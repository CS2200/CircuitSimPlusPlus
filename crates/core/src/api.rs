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
///
/// `comp_id` obeys the **CompId-on-the-wire rule** (contract v1.1): it is
/// the component's document-order index within `circuit`'s `components`
/// array — NOT the post-flatten engine index. Named memories/registers
/// inside subcircuit instances are addressable by hierarchical name
/// (`instance/.../name`, docs/autograder.md); their `circuit` is the
/// circuit that *defines* them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NamedComponent {
    /// The unique, validated name (§5.2; hierarchical when nested).
    pub name: String,
    /// Component kind.
    pub kind: NamedKind,
    /// Circuit whose `components` array `comp_id` indexes into.
    pub circuit: CircuitName,
    /// Document-order index within `circuit`'s `components` array.
    pub comp_id: CompId,
    /// Engine net carrying this component's watchable value — register `q`,
    /// RAM `dout`, ROM `out`, probe `in` (contract v1.2). Present even when
    /// nothing is wired to that pin (every pin gets a net), so a UI readout
    /// still works with the value output left open.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_net: Option<NetId>,
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

/// One net's new value within a [`NetDiffs`] batch.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetChange {
    /// The net whose value changed.
    pub net: NetId,
    /// The net's new value.
    pub val: WireValue,
    /// Simulation time (ns since run start) of the change (contract v1.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at: Option<u64>,
    /// Present and `true` when this net's `X` is a genuine **short circuit** —
    /// two enabled drivers disagreeing — rather than an `X` that flowed in
    /// (contract v1.2; omitted when false). The UI flags shorts with it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contended: Option<bool>,
}

/// Event: values of nets that changed. Diffs only, never full state
/// (DESIGN.md §7.2). Consumers apply at most one batch per animation frame
/// and may drop intermediate batches — never queue a backlog.
///
/// **Exception (contract v1.1):** exactly one batch — the first after
/// `load_circuit`/`resume` — has `full: true` and contains **all** nets
/// (unchanged nets included), so the UI can paint initial state without
/// waiting for activity. All later batches have `full: false`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NetDiffs {
    /// Cycle at which this batch was produced.
    pub cycle: u64,
    /// The nets that changed, with their new values.
    pub changes: Vec<NetChange>,
    /// `true` exactly for the one initial batch after load/resume
    /// (contains ALL nets — the documented exception to diff-only).
    pub full: bool,
}

/// Event: run-state telemetry. Emitted on play/pause and ~1 Hz while running.
/// `eff_hz` is rounded effective sim speed (telemetry only, not evaluation).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimStatus {
    /// Whether the simulation is currently playing.
    pub running: bool,
    /// Current cycle.
    pub cycle: u64,
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
///
/// **`details` format (contract v1.1):** when the halt is attributable to
/// a component pin (floating-read), it starts with the parseable prefix
/// `comp <CompId> pin "<pin>": <message>`. The `CompId` is document-order:
/// the component's index within the ROOT circuit when the culprit is at
/// root level, or the root-sheet id of the enclosing subcircuit INSTANCE
/// when it is nested (v1 UI highlights root-sheet only). Halts with no
/// single culprit (oscillation, event storms) use a plain message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SimHalted {
    /// Cycle at which the halt occurred.
    pub cycle: u64,
    /// Why the run stopped.
    pub reason: HaltReason,
    /// `comp <CompId> pin "<pin>": <message>` when attributable (see
    /// above), else a plain message.
    pub details: String,
}

/// Which timing discipline a [`TimingViolation`] records (§4.3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ViolationKind {
    /// Data changed within `t_setup` before the clock edge.
    Setup,
    /// Data changed within `t_hold` after the clock edge.
    Hold,
}

/// A setup/hold warning (DESIGN.md §4.3), contract v1.1. `comp_id` obeys
/// the CompId-on-the-wire rule: the document-order index within `circuit`'s
/// `components` array. For a violating component inside a subcircuit, the
/// pair (`circuit`, `comp_id`) names the component within its defining
/// circuit; hierarchical designs attribute violations per circuit.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimingViolation {
    /// Circuit whose `components` array `comp_id` indexes into.
    pub circuit: CircuitName,
    /// Document-order index of the violating component within `circuit`.
    pub comp_id: CompId,
    /// Which discipline was violated.
    pub kind: ViolationKind,
    /// Human-readable detail (offending edge time, cycle, pin).
    pub detail: String,
}

/// One observed critical path (DTA, §4.4), contract v1.1. `comps` are
/// document-order indices within `circuit`'s `components` array (the
/// CompId-on-the-wire rule). A path that crosses circuit boundaries is
/// split into consecutive per-circuit runs, one [`TimingPath`] per run,
/// preserving order; every emitted `CompId` is then valid within the
/// named `circuit`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimingPath {
    /// Circuit whose `components` array `comps` indexes into.
    pub circuit: CircuitName,
    /// The path's components, document-order indices within `circuit`,
    /// endpoint's driver first, launching element last.
    pub comps: Vec<CompId>,
    /// Observed settle time (ns) of the path.
    pub delay_ns: u64,
}

/// Event: DTA timing results (DESIGN.md §4.4), emitted after `run_until` and
/// on pause. `t_obs` is the max observed per-cycle settle time in delay-table
/// units (ns); `est_time` is `cycles × t_obs` (saturating); `violations` is
/// the setup/hold warning list (the count is its length); `top_paths` are
/// the observed critical paths for UI highlighting.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TimingUpdate {
    /// Max observed per-cycle settle time in delay-table units (ns).
    pub t_obs: u64,
    /// `cycles × t_obs` (saturating).
    pub est_time: u64,
    /// Setup/hold warnings (§4.3); the count is the list length.
    pub violations: Vec<TimingViolation>,
    /// Observed critical paths, grouped per circuit, for UI highlighting.
    pub top_paths: Vec<TimingPath>,
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

/// The simulation session API. One instance per open circuit, implemented
/// by [`crate::session::Session`].
///
/// **Semantics (contract v1.1):**
///
/// - Exactly one *full* [`NetDiffs`] batch (`full: true`, all nets) is
///   emitted after each successful `load_circuit_*`/`resume`/`reset`;
///   every later batch is diff-only (`full: false`).
/// - A *tick* is one clock half-period (advance to the next clock edge).
///   There is one engine; the removed zero-delay mode had its own notion of a
///   tick, and nothing else did.
/// - `CompId`s on the wire are always document-order indices within the
///   referenced circuit (see [`NamedComponent`]); engine-internal
///   flattened ids are mapped back at the boundary.
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

    /// Re-power-on the simulation and re-apply every memory's `autoload`
    /// image (DESIGN.md §5.2, goal G6: reset reloads the program).
    /// `contents` attributes are part of the document and re-apply through
    /// the rebuild; file `autoload`s are re-read (resolving relative to
    /// the circuit file's directory, sandboxed per §11; a session loaded
    /// from bytes has no base path and resolves against the current
    /// working directory). Emits a fresh full [`NetDiffs`] batch.
    fn reset(&mut self) {
        unimplemented!("csim-core engine — contract v1.2")
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
                at: None,
                contended: None,
            }],
            full: false,
        };
        let json = serde_json::to_string(&diffs).unwrap();
        assert_eq!(
            json,
            r#"{"cycle":42,"changes":[{"net":7,"val":{"v":"1","x":"","z":""}}],"full":false}"#
        );
        let back: NetDiffs = serde_json::from_str(&json).unwrap();
        assert_eq!(diffs, back);

        // A short circuit rides along as `contended` (contract v1.2); absent
        // otherwise, as the assertion above shows.
        let shorted = NetDiffs {
            cycle: 42,
            changes: vec![NetChange {
                net: NetId(7),
                val: WireValue {
                    v: String::new(),
                    x: "1".into(),
                    z: String::new(),
                },
                at: None,
                contended: Some(true),
            }],
            full: false,
        };
        assert_eq!(
            serde_json::to_string(&shorted).unwrap(),
            r#"{"cycle":42,"changes":[{"net":7,"val":{"v":"","x":"1","z":""},"contended":true}],"full":false}"#
        );

        // `at` present (delay mode) and a full (initial) batch.
        let initial = NetDiffs {
            cycle: 0,
            changes: vec![NetChange {
                net: NetId(0),
                val: WireValue::default(),
                at: Some(20),
                contended: None,
            }],
            full: true,
        };
        let json = serde_json::to_string(&initial).unwrap();
        assert_eq!(
            json,
            r#"{"cycle":0,"changes":[{"net":0,"val":{"v":"","x":"","z":""},"at":20}],"full":true}"#
        );
        assert_eq!(initial, serde_json::from_str(&json).unwrap());

        // Enum wire spellings must match the contract exactly.
        assert_eq!(
            serde_json::to_string(&HaltReason::FloatingRead).unwrap(),
            r#""floating-read""#
        );
        assert_eq!(serde_json::to_string(&NamedKind::Ram).unwrap(), r#""ram""#);
        assert_eq!(
            serde_json::to_string(&ViolationKind::Setup).unwrap(),
            r#""setup""#
        );
    }

    #[test]
    fn timing_payloads_roundtrip() {
        let update = TimingUpdate {
            t_obs: 39,
            est_time: 117,
            violations: vec![TimingViolation {
                circuit: "main".into(),
                comp_id: CompId(4),
                kind: ViolationKind::Hold,
                detail: "d changed 3 ns after the edge".into(),
            }],
            top_paths: vec![TimingPath {
                circuit: "main".into(),
                comps: vec![CompId(4), CompId(2)],
                delay_ns: 39,
            }],
        };
        let json = serde_json::to_string(&update).unwrap();
        assert_eq!(
            json,
            r#"{"t_obs":39,"est_time":117,"violations":[{"circuit":"main","comp_id":4,"kind":"hold","detail":"d changed 3 ns after the edge"}],"top_paths":[{"circuit":"main","comps":[4,2],"delay_ns":39}]}"#
        );
        assert_eq!(update, serde_json::from_str(&json).unwrap());
    }
}
