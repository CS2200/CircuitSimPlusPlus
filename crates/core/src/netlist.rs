//! Flattened netlist construction (DESIGN.md §4.2 steps 1–2, §5.2 wire
//! rules; BACKEND.md task B3).
//!
//! Pipeline: expand the hierarchy (subcircuits inlined; registers, memory,
//! pins, and I/O stay primitive) while union-find merges pin terminals over
//! wires and junctions → nets; then the load-time net checks: **bitsize
//! agreement** per net (error), plus floating nets and driver counts as
//! computed *facts* (not errors — a net with no enabled drivers is `Z` by
//! design on tri-state buses; consuming `Z` halts at runtime, §4.1).
//!
//! Callers must run `format` validation first (task B2). Construction is
//! defensive (unresolvable references are skipped, never panic — §5.2), but
//! its checks assume a validated document.
//!
//! Determinism (§4.6): expansion is document-order; net IDs are assigned in
//! first-seen order; all maps are `BTreeMap`. The netlist is a pure
//! function of the document.
//!
//! Naming: autograder-visible components (`mem.ram/rom`, `mem.register`,
//! `wiring.probe` with a `name`) are addressable by their *hierarchical
//! name* — the plain `name` at root level, `"instance/id/.../name"` when
//! nested (DESIGN.md §8.2; instance ids guarantee global uniqueness).
//!
//! `net_map` covers the **root circuit's** wires only (the frontend's
//! net-extent highlighting works on the top-level canvas; inlined
//! subcircuit wires have circuit-relative indices the IPC contract does not
//! carry).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Map, Value as Json};

use crate::api::{
    CircuitName, CompId, LoadError, LoadErrorKind, NamedComponent, NamedKind, NetId, NetMapEntry,
    WireIdx,
};
use crate::components::{self, PinDir, PinSig};
use crate::format::{Circuit, Document, Endpoint};

/// Post-flatten instance cap (DESIGN.md §11).
pub const DEFAULT_INSTANCE_CAP: usize = 1_000_000;

/// Which circuit simulates: `"main"` if present, else the first circuit.
pub fn root_circuit(doc: &Document) -> Option<usize> {
    if doc.circuits.is_empty() {
        None
    } else {
        Some(
            doc.circuits
                .iter()
                .position(|c| c.name == "main")
                .unwrap_or(0),
        )
    }
}

/// Union-find over terminal nodes (union by rank + path halving). Internal
/// shape is irrelevant to determinism — only the equivalence classes
/// matter, and those are order-independent.
struct Uf {
    parent: Vec<u32>,
    rank: Vec<u8>,
}

impl Uf {
    fn new() -> Self {
        Uf {
            parent: Vec::new(),
            rank: Vec::new(),
        }
    }

    fn node(&mut self) -> u32 {
        let id = self.parent.len() as u32;
        self.parent.push(id);
        self.rank.push(0);
        id
    }

    fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            let next = self.parent[x as usize];
            self.parent[x as usize] = self.parent[next as usize];
            x = next;
        }
        x
    }

    fn union(&mut self, a: u32, b: u32) {
        let (mut ra, mut rb) = (self.find(a), self.find(b));
        if ra == rb {
            return;
        }
        if self.rank[ra as usize] < self.rank[rb as usize] {
            std::mem::swap(&mut ra, &mut rb);
        }
        self.parent[rb as usize] = ra;
        if self.rank[ra as usize] == self.rank[rb as usize] {
            self.rank[ra as usize] += 1;
        }
    }
}

/// A primitive component instance in the flattened design.
#[derive(Debug, Clone)]
pub struct FlatComp {
    pub id: CompId,
    pub type_: String,
    /// Hierarchical autograder name (see module docs), if the component is
    /// named.
    pub name: Option<String>,
    pub attrs: Map<String, Json>,
    pub pins: Vec<PinConn>,
    /// Circuit (by name) whose definition this instance came from.
    pub def_circuit: CircuitName,
    /// Component id within that circuit.
    pub def_id: String,
    /// Index within that circuit's `components` array (LoadError
    /// convention).
    pub def_idx: usize,
    /// Instance path from the root (`"c4/c12"`), empty at root.
    pub inst_path: String,
}

impl FlatComp {
    /// Human-readable location for messages, e.g. `main: c17` or
    /// `alu: c3 (via c10/c4)`.
    pub fn origin(&self) -> String {
        let base = format!("{}: {}", self.def_circuit, self.def_id);
        if self.inst_path.is_empty() {
            base
        } else {
            format!("{base} (via {})", self.inst_path)
        }
    }
}

/// One pin's net connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PinConn {
    pub pin: String,
    pub dir: PinDir,
    pub width: u32,
    pub net: NetId,
}

/// A derived net (§5.1 — internal only, never stored in files).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Net {
    pub id: NetId,
    pub width: u32,
    /// No driving pin (Out or InOut) at all — the net floats (`Z`).
    pub floating: bool,
    /// Pins that can drive this net (Out and InOut), in comp order.
    pub drivers: Vec<(CompId, String)>,
    /// Pins that consume this net (In and InOut), in comp order.
    pub sinks: Vec<(CompId, String)>,
}

/// The flattened design: primitive instances + derived nets + named access.
#[derive(Debug, Clone)]
pub struct Netlist {
    pub comps: Vec<FlatComp>,
    pub nets: Vec<Net>,
    pub named: Vec<NamedComponent>,
    pub net_map: Vec<NetMapEntry>,
    pub root: usize,
}

/// Build a netlist from a validated document (instance cap §11).
pub fn build(doc: &Document) -> Result<Netlist, Vec<LoadError>> {
    build_with_cap(doc, DEFAULT_INSTANCE_CAP)
}

/// As [`build`], with a caller-chosen instance cap (tests, §11 tuning).
pub fn build_with_cap(doc: &Document, cap: usize) -> Result<Netlist, Vec<LoadError>> {
    let Some(root) = root_circuit(doc) else {
        return Err(vec![LoadError {
            kind: LoadErrorKind::Other,
            message: "document has no circuits".to_string(),
            circuit: String::new(),
            comp_id: None,
            wire_idx: None,
        }]);
    };

    let mut ex = Expander::new(doc, cap);
    let mut path = Vec::new();
    ex.expand(root, &mut path, true);
    if !ex.errors.is_empty() {
        return Err(ex.errors);
    }

    let Expander {
        mut uf,
        insts,
        root_wire_nodes,
        ..
    } = ex;

    // ---- Derive nets: first-seen class → next NetId, in instance order.
    let mut net_of_root: BTreeMap<u32, NetId> = BTreeMap::new();
    let mut nets: Vec<Net> = Vec::new();
    let mut pin_widths: Vec<Vec<(u32, CompId, String)>> = Vec::new(); // per net
    let mut comps: Vec<FlatComp> = Vec::with_capacity(insts.len());

    for (inst_idx, inst) in insts.iter().enumerate() {
        let comp_id = CompId(inst_idx as u32);
        let mut pins = Vec::with_capacity(inst.sigs.len());
        for (pidx, sig) in inst.sigs.iter().enumerate() {
            let class = uf.find(inst.pin_nodes[pidx]);
            let net = *net_of_root.entry(class).or_insert_with(|| {
                nets.push(Net {
                    id: NetId(nets.len() as u32),
                    width: sig.width,
                    floating: false,
                    drivers: Vec::new(),
                    sinks: Vec::new(),
                });
                pin_widths.push(Vec::new());
                NetId(nets.len() as u32 - 1)
            });
            let n = &mut nets[net.idx()];
            match sig.dir {
                PinDir::Out => n.drivers.push((comp_id, sig.name.clone())),
                PinDir::In => n.sinks.push((comp_id, sig.name.clone())),
                PinDir::InOut => {
                    n.drivers.push((comp_id, sig.name.clone()));
                    n.sinks.push((comp_id, sig.name.clone()));
                }
            }
            pin_widths[net.idx()].push((sig.width, comp_id, sig.name.clone()));
            pins.push(PinConn {
                pin: sig.name.clone(),
                dir: sig.dir,
                width: sig.width,
                net,
            });
        }
        comps.push(FlatComp {
            id: comp_id,
            type_: inst.type_.clone(),
            name: inst.name.clone(),
            attrs: inst.attrs.clone(),
            pins,
            def_circuit: inst.def_circuit.clone(),
            def_id: inst.def_id.clone(),
            def_idx: inst.def_idx,
            inst_path: inst.inst_path.clone(),
        });
    }

    // ---- Checks: bitsize agreement, floating.
    let mut errors = Vec::new();
    for (nidx, votes) in pin_widths.iter().enumerate() {
        let width = nets[nidx].width;
        if votes.iter().any(|(w, _, _)| *w != width) {
            let mut locs: Vec<String> = Vec::new();
            for (w, comp, pin) in votes {
                if locs.len() < 6 {
                    locs.push(format!("{}.{} ({w} bits)", comps[comp.idx()].origin(), pin));
                }
            }
            if votes.len() > 6 {
                locs.push(format!("… and {} more", votes.len() - 6));
            }
            let (first_comp, _) = {
                let (_, c, _) = &votes[0];
                (*c, ())
            };
            errors.push(LoadError {
                kind: LoadErrorKind::BitsizeMismatch,
                message: format!("net connects pins of different widths: {}", locs.join(", ")),
                circuit: comps[first_comp.idx()].def_circuit.clone(),
                comp_id: Some(CompId(comps[first_comp.idx()].def_idx as u32)),
                wire_idx: None,
            });
        }
        let floating = nets[nidx].drivers.is_empty();
        nets[nidx].floating = floating;
    }
    if !errors.is_empty() {
        return Err(errors);
    }

    // ---- Named access (hierarchical names; §8.2).
    let mut named = Vec::new();
    for (inst_idx, inst) in insts.iter().enumerate() {
        let kind = match inst.type_.as_str() {
            "mem.ram" => Some(NamedKind::Ram),
            "mem.rom" => Some(NamedKind::Rom),
            "mem.register" => Some(NamedKind::Register),
            "wiring.probe" => Some(NamedKind::Probe),
            _ => None,
        };
        if let (Some(kind), Some(name)) = (kind, &inst.name) {
            let name = if inst.inst_path.is_empty() {
                name.clone()
            } else {
                format!("{}/{name}", inst.inst_path)
            };
            named.push(NamedComponent {
                name,
                kind,
                comp_id: CompId(inst_idx as u32),
            });
        }
    }

    // ---- net_map: root circuit wires → nets (for UI net highlighting).
    let mut by_net: BTreeMap<NetId, Vec<WireIdx>> = BTreeMap::new();
    for (widx, node) in root_wire_nodes.iter().enumerate() {
        if let Some(node) = node {
            let class = uf.find(*node);
            if let Some(&net) = net_of_root.get(&class) {
                by_net.entry(net).or_default().push(WireIdx(widx as u32));
            }
        }
    }
    let net_map = by_net
        .into_iter()
        .map(|(net, wires)| NetMapEntry { net, wires })
        .collect();

    Ok(Netlist {
        comps,
        nets,
        named,
        net_map,
        root,
    })
}

/// A primitive instance under construction (pins already have UF nodes).
struct InstBuild {
    type_: String,
    name: Option<String>,
    attrs: Map<String, Json>,
    sigs: Vec<PinSig>,
    pin_nodes: Vec<u32>,
    def_circuit: String,
    def_id: String,
    def_idx: usize,
    inst_path: String,
}

struct Expander<'a> {
    doc: &'a Document,
    circuit_by_name: BTreeMap<&'a str, usize>,
    uf: Uf,
    insts: Vec<InstBuild>,
    cap: usize,
    cap_hit: bool,
    errors: Vec<LoadError>,
    root_wire_nodes: Vec<Option<u32>>,
}

impl<'a> Expander<'a> {
    fn new(doc: &'a Document, cap: usize) -> Self {
        let mut circuit_by_name = BTreeMap::new();
        for (i, c) in doc.circuits.iter().enumerate() {
            circuit_by_name.entry(c.name.as_str()).or_insert(i);
        }
        Expander {
            doc,
            circuit_by_name,
            uf: Uf::new(),
            insts: Vec::new(),
            cap,
            cap_hit: false,
            errors: Vec::new(),
            root_wire_nodes: Vec::new(),
        }
    }

    /// Expand one circuit into the current instance path; returns the
    /// expansion's pin terminals (pin-component name → UF node) for the
    /// parent to bridge onto instance pins.
    fn expand(
        &mut self,
        cidx: usize,
        path: &mut Vec<String>,
        is_root: bool,
    ) -> BTreeMap<String, u32> {
        let circuit = &self.doc.circuits[cidx];
        let comp_idx_by_id: BTreeMap<&str, usize> = circuit
            .components
            .iter()
            .enumerate()
            .map(|(i, c)| (c.id.as_str(), i))
            .collect();
        let mut local: BTreeMap<(usize, String), u32> = BTreeMap::new();
        let mut pin_terminals: BTreeMap<String, u32> = BTreeMap::new();

        for (idx, comp) in circuit.components.iter().enumerate() {
            if self.cap_hit {
                break;
            }
            if comp.type_ == "subcircuit" {
                let Some(target_name) = comp.attrs.get("circuit").and_then(|v| v.as_str()) else {
                    continue; // unvalidated input — validation reports this
                };
                let Some(&tidx) = self.circuit_by_name.get(target_name) else {
                    continue;
                };
                // Bridge node per interface pin (document order of the
                // target's pin components).
                let target = &self.doc.circuits[tidx];
                let pin_names: Vec<&str> = target
                    .components
                    .iter()
                    .filter(|c| c.type_ == "wiring.pin" && !c.name.is_empty())
                    .map(|c| c.name.as_str())
                    .collect();
                let mut bridge: BTreeMap<String, u32> = BTreeMap::new();
                for pn in &pin_names {
                    let node = self.uf.node();
                    local.insert((idx, pn.to_string()), node);
                    bridge.insert(pn.to_string(), node);
                }
                path.push(comp.id.clone());
                let child = self.expand(tidx, path, false);
                path.pop();
                for (pn, child_node) in child {
                    if let Some(&b) = bridge.get(&pn) {
                        self.uf.union(b, child_node);
                    }
                }
            } else {
                let Some(sigs) = components::pin_sigs(&comp.type_, &comp.attrs) else {
                    continue; // unknown type — validation reports this
                };
                // Pin components dissolve when inlined (they are pure
                // connectivity bridges); at the root they stay primitive
                // (they are the design's external I/O).
                if comp.type_ == "wiring.pin" && !is_root {
                    let node = self.uf.node();
                    local.insert((idx, "pin".to_string()), node);
                    if !comp.name.is_empty() {
                        pin_terminals.insert(comp.name.clone(), node);
                    }
                    continue;
                }
                if self.insts.len() >= self.cap {
                    self.cap_hit = true;
                    self.errors.push(LoadError {
                        kind: LoadErrorKind::Other,
                        message: format!(
                            "post-flatten instance count exceeds the cap of {} (DESIGN.md §11)",
                            self.cap
                        ),
                        circuit: circuit.name.clone(),
                        comp_id: Some(CompId(idx as u32)),
                        wire_idx: None,
                    });
                    break;
                }
                let mut nodes = Vec::with_capacity(sigs.len());
                for sig in &sigs {
                    let node = self.uf.node();
                    local.insert((idx, sig.name.clone()), node);
                    nodes.push(node);
                }
                if comp.type_ == "wiring.pin" && !comp.name.is_empty() {
                    pin_terminals.insert(comp.name.clone(), nodes[0]);
                }
                self.insts.push(InstBuild {
                    type_: comp.type_.clone(),
                    name: if comp.name.is_empty() {
                        None
                    } else {
                        Some(comp.name.clone())
                    },
                    attrs: comp.attrs.clone(),
                    sigs,
                    pin_nodes: nodes,
                    def_circuit: circuit.name.clone(),
                    def_id: comp.id.clone(),
                    def_idx: idx,
                    inst_path: path.join("/"),
                });
            }
        }

        for wire in &circuit.wires {
            let na = endpoint_node(circuit, &comp_idx_by_id, &local, &wire.a);
            let nb = endpoint_node(circuit, &comp_idx_by_id, &local, &wire.b);
            if let (Some(a), Some(b)) = (na, nb) {
                self.uf.union(a, b);
            }
            if is_root {
                self.root_wire_nodes.push(na.or(nb));
            }
        }

        pin_terminals
    }
}

/// Resolve a wire endpoint to a UF node (defensive: `None` when the
/// reference doesn't resolve — validation reports those cases).
fn endpoint_node(
    circuit: &Circuit,
    by_id: &BTreeMap<&str, usize>,
    local: &BTreeMap<(usize, String), u32>,
    ep: &Endpoint,
) -> Option<u32> {
    match ep {
        Endpoint::Pin(p) => {
            let idx = *by_id.get(p.comp.as_str())?;
            local.get(&(idx, p.pin.clone())).copied()
        }
        Endpoint::Join(j) => resolve_join(circuit, by_id, local, j.join.wire as usize),
    }
}

/// A junction electrically connects to the joined wire's net: resolve to
/// any reachable pin-endpoint node (all endpoints of a wire end up in one
/// class, so any member node represents it). Iterative — pathological join
/// chains can't overflow the stack (§11).
fn resolve_join(
    circuit: &Circuit,
    by_id: &BTreeMap<&str, usize>,
    local: &BTreeMap<(usize, String), u32>,
    start: usize,
) -> Option<u32> {
    let mut seen = BTreeSet::new();
    let mut stack = vec![start];
    while let Some(widx) = stack.pop() {
        if !seen.insert(widx) {
            continue;
        }
        let wire = circuit.wires.get(widx)?;
        for ep in [&wire.a, &wire.b] {
            match ep {
                Endpoint::Pin(p) => {
                    if let Some(&idx) = by_id.get(p.comp.as_str()) {
                        if let Some(&n) = local.get(&(idx, p.pin.clone())) {
                            return Some(n);
                        }
                    }
                }
                Endpoint::Join(j) => stack.push(j.join.wire as usize),
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_json(json: &str) -> Result<Netlist, Vec<LoadError>> {
        let doc = crate::format::load_document(json.as_bytes()).expect("test doc must validate");
        build(&doc)
    }

    fn header(circuits: &str) -> String {
        format!(
            r#"{{"format":"circuitsim-plus-plus","version":2,"name":"t",
                "settings":{{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"}},
                "circuits":[{circuits}]}}"#
        )
    }

    /// Net membership as comparable pin-location strings ("c0.out").
    fn net_pins(net: &Net) -> BTreeSet<String> {
        net.drivers
            .iter()
            .chain(net.sinks.iter())
            .map(|(c, p)| format!("c{}.{p}", c.0))
            .collect()
    }

    #[test]
    fn flat_basic_driver_sink_accounting() {
        let json = header(
            r#"{"name":"main","components":[
                {"id":"c0","type":"wiring.clock","pos":[0,0]},
                {"id":"c1","type":"mem.register","pos":[5,0],"name":"pc","attrs":{"bitsize":32}},
                {"id":"c2","type":"wiring.probe","pos":[10,0],"name":"out","attrs":{"bitsize":32}}
            ],"wires":[
                {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"clk"}},
                {"a":{"comp":"c1","pin":"q"},"b":{"comp":"c2","pin":"in"}}
            ]}"#,
        );
        let nl = build_json(&json).unwrap();
        assert_eq!(nl.comps.len(), 3);
        // clk net + q→probe net + one singleton net per unwired register
        // pin (d, en, rst).
        assert_eq!(nl.nets.len(), 5);

        let clk_net = &nl.nets[nl.comps[0].pins[0].net.idx()];
        assert_eq!(clk_net.width, 1);
        assert!(!clk_net.floating);
        assert_eq!(clk_net.drivers, vec![(CompId(0), "out".to_string())]);
        assert_eq!(clk_net.sinks, vec![(CompId(1), "clk".to_string())]);

        let q_net = &nl.nets[nl.comps[1]
            .pins
            .iter()
            .find(|p| p.pin == "q")
            .unwrap()
            .net
            .idx()];
        assert_eq!(q_net.width, 32);
        assert_eq!(q_net.sinks, vec![(CompId(2), "in".to_string())]);

        // Register D input is unwired: its net exists and floats (a fact,
        // not an error — §4.1 runtime halt handles consumption).
        let d_net = &nl.nets[nl.comps[1]
            .pins
            .iter()
            .find(|p| p.pin == "d")
            .unwrap()
            .net
            .idx()];
        assert!(d_net.floating);
        assert!(d_net.drivers.is_empty());
    }

    #[test]
    fn fan_out_is_one_net() {
        let json = header(
            r#"{"name":"main","components":[
                {"id":"c0","type":"wiring.clock","pos":[0,0]},
                {"id":"c1","type":"mem.register","pos":[5,0]},
                {"id":"c2","type":"mem.register","pos":[5,2]},
                {"id":"c3","type":"mem.register","pos":[5,4]}
            ],"wires":[
                {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"clk"}},
                {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c2","pin":"clk"}},
                {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c3","pin":"clk"}}
            ]}"#,
        );
        let nl = build_json(&json).unwrap();
        // 1 shared clk net + 4 unwired pin nets per register (d, en, rst, q).
        assert_eq!(nl.nets.len(), 1 + 3 * 4);
        let clk_net = &nl.nets[nl.comps[0].pins[0].net.idx()];
        assert_eq!(clk_net.sinks.len(), 3);
        assert_eq!(clk_net.drivers.len(), 1);
    }

    #[test]
    fn join_chains_are_order_independent() {
        let wires = |order: &str| {
            format!(
                r#"{{"name":"main","components":[
                    {{"id":"c0","type":"wiring.pin","pos":[0,0],"name":"src"}},
                    {{"id":"c1","type":"wiring.probe","pos":[5,0],"name":"p0"}},
                    {{"id":"c2","type":"wiring.probe","pos":[5,2],"name":"p1"}},
                    {{"id":"c3","type":"wiring.probe","pos":[5,4],"name":"p2"}}
                ],"wires":{order}}}"#
            )
        };
        let fwd = r#"[
            {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c1","pin":"in"}},
            {"a":{"comp":"c2","pin":"in"},"b":{"join":{"wire":0,"segment":0}}},
            {"a":{"comp":"c3","pin":"in"},"b":{"join":{"wire":1,"segment":0}}}
        ]"#;
        let rev = r#"[
            {"a":{"comp":"c3","pin":"in"},"b":{"join":{"wire":2,"segment":0}}},
            {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c1","pin":"in"}},
            {"a":{"comp":"c2","pin":"in"},"b":{"join":{"wire":1,"segment":0}}}
        ]"#;
        let a = build_json(&header(&wires(fwd))).unwrap();
        let b = build_json(&header(&wires(rev))).unwrap();
        let memberships_a: BTreeSet<BTreeSet<String>> = a.nets.iter().map(net_pins).collect();
        let memberships_b: BTreeSet<BTreeSet<String>> = b.nets.iter().map(net_pins).collect();
        assert_eq!(memberships_a, memberships_b);
        // All four pins on one net.
        assert!(memberships_a
            .iter()
            .any(|m| m.len() == 4 && m.contains("c0.pin") && m.contains("c3.in")));
    }

    #[test]
    fn nested_subcircuits_three_deep() {
        let circuits = r#"
            {"name":"c","components":[
                {"id":"c0","type":"wiring.pin","pos":[0,0],"name":"x"},
                {"id":"c1","type":"wiring.pin","pos":[4,0],"name":"y","attrs":{"isOutput":true}},
                {"id":"c2","type":"gate.buffer","pos":[2,0]}
            ],"wires":[
                {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c2","pin":"in"}},
                {"a":{"comp":"c2","pin":"out"},"b":{"comp":"c1","pin":"pin"}}
            ]},
            {"name":"b","components":[
                {"id":"c0","type":"wiring.pin","pos":[0,0],"name":"i"},
                {"id":"c1","type":"wiring.pin","pos":[8,0],"name":"o","attrs":{"isOutput":true}},
                {"id":"c2","type":"subcircuit","pos":[3,0],"attrs":{"circuit":"c"}}
            ],"wires":[
                {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c2","pin":"x"}},
                {"a":{"comp":"c2","pin":"y"},"b":{"comp":"c1","pin":"pin"}}
            ]},
            {"name":"a","components":[
                {"id":"c0","type":"wiring.pin","pos":[0,0],"name":"i"},
                {"id":"c1","type":"wiring.pin","pos":[8,0],"name":"o","attrs":{"isOutput":true}},
                {"id":"c2","type":"subcircuit","pos":[3,0],"attrs":{"circuit":"b"}}
            ],"wires":[
                {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c2","pin":"i"}},
                {"a":{"comp":"c2","pin":"o"},"b":{"comp":"c1","pin":"pin"}}
            ]},
            {"name":"main","components":[
                {"id":"c0","type":"wiring.constant","pos":[0,0],"attrs":{"value":"1"}},
                {"id":"c1","type":"subcircuit","pos":[3,0],"attrs":{"circuit":"a"}},
                {"id":"c2","type":"wiring.probe","pos":[8,0],"name":"seen"}
            ],"wires":[
                {"a":{"comp":"c0","pin":"out"},"b":{"comp":"c1","pin":"i"}},
                {"a":{"comp":"c1","pin":"o"},"b":{"comp":"c2","pin":"in"}}
            ]}"#;
        let nl = build_json(&header(circuits)).unwrap();
        // Pins dissolve: constant + buffer + probe remain.
        assert_eq!(nl.comps.len(), 3);
        assert_eq!(nl.nets.len(), 2);
        let konst = &nl.comps[0];
        let buf = &nl.comps[1];
        let probe = &nl.comps[2];
        assert_eq!(konst.type_, "wiring.constant");
        assert_eq!(buf.type_, "gate.buffer");
        assert_eq!(buf.inst_path, "c1/c2/c2");
        // Signal flow: const.out net == buffer.in net; buffer.out net == probe.in net.
        assert_eq!(konst.pins[0].net, buf.pins[0].net);
        assert_eq!(buf.pins[1].net, probe.pins[0].net);
    }

    #[test]
    fn splitter_nets_and_bitsize_mismatch() {
        // OK: 8-bit bus split 4/4 into matching pins.
        let ok = header(
            r#"{"name":"main","components":[
                {"id":"c0","type":"mem.register","pos":[0,0],"attrs":{"bitsize":8}},
                {"id":"c1","type":"wiring.splitter","pos":[3,0],"attrs":{"splits":{"lo":[0,1,2,3],"hi":[4,5,6,7]}}},
                {"id":"c2","type":"wiring.probe","pos":[6,0],"name":"lo","attrs":{"bitsize":4}}
            ],"wires":[
                {"a":{"comp":"c0","pin":"q"},"b":{"comp":"c1","pin":"bus"}},
                {"a":{"comp":"c1","pin":"lo"},"b":{"comp":"c2","pin":"in"}}
            ]}"#,
        );
        let nl = build_json(&ok).unwrap();
        let split = &nl.comps[1];
        assert_eq!(split.pins.iter().find(|p| p.pin == "bus").unwrap().width, 8);
        assert_eq!(split.pins.iter().find(|p| p.pin == "lo").unwrap().width, 4);

        // Mismatch: 8-bit bus onto a 4-bit probe.
        let bad = header(
            r#"{"name":"main","components":[
                {"id":"c0","type":"mem.register","pos":[0,0],"attrs":{"bitsize":8}},
                {"id":"c1","type":"wiring.probe","pos":[3,0],"name":"p","attrs":{"bitsize":4}}
            ],"wires":[
                {"a":{"comp":"c0","pin":"q"},"b":{"comp":"c1","pin":"in"}}
            ]}"#,
        );
        let errors = build_json(&bad).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].kind, LoadErrorKind::BitsizeMismatch);
        assert!(errors[0].message.contains("8 bits"));
        assert!(errors[0].message.contains("4 bits"));
        assert!(errors[0].message.contains("main: c0"));
        assert!(errors[0].message.contains("main: c1"));
    }

    #[test]
    fn named_components_are_hierarchical() {
        let json = header(
            r#"{"name":"reg_probe","components":[
                {"id":"c0","type":"wiring.probe","pos":[0,0],"name":"result"}
            ]},
            {"name":"main","components":[
                {"id":"u1","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"reg_probe"}},
                {"id":"u2","type":"subcircuit","pos":[0,2],"attrs":{"circuit":"reg_probe"}},
                {"id":"c0","type":"mem.ram","pos":[5,0],"name":"imem"},
                {"id":"c1","type":"wiring.probe","pos":[5,2],"name":"top"}
            ]}"#,
        );
        let nl = build_json(&json).unwrap();
        let names: BTreeSet<&str> = nl.named.iter().map(|n| n.name.as_str()).collect();
        assert_eq!(
            names,
            BTreeSet::from(["imem", "top", "u1/result", "u2/result"])
        );
        let imem = nl.named.iter().find(|n| n.name == "imem").unwrap();
        assert_eq!(imem.kind, NamedKind::Ram);
    }

    #[test]
    fn unconnected_subcircuit_pin_floats_but_ghosts_are_dropped() {
        let json = header(
            r#"{"name":"inner","components":[
                {"id":"c0","type":"wiring.pin","pos":[0,0],"name":"x"},
                {"id":"c1","type":"wiring.pin","pos":[0,4],"name":"ghost"},
                {"id":"c2","type":"wiring.probe","pos":[4,0],"name":"p"}
            ],"wires":[
                {"a":{"comp":"c0","pin":"pin"},"b":{"comp":"c2","pin":"in"}}
            ]},
            {"name":"main","components":[
                {"id":"c0","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"inner"}}
            ]}"#,
        );
        let nl = build_json(&json).unwrap();
        // Only the probe's net survives; the ghost pin (unwired on both
        // sides) creates no net.
        assert_eq!(nl.nets.len(), 1);
        // The subcircuit input is unconnected in the parent: the net has a
        // sink but no driver → floating (runtime will halt on consume, §4.1).
        assert!(nl.nets[0].floating);
        assert_eq!(nl.nets[0].sinks.len(), 1);
    }

    #[test]
    fn instance_cap() {
        let json = header(
            r#"{"name":"main","components":[
                {"id":"c0","type":"wiring.clock","pos":[0,0]},
                {"id":"c1","type":"gate.not","pos":[1,0]},
                {"id":"c2","type":"gate.not","pos":[2,0]},
                {"id":"c3","type":"gate.not","pos":[3,0]}
            ]}"#,
        );
        let doc = crate::format::load_document(json.as_bytes()).unwrap();
        let errors = build_with_cap(&doc, 3).unwrap_err();
        assert_eq!(errors.len(), 1);
        assert!(errors[0].message.contains("cap"));
    }

    #[test]
    fn root_selection() {
        // No "main": first circuit is the root.
        let json = header(r#"{"name":"only","components":[]}"#);
        let nl = build_json(&json).unwrap();
        assert_eq!(nl.root, 0);
    }

    #[test]
    fn perf_3p4k_components() {
        // Synthetic EC-project-scale circuit (DESIGN.md §2: ~3,443
        // components): 400 instances of a 3-gate cell + a 2200-gate chain.
        let mut main_comps = String::new();
        let mut main_wires = String::new();
        main_comps.push_str(
            r#"{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src","attrs":{"bitsize":32}},"#,
        );
        let n_cells = 400;
        for i in 0..n_cells {
            main_comps.push_str(&format!(
                r#"{{"id":"cell{i}","type":"subcircuit","pos":[{},0],"attrs":{{"circuit":"cell"}}}},"#,
                i + 1
            ));
            let (from_pin, from_comp) = if i == 0 {
                ("pin", "src".to_string())
            } else {
                ("o", format!("cell{}", i - 1))
            };
            main_wires.push_str(&format!(
                r#"{{"a":{{"comp":"{from_comp}","pin":"{from_pin}"}},"b":{{"comp":"cell{i}","pin":"i"}}}},"#
            ));
        }
        // 2200-gate chain fed by the last cell.
        for i in 0..2200 {
            main_comps.push_str(&format!(
                r#"{{"id":"g{i}","type":"gate.not","pos":[{},2],"attrs":{{"bitsize":32}}}},"#,
                i
            ));
            let from = if i == 0 {
                format!(r#"{{"comp":"cell{}","pin":"o"}}"#, n_cells - 1)
            } else {
                format!(r#"{{"comp":"g{}","pin":"out"}}"#, i - 1)
            };
            main_wires.push_str(&format!(
                r#"{{"a":{from},"b":{{"comp":"g{i}","pin":"in"}}}},"#
            ));
        }
        main_comps.push_str(
            r#"{"id":"sink","type":"wiring.probe","pos":[9999,0],"name":"sink","attrs":{"bitsize":32}}"#,
        );
        main_wires.push_str(r#"{"a":{"comp":"g2199","pin":"out"},"b":{"comp":"sink","pin":"in"}}"#);

        let json = header(&format!(
            r#"{{"name":"cell","components":[
                {{"id":"i0","type":"wiring.pin","pos":[0,0],"name":"i","attrs":{{"bitsize":32}}}},
                {{"id":"o0","type":"wiring.pin","pos":[6,0],"name":"o","attrs":{{"isOutput":true,"bitsize":32}}}},
                {{"id":"n0","type":"gate.not","pos":[1,0],"attrs":{{"bitsize":32}}}},
                {{"id":"n1","type":"gate.not","pos":[3,0],"attrs":{{"bitsize":32}}}},
                {{"id":"n2","type":"gate.not","pos":[5,0],"attrs":{{"bitsize":32}}}}
            ],"wires":[
                {{"a":{{"comp":"i0","pin":"pin"}},"b":{{"comp":"n0","pin":"in"}}}},
                {{"a":{{"comp":"n0","pin":"out"}},"b":{{"comp":"n1","pin":"in"}}}},
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"n2","pin":"in"}}}},
                {{"a":{{"comp":"n2","pin":"out"}},"b":{{"comp":"o0","pin":"pin"}}}}
            ]}},
            {{"name":"main","components":[{main_comps}],"wires":[{main_wires}]}}"#
        ));

        let doc = crate::format::load_document(json.as_bytes()).unwrap();
        let start = std::time::Instant::now();
        let nl = build(&doc).unwrap();
        let elapsed = start.elapsed();
        eprintln!(
            "perf_3p4k: {} comps, {} nets built in {elapsed:?}",
            nl.comps.len(),
            nl.nets.len()
        );
        assert_eq!(nl.comps.len(), 400 * 3 + 2200 + 2); // 3402 + src + sink
                                                        // Generous bound to catch algorithmic regressions in debug builds;
                                                        // the <50 ms acceptance is measured in release mode.
        assert!(
            elapsed.as_secs() < 10,
            "netlist build too slow: {elapsed:?}"
        );
    }
}
