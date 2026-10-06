//! CircuitSim++ Tauri shell.
//!
//! This crate is a **thin adapter** (FRONTEND.md task U5 wires it to a real
//! engine): it exposes the IPC contract from `docs/tasks/README.md` §3 as
//! Tauri commands, and forwards engine events as Tauri events. All types come
//! from `csim_core::api` — the shell owns no semantics.
//!
//! Event names on the frontend side: `net_diffs`, `sim_status`, `sim_halted`,
//! `timing_update` (payloads are the `csim_core::api` types, serialized).

use csim_core::api::{CompId, LoadResult, NamedKind, SaveResult, SimMode, WireValue};
use tauri::Emitter;

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

// --- Commands (README §3). Bodies land in FRONTEND.md task U5 against a
// --- `csim_core::api::Sim` held in Tauri state on a dedicated sim thread.

#[tauri::command]
fn load_circuit(path: Option<String>, bytes: Option<Vec<u8>>) -> LoadResult {
    let _ = (path, bytes);
    unimplemented!("FRONTEND.md U5 — wire to csim_core::api::Sim")
}

#[tauri::command]
fn save_circuit(path: String, document: serde_json::Value) -> SaveResult {
    let _ = (path, document);
    unimplemented!("FRONTEND.md U5 — wire to csim_core::api::Sim")
}

#[tauri::command]
fn sim_play(hz: u64) {
    let _ = hz;
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn sim_pause() {
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn sim_step_tick() {
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn sim_step_cycles(n: u64) {
    let _ = n;
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn sim_run_until(cycle: u64) {
    let _ = cycle;
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn sim_set_mode(mode: SimMode) {
    let _ = mode;
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn poke(comp_id: CompId, pin: String, value: WireValue) {
    let _ = (comp_id, pin, value);
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn mem_read(name: String, addr: u64, len: u64) -> Vec<WireValue> {
    let _ = (name, addr, len);
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn mem_write(name: String, addr: u64, values: Vec<WireValue>) {
    let _ = (name, addr, values);
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn snapshot(path: String) {
    let _ = path;
    unimplemented!("FRONTEND.md U5")
}

#[tauri::command]
fn resume(path: String) {
    let _ = path;
    unimplemented!("FRONTEND.md U5")
}

/// Contract sanity: referenced so the compiler type-checks the event payload
/// types used by the frontend (task U5 will emit them for real).
#[allow(dead_code)]
fn emit_timing_update(app: &tauri::AppHandle, update: &csim_core::api::TimingUpdate) {
    let _ = app.emit(events::TIMING_UPDATE, update);
}

/// Contract sanity: keeps [`NamedKind`] referenced from the shell.
#[allow(dead_code)]
fn _named_kind_marker(_: NamedKind) {}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            load_circuit,
            save_circuit,
            sim_play,
            sim_pause,
            sim_step_tick,
            sim_step_cycles,
            sim_run_until,
            sim_set_mode,
            poke,
            mem_read,
            mem_write,
            snapshot,
            resume,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CircuitSim++");
}
