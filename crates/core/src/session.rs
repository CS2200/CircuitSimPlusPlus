//! Interactive simulation session — the [`crate::api::Sim`] contract keystone
//! the Tauri shell wires to (`crates/app`, FRONTEND.md task U5; contract
//! v1.1).
//!
//! One [`Session`] owns one open circuit: the stored [`Document`], the
//! flattened [`Netlist`], and the live delay-aware engine. All engine access
//! is serialized through one `Mutex`; `play` runs on a dedicated thread
//! that steps through the same mutex and stops on an atomic flag — no
//! lock is held across frames and every sink callback happens under the
//! lock, so events are emitted in a single, deterministic order.
//!
//! Semantics pinned by the contract (see `api` docs):
//!
//! - Exactly one **full** [`NetDiffs`] batch (`full: true`, all nets) is
//!   emitted after each successful `load_circuit_*`, `resume`, and
//!   `reset`; every later batch is diff-only.
//! - A **tick** is one clock half-period (advance to the next clock edge).
//! - `CompId`s on the wire are document-order indices within the
//!   referenced circuit; the engine's post-flatten ids are mapped back
//!   here.
//! - `reset` **rebuilds the engine from the stored document — all
//!   simulation state resets** (power-on) — and additionally re-applies
//!   every memory's `autoload` image (the G6 feature: reset reloads the
//!   program).
//! - Autoload paths resolve relative to the circuit file's directory and
//!   stay inside its tree (§11 sandbox). A session loaded from **bytes**
//!   has no base path: autoloads resolve against the current working
//!   directory (documented here per the contract).
//! - Operations with no error channel (`poke`, `mem_write`, `snapshot`,
//!   `resume`, `reset`) report failures as a `sim_halted` event with
//!   `reason: error`; unknown ids/names are silent no-ops.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::api::{
    CompId, EventSink, LoadError, LoadErrorKind, LoadResult, NetChange, NetDiffs, NetId,
    SaveResult, Sim, SimHalted, SimStatus, TimingUpdate, WireValue,
};
use crate::delay::{DelayEngine, Halt, RunReport};
use crate::format::{self, Document};
use crate::netlist::{self, Netlist};
use crate::timing_table::TimingTable;
use crate::value::Value;

/// Default clock half-period for the delay engine (ns); the same default
/// the autograder uses (docs/delay-table.md).
const DEFAULT_HALF_PERIOD: u64 = 1000;

/// Play loop frame time (diff batching granularity, §7.2).
const FRAME: Duration = Duration::from_millis(16);

/// The session API over one open circuit. Construct with an
/// [`EventSink`] (the Tauri shell's event emitter; the tests' recorder).
pub struct Session {
    inner: Arc<Mutex<Inner>>,
    play: Option<PlayHandle>,
}

struct PlayHandle {
    stop: Arc<AtomicBool>,
    join: JoinHandle<()>,
}

struct Inner {
    sink: Box<dyn EventSink>,
    doc: Option<Document>,
    /// Base directory for autoload resolution (the circuit file's
    /// directory; `None` → CWD for bytes-loaded sessions).
    circuit_dir: Option<PathBuf>,
    state: Option<SimState>,
}

struct SimState {
    engine: Engine,
    netlist: Netlist,
    half: u64,
    /// Root-circuit document-order index → engine id (poke mapping).
    root_flat: BTreeMap<u32, CompId>,
    /// Last emitted net values (diff baseline).
    last_values: Vec<Value>,
    /// Per-net "this net's X is a genuine short circuit" baseline (contract
    /// v1.2), parallel to `last_values`.
    last_contended: Vec<bool>,
    /// Delay mode: the most recent run's report (for `timing_update`).
    last_report: Option<RunReport>,
    running: bool,
    play_hz: u64,
    eff_hz: u64,
}

/// The one simulation engine: delay-aware (DESIGN.md §4.3). The wrapper
/// keeps the session plumbing engine-shaped; there is no second mode.
struct Engine(DelayEngine);

impl Engine {
    fn cycle(&self) -> u64 {
        self.0.cycle()
    }

    fn net_count(&self) -> usize {
        self.0.netlist().nets.len()
    }

    fn net_value(&self, net: usize) -> Value {
        self.0.net_value(NetId(net as u32))
    }

    /// True when a net's `X` is a genuine short circuit (contract v1.2).
    fn net_contended(&self, net: usize) -> bool {
        self.0.net_contended(NetId(net as u32))
    }

    /// Current simulation time in ns.
    fn now(&self) -> Option<u64> {
        Some(self.0.now())
    }

    /// Run `n` full cycles; `Err` on halt (sticky in the engine).
    fn run(&mut self, n: u64) -> Result<Option<RunReport>, Halt> {
        self.0.run(n).map(Some)
    }

    /// One contract tick: one clock half-period (advance to the next edge).
    fn tick(&mut self) -> Result<Option<RunReport>, Halt> {
        self.0.step_tick().map(|()| None)
    }

    /// Settle once without clocking (initial paint after load). The delay
    /// engine's construction-time boot settle already quiesced the circuit.
    fn settle_initial(&mut self) -> Result<(), Halt> {
        Ok(())
    }

    fn snapshot(&self) -> String {
        self.0.snapshot()
    }

    fn restore(&mut self, json: &str) -> Result<(), String> {
        self.0.restore(json)
    }

    fn poke_pin(&mut self, name: &str, v: Value) -> Result<bool, Halt> {
        Ok(self.0.poke_input_pin(name, v))
    }

    fn settle_cycle(&mut self) -> Result<(), Halt> {
        self.0.settle_cycle()
    }

    fn poke_button_at(&mut self, id: usize, pressed: bool) -> Result<bool, Halt> {
        Ok(self.0.poke_button_at(id, pressed))
    }

    fn poke_register_at(&mut self, id: usize, v: Value) -> Result<bool, Halt> {
        Ok(self.0.poke_register_at(id, v))
    }

    fn memory_word(&self, name: &str, addr: u64) -> Option<Value> {
        self.0.memory_word(name, addr)
    }

    fn set_memory_word(&mut self, name: &str, addr: u64, v: Value) -> bool {
        self.0.set_memory_word(name, addr, v)
    }

    fn load_memory_image(&mut self, name: &str, image: &[u64]) -> Result<bool, String> {
        self.0.load_memory_image(name, image)
    }
}

impl SimState {
    /// Every net's current value (fresh diff baseline).
    fn all_values(&self) -> Vec<Value> {
        (0..self.engine.net_count())
            .map(|i| self.engine.net_value(i))
            .collect()
    }

    /// Whether each net's `X` is a genuine short circuit (contract v1.2) —
    /// `false` for every net that is not currently `X`.
    fn all_contended(&self) -> Vec<bool> {
        (0..self.engine.net_count())
            .map(|i| self.engine.net_value(i).has_x() && self.engine.net_contended(i))
            .collect()
    }

    /// Emit the one initial full batch (contract v1.1).
    fn emit_full_batch(&mut self, sink: &mut dyn EventSink) {
        let changes = (0..self.engine.net_count())
            .map(|i| {
                let val = self.engine.net_value(i);
                NetChange {
                    net: NetId(i as u32),
                    at: self.engine.now(),
                    val: val.to_wire_value(),
                    contended: (val.has_x() && self.engine.net_contended(i)).then_some(true),
                }
            })
            .collect();
        self.last_values = self.all_values();
        self.last_contended = self.all_contended();
        sink.net_diffs(&NetDiffs {
            cycle: self.engine.cycle(),
            changes,
            full: true,
        });
    }

    /// Emit a diff-only batch for nets that changed since the last emit.
    fn emit_diffs(&mut self, sink: &mut dyn EventSink) {
        let at = self.engine.now();
        let mut changes = Vec::new();
        for i in 0..self.engine.net_count() {
            let v = self.engine.net_value(i);
            // A driver conflict always shows up as X, so only an X net can be
            // shorted — which keeps the (driver-merging) check off the hot path.
            let contended = v.has_x() && self.engine.net_contended(i);
            if v != self.last_values[i] || contended != self.last_contended[i] {
                changes.push(NetChange {
                    net: NetId(i as u32),
                    val: v.to_wire_value(),
                    at,
                    contended: contended.then_some(true),
                });
                self.last_values[i] = v;
                self.last_contended[i] = contended;
            }
        }
        if !changes.is_empty() {
            sink.net_diffs(&NetDiffs {
                cycle: self.engine.cycle(),
                changes,
                full: false,
            });
        }
    }

    fn emit_status(&self, sink: &mut dyn EventSink) {
        sink.status(&SimStatus {
            running: self.running,
            cycle: self.engine.cycle(),
            eff_hz: self.eff_hz,
        });
    }

    fn emit_halted(&self, sink: &mut dyn EventSink, h: &Halt) {
        sink.halted(&SimHalted {
            cycle: h.cycle,
            reason: h.reason,
            details: h.details.clone(),
        });
    }

    fn emit_error(&self, sink: &mut dyn EventSink, details: String) {
        sink.halted(&SimHalted {
            cycle: self.engine.cycle(),
            reason: crate::api::HaltReason::Error,
            details,
        });
    }

    /// DTA results for `timing_update` (DESIGN.md §4.4).
    fn emit_timing(&self, sink: &mut dyn EventSink) {
        let e = &self.engine.0;
        let cycles = e.cycle();
        let t_obs = e.t_obs();
        let update = TimingUpdate {
            t_obs,
            est_time: cycles.saturating_mul(t_obs),
            violations: e
                .violations()
                .iter()
                .map(|v| crate::autograde::api_violation(&self.netlist, v))
                .collect(),
            top_paths: self
                .last_report
                .as_ref()
                .map(|r| {
                    r.top_paths
                        .iter()
                        .flat_map(|(settle, path)| {
                            crate::autograde::api_path(&self.netlist, *settle, path)
                        })
                        .collect()
                })
                .unwrap_or_default(),
        };
        sink.timing(&update);
    }

    /// Run `n` cycles, emitting diffs and, on a halt, `sim_halted`.
    fn run_cycles(&mut self, n: u64, sink: &mut dyn EventSink) {
        match self.engine.run(n) {
            Ok(rep) => {
                if rep.is_some() {
                    self.last_report = rep;
                }
            }
            Err(h) => {
                self.running = false;
                self.emit_diffs(sink);
                self.emit_halted(sink, &h);
                self.emit_status(sink);
                return;
            }
        }
        self.emit_diffs(sink);
    }
}

/// Build a fresh engine + netlist from a validated document.
fn build_engine(
    doc: &Document,
    half: u64,
) -> Result<(Engine, Netlist, TimingTable), Vec<LoadError>> {
    let nl = netlist::build(doc)?;
    let table = TimingTable::builtin(&doc.settings.delay_table).map_err(|e| {
        vec![LoadError {
            kind: LoadErrorKind::Other,
            message: format!("settings.delayTable: {e}"),
            circuit: String::new(),
            comp_id: None,
            wire_idx: None,
        }]
    })?;
    let engine = Engine(DelayEngine::new(nl.clone(), half.max(1), &table)?);
    Ok((engine, nl, table))
}

/// Root-circuit document-order → engine id mapping (poke addressing).
fn root_flat_map(doc: &Document, nl: &Netlist) -> BTreeMap<u32, CompId> {
    let root_name: &str = &doc.circuits[nl.root].name;
    nl.comps
        .iter()
        .filter(|c| c.inst_path.is_empty() && c.def_circuit == root_name)
        .map(|c| (c.def_idx as u32, c.id))
        .collect()
}

impl Session {
    /// A session with no circuit yet; events go to `sink`.
    pub fn new(sink: Box<dyn EventSink>) -> Session {
        Session {
            inner: Arc::new(Mutex::new(Inner {
                sink,
                doc: None,
                circuit_dir: None,
                state: None,
            })),
            play: None,
        }
    }

    /// Stop the play thread, if any (idempotent).
    fn stop_play(&mut self) {
        if let Some(h) = self.play.take() {
            h.stop.store(true, Ordering::Relaxed);
            let _ = h.join.join();
        }
    }

    /// Shared load path: parse + validate + build + initial full batch.
    fn load_impl(&mut self, bytes: &[u8], base: Option<PathBuf>) -> LoadResult {
        self.stop_play();
        let mut inner = self.inner.lock().expect("session mutex poisoned");
        let fail = |errors: Vec<LoadError>| LoadResult {
            ok: false,
            errors,
            net_map: Vec::new(),
            named: Vec::new(),
        };
        let doc = match format::load_document(bytes) {
            Ok(d) => d,
            Err(errors) => {
                inner.doc = None;
                inner.state = None;
                return fail(errors);
            }
        };
        match build_engine(&doc, DEFAULT_HALF_PERIOD) {
            Err(errors) => {
                inner.doc = None;
                inner.state = None;
                fail(errors)
            }
            Ok((engine, nl, _table)) => {
                let root_flat = root_flat_map(&doc, &nl);
                let net_map = nl.net_map.clone();
                let named = nl.named.clone();
                let st = SimState {
                    engine,
                    netlist: nl,
                    half: DEFAULT_HALF_PERIOD,
                    root_flat,
                    last_values: Vec::new(),
                    last_contended: Vec::new(),
                    last_report: None,
                    running: false,
                    play_hz: 0,
                    eff_hz: 0,
                };
                inner.state = Some(st);
                inner.doc = Some(doc);
                inner.circuit_dir = base;
                // G6/§5.2: autoload images apply at startup (and on every
                // reset — see `reset`).
                Self::apply_autoloads(&mut inner);
                // Initial paint: the delay engine already boot-settled at
                // construction; a power-on halt (e.g. a floating input) is
                // reported, not hidden.
                let Inner { state, sink, .. } = &mut *inner;
                let st = state.as_mut().expect("just stored");
                let initial_halt = st.engine.settle_initial().err();
                st.emit_full_batch(&mut **sink);
                if let Some(h) = initial_halt {
                    st.emit_halted(&mut **sink, &h);
                } else {
                    // A boot-settle halt is sticky in the engine; surface it.
                    if let Some(h) = st.engine.0.halted() {
                        let h = h.clone();
                        st.emit_halted(&mut **sink, &h);
                    }
                }
                st.emit_status(&mut **sink);
                LoadResult {
                    ok: true,
                    errors: Vec::new(),
                    net_map,
                    named,
                }
            }
        }
    }

    /// Rebuild the engine from the stored document (the reset core): all
    /// simulation state resets to power-on; the fresh full batch is
    /// emitted by the caller.
    fn rebuild(inner: &mut Inner) -> Result<(), Vec<LoadError>> {
        let Some(doc) = inner.doc.clone() else {
            return Err(vec![LoadError {
                kind: LoadErrorKind::Other,
                message: "no circuit loaded".to_string(),
                circuit: String::new(),
                comp_id: None,
                wire_idx: None,
            }]);
        };
        let half = inner.state.as_ref().map_or(DEFAULT_HALF_PERIOD, |s| s.half);
        let (engine, nl, _table) = build_engine(&doc, half)?;
        let root_flat = root_flat_map(&doc, &nl);
        inner.state = Some(SimState {
            engine,
            netlist: nl,
            half,
            root_flat,
            last_values: Vec::new(),
            last_contended: Vec::new(),
            last_report: None,
            running: false,
            play_hz: 0,
            eff_hz: 0,
        });
        Ok(())
    }

    /// Re-apply every memory's `autoload` image (G6/§5.2; F12:
    /// hierarchical names; §11 sandboxing). Failures are reported via
    /// `sim_halted` with `reason: error`.
    fn apply_autoloads(inner: &mut Inner) {
        let Some(doc) = &inner.doc else { return };
        let autoloads = netlist::autoload_memories(doc);
        if autoloads.is_empty() {
            return;
        }
        let base = inner
            .circuit_dir
            .clone()
            .unwrap_or_else(|| PathBuf::from("."));
        let Inner { state, sink, .. } = &mut *inner;
        let Some(st) = state.as_mut() else { return };
        for (name, rel) in autoloads {
            let result = (|| -> Result<(), String> {
                let path = sandbox_resolve(&base, Path::new(&rel))?;
                let text = std::fs::read_to_string(&path)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                let depth = crate::autograde::memory_depth(&st.netlist, &name)
                    .ok_or_else(|| format!("no named memory '{name}'"))?;
                let words = crate::format::rle::parse(&text, depth as usize)
                    .map_err(|e| format!("{}: {e}", path.display()))?;
                match st.engine.load_memory_image(&name, &words) {
                    Ok(true) => Ok(()),
                    Ok(false) => Err(format!("no named memory '{name}'")),
                    Err(e) => Err(format!("{name}: {e}")),
                }
            })();
            if let Err(e) = result {
                st.emit_error(&mut **sink, format!("autoload: {e}"));
            }
        }
    }
}

/// §11 sandbox: `path` resolved under `root` must stay under `root`.
fn sandbox_resolve(root: &Path, path: &Path) -> Result<PathBuf, String> {
    let joined = root.join(path);
    let canon_root = root
        .canonicalize()
        .map_err(|e| format!("{}: {e}", root.display()))?;
    let canon = joined
        .canonicalize()
        .map_err(|e| format!("{}: {e}", joined.display()))?;
    if canon.starts_with(&canon_root) {
        Ok(canon)
    } else {
        Err(format!(
            "{}: outside the circuit's directory tree (§11)",
            joined.display()
        ))
    }
}

impl Sim for Session {
    fn load_circuit_bytes(&mut self, bytes: &[u8]) -> LoadResult {
        // No base path: autoloads resolve against the CWD (module docs).
        self.load_impl(bytes, None)
    }

    fn load_circuit_path(&mut self, path: &str) -> LoadResult {
        let p = Path::new(path);
        let base = p.parent().map(Path::to_path_buf);
        match std::fs::read(p) {
            Ok(bytes) => self.load_impl(&bytes, base),
            Err(e) => {
                self.stop_play();
                LoadResult {
                    ok: false,
                    errors: vec![LoadError {
                        kind: LoadErrorKind::Io,
                        message: format!("{}: {e}", p.display()),
                        circuit: String::new(),
                        comp_id: None,
                        wire_idx: None,
                    }],
                    net_map: Vec::new(),
                    named: Vec::new(),
                }
            }
        }
    }

    fn save_circuit(&mut self, path: &str, document: &serde_json::Value) -> SaveResult {
        // One shared implementation: parse → validate → canonicalize → atomic
        // write (autosave uses the same path, so bytes are identical).
        match format::save_json_atomic(path, document) {
            Ok(()) => SaveResult {
                ok: true,
                errors: Vec::new(),
            },
            Err(errors) => SaveResult { ok: false, errors },
        }
    }

    fn play(&mut self, hz: u64) {
        self.stop_play();
        let stop = Arc::new(AtomicBool::new(false));
        let inner = Arc::clone(&self.inner);
        let stop2 = Arc::clone(&stop);
        {
            let mut g = inner.lock().expect("session mutex poisoned");
            let Inner { state, sink, .. } = &mut *g;
            let Some(st) = state.as_mut() else { return };
            st.running = true;
            st.play_hz = hz;
            st.emit_status(&mut **sink);
        }
        let join = std::thread::spawn(move || {
            let mut last_status = Instant::now();
            let mut status_base_cycle = 0u64;
            loop {
                if stop2.load(Ordering::Relaxed) {
                    break;
                }
                {
                    let mut g = inner.lock().expect("session mutex poisoned");
                    let Inner { state, sink, .. } = &mut *g;
                    let Some(st) = state.as_mut() else { break };
                    if !st.running {
                        break;
                    }
                    let chunk = (st.play_hz / 60).max(1);
                    st.run_cycles(chunk, &mut **sink);
                    let now = Instant::now();
                    if now.duration_since(last_status) >= Duration::from_secs(1) {
                        let done = st.engine.cycle().saturating_sub(status_base_cycle);
                        st.eff_hz = done; // ~1 s window
                        status_base_cycle = st.engine.cycle();
                        last_status = now;
                        st.emit_status(&mut **sink);
                    }
                    if !st.running {
                        break; // halted inside run_cycles
                    }
                }
                std::thread::sleep(FRAME);
            }
        });
        self.play = Some(PlayHandle { stop, join });
    }

    fn pause(&mut self) {
        self.stop_play();
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        if let Some(st) = state.as_mut() {
            st.running = false;
            st.emit_status(&mut **sink);
            st.emit_timing(&mut **sink);
        }
    }

    fn step_tick(&mut self) {
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        match st.engine.tick() {
            Ok(rep) => {
                if rep.is_some() {
                    st.last_report = rep;
                }
            }
            Err(h) => {
                st.emit_diffs(&mut **sink);
                st.emit_halted(&mut **sink, &h);
                st.emit_status(&mut **sink);
                return;
            }
        }
        st.emit_diffs(&mut **sink);
        st.emit_status(&mut **sink);
    }

    fn step_cycles(&mut self, n: u64) {
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        st.run_cycles(n, &mut **sink);
        st.emit_status(&mut **sink);
    }

    fn run_until(&mut self, cycle: u64) {
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        let cur = st.engine.cycle();
        if cycle > cur {
            st.run_cycles(cycle - cur, &mut **sink);
        }
        st.emit_status(&mut **sink);
        st.emit_timing(&mut **sink);
    }

    fn poke(&mut self, comp_id: CompId, pin: &str, value: WireValue) {
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        let Some(&flat) = st.root_flat.get(&comp_id.0) else {
            return; // unknown id: no-op (module docs)
        };
        let fc = &st.netlist.comps[flat.idx()];
        let type_ = fc.type_.clone();
        let name = fc.name.clone().unwrap_or_default();
        let is_output = fc
            .attrs
            .get("isOutput")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let width = fc.pins.first().map(|p| p.width).unwrap_or(1);
        let result = match type_.as_str() {
            "wiring.pin" if pin == "pin" && !is_output => {
                match Value::from_wire_value(&value, width) {
                    Ok(v) => st.engine.poke_pin(&name, v),
                    Err(e) => {
                        st.emit_error(&mut **sink, format!("poke: {e}"));
                        return;
                    }
                }
            }
            "io.button" => {
                let pressed = Value::from_wire_value(&value, 1)
                    .and_then(|v| v.to_u64().ok_or(crate::value::ValueError::OverlappingMasks))
                    .map(|n| n == 1)
                    .unwrap_or(false);
                // Poke by flat id, so an UNNAMED button is still pressable.
                st.engine.poke_button_at(flat.idx(), pressed)
            }
            "mem.register" => match Value::from_wire_value(&value, width) {
                Ok(v) => st.engine.poke_register_at(flat.idx(), v),
                Err(e) => {
                    st.emit_error(&mut **sink, format!("poke: {e}"));
                    return;
                }
            },
            _ => return, // unsupported poke target: no-op
        };
        match result {
            Ok(_) => {
                // An interactive poke must take effect THIS cycle: settle the
                // queued propagation (without firing a clock edge) before
                // reporting diffs, so the new value and its downstream cone
                // show immediately at the current cycle.
                if let Err(h) = st.engine.settle_cycle() {
                    st.emit_diffs(&mut **sink);
                    st.emit_halted(&mut **sink, &h);
                    st.emit_status(&mut **sink);
                    return;
                }
                st.emit_diffs(&mut **sink);
            }
            Err(h) => {
                st.emit_diffs(&mut **sink);
                st.emit_halted(&mut **sink, &h);
                st.emit_status(&mut **sink);
            }
        }
    }

    fn mem_read(&self, name: &str, addr: u64, len: u64) -> Vec<WireValue> {
        let g = self.inner.lock().expect("session mutex poisoned");
        let Some(st) = g.state.as_ref() else {
            return Vec::new();
        };
        (0..len)
            .filter_map(|i| {
                st.engine
                    .memory_word(name, addr.saturating_add(i))
                    .map(|v| v.to_wire_value())
            })
            .collect()
    }

    fn mem_write(&mut self, name: &str, addr: u64, values: &[WireValue]) {
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        for (i, wv) in values.iter().enumerate() {
            let a = addr.saturating_add(i as u64);
            let Some(width) = st.engine.memory_word(name, a).map(|v| v.width()) else {
                continue;
            };
            match Value::from_wire_value(wv, width) {
                Ok(v) => {
                    st.engine.set_memory_word(name, a, v);
                }
                Err(e) => {
                    st.emit_error(&mut **sink, format!("mem_write: {e}"));
                }
            }
        }
    }

    fn snapshot(&mut self, path: &str) {
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        let json = st.engine.snapshot();
        if let Err(e) = std::fs::write(path, json) {
            st.emit_error(&mut **sink, format!("snapshot: {path}: {e}"));
        }
    }

    fn resume(&mut self, path: &str) {
        self.stop_play();
        let mut g = self.inner.lock().expect("session mutex poisoned");
        let Inner { state, sink, .. } = &mut *g;
        let Some(st) = state.as_mut() else { return };
        match std::fs::read_to_string(path)
            .map_err(|e| format!("resume: {path}: {e}"))
            .and_then(|json| st.engine.restore(&json))
        {
            Ok(()) => {
                // Contract: resume re-emits a full batch.
                st.emit_full_batch(&mut **sink);
                st.emit_status(&mut **sink);
            }
            Err(e) => st.emit_error(&mut **sink, e),
        }
    }

    fn reset(&mut self) {
        self.stop_play();
        let mut g = self.inner.lock().expect("session mutex poisoned");
        if g.doc.is_none() {
            return;
        }
        if let Err(errors) = Self::rebuild(&mut g) {
            let msg = errors
                .iter()
                .map(|e| e.message.as_str())
                .collect::<Vec<_>>()
                .join("; ");
            let Inner { state, sink, .. } = &mut *g;
            if let Some(st) = state.as_mut() {
                st.emit_error(&mut **sink, format!("reset rebuild failed: {msg}"));
            }
            return;
        }
        // G6: re-power-on AND re-apply every autoload image.
        Self::apply_autoloads(&mut g);
        let Inner { state, sink, .. } = &mut *g;
        let st = state.as_mut().expect("rebuilt");
        let halt = st.engine.settle_initial().err();
        st.emit_full_batch(&mut **sink);
        if let Some(h) = halt {
            st.emit_halted(&mut **sink, &h);
        }
        st.emit_status(&mut **sink);
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.stop_play();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    /// Recorded sink: captures every event for assertions.
    #[derive(Default)]
    struct Rec {
        diffs: Vec<NetDiffs>,
        statuses: Vec<SimStatus>,
        halts: Vec<SimHalted>,
        timings: Vec<TimingUpdate>,
    }

    #[derive(Clone, Default)]
    struct RecSink(Arc<StdMutex<Rec>>);

    impl EventSink for RecSink {
        fn net_diffs(&mut self, d: &NetDiffs) {
            self.0.lock().unwrap().diffs.push(d.clone());
        }
        fn status(&mut self, s: &SimStatus) {
            self.0.lock().unwrap().statuses.push(s.clone());
        }
        fn halted(&mut self, h: &SimHalted) {
            self.0.lock().unwrap().halts.push(h.clone());
        }
        fn timing(&mut self, t: &TimingUpdate) {
            self.0.lock().unwrap().timings.push(t.clone());
        }
    }

    /// Counter circuit with an autoloading RAM (written into a temp dir).
    fn counter_doc(autoload: Option<&str>) -> String {
        let auto = autoload
            .map(|a| format!(r#","autoload":"{a}""#))
            .unwrap_or_default();
        format!(
            r##"{{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t",
            "settings": {{"clockHz":1,"delayTable":"cs2200-74ls-v1"}},
            "circuits": [{{ "name": "main", "components": [
                {{"id":"clk","type":"wiring.clock","pos":[0,0]}},
                {{"id":"one","type":"wiring.constant","pos":[0,0],"attrs":{{"value":"1"}}}},
                {{"id":"zw","type":"wiring.constant","pos":[0,0]}},
                {{"id":"za","type":"wiring.constant","pos":[0,0],"attrs":{{"bitsize":2}}}},
                {{"id":"r1","type":"mem.register","pos":[0,0],"name":"r1"}},
                {{"id":"n1","type":"gate.not","pos":[0,0]}},
                {{"id":"m","type":"mem.ram","pos":[0,0],"name":"dmem",
                  "attrs":{{"bitsize":8,"depth":4{auto}}}}},
                {{"id":"p","type":"wiring.probe","pos":[0,0],"name":"q"}}
            ], "wires": [
                {{"a":{{"comp":"clk","pin":"out"}},"b":{{"comp":"r1","pin":"clk"}}}},
                {{"a":{{"comp":"one","pin":"out"}},"b":{{"comp":"r1","pin":"en"}}}},
                {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"r1","pin":"rst"}}}},
                {{"a":{{"comp":"n1","pin":"out"}},"b":{{"comp":"r1","pin":"d"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"n1","pin":"in"}}}},
                {{"a":{{"comp":"r1","pin":"q"}},"b":{{"comp":"p","pin":"in"}}}},
                {{"a":{{"comp":"zw","pin":"out"}},"b":{{"comp":"m","pin":"we"}}}},
                {{"a":{{"comp":"za","pin":"out"}},"b":{{"comp":"m","pin":"addr"}}}}
            ]}}]
        }}"##
        )
    }

    fn session(bytes: &str) -> (Session, Arc<StdMutex<Rec>>) {
        let rec = RecSink::default();
        let mut s = Session::new(Box::new(rec.clone()));
        let res = s.load_circuit_bytes(bytes.as_bytes());
        assert!(res.ok, "{:?}", res.errors);
        (s, rec.0)
    }

    #[test]
    fn load_emits_one_full_batch_then_diffs_only() {
        let (mut s, rec) = session(&counter_doc(None));
        {
            let r = rec.lock().unwrap();
            assert_eq!(r.diffs.len(), 1, "exactly one initial batch");
            assert!(r.diffs[0].full, "initial batch is full");
            // Delay mode: the full batch's entries carry `at`.
            assert!(r.diffs[0].changes.iter().all(|c| c.at.is_some()));
        }
        // Every net is in the full batch.
        let n_nets = rec.lock().unwrap().diffs[0].changes.len();
        assert!(n_nets > 5);
        s.step_cycles(1);
        let r = rec.lock().unwrap();
        assert!(r.diffs.len() >= 2, "a diff batch followed the step");
        assert!(r.diffs[1..].iter().all(|d| !d.full));
        // Delay mode: diff entries carry `at`.
        assert!(r.diffs[1].changes.iter().all(|c| c.at.is_some()));
    }

    #[test]
    fn named_ids_are_document_order() {
        let (s, _) = session(&counter_doc(None));
        let g = s.inner.lock().unwrap();
        let st = g.state.as_ref().unwrap();
        let r1 = st.netlist.named.iter().find(|n| n.name == "r1").unwrap();
        assert_eq!(r1.circuit, "main");
        assert_eq!(r1.comp_id, CompId(4)); // clk, one, zw, za, r1 → index 4
    }

    #[test]
    fn step_tick_counts_cycles_and_timing_update_on_run_until() {
        let (mut s, rec) = session(&counter_doc(None));
        s.step_tick(); // to the rising edge: cycle 1
        assert_eq!(last_cycle(&rec), 1);
        s.step_tick(); // falling edge: still cycle 1
        assert_eq!(last_cycle(&rec), 1);
        s.step_tick(); // next rising edge: cycle 2
        assert_eq!(last_cycle(&rec), 2);
        s.run_until(4);
        assert_eq!(last_cycle(&rec), 4);
        let r = rec.lock().unwrap();
        let t = r.timings.last().expect("timing_update on run_until");
        assert!(t.t_obs > 0);
        assert_eq!(t.est_time, 4 * t.t_obs);
        assert!(t.violations.is_empty());
        // r1 toggles every cycle: q = 0 after 4 cycles → register value 0.
    }

    #[test]
    fn reset_reapplies_autoload_image() {
        let dir = std::env::temp_dir().join(format!("csim-session-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("img.hex"), "aa bb 2-00\n").unwrap();
        let circuit = dir.join("c.csx");
        std::fs::write(&circuit, counter_doc(Some("img.hex"))).unwrap();

        let rec = RecSink::default();
        let mut s = Session::new(Box::new(rec.clone()));
        assert!(s.load_circuit_path(circuit.to_str().unwrap()).ok);
        assert_eq!(s.mem_read("dmem", 0, 2)[0].v, "aa");
        // Corrupt the memory, then reset: the image comes back.
        s.mem_write(
            "dmem",
            0,
            &[WireValue {
                v: "ff".into(),
                x: String::new(),
                z: String::new(),
            }],
        );
        assert_eq!(s.mem_read("dmem", 0, 2)[0].v, "ff");
        s.reset();
        assert_eq!(s.mem_read("dmem", 0, 1)[0].v, "aa");
        assert_eq!(s.mem_read("dmem", 1, 1)[0].v, "bb");
        // reset also restarts the clock.
        assert_eq!(last_cycle(&rec.0), 0);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn snapshot_resume_roundtrip_and_full_batch() {
        let dir = std::env::temp_dir().join(format!("csim-session-snap-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let snap = dir.join("state.json");
        let (mut s, rec) = session(&counter_doc(None));
        s.step_cycles(3);
        assert_eq!(last_cycle(&rec), 3);
        s.snapshot(snap.to_str().unwrap());
        s.step_cycles(2);
        assert_eq!(last_cycle(&rec), 5);
        let batches_before = rec.lock().unwrap().diffs.len();
        s.resume(snap.to_str().unwrap());
        assert_eq!(last_cycle(&rec), 3);
        let r = rec.lock().unwrap();
        assert_eq!(r.diffs.len(), batches_before + 1);
        assert!(r.diffs.last().unwrap().full, "resume re-emits a full batch");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn poke_and_halt_details_prefix() {
        // Floating input on a gate → halt with the contract prefix.
        let json = r##"{
            "format": "circuitsim-plus-plus", "version": 3, "name": "t",
            "settings": {"clockHz":1,"delayTable":"cs2200-74ls-v1"},
            "circuits": [{ "name": "main", "components": [
                {"id":"c","type":"wiring.constant","pos":[0,0]},
                {"id":"g","type":"gate.and","pos":[0,0]}
            ], "wires": [
                {"a":{"comp":"c","pin":"out"},"b":{"comp":"g","pin":"in0"}}
            ]}]
        }"##;
        let rec = RecSink::default();
        let mut s = Session::new(Box::new(rec.clone()));
        assert!(s.load_circuit_bytes(json.as_bytes()).ok);
        let r = rec.0.lock().unwrap();
        let h = r.halts.last().expect("power-on floating read");
        assert_eq!(h.reason, crate::api::HaltReason::FloatingRead);
        assert!(
            h.details
                .starts_with("comp 1 pin \"in1\": floating (Z) value consumed"),
            "got: {}",
            h.details
        );
    }

    fn last_cycle(rec: &Arc<StdMutex<Rec>>) -> u64 {
        rec.lock()
            .unwrap()
            .statuses
            .last()
            .map(|s| s.cycle)
            .unwrap_or(0)
    }
}
