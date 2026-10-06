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
    /// Logic-1 mask (bit set = logic 1).
    pub v: String,
    /// X mask (contention); never overlaps `z` for the same bit.
    pub x: String,
    /// Z mask (floating); never overlaps `x` for the same bit.
    pub z: String,
}

/// Which circuit (by name) a load error belongs to.
pub type CircuitName = String;

/// Classification of load/validation errors (DESIGN.md §5.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LoadErrorKind {
    /// JSON/syntax parse failure.
    Parse,
    /// File I/O failure (missing/unreadable file).
    Io,
    /// A wire endpoint's component/pin reference does not resolve.
    UnresolvedPin,
    /// A junction's wire/segment reference does not resolve.
    UnresolvedJoin,
    /// Pins on a derived net disagree on bitsize.
    BitsizeMismatch,
    /// A `name` is used twice within one circuit.
    DuplicateName,
    /// A component `id` is used twice.
    DuplicateId,
    /// Subcircuit instantiation forms a cycle.
    HierarchyCycle,
    /// Any other load/validation failure.
    Other,
}

/// A single validation error. Load collects *all* errors — the engine never
/// panics and never partially loads (DESIGN.md §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LoadError {
    /// Error classification.
    pub kind: LoadErrorKind,
    /// Human-readable detail for the UI/CLI.
    pub message: String,
    /// Circuit the error belongs to.
    pub circuit: CircuitName,
    /// Offending component, when the error is component-specific.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub comp_id: Option<CompId>,
    /// Offending wire, when the error is wire-specific.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wire_idx: Option<WireIdx>,
}

/// Maps a derived net to the wires (by index) that belong to it, so the UI
/// can highlight net extents without knowing anything about net derivation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetMapEntry {
    /// The derived net.
    pub net: NetId,
    /// Wires (by index) that belong to this net.
    pub wires: Vec<WireIdx>,
}

/// Kinds of components addressable by name from the autograder and watch
/// panel (DESIGN.md §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NamedKind {
    /// A `mem.ram` component.
    Ram,
    /// A `mem.rom` component.
    Rom,
    /// A `mem.register` component.
    Register,
    /// A `wiring.probe` component.
    Probe,
}

/// A component carrying a unique, validated `name` (DESIGN.md §5.2).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedComponent {
    /// The unique, validated name (§5.2).
    pub name: String,
    /// Component kind.
    pub kind: NamedKind,
    /// Engine handle for the component.
    pub comp_id: CompId,
}

/// Result of [`Sim::load_circuit_bytes`] / [`Sim::load_circuit_path`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct LoadResult {
    /// True when the document loaded with no errors.
    pub ok: bool,
    /// All load/validation errors collected (§5.2); empty on success.
    pub errors: Vec<LoadError>,
    /// Net → wires mapping for UI net-extent highlighting.
    pub net_map: Vec<NetMapEntry>,
    /// All named (autograder/watch-addressable) components.
    pub named: Vec<NamedComponent>,
}

/// Result of [`Sim::save_circuit`].
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct SaveResult {
    /// True when the file was written.
    pub ok: bool,
    /// Errors encountered while saving; empty on success.
    pub errors: Vec<LoadError>,
}

/// Simulation mode (DESIGN.md §4.2–4.3). Grading pins `Delay` (DTA, §4.4);
/// `Zero` is the interactive fast/debug mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SimMode {
    /// Zero-delay mode — interactive fast/debug (§4.2).
    Zero,
    /// Delay-aware mode — teaching + grading engine (§4.3).
    Delay,
}

/// One net's new value within a [`NetDiffs`] batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetChange {
    /// The net whose value changed.
    pub net: NetId,
    /// The net's new value.
    pub val: WireValue,
}

/// Event: values of nets that changed. Diffs only, never full state
/// (DESIGN.md §7.2). Consumers apply at most one batch per animation frame
/// and may drop intermediate batches — never queue a backlog.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetDiffs {
    /// Cycle at which this batch was produced.
    pub cycle: u64,
    /// The nets that changed, with their new values.
    pub changes: Vec<NetChange>,
}

/// Event: run-state telemetry. Emitted on play/pause and ~1 Hz while running.
/// `eff_hz` is rounded effective sim speed (telemetry only, not evaluation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimStatus {
    /// Whether the simulation is currently playing.
    pub running: bool,
    /// Current cycle.
    pub cycle: u64,
    /// Current simulation mode.
    pub mode: SimMode,
    /// Rounded effective sim speed (telemetry only, not evaluation).
    pub eff_hz: u64,
}

/// Why a run stopped (DESIGN.md §4.1, §4.5, §8.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HaltReason {
    /// A breakpoint fired (interactive stepping).
    Breakpoint,
    /// A `Z` was consumed — gate input, register D at an edge, memory port
    /// access (§4.1).
    FloatingRead,
    /// Two enabled drivers disagree on a net (§4.1).
    Contention,
    /// Combinational feedback failed to converge (§4.5).
    Oscillation,
    /// The run consumed its cycle budget.
    CycleLimit,
    /// Any other abnormal halt.
    Error,
}

/// Event: simulation halted. `details` names the component/pin for UI
/// highlighting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimHalted {
    /// Cycle at which the halt occurred.
    pub cycle: u64,
    /// Why the run stopped.
    pub reason: HaltReason,
    /// Names the component/pin for UI highlighting.
    pub details: String,
}

/// Event: DTA timing results (DESIGN.md §4.4), emitted after `run_until` and
/// on pause. `t_obs` is the max observed per-cycle settle time in delay-table
/// units (ns); `est_time` is `cycles × t_obs` (saturating); `top_paths` are
/// the observed critical paths as component-ID sequences for UI highlighting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimingUpdate {
    /// Max observed per-cycle settle time in delay-table units (ns).
    pub t_obs: u64,
    /// `cycles × t_obs` (saturating).
    pub est_time: u64,
    /// Setup/hold warning count (§4.3).
    pub violations: u64,
    /// Observed critical paths as component-ID sequences, for UI
    /// highlighting.
    pub top_paths: Vec<Vec<CompId>>,
}

/// Sink for engine events. The Tauri shell implements this by emitting Tauri
/// events (README §3); the CLI implements it by writing JSON lines.
pub trait EventSink: Send {
    /// Deliver a batch of changed-net values (`net_diffs` event).
    fn net_diffs(&mut self, diffs: &NetDiffs);
    /// Deliver run-state telemetry (`sim_status` event).
    fn status(&mut self, status: &SimStatus);
    /// Deliver a halt notification (`sim_halted` event).
    fn halted(&mut self, halted: &SimHalted);
    /// Deliver DTA timing results (`timing_update` event).
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

    /// Run continuously at `hz` sim speed.
    fn play(&mut self, hz: u64) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    /// Stop the running simulation.
    fn pause(&mut self) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    /// Advance one half-cycle (one clock-phase toggle).
    fn step_tick(&mut self) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    /// Advance `n` full clock cycles.
    fn step_cycles(&mut self, n: u64) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    /// Run until `cycle`, then emit DTA results (§4.4).
    fn run_until(&mut self, cycle: u64) {
        unimplemented!("csim-core engine — BACKEND.md task B5/B6")
    }
    /// Switch the simulation mode.
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
    /// Restore engine state from a savestate written by [`Sim::snapshot`].
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
