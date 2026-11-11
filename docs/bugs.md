# Bugs

**Current bugs only.** The log of everything found and fixed — every round, with its measurements
and its reasoning — is in [`bugs-archive.md`](bugs-archive.md). This file is what is *open now*.

---

## 1. A narrow pulse is swallowed where CE passes it (known divergence, deliberate)

A pulse narrower than a gate's `t_pd` is filtered by an inertial gate here and propagated by CE,
which has no time at all. `docs/bugs.md`'s archive has the history; the current statement is
`a_narrow_pulse_survives_a_wire_but_not_a_gate` in `crates/core/src/delay.rs`, and it is a
*decision* rather than a defect: our gate models the physics, CE models a tick.

## 2. OLED wires can vanish (display/GPU-specific, unconfirmed)

On some machines — reported on recent Macs with XDR displays and some Windows
devices — the **OLED** theme draws no visible wires on first load (parts and grid
are fine). Opening Settings and changing the theme makes them appear, rendered as
**black** strokes (visible against a non-black background). It cannot be
reproduced on the Linux/Chromium CI setup.

Two contributors are plausible and both are now mitigated:

- `Canvas2DRenderer` batches strokes and relies on `strokeStyle` changes taking
  effect between batches. WebKit (Tauri's macOS WKWebView) has had a canvas
  regression where consecutive stroke-state changes are cached/dropped, leaving
  paths stroked with the context default **black** — invisible on OLED's `#000`.
- `resolveTheme` passed CSS custom properties through verbatim. If a webview
  serializes a colour as `rgb(...)`/`color(...)` instead of the authored hex, the
  hex-only `mixHex`/`luminance` maths silently fell back to its `base` argument —
  for an idle wire, the **background** colour.

Shipped mitigation: **Dark** is now the default theme (existing `oled`
preferences migrate to Dark once), and `resolveTheme` normalizes every palette
colour to `#rrggbb` (regression-tested). OLED remains selectable. If the symptom
recurs, the next step is to defeat the webview stroke-state cache in
`Canvas2DRenderer` (e.g. a tiny per-batch `lineWidth` nudge) or drop the OLED
option entirely.

## 3. Documentation gaps (not lies — omissions)

- `docs/autograder.md` §1 does not list the `csim nets` subcommand (a conversion-debugging
  aid), and §5 does not document the test-spec fields `pause_on_unknown` /
  `pause_on_breakpoints` — their CLI flags *are* listed, and `pause_on_breakpoints` also
  appears in §3's `halt_reason` note.

## 4. Editor UX backlog — 2026-11-11 review

Actionable checklist from the current editor review. Decisions made in the review are
recorded with each item so implementation does not need to re-litigate them.

### 4.1 Width mismatch flashes but shows no error

- [x] **Show the actual error, not only a blink.** Done: a steady ⚠ badge sits at the
  net's midpoint, and the hover card explains the disagreeing widths.
  - Today: `DocScene` computes the conflicting net widths and flashes the wire halo
    (`frontend/src/editor/docScene.ts:1026-1031`, `:1489-1500`). The code comment promises a
    per-net ⚠ badge, but no badge is drawn. The only text is the Inspector note, and only when
    that exact wire is selected (`frontend/src/components/InspectorPanel.tsx:231-237`).
  - Wanted: a visible diagnostic near the offending wire/pin (badge or marker) plus the full
    message. Keep the Inspector detail.
  - Acceptance: a mismatched wire is identifiable without selecting it, and the message names
    the disagreeing widths and (where possible) the pins.

### 4.2 Hovering a flashing warning explains it

- [x] **Hover diagnostics for warnings.** Done: `warningAt` resolves mismatch, dangling
  pin, and open wire end; the hover card explains the one under the pointer.
  - Today: hover deliberately ignores plain wires (`frontend/src/editor/tools.ts:1009-1020`);
    pins show only a name/width and components only a truncated readout
    (`frontend/src/editor/docScene.ts:2496-2535`).
  - Wanted: hovering a flashing wire, a dangling pin, a free wire end, or a component with
    dangling pins shows the error/potential error. Keep the card readable while the item blinks
    (pause the blink on hover or draw a steady hover outline).
  - Acceptance: every blinking warning has a hover explanation, including with the animation
    preference off.

### 4.3 Default CLK/RST sources spawn on top of each other

- [x] **Give the default clock and reset sources distinct, free positions.** Done: a
  clearance-aware slot search places them apart and the router leaves the body cleanly.
  - Root cause: `applyClockDefaults` creates both missing sources at the SAME fixed offset —
    root `[placed.x, placed.y - 6]` for both `wiring.clock` and `wiring.reset`
    (`frontend/src/editor/clockDefaults.ts:111-116`), subcircuit `[placed.x - 8, placed.y]`
    for both `CLK` and `RST` ports (`:123-133`).
  - Wanted: distinct slots with spacing; never overlap each other, a component body, or a
    wire. Prefer the control-pin side (registers/RAM have `clk`/`rst` on the bottom) so the
    default wire does not cross the body; use clearance-aware routing rather than the current
    raw Manhattan L.
  - Acceptance: placing a register in an empty sheet gives two separated sources and two
    readable wires, all in one undo step; same for a subcircuit's `CLK`/`RST` ports.

### 4.4 Splitter editor: ranges, direction, totals, ordering

- [x] **Improve the splitter UI without changing the `.csx` format.** Done: names are
  hidden, rows are ordered by bus bit, ranges accept both directions, and the two totals
  sit at the top. Invalid edits are not written to the document.
  - Decisions: do **not** change the file format; do **not** expose pin names to users. Keep
    the internal `splits` map/arrays, use generated opaque names, and order rows sensibly in
    the UI. A comma-separated display is fine; ranges are the real missing feature.
  - Add two numbers at the **very top** of the editor: **bus width** (total bits) and
    **output count**.
  - Support ranges with direction: `0-3` = `[0,1,2,3]`, `7-4` = `[7,6,5,4]`. Canonicalize the
    display back to ranges; accept mixed lists such as `0-3, 8, 12-15`.
  - Add live coverage validation: every bit mapped exactly once, with missing/duplicate bits
    named. Do not silently write an invalid mapping.
  - Auto-order rows in a meaningful way; auto-fill the next uncovered run for a new row.
  - Add convenience actions such as even distribution and “fill the remaining bits” (presets
    optional).
  - Acceptance: a user can change the total width/output count, type ranges in either
    direction, and see a valid/invalid summary without ever choosing a pin name.

### 4.5 macOS folder-access permission keeps re-prompting

- [x] **Stop the repeated macOS TCC folder-access prompt on save.** Done: the app is
  signed with a stable self-signed certificate (see `scripts/macos-signing.sh` and the
  release workflow), so TCC's grant is tied to the certificate's identity instead of the
  binary's cdhash. The app is still not notarized; the "Open anyway" workaround remains.
  - Confirmed in review: the prompt is macOS's folder-access permission dialog (not the
    in-app save dialog or the disk-conflict banner), and it keeps re-appearing.
  - The app writes through the Tauri shell (`std::fs`) and is not sandboxed; TCC ties the
    grant to the app's identity/path. Unsigned or dev builds can look like a new app each time.
  - Fix: a stable self-signed certificate (not a paid Apple Developer ID) gives the app a
    stable code-signing identity. TCC stores the certificate's designated requirement, so
    rebuilding the app does not invalidate the folder grant.
  - Acceptance: after the first grant, saving to the same folder does not prompt again.
  - Test: `node scripts/check-signing.mjs` (part of `node scripts/build.mjs check`)
    verifies the certificate import, the signing identity, and the folder-usage
    descriptions in the app bundle.

### 4.6 Copy/paste a register loses its default CLK/RST wiring

- [x] **Reconnect copied clocked parts to the existing clock/reset source.** Done:
  `copySelection` records the default clock/reset of a copied clocked part, and
  `paste` reconnects it to the destination's existing source in the same undo
  step. A custom-logic source is not copied and is not reconnected, so the pin
  stays dangling with a warning instead of silently moving to the global clock.
  - Today: `copySelection` drops any wire whose other endpoint is outside the selection
    (`frontend/src/editor/tools.ts:1521-1570`), so copying a register alone loses `clk`/`rst`.
    `document.paste` does no default wiring (`frontend/src/model/document.ts:623-689`); only
    placement calls `applyClockDefaults`.
  - Wanted: after paste, connect an unwired `clk`/`rst` to the existing `wiring.clock` /
    `wiring.reset` (or the subcircuit's `CLK`/`RST` port) in the same undo step. Skip pins that
    already have a copied wire; never duplicate a source.
  - Preserve intent: if the original `clk`/`rst` came from custom logic and that logic was not
    copied, leave it dangling with a warning rather than silently rewiring it to the global
    clock.
  - Acceptance: copy a register alone, paste it, and it still has both control connections
    without creating a second clock/reset source.
  - Test: `frontend/src/editor/clockDefaults.test.ts` covers reconnection, the
    custom-logic case, and the one-undo-step rule.

### 4.7 Arrow keys must not flip a pin's input/output direction

- [ ] **Decouple a `wiring.pin`'s direction from its rotation.**
  - Today: `rotatedComponent` rewrites `attrs.isOutput` when a pin's rotation becomes `W`
    (`frontend/src/model/document.ts:1329-1349`). Arrow keys call `setRotation`, and `R` calls
    `rotateComponents`; both go through that helper. So pressing left/right both rotates the
    pin and changes whether it is an input or an output — unclear, and it prevents rotating a
    pin without changing its direction.
  - Wanted: arrow keys and `R` change only the visual facing/rotation. Direction is changed
    explicitly (Inspector control and/or the palette's INPUT/OUTPUT tiles).
  - Acceptance: rotating a pin through all four facings never changes its `isOutput` value;
    a subcircuit instance's port side still follows the pin's actual direction.

### 4.8 Later / parked idea

- [ ] **Splitter bit-ruler visualizer (deferred).** One cell per bus bit, coloured by its split
  output, with click/drag assignment. Explicitly parked for later; do the range-based editor
  first.
