# UI Agent — Task List

> **Status (2026-10-06, human): COMPLETE (mock-verified) + integrated.** U1–U8 all landed
> and merged to master; contract v1.1 uptake done (structured violations with on-canvas
> markers, event-timestamped pulses, full-batch initial paint, halt attribution). The
> mock→real seam is wired: `crates/app` now constructs `csim_core::session::Session` and
> the IPC surface gained `sim_reset` (reset = engine reset + autoload re-apply).
> Gates: 182 unit + 16 e2e green, lint/build clean, bench ~3 ms avg render on the stress
> scene (SwiftShader). Owed to the human: U4/U7 screenshot sign-offs, real-GPU 60 FPS
> re-check on a packaged build, GITHUB_REPO value, release dry-run (needs the remote).
> Follow-ups filed: pin/component spatial indexing, hover re-render churn, U4 spec-letter
> partials (wire-thickness∝bitsize, idle-wire hover), file open/save UI (planned seam).

_(Recorded as of that date. See `README.md` for the live gate and `docs/bugs.md` for the open backlog; the `.csx` format has been revised since — `docs/format-v2.md` is normative, not the sketch quoted in `DESIGN.md` §5.2.)_

**Mission:** Build the Tauri + React desktop app per `DESIGN.md` — Milestones M2, M3, the UI side of M4, and M5.
**Owns:** `frontend/**`, `crates/app/**` (Tauri shell), `docs/ipc.md`, `.github/workflows/frontend.yml`.
**Never touches:** `crates/core/**`, `crates/cli/**`, `tests/**`, `docs/tasks/**`, `DESIGN.md`, `docs/format-v2.md`, `docs/delay-table.md`. (Exception: may append `crates/app` to the root `Cargo.toml` workspace members — nothing else in that file.)

Execute in order. U9 (mock core) comes before anything that needs a running simulation — it is what lets you work in parallel with the Backend Agent. After each task: run its acceptance checks and report.

---

## U9 — Mock core (do this first, unblocks everything)

> ⚠️ The contract types already exist: `frontend/src/ipc/types.ts` (scaffolded, tested).
> This task is the mock *implementation* (`src/ipc/mock.ts`) behind the `CoreApi` interface.

**Spec:** README §3 (IPC contract). **Depends on:** U0

- TypeScript module implementing every README §3 command/event behind the exact contract types, backed by a tiny in-memory demo circuit (a counter: clock → register → adder → probe, a few dozen gates).
- Toggle via env var: `VITE_MOCK_CORE=1`. Emits realistic `net_diffs` batches at configurable Hz so the renderer/bridge can be perf-tested without Rust.

**Done when:** every later task up to U5 can demo end-to-end with the mock; contract types are shared (`frontend/src/ipc/types.ts` — the single source Frontend compiles against).

## U0 — Scaffolding

> ✅ **Done (human, 2026-10-06).** Vite + React 18 + TS strict, Tauri 2 shell (`crates/app`,
> verified compiling), ESLint/Prettier/Vitest/Playwright configs, `frontend.yml`, `docs/ipc.md`,
> and the `src/ipc/types.ts` contract types are landed and verified: `npm run lint`,
> `npm run test`, `npm run build` all green locally. The CI matrix and Tauri bundles can only be
> verified once this is pushed to GitHub (repo is not yet git-initialized — human's call).
> **Start at U9.**

**Spec:** DESIGN.md §7.1. **Depends on:** —

- Vite + React 18 + TypeScript strict in `frontend/`; Tauri 2 shell in `crates/app` (append to workspace members only). ESLint + Prettier + Vitest + Playwright.
- `frontend.yml` CI: lint, unit tests, `tauri build` matrix (ubuntu, windows, macos).
- Write `docs/ipc.md`: the README §3 contract as normative prose + TS types.

**Done when:** `npm run tauri dev` opens a themed empty window; CI produces (unsigned) dmg/zip artifacts on all three OSes.

## U1 — Canvas renderer core

**Spec:** DESIGN.md §7.0, §7.1. **Depends on:** U0

- One `<canvas>` in one React component; camera (pan/zoom, grid snapping); world↔screen transforms.
- Renderer behind an interface (`Renderer` trait-equivalent in TS) so WebGL can slot in later; batched path drawing (group by state color, single pass per color).
- Spatial index (e.g., uniform grid) for hit-testing wires/components.

**Done when:** synthetic stress scene — 5,000 wires + 1,500 components, pan/zoom/drag — holds 60 FPS (measured, reported) on the weakest dev machine available.

## U2 — Circuit document model

**Spec:** DESIGN.md §5 (mirror of the schema; Backend owns the schema, you consume it). **Depends on:** U1

- TS model of `.csx` (components, wires with `join` endpoints, circuits), selection model, dirty tracking.
- Undo/redo stack (command pattern; this is where the post-MVP provenance journal will eventually hook in — keep it clean).
- Union-find net derivation client-side (for net-extent highlight pre-integration; matches Backend semantics).

**Done when:** unit tests: document ops + undo/redo invariants + net derivation on junction graphs.

## U3 — Editor interactions

**Spec:** DESIGN.md §7.1. **Depends on:** U2

- Palette drag-drop; place/rotate (R key); wire routing with click-placed bends; junction on drop-onto-wire (dot); drag components with wires attached (routes stretch); multi-select (box + shift); copy/paste; delete semantics per §5.2 (junction dependents).
- Keyboard map documented in-app (help overlay).

**Done when:** Playwright interaction suite green: place, wire, junction, drag, delete-branch, undo-all.

## U4 — The DLS look

**Spec:** DESIGN.md §6 (visual language), §7.1, Appendix B.1. **Depends on:** U3

- Gate shapes: distinctive per family, bubbled inputs render as bubbles (config from `attrs.negateInputs`).
- Wires: quadratic-Bézier rounded corners (~0.12 grid-unit radius), per-state colors (low/high/`X`/`Z`/disconnected), per-bus hues (rainbow buses), thickness ∝ bitsize option; hover = brighten + **net-extent highlight**.
- Theme system: CSS custom properties; dark + light themes ship; palette is data (accessibility drop-in later, D8).

**Done when:** side-by-side screenshot review against DLS reference scenes (human sign-off); Playwright visual-regression baseline committed.

## U5 — Sim bridge (integration point)

**Spec:** DESIGN.md §7.2; README §3. **Depends on:** U9 (mock), U4; **integrates real core after Backend B6**

- `crates/app`: thin Tauri adapter exposing README §3 commands/events, delegating to `csim_core::api` (until B0 lands, gate behind the same `VITE_MOCK_CORE` seam).
- Diff consumption: ≤ 1 batch per animation frame; drop intermediates, never backlog; status/halt/timing events wired to UI.
- Sim controls: play/pause/step-tick/step-cycle/speed slider/run-to-cycle-N; watch panel (named probes/registers, value display modes unsigned/signed/hex); error markers on canvas for `sim_halted` reasons (floating/contention/oscillation) with component highlight.

**Done when:** with mock: full control loop works; after Backend B6: **joint smoke test** — load `tests/fixtures/alu.csx`, run, wires light with correct states, pause/step match `csim` CLI results cycle-for-cycle.

## U6 — Memory & probe UX

**Spec:** DESIGN.md §6, §8.1. **Depends on:** U5

- RAM/ROM inspector: hex grid viewer/editor (read-only while running), `autoload` path picker (relative path, displayed clearly), contents preview of loaded file image.
- Probe placement/config (name, display mode); reset button semantics = engine reset **+ autoload re-applies** (DESIGN §5.2) — show a toast confirming reloads.

**Done when:** Playwright: set autoload, run, modify RAM via poke, reset → inspector shows file image restored.

## U7 — Timing visualization (M4, UI side)

**Spec:** DESIGN.md §4.3–4.4, §14 M4. **Depends on:** U5 (real core), Backend B6

- Propagation animation: signals visibly travel wires (transport delay is in the engine; render edge-positioned pulses from event timestamps at low sim speeds).
- `timing_update` → observed-critical-path highlight on canvas (component IDs from the report); setup/hold violation markers on the offending registers.

**Done when:** demo fixture `pipeline5.csx`: run → `T_obs` banner updates → clicking it highlights the path; human sign-off on clarity.

## U8 — Packaging & update nudge (M5)

**Spec:** DESIGN.md §9. **Depends on:** U0 CI

- Release workflow: tag → matrix builds → GitHub Release with dmg/zip + the unsigned-build workaround text (right-click→Open / SmartScreen note) in the release body and in-app About page.
- Startup check: fetch latest release tag from our GitHub repo, semver-compare, "please upgrade" dialog with link. Never forced, never auto-installs. Offline = silent skip.

**Done when:** dry-run release on a fork: artifacts downloadable, nudge dialog appears when version is behind, dismissed-permanently option works.

---

**Definition of done for the whole frontend:** M2/M3/M5 acceptance in DESIGN.md §14; joint smoke test (U5) green against the real engine; 60 FPS acceptance (U1) re-verified on the final build; all CI green on the three OSes.
