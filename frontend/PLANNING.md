# Frontend — Integration TODO (the planning doc)

Items deliberately deferred until the **real Backend session** (B9's concrete
`csim_core::api::Sim` impl) and/or the **GitHub remote** exist. Everything here
is pinned to a specific swap point so the integration pass is mechanical.
Ordered roughly by dependency.

---

## 1. Wire the real engine (Backend B9 → this repo)

- **Swap point:** `crates/app/src/lib.rs :: new_session()` — one-line change
  once csim-core exports a constructible `Sim`. Everything downstream
  (commands, `EventSink` → Tauri events) is already implemented and compiling.
- **Then:** remove the clean-error path and re-test the packaged app.
- **Joint smoke test (U5 done-when):** load `tests/fixtures/alu.csx`
  (Backend B11), run, wires light with correct states, pause/step match
  `csim` CLI cycle-for-cycle. The whole UI side is already built and
  e2e-tested against the mock.

## 2. File open/save UI — IMPLEMENTED (menu bar)

Implemented via the menu bar (`src/components/MenuBar.tsx` +
`src/files.ts`): File menu with New / Open… (Ctrl+O) / Save (Ctrl+S) /
Save As… (Ctrl+Shift+S), dirty-confirm on destructive opens, native
dialogs in the Tauri shell (`@tauri-apps/plugin-dialog` + `plugin-fs`),
browser fallbacks (file input / download) in mock dev. The engine loads
via `load_circuit { path }` so memory autoloads resolve next to the file;
saves go through `save_circuit { path, document }` (canonical serializer
engine-side — never local JSON). Subcircuit sheets live in the
Subcircuits menu (new/rename/switch). Still open:

- Recent-files list, autosave-on-quit prompt.
- Native-dialog smoke on Windows/macOS (CI drives the browser fallbacks;
  Linux verified).

## 3. Contract gaps → RESOLVED by contract v1.1 (docs/ipc.md, human-ratified)

- ~~**`timing_update.violations` is only a count.**~~ RESOLVED: v1.1
  `violations: TimingViolation[]` = `{ circuit, comp_id, kind, detail }`;
  the count is `violations.length`. U7 register markers are implemented
  (canvas ring + ⚠kind tag + hover detail card, current-sheet filter).
- ~~**Event timestamps for pulses.**~~ RESOLVED: v1.1 `NetChange.at?` (ns
  since run start; delay mode only). Pulses stagger spawns from `at` within
  a flushed frame (`sim/pulses.ts`); zero mode falls back to batch arrival.
- ~~**Halt attribution convention**~~ (was our unratified docs/ipc.md §5
  amendment). RESOLVED + tightened in v1.1: `details` starts with
  `comp <CompId> pin "<pin>": <message>`; CompId = root-sheet
  document-order; subcircuit culprits report the enclosing INSTANCE's
  root-sheet id.
- ~~**Tick semantics.**~~ RESOLVED: tick = one clock half-period in delay
  mode; one full cycle in zero mode (documented at `sim_step_tick`).
- ~~**Initial full-state batch.**~~ RESOLVED: v1.1 `NetDiffs.full` — true
  exactly for the ONE initial batch after load/resume; the "never full
  state" rule carries this exception. Full frames spawn no pulses.
- **CompId redefinition (v1.1):** document-order index into the REFERENCED
  circuit's components array; messages that can reference non-root circuits
  carry `circuit` (`TimingViolation`/`TimingPath`/`NamedComponent`).
  `net_map` stays root-circuit-only for v1 (documented limitation).
- **Free wire endpoints** — still DEFERRED. The human holds this as
  amendment P1 (not scheduled). No editor/schema work until ratified.

## 4. Mock conventions to retire at integration

- **Autoload:** the mock embeds images inline (`"hex:<rle-hex>"`); the real
  engine reads the file relative to the circuit (§11). Keep the UI (path
  field + reset toast) — only the mock's interpretation is temporary.
- **Mock demo circuit** (`?simdemo=1`, `mockDemoSpec.ts`): dev affordance;
  the real engine needs no marker circuit.
- **Memory inspector polling:** refreshes on paused store changes; the real
  engine may emit diffs for RAM writes (clocked RAM) — no change needed,
  but re-verify.

## 5. Release/distribution (needs the GitHub remote — human's call)

- Set `GITHUB_REPO` in `frontend/src/update.ts` (nudge silently skips
  until then).
- Dry-run release on a fork (U8 done-when): tag → matrix artifacts
  downloadable; nudge appears when behind; dismissal persists.
- CI matrix green on the three OSes (`.github/workflows/frontend.yml`).

## 6. Sign-offs owed to the human

- **U4 look:** `e2e/visual.spec.ts-snapshots/demo-*.png` vs DLS reference.
- **U7 clarity:** `e2e/timing.spec.ts-snapshots/timing-path-*.png` (baseline
  regenerated for v1.1: the synthetic setup-violation marker now renders).
- **60 FPS re-verify on the final packaged build** (the bench runs in every
  e2e pass; currently ~3 ms avg render on the stress scene).

## 7. Nice-to-haves (unpinned, ask first)

- Subcircuit editing UI (schema supports; editor doesn't).
- Savestate/restore buttons (contract `snapshot`/`resume` exist; mock
  implements in-memory).
- Colorblind-accessibility theme (D8: palettes are data — drop-in).
