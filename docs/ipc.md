# IPC Contract — `csim-core` ↔ Tauri shell ↔ React frontend

**Status:** Pinned (U0/B0), **v1.2** (v1.1 human-ratified 2026-10-06; v1.2 signed off 2026-10-18).
Normative. Mirrors `docs/tasks/README.md` §3; implemented in Rust by `crates/core/src/api.rs`
and in TypeScript by `frontend/src/ipc/types.ts`. Changes require human sign-off and a
DESIGN.md note.

**Changelog v1.5 → v1.6 (proposed 2026-11-11, needs sign-off):** `sim_set_watch` installs
caller-defined **stop conditions**; `step_tick`/`step_cycles`/`run_until`/`play` then stop early
when one holds and report `sim_halted` with `reason: "stop"` — a *pause*, not a fault, so the next
command carries on from exactly there (like `breakpoint`). A `Watch` is
`{ when: "stable", name, cycles }` | `{ when: "changes", name, count }` |
`{ when: "reaches", name, value }` | `{ when: "is", name, value }`; `name` is a
watch-addressable register/probe (the `probe('…')` registry) and `value` a §4 literal. An empty
array clears them; a bad name/literal is reported as an `error` halt. Mirrors `Sim::set_watch`
(`api.rs`).

**Changelog v1.4 → v1.5 (proposed 2026-10-26, needs sign-off):** `load_circuit` with **both**
`path` and `bytes` loads the bytes as the document that lives at `path`: autoload paths resolve
(and stay sandboxed) next to `path`, and the file itself is not read. Additive — `path` alone and
`bytes` alone are unchanged (before, `path` silently won when both were given). The editor needs
it to re-sync a file-backed document from its current text: re-reading the file picked up a stale
copy that autosave had not rewritten yet, so a fixed load error stayed on screen. Rust:
`Sim::load_circuit_bytes_at` (defaults to `load_circuit_bytes`).

**Changelog v1.1 → v1.2:** `NamedComponent.value_net?` — the engine net carrying a named
component's watchable value, so a UI readout works even when that pin is unwired (the engine
nets every pin; `net_map` only covers wires); `NetChange.contended?` — the net's `X` is a
genuine short circuit (two enabled drivers disagreeing) rather than an `X` that flowed in, so
the UI can warn precisely.

**Changelog v1.0 → v1.1:** `NetChange.at?` (engine event timestamps); `NetDiffs.full`
(initial full-state batch exception); structured `TimingPath[]` in
`timing_update` (replaces the bare count + bare id lists); `NamedComponent.circuit`;
CompId redefined as document-order within the referenced circuit (net_map stays
root-circuit-only for v1); halt attribution tightened for subcircuits; tick semantics pinned.

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
| `load_circuit` | `{ path?: string, bytes?: Uint8Array }` | `LoadResult` — **v1.5:** with both, `bytes` is the document and `path` only where it lives (autoloads resolve there; the file is not read) |
| `save_circuit` | `{ path: string, document: unknown }` | `SaveResult` — **writes even when the document fails validation**, returning those problems as warnings in `errors` (`ok: true`); only a document that cannot be parsed at all is refused (`ok: false`, nothing written). Losing a mid-edit draft is worse than saving one, and the previous clean state remains in version history. |
| `sim_play` | `{ hz: number }` | — |
| `sim_pause` | `{}` | — |
| `sim_step_tick` | `{}` | — one **tick**: one clock phase, posedge or negedge (`docs/derived-clock.md` §2) |
| `sim_step_cycles` | `{ n: number }` | — |
| `sim_run_until` | `{ cycle: number }` | — |
| `sim_reset` | `{}` | — fresh power-on state; every memory's autoload image re-applies (DESIGN.md §5.2 / G6); answered with a `full: true` `net_diffs` batch |
| `poke` | `{ comp_id: CompId, pin: string, value: WireValue }` | — (a `mem.register` sets its stored value, a `wiring.pin` drives an input, an `io.button` presses/releases; anything else is a no-op). An interactive poke **settles the current cycle** — its effect propagates to the output cone before the next clock edge — rather than waiting for the next tick. |
| `mem_read` | `{ name: string, addr: number, len: number }` | `WireValue[]` |
| `mem_write` | `{ name: string, addr: number, values: WireValue[] }` | — |
| `snapshot` | `{ path: string }` | — |
| `sim_set_pause_on_unknown` | `{ pause: bool }` | ask (or do not ask) when the sim reads a net nothing drives |
| `sim_set_watch` | `{ watch: Watch[] }` | install stop conditions (**v1.6**); an empty array clears them |
| `resume` | `{ path: string }` | — |

`LoadResult` = `{ ok, errors: LoadError[], net_map: NetMapEntry[], named: NamedComponent[] }`.
`NetMapEntry` = `{ net, instance, circuit, wires }` — **v1.4:** one entry per
*(instance path, circuit, net)*. `wires` index into `circuit`'s own `wires` array, and `instance`
is the instance path (`""` at the root, `"c0"` / `"c0/c3"` when nested). The pair is the key: the
same circuit-relative wire index means a different `net` in each instance, which is what lets the
UI show a subcircuit sheet opened *as a specific instance*. (Through v1.3 the map was
root-circuit-only and carried neither field.)
`NamedComponent` = `{ name, kind: ram|rom|register|probe, circuit, comp_id, value_net? }` —
**v1.2:** `value_net` is the engine net carrying the component's watchable value (register `q`,
RAM `dout`, ROM `out`, probe `in`). The engine nets **every pin**, so it is present even when
that pin is unwired — a register with `q` open still reads its stored value. Omitted only by a
core that cannot resolve it (the mock derives nets from wires).
`LoadError` = `{ kind, message, circuit, comp_id?, wire_idx? }` — load collects **all** errors;
the engine never panics and never partially loads (DESIGN.md §5.2).

## 3. Events (Rust → frontend)

| Event | Payload | Semantics |
|---|---|---|
| `net_diffs` | `{ cycle, full, changes: [{ net, val, at?, contended? }] }` | Only changed nets, never full state (DESIGN.md §7.2) — **one exception (v1.1):** the single initial batch after load/resume has `full: true` and contains ALL nets (the UI's initial paint); every later batch is changed-nets-only with `full: false`. `at` = ns since run start. **v1.2:** `contended` is present and `true` when that net's `X` is a genuine short circuit (two enabled drivers disagreeing — DESIGN.md §4.1); absent for an `X` that merely flowed in. The UI applies ≤ 1 batch per animation frame and may drop intermediates — never queue a backlog. **Consumers that need history tap the batches before that merge** (`DiffPump`'s `onRaw`): the waveform viewer (UI_OVERHAUL §89) records from there, so the ≤ 1-batch-per-frame rule stays a *painting* rule and costs the trace nothing. No new event, command or field. |
| `sim_status` | `{ running, cycle, eff_hz }` | On play/pause and ~1 Hz while running. |
| `sim_halted` | `{ cycle, reason, details }` | `reason ∈ breakpoint \| floating-read \| contention \| oscillation \| cycle-limit \| stop \| error`; `details` names the component/pin for highlighting (shape pinned in §5). **`breakpoint`, `floating-read`, and `stop` are the reasons that are not sticky:** every other halt means the design is broken (or out of budget) and the engine refuses to run until a load/reset, while these are *pauses* — the next `sim_step_*`/`sim_run_until` continues from exactly there (`docs/format-v2.md` §9; contract v1.2/v1.4/v1.6). The UI can therefore leave the transport armed instead of showing a fatal error. |
| `timing_update` | `{ t_obs, est_time, top_paths }` | DTA results (DESIGN.md §4.4), after `sim_run_until` / pause. `top_paths: TimingPath[]` = `{ circuit, comps: [comp_id], delay_ns }`. |

## 4. Net identifiers

`NetId`s are assigned by the engine at load and are valid for one loaded session. The frontend
learns net ids two ways: the net ↔ wire mapping from `LoadResult.net_map`, and each named
component's `value_net` (v1.2) for its value pin — which exists even when that pin is unwired.
Nets are **never** exposed in files (DESIGN.md §5.1: nets are derived, wires are the stored
truth).

## 5. Conventions

- **`CompId` = document-order component array index** (format-v2 §5): the component's position
  in the **referenced circuit's** `components` array — never a post-flatten engine index.
  Messages that can reference non-root circuits carry an explicit `circuit` field
  (`TimingPath`, `NamedComponent`); `LoadError.comp_id` is document-order
  within `LoadError.circuit`. **v1.4:** `LoadResult.net_map` carries an explicit `circuit` and
  `instance` per entry, so every instance's wires resolve to their own nets (see §2).
- **`sim_halted.details` shape:** for component-attributable halts (floating-read, contention,
  oscillation, stop, breakpoint), `details` starts with `comp <CompId> pin "<name>": <message>` so
  the UI can ring the offending component on the canvas. The CompId is the **root-sheet**
  document-order id: when the culprit is inside a subcircuit, the engine reports the enclosing
  subcircuit INSTANCE's root-sheet id (v1 UI highlights the root sheet only). Free-form text
  remains legal for non-component halts (cycle-limit, error).
