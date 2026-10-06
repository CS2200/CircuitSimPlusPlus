//! Public API surface — the integration contract between the engine, the
//! autograder CLI, and the Tauri shell.
//!
//! This module mirrors `docs/tasks/README.md` §3 and `docs/ipc.md` exactly.
//! It is deliberately written *before* any engine code (BACKEND.md task B0):
//! the Tauri shell (`crates/app`) and the frontend mock compile against these
//! types while the engine is implemented behind them (tasks B1–B6).
//!
//! All types serialize with `serde`; field names on the wire are the Rust
//! field names (snake_case), matching the TypeScript types in
//! `frontend/src/ipc/types.ts`.

use serde::{Deserialize, Serialize};

// Identifiers are newtypes (task B1) that serialize transparently as bare
// `u32`s — the wire format pinned in `docs/ipc.md` is unchanged.
pub use crate::ids::{CompId, NetId, WireIdx};

/// A 4-state logic value on the wire: three hex masks (DESIGN.md §4.1,
/// README §3). Bit set in `v` = logic 1; bit set in `x` = X (contention);
/// bit set in `z` = Z (floating). `x` and `z` are never both set for a bit.
/// Hex strings are MSB-first; empty string means zero-width/zero.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct WireValue {
    pub v: String,
    pub x: String,
    pub z: String,
}

/// Which circuit (by name) a load error belongs to.
pub type CircuitName = String;

/// Classification of load/validation errors (DESIGN.md §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoadErrorKind {
    Parse,
    Io,
    UnresolvedPin,
    UnresolvedJoin,
    BitsizeMismatch,
    DuplicateName,
    DuplicateId,
    HierarchyCycle,
    Other,
}

/// A single validation error. Load collects *all* errors — the engine never
/// panics and never partially loads (DESIGN.md §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoadError {
    pub kind: LoadErrorKind,
    pub message: String,
    pub circuit: CircuitName,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comp_id: Option<CompId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wire_idx: Option<WireIdx>,
}

/// Maps a derived net to the wires (by index) that belong to it, so the UI
/// can highlight net extents without knowing anything about net derivation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetMapEntry {
    pub net: NetId,
    pub wires: Vec<WireIdx>,
}

/// Kinds of components addressable by name from the autograder and watch
/// panel (DESIGN.md §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NamedKind {
    Ram,
    Rom,
    Register,
    Probe,
}

/// A component carrying a unique, validated `name` (DESIGN.md §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedComponent {
    pub name: String,
    pub kind: NamedKind,
    pub comp_id: CompId,
}

/// Result of [`Sim::load_circuit_bytes`] / [`Sim::load_circuit_path`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LoadResult {
    pub ok: bool,
    pub errors: Vec<LoadError>,
    pub net_map: Vec<NetMapEntry>,
    pub named: Vec<NamedComponent>,
}

/// Result of [`Sim::save_circuit`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SaveResult {
    pub ok: bool,
    pub errors: Vec<LoadError>,
}

/// Simulation mode (DESIGN.md §4.2–4.3). Grading pins `Delay` (DTA, §4.4);
/// `Zero` is the interactive fast/debug mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SimMode {
    Zero,
    Delay,
}

/// One net's new value within a [`NetDiffs`] batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetChange {
    pub net: NetId,
    pub val: WireValue,
}

/// Event: values of nets that changed. Diffs only, never full state
/// (DESIGN.md §7.2). Consumers apply at most one batch per animation frame
/// and may drop intermediate batches — never queue a backlog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetDiffs {
    pub cycle: u64,
    pub changes: Vec<NetChange>,
}

/// Event: run-state telemetry. Emitted on play/pause and ~1 Hz while running.
/// `eff_hz` is rounded effective sim speed (telemetry only, not evaluation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimStatus {
    pub running: bool,
    pub cycle: u64,
    pub mode: SimMode,
    pub eff_hz: u64,
}

/// Why a run stopped (DESIGN.md §4.1, §4.5, §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HaltReason {
    Breakpoint,
    FloatingRead,
    Contention,
    Oscillation,
    CycleLimit,
    Error,
}

/// Event: simulation halted. `details` names the component/pin for UI
/// highlighting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimHalted {
    pub cycle: u64,
    pub reason: HaltReason,
    pub details: String,
}

/// Event: DTA timing results (DESIGN.md §4.4), emitted after `run_until` and
/// on pause. `t_obs` is the max observed per-cycle settle time in delay-table
/// units (ns); `est_time` is `cycles × t_obs` (saturating); `top_paths` are
/// the observed critical paths as component-ID sequences for UI highlighting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimingUpdate {
    pub t_obs: u64,
    pub est_time: u64,
    pub violations: u64,
    pub top_paths: Vec<Vec<CompId>>,
}

/// Sink for engine events. The Tauri shell implements this by emitting Tauri
/// events (README §3); the CLI implements it by writing JSON lines.
pub trait EventSink: Send {
    fn net_diffs(&mut self, diffs: &NetDiffs);
    fn status(&mut self, status: &SimStatus);
    fn halted(&mut self, halted: &SimHalted);
    fn timing(&mut self, timing: &TimingUpdate);
}

/// The simulation session API. One instance per open circuit.
///
/// Default bodies are `unimplemented!()` scaffolding (task B0); the engine
/// fills them in across tasks B2–B6. Callers must not rely on defaults.
#[allow(unused_variables)]
pub trait Sim {
    /// Parse and validate a `.csx` document (DESIGN.md §5). Collects all
    /// errors; never panics.
    fn load_circuit_bytes(&mut self, bytes: &[u8]) -> LoadResult {
        unimplemented!("csim-core engine — BACKEND.md task B2/B3")
    }
    /// Load from a file path (autoload paths resolve relative to it, §11).
    fn load_circuit_path(&mut self, path: &str) -> LoadResult {
        unimplemented!("csim-core engine — BACKEND.md task B2/B3")
    }
    /// Serialize the current document canonically (sorted keys, 2-space
    /// indent — saving twice is byte-identical, §5.1).
    fn save_circuit(&mut self, path: &str, document: &serde_json::Value) -> SaveResult {
        unimplemented!("csim-core engine — BACKEND.md task B2")
    }

    fn play(&mut self, hz: u64) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    fn pause(&mut self) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    fn step_tick(&mut self) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    fn step_cycles(&mut self, n: u64) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    fn run_until(&mut self, cycle: u64) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    fn set_mode(&mut self, mode: SimMode) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }

    /// Drive a component pin (interactive poking / test setup).
    fn poke(&mut self, comp_id: CompId, pin: &str, value: WireValue) {
        unimplemented!("csim-core engine — BACKEND.md task B4")
    }
    /// Read `len` words starting at `addr` from a named memory (§8.2).
    fn mem_read(&self, name: &str, addr: u64, len: u64) -> Vec<WireValue> {
        unimplemented!("csim-core engine — BACKEND.md task B9")
    }
    /// Write words starting at `addr` in a named memory (§8.2).
    fn mem_write(&mut self, name: &str, addr: u64, values: &[WireValue]) {
        unimplemented!("csim-core engine — BACKEND.md task B9")
    }

    /// Persist full engine state (savestate; also the autograder's mechanism,
    /// §8.1).
    fn snapshot(&mut self, path: &str) {
        unimplemented!("csim-core engine — BACKEND.md task B5")
    }
    fn resume(&mut self, path: &str) {
        unimplemented!("csim-core engine — BACKEND.md task B5")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Contract types must round-trip through JSON with the exact field
    /// names the frontend expects (`frontend/src/ipc/types.ts`).
    #[test]
    fn wire_value_roundtrip() {
        let val = WireValue {
            v: "1fa3".into(),
            x: "0010".into(),
            z: String::new(),
        };
        let json = serde_json::to_string(&val).unwrap();
        assert_eq!(json, r#"{"v":"1fa3","x":"0010","z":""}"#);
        let back: WireValue = serde_json::from_str(&json).unwrap();
        assert_eq!(val, back);
    }

    #[test]
    fn event_payloads_roundtrip() {
        let diffs = NetDiffs {
            cycle: 42,
            changes: vec![NetChange {
                net: NetId(7),
                val: WireValue {
                    v: "1".into(),
                    x: String::new(),
                    z: String::new(),
                },
            }],
        };
        let json = serde_json::to_string(&diffs).unwrap();
        assert_eq!(
            json,
            r#"{"cycle":42,"changes":[{"net":7,"val":{"v":"1","x":"","z":""}}]}"#
        );
        let back: NetDiffs = serde_json::from_str(&json).unwrap();
        assert_eq!(diffs, back);

        // Enum wire spellings must match the contract exactly.
        assert_eq!(
            serde_json::to_string(&SimMode::Delay).unwrap(),
            r#""delay""#
        );
        assert_eq!(
            serde_json::to_string(&HaltReason::FloatingRead).unwrap(),
            r#""floating-read""#
        );
        assert_eq!(serde_json::to_string(&NamedKind::Ram).unwrap(), r#""ram""#);
    }
}
