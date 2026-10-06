# IPC Contract — `csim-core` ↔ Tauri shell ↔ React frontend

**Status:** Pinned (U0/B0). Normative. Mirrors `docs/tasks/README.md` §3; implemented in Rust by
`crates/core/src/api.rs` and in TypeScript by `frontend/src/ipc/types.ts`. Changes require human
sign-off and a DESIGN.md note.

Transport: Tauri **commands** (frontend → Rust) and Tauri **events** (Rust → frontend).
`crates/app` is a thin adapter over `csim_core::api`; the shell owns no semantics.

## 1. Value encoding (4-state)

A bus value is `{ "v": "1fa3", "x": "0000", "z": "0000" }` — hex masks, MSB-first:

- bit set in `v` → logic **1**
- bit set in `x` → **X** (contention: two enabled drivers disagree, DESIGN.md §4.1)
- bit set in `z` → **Z** (floating: no enabled driver)

`x` and `z` are never both set for the same bit. Empty string = all-zero mask.

## 2. Commands (frontend → Rust)

| Command | Args | Returns |
|---|---|---|
| `load_circuit` | `{ path?: string, bytes?: Uint8Array }` | `LoadResult` |
| `save_circuit` | `{ path: string, document: unknown }` | `SaveResult` |
| `sim_play` | `{ hz: number }` | — |
| `sim_pause` | `{}` | — |
| `sim_step_tick` | `{}` | — |
| `sim_step_cycles` | `{ n: number }` | — |
| `sim_run_until` | `{ cycle: number }` | — |
| `sim_set_mode` | `{ mode: "zero" \| "delay" }` | — |
| `poke` | `{ comp_id: CompId, pin: string, value: WireValue }` | — |
| `mem_read` | `{ name: string, addr: number, len: number }` | `WireValue[]` |
| `mem_write` | `{ name: string, addr: number, values: WireValue[] }` | — |
| `snapshot` | `{ path: string }` | — |
| `resume` | `{ path: string }` | — |

`LoadResult` = `{ ok, errors: LoadError[], net_map: NetMapEntry[], named: NamedComponent[] }`.
`LoadError` = `{ kind, message, circuit, comp_id?, wire_idx? }` — load collects **all** errors;
the engine never panics and never partially loads (DESIGN.md §5.2).

## 3. Events (Rust → frontend)

| Event | Payload | Semantics |
|---|---|---|
| `net_diffs` | `{ cycle, changes: [{ net, val }] }` | Only changed nets, never full state (DESIGN.md §7.2). The UI applies ≤ 1 batch per animation frame and may drop intermediates — never queue a backlog. |
| `sim_status` | `{ running, cycle, mode, eff_hz }` | On play/pause and ~1 Hz while running. |
| `sim_halted` | `{ cycle, reason, details }` | `reason ∈ breakpoint \| floating-read \| contention \| oscillation \| cycle-limit \| error`; `details` names the component/pin for highlighting. |
| `timing_update` | `{ t_obs, est_time, violations, top_paths }` | DTA results (DESIGN.md §4.4), after `sim_run_until` / pause. |

## 4. Net identifiers

`NetId`s are assigned by the engine at load and are valid for one loaded session. The frontend
learns the net ↔ wire mapping exclusively from `LoadResult.net_map`. Nets are **never** exposed
in files (DESIGN.md §5.1: nets are derived, wires are the stored truth).

## 5. Conventions

- **`CompId` = component array index** (format-v2 §5): the component's position in its circuit's
  `components` array, document order. The frontend maps a `CompId` to a document component by
  array position; the engine maps it to its flattened netlist the same way.
- **`sim_halted.details` shape:** for component-attributable halts (floating-read, contention,
  oscillation, setup/hold), `details` starts with `comp <CompId> pin "<name>": <message>` so
  the UI can ring the offending component on the canvas (added in U5; the mock already emits
  this shape). Free-form text remains legal for non-component halts (cycle-limit, error).
