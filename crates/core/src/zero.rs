//! Zero-delay engine (DESIGN.md §4.2; BACKEND.md task B5).
//!
//! At load: flatten (task B3), cut at state elements, levelize once
//! (Kahn). Each simulated cycle is then:
//!
//! 1. the clock edge — every clocked component (register, RAM) whose
//!    `clk` net rose latches/writes simultaneously, sampling the values
//!    settled at the end of the previous cycle;
//! 2. one walk down the sorted component list — the whole combinational
//!    cloud settles in a single pass, because a gate's inputs are always
//!    final before the gate runs.
//!
//! No event queue, no iteration-to-converge, no races: identical inputs
//! always produce identical outputs (§4.6).
//!
//! ## Cycles and ticks
//!
//! The global clock is engine-driven; `wiring.clock` components mirror it
//! (§4.7). A *tick* is a half-cycle: toggle the phase, settle, latch on
//! rising edges, settle again. A *cycle* is two ticks (high then low);
//! [`ZeroEngine::cycle`] counts rising edges. A register whose `clk` is
//! driven by logic rather than a clock component (e.g. a ripple counter
//! bit) is still edge-detected — its latch is observed on the tick after
//! its `clk` settles high, which is the best the zero-delay abstraction
//! can do (the delay-aware engine, task B6, models it exactly).
//!
//! ## Combinational cycles (§4.5)
//!
//! Components Kahn can't schedule (feedback loops + everything downstream
//! of them) form the *residue*, evaluated each settle by bounded
//! fixed-point iteration (comp-index order, cap = `residue.len() + 2`,
//! which propagates stability one residue-depth per pass). Feedback nets
//! are seeded to 0 at power-on — deterministic (§4.5: nothing is ever
//! resolved randomly), and it makes well-formed feedback (an SR latch)
//! converge while true paradoxes (an odd inverter ring) fail to
//! converge: all nets the residue touches become `X` and the run halts
//! with an oscillation error. The simulator never hangs.
//!
//! ## Net resolution
//!
//! A net's value is derived on demand by contention-merging its drivers'
//! current pin slots (`Value::contention_merge` per §4.1); there is no
//! stale incremental-merge bookkeeping, so splitter re-evaluation during
//! fixed-point iteration is trivially correct.

use std::collections::VecDeque;

use serde::{Deserialize, Serialize};
use serde_json::Value as Json;

use crate::api::{HaltReason, LoadError, NamedKind, NetId};
use crate::behavior::{Behavior, FloatingRead};
use crate::components::PinDir;
use crate::netlist::Netlist;
use crate::value::{Bit, Value};

/// A simulation stop with context (task B9 maps reasons to exit codes).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[error("cycle {cycle}: {reason:?}: {details}")]
pub struct Halt {
    /// Why the simulation stopped.
    pub reason: HaltReason,
    /// Cycle at which the halt occurred.
    pub cycle: u64,
    /// Human-readable context (e.g. the offending component and pin).
    pub details: String,
}

/// The zero-delay engine: owns the netlist, component behaviors, and all
/// mutable simulation state.
#[derive(Debug, Clone)]
pub struct ZeroEngine {
    netlist: Netlist,
    comps: Vec<Behavior>,
    /// Driven value per pin slot, comp-major in `PinConn` order. Only
    /// Out/InOut pins are meaningful; a net's value is the merge of its
    /// drivers' slots.
    drives: Vec<Vec<Value>>,
    /// Per net: (comp, pin slot) of each driver, precomputed.
    net_drivers: Vec<Vec<(u32, usize)>>,
    /// Kahn-scheduled DAG components, in evaluation order.
    order: Vec<u32>,
    /// Feedback components + downstream (fixed-point set), comp order.
    residue: Vec<u32>,
    clock_phase: bool,
    /// Last settled clk-pin state per clocked comp (true = known high).
    prev_clk: Vec<bool>,
    cycle: u64,
}

use crate::engine_common::{resolve, resolve_except};

/// Evaluate one component and publish its outputs into the drive slots.
/// Returns `true` if any driven value changed.
fn eval_comp(
    netlist: &Netlist,
    net_drivers: &[Vec<(u32, usize)>],
    comps: &[Behavior],
    drives: &mut [Vec<Value>],
    c: u32,
) -> Result<bool, FloatingRead> {
    let fc = &netlist.comps[c as usize];
    let beh = &comps[c as usize];
    let mut changed = false;
    if beh.is_splitter() {
        let nets: Vec<Value> = fc
            .pins
            .iter()
            .map(|p| resolve_except(netlist, net_drivers, drives, p.net, c))
            .collect();
        let out = beh.eval_splitter(&nets);
        for (slot, v) in out.into_iter().enumerate() {
            if drives[c as usize][slot] != v {
                drives[c as usize][slot] = v;
                changed = true;
            }
        }
        return Ok(changed);
    }
    // Gather inputs (In pins in PinConn order = behavior ins order).
    let ins: Vec<Value> = fc
        .pins
        .iter()
        .filter(|p| p.dir == PinDir::In)
        .map(|p| resolve(netlist, net_drivers, drives, p.net))
        .collect();
    let ins_refs: Vec<&Value> = ins.iter().collect();
    let outs = beh.eval(&ins_refs)?;
    // Publish outputs (Out pins in PinConn order = behavior outs order).
    let mut out_idx = 0;
    for (slot, pin) in fc.pins.iter().enumerate() {
        if pin.dir == PinDir::Out {
            let v = outs[out_idx].clone();
            out_idx += 1;
            if drives[c as usize][slot] != v {
                drives[c as usize][slot] = v;
                changed = true;
            }
        }
    }
    debug_assert_eq!(out_idx, outs.len(), "output count matches Out pins");
    Ok(changed)
}

/// Levelize (Kahn) over the flattened netlist: DAG components in
/// evaluation order, then the residue (feedback + downstream) in
/// comp-index order.
///
/// Dependency rule: comp B depends on every comp driving a net that B
/// consumes. Consumed pins come from `Behavior::comb_input_deps`
/// (register: none; RAM: `addr` only). Splitters consume every pin net
/// that has a driver other than themselves (their direction is dynamic;
/// static other-driver presence is the best DAG approximation — genuine
/// both-ways usage lands in the residue and iterates to fixpoint).
/// Self-loops force self-fed components into the residue — EXCEPT a
/// splitter's own driver listing (splitter pins are InOut, so a splitter
/// is always nominally a driver of its own nets; that pseudo-loop is not
/// feedback — its direction is resolved at evaluation, and treating it
/// as one wrongly seeded static splitter cones to 0, B11).
pub(crate) fn levelize(netlist: &Netlist, comps: &[Behavior]) -> (Vec<u32>, Vec<u32>) {
    let n = netlist.comps.len();
    let mut indeg = vec![0usize; n];
    let mut edges: Vec<Vec<u32>> = vec![Vec::new(); n];
    let mut add_edge = |from: u32, to: u32| {
        edges[from as usize].push(to);
        indeg[to as usize] += 1;
    };
    for (ci, beh) in comps.iter().enumerate() {
        let fc = &netlist.comps[ci];
        let consumed_nets: Vec<NetId> = if beh.is_splitter() {
            fc.pins
                .iter()
                .map(|p| p.net)
                .filter(|net| {
                    netlist.nets[net.idx()]
                        .drivers
                        .iter()
                        .any(|(drv, _)| drv.idx() != ci)
                })
                .collect()
        } else {
            let in_positions: Vec<usize> = fc
                .pins
                .iter()
                .enumerate()
                .filter(|(_, p)| p.dir == PinDir::In)
                .map(|(i, _)| i)
                .collect();
            beh.comb_input_deps(in_positions.len())
                .into_iter()
                .map(|dep| fc.pins[in_positions[dep]].net)
                .collect()
        };
        let splitter = beh.is_splitter();
        for net in consumed_nets {
            for (drv, _) in &netlist.nets[net.idx()].drivers {
                // A splitter's pins are InOut, so it is always listed as a
                // driver of its own nets — a *pseudo* self-loop that is
                // not feedback (its drive direction is dynamic, resolved
                // at evaluation). Real self-loops (a gate feeding itself)
                // still force the residue.
                if splitter && drv.idx() == ci {
                    continue;
                }
                add_edge(drv.0, ci as u32);
            }
        }
    }
    // Kahn, seeded and processed deterministically.
    let mut queue: VecDeque<u32> = (0..n as u32).filter(|&i| indeg[i as usize] == 0).collect();
    let mut order = Vec::with_capacity(n);
    let mut scheduled = vec![false; n];
    while let Some(c) = queue.pop_front() {
        if scheduled[c as usize] {
            continue; // duplicate queue entries from multi-edge frees
        }
        scheduled[c as usize] = true;
        order.push(c);
        for &next in &edges[c as usize] {
            indeg[next as usize] -= 1;
            if indeg[next as usize] == 0 {
                queue.push_back(next);
            }
        }
    }
    let residue: Vec<u32> = (0..n as u32).filter(|&i| !scheduled[i as usize]).collect();
    (order, residue)
}

impl ZeroEngine {
    /// Build an engine from a flattened netlist (task B3). Errors only if
    /// a component has no behavior — impossible for a validated document
    /// (subcircuits are inlined; unknown types are rejected at load).
    pub fn new(netlist: Netlist) -> Result<ZeroEngine, Vec<LoadError>> {
        let comps = crate::engine_common::build_behaviors(&netlist)?;
        let net_drivers = crate::engine_common::net_drivers(&netlist);
        let (order, residue) = levelize(&netlist, &comps);
        let n_comps = comps.len();
        // Drive slots start fully floating (Z); residue (feedback) outputs
        // are seeded to 0 — deterministic power-on for cyclic logic.
        // Splitters are excepted: they carry values but never originate
        // them, so a 0 seed would phantom-contend with the other side of
        // a splitter chain (B11).
        let mut drives = crate::engine_common::drive_slots(&netlist);
        for (ci, fc) in netlist.comps.iter().enumerate() {
            if residue.contains(&(ci as u32)) && !comps[ci].is_splitter() {
                for (slot, p) in fc.pins.iter().enumerate() {
                    if p.dir != PinDir::In {
                        drives[ci][slot] = Value::zero(p.width);
                    }
                }
            }
        }
        Ok(ZeroEngine {
            netlist,
            comps,
            drives,
            net_drivers,
            order,
            residue,
            clock_phase: false,
            prev_clk: vec![false; n_comps],
            cycle: 0,
        })
    }

    /// The flattened design under simulation.
    pub fn netlist(&self) -> &Netlist {
        &self.netlist
    }

    /// Rising clock edges processed so far (the cycle count).
    pub fn cycle(&self) -> u64 {
        self.cycle
    }

    /// Current resolved value of a net.
    pub fn net_value(&self, net: NetId) -> Value {
        resolve(&self.netlist, &self.net_drivers, &self.drives, net)
    }

    /// Value of a named component: probe (its input net), register
    /// (stored value), input/output pin (its net), memory word via
    /// [`ZeroEngine::memory_word`].
    pub fn named_value(&self, name: &str) -> Option<Value> {
        let named = self.netlist.named.iter().find(|n| n.name == name)?;
        let ci = named.comp_id.idx();
        match named.kind {
            NamedKind::Register => self.comps[ci].register_value().cloned(),
            NamedKind::Probe => {
                let fc = &self.netlist.comps[ci];
                let pin = fc.pins.iter().find(|p| p.dir == PinDir::In)?;
                Some(self.net_value(pin.net))
            }
            NamedKind::Ram | NamedKind::Rom => None,
        }
    }

    /// Read a word from a named memory (autograder `mem_read`, task B9).
    pub fn memory_word(&self, name: &str, addr: u64) -> Option<Value> {
        let named = self.netlist.named.iter().find(|n| n.name == name)?;
        match named.kind {
            NamedKind::Ram | NamedKind::Rom => {
                self.comps[named.comp_id.idx()].memory_word(addr as usize)
            }
            _ => None,
        }
    }

    /// Write a word to a named RAM (autograder `mem_write`, task B9).
    pub fn set_memory_word(&mut self, name: &str, addr: u64, v: Value) -> bool {
        let Some(named) = self.netlist.named.iter().find(|n| n.name == name) else {
            return false;
        };
        if named.kind != NamedKind::Ram {
            return false;
        }
        self.comps[named.comp_id.idx()].set_memory_word(addr as usize, v);
        true
    }

    /// Bulk-load a named memory's image (autoload/`--load`, task B9).
    pub fn load_memory_image(&mut self, name: &str, image: &[u64]) -> bool {
        let Some(named) = self.netlist.named.iter().find(|n| n.name == name) else {
            return false;
        };
        match named.kind {
            NamedKind::Ram | NamedKind::Rom => {
                self.comps[named.comp_id.idx()].load_words(image);
                true
            }
            _ => false,
        }
    }

    /// Drive a root input pin's value (test setup / interactive poking).
    /// Settles afterwards so the poke is visible in net values.
    pub fn poke_input_pin(&mut self, name: &str, v: Value) -> Result<bool, Halt> {
        let Some(fc) = self
            .netlist
            .comps
            .iter()
            .find(|c| c.type_ == "wiring.pin" && c.name.as_deref() == Some(name))
        else {
            return Ok(false);
        };
        self.comps[fc.id.idx()].set_pin_value(v);
        self.settle()?;
        Ok(true)
    }

    /// One half-cycle: toggle the global phase, settle, latch clocked
    /// components whose `clk` net rose, settle again to propagate the new
    /// state. Rising edges increment [`ZeroEngine::cycle`].
    pub fn step_tick(&mut self) -> Result<(), Halt> {
        self.clock_phase = !self.clock_phase;
        for b in &mut self.comps {
            b.set_phase(self.clock_phase);
        }
        self.settle()?;
        self.detect_edges()?;
        self.settle()?;
        Ok(())
    }

    /// One full clock cycle (two ticks: high, then low).
    pub fn step_cycle(&mut self) -> Result<(), Halt> {
        self.step_tick()?; // rising edge, cycle += 1
        self.step_tick() // falling edge
    }

    /// Run `n` full cycles, stopping early on a halt.
    pub fn run(&mut self, n: u64) -> Result<(), Halt> {
        for _ in 0..n {
            self.step_cycle()?;
        }
        Ok(())
    }

    /// Full engine state as deterministic JSON (savestate; the
    /// autograder's snapshot mechanism, §8.1).
    pub fn snapshot(&self) -> String {
        #[derive(Serialize)]
        struct Snap {
            cycle: u64,
            clock_phase: bool,
            prev_clk: Vec<bool>,
            comps: Vec<Json>,
        }
        serde_json::to_string(&Snap {
            cycle: self.cycle,
            clock_phase: self.clock_phase,
            prev_clk: self.prev_clk.clone(),
            comps: self.comps.iter().map(Behavior::save_state).collect(),
        })
        .expect("snapshot serializes")
    }

    /// Restore a snapshot into this engine (which must have been built
    /// from the same circuit). Re-settles from restored state; a halt
    /// during that settle fails the restore.
    pub fn restore(&mut self, json: &str) -> Result<(), String> {
        #[derive(Deserialize)]
        struct Snap {
            cycle: u64,
            clock_phase: bool,
            prev_clk: Vec<bool>,
            comps: Vec<Json>,
        }
        let snap: Snap = serde_json::from_str(json).map_err(|e| format!("bad snapshot: {e}"))?;
        if snap.comps.len() != self.comps.len() || snap.prev_clk.len() != self.prev_clk.len() {
            return Err("snapshot does not match this circuit".to_string());
        }
        for (b, s) in self.comps.iter_mut().zip(&snap.comps) {
            if !b.load_state(s) {
                return Err("snapshot state does not match component kinds".to_string());
            }
        }
        self.cycle = snap.cycle;
        self.clock_phase = snap.clock_phase;
        self.prev_clk = snap.prev_clk;
        // Re-derive drive slots from state (same seeding as power-on),
        // then settle without latching.
        for (ci, fc) in self.netlist.comps.iter().enumerate() {
            let seeded = self.residue.contains(&(ci as u32)) && !self.comps[ci].is_splitter();
            for (slot, p) in fc.pins.iter().enumerate() {
                self.drives[ci][slot] = if seeded && p.dir != PinDir::In {
                    Value::zero(p.width)
                } else {
                    Value::z(p.width)
                };
            }
        }
        self.settle().map_err(|h| h.details)
    }

    /// The single-sweep settle + bounded fixed-point iteration over the
    /// residue (module docs).
    fn settle(&mut self) -> Result<(), Halt> {
        let Self {
            netlist,
            comps,
            drives,
            net_drivers,
            order,
            residue,
            cycle,
            ..
        } = self;
        let halt = |c: u32, fr: FloatingRead| Halt {
            reason: HaltReason::FloatingRead,
            cycle: *cycle,
            details: format!("{}: pin '{}'", netlist.comps[c as usize].origin(), fr.pin),
        };
        for &c in order.iter() {
            eval_comp(netlist, net_drivers, comps, drives, c).map_err(|fr| halt(c, fr))?;
        }
        if residue.is_empty() {
            return Ok(());
        }
        let cap = residue.len() + 2;
        for _ in 0..cap {
            let mut changed = false;
            for &c in residue.iter() {
                changed |=
                    eval_comp(netlist, net_drivers, comps, drives, c).map_err(|fr| halt(c, fr))?;
            }
            if !changed {
                return Ok(());
            }
        }
        // Non-convergence: mark everything the residue drives as X and
        // halt with an oscillation error (§4.5 — never hang).
        let mut names = Vec::new();
        for &c in residue.iter() {
            let fc = &netlist.comps[c as usize];
            names.push(fc.origin());
            for (slot, p) in fc.pins.iter().enumerate() {
                if p.dir != PinDir::In {
                    drives[c as usize][slot] = Value::x(p.width);
                }
            }
        }
        Err(Halt {
            reason: HaltReason::Oscillation,
            cycle: *cycle,
            details: format!(
                "combinational cycle did not converge ({} component(s)): {}",
                residue.len(),
                names.join(", ")
            ),
        })
    }

    /// Latch clocked components whose `clk` net rose since the last
    /// settle; the sampled inputs are the values settled at the end of
    /// the previous phase (DESIGN.md §4.2).
    fn detect_edges(&mut self) -> Result<(), Halt> {
        for ci in 0..self.comps.len() {
            if !self.comps[ci].is_clocked() {
                continue;
            }
            let fc = &self.netlist.comps[ci];
            let Some(clk_pin) = fc.pins.iter().find(|p| p.pin == "clk") else {
                continue;
            };
            let cur = self.net_value(clk_pin.net).bit(0);
            let rose = !self.prev_clk[ci] && cur == Bit::One;
            self.prev_clk[ci] = cur == Bit::One;
            if !rose {
                continue;
            }
            let ins: Vec<Value> = fc
                .pins
                .iter()
                .filter(|p| p.dir == PinDir::In)
                .map(|p| self.net_value(p.net))
                .collect();
            let ins_refs: Vec<&Value> = ins.iter().collect();
            self.comps[ci].rising_edge(&ins_refs).map_err(|fr| Halt {
                reason: HaltReason::FloatingRead,
                cycle: self.cycle,
                details: format!("{}: pin '{}'", fc.origin(), fr.pin),
            })?;
        }
        if self.clock_phase {
            self.cycle += 1;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::load_document;
    use crate::netlist;

    /// Build an engine straight from a document string.
    pub(crate) fn engine(json: &str) -> ZeroEngine {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        ZeroEngine::new(nl).expect("test doc builds")
    }

    fn k(width: u32, v: u64) -> Value {
        Value::from_u64(width, v)
    }

    /// Free-running counter: reg ← adder(reg.q, 1). Known-answer fixture.
    const COUNTER: &str = r##"{
        "format": "circuitsim-plus-plus", "version": 2, "name": "t", "settings": {"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
        "circuits": [{ "name": "main", "components": [
            {"id":"clk","type":"wiring.clock","pos":[0,0]},
            {"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{"bitsize":8,"value":"1"}},
            {"id":"one1","type":"wiring.constant","pos":[0,0],"attrs":{"value":"1"}},
            {"id":"zero1","type":"wiring.constant","pos":[0,0]},
            {"id":"reg","type":"mem.register","pos":[0,0],"name":"r","attrs":{"bitsize":8}},
            {"id":"add","type":"arith.adder","pos":[0,0],"attrs":{"bitsize":8}},
            {"id":"prb","type":"wiring.probe","pos":[0,0],"name":"q","attrs":{"bitsize":8}}
        ], "wires": [
            {"a":{"comp":"clk","pin":"out"},"b":{"comp":"reg","pin":"clk"}},
            {"a":{"comp":"one1","pin":"out"},"b":{"comp":"reg","pin":"en"}},
            {"a":{"comp":"zero1","pin":"out"},"b":{"comp":"reg","pin":"rst"}},
            {"a":{"comp":"add","pin":"out"},"b":{"comp":"reg","pin":"d"}},
            {"a":{"comp":"reg","pin":"q"},"b":{"comp":"add","pin":"a"}},
            {"a":{"comp":"one","pin":"out"},"b":{"comp":"add","pin":"b"}},
            {"a":{"comp":"zero1","pin":"out"},"b":{"comp":"add","pin":"cin"}},
            {"a":{"comp":"reg","pin":"q"},"b":{"comp":"prb","pin":"in"}}
        ]}]
    }"##;

    #[test]
    fn counter_known_answer() {
        let mut eng = engine(COUNTER);
        assert_eq!(eng.cycle(), 0);
        assert_eq!(eng.named_value("r"), Some(k(8, 0)));
        eng.run(1).unwrap();
        assert_eq!(eng.cycle(), 1);
        assert_eq!(eng.named_value("r"), Some(k(8, 1)));
        assert_eq!(eng.named_value("q"), Some(k(8, 1))); // probe on the q net
        eng.run(4).unwrap();
        assert_eq!(eng.cycle(), 5);
        assert_eq!(eng.named_value("r"), Some(k(8, 5)));
        // Register enable gating still works through the engine.
    }

    #[test]
    fn poke_gates_the_counter() {
        // en driven by a named input pin instead of a constant.
        let json = COUNTER.replace(
            r#"{"id":"one1","type":"wiring.constant","pos":[0,0],"attrs":{"value":"1"}}"#,
            r#"{"id":"en","type":"wiring.pin","pos":[0,0],"name":"en"}"#,
        );
        let json = json.replace(
            r#"{"a":{"comp":"one1","pin":"out"},"b":{"comp":"reg","pin":"en"}}"#,
            r#"{"a":{"comp":"en","pin":"pin"},"b":{"comp":"reg","pin":"en"}}"#,
        );
        let mut eng = engine(&json);
        eng.poke_input_pin("en", k(1, 0)).unwrap();
        eng.run(3).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(8, 0))); // held
        eng.poke_input_pin("en", k(1, 1)).unwrap();
        eng.run(3).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(8, 3))); // counting
    }

    #[test]
    fn splitter_and_wide_logic_known_answer() {
        // const 0xAB → splitter bus; hi nibble → probe. Splitter is a DAG
        // node here (only the bus net has other drivers).
        let eng_json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", "settings": {"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"c","type":"wiring.constant","pos":[0,0],"attrs":{"bitsize":8,"value":"ab"}},
                {"id":"sp","type":"wiring.splitter","pos":[0,0],
                 "attrs":{"splits":{"lo":[0,1,2,3],"hi":[4,5,6,7]}}},
                {"id":"p","type":"wiring.probe","pos":[0,0],"name":"hi","attrs":{"bitsize":4}}
            ], "wires": [
                {"a":{"comp":"c","pin":"out"},"b":{"comp":"sp","pin":"bus"}},
                {"a":{"comp":"sp","pin":"hi"},"b":{"comp":"p","pin":"in"}}
            ]}]
        }"##;
        let mut eng = engine(eng_json);
        eng.step_tick().unwrap();
        assert_eq!(eng.named_value("hi"), Some(k(4, 0xA)));
    }

    #[test]
    fn sr_latch_converges_deterministically() {
        // Two NORs cross-coupled, other inputs tied low: feedback seeds at
        // 0, sequential iteration in comp order converges to g1=1, g2=0.
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", "settings": {"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"z","type":"wiring.constant","pos":[0,0]},
                {"id":"g1","type":"gate.nor","pos":[0,0]},
                {"id":"g2","type":"gate.nor","pos":[0,0]},
                {"id":"p1","type":"wiring.probe","pos":[0,0],"name":"q"},
                {"id":"p2","type":"wiring.probe","pos":[0,0],"name":"qb"}
            ], "wires": [
                {"a":{"comp":"z","pin":"out"},"b":{"comp":"g1","pin":"in0"}},
                {"a":{"comp":"z","pin":"out"},"b":{"comp":"g2","pin":"in0"}},
                {"a":{"comp":"g1","pin":"out"},"b":{"comp":"g2","pin":"in1"}},
                {"a":{"comp":"g2","pin":"out"},"b":{"comp":"g1","pin":"in1"}},
                {"a":{"comp":"g1","pin":"out"},"b":{"comp":"p1","pin":"in"}},
                {"a":{"comp":"g2","pin":"out"},"b":{"comp":"p2","pin":"in"}}
            ]}]
        }"##;
        let mut eng = engine(json);
        eng.step_tick().unwrap();
        assert_eq!(eng.named_value("q"), Some(k(1, 1)));
        assert_eq!(eng.named_value("qb"), Some(k(1, 0)));
    }

    #[test]
    fn odd_inverter_ring_oscillates_with_x_and_error() {
        // A gate feeding itself has no fixpoint: iteration flips forever →
        // bounded, then nets → X + oscillation error (§4.5, never hangs).
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", "settings": {"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"g","type":"gate.not","pos":[0,0]},
                {"id":"p","type":"wiring.probe","pos":[0,0],"name":"x"}
            ], "wires": [
                {"a":{"comp":"g","pin":"out"},"b":{"comp":"g","pin":"in"}},
                {"a":{"comp":"g","pin":"out"},"b":{"comp":"p","pin":"in"}}
            ]}]
        }"##;
        let mut eng = engine(json);
        let halt = eng.step_tick().expect_err("must halt");
        assert_eq!(halt.reason, HaltReason::Oscillation);
        assert!(halt.details.contains('g'));
        assert_eq!(eng.named_value("x"), Some(Value::x(1)));
    }

    #[test]
    fn floating_read_halts_naming_comp_and_pin() {
        // gate.and with in1 unwired → that net floats → consume → halt.
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", "settings": {"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"c","type":"wiring.constant","pos":[0,0]},
                {"id":"g","type":"gate.and","pos":[0,0]}
            ], "wires": [
                {"a":{"comp":"c","pin":"out"},"b":{"comp":"g","pin":"in0"}}
            ]}]
        }"##;
        let mut eng = engine(json);
        let halt = eng.step_tick().expect_err("must halt");
        assert_eq!(halt.reason, HaltReason::FloatingRead);
        assert_eq!(halt.details, "main: g: pin 'in1'");
    }

    #[test]
    fn ram_async_read_and_edge_write() {
        // Poked pins drive addr/din/we; clock comp drives clk.
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", "settings": {"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"clk","type":"wiring.clock","pos":[0,0]},
                {"id":"addr","type":"wiring.pin","pos":[0,0],"name":"addr","attrs":{"bitsize":2}},
                {"id":"din","type":"wiring.pin","pos":[0,0],"name":"din","attrs":{"bitsize":8}},
                {"id":"we","type":"wiring.pin","pos":[0,0],"name":"we"},
                {"id":"ram","type":"mem.ram","pos":[0,0],"name":"m","attrs":{"bitsize":8,"depth":4}},
                {"id":"p","type":"wiring.probe","pos":[0,0],"name":"out","attrs":{"bitsize":8}}
            ], "wires": [
                {"a":{"comp":"clk","pin":"out"},"b":{"comp":"ram","pin":"clk"}},
                {"a":{"comp":"addr","pin":"pin"},"b":{"comp":"ram","pin":"addr"}},
                {"a":{"comp":"din","pin":"pin"},"b":{"comp":"ram","pin":"din"}},
                {"a":{"comp":"we","pin":"pin"},"b":{"comp":"ram","pin":"we"}},
                {"a":{"comp":"ram","pin":"dout"},"b":{"comp":"p","pin":"in"}}
            ]}]
        }"##;
        let mut eng = engine(json);
        eng.poke_input_pin("addr", k(2, 3)).unwrap();
        eng.poke_input_pin("din", k(8, 42)).unwrap();
        eng.poke_input_pin("we", k(1, 1)).unwrap();
        eng.run(1).unwrap(); // write 42 @ 3 on the rising edge
        eng.poke_input_pin("we", k(1, 0)).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(8, 42))); // async read
        assert_eq!(eng.memory_word("m", 3), Some(k(8, 42)));
        eng.poke_input_pin("addr", k(2, 1)).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(8, 0))); // other word
    }

    #[test]
    fn snapshot_restore_is_bit_identical() {
        let mut a = engine(COUNTER);
        a.run(8).unwrap();
        let nets_a: Vec<Value> = (0..a.netlist().nets.len() as u32)
            .map(|i| a.net_value(NetId(i)))
            .collect();

        let mut b = engine(COUNTER);
        b.run(5).unwrap();
        let snap = b.snapshot();
        b.run(3).unwrap();
        // Restore into a fresh engine and continue identically.
        let mut c = engine(COUNTER);
        c.restore(&snap).unwrap();
        assert_eq!(c.cycle(), 5);
        assert_eq!(c.named_value("r"), Some(k(8, 5)));
        c.run(3).unwrap();

        assert_eq!(a.cycle(), 8);
        assert_eq!(b.cycle(), 8);
        assert_eq!(c.cycle(), 8);
        for i in 0..a.netlist().nets.len() as u32 {
            assert_eq!(
                nets_a[i as usize],
                c.net_value(NetId(i)),
                "net {i} differs after snapshot/restore"
            );
        }
        assert_eq!(a.named_value("r"), c.named_value("r"));
    }

    #[test]
    fn determinism_two_engines_same_run() {
        let mut a = engine(COUNTER);
        let mut b = engine(COUNTER);
        a.run(20).unwrap();
        b.run(20).unwrap();
        assert_eq!(a.snapshot(), b.snapshot());
    }
}
