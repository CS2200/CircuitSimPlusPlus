//! Delay-aware event-driven engine (DESIGN.md §4.3, §4.4; BACKEND.md task
//! B6) — the teaching + grading engine.
//!
//! Events are processed from a `(time, seq)`-ordered queue; `seq` is a
//! monotonic counter assigned at schedule time, and same-timestamp
//! reactions run in component-index order — runs are bit-for-bit
//! reproducible (§4.6).
//!
//! ## The delay model (resolved D1)
//!
//! - **Wires — transport delay.** Each net delays every transition of its
//!   resolved value by `d_net = wire_len × wire-delay constant` from the
//!   delay table (task B7; 0 disables wire delay). Every transition is
//!   reproduced, however narrow the pulse.
//! - **Gates — inertial delay.** Each component carries a `(generation,
//!   pending outputs)` pair; an input change recomputes the outputs and
//!   re-schedules the pending commit at `now + t_pd`, cancelling the
//!   previous generation — an input pulse narrower than `t_pd` never
//!   reaches the output.
//! - **Registers — clk→Q + setup/hold.** On a rising `clk` net, D is
//!   sampled (consuming `Z` halts, §4.1) and Q commits `clk→Q` later
//!   (last edge wins, same generation mechanism). D changing within
//!   `t_setup` before the edge or `t_hold` after it is recorded as a
//!   **warning** (`TimingViolation`); the latch still happens,
//!   deterministically.
//! - **RAM/ROM** — reads settle `t_access` after an address change;
//!   writes obey the same edge + setup/hold discipline as registers
//!   (tracked on `din` and `addr`).
//!
//! ## Floating-consume in an event engine (§4.1)
//!
//! Arrival-order transients make "halt the moment a gate sees Z" wrong:
//! with differing delays, a gate's inputs legitimately arrive at
//! different times. The rule here matches the zero-delay engine's
//! *settled-state* semantics (§3's behavioral-identity goal):
//!
//! - A combinational component evaluates only once **all** its inputs are
//!   non-`Z` (a `Z` input means "not yet arrived"; the output holds its
//!   previous value, which may itself be the never-driven `Z`).
//! - At each **cycle close**, every net that is still fully `Z` *and*
//!   feeds a combinational sink (or a RAM/ROM address pin) halts the run
//!   with `FloatingRead`, naming the first such sink in comp order. A bus
//!   idling between transactions shows `Z` on probes/pins without halting
//!   (observation is not consumption); a bus feeding a gate directly at
//!   cycle close is the accepted-strict false positive (§13.5, D3).
//! - Register/RAM consume rules (D while enabled at an edge, RAM ports
//!   during an access) halt immediately, exactly as in zero-delay.
//!
//! ## Clock, cycles, DTA
//!
//! The global clock is a free-running square wave with half period
//! `clock_half_period` (an engine parameter; B9 exposes it). Cycle 0 is
//! the boot/settle cycle; the first rising edge is at `T = 2 × half`.
//! Per cycle, the engine records the timestamp of the last value change
//! on any net feeding a register/memory input, measured from cycle
//! start; `T_obs` is the maximum over the run (§4.4) and `est_time =
//! cycles × T_obs`. The top-k (10) longest distinct observed paths are
//! kept as component-ID chains for UI highlighting, reconstructed from
//! per-net causal back-pointers (`net → (comp, triggering input net)`).
//!
//! An **event storm** (§4.5 — e.g. a zero-delay inverter ring) is capped
//! per cycle (`events_per_cycle_cap`) and halts with
//! `HaltReason::Oscillation`; the simulator never hangs.
//!
//! A running **FNV-1a trace hash** over every applied event (time, seq,
//! kind, ids, value masks) is the determinism tripwire: same circuit +
//! same inputs ⇒ same hash, every platform.

use std::collections::{BTreeSet, BinaryHeap};

use crate::api::{CompId, HaltReason, LoadError, LoadErrorKind, NamedKind, NetId};
use crate::behavior::{Behavior, FloatingRead, Timing};
use crate::engine_common as ec;
use crate::netlist::Netlist;
use crate::timing_table::TimingTable;
use crate::value::{Bit, Value};
pub use crate::zero::Halt;

/// Default cap on applied events per cycle before declaring an event
/// storm (§4.5).
pub const DEFAULT_EVENTS_PER_CYCLE_CAP: u64 = 1_000_000;

const TOP_K: usize = 10;

/// A setup/hold warning (DESIGN.md §4.3): recorded, never corrupts state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TimingViolation {
    pub comp: CompId,
    pub kind: ViolationKind,
    /// Simulation time of the offending edge.
    pub time: u64,
    /// Cycle (rising-edge count) containing the edge.
    pub cycle: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub enum ViolationKind {
    /// Data changed within `t_setup` before the edge.
    Setup,
    /// Data changed within `t_hold` after the edge.
    Hold,
}

/// What a run produced (also the engine's observable state).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    /// Rising edges processed in this run.
    pub cycles: u64,
    /// Max observed per-cycle settle time (§4.4).
    pub t_obs: u64,
    /// Cumulative setup/hold warnings.
    pub violations: Vec<TimingViolation>,
    /// Top-k distinct observed critical paths, longest first, as
    /// `(settle_time, comp chain from latest-arriving register input back
    /// to the launching element)`.
    pub top_paths: Vec<(u64, Vec<CompId>)>,
    /// FNV-1a over every applied event — determinism tripwire (§4.6).
    pub trace_hash: u64,
    pub events_processed: u64,
}

/// Event payload. Ordering is (time, seq) via `Ev`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum EvKind {
    /// Global clock edge; `phase` is the new level.
    Clock { phase: bool },
    /// Commit a component's pending outputs (inertial: dropped when the
    /// generation was cancelled by a newer input change).
    Fire { comp: u32, gen: u64 },
    /// Apply a resolved net value (transport: never cancelled).
    Net { net: u32, value: Value },
    /// Drive a root input pin at an absolute time (testbench poking).
    Poke { comp: u32, value: Value },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Ev {
    time: u64,
    seq: u64,
    kind: EvKind,
}

impl Ord for Ev {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        // Min-heap: earlier time, then smaller seq first.
        (other.time, other.seq).cmp(&(self.time, self.seq))
    }
}
impl PartialOrd for Ev {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

/// Serializable snapshot form (`snapshot`/`restore`, §8.1).
#[derive(serde::Serialize, serde::Deserialize)]
struct DelaySnap {
    version: u32,
    half_period: u64,
    now: u64,
    seq: u64,
    next_rising: bool,
    rising_seen: u64,
    next_boundary: u64,
    cycle_settle: u64,
    cycle_settle_net: Option<u32>,
    t_obs: u64,
    top_paths: Vec<(u64, Vec<CompId>)>,
    violations: Vec<TimingViolation>,
    events_this_cycle: u64,
    events_processed: u64,
    trace_hash: u64,
    halted: Option<Halt>,
    comps: Vec<serde_json::Value>,
    drives: Vec<Vec<crate::api::WireValue>>,
    net_values: Vec<crate::api::WireValue>,
    net_scheduled: Vec<crate::api::WireValue>,
    net_cause: Vec<Option<(u32, Option<u32>)>>,
    z_nets: Vec<u32>,
    pending_gen: Vec<u64>,
    pending_val: Vec<Vec<crate::api::WireValue>>,
    pending_cause: Vec<Option<u32>>,
    pending_net_cause: Vec<(u32, (u32, Option<u32>))>,
    clk_track: Vec<ClockTrack>,
    queue: Vec<SnapEv>,
}

/// Flat event encoding (kind tag + the one relevant payload slot).
/// Values serialize as width-less masks; `restore` re-decodes them with
/// the netlist's widths.
#[derive(serde::Serialize, serde::Deserialize)]
struct SnapEv {
    time: u64,
    seq: u64,
    kind: String,
    #[serde(default)]
    comp: u32,
    #[serde(default)]
    gen: u64,
    #[serde(default)]
    net: u32,
    #[serde(default)]
    phase: bool,
    #[serde(default)]
    value: Option<crate::api::WireValue>,
}

impl SnapEv {
    fn from_ev(e: &Ev) -> SnapEv {
        let (kind, comp, gen, net, phase, value) = match &e.kind {
            EvKind::Clock { phase } => ("clock", 0, 0, 0, *phase, None),
            EvKind::Fire { comp, gen } => ("fire", *comp, *gen, 0, false, None),
            EvKind::Net { net, value } => ("net", 0, 0, *net, false, Some(value.to_wire_value())),
            EvKind::Poke { comp, value } => {
                ("poke", *comp, 0, 0, false, Some(value.to_wire_value()))
            }
        };
        SnapEv {
            time: e.time,
            seq: e.seq,
            kind: kind.to_string(),
            comp,
            gen,
            net,
            phase,
            value,
        }
    }

    /// Rebuild the event; `width_of` resolves payload widths (net events
    /// from the net, poke events from the pin).
    fn to_ev(&self, width_of: impl Fn(&SnapEv) -> Result<u32, String>) -> Result<Ev, String> {
        let value = |w: u32| -> Result<Value, String> {
            let wv = self
                .value
                .as_ref()
                .ok_or_else(|| format!("{} event without value", self.kind))?;
            Value::from_wire_value(wv, w).map_err(|e| e.to_string())
        };
        let kind = match self.kind.as_str() {
            "clock" => EvKind::Clock { phase: self.phase },
            "fire" => EvKind::Fire {
                comp: self.comp,
                gen: self.gen,
            },
            "net" => EvKind::Net {
                net: self.net,
                value: value(width_of(self)?)?,
            },
            "poke" => EvKind::Poke {
                comp: self.comp,
                value: value(width_of(self)?)?,
            },
            other => return Err(format!("bad snapshot event kind '{other}'")),
        };
        Ok(Ev {
            time: self.time,
            seq: self.seq,
            kind,
        })
    }
}

/// Static per-component data precomputed at engine build.
#[derive(Debug)]
struct CompData {
    class: Class,
    /// Consumed input pins: (pin slot, net). For splitters: all pins.
    in_pins: Vec<(usize, NetId)>,
    /// Driven pins: (pin slot, net). For splitters: all pins.
    out_pins: Vec<(usize, NetId)>,
    timing: Timing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Class {
    /// Gates, plexers, arithmetic, controlled buffer.
    Comb,
    Splitter,
    Register,
    Ram,
    Rom,
    /// No inputs: constant, input pin, button, clock.
    Source,
    /// Observation only: probe, LED, hex display, output pin.
    Sink,
}

fn class_of(type_: &str, has_inputs: bool, has_outputs: bool) -> Class {
    match type_ {
        "wiring.splitter" => Class::Splitter,
        "mem.register" => Class::Register,
        "mem.ram" => Class::Ram,
        "mem.rom" => Class::Rom,
        _ if !has_inputs => Class::Source,
        _ if !has_outputs => Class::Sink,
        _ => Class::Comb,
    }
}

/// Per-clocked-component setup/hold tracking.
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
struct ClockTrack {
    last_edge: Option<u64>,
    last_d: Option<u64>,
    last_din: Option<u64>,
    last_addr: Option<u64>,
}

/// Precomputed sink-pin identity per net (Copy — the hot Net-apply loop
/// iterates it without cloning the netlist's `String` sink table).
#[derive(Debug, Clone, Copy)]
struct SinkPin {
    comp: u32,
    kind: SinkKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SinkKind {
    D,
    Clk,
    En,
    Rst,
    Addr,
    Din,
    We,
    Other,
}

impl SinkKind {
    fn from_pin(name: &str) -> SinkKind {
        match name {
            "d" => SinkKind::D,
            "clk" => SinkKind::Clk,
            "en" => SinkKind::En,
            "rst" => SinkKind::Rst,
            "addr" => SinkKind::Addr,
            "din" => SinkKind::Din,
            "we" => SinkKind::We,
            _ => SinkKind::Other,
        }
    }
}

/// The delay-aware engine. See module docs for the semantics.
#[derive(Debug)]
pub struct DelayEngine {
    netlist: Netlist,
    comps: Vec<Behavior>,
    cdata: Vec<CompData>,
    drives: Vec<Vec<Value>>,
    net_drivers: Vec<Vec<(u32, usize)>>,
    net_values: Vec<Value>,
    /// Last *scheduled* value per net (transport bookkeeping: a resolved
    /// transition equal to the current value must still be scheduled when
    /// an earlier transition is already in flight — otherwise the trailing
    /// edge of a pulse narrower than the wire delay would be lost).
    net_scheduled: Vec<Value>,
    /// Transport delay per net (ns).
    net_delay: Vec<u64>,
    /// Causal back-pointer per net: (comp that last changed it, that
    /// comp's triggering input net) — for critical-path reconstruction.
    net_cause: Vec<Option<(u32, Option<u32>)>>,
    /// Nets feeding a register/memory input pin (DTA settle watchers).
    state_input_net: Vec<bool>,
    /// Nets whose persistent `Z` state is a floating-read error at cycle
    /// close (feed a combinational sink or RAM/ROM address).
    z_watched_net: Vec<bool>,
    /// Precomputed sinks per net (comp order preserved).
    net_sinks: Vec<Vec<SinkPin>>,
    /// Currently-fully-`Z` watched nets (min-first for determinism).
    z_nets: BTreeSet<u32>,
    /// Inertial bookkeeping: current generation, scheduled outputs,
    /// triggering input net.
    pending_gen: Vec<u64>,
    pending_val: Vec<Vec<Value>>,
    pending_cause: Vec<Option<u32>>,
    /// (net, cause) for scheduled-but-not-yet-applied net events;
    /// applied in schedule order (FIFO per net).
    pending_net_cause: Vec<(u32, (u32, Option<u32>))>,
    queue: BinaryHeap<Ev>,
    now: u64,
    seq: u64,
    half_period: u64,
    next_rising: bool,
    rising_seen: u64,
    next_boundary: u64,
    cycle_settle: u64,
    cycle_settle_net: Option<u32>,
    t_obs: u64,
    top_paths: Vec<(u64, Vec<CompId>)>,
    violations: Vec<TimingViolation>,
    clk_track: Vec<ClockTrack>,
    /// Cap on applied events per cycle (storm detection, §4.5).
    pub events_per_cycle_cap: u64,
    events_this_cycle: u64,
    events_processed: u64,
    trace_hash: u64,
    halted: Option<Halt>,
}

impl DelayEngine {
    /// Build the engine. `clock_half_period` is in delay-table units
    /// (ns); it must exceed the design's true critical path or setup
    /// violations pile up (that's the lesson, §4.3). All delays come from
    /// `table` (the published table named by `settings.delayTable`, B7).
    pub fn new(
        netlist: Netlist,
        clock_half_period: u64,
        table: &TimingTable,
    ) -> Result<DelayEngine, Vec<LoadError>> {
        let comps = ec::build_behaviors(&netlist)?;
        let n = comps.len();
        let mut cdata = Vec::with_capacity(n);
        let mut state_input_net = vec![false; netlist.nets.len()];
        let mut z_watched_net = vec![false; netlist.nets.len()];
        for (ci, beh) in comps.iter().enumerate() {
            let fc = &netlist.comps[ci];
            let in_pins: Vec<(usize, NetId)> = fc
                .pins
                .iter()
                .enumerate()
                .filter(|(_, p)| p.dir != crate::components::PinDir::Out)
                .map(|(i, p)| (i, p.net))
                .collect();
            let out_pins: Vec<(usize, NetId)> = fc
                .pins
                .iter()
                .enumerate()
                .filter(|(_, p)| p.dir != crate::components::PinDir::In)
                .map(|(i, p)| (i, p.net))
                .collect();
            let class = class_of(&fc.type_, !in_pins.is_empty(), !out_pins.is_empty());
            match class {
                Class::Register | Class::Ram | Class::Rom => {
                    // DTA watches *data* inputs; the clock is the
                    // reference, not a settling signal (its falling edge
                    // would otherwise dominate every cycle).
                    for (slot, net) in &in_pins {
                        if fc.pins[*slot].pin != "clk" {
                            state_input_net[net.idx()] = true;
                        }
                    }
                }
                Class::Comb => {
                    for (_, net) in &in_pins {
                        z_watched_net[net.idx()] = true;
                    }
                }
                _ => {}
            }
            cdata.push(CompData {
                class,
                in_pins,
                out_pins,
                timing: beh.timing(table),
            });
        }
        // RAM/ROM addresses are Z-watched too (a floating address is an
        // access on a floating port, §4.1).
        for (ci, cd) in cdata.iter().enumerate() {
            if matches!(cd.class, Class::Ram | Class::Rom) {
                for (_, net) in &cd.in_pins {
                    z_watched_net[net.idx()] = true;
                }
                let _ = ci;
            }
        }
        let net_values: Vec<Value> = netlist.nets.iter().map(|n| Value::z(n.width)).collect();
        let net_scheduled = net_values.clone();
        let net_delay: Vec<u64> = netlist
            .nets
            .iter()
            .map(|n| table.wire_delay(n.wire_len))
            .collect();
        let z_nets: BTreeSet<u32> = z_watched_net
            .iter()
            .enumerate()
            .filter(|(_, &w)| w)
            .map(|(i, _)| i as u32)
            .collect();
        let net_drivers = ec::net_drivers(&netlist);
        let net_sinks: Vec<Vec<SinkPin>> = netlist
            .nets
            .iter()
            .map(|n| {
                n.sinks
                    .iter()
                    .map(|(c, pin)| SinkPin {
                        comp: c.0,
                        kind: SinkKind::from_pin(pin),
                    })
                    .collect()
            })
            .collect();
        let n_nets = netlist.nets.len();
        let drives = ec::drive_slots(&netlist);
        let mut eng = DelayEngine {
            netlist,
            comps,
            cdata,
            drives,
            net_drivers,
            net_values,
            net_scheduled,
            net_delay,
            net_cause: vec![None; n_nets],
            state_input_net,
            z_watched_net,
            net_sinks,
            z_nets,
            pending_gen: vec![0; n],
            pending_val: vec![Vec::new(); n],
            pending_cause: vec![None; n],
            pending_net_cause: Vec::new(),
            queue: BinaryHeap::new(),
            now: 0,
            seq: 0,
            half_period: clock_half_period,
            next_rising: true,
            rising_seen: 0,
            next_boundary: 2 * clock_half_period,
            cycle_settle: 0,
            cycle_settle_net: None,
            t_obs: 0,
            top_paths: Vec::new(),
            violations: Vec::new(),
            clk_track: vec![ClockTrack::default(); n],
            events_per_cycle_cap: DEFAULT_EVENTS_PER_CYCLE_CAP,
            events_this_cycle: 0,
            events_processed: 0,
            trace_hash: 0xcbf2_9ce4_8422_2325, // FNV offset basis
            halted: None,
        };
        // Power-on for combinational loops: seed loop nets to 0 (same
        // deterministic rule as the zero-delay engine) so feedback logic
        // starts from a defined state.
        let (_, residue) = crate::zero::levelize(&eng.netlist, &eng.comps);
        for c in residue {
            for (_, net) in &eng.cdata[c as usize].out_pins {
                let width = eng.netlist.nets[net.idx()].width;
                eng.net_values[net.idx()] = Value::zero(width);
                eng.net_scheduled[net.idx()] = Value::zero(width);
                eng.z_nets.remove(&net.0);
            }
        }
        // Power-on: sources and state elements commit their initial
        // outputs at T=0 (in comp order, §4.3); the first rising edge is
        // at T = 2×half so cycle 0 is the boot/settle cycle.
        for c in 0..n as u32 {
            let cd = &eng.cdata[c as usize];
            if matches!(cd.class, Class::Source | Class::Register) {
                eng.eval_and_schedule(c, 0, None).map_err(|h| {
                    vec![LoadError {
                        kind: LoadErrorKind::Other,
                        message: format!("power-on evaluation failed: {h}"),
                        circuit: String::new(),
                        comp_id: None,
                        wire_idx: None,
                    }]
                })?;
            }
        }
        eng.schedule(2 * clock_half_period, EvKind::Clock { phase: true });
        Ok(eng)
    }

    pub fn netlist(&self) -> &Netlist {
        &self.netlist
    }

    /// Current simulation time (ns).
    pub fn now(&self) -> u64 {
        self.now
    }

    /// Rising edges processed so far (the cycle count).
    pub fn cycle(&self) -> u64 {
        self.rising_seen
    }

    pub fn t_obs(&self) -> u64 {
        self.t_obs
    }

    pub fn violations(&self) -> &[TimingViolation] {
        &self.violations
    }

    pub fn trace_hash(&self) -> u64 {
        self.trace_hash
    }

    // -- Snapshot/restore (§8.1) ------------------------------------------

    /// Full engine state as deterministic JSON (savestate; §8.1). The
    /// queue is serialized in (time, seq) order; restoring into an engine
    /// built from the same circuit + table continues bit-identically
    /// (§4.6 — see the test).
    pub fn snapshot(&self) -> String {
        let mut queue: Vec<&Ev> = self.queue.iter().collect();
        queue.sort_by_key(|e| (e.time, e.seq));
        let snap = DelaySnap {
            version: 1,
            half_period: self.half_period,
            now: self.now,
            seq: self.seq,
            next_rising: self.next_rising,
            rising_seen: self.rising_seen,
            next_boundary: self.next_boundary,
            cycle_settle: self.cycle_settle,
            cycle_settle_net: self.cycle_settle_net,
            t_obs: self.t_obs,
            top_paths: self.top_paths.clone(),
            violations: self.violations.clone(),
            events_this_cycle: self.events_this_cycle,
            events_processed: self.events_processed,
            trace_hash: self.trace_hash,
            halted: self.halted.clone(),
            comps: self.comps.iter().map(Behavior::save_state).collect(),
            drives: self
                .drives
                .iter()
                .map(|slots| slots.iter().map(Value::to_wire_value).collect())
                .collect(),
            net_values: self.net_values.iter().map(Value::to_wire_value).collect(),
            net_scheduled: self
                .net_scheduled
                .iter()
                .map(Value::to_wire_value)
                .collect(),
            net_cause: self.net_cause.clone(),
            z_nets: self.z_nets.iter().copied().collect(),
            pending_gen: self.pending_gen.clone(),
            pending_val: self
                .pending_val
                .iter()
                .map(|outs| outs.iter().map(Value::to_wire_value).collect())
                .collect(),
            pending_cause: self.pending_cause.clone(),
            pending_net_cause: self.pending_net_cause.clone(),
            clk_track: self.clk_track.clone(),
            queue: queue.iter().map(|e| SnapEv::from_ev(e)).collect(),
        };
        serde_json::to_string(&snap).expect("snapshot serializes")
    }

    /// Restore a snapshot into an engine built from the same circuit and
    /// delay table. Errors (never panics) on shape/version mismatch.
    pub fn restore(&mut self, json: &str) -> Result<(), String> {
        let snap: DelaySnap =
            serde_json::from_str(json).map_err(|e| format!("bad snapshot: {e}"))?;
        if snap.version != 1 {
            return Err(format!("unsupported snapshot version {}", snap.version));
        }
        if snap.half_period != self.half_period {
            return Err("snapshot clock half-period does not match".to_string());
        }
        let n_comps = self.comps.len();
        let n_nets = self.netlist.nets.len();
        let shape_ok = snap.comps.len() == n_comps
            && snap.drives.len() == n_comps
            && snap.pending_gen.len() == n_comps
            && snap.pending_val.len() == n_comps
            && snap.pending_cause.len() == n_comps
            && snap.clk_track.len() == n_comps
            && snap.net_values.len() == n_nets
            && snap.net_scheduled.len() == n_nets
            && snap.net_cause.len() == n_nets;
        if !shape_ok {
            return Err("snapshot does not match this circuit".to_string());
        }
        let values = |wv: &crate::api::WireValue, width: u32| {
            Value::from_wire_value(wv, width).map_err(|e| e.to_string())
        };
        for (b, s) in self.comps.iter_mut().zip(&snap.comps) {
            if !b.load_state(s) {
                return Err("snapshot state does not match component kinds".to_string());
            }
        }
        for (ci, slots) in snap.drives.iter().enumerate() {
            let fc = &self.netlist.comps[ci];
            if slots.len() != fc.pins.len() {
                return Err("snapshot drive slots do not match".to_string());
            }
            for (slot, wv) in slots.iter().enumerate() {
                self.drives[ci][slot] = values(wv, fc.pins[slot].width)?;
            }
        }
        for (i, wv) in snap.net_values.iter().enumerate() {
            self.net_values[i] = values(wv, self.netlist.nets[i].width)?;
        }
        for (i, wv) in snap.net_scheduled.iter().enumerate() {
            self.net_scheduled[i] = values(wv, self.netlist.nets[i].width)?;
        }
        for (ci, outs) in snap.pending_val.iter().enumerate() {
            // pending_val slots are lazily sized (empty until first eval).
            if outs.is_empty() {
                self.pending_val[ci] = Vec::new();
                continue;
            }
            let out_pins: Vec<usize> = self.cdata[ci].out_pins.iter().map(|(s, _)| *s).collect();
            if outs.len() != out_pins.len() {
                return Err("snapshot pending outputs do not match".to_string());
            }
            let mut rebuilt = Vec::with_capacity(outs.len());
            for (j, wv) in outs.iter().enumerate() {
                rebuilt.push(values(wv, self.netlist.comps[ci].pins[out_pins[j]].width)?);
            }
            self.pending_val[ci] = rebuilt;
        }
        self.net_cause = snap.net_cause;
        self.z_nets = snap.z_nets.into_iter().collect();
        self.pending_gen = snap.pending_gen;
        self.pending_cause = snap.pending_cause;
        self.pending_net_cause = snap.pending_net_cause;
        self.clk_track = snap.clk_track;
        self.queue = snap
            .queue
            .iter()
            .map(|se| {
                se.to_ev(|se| match se.kind.as_str() {
                    "net" => self
                        .netlist
                        .nets
                        .get(se.net as usize)
                        .map(|n| n.width)
                        .ok_or_else(|| format!("net event for unknown net {}", se.net)),
                    "poke" => self
                        .netlist
                        .comps
                        .get(se.comp as usize)
                        .and_then(|c| c.pins.first())
                        .map(|p| p.width)
                        .ok_or_else(|| format!("poke event for unknown comp {}", se.comp)),
                    other => Err(format!("bad snapshot event kind '{other}'")),
                })
            })
            .collect::<Result<_, _>>()?;
        self.now = snap.now;
        self.seq = snap.seq;
        self.next_rising = snap.next_rising;
        self.rising_seen = snap.rising_seen;
        self.next_boundary = snap.next_boundary;
        self.cycle_settle = snap.cycle_settle;
        self.cycle_settle_net = snap.cycle_settle_net;
        self.t_obs = snap.t_obs;
        self.top_paths = snap.top_paths;
        self.violations = snap.violations;
        self.events_this_cycle = snap.events_this_cycle;
        self.events_processed = snap.events_processed;
        self.trace_hash = snap.trace_hash;
        self.halted = snap.halted;
        Ok(())
    }

    /// Current resolved value of a net.
    pub fn net_value(&self, net: NetId) -> Value {
        self.net_values[net.idx()].clone()
    }

    /// Value of a named probe (its input net) or register (stored state).
    pub fn named_value(&self, name: &str) -> Option<Value> {
        let named = self.netlist.named.iter().find(|n| n.name == name)?;
        let ci = named.comp_id.idx();
        match named.kind {
            NamedKind::Register => self.comps[ci].register_value().cloned(),
            NamedKind::Probe => {
                let pin = self.netlist.comps[ci]
                    .pins
                    .iter()
                    .find(|p| p.dir == crate::components::PinDir::In)?;
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

    /// Drive a root input pin at the current time.
    pub fn poke_input_pin(&mut self, name: &str, v: Value) -> bool {
        self.poke_at(name, v, self.now)
    }

    /// Drive a root input pin at an absolute simulation time (testbench
    /// stimulus). Times in the past are clamped to `now`.
    pub fn poke_at(&mut self, name: &str, v: Value, at: u64) -> bool {
        let Some(fc) = self
            .netlist
            .comps
            .iter()
            .find(|c| c.type_ == "wiring.pin" && c.name.as_deref() == Some(name))
        else {
            return false;
        };
        self.schedule(
            at.max(self.now),
            EvKind::Poke {
                comp: fc.id.0,
                value: v,
            },
        );
        true
    }

    /// Run `cycles` full clock cycles (rising edges). Returns the run
    /// report; on a halt, the engine stays halted (the error is sticky).
    pub fn run(&mut self, cycles: u64) -> Result<RunReport, Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        match self.run_inner(cycles) {
            Ok(rep) => Ok(rep),
            Err(h) => {
                self.halted = Some(h.clone());
                Err(h)
            }
        }
    }

    /// Process events up to (not including) simulation time `t`
    /// (testbench sampling; clock edges keep the queue non-empty).
    pub fn run_until_time(&mut self, t: u64) -> Result<(), Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        while let Some(ev) = self.queue.peek() {
            if ev.time >= t {
                break;
            }
            let ev = self.queue.pop().expect("peeked");
            self.apply(ev).inspect_err(|h| {
                self.halted = Some(h.clone());
            })?;
        }
        Ok(())
    }

    fn run_inner(&mut self, cycles: u64) -> Result<RunReport, Halt> {
        let target = self.rising_seen + cycles;
        let mut run_cycles = 0;
        while let Some(ev) = self.queue.peek() {
            if let EvKind::Clock { phase: true } = ev.kind {
                if self.rising_seen == target {
                    break; // stop at the boundary; the edge belongs to the next run
                }
            }
            let ev = self.queue.pop().expect("peeked");
            let was_rising = matches!(ev.kind, EvKind::Clock { phase: true });
            self.apply(ev)?;
            if was_rising {
                run_cycles += 1;
            }
        }
        Ok(RunReport {
            cycles: run_cycles,
            t_obs: self.t_obs,
            violations: self.violations.clone(),
            top_paths: self.top_paths.clone(),
            trace_hash: self.trace_hash,
            events_processed: self.events_processed,
        })
    }

    /// Schedule an event (assigns the deterministic sequence number).
    fn schedule(&mut self, time: u64, kind: EvKind) {
        self.seq += 1;
        self.queue.push(Ev {
            time,
            seq: self.seq,
            kind,
        });
    }

    /// Evaluate a component and (re-)schedule its output commit with
    /// inertial cancellation (module docs). `cause` is the input net
    /// whose change triggered this evaluation (path tracking).
    fn eval_and_schedule(&mut self, comp: u32, now: u64, cause: Option<u32>) -> Result<(), Halt> {
        let c = comp as usize;
        let cd = &self.cdata[c];
        let beh = &self.comps[c];
        let outs = if beh.is_splitter() {
            let nets: Vec<Value> = cd
                .in_pins
                .iter()
                .map(|(_, net)| {
                    ec::resolve_except(&self.netlist, &self.net_drivers, &self.drives, *net, comp)
                })
                .collect();
            beh.eval_splitter(&nets)
        } else {
            let ins: Vec<Value> = cd
                .in_pins
                .iter()
                .map(|(_, net)| self.net_values[net.idx()].clone())
                .collect();
            // Combinational parts wait until every input has arrived
            // (module docs, §4.1); clocked parts consume per B4's table.
            if cd.class == Class::Comb && ins.iter().any(|v| v.has_z()) {
                return Ok(());
            }
            let ins_refs: Vec<&Value> = ins.iter().collect();
            beh.eval(&ins_refs)
                .map_err(|fr| self.halt_floating(comp, fr))?
        };
        if outs == self.pending_val[c] {
            return Ok(()); // already scheduled to commit exactly this
        }
        self.pending_gen[c] += 1;
        let gen = self.pending_gen[c];
        self.pending_val[c] = outs;
        self.pending_cause[c] = cause;
        let differs_from_drive = self.cdata[c]
            .out_pins
            .iter()
            .enumerate()
            .any(|(i, (slot, _))| self.drives[c][*slot] != self.pending_val[c][i]);
        if differs_from_drive {
            // Reads settle after the access time; combinational logic and
            // register clk→Q use prop.
            let delay = match self.cdata[c].class {
                Class::Ram | Class::Rom => self.cdata[c].timing.access,
                _ => self.cdata[c].timing.prop,
            };
            self.schedule(now + delay, EvKind::Fire { comp, gen });
        }
        Ok(())
    }

    fn halt_floating(&self, comp: u32, fr: FloatingRead) -> Halt {
        Halt {
            reason: HaltReason::FloatingRead,
            cycle: self.rising_seen,
            details: format!(
                "{}: pin '{}'",
                self.netlist.comps[comp as usize].origin(),
                fr.pin
            ),
        }
    }

    /// Apply one event (the queue's minimum).
    fn apply(&mut self, ev: Ev) -> Result<(), Halt> {
        self.now = ev.time;
        // Cycle close at apply time (events are processed in time order):
        // closing on peek would be premature when the run loop stops
        // *before* a boundary-edge it only looked at.
        while self.now >= self.next_boundary {
            self.close_cycle()?;
        }
        self.events_this_cycle += 1;
        self.events_processed += 1;
        if self.events_this_cycle > self.events_per_cycle_cap {
            return Err(Halt {
                reason: HaltReason::Oscillation,
                cycle: self.rising_seen,
                details: format!(
                    "event storm: more than {} events in one cycle",
                    self.events_per_cycle_cap
                ),
            });
        }
        self.hash_event(&ev);
        match ev.kind {
            EvKind::Clock { phase } => {
                self.next_rising = !phase;
                let clocks: Vec<u32> = (0..self.comps.len() as u32)
                    .filter(|&c| self.cdata[c as usize].class == Class::Source)
                    .filter(|&c| self.netlist.comps[c as usize].type_ == "wiring.clock")
                    .collect();
                for c in clocks {
                    self.comps[c as usize].set_phase(phase);
                    self.eval_and_schedule(c, ev.time, None)?;
                }
                self.schedule(ev.time + self.half_period, EvKind::Clock { phase: !phase });
                if phase {
                    self.rising_seen += 1;
                }
            }
            EvKind::Fire { comp, gen } => {
                let c = comp as usize;
                if gen != self.pending_gen[c] {
                    return Ok(()); // cancelled (inertial swallow)
                }
                let outs = std::mem::take(&mut self.pending_val[c]);
                // Pending committed; make a same-valued placeholder so a
                // later identical recomputation is a no-op.
                self.pending_val[c] = outs.clone();
                let out_pins = std::mem::take(&mut self.cdata[c].out_pins);
                let mut affected: Vec<u32> = Vec::new();
                for (i, (slot, net)) in out_pins.iter().enumerate() {
                    self.drives[c][*slot] = outs[i].clone();
                    if !affected.contains(&net.0) {
                        affected.push(net.0);
                    }
                }
                self.cdata[c].out_pins = out_pins;
                let cause = (comp, self.pending_cause[c]);
                for net in affected {
                    let resolved =
                        ec::resolve(&self.netlist, &self.net_drivers, &self.drives, NetId(net));
                    // Transport: compare against the last *scheduled* value
                    // for this net, not the currently applied one (see
                    // `net_scheduled` field docs).
                    if resolved != self.net_scheduled[net as usize] {
                        self.net_scheduled[net as usize] = resolved.clone();
                        let at = ev.time + self.net_delay[net as usize];
                        self.schedule(
                            at,
                            EvKind::Net {
                                net,
                                value: resolved,
                            },
                        );
                        // Causal pointer lands at apply time (below).
                        self.pending_net_cause.push((net, cause));
                    }
                }
            }
            EvKind::Net { net, value } => {
                let n = net as usize;
                // Causal pointer: pop the scheduling record (FIFO per net)
                // before any early return, so entries never leak.
                if let Some(pos) = self.pending_net_cause.iter().position(|&(nn, _)| nn == net) {
                    let (_, cause) = self.pending_net_cause.remove(pos);
                    self.net_cause[n] = Some(cause);
                }
                if self.net_values[n] == value {
                    return Ok(()); // superseded transport duplicate
                }
                self.net_values[n] = value.clone();
                // Z-watch maintenance.
                if self.z_watched_net[n] {
                    if value.is_fully_z() {
                        self.z_nets.insert(net);
                    } else {
                        self.z_nets.remove(&net);
                    }
                }
                // DTA settle tracking.
                if self.state_input_net[n] {
                    let cycle_start = self.next_boundary - 2 * self.half_period;
                    let dt = ev.time - cycle_start;
                    if dt > self.cycle_settle {
                        self.cycle_settle = dt;
                        self.cycle_settle_net = Some(net);
                    }
                }
                // Reactions in comp order (sinks were built in comp order);
                // iterate the precomputed Copy table — no cloning.
                for i in 0..self.net_sinks[n].len() {
                    let SinkPin { comp, kind } = self.net_sinks[n][i];
                    self.react(comp, net, kind, ev.time)?;
                }
            }
            EvKind::Poke { comp, value } => {
                self.comps[comp as usize].set_pin_value(value);
                self.eval_and_schedule(comp, ev.time, None)?;
            }
        }
        Ok(())
    }

    /// A net changed: notify one sink component.
    fn react(&mut self, comp: u32, net: u32, pin: SinkKind, time: u64) -> Result<(), Halt> {
        let c = comp as usize;
        match self.cdata[c].class {
            Class::Comb | Class::Splitter | Class::Rom => {
                self.eval_and_schedule(comp, time, Some(net))?;
            }
            Class::Ram => match pin {
                SinkKind::Addr => {
                    self.track_hold(c, TrackField::Addr, time);
                    self.eval_and_schedule(comp, time, Some(net))?;
                }
                SinkKind::Din => self.track_hold(c, TrackField::Din, time),
                SinkKind::Clk => {
                    let cur = self.net_values[net as usize].bit(0);
                    if cur == Bit::One {
                        self.clock_edge(comp, time)?;
                    }
                }
                _ => {}
            },
            Class::Register => match pin {
                SinkKind::D => self.track_hold(c, TrackField::D, time),
                SinkKind::Clk => {
                    let cur = self.net_values[net as usize].bit(0);
                    if cur == Bit::One {
                        self.clock_edge(comp, time)?;
                    }
                }
                _ => {}
            },
            Class::Source | Class::Sink => {}
        }
        Ok(())
    }

    /// Record a data-input change; flag a hold violation if it lands
    /// within `t_hold` after the last edge.
    fn track_hold(&mut self, c: usize, field: TrackField, time: u64) {
        let hold = self.cdata[c].timing.hold;
        let tr = &mut self.clk_track[c];
        if let Some(e) = tr.last_edge {
            if time >= e && time < e + hold {
                self.violations.push(TimingViolation {
                    comp: CompId(c as u32),
                    kind: ViolationKind::Hold,
                    time,
                    cycle: self.rising_seen,
                });
            }
        }
        match field {
            TrackField::D => tr.last_d = Some(time),
            TrackField::Din => tr.last_din = Some(time),
            TrackField::Addr => tr.last_addr = Some(time),
        }
    }

    /// Rising clock edge on a register/RAM: setup check, latch/write
    /// (consuming `Z` halts), schedule the output commit.
    fn clock_edge(&mut self, comp: u32, time: u64) -> Result<(), Halt> {
        let c = comp as usize;
        let setup = self.cdata[c].timing.setup;
        let tr = self.clk_track[c];
        let last_data = match self.cdata[c].class {
            Class::Ram => tr.last_din.max(tr.last_addr),
            _ => tr.last_d,
        };
        if let Some(dc) = last_data {
            if dc > time.saturating_sub(setup) && dc <= time {
                self.violations.push(TimingViolation {
                    comp: CompId(c as u32),
                    kind: ViolationKind::Setup,
                    time,
                    cycle: self.rising_seen,
                });
            }
        }
        self.clk_track[c].last_edge = Some(time);
        // Sample inputs and latch (consume rules fire here).
        let ins: Vec<Value> = self.cdata[c]
            .in_pins
            .iter()
            .map(|(_, net)| self.net_values[net.idx()].clone())
            .collect();
        let ins_refs: Vec<&Value> = ins.iter().collect();
        self.comps[c]
            .rising_edge(&ins_refs)
            .map_err(|fr| self.halt_floating(comp, fr))?;
        // Q / dout commit after clk→Q / access (gen-guarded: last edge wins).
        self.eval_and_schedule(comp, time, None)?;
        Ok(())
    }

    /// Close the current cycle: record DTA results, run the
    /// floating-read sweep, reset per-cycle counters.
    fn close_cycle(&mut self) -> Result<(), Halt> {
        // Persistent-Z sweep (module docs): the first watched net that is
        // still floating, in net-id order, names its first watched sink.
        if let Some(&net) = self.z_nets.iter().next() {
            let n = &self.netlist.nets[net as usize];
            for (sink, pin) in &n.sinks {
                let cd = &self.cdata[sink.idx()];
                let watched = matches!(cd.class, Class::Comb)
                    || (matches!(cd.class, Class::Ram | Class::Rom) && pin == "addr");
                if watched {
                    return Err(Halt {
                        reason: HaltReason::FloatingRead,
                        cycle: self.rising_seen,
                        details: format!(
                            "{}: pin '{pin}'",
                            self.netlist.comps[sink.idx()].origin()
                        ),
                    });
                }
            }
        }
        if self.cycle_settle > 0 {
            self.t_obs = self.t_obs.max(self.cycle_settle);
            let path = self.extract_path(self.cycle_settle_net);
            let entry = (self.cycle_settle, path);
            if !self.top_paths.contains(&entry) {
                self.top_paths.push(entry);
                self.top_paths
                    .sort_by_key(|(settle, _)| std::cmp::Reverse(*settle));
                self.top_paths.truncate(TOP_K);
            }
        }
        self.cycle_settle = 0;
        self.cycle_settle_net = None;
        self.events_this_cycle = 0;
        self.next_boundary += 2 * self.half_period;
        Ok(())
    }

    /// Walk causal back-pointers from the net that set this cycle's
    /// settle time to the launching state element (module docs).
    fn extract_path(&self, start: Option<u32>) -> Vec<CompId> {
        let mut path = Vec::new();
        let mut cur = start;
        while let Some(net) = cur {
            match self.net_cause[net as usize] {
                Some((comp, src)) => {
                    path.push(CompId(comp));
                    cur = src;
                }
                _ => break,
            }
            if path.len() > self.comps.len() {
                break; // defensive: causality is time-ordered, cannot cycle
            }
        }
        path
    }

    /// FNV-1a over the applied event — the determinism tripwire (§4.6).
    fn hash_event(&mut self, ev: &Ev) {
        let mut h = self.trace_hash;
        let mut mix = |bytes: &[u8]| {
            for &b in bytes {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        mix(&ev.time.to_le_bytes());
        mix(&ev.seq.to_le_bytes());
        match &ev.kind {
            EvKind::Clock { phase } => {
                mix(&[0]);
                mix(&[u8::from(*phase)]);
            }
            EvKind::Fire { comp, gen } => {
                mix(&[1]);
                mix(&comp.to_le_bytes());
                mix(&gen.to_le_bytes());
            }
            EvKind::Net { net, value } => {
                mix(&[2]);
                mix(&net.to_le_bytes());
                let wv = value.to_wire_value();
                mix(wv.v.as_bytes());
                mix(wv.x.as_bytes());
                mix(wv.z.as_bytes());
            }
            EvKind::Poke { comp, value } => {
                mix(&[3]);
                mix(&comp.to_le_bytes());
                let wv = value.to_wire_value();
                mix(wv.v.as_bytes());
                mix(wv.x.as_bytes());
                mix(wv.z.as_bytes());
            }
        }
        self.trace_hash = h;
    }
}

#[derive(Debug, Clone, Copy)]
enum TrackField {
    D,
    Din,
    Addr,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::load_document;
    use crate::netlist;

    pub(super) fn engine(json: &str, half: u64) -> DelayEngine {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        let table = TimingTable::builtin("cs2200-74ls-v1").unwrap();
        DelayEngine::new(nl, half, &table).expect("test engine builds")
    }

    pub(super) fn k(width: u32, v: u64) -> Value {
        Value::from_u64(width, v)
    }

    pub(super) const SETTINGS: &str =
        r#""settings":{"delayModel":"delay","clockHz":1,"delayTable":"cs2200-74ls-v1"}"#;

    /// Two-stage pipeline: r1.q → not → and → r2.d; r1 toggles
    /// (r1.d ← not(r1.q)). Table delays: clk→Q 20, not 9, and 10 →
    /// after a toggle, r2.d settles at 20+9+10 = 39.
    pub(super) fn pipeline_json() -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"r1","type":"mem.register","pos":[0,0],"name":"r1"}},
                {{"id":"r2","type":"mem.register","pos":[0,0],"name":"r2"}},
                {{"id":"inv","type":"gate.not","pos":[0,0]}},
                {{"id":"n2","type":"gate.not","pos":[0,0]}},
                {{"id":"and","type":"gate.and","pos":[0,0]}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r2","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r2","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r1","pin":"rst"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r2","pin":"rst"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"inv","pin":"in"}}}},
                {{"a":{{"comp":"inv","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"n2","pin":"in"}}}},
                {{"a":{{"comp":"n2","pin":"out"}},"b":{{"comp":"and","pin":"in0"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"and","pin":"in1"}}}},
                {{"a":{{"comp":"and","pin":"out"}},"b":{{"comp":"r2","pin":"d"}}}}
            ]}}]
        }}"##
        )
    }

    #[test]
    fn t_obs_matches_hand_computed_value() {
        // half = 500 ns (cycle 1000 ns — far above the 39 ns path).
        let mut eng = engine(&pipeline_json(), 500);
        let rep = eng.run(3).unwrap();
        assert_eq!(rep.cycles, 3);
        assert_eq!(rep.t_obs, 39, "clk→Q 20 + not 9 + and 10");
        assert!(rep.violations.is_empty());
        // r1 toggled every cycle; r2 follows one cycle behind (d=1,0,1 at
        // the three edges → q=1).
        assert_eq!(eng.named_value("r1"), Some(k(1, 1))); // 3 toggles: 0→1→0→1
        assert_eq!(eng.named_value("r2"), Some(k(1, 1)));
        // The observed critical path names the chain r2.d ← and ← n2 ← r1
        // (ending at the launching register).
        let (settle, path) = &rep.top_paths[0];
        assert_eq!(*settle, 39);
        let names: Vec<&str> = path
            .iter()
            .map(|c| eng.netlist().comps[c.idx()].def_id.as_str())
            .collect();
        assert_eq!(names, ["and", "n2", "r1"]);
    }

    #[test]
    fn inertial_gate_swallows_narrow_glitch() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"g","type":"gate.not","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"g","pin":"in"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 5000);
        assert!(eng.poke_at("src", k(1, 1), 100));
        assert!(eng.poke_at("src", k(1, 0), 105)); // 5 ns pulse < t_pd 9
        eng.run_until_time(200).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(1, 1))); // never fell
                                                           // A held input propagates after t_pd.
        assert!(eng.poke_at("src", k(1, 1), 300));
        eng.run_until_time(309).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(1, 1)));
        eng.run_until_time(310).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(1, 0)));
    }

    #[test]
    fn transport_wire_passes_narrow_glitch() {
        // pin → 200-grid-unit wire → probe: d_net = 200/10 = 20 ns.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"d"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"p","pin":"in"}},
                 "points":[[0,0],[100,0],[100,100]]}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 5000);
        assert!(eng.poke_at("src", k(1, 1), 100));
        assert!(eng.poke_at("src", k(1, 0), 105)); // 5 ns pulse
        eng.run_until_time(120).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 0)));
        eng.run_until_time(121).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 1))); // leading edge @120
        eng.run_until_time(125).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 1)));
        eng.run_until_time(126).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 0))); // trailing edge @125
    }

    #[test]
    fn wire_delay_constant_comes_from_the_table() {
        // Same 200-grid-unit wire as the transport test; a table with
        // wire {num:1, den:1} makes the net delay 200 ns (vs 20 with the
        // reference table's 1/10) — the constant is data, not code (B7).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"d"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"p","pin":"in"}},
                 "points":[[0,0],[100,0],[100,100]]}}
            ]}}]
        }}"##
        );
        let doc = load_document(json.as_bytes()).unwrap();
        let nl = netlist::build(&doc).unwrap();
        let mut custom: serde_json::Value =
            serde_json::from_str(include_str!("../data/cs2200-74ls-v1.json")).unwrap();
        custom["wire"]["den"] = serde_json::json!(1);
        let table = TimingTable::from_json(&custom.to_string()).unwrap();
        let mut eng = DelayEngine::new(nl, 5000, &table).unwrap();
        assert!(eng.poke_at("src", k(1, 1), 100));
        eng.run_until_time(300).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 0)));
        eng.run_until_time(301).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 1))); // edge @100+200
    }

    #[test]
    fn setup_and_hold_violations_are_warnings() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"d","type":"wiring.pin","pos":[0,0],"name":"d"}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r","pin":"rst"}}}},
                {{"a":{{"comp":"d","pin":"pin"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 50); // period 100, edges at 100/200/…
        eng.run(1).unwrap(); // edge @100, clean
        assert_eq!(eng.named_value("r"), Some(k(1, 0)));
        // Setup: D changes at 190, within t_setup 15 of the edge at 200.
        eng.poke_at("d", k(1, 1), 190);
        eng.run(1).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(1, 1))); // latch still happens
        assert_eq!(eng.violations().len(), 1);
        assert_eq!(eng.violations()[0].kind, ViolationKind::Setup);
        // Hold: D changes at 302, within t_hold 5 after the edge at 300.
        eng.poke_at("d", k(1, 0), 302);
        eng.run(1).unwrap();
        assert_eq!(eng.violations().len(), 2);
        assert_eq!(eng.violations()[1].kind, ViolationKind::Hold);
        assert_eq!(eng.violations()[1].comp.0, eng.violations()[0].comp.0);
    }

    #[test]
    fn snapshot_restore_continues_bit_identically() {
        // A: 3 cycles, snapshot, 3 more. B: 6 straight. C: restore A's
        // snapshot, 3 more. All three must agree on everything observable.
        let mut a = engine(&pipeline_json(), 500);
        a.run(3).unwrap();
        let snap = a.snapshot();
        a.run(3).unwrap();

        let mut b = engine(&pipeline_json(), 500);
        b.run(6).unwrap();

        let mut c = engine(&pipeline_json(), 500);
        c.restore(&snap).unwrap();
        c.run(3).unwrap();

        for (name, eng) in [("b", &b), ("c", &c)] {
            assert_eq!(a.trace_hash(), eng.trace_hash(), "{name} trace_hash");
            assert_eq!(a.t_obs(), eng.t_obs(), "{name} t_obs");
            assert_eq!(a.cycle(), eng.cycle(), "{name} cycle");
            assert_eq!(a.named_value("r1"), eng.named_value("r1"), "{name} r1");
            assert_eq!(a.named_value("r2"), eng.named_value("r2"), "{name} r2");
            assert_eq!(a.violations(), eng.violations(), "{name} violations");
        }
    }

    #[test]
    fn restore_rejects_mismatched_snapshots() {
        let mut eng = engine(&pipeline_json(), 500);
        eng.run(1).unwrap();
        let snap = eng.snapshot();
        assert!(eng.restore("{garbage").is_err());
        // Different circuit (the setup/hold fixture's 5 comps) → shape error.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}}
            ], "wires": []}}]
        }}"##
        );
        let mut other = engine(&json, 500);
        assert!(other.restore(&snap).is_err());
    }

    #[test]
    fn identical_runs_have_identical_trace_hashes() {
        let json = pipeline_json();
        let mut a = engine(&json, 500);
        let mut b = engine(&json, 500);
        assert!(!a.poke_at("no-such-pin", k(1, 1), 0)); // unknown pin: no-op
        b.run(50).unwrap();
        a.run(50).unwrap();
        assert_eq!(a.trace_hash(), b.trace_hash());
        assert_eq!(a.t_obs(), b.t_obs());
        assert_ne!(a.trace_hash(), 0xcbf2_9ce4_8422_2325); // real work hashed
    }

    #[test]
    fn rom_read_settles_after_access_time() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"addr","type":"wiring.pin","pos":[0,0],"name":"addr","attrs":{{"bitsize":2}}}},
                {{"id":"rom","type":"mem.rom","pos":[0,0],"name":"rom",
                  "attrs":{{"bitsize":8,"depth":4,"contents":"aa 55 0f f0"}}}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out","attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"addr","pin":"pin"}},"b":{{"comp":"rom","pin":"addr"}}}},
                {{"a":{{"comp":"rom","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 5000);
        assert!(eng.poke_at("addr", k(2, 1), 100));
        // Boot: the addr pin drives 0 at T=0 → word 0 read commits at T=50.
        eng.run_until_time(149).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(8, 0xaa)));
        eng.run_until_time(151).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(8, 0x55))); // t_access 50
    }

    #[test]
    fn event_storm_halts_with_oscillation() {
        // nand(a=src, b=self): primed at src=0 (out=1), then src=1 →
        // zero-delay storm (delay overridden to 0).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"g","type":"gate.nand","pos":[0,0],"attrs":{{"delay":0}}}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"g","pin":"in0"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"g","pin":"in1"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 5000);
        eng.events_per_cycle_cap = 200;
        eng.poke_at("src", k(1, 1), 10);
        let halt = eng.run(1).expect_err("storm must halt");
        assert_eq!(halt.reason, HaltReason::Oscillation);
    }

    #[test]
    fn floating_gate_input_halts_at_cycle_close() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"c","type":"wiring.constant","pos":[0,0]}},
                {{"id":"g","type":"gate.and","pos":[0,0]}}
            ], "wires": [
                {{"a":{{"comp":"c","pin":"out"}},"b":{{"comp":"g","pin":"in0"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        let halt = eng.run(1).expect_err("must halt");
        assert_eq!(halt.reason, HaltReason::FloatingRead);
        assert!(halt.details.contains("in1"), "got: {}", halt.details);
    }

    fn bus_json() -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"a","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8,"value":"11"}}}},
                {{"id":"b","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8,"value":"22"}}}},
                {{"id":"ea","type":"wiring.pin","pos":[0,0],"name":"ea"}},
                {{"id":"eb","type":"wiring.pin","pos":[0,0],"name":"eb"}},
                {{"id":"ba","type":"wiring.controlled-buffer","pos":[0,0],"attrs":{{"bitsize":8}}}},
                {{"id":"bb","type":"wiring.controlled-buffer","pos":[0,0],"attrs":{{"bitsize":8}}}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"bus","attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"a","pin":"out"}},"b":{{"comp":"ba","pin":"in"}}}},
                {{"a":{{"comp":"b","pin":"out"}},"b":{{"comp":"bb","pin":"in"}}}},
                {{"a":{{"comp":"ea","pin":"pin"}},"b":{{"comp":"ba","pin":"en"}}}},
                {{"a":{{"comp":"eb","pin":"pin"}},"b":{{"comp":"bb","pin":"en"}}}},
                {{"a":{{"comp":"ba","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"bb","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        )
    }

    #[test]
    fn idle_bus_displays_z_without_halting() {
        // Two controlled buffers on a bus; enables switch drivers, then
        // both off: the bus idles at Z feeding only a probe — legal.
        let json = bus_json();
        let mut eng = engine(&json, 500);
        eng.poke_at("ea", k(1, 1), 10);
        eng.run_until_time(50).unwrap();
        assert_eq!(eng.named_value("bus"), Some(k(8, 0x11)));
        eng.poke_at("ea", k(1, 0), 60);
        eng.poke_at("eb", k(1, 1), 60);
        eng.run_until_time(100).unwrap();
        assert_eq!(eng.named_value("bus"), Some(k(8, 0x22)));
        eng.poke_at("eb", k(1, 0), 110);
        eng.run(1).unwrap(); // bus idles at Z across a cycle close — no halt
        assert_eq!(eng.named_value("bus"), Some(Value::z(8)));
    }

    #[test]
    fn zero_and_delay_engines_agree_on_a_counter() {
        // Same circuit functionally: the zero engine counts 1/cycle; the
        // delay engine must latch the same sequence.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 2, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8,"value":"1"}}}},
                {{"id":"one1","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero1","type":"wiring.constant","pos":[0,0]}},
                {{"id":"reg","type":"mem.register","pos":[0,0],"name":"r","attrs":{{"bitsize":8}}}},
                {{"id":"add","type":"arith.adder","pos":[0,0],"attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"reg","pin":"clk"}}}},
                {{"a":{{"comp":"one1","pin":"out"}},"b":{{"comp":"reg","pin":"en"}}}},
                {{"a":{{"comp":"zero1","pin":"out"}},"b":{{"comp":"reg","pin":"rst"}}}},
                {{"a":{{"comp":"add","pin":"out"}},"b":{{"comp":"reg","pin":"d"}}}},
                {{"a":{{"comp":"reg","pin":"q"}},"b":{{"comp":"add","pin":"a"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"add","pin":"b"}}}},
                {{"a":{{"comp":"zero1","pin":"out"}},"b":{{"comp":"add","pin":"cin"}}}}
            ]}}]
        }}"##
        );
        let mut z = {
            let doc = load_document(json.as_bytes()).unwrap();
            let nl = netlist::build(&doc).unwrap();
            crate::zero::ZeroEngine::new(nl).unwrap()
        };
        let mut d = engine(&json, 500);
        z.run(5).unwrap();
        d.run(5).unwrap();
        assert_eq!(z.named_value("r"), d.named_value("r"));
        assert_eq!(d.cycle(), 5);
        assert_eq!(d.named_value("r"), Some(k(8, 5)));
    }
}

#[cfg(test)]
mod perf_probe {
    use super::tests::{engine, pipeline_json};

    /// Release-mode perf probe (B10's budget depends on it):
    /// `cargo test --release -p csim-core perf_probe -- --nocapture --ignored`
    #[test]
    #[ignore = "release-mode perf measurement"]
    fn pipeline_100k_cycles() {
        let mut eng = engine(&pipeline_json(), 500);
        let start = std::time::Instant::now();
        let rep = eng.run(100_000).unwrap();
        eprintln!(
            "100k cycles, {} events in {:?} ({:.0} events/cycle, {:.1} Mevents/s)",
            rep.events_processed,
            start.elapsed(),
            rep.events_processed as f64 / 100_000.0,
            rep.events_processed as f64 / start.elapsed().as_secs_f64() / 1e6
        );
    }
}
