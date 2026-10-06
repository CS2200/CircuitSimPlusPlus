/**
 * IPC contract types — the single source of truth the frontend compiles
 * against. Mirrors `docs/tasks/README.md` §3, `docs/ipc.md`, and
 * `crates/core/src/api.rs` field-for-field. Do not deviate.
 */

/** Opaque net identifier, assigned by the engine at load (internal only). */
export type NetId = number;
/** Opaque component identifier (stable within a loaded document). */
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

/** `zero` = interactive fast/debug; `delay` = teaching + grading (DTA). */
export type SimMode = "zero" | "delay";

export interface NetChange {
  net: NetId;
  val: WireValue;
}

/** Diffs only, never full state (DESIGN.md §7.2). ≤ 1 batch per frame. */
export interface NetDiffs {
  cycle: number;
  changes: NetChange[];
}

export interface SimStatus {
  running: boolean;
  cycle: number;
  mode: SimMode;
  eff_hz: number;
}

export type HaltReason =
  "breakpoint" | "floating-read" | "contention" | "oscillation" | "cycle-limit" | "error";

export interface SimHalted {
  cycle: number;
  reason: HaltReason;
  /** Names the component/pin for UI highlighting. */
  details: string;
}

/** DTA timing results (DESIGN.md §4.4). */
export interface TimingUpdate {
  t_obs: number;
  est_time: number;
  violations: number;
  top_paths: CompId[][];
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
  stepTick(): Promise<void>;
  stepCycles(n: number): Promise<void>;
  runUntil(cycle: number): Promise<void>;
  setMode(mode: SimMode): Promise<void>;

  poke(compId: CompId, pin: string, value: WireValue): Promise<void>;
  memRead(name: string, addr: number, len: number): Promise<WireValue[]>;
  memWrite(name: string, addr: number, values: WireValue[]): Promise<void>;

  snapshot(path: string): Promise<void>;
  resume(path: string): Promise<void>;
}
