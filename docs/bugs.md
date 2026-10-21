# CircuitSim++ — Bug & Task Backlog

_Triaged 2026-10-18 against `master` @ `5deed81`. **Phase 1 (P0) landed @
`0462adf`; P1 and P2 since** — two P2 items were clarified 2026-10-19 (wire
segment deletion, one Clear) and are open below. The trial tester's raw list was verified item-by-item
against the code; already-fixed, by-design, and out-of-scope entries live in the
appendices so the active list stays honest._

## Latest round — done (2026-10-21)

- **The reset pin is back, hidden by default** (§93): `mem.register` /
  `mem.ram` carry `clk` and `rst` again, visible only when `showClk` /
  `showRst` says so, with an unwired `rst` reading deasserted and an unwired
  `clk` following the circuit's clock. The breakpoint's pinout became
  CircuitSim CE's `BreakpointPeer`. _(commit `7f661a9`; `UI_OVERHAUL.md` §93,
  `docs/format-v2.md` §4/§9.)_
- **Three engine rules the conversion exposed** (all in `delay.rs`, all stated
  in format-v2 §9): a memory's asynchronous read **waits** on an address that is
  still in flight (a `Z` on a net that *has* a driver pin) instead of halting a
  settling design at power-on; the cycle-close sweep uses the same test, so only
  a net with no driver pin at all is a floating read; and a memory **preload**
  (`--load`, `autoload`) is a write, so it no longer fails on an unsettled
  address. Each has a test; the golden hashes and the negative fixtures are
  unchanged.

## The reset pin's semantics (decided 2026-10-21)

`mem.register`/`mem.ram` have `rst` and `clk` again, hidden unless `showClk`/`showRst`
(UI_OVERHAUL §93). Our reset is **synchronous** — it clears on a rising edge, and wins over
a simultaneous enable — which is the right reading of a D flip-flop. CircuitSim CE's `Clear`
is *asynchronous* (level-triggered: it zeroes the part on any input change while asserted),
so the two differ for a reset pulse shorter than one clock; a reset held across an edge
behaves the same in both, which is how the old schematic is drawn and how the converted
LC-5200 uses it. Recorded here rather than "fixed", because the synchronous behaviour is
deliberate.

**Backlog (P3): more register types in the Memory palette.** A D *latch* (level-sensitive,
transparent while enabled) and possibly a transparent-latch RAM variant would cover designs
that want asynchronous/level behaviour instead of ours (and would make an asynchronous
reset a property of a *type* rather than of the flag). Nothing depends on it yet.

**Current state (2026-10-21):** contract **v1.2**, file format **v5** (registers
and RAMs have their `rst`/`clk` pins back, hidden unless `showClk`/`showRst` says
otherwise — UI_OVERHAUL §93), **213 backend + 445 unit + 80 e2e** tests green. RAM powers
on unknown (§9 of the format doc, below), registers still on 0 pending the Head TA. The
priority decoder gained CircuitSim CE's enable chain (`en_in`/`en_out`, `valid` as CE's
Group Signal, `out` = `X` when nothing wins) so the class's cascaded encoder — the
forwarding unit's — is representable; see UI_OVERHAUL §88 and format-v2 §4/§9. The
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
  treats a missing behavior as a hard load error — so _placing a text label made
  the document unloadable_. It now has an inert `BehaviorKind::Text` (no pins, no
  evaluation), with a delay-engine test that loads a document containing one and
  runs it. _(commit `c42533f`)_
- **Settings spacing.** The 24-hour clock toggle sat directly under the accent
  swatches with only its bottom margin; `.accent-row + .settings-toggle` now
  carries top spacing. _(commit `c42533f`)_
- **The `rst` pin is gone, format-wide** — the item the previous two attempts
  reverted. `mem.register` is `d, clk, en, q` and `mem.ram` is
  `addr, din, dout, we, clk` in engine, format, fixtures, tests, frontend and
  docs. The pin only ever existed because the old simulator had no RAM autoload:
  a canvas button wired into every register's reset was how a circuit restarted.
  Both replacements exist now — memory autoload on load/reset, and the
  transport's **reset** (Ctrl+R) — so the pin was dead weight, and a reset trace
  across a schematic hid what the clock was doing. _(commit `72b8473`)_
- **…and that break is migrated, not just declared** _(this round)_: the format
  is now **v4** (`FORMAT_VERSION`), with a v3 → v4 migration that drops wiring to
  the retired pins — including wires _junctioned onto_ a dropped wire, the
  fan-out shape a shared reset produced — and renumbers the surviving `join`
  targets. The steps chain, so a v2 file (which also predates v3 but used `rst`
  too) is walked v2 → v3 → v4 in one load. A circuit saved by the tester before
  this change still opens. The frontend mirrors the chain, and the fixtures were
  regenerated at v4 with a golden test asserting they never lag the version
  (otherwise the suite would quietly test the migration path instead of today's
  parser). _(this round)_

---

## Phase 1 — done (P0 correctness)

- **#1/#2 Pin names now match the engine.** The editor's adder carry was
  `c_in`/`c_out` (the core knows `cin`/`cout`) and the decoder's select was a
  1-bit `sel` (the core knows a bus `in`); wires on those pins were _rejected at
  load_, so carries and decoders could not be wired at all. Editor now mirrors
  the engine registry (format-v2 §4): `cin`/`cout`, subtractor `bin`/`bout`,
  divider `quot`/`rem`, decoder `in` (`inputBits` wide), and `sel`/`amt` carry
  their real widths. Guarded by unit tests. _(commit `da11b5b`)_
- **#3 Editing no longer reboots the sim.** The live re-sync compared the
  document revision, so dragging a part or bending a wire reloaded a fresh
  power-on — clocked state cleared and the cycle counter jumped to 0. `isStale`
  now compares a **netlist fingerprint**, so only an edit the core cares about
  reloads. _(commit `bf41341`)_
- **#3(b) The clock no longer "lights up" on an edit.** An unwired clock fell
  back to `cycle % 2` for its body fill; a reload put the cycle at 0 → painted
  HIGH (dark green). The fallback now only fires after a rising edge, so an idle
  clock draws its neutral wave. _(commit `bf41341`)_
- **#5 Intermittent execution (reload race) fixed.** Overlapping loads could
  both apply their initial diff batches; loads are now serialized so the newest
  resets and loads last. _(commit `bf41341`)_
- **#4 `Ctrl+J` force-stops the clock** before stepping (a step while playing
  was a no-op), matching the transport's "tick" button. _(commit `0462adf`)_
- **#6 Probe rotates.** A N/S probe was drawn with an east-facing body offset
  from its swapped rect; it now rotates like the gate shapes. _(commit
  `0462adf`)_
- **#11 Long pin names ellipsize** (subcircuit instance labels) so they cannot
  spill across the box. _(commit `0462adf`)_

---

## P1 — Course-facing correctness — DONE (one decision left)

All four actionable items landed; the last is a format decision.

- **Probe width auto-match on connect** _(commit `9ba29da`)_: a wire landing on a
  probe's `in` sets its `bitsize` from the driver.
- **Explicit unnamed-pin warning** _(commit `32db2f0`)_: the Inspector says why
  an unnamed `wiring.pin` stops the file loading.
- **Register readout with an open `q`** _(commit `471a911`)_: a test settled that
  the engine was never at fault (`632f6e3`), so the fix was to get the engine's
  stored state to the UI. IPC **v1.2** adds `NamedComponent.value_net` — the
  engine nets every pin, so the readout works with the output unwired. That also
  repaired the Watch panel's RAM/ROM entry (it looked for a `q`, which RAMs do
  not have) and lets a subcircuit component be watched.
- **Real short-circuit alerts** _(commit `0b6035c`)_: `HaltReason::Contention` is
  never emitted and DESIGN.md §4.1 wants `X` plus a shorted-wire highlight, so
  there was no alert at all. IPC **v1.2** adds `NetChange.contended`, set only
  when a net's `X` is a genuine driver fight; the sim bar now says
  _"⚠ Short circuit — N nets driven both high and low…"_.

### Decided: pin names stay lowercase (no rename)

The tester asked to capitalize pin names (`AMOUNT`, `CARRY_IN`, …). Decision
(2026-10-18): **leave them alone.** Ordinary pins are not labelled on the canvas
(they are dots), so the change is almost entirely a _format_ change — pin names
are wire-endpoint keys in `.csx`, and the fixtures and autograder use them
(`amt`, `cin`, …). Revisit only if the tester asks again and it turns out to
matter; it would need a format-version bump plus fixture/demo/golden
regeneration.

---

## P2 — UX polish

**Done:** the cycle input is typed (`cycle #`, no steppers) _(70f6eb4)_; the
**wiring hint** sits in the status bar and timestamps have a **12-/24-hour**
preference _(93c93ea)_; a **bottom zoom slider** on the canvas _(6227196)_; palette
tooltips name the part _(70f6eb4)_; sheet-tab right-click → Rename _(70f6eb4)_;
Reload-from-Disk confirms first _(70f6eb4)_; the `named` history pill is gone
_(70f6eb4)_; the header light/dark toggle is gone — Settings is the single path
_(e7aaff3)_; **saving with validation errors** — the engine now writes the draft
and returns the problems as warnings, and the toast says so and points at
Version history; only an unparseable document is still refused; the save
indicator reads **"Saved"** / **"Saving changes"** instead of
"All changes saved" / "Unsaved changes".

**Resolved from the ambiguous list (2026-10-19, human-confirmed):**

- **"Simplify the reset label"** _was_ the reset pin: the memory parts have no
  reset input at all any more (format v4 — see the latest round above), so there
  is no label to simplify. Done, not parked. _(72b8473)_
- **Light-mode history colours** were reconciled by the dynamic contrast helper
  (`readableOn`, _(3fcf504)_): an authored colour that would wash out against the
  light background falls back to the theme's text colour. The drawer's previews
  render through the same `DocScene`, so they inherit it.
- **"Text element load-failed bug"** was real after all and is fixed — `misc.text`
  had no behavior, so placing one made the document unloadable _(c42533f)_.
  Removed from Appendix A.

**New tester feedback (fixed this round):** a memory's `addr` pin was as wide as
its DATA (a fresh RAM drew a 1-bit address while the core indexed 256 words, so a
correct 8-bit address looked like a mismatch) _(028ffc7)_; a constant's readout
now scales with its bit width (`0x5` → `0x05`) _(028ffc7)_; a wired-up part's
unconnected INPUTS blink red _(a4a7291)_; and a RAM/ROM previews the word at its
address _(8879681)_.

**Reported 2026-10-19 (maintainer, from the canvas):**

- **A MUX/DEMUX carries no mark.** UI_OVERHAUL §17 rule 3 lists `MUX`/`DEMUX`
  among the abbreviations a body shows, but `docScene` suppresses the caption
  for _shaped_ bodies ("shaped bodies have no caption", §24's pass) — and a
  trapezoid is far less self-evident than a NAND gate, which is why the note
  exists. Evidence: the committed demo baseline draws the mux as a bare
  trapezoid. Fix: keep the suppression for gates and draw the abbreviation on
  plexer trapezoids (and re-bless the visual baselines). **Resolved for the canvas**
  _(§68)_; the **palette icon** half had not landed — the maintainer's screenshot shows
  MUX/DEMUX still drawing bare trapezoids in the Plexers palette while DEC/PRI showed
  their word. Both now read one predicate (`showsBodyCaption`, UI_OVERHAUL §83), so a
  body mark cannot drift between canvas and palette again.
- **Body marks read as "off"** — _diagnosed_ (screenshot + measurement). At the
  maintainer's zoom the adder's `+` sits ~0.47 world units below its box centre
  and ~0.22 left; in the committed demo baseline (default zoom) the same `+`
  measures centred. So it is **zoom-dependent**, which rules out the layout: the
  mark is drawn at `layout.rect`'s centre (`docScene.ts:1284`) with
  `textBaseline = "middle"` (`render/canvas2d.ts:115`).

  **Cause:** the renderer sets `ctx.font = \`${size}px …\``where`size` is in
  _world_ units (≈1 for a mark) and relies on the camera transform to scale the
  glyph up (~60× when zoomed in). Font metrics are quantized at that ~1px size,
  so "middle" is off by a fraction of a _world_ pixel — invisible when zoomed out,
  and multiplied by the zoom when zoomed in. Bigger marks and closer zooms make
  it worse, which is exactly "everything's logo is off".

  **Fix:** draw text in device space at the final pixel size — read the live
  transform in the flush loop (`ctx.getTransform()`), reset it, set
  `font = size × scale`, and place the glyph at the transformed point (or set an
  explicit alphabetic baseline offset). Then re-bless the visual baselines (every
  text draw shifts a hair).

**Clarified 2026-10-19 (real, being worked):**

- **"Recover unsaved work" was the wrong half of the mechanic** _(maintainer,
  fixed this round)_: it offered recovery after _clean_ closes too. The app now
  asks when the window is closed — **Save / Don't save / Cancel** — and any
  resolved decision ends the recovery copy, so the launch dialog means "the last
  session ended without closing" (a crash). _(this round)_

- ~~**Wire segment deletion is all-or-nothing**~~ _(fixed this round)_: a second
  click narrows the selection to the piece under the cursor — a branch wire
  hanging off the trunk at that segment, or the segment itself — so Delete takes
  only that. A branch survives its trunk; a segment delete drops the bend the
  wire turns at (shortening it), and a wire with no bends is just that segment,
  so it goes entirely. Junction dependents follow the new geometry. _(this
  round)_
- **One Clear, inside the memory editor.** The Inspector's `Clear` (it drops the
  `autoload` file reference) is unnecessary beside the editor's `Clear all`; the
  editor is the single place to clear, and `Clear all` takes the autoload file
  with it so the capability is not lost. _(this round)_

**Left (optional; maintainer's call):**

- **Wires**: a _per-wire_ colour palette, if identity colours are wanted back.
  The default is one bus colour with no net-id dependency _(66f46e0)_, and a
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
format bump. _(this round)_

- ~~Export the canvas/circuit as an image~~ _(done this round)_: File → **Export
  view as PNG…** writes what the canvas is showing — a real file through the
  shell (`save_image`, which decodes the data URL), a download in the browser —
  named `<document>-view.png` so it can sit beside its `.csx`. The pixels are the
  renderer's, so the canvas element is the source; the export is the _current
  view_ (fit-the-whole-circuit export is a follow-up).
- ~~Right-click context-menu overhaul~~ **done** _(this round)_: a right **click** on
  the canvas (press and release without movement — the same gate that keeps
  right-**drag** panning) opens a part / wire / canvas menu that acts on what is
  under the pointer, selecting it first so the menu and the highlight agree. The two
  older meanings of right-click stay exactly as they were: cancel a gesture, and jump
  to a subcircuit instance's definition — which is why the menu offers no
  "Open definition" duplicate. UI_OVERHAUL §75.
- ~~Version history: full-viewport view (no overlay), diff highlighting + copy~~
  **done** _(this round)_: the history is a view that owns the viewport — the editor
  row is not displayed, so nothing sits behind the preview — each change is tagged
  and coloured with the palette's own wire colours, **Copy** puts the uncapped
  comparison on the real clipboard, and the preview outlines the parts a version
  adds or changes through `SceneOverlay.changedIds` rather than the selection model
  (a selection also draws the rotate handle, which a read-only preview must not
  offer). Removals are not marked on the canvas — the part is not in that version —
  so they stay in the list. UI_OVERHAUL §76.
- Subcircuits. **Done** _(this round)_: **dynamic outer pins** — an instance's
  terminals are derived from its definition on every sync, so adding, renaming or
  resizing an inner pin was already live; rotation was the gap (neither layer reads
  it: the core derives the interface from `attrs.isOutput`, and rotation is only a
  facing). Rotating a `wiring.pin` now keeps its direction in step with its facing
  — west = output, else input, the pairing the palette seeds — so a port rotated
  across west moves to the other side of every instance, canonically (`true` or
  absent, never `false`). **Scope colours**: a subcircuit sheet is marked as its own
  scope with a hue per name (active tab, a frame around the canvas, a status-bar
  chip), so "which scope am I in" is never a guess. UI_OVERHAUL §77.
  **Instance sizing** _(this round)_: an instance may carry `width`/`height` in
  grid units (additive attrs, no version bump — the engine gained the names and a
  range check); unset still means "derive from the pins", an explicit height may
  shrink a tall default but never below one grid unit between pins, and nonsense
  falls back to the derived box. UI_OVERHAUL §79.
  **Always-visible panel + instance vs template** _(this round)_: the palette's
  Subcircuits group is always on the rail now (it used to appear only once the
  document already had a second circuit — backwards for a feature nobody has used
  yet), with an empty state, a "New subcircuit" button, and a per-tile "used by
  main" / "not placed yet" note. Double-clicking an instance opens its definition, the Inspector's
  "Edit definition" button is the same door (the right-click jump stays), and inside a definition a scope bar gives the way
  back — named after a sheet that really instantiates it, since the parent is
  DERIVED via `instantiators()` rather than remembered. UI_OVERHAUL §80.

- Primitives: **power, ground and the transistor** — all done. Power and ground
  (`wiring.power` / `wiring.ground`): fixed 1-bit sources with no attrs, additive so
  no format bump; a rake and a bar glyph (UI_OVERHAUL §71–72, pinned by a shape
  test). The transistor (`wiring.transistor`, a gate-driven pass gate with
  `in`/`gate`/`out`) is its own `CompKind`/`BehaviorKind` pair, so a halt names
  `gate` rather than `en` (§73), and it draws a MOSFET symbol now instead of a box
  (§78, also pinned by a shape test).
- ~~Propagation-delay readout~~ **done**: the Inspector shows the selected part's
  own cost from the published table (`crates/core/data/cs2200-74ls-v1.json`, read
  at build time so the numbers cannot drift — `prop 20 ns · setup 15 ns · hold
5 ns` for a register), and a selected _wire_ shows its per-path delay (drawn
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

- **Wire relocation with a bend/junction** — the maintainer was right and this note
  was wrong: it said "works" and it did not. Dragging a SELECTION left junctions
  behind ("they don't move at all"). Two coupled defects in the multi-move path (the
  single-component path was tested, the set path was not): a wire whose ends both
  travelled kept its interior bends, so a Z-route came out skewed; and a dragged
  wire's joined end did not travel with the cluster at all. Fixed together in
  `moveComponents` + the re-seating pass (UI_OVERHAUL §81), pinned by four unit tests
  over a trunk-with-a-bend plus a branch (including an invariant sweep across which
  parts move) and an e2e that lassos a wired pair and drags it.

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
- **Waveform viewer** — **done** (UI_OVERHAUL §89): a full-view cycle trace over the
  existing `net_diffs` stream, recording before the per-frame merge so no cycle is dropped.
  No engine or IPC change was needed. Signals default to the named parts and take the canvas
  selection; the axis is cycles.
- **Debugging tab with breakpoints** — **done** (UI_OVERHAUL §90): `debug.breakpoint` is the old
  `BreakpointPeer`'s DATA/ENABLE pair, so the transpiler's probe substitution is gone; CE's rule
  is kept exactly (`in` *becomes* `value`, `en` arms on anything but a driven `0`), and the halt
  is the engine's one **non-sticky** stop — the trap that made a breakpoint component useless
  before, since every other halt is terminal until a reload. The trace marks each watched signal
  with its condition and draws a dashed rule at the cycle the run stopped at. Still open: setting
  one *from* a value in the trace, which is a document edit (undoable) rather than a session one.
- **"Remove 'Named' bubble"** — read as the history `named` badge, which is gone
  _(70f6eb4)_; recorded in the P2 list.
- **"Reposition 'Restore Version' tab to the far right"** — this meant the
  _History_ tab's "Restore this version" / "Back to current" bar, which sat
  misaligned at the top; fixed by unrelated work.
- **"Make cycle counting continuous"** — fixed by the same netlist-fingerprint
  work as Phase 1's edit fix (`bf41341`): geometry-only edits no longer reset the
  counter. A _topology_ change still reboots the engine, by design — surviving
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

### The measured per-part delay — RESOLVED, and the contract change was not needed

**Outcome (2026-10-19):** the Inspector now shows the _observed_ settle time beside
the design cost, but the contract was left alone — see below for why, because the
reason is the interesting part.

A commit in the delay engine is scheduled as `Fire { comp, gen }` at
`input_arrival + t_pd` (inertial, `delay.rs`). So a part's **observed delay is its
table delay by construction** — an IPC `delays` field would re-serialize the
published table into every `timing_update` for a number the Inspector already
shows. What _is_ genuinely observed is the **path** (`TimingPath { circuit, comps,
delay_ns }`), which the frontend already receives for the canvas highlight. The UI
therefore reads that: `topPathDelay()` (+ `topPathIds`) with the same contract v1.1
sheet filter, shown for a selected part that is on the path (UI_OVERHAUL §74).

**Still authorized, if a per-part measured number is ever wanted for its own sake**
(say, to show how long an overclocked chain's parts actually took): the engine
records each component's last committed transition magnitude into a `Vec` plus an
accessor; the contract grows `delays: [{ comp_id, ns }]` on the existing
`timing_update` (additive, v1.3); the Inspector gains the second number everywhere
rather than only on the path. The original sketch, for reference:

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

### The canvas context menu — DONE (2026-10-19)

Shipped in the round after this note, essentially as written. What the note got
right: the menu rides CanvasHost's existing click-vs-drag gate (`pendingRef`), so a
right **drag** still pans and opens nothing, and it is a plain HTML overlay — which
is why SCREEN coordinates are the right thing to put in it. What it got wrong: the
world point was never the problem. `PointerInfo` simply had no viewport position, so
it grew `clientX`/`clientY` (filled in one place, `infoOf`).

Being explicit about right-click paid off. There are three cases now, and only the
last is new:

- a gesture in progress → cancel (unchanged; still pinned by pan.spec.ts),
- idle over a subcircuit instance → jump to its definition (unchanged; still pinned
  by fileops.spec.ts),
- otherwise idle → the menu, on a part / wire / bare canvas.

Because the jump keeps its one-click meaning, the menu deliberately offers **no**
"Open definition" item — right-clicking the instance already _is_ that command, so
an item would be a worse duplicate. The item set is keyed off what was pointed at,
not off the current selection, so right-clicking bare canvas never offers to edit a
part selected elsewhere; the commands themselves still act on the whole selection,
which is why a right-click inside a multi-selection keeps it.

Actions dispatch through the editor's existing public commands (no new command
surface), tests are five unit tests plus `e2e/contextmenu.spec.ts`, and the original
sketch below is kept for the record:

Right-click currently pans (UI_OVERHAUL §1: right-drag pans, Shift+left-drag pans).
So the menu opens on a right **click** — press and release with no movement — and
never on a drag. Facts gathered so it goes in one pass, as the transistor's note
allowed:

- **The conversion already exists.** `CanvasHost` hands its pointer callbacks a
  _world_ point (`onPointerDown(world: Vec2, info: PointerInfo)`), so the menu can
  ride the same conversion rather than re-deriving it from the camera. Its name
  inside `CanvasHost` is the one thing not yet read — find it, add a sibling
  `onContextMenu?: (world: Vec2) => void`, and call it from the existing pointer
  release path when `button === 2` and the pointer did not move (the host already
  tracks that distinction for "click-or-pan").
- **The menu UI is a pattern to copy, not to invent.** `SheetTabs.tsx` already has
  the shape: a `menu` state of `{ x, y }`, a `div.sheet-tab-menu` with
  `role="menu"` + an `aria-label` of "<thing> actions", `role="menuitem"` buttons
  that close the menu before acting, a `menuRef` + outside-click dismissal, and
  Escape handling. `.menu-item` styles exist in `styles.css`. Screen coordinates
  are right for it (it is an HTML overlay).
- **The actions already exist on the tools machine**: `deleteSelection()`, `cut()`,
  `copy()`, `paste()`, `rotateSelection(ccw)`, `faceSelection(rot)`. A sensible
  first cut: on a component (single selection) — Cut / Copy / Rotate CW / Rotate
  CCW / Delete; on a wire — Delete (a wire is not copyable; a narrowed segment
  means "Delete this leg"); on empty space — Paste, disabled when the clipboard is
  empty.
- **Resolving the target**: pick at the world point (`scene.pick` — the same
  picker that decides what a left click means, so a right click on a junction
  picks what a left click would), then either select that target (so the action
  applies to it) or act on the current selection — selecting is friendlier and
  reuses the highlight the user already understands.
- **Tests**: an e2e that right-clicks a gate and asserts the menu's items, that a
  right _drag_ still pans and opens nothing, and that Cut/Delete from the menu
  change the document; a unit test is optional here since the actions themselves
  are already covered.

## RAM powers on unknown (2026-10-19)

Real RAM has no defined power-on contents, so the engine no longer assumes zero: the
one place that decided it (`init_words`) now fills an image's _missing_ words with `X`,
and the browser mock mirrors it word for word (its image parsers report how many words
they defined; `memRead` answers an X mask for the rest). The engine's read paths already
did the right thing for an `X` address and for a past-end address, and a write with
`we = X` already stored `X`. An image or a write makes a word defined, explicitly
including a zero. Normative statement: docs/format-v2.md §9; also DESIGN.md §4.1,
UI_OVERHAUL §82.

**Still open (UI).** The memory dialog should say what an unset word now means and offer
**Fill with 0s** (UI_OVERHAUL §82): "no image" now means "all unknown", and the common
case — a lab that wants a zeroed memory — deserves one click rather than hand-typing an
RLE run.

**Evidence from the old format (2026-10-21).** The course's reference model *is* zero:
CircuitSim CE's RAM is a Java `int[]`, and the taught ISA simulator agrees —
`int_simulator.py`'s `access_mem` returns `0` for any address the program image does not
define. The autograder's committed expected traces were generated under that rule. So
"no image" meaning "all unknown" is a deliberate *divergence* from what a converted or
course-run design expects; the transpiler compensates by giving a converted memory a
full-depth zero image (`circuitsim-transpiler` `docs/02-mapping.md`). The open question is
what the *new* tool should do by default for a memory a student draws.

**Question for the Head TA — registers.** RAM now powers on `X`; registers still power on
`0`. The same argument applies to them (a real flip-flop's power-on value is
indeterminate), but a register has no image to initialize it from, so there are two
ways to go:

1. **Registers start `X` too** — realistic, and every stored value in a circuit becomes
   the designer's responsibility. Cost: circuits that rely on a register starting at 0
   (a counter's first cycle, say) now show `X` until something loads it.
2. **An explicit initial-value attribute** on `mem.register` — a small additive format
   change; explicit and teachable ("this register starts at 0 because I said so"), and it
   keeps a circuit's power-on state readable from the file.

Recommendation: (1), on the same reasoning as RAM — but how much of a circuit's
internal state a student should have to explain is a course-wide call, not a
simulator's. Either way the change is one line where the state is created, plus the same
test updates.
