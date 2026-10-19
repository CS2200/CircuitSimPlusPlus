# CircuitSim++ — Bug & Task Backlog

*Triaged 2026-10-18 against `master` @ `5deed81`. **Phase 1 (P0) landed @
`0462adf`; P1 and P2 since** — two P2 items were clarified 2026-10-19 (wire
segment deletion, one Clear) and are open below. The trial tester's raw list was verified item-by-item
against the code; already-fixed, by-design, and out-of-scope entries live in the
appendices so the active list stays honest.*

**Current state (2026-10-19):** contract **v1.2**, file format **v4** (registers
and RAMs have no `rst` pin), 200 backend + 343 unit + 64 e2e tests green. The
committed `.csx` fixtures are gated against their generators in CI
(`node scripts/build.mjs fixtures`), and the specs were re-audited against the
code the same day — `DESIGN.md`, `docs/format-v2.md`, `docs/ipc.md`,
`docs/autograder.md`, `docs/delay-table.md`, `docs/tasks/**`, `README.md`, the
frontend planning docs, and the source comments that restated them.

**Priority:** **P1** course-facing · **P2** UX polish (small) · **P3** feature
(sizeable) · **?** needs info.

---

## Latest round — done (2026-10-19)

- **Text annotations load again.** `misc.text` had no behavior, and the builder
  treats a missing behavior as a hard load error — so *placing a text label made
  the document unloadable*. It now has an inert `BehaviorKind::Text` (no pins, no
  evaluation), with a delay-engine test that loads a document containing one and
  runs it. *(commit `c42533f`)*
- **Settings spacing.** The 24-hour clock toggle sat directly under the accent
  swatches with only its bottom margin; `.accent-row + .settings-toggle` now
  carries top spacing. *(commit `c42533f`)*
- **The `rst` pin is gone, format-wide** — the item the previous two attempts
  reverted. `mem.register` is `d, clk, en, q` and `mem.ram` is
  `addr, din, dout, we, clk` in engine, format, fixtures, tests, frontend and
  docs. The pin only ever existed because the old simulator had no RAM autoload:
  a canvas button wired into every register's reset was how a circuit restarted.
  Both replacements exist now — memory autoload on load/reset, and the
  transport's **reset** (Ctrl+R) — so the pin was dead weight, and a reset trace
  across a schematic hid what the clock was doing. *(commit `72b8473`)*
- **…and that break is migrated, not just declared** *(this round)*: the format
  is now **v4** (`FORMAT_VERSION`), with a v3 → v4 migration that drops wiring to
  the retired pins — including wires *junctioned onto* a dropped wire, the
  fan-out shape a shared reset produced — and renumbers the surviving `join`
  targets. The steps chain, so a v2 file (which also predates v3 but used `rst`
  too) is walked v2 → v3 → v4 in one load. A circuit saved by the tester before
  this change still opens. The frontend mirrors the chain, and the fixtures were
  regenerated at v4 with a golden test asserting they never lag the version
  (otherwise the suite would quietly test the migration path instead of today's
  parser). *(this round)*

---

## Phase 1 — done (P0 correctness)

- **#1/#2 Pin names now match the engine.** The editor's adder carry was
  `c_in`/`c_out` (the core knows `cin`/`cout`) and the decoder's select was a
  1-bit `sel` (the core knows a bus `in`); wires on those pins were *rejected at
  load*, so carries and decoders could not be wired at all. Editor now mirrors
  the engine registry (format-v2 §4): `cin`/`cout`, subtractor `bin`/`bout`,
  divider `quot`/`rem`, decoder `in` (`inputBits` wide), and `sel`/`amt` carry
  their real widths. Guarded by unit tests. *(commit `da11b5b`)*
- **#3 Editing no longer reboots the sim.** The live re-sync compared the
  document revision, so dragging a part or bending a wire reloaded a fresh
  power-on — clocked state cleared and the cycle counter jumped to 0. `isStale`
  now compares a **netlist fingerprint**, so only an edit the core cares about
  reloads. *(commit `bf41341`)*
- **#3(b) The clock no longer "lights up" on an edit.** An unwired clock fell
  back to `cycle % 2` for its body fill; a reload put the cycle at 0 → painted
  HIGH (dark green). The fallback now only fires after a rising edge, so an idle
  clock draws its neutral wave. *(commit `bf41341`)*
- **#5 Intermittent execution (reload race) fixed.** Overlapping loads could
  both apply their initial diff batches; loads are now serialized so the newest
  resets and loads last. *(commit `bf41341`)*
- **#4 `Ctrl+J` force-stops the clock** before stepping (a step while playing
  was a no-op), matching the transport's "tick" button. *(commit `0462adf`)*
- **#6 Probe rotates.** A N/S probe was drawn with an east-facing body offset
  from its swapped rect; it now rotates like the gate shapes. *(commit
  `0462adf`)*
- **#11 Long pin names ellipsize** (subcircuit instance labels) so they cannot
  spill across the box. *(commit `0462adf`)*

---

## P1 — Course-facing correctness — DONE (one decision left)

All four actionable items landed; the last is a format decision.

- **Probe width auto-match on connect** *(commit `9ba29da`)*: a wire landing on a
  probe's `in` sets its `bitsize` from the driver.
- **Explicit unnamed-pin warning** *(commit `32db2f0`)*: the Inspector says why
  an unnamed `wiring.pin` stops the file loading.
- **Register readout with an open `q`** *(commit `471a911`)*: a test settled that
  the engine was never at fault (`632f6e3`), so the fix was to get the engine's
  stored state to the UI. IPC **v1.2** adds `NamedComponent.value_net` — the
  engine nets every pin, so the readout works with the output unwired. That also
  repaired the Watch panel's RAM/ROM entry (it looked for a `q`, which RAMs do
  not have) and lets a subcircuit component be watched.
- **Real short-circuit alerts** *(commit `0b6035c`)*: `HaltReason::Contention` is
  never emitted and DESIGN.md §4.1 wants `X` plus a shorted-wire highlight, so
  there was no alert at all. IPC **v1.2** adds `NetChange.contended`, set only
  when a net's `X` is a genuine driver fight; the sim bar now says
  *"⚠ Short circuit — N nets driven both high and low…"*.

### Decided: pin names stay lowercase (no rename)
The tester asked to capitalize pin names (`AMOUNT`, `CARRY_IN`, …). Decision
(2026-10-18): **leave them alone.** Ordinary pins are not labelled on the canvas
(they are dots), so the change is almost entirely a *format* change — pin names
are wire-endpoint keys in `.csx`, and the fixtures and autograder use them
(`amt`, `cin`, …). Revisit only if the tester asks again and it turns out to
matter; it would need a format-version bump plus fixture/demo/golden
regeneration.

---

## P2 — UX polish

**Done:** the cycle input is typed (`cycle #`, no steppers) *(70f6eb4)*; the
**wiring hint** sits in the status bar and timestamps have a **12-/24-hour**
preference *(93c93ea)*; a **bottom zoom slider** on the canvas *(6227196)*; palette
tooltips name the part *(70f6eb4)*; sheet-tab right-click → Rename *(70f6eb4)*;
Reload-from-Disk confirms first *(70f6eb4)*; the `named` history pill is gone
*(70f6eb4)*; the header light/dark toggle is gone — Settings is the single path
*(e7aaff3)*; **saving with validation errors** — the engine now writes the draft
and returns the problems as warnings, and the toast says so and points at
Version history; only an unparseable document is still refused; the save
indicator reads **"Saved"** / **"Saving changes"** instead of
"All changes saved" / "Unsaved changes".

**Resolved from the ambiguous list (2026-10-19, human-confirmed):**

- **"Simplify the reset label"** *was* the reset pin: the memory parts have no
  reset input at all any more (format v4 — see the latest round above), so there
  is no label to simplify. Done, not parked. *(72b8473)*
- **Light-mode history colours** were reconciled by the dynamic contrast helper
  (`readableOn`, *(3fcf504)*): an authored colour that would wash out against the
  light background falls back to the theme's text colour. The drawer's previews
  render through the same `DocScene`, so they inherit it.
- **"Text element load-failed bug"** was real after all and is fixed — `misc.text`
  had no behavior, so placing one made the document unloadable *(c42533f)*.
  Removed from Appendix A.

**New tester feedback (fixed this round):** a memory's `addr` pin was as wide as
its DATA (a fresh RAM drew a 1-bit address while the core indexed 256 words, so a
correct 8-bit address looked like a mismatch) *(028ffc7)*; a constant's readout
now scales with its bit width (`0x5` → `0x05`) *(028ffc7)*; a wired-up part's
unconnected INPUTS blink red *(a4a7291)*; and a RAM/ROM previews the word at its
address *(8879681)*.

**Reported 2026-10-19 (maintainer, from the canvas):**

- **A MUX/DEMUX carries no mark.** UI_OVERHAUL §17 rule 3 lists `MUX`/`DEMUX`
  among the abbreviations a body shows, but `docScene` suppresses the caption
  for *shaped* bodies ("shaped bodies have no caption", §24's pass) — and a
  trapezoid is far less self-evident than a NAND gate, which is why the note
  exists. Evidence: the committed demo baseline draws the mux as a bare
  trapezoid. Fix: keep the suppression for gates and draw the abbreviation on
  plexer trapezoids (and re-bless the visual baselines).
- **Body marks read as "off"** — *diagnosed* (screenshot + measurement). At the
  maintainer's zoom the adder's `+` sits ~0.47 world units below its box centre
  and ~0.22 left; in the committed demo baseline (default zoom) the same `+`
  measures centred. So it is **zoom-dependent**, which rules out the layout: the
  mark is drawn at `layout.rect`'s centre (`docScene.ts:1284`) with
  `textBaseline = "middle"` (`render/canvas2d.ts:115`).

  **Cause:** the renderer sets `ctx.font = \`${size}px …\`` where `size` is in
  *world* units (≈1 for a mark) and relies on the camera transform to scale the
  glyph up (~60× when zoomed in). Font metrics are quantized at that ~1px size,
  so "middle" is off by a fraction of a *world* pixel — invisible when zoomed out,
  and multiplied by the zoom when zoomed in. Bigger marks and closer zooms make
  it worse, which is exactly "everything's logo is off".

  **Fix:** draw text in device space at the final pixel size — read the live
  transform in the flush loop (`ctx.getTransform()`), reset it, set
  `font = size × scale`, and place the glyph at the transformed point (or set an
  explicit alphabetic baseline offset). Then re-bless the visual baselines (every
  text draw shifts a hair).

**Clarified 2026-10-19 (real, being worked):**

- **"Recover unsaved work" was the wrong half of the mechanic** *(maintainer,
  fixed this round)*: it offered recovery after *clean* closes too. The app now
  asks when the window is closed — **Save / Don't save / Cancel** — and any
  resolved decision ends the recovery copy, so the launch dialog means "the last
  session ended without closing" (a crash). *(this round)*

- ~~**Wire segment deletion is all-or-nothing**~~ *(fixed this round)*: a second
  click narrows the selection to the piece under the cursor — a branch wire
  hanging off the trunk at that segment, or the segment itself — so Delete takes
  only that. A branch survives its trunk; a segment delete drops the bend the
  wire turns at (shortening it), and a wire with no bends is just that segment,
  so it goes entirely. Junction dependents follow the new geometry. *(this
  round)*
- **One Clear, inside the memory editor.** The Inspector's `Clear` (it drops the
  `autoload` file reference) is unnecessary beside the editor's `Clear all`; the
  editor is the single place to clear, and `Clear all` takes the autoload file
  with it so the capability is not lost. *(this round)*

**Left (optional; maintainer's call):**
- **Wires**: a *per-wire* colour palette, if identity colours are wanted back.
  The default is one bus colour with no net-id dependency *(66f46e0)*, and a
  wire's own `attrs.color` already wins.
- **"Tidy tab / timing-readout alignment"** — no repro was ever supplied; fold
  into the P3 tab/context-menu work if it turns up again.

---

## P3 — Features (sizeable; schedule deliberately)

**Done:** a memory's width is picked, not typed. Both the **Address Bits**
(`addrBits`) and **Data Bits** (`bitsize`) are the same one-click grid every
other width uses, and the address pick sizes the memory too (`depth =
2^addrBits`, trimming an over-long image) — the free-text **Words** field is
gone. Defaults derive from `depth`, so nothing existing changed; additive, so no
format bump. *(this round)*

- ~~Export the canvas/circuit as an image~~ *(done this round)*: File → **Export
  view as PNG…** writes what the canvas is showing — a real file through the
  shell (`save_image`, which decodes the data URL), a download in the browser —
  named `<document>-view.png` so it can sit beside its `.csx`. The pixels are the
  renderer's, so the canvas element is the source; the export is the *current
  view* (fit-the-whole-circuit export is a follow-up).
- Right-click context-menu overhaul.
- Version history: full-viewport view (no overlay), diff highlighting + copy.
- Subcircuits: always-visible panel, click into an *instance* vs template,
  scope colors, resizing, dynamic outer pins from inner pin rotation.
  **Delete a sheet tab** is already there — the tab's right/middle-click menu
  (`Rename…` / `Delete`, guarded against deleting a sheet with parts, with the
  active sheet re-pointed) and its e2e test predate this list.
- Primitives: **power and ground done** (`wiring.power` / `wiring.ground` — fixed
  1-bit sources with no attrs, additive so no format bump; UI_OVERHAUL §71). A
  **transistor** (a gate-driven switch: `in`/`gate`/`out`) still needs a behaviour
  kind (and a sink kind in the delay engine for its halt message to name `gate`,
  not `en`). Bar/rake glyphs landed (UI_OVERHAUL §72, pinned by a shape test).
- ~~Propagation-delay readout~~ **done**: the Inspector shows the selected part's
  own cost from the published table (`crates/core/data/cs2200-74ls-v1.json`, read
  at build time so the numbers cannot drift — `prop 20 ns · setup 15 ns · hold
  5 ns` for a register), and a selected *wire* shows its per-path delay (drawn
  length × the table's 0.1 ns/unit). Both are **design** numbers; the transport's
  `T_obs`/`top_paths` stay the measured ones.
- ~~Animation pulse-rate slider~~ **done**: Settings → Canvas has a **Pulse speed**
  picker (50…200%); the pref is a percentage, and `PulseTracker` takes its
  duration from it, so the whole bullet is closed.

---

## Appendix A — Needs info (can't reproduce / ambiguous)

- **"Intermittent general circuit execution bug"** — believed fixed by the
  reload-race fix (`bf41341`) (the tester's read too); re-open with a repro if it
  ever recurs.

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
- **"Remove 'Named' bubble"** — read as the history `named` badge, which is gone
  *(70f6eb4)*; recorded in the P2 list.
- **"Reposition 'Restore Version' tab to the far right"** — this meant the
  *History* tab's "Restore this version" / "Back to current" bar, which sat
  misaligned at the top; fixed by unrelated work.
- **"Make cycle counting continuous"** — fixed by the same netlist-fingerprint
  work as Phase 1's edit fix (`bf41341`): geometry-only edits no longer reset the
  counter. A *topology* change still reboots the engine, by design — surviving
  even that would need a `startCycle` in the load contract.
- **"Polish application logo"** — subjective, not actionable.
- **"Support floating-point resistors"** — there is no resistor part, and a
  digital net is 0/1/Z/X. Clarify what's wanted.

---

## Notes for the next rounds (2026-10-19)

Two plans, written down so the rounds are mechanical. Neither is a promise about
scope — they are what I would do, in this order.

### The transistor (P3 primitives, the last piece)

It must name its control pin **`gate`**, and that name is what a halt reports and
the UI highlights — so it **cannot** reuse the controlled buffer's behaviour arm,
which hardcodes `consume(en, "en")`. A transistor that halted saying `pin "en"`
would name a pin the part does not have, and the canvas would highlight nothing.

**Checked, and this makes it smaller than feared:** `delay.rs`'s `SinkKind` is
derived from the **pin name** (`SinkKind::from_pin`), so a `gate` pin already maps
to `SinkKind::Other` — no enum variant, no timing-table entry, no delay-engine
change. The work is: a `CompKind` shape (its own variant, or a control-name field
on the buffer's), a `BehaviorKind` mirroring `ControlledBuffer`'s arm with
`"gate"`, the registry arm (`in`/`gate`/`out`, `bitsize` only), catalog + palette +
`typeDisplayName`, docs, and a behaviour test asserting that a floating gate halts
naming `gate` — the assertion that motivates the whole thing. The compiler names
every exhaustive `CompKind` match the new variant breaks; that is the loop.

### The measured per-part delay (IPC change authorized 2026-10-19)

- **Engine:** the delay engine already reschedules a gate's commit per input event,
  so it can record each component's last committed transition magnitude
  (`commit_time − input_arrival`) into a `Vec` plus an accessor. That is the number
  students ask about: not the table's design cost, but what the part actually took.
- **Contract (v1.3, additive):** a `delays: [{ comp_id, ns }]` array on the existing
  `timing_update` event — no new round trip, since the UI already merges that event
  after each run/pause. `docs/ipc.md` gains a v1.3 stanza; `api.rs` and `types.ts`
  the field. Strictly additive, so nothing existing changes meaning.
- **UI:** the Inspector's Delay row grows a second half — `Design 10 ns · Observed
  12.4 ns` — and shows the design number alone until a run has produced one.
- **Tests:** engine (recorded, deterministic), the contract shape, the store merge,
  the Inspector display, and an e2e (run, select a gate, expect "Observed").

### Still queued behind those

The canvas context-menu overhaul (right-click currently pans; needs the
click-versus-drag split plus per-target actions), the version-history full-viewport
view with diff highlighting and copy (the structural diff already exists), and the
subcircuit panel work (always-visible panel, instance-versus-template scope, scope
colours, resizing, dynamic outer pins).
