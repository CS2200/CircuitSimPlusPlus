# Sub-Agent Task Lists — Overview, Ownership, Contracts

This directory contains the task lists for the two implementation agents:

- **`BACKEND.md`** — the Backend Agent: `csim-core` + `csim-cli` (Milestones M0, M1, engine side of M4).
- **`FRONTEND.md`** — the UI Agent: Tauri shell + React frontend (M2, M3, UI side of M4, M5).

**Read `DESIGN.md` (repo root) first. It is the normative spec.** These task lists operationalize it; where the two disagree, `DESIGN.md` wins and the disagreement means `DESIGN.md` needs an update (route through the human, not the other agent).

---

## 1. File ownership map (how parallel work avoids collisions)

| Path | Owner |
|---|---|
| `crates/core/**`, `crates/cli/**` | Backend |
| `tests/**` (fixtures, golden traces) | Backend |
| `docs/format-v2.md`, `docs/delay-table.md`, `crates/core/data/**` | Backend |
| `.github/workflows/backend.yml` | Backend |
| `frontend/**`, `crates/app/**` (Tauri shell) | Frontend |
| `docs/ipc.md` | Frontend (implements the contract pinned in §3 below) |
| `.github/workflows/frontend.yml` | Frontend |
| `Cargo.toml` (workspace member list) | Backend creates at scaffolding; Frontend may **append** `crates/app` only |
| `DESIGN.md`, `docs/tasks/**` | **Human only.** Neither agent edits these. |

Rules for both agents:

1. Never write outside your owned paths. If you need a change outside them, stop and report to the human.
2. Work on your branch (`backend/main`, `frontend/main`); small commits; the human merges.
3. Rust: `cargo fmt`, `cargo clippy -- -D warnings`, `cargo test` must pass before every commit. Frontend: `npm run lint`, `npm run test`, `npm run build`.
4. Honor the determinism rules in DESIGN.md §4.6 — no `HashMap` iteration, floats, wall-clock, or RNG in any evaluation/serialization path.

## 2. The one hard dependency, and how we break it

The only real coupling is: **Frontend needs Core's API; Core doesn't exist yet.** Broken as follows:

1. Backend task **B0–B2** lands first (workspace + `.csx` schema + `core::api` type stubs with `unimplemented!()` bodies). This is days, not weeks.
2. Frontend builds **U0–U4 and U6 against a TypeScript mock** (task U9) that implements the §3 IPC contract exactly. No waiting on Rust.
3. Integration point: when Backend B5/B6 land, Frontend U5 swaps the mock for the real Tauri commands. Same contract, no rewrites.
4. Joint smoke test (both agents + human): load `tests/fixtures/alu.csx` in the app, run it, watch wires light up. That's MVP.

## 3. IPC contract (pinned — both agents implement to this)

Transport: Tauri commands (frontend→Rust) and Tauri events (Rust→frontend). `crates/app` (Frontend-owned) is a thin adapter over `csim_core::api` (Backend-owned); all types below are the contract.

**Value encoding (4-state, packed as hex masks):** a bus value is `{ "v": "1fa3", "x": "0000", "z": "0000" }` — bit set in `v` = 1; bit set in `x` = X (contention); bit set in `z` = Z (floating). `x` and `z` never both set for the same bit.

**Commands:**

| Command | Args | Returns |
|---|---|---|
| `load_circuit` | `{ path }` or `{ bytes }` | `{ ok, errors: [LoadError], net_map: [{ net: u32, wires: [u32] }], named: [{ name, kind, comp_id }] }` |
| `save_circuit` | `{ path, document }` | `{ ok, errors }` |
| `sim_play` / `sim_pause` | `{ hz }` / `{}` | — |
| `sim_step_tick` / `sim_step_cycles` | `{}` / `{ n }` | — |
| `sim_run_until` | `{ cycle }` | — |
| `sim_set_mode` | `{ mode: "zero" \| "delay" }` | — |
| `sim_reset` | `{}` | — |
| `poke` | `{ comp_id, pin, value }` | — |
| `mem_read` / `mem_write` | `{ name, addr, len }` / `{ name, addr, values }` | `[{v,x,z}]` / — |
| `snapshot` / `resume` | `{ path }` | — |

**Events:**

| Event | Payload | Semantics |
|---|---|---|
| `net_diffs` | `{ cycle, changes: [{ net: u32, val: {v,x,z} }] }` | Only changed nets; ≤ 1 batch per animation frame consumed; intermediate frames may be dropped — never queue a backlog |
| `sim_status` | `{ running, cycle, mode, eff_hz }` | On play/pause and ~1 Hz while running |
| `sim_halted` | `{ cycle, reason, details }` | `reason`: `breakpoint \| floating-read \| contention \| oscillation \| cycle-limit \| error`; `details` names component/pin for highlighting |
| `timing_update` | `{ t_obs, est_time, violations, top_paths }` | After `sim_run_until` / pause |

**LoadError** (collected, never thrown): `{ kind, message, circuit, comp_id? , wire_idx? }`.

## 4. Component type registry (pinned naming)

Type strings per DESIGN.md §6: `gate.and|or|xor|not|buffer|nand|nor|xnor`, `wiring.pin|constant|clock|splitter|probe`, `plexers.mux|demux|decoder`, `arith.adder|subtractor|multiplier|divider|comparator|negator|shifter|bit-extender`, `mem.register|ram|rom`, `subcircuit`, `io.button|led|hexdisplay`. Backend owns semantics; Frontend owns rendering. Adding one = Backend behavior first, then Frontend visuals.

## 5. Spawn prompts (paste-ready)

> **Backend Agent:** Read `DESIGN.md` and `docs/tasks/README.md` in full, then execute `docs/tasks/BACKEND.md` in order. You own only the paths listed there. Contracts in README §3–4 are pinned; do not deviate. Branch: `backend/main`. Report after each task with its acceptance output.

> **UI Agent:** Read `DESIGN.md` and `docs/tasks/README.md` in full, then execute `docs/tasks/FRONTEND.md` in order. You own only the paths listed there. Contracts in README §3–4 are pinned; do not deviate. Branch: `frontend/main`. Build U9 (mock core) first where unblocked work depends on the IPC contract. Report after each task with its acceptance output.
