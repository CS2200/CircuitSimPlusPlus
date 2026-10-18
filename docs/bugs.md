# CircuitSim++ — Bug & Task Backlog

*Triaged 2026-10-18 against `master` @ `5deed81`. **Phase 1 (P0) landed @
`0462adf`** — see "Phase 1 — done" below.* The trial tester's raw list was
verified item-by-item against the code; already-fixed, by-design, and
out-of-scope entries live in the appendices so the active list stays honest.

**Priority:** **P1** course-facing · **P2** UX polish (small) · **P3** feature
(sizeable) · **?** needs info.

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

**Done:** the cycle input is typed (`cycle #`, no steppers) *(70f6eb4)*; palette
tooltips name the part *(70f6eb4)*; sheet-tab right-click → Rename *(70f6eb4)*;
Reload-from-Disk confirms first *(70f6eb4)*; the `named` history pill is gone
*(70f6eb4)*; the header light/dark toggle is gone — Settings is the single path
*(e7aaff3)*.

**Left:**
- **Save**: indicator wording ("Saving…" / "Saved") **and saving with validation
  errors** — the Tauri save refuses *by design*: a bad in-memory document must
  not clobber a good file (`format/mod.rs`, guarded by a test). Version history
  already keeps the last good save, so "write it + warn" is defensible — needs
  the maintainer's call. (`App.tsx:614`)
- **Canvas**: bottom zoom slider.
- **Clock**: 12-/24-hour timestamp toggle.
- **Wire editing**: on-screen "press Esc to exit" hint.
- **Wires**: stable colors — the hue is keyed to the derived net id, so colors
  reshuffle when wires are added/removed (`docScene.ts:845`). Per-wire colouring
  would break "one net, one colour"; needs a design choice.
- **Theme**: reconcile light-mode history colors.
- **Trim (ambiguous)**: "simplify the reset label" — the transport already reads
  `reset`, so which control? — and "tidy tab / timing-readout alignment" (no
  repro).

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
- **"Make cycle counting continuous"** — geometry-only edits no longer reset the
  counter (Phase 1); a *topology* change still reboots the engine, by design. If
  the counter must survive even that, the load contract needs a `startCycle`.
- **"Intermittent general circuit execution bug"** — a reload race is fixed
  (`bf41341`); ask the tester for a repro if it recurs.

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
