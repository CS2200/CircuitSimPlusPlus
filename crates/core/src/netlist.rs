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
    /// Unique instance id; index into [`Netlist::comps`].
    pub id: CompId,
    /// Component type string (e.g. `"gate.and"`, `"mem.register"`).
    pub type_: String,
    /// Hierarchical autograder name (see module docs), if the component is
    /// named.
    pub name: Option<String>,
    /// Instance attributes, as given in the document.
    pub attrs: Map<String, Json>,
    /// Pin connections, in the component's pin-signature order.
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
    /// Pin name (from the component's pin signature).
    pub pin: String,
    /// Pin direction (In / Out / InOut).
    pub dir: PinDir,
    /// Pin width in bits.
    pub width: u32,
    /// Net this pin connects to.
    pub net: NetId,
}

/// A derived net (§5.1 — internal only, never stored in files).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Net {
    /// Unique net id; index into [`Netlist::nets`].
    pub id: NetId,
    /// Net width in bits (all attached pins must agree, checked at build).
    pub width: u32,
    /// No driving pin (Out or InOut) at all — the net floats (`Z`).
    pub floating: bool,
    /// Pins that can drive this net (Out and InOut), in comp order.
    pub drivers: Vec<(CompId, String)>,
    /// Pins that consume this net (In and InOut), in comp order.
    pub sinks: Vec<(CompId, String)>,
    /// Total drawn wire length on this net, in grid units (sum of the
    /// polylines of every wire merged into the net, across all inlined
    /// expansions). Kept for STA's structural estimates and documentation;
    /// the delay-aware engine uses the per-sink path delays below.
    pub wire_len: u32,
    /// Per-sink transport delay in grid units, aligned with `sinks`:
    /// the shortest path through the net's wire graph from the nearest
    /// driver to that sink (contract v1.1, F14 — unused stub branches do
    /// not inflate other sinks' delays).
    pub sink_wire_units: Vec<u32>,
    /// Per-driver, per-sink path lengths in grid units (STA's per-path
    /// structural arrivals): `sink_wire_by_driver[i]` is the driver list
    /// index into `drivers` and the per-sink vector aligned with `sinks`.
    pub sink_wire_by_driver: Vec<(u32, Vec<u32>)>,
}

/// The flattened design: primitive instances + derived nets + named access.
#[derive(Debug, Clone)]
pub struct Netlist {
    /// Primitive instances, in expansion order; indexed by `CompId`.
    pub comps: Vec<FlatComp>,
    /// Derived nets; indexed by `NetId`.
    pub nets: Vec<Net>,
    /// Autograder-visible named components (RAM/ROM/register/probe); §8.2.
    /// `comp_id` is the DOCUMENT-ORDER index within `circuit` (contract
    /// v1.1); engines must use [`Netlist::named_flat`] instead.
    pub named: Vec<NamedComponent>,
    /// Engine (post-flatten) ids parallel to [`Netlist::named`]; internal.
    pub named_flat: Vec<CompId>,
    /// Root-circuit wire segments per net, for UI net highlighting.
    pub net_map: Vec<NetMapEntry>,
    /// Index of the root circuit in the document's `circuits` array (see
    /// [`root_circuit`]).
    pub root: usize,
}

impl Netlist {
    /// Engine (post-flatten) id of a named component — the internal
    /// companion of the contract-facing [`Netlist::named`] registry.
    pub fn named_engine_id(&self, name: &str) -> Option<CompId> {
        self.named
            .iter()
            .position(|n| n.name == name)
            .map(|i| self.named_flat[i])
    }

    /// Map an engine (post-flatten) component to its document identity:
    /// the circuit that defines it and its document-order index within
    /// that circuit's `components` array (contract v1.1 CompId rule).
    pub fn doc_id(&self, flat: CompId) -> (CircuitName, CompId) {
        let fc = &self.comps[flat.idx()];
        (fc.def_circuit.clone(), CompId(fc.def_idx as u32))
    }

    /// Map an engine component to the document-order id used in
    /// `sim_halted.details` (contract v1.1): its own index when it lives
    /// in the root circuit, else the root-circuit index of the enclosing
    /// subcircuit INSTANCE (v1 UI highlights root-sheet only).
    pub fn root_sheet_comp(&self, flat: CompId) -> CompId {
        let fc = &self.comps[flat.idx()];
        if fc.inst_path.is_empty() {
            return CompId(fc.def_idx as u32);
        }
        let top = fc.inst_path.split('/').next().unwrap_or("");
        // The first path segment is a component id in the root circuit.
        self.comps
            .iter()
            .find(|c| c.inst_path.is_empty() && c.def_id == top)
            .map(|c| CompId(c.def_idx as u32))
            .unwrap_or(CompId(fc.def_idx as u32))
    }
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
        wire_len_nodes,
        wire_recs,
        ..
    } = ex;

    // ---- Derive nets: first-seen class → next NetId, in instance order.
    let mut net_of_root: BTreeMap<u32, NetId> = BTreeMap::new();
    let mut nets: Vec<Net> = Vec::new();
    let mut pin_widths: Vec<Vec<(u32, CompId, String)>> = Vec::new(); // per net
    let mut comps: Vec<FlatComp> = Vec::with_capacity(insts.len());
    // UF terminal node per (comp, pin slot) — the wire graph's endpoints.
    let mut terminal_of: Vec<Vec<u32>> = Vec::with_capacity(insts.len());

    for (inst_idx, inst) in insts.iter().enumerate() {
        let comp_id = CompId(inst_idx as u32);
        terminal_of.push(inst.pin_nodes.clone());
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
                    wire_len: 0,
                    sink_wire_units: Vec::new(),
                    sink_wire_by_driver: Vec::new(),
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

    // ---- Attribute drawn wire lengths to nets (transport delays, §4.3).
    for (node, len) in &wire_len_nodes {
        let class = uf.find(*node);
        if let Some(net) = net_of_root.get(&class) {
            nets[net.idx()].wire_len += len;
        }
    }

    // ---- Per-sink wire path lengths (contract v1.1, F14): build each
    // net's wire graph (pins + junction nodes, segments as weighted
    // edges) and compute driver→sink shortest paths.
    {
        let mut graphs = WireGraphs {
            uf: &mut uf,
            recs: &wire_recs,
            net_of_root: &net_of_root,
        };
        graphs.compute(&mut nets, &comps, &terminal_of);
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

    // ---- Named access (hierarchical names; §8.2). The wire-facing
    // `comp_id` is the DOCUMENT-ORDER index within the defining circuit
    // (contract v1.1); `named_flat` keeps the engine ids in parallel.
    let mut named = Vec::new();
    let mut named_flat = Vec::new();
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
                circuit: inst.def_circuit.clone(),
                comp_id: CompId(inst.def_idx as u32),
            });
            named_flat.push(CompId(inst_idx as u32));
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
        named_flat,
        net_map,
        root,
    })
}

/// Collect every memory (`mem.ram`/`mem.rom`) carrying a nonempty
/// `autoload` attr, addressed by its **hierarchical** name (contract
/// v1.1, F12 — e.g. `u1/imem` for a memory nested in an instance), with
/// its raw autoload path. Paths are resolved/sandboxed by the caller
/// (the CLI owns file access, §11). Shares the expander's traversal, so
/// names always match the netlist's `named` registry.
pub fn autoload_memories(doc: &Document) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let Some(root) = root_circuit(doc) else {
        return out;
    };
    let circuit_by_name: BTreeMap<&str, usize> = doc
        .circuits
        .iter()
        .enumerate()
        .map(|(i, c)| (c.name.as_str(), i))
        .collect();
    let mut stack: Vec<(usize, String)> = vec![(root, String::new())];
    let mut visited_guard = 0usize;
    while let Some((cidx, path)) = stack.pop() {
        // The hierarchy is acyclic (validated); the guard only protects
        // the lenient unvalidated path.
        visited_guard += 1;
        if visited_guard > 1_000_000 {
            break;
        }
        let mut children = Vec::new();
        for comp in &doc.circuits[cidx].components {
            if comp.type_ == "subcircuit" {
                if let Some(target) = comp.attrs.get("circuit").and_then(|v| v.as_str()) {
                    if let Some(&tidx) = circuit_by_name.get(target) {
                        let child = if path.is_empty() {
                            comp.id.clone()
                        } else {
                            format!("{path}/{}", comp.id)
                        };
                        children.push((tidx, child));
                    }
                }
                continue;
            }
            if !matches!(comp.type_.as_str(), "mem.ram" | "mem.rom") || comp.name.is_empty() {
                continue;
            }
            if let Some(auto) = comp.attrs.get("autoload").and_then(|v| v.as_str()) {
                if auto.is_empty() {
                    continue;
                }
                let name = if path.is_empty() {
                    comp.name.clone()
                } else {
                    format!("{path}/{}", comp.name)
                };
                out.push((name, auto.to_string()));
            }
        }
        // Document order: the stack pops last-in-first-out.
        for child in children.into_iter().rev() {
            stack.push(child);
        }
    }
    out
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
    /// (UF node, drawn length) per processed wire, for per-net transport
    /// delays (§4.3) — attributed to nets after union-find completes.
    wire_len_nodes: Vec<(u32, u32)>,
    /// One record per processed wire (all expansions), for the per-sink
    /// wire graph (F14).
    wire_recs: Vec<WireRec>,
}

/// One endpoint of a [`WireRec`].
#[derive(Debug, Clone, Copy)]
enum RecEnd {
    /// Unresolvable reference (lenient path; validation reports it).
    None,
    /// A pin's UF terminal node.
    Pin(u32),
    /// Junction onto `segment` of the wire with this record index
    /// (absolute within `Expander::wire_recs`).
    Join(usize, u32),
}

/// A processed wire's geometry for path-length computation.
#[derive(Debug, Clone)]
struct WireRec {
    /// Raw endpoints.
    a: RecEnd,
    /// Raw endpoints.
    b: RecEnd,
    /// Resolved terminals used for the union (as before), either end.
    resolved: Option<u32>,
    /// Per-segment drawn lengths in grid units (polyline Manhattan, or
    /// the endpoint-distance fallback as a single segment).
    segs: Vec<u32>,
}

impl WireRec {
    /// Total drawn length.
    fn len(&self) -> u32 {
        self.segs.iter().sum()
    }
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
            wire_len_nodes: Vec::new(),
            wire_recs: Vec::new(),
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
            let rec_base = self.wire_recs.len();
            let na = endpoint_node(circuit, &comp_idx_by_id, &local, &wire.a);
            let nb = endpoint_node(circuit, &comp_idx_by_id, &local, &wire.b);
            if let (Some(a), Some(b)) = (na, nb) {
                self.uf.union(a, b);
            }
            let segs = wire_segments(circuit, &comp_idx_by_id, wire);
            let len: u32 = segs.iter().sum();
            self.wire_recs.push(WireRec {
                a: endpoint_raw(&comp_idx_by_id, &local, &wire.a, rec_base),
                b: endpoint_raw(&comp_idx_by_id, &local, &wire.b, rec_base),
                resolved: na.or(nb),
                segs,
            });
            if let Some(node) = na.or(nb) {
                if len > 0 {
                    self.wire_len_nodes.push((node, len));
                }
            }
            if is_root {
                self.root_wire_nodes.push(na.or(nb));
            }
        }

        pin_terminals
    }
}

/// Per-segment drawn lengths of a wire in grid units (polyline Manhattan
/// per consecutive `points` pair; a single fallback segment when `points`
/// is empty, per the Manhattan endpoint-distance rule — see
/// docs/delay-table.md).
///
/// Fractional (sub-grid) coordinates — component pins may sit on
/// half/finer positions — are quantized to whole grid units here: the
/// transport delay is a documented approximation ("≈ 1 ns per N grid
/// units") and all engine timing math is integer-ns throughout.
fn wire_segments(
    circuit: &Circuit,
    by_id: &BTreeMap<&str, usize>,
    wire: &crate::format::Wire,
) -> Vec<u32> {
    if wire.points.len() >= 2 {
        return wire
            .points
            .windows(2)
            .map(|w| {
                let manhattan = (w[1][0] - w[0][0]).abs() + (w[1][1] - w[0][1]).abs();
                manhattan.round() as u32
            })
            .collect();
    }
    let pos = |ep: &Endpoint| -> Option<[i32; 2]> {
        let p = ep.as_pin()?;
        let idx = *by_id.get(p.0)?;
        Some(circuit.components[idx].pos)
    };
    let len = match (pos(&wire.a), pos(&wire.b)) {
        (Some(a), Some(b)) => a[0].abs_diff(b[0]) + a[1].abs_diff(b[1]),
        _ => 0,
    };
    vec![len]
}

/// Raw endpoint extraction for the wire graph (joins kept as references,
/// unlike [`endpoint_node`] which resolves them to a terminal).
fn endpoint_raw(
    by_id: &BTreeMap<&str, usize>,
    local: &BTreeMap<(usize, String), u32>,
    ep: &Endpoint,
    rec_base: usize,
) -> RecEnd {
    match ep {
        Endpoint::Pin(p) => by_id
            .get(p.comp.as_str())
            .and_then(|&i| local.get(&(i, p.pin.clone())))
            .map(|&n| RecEnd::Pin(n))
            .unwrap_or(RecEnd::None),
        Endpoint::Join(j) => RecEnd::Join(rec_base + j.join.wire as usize, j.join.segment),
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

/// Per-net wire graphs: driver→sink shortest-path lengths through the
/// drawn geometry (contract v1.1, F14 — per-path wire delays).
///
/// Nodes are pin UF-terminals plus synthesized junction nodes; edges are
/// wire (sub-)segments weighted by drawn length. A junction onto segment
/// `s` of a target wire attaches at the segment's MIDPOINT (uniform
/// assumption — the format does not record an intra-segment position;
/// documented in docs/delay-table.md).
struct WireGraphs<'a> {
    uf: &'a mut Uf,
    recs: &'a [WireRec],
    net_of_root: &'a BTreeMap<u32, NetId>,
}

impl WireGraphs<'_> {
    fn compute(&mut self, nets: &mut [Net], comps: &[FlatComp], terminal_of: &[Vec<u32>]) {
        let n_uf = self.uf.parent.len() as u32;
        let n_recs = self.recs.len();

        // -- Junction nodes + split points per target wire ----------------
        let mut join_node: Vec<[Option<u32>; 2]> = vec![[None; 2]; n_recs];
        let mut splits: Vec<Vec<(u32, u32)>> = vec![Vec::new(); n_recs];
        let mut next = n_uf;
        for (i, rec) in self.recs.iter().enumerate() {
            for (end, ep) in [rec.a, rec.b].into_iter().enumerate() {
                if let RecEnd::Join(target, seg) = ep {
                    let jn = next;
                    next += 1;
                    join_node[i][end] = Some(jn);
                    if target < n_recs {
                        let trec = &self.recs[target];
                        let mut d = 0u32;
                        for (si, s) in trec.segs.iter().enumerate() {
                            if si == seg as usize {
                                d += s / 2; // segment midpoint (module docs)
                                break;
                            }
                            d += s;
                        }
                        splits[target].push((d.min(trec.len()), jn));
                    }
                }
            }
        }
        for s in &mut splits {
            s.sort_unstable();
        }

        // -- Edges per rec (split chains), attributed to a net class ------
        // (u, v, weight, net).
        let mut per_net: Vec<Vec<(u32, u32, u32)>> = vec![Vec::new(); nets.len()];
        let end_node = |i: usize, end: usize| -> Option<u32> {
            match if end == 0 {
                self.recs[i].a
            } else {
                self.recs[i].b
            } {
                RecEnd::None => None,
                RecEnd::Pin(t) => Some(t),
                RecEnd::Join(..) => join_node[i][end],
            }
        };
        for (i, rec) in self.recs.iter().enumerate() {
            let Some(resolved) = rec.resolved else {
                continue;
            };
            let class = self.uf.find(resolved);
            let Some(&net) = self.net_of_root.get(&class) else {
                continue;
            };
            let (ea, eb) = (end_node(i, 0), end_node(i, 1));
            let len = rec.len();
            if splits[i].is_empty() {
                if let (Some(a), Some(b)) = (ea, eb) {
                    per_net[net.idx()].push((a, b, len));
                }
                continue;
            }
            // Chain: a-end → splits (sorted by distance) → b-end.
            let mut prev_node = ea;
            let mut prev_d = 0u32;
            let mut chain: Vec<(Option<u32>, u32)> =
                splits[i].iter().map(|&(d, jn)| (Some(jn), d)).collect();
            chain.push((eb, len));
            for (node, d) in chain {
                if let (Some(u), Some(v)) = (prev_node, node) {
                    per_net[net.idx()].push((u, v, d.saturating_sub(prev_d)));
                }
                prev_node = node;
                prev_d = d;
            }
        }

        // -- Per net: adjacency + Dijkstra from each driver ---------------
        let terminal = |comps: &[FlatComp], c: CompId, pin: &str| -> Option<u32> {
            let slot = comps[c.idx()].pins.iter().position(|p| p.pin == pin)?;
            terminal_of.get(c.idx()).and_then(|t| t.get(slot)).copied()
        };
        for net in nets.iter_mut() {
            let mut adj: BTreeMap<u32, Vec<(u32, u32)>> = BTreeMap::new();
            for &(u, v, w) in &per_net[net.id.idx()] {
                adj.entry(u).or_default().push((v, w));
                adj.entry(v).or_default().push((u, w));
            }
            let sinks: Vec<Option<u32>> = net
                .sinks
                .iter()
                .map(|(c, p)| terminal(comps, *c, p))
                .collect();
            let mut min_per_sink = vec![u32::MAX; sinks.len()];
            let mut by_driver = Vec::with_capacity(net.drivers.len());
            for (didx, (dc, dp)) in net.drivers.iter().enumerate() {
                let Some(dt) = terminal(comps, *dc, dp) else {
                    continue;
                };
                let dist = dijkstra(&adj, dt);
                let mut per_sink = Vec::with_capacity(sinks.len());
                for (si, st) in sinks.iter().enumerate() {
                    let d = st.and_then(|st| dist.get(&st)).copied();
                    if let Some(d) = d {
                        min_per_sink[si] = min_per_sink[si].min(d);
                        per_sink.push(d);
                    } else {
                        per_sink.push(u32::MAX);
                    }
                }
                by_driver.push((didx as u32, per_sink));
            }
            let fallback = net.wire_len;
            net.sink_wire_units = min_per_sink
                .iter()
                .map(|&d| if d == u32::MAX { fallback } else { d })
                .collect();
            net.sink_wire_by_driver = by_driver
                .into_iter()
                .map(|(didx, ds)| {
                    (
                        didx,
                        ds.into_iter()
                            .map(|d| if d == u32::MAX { fallback } else { d })
                            .collect(),
                    )
                })
                .collect();
        }
    }
}

/// Dijkstra shortest paths from `src` over a small weighted graph
/// (adjacency lists). Deterministic: integer weights, `BTreeMap` storage.
fn dijkstra(adj: &BTreeMap<u32, Vec<(u32, u32)>>, src: u32) -> BTreeMap<u32, u32> {
    use std::cmp::Reverse;
    let mut dist = BTreeMap::from([(src, 0u32)]);
    let mut heap = std::collections::BinaryHeap::new();
    heap.push(Reverse((0u32, src)));
    while let Some(Reverse((d, u))) = heap.pop() {
        if dist.get(&u).is_some_and(|&best| d > best) {
            continue;
        }
        if let Some(edges) = adj.get(&u) {
            for &(v, w) in edges {
                let nd = d.saturating_add(w);
                if dist.get(&v).is_none_or(|&best| nd < best) {
                    dist.insert(v, nd);
                    heap.push(Reverse((nd, v)));
                }
            }
        }
    }
    dist
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
    #[test]
    fn wire_length_accumulates_per_net() {
        // One 200-unit wire (polyline) + one 30-unit wire (endpoint
        // distance, no drawn points) on the same net → 230.
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t",
            "settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"src","type":"wiring.pin","pos":[0,0],"name":"a"},
                {"id":"m","type":"wiring.pin","pos":[10,0],"name":"b","attrs":{"isOutput":true}},
                {"id":"p","type":"wiring.probe","pos":[40,0]}
            ], "wires": [
                {"a":{"comp":"src","pin":"pin"},"b":{"comp":"m","pin":"pin"},
                 "points":[[0,0],[100,0],[100,100]]},
                {"a":{"comp":"m","pin":"pin"},"b":{"comp":"p","pin":"in"}}
            ]}]
        }"##;
        let nl = build_json(json).unwrap();
        assert_eq!(nl.nets.len(), 1);
        assert_eq!(nl.nets[0].wire_len, 200 + 30);
        // No drawn points and no resolvable geometry → 0.
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t",
            "settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"src","type":"wiring.pin","pos":[0,0],"name":"a"},
                {"id":"p","type":"wiring.probe","pos":[0,0]}
            ], "wires": [
                {"a":{"comp":"src","pin":"pin"},"b":{"comp":"p","pin":"in"},"points":[[0,0]]}
            ]}]
        }"##;
        let nl = build_json(json).unwrap();
        assert_eq!(nl.nets[0].wire_len, 0);
    }

    #[test]
    fn fractional_wire_geometry_quantizes_to_whole_units() {
        // Half-grid points: [0,0]→[5,0] = 5 exactly; [5,0]→[5,1.5] = 1.5
        // quantized to 2 (transport delay is integer-ns approximate).
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t",
            "settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"src","type":"wiring.pin","pos":[0,0],"name":"a"},
                {"id":"p","type":"wiring.probe","pos":[10,0]}
            ], "wires": [
                {"a":{"comp":"src","pin":"pin"},"b":{"comp":"p","pin":"in"},
                 "points":[[0,0],[5,0],[5,1.5]]}
            ]}]
        }"##;
        let nl = build_json(json).unwrap();
        assert_eq!(nl.nets[0].wire_len, 5 + 2);
    }

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
    fn autoload_memories_are_hierarchical() {
        // F12: a memory inside a subcircuit instance is addressed by its
        // hierarchical name (`u1/imem`), matching the `named` registry.
        let json = header(
            r##"{"name":"chip","components":[
                {"id":"m","type":"mem.ram","pos":[0,0],"name":"imem",
                 "attrs":{"bitsize":32,"depth":16,"autoload":"prog.hex"}}
            ]},
            {"name":"main","components":[
                {"id":"u1","type":"subcircuit","pos":[0,0],"attrs":{"circuit":"chip"}},
                {"id":"u2","type":"subcircuit","pos":[0,4],"attrs":{"circuit":"chip"}},
                {"id":"t","type":"mem.rom","pos":[4,0],"name":"top",
                 "attrs":{"bitsize":32,"depth":16,"autoload":"top.hex"}}
            ]}"##,
        );
        let doc = crate::format::load_document(json.as_bytes()).unwrap();
        let loads = autoload_memories(&doc);
        assert_eq!(
            loads,
            vec![
                ("top".to_string(), "top.hex".to_string()),
                ("u1/imem".to_string(), "prog.hex".to_string()),
                ("u2/imem".to_string(), "prog.hex".to_string()),
            ]
        );
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
