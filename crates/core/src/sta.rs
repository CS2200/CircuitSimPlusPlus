//! Static timing analysis — **informational only** (DESIGN.md §4.4,
//! decision D11; BACKEND.md task B8).
//!
//! STA computes the structural worst-case settle time `T_sta` over the
//! flattened netlist with delay-table numbers. It is a *structural
//! bound*: the report must label it "may include paths your design never
//! uses" (microcode ROMs, multi-use buses). Grading uses DTA (task B6);
//! STA exists so TAs can eyeball anomalies and students can bound their
//! clock before running the suite.
//!
//! ## Model
//!
//! - **Breaks:** register `q` and source components (`wiring.pin` inputs,
//!   constants, clocks, buttons) start paths at arrival 0. Register
//!   `d`/`en`/`rst` and RAM `din`/`we`/`addr` are **endpoints** (they
//!   must settle before the clock edge); so are output pins, probes, and
//!   LEDs/displays (they bound comb-only designs like an ALU).
//! - **Through-edges:** combinational comps contribute `prop` (table,
//!   per-bit scaled, `attrs.delay` applied) from every input pin to
//!   every output pin; RAM/ROM `addr → dout` contributes `access`
//!   (asynchronous read, §6).
//! - **Wires:** a net's transport delay (`wire_len ×` table constant)
//!   is added where its drivers meet it.
//! - **Splitters** are wiring: all of a splitter's pin nets are
//!   union-find merged into one STA node with zero added delay. The
//!   merged node's arrival is the max over its member nets (per-member
//!   wire delay included; the split side's own stub length is not
//!   double-counted).
//! - **Pure-combinational cycles** have no max-plus fixed point: they
//!   are a clean [`StaError`], not a hang (the zero-delay engine's
//!   fixed-point residue semantics do not apply to longest paths).
//!
//! Determinism (§4.6): all iteration is index-ordered; equal-arrival
//! ties resolve to the lowest `CompId`/net index.

use std::collections::VecDeque;

use thiserror::Error;

use crate::api::CompId;
use crate::components::PinDir;
use crate::netlist::Netlist;
use crate::timing_table::TimingTable;

/// One structural path: `delay` arrives at `endpoint` (a register/memory
/// input, output pin, or probe); `comps` is the driver chain, endpoint's
/// driver first, source last — same convention as DTA's top paths.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaPath {
    /// Structural arrival time at the endpoint.
    pub delay: u64,
    /// Component at whose input the path ends.
    pub endpoint: CompId,
    /// Driver chain, endpoint's driver first, source last.
    pub comps: Vec<CompId>,
}

/// STA output. `t_sta` is the structural clock-period bound (max over
/// all endpoint arrivals).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StaResult {
    /// Structural clock-period bound (max over all endpoint arrivals).
    pub t_sta: u64,
    /// Top-k longest structural paths, longest first (deterministic
    /// tie-break, §4.6).
    pub top_paths: Vec<StaPath>,
}

/// STA cannot proceed (§4.4: clean error, never a hang).
#[derive(Debug, Error, PartialEq, Eq)]
#[error(
    "combinational cycle: static timing has no fixed point through {} component(s) in or downstream of the loop",
    comps.len()
)]
pub struct StaError {
    /// Components in or downstream of the cycle, in comp order.
    pub comps: Vec<CompId>,
}

/// Per-component structural role (from the type string + pin directions).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    /// Drives its Out pins at arrival 0 (pin-in/constant/clock/button/
    /// register).
    Source,
    /// Every In pin to every Out pin, weight `prop`.
    Comb { prop: u64 },
    /// `addr → dout` with weight `access`; `din`/`we`/`addr` endpoints.
    Ram { access: u64 },
    /// `addr → dout` with weight `access`.
    Rom { access: u64 },
    /// Consumes only (pin-out/probe/LED/display).
    EndpointOnly,
    /// Wiring: pin nets union-merged, zero delay.
    Splitter,
}

fn role_of(type_: &str, in_width: u32, table: &TimingTable, delay_override: Option<u64>) -> Role {
    match type_ {
        "wiring.splitter" => Role::Splitter,
        // Registers are timing breaks: q restarts paths at 0, data inputs
        // are endpoints (collected by the caller).
        "mem.register" => Role::Source,
        "mem.ram" => Role::Ram {
            access: table.timing(type_, in_width, delay_override).access,
        },
        "mem.rom" => Role::Rom {
            access: table.timing(type_, in_width, delay_override).access,
        },
        "wiring.probe" | "io.led" | "io.hexdisplay" => Role::EndpointOnly,
        _ => {
            let t = table.timing(type_, in_width, delay_override);
            if t.prop == 0 && t.access == 0 {
                Role::Source
            } else {
                Role::Comb { prop: t.prop }
            }
        }
    }
}

/// Union-find over nets (splitter pins merge their nets into one node).
struct NetGroups {
    parent: Vec<u32>,
}

impl NetGroups {
    fn find(&mut self, mut x: u32) -> u32 {
        while self.parent[x as usize] != x {
            self.parent[x as usize] = self.parent[self.parent[x as usize] as usize];
            x = self.parent[x as usize];
        }
        x
    }

    fn union(&mut self, a: u32, b: u32) {
        let (ra, rb) = (self.find(a), self.find(b));
        if ra != rb {
            // Deterministic: lower index is the representative.
            if ra < rb {
                self.parent[rb as usize] = ra;
            } else {
                self.parent[ra as usize] = rb;
            }
        }
    }
}

/// Structural longest-path analysis. `top_k` bounds the returned path
/// list (DESIGN.md §8.1's `timing --paths k`).
pub fn analyze(
    netlist: &Netlist,
    table: &TimingTable,
    top_k: usize,
) -> Result<StaResult, StaError> {
    let n_comps = netlist.comps.len();
    let n_nets = netlist.nets.len();

    // -- Roles, union-find groups, endpoints ------------------------------
    let mut groups = NetGroups {
        parent: (0..n_nets as u32).collect(),
    };
    for fc in &netlist.comps {
        if fc.type_ == "wiring.splitter" {
            for p in &fc.pins[1..] {
                groups.union(fc.pins[0].net.0, p.net.0);
            }
        }
    }
    // Compress once so every later `find` is O(1)-ish.
    for n in 0..n_nets as u32 {
        groups.find(n);
    }
    let group_of = |net: u32| groups.parent[net as usize];

    let mut roles = Vec::with_capacity(n_comps);
    let mut endpoints: Vec<(u32, String, u32)> = Vec::new(); // (comp, pin, group)
    for (ci, fc) in netlist.comps.iter().enumerate() {
        let in_width = fc
            .pins
            .iter()
            .filter(|p| p.dir == PinDir::In)
            .map(|p| p.width)
            .max()
            .unwrap_or(1);
        let delay_override = fc.attrs.get("delay").and_then(|v| v.as_u64());
        let role = role_of(&fc.type_, in_width, table, delay_override);
        roles.push(role);
        match fc.type_.as_str() {
            "mem.register" => {
                for p in &fc.pins {
                    if p.dir == PinDir::In && p.pin != "clk" {
                        endpoints.push((ci as u32, p.pin.clone(), group_of(p.net.0)));
                    }
                }
            }
            "mem.ram" => {
                for p in &fc.pins {
                    if p.dir == PinDir::In && (p.pin == "din" || p.pin == "we" || p.pin == "addr") {
                        endpoints.push((ci as u32, p.pin.clone(), group_of(p.net.0)));
                    }
                }
            }
            "wiring.pin" | "wiring.probe" | "io.led" | "io.hexdisplay" => {
                for p in &fc.pins {
                    if p.dir == PinDir::In {
                        endpoints.push((ci as u32, p.pin.clone(), group_of(p.net.0)));
                    }
                }
            }
            _ => {}
        }
    }

    // -- Group drivers/readers (splitters excluded — they vanish) ---------
    let mut group_drivers: Vec<Vec<u32>> = vec![Vec::new(); n_nets];
    let mut group_nets: Vec<Vec<u32>> = vec![Vec::new(); n_nets];
    for (ni, net) in netlist.nets.iter().enumerate() {
        let g = group_of(ni as u32) as usize;
        group_nets[g].push(ni as u32);
        for (d, _) in &net.drivers {
            if roles[d.idx()] != Role::Splitter {
                group_drivers[g].push(d.0);
            }
        }
    }
    for drivers in &mut group_drivers {
        drivers.sort_unstable();
        drivers.dedup();
    }

    // Consumed groups per comp (through-path inputs only — endpoints are
    // evaluated after the DP and impose no ordering).
    let mut consumed: Vec<Vec<u32>> = vec![Vec::new(); n_comps];
    for (ci, fc) in netlist.comps.iter().enumerate() {
        match roles[ci] {
            Role::Comb { .. } => {
                for p in &fc.pins {
                    if p.dir == PinDir::In {
                        consumed[ci].push(group_of(p.net.0));
                    }
                }
            }
            Role::Ram { .. } | Role::Rom { .. } => {
                for p in &fc.pins {
                    if p.pin == "addr" {
                        consumed[ci].push(group_of(p.net.0));
                    }
                }
            }
            _ => {}
        }
        consumed[ci].sort_unstable();
        consumed[ci].dedup();
    }

    // -- Two-counter Kahn: a group finalizes once all its drivers are
    //    processed; a comp processes once all its input groups finalized.
    let mut pending_drivers: Vec<usize> = group_drivers.iter().map(Vec::len).collect();
    let mut group_readers: Vec<Vec<u32>> = vec![Vec::new(); n_nets];
    let mut pending_in = vec![0usize; n_comps];
    for (ci, groups_in) in consumed.iter().enumerate() {
        pending_in[ci] = groups_in.len();
        for &g in groups_in {
            group_readers[g as usize].push(ci as u32);
        }
    }

    let mut out_arrival = vec![0u64; n_comps];
    let mut in_cause: Vec<Option<u32>> = vec![None; n_comps];
    let mut processed = vec![false; n_comps];
    let mut group_arrival = vec![0u64; n_nets];
    let mut group_cause: Vec<Option<u32>> = vec![None; n_nets];
    let mut group_final = vec![false; n_nets];

    let mut queue: VecDeque<u32> = (0..n_comps as u32)
        .filter(|&c| pending_in[c as usize] == 0 && roles[c as usize] != Role::Splitter)
        .collect();

    let finalize_group = |g: u32,
                          processed: &[bool],
                          out_arrival: &[u64],
                          group_arrival: &mut [u64],
                          group_cause: &mut [Option<u32>],
                          group_final: &mut [bool]| {
        debug_assert!(group_drivers[g as usize]
            .iter()
            .all(|&d| processed[d as usize]));
        let mut best = 0u64;
        let mut cause = None;
        for &ni in &group_nets[g as usize] {
            let net = &netlist.nets[ni as usize];
            let wd = table.wire_delay(net.wire_len);
            for (d, _) in &net.drivers {
                if roles[d.idx()] == Role::Splitter {
                    continue;
                }
                let cand = out_arrival[d.idx()] + wd;
                if cause.is_none() || cand > best {
                    best = cand;
                    cause = Some(d.0);
                }
            }
        }
        group_arrival[g as usize] = best;
        group_cause[g as usize] = cause;
        group_final[g as usize] = true;
    };

    // Seed: groups with no (non-splitter) drivers finalize at arrival 0.
    for g in 0..n_nets as u32 {
        if pending_drivers[g as usize] == 0 && !group_nets[g as usize].is_empty() {
            finalize_group(
                g,
                &processed,
                &out_arrival,
                &mut group_arrival,
                &mut group_cause,
                &mut group_final,
            );
            for &r in &group_readers[g as usize] {
                pending_in[r as usize] -= 1;
                if pending_in[r as usize] == 0 {
                    queue.push_back(r);
                }
            }
        }
    }

    while let Some(c) = queue.pop_front() {
        if processed[c as usize] {
            continue;
        }
        processed[c as usize] = true;
        let ci = c as usize;
        let (arrival, cause) = match roles[ci] {
            Role::Source => (0, None),
            Role::Comb { prop } => {
                let mut best = 0u64;
                let mut cause = None;
                for &g in &consumed[ci] {
                    debug_assert!(group_final[g as usize]);
                    let cand = group_arrival[g as usize];
                    if cause.is_none() || cand > best {
                        best = cand;
                        cause = Some(g);
                    }
                }
                (best + prop, cause)
            }
            Role::Ram { access } | Role::Rom { access } => {
                // (A RAM/ROM always has an `addr` pin; `first` is just
                // defensive.)
                match consumed[ci].first() {
                    Some(&g) => (group_arrival[g as usize] + access, Some(g)),
                    None => (0, None),
                }
            }
            Role::EndpointOnly | Role::Splitter => (0, None), // unreachable
        };
        out_arrival[ci] = arrival;
        in_cause[ci] = cause;
        // Free groups this comp drives (dedup: several Out pins may land
        // on the same group, but the comp is counted once per group).
        let mut driven: Vec<u32> = netlist.comps[ci]
            .pins
            .iter()
            .filter(|p| p.dir != PinDir::In)
            .map(|p| group_of(p.net.0))
            .collect();
        driven.sort_unstable();
        driven.dedup();
        for g in driven {
            pending_drivers[g as usize] -= 1;
            if pending_drivers[g as usize] == 0 {
                finalize_group(
                    g,
                    &processed,
                    &out_arrival,
                    &mut group_arrival,
                    &mut group_cause,
                    &mut group_final,
                );
                for &r in &group_readers[g as usize] {
                    pending_in[r as usize] -= 1;
                    if pending_in[r as usize] == 0 {
                        queue.push_back(r);
                    }
                }
            }
        }
    }

    let leftover: Vec<CompId> = (0..n_comps as u32)
        .filter(|&c| !processed[c as usize] && roles[c as usize] != Role::Splitter)
        .map(CompId)
        .collect();
    if !leftover.is_empty() {
        return Err(StaError { comps: leftover });
    }

    // -- Endpoints, T_sta, top-k paths ------------------------------------
    let mut cands: Vec<(u64, u32, &str, u32)> = endpoints
        .iter()
        .map(|(c, pin, g)| (group_arrival[*g as usize], *c, pin.as_str(), *g))
        .collect();
    cands.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)).then(a.2.cmp(b.2)));
    let t_sta = cands.first().map(|c| c.0).unwrap_or(0);

    let top_paths = cands
        .iter()
        .take(top_k)
        .map(|&(delay, comp, _, mut g)| {
            let mut path = Vec::new();
            while let Some(d) = group_cause[g as usize] {
                path.push(CompId(d));
                match in_cause[d as usize] {
                    Some(next) => g = next,
                    None => break,
                }
            }
            StaPath {
                delay,
                endpoint: CompId(comp),
                comps: path,
            }
        })
        .collect();

    Ok(StaResult { t_sta, top_paths })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::load_document;
    use crate::netlist;

    const SETTINGS: &str =
        r#""settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"}"#;

    fn sta(json: &str, k: usize) -> Result<(StaResult, netlist::Netlist), StaError> {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        let table = TimingTable::builtin("cs2200-74ls-v1").unwrap();
        analyze(&nl, &table, k).map(|r| (r, nl))
    }

    fn names<'a>(nl: &'a netlist::Netlist, comps: &[CompId]) -> Vec<&'a str> {
        comps
            .iter()
            .map(|c| nl.comps[c.idx()].def_id.as_str())
            .collect()
    }

    /// r1 toggles (d ← not(q)); r1.q → not → and(+const1) → r2.d.
    /// T_sta = not 9 + and 10 = 19, path [and, n1, r1] ending at source r1.
    fn pipeline_json() -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"r1","type":"mem.register","pos":[0,0]}},
                {{"id":"n1","type":"gate.not","pos":[0,0]}},
                {{"id":"a1","type":"gate.and","pos":[0,0]}},
                {{"id":"r2","type":"mem.register","pos":[0,0]}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r2","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r2","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"a1","pin":"in1"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"n1","pin":"in"}}}},
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"a1","pin":"in0"}}}},
                {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"r2","pin":"d"}}}}
            ]}}]
        }}"##
        )
    }

    #[test]
    fn pipeline_matches_hand_computed() {
        let (r, nl) = sta(&pipeline_json(), 10).unwrap();
        assert_eq!(r.t_sta, 19, "not 9 + and 10");
        let p = &r.top_paths[0];
        assert_eq!(p.delay, 19);
        assert_eq!(nl.comps[p.endpoint.idx()].def_id, "r2");
        assert_eq!(names(&nl, &p.comps), ["a1", "n1", "r1"]);
    }

    #[test]
    fn adder32_ripple_scales_per_bit() {
        // pin(32) → adder(+const) → register: T_sta = 15 + 31×4 = 139.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src","attrs":{{"bitsize":32}}}},
                {{"id":"add","type":"arith.adder","pos":[0,0],"attrs":{{"bitsize":32}}}},
                {{"id":"dst","type":"mem.register","pos":[0,0],"attrs":{{"bitsize":32}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"dst","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"dst","pin":"en"}}}},
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"add","pin":"a"}}}},
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"add","pin":"b"}}}},
                {{"a":{{"comp":"add","pin":"out"}},"b":{{"comp":"dst","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let (r, nl) = sta(&json, 10).unwrap();
        assert_eq!(r.t_sta, 15 + 31 * 4);
        assert_eq!(names(&nl, &r.top_paths[0].comps), ["add", "src"]);
    }

    #[test]
    fn wire_delay_and_rom_access_count() {
        // pin →(200-grid-unit wire = 20 ns)→ and → reg.d; reg.q →
        // rom.addr →(access 50)→ rom.dout → probe. T_sta = 50 path wins.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"s"}},
                {{"id":"a1","type":"gate.and","pos":[0,0]}},
                {{"id":"r1","type":"mem.register","pos":[0,0]}},
                {{"id":"rom","type":"mem.rom","pos":[0,0],"attrs":{{"depth":2}}}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"p"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"a1","pin":"in1"}}}},
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"a1","pin":"in0"}},
                 "points":[[0,0],[100,0],[100,100]]}},
                {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"rom","pin":"addr"}}}},
                {{"a":{{"comp":"rom","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let (r, nl) = sta(&json, 10).unwrap();
        assert_eq!(r.t_sta, 50, "ROM access from a register output");
        assert_eq!(names(&nl, &r.top_paths[0].comps), ["rom", "r1"]);
        // Second-longest: wire 20 + and 10 = 30 at r1.d.
        assert_eq!(r.top_paths[1].delay, 30);
        assert_eq!(
            nl.comps[r.top_paths[1].endpoint.idx()].def_id,
            "r1",
            "endpoint is the register's d pin"
        );
    }

    #[test]
    fn splitter_is_zero_delay_wiring() {
        // pin → splitter bus; split bit → and → reg.d: T_sta = 10.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"s","attrs":{{"bitsize":2}}}},
                {{"id":"sp","type":"wiring.splitter","pos":[0,0],
                  "attrs":{{"splits":{{"a":[0],"b":[1]}}}}}},
                {{"id":"a1","type":"gate.and","pos":[0,0]}},
                {{"id":"r1","type":"mem.register","pos":[0,0]}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"a1","pin":"in1"}}}},
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"sp","pin":"bus"}}}},
                {{"a":{{"comp":"sp","pin":"a"}},"b":{{"comp":"a1","pin":"in0"}}}},
                {{"a":{{"comp":"a1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let (r, _) = sta(&json, 10).unwrap();
        assert_eq!(r.t_sta, 10, "splitter adds no delay");
    }

    #[test]
    fn combinational_cycle_is_a_clean_error() {
        // nand(a,a) feeding itself = comb loop; downstream probe included.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"g","type":"gate.nand","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"p"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"g","pin":"in1"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"g","pin":"in0"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let e = sta(&json, 10).unwrap_err();
        assert!(e.to_string().contains("combinational cycle"), "{e}");
        assert_eq!(e.comps.len(), 1, "just the nand; the probe is an endpoint");
    }

    #[test]
    fn perf_3p4k_components() {
        // Same synthetic as netlist's perf test: 400×3-not cells + a
        // 2200-not chain, 32-bit datapath. STA: 3400 nots × 9 = 30600.
        // All positions [0,0]: the no-drawn-points wire-length fallback
        // (endpoint Manhattan distance) then contributes 0.
        let mut main_comps = String::new();
        let mut main_wires = String::new();
        main_comps.push_str(
            r#"{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src","attrs":{"bitsize":32}},"#,
        );
        let n_cells = 400;
        for i in 0..n_cells {
            main_comps.push_str(&format!(
                r#"{{"id":"cell{i}","type":"subcircuit","pos":[0,0],"attrs":{{"circuit":"cell"}}}},"#
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
        for i in 0..2200 {
            main_comps.push_str(&format!(
                r#"{{"id":"g{i}","type":"gate.not","pos":[0,0],"attrs":{{"bitsize":32}}}},"#
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
            r#"{"id":"sink","type":"wiring.probe","pos":[0,0],"name":"sink","attrs":{"bitsize":32}}"#,
        );
        main_wires.push_str(r#"{"a":{"comp":"g2199","pin":"out"},"b":{"comp":"sink","pin":"in"}}"#);
        let json = format!(
            r##"{{"format":"circuitsim-plus-plus","version":2,"name":"t",{SETTINGS},"circuits":[
            {{"name":"cell","components":[
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
            {{"name":"main","components":[{main_comps}],"wires":[{main_wires}]}}]}}"##
        );

        let doc = load_document(json.as_bytes()).unwrap();
        let nl = netlist::build(&doc).unwrap();
        let table = TimingTable::builtin("cs2200-74ls-v1").unwrap();
        let start = std::time::Instant::now();
        let r = analyze(&nl, &table, 10).unwrap();
        let elapsed = start.elapsed();
        eprintln!("sta perf_3p4k: T_sta={} in {elapsed:?}", r.t_sta);
        assert_eq!(r.t_sta, 3400 * 9, "3400 inverters at 9 ns each");
        // Generous debug-build bound; the <100 ms acceptance is release.
        assert!(elapsed.as_secs() < 10, "STA too slow: {elapsed:?}");
    }
}
