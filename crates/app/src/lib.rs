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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

mod history;
mod recovery;

use csim_core::api::{
    CompId, EventSink, LoadResult, NetDiffs, SaveResult, Sim, SimHalted, SimStatus, TimingUpdate,
    Watch, WireValue,
};
use csim_core::session::Session;
use tauri::{AppHandle, Emitter, Manager, State};

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
        // Both (contract v1.5): the bytes ARE the document, the path is where it
        // lives — the editor's current text, autoloads resolved next to the file.
        (Some(p), Some(b)) => sim.load_circuit_bytes_at(&b, &p),
        (Some(p), None) => sim.load_circuit_path(&p),
        (None, Some(b)) => sim.load_circuit_bytes(&b),
        (None, None) => unreachable!("checked above"),
    };
    *lock(&state)? = Some(sim);
    Ok(result)
}

/// Write an exported canvas image (`data:image/png;base64,…`) to `path`.
///
/// The canvas lives in the webview, so the bytes arrive as a data URL; the
/// shell owns the filesystem, exactly like `save_circuit` (§U6).
#[tauri::command]
fn save_image(path: String, data_url: String) -> Result<(), String> {
    use base64::Engine as _;
    let encoded = data_url
        .split_once(',')
        .map(|(_, b)| b)
        .unwrap_or(&data_url);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .map_err(|e| format!("bad image data: {e}"))?;
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path}: {e}"))
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

/// Pause when a component reads a value the model had to call unknown (DESIGN.md §4.1) —
/// the editor's "stop and ask". The value is `X` (nothing is assumed), and the halt is a
/// *pause*: pressing play carries on from exactly there, like a breakpoint.
#[tauri::command]
fn sim_set_pause_on_unknown(state: State<SimState>, pause: bool) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.set_pause_on_unknown(pause);
    Ok(())
}

/// Install the caller's stop conditions (contract v1.6): `step*`/`run_until` stop early when one
/// holds and report `reason: stop` — a *stop*, not a fault, so the next call carries on. An empty
/// array clears them; a bad name/literal is reported as an `error` halt (the engine keeps its
/// previous watches).
#[tauri::command]
fn sim_set_watch(state: State<SimState>, watch: Vec<Watch>) -> Result<(), String> {
    let mut guard = lock(&state)?;
    session(&mut guard)?.set_watch(&watch);
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

// --- Crash-recovery store (autosave, phase 1) -----------------------------
//
// Filesystem work lives in `recovery`; these commands only resolve the app
// data directory. Routing writes through Rust (rather than granting the
// webview `fs:allow-write-*`) keeps the sandbox narrow.

/// The app data directory the recovery store lives under.
fn recovery_base(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("app data dir: {e}"))
}

/// Write the recovery copy for an open document; returns its storage key
/// (pass it back to `autosave_recover_read`/`_discard`).
#[tauri::command]
fn autosave_recover_write(
    app: AppHandle,
    path: Option<String>,
    doc_key: String,
    name: String,
    label: String,
    at_ms: u64,
    document: serde_json::Value,
) -> Result<String, String> {
    let base = recovery_base(&app)?;
    let key = recovery::key_for(path.as_deref(), &doc_key);
    let envelope = recovery::envelope(path, name, label, at_ms, document);
    recovery::write(&base, &key, &envelope).map_err(|e| e.to_string())?;
    Ok(key)
}

/// Every recovery copy on disk, newest first.
#[tauri::command]
fn autosave_recover_list(app: AppHandle) -> Result<Vec<recovery::RecoveryMeta>, String> {
    Ok(recovery::list(&recovery_base(&app)?))
}

/// The stored `.csx` document for `key` (`None` when absent/unreadable).
#[tauri::command]
fn autosave_recover_read(app: AppHandle, key: String) -> Result<Option<String>, String> {
    Ok(recovery::read(&recovery_base(&app)?, &key))
}

/// Remove one recovery copy (`true` when a file was removed).
#[tauri::command]
fn autosave_recover_discard(app: AppHandle, key: String) -> Result<bool, String> {
    recovery::discard(&recovery_base(&app)?, &key).map_err(|e| e.to_string())
}

// --- Version store (autosave phase 2) -------------------------------------
//
// Same document key as the recovery store, so history and recovery agree on
// what "this document" is. The canonical text is produced Rust-side (via
// csim-core), so a snapshot is byte-identical to a save and dedupes by content.

/// The history entry key for a document, from its path or per-session id.
fn history_key(path: Option<&str>, doc_key: &str) -> String {
    recovery::key_for(path, doc_key)
}

/// Canonicalize the document, then record it as the document's newest version.
/// `coalesce_ms > 0` folds the write into a recent automatic version.
#[tauri::command]
fn history_snapshot(
    app: AppHandle,
    path: Option<String>,
    doc_key: String,
    document: serde_json::Value,
    label: String,
    at_ms: u64,
    coalesce_ms: u64,
) -> Result<history::Snapshot, String> {
    let text = csim_core::format::canonical_document(&document).map_err(|errors| {
        errors
            .first()
            .map(|e| e.message.clone())
            .unwrap_or_default()
    })?;
    let key = history_key(path.as_deref(), &doc_key);
    history::snapshot(
        &recovery_base(&app)?,
        &key,
        &text,
        &label,
        at_ms,
        coalesce_ms,
    )
    .map_err(|e| e.to_string())
}

/// Every version for a document, newest first.
#[tauri::command]
fn history_list(
    app: AppHandle,
    path: Option<String>,
    doc_key: String,
) -> Result<Vec<history::VersionMeta>, String> {
    Ok(history::list(
        &recovery_base(&app)?,
        &history_key(path.as_deref(), &doc_key),
    ))
}

/// The canonical `.csx` text of one version.
#[tauri::command]
fn history_read(
    app: AppHandle,
    path: Option<String>,
    doc_key: String,
    id: String,
) -> Result<Option<String>, String> {
    Ok(history::read(
        &recovery_base(&app)?,
        &history_key(path.as_deref(), &doc_key),
        &id,
    ))
}

/// Promote a version to "named" (exempt from retention).
#[tauri::command]
fn history_name(
    app: AppHandle,
    path: Option<String>,
    doc_key: String,
    id: String,
    label: String,
) -> Result<bool, String> {
    history::name(
        &recovery_base(&app)?,
        &history_key(path.as_deref(), &doc_key),
        &id,
        &label,
    )
    .map_err(|e| e.to_string())
}

/// Delete one version.
#[tauri::command]
fn history_delete(
    app: AppHandle,
    path: Option<String>,
    doc_key: String,
    id: String,
) -> Result<bool, String> {
    history::delete(
        &recovery_base(&app)?,
        &history_key(path.as_deref(), &doc_key),
        &id,
    )
    .map_err(|e| e.to_string())
}

/// Drop a document's whole history.
#[tauri::command]
fn history_clear(app: AppHandle, path: Option<String>, doc_key: String) -> Result<bool, String> {
    history::clear(
        &recovery_base(&app)?,
        &history_key(path.as_deref(), &doc_key),
    )
    .map_err(|e| e.to_string())
}

/// Total version-history footprint (the Settings readout).
#[tauri::command]
fn history_usage(app: AppHandle) -> Result<history::Usage, String> {
    Ok(history::usage(&recovery_base(&app)?))
}

/// Rename (or move) a circuit file, taking its version history with it (§39).
///
/// History is keyed by path (D1), so a rename has to move the store too —
/// otherwise the file would look like it had lost every version. Returns the
/// path actually written (a `.csx` extension is enforced, as Save-As does).
#[tauri::command]
fn rename_circuit_file(app: AppHandle, from: String, to: String) -> Result<String, String> {
    let target = if to.to_ascii_lowercase().ends_with(".csx") {
        to
    } else {
        format!("{to}.csx")
    };
    if target == from {
        return Ok(target);
    }
    if std::path::Path::new(&target).exists() {
        return Err(format!("{target} already exists"));
    }
    std::fs::rename(&from, &target).map_err(|e| e.to_string())?;
    let base = recovery_base(&app)?;
    history::rename(
        &base,
        &recovery::key_for(Some(&from), ""),
        &recovery::key_for(Some(&target), ""),
    )
    .map_err(|e| e.to_string())?;
    Ok(target)
}

/// Size + mtime of a file (`None` when it does not exist). Used by the
/// frontend's external-change guard: autosave refuses to overwrite a file that
/// changed underneath it.
#[derive(serde::Serialize)]
struct FileStat {
    mtime_ms: u64,
    size: u64,
}

#[tauri::command]
fn file_stat(path: String) -> Result<Option<FileStat>, String> {
    match std::fs::metadata(&path) {
        Ok(meta) => Ok(Some(FileStat {
            mtime_ms: meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            size: meta.len(),
        })),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
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

/// Startup diagnostics (used by [`run`] only): one line per initialization step
/// and its outcome, so a silent startup death points at the step that didn't
/// finish. Kept to startup — the running app logs nothing.
mod startup {
    /// Context worth knowing, or a step about to be attempted.
    pub fn info(msg: &str) {
        eprintln!("  info {msg}");
    }
    /// A step that completed.
    pub fn ok(msg: &str) {
        eprintln!("  ok   {msg}");
    }
    /// A step that failed; the caller decides whether to abort.
    pub fn fail(msg: &str, err: impl std::fmt::Display) {
        eprintln!("  FAIL {msg}: {err}");
    }
}

/// The first `on_page_load` pair is the startup load; anything after it (a dev
/// server's HMR reloads) is not startup and stays unlogged.
static STARTUP_PAGE_STARTED: AtomicBool = AtomicBool::new(false);
static STARTUP_PAGE_FINISHED: AtomicBool = AtomicBool::new(false);

pub fn run() {
    let profile = if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    };
    eprintln!(
        "CircuitSim++ {} starting ({profile}, {} {})",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );

    let context = tauri::generate_context!();
    if tauri::is_dev() {
        match context.config().build.dev_url.as_ref() {
            Some(url) => startup::info(&format!("frontend: dev server {url}")),
            None => startup::info("frontend: bundled assets (dev build)"),
        }
    } else {
        startup::info("frontend: bundled assets");
    }
    startup::info("plugins: dialog, fs, opener");

    let built = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // Opens external links (the update nudge's "Download" and the About
        // card's download-page link) in the system browser. Without it, a
        // `target="_blank"` click is a no-op inside the webview.
        .plugin(tauri_plugin_opener::init())
        .manage(SimState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            load_circuit,
            save_circuit,
            save_image,
            sim_play,
            sim_pause,
            sim_set_pause_on_unknown,
            sim_set_watch,
            sim_step_tick,
            sim_step_cycles,
            sim_run_until,
            sim_reset,
            autosave_recover_write,
            autosave_recover_list,
            autosave_recover_read,
            autosave_recover_discard,
            history_snapshot,
            history_list,
            history_read,
            history_name,
            history_delete,
            history_clear,
            history_usage,
            file_stat,
            rename_circuit_file,
            poke,
            mem_read,
            mem_write,
            snapshot,
            resume,
        ])
        // The webview's first page load, logged for context. It is *not* a
        // success gate: see the Finished arm below. Only the first load is
        // startup; a dev server's HMR reloads stay unlogged.
        .on_page_load(|_webview, payload| {
            let url = payload.url();
            match payload.event() {
                tauri::webview::PageLoadEvent::Started => {
                    if !STARTUP_PAGE_STARTED.swap(true, Ordering::Relaxed) {
                        startup::info(&format!("webview loading {url}"));
                    }
                }
                tauri::webview::PageLoadEvent::Finished => {
                    if !STARTUP_PAGE_FINISHED.swap(true, Ordering::Relaxed) {
                        // Informational only: this fires even when the frontend
                        // is unreachable (the webview finishes on its error page),
                        // so it is not proof the UI rendered.
                        startup::info(&format!("webview load finished {url}"));
                    }
                }
            }
        })
        // Tauri builds the configured windows just before this hook runs, so a
        // missing `main` here is a real startup failure, not a race.
        .setup(|app| match app.get_webview_window("main") {
            Some(window) => {
                let size = match (window.inner_size(), window.scale_factor()) {
                    (Ok(physical), Ok(scale)) => {
                        let logical = physical.to_logical::<u32>(scale);
                        format!("{}x{}", logical.width, logical.height)
                    }
                    _ => "size unknown".to_string(),
                };
                startup::ok(&format!("window 'main' created ({size})"));
                Ok(())
            }
            None => Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "the 'main' window was not created",
            )
            .into()),
        })
        .build(context);

    let app = match built {
        Ok(app) => {
            startup::ok("app built (runtime + plugins initialized)");
            app
        }
        Err(e) => {
            startup::fail("app build", &e);
            std::process::exit(1);
        }
    };

    app.run(|_app, event| match event {
        tauri::RunEvent::Ready => {
            startup::ok("event loop ready");
            eprintln!("CircuitSim++ ready.");
        }
        tauri::RunEvent::Exit => startup::info("exited"),
        _ => {}
    });
}
