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

## 2. File open/save UI — deferred on purpose

The contract has `load_circuit { path }` / `save_circuit { path, document }`
(canonical serializer engine-side — **never** save local JSON). Missing UI,
to build at integration:

- Open/Save/Save-as buttons + Tauri file dialogs (`@tauri-apps/plugin-dialog`),
  recent-files list, dirty-dot → save reminder, autosave-on-quit prompt.
- Load flow: file path → `load_circuit` → errors listed in the banner
  (store already handles `LoadError`s with comp/wire highlighting hooks).
- Save flow: doc → `save_circuit` (engine canonicalizes; byte-identical
  re-saves, §5.1).

## 3. Contract gaps to raise with Backend (docs/ipc.md owners: us)

- **`timing_update.violations` is only a count.** U7's setup/hold register
  markers need the offending components. Proposal:
  `violations: [{ comp_id, kind: "setup"|"hold", detail }]`, keep the count
  as `violations.len()`. Mock emits `[]` meanwhile.
- **Event timestamps for pulses:** exact propagation animation (U7 full
  acceptance) needs transport-delay event times in `net_diffs` (e.g.
  `changes: [{ net, val, at }]` in delay mode). v1 pulses trigger on batch
  arrival; the PulseTracker API already speaks spawn-at-time, so the swap
  is local.
- **Free wire endpoints** (proposal already sent to the human): endpoint
  kind `{ free: [x,y] }` — dangling wires, draw-wires-first,
  delete-component-keep-wires. Needs DESIGN.md §5.2 + B2/B3 semantics +
  editor op `rewireEndpoint`. Floating stub reads `Z`.

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
- **U7 clarity:** `e2e/timing.spec.ts-snapshots/timing-path-*.png`.
- **60 FPS re-verify on the final packaged build** (the bench runs in every
  e2e pass; currently ~3 ms avg render on the stress scene).

## 7. Nice-to-haves (unpinned, ask first)

- Subcircuit editing UI (schema supports; editor doesn't).
- Savestate/restore buttons (contract `snapshot`/`resume` exist; mock
  implements in-memory).
- Colorblind-accessibility theme (D8: palettes are data — drop-in).
