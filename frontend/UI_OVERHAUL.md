# UI Overhaul — Pan Gestures, OLED Themes, Right-Dock Inspector

**Status:** planned (2026-10-15, human-directed). Frontend-owned document:
`DESIGN.md` and `docs/tasks/**` are human-only, so the three UX decisions below
are recorded here until the human folds them into `DESIGN.md` §7.1.

> **Reading order.** §1–§3 are normative. From §7 on this is a per-pass
> changelog, written as each batch landed. **Where a later section contradicts an
> earlier one, the later one wins** — §62 supersedes the memory pin layout and the
> header theme toggle that §9 and §24 describe.

**Scope (what this pass changes):**

1. **Pan gestures** — holding right-click and dragging pans; Shift+left-drag
   pans. Existing pan entry points (middle-drag, Space+left-drag) stay.
2. **Themes** — a new **OLED** theme (true-black, the new default) and a
   Settings dialog with a preconfigured theme picker. Themes stay _data_
   (DESIGN.md §7.1 / D8): every theme is a CSS custom-property block, and the
   canvas reads it back through `resolveTheme` with zero renderer changes.
3. **Component editor** — the modal `PropertiesDialog` (double-click) is
   retired. The component editor is an **Inspector panel docked on the right**,
   and it appears when a single component is selected.

**Non-goals:** no changes to simulation semantics, the IPC contract, the
`.csx` format, gate/wire rendering, or the palette. Nothing in
`crates/core/**`, `crates/cli/**`, `tests/**`, `DESIGN.md`, `docs/tasks/**`.

---

## 1. Pan gesture model (normative)

The canvas now has two "click-or-pan" gestures. They are disambiguated by a
**4 CSS-px movement threshold** owned by `CanvasHost` (screen space, so
constant across zoom):

| Input (canvas)   | Press without movement                                                                                                       | Drag past threshold                                                                  |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Plain left       | scene click (select/wire/box)                                                                                                | scene drag (unchanged)                                                               |
| **Right**        | right-click action (cancel wiring/placement; on a subcircuit instance: jump to its definition)                               | **pan**                                                                              |
| **Shift + left** | shift-click action (toggle component selection; shift+click a wire: value card; shift+click canvas: plant bend while wiring) | **pan**                                                                              |
| Middle           | pan (immediate, unchanged)                                                                                                   | pan                                                                                  |
| Space + left     | pan (immediate, unchanged)                                                                                                   | pan                                                                                  |
| Ctrl + left      | scene click (unchanged)                                                                                                      | additive box select (new alternative to Shift+box, which Shift now owns for panning) |
| Wheel            | zoom at cursor (unchanged)                                                                                                   | —                                                                                    |

**Why threshold-on-release:** right-click already means "cancel"/"open
subcircuit" and Shift+click already means "toggle/select". Making the pan
gesture claim the _drag_ without stealing the _click_ preserves both; the
scene handlers only ever see a click. For Shift+left this is implemented by
deferring the scene's `pointerdown` until release: if the pointer never moved,
`CanvasHost` synthesizes `down`+`up` to the scene (exactly a click); if it
moved, it pans instead and the scene never sees the gesture.

**Behavior notes:**

- Dragging (right or Shift+left) while a wire is in progress pans **without
  cancelling the wire** — the preview follows the cursor. Cancel remains
  Esc / right-click.
- Right-click cancel now commits on button **release** (was: press). A press
  that becomes a pan never cancels.
- The browser context menu is suppressed on the canvas (`contextmenu` →
  `preventDefault`) — required for right-drag to feel native.
- `pointercancel` clears any pending/active pan (no stuck camera).
- Shift+click behaviors on wires/components and right-click on subcircuit
  instances are byte-for-byte the old behaviors when the pointer doesn't
  move (synthesized click).
- Scene-level tests are unaffected: `ToolMachine` still receives only clicks;
  the threshold lives in the host.

**Trade-off, accepted:** Shift+box-select (additive marquee) moves to
Ctrl+drag; Shift+drag is now pan. Documented in the in-app help overlay.

## 2. Themes (normative)

### 2.1 Catalog

Three preconfigured themes, in picker order:

| id      | name      | role                                                                                          |
| ------- | --------- | --------------------------------------------------------------------------------------------- |
| `oled`  | **OLED**  | **Default.** True-black background; saturated wire hues tuned for black; `color-scheme: dark` |
| `dark`  | **Dark**  | The pre-overhaul dark theme, unchanged (baseline-compatible)                                  |
| `light` | **Light** | The pre-overhaul light theme, unchanged                                                       |

Every theme block defines the full custom-property set the canvas consumes
(`resolveTheme` in `src/render/theme.ts`): `--bg`, `--grid`, `--panel`,
`--panel-border`, `--text`, `--text-dim`, `--accent`, `--wire-low/high/x/z/
disconnected`, `--bus-a..e`, `--violation`, plus `color-scheme`.

OLED palette (deliberate choices: pure `#000` background — not near-black —
so OLED panels actually power pixels off; panel/grid lift just enough to
separate surfaces; wire colors pushed brighter/saturated for black):

```css
[data-theme="oled"] {
  --bg: #000000;
  --grid: #131318;
  --panel: #0a0a0e;
  --panel-border: #26262e;
  --text: #f2f2f7;
  --text-dim: #9c9cad;
  --accent: #7aa2ff;
  --wire-low: #4a8fd8;
  --wire-high: #2ee87a;
  --wire-x: #ff5c52;
  --wire-z: #7d7d88;
  --wire-disconnected: #1b1b22;
  --bus-a: #ffc94d;
  --bus-b: #c58cff;
  --bus-c: #5ae6f5;
  --bus-d: #ff85bd;
  --bus-e: #c9f75a;
  --violation: #ffab3d;
}
```

### 2.2 Preference & application

- **Persistence:** `localStorage["csx.theme"]`. Unknown/missing/unreadable
  values fall back to `oled`. The preference is per-user, per-machine — _not_
  part of the `.csx` document (the format's `settings` is normative and
  delivery-specific; `DELAY.md`/format-v2 §2 stays untouched).
- **Application:** `data-theme="<id>"` on `.app`; the canvas host re-resolves
  computed styles on change. Theme switches are instant, no reload.
- **Picker:** a **Settings** header button opens `SettingsDialog`:

  ```
  Settings
  └─ Appearance
     └─ Theme: [ OLED card ] [ Dark card ] [ Light card ]
  ```

  Cards show name, one-line blurb, and four swatch chips; the active card is
  marked (✓ + accent ring). Selecting applies live and persists. Escape /
  backdrop / ✕ closes. The old one-click dark/light toggle button is retired
  (it cannot scale to N themes).

D8 stays satisfied: a colorblind-accessibility theme remains a new
`[data-theme=...]` block + one catalog entry, no refactor.

## 3. Component editor → right-dock Inspector

### 3.1 Layout

The right side of the editor becomes a dock with two tabs
(`role="tablist"`):

- **Inspector** — the component editor (this document, §3).
- **Watch** — the existing watch panel + memory inspector, unchanged content.

Both tabs stay mounted; the inactive one is `hidden` (watch display modes and
an open memory inspector survive tab hops). Dock width: 16 rem.

### 3.2 Visibility rules (the "instead of double-clicking" part)

- Selecting **exactly one component** auto-activates the **Inspector** tab.
- When the selection becomes **empty**, the dock returns to **Watch** (only
  if Inspector was active).
- Selecting a wire, or 2+ components, does not auto-open the Inspector;
  visiting it manually shows a matching empty state
  ("Nothing selected…", "N selected…").
- Double-click a component = select it + activate the Inspector (kept as a
  shortcut for muscle memory). The modal dialog is gone.

### 3.3 Editing semantics (live, undo-coalesced)

All edits apply directly to the document via `updateComponent` — no
Apply/Cancel:

| Field kind                                        | Commit timing                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------- |
| Name, autoload path, text attrs                   | Enter or blur (draft while focused)                              |
| Numbers (bitsize, inputs, selBits, depth, value…) | Enter/blur, or immediately when the typed/spun value is in range |
| Rotation, selects, checkboxes                     | Immediately                                                      |

- Each commit is **one undoable op**. Consecutive commits on the _same field_
  coalesce (`coalesceKey = edit:<circuit>:<id>:<field>`) so a typing burst or
  a stepper spree is a single undo step. `updateComponent` gains an optional
  `coalesceKey` parameter for this.
- Structural edits keep their existing safety: reducing gate inputs /
  selBits prunes wires to vanished pins (document semantics, unchanged).
- `wiring.pin`: flipping "Output pin" mirrors default facing E ↔ W (same
  rule the dialog had).
- Unnamed `mem.ram`/`mem.rom`/`mem.register`/`wiring.probe` components show a
  quiet hint: _"Not autograder-addressable — give it a name"_ (DESIGN.md
  §13.7 nudge).

### 3.4 Plumbing

- `EditorStatus` gains `selectedComponents: readonly string[]` and
  `revision: number` (doc revision) so `App` can drive the dock and the panel
  re-reads state after undo/redo or any external edit.
- `ToolMachine.doubleClick` now also selects the component before firing
  `onEditComponent`, so the dock and canvas agree on what is being edited.
- `App` runs the dock-tab state machine (§3.2); `EditorCanvas` keeps owning
  canvas state. No sim/IPC changes.

---

## 4. Test plan

**Unit (vitest):**

- `src/theme.test.ts` — preference load/save/fallback/unknown-value handling
  (fake `localStorage`), catalog integrity (ids unique, default exists).
- `src/editor/tools.test.ts` — double-click selects the component and fires
  `onEditComponent`; Ctrl+left boxing is additive.
- `src/model/document.test.ts` — `updateComponent` coalescing: consecutive
  same-key edits collapse into one undo step; a different key starts a new one.

**E2E (Playwright):**

- `e2e/pan.spec.ts` (new) — right-drag pans the camera; Shift+left-drag pans;
  right-click (no move) still cancels wiring; Shift+click a wire still shows
  the value card; middle-drag/Space+drag still pan.
- `e2e/settings.spec.ts` (new) — Settings → pick theme → `data-theme`
  changes; choice persists across reload.
- `e2e/editor.spec.ts`, `fileops.spec.ts`, `memory.spec.ts` — property edits
  move from "dblclick + Apply" to "click + inspector + Enter/blur".
- `e2e/visual.spec.ts` — one screenshot per theme via the picker;
  `demo-dark`/`demo-light` baselines stay byte-compatible (palettes
  unchanged), `demo-oled` is the new baseline.
- `sim.spec.ts` / `timing.spec.ts` — pin `csx.theme=dark` in an init script
  so their committed screenshots keep validating the dark palette
  (theme picker coverage lives in visual/settings specs).

**Baseline convention:** baselines are committed per platform (CI runs e2e
on Linux only). A platform without a committed baseline would normally fail
its first screenshot run even with `updateSnapshots: "missing"` — so the
suites assert through `e2e/screenshots.ts :: expectScreenshot`, which on a
missing baseline captures it to the expected path, passes, and annotates the
report for review. A first run on Windows (or Linux CI for the new
`demo-oled`) therefore stays green and produces the file to inspect and
commit.

**Two pre-existing test fragilities surfaced by this pass, fixed:** the
File-menu round-trip read the document the same tick as the async
open/new (now waits deterministically), and the pin-terminal wiring test
aimed at raw pixel offsets ~0.01 units outside `PIN_TOL` (now aims at the
terminal's world position via the camera).

**Gates:** `npm run lint`, `npm run test`, `npm run build`, `npm run test:e2e`.

## 5. Acceptance checklist

- [x] Doc written before code (this file). _(T1)_
- [x] Pan: right-drag + Shift+left-drag; clicks keep old semantics; context
      menu suppressed; help overlay updated. _(T2)_
- [x] OLED theme block + `dark`/`light` unchanged; default `oled`;
      localStorage persistence; Settings dialog with theme cards; pre-paint
      bootstrap in `index.html`. _(T3)_
- [x] Right dock w/ Inspector + Watch tabs; selection-driven Inspector;
      live undo-coalesced editing; modal retired; unnamed-component nudge;
      schema-default placeholders on empty number fields. _(T4)_
- [x] Unit + e2e suites updated/added; baselines handled per §4 (lint / 201
      unit / build green; 28/28 e2e green). _(T5)_
- [x] `PLANNING.md` pointer to this document; follow-ups re-checked. _(T6)_

## 6. Follow-ups (not this pass)

- Procedural/OS-follow theme (`prefers-color-scheme`) — trivially a fourth
  catalog entry later.
- Colorblind-accessibility palette (D8) — still a data drop-in.
- Inspector: per-field scrub-to-edit; multi-select batch edits.
- Separating the statusbar cursor readout from hover-rate re-renders
  (pre-existing; unaffected by this pass).

## 7. Second pass (2026-10-15): resizable panels + palette glyphs

Team direction after the first pass. Per the human, the **Watch tab stays**
("keep the watch tab for now") — no changes to §3's dock contract.

**Resizable side panels.** The palette and the right dock are resizable by
dragging the separator strip between the panel and the canvas:

- Bounds/defaults: palette 150–320 px (default 190), dock 220–420 px
  (default 256). `src/panels.ts` owns clamp/load/save; `App` holds the live
  widths and persists on release (`csx.panel.palette`, `csx.panel.dock`).
- Interaction: pointer drag with capture (live re-layout, one localStorage
  write on release); double-click resets the default; the handle is a
  focusable `role="separator"` with Arrow-key stepping (±8 px).
- The handles are edge **overlays** on the work area (absolute, no layout
  footprint): the canvas geometry is identical whether or not the panels
  are resizable, which also keeps the visual-regression baselines stable.
  The panels' former static borders are gone.

**Palette component glyphs.** Every palette entry renders a small SVG
miniature of the component next to its name (`components/CompIcon.tsx`):

- gate bodies come from the real `gateShape` geometry and pin stubs/dots
  from the catalog's pin specs — the sidebar is a faithful miniature of
  what gets placed, same curves as the canvas;
- box families carry a short glyph (+ − × ÷ = ~ «, REG/RAM/ROM, DEC, 1, 8);
  clock/probe/LED get bespoke silhouettes; subcircuit modules get an inset
  border. Icons draw in `currentColor`, so every theme (incl. OLED) styles
  them automatically;
- the palette is a responsive grid (`auto-fill, minmax(80px, 1fr)`) — a
  wider panel simply shows more columns (see §8 for the group rail).

**Acceptance:** `e2e/panels.spec.ts` (drag / persist / reset / clamp /
keyboard + icon coverage) and `src/panels.test.ts` (clamp / load / save)
pass; lint / unit / build / e2e green.

## 8. Third pass (2026-10-15): palette activity rail (VS Code-style)

Team direction: one rail icon per component group; hovering a group icon
opens that group's components.

- **Layout:** the palette is a fixed 44px **activity rail** plus the
  resizable body. The rail carries one glyph per registry group (Gates,
  Wiring, Plexers, Arithmetic, Memory, I/O — plus Subcircuits while the
  document has more than one circuit); the body shows the active group's
  item grid with the group name as its header. The rail is fixed-width;
  the persisted `csx.panel.palette` width keeps covering the whole panel
  (default stays 190px — rail 44 + a single-column body, VS Code-like;
  widen the panel for more columns).
- **Interaction:** hovering, focusing, or clicking a rail icon switches
  the body (VS Code's click model, extended with hover as requested).
  Markup is `role="tablist"`/`role="tab"`/`role="tabpanel"` with roving
  focus; ArrowUp/ArrowDown move between groups; each icon has a `title`
  tooltip and the active one gets the accent left-bar treatment. If the
  active group disappears (Subcircuits after New), the body falls back to
  the first group.
- **Group glyphs** (`PaletteGroupIcon`, same `CompIcon` language,
  `currentColor`, theme-agnostic): NAND for Gates, a bent wire with a
  junction dot for Wiring, mux/adder/RAM/LED/module for the rest.

**Acceptance:** `e2e/panels.spec.ts` covers rail hover/click switching,
per-group icon coverage, and the resize numbers; the other suites
(canvas geometry unchanged → baselines unchanged) stay green.

## 9. Fourth pass (2026-10-15): VS Code-style top bar

> Superseded by §28 (Docs-style two-row header).

Team direction: title-bar layout; icons instead of text buttons.

- The old app header (big "CircuitSim++" title + text buttons) is gone —
  the menu row is now the window's title bar, flush at the top, on one
  row: menus (File, Simulation, Subcircuits, Help) on the left, the
  current file centered (front-truncated when long), window actions on the
  right. Stress mode gets the same bar with just the animate + theme
  controls.
- Undo/redo are icon buttons (the live undo/redo labels stay in the
  tooltips), as are the light/dark toggle, help (`?`), about and settings;
  all keep aria-labels, titles, and disabled states. Glyphs live in
  `components/icons.tsx` (16px strokes in `currentColor`, no icon package).
- Help moved into a **Help** menu ("Keyboard shortcuts" — still `?` — and
  "About CircuitSim++"); Settings is **File ▸ Settings…**. The `?` key and
  Escape behavior are unchanged.
- The **light/dark toggle** sits at the far right of the row: it flips
  between the light theme and the last dark-family theme (OLED unless the
  user picked dark) and persists through the normal theme preference.

**Amendment (routing/top-bar merge, 2026-10-15):** the parallel worktree
branch merged on top keeps this title-bar layout, the Help menu and
**File ▸ Settings…**, but per the human's direction:

- **rotate** is now a floating ↻ button drawn above the component selection
  on the canvas (`R` still works) — no rotate icon in the bar;
- there is **no delete icon** (Del and Edit ▸ Delete remain);
- the top bar also carries the settings gear, about and help icons, and an
  **Edit** menu (Undo/Redo/Copy/Paste/Rotate/Delete/Select All);
- the Settings dialog gained the second-pass theme catalog (OLED/Dark/
  Midnight/High contrast/Light/Paper), accent colors, and the pulse /
  update-check toggles; `components/TopBarIcons.tsx` was removed.

**Baselines:** dropping the header row makes the canvas ~39px taller, so
every canvas screenshot changes. The Windows baselines were regenerated
locally (untracked per the §4 convention) and the committed Linux baselines
need one `npx playwright test --update-snapshots` re-bless before CI's
visual suite goes green.

**Acceptance:** smoke / settings / visual / update specs updated for the
menu paths; new light/dark toggle test; lint / unit / build / 32-of-32 e2e
green.

## 10. Follow-up batch A (2026-10-16): placement, rotation, interaction

- **Rotation alignment:** for N/S rotations the body rect swaps axes (h×w),
  but the gate silhouette was still anchored at the _unrotated_ origin, so it
  rotated about the wrong point and drew offset from its pins (and from the
  selection box / floating rotate button). The EAST-frame shape is now built
  centered on the body rect.
- **Placement:** components center on the cursor (matching palette
  drag-drop), and the ghost carries the resolved body position, so the
  preview is exactly where the click drops it.
- **Placement preview:** the ghost draws the real part (gate silhouette,
  mux/demux trapezoid, module box, pins) instead of a bounding rectangle.
- **Wire gesture:** finishing a wire clears any wire selection and leaves no
  drag state, so the next click starts a fresh gesture instead of re-routing
  the wire just produced.
- **Top/sim bar:** the Settings icon is gone from the title bar (File ▸
  Settings… only), the file path sits on the right, the speed slider caps at
  1 kHz (menu presets too), and the "cycle" step button/menu item is gone
  (two `tick` clicks = one cycle; Ctrl+J/K/R unchanged).

## 11. Follow-up batch B (2026-10-16): sheets, memory loading, retired Watch tab

- **Circuit sheets:** each tab carries an "×" delete (`removeCircuit` in the
  document; refused for the last circuit or one still instantiated by a
  `subcircuit` component, undoable, confirm when non-empty), and the strip
  left-insets to the palette width so tabs line up with the canvas grid.
- **Memory loading in the Inspector** (`mem.ram`/`mem.rom`) replaces the raw
  `autoload` text field with two methods:
  1. **Paste hex** — a dialog (`MemContentsDialog`) with a paginated hex
     table over the whole memory; applying writes canonical `rle-hex`
     (`lib/rleHex.ts`, bounded expansion) to `attrs.contents`.
  2. **Autoload file** — a real file picker (`files.pickHexFile`): the Tauri
     shell stores a path relative to the circuit file (engine sandbox);
     browser/mock mode embeds the image as `contents` instead, since
     browsers expose no paths.
- **Watch tab retired for now** (per the human): the right dock is
  Inspector-only (component or, now, wire). `WatchPanel`/`MemoryInspector`
  stay in the tree unrendered; their e2e coverage moved to the new
  Inspector memory tests.

## 12. Follow-up batch C (2026-10-16): wire styling

- Selecting a wire opens the Inspector's **wire section**: a color swatch
  row (plus "Default" to clear) and a **width** control. Width is a property
  of the driving pin (format-v2 §5.2), so the control edits the source
  component's `bitsize` (the Inspector shows which component/pin), and the
  renderer now scales wire thickness with the bit count.
- **Format:** wires gain an optional cosmetic `color` (`"#rrggbb"`) —
  `docs/format-v2.md` §2/§6/§10, the Rust `Wire.color` field (ignored by the
  engine, omitted when unset so uncolored files stay byte-identical), and
  the frontend type/renderer/Inspector.

**Acceptance:** `cargo fmt`/`clippy -D warnings`/`test` green (177 core + 8
golden + 12 cli); frontend lint / 252 unit / build / 33-of-33 e2e green
(new `wires.spec.ts` + rewritten `memory.spec.ts`; screenshot baselines
unchanged).

## 13. Follow-up batch D (2026-10-16): rail labels + drag-wiring

- **Activity rail:** every rail button now shows its group name under the icon
  (`palette-rail-label`; the rail widens 56 → 68 px). The palette _panel_ width
  is unchanged, so canvas geometry and the sheet-tab inset are unaffected.
- **Wire gesture** — the report was "drag a wire from one component to another,
  then I click the wire and it re-routes it, and even clicking something else
  re-routes it, making the entire thing unusable". Routing was click-only: a
  press → sweep → release produced **nothing** and left the machine in wiring
  mode, so every later click planted another waypoint on the phantom wire.
  The machine now tracks the press (`pressStart`/`pressSwept`) and a **swept
  release finishes the wire** on whatever is under the pointer:
  1. a pin or wire within `RELEASE_PIN_TOL` (1 grid unit), else
  2. the nearest pin of the part you dropped on (`DocScene.nearestPinOf`) —
     big parts are mostly body, and missing the terminal by a hair used to
     strand the gesture, else
  3. nothing to attach to (empty space) → routing continues, exactly as a
     click there would.
     Click-click wiring is untouched: a press without movement still plants a
     waypoint, and the next click finishes.
- Regression tests: `tools.test.ts` (drag-release commits; empty-space release
  keeps routing; drop-on-body snaps to the nearest pin) and `wires.spec.ts`
  (drag-wiring commits, then clicking the wire _selects_ it, and clicking a
  component selects that component with the route unchanged).

## 14. Follow-up batch E (2026-10-16): memory grid editor

- The RAM/ROM contents dialog is a **hex grid**, not a paste box: 16 × 16 cells
  per page (address gutter + page nav over the whole depth). Click a cell and
  paste — values fill from that address onward (same `rle-hex-v1` parser, so
  `4-00` runs work) — or type into a cell (hex only, clamped to the word width,
  empty clears). Arrow keys walk the grid; the focused cell is the selection.
  Applying writes the canonical image to `attrs.contents`.
- The dialog opts out of the generic help card's 480 px `max-width`
  (`help-card.mem-dialog`) so a full 16-column row fits.
- `mock.ts` honors the embedded `attrs.contents` image (what the Inspector
  writes) before the dev-only `hex:` autoload convention, matching the engine
  (`behavior.rs::init_words`).

**Acceptance:** frontend lint / 254 unit / build / 34-of-34 e2e green (new
drag-wiring `wires.spec.ts` test, grid-based `memory.spec.ts`, a mock
`contents` test); screenshot baselines unchanged.

## 15. Follow-up batch F (2026-10-16): transport bar, grid, wire widths

- **Simulation menu retired** (human decision; it was read as "the simulation
  tab"): its Hz speed presets were redundant with the slider, so the whole menu
  is gone. Nothing is lost: step tick / reset / run-to live in the transport
  bar, the `T_obs` chip toggles the critical-path highlight, and the **status
  chip now switches delay ↔ zero mode** (`ctl.setMode`), which was the only
  control the menu owned. Keyboard shortcuts are unchanged.
- **Speed slider**: already exponential (`hz = 10^(exp/10)`, exp 0…30 = 1 Hz…
  1 kHz); it now shows **notches** at the round values (1, 2, 5, 10, 20, 50,
  100, 200, 500, 1000 Hz; decades taller) so the log scale is legible.
- **Canvas grid** (Settings ▸ Canvas ▸ "Show grid", off by default, persisted
  as `csx.grid`): lines are drawn in **groups** — `gridStepFor(scale)` doubles
  the step (1, 2, 4, 8… cells) until neighbours are ≥ 14 px apart — so the grid
  stays evenly spaced and readable at every zoom instead of collapsing into a
  wash. Drawn behind everything at 1 CSS px; `theme.grid` is the line color.
- **Wire color while selected**: selection is now an accent **halo** under the
  core stroke instead of repainting the wire, so a color you just picked shows
  immediately (previously the accent hid it until you deselected).
- **Wire width now follows the bit width**: `DocScene` uses the **widest
  declared pin width on the net** (`inferNetBits`) rather than collapsing a
  conflicting net to 1 bit, and thickness grows with √bits (32-bit ≈ 3.5× a
  1-bit wire). A width edit is therefore visible at once — and a net whose ends
  disagree now _draws_ as the bus it declares, which surfaces real
  width-mismatch mistakes (the engine reports them at load).
- **Panels/layout**: the circuit tabs moved above the **canvas column** only,
  so the palette and dock run the full height — the dead strip above the
  palette (the reported "gap") is gone and the tab `inset` prop is retired. The
  right dock gained padding, the rail got spacing between its icons, and tab
  labels are centered in their tabs.

**Acceptance:** frontend lint / 256 unit / build / 35-of-35 e2e green (rewritten
`fileops` sim-bar test, new `grid.test.ts` + settings grid test). **Screenshot
baselines changed on purpose** (declared-width drawing) and were regenerated
locally (win32); the committed Linux baselines need one `--update-snapshots`
run on Linux.

## 16. Follow-up batch G (2026-10-16): menus, tabs, and the hex grid

- **Subcircuits menu retired**: the tab strip owns sheets now — the "+" tab
  creates one (new subcircuits are also in the palette's Subcircuits group) and
  **double-clicking anywhere on a tab** (label, padding, or the gap around it,
  not just the text) opens the rename dialog. The ✕ swallows double-clicks so
  it can't accidentally trigger a rename.
- **Edit menu trimmed**: Rotate and Delete are gone from it (the R and Del
  shortcuts still work, as does the floating rotate button and each component's
  Rotation field in the Inspector).
- **Create/rename dialog restyled**: `NameDialog` is now a compact
  settings-style card — same head + ✕ close, hint-free single field, and
  Cancel/accent-submit buttons as the Settings dialog, instead of the old
  bare `help-card`.
- **Tabs align with the canvas**: the strip has no left padding, so the first
  tab's edge lines up with the grid edge (it already sat above the canvas
  column only, per §15).
- **Hex grid editing**: the memory dialog's table no longer stretches while its
  inputs stay narrow — inputs fill their cell (`width: 100%`, `minWidth` of one
  word) so the _whole_ cell is clickable/editable, not just the left part.
- **`DEC` → `DECODER`**: the plexers palette tile (label and icon glyph) now
  reads DECODER. Canvas bodies are unaffected — shaped bodies draw no caption
  unless the part is named.

**Acceptance:** frontend lint / 256 unit / build / 35-of-35 e2e green (the
subcircuit e2e now drives creation through the "+" tab and rename through a
double-click on the tab box; the palette rail test asserts DECODER).

## 17. Follow-up batch H (2026-10-16): labels, alignment, mismatch, wire color

- **One labeling rule** (the "consistent method" ask). A component body ALWAYS
  shows its **type mark**:
  1. the **symbol** where the family has one — the arithmetic family is now
     `+ − × ÷ = ~ «` (matching the palette icons) instead of `ADD/SUB/MUL/…`;
  2. the **shape itself** for shaped parts (gates, plexers);
  3. otherwise a **short abbreviation** (`REG`, `RAM`, `ROM`, `MUX`, `DEMUX`,
     `DECODER`, `PIN`, `CLK`, `BTN`, `LED`, `EXT`, …).
     A user-assigned **name is drawn above the part** and never replaces the
     mark (previously a named box swapped its mark for the name); value parts
     (constant / probe / register) still show the live value in place of the
     mark with the name above. So `imem` now reads "RAM" with "imem" above it.
- **Inspector alignment**: `.inspector-row` is a two-column grid (flexible
  label track + fixed control track, controls `width: 100%`), so every
  input/select/button group lines up down the panel instead of drifting with
  its label.
- **Bitsize mismatch, clearly visible**: a net whose pins disagree (format-v2
  width rules) gets a halo under the wire core once per net — color-independent,
  so it reads over bus hues and custom wire colors (the old "turn it yellow"
  recolor was lost once wires got colors). (Superseded by §42: the halo is no
  longer amber — it blinks in the wire's own color.) Selecting such a wire also
  shows the exact widths in the Inspector
  ("this net mixes 1 / 32-bit pins — the engine reports it at load").
- **Default wire color**: wires with **no signal yet** (nothing simulated, or a
  wire added after the current sim load) were drawn in the near-black
  `--wire-disconnected`, so a freshly drawn wire looked dead. That variable is
  now each theme's visible **default wire** color (a slate in dark/OLED/
  midnight/contrast, mid-grey in the light/paper themes), so drawing a wire
  looks like a wire until a simulation replaces it with per-state colors.
  (Superseded by §34: idle wires now show a dull tint of their own color, and
  `--wire-disconnected` is only the junction-dot neutral.)

**Acceptance:** frontend lint / 256 unit / build / 35-of-35 e2e green. The three
sim demo baselines were regenerated (the mismatch halos and the new body
marks/value layout are intentional); the committed Linux baselines still need
one `--update-snapshots` run on Linux.

## 18. Follow-up batch I (2026-10-16): marks, complete properties, bit picker

- **Arithmetic marks**: the body mark is drawn larger (`CompSpec.markSize`,
  1.7 for the symbol family) so `+ − × ÷ = ~ «` read clearly, while the
  **palette tiles keep the human name** (`CompSpec.label`: ADD, SUB, MUL, DIV,
  CMP, NEG, SHIFT, EXT) with the symbol still inside the icon.
- **Bit width is a picker, not a text box**: `BitsizePicker` shows all 32 legal
  widths in an 8×4 grid (one click, and it can't hold an invalid value); used
  for every width field (`bitsize`, `inBits`, `outBits`) and for the wire
  width control. Fields show the format's effective default when the attr is
  absent (1, or 4 for a hex display, 8/16 for the extender).
- **Every component now exposes every attr format-v2 §4 defines**, under
  Width / Options / Timing section headings, with hints. Names were corrected
  to the engine's (`crates/core/src/components.rs`), which also fixes attrs the
  frontend was writing that the engine would reject:
  | was                                                                       | now                                                                    |
  | ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
  | mux/demux `selBits`                                                       | `selectBits` (1..8)                                                    |
  | decoder `selBits`                                                         | `inputBits` (default 2)                                                |
  | probe `display`                                                           | `radix`                                                                |
  | extender `bitsize`                                                        | `inBits` (8) + `outBits` (16) + `mode` (zero/sign)                     |
  | splitter: none                                                            | `splits` (required) — default mapping seeded on placement,             |
  | edited as `pin: bit,bit` lines; the bus width now follows the mapping     |
  | constant `value` (number)                                                 | hex string (default `"0"`)                                             |
  | —                                                                         | gates gained `negateInputs` + `inputs` up to 64; every type gained the |
  | optional per-instance `delay` override                                    |
  | The `io.hexdisplay` default width is 4. Unit tests assert the field sets, |
  | the groups, and the seeded splitter mapping.                              |
- **Known gap (next)**: _pin names_ still diverge from the engine on several
  types — adder `c_in`/`c_out` vs `cin`/`cout`, subtractor missing
  `bin`/`bout`, divider `out` vs `quot`/`rem`, register missing `rst`,
  RAM `d`/`q` vs `din`/`dout`, ROM `clk`/`q` vs `out`, decoder `sel` vs `in`.
  Those are geometry/format changes (they touch wires, demos and tests), so
  they are deliberately left for their own pass.

**Acceptance:** frontend lint / 262 unit / build / 35-of-35 e2e green.

## 19. Follow-up batch J (2026-10-16): pulse, slider, sim bar, HUD, flat panel

- **Width mismatches pulse.** The mismatch halo now animates (opacity and
  ring weight oscillate) so it is impossible to miss even among colored wires
  (superseded by §42: the blink is now the wire's own color, not amber);
  the canvas keeps repainting while any net disagrees, gated by the same
  _Animate signal pulses_ preference. `StrokeStyle` gained an `alpha` channel
  (batched, like the other style keys), `SceneOverlay` gained `now`, and
  `DocScene.hasMismatch()` tells the host when to animate. Visual-regression
  specs set `csx.pulses=0` so their baselines stay deterministic (the halo is
  then drawn at a fixed phase).
- **Slider notches fixed.** They were positioned as a percentage of the input
  while the thumb travels a shorter span, so they lined up with nothing (and
  sat in a separate strip). The slider is now fully custom — a 4 px track and a
  fixed 12 px thumb — and the notch strip is inset by the thumb radius, so a
  notch at fraction `f` lands exactly where the thumb's centre does. Ten
  notches at the round values (1, 2, 5, 10, … 1000 Hz), decades taller.
- **Sim bar regrouped.** Transport (play/pause · tick · reset), run-to
  (cycle N · run to) and speed (label · slider · Hz) are three bordered pills,
  and the telemetry (`cycle N · mode chip · eff Hz`, then `T_obs`) is pushed to
  the right edge, instead of seven loose controls in a row.
- **HUD aligned.** The fps/status chip was floating 8 px inside the canvas; it
  is now flush with the canvas's top-left corner, so it lines up with the
  circuit tab above it.
- **Inspector is flat again.** The Width / Options / Timing headings are gone
  (the fields keep their order and hints); grouping is still tagged in the
  catalog for future use.

**Acceptance:** frontend lint / 262 unit / build / 35-of-35 e2e green (the
fileops sim-bar test asserts the notch marks; the canvas screenshot specs
freeze animations).

## 20. Follow-up batch K (2026-10-16): hover menus, save-cancel, arrows

- **Menus open on hover.** Moving the pointer onto File/Edit/Help opens that
  menu, moving across the bar switches menus, and leaving the bar (or its
  popup, which is a child) closes it. A click now only ever OPENS: hover has
  already opened it, so a click-to-toggle would close a menu the pointer is
  resting on.
- **Cancel is not a save.** Three layers: the browser Save uses the File System
  Access picker (`showSaveFilePicker`) where available — a real Save-As dialog
  that _reports cancel_ — with the download shim as fallback (and under
  automation, where a native picker could not be driven); the Tauri picker
  treats `null`/`undefined`/blank as cancel (previously a blank answer became
  `.csx` and looked like a successful save); and `doSave` refuses a blank path.
  Cancel now writes nothing, marks nothing clean and toasts nothing.
- **Width mismatch: the pulse is the whole signal.** The "⚠ width" text badge
  is gone; the pulsing ring is it (superseded by §42: it blinks in the wire's own
  color). The Inspector still spells out the mixed widths when such a wire is
  selected.
- **Arrow-key rotation.** ← / → rotate the selection and the placement ghost
  counter-clockwise / clockwise (R stays clockwise; the reverse cycle is a new
  `prevRotation`, and a CCW rotate is still one undoable op). The canvas key
  handler also ignores events from buttons, inputs and the panel resize
  handles, so rail/resize keyboard use isn't hijacked.

**Acceptance:** frontend lint / 263 unit / build / 35-of-35 e2e green.

## 21. Follow-up batch L (2026-10-16): live values, pin shapes, family colour

- **Live values on the body.** Clocks, pin parts, probes, registers, RAM/ROM,
  LEDs and hex displays now show the value on their read pin (`VALUE_PIN`) in
  place of their type mark, plus the part's name above — the same live-readout
  treatment probes/registers already had. A single-bit readout reads `0`/`1`
  (no `0x` prefix); wider ones honour the part's `radix`. The value repeats next
  to the source pin only for the big readouts (probe/register/memory): a pin
  part's body _is_ that pin, and small I/O parts would just get noisy.
- **Text fits the body.** Both the mark and the value are auto-sized to the
  body (`fitTextSize`), so a 32-bit readout on a 2×1 pin stays inside it, and
  values are drawn in the brighter text colour to stand apart from type marks.
- **Pin shapes.** Every input pin marker is a **square**, every output pin
  marker is a **circle** (inout stays square, junction/corner dots unchanged) —
  so a part's direction is readable from any component. The `wiring.pin`
  _component_ follows the same rule: an input pin is a square body, an output
  pin a rounded (stadium) body.
- **Family colour.** Components that belong to a family get a subtle tint —
  a 10 % body fill and a 50 % outline — from the theme's existing palette:
  input pins cyan, output pins amber, memory purple, arithmetic lime, plexers
  pink, I/O the accent colour. Gates keep the classic look and wiring parts
  stay neutral. Pin markers are the same colours, muted, so they read as
  colour-coded without shouting.

**Acceptance:** frontend lint / 263 unit / build / 35-of-35 e2e green (baselines
regenerated locally; Linux still wants one `--update-snapshots` run).

## 22. Follow-up batch M (2026-10-16): arrows set the facing

- **Arrows are absolute, not a step.** The arrow whose direction matches the
  way a part should point is the one that does it: **→ faces East, ← West,
  ↑ North, ↓ South**, for the selection and the placement ghost alike. Pressing
  → on a part already facing east does nothing; pressing ← makes it face west
  whatever it faced before. `R` still steps the E→S→W→N cycle (one undoable op
  per change, and the wired-pin repair still runs, since `applyRotation` is now
  shared by the cycle and the absolute setter).
- The canvas key handler ignores real text fields (and open dialogs); widgets
  that own arrow keys (palette rail, resize handles) stop the event instead
  (§23).

**Acceptance:** frontend lint / 263 unit / build / 35-of-35 e2e green.

## 23. Follow-up batch N (2026-10-16): values from the start, arrow focus

- **Values are live from the start.** Adopting a document (mount, File → New,
  File → Open) now loads it into the engine, so clocks, pins, probes,
  registers, RAM/ROM and I/O show their value immediately instead of their type
  mark — opening a circuit (or the `?simdemo=1` demo) no longer needs a
  transport command first. `store.onLoaded` already preserved the load-time
  full-state batch; the missing piece was triggering a load on identity change,
  and that effect must depend on the document identity only — depending on the
  store version re-entered while `loaded` was still false and looped. Edits
  afterwards keep the last known values until the next command (U6).
- **A placed component is selected.** Placing now leaves the new part selected,
  so the natural follow-up — arrows/R to orient it, Del to remove it, the
  Inspector to edit it — acts on it immediately instead of on nothing.
- **Arrow focus trap fixed.** After picking a palette item the button keeps
  focus, and the canvas key handler used to bail on any BUTTON target, so
  R/arrows appeared dead. It now ignores only real text fields (and open
  dialogs), and the widgets that own arrow keys stop propagation. So: place a
  part with the palette, press ↑, and it faces up — no clicking back into the
  canvas first.

**Acceptance:** frontend lint / 263 unit / build / 35-of-35 e2e green (canvas
baselines regenerated: they now include live readouts).

## 24. Follow-up batch O (2026-10-16): negateInputs out, 32 inputs, pins bottom

- **`negateInputs` is gone** (human decision) — from the engine
  (`CompKind::Gate` lost its `negate_inputs`, the string-list attr helper went
  with it, and the De Morgan test became a truth-table test for the NAND/NOR/
  XNOR _types_), from the frontend (the Inspector field, the `list` field kind
  and the bubble pass), and from the docs so they match the code:
  `docs/format-v2.md` §4 (the gate row) + §4's deviations note, and the
  DESIGN.md §5.2 sample document. A file carrying `negateInputs` now fails
  validation as an unknown attr (asserted in `components.rs`).
- **Gate inputs cap at 32** (`MAX_GATE_INPUTS`, the Inspector's max) and
  `docs/format-v2.md` says 2..=32 accordingly.
- **Clock/reset inputs moved to the bottom edge** of the memory parts, data-sheet
  style: `mem.register` gained the `rst` pin the format defines (d/en left,
  clk/rst bottom, q right), `mem.ram` puts `we`/`clk` on the bottom and uses the
  format's `din`/`dout` names, and `mem.rom` is `addr`/`out` only. `VALUE_PIN`
  follows the renamed read pins (ram → dout, rom → out).

**Acceptance:** `cargo fmt`/`clippy -D warnings`/`test` green (12 cli + 167 core

- 8 golden); frontend lint / 263 unit / build / 36-of-36 e2e green.

## 25. Follow-up batch P (2026-10-16): modern settings panel

- **Sectioned panel**: the Settings dialog is now a two-pane settings panel —
  a nav column (Appearance / Canvas / Editing / Simulation / Startup) and the
  section's controls beside it, in rows (label + hint left, control right) that
  mirror the Inspector. Same live-apply, no-Apply-button model, same footer.
- **More themes** (11): OLED, Dark, Midnight, **Nord**, **Dracula**,
  **Gruvbox**, **Solarized**, High contrast, Light, Paper, **Solarized Light** —
  each one CSS block plus a catalog entry (themes stay data).
- **More accents** (14): theme default plus blue, indigo, violet, fuchsia, rose,
  red, orange, amber, lime, green, teal, cyan, slate.
- **More settings**: _Canvas_ — show grid, **show live values**, animate signal
  pulses, **show the performance overlay**; _Editing_ — **default bit width**
  and **default gate inputs**, seeded onto newly placed parts; _Simulation_ —
  **default clock speed** (where the transport slider starts). All persist per
  machine (`csx.*`), all are reset by "Reset to defaults", and the e2e covers
  the nav, a new theme/accent and the placement seeds.

**Acceptance:** frontend lint / 263 unit / build / 36-of-36 e2e green.

## 26. Follow-up batch Q (2026-10-16): settings shell, no delay field

- **Settings panel padding + fixed size.** The panel now owns the padding
  (`1rem 1.25rem 1.05rem`) and the head/nav/pane use it instead of growing their
  own insets, so everything lines up on one left edge; the pane and the nav
  reserve their scrollbar gutter (`scrollbar-gutter: stable`) so the content
  width does not shift between sections. The panel's **height is fixed**
  (`min(88vh, 44rem)`), so switching from Appearance to Startup no longer
  resizes the dialog — asserted in the e2e by comparing the panel's box across
  two sections.
- **No delay field.** The Inspector no longer offers the per-instance `delay`
  override for any part (§25 had just added it). Timing is presented as
  unit-wide, matching the course model. (The attr no longer exists in the format
  at all — v3 dropped per-instance delays and the engine rejects one as an
  unknown attr (`format-v2` §4/§6); the panel simply doesn't offer it.)

**Acceptance:** frontend lint / 263 unit / build / 37-of-37 e2e green.

## 27. Follow-up batch R (2026-10-16): autosave + version history

Phases 0-3 of the autosave plan: a scheduler in the frontend, two small
filesystem stores in the Tauri shell.

- **Atomic saves.** `format::write_atomic` (sibling temp file -> fsync ->
  rename) and `format::save_json_atomic` are now the one save path, shared by
  `save_circuit` and the shell, so an interrupted autosave can never truncate a
  `.csx`.
- **Autosave (phase 1).** `model/autosave.ts` debounces **3 s of idle** after the
  last edit, caps a continuously-dirty document at 30 s, and force-flushes on
  window blur, window close and explicit Save. While dirty, the document is
  copied to the crash-recovery store (`crates/app/src/recovery.rs`: one rolling
  envelope per document under the app data dir, keyed by a hash of its path — or
  a per-session id before the first save). On launch an orphaned copy offers
  **Recover unsaved work** (Restore comes back dirty; Discard throws it away).
  Named files with "also save the file" on are also rewritten atomically;
  unnamed documents and the browser stay recovery-only.
- **Version history (phases 2-3).** Every successful save records a version
  (`crates/app/src/history.rs`: content-addressed canonical snapshots plus a
  small per-document index, same document key as recovery). Automatic versions
  coalesce inside 60 s, so one editing burst is one entry. **File ▸ Version
  history…**, the top-bar clock button, or **Ctrl+Alt+H** lists them
  newest-first, previews the selected one and
  offers Restore (becomes the new head — history is never rewritten), Save a
  copy…, Name… (exempt from retention) and Delete. Retention: named versions are
  kept forever; automatic ones are capped at 50 per document and 25 MB.
- **External-change guard (phase 4).** Autosave compares the file's mtime+size
  with what it last wrote; if something changed underneath us it refuses to
  overwrite, says so, and points at **File ▸ Reload from disk**. An explicit Save
  still wins — that is the user's intent.
- **Settings ▸ Autosave** carries the two toggles plus the version-history
  footprint and "Clear this file's history".
- **Scope.** History lives in the app data directory keyed by file path, so it
  does not follow a moved or renamed file; the browser/dev build mirrors both
  stores in `sessionStorage` (so the flows are e2e-testable) but that is not a
  substitute for the Tauri stores.

**Acceptance:** frontend lint / 291 unit / build / 43-of-43 e2e green; Rust 168
core + 12 CLI + 8 golden + 14 app tests, clippy/fmt clean.

## 28. Follow-up batch S (2026-10-16): roomier inspector, picker inputs, label side, app dropdowns

Four requests on top of §25/§26, all in the Inspector and Settings panels.

- **Roomier Inspector.** Rows breathe: `.inspector-row` margin 7 -> 11px,
  `.inspector-field` 7 -> 12px, the picker grid gap 3 -> 4px and its cells a
  touch taller. Nothing else changed shape, so the panel still does not resize
  when you switch selection.
- **Gate input count is a picker grid.** The old "Inputs" _number box_ is gone.
  `NumberPicker` (`components/NumberPicker.tsx`) generalises the bit-width grid:
  it takes an inclusive `min`/`max` and renders one cell per legal value, so
  **bit size is 1..32** and **gate inputs are 2..32** — one click, and a value
  can never be typed out of range. The catalog field kind `"bitsize"` became
  `"picker"` (with optional `min`/`max`); `BitsizePicker.tsx` was deleted. The
  cells carry `data-value` (the e2e targets moved from `data-bitsize`).
- **Where a part's name is drawn.** A per-component field, `namePos`, alongside
  `rot`/`name`: one of `N`/`E`/`S`/`W` (same compass letters as `rot`), **omitted
  when unset** (`Option` + `skip_serializing_if`, exactly like a wire's `color`),
  so files written before it stay byte-identical and old `.csx` files stay valid.
  The engine ignores it beyond round-tripping it. The Inspector's **Label side**
  select sets it (Above / Below / Left / Right), **Above (`N`) is the default**
  and is stored as "absent", so a default part writes nothing — there is no
  global setting and no "Default" entry (superseded by §31). `docScene`'s
  `labelAnchor()` reads `comp.namePos ?? "N"` and maps the side to an anchor +
  text alignment for both box and shaped bodies. The per-pin value readout beside
  a pin is unaffected.
- **App dropdowns instead of native `<select>`.** A new `Select` component
  (`components/Select.tsx`) renders a button (`aria-haspopup="listbox"`,
  `aria-label`) plus an option list styled like the menu-bar popups, and is now
  used for every select in the **Inspector** (Rotation and the
  `select`-kind attrs: radix / shift / extend mode / subcircuit) and in the
  **Settings** panel (default bit width / gate inputs / clock speed). The list renders **inline** (not absolutely positioned): the dock
  and the settings pane both scroll. (Superseded by §29: the list is now a
  portaled overlay rather than inline.) Escape and outside-click close it.
- **Prettier `endOfLine: "auto"`** in `frontend/.prettierrc.json`. The Windows
  checkout is CRLF (`core.autocrlf=true`, no `.gitattributes`) while Prettier
  defaults to LF, so every CRLF file failed `prettier --check`. `auto` accepts
  both, keeping the gate meaningful on this machine without rewriting the tree.

**Acceptance:** frontend lint / 292 unit / build green; 44-of-44 e2e green; Rust
170 core + 12 CLI + 8 golden tests, clippy/fmt clean. The two settings selects
now click instead of `selectOption`, and `editor.spec` drives the Inspector's
Label side select (writes/clears `namePos`) in place.

## 29. Follow-up batch T (2026-10-16): overlay dropdowns, quieter pins, tidier memory

Three polish fixes.

- **Dropdowns overlay instead of reflowing.** `Select` now renders its option
  list through `createPortal(…, document.body)` with `position: fixed` and a
  computed anchor (left/min-width/max-width from the button, top-or-bottom +
  max-height from the free space), so the list **floats over** the panel instead
  of pushing the rows down, and is never clipped by the scrolling parent. It
  flips above the button when the space below is tight, repositions on scroll /
  resize, and sits at `z-index: 200` so it is clickable over the settings modal
  (`z-index: 100`). Theme variables live on `:root`, so a body-level portal still
  inherits them. `editor.spec` guards the behaviour: the panel's `scrollHeight`
  is unchanged while the list is open.
- **Concise pin hover.** The pin tooltip is now a single line — the pin name,
  with its width appended only when it is wider than one bit (`din · 8b`) —
  instead of the old two-line `name` + `kind · N b` card, and `drawCard`'s
  padding/line-height/type size are all smaller.
- **Tidier RAM/ROM panel.** The memory-image controls sit under a small
  uppercase **Memory image** subhead; the file picker and hex-editor buttons are
  full-width action rows (`inspector-buttons-full`) rather than a lopsided
  label/control pair, the depth field is labelled **Depth** with its hint
  ("Words — a power of two, up to 2^20.") moved into the hint line, and the footer
  hint is one short sentence.
- **Test-race fix.** `memory.spec`'s `selectImem` clicks by world coordinates,
  but the `?simdemo=1` view auto-fits its camera after mount; reading the camera
  before it settled clicked the wrong point (this failed on the prior commit
  too). A `ready()` helper now waits for the camera to stop changing before
  computing screen coordinates → 6-of-6 stable.

**Acceptance:** frontend lint / 292 unit / build green; 44-of-44 e2e green.

## 30. Follow-up batch U (2026-10-16): Docs-style header

The top bar became a two-row header modelled on Google Docs/Sheets. Chrome
height is unchanged: the sim transport moved _into_ the header's second row
instead of owning a row of its own.

- **Row 1** — `[app mark] <file name> (save chip) …… undo redo | history | theme`.
  The title is the **file name** (`(unsaved)` before the first save) with the
  full path on hover; the app name lives on the logo tooltip (plus the sr-only
  `h1`). Google's ★ (favorite), ↗ (move) and 💬 (comments) have no meaning in a
  desktop EDA tool, so they were dropped — the ☁ slot became the autosave chip
  (`SaveIndicator`, moved up out of the status bar).
- **Row 2** — menu tabs on the left, transport on the right:
  `File Edit View Tools Help` … `play tick reset run-to speed T_obs`.
- **New menus** — `View` (grid, live values, pulses, performance overlay,
  highlight critical path — previously Settings-only) and `Tools` (recover
  unsaved work, clear this file's history, settings, reset appearance — the
  Tools menu was dropped again in §32).
  `Simulate` was deliberately **not** re-added: §15 retired it because the
  transport owns run/step/reset/speed, and the transport is still on screen.
  `Edit` is unchanged; `File` keeps Version history….
- **Layout guarantee** — the menu row never shrinks (`flex: 0 0 auto`); the
  transport gives way instead: its telemetry ellipsizes, the status text drops
  below 1150 px and the run-to group below 1000 px. Letting the _menus_ shrink
  instead made the Help button spill over `.sim-play` and swallow clicks (caught
  by `sim.spec`'s play/pause loop). The sim banner is now an overlay dropping
  out from under the header (`.sim-banner`, absolute) so a halt never becomes a
  third row of chrome.
- **Sizing** — icon buttons are 34×30 with 19 px glyphs; the speed slider and
  the run-to input were tightened so the row fits a 1280 px window with both the
  telemetry and the T_obs chip on screen.

**Acceptance:** 292 unit / 45 e2e green; Rust 170 core + 12 CLI + 8 golden + 14
app. The header is taller than the old strip and §28 moved component labels, so
both the canvas region and the label anchors changed: the five screenshot
baselines were re-blessed locally (`sim-lit`, `timing-path`, `timing-violation`,
`demo-dark`, `demo-light`). Their Linux copies need the same one-shot
`--update-snapshots` run on CI.

## 31. Follow-up batch V (2026-10-16): label-side default, accent highlights, comparator symbols

- **Label side: no "Default", Above is the default.** The Inspector's **Label
  side** select dropped its "Default" entry and now offers only Above / Below /
  Left / Right, with **Above (`N`) selected when unset**. Choosing Above stores
  nothing (the field is removed again), so a default part writes no `namePos`.
  The global **Default name position** setting from §28 is gone — with Above as
  the built-in default it had nothing left to do — along with the `csx.labelPos`
  pref and the `labelPos` parameter threading through `EditorCanvas`/`draw`.
- **Highlights follow the accent, not the browser blue.** The base
  `button, input, select` rule sets `accent-color: var(--accent)`, so the
  Settings toggles, any radio/range control and the like highlight in the chosen
  accent; a global `::selection` paints text selection in the accent; and the
  dropdown's hovered/active option uses an accent-tinted background
  (`color-mix`) instead of plain grey. The option list is portaled **inside
  `.app`** (which carries `data-accent`), not `document.body` — a body-level
  portal sits outside the accent override and silently falls back to the theme's
  default accent. `editor.spec` guards this (`.app .select-pop`).
- **Comparator shows its three relations.** `arith.comparator` no longer draws
  one centered `=`. Each output pin gets its own symbol just inside the right
  edge, **vertically centred on the pin's row** (`drawText` uses
  `textBaseline: middle`, so the symbol is drawn at `p.y`) — `<` by `lt`, `=` by
  `eq`, `>` by `gt` — so the part reads as a comparator at a glance. The
  catalog's family mark stays `=` (it still drives the palette tile and the
  `catalog.test` marks list).

**Acceptance:** frontend lint / 292 unit / build green; 45-of-45 e2e green.

## 32. Follow-up batch W (2026-10-16): the Inspector no longer swaps a part's type

- **No more gate Type dropdown.** The Inspector's `Type` select (AND ↔ OR ↔ NAND
  ↔ …) is gone. To use a different part, place it from the **palette drawer** on
  the left — the palette is the single place a component's type is chosen. This
  drops the last "edit the type in place" control; `GATE_TYPE_OPTIONS` and the
  panel's `commitType` were removed with it.
- The document op is unchanged: `updateComponent({ type })` still exists (the
  engine and `document.test` exercise it), the panel just no longer offers it.

**Acceptance:** frontend lint / 292 unit / build green; 45-of-45 e2e green.

## 33. Follow-up batch X (2026-10-16): friendly comparator pin preview

- **Hover preview reads as words.** The pin hover card (the preview that follows
  the cursor over a pin) showed the raw registry name, so the comparator's
  outputs read `lt` / `eq` / `gt`. `pinDisplayName()` maps those three to
  **less than** / **equal to** / **greater than**; every other pin keeps its
  name. This matches the `<` / `=` / `>` symbols now drawn on the body (§31) —
  the glyph on the part, the words on hover.

**Acceptance:** frontend lint / 292 unit / build green; 45-of-45 e2e green.

## 34. Follow-up batch Y (2026-10-16): version drawer, quieter transport

Three requests: make version history a Google-Docs-style drawer, drop the Tools
menu, and tidy the simulation bar.

- **Version history is a drawer, not a dialog** (`HistoryDrawer.tsx`). It sits
  over the right dock: newest first, each row showing the relative time, the
  label, and the absolute time + size, with a badge on named versions. Selecting
  a row previews that version's circuit on the canvas behind it.
- **The preview is its own renderer** (`HistoryPreview.tsx`): the version's
  canonical `.csx` is parsed into a throwaway document and drawn on a private
  `DocScene`/`CanvasHost`. The live document, selection, undo stack, sim session
  and autosave are never touched, so previewing cannot disturb the open circuit
  (and closing the drawer is instant). A Docs-style banner sits above it —
  "Viewing an older version — 5 min ago · Added the ALU" with **Restore this
  version** / **Back to current**. Restore is the only action that changes the
  document, and the restored state comes back dirty so autosave/Save protect it.
  Save a copy…, Name… and Delete live in the drawer footer.
- **The Tools menu is gone.** All four items already lived where they belong:
  recover unsaved work (the recovery dialog), clear this file's history and reset
  appearance (Settings), settings (File ▸ Settings…). Menus are now File / Edit /
  View / Help.
- **Transport restyle** (`SimBar` + `.simbar` CSS). The nested pill borders are
  gone: one filled play button, flat text buttons that highlight on hover,
  hairline dividers between the clusters, a single 26px control height, a thinner
  slider with fainter preset ticks, and tabular-figure telemetry. The "speed"
  word is gone (the slider plus the Hz readout already say it), and the T_obs
  chip is a quiet outlined chip rather than a panel-coloured block.

**Acceptance:** 292 unit / 45 e2e green. The transport is 2px taller, so the
committed screenshot baselines need the usual `--update-snapshots` pass on CI.

## 35. Follow-up batch Z (2026-10-16): dull idle wires, true color when data flows

- **Idle wires are tinted, never grey.** Before a sim value reaches a wire it now
  draws in `dullColor()` — its **identity color mixed halfway toward the
  background** — instead of the flat `--wire-disconnected` slate. The identity is
  the wire's user-chosen `color` if it has one (UI_OVERHAUL §12), otherwise its
  **net's bus hue** (`theme.bus[netId % 5]`), the same hue a bus already used, now
  extended to single-bit wires so every wire carries a tint (and wires on one net
  share it). `--wire-disconnected` now only neutralises junction dots.
- **The true color comes in when data flows.** Once `sim.valueForWire(i)` is
  defined the wire brightens to its real color: a chosen color, the bus hue for a
  live bus, or the per-state logic color (`low`/`high`/`x`/`z`) for a single-bit
  wire. So a wire reads "dull = not driven yet, vivid = live".

**Acceptance:** frontend lint / 292 unit / build green; 45-of-45 e2e green (the
demo/theme screenshot specs stay within their 2% `maxDiffPixelRatio`).

## 36. Follow-up batch AA (2026-10-16): rail label, constant 0, clock glyph, probe, Ctrl+X, split pins

- **Rail label no longer clips.** `.palette-rail-label` used `line-height: 1.15`
  with `overflow: hidden` (needed for the ellipsis on long names), which cut the
  descender of the "g" in **Wiring**. The line box is now tall enough
  (`line-height: 1.4` + a hair of bottom padding) and the rail/button are a touch
  wider (74/66px).
- **A constant always has a value.** `defaultAttrs("wiring.constant")` seeds
  `value: "0"`, so a placed constant drives its net from the first click and the
  Inspector shows `0` instead of an empty field.
- **The clock draws a clock face.** `wiring.clock` no longer shows the word
  `CLK`: idle it draws a dial + two hands (`drawClockGlyph`), and a live readout
  replaces it while simulating.
- **The probe has its own shape and only shows a value.** A probe body is a
  pointed hexagon (`probeBodyPath`) rather than a rectangle, and it never prints
  `PROBE` — it shows only its live value (and the value repeats by its pin while
  simulating).
- **Ctrl+X cuts.** `ToolMachine.cut()` copies the selection then deletes it as one
  op; the canvas key handler binds `Ctrl/Cmd+X` and the **Edit ▸ Cut** menu item
  (`Ctrl+X`) drives the same path. (Previously `Ctrl+X` did nothing.)
- **Input and output pins are separate palette tiles.** `PALETTE` entries became
  `PaletteItem { type, label?, attrs?, rot? }`, so the Wiring group offers
  **INPUT** and **OUTPUT** — both place `wiring.pin`, the output seeding
  `isOutput: true` and `rot: "W"`. `startPlacing` and the drag payload carry the
  seed rot, `CompIcon` takes `attrs` so the two tiles draw differently, and the
  Inspector's **Output pin** toggle (and `commitAsOutput`) is gone — the
  direction is chosen by which tile you place.

**Acceptance:** frontend lint / 292 unit / build green; 45-of-45 e2e green.

## 37. Follow-up batch AB (2026-10-16): text annotations, grid edge, middle-click tabs

- **A Misc tab with a text annotation.** New component type `misc.text` — a
  free-form label with **no pins and no behavior** (like a subcircuit in
  `behavior.rs`: `CompKind::Text => return None`). The engine validates a single
  `text` attr (§4 registry row) so a typo is still a load error; the frontend
  paints the string on the canvas with no body box (a thin accent outline only
  while selected), seeds it with `{ text: "Text" }`, sizes its hit box from the
  text width, and offers a **Text** field in the Inspector. The palette gains a
  **Misc** group with a **TEXT** tile.
- **Grid edge aligned to the chrome.** `CanvasHost` sized the canvas from
  integer `clientWidth`/`clientHeight` and scaled the transform by nominal
  `devicePixelRatio`; on fractional DPRs (Windows 125%/150%) `round()` makes the
  backing/CSS ratio differ, so the drawing was scaled a fraction of a pixel off
  the real CSS box — the grid's edge line drifted from the sheet-tab strip that
  shares its edge. The viewport now uses the **fractional**
  `getBoundingClientRect()` size and the **actual** backing/CSS ratio
  (`canvas.width / width`), and the background fill covers a pixel of slack so no
  sliver is left unfilled.
- **Middle-click a sheet tab → Rename / Delete.** `SheetTabs` opens a small menu
  on middle-button `mousedown` (its `preventDefault` also suppresses Chromium's
  autoscroll/gesture default, which is what surfaced as a stray browser panel).
  The menu reuses the popup styling, closes on outside-click/Escape, and mirrors
  the "×" affordance. `fileops.spec` covers it.

**Acceptance:** frontend lint / 292 unit / build green; 47-of-47 e2e green; Rust
171 core + 12 CLI + 8 golden, clippy/fmt clean.

## 38. Follow-up batch AC (2026-10-16): one save per file, renameable names, change list

Four follow-ups on saving and version history.

- **Ctrl+S saves** (it used to re-ask every time in the browser — the shell
  always wrote straight to its path). `saveTextFile` now keeps the File System
  Access handle from the first save and writes to it again, so the picker
  appears once per file; `forgetSavedFileHandle()` (on New / Open) is what makes
  the next save ask again, while Save As and renaming pass `forcePicker`.
- **The header title names the file.** `.app-title` is a button (in the shell;
  stress mode keeps the plain label): clicking it opens the name dialog, renames
  the document (`CircuitDocument.rename` — marks dirty, bumps the revision) and
  then saves. That is Save-As semantics, so an existing file is left alone and
  the title follows the chosen name. (§39 later made the shell rename the file
  **in place** instead, so nothing is left behind.)
- **The version drawer lost its buttons.** Save a copy…, Name… and Delete are
  gone; a version is renamed by clicking its name (inline field: Enter commits,
  Escape cancels). The row's click target is a transparent overlay button, so the
  name can sit above it and take its own clicks.
- **Change list.** `model/versionDiff.ts` compares the previewed version with the
  open document — components by `id`, wires as a multiset, circuits by name — and
  the drawer shows "This version vs the open document": a summary plus the
  individual changes (`+ part`, `~ field old → new`, `− part`), capped at eight
  lines. The newest version therefore reads "No differences from the open
  document".

**Acceptance:** 302 unit / 46 e2e green. New unit tests cover the diff
(`versionDiff.test.ts`) and the browser handle reuse (`files.test.ts`) — the
latter has no e2e because automation bypasses the picker entirely.

## 39. Follow-up batch AD (2026-10-16): the title edits in place

Clicking the file name in the header now behaves like a document editor: the
label becomes a **bordered field with the whole name selected**, Enter or blur
commits, Escape puts the old name back. No dialog.

What committing does depends on what exists:

- **A file on disk (shell)** → renamed **in place**. The new
  `rename_circuit_file` command renames the file and moves its version-history
  directory to the new path key: history is keyed by path (D1), so without that
  the file would look like it had lost every version. The document's `name`
  field is then written through the normal save path, so the `.csx` matches the
  name it is filed under.
- **No file yet** → naming it saves it (native picker in the shell, the File
  System Access picker / download in the browser).
- **The browser** cannot rename a file, so it names through Save-As.

Enter-then-blur would commit twice; a ref makes the commit fire once.

**Acceptance:** 302 unit / 48 e2e green; Rust 171 core + 12 CLI + 8 golden + 15
app (the new `history::rename` test included).

## 40. Follow-up batch AE (2026-10-16): text styling, probe preview + value

- **Text annotations lose Name / Label side.** For `misc.text` the Inspector
  hides both rows (an annotation's body _is_ its text) and instead offers
  **Color** and **Font** alongside **Text** (UI_OVERHAUL §40). The engine now
  validates `color` ("" = theme text, else `#rrggbb`) and `font`
  (`"sans" | "serif" | "mono"`); `TextStyle` gained an optional `font`, and the
  Inspector's new `color` field kind renders a native swatch.
- **The probe preview matches the part.** The pointed-hexagon body moved into
  `shapes.ts` as `probePath(x, y, w, h)`, shared by the placed body, the
  placement **ghost** (which used to preview a plain rectangle) and the palette
  icon — so what you drag out is what you get.
- **A probe shows what it is wired to.** With no live sim value a probe now
  falls back to `DocScene.staticProbeValue()`: it reads the configured value of a
  `wiring.constant` on the same net, so a probe on a constant reads `0` (or its
  value) before/without a run. A live sim value still wins.

**Acceptance:** frontend lint / 302 unit / build green; 48-of-48 e2e green; Rust
171 core + 12 CLI + 8 golden, clippy/fmt clean.

## 41. Follow-up batch AF (2026-10-16): grid-edge alignment, probe value, splitter editor

- **The grid's edge line meets the chrome.** The camera now snaps so the
  canvas's **top-left corner lands exactly on a grid line** (`Camera.alignToGrid`,
  a multiple of the current grid step). Parts stay on the grid — they share the
  camera transform — but the canvas edge no longer cuts a partial cell, so the
  grid line under the sheet-tab strip lines up with it. It aligns on the first
  sizing, on debounced resizes, and (debounced) after a wheel zoom; a **pan**
  release re-aligns too. The nudge is skipped when it would exceed ~8 px, so a
  high-zoom gesture never lurches. `editor.spec` checks the invariant;
  `pan.spec`'s delta assertions now allow the ≤½-cell snap.
- **A probe's value is only inside the probe.** `wiring.probe` left
  `VALUE_REPEAT`, so its live value is painted once, on the body — never
  repeated next to its pin outside the part.
- **Splitter editor, not a text box.** The `splits` field is now a structured
  editor (`SplitsField`): one row per split pin with a name and its bus-bit
  indices, add/remove, and a `N pins · bus M bits` summary. Text edits commit on
  blur/Enter (a per-keystroke rename would drop the old pin and prune its
  wires); add/remove commit immediately. `editor.spec` covers it.

**Acceptance:** frontend lint / 302 unit / build green; 50-of-50 e2e green; Rust
171 core + 12 CLI + 8 golden, clippy/fmt clean. The camera nudge shifts the
canvas a few px, so the sim/timing screenshot baselines were re-blessed locally
(`--update-snapshots`); their committed Linux copies need the same pass on CI.

## 42. Follow-up batch AG (2026-10-16): mismatch blink, no text rotation, grid toggle repaint

- **Settings/View toggles repaint an idle canvas.** Changing a render-affecting
  preference (e.g. **Show grid**) produced a new `draw` closure but never marked
  the canvas dirty, so an idle canvas kept its old frame — the grid toggle
  appeared to do nothing. `CanvasHost` now marks dirty when `draw` changes
  (UI_OVERHAUL §42); `settings.spec` checks the pixels actually change.
- **The text annotation drops Rotation too.** `misc.text` now hides Name,
  Rotation and Label side — a free text label is placed and typed, not aimed — so
  its Inspector is only Text / Color / Font (UI_OVERHAUL §40).
- **The mismatch halo is the wire's own color, not amber.** A net whose pin
  widths disagree no longer draws a fixed `theme.violation` ring; the halo under
  the core uses the wire's computed color (`stroke` — custom color, bus hue, or
  state color) and **blinks** it (opacity 0.3→1 and ring weight 2.1→3.1× at
  ~170 ms), so the part you drew pulses in its own color. `theme.violation`
  stays for the setup/hold violation markers (§U7), which are a different signal.

**Acceptance:** frontend lint / 302 unit / build green; 50-of-50 e2e green. The
sim/timing screenshot baselines were re-blessed locally for the new halo color;
their committed Linux copies need the same `--update-snapshots` pass on CI.

## 43. Follow-up batch AH (2026-10-16): real paths on Windows

`path.includes("/")` was the app's test for "the shell handed us a real file",
and on Windows every path is `C:\…\file.csx` — so the shell treated **every**
saved file as pathless. Ctrl+S and a title rename therefore re-opened the save
dialog, file-autosave never rewrote anything, version history was keyed by the
session instead of the path, and the external-change guard never armed.

`files.ts` now owns the two helpers: `isRealFilePath` (either separator) and
`siblingPath` (same directory, same separator style). Both are unit-tested, and
`realPathOf`, `onSave`, `onSaveAs` and the rename all use them. Renaming in
the browser also stopped re-opening the picker: the new name is written into the
file it already holds a handle for, since a browser cannot rename a file.

## 44. Follow-up batch AI (2026-10-16): save every change, compress the history

Google-Docs-style persistence.

- **Autosave writes on every change.** The scheduler gained a leading edge: the
  first edit after a quiet spell is flushed immediately, and further edits in
  that burst coalesce into a trailing flush. The timing tightened from 3 s idle
  / 30 s cap to **1 s idle / 10 s cap** (`DEFAULT_AUTOSAVE_TIMING`), so a change
  reaches disk (or the recovery store) within about a second and a continuous
  edit run is written at least every 10 s. Blur / close / explicit Save still
  force a flush, and a queued write survives `dispose()`.
- **History compresses by age** (`history::prune`, mirrored in the dev store):
  under an hour keep every step, under a day one per 5 minutes, under a week one
  per hour, older one per day — on top of the hard caps (200 automatic versions
  or 25 MB per document, whichever bites first). Named versions are never
  thinned. Blobs are content-addressed, so identical states still share one
  file, and each save collects the blobs nothing references.

**Acceptance:** 303 unit / 48 e2e green; Rust 171 core + 12 CLI + 8 golden + 17
app (two new tier tests: a day-old stretch thins to ~one per 5 minutes, a
month-old one to one a day).

## 43. Follow-up batch AH (2026-10-16): the BUFFER tile

- **A gate stays its size; extra inputs extend its input edge.** First attempt
  (superseded by §44): the body height was pinned at 3 and the gate widened with
  the input count. See §44 for the shipped behaviour.
- **Buf → BUFFER, with an enable.** The Gates palette's `BUF` tile is now
  **BUFFER**, placing the engine's tri-state `wiring.controlled-buffer`
  (`in`/`en`/`out`, `en` on the BOTTOM edge per §24) with a buffer triangle plus
  an enable lead (`shapes.ts`). The frontend registry previously had no spec for
  this engine type — it was unreachable from the UI. The plain `gate.buffer`
  still loads (demo circuits use it) but is no longer offered. See
  `docs/format-v2.md` §4's ⚠️¹ note.

**Acceptance:** frontend lint / 302 unit / build green; 51-of-51 e2e green; Rust
171 core + 12 CLI + 8 golden, clippy/fmt clean.

## 44. Follow-up batch AI (2026-10-16): a gate keeps its shape; inputs hang on the input edge

- **The gate symbol never reshapes.** A gate's AND/OR shape is drawn at a fixed
  2-input size (`CAP_H = 3` in `shapes.ts`), vertically centred in the body. The
  body still grows TALLER with `inputs` (so the pins keep their spacing — nothing
  is compressed), and a **straight vertical input-edge line** at `x = 0` is drawn
  spanning the whole body, so every input pin lands on one clean edge the length
  of the input set. Negated variants keep their output bubble at the symbol's tip;
  XOR/XNOR keep their back arc on the symbol. Width is 5 for every gate.
- Two-input gates are byte-identical to before (height 3 = `CAP_H`, so no input
  line is added). `layout.test` pins a 4-input AND at 5×5. `gateSpec` is back to
  the original height growth; §43's "wider" attempt is superseded.

**Acceptance:** frontend lint / 303 unit / build green; 51-of-51 e2e green; Rust
171 core + 12 CLI + 8 golden, clippy/fmt clean.

## 45. Follow-up batch AJ (2026-10-16): a `?` panel that fits

- **Redesigned the shortcuts overlay.** It was one long `<table>` inside
  `.help-card` (max-width 480, no height cap), so it ran off the bottom of the
  screen. It is now `.help-card.help-shortcuts`: a **two-column, scrollable**
  card (`width: min(94vw, 820px)`, `max-height: min(88vh, 780px)`, the section
  list itself scrolls) with a header + close button, the rows grouped into
  **Wiring / Selecting & editing / Keyboard / Files / Simulation / Pan & zoom**,
  and a `Ctrl+X` (cut) + `?` row added. The shared `.help-card` base is
  untouched, so the About/memory dialogs keep their look.
- `help.spec` opens it with `?` and asserts the card's box is inside the
  viewport, that all six sections render, and that Escape dismisses.

**Acceptance:** frontend lint / 303 unit / build green; 52-of-52 e2e green.

## 46. Follow-up batch AK (2026-10-16): splitter + RAM get real shapes

- **The splitter is a bus rail, not a box.** `wiring.splitter` no longer draws a
  rectangle (which read as a mux): `docScene` draws a straight vertical rail with
  one horizontal tap per split pin and a stub from the `bus` pin into the rail,
  and `CompIcon` mirrors it. Selection still outlines the hit box.
- **A RAM/ROM looks like a chip and reads out its address + data.** The body is
  `shapes.chipPath` — a rounded rectangle with an orientation notch pip on its
  bottom edge — used by the placed body, the placement **ghost** and the palette
  icon. Instead of the word "RAM", the body now shows the **address** beside the
  `addr` pin and the **data value** beside the output pin (`dout`/`out`), taken
  from the live sim (formatted by the part's `radix`). The type word is kept as a
  small dim centred label; memory parts left `VALUE_REPEAT` so the value is no
  longer duplicated outside the body.

**Acceptance:** frontend lint / 303 unit / build green; e2e unchanged.

## 47. Follow-up batch AL (2026-10-16): a clock you can tick and read

- **The clock shows a square wave + its last edge.** `drawClockWave` replaces the
  idle clock face: a low→high→current square wave whose final segment is the
  level the clock currently drives, with an **▲ rising / ▼ falling** marker on
  the transition that just happened. Idle (no sim value) draws a neutral wave.
- **Shift+click a clock ticks the sim in place.** `ToolMachine.onTick` fires when
  a Shift+click lands on a `wiring.clock` (instead of toggle-selecting it);
  `EditorCanvas` loads the session on demand and calls `stepTick` — the same path
  as the transport's Ctrl+J, but at the part you're looking at.
- **The tick is visible.** When a clock's level flips, its outline flashes in the
  accent colour (fading over ~450 ms while the canvas is animating), in addition
  to the waveform/edge marker. `editor.spec` guards that the Shift+click is
  consumed as a tick and does not toggle the selection.

**Acceptance:** frontend lint / 303 unit / build green; 52-of-53 e2e green — the
stress-scene _benchmark_ p95 gate fails on this machine (rAF ~40 fps); it also
fails with these changes stashed, so it is load, not a regression.

## 48. Follow-up batch AM (2026-10-16): reads before a run, a clock that glows, a real button

- **Parts read their driver before a run.** `staticProbeValue` became
  `staticPinText(comp, pin)` (a `wiring.constant` on the pin's net): the probe
  uses it for `in`, and a **RAM/ROM's `addr`** now uses it too — so wiring `addr`
  to a constant shows the address on the chip immediately, no tick needed.
- **The clock glows high / dulls low.** It draws its square wave **bright
  (`--wire-high`) while it drives 1** with a soft halo around the body, and dull
  (`--text-dim`) while it drives 0, so the rising/falling edge is legible at a
  glance; the accent flash on a flip is kept. Shift+click still ticks in place.
- **`io.button` looks like a button.** A round cap with a plunger + a lead to the
  pin (`shapes.ts`), shared by the placed body, the ghost and the palette icon —
  no more box.
- **Outline-only parts are visible.** The splitter's rail/taps moved from
  `--panel-border` to `--text-dim` and got a touch thicker — on a dark canvas the
  rail was invisible before.

**Acceptance:** frontend lint / 303 unit / build green; 52-of-53 e2e (the stress
benchmark p95 gate is failing on this loaded machine — it also fails with the
changes stashed).

## 49. Follow-up batch AN (2026-10-16): the LED lights up

- **`io.led` gets `color` + `intensity`.** The engine validates `color` ("" =
  theme accent, else `#rrggbb`) and `intensity` (0..=100, default 80); the
  Inspector offers a swatch + a Brightness field (`docs/format-v2.md` §4).
- **It looks like an LED and it glows.** The body is a dome (circle) with a base
  and two legs — shared by the canvas, the placement ghost and the palette icon.
  While the net it reads drives a 1 it fills with its colour and **throws soft
  concentric glow rings** whose alpha scales with `intensity`; while the net is 0
  (or unconnected) it is a dark, unlit dome.
- **It lights without a run.** The ON test uses the live sim value when present,
  else the same static read as the probe/RAM — a connected constant — so a
  constant wired to an LED lights it immediately (UI_OVERHAUL §48).

**Acceptance:** frontend lint / 303 unit / build green; Rust 171 core + 8 golden,
clippy/fmt clean; 52-of-53 e2e (the stress benchmark p95 gate is environmental).

## 50. Follow-up batch AO (2026-10-16): terminals, memory text, LED punch

- **Every part gets its pin markers.** The text/splitter/LED special cases
  `continue`d past the pin collection, so those parts drew **no terminals at all**
  — the LED's and splitter's connection points were invisible. Pins are now
  collected at the top of the component loop, before any special case.
- **RAM/ROM read as text, centred.** Instead of a value beside each pin, the body
  now stacks **`RAM` / `Addr:` / `Data:`** on three centred lines in the light
  caption style (unread values show `—`); **constants read their value in that
  same light style** too.
- **The LED's connection is obvious and its glow has punch.** A lead runs from
  the `in` pin into the dome, and the glow is a 4-ring bloom whose radius and
  alpha scale hard with `intensity` — 100% lights the space around it properly.
- **Brightness is a bar.** New `slider` field kind (drag bar + numeric readout);
  the LED's Brightness uses it.
- **Shift+click a clock now always ticks.** The tick fires on the **press**
  (`CanvasHost.onShiftPress` → `ToolMachine.tickClockAt`) before the Shift+left
  PAN gesture can claim it, so a click that drifts a few pixels still ticks.

**Acceptance:** frontend lint / 303 unit / build green; 52-of-53 e2e (the stress
benchmark p95 gate is environmental — it also fails with these changes stashed).

## 51. Follow-up batch AP (2026-10-16): splitter ghost, no stray Z, a ticking clock

- **The splitter's placement ghost matches the part.** The ghost's box fallback
  still drew a rectangle for `wiring.splitter`; it now draws the same bus rail +
  taps as the placed body (and the palette icon).
- **No stale Z on a constant-driven net.** A constant always drives its net, so
  when the sim reports high-Z/X for one (its session predates a recent edit) the
  readouts now fall back to the **constant's value** instead of showing `Z` —
  applied to every value readout and to the LED's on/off test.
- **An unwired clock still visibly ticks.** A clock whose output isn't wired has
  no net to report, so its drawn level never changed. It now falls back to the
  sim's **phase** (`SimOverlay.cycle`: high on even cycles), so Shift+click
  ticking animates it either way.
- **LED panel tidied.** The Brightness field's hint line is gone (the bar and its
  numeric readout say enough).

**Acceptance:** frontend lint / 303 unit / build green; 52-of-53 e2e (the stress
benchmark p95 gate is environmental).

## 52. Follow-up batch AQ (2026-10-16): a quieter clock, an honest address, pin words

- **Clock restyled.** The green `--wire-high` wave and the wide green halo are
  gone: the waveform is neutral (`--text-dim`) and the segment holding the
  **current level** is drawn in the theme accent, with the accent edge marker
  (▲/▼) at half opacity while low. "Driving 1" is now a quiet accent ring around
  the body instead of a glow — same information, none of the colour noise.
- **A RAM's address never shows a stale Z.** The §51 constant-over-Z rule was
  applied to the generic value readout but **not** to `addrText` (which is
  computed separately), so a RAM wired to a constant still read `Z`. The address
  readout now applies the same rule.
- **Pin words in the hover preview.** `PIN_DISPLAY` gained `we` → **write
  enable** (plus en/rst/addr/din/dout), so the memory control pins read as words
  when you hover them. The `.csx` format keeps the registry names — renaming
  `we` for real would invalidate every existing wire endpoint that references it.

**Acceptance:** frontend lint / 303 unit / build green; 52-of-53 e2e.

## 53. Follow-up batch AR (2026-10-16): constant radix, double-click to edit

- **A constant can show hex, binary, or decimal.** New display-only `radix` attr on
  `wiring.constant` (`"hex" | "bin" | "dec"`, default `"hex"`). The stored `value`
  stays a hex string in the `.csx` file; the editor renders it per the chosen
  radix — `0x…` for hex, `0b…` (zero-padded to the bit width) for binary, and the
  plain unsigned decimal. The `out` pin's bit width drives the padding.
- **The radix is tagged in the body's corner.** A small dim `hex` / `bin` / `dec`
  label sits in the constant's bottom-right corner, so its display style is never
  ambiguous.
- **Double-click a constant to edit its value.** Double-clicking a constant now
  selects it _and_ drops the caret straight into its **Value** input in the
  Inspector (`onEditComponent(compId, "value")` → `focusField` prop → the field
  focuses and selects on the next render).

**Acceptance:** frontend lint / build green; 6 editor e2e pass (constant radix +
double-click focus covered); core tests green (`cargo test -p csim-core`, 171 +
8 golden).

## 54. Follow-up batch AS (2026-10-16): the priority decoder

- **New Plexers tile: Priority Decoder** (`plexers.priority-decoder`). The user
  asked for this by name and confirmed the behavior: the **highest-numbered
  asserted input line** (`in0` = lowest priority) is encoded as its **binary
  index** on `out` (⌈log₂N⌉ bits), with a `valid` output that is high iff any
  input line is asserted. Behaviorally that is the standard _priority encoder_;
  the type string and the palette tile keep the course's "priority decoder"
  wording.
- **Engine-first.** `CompKind::PriorityDecoder` + `BehaviorKind::PriorityDecoder`
  with `inputBits` (2..=8, default 4); pins `in0..in{N−1}` (1 bit each), `out`
  (⌈log₂N⌉ bits), `valid` (1 bit). Every input line consumes (format-v2 §4 /
  behavior module consume table). An `X` on a line above every known `1` leaves
  the result unknown (`out` and `valid` are `X`); an `X` below a higher `1` is
  masked. Delay-table entry `plexers.priority-decoder` = 12 ns, matching the
  other plexers.
- **Frontend** mirrors it: a 4-wide box, input lines spread down the left edge,
  `out`/`valid` on the right, body caption `PRIO DEC`; the palette keeps the
  human name **Priority Decoder**. The Inspector edits **Input lines** (2–8).

**Acceptance:** frontend lint / 303 unit / build green; core `cargo test -p
csim-core` 173 + 8 golden; e2e covers the tile (`panels.spec`) and placement +
line-count edit (`editor.spec`).

## 55. Follow-up batch AT (2026-10-16): LED, slider, wire drag, previews, constants

- **The LED has no bit size.** `io.led`'s Inspector drops its `bitsize` picker
  (it is a 1-bit indicator); new LEDs no longer seed one.
- **The brightness slider reaches the end.** The shared `.inspector-row input`
  rule gave the range input 8 px padding + a border, insetting the track so the
  fill stopped short of the end. The slider now resets padding/border and draws
  an explicit `--fill` gradient from its value, so 100 lights the whole bar.
- **A dragged wire lets go.** Releasing a wire drag (a moved bend, or a
  junction-wire dropped without connecting) now clears the wire's selection
  instead of leaving it highlighted; press the handle again to highlight and
  keep dragging (`ToolMachine.deselectWires`).
- **The canvas cursor says what a press will do.** Hovering a **pin** shows
  `crosshair` (wiring — the next click moves the wire), a wire **bend** shows
  `move`, a **wire** shows `pointer`, a component drag shows `move`, and a
  placement ghost shows `copy` (`ToolMachine.cursor` → `CanvasHost.cursor`).
  Idle space keeps the pan cursor.
- **The output pin's preview matches.** The placement ghost and the palette icon
  drew a plain rectangle for an output pin; both now use the same rounded
  stadium the placed part uses (terminal facing left, since an output pin seeds
  rotation W).
- **Constants read and edit in their own base.** The body grew to 3x2 so the
  value fits, the corner `hex`/`bin`/`dec` tag is gone, **Show as** is a
  3-button segmented chooser, and the **Value** input is typed and shown in the
  selected base (no forced hex string) — it is converted to the stored hex on
  commit and rejected if it does not fit the bit width.

**Acceptance:** frontend lint / 305 unit / build green; e2e 54-of-55 (the stress
benchmark p95 gate is environmental); new unit tests cover the wire-deselect and
cursor behavior.

## 56. Follow-up batch AU (2026-10-16): probe size, readout buttons, value ellipsis

- **The constant's value hint is gone.** The right panel no longer shows "Typed
  in the selected base…" under **Value**.
- **The probe is roomier and picks its base with buttons.** `wiring.probe` grew
  to 3×2 so a multi-bit readout fits, and its **Show as** is now the same
  segmented-button chooser the constant uses instead of a "Radix" dropdown. The
  pin's readout gets the same chooser. (Their `radix` is a _display mode_ —
  unsigned / signed / hex, validated by the engine — so the buttons offer those
  three rather than the constant's hex / bin / dec.)
- **Long readouts ellipsize instead of overflowing.** A value that would overrun
  its body is shortened with a trailing `…` at a readable size (≥ 0.6) rather
  than shrunk to a hairline or spilling off the part — constants, probes, pins,
  registers, LEDs and a RAM/ROM's `Addr:`/`Data:` lines all go through
  `fitValueLine`. **Hovering the part then shows the full value in a card above
  it** (`DocScene.truncated` → `drawCard`).

**Acceptance:** frontend lint / 307 unit / build green; e2e 54-of-55; new
`docScene.test.ts` pins `fitValueLine` (short values stay whole, wide ones fit).

## 57. Follow-up batch AV (2026-10-16): plain names, one base chooser everywhere

- **The Inspector header reads in plain words.** It showed the raw id + type
  (`c3` / `plexers.mux`); it now headlines the component's full name —
  **Multiplexer**, **Demultiplexer**, **Priority Decoder**, **Tri-state
  Buffer**, … (`catalog.typeDisplayName`) — with the raw id as quiet metadata.
  Selecting a wire headlines **Wire** (`N-bit bus` stays beside it).
- **Every readout shares one base chooser.** The constant, pin, probe and now
  the **register** all use the same 3-button **Show as** chooser — **Hex / Bin /
  Dec** — replacing the old "Radix" dropdowns (and dropping the separate
  Unsigned/Signed labels, which read as the same thing to the user). A new
  `bin` display mode renders `0b…` (`formatValue`).
- **The register's stored value reads on its body** in the chosen base, like the
  other readouts (its `radix` is display-only; `docs/format-v2.md` notes it).
  The engine accepts `radix` on `wiring.pin` / `wiring.probe` / `mem.register`
  as `unsigned | signed | hex | bin | dec` (the extra names stay valid so older
  files keep loading).

**Acceptance:** cargo fmt/clippy/`csim-core` 173 + 8 golden green; frontend lint
/ 308 unit / build green; e2e 54-of-55 (the stress benchmark p95 gate is
environmental).

## 58. Follow-up batch AW (2026-10-16): one-page memory editor, quieter Inspector

- **The memory editor is one scrolling page.** The hex grid no longer paginates
  (256 words a page): every address renders in a single scroll area that fills
  the dialog (`.mem-table-wrap { flex: 1; min-height: 0; overflow: auto }`).
  Paste/arrow navigation still focuses the landed cell, which scrolls it into
  view.
- **No more how-to prose.** The dialog's "Click a cell, then paste or type hex
  values …" paragraph is gone (the "N of M words set · cell 0x…" counter stays).
  Every component `hint:` is dropped from the Inspector — no "Words — a power of
  two…", no "One `pin: bit,bit` line…", no "A hex display decodes four bits per
  digit", etc. — as are the wire-width explanations. Only real warnings (width
  mismatch, unnamed/not-addressable) remain.
- **The RAM/ROM panel is compact.** The memory's size field is labelled **Words**
  (it is the number of words the memory holds — kept, since it is what sizes the
  memory) with its hint removed; the `Autoload` and `Contents` rows are followed
  by a **single action line** — `Choose file…` / `Clear` / `Edit hex…` — instead
  of two full-width button rows plus a trailing explanation.

**Acceptance:** frontend lint / 308 unit / build green; e2e 54-of-55 (memory
spec passes against the single-page grid).

## 59. Follow-up batch AX (2026-10-16): a thin width-mismatch flash

- **The mismatch flash no longer scales with the bus.** The pulsing width-mismatch
  halo was drawn at `width × (2.1 + phase)`, so a 32-bit bus (≈0.57 units of
  core) flashed as a **~1.5-unit blob**. It is now `width + MISMATCH_RING × (0.6
  - 0.8·phase)` with a constant ring width (`MISMATCH_RING = 0.3`): a thin pulse
    around the wire at every bit width — wide enough never to hide behind the core,
    never proportional to it.

**Acceptance:** frontend lint / build green; e2e 54-of-55 (the three frozen-halo
baselines were re-blessed for this platform). The committed **linux** baselines
still need one `--update-snapshots` run on Linux (pre-existing todo).

## 60. Follow-up batch AY (2026-10-16): tabs name themselves, no popups

- **Creating a tab is inline, with a slide-in.** The strip's "+" adds the
  subcircuit straight away with a unique default name (`subN`), the tab **slides
  in** (`.sheet-tab-wrap.enter` → `sheet-tab-in`), and its label becomes a small
  **input right in the tab** — type the name there. Enter (or blur) commits,
  Escape abandons and keeps the default.
- **Double-click re-opens the same inline box.** The tab's double-click (and the
  middle-click menu's **Rename…**) now start in-place editing rather than a
  modal, so the sheet-name popup is gone entirely — `components/NameDialog.tsx`
  and its `.name-dialog`/`.name-actions` styles are deleted.
- The inline input stops its own key events, and the app's global shortcuts
  already ignore events from a focused `INPUT`, so typing a name never rotates
  the selection or cancels wiring.

**Acceptance:** frontend lint / 308 unit / build green; e2e 54-of-55 (`fileops`
covers create-inline, double-click rename and the middle-click Rename… box).

## 61. Follow-up batch AZ (2026-10-16): a register always reads a value

- **A register shows its value even with nothing connected.** It only had a
  readout when its `q` net carried a live value, so an unwired (or not-yet-run)
  register fell back to the bare **"REG"** mark. A register powers on at 0, so
  when no live value is available the body now reads zero padded to its word
  width in the chosen base (e.g. `0x00000000` for a 32-bit register, `0` for a
  1-bit one). The `Show values` preference still governs it, and a live value
  overrides it as before.

**Acceptance:** frontend lint / build green; e2e 54-of-55 (visual baselines
unchanged within tolerance).

## 62. Follow-up batch BA (2026-10-19): the reset pin and the header theme toggle retire

Two things this document specifies are gone; where §9 and §24 describe them, this
section wins.

- **`mem.register` / `mem.ram` lost their `rst` pin** — format-wide (engine,
  fixtures, frontend, docs). The pin existed because the old simulator had no RAM
  autoload: a canvas button wired into every register's reset was how a circuit
  restarted. Both replacements exist now — memory autoload on load/reset, and the
  transport's **reset** (Ctrl+R) — so the pin was dead weight. Register pins are
  `d`/`en` on the left edge, `clk` on the bottom, `q` on the right; RAM pins are
  `addr`/`din` left, `dout` right, `we`/`clk` bottom. A memory's `addr` pin is as
  wide as its address space (`ceil(log2 depth)`), and readouts pad to the pin's
  declared width, so a 32-bit part reads `0x00000000`.
- **The top-bar light/dark toggle is gone.** Theme — light or dark — is chosen in
  **Settings → Appearance**, which is the only path to it (the 24-hour clock
  toggle sits on the same row).

Everything else from the tester's report is logged, with commit hashes, in
`docs/bugs.md`: probe width auto-match, RAM/ROM previewing the word at the
address, readouts zero-padded to the pin's declared width, a typed cycle input
(no steppers), palette tooltips naming the part, sheet-tab right-click rename,
reload-from-disk confirmation, **one** bus colour instead of per-net colours, red
blinking unconnected inputs on otherwise-wired parts, the wiring hint in the
status bar, the 12-/24-hour timestamp preference, the bottom zoom slider, inset
focus rings on sheet tabs, annotation text that stays legible in light themes,
and text annotations that load at all — `misc.text` had no behavior, so placing
one made the whole document unloadable.

**Acceptance:** frontend lint / 342 unit / build green, e2e 64 passed; the canvas
baselines were re-blessed (a pin dot departed) and verified deterministic across
two consecutive runs.

## 64. Follow-up batch BC (2026-10-19): ask before closing, not after

The "Recover unsaved work" dialog was the wrong half of the mechanic: it offered
recovery for _clean_ closes too, asking after the fact about work the person had
just deliberately closed. Closing is a moment they are present for, so we ask
then.

- **"Save your work?"** — the close guard (desktop: the window's close request;
  web: the browser's own `beforeunload` warning) names the document and offers
  **Save** (a Save As only when it has never been named), **Don't save**, and
  **Cancel**; Escape is Cancel, the choice that loses nothing. A cancelled or
  failed save keeps the window open _and_ keeps the recovery copy — the work is
  still at risk.
- **Any resolved decision ends the recovery copy**, so the launch dialog now
  means what it says: the last session ended without closing (a crash), because a
  clean close has nothing left to offer. Save writes through the ordinary save
  path, so an unnamed document still asks where.
- The once-registered window handler reads the guard through a ref (the same
  pattern as the autosave/pref refs), and `saveNow(forcePicker)` is now the one
  save entry point behind Ctrl+S, Save As, and the guard — so "did it save?"
  has a single answer (the bytes were written).

## 63. Follow-up batch BB (2026-10-19): a memory's address width, and one Clear

- **A memory's address width is yours.** `addr` was always `ceil(log2 depth)`
  wide, which made a deliberately narrow address — a 4-bit address reaching a
  16-word window of a 256-word memory — impossible to draw, and an address space
  larger than the word count inexpressible. The Inspector now offers **two
  one-click pickers** — **Address Bits** (`addrBits`, format-v2 §4) and **Data
  Bits** (`bitsize`) — the same 8-column grid every other bit width uses (§28);
  no dropdown. There is **no word-count field**: the address pick _is_ the size
  (`depth = 2^addrBits`), so 4 address bits means 16 words and nothing can hide
  beyond the end — and since an image longer than the memory is a load error, a
  resize trims it (Undo is the way back). Unset = auto (the width derived from
  `depth`, which a default memory leaves unwritten), set = exactly that width.
  The format still keeps the two attributes independent, so a hand-authored file
  may express a window. Fewer bits
  address a window, more leave the extra addresses reading `X`. Additive, so no
  format-version bump; the engine test and the catalog unit test pin the same
  rule (`components.rs::addr_width`).
- **One Clear per memory.** The Inspector's bare `Clear` (it dropped the
  `autoload` file reference) is gone; `Clear all` inside `Edit hex…` clears both
  the embedded image and the autoload file, and the dialog says so before Apply.
  See §58's action line, §62 for the pin/theme retirements above.

## 65. Follow-up batch BD (2026-10-19): a second click narrows a wire to the piece you mean

Deleting a wire took _everything_. At a junction the trunk and the branch are
both under the pointer, so clicking a branch could select its parent — and Delete
then took the parent _and_ every branch hanging off it (the tester's "remove an
unnecessary segment removes the entire wire").

- **The selection narrows on a second click.** Clicking a wire selects it (all
  bends, as before); clicking the same wire again selects the **piece under the
  cursor** — a branch wire junctioned onto it at that segment, or the segment
  itself. Delete then takes only that piece.
- **What a piece means.** A branch goes on its own (its parent survives). A
  segment delete **shortens** the wire by dropping the bend that segment turns
  at, so both endpoints stay attached — a wire here _is_ a connection, and its
  ends cannot dangle (that is why a redundant "end segment" cannot simply be
  trimmed off; dangling ends are still the deferred feature of DESIGN §5.2). A
  wire drawn without bends is nothing but that segment, so deleting it deletes
  the wire. Junction dependents are re-projected onto the new geometry, and the
  delete is its own undo step (`remove wire segment`) — it never merges into the
  route edit before it.
- The narrowed segment is drawn in the accent colour, so what the next Delete
  would take is never a guess.

## 66. Follow-up batch BE (2026-10-19): export the canvas as a PNG

`File → Export view as PNG…` writes the canvas exactly as it is drawn — the
renderer owns the pixels, so the `<canvas>` element is asked for a
`data:image/png` URL and the file plumbing delivers it: a real file through the
shell, a download in the browser. It is named `<document>-view.png`, so an export
can live beside the `.csx` it came from, and the name is written as a file on the
shell side by a `save_image` command that decodes the data URL (the webview has
the bytes; the shell owns the filesystem, like `save_circuit`).

Scope: the **current view** — the export is what is on screen, at the canvas's
own resolution (device-scaled). Exporting the whole circuit (fit the view to the
content, render one frame, restore) is a deliberate follow-up: it needs a frame
handshake with the animation loop, not a screenshot.

## 67. Follow-up batch BF (2026-10-19): the Inspector shows a part's table delay

The Inspector now reports the selected part's own cost, straight from the
published table (`crates/core/data/cs2200-74ls-v1.json`) read at **build time** —
a bundler import, not a second copy of the numbers, so the editor can never
disagree with the engine. A register reads `prop 20 ns · setup 15 ns · hold 5 ns`,
an adder `prop 15 ns + 4/bit`, an AND `prop 10 ns`; parts with no published cost
(pins, subcircuits, text) show no row at all.

This is the **design** number — what the part contributes and what STA bounds.
The transport's `top_paths`/`T_obs` remain the _measured_ (DTA) quantity, and the
row deliberately does not try to be a simulation result. A wire's own readout
(path length × the table's per-unit wire delay) and the animation pulse-rate
slider are the follow-ups.

## 68. Follow-up batch BG (2026-10-19): exact text at every zoom, and a MUX that says so

Two reports from the canvas, both from the same corner of the renderer.

- **Text is rasterized in DEVICE space at its final pixel size.** The renderer used
  to set `ctx.font` in _world_ units (≈1px for a body mark) and let the camera
  transform scale the glyph up. Font metrics are quantized at that ~1px size, so
  `textBaseline = "middle"` landed a fraction of a _world_ pixel off — invisible
  zoomed out, multiplied by the zoom when zoomed in, and worse for bigger marks.
  That is why the adder's `+` measured centred in the committed baseline but
  ~0.47 units low in a zoomed-in screenshot: "everything's logo is off". The flush
  loop now reads the live transform, resets it, sizes the font to `size × scale`
  and places the glyph at the transformed point, so a mark is exact at any zoom.
- **A plexer's trapezoid carries `MUX` / `DEMUX`.** §17's rule 3 lists them among
  the abbreviations a body shows, but the shaped-body pass suppressed _every_
  caption. The shape stays — but a bare trapezoid, unlike a NAND's outline, does
  not say which plexer it is. Gates keep the shape-only treatment.

## 69. Follow-up batch BH (2026-10-19): a wire's delay, on the wire

A selected wire now shows its own per-path delay — the drawn length in grid units
times the published table's per-unit wire fraction (0.1 ns), from the same
build-time table the part readouts use (docs/delay-table.md, §67). A routed wire
of 5.5 units reads `≈ 0.6 ns (5.5 units × 0.10 ns)`. Like a part's row, this is
the **design** number: the transport's `T_obs` and `top_paths` remain what a run
observed.

## 70. Follow-up batch BI (2026-10-19): pulse speed, and where it stops

The signal-pulse animation had one fixed duration (`PULSE_MS = 350`). **Settings →
Canvas → Pulse speed** (50 / 75 / 100 / 150 / 200 %, default Normal) now scales it:
the pref is an integer percentage (`csx.pulseSpeed`), `PulseTracker` takes its
duration from it, and `EditorCanvas` rebuilds the tracker when it changes. The
switch it modifies ("Animate signal pulses") sits directly below it.

That closes the propagation-delay/pulse bullet: a part's table cost, a wire's
per-path cost, and the animation's pace are all visible and adjustable. The last
piece of the _measured_ story is deliberately not done — see `docs/bugs.md`: a
per-part **observed** delay needs a new IPC field, which is a contract change
(`docs/ipc.md`) and therefore wants a sign-off rather than a drive-by.

## 71. Follow-up batch BJ (2026-10-19): power and ground

Two fixed sources, for the schematic habit: **Power** (a 1) and **Ground** (a 0),
placed from the Wiring group and drawn like a constant whose caption is its value.
They are `wiring.power` / `wiring.ground` — new _type strings_, which the format
takes additively (no version bump; nothing existing changes) — and their engine
behaviour is the `CompKind::Constant` arm, so every path that already handles a
constant (netlist, DTA/STA, autograder) handles them. They accept **no attrs**: a
stray `value` is an unknown-attr error rather than a silent override of what the
part means. Distinct glyphs (the legacy bar / rake) and the **transistor** are the
rest of the primitives bullet.

## 72. Follow-up batch BK (2026-10-19): a rake and a bar

Power and ground (§71) get their classical glyphs: **ground is a rake** (three
bars of decreasing width), **power is a bar on a stem**, both drawn inside the
body rect so they rotate with the part like every other shaped body. They keep
their `1` / `0` caption — the shaped-body rule that dropped captions (§68) now
exempts them for the same reason it exempts the plexers: the shape alone does not
tell you which source you are looking at.

No committed screenshot contains these parts, so instead of re-blessing baselines
the geometry is pinned by a unit test (`shapes.test.ts`) asserting both glyphs
stay inside their rect.

## 73. Follow-up batch BL (2026-10-19): the transistor

A **transistor / pass gate** (`wiring.transistor`) in the Wiring group: it
conducts `in` → `out` while `gate` is high, floats (`Z`) while it is low, and
outputs `X` while the gate is unknown (consuming the data, since the gate might be
open). A floating gate **halts naming `gate`**.

That last sentence is why it is not simply the tri-state buffer: the buffer's arm
hardcodes `consume(en, "en")`, and that string is what a halt reports and the
canvas highlights — so a transistor built on it would name a pin the part does not
have. It is its own `CompKind`/`BehaviorKind` pair, and the delay engine needed no
change at all: `SinkKind` comes from the **pin name**, so `gate` lands on
`SinkKind::Other` (a plain combinational input). It is drawn as a box for now
(`FET`) — a proper transistor symbol is a follow-up.

## 74. Follow-up batch BM (2026-10-19): the observed number beside the design one

A part's delay row now has two halves when there is something to compare: `prop
10 ns · observed 12 ns on the critical path`. The first is the published table (the
design cost, §67); the second is what DTA actually measured for the critical path
the part sits on.

The measured half needed no new IPC surface, and the reason is worth recording: a
commit in the delay engine is scheduled at `input_arrival + t_pd` (inertial), so a
part's observed delay **is** its table delay by construction — a per-part field
would re-serialize the table into every `timing_update`. What is genuinely observed
is the path (`TimingPath.delay_ns`), which the UI already received for the canvas
highlight. `topPathDelay()` reads that same `top_paths[0]`, and App passes it only
for a part that is on the path.

## 75. The canvas context menu

Right-click used to mean exactly two things on the canvas — cancel whatever gesture
is in progress, and jump to a subcircuit instance's definition — and both survive,
now deliberately rather than by accident. What is new is the third case: with
nothing in progress and no instance under the pointer, a right **click** (press and
release with no movement — the same gate that keeps right-**drag** panning) opens a
menu for whatever is under the pointer.

- **A part**: Cut / Copy / Rotate right / Rotate left / Delete.
- **A wire**: Delete wire — "Delete segment" once the selection is narrowed to one
  leg, which is the same command `Del` runs.
- **Bare canvas**: Paste (disabled while the clipboard is empty) and Select all.

Right-clicking a part or wire that is not already selected makes it the selection
first, so the menu acts on exactly what the user sees highlighted and the Inspector
follows it; right-clicking inside a multi-selection keeps the whole selection, and
the header says how many parts are involved. The item set is keyed off what was
_pointed at_, not off the selection, so a right-click on bare canvas never offers to
edit a part selected elsewhere on the sheet. Because a right-click on an instance
already jumps to its definition, the menu offers no "Open definition" duplicate.

The menu is an HTML overlay in screen coordinates, which is why `PointerInfo` grew
`clientX`/`clientY`: the world point alone cannot place it, and re-deriving the
camera transform outside `CanvasHost` would make the same mapping have two sources
of truth. `ToolMachine` reports the menu as plain state (`CanvasMenuState`) through
`onCanvasMenu`; App renders `CanvasMenu` and routes the pick back through the
editor's existing public commands, so the actions themselves invent nothing new.

## 76. The version history is a view now

Opening the history hides the editor row and hands the whole viewport to the
history: the version list and the comparison on the right, the previewed version on
the canvas beside it. Nothing sits _behind_ the preview any more — it used to be an
absolutely positioned rectangle over the dock, inset by a hard-coded
`HISTORY_DRAWER_W`, which is gone; it is a flex column now, and the drawer is a
column beside it rather than an overlay.

The comparison reads as a diff and can leave the app:

- Each change carries a kind, coloured with the palette's **own wire colours**
  (`--wire-high` / `--accent` / `--wire-x`), so it stays legible in every theme
  without adding a variable to all twelve. `diffEntries` is the source of those
  kinds, `diffLines` is kept for tests, and `diffText` is the whole comparison
  **uncapped**: the drawer list caps at 8 with a "…and N more" line, but a paste
  should not quietly lose changes.
- **Copy** puts that text on the real system clipboard through a small `copyText`
  helper — the async Clipboard API first, a hidden textarea when a context refuses
  it, and a toast either way saying which happened.
- On the canvas, the parts a version **adds or changes** get an accent outline, and
  the preview bar says how many. Two deliberate choices: it rides a new
  `SceneOverlay.changedIds` rather than the selection model (a selection also draws
  the rotate handle and the wire corner dots — affordances a read-only preview must
  not offer), and **removals are not marked at all**, because the part is not in the
  version being previewed. The canvas marks what it honestly can; the list carries
  the rest.

## 77. Terminals that follow the definition, and a marked scope

**Dynamic outer pins.** An instance's terminals were already re-derived from its
definition on every sync, so adding, renaming or resizing an inner pin was live.
Rotation was the gap, and the reason is worth recording: neither layer reads it. The
core derives a subcircuit's interface from `attrs.isOutput` ("True when this pin is
an output of its circuit"), the frontend agrees, and rotation is only a facing — so
rotating a port pin inside a definition changed nothing but the glyph.

Rotation now carries the pairing the palette already seeds (`INPUT` faces east,
`OUTPUT` faces west): rotating a `wiring.pin` sets `isOutput` from its new facing, so
a port rotated across west moves to the other side of every instance of that
circuit. One chokepoint does it — `applyRotation` is the shared op behind R, the
arrow keys and the floating rotate button — and the canonical form is kept: an
output writes `isOutput: true` and an input leaves the attribute out, exactly as the
palette does, so rotating a pin back and forth cannot leave a trail of
`isOutput: false` for the version diff to report as changes.

**Scope colours.** A subcircuit sheet is a different scope from the top level, and
now says so: a hue derived from the sheet's _name_ (stable across runs, spread so the
`sub2`/`sub3` the "+" tab makes do not look alike) colours the active tab, an overlay
frame around the canvas, and a chip in the status bar. Leaving the definition removes
all three. The top level deliberately has no scope mark, which is itself information.
The frame is an overlay rather than a border, so no drawing and no canvas baseline
moves.

## 78. A MOSFET for the transistor

`wiring.transistor` draws a symbol now instead of a plain box: a gate lead and its
plate on the left, the channel broken into three segments beside it (enhancement
mode), and the drain/source leads leaving the channel for the body's edges. It is
drawn inside the catalog's body rect, so it picks, routes, rotates and reports
exactly as before — only the drawing changes. Returning a `gateShape` also means it
draws its symbol _instead of_ a rect, which is the schematic look; power and ground
already work that way.

The geometry is pinned by a shape test rather than a screenshot, for the same reason
the power/ground glyphs are: no baselined circuit contains one, and a transistor is
too small at the baseline zoom for a pixel test to say anything useful about it.

## 79. An instance box that carries its own size

An instance's box was always derived: width 8, and height `2 ×` the larger pin count
(minimum 4), so a wide interface got a tall box whether or not that suited the
sheet. An instance may now carry `width`/`height` in grid units — offered as the
same one-click Width pickers every other dimension uses — with the derivation
still the default, which is what every existing file means (additive attrs, no
version bump).

Two rules, both checked rather than asserted in prose:

- **The pins are never crowded.** They sit at `(i+1)·h/(n+1)`, so the height _floor_
  for an explicit choice is what keeps them a grid unit apart — `max(4, n+1)` — not
  the roomy `2·n` the default gives. Asking for something shorter gets the shortest
  legal box.
- **Nonsense falls back.** A string, `0`, a negative number or anything past the
  400-unit cap gives the derived box rather than a broken layout, and a wider box
  moves the output pins to its new right edge.

The engine has to allow the attributes or a sized instance would not load — the
core's `AttrCheck` is what rejects unknown attrs — so `width`/`height` are in the
subcircuit's allowed set and range-checked like any other numeric attr. That split is
the existing one: the engine checks what it can see (`1..=400`), and the editor
clamps to the interface's floor, which needs the document to resolve.

## 80. A definition is a place: a home in the palette, and a way in and out

**The panel is always there.** The palette's Subcircuits group used to appear only
once the document had a second circuit — that is, only after you had already found
the "+" tab — which is backwards for a feature nobody has used yet. The rail always
carries it now, with an empty state that says what a subcircuit is for and its own
`+ New subcircuit` button. Each definition's tile also says where it is placed
(`used by main`, `not placed yet`) and updates as you place it.

**In and out.** Double-clicking an instance opens its definition — what "click into
the box" should obviously do; the right-click jump stays as it was, and it is the one
the e2e has pinned all along. Inside a definition a small scope bar sits at the top of
the canvas, carrying the way back, the sheet's name, and where it is used.

The parent is **derived, not remembered**: `instantiators()` (lib/subcircuit.ts) asks
the document which sheets place a given circuit, so "back to main" always names a
sheet that really instantiates the definition — rather than a navigation history that
goes stale the moment someone switches sheets by tab. The same helper is what the
palette's usage note reads, so the two can never disagree, and it is unit-tested on
its own (a definition used by two sheets, one used by none, and a pin that merely
shares the name).
