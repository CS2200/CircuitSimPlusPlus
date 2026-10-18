/**
 * IPC contract types — the single source of truth the frontend compiles
 * against. Mirrors `docs/tasks/README.md` §3, `docs/ipc.md` (v1.1), and
 * `crates/core/src/api.rs` field-for-field. Do not deviate.
 */

/** Opaque net identifier, assigned by the engine at load (internal only). */
export type NetId = number;
/**
 * Opaque component identifier (stable within a loaded document).
 *
 * Contract v1.1: a CompId on the wire is the **document-order index into
 * the referenced circuit's `components` array** — never a post-flatten
 * engine index. Messages that can reference non-root circuits carry an
 * explicit `circuit` field (`TimingViolation`, `TimingPath`,
 * `NamedComponent`); `LoadError.comp_id` is document-order within
 * `LoadError.circuit`. `LoadResult.net_map` remains root-circuit-only in
 * v1 (the UI edits one sheet at a time).
 */
export type CompId = number;
/** Index of a wire within its circuit's `wires` array. */
export type WireIdx = number;

/**
 * 4-state logic value as three hex masks (DESIGN.md §4.1):
 * bit set in `v` = 1; bit set in `x` = X (contention); bit set in `z` = Z
 * (floating). `x` and `z` are never both set for a bit. MSB-first.
 */
export interface WireValue {
  v: string;
  x: string;
  z: string;
}

export type LoadErrorKind =
  | "parse"
  | "io"
  | "unresolved-pin"
  | "unresolved-join"
  | "bitsize-mismatch"
  | "duplicate-name"
  | "duplicate-id"
  | "hierarchy-cycle"
  | "other";

/** Load collects ALL errors; the engine never panics (DESIGN.md §5.2). */
export interface LoadError {
  kind: LoadErrorKind;
  message: string;
  circuit: string;
  comp_id?: CompId;
  wire_idx?: WireIdx;
}

/** Derived net → member wires, for net-extent highlighting in the UI. */
export interface NetMapEntry {
  net: NetId;
  wires: WireIdx[];
}

export type NamedKind = "ram" | "rom" | "register" | "probe";

/** A component with a unique validated `name` (autograder/watch addressable). */
export interface NamedComponent {
  name: string;
  kind: NamedKind;
  comp_id: CompId;
  /** Circuit the component lives in (v1.1); `comp_id` is document-order within it. */
  circuit: string;
  /**
   * Engine net carrying this component's watchable value — register `q`,
   * RAM `dout`, ROM `out`, probe `in` (contract v1.2). The engine nets every
   * pin, so this is present even when that pin is unwired, which is what lets a
   * readout work with the output left open. Absent from a core that derives
   * nets from wires only (the mock), or an older engine.
   */
  value_net?: NetId;
}

export interface LoadResult {
  ok: boolean;
  errors: LoadError[];
  net_map: NetMapEntry[];
  named: NamedComponent[];
}

export interface SaveResult {
  ok: boolean;
  errors: LoadError[];
}

export interface NetChange {
  net: NetId;
  val: WireValue;
  /**
   * Event timestamp (v1.1): ns since run start. Powers the U7 propagation
   * pulses; presentation only, never the evaluation path.
   */
  at?: number;
  /**
   * Present and `true` when this net's `X` is a genuine **short circuit** — two
   * enabled drivers disagreeing — rather than an `X` that flowed in (contract
   * v1.2; omitted when false). Powers the short-circuit warning.
   */
  contended?: boolean;
}

/**
 * Diffs only, never full state (DESIGN.md §7.2) — with ONE exception
 * (v1.1): the initial batch after load/resume carries `full: true` and
 * contains ALL nets, so the UI can paint without a special-case command.
 * Every other batch is changed-nets-only with `full: false`.
 * ≤ 1 batch per animation frame consumed; intermediates may be dropped.
 */
export interface NetDiffs {
  cycle: number;
  full: boolean;
  changes: NetChange[];
}

export interface SimStatus {
  running: boolean;
  cycle: number;
  eff_hz: number;
}

export type HaltReason =
  "breakpoint" | "floating-read" | "contention" | "oscillation" | "cycle-limit" | "error";

export interface SimHalted {
  cycle: number;
  reason: HaltReason;
  /**
   * Names the component/pin for UI highlighting. Convention (v1.1): for
   * component-attributable halts (floating-read, contention, oscillation),
   * `details` starts with `comp <CompId> pin "<pin>": <message>`; CompId
   * is the root-sheet document-order id — when the culprit is inside a
   * subcircuit, the engine reports the enclosing subcircuit INSTANCE's
   * root-sheet id (v1 UI highlights the root sheet only). Free-form text
   * remains legal for non-component halts (cycle-limit, error).
   */
  details: string;
}

/** Setup/hold violation classification (DESIGN.md §4.3). */
export type ViolationKind = "setup" | "hold";

/** One timed-register violation warning (v1.1 — replaces the bare count). */
export interface TimingViolation {
  /** Circuit the offending register lives in; `comp_id` is document-order within it. */
  circuit: string;
  comp_id: CompId;
  kind: ViolationKind;
  /** Human-readable explanation (e.g. "D changed 3 ns before the edge; t_setup = 15 ns"). */
  detail: string;
}

/** One observed critical path (DTA, DESIGN.md §4.4). */
export interface TimingPath {
  /** Circuit the path's components live in; `comps` are document-order within it. */
  circuit: string;
  comps: CompId[];
  delay_ns: number;
}

/** DTA timing results (DESIGN.md §4.4). */
export interface TimingUpdate {
  t_obs: number;
  est_time: number;
  violations: TimingViolation[];
  top_paths: TimingPath[];
}

/** Tauri event names (Rust → frontend). */
export const IpcEvents = {
  NetDiffs: "net_diffs",
  SimStatus: "sim_status",
  SimHalted: "sim_halted",
  TimingUpdate: "timing_update",
} as const;

/**
 * The session API the frontend codes against. Implemented by:
 *  - `src/ipc/mock.ts`      (task U9 — TypeScript demo core, parallel dev)
 *  - `src/ipc/tauri.ts`     (task U5 — Tauri command adapter over csim-core)
 */
export interface CoreApi {
  loadCircuit(src: { path?: string; bytes?: Uint8Array }): Promise<LoadResult>;
  saveCircuit(path: string, document: unknown): Promise<SaveResult>;

  play(hz: number): Promise<void>;
  pause(): Promise<void>;
  /**
   * Advance one tick (v1.1 semantics): one clock half-period
   * (posedge/negedge).
   */
  stepTick(): Promise<void>;
  stepCycles(n: number): Promise<void>;
  runUntil(cycle: number): Promise<void>;

  /**
   * Reset to fresh power-on state and re-apply every memory's autoload
   * image (DESIGN.md §5.2 / G6). Emits a fresh `full: true` batch.
   */
  reset(): Promise<void>;

  poke(compId: CompId, pin: string, value: WireValue): Promise<void>;
  memRead(name: string, addr: number, len: number): Promise<WireValue[]>;
  memWrite(name: string, addr: number, values: WireValue[]): Promise<void>;

  snapshot(path: string): Promise<void>;
  resume(path: string): Promise<void>;
}
