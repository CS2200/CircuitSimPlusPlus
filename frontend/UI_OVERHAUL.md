# UI Overhaul — Pan Gestures, OLED Themes, Right-Dock Inspector

**Status:** planned (2026-10-15, human-directed). Frontend-owned document:
`DESIGN.md` and `docs/tasks/**` are human-only, so the three UX decisions below
are recorded here until the human folds them into `DESIGN.md` §7.1.

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
| Rotation, gate type, selects, checkboxes          | Immediately                                                      |

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
