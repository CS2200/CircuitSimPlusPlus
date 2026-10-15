//! CircuitSim++ Tauri shell.
//!
//! This crate is a **thin adapter**: it exposes the IPC contract from
//! `docs/tasks/README.md` §3 as Tauri commands, and forwards engine events
//! as Tauri events. All types come from `csim_core::api` — the shell owns
//! no semantics.
//!
//! Session model (DESIGN.md §7.2): one `Box<dyn Sim + Send>` per app,
//! guarded by a mutex in Tauri state; the engine runs on its own thread
//! and pushes events through a [`TauriSink`]. The concrete `Sim`
//! implementation is [`csim_core::session::Session`].

use std::sync::Mutex;

use csim_core::api::{
    CompId, EventSink, LoadResult, NetDiffs, SaveResult, Sim, SimHalted, SimStatus, TimingUpdate,
    WireValue,
};
use csim_core::session::Session;
use tauri::{AppHandle, Emitter, State};

/// Tauri event names (frontend subscribes to these — see `docs/ipc.md`).
pub mod events {
    /// Payload: [`csim_core::api::NetDiffs`]
    pub const NET_DIFFS: &str = "net_diffs";
    /// Payload: [`csim_core::api::SimStatus`]
    pub const SIM_STATUS: &str = "sim_status";
    /// Payload: [`csim_core::api::SimHalted`]
    pub const SIM_HALTED: &str = "sim_halted";
    /// Payload: [`csim_core::api::TimingUpdate`]
    pub const TIMING_UPDATE: &str = "timing_update";
}

/// Engine events → Tauri events (README §3). Emit failures are dropped:
/// a closed window must not crash the sim thread.
struct TauriSink(AppHandle);

impl EventSink for TauriSink {
    fn net_diffs(&mut self, diffs: &NetDiffs) {
        let _ = self.0.emit(events::NET_DIFFS, diffs);
    }
    fn status(&mut self, status: &SimStatus) {
        let _ = self.0.emit(events::SIM_STATUS, status);
    }
    fn halted(&mut self, halted: &SimHalted) {
        let _ = self.0.emit(events::SIM_HALTED, halted);
    }
    fn timing(&mut self, timing: &TimingUpdate) {
        let _ = self.0.emit(events::TIMING_UPDATE, timing);
    }
}

/// The one live simulation session (None before the first load).
struct SimState(Mutex<Option<Box<dyn Sim + Send>>>);

/// Construct a session over the real engine (the integration swap point).
fn new_session(sink: TauriSink) -> Result<Box<dyn Sim + Send>, String> {
    Ok(Box::new(Session::new(Box::new(sink))))
}

fn lock<'a>(
    state: &'a State<SimState>,
) -> Result<std::sync::MutexGuard<'a, Option<Box<dyn Sim + Send>>>, String> {
    state
        .0
        .lock()
        .map_err(|_| "sim state lock poisoned".to_string())
}

fn session(guard: &mut Option<Box<dyn Sim + Send>>) -> Result<&mut Box<dyn Sim + Send>, String> {
    guard
        .as_mut()
        .ok_or_else(|| "no circuit loaded".to_string())
}

// --- Commands (README §3). Errors reject the frontend's invoke() promise.

#[tauri::command]
fn load_circuit(
    app: AppHandle,
    state: State<SimState>,
    path: Option<String>,
    bytes: Option<Vec<u8>>,
) -> Result<LoadResult, String> {
    if path.is_none() && bytes.is_none() {
        return Err("load_circuit: a path or bytes is required".into());
    }
    let mut sim = new_session(TauriSink(app))?;
    let result = match (path, bytes) {
        (Some(p), _) => sim.load_circuit_path(&p),
        (None, Some(b)) => sim.load_circuit_bytes(&b),
        (None, None) => unreachable!("checked above"),
    };
    *lock(&state)? = Some(sim);
    Ok(result)
}

#[tauri::command]
fn save_circuit(
    state: State<SimState>,
    path: String,
    document: serde_json::Value,
) -> Result<SaveResult, String> {
    let mut guard = lock(&state)?;
    Ok(session(&mut guard)?.save_circuit(&path, &document))
}

#[tauri::command]
fn sim_play(state: State<SimState>, hz: u64) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.play(hz);
    Ok(())
}

#[tauri::command]
fn sim_pause(state: State<SimState>) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.pause();
    Ok(())
}

#[tauri::command]
fn sim_step_tick(state: State<SimState>) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.step_tick();
    Ok(())
}

#[tauri::command]
fn sim_step_cycles(state: State<SimState>, n: u64) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.step_cycles(n);
    Ok(())
}

#[tauri::command]
fn sim_run_until(state: State<SimState>, cycle: u64) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.run_until(cycle);
    Ok(())
}

/// Fresh power-on state; every memory's autoload image re-applies
/// (DESIGN.md §5.2 / G6).
#[tauri::command]
fn sim_reset(state: State<SimState>) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.reset();
    Ok(())
}

#[tauri::command]
fn poke(
    state: State<SimState>,
    comp_id: CompId,
    pin: String,
    value: WireValue,
) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.poke(comp_id, &pin, value);
    Ok(())
}

#[tauri::command]
fn mem_read(
    state: State<SimState>,
    name: String,
    addr: u64,
    len: u64,
) -> Result<Vec<WireValue>, String> {
    let mut guard = lock(&state)?;
    Ok(session(&mut guard)?.mem_read(&name, addr, len))
}

#[tauri::command]
fn mem_write(
    state: State<SimState>,
    name: String,
    addr: u64,
    values: Vec<WireValue>,
) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.mem_write(&name, addr, &values);
    Ok(())
}

#[tauri::command]
fn snapshot(state: State<SimState>, path: String) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.snapshot(&path);
    Ok(())
}

#[tauri::command]
fn resume(state: State<SimState>, path: String) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.resume(&path);
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(SimState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_circuit,
            save_circuit,
            sim_play,
            sim_pause,
            sim_step_tick,
            sim_step_cycles,
            sim_run_until,
            sim_reset,
            poke,
            mem_read,
            mem_write,
            snapshot,
            resume,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CircuitSim++");
}
