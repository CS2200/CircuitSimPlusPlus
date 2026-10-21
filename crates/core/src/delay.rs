//! Delay-aware event-driven engine (DESIGN.md §4.3, §4.4; BACKEND.md task
//! B6) — the teaching + grading engine.
//!
//! Events are processed from a `(time, seq)`-ordered queue; `seq` is a
//! monotonic counter assigned at schedule time, and same-timestamp
//! reactions run in component-index order — runs are bit-for-bit
//! reproducible (§4.6).
//!
//! ## The delay model (resolved D1, per-path since contract v1.1 / F14)
//!
//! - **Wires — per-path transport delay.** Every transition of a net's
//!   resolved value is delivered to each *sink pin* at
//!   `path_len(driver → that sink) × wire-delay constant` (path lengths
//!   from the netlist's wire graph, in grid units; the constant from the
//!   delay table; 0 disables). Unused stub branches do **not** inflate
//!   other sinks' delays. Each sink pin has its own *view* of the net;
//!   every transition is reproduced at every sink, however narrow the
//!   pulse. (Multi-driver nets use the nearest driver's path per sink —
//!   documented approximation; single-driver nets are exact.)
//! - **Gates — inertial delay.** Each component carries a `(generation,
//!   pending outputs)` pair; an input change recomputes the outputs and
//!   re-schedules the pending commit at `now + t_pd`, cancelling the
//!   previous generation — an input pulse narrower than `t_pd` never
//!   reaches the output. If the recomputed outputs equal the already
//!   scheduled ones, the pending commit keeps its original time (the
//!   schedule is not deferred — U23).
//! - **Registers — clk→Q + setup/hold.** On a rising `clk` view, D is
//!   sampled (consuming `Z` halts, §4.1) and Q commits `clk→Q` later
//!   (last edge wins, same generation mechanism). D changing within
//!   `t_setup` before the edge (`edge − t_setup < change ≤ edge`) or
//!   within `t_hold` after it (`edge ≤ change < edge + t_hold`) is
//!   recorded as a **warning** (`TimingViolation`); the latch still
//!   happens, deterministically.
//! - **RAM/ROM** — reads settle `t_access` after an address change;
//!   writes obey the same edge + setup/hold discipline as registers
//!   (tracked on `din`, `addr`, and `we`).
//!
//! ## Boot settle (contract v1.1, F6)
//!
//! Construction runs a **boot settle**: the power-on event queue is
//! processed to quiescence *without any clock edges* (rails stabilizing
//! before the clock starts; the boot is capped by
//! `events_per_cycle_cap` — a free-running ring halts with
//! `Oscillation`). Time then restarts at 0, cycle accounting begins, and
//! the first rising edge is at `T = 2 × half`. Boot activity does not
//! count toward DTA settle times.
//!
//! ## Floating-consume in an event engine (§4.1, per-consumer since F6)
//!
//! Combinational components evaluate only once **all** their input views
//! are non-`Z` (a `Z` view means "not yet arrived"; the output holds).
//! At each **cycle close** a per-consumer sweep halts the run with
//! `FloatingRead` only when a pin that *consumes* (per the behavior
//! module's consume table — muxes consume only the selected input,
//! probes/splitters nothing, etc.) still sees a fully-`Z` input view
//! **and** its net has never carried a non-`Z` value this run (genuinely
//! undriven). Nets that were driven and went idle-`Z` (tri-state buses)
//! never halt; overclocked designs (propagation longer than the period)
//! produce setup/hold warnings and wrong-but-deterministic latching,
//! never a floating halt. Register/RAM consume rules (D while enabled at
//! an edge, RAM ports during an access) halt immediately, exactly as in
//! the zero-delay engine.
//!
//! ## Clock, cycles, DTA
//!
//! The global clock is a free-running square wave with half period
//! `clock_half_period` (engine parameter; the CLI pins it with
//! `--clock-half-period-ns`, default 1000 ns). Cycle 0 is the first full
//! period after the boot settle. Per cycle, the engine records the
//! timestamp of the last input change at any register/memory input pin
//! (its own view's arrival), measured from cycle start; `T_obs` is the
//! maximum over the run — **including the final in-progress cycle, which
//! is closed out at run end** (§4.4, F7) — and `est_time = cycles ×
//! T_obs`. The top-k (10) longest distinct observed paths are kept as
//! component-ID chains for UI highlighting, reconstructed from per-net
//! causal back-pointers (`net → (comp, triggering input net)`).
//!
//! An **event storm** (§4.5 — e.g. a zero-delay inverter ring) is capped
//! per cycle (`events_per_cycle_cap`) and halts with
//! `HaltReason::Oscillation`; the simulator never hangs.
//!
//! A running **FNV-1a trace hash** over every applied event (time, seq,
//! kind, ids, value masks) is the determinism tripwire: same circuit +
//! same inputs ⇒ same hash, every platform.

use std::collections::BinaryHeap;

use crate::api::{CompId, HaltReason, LoadError, LoadErrorKind, NamedKind, NetId};
use crate::behavior::{Behavior, FloatingRead, Timing};
use crate::engine_common as ec;
pub use crate::engine_common::Halt;
use crate::netlist::Netlist;
use crate::timing_table::TimingTable;
use crate::value::{Bit, Value};

/// Default cap on applied events per cycle before declaring an event
/// storm (§4.5).
pub const DEFAULT_EVENTS_PER_CYCLE_CAP: u64 = 1_000_000;

const TOP_K: usize = 10;

/// A setup/hold warning (DESIGN.md §4.3): recorded, never corrupts state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct TimingViolation {
    /// Component whose input changed too close to its clock edge.
    pub comp: CompId,
    /// Which discipline was violated (setup or hold).
    pub kind: ViolationKind,
    /// Simulation time of the offending edge.
    pub time: u64,
    /// Cycle (rising-edge count) containing the edge.
    pub cycle: u64,
}

/// Which timing discipline a [`TimingViolation`] records (§4.3).
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
    /// Total events applied over the run.
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
    /// Apply a resolved net value to the net's shared "latest" slot at the
    /// earliest sink's arrival (transport bookkeeping; reactions happen
    /// per sink via `Deliver`).
    Net { net: u32, value: Value },
    /// Deliver a resolved net value to one sink pin's view, at that
    /// sink's own path-delay arrival (per-path transport, F14). `kind`
    /// is the precomputed sink-pin classification (avoids a per-event
    /// sink-table scan on wide fan-out nets).
    Deliver {
        net: u32,
        comp: u32,
        slot: u32,
        kind: SinkKind,
        value: Value,
    },
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

/// Serializable snapshot form (`snapshot`/`restore`, §8.1). Version 2:
/// per-sink views + per-path deliveries (F14); version 1 files are
/// rejected cleanly.
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
    views: Vec<Vec<crate::api::WireValue>>,
    net_values: Vec<crate::api::WireValue>,
    net_scheduled: Vec<crate::api::WireValue>,
    net_cause: Vec<Option<(u32, Option<u32>)>>,
    net_ever_driven: Vec<bool>,
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
    slot: u32,
    #[serde(default)]
    kind2: SinkKind,
    #[serde(default)]
    phase: bool,
    #[serde(default)]
    value: Option<crate::api::WireValue>,
}

impl SnapEv {
    fn from_ev(e: &Ev) -> SnapEv {
        let (kind, comp, gen, net, slot, kind2, phase, value) = match &e.kind {
            EvKind::Clock { phase } => ("clock", 0, 0, 0, 0, SinkKind::Other, *phase, None),
            EvKind::Fire { comp, gen } => ("fire", *comp, *gen, 0, 0, SinkKind::Other, false, None),
            EvKind::Net { net, value } => (
                "net",
                0,
                0,
                *net,
                0,
                SinkKind::Other,
                false,
                Some(value.to_wire_value()),
            ),
            EvKind::Deliver {
                net,
                comp,
                slot,
                kind,
                value,
            } => (
                "deliver",
                *comp,
                0,
                *net,
                *slot,
                *kind,
                false,
                Some(value.to_wire_value()),
            ),
            EvKind::Poke { comp, value } => (
                "poke",
                *comp,
                0,
                0,
                0,
                SinkKind::Other,
                false,
                Some(value.to_wire_value()),
            ),
        };
        SnapEv {
            time: e.time,
            seq: e.seq,
            kind: kind.to_string(),
            comp,
            gen,
            net,
            slot,
            kind2,
            phase,
            value,
        }
    }

    /// Rebuild the event; `width_of` resolves payload widths (net events
    /// from the net, poke/deliver events from the pin).
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
            "deliver" => EvKind::Deliver {
                net: self.net,
                comp: self.comp,
                slot: self.slot,
                kind: self.kind2,
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

/// Per-clocked-component setup/hold tracking. `we` is tracked like
/// `din`/`addr` (contract v1.1, F11 — the write-enable must also be
/// stable around the edge).
#[derive(Debug, Clone, Copy, Default, serde::Serialize, serde::Deserialize)]
struct ClockTrack {
    last_edge: Option<u64>,
    last_d: Option<u64>,
    last_din: Option<u64>,
    last_addr: Option<u64>,
    last_we: Option<u64>,
}

/// Precomputed sink-pin identity per net (Copy — the hot Deliver-apply
/// loop iterates it without cloning the netlist's `String` sink table).
#[derive(Debug, Clone, Copy)]
struct SinkPin {
    comp: u32,
    /// Pin slot within the sink component (view index).
    slot: u32,
    kind: SinkKind,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
enum SinkKind {
    D,
    Clk,
    En,
    Addr,
    Din,
    We,
    #[default]
    Other,
}

impl SinkKind {
    fn from_pin(name: &str) -> SinkKind {
        match name {
            "d" => SinkKind::D,
            "clk" => SinkKind::Clk,
            "en" => SinkKind::En,
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
    /// Per-sink-pin views of each net, comp-major in `PinConn` order (like
    /// `drives`): what each input pin has *received* — per-path transport
    /// (F14). Splitter pins don't use views (they read other drivers'
    /// drive slots directly).
    views: Vec<Vec<Value>>,
    net_drivers: Vec<Vec<(u32, usize)>>,
    /// Latest *applied* resolved value per net (observation/probe value;
    /// applied at the earliest sink's arrival).
    net_values: Vec<Value>,
    /// Last *scheduled* value per net (transport bookkeeping: a resolved
    /// transition equal to the current value must still be scheduled when
    /// an earlier transition is already in flight — otherwise the trailing
    /// edge of a pulse narrower than the wire delay would be lost).
    net_scheduled: Vec<Value>,
    /// Per-sink transport delay (ns), aligned with `net_sinks`
    /// (nearest-driver path length × table constant, F14).
    net_sink_delay: Vec<Vec<u64>>,
    /// Per net: earliest sink arrival (ns); 0 for sink-less nets.
    net_min_delay: Vec<u64>,
    /// Causal back-pointer per net: (comp that last changed it, that
    /// comp's triggering input net) — for critical-path reconstruction.
    net_cause: Vec<Option<(u32, Option<u32>)>>,
    /// Nets feeding a register/memory input pin (DTA settle watchers).
    state_input_net: Vec<bool>,
    /// Whether a non-fully-`Z` resolution of this net has ever been
    /// scheduled this run (the cycle-close sweep's immunity rule, F6).
    net_ever_driven: Vec<bool>,
    /// Precomputed sinks per net (comp order preserved).
    net_sinks: Vec<Vec<SinkPin>>,
    /// Registers and RAMs whose `clk` pin sits on a floating net — nothing
    /// drives it, so the pin is unwired (or wired to nothing that drives).
    /// They are clocked by the circuit's clock: the engine ticks them with the
    /// global rising clock event (UI_OVERHAUL §93).
    implicit_clk: Vec<u32>,
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
    /// Cap on applied events per cycle (storm detection, §4.5); also the
    /// boot settle's quiescence cap.
    pub events_per_cycle_cap: u64,
    events_this_cycle: u64,
    events_processed: u64,
    trace_hash: u64,
    halted: Option<Halt>,
    /// True during the construction-time boot settle (module docs): no
    /// cycle closes, no DTA settle tracking, and no breakpoint fires (a
    /// breakpoint watches *changes during the run*; every net takes on a
    /// value at power-on, and stopping for that would be noise — see
    /// `react`'s `Class::Sink` arm).
    in_boot: bool,
}

impl DelayEngine {
    /// Build the engine. `clock_half_period` is in delay-table units
    /// (ns); it should exceed the design's true critical path or setup
    /// violations pile up (that's the lesson, §4.3 — the engine no longer
    /// *halts* in that case, F6). All delays come from `table` (the
    /// published table named by `settings.delayTable`, B7).
    pub fn new(
        netlist: Netlist,
        clock_half_period: u64,
        table: &TimingTable,
    ) -> Result<DelayEngine, Vec<LoadError>> {
        let comps = ec::build_behaviors(&netlist)?;
        let n = comps.len();
        let mut cdata = Vec::with_capacity(n);
        let mut state_input_net = vec![false; netlist.nets.len()];
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
            if let Class::Register | Class::Ram | Class::Rom = class {
                // DTA watches *data* inputs; the clock is the reference,
                // not a settling signal (its falling edge would otherwise
                // dominate every cycle).
                for (slot, net) in &in_pins {
                    if fc.pins[*slot].pin != "clk" {
                        state_input_net[net.idx()] = true;
                    }
                }
            }
            cdata.push(CompData {
                class,
                in_pins,
                out_pins,
                timing: beh.timing(table),
            });
        }
        let net_values: Vec<Value> = netlist.nets.iter().map(|n| Value::z(n.width)).collect();
        let net_scheduled = net_values.clone();
        let views: Vec<Vec<Value>> = ec::drive_slots(&netlist); // all-Z, same shape
                                                                // Per-sink path delays (F14): grid units × the table's wire
                                                                // constant; min per net for the shared "latest value" slot.
        let net_sink_delay: Vec<Vec<u64>> = netlist
            .nets
            .iter()
            .map(|n| {
                n.sink_wire_units
                    .iter()
                    .map(|&units| table.wire_delay(units))
                    .collect()
            })
            .collect();
        let net_min_delay: Vec<u64> = net_sink_delay
            .iter()
            .map(|ds| ds.iter().copied().min().unwrap_or(0))
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
                        slot: netlist.comps[c.idx()]
                            .pins
                            .iter()
                            .position(|p| &p.pin == pin)
                            .expect("sink pin exists") as u32,
                        kind: SinkKind::from_pin(pin),
                    })
                    .collect()
            })
            .collect();
        // Implicit clocks (UI_OVERHAUL §93): a register/RAM whose `clk` pin is
        // on a floating net follows the *circuit's* clock. The clock component
        // toggles with the global clock event (see the `EvKind::Clock` arm), so
        // ticking these on the same event is the same edge — at the same time,
        // in the same cycle. A net that merely *has* a driver is left to the
        // ordinary path: the pin is wired, so its own edge decides.
        let implicit_clk: Vec<u32> = (0..n as u32)
            .filter(|&c| {
                let cd = &cdata[c as usize];
                matches!(cd.class, Class::Register | Class::Ram)
                    && cd.in_pins.iter().any(|(slot, net)| {
                        netlist.comps[c as usize].pins[*slot].pin == "clk"
                            && netlist.nets[net.idx()].floating
                    })
            })
            .collect();
        let n_nets = netlist.nets.len();
        let drives = ec::drive_slots(&netlist);
        let mut eng = DelayEngine {
            netlist,
            comps,
            cdata,
            drives,
            views,
            net_drivers,
            net_values,
            net_scheduled,
            net_sink_delay,
            net_min_delay,
            net_cause: vec![None; n_nets],
            state_input_net,
            net_ever_driven: vec![false; n_nets],
            net_sinks,
            implicit_clk,
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
            in_boot: true,
        };
        // Power-on for combinational loops: seed loop nets to 0 (same
        // deterministic rule as the zero-delay engine) so feedback logic
        // starts from a defined state. Splitters are excepted: they carry
        // values but never originate them (B11 — a 0 seed phantom-contends
        // with the other side of a splitter chain). The seed must reach
        // every sink's *view* (gates read views, F14).
        let (_, residue) = crate::engine_common::levelize(&eng.netlist, &eng.comps);
        for c in residue {
            if eng.comps[c as usize].is_splitter() {
                continue;
            }
            for (_, net) in &eng.cdata[c as usize].out_pins {
                let width = eng.netlist.nets[net.idx()].width;
                eng.net_values[net.idx()] = Value::zero(width);
                eng.net_scheduled[net.idx()] = Value::zero(width);
                for sp in &eng.net_sinks[net.idx()] {
                    eng.views[sp.comp as usize][sp.slot as usize] = Value::zero(width);
                }
            }
        }
        // Power-on: sources and state elements commit their initial
        // outputs at T=0 (in comp order, §4.3).
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
        // Boot settle (module docs): run the power-on queue to quiescence
        // WITHOUT clock edges. A halt here (e.g. an enabled RAM port
        // reading a floating address, or an oscillating ring tripping the
        // storm cap) becomes the sticky halt the first `run` reports. A
        // breakpoint can never be the halt here: it does not fire in_boot.
        if let Err(h) = eng.boot() {
            eng.halted = Some(h);
        }
        // Time restarts at 0; cycle accounting begins.
        eng.in_boot = false;
        eng.now = 0;
        eng.next_boundary = 2 * clock_half_period;
        eng.events_this_cycle = 0;
        eng.clk_track
            .iter_mut()
            .for_each(|t| *t = ClockTrack::default());
        if eng.halted.is_none() {
            eng.schedule(2 * clock_half_period, EvKind::Clock { phase: true });
        }
        Ok(eng)
    }

    /// The boot settle: apply every queued event (no clock events exist
    /// yet) until the queue is empty. `apply` caps runaway rings with the
    /// storm limit (`Oscillation`).
    fn boot(&mut self) -> Result<(), Halt> {
        while let Some(ev) = self.queue.pop() {
            self.apply(ev)?;
        }
        Ok(())
    }

    /// The flattened design under simulation.
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

    /// Max observed per-cycle settle time so far (§4.4).
    pub fn t_obs(&self) -> u64 {
        self.t_obs
    }

    /// Setup/hold warnings recorded so far.
    pub fn violations(&self) -> &[TimingViolation] {
        &self.violations
    }

    /// The sticky halt, if the engine has halted — including a
    /// boot-settle halt at construction (the session surfaces it).
    pub fn halted(&self) -> Option<&Halt> {
        self.halted.as_ref()
    }

    /// FNV-1a hash over every applied event so far (§4.6).
    pub fn trace_hash(&self) -> u64 {
        self.trace_hash
    }

    // -- Snapshot/restore (§8.1) ------------------------------------------

    /// Full engine state as deterministic JSON (savestate; §8.1). The
    /// queue is serialized in (time, seq) order; restoring into an engine
    /// built from the same circuit + table continues bit-identically
    /// (§4.6 — see the test). Snapshot version 2 (F14): per-sink views.
    pub fn snapshot(&self) -> String {
        let mut queue: Vec<&Ev> = self.queue.iter().collect();
        queue.sort_by_key(|e| (e.time, e.seq));
        let snap = DelaySnap {
            version: 2,
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
            views: self
                .views
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
            net_ever_driven: self.net_ever_driven.clone(),
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
        if snap.version != 2 {
            return Err(format!("unsupported snapshot version {}", snap.version));
        }
        if snap.half_period != self.half_period {
            return Err("snapshot clock half-period does not match".to_string());
        }
        let n_comps = self.comps.len();
        let n_nets = self.netlist.nets.len();
        let shape_ok = snap.comps.len() == n_comps
            && snap.drives.len() == n_comps
            && snap.views.len() == n_comps
            && snap.pending_gen.len() == n_comps
            && snap.pending_val.len() == n_comps
            && snap.pending_cause.len() == n_comps
            && snap.clk_track.len() == n_comps
            && snap.net_values.len() == n_nets
            && snap.net_scheduled.len() == n_nets
            && snap.net_cause.len() == n_nets
            && snap.net_ever_driven.len() == n_nets;
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
        for (ci, slots) in snap.views.iter().enumerate() {
            let fc = &self.netlist.comps[ci];
            if slots.len() != fc.pins.len() {
                return Err("snapshot view slots do not match".to_string());
            }
            for (slot, wv) in slots.iter().enumerate() {
                self.views[ci][slot] = values(wv, fc.pins[slot].width)?;
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
        self.net_ever_driven = snap.net_ever_driven;
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
                    "deliver" => self
                        .netlist
                        .comps
                        .get(se.comp as usize)
                        .and_then(|c| c.pins.get(se.slot as usize))
                        .map(|p| p.width)
                        .ok_or_else(|| format!("deliver event for unknown pin {}", se.comp)),
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

    /// True when `net`'s drivers genuinely disagree — two enabled drivers
    /// fighting, i.e. a short circuit — rather than the net merely carrying an
    /// `X` that flowed in (DESIGN.md §4.1; contract v1.2). Single-driver and
    /// undriven nets are never shorted.
    pub fn net_contended(&self, net: NetId) -> bool {
        let drivers = &self.net_drivers[net.idx()];
        if drivers.len() < 2 {
            return false;
        }
        let n = &self.netlist.nets[net.idx()];
        let vals: Vec<Value> = drivers
            .iter()
            .map(|&(c, s)| self.drives[c as usize][s].clone())
            .collect();
        Value::contention_merge_detail(n.width, &vals).1
    }

    /// Value of a named probe (its input pin's view) or register (stored
    /// state).
    pub fn named_value(&self, name: &str) -> Option<Value> {
        let named = self.netlist.named.iter().find(|n| n.name == name)?;
        let ci = self.netlist.named_engine_id(name)?.idx();
        match named.kind {
            NamedKind::Register => self.comps[ci].register_value().cloned(),
            NamedKind::Probe => {
                let (slot, _) = self.netlist.comps[ci]
                    .pins
                    .iter()
                    .enumerate()
                    .find(|(_, p)| p.dir == crate::components::PinDir::In)?;
                Some(self.views[ci][slot].clone())
            }
            NamedKind::Ram | NamedKind::Rom => None,
        }
    }

    /// Read a word from a named memory (autograder `mem_read`, task B9).
    pub fn memory_word(&self, name: &str, addr: u64) -> Option<Value> {
        let named = self.netlist.named.iter().find(|n| n.name == name)?;
        match named.kind {
            NamedKind::Ram | NamedKind::Rom => {
                self.comps[self.netlist.named_engine_id(name)?.idx()].memory_word(addr as usize)
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
        let Some(ci) = self.netlist.named_engine_id(name) else {
            return false;
        };
        self.comps[ci.idx()].set_memory_word(addr as usize, v);
        true
    }

    /// Bulk-load a named memory's image (autoload/`--load`, task B9).
    /// `Ok(false)` = no such named memory; `Err` = image error (F1 —
    /// e.g. a word wider than the memory's bitsize; never panics).
    /// The asynchronous read is re-evaluated so `dout` commits from the
    /// new image after the access time (a load applied after the boot
    /// settle must not leave a stale `dout`).
    pub fn load_memory_image(&mut self, name: &str, image: &[u64]) -> Result<bool, String> {
        let Some(named) = self.netlist.named.iter().find(|n| n.name == name) else {
            return Ok(false);
        };
        match named.kind {
            NamedKind::Ram | NamedKind::Rom => {
                let ci = self
                    .netlist
                    .named_engine_id(name)
                    .expect("named_flat is parallel to named");
                self.comps[ci.idx()].load_words(image)?;
                let now = self.now;
                // Refresh the read output — a preload is a WRITE to the memory,
                // so a floating *address* here must not fail it: this runs before
                // the boot settle (and before any cycle), where every view is
                // still `Z`, and a memory whose address is a register would
                // otherwise refuse to load at all. The value settles on the
                // ordinary path as soon as the address arrives; a real halt is
                // reported then, with the same detail.
                if let Err(h) = self.eval_and_schedule(ci.0, now, None) {
                    if !matches!(h.reason, HaltReason::FloatingRead) {
                        return Err(h.details);
                    }
                }
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    /// Drive a root input pin at the current time.
    pub fn poke_input_pin(&mut self, name: &str, v: Value) -> bool {
        self.poke_at(name, v, self.now)
    }

    /// Press/release a named root button (interactive poking); the new
    /// drive commits through the normal event path.
    pub fn poke_button(&mut self, name: &str, pressed: bool) -> bool {
        let Some(fc) = self
            .netlist
            .comps
            .iter()
            .find(|c| c.type_ == "io.button" && c.name.as_deref() == Some(name))
        else {
            return false;
        };
        let id = fc.id.0;
        self.comps[id as usize].set_pressed(pressed);
        // A button has no inputs, so its evaluation cannot halt.
        let _ = self.eval_and_schedule(id, self.now, None);
        true
    }

    /// Press/release a button by flat id (works for unnamed buttons too).
    pub fn poke_button_at(&mut self, id: usize, pressed: bool) -> bool {
        let Some(c) = self.comps.get_mut(id) else {
            return false;
        };
        c.set_pressed(pressed);
        let _ = self.eval_and_schedule(id as u32, self.now, None);
        true
    }

    /// Set a register's stored value by flat id (live poke, UI decision); the
    /// register then re-evaluates, driving its new value onto `q`.
    pub fn poke_register_at(&mut self, id: usize, v: Value) -> bool {
        let Some(c) = self.comps.get_mut(id) else {
            return false;
        };
        if !c.set_register(v) {
            return false;
        }
        // A register's evaluation cannot halt (it just reads its state).
        let _ = self.eval_and_schedule(id as u32, self.now, None);
        true
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
    /// The in-progress final cycle is *closed out* at run end (F7): its
    /// settle time counts toward `t_obs` and the cycle-close
    /// floating-read sweep runs.
    pub fn run(&mut self, cycles: u64) -> Result<RunReport, Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        match self.run_inner(cycles).and_then(|mut rep| {
            // Fold the final in-progress cycle (module docs, F7). The
            // boundary itself is NOT advanced — the pending clock edge
            // closes the (now empty) cycle on the next run.
            self.floating_sweep()?;
            self.record_cycle();
            // The report must reflect the fold (the final cycle's settle
            // counts toward T_obs, F7).
            rep.t_obs = self.t_obs;
            rep.top_paths = self.top_paths.clone();
            rep.violations = self.violations.clone();
            rep.trace_hash = self.trace_hash;
            rep.events_processed = self.events_processed;
            Ok(rep)
        }) {
            Ok(rep) => Ok(rep),
            Err(h) => {
                self.record_halt(&h);
                Err(h)
            }
        }
    }

    /// Advance one half-period (one clock edge — the contract v1.1
    /// `step_tick` in delay mode): apply events up to and including the
    /// next global clock event.
    pub fn step_tick(&mut self) -> Result<(), Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        while let Some(ev) = self.queue.pop() {
            let is_clock = matches!(ev.kind, EvKind::Clock { .. });
            self.apply(ev).inspect_err(|h| self.record_halt(h))?;
            if is_clock {
                return Ok(());
            }
        }
        Ok(())
    }

    /// Settle everything queued BEFORE the next clock edge — i.e. let an
    /// interactive poke (a forced register/button value) propagate through the
    /// circuit within the CURRENT cycle, without firing a clock edge. Stops at
    /// the first queued `Clock` event, so no half-cycle is consumed.
    pub fn settle_cycle(&mut self) -> Result<(), Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        while let Some(ev) = self.queue.peek() {
            if matches!(ev.kind, EvKind::Clock { .. }) {
                break;
            }
            let ev = self.queue.pop().expect("peeked");
            self.apply(ev).inspect_err(|h| self.record_halt(h))?;
        }
        Ok(())
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
            self.apply(ev).inspect_err(|h| self.record_halt(h))?;
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
            // Each input pin reads its own *view* of its net (per-path
            // transport, F14).
            let ins: Vec<Value> = cd
                .in_pins
                .iter()
                .map(|(slot, _)| self.views[c][*slot].clone())
                .collect();
            // Combinational parts wait until every input has *arrived*
            // (module docs, §4.1). A `Z` view on a DRIVERLESS net can
            // never arrive — it is passed through so the behavior's
            // consume table decides (a mux's unselected input is not
            // consumed; a gate input is and halts). `Z` on a driven net
            // means "still in flight or idle": wait (the output holds).
            //
            // A memory's ASYNCHRONOUS READ path waits the same way, on its
            // `addr` only (`din`/`we`/`clk` are edge inputs and must not stall
            // a read): a RAM/ROM whose address is still in flight holds its
            // output instead of judging a half-arrived `Z`. Without this, a
            // converted design halted at power-on on an address that was merely
            // in transit through a splitter — a `Z` on a *driven* net, which
            // the cycle-close sweep exists to tell apart from a real floating
            // read (`floating_sweep`, the never-driven oracle).
            if matches!(cd.class, Class::Comb | Class::Ram | Class::Rom) {
                let waiting = cd.in_pins.iter().enumerate().any(|(i, &(slot, net))| {
                    let read_now = match cd.class {
                        Class::Comb => true,
                        _ => self.netlist.comps[c].pins[slot].pin == "addr",
                    };
                    read_now && ins[i].has_z() && !self.netlist.nets[net.idx()].floating
                });
                if waiting {
                    return Ok(());
                }
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
            // Contract v1.1 details format: root-sheet document-order id.
            details: format!(
                "comp {} pin \"{}\": floating (Z) value consumed",
                self.netlist.root_sheet_comp(CompId(comp)),
                fr.pin
            ),
        }
    }

    /// The pause a breakpoint asks for: same contract shape as
    /// [`DelayEngine::halt_floating`], but a **soft** halt — see
    /// [`DelayEngine::record_halt`] for why it does not stick.
    fn halt_breakpoint(&self, comp: u32) -> Halt {
        let value = self.comps[comp as usize]
            .breakpoint_value()
            .cloned()
            .unwrap_or_else(|| Value::zero(1));
        Halt {
            reason: HaltReason::Breakpoint,
            cycle: self.rising_seen,
            // Contract v1.2 details format: root-sheet document-order id,
            // then the pin the halt is attributed to — so the UI highlights
            // the breakpoint that fired like any other attributable halt.
            details: format!(
                "comp {} pin \"in\": watched value {value} arrived",
                self.netlist.root_sheet_comp(CompId(comp)),
            ),
        }
    }

    /// Make a halt the engine's state. Every reason but `Breakpoint` is
    /// **sticky**: the design is broken (or out of budget), so the engine
    /// refuses to run again until a load/reset. A **breakpoint** is not a
    /// fault at all — it is the pause the user asked for — so it is reported
    /// and then forgotten, and the very next `run`/`step_*` continues from
    /// exactly here (contract v1.2, `docs/ipc.md` §3). That is also why it
    /// can live mid-settle: the rest of the cycle is still queued.
    fn record_halt(&mut self, h: &Halt) {
        if h.reason == HaltReason::Breakpoint {
            return;
        }
        self.halted = Some(h.clone());
    }

    /// Apply one event (the queue's minimum).
    fn apply(&mut self, ev: Ev) -> Result<(), Halt> {
        self.now = ev.time;
        // Cycle close at apply time (events are processed in time order):
        // closing on peek would be premature when the run loop stops
        // *before* a boundary-edge it only looked at. No cycle accounting
        // during the boot settle.
        while !self.in_boot && self.now >= self.next_boundary {
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
                    // Implicit clocks: the same edge, for the parts that do not
                    // wire one (UI_OVERHAUL §93). `rising_seen` is bumped first,
                    // so a halt or violation here reports the cycle that the
                    // wired parts would report too.
                    for i in 0..self.implicit_clk.len() {
                        let c = self.implicit_clk[i];
                        self.clock_edge(c, ev.time)?;
                    }
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
                        // The shared "latest" slot applies at the earliest
                        // sink's arrival; each sink pin's *view* is
                        // delivered at its own path delay (F14).
                        let nidx = net as usize;
                        let at = ev.time + self.net_min_delay[nidx];
                        self.schedule(
                            at,
                            EvKind::Net {
                                net,
                                value: resolved.clone(),
                            },
                        );
                        // Causal pointer lands at apply time (below).
                        self.pending_net_cause.push((net, cause));
                        let deliveries: Vec<(u64, EvKind)> = self.net_sinks[nidx]
                            .iter()
                            .enumerate()
                            .map(|(i, sp)| {
                                (
                                    ev.time + self.net_sink_delay[nidx][i],
                                    EvKind::Deliver {
                                        net,
                                        comp: sp.comp,
                                        slot: sp.slot,
                                        kind: sp.kind,
                                        value: resolved.clone(),
                                    },
                                )
                            })
                            .collect();
                        for (t, kind) in deliveries {
                            self.schedule(t, kind);
                        }
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
                if !value.is_fully_z() {
                    self.net_ever_driven[n] = true;
                }
                self.net_values[n] = value;
            }
            EvKind::Deliver {
                net,
                comp,
                slot,
                kind,
                value,
            } => {
                // Per-sink transport arrival: update the pin's view, then
                // notify the sink (F14). DTA settle and setup/hold
                // tracking happen at the pin's own arrival time.
                self.views[comp as usize][slot as usize] = value;
                if !self.in_boot && self.state_input_net[net as usize] {
                    let cycle_start = self.next_boundary - 2 * self.half_period;
                    let dt = ev.time - cycle_start;
                    if dt > self.cycle_settle {
                        self.cycle_settle = dt;
                        self.cycle_settle_net = Some(net);
                    }
                }
                self.react(comp, net, slot as usize, kind, ev.time)?;
            }
            EvKind::Poke { comp, value } => {
                self.comps[comp as usize].set_pin_value(value);
                self.eval_and_schedule(comp, ev.time, None)?;
            }
        }
        Ok(())
    }

    /// A value arrived at one sink pin: notify the sink component. `slot` is
    /// the pin's slot within the component (the breakpoint needs to know
    /// *which* pin moved; the others match on `pin` alone).
    fn react(
        &mut self,
        comp: u32,
        net: u32,
        slot: usize,
        pin: SinkKind,
        time: u64,
    ) -> Result<(), Halt> {
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
                SinkKind::We => self.track_hold(c, TrackField::We, time),
                SinkKind::Clk => {
                    let cur = self.views[c]
                        .iter()
                        .zip(&self.netlist.comps[c].pins)
                        .find(|(_, p)| p.pin == "clk")
                        .map(|(v, _)| v.bit(0))
                        .unwrap_or(Bit::Z);
                    if cur == Bit::One {
                        self.clock_edge(comp, time)?;
                    }
                }
                _ => {}
            },
            Class::Register => match pin {
                SinkKind::D => self.track_hold(c, TrackField::D, time),
                SinkKind::Clk => {
                    let cur = self.views[c]
                        .iter()
                        .zip(&self.netlist.comps[c].pins)
                        .find(|(_, p)| p.pin == "clk")
                        .map(|(v, _)| v.bit(0))
                        .unwrap_or(Bit::Z);
                    if cur == Bit::One {
                        self.clock_edge(comp, time)?;
                    }
                }
                _ => {}
            },
            Class::Source => {}
            Class::Sink => {
                // A breakpoint fires on the arrival of its **data** value:
                // this delivery *is* the change CircuitSim CE's
                // `Breakpoint.valueChanged` reacts to, and the enable is
                // sampled at that same instant, exactly as CE reads it. CE's
                // enable rule is kept to the letter — anything but a driven
                // 0 enables, so an **unconnected** `en` still watches and an
                // `X` is conservative.
                //
                // The power-on settle (`in_boot`) is not part of the run, so
                // it never fires: every net comes up somewhere, and stopping
                // at cycle 0 because a signal *is* its breakpoint value (and
                // not because it *became* it) is noise, not a breakpoint.
                if !self.in_boot {
                    if let Some(target) = self.comps[c].breakpoint_value() {
                        // Pin order is the registry's: `in`, then `en`
                        // (components.rs). The delivery updated `views` before
                        // calling us, so the data pin already holds the new
                        // value and the enable reads as of this instant.
                        let (data_slot, _) = self.cdata[c].in_pins[0];
                        let (en_slot, _) = self.cdata[c].in_pins[1];
                        let enabled = self.views[c][en_slot].bit(0) != Bit::Zero;
                        if slot == data_slot && enabled && &self.views[c][data_slot] == target {
                            return Err(self.halt_breakpoint(comp));
                        }
                    }
                }
            }
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
            TrackField::We => tr.last_we = Some(time),
        }
    }

    /// Rising clock edge on a register/RAM: setup check (data inputs
    /// include `we` for RAM, F11), latch/write (consuming `Z` halts),
    /// schedule the output commit.
    fn clock_edge(&mut self, comp: u32, time: u64) -> Result<(), Halt> {
        let c = comp as usize;
        let setup = self.cdata[c].timing.setup;
        let tr = self.clk_track[c];
        let last_data = match self.cdata[c].class {
            Class::Ram => tr.last_din.max(tr.last_addr).max(tr.last_we),
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
        // Sample inputs from the pins' *views* and latch (consume rules
        // fire here).
        let ins: Vec<Value> = self.cdata[c]
            .in_pins
            .iter()
            .map(|(slot, _)| self.views[c][*slot].clone())
            .collect();
        let ins_refs: Vec<&Value> = ins.iter().collect();
        self.comps[c]
            .rising_edge(&ins_refs)
            .map_err(|fr| self.halt_floating(comp, fr))?;
        // Q / dout commit after clk→Q / access (gen-guarded: last edge wins).
        self.eval_and_schedule(comp, time, None)?;
        Ok(())
    }

    /// Close the current cycle at a clock boundary: per-consumer
    /// floating sweep, then record DTA results and advance the boundary.
    fn close_cycle(&mut self) -> Result<(), Halt> {
        self.floating_sweep()?;
        self.record_cycle();
        self.next_boundary += 2 * self.half_period;
        Ok(())
    }

    /// Fold the current cycle's settle measurements into `t_obs` /
    /// `top_paths` and reset the per-cycle counters (without advancing
    /// the boundary — also called at run end for the final in-progress
    /// cycle, F7).
    fn record_cycle(&mut self) {
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
    }

    /// Per-consumer floating-read sweep (contract v1.1, F6 — module
    /// docs). A halt requires BOTH: a pin that consumes (per the behavior
    /// consume table, evaluated with current values — muxes consume only
    /// the selected input, disabled buffers nothing, etc.) still seeing a
    /// fully-`Z` view, AND that pin's net never having carried a non-`Z`
    /// value this run. Driven-then-idle nets (tri-state buses) and
    /// in-flight arrivals (overclocked designs) are immune.
    fn floating_sweep(&mut self) -> Result<(), Halt> {
        for c in 0..self.comps.len() {
            let cd = &self.cdata[c];
            if !matches!(cd.class, Class::Comb | Class::Ram | Class::Rom) {
                continue;
            }
            let beh = &self.comps[c];
            if beh.is_splitter() {
                continue; // splitters consume nothing
            }
            // Substitute immune floating views with a driven 0 so the
            // behavior's own consume rule (the oracle) only ever fires on
            // genuinely never-driven nets. "Immune" is the SAME test the eager
            // path uses (`eval_and_schedule`): a `Z` on a net that a driver pin
            // sits on is "still in flight or idle" — a deep combinational path
            // takes several cycles to settle, so at the first cycle close its
            // far end is legitimately `Z`, and halting there stopped every
            // converted LC-5200 at power-on. Only a net with no driver pin at
            // all — an unconnected input — is a real floating read.
            let mut ins: Vec<Value> = cd
                .in_pins
                .iter()
                .map(|(slot, _)| self.views[c][*slot].clone())
                .collect();
            let mut candidate = false;
            for (v, &(_, net)) in ins.iter_mut().zip(cd.in_pins.iter()) {
                if v.has_z() {
                    if self.net_ever_driven[net.idx()] || !self.netlist.nets[net.idx()].floating {
                        *v = Value::zero(v.width());
                    } else {
                        candidate = true;
                    }
                }
            }
            if !candidate {
                continue;
            }
            let ins_refs: Vec<&Value> = ins.iter().collect();
            if let Err(fr) = beh.eval(&ins_refs) {
                return Err(self.halt_floating(c as u32, fr));
            }
        }
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
            EvKind::Deliver {
                net,
                comp,
                slot,
                value,
                ..
            } => {
                mix(&[4]);
                mix(&net.to_le_bytes());
                mix(&comp.to_le_bytes());
                mix(&slot.to_le_bytes());
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
    We,
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

    pub(super) const SETTINGS: &str = r#""settings":{"clockHz":1,"delayTable":"cs2200-74ls-v1"}"#;

    /// Two-stage pipeline: r1.q → not → and → r2.d; r1 toggles
    /// (r1.d ← not(r1.q)). Table delays: clk→Q 20, not 9, and 10 →
    /// after a toggle, r2.d settles at 20+9+10 = 39.
    pub(super) fn pipeline_json() -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"d","type":"wiring.pin","pos":[0,0],"name":"d"}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
        // event storm (a gate feeding its own input has no stable state).
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"g","type":"gate.nand","pos":[0,0]}}
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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

    /// F11: the RAM write-enable is tracked like din/addr — a `we`
    /// change inside the setup window is a warning (the write still
    /// happens, deterministically).
    #[test]
    fn ram_we_setup_violation_is_tracked() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":2}}}},
                {{"id":"zd","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8}}}},
                {{"id":"we","type":"wiring.pin","pos":[0,0],"name":"we"}},
                {{"id":"m","type":"mem.ram","pos":[0,0],"name":"m","attrs":{{"bitsize":8,"depth":4}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"m","pin":"clk"}}}},
                {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"m","pin":"addr"}}}},
                {{"a":{{"comp":"zd","pin":"out"}},"b":{{"comp":"m","pin":"din"}}}},
                {{"a":{{"comp":"we","pin":"pin"}},"b":{{"comp":"m","pin":"we"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        // Edge at 1000 (clk wire 0). we rises at 990 — inside setup 15.
        assert!(eng.poke_at("we", k(1, 1), 990));
        let rep = eng.run(1).unwrap();
        assert_eq!(rep.violations.len(), 1, "we setup violation tracked");
        assert_eq!(rep.violations[0].kind, ViolationKind::Setup);
        assert_eq!(
            eng.memory_word("m", 0),
            Some(k(8, 0)),
            "write still happened"
        );
    }

    /// F6 (S1): a propagation path longer than the clock period must NOT
    /// halt as floating-read — the boot settle quiesces first; the run
    /// completes with setup/hold warnings and deterministic latching.
    #[test]
    fn overclocked_chain_completes_with_setup_violation() {
        let mut comps = String::new();
        let mut wires = String::new();
        comps.push_str(
            r#"{"id":"clk","type":"wiring.clock","pos":[0,0]},
            {"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{"value":"1"}},
            {"id":"zero","type":"wiring.constant","pos":[0,0]},
            {"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"},
            {"id":"r2","type":"mem.register","pos":[300,0],"name":"r2"},"#,
        );
        wires.push_str(
            r#"{"a":{"comp":"clk","pin":"out"},"b":{"comp":"r2","pin":"clk"}},
            {"a":{"comp":"one","pin":"out"},"b":{"comp":"r2","pin":"en"}},"#,
        );
        let mut prev = ("src".to_string(), "pin".to_string());
        for i in 0..250 {
            comps.push_str(&format!(
                r#"{{"id":"g{i}","type":"gate.not","pos":[{},2]}},"#,
                i
            ));
            wires.push_str(&format!(
                r#"{{"a":{{"comp":"{}","pin":"{}"}},"b":{{"comp":"g{i}","pin":"in"}}}},"#,
                prev.0, prev.1
            ));
            prev = (format!("g{i}"), "out".to_string());
        }
        wires.push_str(&format!(
            r#"{{"a":{{"comp":"{}","pin":"{}"}},"b":{{"comp":"r2","pin":"d"}}}}"#,
            prev.0, prev.1
        ));
        let json = format!(
            r##"{{"format":"circuitsim-plus-plus","version":2,"name":"t",{SETTINGS},
            "circuits":[{{"name":"main","components":[{}],"wires":[{}]}}]}}"##,
            comps.trim_end_matches(','),
            wires
        );
        // 250 inverters ≈ 2250 ns; period 1000 ns < the path. Before F6
        // this died at cycle close with a spurious FloatingRead.
        let mut eng = engine(&json, 500);
        assert!(eng.halted().is_none(), "boot halt: {:?}", eng.halted());
        // src rises at T=770; r2.d changes ~2255 ns later (3025), inside
        // the setup window (15 ns) of r2's clock edge — the 300-unit clk
        // wire delays the edge to 3000+30=3030 → warning, not a halt.
        assert!(eng.poke_at("src", k(1, 1), 770));
        let rep = eng.run(3).expect("overclocked run must complete");
        assert_eq!(rep.cycles, 3);
        assert_eq!(rep.violations.len(), 1, "exactly one setup violation");
        assert_eq!(rep.violations[0].kind, ViolationKind::Setup);
        // The final-cycle fold (F7) counts the last cycle's settle:
        // d changed at 3025, cycle 3 starts at 3000 → dt 25.
        assert_eq!(rep.t_obs, 25, "final in-progress cycle is folded");
    }

    /// F6 (S3): a floating value on a mux's UNSELECTED input is not
    /// consumed — no halt; the output is still computed (driverless-net
    /// views do not block evaluation).
    #[test]
    fn mux_floating_unselected_input_does_not_halt() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"c","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"z","type":"wiring.constant","pos":[0,0]}},
                {{"id":"m","type":"plexers.mux","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}}
            ], "wires": [
                {{"a":{{"comp":"c","pin":"out"}},"b":{{"comp":"m","pin":"in0"}}}},
                {{"a":{{"comp":"z","pin":"out"}},"b":{{"comp":"m","pin":"sel"}}}},
                {{"a":{{"comp":"m","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        // in1 is unwired (driverless); sel=0 selects in0.
        let mut eng = engine(&json, 500);
        eng.run(2)
            .expect("mux with floating UNSELECTED input must not halt");
        assert_eq!(eng.named_value("out"), Some(k(1, 1)));
    }

    /// F14: a stub branch off a net must not inflate another sink's
    /// arrival — per-path wire delays.
    #[test]
    fn stub_branch_does_not_inflate_sink_arrival() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"p","type":"wiring.probe","pos":[20,0],"name":"d"}},
                {{"id":"q","type":"wiring.probe","pos":[20,10000],"name":"stub"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"p","pin":"in"}},
                 "points":[[0,0],[200,0]]}},
                {{"a":{{"comp":"q","pin":"in"}},"b":{{"join":{{"wire":0,"segment":0}}}},
                 "points":[[200,10000],[100,0]]}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 5000);
        assert!(eng.poke_at("src", k(1, 1), 100));
        eng.run_until_time(120).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 0)));
        eng.run_until_time(121).unwrap();
        // path src→p = 200 units → 20 ns; the ~10100-unit stub branch is
        // irrelevant to p's arrival (the old net-lumped model added it).
        assert_eq!(
            eng.named_value("d"),
            Some(k(1, 1)),
            "stub must not inflate the sink's arrival"
        );
    }
    /// A text annotation has no pins and no behavior — but every flattened
    /// component still needs a behavior built for it. Returning `None` here
    /// failed the WHOLE document ("component 'main: c22' has no behavior
    /// (type 'misc.text')"), so a label made a circuit unloadable.
    #[test]
    fn a_text_annotation_loads_and_is_inert() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"note","type":"misc.text","pos":[0,0],"attrs":{{"text":"hello"}}}}
            ], "wires": []}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        assert_eq!(eng.cycle(), 0);
        // It drives nothing, so a run just ticks the clock.
        eng.run(2).unwrap();
        assert_eq!(eng.cycle(), 2);
    }

    /// A register's stored state must not depend on `q` being wired: the readout
    /// falls back to `named_value` when `q` is open, so the latch must still
    /// happen. (Bug report: "register non-update when the output is
    /// disconnected".)
    #[test]
    fn unwired_q_does_not_stop_a_register_latching() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        assert_eq!(eng.named_value("r"), Some(k(1, 0)), "powers on at 0");
        // One full cycle latches d=1 even though nothing observes `q`.
        eng.run(1).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(1, 1)), "latched with q open");

        // The UI reads a named register through `value_net`, which exists even
        // with `q` open — every pin gets a net (contract v1.2).
        let net = eng
            .netlist()
            .named
            .iter()
            .find(|n| n.name == "r")
            .expect("named r")
            .value_net
            .expect("value_net present");
        assert_eq!(eng.net_value(net), k(1, 1));
    }
    /// UI_OVERHAUL §93: the clock pin is optional. A register that never wires
    /// one is clocked by the *circuit's* clock — the same global rising edge the
    /// clock component rides — so a schematic drawn with the pin hidden still
    /// ticks exactly once per cycle (a toggling counter proves "once", not
    /// "whenever anything moves").
    #[test]
    fn an_unwired_clock_pin_follows_the_circuit_clock() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 5, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}},
                {{"id":"n","type":"gate.not","pos":[0,0]}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"n","pin":"in"}}}},
                {{"a":{{"comp":"n","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        assert_eq!(eng.named_value("r"), Some(k(1, 0)), "powers on at 0");
        eng.run(1).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(1, 1)), "one cycle, one latch");
        eng.run(1).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(1, 0)), "not two, and not zero");
        eng.run(1).unwrap();
        assert_eq!(eng.named_value("r"), Some(k(1, 1)), "still one per cycle");
    }

    /// …and a *wired* reset is a real input. Asserted over a simultaneous
    /// enable it wins (synchronous, like CircuitSim CE's Clear), which is what
    /// the old format's reset wiring expects from a converted schematic.
    #[test]
    fn a_wired_reset_wins_over_the_enable() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 5, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"rst","type":"wiring.pin","pos":[0,0],"name":"rst"}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}},
                {{"a":{{"comp":"rst","pin":"pin"}},"b":{{"comp":"r","pin":"rst"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        // The register's clock is unwired, so it ticks with the circuit clock.
        eng.run(1).unwrap();
        assert_eq!(
            eng.named_value("r"),
            Some(k(1, 1)),
            "latches while rst is low"
        );
        assert!(eng.poke_input_pin("rst", k(1, 1)), "the reset pin is wired");
        eng.run(1).unwrap();
        assert_eq!(
            eng.named_value("r"),
            Some(k(1, 0)),
            "asserted reset clears it"
        );
        assert!(eng.poke_input_pin("rst", k(1, 0)));
        eng.run(1).unwrap();
        assert_eq!(
            eng.named_value("r"),
            Some(k(1, 1)),
            "released, it latches again"
        );
    }

    /// A RAM's reset clears every word (its stored state, not just the read
    /// path) — and an unwired clock on a memory works the same way.
    #[test]
    fn a_wired_reset_clears_the_ram() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 5, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"addr","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"0","bitsize":4}}}},
                {{"id":"data","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"5","bitsize":8}}}},
                {{"id":"rst","type":"wiring.pin","pos":[0,0],"name":"rst"}},
                {{"id":"m","type":"mem.ram","pos":[0,0],"attrs":{{"bitsize":8,"depth":16}}}},
                {{"id":"out","type":"wiring.probe","pos":[0,0],"name":"out","attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"m","pin":"we"}}}},
                {{"a":{{"comp":"addr","pin":"out"}},"b":{{"comp":"m","pin":"addr"}}}},
                {{"a":{{"comp":"data","pin":"out"}},"b":{{"comp":"m","pin":"din"}}}},
                {{"a":{{"comp":"rst","pin":"pin"}},"b":{{"comp":"m","pin":"rst"}}}},
                {{"a":{{"comp":"m","pin":"dout"}},"b":{{"comp":"out","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(1).unwrap();
        assert_eq!(
            eng.named_value("out"),
            Some(k(8, 5)),
            "the word was written"
        );
        assert!(eng.poke_input_pin("rst", k(1, 1)));
        eng.run(1).unwrap();
        assert_eq!(
            eng.named_value("out"),
            Some(k(8, 0)),
            "…and the reset cleared it"
        );
    }

    /// A memory's ASYNCHRONOUS READ waits for its `addr` the same way a
    /// combinational part waits for its inputs. A `Z` on a *driven* net is a
    /// value still in transit — at power-on a splitter publishes `Z` onto its
    /// sides before its bus has arrived — and a RAM/ROM that judged it then
    /// halted a perfectly good design at cycle 0 (a converted LC-5200 did).
    /// Only a net with no driver pin at all is a floating read.
    #[test]
    fn a_memory_read_waits_for_an_address_in_flight() {
        // The ROM's `addr` is a splitter's split: the splitter drives it, so the
        // net has a driver pin and is never "floating" — but the splitter's
        // first publication is `Z`, before the constant on its bus arrives.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 5, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"5","bitsize":4}}}},
                {{"id":"sp","type":"wiring.splitter","pos":[0,0],
                  "attrs":{{"splits":{{"out0":[0,1,2,3]}}}}}},
                {{"id":"rom","type":"mem.rom","pos":[0,0],"name":"rom",
                  "attrs":{{"bitsize":4,"depth":16,"addrBits":4,
                            "contents":"7 8 9 a b c d e f 1 2 3 4 5 6 0"}}}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"sp","pin":"bus"}}}},
                {{"a":{{"comp":"sp","pin":"out0"}},"b":{{"comp":"rom","pin":"addr"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(1).unwrap(); // must not halt
        let net = eng
            .netlist()
            .named
            .iter()
            .find(|n| n.name == "rom")
            .expect("named rom")
            .value_net
            .expect("value_net present");
        assert_eq!(eng.net_value(net), k(4, 12), "reads word 5 = 0xc");
    }

    /// A preload is a WRITE: `csim run --load mem=prog.hex` (and a memory's
    /// `autoload`) must not fail because the read path has not settled yet — at
    /// load time every view is still `Z`, so this used to report "grader
    /// configuration: mem: comp N pin \"addr\": floating". The read output
    /// refreshes on the ordinary path once the address arrives.
    #[test]
    fn a_preload_does_not_fail_on_an_unsettled_address() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 5, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"m","type":"mem.ram","pos":[0,0],"name":"mem",
                  "attrs":{{"bitsize":8,"depth":16}}}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out","attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"m","pin":"dout"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        // The address is unwired (`Z`): the preload must succeed anyway. The
        // design still halts when it *runs* — an address nobody drives is a real
        // floating read — but loading a program into a memory is not a read.
        assert!(eng.load_memory_image("mem", &[7]).is_ok());
        assert!(
            eng.netlist().named.iter().any(|n| n.name == "mem"),
            "the named memory stays addressable"
        );
    }

    /// A driver fight resolves its net to `X` **and** is flagged as a short
    /// (`net_contended`), while an `X` that merely flows into another part is
    /// not — so the UI can say "short circuit" only when there is one
    /// (DESIGN.md §4.1; contract v1.2).
    #[test]
    fn net_contended_distinguishes_a_short_from_a_flowed_in_x() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"b1","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"b2","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"b3","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"bus","type":"wiring.probe","pos":[0,0],"name":"bus"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b1","pin":"in"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b1","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"b2","pin":"in"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b2","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"b3","pin":"en"}}}},
                {{"a":{{"comp":"b1","pin":"out"}},"b":{{"comp":"bus","pin":"in"}}}},
                {{"a":{{"comp":"b2","pin":"out"}},"b":{{"comp":"bus","pin":"in"}}}},
                {{"a":{{"comp":"b1","pin":"out"}},"b":{{"comp":"b3","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let eng = engine(&json, 500);
        let count = eng.netlist().nets.len();

        let shorted = (0..count)
            .find(|&i| eng.netlist().nets[i].drivers.len() == 2)
            .expect("the shorted net has two drivers");
        let short = NetId(shorted as u32);
        assert!(eng.net_value(short).has_x(), "a driver fight resolves to X");
        assert!(eng.net_contended(short), "…and is flagged as a short");

        // b3 reads the shorted net, so its own output carries the X onward —
        // but nothing disagrees on THAT net, so it is not a short.
        let carried = (0..count)
            .filter(|&i| i != shorted)
            .find(|&i| eng.net_value(NetId(i as u32)).has_x())
            .expect("the X propagates downstream");
        assert_eq!(eng.netlist().nets[carried].drivers.len(), 1);
        assert!(
            !eng.net_contended(NetId(carried as u32)),
            "an X that flowed in is not a short"
        );
    }

    // ---- Breakpoint (UI_OVERHAUL §90, docs/format-v2.md §9)

    /// A toggling register watched by a breakpoint: `r` is `0` at power-on and
    /// flips at every rising edge (`d = ¬q`), so `q` *becomes* 1 in cycle 1 and
    /// *becomes* 0 in cycle 2. `en` is wired to the named constant or left
    /// unwired.
    fn breakpoint_register_json(watch: &str, en: Option<&str>) -> String {
        let en_wire = match en {
            Some(c) => {
                format!(r#",{{"a":{{"comp":"{c}","pin":"out"}},"b":{{"comp":"bp","pin":"en"}}}}"#)
            }
            None => String::new(),
        };
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}},
                {{"id":"inv","type":"gate.not","pos":[0,0]}},
                {{"id":"bp","type":"debug.breakpoint","pos":[0,0],"attrs":{{"value":"{watch}"}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"inv","pin":"in"}}}},
                {{"a":{{"comp":"inv","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}},
                {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"bp","pin":"in"}}}}{en_wire}
            ]}}]
        }}"##
        )
    }

    /// A breakpoint pauses the run at the cycle whose change matched it — and
    /// the pause is **soft**: the engine keeps its sticky-halt slot empty, so
    /// the very next run carries on (contract v1.2, `docs/ipc.md` §3). Every
    /// other halt is sticky because the design it reports is broken.
    #[test]
    fn breakpoint_pauses_the_run_without_poisoning_the_engine() {
        let mut eng = engine(&breakpoint_register_json("1", None), 500);
        let h = eng.run(3).expect_err("the breakpoint must stop the run");
        assert_eq!(h.reason, HaltReason::Breakpoint);
        assert_eq!(h.cycle, 1, "stopped within the cycle whose edge raised q");
        // The same contract shape as any attributable halt, so the UI can
        // highlight the part that fired (`api.rs` `sim_halted`).
        assert!(h.details.starts_with("comp "), "{}", h.details);
        assert!(h.details.contains("pin \"in\""), "{}", h.details);
        assert!(h.details.contains("0x1"), "{}", h.details);

        assert!(eng.halted().is_none(), "a breakpoint must not be sticky");

        // The next run continues — the rest of the interrupted cycle settles
        // too — and q falls at the following edge as usual.
        let rep = eng.run(1).expect("a breakpoint does not poison the engine");
        assert_eq!(rep.cycles, 1);
        assert_eq!(eng.named_value("r"), Some(k(1, 0)));

        // It is not a one-shot: coming back to the watched value fires again.
        let h2 = eng.run(1).expect_err("q rose again");
        assert_eq!(h2.cycle, 3);
    }

    /// The enable and the value comparison keep CircuitSim CE's rule to the
    /// letter (`Breakpoint.valueChanged`): the watch is armed when `en` is
    /// anything but a driven `0`, and it fires when the data value *equals*
    /// the watched value.
    #[test]
    fn breakpoint_enable_rule_is_circuit_sim_ce() {
        // en ← 0: disarmed, so the register passes through 1 twice quietly.
        let mut eng = engine(&breakpoint_register_json("1", Some("zero")), 500);
        eng.run(4).expect("a disarmed breakpoint never fires");
        assert!(eng.halted().is_none());

        // en ← 1: armed, and it fires.
        let mut eng = engine(&breakpoint_register_json("1", Some("one")), 500);
        assert_eq!(eng.run(4).unwrap_err().reason, HaltReason::Breakpoint);

        // Unwired `en` reads Z, and CE's rule ("anything but 0") calls that
        // armed — the plain "break on this signal" case needs no wiring.
        let mut eng = engine(&breakpoint_register_json("1", None), 500);
        assert_eq!(eng.run(4).unwrap_err().reason, HaltReason::Breakpoint);

        // Watching 0 on the same line stops on the *fall* (cycle 2), not on the
        // rise — the value has to arrive, and 0 was already there at power-on.
        let mut eng = engine(&breakpoint_register_json("0", None), 500);
        let h = eng.run(4).expect_err("q fell to the watched value");
        assert_eq!(h.cycle, 2);
    }

    /// A breakpoint is edge-like, not level-like: it fires on a value
    /// *arriving*, so holding the watched value is not a hit and leaving and
    /// returning is. That is what makes "step past the breakpoint" mean
    /// anything — CE stops the clock the moment the value arrives, so a value
    /// that has stopped moving never stops it again.
    #[test]
    fn breakpoint_fires_on_arrival_not_on_level() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"p","type":"wiring.pin","pos":[0,0],"name":"p"}},
                {{"id":"bp","type":"debug.breakpoint","pos":[0,0],"attrs":{{"value":"1"}}}}
            ], "wires": [
                {{"a":{{"comp":"p","pin":"pin"}},"b":{{"comp":"bp","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run_until_time(1500).expect("a quiet first cycle");

        // The poke is the change: the breakpoint fires as the value arrives.
        assert!(eng.poke_at("p", k(1, 1), 1500));
        let h = eng.run_until_time(2000).expect_err("the value arrived");
        assert_eq!(h.reason, HaltReason::Breakpoint);
        assert_eq!(h.cycle, 1);
        assert!(h.details.contains("0x1"), "{}", h.details);

        // Held at the watched value, cycles pass quietly: nothing arrives.
        eng.run_until_time(9000).expect("no arrival, no breakpoint");
        assert!(eng.halted().is_none());

        // A second arrival is a hit again.
        assert!(eng.poke_at("p", k(1, 0), 9500));
        eng.run_until_time(10000)
            .expect("leaving the value is not a hit");
        assert!(eng.poke_at("p", k(1, 1), 10500));
        let h2 = eng.run_until_time(11000).expect_err("it arrived again");
        assert_eq!(h2.cycle, 10);
    }

    /// Arriving at a value the net *already* carries at power-on is not a hit:
    /// the boot settle is not part of the run (every net comes up somewhere,
    /// and stopping for that would stop every breakpoint on a constant-0 line
    /// at cycle 0). Only *becoming* the value is an event.
    #[test]
    fn breakpoint_does_not_fire_at_power_on() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"k","type":"wiring.constant","pos":[0,0],
                  "attrs":{{"bitsize":4,"value":"9"}}}},
                {{"id":"bp","type":"debug.breakpoint","pos":[0,0],
                  "attrs":{{"bitsize":4,"value":"9"}}}}
            ], "wires": [
                {{"a":{{"comp":"k","pin":"out"}},"b":{{"comp":"bp","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(4)
            .expect("a value that was always there never arrives");
        assert!(eng.halted().is_none());
    }

    /// A breakpoint *observes* (docs/format-v2.md §9's consume table): it
    /// consumes nothing, so watching an undriven net is legal — no
    /// floating-read halt — and `Z` is simply never the watched value.
    #[test]
    fn breakpoint_never_consumes() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"bp","type":"debug.breakpoint","pos":[0,0],
                  "attrs":{{"value":"1"}}}}
            ], "wires": []}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(3)
            .expect("a watcher cannot consume a floating value");
        assert!(eng.halted().is_none());
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
