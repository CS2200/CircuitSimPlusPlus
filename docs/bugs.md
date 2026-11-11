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
