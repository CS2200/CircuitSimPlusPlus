//! Delay-aware event-driven engine (DESIGN.md §4.3, §4.4; BACKEND.md task
//! B6) — the teaching + grading engine.
//!
//! Events are processed from a `(time, prio, seq)`-ordered queue; `seq` is a
//! monotonic counter assigned at schedule time, `prio` is 0 for every event
//! but the commit of a part that lies on a combinational cycle (see
//! "Same-timestamp tie-break" below), and same-timestamp reactions run in
//! component-index order — runs are bit-for-bit reproducible (§4.6).
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
//! - **Registers — clk→Q.** On a rising `clk` view, D is sampled
//!   (consuming `Z` halts, §4.1) and Q commits `clk→Q` later (last edge
//!   wins, same generation mechanism). There is no setup/hold *check*
//!   any more: the clock is **derived** (`docs/derived-clock.md`), so the
//!   edge is placed after the cascade has settled and no data change can
//!   race it.
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
//! A combinational component holds its output while a `Z` it would
//! actually *read* is still on its way — the wait consults the same
//! consume table as the sweep below, so a `Z` on a pin the part never
//! reads (a mux's *unselected* input, a disabled buffer's data) does not
//! stall it, and a `Z` whose drivers have all committed — an idle
//! tri-state bus — is final, not in flight: there is nothing to wait for,
//! so the part evaluates (`net_in_flight`).
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
//! The global clock is **derived** (`docs/derived-clock.md`): every edge is
//! placed by the drain, so the period is the design's own and
//! [`DEFAULT_CLOCK_START_NS`] decides only *when the clock starts*. Cycle 0 is
//! the first period after the boot settle. Per cycle, the engine records the
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
//! same inputs ⇒ same hash, every platform. Values go in as their raw
//! `width` + mask words (`Value::fold_bytes`), never as rendered text —
//! rendering three hex `String`s per event cost ~8% of a run to hash the
//! same bits.
//!
//! ## Same-timestamp tie-break (a symmetric settle)
//!
//! Two parts that commit at the same timestamp are *simultaneous* in the
//! model, and inside a **feedback loop** that simultaneity can be a fixed
//! point of the race: a cross-coupled NAND pair at power-on has both
//! outputs seeded `0`, recomputes `1,1` from the same stale views, then
//! `0,0` again — a 20 ns limit cycle, not a zero-delta one, so a design the
//! zero-delay old tool runs to completion trips our storm cap. Both parts
//! have the same delay and both commit together, so nothing in delay order
//! ever breaks the symmetry.
//!
//! The tie is broken deterministically, by **propagation before commit**:
//! within one timestamp, the commit of a component that lies **on a
//! combinational feedback cycle** (`engine_common::on_cycle`, DESIGN.md
//! §4.5's SCC analysis) is applied *after* every other event at that
//! timestamp. The transport arrival a same-instant commit produces is
//! therefore delivered to its sinks first; the recipient re-evaluates from
//! the freshly arrived value, the ordinary inertial mechanism invalidates
//! its pending commit (generation bump), and it is rescheduled one `t_pd`
//! later. The part the queue commits first wins and the loop settles to one
//! definite state — exactly the role CircuitSim CE's link order plays in
//! `Simulator.step` (it moves one link out of a `LinkedHashSet` per step,
//! so a symmetric settle is decided by insertion order). Nothing here is
//! random and nothing is a tolerance (§4.5, §4.6): the winner is
//! `(time, prio, seq)` order with `seq` the schedule order, i.e. component
//! (document) order.
//!
//! **Narrow by construction.** Only a `Fire` of a component that is *on a
//! cycle* is promoted to class 1; every other event — including a `Fire` of
//! a part that is merely *downstream* of a loop, and every `Deliver`/`Net`/
//! `Clock`/`Poke` — keeps its plain `(time, seq)` order. A design with no
//! combinational feedback therefore has no class-1 event and its event
//! trace is bit-identical to before. A genuine oscillator is unaffected as
//! well: its stages are one `t_pd` apart, so no two of their commits share a
//! timestamp and the cap below still fires on it.

use std::borrow::Cow;
use std::collections::{BTreeMap, VecDeque};
use std::sync::Arc;

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

/// When the clock's first edge happens, in delay-table units (ns). It is the timeline's
/// **origin** and nothing else: every later edge is placed by the drain
/// (`docs/derived-clock.md` §2/§3), so this decides neither the values latched nor the period
/// `t_obs` reports — only how far into simulated time the run starts moving.
pub const DEFAULT_CLOCK_START_NS: u64 = 1000;

/// The smallest step a transition can take. A transition may not land on the timestamp of the
/// edge that scheduled it: with no clocked parts there is nothing to drain and no setup to
/// charge, so two transitions would share one instant forever and trip the event cap. One
/// unit of simulator time is that guarantee, and it is the **only** floor left — the nominal
/// period no longer decides where any edge after the first one goes.
pub const MIN_STEP: u64 = 1;

const TOP_K: usize = 10;

/// What a run produced (also the engine's observable state).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunReport {
    /// Rising edges processed in this run.
    pub cycles: u64,
    /// The derived period (§4.4, `docs/derived-clock.md` §3).
    pub t_obs: u64,
    /// Top-k distinct observed critical paths, longest first, as
    /// `(settle_time, comp chain from latest-arriving register input back
    /// to the launching element)`.
    pub top_paths: Vec<(u64, Vec<CompId>)>,
    /// FNV-1a over every applied event — determinism tripwire (§4.6).
    pub trace_hash: u64,
    /// Total events applied over the run.
    pub events_processed: u64,
    /// Clocked parts whose `clk` pin rose **more than once inside one cycle**, as
    /// `(cycle, part)` — the design's clock glitched. This is the delay-aware engine's one
    /// structural difference from CircuitSim CE, which never delivers a same-round transient
    /// (`docs/bugs-archive.md`). It is a diagnostic: it changes no verdict, it only makes a
    /// timing-table-dependent design visible.
    pub clock_glitches: Vec<(u64, CompId)>,
    /// Nets whose driver values disagree with the net's width, as
    /// `(cycle, net, driver, value width, net width)` (`docs/bugs-archive.md`).
    pub net_width_mismatches: Vec<(u64, u32, CompId, u32, u32)>,
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
    /// per sink via `Deliver`). The payload is shared by the `Net` event and
    /// every `Deliver` event for the same resolution: a net with S sinks used
    /// to clone its `Value` S times into S separate events, and the queue
    /// carried S copies of a 100-byte struct.
    Net { net: u32, value: Arc<Value> },
    /// Deliver a resolved net value to one sink pin's view, at that
    /// sink's own path-delay arrival (per-path transport, F14). `kind`
    /// is the precomputed sink-pin classification (avoids a per-event
    /// sink-table scan on wide fan-out nets).
    Deliver {
        net: u32,
        comp: u32,
        slot: u32,
        kind: SinkKind,
        value: Arc<Value>,
    },
    /// Drive a root input pin at an absolute time (testbench poking).
    Poke { comp: u32, value: Arc<Value> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Ev {
    time: u64,
    /// Priority class within one timestamp (see `Ev::cmp`): 0 for every
    /// event except a commit of a component **in a combinational loop**,
    /// which is 1. It defers the loop commit until every same-timestamp
    /// transport arrival has been applied — the deterministic tie-break
    /// for a symmetric settle (module docs, "Same-timestamp tie-break").
    prio: u8,
    seq: u64,
    kind: EvKind,
}

/// The event queue: one bucket per timestamp, each split by priority class.
///
/// Ordering is exactly `Ev`'s old `(time, prio, seq)` key — times come out in
/// `BTreeMap` order, and inside one timestamp priority 0 before priority 1,
/// each in insertion (`seq`) order, which is `VecDeque` order. It replaces a
/// `BinaryHeap`, whose every push/pop was `O(log N)` comparisons and swaps of
/// a whole `Ev`; here a same-timestamp push/pop is amortized `O(1)`, and the
/// only logarithmic part is the number of *distinct future times*.
#[derive(Debug, Default)]
struct EventQueue {
    buckets: BTreeMap<u64, [VecDeque<Ev>; 2]>,
}

impl EventQueue {
    fn push(&mut self, ev: Ev) {
        self.buckets.entry(ev.time).or_default()[usize::from(ev.prio.min(1))].push_back(ev);
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.buckets.values().map(|b| b[0].len() + b[1].len()).sum()
    }

    fn is_empty(&self) -> bool {
        self.buckets.is_empty()
    }

    fn peek(&self) -> Option<&Ev> {
        let (_, b) = self.buckets.iter().next()?;
        b[0].front().or_else(|| b[1].front())
    }

    fn pop(&mut self) -> Option<Ev> {
        let time = *self.buckets.keys().next()?;
        let b = self.buckets.get_mut(&time).expect("keys() said it exists");
        let ev = if let Some(e) = b[0].pop_front() {
            e
        } else {
            b[1].pop_front().expect("bucket is never empty")
        };
        if b[0].is_empty() && b[1].is_empty() {
            self.buckets.remove(&time);
        }
        Some(ev)
    }

    fn iter(&self) -> impl Iterator<Item = &Ev> {
        self.buckets
            .values()
            .flat_map(|b| b.iter().flat_map(|d| d.iter()))
    }

    fn into_vec(self) -> Vec<Ev> {
        self.buckets
            .into_values()
            .flat_map(|b| b.into_iter().flat_map(|d| d.into_iter()))
            .collect()
    }
}

impl FromIterator<Ev> for EventQueue {
    fn from_iter<I: IntoIterator<Item = Ev>>(iter: I) -> Self {
        let mut q = EventQueue::default();
        for ev in iter {
            q.push(ev);
        }
        q
    }
}

/// Serializable snapshot form (`snapshot`/`restore`, §8.1). Version 2:
/// per-sink views + per-path deliveries (F14); version 1 files are
/// rejected cleanly.
#[derive(serde::Serialize, serde::Deserialize)]
struct DelaySnap {
    version: u32,
    clock_start: u64,
    now: u64,
    seq: u64,
    next_rising: bool,
    rising_seen: u64,
    cycle_settle: u64,
    /// Simulated time of the last clock edge: the start of the cycle in progress. The
    /// clock is **derived** (`docs/derived-clock.md`) — an edge fires when the cascade
    /// has settled, so there is no nominal boundary to measure the settle from.
    cycle_start: u64,
    /// Time of the last **rising** edge: the period is rise-to-rise
    /// (`docs/derived-clock.md` §3), so `t_obs` needs the previous one.
    last_rise: Option<u64>,
    cycle_settle_net: Option<u32>,
    t_obs: u64,
    top_paths: Vec<(u64, Vec<CompId>)>,
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
    clk_entry_low: Vec<bool>,
    clk_last_low: Vec<bool>,
    clk_change_at: Vec<Option<u64>>,
    clk_changes: Vec<u32>,
    clock_glitches: Vec<(u64, CompId)>,
    net_width_mismatches: Vec<(u64, u32, CompId, u32, u32)>,
    pending_gen: Vec<u64>,
    pending_val: Vec<Vec<crate::api::WireValue>>,
    pending_cause: Vec<Option<u32>>,
    pending_net_cause: Vec<(u32, (u32, Option<u32>))>,
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
                value: Arc::new(value(width_of(self)?)?),
            },
            "deliver" => EvKind::Deliver {
                net: self.net,
                comp: self.comp,
                slot: self.slot,
                kind: self.kind2,
                value: Arc::new(value(width_of(self)?)?),
            },
            "poke" => EvKind::Poke {
                comp: self.comp,
                value: Arc::new(value(width_of(self)?)?),
            },
            other => return Err(format!("bad snapshot event kind '{other}'")),
        };
        Ok(Ev {
            time: self.time,
            // Re-derived from the engine's cycle set by `restore` after the
            // queue is rebuilt; a snapshot does not have to carry it.
            prio: 0,
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
    /// Pin slot of the component's `clk` pin, if it has one. Precomputed so a
    /// clock delivery reads it directly instead of scanning every pin's name.
    clk_slot: Option<usize>,
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
    Rst,
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
            "rst" => SinkKind::Rst,
            "addr" => SinkKind::Addr,
            "din" => SinkKind::Din,
            "we" => SinkKind::We,
            _ => SinkKind::Other,
        }
    }
}

/// Which [`crate::api::Watch`] kind was installed (the engine-side form: the literal is
/// already parsed and width-matched, so the per-cycle evaluation never re-parses.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchKind {
    /// Unchanged across this many consecutive cycle boundaries.
    Stable(u64),
    /// Becomes the wanted value (a transition).
    Reaches,
    /// Equals the wanted value (a level).
    Is,
    /// Changed at this many cycle boundaries (an instruction counter).
    Changes(u64),
}

/// One installed stop condition plus the per-cycle bookkeeping it needs.
#[derive(Debug, Clone)]
struct WatchState {
    /// The `probe('…')`-registry name being watched.
    name: String,
    kind: WatchKind,
    /// The parsed literal (`None` for `Stable` and `Changes`).
    want: Option<Value>,
    /// Value at the previous boundary (`None` before the first evaluation).
    last: Option<Value>,
    /// Consecutive boundaries with an unchanged value (`Stable`).
    stable_for: u64,
    /// Boundaries at which the value differed from the previous one (`Changes`).
    changed: u64,
    /// The cycle the value last changed (`Stable`'s and `Changes`' `last_change_cycle`).
    last_change_cycle: u64,
}

impl WatchState {
    fn when(&self) -> &'static str {
        match self.kind {
            WatchKind::Stable(_) => "stable",
            WatchKind::Reaches => "reaches",
            WatchKind::Is => "is",
            WatchKind::Changes(_) => "changes",
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
    /// drive slots directly). `Arc`: every sink on a net receives the *same*
    /// value, so a delivery stores a shared pointer instead of deep-copying
    /// the ~100-byte `Value` into each view.
    views: Vec<Vec<Arc<Value>>>,
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
    /// The components that *are* the global clock (`wiring.clock` sources).
    /// Precomputed once: the `EvKind::Clock` arm used to rescan every component
    /// on every edge, which is 2 × cycles × components of pure filtering.
    clock_comps: Vec<u32>,
    /// Per clocked part: the instant of its most recent `clk` delivery, and how many it has had
    /// at that instant. More than one is the same-instant transient CE's round coalesces
    /// (`clock_glitches`, `docs/bugs-archive.md`).
    clk_change_at: Vec<Option<u64>>,
    clk_changes: Vec<u32>,
    /// Clocked parts that rose twice at one instant, as `(cycle, part)` (the diagnostic).
    clock_glitches: Vec<(u64, CompId)>,
    /// Nets whose *driver values* disagree with the net's width, as
    /// `(cycle, net, driver, value width, net width)`. The merge yields `X` for such a net and
    /// never panics (`docs/bugs-archive.md`); this is how the cause becomes visible.
    net_width_mismatches: Vec<(u64, u32, CompId, u32, u32)>,
    /// Per clocked part (register/RAM): whether the **instant being processed entered with the
    /// clock at a definite low** — and no edge taken for it yet. A `clk` delivery takes an edge
    /// only when this holds, so a clocked part takes **at most one edge per instant**, and never
    /// one whose instant began high (a `1 -> 0 -> 1` inside one instant is the transient this
    /// engine delivers and CircuitSim CE's round coalesces: `docs/derived-clock.md` §11,
    /// `docs/bugs-archive.md`).
    clk_entry_low: Vec<bool>,
    /// Per clocked part: the clock's level as of the last definite delivery — what the *next*
    /// instant enters with. A `Z`/`X` leaves it alone, so a floating clock holds the level.
    clk_last_low: Vec<bool>,
    /// Inertial bookkeeping: current generation, scheduled outputs,
    /// triggering input net.
    pending_gen: Vec<u64>,
    pending_val: Vec<Vec<Value>>,
    pending_cause: Vec<Option<u32>>,
    /// (net, cause) for scheduled-but-not-yet-applied net events;
    /// applied in schedule order (FIFO per net).
    pending_net_cause: Vec<(u32, (u32, Option<u32>))>,
    /// Scratch for `apply`'s `Fire` arm: the distinct output nets a commit
    /// touches. Reused so a commit does not allocate a `Vec` every time.
    scratch_affected: Vec<u32>,
    queue: EventQueue,
    now: u64,
    seq: u64,
    clock_start: u64,
    next_rising: bool,
    rising_seen: u64,
    /// How long after quiescence the edge is placed: the largest `t_setup` among the
    /// clocked parts (`docs/derived-clock.md` §2). Setup means the data must be stable
    /// `t_setup` *before* the edge, so an edge placed the instant the cascade ends would
    /// violate it by construction; waiting is what makes hold free and violations
    /// impossible.
    setup_wait: u64,
    cycle_settle: u64,
    /// Simulated time of the last clock edge: the start of the cycle in progress. The
    /// clock is **derived** (`docs/derived-clock.md`) — an edge fires when the cascade
    /// has settled, so there is no nominal boundary to measure the settle from.
    cycle_start: u64,
    /// Time of the last **rising** edge: the period is rise-to-rise
    /// (`docs/derived-clock.md` §3), so `t_obs` needs the previous one.
    last_rise: Option<u64>,
    cycle_settle_net: Option<u32>,
    t_obs: u64,
    top_paths: Vec<(u64, Vec<CompId>)>,
    /// Cap on applied events per cycle (storm detection, §4.5); also the
    /// boot settle's quiescence cap.
    pub events_per_cycle_cap: u64,
    /// Pause when a component reads a net nothing drives (§4.1): a **pause**, not a fault
    /// — the value it read is `X` (unknown), the engine carries on by default, and the
    /// converter is what supplies CE's implied constants (`clk`/`rst` → 0, an enable → 1).
    /// The editor turns this on to *ask*; a graded run leaves it off and lets the `X`
    /// surface in the verdict.
    pub pause_on_unknown: bool,
    /// **CE-compatibility diagnostic mode.** When a component consumes a floating (`Z`)
    /// input, use CE's own per-consumer reading (`Behavior::z_compat`) instead of the
    /// engine's `X`. This is a *debug* switch to separate engine `Z`-semantics from
    /// converter connectivity — the production engine never invents a value, and the
    /// converter is what writes constants. Off by default.
    pub compat: bool,
    /// Honour `debug.breakpoint`s (a pause) or ignore them. The editor wants the pause;
    /// a **graded** run does not — a breakpoint is a debug aid a submitter left in their
    /// schematic, and the old tool never let one end a graded run (DESIGN.md §8.1), so
    /// `GradeConfig` turns this off by default.
    pub breakpoints_enabled: bool,
    events_this_cycle: u64,
    events_processed: u64,
    trace_hash: u64,
    halted: Option<Halt>,
    /// Caller-defined stop conditions (§8.4), evaluated at every cycle boundary. Like
    /// `breakpoints_enabled` this is caller configuration, so it is not part of a
    /// savestate.
    watch: Vec<WatchState>,
    /// Per component: does it lie **on** a combinational feedback cycle
    /// (DESIGN.md §4.5's SCC analysis — `engine_common::on_cycle`)? A commit
    /// of such a part is the only event whose priority class is raised, so
    /// the same-timestamp tie-break is confined to genuine loops.
    cycle_comp: Vec<bool>,
    /// The stop that last held (contract v1.3) — reported as `Report::stop`, and what
    /// makes a cycle count to completion reportable without a fixed budget.
    stop: Option<crate::api::StopInfo>,
    /// True during the construction-time boot settle (module docs): no
    /// cycle closes, no DTA settle tracking, and no breakpoint fires (a
    /// breakpoint watches *changes during the run*; every net takes on a
    /// value at power-on, and stopping for that would be noise — see
    /// `react`'s `Class::Sink` arm).
    in_boot: bool,
}

/// One component as the engine sees it (the `csim nets --comp` debug dump).
#[derive(Debug, Clone, serde::Serialize)]
pub struct CompDump {
    pub comp: String,
    /// Registry type string, e.g. `gate.not`.
    #[serde(rename = "type")]
    pub type_: String,
    /// The engine's classification: `comb`, `source`, `sink`, `register`, `ram`, …
    pub class: String,
    pub pins: Vec<CompPin>,
}

/// One pin of a [`CompDump`].
#[derive(Debug, Clone, serde::Serialize)]
pub struct CompPin {
    pub pin: String,
    pub dir: String,
    pub net: usize,
    pub net_value: String,
    /// What this pin received (per-path transport).
    pub received: String,
}

/// One net as the engine sees it — the `csim nets` debug dump.
///
/// A converted design that misbehaves usually misbehaves *here*: the schematic says who
/// is connected, but only the engine knows which terminals it merged into the net, what
/// the resolved value is, and what each input pin received.
#[derive(Debug, Clone, serde::Serialize)]
pub struct NetDump {
    /// Index into the engine's net list.
    pub net: usize,
    /// The wire **name** (`Wire::name`, the old tool's tunnel) when this net carries
    /// one — instance-qualified like the named registry (`"Opcode"`, `"c61/Opcode"`).
    /// A name is a label, not a merging rule, so this is the first of possibly
    /// several; the net can be found by any of them with `--label`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub width: u32,
    /// No driving pin at all (the net is `Z`).
    pub floating: bool,
    /// The net's applied (resolved) value, four-state aware.
    pub value: String,
    /// Pins that can drive it, `id.pin` (or `instance/id.pin` when inlined).
    pub drivers: Vec<String>,
    /// What each of those pins currently **drives** (its last push), parallel to
    /// [`NetDump::drivers`]. This is what a disagreement is made of: the net's own value
    /// says `X`, but only this says *which two pins* are fighting.
    pub driver_values: Vec<String>,
    /// Pins that consume it, same naming.
    pub sinks: Vec<String>,
    /// The queried pin, when the dump was asked for one.
    pub pin: Option<String>,
    /// What that pin *received* (per-path transport), which can differ from `value`
    /// while an event is in flight.
    pub view: Option<String>,
}

fn debug_splitter_shape() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("CSIM_DEBUG_SPLITTER_SHAPE").is_ok())
}

fn debug_boot() -> Option<u32> {
    static ON: std::sync::OnceLock<Option<u32>> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        std::env::var("CSIM_DEBUG_BOOT")
            .ok()
            .and_then(|v| v.parse().ok())
    })
}

/// A comma-separated env var as a list of tokens, read once.
fn debug_spec(var: &str) -> Vec<String> {
    match var {
        "CSIM_DEBUG_SPLITTER" => {
            static ON: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
            ON.get_or_init(|| read_spec(var)).clone()
        }
        "CSIM_DEBUG_COMP" => {
            static ON: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
            ON.get_or_init(|| read_spec(var)).clone()
        }
        _ => read_spec(var),
    }
}

fn read_spec(var: &str) -> Vec<String> {
    std::env::var(var)
        .map(|v| {
            v.split(',')
                .map(|x| x.trim().to_string())
                .filter(|x| !x.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

/// Does component `c` match any token? A token is an engine index (`12`), a document id
/// (`c55`), the instance-qualified id (`c0/c7`), or the part's `name` (`Opcode`, `State`)
/// — because an index is not something a schematic tells you and guessing it wastes a run.
fn comp_matches(nl: &Netlist, c: usize, spec: &[String]) -> bool {
    if spec.is_empty() {
        return false;
    }
    let comp = &nl.comps[c];
    let qualified = if comp.inst_path.is_empty() {
        comp.def_id.clone()
    } else {
        format!("{}/{}", comp.inst_path, comp.def_id)
    };
    spec.iter().any(|t| match t.parse::<u32>() {
        Ok(i) => i as usize == c,
        Err(_) => qualified == *t || comp.def_id == *t || comp.name.as_deref() == Some(t.as_str()),
    })
}

impl DelayEngine {
    /// Build the engine. `clock_start` is in delay-table units
    /// (ns); it should exceed the design's true critical path or setup
    /// violations pile up (that's the lesson, §4.3 — the engine no longer
    /// *halts* in that case, F6). All delays come from `table` (the
    /// published table named by `settings.delayTable`, B7).
    pub fn new(
        netlist: Netlist,
        clock_start: u64,
        table: &TimingTable,
    ) -> Result<DelayEngine, Vec<LoadError>> {
        Self::build(netlist, clock_start, table, false)
    }

    /// Like [`DelayEngine::new`], with the CE-compatibility diagnostic enabled from
    /// construction — for a tool that only *inspects* the engine (`csim nets --compat`),
    /// where the boot settle must already read floating inputs the way CE does.
    pub fn new_compat(
        netlist: Netlist,
        clock_start: u64,
        table: &TimingTable,
    ) -> Result<DelayEngine, Vec<LoadError>> {
        Self::build(netlist, clock_start, table, true)
    }

    /// Like [`DelayEngine::new`], but the CE-compatibility diagnostic mode is known
    /// *before* the boot settle: a floating read at power-on is then coalesced the way
    /// CE reads it, rather than taken as `X` and never revisited (a purely combinational
    /// part may not re-evaluate after boot).
    pub(crate) fn build(
        netlist: Netlist,
        clock_start: u64,
        table: &TimingTable,
        compat: bool,
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
                clk_slot: fc.pins.iter().position(|p| p.pin == "clk"),
                timing: beh.timing(table),
            });
        }
        let net_values: Vec<Value> = netlist.nets.iter().map(|n| Value::z(n.width)).collect();
        let net_scheduled = net_values.clone();
        let views: Vec<Vec<Arc<Value>>> = ec::drive_slots(&netlist)
            .into_iter()
            .map(|slots| slots.into_iter().map(Arc::new).collect())
            .collect(); // all-Z, same shape
                        // Per-sink path delays (F14): grid units × the table's wire
                        // constant; min per net for the shared "latest value" slot.
                        // Per-sink path delays (F14): grid units × the table's wire constant; min per net
                        // for the shared "latest value" slot. Wire propagation is currently **off** — the
                        // table ships `wire.num = 0` — so this is 0 everywhere and only component delays
                        // count (see `timing_table.rs`); the per-path shape is kept for when wires return.
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
        // The global clock components, precomputed once: the `EvKind::Clock` arm
        // used to rescan every component on every edge just to find these.
        let clock_comps: Vec<u32> = (0..n as u32)
            .filter(|&c| cdata[c as usize].class == Class::Source)
            .filter(|&c| netlist.comps[c as usize].type_ == "wiring.clock")
            .collect();
        // The clocked parts' largest setup time: how long the edge waits after the cascade
        // settles (`docs/derived-clock.md` §2). Setup means the data must be stable
        // `t_setup` *before* the edge, so an edge placed the instant the cascade ends would
        // violate it by construction; waiting is what makes hold free and violations
        // impossible.
        let setup_wait = cdata
            .iter()
            .filter(|d| matches!(d.class, Class::Register | Class::Ram))
            .map(|d| d.timing.setup)
            .max()
            .unwrap_or(0);
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
            clock_comps,
            clk_entry_low: vec![true; n],
            clk_last_low: vec![true; n],
            clk_change_at: vec![None; n],
            clk_changes: vec![0; n],
            net_width_mismatches: Vec::new(),
            clock_glitches: Vec::new(),
            pending_gen: vec![0; n],
            pending_val: vec![Vec::new(); n],
            pending_cause: vec![None; n],
            pending_net_cause: Vec::new(),
            scratch_affected: Vec::new(),
            queue: EventQueue::default(),
            now: 0,
            seq: 0,
            clock_start,
            next_rising: true,
            rising_seen: 0,
            setup_wait,
            cycle_settle: 0,
            cycle_start: 0,
            last_rise: None,
            cycle_settle_net: None,
            t_obs: 0,
            top_paths: Vec::new(),
            events_per_cycle_cap: DEFAULT_EVENTS_PER_CYCLE_CAP,
            breakpoints_enabled: true,
            pause_on_unknown: false,
            compat,
            events_this_cycle: 0,
            events_processed: 0,
            trace_hash: 0xcbf2_9ce4_8422_2325, // FNV offset basis
            halted: None,
            watch: Vec::new(),
            cycle_comp: vec![false; n],
            stop: None,
            in_boot: true,
        };
        // Power-on for combinational loops: seed loop nets to 0 (same
        // deterministic rule as the zero-delay engine) so feedback logic
        // starts from a defined state. Splitters are excepted: they carry
        // values but never originate them (B11 — a 0 seed phantom-contends
        // with the other side of a splitter chain). The seed must reach
        // every sink's *view* (gates read views, F14).
        let (_, residue) = crate::engine_common::levelize(&eng.netlist, &eng.comps);
        // The precise subset of the residue that is *feedback*: the parts a
        // same-timestamp tie-break may reorder (module docs).
        let cycle_comp = crate::engine_common::on_cycle(&eng.netlist, &eng.comps);
        eng.cycle_comp = cycle_comp;
        for c in residue.iter().copied() {
            if eng.comps[c as usize].is_splitter() {
                continue;
            }
            for (_, net) in &eng.cdata[c as usize].out_pins {
                let width = eng.netlist.nets[net.idx()].width;
                eng.net_values[net.idx()] = Value::zero(width);
                // NOT `net_scheduled`: the seed gives the net a *value* so its consumers do
                // not stall on a `Z` view, but nothing has been *committed* on it yet. The
                // commit happens when the loop part evaluates, and it is the change test
                // (`resolved != net_scheduled`) that fires the arrivals its consumers need.
                // Seeding `net_scheduled` to the same 0 made that commit invisible — no
                // `Net`, no `Deliver` — so a part inside the loop that was seeded a view but
                // never got an arrival (a splitter on a loop-driven bus) sat on its initial
                // `Z` for the whole run while every wire was correct.
                for sp in &eng.net_sinks[net.idx()] {
                    eng.views[sp.comp as usize][sp.slot as usize] = Arc::new(Value::zero(width));
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
        // A seeded loop has *values* but has not been *evaluated*: every part in it
        // would otherwise wait for a delivery that never comes, because a part whose
        // first evaluation computes exactly the seeded 0 leaves its consumers' views
        // untouched. That is not a corner case — the course pipelines' stall and
        // forwarding logic is a combinational loop (En → ID/RR → comparators → the
        // stall gate → En), so a design could freeze at power-on with its stall gate
        // reading 0 forever while every wire was correct. So evaluate each loop
        // component once from the seeded state; the boot queue then iterates the loop
        // to its fixed point, and a genuine oscillator still trips the storm cap.
        // Splitters included. A splitter is exempt from the *seed* above — it originates
        // no value, so seeding one would phantom-contend with the other side of a chain —
        // but it is not exempt from being *evaluated*, and skipping it left a slicing
        // splitter on its initial `Z` for the whole run. Its output then never *changed*,
        // so no arrival was ever delivered to the parts reading it: a converted datapath's
        // memory address line stayed floating while every wire was correct. `wiring.constant`
        // masked it, because a source is evaluated at power-on whatever loops it sits in.
        for c in &residue {
            if let Err(h) = eng.eval_and_schedule(*c, 0, None) {
                eng.halted = Some(h);
                break;
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
        // Final settle (power-on): a combinational part that tried to evaluate while an
        // input was still *in flight* is left un-evaluated — and if that driver's commit
        // turns out to be a `Z` **no-op** (a disabled tri-state buffer, a comparator on
        // it), no delivery is ever produced, so the part never wakes. Its output then
        // stays at the initial `Z` for the whole run: production reads it as `X`, and
        // `compat` never gets to apply CE's per-consumer coalescence because the part is
        // never re-evaluated. `boot()` has drained the queue, so nothing that will arrive
        // is still outstanding — re-attempt every part that has not produced an output,
        // to a fixpoint. (`net_in_flight` no longer reports the settled driver, so the
        // retry does not wait again.)
        if eng.halted.is_none() {
            let mut rounds = 0usize;
            loop {
                rounds += 1;
                if rounds > n + 1 {
                    break;
                }
                let stuck: Vec<u32> = (0..n as u32)
                    .filter(|&c| {
                        eng.pending_gen[c as usize] == 0
                            && matches!(
                                eng.cdata[c as usize].class,
                                Class::Comb | Class::Ram | Class::Rom
                            )
                    })
                    .collect();
                if stuck.is_empty() {
                    break;
                }
                for c in &stuck {
                    if let Err(h) = eng.eval_and_schedule(*c, 0, None) {
                        eng.halted = Some(h);
                        break;
                    }
                }
                if eng.halted.is_some() {
                    break;
                }
                if let Err(h) = eng.boot() {
                    eng.halted = Some(h);
                    break;
                }
                // Progress: at least one stuck part produced an output this round. A part
                // that keeps waiting (a genuinely in-flight or oscillating input) makes no
                // progress and ends the loop.
                if stuck.iter().all(|&c| eng.pending_gen[c as usize] == 0) {
                    break;
                }
            }
        }
        // Time restarts at 0; cycle accounting begins.
        eng.in_boot = false;
        eng.now = 0;
        eng.events_this_cycle = 0;
        if eng.halted.is_none() {
            eng.schedule(clock_start, EvKind::Clock { phase: true });
        }
        // `CSIM_DEBUG_BOOT=<net idx>`: what every driver of that net had committed when the
        // boot settle finished. Env-gated; inert otherwise. (This is how the register's
        // power-on value was settled — CE's `Register.init` pushes `WireValue.of(0, ...)`,
        // so the engine's `0` is right and an experiment that drove `Z` instead regressed
        // 106 submissions. docs/bugs.md.)
        if let Some(net) = debug_boot() {
            let ds = &eng.net_drivers[net as usize];
            eprintln!(
                "BOOT net {net} = {} | drivers [{}]",
                eng.net_values[net as usize],
                ds.iter()
                    .map(|&(c, slot)| {
                        let k = &eng.netlist.comps[c as usize];
                        format!(
                            "#{c}:{}({})= {}",
                            k.name.clone().unwrap_or_else(|| k.type_.clone()),
                            k.type_,
                            eng.drives[c as usize][slot]
                        )
                    })
                    .collect::<Vec<_>>()
                    .join(" | ")
            );
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

    /// The derived period so far: max rise-to-rise interval (§4.4).
    pub fn t_obs(&self) -> u64 {
        self.t_obs
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
    /// queue is serialized in pop order `(time, prio, seq)`; restoring into
    /// an engine built from the same circuit + table continues bit-identically
    /// (§4.6 — see the test). Snapshot version 8: the clocked parts' entry level, the
    /// clock-glitch diagnostic and the net-width diagnostic (`docs/derived-clock.md` §11,
    /// `docs/bugs-archive.md`). Version 4 was per-sink views (F14); the setup/hold tracker
    /// and its violations list are gone, `half_period`/`next_boundary` are gone, and the clock
    /// origin is `clock_start` (`docs/derived-clock.md`).
    pub fn snapshot(&self) -> String {
        let mut queue: Vec<&Ev> = self.queue.iter().collect();
        queue.sort_by_key(|e| (e.time, e.prio, e.seq));
        let snap = DelaySnap {
            version: 8,
            clock_start: self.clock_start,
            now: self.now,
            seq: self.seq,
            next_rising: self.next_rising,
            rising_seen: self.rising_seen,
            cycle_settle: self.cycle_settle,
            cycle_start: self.cycle_start,
            last_rise: self.last_rise,
            cycle_settle_net: self.cycle_settle_net,
            t_obs: self.t_obs,
            top_paths: self.top_paths.clone(),
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
                .map(|slots| slots.iter().map(|v| v.to_wire_value()).collect())
                .collect(),
            net_values: self.net_values.iter().map(Value::to_wire_value).collect(),
            net_scheduled: self
                .net_scheduled
                .iter()
                .map(Value::to_wire_value)
                .collect(),
            net_cause: self.net_cause.clone(),
            net_ever_driven: self.net_ever_driven.clone(),
            clk_entry_low: self.clk_entry_low.clone(),
            clk_last_low: self.clk_last_low.clone(),
            clk_change_at: self.clk_change_at.clone(),
            clk_changes: self.clk_changes.clone(),
            clock_glitches: self.clock_glitches.clone(),
            net_width_mismatches: self.net_width_mismatches.clone(),
            pending_gen: self.pending_gen.clone(),
            pending_val: self
                .pending_val
                .iter()
                .map(|outs| outs.iter().map(Value::to_wire_value).collect())
                .collect(),
            pending_cause: self.pending_cause.clone(),
            pending_net_cause: self.pending_net_cause.clone(),
            queue: queue.iter().map(|e| SnapEv::from_ev(e)).collect(),
        };
        serde_json::to_string(&snap).expect("snapshot serializes")
    }

    /// Restore a snapshot into an engine built from the same circuit and
    /// delay table. Errors (never panics) on shape/version mismatch.
    pub fn restore(&mut self, json: &str) -> Result<(), String> {
        let snap: DelaySnap =
            serde_json::from_str(json).map_err(|e| format!("bad snapshot: {e}"))?;
        if snap.version != 8 {
            return Err(format!("unsupported snapshot version {}", snap.version));
        }
        if snap.clock_start != self.clock_start {
            return Err("snapshot clock start does not match".to_string());
        }
        let n_comps = self.comps.len();
        let n_nets = self.netlist.nets.len();
        let shape_ok = snap.comps.len() == n_comps
            && snap.drives.len() == n_comps
            && snap.views.len() == n_comps
            && snap.pending_gen.len() == n_comps
            && snap.pending_val.len() == n_comps
            && snap.pending_cause.len() == n_comps
            && snap.net_values.len() == n_nets
            && snap.net_scheduled.len() == n_nets
            && snap.net_cause.len() == n_nets
            && snap.net_ever_driven.len() == n_nets
            && snap.clk_entry_low.len() == n_comps
            && snap.clk_last_low.len() == n_comps
            && snap.clk_change_at.len() == n_comps
            && snap.clk_changes.len() == n_comps;
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
                self.views[ci][slot] = Arc::new(values(wv, fc.pins[slot].width)?);
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
        self.clk_entry_low = snap.clk_entry_low;
        self.clk_last_low = snap.clk_last_low;
        self.clk_change_at = snap.clk_change_at;
        self.clk_changes = snap.clk_changes;
        self.clock_glitches = snap.clock_glitches;
        self.net_width_mismatches = snap.net_width_mismatches;
        self.pending_gen = snap.pending_gen;
        self.pending_cause = snap.pending_cause;
        self.pending_net_cause = snap.pending_net_cause;
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
        // Re-derive the priority class of every queued commit from this
        // engine's own cycle set, so a restored heap pops in exactly the
        // order a fresh build would have.
        let mut queue: Vec<Ev> = std::mem::take(&mut self.queue).into_vec();
        for ev in queue.iter_mut() {
            if let EvKind::Fire { comp, .. } = ev.kind {
                ev.prio = u8::from(self.cycle_comp[comp as usize]);
            }
        }
        self.queue = queue.into_iter().collect();
        self.next_rising = snap.next_rising;
        self.rising_seen = snap.rising_seen;
        self.cycle_settle = snap.cycle_settle;
        self.cycle_start = snap.cycle_start;
        self.last_rise = snap.last_rise;
        self.cycle_settle_net = snap.cycle_settle_net;
        self.t_obs = snap.t_obs;
        self.top_paths = snap.top_paths;
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
                Some(self.views[ci][slot].as_ref().clone())
            }
            NamedKind::Ram | NamedKind::Rom => None,
        }
    }

    /// Install the caller's stop conditions (§8.4, contract v1.3).
    ///
    /// Each name is validated against the same registry `probe('…')` reads (registers and
    /// probes), and each literal is parsed and width-matched to the watched value, so a
    /// typo fails here — with the run — instead of silently never stopping. An empty
    /// slice clears the watches (and the recorded stop).
    pub fn set_watch(&mut self, watch: &[crate::api::Watch]) -> Result<(), String> {
        let mut installed = Vec::with_capacity(watch.len());
        for w in watch {
            let name = self.resolve_named(w.name())?;
            let cur = self
                .named_value(&name)
                .ok_or_else(|| format!("'{name}' has no value to watch"))?;
            let (kind, want) = match w {
                crate::api::Watch::Stable { cycles, .. } => (WatchKind::Stable(*cycles), None),
                crate::api::Watch::Changes { count, .. } => (WatchKind::Changes(*count), None),
                crate::api::Watch::Reaches { value, .. } => (
                    WatchKind::Reaches,
                    Some(self.watch_literal(&name, &cur.width(), value)?),
                ),
                crate::api::Watch::Is { value, .. } => (
                    WatchKind::Is,
                    Some(self.watch_literal(&name, &cur.width(), value)?),
                ),
            };
            installed.push(WatchState {
                name,
                kind,
                want,
                last: None,
                stable_for: 0,
                changed: 0,
                last_change_cycle: 0,
            });
        }
        self.watch = installed;
        self.stop = None;
        Ok(())
    }

    /// Resolve a watch's name against the named registry.
    ///
    /// An exact name wins. Otherwise a **unique** `/`-suffix match is accepted: a watch's
    /// name comes from the design's own labelling, and the old tester resolved those
    /// recursively (`lookupRegister("PC-IF", 32, true)`), while the hierarchy is in the
    /// name for a converted design (`c24/c29/$v0`). Ambiguity is an error, never a guess —
    /// a grader must not silently watch one of two registers that happen to share a leaf.
    fn resolve_named(&self, name: &str) -> Result<String, String> {
        if self.netlist.named.iter().any(|n| n.name == name) {
            return Ok(name.to_string());
        }
        let suffix = format!("/{name}");
        let hits: Vec<&str> = self
            .netlist
            .named
            .iter()
            .map(|n| n.name.as_str())
            .filter(|n| n.ends_with(&suffix))
            .collect();
        match hits.as_slice() {
            [one] => Ok((*one).to_string()),
            [] => Err(format!(
                "no named register or probe '{name}' (a watch names what `probe('…')` reads)"
            )),
            many => Err(format!(
                "'{name}' is ambiguous — {} named parts end with it: {}",
                many.len(),
                many.join(", ")
            )),
        }
    }

    /// Parse a watch literal and widen/truncate it to the watched value's width.
    ///
    /// The width comes from the *current* value, so a watch on a named register sees the
    /// same width the assertion grammar would compare against.
    fn watch_literal(&self, name: &str, width: &u32, text: &str) -> Result<Value, String> {
        let v = crate::value::parse_int_literal(text)
            .ok_or_else(|| format!("watch on '{name}': bad literal '{text}'"))?;
        Ok(Value::from_u64(*width, v))
    }

    /// The stop that last held (§8.4), for the report.
    pub fn stop_info(&self) -> Option<&crate::api::StopInfo> {
        self.stop.as_ref()
    }

    /// Evaluate the stop conditions at a cycle boundary (§8.4).
    ///
    /// Called just before a rising edge is applied, which is the state the course graders
    /// read after a clock tick: the previous cycle has fully settled, because events are
    /// applied in time order. Returns the halt to raise when one holds.
    ///
    /// A watch that held is **disarmed** (dropped), so a caller that carries on after a
    /// stop — the editor's "run until halt" then play again — is not stopped forever by a
    /// condition that is still true. `Reaches` only ever fires on a transition, so it is
    /// naturally once-per-change; `Is` and `Stable` are levels, and this is what keeps
    /// them from re-firing on every subsequent run.
    fn check_watch(&mut self) -> Result<(), Halt> {
        if self.watch.is_empty() {
            return Ok(());
        }
        // Taken out so the per-cycle bookkeeping can call `&self` readers (the value
        // lookup) without a double borrow; put back before returning, and no event runs
        // in between.
        let mut watch = std::mem::take(&mut self.watch);
        let cycle = self.rising_seen;
        let mut fired: Option<crate::api::StopInfo> = None;
        let mut keep: Vec<WatchState> = Vec::with_capacity(watch.len());
        for mut w in watch.drain(..) {
            let Some(cur) = self.named_value(&w.name) else {
                keep.push(w);
                continue;
            };
            let held = match w.kind {
                WatchKind::Stable(need) => {
                    if w.last.as_ref() == Some(&cur) {
                        w.stable_for += 1;
                    } else {
                        w.stable_for = 0;
                        w.last_change_cycle = cycle;
                    }
                    need > 0 && w.stable_for >= need
                }
                // A transition *into* the value: something that already held it at
                // power-on is noise, like a `debug.breakpoint` that starts satisfied.
                WatchKind::Reaches => {
                    w.last.as_ref().is_some_and(|prev| prev != &cur)
                        && w.want.as_ref() == Some(&cur)
                }
                WatchKind::Is => w.want.as_ref() == Some(&cur),
                // Counting changes: the first boundary only *observes*, so a value that is
                // already settled when the run starts counts nothing.
                WatchKind::Changes(need) => {
                    if w.last.as_ref().is_some_and(|prev| prev != &cur) {
                        w.changed += 1;
                        w.last_change_cycle = cycle;
                    }
                    need > 0 && w.changed >= need
                }
            };
            if held {
                if fired.is_none() {
                    fired = Some(crate::api::StopInfo {
                        name: w.name.clone(),
                        when: w.when().to_string(),
                        at_cycle: cycle,
                        last_change_cycle: matches!(
                            w.kind,
                            WatchKind::Stable(_) | WatchKind::Changes(_)
                        )
                        .then_some(w.last_change_cycle),
                        value: format!("{cur}"),
                    });
                }
                continue; // disarmed: it is spent
            }
            w.last = Some(cur);
            keep.push(w);
        }
        self.watch = keep;
        match fired {
            None => Ok(()),
            Some(info) => {
                let detail = match info.last_change_cycle {
                    Some(c) => format!(
                        "watch '{}' {} held at cycle {} (value {}; last changed cycle {c})",
                        info.name, info.when, info.at_cycle, info.value
                    ),
                    None => format!(
                        "watch '{}' {} held at cycle {} (value {})",
                        info.name, info.when, info.at_cycle, info.value
                    ),
                };
                self.stop = Some(info);
                Err(Halt {
                    reason: HaltReason::Stop,
                    cycle,
                    details: detail,
                })
            }
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
    /// The engine's own view of the net carrying a root-circuit component pin.
    ///
    /// A debugging aid for conversions: it answers "what does the engine think is on
    /// this net, and who is on it" — which is the question a schematic cannot answer
    /// once a design misbehaves. `view` is what *this pin* received (per-path
    /// transport, F14), which can differ from the net's applied value while an
    /// event is in flight.
    pub fn net_of_pin(&self, id: &str, pin: &str) -> Option<NetDump> {
        let ci = match self.netlist.named.iter().position(|n| n.name == id) {
            Some(i) => self.netlist.named_flat[i].idx(),
            None => self.netlist.comps.iter().position(|c| {
                c.inst_path.is_empty() && (c.def_id == id || c.name.as_deref() == Some(id))
            })?,
        };
        let slot = self.netlist.comps[ci]
            .pins
            .iter()
            .position(|p| p.pin == pin)?;
        let net = self.netlist.comps[ci].pins[slot].net.idx();
        let mut dump = self.net_dump(net);
        dump.pin = Some(format!("{id}.{pin}"));
        dump.view = Some(self.views[ci][slot].to_string());
        Some(dump)
    }

    /// The engine's view of one root-circuit component: its class, and every pin with
    /// the net it lands on, that net's value, and what the pin received (debugging aid).
    pub fn comp_dump(&self, id: &str) -> Option<CompDump> {
        // The named registry is the authority on how a part is spelled; fall back to a
        // scan so root parts with no `name` (a gate, say) are addressable by their id.
        let ci = match self.netlist.named.iter().position(|n| n.name == id) {
            Some(i) => self.netlist.named_flat[i].idx(),
            None => self.netlist.comps.iter().position(|c| {
                c.inst_path.is_empty() && (c.def_id == id || c.name.as_deref() == Some(id))
            })?,
        };
        let class = match self.cdata[ci].class {
            Class::Comb => "comb",
            Class::Splitter => "splitter",
            Class::Register => "register",
            Class::Ram => "ram",
            Class::Rom => "rom",
            Class::Source => "source",
            Class::Sink => "sink",
        };
        let pins = self.netlist.comps[ci]
            .pins
            .iter()
            .enumerate()
            .map(|(slot, p)| CompPin {
                pin: p.pin.clone(),
                dir: format!("{:?}", p.dir).to_lowercase(),
                net: p.net.idx(),
                net_value: self
                    .net_values
                    .get(p.net.idx())
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "?".to_string()),
                received: self.views[ci][slot].to_string(),
            })
            .collect();
        Some(CompDump {
            comp: id.to_string(),
            type_: self.netlist.comps[ci].type_.clone(),
            class: class.to_string(),
            pins,
        })
    }

    /// The raw four-state reading of every net carrying the labelled wire `label`, each
    /// as `merged|ok` or `merged|SHORT`: the net's resolved value (every driver merged)
    /// in the old tool's own alphabet — bare bits, lowercase `z` — and whether the
    /// drivers genuinely **disagree** (`Value::contention_merge_detail`'s short flag).
    ///
    /// This is the engine-side twin of the old tracer's `TRACE_RAW` column, so the two
    /// can be read side by side for the same wire name. The old tool has no `X`
    /// (`WireValue.State` is `ONE`/`ZERO`/`Z`), so **any `x` here is a divergence** —
    /// and `SHORT` is the transient the old engine defers (`Simulator.step` records it
    /// and only re-raises at quiescence).
    pub fn net_raw_by_label(&self, label: &str) -> Vec<String> {
        self.netlist
            .net_ids_of_label(label)
            .into_iter()
            .map(|n| {
                let nidx = n.idx();
                let drivers: Vec<Value> = self.net_drivers[nidx]
                    .iter()
                    .map(|&(d, sl)| self.drives[d as usize][sl].clone())
                    .collect();
                let (_, shorted) =
                    Value::contention_merge_detail(self.netlist.nets[nidx].width, &drivers);
                let merged = self
                    .net_values
                    .get(nidx)
                    .map(|v| v.to_string())
                    .unwrap_or_else(|| "?".to_string());
                let merged = merged.strip_prefix("0b").unwrap_or(&merged).to_string();
                format!("{merged}|{}", if shorted { "SHORT" } else { "ok" })
            })
            .collect()
    }

    /// The resolved values of every net carrying the labelled wire `label`, in net
    /// order (see [`DelayEngine::nets_by_label`]). Empty when nothing carries it.
    pub fn net_values_by_label(&self, label: &str) -> Vec<Value> {
        self.netlist
            .net_ids_of_label(label)
            .into_iter()
            .filter_map(|n| self.net_values.get(n.idx()).cloned())
            .collect()
    }

    /// Every net carrying the labelled wire `label` — an exact name or a
    /// `/`-suffix within an instance — as dumps. This is the *net* companion of
    /// [`DelayEngine::named_value`]: a labelled wire is the old tool's **tunnel**, and
    /// its tracer reads one by name (`Subcircuit.snitchTunnel`), so this is what lets
    /// the engine answer the same question per cycle (`PROBE_NETS`) or on demand
    /// (`csim nets --label`).
    pub fn nets_by_label(&self, label: &str) -> Vec<NetDump> {
        self.netlist
            .net_ids_of_label(label)
            .into_iter()
            .map(|n| self.net_dump(n.idx()))
            .collect()
    }

    /// Every net that carries at least one pin, in id order (debugging aid).
    pub fn nets(&self) -> Vec<NetDump> {
        (0..self.netlist.nets.len())
            .filter(|n| {
                let net = &self.netlist.nets[*n];
                !net.drivers.is_empty() || !net.sinks.is_empty()
            })
            .map(|n| self.net_dump(n))
            .collect()
    }

    fn net_dump(&self, net: usize) -> NetDump {
        let n = &self.netlist.nets[net];
        let label = |(comp, pin): &(crate::api::CompId, String)| {
            let c = &self.netlist.comps[comp.idx()];
            if c.inst_path.is_empty() {
                format!("{}.{pin}", c.def_id)
            } else {
                format!("{}/{}.{pin}", c.inst_path, c.def_id)
            }
        };
        let name = self
            .netlist
            .labelled
            .iter()
            .find(|(_, ln)| ln.idx() == net)
            .map(|(name, _)| name.clone());
        NetDump {
            net,
            name,
            width: n.width,
            floating: n.floating,
            value: self
                .net_values
                .get(net)
                .map(|v| v.to_string())
                .unwrap_or_else(|| "?".to_string()),
            drivers: n.drivers.iter().map(label).collect(),
            driver_values: self.net_drivers[net]
                .iter()
                .map(|&(d, sl)| {
                    self.drives
                        .get(d as usize)
                        .and_then(|pins| pins.get(sl))
                        .map(|v| v.to_string())
                        .unwrap_or_else(|| "?".to_string())
                })
                .collect(),
            sinks: n.sinks.iter().map(label).collect(),
            pin: None,
            view: None,
        }
    }

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
                value: Arc::new(v),
            },
        );
        true
    }

    /// Run `cycles` full clock cycles (rising edges). Returns the run
    /// report; on a halt, the engine stays halted (the error is sticky).
    /// The in-progress final cycle is *closed out* at run end (F7): the cycle-close
    /// floating-read sweep runs and its critical path is recorded. `t_obs` is the
    /// rise-to-rise period, so a cycle that never ended contributes nothing to it.
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

    /// Fire a clock edge **without overtaking the logic** (`docs/derived-clock.md`):
    /// drain everything queued, then place the edge `setup_wait` after the last event
    /// applied, so the cycle it closes has settled and a latch samples a settled cloud.
    ///
    /// The drain is **untruncated on purpose**. A design that never quiesces is caught by
    /// the engine's own per-cycle event cap in `apply` and halts as an oscillation; a local
    /// cap here (a debug build once carried `if n > 400_000 { break; }`) instead *continues*
    /// on a partially settled cascade, which silently breaks the one contract that is not
    /// negotiable. Both callers come through here for the same reason: when this logic was
    /// copy-pasted between `run_inner` and `step_tick`, the copies drifted, and the one in
    /// `run_inner` -- the path a real run takes -- kept the truncation.
    fn place_transition(&mut self, due: u64, kind: EvKind) -> Result<(), Halt> {
        // Drain to quiescence: everything queued belongs to the cycle this transition closes,
        // because nothing can schedule the next cycle's events before the transition happens.
        let mut pause = None;
        while let Some(e) = self.queue.pop() {
            if let Err(h) = self.apply(e) {
                pause = Some(h);
                break;
            }
        }
        // The transition is re-queued **whatever happened**: a pause (a breakpoint, a `stop`)
        // is not a fault, so the rest of the cycle is still queued and the run carries on from
        // exactly here. Dropping the transition would stop the clock.
        self.schedule(self.transition_time(due, &kind), kind);
        match pause {
            Some(h) => Err(h),
            None => Ok(()),
        }
    }

    /// Where a transition lands: **quiescence plus the setup it owes** — and it owes setup only
    /// if it *samples*. A falling edge latches nothing, so it has no data to be stable and is
    /// placed at quiescence; charging it setup there would charge two setups per cycle.
    ///
    /// `max` with the transition's own due time rather than `quiescence + setup` alone: a
    /// transition is never pulled *earlier* than it was due, which is what leaves the boot's
    /// first edge (an empty queue in front of it) where the boot put it.
    fn transition_time(&self, due: u64, kind: &EvKind) -> u64 {
        let samples = matches!(kind, EvKind::Clock { phase: true }) && self.setup_wait > 0;
        let settled = if samples {
            self.now + self.setup_wait
        } else {
            self.now
        };
        settled.max(due)
    }

    /// Apply a transition that the queue already holds alone: nothing left to drain, so it is
    /// already as early as the drain would place it, and it is applied rather than re-queued.
    /// (This is also what advances a design with no clocked parts at all.)
    fn apply_transition_now(&mut self, due: u64, kind: EvKind) -> Result<(), Halt> {
        self.seq += 1;
        let ev = Ev {
            time: self.transition_time(due, &kind),
            prio: 0,
            seq: self.seq,
            kind,
        };
        #[cfg(test)]
        self.assert_edge_does_not_overtake(&ev);
        self.apply(ev)
    }

    /// Advance one half-period (one clock edge — the contract v1.1
    /// `step_tick` in delay mode): apply events up to and including the
    /// next global clock event.
    pub fn step_tick(&mut self) -> Result<(), Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        loop {
            let Some(ev) = self.queue.peek() else {
                return Ok(());
            };
            if matches!(ev.kind, EvKind::Clock { .. }) {
                let (due, kind) = (ev.time, ev.kind.clone());
                self.queue.pop();
                if self.queue.is_empty() {
                    self.apply_transition_now(due, kind)
                        .inspect_err(|h| self.record_halt(h))?;
                    return Ok(());
                }
                self.place_transition(due, kind)?;
                continue;
            }
            let ev = self.queue.pop().expect("peeked");
            self.apply(ev).inspect_err(|h| self.record_halt(h))?;
        }
    }

    /// Settle everything queued BEFORE the next clock edge — i.e. let an
    /// interactive poke (a forced register/button value) propagate through the
    /// circuit within the CURRENT cycle, without firing a clock edge. Stops at
    /// the first queued `Clock` event, so no half-cycle is consumed.
    pub fn settle_cycle(&mut self) -> Result<(), Halt> {
        if let Some(h) = &self.halted {
            return Err(h.clone());
        }
        // A transition is *deferred*, not a stopping point. It sits at the head of the queue
        // the moment it is due (a successor is due immediately after its edge), so stopping at
        // it would leave an interactive poke unsettled — which is this function's whole job.
        let mut deferred: Vec<Ev> = Vec::new();
        while let Some(ev) = self.queue.peek() {
            if matches!(ev.kind, EvKind::Clock { .. }) {
                deferred.push(self.queue.pop().expect("peeked"));
                continue;
            }
            let ev = self.queue.pop().expect("peeked");
            self.apply(ev).inspect_err(|h| self.record_halt(h))?;
        }
        for ev in deferred {
            self.queue.push(ev);
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
            if matches!(ev.kind, EvKind::Clock { .. }) {
                let (due, kind) = (ev.time, ev.kind.clone());
                if self.transition_time(due, &kind) >= t {
                    break; // it lands at or after `t`: leave it for the caller
                }
                self.queue.pop();
                if self.queue.is_empty() {
                    self.apply_transition_now(due, kind)
                        .inspect_err(|h| self.record_halt(h))?;
                } else {
                    self.place_transition(due, kind)?;
                }
                continue;
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
            // Copy what this iteration needs and let the queue borrow end here: every path
            // below mutates the engine.
            let due = ev.time;
            let is_rising = matches!(ev.kind, EvKind::Clock { phase: true });
            let kind = if matches!(ev.kind, EvKind::Clock { .. }) {
                Some(ev.kind.clone())
            } else {
                None
            };
            if is_rising {
                if self.rising_seen == target {
                    break; // stop at the boundary; the edge belongs to the next run
                }
                // Caller-defined stop conditions (§8.4) are evaluated at the boundary: every
                // event earlier than the edge has been applied, so the cycle has settled —
                // the state a course grader reads after a clock tick.
                self.check_watch()?;
            }
            let Some(kind) = kind else {
                let ev = self.queue.pop().expect("peeked");
                #[cfg(test)]
                self.assert_edge_does_not_overtake(&ev);
                self.apply(ev)?;
                continue;
            };
            // **Derived clock** (`docs/derived-clock.md` §3): a transition is *placed* by the
            // drain before it is applied. If the cascade from the previous one is still
            // pending, drain it and stamp the transition at `quiescence + setup` — so a latch
            // always samples a settled cloud, and the period is the design's own number rather
            // than the nominal.
            self.queue.pop();
            if self.queue.is_empty() {
                self.apply_transition_now(due, kind)?;
                if is_rising {
                    run_cycles += 1;
                }
            } else {
                self.place_transition(due, kind)?;
            }
        }
        Ok(RunReport {
            cycles: run_cycles,
            t_obs: self.t_obs,
            top_paths: self.top_paths.clone(),
            trace_hash: self.trace_hash,
            events_processed: self.events_processed,
            clock_glitches: self.clock_glitches.clone(),
            net_width_mismatches: self.net_width_mismatches.clone(),
        })
    }

    /// Schedule an event (assigns the deterministic sequence number and
    /// priority class). A commit of a component **on a combinational cycle**
    /// goes in class 1, so at an equal timestamp every transport arrival is
    /// applied first; everything else is class 0 and keeps plain
    /// `(time, seq)` order. See `Ev::cmp` and the module docs' "Same-
    /// timestamp tie-break".
    fn schedule(&mut self, time: u64, kind: EvKind) {
        self.seq += 1;
        let prio = match &kind {
            EvKind::Fire { comp, .. } if self.cycle_comp[*comp as usize] => 1,
            _ => 0,
        };
        self.queue.push(Ev {
            time,
            prio,
            seq: self.seq,
            kind,
        });
    }

    /// Evaluate a component and (re-)schedule its output commit with
    /// inertial cancellation (module docs). `cause` is the input net
    /// whose change triggered this evaluation (path tracking).
    fn eval_and_schedule(&mut self, comp: u32, now: u64, cause: Option<u32>) -> Result<(), Halt> {
        let _ = cause;
        let c = comp as usize;
        let cd = &self.cdata[c];
        let beh = &self.comps[c];
        // `compat`: CE's `RAM.valueChanged` pushes **nothing at all** when the enable is
        // asserted but the address is not a valid value —
        //
        //     case PORT_ENABLE: case PORT_LOAD:
        //         if (!enabled || !load) { state.pushValue(getPort(PORT_DATA), noValue); }
        //     case PORT_ADDRESS:                       // falls through, no break
        //         if (enabled && load && address.isValidValue()) { ...push the word... }
        //         break;
        //
        // — so the link simply keeps the value it was last given (a port's drive is
        // *sticky*). Ours turned that into `X` (or let the floating-address `consume`
        // fire), which the old tool never produces, and one `X` on a memory output is
        // enough to poison a control word — `opcode` → `HALT` → the clock gate → a
        // spurious clock edge, which is what freezes `374625393` (docs/bugs.md Round 20).
        // Holding is therefore both faithful and conservative: the drive is left exactly
        // as it stands, i.e. no `Fire` is scheduled.
        if self.compat && matches!(cd.class, Class::Ram) {
            if let Some((addr_slot, _)) = cd.in_pins.first() {
                let addr = &self.views[c][*addr_slot];
                if addr.has_z() || addr.has_x() {
                    return Ok(());
                }
            }
        }
        let outs = if beh.is_splitter() {
            let nets: Vec<Cow<Value>> = cd
                .in_pins
                .iter()
                .map(|(_, net)| {
                    if self.compat {
                        // A splitter's view of its own pins is the *others'* merge, and a
                        // flattened boundary can hide some of those others (docs/bugs.md,
                        // Round 16: the splitter inside `373713172`'s `Selector` must not
                        // see — or drive — the outer instruction bus).
                        ec::resolve_except_visible(
                            &self.netlist,
                            &self.net_drivers,
                            &self.drives,
                            *net,
                            comp,
                            &self.netlist.comps[c].inst_path,
                        )
                    } else {
                        ec::resolve_except(
                            &self.netlist,
                            &self.net_drivers,
                            &self.drives,
                            *net,
                            comp,
                        )
                    }
                })
                .collect();
            // `CSIM_DEBUG_SPLITTER_SHAPE=1`: print every splitter's authored flags once.
            // A split whose only other drivers are splitters is the shape Round 11's
            // falsified rule targeted — count it before changing anything.
            if debug_splitter_shape() {
                static SEEN: std::sync::Mutex<Option<std::collections::BTreeSet<usize>>> =
                    std::sync::Mutex::new(None);
                let mut g = SEEN.lock().unwrap();
                let set = g.get_or_insert_with(std::collections::BTreeSet::new);
                if set.insert(c) {
                    let flags: Vec<String> = cd
                        .in_pins
                        .iter()
                        .enumerate()
                        .map(|(i, (_, net))| {
                            let n = self.net_drivers[net.idx()]
                                .iter()
                                .filter(|&&(d, _)| d as usize != c)
                                .count();
                            let auth = self.net_drivers[net.idx()].iter().any(|&(d, _)| {
                                d as usize != c && !self.comps[d as usize].is_splitter()
                            });
                            let port_w = self.netlist.nets[net.idx()].width as usize;
                            let map_len = beh.split_map_len(i).unwrap_or(port_w);
                            format!(
                                "{i}:{n}d{}w{}{}",
                                if auth { "A" } else { "-" },
                                port_w,
                                if map_len != port_w {
                                    format!("!M{map_len}")
                                } else {
                                    String::new()
                                }
                            )
                        })
                        .collect();
                    eprintln!("SPLITSHAPE #{c} pins[{}]", flags.join(" "));
                }
            }
            let outs = beh.eval_splitter(&nets);
            // `CSIM_DEBUG_SPLITTER=<comp idx>`: show what a splitter was handed and what
            // it drove. Env-gated, read once; inert otherwise.
            let watch = comp_matches(&self.netlist, c, &debug_spec("CSIM_DEBUG_SPLITTER"));
            if watch {
                let drv = |net: u32| {
                    self.net_drivers
                        .get(net as usize)
                        .map(|ds| {
                            ds.iter()
                                .map(|&(c, _)| {
                                    let k = &self.netlist.comps[c as usize];
                                    format!(
                                        "#{c}:{}",
                                        k.name.clone().unwrap_or_else(|| k.type_.clone())
                                    )
                                })
                                .collect::<Vec<_>>()
                                .join("+")
                        })
                        .unwrap_or_default()
                };
                let pins: Vec<String> = self.cdata[c]
                    .in_pins
                    .iter()
                    .map(|(_, n)| format!("{}:[{}]", drv(n.0), n.0))
                    .collect();
                let k = &self.netlist.comps[c];
                eprintln!("SPLIT #{comp}:{} at t={now} in-pin nets {pins:?}", k.def_id,);
                eprintln!(
                    "            handed [{}] -> drives [{}]",
                    nets.iter()
                        .map(|v| format!("{v}"))
                        .collect::<Vec<_>>()
                        .join(", "),
                    outs.iter()
                        .map(|v| format!("{v}"))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
            }
            outs
        } else {
            // Each input pin reads its own *view* of its net (per-path
            // transport, F14).
            let mut ins: Vec<Arc<Value>> = cd
                .in_pins
                .iter()
                .map(|(slot, _)| self.views[c][*slot].clone())
                .collect();
            // Combinational parts wait until every input has *arrived*
            // (module docs, §4.1). A `Z` view on a DRIVERLESS net can
            // never arrive — it is passed through so the behavior's
            // consume table decides (a mux's unselected input is not
            // consumed; a gate input is and halts). `Z` on a driven net
            // means "in flight or idle": wait only while the value is
            // still on its way (`net_in_flight`). An *idle* driven net —
            // every driver enabled off, i.e. a tri-state bus driving
            // nothing — is final, not in flight, so it must not stall the
            // part: a mux with a disabled buffer on its unselected input
            // used to wait forever and hold its output at `Z` instead of
            // passing the selected input through.
            //
            // A memory's ASYNCHRONOUS READ path waits the same way, on its
            // `addr` only (`din`/`we`/`clk` are edge inputs and must not stall
            // a read): a RAM/ROM whose address is still in flight holds its
            // output instead of judging a half-arrived `Z`. Without this, a
            // converted design halted at power-on on an address that was merely
            // in transit through a splitter — a `Z` on a *driven* net, which
            // the cycle-close sweep exists to tell apart from a real floating
            // read (`floating_sweep`, the never-driven oracle).
            let mut first_eval: Option<Vec<Value>> = None;
            if matches!(cd.class, Class::Comb | Class::Ram | Class::Rom) {
                // A `Z` may only stall the part if the part would *read* it: ask the
                // behavior's own consume table (`eval`). A `Z` it never reads — a mux's
                // unselected input, a disabled tri-state buffer's data — is not its
                // problem, and that is the whole point of a gated bus. Waiting on any
                // input instead deadlocked every converted design whose write-back path
                // gates a bus this way: the mux waited forever and held its output at `Z`
                // (then a consuming register stored `X`) rather than passing the selected
                // input through. `floating_sweep` already states this oracle — "muxes
                // consume only the selected input, disabled buffers nothing".
                //
                // A memory's asynchronous read path is the one exception: it waits on its
                // `addr` only (`din`/`we`/`clk` are edge inputs and must not stall a read),
                // so for RAM/ROM the pin is named directly rather than asked of `eval`.
                let wakes: Option<usize> = if cd.class == Class::Comb {
                    let refs: Vec<&Value> = ins.iter().map(|v| v.as_ref()).collect();
                    // **Evaluate once**: in the common case every input has arrived, so
                    // keep this result instead of asking the behaviour a second time below.
                    match beh.eval_with(&refs, false) {
                        Ok(outs) => {
                            first_eval = Some(outs);
                            None
                        }
                        Err(fr) => self.input_index_for(c, &fr.pin),
                    }
                } else {
                    cd.in_pins
                        .iter()
                        .position(|&(slot, _)| self.netlist.comps[c].pins[slot].pin == "addr")
                };
                let waiting = wakes.is_some_and(|i| {
                    let (_slot, net) = cd.in_pins[i];
                    ins[i].has_z()
                        && !self.netlist.nets[net.idx()].floating
                        && self.net_in_flight(net)
                });
                if waiting {
                    return Ok(());
                }
            }
            // A `Z` that survives the wait is on a net **nothing drives**: it is not in
            // flight, it never arrives. When a behaviour consumes such a pin, read it as
            // `X` — the model does not know, so it will not guess. The old tool let each
            // component pick a value for such a pin (its gates coalesce `Z` to 0, an
            // enable treats it as 1, a register stores `Z`); that choice belongs to the
            // *converter*, which writes it as an explicit constant driver, so the engine
            // never invents one. `pause_on_unknown` is the editor's "ask me first".
            match first_eval {
                Some(outs) => outs,
                None => {
                    let beh_ref = beh;
                    let compat = self.compat;
                    match self.eval_reading_unknowns(c, &mut ins, |refs| {
                        beh_ref.eval_with(refs, compat)
                    })? {
                        Some(outs) => outs,
                        // `compat`: CE pushes `Z` on every output of this part.
                        None => self.all_z_outputs(c),
                    }
                }
            }
        };
        if outs == self.pending_val[c] {
            return Ok(()); // already scheduled to commit exactly this
        }
        // `CSIM_DEBUG_COMP=<spec>`: narrate one part's every evaluation — the timestamp,
        // what it **read** (each input pin's *view*, which is the old tool's
        // `getLastReceived`), and what it drives. The per-cycle samplers stop at cycle
        // boundaries, but a register's latch decision is made *inside* one, against the
        // view it had at that instant; this is the instrument for "which value did it
        // take, and in what order did the parts around it run".
        if comp_matches(&self.netlist, c, &debug_spec("CSIM_DEBUG_COMP")) {
            let k = &self.netlist.comps[c];
            let qualified = if k.inst_path.is_empty() {
                k.def_id.clone()
            } else {
                format!("{}/{}", k.inst_path, k.def_id)
            };
            let ins: Vec<String> = cd
                .in_pins
                .iter()
                .map(|(slot, _)| self.views[c][*slot].to_string())
                .collect();
            eprintln!(
                "FIRE t={now} {qualified} {} reads [{}] -> drives [{}]",
                k.type_,
                ins.join(", "),
                outs.iter()
                    .map(|v| v.to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            );
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

    /// Is `net`'s current value still on its way in? True while any driver of the net has
    /// not yet committed what it drives — either it has produced no output at all, or it
    /// has a change queued on its propagation delay.
    ///
    /// `Z` means two different things and only this separates them: a value **in flight**
    /// (wait for it) and an **idle bus** — every driver enabled off, a tri-state part
    /// driving nothing. The second is final, so a part seeing that `Z` on a pin it does not
    /// even read must not stall on it (the conformance case is `mux_z_input`).
    fn net_in_flight(&self, net: NetId) -> bool {
        self.net_drivers[net.idx()]
            .iter()
            .any(|&(c, slot)| self.driver_in_flight(c as usize, slot))
    }

    /// Has `c` not yet committed the value it drives on output `slot`?
    fn driver_in_flight(&self, c: usize, slot: usize) -> bool {
        if self.pending_gen[c] == 0 {
            return true; // no output produced yet: the `Z` is the initial state, not a decision
        }
        self.cdata[c]
            .out_pins
            .iter()
            .position(|&(s, _)| s == slot)
            .is_some_and(|i| {
                self.pending_val[c]
                    .get(i)
                    .is_some_and(|pending| pending != &self.drives[c][slot])
            })
    }

    /// Everything a component has on one net arrives **together**.
    ///
    /// The engine delivers per pin (F14), so two pins of the same component that sit on the
    /// same net can be a path-delay apart in that component's views. CE has no such gap: it
    /// pushes a net's new value to every port on it, and a handler that reads another port of
    /// its own component reads that port's *last received* value. CE's `Register` is exactly
    /// this case — it detects the edge on `CLK` (`PORT_CLK` = 2) and reads
    /// `getLastReceived(ENABLE)` (`PORT_ENABLE` = 1) right there — so a register whose enable
    /// shares a net with its clock **is enabled at the edge**. Sampling our own
    /// not-yet-updated enable view instead left it disabled forever, which froze a converted
    /// design whose PC is clocked that way at power-on (see `en_on_clk_net_latches`).
    ///
    /// Only pins on the *same* net are touched, so per-path transport everywhere else is
    /// unchanged.
    fn arrive_together(&mut self, c: usize, slot: usize, net: u32) {
        // Most components have no *other* pin on the clock's net (the whole
        // point of the tie is the rare register whose enable shares the clock
        // net). Scan first so the common case does not allocate a slot list.
        if !self.cdata[c]
            .in_pins
            .iter()
            .any(|&(s, n)| n.idx() == net as usize && s != slot)
        {
            return;
        }
        let slots: Vec<usize> = self.cdata[c]
            .in_pins
            .iter()
            .filter(|&&(s, n)| n.idx() == net as usize && s != slot)
            .map(|&(s, _)| s)
            .collect();
        let value = self.views[c][slot].clone();
        for s in slots {
            self.views[c][s] = value.clone();
        }
    }

    /// The index (into a component's `in_pins`/input list) whose pin is named `pin` —
    /// `consume`'s error names the pin, and the caller needs the slot to substitute for.
    fn input_index_for(&self, c: usize, pin: &str) -> Option<usize> {
        self.cdata[c]
            .in_pins
            .iter()
            .position(|&(slot, _)| self.netlist.comps[c].pins[slot].pin == pin)
    }

    /// Evaluate a component, reading a floating net as `X` rather than faulting: only the
    /// pin the behaviour *actually consumed* is substituted, so an unselected mux input
    /// stays `Z` (the three-valued rule reads all data inputs to decide, and must not see
    /// an `X` it was never asked about). `max` bounds the retries by the input count.
    fn eval_reading_unknowns<T: Default>(
        &self,
        c: usize,
        ins: &mut [Arc<Value>],
        mut run: impl FnMut(&[&Value]) -> Result<T, FloatingRead>,
    ) -> Result<Option<T>, Halt> {
        for _ in 0..=ins.len() {
            let refs: Vec<&Value> = ins.iter().map(|v| v.as_ref()).collect();
            match run(&refs) {
                Ok(outs) => return Ok(Some(outs)),
                Err(fr) => {
                    let Some(i) = self.input_index_for(c, &fr.pin) else {
                        return Ok(Some(T::default())); // not an input pin: nothing to substitute
                    };
                    if self.pause_on_unknown {
                        return Err(self.halt_unknown(c as u32, &fr.pin));
                    }
                    if self.compat {
                        let repl = {
                            let refs: Vec<&Value> = ins.iter().map(|v| v.as_ref()).collect();
                            self.comps[c].z_compat(&fr.pin, refs[i], &refs)
                        };
                        match repl {
                            // CE reads this pin as a definite value: substitute and retry.
                            Some(v) => ins[i] = Arc::new(v),
                            // CE pushes `Z` on every output (a comparator with an invalid
                            // input, an all-`Z` gate): the caller returns all-`Z`.
                            None => return Ok(None),
                        }
                    } else {
                        // Production: an unknown stays unknown.
                        ins[i] = Arc::new(ins[i].z_to_x());
                    }
                }
            }
        }
        Ok(Some(T::default()))
    }

    /// Every output pin's value set to `Z`. CE's `valueChanged` pushes `Z` on all its
    /// outputs when a consumed input is invalid and the part has no coalescing rule
    /// (`compat` mode) — a comparator, a mux on a floating `sel`, and so on.
    fn all_z_outputs(&self, c: usize) -> Vec<Value> {
        self.cdata[c]
            .out_pins
            .iter()
            .map(|&(slot, _)| Value::z(self.netlist.comps[c].pins[slot].width))
            .collect()
    }

    /// The halt a **floating read** asks for (§4.1): a component read a net nothing
    /// drives, so the value it read is `X` — unknown. Every fact a person needs to find it
    /// is in the message: the component's **type**, its **name** when it has one, where it
    /// **lives** (circuit, and the instance path when it is nested), and which **pin** did
    /// the reading — because "a mux's `sel` is floating" and "a mux's `in6` is floating"
    /// are different problems.
    fn halt_unknown(&self, c: u32, pin: &str) -> Halt {
        let fc = &self.netlist.comps[c as usize];
        let doc = CompId(fc.def_idx as u32);
        let name = self
            .netlist
            .named
            .iter()
            .find(|n| n.circuit == fc.def_circuit && n.comp_id == doc)
            .map(|n| format!(" '{}'", n.name))
            .unwrap_or_default();
        Halt {
            reason: HaltReason::FloatingRead,
            cycle: self.rising_seen,
            details: format!(
                "{}{} ({}) at {}, pin '{}' — nothing drives that net, so the value read is \
                 X (unknown)",
                fc.type_,
                name,
                fc.origin(),
                fc.def_circuit,
                pin
            ),
        }
    }

    /// The pause a breakpoint asks for: same contract shape as
    /// [`DelayEngine::halt_unknown`], but a **soft** halt — see
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

    /// Make a halt the engine's state. Every reason but `Breakpoint` and `Stop` is
    /// **sticky**: the design is broken (or out of budget), so the engine
    /// refuses to run again until a load/reset. A **breakpoint** is not a
    /// fault at all — it is the pause the user asked for — so it is reported
    /// and then forgotten, and the very next `run`/`step_*` continues from
    /// exactly here (contract v1.2, `docs/ipc.md` §3). That is also why it
    /// can live mid-settle: the rest of the cycle is still queued. A **stop**
    /// (§8.4) is the same shape for the same reason: the design did what the
    /// caller was waiting for, which is not a fault, so the disarmed watch lets
    /// the caller carry on.
    fn record_halt(&mut self, h: &Halt) {
        if matches!(
            h.reason,
            HaltReason::Breakpoint | HaltReason::Stop | HaltReason::FloatingRead
        ) {
            return;
        }
        self.halted = Some(h.clone());
    }

    /// **A2 (`docs/derived-clock.md` section 10) instrument.** Fires if any *data* event is
    /// still queued when an edge is applied. The barrier's whole content is that an edge is
    /// only ever applied once the cascade it closes has been drained, so at that moment the
    /// queue holds nothing but clocks that are due later.
    ///
    /// Note what this is *not*. It is not "nothing earlier than the edge is still pending":
    /// that holds for free, because the queue is time-ordered, so popping the minimum can
    /// never leave an earlier event behind -- with or without a barrier. A2 was written that
    /// way first, and the barrier-disabled control run *passed*, which is how the mistake
    /// was caught; a test whose assertion is a property of the data structure rather than
    /// of the thing under test is worse than no test, because it reads like coverage.
    ///
    /// Two things are legitimately still queued, and both are *stimulus* rather than logic
    /// awaiting settlement:
    ///
    /// - a **poke** the testbench scheduled for a future time -- it is the caller injecting
    ///   a value at time `t`, not part of any cascade, and waiting for it would be wrong;
    /// - **clocks due later** -- the next half-edge, which is not a violation of anything.
    ///
    /// It is called by the *cycle-advancing* paths -- where the loop is about to apply an
    /// edge -- and checked there rather than inside `apply`, because `apply` cannot tell who
    /// called it. `run_until_time` strides to a *time* on the testbench's behalf rather than
    /// to a settled state and legitimately crosses an edge mid-cascade; it has no caller
    /// outside this file's tests, and if one ever appears, that assertion site is what should
    /// decide whether it is allowed to. (Being path-aware is not a convenience: put inside
    /// `apply`, this check fails `breakpoint_fires_on_arrival_not_on_level`, which strides
    /// across edges by design.)
    ///
    /// What it therefore pins is the *routing*: an edge with a cascade waiting must have gone
    /// through `fire_edge_without_overtaking`, so reaching a plain apply with logic still
    /// queued means the barrier did not do its job. That is a smaller claim than it looks,
    /// and it is the honest one -- the *behavioural* half of A2 (a latch samples a settled
    /// cloud) is A1's, B5's and B1/B3's, which all fail when the barrier is removed. This is
    /// the mechanism those tests have in common, asserted where it is decided.
    #[cfg(test)]
    fn assert_edge_does_not_overtake(&self, ev: &Ev) {
        // Only edges owe the barrier anything: a data event is applied by definition.
        if !matches!(ev.kind, EvKind::Clock { .. }) {
            return;
        }
        if let Some(e) = self
            .queue
            .iter()
            .find(|e| !matches!(e.kind, EvKind::Clock { .. } | EvKind::Poke { .. }))
        {
            panic!(
                "A2: an edge fired while an event at {} ({:?}) was still pending -- the \
                 barrier drains the cascade, never the testbench's future stimulus",
                e.time, e.kind
            );
        }
    }

    /// Report a component that drove a value whose width is not its pin's, once per net.
    ///
    /// The shape used to `panic!` inside `contention_merge` — `no run report`, no verdict at all —
    /// and stayed invisible unless the net happened to have two drivers (`docs/bugs-archive.md`). The
    /// value is now fitted to the pin and the merge yields `X` for any residual disagreement; this
    /// is the engine telling the user *which* part is the wrong width, and what the two widths are.
    fn note_net_width_mismatch(&mut self, net: u32, comp: u32, got: u32, want: u32) {
        if self
            .net_width_mismatches
            .iter()
            .any(|&(_, n, _, _, _)| n == net)
        {
            return;
        }
        self.net_width_mismatches
            .push((self.rising_seen, net, CompId(comp), got, want));
    }

    /// Fold one `clk`-pin delivery into the part's clock bookkeeping, returning `true` when it
    /// is a rising edge to take.
    ///
    /// **A clocked part takes at most one edge per instant, and only if the instant *entered*
    /// with the clock at a definite low.** A `1 -> 0 -> 1` inside one instant therefore takes no
    /// edge, while a low at an earlier instant still arms the rise after it — which is the
    /// distinction that matters: this engine *delivers* every change and CircuitSim CE's
    /// round-based iteration coalesces a round, so an instant that began high and recovered is a
    /// transient, whereas a rise after a real low is a genuine edge (`docs/bugs-archive.md`,
    /// `docs/derived-clock.md` §11).
    ///
    /// The delivery is also counted, so a clock driven more than once inside one instant is
    /// *reported* rather than silent (`clock_glitches`) — never acted on beyond the rule above.
    fn clock_delivery(&mut self, c: usize, level: Bit, now: u64) -> bool {
        if self.clk_change_at[c] != Some(now) {
            // A new instant enters with the level the previous one ended at.
            self.clk_entry_low[c] = self.clk_last_low[c];
            self.clk_change_at[c] = Some(now);
            self.clk_changes[c] = 0;
        }
        self.clk_changes[c] += 1;
        if self.clk_changes[c] == 2 && !self.in_boot {
            self.clock_glitches
                .push((self.rising_seen, CompId(c as u32)));
        }
        match level {
            Bit::One => {
                let edge = self.clk_entry_low[c];
                self.clk_entry_low[c] = false; // at most one edge per instant
                self.clk_last_low[c] = false;
                edge
            }
            Bit::Zero => {
                self.clk_last_low[c] = true;
                false
            }
            // A floating clock holds both the level and the entry: a hiccup, not a level.
            _ => false,
        }
    }

    /// Apply one event (the queue's minimum).
    fn apply(&mut self, ev: Ev) -> Result<(), Halt> {
        self.now = ev.time;
        // Cycle close at apply time (events are processed in time order):
        // closing on peek would be premature when the run loop stops
        // *before* a boundary-edge it only looked at. No cycle accounting
        // during the boot settle.
        // There is no time-based cycle boundary any more: the cycle is closed by the edge
        // itself (`EvKind::Clock`), which the barrier only fires once the cascade has
        // settled. This used to spin here waiting for `next_boundary` to be passed — and
        // since `close_cycle` no longer advances it, that loop never terminated.
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
                // The cycle that just ended is closed **at the edge** — the barrier below
                // guarantees the cascade has settled, so this is the state a grader reads.
                if !self.in_boot {
                    self.close_cycle()?;
                }
                self.cycle_start = ev.time;
                self.next_rising = !phase;
                for i in 0..self.clock_comps.len() {
                    let c = self.clock_comps[i];
                    self.comps[c as usize].set_phase(phase);
                    self.eval_and_schedule(c, ev.time, None)?;
                }
                // The successor is **due immediately**, and *placed* by the drain
                // (`place_transition`). The nominal period is the timeline's origin now, not
                // a rate (docs/derived-clock.md §3).
                self.schedule(ev.time + MIN_STEP, EvKind::Clock { phase: !phase });
                if phase {
                    // **The derived period** (`docs/derived-clock.md` §3): `t_obs` is the
                    // maximum rise-to-rise interval -- the clock rate the design can actually
                    // be run at. Both edges are placed by the drain now, so this *is*
                    // `depth + setup`: the two numbers are one number.
                    if let Some(prev) = self.last_rise {
                        self.t_obs = self.t_obs.max(ev.time - prev);
                    }
                    self.last_rise = Some(ev.time);
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
                let mut outs = std::mem::take(&mut self.pending_val[c]);
                // Pending committed; make a same-valued placeholder so a
                // later identical recomputation is a no-op.
                self.pending_val[c] = outs.clone();
                let out_pins = std::mem::take(&mut self.cdata[c].out_pins);
                let mut affected = std::mem::take(&mut self.scratch_affected);
                affected.clear();
                for (i, (slot, net)) in out_pins.iter().enumerate() {
                    // A behaviour must drive its pin at the pin's width (CE builds every port's
                    // value at its link's width: `new WireValue(value, bitSize)`). A disagreement
                    // is *reported* and *fitted* here — the one choke point — so it neither
                    // panics the merge nor spreads (`docs/bugs-archive.md`).
                    let want = self.netlist.comps[c].pins[*slot].width;
                    if outs[i].width() != want {
                        self.note_net_width_mismatch(net.0, comp, outs[i].width(), want);
                        outs[i] = outs[i].fitted(want);
                    }
                    self.drives[c][*slot] = outs[i].clone();
                    if !affected.contains(&net.0) {
                        affected.push(net.0);
                    }
                }
                self.cdata[c].out_pins = out_pins;
                let cause = (comp, self.pending_cause[c]);
                for &net in &affected {
                    let resolved = Arc::new(ec::resolve(
                        &self.netlist,
                        &self.net_drivers,
                        &self.drives,
                        NetId(net),
                    ));
                    // Transport: compare against the last *scheduled* value
                    // for this net, not the currently applied one (see
                    // `net_scheduled` field docs).
                    if *resolved != self.net_scheduled[net as usize] {
                        self.net_scheduled[net as usize] = (*resolved).clone();
                        // The shared "latest" slot applies at the earliest
                        // sink's arrival; each sink pin's *view* is
                        // delivered at its own path delay (F14). The same
                        // `resolved` is shared with every delivery — `Arc`
                        // clone, not a 100-byte `Value` clone per sink.
                        let nidx = net as usize;
                        let at = ev.time + self.net_min_delay[nidx];
                        self.schedule(
                            at,
                            EvKind::Net {
                                net,
                                value: Arc::clone(&resolved),
                            },
                        );
                        // Causal pointer lands at apply time (below).
                        self.pending_net_cause.push((net, cause));
                        // Schedule each delivery directly (no intermediate `Vec`):
                        // `SinkPin` is `Copy`, so an indexed loop avoids the
                        // per-net-transition allocation without borrowing `self`
                        // twice.
                        for i in 0..self.net_sinks[nidx].len() {
                            let sp = self.net_sinks[nidx][i];
                            // `compat`: CE delivers **`getIncomingValue(port)`** — the
                            // merge of the *other* participants on the link, excluding the
                            // receiving **port** (`LinkState.propagate`:
                            // `participants.forEach((p, info) -> { if (p != port) ... })`).
                            // So a part that both drives and consumes a net reads the
                            // *others'* value for it — excluding its own **pin**, not the
                            // whole part: a gate feeding its own input still sees its own
                            // output (`g.out` is a different port), which is why that stays
                            // an oscillation rather than becoming a self-ignore.
                            // Production keeps the all-drivers merge until this is measured
                            // on the corpus; `compat` is where CE's reading belongs.
                            let value = if self.compat {
                                let reader_path = &self.netlist.comps[sp.comp as usize].inst_path;
                                let mut others: Vec<Value> = Vec::new();
                                for &(d, sl) in &self.net_drivers[nidx] {
                                    if d == sp.comp && sl as u32 == sp.slot {
                                        continue; // CE excludes the receiving *port*
                                    }
                                    // …and a flattened subcircuit boundary hides the far
                                    // side (`Netlist::driver_visible`, docs/bugs.md Round
                                    // 16): the inner splitter's drive must not reach a
                                    // reader outside the instance, nor an outer drive a
                                    // reader inside it.
                                    if !self.netlist.driver_visible(
                                        NetId(net),
                                        &self.netlist.comps[d as usize].inst_path,
                                        reader_path,
                                    ) {
                                        continue;
                                    }
                                    others.push(self.drives[d as usize][sl].clone());
                                }
                                let (merged, shorted) = Value::contention_merge_detail(
                                    self.netlist.nets[nidx].width,
                                    &others,
                                );
                                // CE: a port whose own incoming merge disagrees is simply
                                // **not notified** (`LinkState.propagate` catches the
                                // `ShortCircuitException` and `continue`s), so it keeps the
                                // view it had; only the all-drivers merge — used for the
                                // short check and the final throw at quiescence — is ever
                                // "short". Delivering the disagreement as `X` instead is what
                                // made an `X` stick: CE has no `X` to undo it with.
                                if shorted {
                                    continue;
                                }
                                Arc::new(merged)
                            } else {
                                Arc::clone(&resolved)
                            };
                            self.schedule(
                                ev.time + self.net_sink_delay[nidx][i],
                                EvKind::Deliver {
                                    net,
                                    comp: sp.comp,
                                    slot: sp.slot,
                                    kind: sp.kind,
                                    value,
                                },
                            );
                        }
                    }
                }
                self.scratch_affected = affected;
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
                self.net_values[n] = (*value).clone();
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
                self.views[comp as usize][slot as usize] = Arc::clone(&value);
                // `rising_seen > 0`: nothing is measured before the first edge. Under the
                // derived clock the first edge is deferred until the initial cascade has
                // settled, so without this the whole boot stretch is measured from
                // `cycle_start == 0` — t_obs 2990 instead of 990 on the overclocked-chain
                // fixture.
                if !self.in_boot && self.rising_seen > 0 && self.state_input_net[net as usize] {
                    let cycle_start = self.cycle_start;
                    let dt = ev.time - cycle_start;
                    if std::env::var("CSIM_DEBUG_SETTLE").is_ok() {
                        eprintln!(
                            "SETTLE t={} cycle_start={} dt={} rising_seen={} in_boot={}",
                            ev.time, cycle_start, dt, self.rising_seen, self.in_boot
                        );
                    }
                    if dt > self.cycle_settle {
                        self.cycle_settle = dt;
                        self.cycle_settle_net = Some(net);
                    }
                }
                self.react(comp, net, slot as usize, kind, ev.time)?;
            }
            EvKind::Poke { comp, value } => {
                self.comps[comp as usize].set_pin_value((*value).clone());
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
                    self.eval_and_schedule(comp, time, Some(net))?;
                }
                // `din`/`we` only matter at the edge; there is nothing to do on arrival.
                SinkKind::Din | SinkKind::We => {}
                // CE's `PORT_CLEAR` is level-sensitive too (`RAM.java`): while it is
                // an exact `1` every word is cleared at once, not at the next edge.
                SinkKind::Rst => {
                    let rst = self.views[c][slot].clone();
                    if !rst.has_z() && rst.bit(0) == Bit::One {
                        self.comps[c].clear_ram();
                    }
                    self.eval_and_schedule(comp, time, Some(net))?;
                }
                SinkKind::Clk => {
                    let cur = self.cdata[c]
                        .clk_slot
                        .map(|slot| self.views[c][slot].bit(0))
                        .unwrap_or(Bit::Z);
                    if self.clock_delivery(c, cur, time) {
                        self.arrive_together(c, slot, net);
                        self.clock_edge(comp, time)?;
                    }
                }
                _ => {}
            },
            Class::Register => match pin {
                // `d` only matters at the edge; nothing happens on arrival.
                SinkKind::D => {}
                SinkKind::Clk => {
                    let cur = self.cdata[c]
                        .clk_slot
                        .map(|slot| self.views[c][slot].bit(0))
                        .unwrap_or(Bit::Z);
                    if self.clock_delivery(c, cur, time) {
                        self.arrive_together(c, slot, net);
                        self.clock_edge(comp, time)?;
                    }
                }
                // CE's reset (`ZERO`) is **level-sensitive and asynchronous**:
                // asserting it pushes `0` to `q` and stores `0` at once, with
                // priority over the clock (behavior.rs's `Register` eval forces the
                // output low while `rst` is an exact 1). Doing it here — and then
                // re-evaluating — makes the reset visible *within* the cycle rather
                // than only at the next edge, which is what lets a design use `rst`
                // as a pipeline flush (clear the buffer before the next buffer can
                // latch the in-flight instruction). CE tests `== State.ONE`, so an
                // `X`/`Z` reset does not reset (a converted design drives it).
                SinkKind::Rst => {
                    let rst = self.views[c][slot].clone();
                    if !rst.has_z() && rst.bit(0) == Bit::One {
                        if let Some(w) = self.comps[c].register_value().map(|v| v.width()) {
                            self.comps[c].set_register(Value::zero(w));
                        }
                    }
                    self.eval_and_schedule(comp, time, Some(net))?;
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
                if !self.in_boot && self.breakpoints_enabled {
                    if let Some(target) = self.comps[c].breakpoint_value() {
                        // Pin order is the registry's: `in`, then `en`
                        // (components.rs). The delivery updated `views` before
                        // calling us, so the data pin already holds the new
                        // value and the enable reads as of this instant.
                        let (data_slot, _) = self.cdata[c].in_pins[0];
                        let (en_slot, _) = self.cdata[c].in_pins[1];
                        let enabled = self.views[c][en_slot].bit(0) != Bit::Zero;
                        if slot == data_slot
                            && enabled
                            && self.views[c][data_slot].as_ref() == target
                        {
                            return Err(self.halt_breakpoint(comp));
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Rising clock edge on a register/RAM: setup check (data inputs
    /// include `we` for RAM, F11), latch/write (consuming `Z` halts),
    /// schedule the output commit.
    fn clock_edge(&mut self, comp: u32, time: u64) -> Result<(), Halt> {
        let c = comp as usize;
        // Sample inputs from the pins' *views* and latch (consume rules
        // fire here).
        let mut ins: Vec<Arc<Value>> = self.cdata[c]
            .in_pins
            .iter()
            .map(|(slot, _)| self.views[c][*slot].clone())
            .collect();
        // The edge path reads `d`/`din`, so a `Z` here is a value *about to be stored*.
        // It is read as `X`: a register that samples a floating input holds X, which is
        // the electrical truth (and only surfaces in the verdict if something reads it).
        let mut attempts = 0;
        loop {
            let refs: Vec<&Value> = ins.iter().map(|v| v.as_ref()).collect();
            // `compat` uses CE's edge (docs/bugs.md): a floating data pin is latched as
            // `Z` rather than promoted to `X`, which no consumer can recover from.
            let edge = if self.compat {
                self.comps[c].rising_edge_compat(&refs)
            } else {
                self.comps[c].rising_edge(&refs)
            };
            match edge {
                Ok(()) => break,
                Err(fr) => {
                    attempts += 1;
                    let Some(i) = self.input_index_for(c, &fr.pin) else {
                        break;
                    };
                    if self.pause_on_unknown {
                        return Err(self.halt_unknown(comp, &fr.pin));
                    }
                    // `compat`: CE's own reading of this pin (`Behavior::z_compat`) where
                    // it has one; otherwise the production `X`. (CE would store `Z` for a
                    // floating data pin and a register would hold `Z`; the edge path keeps
                    // `X` — a documented limit of this diagnostic.)
                    let repl = if self.compat {
                        let refs: Vec<&Value> = ins.iter().map(|v| v.as_ref()).collect();
                        self.comps[c].z_compat(&fr.pin, refs[i], &refs)
                    } else {
                        None
                    };
                    ins[i] = Arc::new(repl.unwrap_or_else(|| ins[i].z_to_x()));
                    if attempts > ins.len() {
                        break;
                    }
                }
            }
        }
        // Q / dout commit after clk→Q / access (gen-guarded: last edge wins).
        self.eval_and_schedule(comp, time, None)?;
        Ok(())
    }

    /// Close the current cycle at a clock boundary: per-consumer
    /// floating sweep, then record DTA results and advance the boundary.
    fn close_cycle(&mut self) -> Result<(), Halt> {
        self.floating_sweep()?;
        self.record_cycle();
        // The boundary is the edge itself (the `EvKind::Clock` arm closes the cycle);
        // a nominal period no longer advances anything.
        Ok(())
    }

    /// Fold the current cycle's settle into the critical-path record (the period `t_obs`
    /// `top_paths` and reset the per-cycle counters (without advancing
    /// the boundary — also called at run end for the final in-progress
    /// cycle, F7).
    fn record_cycle(&mut self) {
        if self.cycle_settle > 0 {
            // The *settle* is what a critical path's `delay_ns` is; the period `t_obs` reports
            // is the rise-to-rise interval, folded where the rising edge is applied.
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
            // Most components have no floating input at cycle close, so scan the views
            // first and only build the owned input list when there is a `Z` to substitute
            // or report. The old code cloned every input for every combinational part on
            // every cycle close.
            let mut any_z = false;
            let mut candidate = false;
            for &(slot, net) in &cd.in_pins {
                if self.views[c][slot].has_z() {
                    any_z = true;
                    if !(self.net_ever_driven[net.idx()] || !self.netlist.nets[net.idx()].floating)
                    {
                        candidate = true;
                        break;
                    }
                }
            }
            if !any_z || !candidate {
                continue;
            }
            let mut ins: Vec<Arc<Value>> = cd
                .in_pins
                .iter()
                .map(|(slot, _)| self.views[c][*slot].clone())
                .collect();
            for (v, &(_, net)) in ins.iter_mut().zip(cd.in_pins.iter()) {
                if v.has_z()
                    && (self.net_ever_driven[net.idx()] || !self.netlist.nets[net.idx()].floating)
                {
                    *v = Arc::new(Value::zero(v.width()));
                }
            }
            let ins_refs: Vec<&Value> = ins.iter().map(|v| v.as_ref()).collect();
            match beh.eval_with(&ins_refs, self.compat) {
                Ok(_) => {}
                Err(fr) => {
                    if self.pause_on_unknown {
                        // The cycle-close oracle for a component that never got an event: same
                        // event as the eager path's, so the same pause and the same message.
                        return Err(self.halt_unknown(c as u32, &fr.pin));
                    }
                }
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
                value.fold_bytes(|b| mix(b));
            }
            EvKind::Poke { comp, value } => {
                mix(&[3]);
                mix(&comp.to_le_bytes());
                value.fold_bytes(|b| mix(b));
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
                value.fold_bytes(|b| mix(b));
            }
        }
        self.trace_hash = h;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::load_document;
    use crate::netlist;

    /// Per-cycle architectural trace of a design, for diffing one converted CPU against
    /// another (or against the old tool's trace): `PROBE_DOC` = the `.csx`, `PROBE_CYCLES`
    /// = how many cycles (default 200), `PROBE_PC` = the program-counter register's name
    /// (default `PC-IF`, the pipelined designs'; the multicycle ones call it `PC`). Prints
    /// `TRACE <cycle> <PC>,<r1..r15>`; a no-op when `PROBE_DOC` is unset, so it costs
    /// nothing in an ordinary `cargo test`.
    ///
    /// This is the per-*cycle* companion to `csim nets` (which snapshots one net or part):
    /// diffing two of these finds the first instruction a conversion gets wrong, and the
    /// register it gets wrong, which is how the multicycle conversion's write-path bugs
    /// were found.
    #[test]
    fn probe_trace() {
        let path = std::env::var("PROBE_DOC").unwrap_or_default();
        if path.is_empty() {
            return;
        }
        let text = std::fs::read_to_string(&path).expect("probe doc");
        let doc = crate::format::load_document(text.as_bytes()).expect("probe doc parses");
        let nl = crate::netlist::build(&doc).expect("probe netlist");
        let table_name =
            std::env::var("PROBE_TABLE").unwrap_or_else(|_| "cs2200-74ls-v1".to_string());
        let table = TimingTable::builtin(&table_name).expect("probe table");
        // `PROBE_COMPAT` builds the engine with CE's floating-read reading applied from
        // construction (the boot settle included), so a trace can be diffed against CE in
        // the mode the corpus is graded under.
        let compat = matches!(
            std::env::var("PROBE_COMPAT").as_deref(),
            Ok(v) if v != "0" && !v.is_empty()
        );
        let mut eng = if compat {
            DelayEngine::new_compat(nl, 1000, &table)
        } else {
            DelayEngine::new(nl, 1000, &table)
        }
        .expect("probe engine");
        let cycles: u64 = std::env::var("PROBE_CYCLES")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(200);
        let regs = [
            "$at", "$v0", "$a0", "$a1", "$a2", "$t0", "$t1", "$t2", "$s0", "$s1", "$s2", "$k0",
            "$sp", "$fp", "$ra",
        ];
        // Match on the *trimmed* name: the old tool's labels routinely carry leading or
        // trailing spaces (`" $a0"`, `"IR "`), and the suffix is what identifies the part,
        // so a stray space silently turning a whole column into `?` is a trap.
        let pick = |suffix: &str| -> Option<String> {
            eng.netlist()
                .named
                .iter()
                .filter(|n| n.kind == crate::api::NamedKind::Register)
                .map(|n| n.name.clone())
                .find(|n| {
                    let bare = n.rsplit('/').next().unwrap_or(n).trim();
                    bare == suffix.trim()
                })
        };
        // `PROBE_NAMES` (comma-separated suffixes) overrides the default register list,
        // so any named part can be traced: pipeline latches, control words, memories.
        let extra = std::env::var("PROBE_NAMES").unwrap_or_default();
        let wanted: Vec<String> = if extra.is_empty() {
            regs.iter().map(|r| r.to_string()).collect()
        } else {
            extra.split(',').map(|x| x.trim().to_string()).collect()
        };
        let names: Vec<String> = wanted.iter().filter_map(|r| pick(r)).collect();
        // The pipelined designs name it `PC-IF`, the multicycle ones `PC`; `PROBE_PC`
        // overrides, so any named register can serve as the instruction boundary.
        let pc_wanted = std::env::var("PROBE_PC").unwrap_or_else(|_| "PC-IF".to_string());
        let pc = pick(&pc_wanted)
            .unwrap_or_else(|| panic!("no named register '{pc_wanted}' — set PROBE_PC"));
        // `PROBE_NETS` (comma-separated **wire names**, i.e. the new tool's tunnels)
        // appends each named net's resolved value to every row. A name is a label, not a
        // merging rule, so more than one net can carry it (one per subcircuit instance):
        // all of them are shown, joined by `|`, and an unmatched name prints `?` rather
        // than silently shifting columns. This is the *net* companion of `PROBE_NAMES`
        // and the engine-side half of the old tool's `TRACE_TUNNELS` diff.
        let net_labels: Vec<String> = std::env::var("PROBE_NETS")
            .unwrap_or_default()
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        // `PROBE_RAW` (same spelling) appends `merged|ok|SHORT` per labelled net — the
        // engine-side twin of the old tracer's `TRACE_RAW`, so the two read side by side.
        let raw_labels: Vec<String> = std::env::var("PROBE_RAW")
            .unwrap_or_default()
            .split(',')
            .map(|x| x.trim().to_string())
            .filter(|x| !x.is_empty())
            .collect();
        if !net_labels.is_empty() || !raw_labels.is_empty() {
            let mut head = format!("TRACEHEAD cycle,{pc_wanted}");
            for n in &names {
                head.push(',');
                head.push_str(n);
            }
            for l in &net_labels {
                head.push(',');
                head.push_str(l);
            }
            for l in &raw_labels {
                head.push(',');
                head.push_str(l);
                head.push_str("(merged|short)");
            }
            println!("{head}");
        }
        for i in 0..=cycles {
            if i > 0 {
                let _ = eng.run(1);
            }
            // A value that is not a clean number prints `?`, exactly as the old tracer's
            // `get()` does when a `WireValue` has a `Z` (or here an `X`). Rendering an
            // all-`Z` value as `0` — which `to_u64().unwrap_or(0)` silently did — hides the
            // one thing a trace is for; the four-state detail is `PROBE_RAW`/`PROBE_NETS`.
            let render = |v: Option<Value>| match v {
                None => "?".to_string(),
                Some(v) if v.has_x() || v.has_z() => "?".to_string(),
                Some(v) => format!("{:X}", v.to_u64().unwrap_or(0)),
            };
            let row: Vec<String> = std::iter::once(render(eng.named_value(&pc)))
                .chain(names.iter().map(|n| render(eng.named_value(n))))
                .chain(net_labels.iter().map(|l| {
                    let vs = eng.net_values_by_label(l);
                    if vs.is_empty() {
                        "?".to_string()
                    } else {
                        vs.into_iter()
                            .map(|v| render(Some(v)))
                            .collect::<Vec<_>>()
                            .join("|")
                    }
                }))
                .chain(raw_labels.iter().map(|l| {
                    let rs = eng.net_raw_by_label(l);
                    if rs.is_empty() {
                        "?".to_string()
                    } else {
                        rs.join("|")
                    }
                }))
                .collect();
            println!("TRACE {i} {}", row.join(","));
        }
    }

    pub(super) fn engine(json: &str, clock_start: u64) -> DelayEngine {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        let table = TimingTable::builtin("cs2200-74ls-v1").unwrap();
        DelayEngine::new(nl, clock_start, &table).expect("test engine builds")
    }

    /// The same, with the `compat` diagnostic set *before* the boot settle.
    pub(super) fn compat_engine(json: &str, clock_start: u64) -> DelayEngine {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        let table = TimingTable::builtin("cs2200-74ls-v1").unwrap();
        DelayEngine::build(nl, clock_start, &table, true).expect("test engine builds")
    }

    /// The built-in table with wire propagation **on** (`wire.num = 1`).
    ///
    /// The shipped table disables wire delay (`num = 0`, Head-TA decision), so the tests
    /// that pin the per-path transport machinery — path lengths, stub branches, narrow
    /// pulses — build their own copy with the wires back on. Nothing else should use this.
    pub(super) fn wired_table() -> TimingTable {
        let mut v: serde_json::Value =
            serde_json::from_str(include_str!("../data/cs2200-74ls-v1.json")).unwrap();
        v["wire"]["num"] = serde_json::json!(1);
        TimingTable::from_json(&v.to_string()).unwrap()
    }

    /// As `engine`, but with wire propagation on.
    pub(super) fn wired_engine(json: &str, clock_start: u64) -> DelayEngine {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        DelayEngine::new(nl, clock_start, &wired_table()).expect("test engine builds")
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
        // The half-period is the timeline's origin now; the period is derived.
        let mut eng = engine(&pipeline_json(), 500);
        let rep = eng.run(3).unwrap();
        assert_eq!(rep.cycles, 3);
        assert_eq!(rep.t_obs, 54, "clk→Q 20 + not 9 + and 10 + setup 15");
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

    /// A register's reset is level-sensitive (CE's `Register.valueChanged`): asserting it
    /// *between* clock edges must drive `q` low and store 0 at once — that is what lets a
    /// design use `rst` as a pipeline flush (the `wrong-value` rows that wrote back the
    /// instruction after `halt`).
    #[test]
    fn register_reset_is_level_sensitive() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"rst","type":"wiring.pin","pos":[0,0],"name":"rst"}},
                {{"id":"r1","type":"mem.register","pos":[0,0],"name":"r1"}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"rst","pin":"pin"}},"b":{{"comp":"r1","pin":"rst"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(3).unwrap();
        assert_eq!(eng.named_value("out"), Some(k(1, 1)), "latched `one`");
        // Assert the reset *between* clock edges: no edge is consumed.
        assert!(eng.poke_input_pin("rst", k(1, 1)));
        eng.settle_cycle().unwrap();
        assert_eq!(
            eng.named_value("out"),
            Some(k(1, 0)),
            "reset drives q low within the cycle"
        );
        assert_eq!(
            eng.named_value("r1"),
            Some(k(1, 0)),
            "and stores 0, as CE's putComponentProperty does"
        );
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
        // Wire propagation on for this one: the per-path transport machinery is what it
        // tests (the shipped table disables wire delay).
        let mut eng = wired_engine(&json, 5000);
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
        // Wires on for this one: the per-path transport machinery is its subject (the
        // shipped table disables wire delay).
        let mut eng = wired_engine(&json, 5000);
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
        // `num` too: the shipped table ships it 0 (wire delay disabled), and this test's
        // whole subject is that the constant is data.
        custom["wire"]["num"] = serde_json::json!(1);
        custom["wire"]["den"] = serde_json::json!(1);
        let table = TimingTable::from_json(&custom.to_string()).unwrap();
        let mut eng = DelayEngine::new(nl, 5000, &table).unwrap();
        assert!(eng.poke_at("src", k(1, 1), 100));
        eng.run_until_time(300).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 0)));
        eng.run_until_time(301).unwrap();
        assert_eq!(eng.named_value("d"), Some(k(1, 1))); // edge @100+200
    }

    /// A register whose `d` is a pokeable named pin: the fixture the stop-condition
    /// tests watch.
    fn watchy_json() -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"d","type":"wiring.pin","pos":[0,0],"name":"d"}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"d","pin":"pin"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        )
    }

    /// `stable` is the shape of both CS 2200 CPU rules (the EC pipeline's "PC unchanged
    /// for N ticks", project 1's "the microcode state register stopped changing"), and it
    /// is what makes a cycle count to completion reportable: the stop *is* the end.
    #[test]
    fn watch_stable_stops_the_run_and_reports_both_cycles() {
        use crate::api::Watch;
        let mut eng = engine(&watchy_json(), 50);
        eng.set_watch(&[Watch::Stable {
            name: "r".into(),
            cycles: 3,
        }])
        .expect("installs");
        let err = eng.run(100).unwrap_err();
        assert_eq!(err.reason, HaltReason::Stop);
        let info = eng.stop_info().cloned().expect("stop recorded");
        assert_eq!((info.name.as_str(), info.when.as_str()), ("r", "stable"));
        assert_eq!(info.value, "0x0");
        // Detected `cycles` boundaries after the value last moved; the course graders
        // report that last-move cycle, so both are carried.
        assert_eq!(info.last_change_cycle, Some(0));
        assert_eq!(info.at_cycle, 3);
        assert_eq!(err.cycle, 3, "the halt's cycle is the stop's cycle");
    }

    /// `changes` is the other half of the CS 2200 rule pair: `MAX_INSTR_COUNT = 10000`
    /// instructions, counted as moves of the PC. It exists so a grader can bound a runaway
    /// *without* guessing a cycle budget — a too-small `--cycles` reports a working design
    /// as hung, which is what a 30,000 cap did to submissions that legitimately run 32,312.
    #[test]
    fn watch_changes_counts_moves() {
        use crate::api::Watch;
        // The fixture latches `d` at the edge @200, so a poke at 190 is exactly one move
        // of `r`: `count: 1` stops on it, `count: 2` never does.
        for (count, stops) in [(1u64, true), (2, false)] {
            let mut eng = engine(&watchy_json(), 50);
            eng.set_watch(&[Watch::Changes {
                name: "r".into(),
                count,
            }])
            .expect("installs");
            assert!(eng.poke_at("d", k(1, 1), 190));
            let out = eng.run(10);
            assert_eq!(out.is_err(), stops, "count={count}");
            if stops {
                let info = eng.stop_info().cloned().expect("stop recorded");
                assert_eq!((info.name.as_str(), info.when.as_str()), ("r", "changes"));
                assert_eq!(
                    info.at_cycle, 1,
                    "the derived clock closes the cycle AT the edge, so the latch is boundary 1"
                );
                assert_eq!(info.last_change_cycle, Some(1));
            }
        }
        // A value that never moves is not a change: `is`-like, the first boundary only
        // observes, so a settled register counts zero.
        let mut eng = engine(&watchy_json(), 50);
        eng.set_watch(&[Watch::Changes {
            name: "r".into(),
            count: 1,
        }])
        .expect("installs");
        assert!(
            eng.run(10).is_ok(),
            "a still register is not an instruction"
        );
    }

    /// `reaches` fires on the *transition*: a value that already held it when the run
    /// started is not a stop, exactly like `debug.breakpoint` (format-v2 §9).
    #[test]
    fn watch_reaches_ignores_the_value_it_started_with() {
        use crate::api::Watch;
        let mut eng = engine(&watchy_json(), 50);
        eng.set_watch(&[Watch::Reaches {
            name: "r".into(),
            value: "0".into(),
        }])
        .expect("installs");
        assert!(eng.run(10).is_ok(), "holding the value is not a stop");
        eng.set_watch(&[Watch::Reaches {
            name: "r".into(),
            value: "1".into(),
        }])
        .expect("installs");
        assert!(eng.poke_at("d", k(1, 1), 190));
        let err = eng.run(10).unwrap_err();
        assert_eq!(err.reason, HaltReason::Stop);
        assert_eq!(eng.stop_info().unwrap().value, "0x1");
    }

    /// `is` is the level form, and — as the old tester's `Clock.tickUntil` does — it is
    /// satisfied *before* the first tick too. That is the whole difference from
    /// `reaches`.
    #[test]
    fn watch_is_fires_on_a_level_and_can_hold_before_any_cycle() {
        use crate::api::Watch;
        let mut eng = engine(&watchy_json(), 50);
        eng.set_watch(&[Watch::Is {
            name: "r".into(),
            value: "0".into(),
        }])
        .expect("installs");
        assert_eq!(eng.run(100).unwrap_err().cycle, 0);
        // `stable(1)` needs one boundary of *history*, so it fires a cycle later.
        let mut eng = engine(&watchy_json(), 50);
        eng.set_watch(&[Watch::Stable {
            name: "r".into(),
            cycles: 1,
        }])
        .expect("installs");
        assert_eq!(eng.run(100).unwrap_err().cycle, 1);
    }

    /// A watch that held is disarmed, so a caller that carries on — "run until halt",
    /// then play again — is not stopped forever by a condition that is still true.
    /// `stop_info` keeps reporting what happened, for the report.
    #[test]
    fn a_fired_watch_is_disarmed_but_still_reported() {
        use crate::api::Watch;
        let mut eng = engine(&watchy_json(), 50);
        eng.set_watch(&[Watch::Is {
            name: "r".into(),
            value: "0".into(),
        }])
        .expect("installs");
        assert_eq!(eng.run(100).unwrap_err().reason, HaltReason::Stop);
        eng.run(5).expect("the watch was spent, not sticky");
        assert_eq!(eng.stop_info().unwrap().when, "is");
    }

    /// A watch names what `probe('…')` reads, and a typo fails the run rather than
    /// silently never stopping.
    #[test]
    fn a_watch_validates_its_name_and_literal() {
        use crate::api::Watch;
        let mut eng = engine(&watchy_json(), 50);
        let err = eng
            .set_watch(&[Watch::Stable {
                name: "nope".into(),
                cycles: 1,
            }])
            .unwrap_err();
        assert!(err.contains("nope"), "{err}");
        let err = eng
            .set_watch(&[Watch::Is {
                name: "r".into(),
                value: "zz".into(),
            }])
            .unwrap_err();
        assert!(err.contains("bad literal"), "{err}");
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
    fn a_cross_coupled_nand_pair_settles_by_link_order_not_a_storm() {
        // The smallest symmetric settle: two NANDs wired output-to-input (a
        // bistable latch), nothing else. Both have the same delay, so both
        // commit at the same timestamp for ever — every net flips `0 ↔ 1` with
        // nothing to break the symmetry. The power-on seed puts both loop nets
        // at 0, which is exactly the *unstable* diagonal of this pair, so the
        // seeded boot lands in the tie. CircuitSim CE breaks it by link order
        // (`Simulator.step` moves one link per step); the delay engine must
        // break it deterministically too, or the boot storm cap fires.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"c1","type":"gate.nand","pos":[0,0]}},
                {{"id":"c2","type":"gate.nand","pos":[0,0]}},
                {{"id":"q","type":"wiring.probe","pos":[0,0],"name":"q"}},
                {{"id":"qn","type":"wiring.probe","pos":[0,0],"name":"qn"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"c1","pin":"in0"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"c2","pin":"in0"}}}},
                {{"a":{{"comp":"c2","pin":"out"}},"b":{{"comp":"c1","pin":"in1"}}}},
                {{"a":{{"comp":"c1","pin":"out"}},"b":{{"comp":"c2","pin":"in1"}}}},
                {{"a":{{"comp":"c1","pin":"out"}},"b":{{"comp":"q","pin":"in"}}}},
                {{"a":{{"comp":"c2","pin":"out"}},"b":{{"comp":"qn","pin":"in"}}}}
            ]}}]
        }}"##
        );
        // The build runs the boot settle; a storm here would already have made
        // `engine` fail its `expect("test engine builds")`.
        let mut eng = engine(&json, 500);
        let rep = eng
            .run(2)
            .expect("a cross-coupled pair must settle, not storm the cap");
        let q = eng.named_value("q").expect("q probe");
        let qn = eng.named_value("qn").expect("qn probe");
        assert!(q.is_fully_known() && qn.is_fully_known(), "{q} / {qn}");
        assert_ne!(q, qn, "the pair settles to its two opposite values");
        // A settle, not a storm: a handful of events, not a million.
        assert!(
            rep.events_processed < 100,
            "settling should take a few events, took {}",
            rep.events_processed
        );
    }

    #[test]
    fn only_feedback_members_are_on_a_cycle_not_downstream_parts() {
        // The narrowness claim, pinned directly: the tie-break's cycle set is
        // the *feedback* members only. `d` reads the latch and is therefore in
        // the levelize residue (it depends on a loop), but it is not *on* a
        // cycle, so it must not be promoted.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"c1","type":"gate.nand","pos":[0,0]}},
                {{"id":"c2","type":"gate.nand","pos":[0,0]}},
                {{"id":"d","type":"gate.and","pos":[0,0]}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"c1","pin":"in0"}}}},
                {{"a":{{"comp":"c2","pin":"out"}},"b":{{"comp":"c1","pin":"in1"}}}},
                {{"a":{{"comp":"c1","pin":"out"}},"b":{{"comp":"c2","pin":"in1"}}}},
                {{"a":{{"comp":"c1","pin":"out"}},"b":{{"comp":"d","pin":"in0"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"d","pin":"in1"}}}}
            ]}}]
        }}"##
        );
        let eng = engine(&json, 500);
        let on = crate::engine_common::on_cycle(&eng.netlist, &eng.comps);
        let (_, residue) = crate::engine_common::levelize(&eng.netlist, &eng.comps);
        let idx = |id: &str| {
            eng.netlist()
                .comps
                .iter()
                .position(|c| c.def_id == id)
                .expect("comp")
        };
        // `d` is downstream of the loop (residue) but not on it.
        assert!(residue.contains(&(idx("d") as u32)), "d is in the residue");
        assert!(!on[idx("d")], "d must not be promoted");
        assert!(on[idx("c1")] && on[idx("c2")], "the pair is the cycle");
        let promoted: Vec<&str> = (0..eng.comps.len())
            .filter(|&i| on[i])
            .map(|i| eng.netlist().comps[i].type_.as_str())
            .collect();
        assert_eq!(promoted, ["gate.nand", "gate.nand"]);
    }

    #[test]
    fn a_ring_of_an_odd_number_of_nots_still_trips_the_storm_cap() {
        // The guarantee the tie-break must not weaken: a **genuine**
        // oscillator — a feedback ring with inverted parity, which has no
        // stable state — keeps changing with definite values and must still
        // halt with `Oscillation`. Its stages are one propagation delay
        // apart, so no two commits ever share a timestamp and the tie-break
        // never fires: the cap is what stops it, exactly as before.
        let mut comps = String::new();
        let mut wires = String::new();
        const N: usize = 3;
        for i in 0..N {
            comps.push_str(&format!(
                r#"{{"id":"n{i}","type":"gate.not","pos":[0,0]}},"#
            ));
        }
        for i in 0..N {
            let j = (i + 1) % N;
            wires.push_str(&format!(
                r#"{{"a":{{"comp":"n{i}","pin":"out"}},"b":{{"comp":"n{j}","pin":"in"}}}},"#
            ));
        }
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [{comps}{{"id":"x","type":"wiring.probe","pos":[0,0]}}],
              "wires": [{wires}{{"a":{{"comp":"n0","pin":"out"}},"b":{{"comp":"x","pin":"in"}}}}]}}]
        }}"##
        );
        let mut eng = engine(&json, 5000);
        eng.events_per_cycle_cap = 50;
        let halt = eng.run(2).expect_err("an odd inverter ring must storm");
        assert_eq!(halt.reason, HaltReason::Oscillation);
    }

    #[test]
    fn a_floating_gate_input_is_read_as_x_and_pausing_is_opt_in() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"c","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"g","type":"gate.and","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"p"}}
            ], "wires": [
                {{"a":{{"comp":"c","pin":"out"}},"b":{{"comp":"g","pin":"in0"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        // `in1` is connected to nothing. The gate reads it as X — the model does not
        // know it, so it will not assume it — and the design runs: the verdict says so
        // when the X reaches an observation.
        let mut eng = engine(&json, 500);
        eng.run(1).expect("a floating read is not a fault");
        assert!(eng.named_value("p").expect("probe").has_x());
        // The editor turns the pause on to *ask*; then it stops and names the pin.
        let mut eng = engine(&json, 500);
        eng.pause_on_unknown = true;
        let halt = eng.run(1).expect_err("pause_on_unknown asks");
        assert_eq!(halt.reason, HaltReason::FloatingRead);
        assert!(halt.details.contains("in1"), "got: {}", halt.details);
        assert!(halt.details.contains("gate.and"), "got: {}", halt.details);
    }

    #[test]
    fn compat_reads_a_floating_gate_input_as_ce_does() {
        // Same wiring as the test above: AND with in0 = 1 and in1 connected to nothing.
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"c","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"g","type":"gate.and","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"p"}}
            ], "wires": [
                {{"a":{{"comp":"c","pin":"out"}},"b":{{"comp":"g","pin":"in0"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        // Production: the floating `in1` is `X`, and it reaches the probe.
        let mut prod = engine(&json, 500);
        prod.run(1).unwrap();
        assert!(prod.named_value("p").unwrap().has_x());
        // `compat`: CE folds the floating `in1` as 0 while `in0` is definite, so the AND
        // is a definite 0 — the diagnostic that separates CE's `Z` semantics from a
        // converter gap.
        let mut compat = compat_engine(&json, 500);
        compat.run(1).unwrap();
        assert_eq!(compat.named_value("p"), Some(Value::from_u64(1, 0)));
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

    /// A tri-state bus idling at `Z` on a mux's **unselected** input must not stall the
    /// mux. That `Z` is final — every driver enabled off — not a value on its way, and the
    /// mux never reads that pin, so the selected input passes through.
    ///
    /// Before this, the wait-for-arrival rule saw a `Z` on a *driven* net and made the mux
    /// wait forever, holding its output at `Z`. Every converted design that gates a bus
    /// this way — the LC-5200's write-back path is exactly this shape — read `Z`, and a
    /// register consuming it stored `X` for the rest of the run.
    #[test]
    fn mux_passes_through_with_idle_bus_on_unselected_input() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"zero","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8,"value":"0"}}}},
                {{"id":"sel0","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":1,"value":"0"}}}},
                {{"id":"five","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":8,"value":"05"}}}},
                {{"id":"off","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":1,"value":"0"}}}},
                {{"id":"buf","type":"wiring.controlled-buffer","pos":[0,0],"attrs":{{"bitsize":8}}}},
                {{"id":"m","type":"plexers.mux","pos":[0,0],"attrs":{{"bitsize":8,"selectBits":1}}}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out","attrs":{{"bitsize":8}}}}
            ], "wires": [
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"m","pin":"in0"}}}},
                {{"a":{{"comp":"five","pin":"out"}},"b":{{"comp":"buf","pin":"in"}}}},
                {{"a":{{"comp":"off","pin":"out"}},"b":{{"comp":"buf","pin":"en"}}}},
                {{"a":{{"comp":"buf","pin":"out"}},"b":{{"comp":"m","pin":"in1"}}}},
                {{"a":{{"comp":"sel0","pin":"out"}},"b":{{"comp":"m","pin":"sel"}}}},
                {{"a":{{"comp":"m","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(1)
            .expect("an idle bus on a pin the part does not read is not a fault");
        assert_eq!(
            eng.named_value("out"),
            Some(k(8, 0)),
            "sel=0 passes in0 through; the disabled buffer on in1 is not read"
        );
    }

    /// A register whose **enable is wired to the same net as its clock** must latch at the
    /// edge. CE does: `Register.valueChanged` fires on `CLK` (`PORT_CLK` = 2) and reads
    /// `getLastReceived(ENABLE)` (`PORT_ENABLE` = 1), and a net change reaches every port on
    /// that net, so the enable is already 1 when the clock handler runs.
    ///
    /// The engine sampled its own `en` *view* instead, which per-pin transport (F14) may not
    /// have updated yet — so the register read the pre-edge 0 and never latched at all.
    /// Converted submissions wire a PC's clock into both its `clk` and its `en` port (the
    /// copper crosses both), and it froze at power-on.
    #[test]
    fn en_on_clk_net_latches() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0],"name":"CLOCK"}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":32,"value":"01"}}}},
                {{"id":"one1","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":1,"value":"1"}}}},
                {{"id":"tied","type":"mem.register","pos":[0,0],"name":"tied","attrs":{{"bitsize":32}}}},
                {{"id":"sep","type":"mem.register","pos":[0,0],"name":"sep","attrs":{{"bitsize":32}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"tied","pin":"clk"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"tied","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"tied","pin":"d"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"sep","pin":"clk"}}}},
                {{"a":{{"comp":"one1","pin":"out"}},"b":{{"comp":"sep","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"sep","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.run(2).expect("no fault");
        assert_eq!(
            eng.named_value("tied"),
            Some(k(32, 1)),
            "the enable shares the clock's net, so the edge sees enable = 1 (as CE reads it)"
        );
        assert_eq!(
            eng.named_value("sep"),
            Some(k(32, 1)),
            "separate enable, for contrast"
        );
    }

    /// Build an engine from `json` with a caller-supplied table (the shipped table is the
    /// test helper's default, so any test that varies the *table* has to reach past it).
    fn engine_with(json: &str, clock_start: u64, table: &TimingTable) -> DelayEngine {
        let doc = load_document(json.as_bytes()).expect("test doc parses");
        let nl = netlist::build(&doc).expect("test doc netlists");
        DelayEngine::new(nl, clock_start, table).expect("test engine builds")
    }

    /// The shipped table with the register's setup time raised by `extra` — and nothing
    /// else touched. B3's whole point is that the two runs differ by exactly that.
    fn table_with_extra_setup(extra: u64) -> TimingTable {
        let mut v: serde_json::Value =
            serde_json::from_str(include_str!("../data/cs2200-74ls-v1.json")).unwrap();
        let base = v["components"]["mem.register"]["setup"]
            .as_u64()
            .expect("the register has a setup time");
        v["components"]["mem.register"]["setup"] = serde_json::json!(base + extra);
        TimingTable::from_json(&v.to_string()).unwrap()
    }

    /// **B2's fixture.** Register `r` samples a value that arrives over a **short** path or a
    /// **long** one, chosen by a mux. Both paths invert an even number of times, so they
    /// carry the *same* value and only the *timing* differs — which is what lets the test
    /// compare periods without the values moving underneath it. `sel_wire` is the JSON for
    /// the mux's select, so the same circuit can pin the short path, pin the long one, or
    /// let the select toggle.
    fn settling_mux_json(sel_wire: &str) -> String {
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"tog","type":"mem.register","pos":[0,0],"name":"tog"}},
                {{"id":"t0","type":"gate.not","pos":[0,0]}},
                {{"id":"s1","type":"gate.not","pos":[0,0]}},
                {{"id":"s2","type":"gate.not","pos":[0,0]}},
                {{"id":"l1","type":"gate.not","pos":[0,0]}},
                {{"id":"l2","type":"gate.not","pos":[0,0]}},
                {{"id":"l3","type":"gate.not","pos":[0,0]}},
                {{"id":"l4","type":"gate.not","pos":[0,0]}},
                {{"id":"mux","type":"plexers.mux","pos":[0,0],"attrs":{{"selectBits":1}}}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"tog","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"tog","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"tog","pin":"rst"}}}},
                {{"a":{{"comp":"t0","pin":"out"}},"b":{{"comp":"tog","pin":"d"}}}},
                {{"a":{{"comp":"tog","pin":"q"}},"b":{{"comp":"t0","pin":"in"}}}},
                {{"a":{{"comp":"tog","pin":"q"}},"b":{{"comp":"s1","pin":"in"}}}},
                {{"a":{{"comp":"s1","pin":"out"}},"b":{{"comp":"s2","pin":"in"}}}},
                {{"a":{{"comp":"s2","pin":"out"}},"b":{{"comp":"mux","pin":"in0"}}}},
                {{"a":{{"comp":"tog","pin":"q"}},"b":{{"comp":"l1","pin":"in"}}}},
                {{"a":{{"comp":"l1","pin":"out"}},"b":{{"comp":"l2","pin":"in"}}}},
                {{"a":{{"comp":"l2","pin":"out"}},"b":{{"comp":"l3","pin":"in"}}}},
                {{"a":{{"comp":"l3","pin":"out"}},"b":{{"comp":"l4","pin":"in"}}}},
                {{"a":{{"comp":"l4","pin":"out"}},"b":{{"comp":"mux","pin":"in1"}}}},
                {sel_wire},
                {{"a":{{"comp":"mux","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}},
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r","pin":"rst"}}}},
                {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"p","pin":"in"}}}}
            ]}}]
        }}"##
        )
    }

    /// **B2 (`docs/derived-clock.md` §10).** `t_obs` is the **max** over cycles, not their
    /// sum, and the fixture is built so the claim cannot pass vacuously: the same circuit is
    /// first run with each path *pinned*, and the test asserts the two pinned periods
    /// actually differ before it asserts anything about the toggling one. If the select ever
    /// stopped moving the settle, the earlier assertion fails and says so.
    ///
    /// (`est_time = cycles × t_obs` is asserted where `est_time` lives, in autograde's report
    /// test — the engine's `RunReport` deliberately does not carry it.)
    #[test]
    fn t_obs_is_the_max_over_cycles_not_their_sum() {
        let pin = |comp: &str| {
            format!(r#"{{"a":{{"comp":"{comp}","pin":"out"}},"b":{{"comp":"mux","pin":"sel"}}}}"#)
        };
        let t_short = engine(&settling_mux_json(&pin("zero")), 500)
            .run(4)
            .expect("a cycle")
            .t_obs;
        let t_long = engine(&settling_mux_json(&pin("one")), 500)
            .run(4)
            .expect("a cycle")
            .t_obs;
        // The control: the fixture must really have two different settles to take a max of.
        assert!(
            t_long > t_short,
            "the long path must settle later than the short one ({t_long} vs {t_short})"
        );
        // The property: with the select toggling, the period is the *worst* cycle.
        let varying = engine(
            &settling_mux_json(r#"{"a":{"comp":"tog","pin":"q"},"b":{"comp":"mux","pin":"sel"}}"#),
            500,
        )
        .run(4)
        .expect("a cycle")
        .t_obs;
        assert_eq!(
            varying, t_long,
            "t_obs is the max over cycles ({t_long}), not a sum or an average (short {t_short})"
        );
    }

    /// **B3 (`docs/derived-clock.md` §10).** Setup is included in the period, and by
    /// *exactly* its delta: the same circuit run against two tables that differ only in the
    /// register's `t_setup`. This is why a near-edge poke is not a race — the edge is placed
    /// after the data by construction, and the width of that gap is `t_setup`.
    ///
    /// **The number is the period (edge to edge), not `t_obs`.** The plan's B1/B3 rows say
    /// `t_obs = settle + setup`, but the engine's `t_obs` is the per-cycle *settle*: the
    /// pipeline reports 39 (`clk→Q 20 + not 9 + and 10`) while its period is 54. B1's own
    /// test already measures the period this way, and B4 says a static design's `t_obs` is 0
    /// (which only the settle can be). So the plan's wording and the field disagree, and the
    /// disagreement is a decision about what `est_time` should mean — `cycles × settle` or
    /// `cycles × period`. Flagged rather than silently resolved; this test asserts the
    /// property either reading agrees on: **setup moves the period by exactly its delta**.
    #[test]
    fn setup_is_in_the_period_by_exactly_its_delta() {
        const EXTRA: u64 = 40;
        // A half period *below* the settle, so the barrier's placement is what decides the
        // period: with a large floor the nominal schedule masks the setup term entirely.
        // (B1's existing test does the same thing for the same reason.)
        let json = pipeline_json();
        let base = TimingTable::builtin("cs2200-74ls-v1").unwrap();
        let slow = table_with_extra_setup(EXTRA);
        let now = |e: &DelayEngine| -> u64 {
            let v: serde_json::Value = serde_json::from_str(&e.snapshot()).expect("snapshot");
            v["now"].as_u64().expect("now")
        };
        let period = |table: &TimingTable| -> u64 {
            let mut eng = engine_with(&json, 5, table);
            eng.run(3).expect("3 cycles");
            let a = now(&eng);
            eng.run(1).expect("one more");
            now(&eng) - a
        };
        let (p_base, p_slow) = (period(&base), period(&slow));
        assert_eq!(
            p_slow,
            p_base + EXTRA,
            "raising t_setup by {EXTRA} must lengthen the period by exactly {EXTRA} \
             ({p_base} -> {p_slow})"
        );
    }

    /// **D3 (`docs/derived-clock.md` §10).** A **conservative** loop: a graph cycle with no
    /// behavioural one. Two controlled buffers share a bus and are gated *by that bus* — one
    /// directly, one through its complement — so the dependency graph closes a loop
    /// (`ba -> bus -> ba.en`) while the circuit has exactly one stable state. This is the
    /// shape that took down the levelized engine (`docs/engine-redesign.md` §3: "almost every
    /// design in this course has such a bus"), and the delay engine must run it, not storm on
    /// it, and give CE's values.
    #[test]
    fn a_conservative_loop_settles_instead_of_storming() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"ba","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"bb","type":"wiring.controlled-buffer","pos":[0,0]}},
                {{"id":"c","type":"gate.not","pos":[0,0]}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"bus"}}
            ], "wires": [
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"ba","pin":"in"}}}},
                {{"a":{{"comp":"ba","pin":"en"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"bb","pin":"in"}}}},
                {{"a":{{"comp":"c","pin":"out"}},"b":{{"comp":"bb","pin":"en"}}}},
                {{"a":{{"comp":"ba","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"bb","pin":"out"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"ba","pin":"out"}},"b":{{"comp":"c","pin":"in"}}}},
                {{"a":{{"comp":"ba","pin":"out"}},"b":{{"comp":"ba","pin":"en"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        // The loop is real in the *graph* — that is the whole point of the fixture.
        let on = crate::engine_common::on_cycle(&eng.netlist, &eng.comps);
        let idx = |id: &str| {
            eng.netlist()
                .comps
                .iter()
                .position(|c| c.def_id == id)
                .expect("comp")
        };
        assert!(
            on[idx("bb")] && on[idx("c")],
            "the fixture must actually close a loop (bb -> bus -> c -> bb.en)"
        );
        // ...and it still runs: one stable state, no storm, no floating halt.
        assert!(eng.halted().is_none(), "boot halt: {:?}", eng.halted());
        eng.run(3)
            .expect("a conservative loop must settle, not storm");
        // The fixed point is definite: `ba` is gated *by* the bus (so it is off), `bb` is
        // enabled by its complement and drives 0, and the two agree -- no contention, no X.
        // The first version of this fixture seeded the bus to 0 and gated `ba` *on*, which
        // put both drivers on the same `Z`-free net and settled at X: a fixture bug that
        // looked exactly like the engine failing D3.
        assert_eq!(
            eng.named_value("bus"),
            Some(k(1, 0)),
            "the loop settles on 0, with no contention and no X"
        );
    }

    /// **F4 (`docs/derived-clock.md` §10).** With **wire delay on**, the clock's own
    /// transition reaches its sink the same way any other signal does — through the cascade
    /// — rather than at a scheduled time. So lengthening the *clock's* wire lengthens the
    /// period by the wire's delay: the edge cannot have been scheduled, or the wire would
    /// not show up in the settle at all.
    #[test]
    fn the_clocks_own_propagation_is_part_of_the_cascade() {
        let json = |points: &str| {
            format!(
                r##"{{
                "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
                "circuits": [{{ "name": "main", "components": [
                    {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                    {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                    {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                    {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}},
                    {{"id":"inv","type":"gate.not","pos":[0,0]}},
                    {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"out"}}
                ], "wires": [
                    {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}{points}}},
                    {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                    {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r","pin":"rst"}}}},
                    {{"a":{{"comp":"inv","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}},
                    {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"inv","pin":"in"}}}},
                    {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"p","pin":"in"}}}}
                ]}}]
            }}"##
            )
        };
        // The wire the transport test already pins: 200 grid units at the table's 1/10 ns
        // per unit = 20 ns. The clock has no wire in the near case, so the difference
        // between the two periods *is* the clock wire's delay.
        const CLOCK_WIRE_NS: u64 = 20;
        let t_near = wired_engine(&json(""), 500).run(2).expect("a cycle").t_obs;
        let t_far = wired_engine(&json(r#","points":[[0,0],[100,0],[100,100]]"#), 500)
            .run(2)
            .expect("a cycle")
            .t_obs;
        assert!(
            t_near > 0,
            "the fixture must settle every cycle, or the delta below is 0 - 0"
        );
        assert_eq!(
            t_far,
            t_near + 2 * CLOCK_WIRE_NS,
            "the clock's wire carries **both** transitions, so the period grows by twice its \
             delay: {t_near} -> {t_far}"
        );
    }

    /// **E4 (`docs/derived-clock.md` §10).** The derived edge times reproduce exactly on a
    /// second engine built from the same document — not just the final hash (E1) but *every*
    /// edge, which is the stronger claim: a difference that cancelled out by the end would
    /// still show up here.
    #[test]
    fn derived_edge_times_reproduce_across_engines() {
        let json = pipeline_json();
        let mut a = engine(&json, 500);
        let mut b = engine(&json, 500);
        let now = |e: &DelayEngine| -> u64 {
            let v: serde_json::Value = serde_json::from_str(&e.snapshot()).expect("snapshot");
            v["now"].as_u64().expect("now")
        };
        for cycle in 0..4 {
            a.run(1).expect("a cycle");
            b.run(1).expect("a cycle");
            assert_eq!(
                now(&a),
                now(&b),
                "cycle {cycle}: the edge time must reproduce exactly"
            );
        }
    }

    /// **H2 (`docs/derived-clock.md` §10).** The divergence with CircuitSim CE, pinned in one
    /// place so it is a known quantity rather than a surprise: a pulse **narrower than a
    /// gate's `t_pd`** is swallowed by an inertial gate but survives a transport wire.
    ///
    /// CE has no time — its settle propagates until the pending set is empty — so it passes
    /// a narrow pulse through both. We model the gate as inertial (a real gate that short a
    /// pulse never sees, which is the physically honest reading) and the wire as transport.
    /// The wire half agrees with CE; the gate half is where the two disagree, and this test
    /// is the place that says so.
    #[test]
    fn a_narrow_pulse_survives_a_wire_but_not_a_gate() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"g","type":"gate.not","pos":[0,0]}},
                {{"id":"gated","type":"wiring.probe","pos":[0,0],"name":"gated"}},
                {{"id":"wire","type":"wiring.probe","pos":[0,0],"name":"wire"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"g","pin":"in"}}}},
                {{"a":{{"comp":"g","pin":"out"}},"b":{{"comp":"gated","pin":"in"}}}},
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"wire","pin":"in"}},
                 "points":[[0,0],[100,0],[100,100]]}}
            ]}}]
        }}"##
        );
        // Wires on: the transported half of the divergence needs the physics.
        let mut eng = wired_engine(&json, 5000);
        assert!(eng.poke_at("src", k(1, 1), 100));
        assert!(eng.poke_at("src", k(1, 0), 105)); // 5 ns < the gate's 9 ns t_pd
                                                   // The wire: passed, arriving 20 ns later and lasting the same 5 ns.
        assert_eq!(eng.named_value("wire"), Some(k(1, 0)));
        eng.run_until_time(121).unwrap();
        assert_eq!(eng.named_value("wire"), Some(k(1, 1)), "leading edge @120");
        eng.run_until_time(126).unwrap();
        assert_eq!(eng.named_value("wire"), Some(k(1, 0)), "trailing edge @125");
        // The gate: swallowed. `gated` was 1 and never moved.
        eng.run_until_time(140).unwrap();
        assert_eq!(
            eng.named_value("gated"),
            Some(k(1, 1)),
            "an inertial gate swallows a pulse shorter than its t_pd (CE passes it)"
        );
        // And holding the input long enough does reach the gate.
        assert!(eng.poke_at("src", k(1, 1), 300));
        eng.run_until_time(309).unwrap();
        assert_eq!(eng.named_value("gated"), Some(k(1, 1)));
        eng.run_until_time(310).unwrap();
        assert_eq!(eng.named_value("gated"), Some(k(1, 0)));
    }

    /// The shipped table with the `gate.not` propagation time replaced. Used to show that a
    /// glitch-dependent design is **table-dependent** — the mechanism behind H1.
    fn table_with_not_prop(prop: u64) -> TimingTable {
        let mut v: serde_json::Value =
            serde_json::from_str(include_str!("../data/cs2200-74ls-v1.json")).unwrap();
        v["components"]["gate.not"]["prop"] = serde_json::json!(prop);
        TimingTable::from_json(&v.to_string()).unwrap()
    }

    /// **H1 (`docs/derived-clock.md` §10) — the mechanism, in miniature.** H1 is the corpus row
    /// that will not stabilise under one table and halts under another, and it is the one
    /// property in the plan that is still false. Its *cause* is public even though the design
    /// that exhibits it is not: a design whose behaviour depends on a pulse narrower than a
    /// gate's `t_pd` answers differently under a table with a different `t_pd`.
    ///
    /// So this is H1 without the private design — the same 5 ns pulse, two tables, two
    /// different values — pinned where it can be seen. It is deliberately an *expectation*,
    /// not a known-failure marker: it passes today and should keep passing, because it
    /// records a divergence we have decided to keep (H2), and the day that decision changes,
    /// this test and H1 change together.
    #[test]
    fn a_glitch_dependent_design_is_table_dependent() {
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
        let pulse = |table: &TimingTable| -> Option<Value> {
            let mut eng = engine_with(&json, 5000, table);
            assert!(eng.poke_at("src", k(1, 1), 100));
            assert!(eng.poke_at("src", k(1, 0), 105)); // 5 ns
                                                       // Observe *during* the pulse: a gate that passes it has already come back by
                                                       // the time a settle-and-look would check.
            eng.run_until_time(103).expect("mid-pulse");
            eng.named_value("out")
        };
        // A 9 ns gate never sees a 5 ns pulse; a 2 ns one does. Same design, same stimulus,
        // different answer — because the answer is about a *glitch*.
        assert_eq!(
            pulse(&table_with_not_prop(9)),
            Some(k(1, 1)),
            "slow gate: the pulse is swallowed and the output never moves"
        );
        assert_eq!(
            pulse(&table_with_not_prop(2)),
            Some(k(1, 0)),
            "fast gate: the same pulse passes, so the design's state differs by table"
        );
    }

    /// **`t_obs` is the derived period** (`docs/derived-clock.md` §3): the maximum rise-to-rise
    /// interval, i.e. `depth + setup`.
    ///
    /// Measured on the pipeline: 54 = 39 (`clk→Q 20 + not 9 + and 10`) + 15 (`t_setup`), the
    /// same in every cycle. This replaces a test that pinned the *old* semantics — `t_obs` as
    /// the settle (39), with the period a separate number the field did not report, and the
    /// 15 ns setup gap measured by nobody. Both numbers still exist: the settle is what a
    /// critical path's `delay_ns` carries.
    #[test]
    fn t_obs_is_the_derived_period() {
        let mut eng = engine(&pipeline_json(), 500);
        let rep = eng.run(4).expect("cycles");
        assert_eq!(rep.t_obs, 54, "depth 39 + setup 15");
        assert_eq!(
            rep.top_paths.iter().map(|(settle, _)| *settle).max(),
            Some(39),
            "the critical path keeps the settle: a path's delay is propagation, not a cycle"
        );
    }

    /// **The period is derived, whatever the nominal is.**
    ///
    /// The nominal is the timeline's *origin* now — it decides when the clock starts and
    /// nothing else. Measured on the pipeline, the period is 54 whether the origin is at 500,
    /// 50, 5 or 1, and `t_obs` (which *is* that period) is 54 in all of them.
    ///
    /// This test used to pin the **opposite**, and that is why it is written down: before every
    /// edge was placed by the drain, the nominal bound the period the moment it exceeded the
    /// design's requirement — 1000 ns at an origin of 500, for a design that needs 54. If the
    /// nominal ever decides a period again, this fails.
    #[test]
    fn the_period_is_derived_whatever_the_nominal_is() {
        const DEPTH: u64 = 39;
        const SETUP: u64 = 15;
        let json = pipeline_json();
        let now = |e: &DelayEngine| -> u64 {
            let v: serde_json::Value = serde_json::from_str(&e.snapshot()).expect("snapshot");
            v["now"].as_u64().expect("now")
        };
        for origin in [500u64, 50, 5, 1] {
            let mut eng = engine(&json, origin);
            let edges: Vec<u64> = (0..4)
                .map(|_| {
                    eng.run(1).expect("a cycle");
                    now(&eng)
                })
                .collect();
            let periods: Vec<u64> = edges.windows(2).map(|w| w[1] - w[0]).collect();
            assert_eq!(
                periods,
                [DEPTH + SETUP; 3],
                "the period must be the design's own at origin {origin}, not the nominal"
            );
            assert_eq!(eng.t_obs, DEPTH + SETUP, "t_obs is that period");
        }
        // The origin is still an origin: the clock's first edge is at 2 x it, plus the setup
        // its sampling owe.
        let mut eng = engine(&json, 500);
        eng.run(1).expect("a cycle");
        // The origin still holds: the first edge is *due* at 2 x 500 = 1000, and `max` leaves
        // it there (the queue in front of it is already empty, so `now + setup` is 15). `now`
        // after one cycle is the end of that cycle's drain — 1000 + the 39 ns pipeline.
        assert_eq!(now(&eng), 500 + DEPTH, "the origin, then one cycle's drain");
    }

    /// A chain of `n` inverters from the `src` pin to register `r2`'s `d`, long enough
    /// **C1 (`docs/derived-clock.md` §10).** A near-edge poke is **honoured**, and there is
    /// nothing to report. `we` *and* `din` both change 10 ns before the edge -- inside any
    /// setup window -- and the write still lands with the new data, because with a derived
    /// clock the edge is placed *after* the settle: a near-edge change is not a race, it is
    /// the normal case.
    ///
    /// The old version of this test asserted the warning and then asserted word 0 was 0 --
    /// which is also the reset value, so it would have passed without the write landing at
    /// all. The rewritten assertion is the *data*, which cannot be satisfied by accident.
    #[test]
    fn a_near_edge_ram_write_is_honoured_not_reported() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":2}}}},
                {{"id":"din","type":"wiring.pin","pos":[0,0],"name":"din","attrs":{{"bitsize":8}}}},
                {{"id":"we","type":"wiring.pin","pos":[0,0],"name":"we"}},
                {{"id":"m","type":"mem.ram","pos":[0,0],"name":"m","attrs":{{"bitsize":8,"depth":4}}}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"m","pin":"clk"}}}},
                {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"m","pin":"addr"}}}},
                {{"a":{{"comp":"din","pin":"pin"}},"b":{{"comp":"m","pin":"din"}}}},
                {{"a":{{"comp":"we","pin":"pin"}},"b":{{"comp":"m","pin":"we"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        // The enable and the data both land 10 ns before the first edge (T=1000).
        assert!(eng.poke_at("we", k(1, 1), 990));
        assert!(eng.poke_at("din", k(8, 0x2A), 990));
        eng.run(1).expect("a cycle");
        assert_eq!(
            eng.memory_word("m", 0),
            Some(k(8, 0x2A)),
            "the write must land with the poked data"
        );
    }

    /// that the settle outlasts the nominal period (n x t_pd). Shared by **A1**, which
    /// reads the *value* it latches, and **A2**, which reads the barrier that makes that
    /// value possible in the first place.
    fn long_chain(n: usize) -> String {
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
        for i in 0..n {
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
        format!(
            r##"{{"format":"circuitsim-plus-plus","version":2,"name":"t",{SETTINGS},
            "circuits":[{{"name":"main","components":[{}],"wires":[{}]}}]}}"##,
            comps.trim_end_matches(','),
            wires
        )
    }

    /// F6 (S1): a propagation path longer than the clock period must NOT
    /// halt as floating-read — the boot settle quiesces first; the run
    /// completes with setup/hold warnings and deterministic latching.
    #[test]
    fn a_chain_longer_than_the_period_latches_the_settled_value() {
        let json = long_chain(250);
        // 250 inverters ≈ 2250 ns; period 1000 ns < the path. Before F6
        // this died at cycle close with a spurious FloatingRead.
        let mut eng = engine(&json, 500);
        assert!(eng.halted().is_none(), "boot halt: {:?}", eng.halted());
        // Wire propagation is off (the table ships `wire.num = 0`), so the *data* path has
        // to do the violating: `src` rises at T=740 and r2.d changes ~2250 ns later, i.e.
        // at 2990 — inside the 15 ns setup window before r2's T=3000 clock edge (edges are
        // every period, 2 × the 500 ns half-period). The latch still happens; the report
        // carries the warning rather than a halt.
        assert!(eng.poke_at("src", k(1, 1), 740));
        let rep = eng.run(3).expect("overclocked run must complete");
        assert_eq!(rep.cycles, 3);
        // **A1 (docs/derived-clock.md §10).** The barrier's whole point: the chain is far
        // longer than the nominal period, and the register must still latch the *settled*
        // value — 250 inversions of a 1 is a 1. Before the derived clock this fixture
        // asserted a *warning*; the value is the property that matters.
        assert_eq!(
            eng.named_value("r2"),
            Some(k(1, 1)),
            "a chain longer than the period must latch the settled value"
        );
        // **Rewritten again for the derived period.** The design goes static after the first
        // edge, so every later cycle has *no depth* — but it still pays its sampling edge's
        // setup, which is now part of the period (`docs/derived-clock.md` §3: `depth + setup`).
        // The old `t_obs == 0` was reachable only while the metric was the settle.
        assert_eq!(rep.t_obs, 35, "measured: clk→Q 20 + setup 15");
    }

    /// **A4 (`docs/derived-clock.md` section 10).** The complement of A1: not only does the
    /// register latch the *settled* value, the **edge itself is late** -- it lands after the
    /// spill. A1 alone would still pass if the engine deferred the value but fired the edge
    /// on time, and it is the lateness that makes A3's monotonicity a statement about
    /// *derived* edges rather than about nominal ones.
    #[test]
    fn the_edge_lands_after_a_cascade_that_spills_past_it() {
        let json = long_chain(250);
        let mut eng = engine(&json, 500);
        assert!(eng.poke_at("src", k(1, 1), 740));
        eng.run(1).expect("a cycle");
        let v: serde_json::Value = serde_json::from_str(&eng.snapshot()).expect("snapshot");
        let now = v["now"].as_u64().expect("now");
        // 250 inverters from the T=740 poke spill well past the nominal first edge; the
        // edge can therefore only be at the far end of the spill or later.
        assert!(
            now >= 2990,
            "the edge must land after the cascade, not at {now}"
        );
        assert_eq!(eng.named_value("r2"), Some(k(1, 1)));
    }

    /// **E3 (`docs/derived-clock.md` section 10).** The stepper and the runner are the same
    /// simulation: two `step_tick`s and a settle reach the state `run(1)` reaches -- same
    /// time, same cycle, same trace hash. If they diverged, what a student sees while
    /// clicking and what they are graded on would come from two engines.
    ///
    /// Both halves of that sentence are measured, not assumed:
    ///
    /// - A cycle is **two half-edges**, so one `step_tick` is half a `run(1)`. Stepped from
    ///   boot it lands on the rising edge (T=1000, cycle 1) while `run(1)` stops after that
    ///   cycle's falling edge (T=1500, cycle 1).
    /// - The settle is what the *stepper* defers. Measured on the pipeline, `run(1)` applies
    ///   55 events and two `step_tick`s apply 51: the four missing ones carry the falling
    ///   edge's own timestamp, so they are the cascade that edge *launches*, which the stepper
    ///   leaves queued for its next call. Draining them makes the two identical -- which is
    ///   also why the stepper can legitimately be *looked at* mid-settle.
    #[test]
    fn a_pair_of_step_ticks_equals_a_cycle_run() {
        let json = pipeline_json();
        let mut stepped = engine(&json, 500);
        let mut ran = engine(&json, 500);
        let state = |e: &DelayEngine| -> (u64, u64, u64) {
            let v: serde_json::Value = serde_json::from_str(&e.snapshot()).expect("snapshot");
            (
                v["now"].as_u64().expect("now"),
                v["rising_seen"].as_u64().expect("rising_seen"),
                e.trace_hash(),
            )
        };
        for cycle in 0..3 {
            stepped.step_tick().expect("a half-edge");
            stepped.step_tick().expect("a half-edge");
            stepped.settle_cycle().expect("the edge's own cascade");
            ran.run(1).expect("a cycle");
            assert_eq!(
                state(&stepped),
                state(&ran),
                "cycle {cycle}: stepping and running must agree"
            );
        }
    }

    /// **D4 (`docs/derived-clock.md` section 10).** The drain is **bounded**. The cap counts
    /// events *applied*, so a queue that merely grew would sail past it; what this asserts is
    /// that the events are consumed as they are produced -- the queue stays small while the
    /// storm runs -- and that the storm ends as an oscillation rather than as memory.
    ///
    /// The storm here is deliberately inside a *barrier drain*: a ring drives a register's
    /// `clk`, so the cascade the edge is waiting for never ends. That is the shape that hung
    /// on the `next_boundary` spin, and the reason the cap has to be checked in `apply`
    /// rather than only at a cycle boundary.
    #[test]
    fn a_storm_inside_a_drain_stays_bounded_and_halts() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"n1","type":"gate.not","pos":[0,0]}},
                {{"id":"n2","type":"gate.not","pos":[0,0]}},
                {{"id":"n3","type":"gate.not","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"n2","pin":"in"}}}},
                {{"a":{{"comp":"n2","pin":"out"}},"b":{{"comp":"n3","pin":"in"}}}},
                {{"a":{{"comp":"n3","pin":"out"}},"b":{{"comp":"n1","pin":"in"}}}},
                {{"a":{{"comp":"n2","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r","pin":"rst"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 500);
        eng.events_per_cycle_cap = 500;
        let halt = eng.run(2).expect_err("a ring on clk must not settle");
        assert_eq!(halt.reason, HaltReason::Oscillation);
        // Tight on purpose: a ring of three nots plus one register keeps a handful of
        // events in flight. A bound of "the cap" would pass just as happily against a queue
        // that grew to the cap without ever draining, which is the failure this names.
        assert!(
            eng.queue.len() <= 32,
            "the queue must be drained as it fills, not left to grow: {} pending",
            eng.queue.len()
        );
    }

    /// **A2 (`docs/derived-clock.md` section 10).** No edge fires while data events are
    /// pending -- the barrier's contract, asserted from the inside.
    ///
    /// The plan's phrasing is "the queue holds only the next clock", and that is what is
    /// asserted, give or take scheduled pokes: the instrument checks the whole queue at the
    /// moment of application, which is the only vantage point from which the property is
    /// visible.
    /// (The weaker reading, "nothing *earlier* than the edge is still pending", is true for
    /// free and was the first version of this test; the control run below is what exposed
    /// it. See the instrument's comment.)
    ///
    /// The fixture is A1's over-period chain, because that is the design that *needs* the
    /// barrier: 250 inversions take ~2250 ns, well past the 1000 ns period, so an edge that
    /// did not wait would land in the middle of a cascade.
    #[test]
    fn no_edge_fires_while_data_events_are_pending() {
        let json = long_chain(250);
        let mut eng = engine(&json, 500);
        assert!(eng.halted().is_none(), "boot halt: {:?}", eng.halted());
        // Kick the chain before the first edge, so the very first edge has a cascade it
        // could overtake -- otherwise the test would pass by having nothing to wait for.
        assert!(eng.poke_at("src", k(1, 1), 740));
        for cycle in 0..4 {
            eng.run(1)
                .unwrap_or_else(|h| panic!("cycle {cycle}: {:?}", h));
        }
        // The run is not vacuous: the register really did move (A1's value, re-asserted
        // here only to keep this test from passing on a design that does nothing).
        assert_eq!(eng.named_value("r2"), Some(k(1, 1)));
    }

    /// **B5 (`docs/derived-clock.md` §10).** The nominal period is the timeline's *origin*,
    /// not a schedule: it must not decide *values*, and it must not change the period `t_obs`
    /// reports. A counter is the clean probe — it changes every cycle, so there is always
    /// something to settle.
    #[test]
    fn the_nominal_period_does_not_decide_values_or_t_obs() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
        let mut fast = engine(&json, 50); // nominal period 100
        let mut slow = engine(&json, 5000); // nominal period 10 000
        let a = fast.run(3).expect("fast run");
        let b = slow.run(3).expect("slow run");
        assert_eq!(
            fast.named_value("r"),
            Some(k(8, 3)),
            "the program must advance identically"
        );
        assert_eq!(slow.named_value("r"), Some(k(8, 3)));
        assert_eq!(
            a.t_obs, b.t_obs,
            "a nominal period 100x longer must not change the settle"
        );
        assert!(a.t_obs > 0, "a counter settles every cycle");
    }

    /// **B1/B3 (`docs/derived-clock.md` §10).** The derived period is **settle + setup**.
    ///
    /// Measured in the steady state — the difference between the engine's simulated time
    /// after N and N+1 cycles, so the boot and the first (floored) cycle do not enter.
    /// For the counter fixture: `clk→Q 4` + 8-bit `arith.adder` (`8 + 1×7` = 15) = 19 ns
    /// of settle, plus `mem.register` setup `2` = **21 ns period**.
    #[test]
    fn the_period_is_settle_plus_setup() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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
        let now = |e: &DelayEngine| -> u64 {
            let snap: serde_json::Value =
                serde_json::from_str(&e.snapshot()).expect("snapshot parses");
            snap["now"].as_u64().expect("now present")
        };
        // The period is the design's own, so it is the **same at any origin**. This is also
        // what closes the "128 at half-period 50" that used to be recorded here as
        // unexplained: a period that exceeded both the nominal and the requirement is the
        // signature of the nominal *binding* the period, which every edge being placed by the
        // drain removes. The assertion below is a control — it fails if the origin ever
        // decides a period again, at any origin, for any fixture.
        let period_at = |half: u64| -> u64 {
            let mut eng = engine(&json, half);
            eng.run(10).expect("10 cycles");
            let t10 = now(&eng);
            eng.run(1).expect("one more");
            now(&eng) - t10
        };
        let period = period_at(5);
        assert!(
            period >= 21,
            "the period must cover settle (19) + setup (2); measured {period}"
        );
        assert_eq!(
            period_at(50),
            period,
            "the origin must not decide the period (this was 128 before the derived period)"
        );
        assert_eq!(period_at(500), period, "…at any origin");
    }

    #[test]
    /// **F1 (`docs/derived-clock.md` §10).** A **gated clock**: the register's `clk` is
    /// driven by logic (here an AND of the global clock and an enable) rather than the
    /// global clock directly. Its settling is part of the cascade, and with the enable held
    /// low the register never sees a rising edge and must not latch. (What makes a gated clock
    /// safe when its *select* glitches — the H1 case — is `clk_armed`: the barrier places the
    /// **global** edge, not a derived one, so a transient could otherwise be read as an edge.
    /// See `a_clock_hiccup_is_not_a_second_rising_edge`.)
    fn a_gated_clock_latches_only_when_the_gate_passes_it() {
        let build = |en: &str| {
            format!(
                r##"{{
                "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
                "circuits": [{{ "name": "main", "components": [
                    {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                    {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                    {{"id":"en","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"{en}"}}}},
                    {{"id":"and","type":"gate.and","pos":[0,0]}},
                    {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
                ], "wires": [
                    {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"and","pin":"in0"}}}},
                    {{"a":{{"comp":"en","pin":"out"}},"b":{{"comp":"and","pin":"in1"}}}},
                    {{"a":{{"comp":"and","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                    {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                    {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
                ]}}]
            }}"##
            )
        };
        // Gate closed: the AND never rises, so no edge reaches the register.
        let mut shut = engine(&build("0"), 50);
        shut.run(3).expect("closed-gate run");
        assert_eq!(
            shut.named_value("r"),
            Some(k(1, 0)),
            "a gated-off clock must not latch"
        );
        // Gate open: the AND passes the global clock, so the register latches.
        let mut open = engine(&build("1"), 50);
        open.run(3).expect("open-gate run");
        assert_eq!(
            open.named_value("r"),
            Some(k(1, 1)),
            "a gated-open clock must latch"
        );
    }

    /// **H1 (`docs/derived-clock.md` §11) — the derived-clock glitch.** A register's clock reads a
    /// definite `1`, then a non-level (`X`/`Z`), then `1` again *without ever going low*. The
    /// recovery is not a rising edge: the clock never went low, so there is nothing to rise
    /// *from*. Before `clk_armed` this read as a second edge and the register latched twice
    /// inside one cycle — which is how `submission_374625393` ran off the rails under
    /// `cs2200-74ls-v1` while passing under `mips-r2000-2um-v1`.
    ///
    /// `poke_at` drives the clock pin directly, so the fixture is the rule itself rather than
    /// a particular converter's tri-state bus.
    #[test]
    fn a_clock_hiccup_is_not_a_second_rising_edge() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"zclk","type":"wiring.pin","pos":[0,0],"name":"zclk"}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"inv","type":"gate.not","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"zclk","pin":"pin"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"r","pin":"q"}},"b":{{"comp":"inv","pin":"in"}}}},
                {{"a":{{"comp":"inv","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        // `d` = not `q`, so the register toggles on each real edge and a *second* latch inside
        // the cycle would toggle it straight back — visible in the final value.
        let mut hiccup = engine(&json, 1000);
        assert!(hiccup.poke_at("zclk", k(1, 0), 100), "poke 0");
        assert!(hiccup.poke_at("zclk", k(1, 1), 200), "poke 1");
        assert!(hiccup.poke_at("zclk", Value::x(1), 300), "poke X");
        assert!(hiccup.poke_at("zclk", k(1, 1), 400), "poke 1 again");
        hiccup.run(1).expect("hiccup run");
        assert_eq!(
            hiccup.named_value("r"),
            Some(k(1, 1)),
            "a `1 -> X -> 1` clock hiccup latches ONCE: the clock never went low, so the \
             recovery is not a rising edge"
        );
        // Control: a genuine low *does* arm the next edge — the rule is not "never latch twice".
        let mut real = engine(&json, 1000);
        assert!(real.poke_at("zclk", k(1, 0), 100), "poke 0");
        assert!(real.poke_at("zclk", k(1, 1), 200), "poke 1");
        assert!(real.poke_at("zclk", k(1, 0), 300), "poke 0 again");
        assert!(real.poke_at("zclk", k(1, 1), 400), "poke 1 again");
        real.run(1).expect("control run");
        assert_eq!(
            real.named_value("r"),
            Some(k(1, 0)),
            "a real `0 -> 1` between two `1`s is a second edge and must latch"
        );
    }

    /// **The settled clock rule (`docs/bugs-archive.md`, `docs/derived-clock.md` §11).** A clocked
    /// part takes **one** edge per instant, and only when that instant *entered* with its clock
    /// at a definite low. The two shapes that matter are mirror images, and this is the whole
    /// rule: a `1 -> 0 -> 1` inside one instant (entered high) is not an edge, while a rise after
    /// a real low is — including when the low is followed by a `Z`, because a floating clock
    /// holds the level. A clock driven twice inside one instant is *reported*, never acted on.
    #[test]
    fn a_clock_edge_needs_the_instant_to_have_entered_low() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 1000);
        // Power-on enters low, so the first rise is an edge — and only one per instant.
        assert!(
            eng.clock_delivery(0, Bit::One, 100),
            "entered low: take the edge"
        );
        assert!(
            !eng.clock_delivery(0, Bit::One, 100),
            "a second rise inside the same instant is not a second edge"
        );
        assert_eq!(
            eng.clock_glitches.len(),
            1,
            "two deliveries inside one instant are reported"
        );
        // A definite low at an earlier instant arms the next rise.
        assert!(
            !eng.clock_delivery(0, Bit::Zero, 200),
            "a low is not an edge"
        );
        assert!(
            eng.clock_delivery(0, Bit::One, 300),
            "a low at an earlier instant arms it"
        );
        // `1 -> 0 -> 1` inside one instant: it entered high, so the recovery is not an edge.
        assert!(!eng.clock_delivery(0, Bit::Zero, 400));
        assert!(
            !eng.clock_delivery(0, Bit::One, 400),
            "an instant that began high takes no edge, however it recovers"
        );
        // A floating clock holds the level, so the low survives the Z and still arms the rise.
        assert!(!eng.clock_delivery(0, Bit::Zero, 500));
        assert!(!eng.clock_delivery(0, Bit::Z, 600));
        assert!(eng.clock_delivery(0, Bit::One, 700), "a Z held the low");
    }

    /// **The clock-glitch diagnostic (`docs/bugs-archive.md`), the false-positive guard.** A register
    /// clocked by the global clock rises once a cycle, at a different instant each time — nothing
    /// to report. (A *gated* clock re-clocking mid-phase must also stay silent: this is the case
    /// that made a per-cycle "one rise" rule unusable.)
    #[test]
    fn a_clean_clock_reports_no_glitch() {
        let clean = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"and","type":"gate.and","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"and","pin":"in0"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"and","pin":"in1"}}}},
                {{"a":{{"comp":"and","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&clean, 1000);
        let rep = eng.run(5).expect("clean run");
        assert!(
            rep.clock_glitches.is_empty(),
            "a gated clock that follows the global clock must not be reported: {:?}",
            rep.clock_glitches
        );
    }

    /// **A net whose driver value carries the wrong width is reported, not fatal**
    /// (`docs/bugs-archive.md`). A testbench poke is where a wrong-width value can enter
    /// (`poke_at` does not check the width), so the fixture pokes a 1-bit pin with a 4-bit value:
    /// the net merges to `X`, the run finishes, and the report names the driver and both widths —
    /// where before, the merge `panic!`ed and the run produced *no report at all*.
    #[test]
    fn a_width_mismatched_driver_is_reported_not_fatal() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"src","type":"wiring.pin","pos":[0,0],"name":"src"}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"src","pin":"pin"}},"b":{{"comp":"r","pin":"d"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 1000);
        assert!(
            eng.poke_at("src", k(4, 0x5), 100),
            "poke a 4-bit value onto a 1-bit pin"
        );
        let rep = eng.run(1).expect("the run must finish, not panic");
        assert_eq!(
            rep.net_width_mismatches.len(),
            1,
            "{:?}",
            rep.net_width_mismatches
        );
        let (cycle, _net, _comp, got, want) = rep.net_width_mismatches[0];
        assert_eq!(
            (cycle, got, want),
            (0, 4, 1),
            "named the driver width and the net width (cycle 0: the poke is before the first edge)"
        );
    }

    /// **A3 (docs/derived-clock.md, test plan).** Edge times advance **monotonically**: the
    /// derived clock must never move backwards, which is the invariant that lets the settle
    /// be measured from the edge at all.
    #[test]
    fn edge_times_only_advance() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
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

        let now = |e: &DelayEngine| -> u64 {
            let v: serde_json::Value = serde_json::from_str(&e.snapshot()).expect("snapshot");
            v["now"].as_u64().expect("now")
        };
        let mut eng = engine(&json, 50);
        let mut last = 0;
        for i in 0..6 {
            eng.run(1).expect("a cycle");
            let n = now(&eng);
            assert!(
                n > last,
                "cycle {i}: edge time must advance ({last} -> {n})"
            );
            last = n;
        }
    }

    /// **F2 (docs/derived-clock.md, test plan).** A **divided** clock: the register's `clk`
    /// is driven by another register's output, so it rises on every *other* global edge.
    /// The discriminating assertion is that it does **not** latch on the falling half -- a
    /// latch on both halves would leave it 1 instead of 0.
    #[test]
    fn a_divided_clock_latches_on_the_rise_only() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"not1","type":"gate.not","pos":[0,0]}},
                {{"id":"r1","type":"mem.register","pos":[0,0],"name":"r1"}},
                {{"id":"r2","type":"mem.register","pos":[0,0],"name":"r2"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r1","pin":"rst"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"not1","pin":"in"}}}},
                {{"a":{{"comp":"not1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"r2","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r2","pin":"en"}}}},
                {{"a":{{"comp":"not1","pin":"out"}},"b":{{"comp":"r2","pin":"d"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r2","pin":"rst"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 50);
        eng.run(1).expect("cycle 1");
        assert_eq!(eng.named_value("r1"), Some(k(1, 1)), "r1 toggles each edge");
        assert_eq!(
            eng.named_value("r2"),
            Some(k(1, 1)),
            "r2 latched on r1's rise -- reading not1's PRE-settled output, because not1's \
             input changed at the same instant its clk rose. That is the hardware's own \
             race, not a modelling choice."
        );
        eng.run(1).expect("cycle 2");
        assert_eq!(eng.named_value("r1"), Some(k(1, 0)), "r1 toggled back");
        assert_eq!(
            eng.named_value("r2"),
            Some(k(1, 1)),
            "r1's clk FELL, so r2 must not latch -- and d became 0 in between, so a latch \
             on the falling half would have left r2 at 0"
        );
    }

    /// **F3 (docs/derived-clock.md, test plan).** A **self-oscillating** clock source -- a
    /// ring driving a register's `clk` -- never quiesces, so the drain never ends and the
    /// run must halt as an **oscillation**, not hang. The "never hang" contract, under the
    /// barrier.
    #[test]
    fn a_self_oscillating_clock_halts_as_an_oscillation() {
        let json = format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t", {SETTINGS},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zero","type":"wiring.constant","pos":[0,0]}},
                {{"id":"n1","type":"gate.not","pos":[0,0]}},
                {{"id":"n2","type":"gate.not","pos":[0,0]}},
                {{"id":"n3","type":"gate.not","pos":[0,0]}},
                {{"id":"r","type":"mem.register","pos":[0,0],"name":"r"}}
            ], "wires": [
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"n2","pin":"in"}}}},
                {{"a":{{"comp":"n2","pin":"out"}},"b":{{"comp":"n3","pin":"in"}}}},
                {{"a":{{"comp":"n3","pin":"out"}},"b":{{"comp":"n1","pin":"in"}}}},
                {{"a":{{"comp":"n2","pin":"out"}},"b":{{"comp":"r","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"en"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r","pin":"d"}}}},
                {{"a":{{"comp":"zero","pin":"out"}},"b":{{"comp":"r","pin":"rst"}}}}
            ]}}]
        }}"##
        );
        let mut eng = engine(&json, 50);
        let halt = eng.run(2).expect_err("a ring on clk must not settle");
        assert_eq!(halt.reason, HaltReason::Oscillation);
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
        let mut eng = wired_engine(&json, 5000);
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
        // The cycle count is a timeline fact: this fixture has no clocked parts, so its period
        // is the minimum step (2 ns) and the clock starts at 2 x 500 = 1000.
        assert_eq!(h.cycle, 500);
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
        assert_eq!(h2.cycle, 4500);
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
