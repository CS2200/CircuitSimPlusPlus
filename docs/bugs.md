# CircuitSim++ — Bug & Task Backlog

*Triaged 2026-10-18 against `master` @ `5deed81`.* The trial tester's raw list was
verified item-by-item against the code. Already-fixed, by-design, and
out-of-scope entries were moved to the **appendices** so the active list stays
honest; the rest is ordered by priority.

**Priority:** **P0** correctness/blocker · **P1** course-facing · **P2** UX polish
(small) · **P3** feature (sizeable) · **?** needs info.

---

## P0 — Correctness (fix first)

### 1. Pin names disagree between the editor and the engine
The editor's catalog names pins differently from the core, and
`format/validate.rs:230` rejects wires to unknown pins — so wires drawn on these
pins **fail to load** (verified: an adder with `c_in` wired → *"component
'adder0' has no pin 'c_in'"*):

| component | editor (`frontend/src/editor/catalog.ts`) | engine (`crates/core/src/components.rs`) |
|---|---|---|
| Adder | `c_in`, `c_out` | `cin`, `cout` |
| Subtractor | *(no borrow pins at all)* | `bin`, `bout` |
| Divider | `out` | `quot`, `rem` |
| Decoder | `sel` (1 bit) | `in` (`inputBits` wide) |
| Shifter | `amt` | `amt` *(matches)* |

Already logged as a "known gap" in `frontend/UI_OVERHAUL.md:604`.
**Fix:** one coordinated pass taking the **engine names as the source of truth**
(files, fixtures and the autograder already use them): rename the editor specs,
add the missing subtractor borrow + divider `quot`/`rem` pins, then re-bless the
demo/visual baselines and fixtures. **Size: M.**

### 2. Decoder can't be wired
Follows from #1 but is user-visible on its own: the tile draws `out*` + a
**1-bit `sel`** and no data input, while the engine expects a bus input named
`in` (`inputBits` wide). Any decode circuit either fails validation or floats.
**Fix:** rename `sel` → `in`, widen it to `inputBits`, keep the outputs.
**Size: S** (once #1 lands).

### 3. Any edit resets the simulation (clock lights up, cycle → 0)
The live re-sync (`frontend/src/App.tsx:1116`) full-reloads the engine on every
settled structural edit. A reload boots fresh state, so `cycle` returns to `0`
and the clock body paints green via the `cycle % 2` fallback
(`frontend/src/editor/docScene.ts:1083-1089`) — the reported "clock lights up on
arbitrary circuit modifications", and "cycle counting" is discontinuous because
of it.
**Fix:** (a) stop painting a clock from `cycle` parity unless it is genuinely
running/driven — paint "unknown" after a reload; (b) carry the cycle counter (and
paused clock phase) across a resync instead of zeroing it.
**Size: M.**

### 4. `Ctrl+J` (step) while running doesn't stop the clock
`frontend/src/components/SimBar.tsx:70` calls `stepTick()` unconditionally and
the engine's `step_tick` never stops playback.
**Fix:** in the `Ctrl+J` handler, pause first when running, then step.
**Size: S.**

### 5. Intermittent execution bug — likely a reload race
`SimController.loadInto` (`frontend/src/sim/controller.ts:107`) mutates
`this.doc` / `loadedRevision` and calls `store.reset()` *before* awaiting the
load, and is invoked from three independent places (mount effect, debounced live
re-sync, command `resync`) with **no sequencing**. Two overlapping loads can
interleave diffs from the older snapshot — a plausible source of "sometimes the
circuit runs wrong".
**Fix:** add a monotonic load token (or serialize loads) and drop stale results;
add a test that fires two loads back-to-back and asserts the newer one wins.
**Size: M.** *(If we can't provoke it, ask the tester for a repro.)*

### 6. Probe points the wrong way when rotated N/S
`frontend/src/editor/docScene.ts:1140` draws `probePath` **unrotated**, so a
north/south probe keeps an east-facing point.
**Fix:** rotate the path about the body centre like the gate shapes
(`rotatePath`). **Size: S.**

---

## P1 — Course-facing correctness

### 7. Register readout is dead when `q` is unwired
The readout resolves through the `q` net (`frontend/src/sim/controller.ts:52`),
so an unconnected `q` shows the §61 zero placeholder instead of the stored value
(poked values are already shown optimistically).
**Fix:** read the register's internal state directly (report it like a named
component) rather than only through the `q` net. **Size: M.**

### 8. Probe doesn't match the wire's bit width on connect
`addWire` (`frontend/src/model/document.ts:596`) never adjusts the probe's
`bitsize`.
**Fix:** on connect, set the probe's width from the net/driver. **Size: S.**

### 9. Short-circuit alert just says "contention"
The engine emits `HaltReason::Contention` (`crates/core/src/api.rs:191`) and the
banner prints the bare word.
**Fix:** a human message — e.g. *"short circuit: net N is driven both high and
low"* — kept in the prominent banner. **Size: S.**

### 10. "Name pins" is only a generic load failure
`format/validate.rs:152` has a clear engine message, but the UI surfaces it as a
plain load error.
**Fix:** a dedicated, prominent frontend warning for unnamed/unreachable pins.
**Size: S.**

### 11. Pin capitalization + long-name truncation
Capitalize labels (`AMOUNT`, `CARRY_IN`…) and ellipsize long pin names —
`docScene.ts:1374` draws them raw at a fixed size. **Fix:** fold the rename into
#1's naming pass (note: engine/fixtures use `amt`, so it is a format change too)
and add width-based ellipsis to the pin-label draw. **Size: S.**

---

## P2 — UX polish (small; batch these together)

- **Cycle input**: hide the native number spinners; placeholder `cycle #`
  (`SimBar.tsx:117`).
- **Save**: indicator wording ("Saving…" / "Saved") **and allow saving with
  validation errors** — the Tauri save currently refuses (`App.tsx:614`).
- **Tooltips**: component name only — drop the *"click… Shift-click… Esc
  cancels"* boilerplate (`App.tsx:1673`).
- **Theme**: remove the standalone light/dark toggle from the header (fold into
  Settings); reconcile light-mode history colors.
- **Trim**: remove the `named` history badge (`HistoryDrawer.tsx:83`); simplify
  the reset label; tidy tab / timing-readout alignment.
- **Sheet tabs**: right-click → Rename (the menu is on middle-click today,
  `SheetTabs.tsx:38`).
- **Canvas**: bottom zoom slider.
- **Reload from Disk**: confirm before discarding edits.
- **Clock**: 12-/24-hour timestamp toggle.
- **Wires**: stable colors — the hue is keyed to the derived net id, so colors
  reshuffle when wires are added/removed (`docScene.ts:845`).
- **Wire editing**: on-screen "press Esc to exit" hint.

---

## P3 — Features (sizeable; schedule deliberately)

- Export the canvas/circuit as an image.
- Right-click context-menu overhaul.
- Version history: full-viewport view (no overlay), diff highlighting + copy.
- Subcircuits: always-visible panel, click into an *instance* vs template,
  scope colors, resizing, dynamic outer pins from inner pin rotation.
- RAM: independent address/data bit widths.
- Primitives: transistor / power / ground.
- Propagation-delay readout + an animation pulse-rate slider.

---

## Appendix A — Needs info (can't reproduce / ambiguous)

- **"Remove unnecessary wire end segments method"** — no such method exists;
  which symptom?
- **"Text element load-failed bug"** — not reproducible; text annotations are
  validated and covered by tests. Need the failing file.
- **"Fix clear/edit button state inconsistencies"** — which buttons?
- **"Remove 'Named' bubble"** — assumed the history `named` badge; confirm.
- **"Simplify reset label to Reset"** — the transport already reads `reset`;
  which control?
- **"Show propagation delays"** — per-component numbers, or is the `T_obs`
  readout enough?
- **"Reposition 'Restore Version' tab to the far right"** — that control isn't a
  tab today.
- **"Intermittent general circuit execution bug"** — see #5; ask for a repro.

## Appendix B — Removed from the list (fixed / by design / out of scope)

- **Wire relocation with a bend/junction** — works; junction dependents are
  re-projected (`document.ts:997`), tested.
- **Routing a new wire from an existing junction** — press-and-sweep does this
  (`editor/tools.ts:403`), tested.
- **Unintended wire deletion near a removed part** — only pin-endpoint wires
  (plus their junction branches) are removed; by design.
- **Wire dim/brighten on activity** — implemented (`docScene.ts:852`).
- **MUX/DEMUX explicit names** — already `MUX` / `DEMUX`.
- **Redundant double value on the register `q` pin** — removed in `5deed81`.
- **Error overlays shifting the nav bar** — fixed (`.sim-banner` overlays).
- **Bit-width mismatch clarity** — improved (blinks + Inspector note, self-clears
  when resolved); verify on the next release and close.
- **Dashed lines between paired tunnels** — no tunnel feature exists (excluded by
  `DESIGN.md`); drop unless tunnels are added.
- **Waveform viewer tab / Debugging tab with breakpoints** — `DESIGN.md` keeps
  these out of scope for now (probes + inspection cover the need); revisit only
  if requested.
- **"Polish application logo"** — subjective, not actionable.
- **"Support floating-point resistors"** — there is no resistor part, and a
  digital net is 0/1/Z/X. Clarify what's wanted.
