# CircuitSim++ — Bug & Task Backlog

_Triaged 2026-10-18 against `master` @ `5deed81`. **Phase 1 (P0) landed @
`0462adf`; P1 and P2 since** — two P2 items were clarified 2026-10-19 (wire
segment deletion, one Clear) and are open below. The trial tester's raw list was verified item-by-item
against the code; already-fixed, by-design, and out-of-scope entries live in the
appendices so the active list stays honest._

## Round — done (2026-10-25, the boot settle left parts stuck at `Z`; a memory's unknown address is inert)

**Two engine fixes, found debugging `submission_374337181` (a 4200 pipeline).**

*Root cause.* At cycle 0 the ALU-output tri-state buffer (`c353`) is disabled, so its net
is `Z`; the comparator `ALUOutZero` propagates that `Z`, and CE's downstream `AND`/`OR`
coalesce it (`AND(Z,0)=0`, `OR(0,Z)=0`), giving `flush = 0` — so the PC advances. Ours
stalled: the comparator tried to evaluate while the buffer was still *in flight*, was left
**un-evaluated**, and when the buffer finally committed its `Z` it produced **no delivery**
(the value did not change), so the comparator never woke. Its output stayed at the initial
`Z` for the whole run, and every consumer stayed `Z` too — production reads that as `X`
(the whole datapath goes `X`), and `compat` never got to apply CE's coalescence because the
part was never re-evaluated. `driver_in_flight` treats a part that produced no output as in
flight, and "evaluated to a no-op `Z`" is indistinguishable from "never evaluated".

*Fix 1 — final settle at power-on.* After the boot queue drains, nothing that will arrive is
outstanding, so re-attempt every combinational part that has not produced an output, to a
fixpoint (`DelayEngine::build`). `net_in_flight` no longer reports the settled driver, so
the retry does not wait again.

*Fix 2 — an unknown address leaves a memory inert (all-`Z`).* CE's `ROM.valueChanged` pushes
a fresh all-`Z` `WireValue` for an address that is not valid, and `RAM.valueChanged` pushes
`noValue`; ours drove `X`. On the **shared microcode bus** that is not equivalent — an `X`
beats a definite value in the merge, so the addressed-off `MAIN ROM` in `submission_408346931`
poisoned every stage's control word. Fix 1 exposed this (it forced that ROM to evaluate:
before, it sat at a partially-`Z` value that happened to work). Fix 2 removes the
regression and is the CE-faithful rule.

*Corpus* (vs the `05fd1af` snapshot):

| | baseline | after |
|---|---|---|
| production | 342/357 (15 disagreements) | **343/357 (14)** — +1, **0 regressions** |
| `--compat` | 349/357 (8) | **353/357 (4)** — +4, **0 regressions** |

Production's gain is `submission_410843919`; `compat` gains `submission_374337181`,
`374593140`, `374625075`, `409848157`. Remaining under `compat`: `373713172`,
`374299303` (never halts), `374625393`, `410460509`. A `csim nets --compat` flag was added
(the dump and the graded run then agree on mode).

## Round — done (2026-10-25, a register's reset is level-sensitive, as CE's is)

**A register's `rst` is now asynchronous (level-sensitive), matching CE's
`Register.valueChanged`:** while `rst` is an exact `1` the register drives `0` — output
*and* stored value — *within* the cycle, with priority over the clock, not only at the
next rising edge. Our reset had been synchronous since the 2026-10-21 decision (below,
"the reset pin's semantics"); the reasoning there — "a reset held across an edge behaves
the same in both" — is true of the resetting register's *own* output but wrong for a
**pipeline flush**, which is exactly how the submissions use it. The decode buffer is
reset the cycle the `halt` is decoded; with a synchronous reset it kept the instruction it
had just latched, so the instruction *after* `halt` (the program's own
`addi $v0,$zero,-1` "failure" value) drained through EX/MEM/WB and wrote the register
file. CE clears the buffer before the following buffer's edge, so the instruction dies.
`RAM.java`'s `PORT_CLEAR` is level-sensitive the same way (it clears on the clear port's
change, not at the edge), so the RAM's clear is level-sensitive too.

Corpus (the plan: `wrong-value` first): **337 → 341 / 357, +4, 0 regressions**.

| | baseline (`b3ea69a`) | level-sensitive reset |
|---|---|---|
| agree | 337/357 | **341/357** |
| wrong-value | 5 | **1** |
| x-cascade | 14 | 14 |
| other | 1 | 1 |
| fail-old/pass-new | 0 | 0 |

The four gains — `submission_372341431`, `372845530`, `404930903`, `409775061` — all
halted `pow` with `$v0 = 0xffffffff` (the post-`halt` instruction's value) instead of
`0x100`, and now agree. The one remaining `wrong-value` row, `submission_374625393`, is a
*different* failure (an LC-4200b **datapath** design that halts at cycle 2). Docs move with
it (`format-v2.md` §4/§9, `DESIGN.md`, the `behavior.rs` header) and so do a behavior unit
test and an engine test.

The timing model is unchanged (still DTA; `--sta`/`t_sta` untouched): this is a *value*
path, not an ordering one, so it is orthogonal to the reverted zero-delay experiment below.

## Round — not done: the fixpoint ("zero-delay") engine does not fix the x-cascade class (2026-10-25)

**Question.** The remaining `x-cascade` disagreements read `X` where CircuitSim CE has a
value. CE models no time (ordered delta cycles to quiescence); the delay-aware engine
added per-component propagation and per-sink transport on top of it. If the `X`s were a
*propagation-order* artefact — a register sampling a value still in flight across the
clock edge — a zero-delay functional mode would settle the cycle first and read the
settled value, exactly as CE does.

**Experiment.** A `--zero-delay` mode zeroed every component commit delay (`prop`/`access`)
so a clock period ran to quiescence. Setup/hold recording had to be disabled in that mode:
every same-timestamp change otherwise read as a violation, and the `violations` list is
serialized, which produced a 658 MB report. Full-corpus diff against `report-1c4445c.json`:

| | baseline | zero-delay |
|---|---|---|
| agree | 336/357 | 335/357 |
| x-cascade | 14 | 14 |
| gains | — | **0** |
| regressions | — | **1** (`submission_409477240`, `oscillation event storm` in a combinational loop) |

**Result.** Zero-delay flips **0 of the 14** x-cascades and regresses one. With
`--pause-on-unknown`, the register-`en` rows — the ones the transpiler's x-cascade
investigation called edge-path "transients" — *still* halt with "nothing drives that
net" under zero delay. So those nets are genuinely undriven in the flattened circuit,
not delayed-but-driven. The `X` is not an arrival-order race.

**Conclusion.** The x-cascade class is two things, neither of which any ordering model
fixes: (1) genuinely undriven nets, where CE coalesces `Z` per consumer and we read `X`;
and (2) `X` propagating from contention/decoders. A fixpoint engine cannot drive an
undriven net. The mode was reverted and the engine stays delay-aware. The open lead is
**`COMPAT`** — make the *engine* mimic CE's per-consumer `Z` handling behind a debug flag,
to separate engine `Z`-semantics from converter connectivity — together with the CE tracer
(`tools/ce_trace.py`) to convict whichever side is wrong on the residual.

## Round — done (2026-10-24, the symmetric-settle tie-break)

**A cross-coupled latch seeded onto its unstable diagonal no longer storms.** The
row the previous round diagnosed — `submission_374535898` (LC-4200b), the
`StateBuffer`'s two cross-coupled NAND pairs — ran to completion in the old tool
in **1833 cycles** and in ours halted at boot with
`oscillation event storm: more than 1000000 events in one cycle`. Both NANDs of a
pair have equal delay and both commit at the *same* timestamp, and the power-on
seed puts both loop nets at `0` — the unstable diagonal of the pair — so every net
flipped `0 ↔ 1` with a 20 ns half-lap and nothing in delay order ever broke the
symmetry. It is the third face of the same model difference the two reverted
changes ran into, and this is the *targeted* fix the boot round said it wanted:
deterministic ordering where two parts commit at the same timestamp, which is how
CircuitSim CE's link order breaks the tie (`Simulator.step` moves one link out of a
`LinkedHashSet` per step; CE is zero-delay, so a part whose input has not moved is
never evaluated).

**The rule — propagation before commit, and only for a part on a cycle.** The event
queue's key becomes `(time, prio, seq)`. `prio` is `0` for every event *except* the
commit (`Fire`) of a component that lies **on** a combinational feedback cycle, which
is `1`; `seq` is the existing monotonic schedule counter, so `prio = 0` reduces the
key to exactly the old `(time, seq)`. A same-timestamp commit that produces a
transport arrival therefore delivers it to its sinks *before* any other commit at
that instant: the recipient re-evaluates from the freshly arrived value, the ordinary
inertial mechanism bumps its generation, and its already-scheduled commit moves one
`t_pd` later. The first committer in queue order wins and the loop settles to one
definite state. Nothing is random and nothing is a tolerance (format-v2 §9, DESIGN.md
§4.5/§4.6). The cycle set is `engine_common::on_cycle` (Kosaraju SCCs over the same
dependency edges `levelize` orders by), i.e. the precise subset of the levelize
*residue* that is feedback rather than merely downstream of it.

**Narrow by construction.** Only a `Fire` of a part *on* a cycle is promoted; a part
merely downstream of a loop, and every `Deliver`/`Net`/`Clock`/`Poke`, keep their
plain `(time, seq)` order. A design with no combinational feedback has no class-1
event, so its event trace is bit-identical — the whole existing golden suite
(`golden_traces_are_pinned`, `t_obs` 39/40/0/205/205) and all **211** core lib tests
pass unchanged, with no re-bless. A **genuine** oscillator is unaffected for the same
reason: an odd-parity ring's stages are one `t_pd` apart, so no two of their commits
share a timestamp and the cap still fires (`event_storm_halts_with_oscillation`, plus
a new odd-inverter-ring test).

**Measured (this round).** `submission_374535898`: storm → `ok=True cycles=1832`
(the old tool's 1833). Controls unchanged: `374174555` 1853, `372649919` 5237,
`373027353` 6683. `373713172` (the other storming row) no longer storms but now fails
with a wrong final state — `$at`/`$v0` read `X` at cycle 3, a different question from
the symmetry, so it is left for its own round.


## Round — done (2026-10-24, CE's enable and splitter rules; the boot change reverted)

**One engine rule was ours rather than the old tool's, and it is fixed.** A controlled buffer
and a transistor now enable only on a **driven `1`**: CE's `ControlledBuffer.valueChanged` and
`Transistor.valueChanged` compare the control against the enable bit and push `Z` otherwise, so
a floating enable means *disabled* — the part drives nothing, and its net belongs to its other
writers — and a floating transistor gate means the switch is open. We consumed those into `X`,
turning "this driver is off" into "this driver might be on with an unknown value". The
transpiler's tie for a floating `en` was the matching half of that mistake and is fixed with it:
`en` is resolved per class now (a register reads it as enabled, a buffer as disabled).

**Two further changes were tried, measured, and reverted.** Both looked like fidelity, both had
a real failing row behind them, and both went the wrong way once the corpus was the judge. The
numbers are the record, because the reasoning that produced them was itself reasonable.

- **A splitter drives its slices from the value it receives on the bus** (landed). CE's
  `Splitter.valueChanged` has two branches and they are not symmetric: on a bus change it slices
  the **incoming bus value** into every fanout, and on a fanout change it pushes the bus with its
  own last bus value plus that fanout's bits. Our `eval_splitter` had a withdrawal instead — it
  drove `Z` on any slice another part also drove — so two splitters on one bus withdrew exactly
  when the other drove: no fixed point, and a `Z ↔ 0` storm for ~100k laps during boot
  (`submission_373713172`).
  The **first** attempt at this drove each slice from `bus_value` — the bus's drivers *folded
  with the fanouts' own drives* — and regressed **155 rows** to all-`X`. The fold is right for the
  *bus* direction and wrong for the slice direction: wherever a fanout's live driver disagreed
  with the bus, the merge fabricated an `X` that the splitter then drove **back onto the fanout
  net**. A confound hid the real story: at that time a controlled buffer with a floating enable
  still drove an invented `X` onto its net, so those "live drivers" were `X` to begin with — the
  two changes had to be measured *together*, and the enable rule landed first.
  Isolated on three rows the wrong variant broke and one it fixes:

  | row | slices from the folded bus value | slices from the received bus value |
  | --- | --- | --- |
  | `372649919` | all-`X` | pass, 5237 cycles |
  | `373027353` | all-`X` | pass, 6683 cycles |
  | `374174555` | all-`X` | pass, 1853 cycles (the course's count) |
  | `373713172` | storm gone, `X` failure | storm gone, `X` failure |

  The last row is the one whose *storm* this removes; it still fails on values, which is the
  read-side difference (a gate coalescing CE's `Z`) and not this rule. Conflict is never decided
  inside the part — the net merge reports it, as CE's `WireValue.merge` does.
- **Removing the boot seed** (power-on from nothing, as CE) — the seed is a guess, and for a
  symmetric latch all-zeros is its *unstable* diagonal, so a converted datapath's `STATE` buffer
  flipped between its two stable states (~100k laps) until the per-boot event cap fired. That
  row did settle, and **154 rows** that had been passing came back all-`X`. The reason is a
  model difference: our engine is *delay-aware* and CE is zero-delay, so CE settles a floating
  loop at a definite value by coalescing the read, while ours settles at `X` — a fixed point of
  every combinational function we have — and every consumer of that loop inherits it. The seed
  is load-bearing exactly as its comment said, and its doc bullet says so now. The
  symmetric-latch row wants a *targeted* fix instead: deterministic ordering where two parts
  commit at the same timestamp, which is how CE's link order breaks the tie.

`csim`'s `--tunnels` probe is what made the first of those measurable rather than inferable: it
reads the *old* tool's named wires per cycle, so "which net carries `PC + 1`" is answered by the
old tool instead of by argument.

## Latest round — done (2026-10-23, third pass)

- **v6: the engine stopped deciding what an unwired reset means.** Through v5 a floating
  `rst` read as *deasserted* — an engine rule doing the converter's job, and one that made
  the transpiler's own `rst` → 0 encoding redundant (so `_reset_only` skipped it, and the
  engine's copy was the one that ran). Now `rst` is consumed like every other input: a
  floating one is `X`, and the register/RAM holds `X`. The three writers take over — the
  **transpiler** writes the 0 in for a converted design (in *both* tie modes: it is a
  CE-*defined* control, not a guess about data), the **UI** places a `wiring.reset`, and a
  new **v5 → v6 migration** gives every register/RAM whose `rst` nothing wires a constant-0
  driver (a constant, not the button — the old semantics was "never resets"). `FORMAT_VERSION`
  5 → 6 in the engine, the transpiler and `CSX_VERSION`; goldens re-blessed with **`t_obs`
  unchanged** and the architectural checks passing.
- **`wiring.reset` — the design's reset is a source part, not a naming convention.** A
  square button beside `wiring.clock` (round stays general-purpose); behaviourally `Button`,
  so a graded run sees it released. The "CLK PIN"/"RST PIN" palette tiles are gone with it:
  CLK/RST stays a convenience the editor uses when it *looks* for a source, and the engine
  binds nothing by name.

## Latest round — done (2026-10-23, second pass)

- **A register whose enable shares a net with its clock now latches** (`arrive_together`).
  CE's `Register.valueChanged` fires on the edge of `CLK` (`PORT_CLK` = 2) and reads
  `getLastReceived(ENABLE) != ZERO` (`PORT_ENABLE` = 1) at that instant — and because a net's
  new value is pushed to *every* port on the net, the enable is already updated when the clock
  handler runs. The engine delivers per *pin* (F14), so the enable's view could still hold the
  pre-edge `0` and the register never latched. Submissions wire a PC's clock into both its
  `clk` and its `en` port (the copper crosses both), so those PCs froze at power-on and the
  program "completed" at cycle 0. Regression test `en_on_clk_net_latches`; narrow by
  construction — only pins on the same net are touched — so the golden hashes and the
  reference trajectories did not move. It accounts for one of the nine remaining
  `wrong-value` rows.

## Latest round — done (2026-10-23)

- **An idle tri-state bus no longer deadlocks the part reading around it** (fixed @ `983cff2`).
  The wait-for-arrival rule was "any input view is `Z` on a net that *has* a driver pin", but a
  disabled `wiring.controlled-buffer`'s `Z` is **final, not in flight**, and the part may not even
  read that pin. A mux with a disabled buffer on its **unselected** input therefore waited
  forever and held its output at `Z`; a register sampling that `Z` stored `X` for the rest of the
  run. Two refinements: the wait asks the part's own **consume table** which pin it reads (a `Z`
  on a pin a part never reads cannot stall it; a memory's asynchronous read keeps its `addr`-only
  wait), and waits only while the value is genuinely **in flight** (`net_in_flight`: a driver with
  a change queued on its propagation delay, or one that has produced no output yet). Regression
  test `mux_passes_through_with_idle_bus_on_unselected_input`; `golden.rs` re-blessed for `alu`,
  `multicycle`, `pipeline5` — `t_obs` held and the architectural checks still pass (the drift is
  events: parts that no longer hold). This is the whole **write-back path** of a converted
  LC-5200: MEM muxes between the ALU result and `D-MEM.dout` through controlled buffers, and the
  buffer on the branch not taken is disabled. `docs/format-v2.md` §9 states both refinements.

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

## A combinational loop kept its seeded zeros (fixed 2026-10-21)

**Every converted pipelined CPU was frozen at power-on**, and the cause was the engine's
own start-up, not the conversion:

* a combinational loop has no topological order, so the engine **seeds** its nets to `0`
  (`delay.rs`, "Power-on for combinational loops") and lets the boot queue iterate them;
* but the seeding wrote the `0` into each sink's **view** as if it had *arrived*, while
  the loop's components were never evaluated at all. A part whose first evaluation
  computes exactly that seeded `0` therefore delivers nothing, so the parts downstream of
  it never see "arrived", hold their own seeded `0`, and the loop never runs. Any loop
  whose real fixed point is not all-zero froze — including the course pipelines' **stall
  and forwarding logic**, which is a loop (`En → ID/RR → comparators → the stall gate →
  En`, with the comparators reading the ID/RR's own outputs);
* the symptom was maddening to read from the schematic, because every wire was right:
  `NOT(AND(0,1))` sat at `0` with both its input and its output net reading a verified
  `0x0`, and the same gate fed from a plain constant inverted correctly;
* the fix evaluates each loop component once from the seeded state, so the boot queue
  iterates the loop to its fixed point (a genuine oscillator still trips the storm cap).

Found with a new debugging aid, `csim nets` (`--pin id.pin`, `--comp id`), which prints
the engine's own view of a net or component: the terminals it merged, their directions,
the resolved value, and what each pin *received*. The reference EC pipeline now runs its
prologue exactly as CircuitSim CE does (`$sp = 0xA000`), and a converted student pipeline
reproduces that student's own bug (`$v0 = 0x2` on `pow`, the same verdict the old grader
gives), so the conversion is faithful where it can be seen; the pipelines still stall
later in the run (`PC-IF` parks at `0x12` for the reference), which is the next thing to
chase. All 199 core + 9 golden tests pass unchanged.

## The reset pin's semantics (decided 2026-10-21) — **superseded 2026-10-25**

> Superseded by "a register's reset is level-sensitive, as CE's is" (2026-10-25, top of
> this file): the reset is now asynchronous, like CE's. The paragraph below is kept for
> the trail; its "a reset held across an edge behaves the same in both" claim is the part
> that turned out wrong for a pipeline flush.

`mem.register`/`mem.ram` have `rst` and `clk` again, hidden unless `showClk`/`showRst`
(UI_OVERHAUL §93). Our reset is **synchronous** — it clears on a rising edge, and wins over
a simultaneous enable — which is the right reading of a D flip-flop. CircuitSim CE's `Clear`
is *asynchronous* (level-triggered: it zeroes the part on any input change while asserted),
so the two differ for a reset pulse shorter than one clock; a reset held across an edge
behaves the same in both, which is how the old schematic is drawn and how the converted
LC-5200 uses it. Recorded here rather than "fixed", because the synchronous behaviour is
deliberate.

**Backlog (P3): more register/latch types in the Memory palette — *after this semester, not now*.**
A reset is a property of the *part*, and real parts disagree: an edge-triggered register with
**no** clear (74LS374/377), one with an **asynchronous** clear (74LS273/174/175 — what the register
now is, and what CE's part is), one with a **synchronous** clear (what we shipped until 2026-10-25),
and a level-sensitive transparent **D latch** (74LS373/573), plus possibly a transparent-latch RAM.
A future term may want these as *selectable types* (a type selector, so a design says which part it
assumes) — but **not this semester**: the current tool must match CE on this term's submissions, and
CE exposes exactly one register part, so a converted design carries no signal to pick among them
(that is exactly why the register itself had to move to the async clear). Deferred deliberately;
nothing depends on it yet.

## Correction: the old file has no short — my splitter was echoing its own bus (2026-10-21)

**An earlier commit in this batch claimed the converted reference CPU "contains a short" that
CE tolerates. That was wrong.** The mistake was mine and it is worth writing down, because it
took two engine bugs to see.

The net is fine. In the reference solution the net carrying the instruction register's output
has exactly two pins — `RegisterPeer(q)` and `SplitterPeer(bus)` — one writer; the splitter
merely *taps* it. Its fanouts go to sinks: a bit extender's input, another splitter's bus, and
the register file's read-address inputs (`Ry`/`Rx`/`Opcode`). Nothing drives that net twice, so
there is nothing for CE to tolerate.

What produced `X` was **our** splitter: `eval_splitter` drove its own `bus` pin with a
pass-through of the net's value, which makes it a second writer on a net it only reads.
CircuitSim CE never does that — `Splitter.valueChanged` pushes the *fanouts* when the bus
changes, and pushes the *bus* only when a *fanout* changes, with its own last bus value (which
starts `Z`) plus that fanout's bits. A pass-through is not that, and the engine's per-bit
contention check turned the disagreement into `X` on the whole instruction bus.

Fixed in `behavior.rs`: the bus is driven only for the bits a split that is itself externally
driven claims (the assemble idiom), and each split reads the bus where nothing else drives it.
On the converted reference CPU, X-carrying nets after a run went from 4 to **0** at cycle 1 and
46 to 0 at cycle 3, and the CPU now **executes the program**: `IR` takes `0x9D00003F`, then
`0x3DD00000`, then `0x9300001A` — the program's first three words — with `A`, `B`, `MAR` and the
microcode state doing the expected work.

**What remains is behavioural, not `X`:** past those first instructions the PC wanders (`0x9`,
`0x3`, `0x14`, …) instead of following the program, and `pow` never reaches its answer. The
autograder's own `reg_states.csv` is a per-cycle reference, so the next step is to diff our
register file against it cycle by cycle.

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
5 ns` for a register), and a selected _wire_ shows its per-path delay — which is
  currently **0** for every wire, because wire propagation ships off (`wire.num = 0`,
  Head-TA decision, `docs/delay-table.md`). Both are **design** numbers; the transport's
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

**Open — a converted CPU can be cycle-unfaithful while being state-faithful (2026-10-22).**
With the new `stop` conditions (§8.4) a run can finally be asked for its *cycle count to
completion*, and the first design measured against the old tool disagrees: the EC project's
reference `pipeline-pred.sim`, converted, reaches the expected final state exactly (all
fifteen registers, PC `0x11`) but the PC takes **1772** cycles to settle where CE's grader
reports **1316** — and a per-cycle diff shows the two trajectories parting at cycle 21 while
seven of the fifteen registers stay identical throughout. Mid-flight the converted design
takes an extra pass over a block CE does not, so the pipeline's *stall/prediction* structure
differs even though the committed state ends up the same. Final-state grading could never see
this; the EC benchmark grades **cycle counts**, so it is load-bearing there.

`LC-5200Jordan.sim` is the control: its trajectory matches CE **cycle for cycle** (1500/1500,
one harness offset), so this is design-dependent, not a global skew. Prime suspect is the
in-cycle question the wire-delay change only partly answered: CE settles a cycle to
*quiescence* and then latches, while our engine applies real per-part delays in event order,
so a comparator or hazard output that arrives after the edge can be latched a cycle
differently. Diagnosing it needs the trajectory oracle at the *first* divergence (cycle 21)
with CE's own per-cycle pipeline latches (`ce_trace` prints them), which is the next step.

## Performance round — the trace hash was rendering hex (2026-10-24)

Profiling a 32,312-cycle datapath submission (`perf record -F 4000 -g`) put ~8% of the run
in `mask_to_hex`, `alloc::fmt::*` and the `malloc`/`cfree` behind them. Nothing on a plain
`csim run` should render: the only hot-path caller was `hash_event` (§4.6's determinism
tripwire), which mixed an event's value by asking for `Value::to_wire_value()` — three
`String`s, hex-formatted limb by limb — purely to hash their *bytes*. It now folds the raw
representation (`Value::fold_bytes`: the width, then each of the three masks limb by limb),
which allocates nothing and, unlike the rendering, tells two widths apart (`0x1` as 8 bits
and as 64 were the same text). The digest therefore changes: the §4.6 goldens were
re-blessed with the README's documented `CSIM_BLESS=1` workflow (`t_obs` unchanged at
39/40/0/205/205 — only the five hashes moved), and a stored snapshot's `trace_hash` now
predates the change.

The same round added `--stop changes:NAME:COUNT`, counting boundaries at which the watched
value *moved*. The course's CPU rule is a pair: `MAX_CYCLES_PER_INSTR = 100` (already
`stable:PC:100`) and `MAX_INSTR_COUNT = 10000` (now `changes:PC:10000`). The submission
harness had been approximating the second with a cycle budget, and a budget is a guess about
a design's CPI: 30,000 was *below* what the recorded corpus legitimately needs (its longest
run is 32,312), so working designs were reported as never halting. Counting PC moves is not
a guess.

## `compat` and the last four corpus rows (2026-10-26)

Under `CSIM_COMPAT=1` the corpus stands at 353/357. The four that fail are
`373713172` (4200 pipeline, X-cascade), `374299303` (4200 datapath, never halts),
`374625393` (4200 datapath, wrong value) and `410460509` (5200 datapath, X-cascade).
They are the same four that fail in production, which is why the earlier round concluded
`compat` "does not touch them" — a conclusion this round had to revisit, because the
evidence for it was gathered wrong.

### The measurement trap: `--pause-on-unknown` masks `compat`

`eval_comb` checks `pause_on_unknown` **before** the `compat` branch and returns early:

```rust
if self.pause_on_unknown { return Err(self.halt_unknown(c, &fr.pin)); }
if self.compat { ... z_compat ... }
```

So `csim run --compat --pause-on-unknown` is *not* a compat run: every floating read
halts instead. Anyone using `--pause-on-unknown` to find the first floating read must
re-run without it before drawing conclusions about `compat`. Verified both ways: with
a real `compat` run (no pause), all four produce byte-identical `cycles` to production
(103 / 48331 / 102 / 160), so the four genuinely are not fixed by compat — but the
first measurement of that was luck, not method.

### The trajectory oracle now runs in either mode

`probe_trace` gained `PROBE_COMPAT=1` (build the engine with `new_compat`, so the boot
settle coalesces too) and `PROBE_TABLE=<name>`. `tools/diff_trajectory.py` inherits the
environment, so

```
PROBE_COMPAT=1 uv run tools/diff_trajectory.py <design>.sim --program POW --cycles N
```

diffs CE's own per-cycle trace against the engine **in the graded mode**. That is the
instrument this class of bug needs; everything below was read off it.

### What the four actually do

`374625393`, CE vs ours (`$sp`, aligned `ours[i] == old[i-1]`):

```
cycle   CE            ours
1       sp=36         sp=0
2       sp=36         sp=36   (PC reaches 2 in both)
3       sp=A000       sp=36   <-- first difference, and ours never moves again
```

CE carries on (PC 1,2,3,4,5,6,7; `$sp` becomes `A000` at cycle 3). Ours **stops
clocking at cycle 2**: the PC freezes at `0x2` and every register holds. `--pause-on-
unknown` on this design names `plexers.mux (Datapath: c2), pin 'in0'` at cycle 1, whose
net is driven by four controlled buffers **all disabled** (resolved all-`Z`), and the
mux's `sel` is `Z` too. But that is a symptom: tracing the engine's own state shows
`State` (the microcode address register, `c0/State`) holding `0x1C` at cycle 1 and
**`X` from cycle 2 onward** — identical in production and compat. With the microcode
address unknown, the ROMs drive all-`Z`, the control word (`c0/c12` splitter) is `Z`,
the register enables read `Z` (`PC.en`, `IR.en` are `0bz`), and the machine stops.

So the divergence is *not* at the mux. It is that **a floating `d` on a state element
becomes `X` in our engine even under `compat`** — the limit the code already documents:

```
// CE would store `Z` for a floating data pin and a register would hold `Z`;
// the edge path keeps `X` — a documented limit of this diagnostic.
```

CE's `Register.valueChanged` latches `getLastReceived(PORT_IN)` **verbatim**, so CE's
register holds `Z` and CE's consumers then apply their own rules (`isValidValue()` →
drive all-`Z`; a gate → treat `Z` as `0`). Once we store `X` instead, no later consumer
can recover: `compat` only ever intervenes on a *`Z`* read, and `X` is not `Z`.

### Ranked hypotheses

1. **The state-element `d` fallback.** `z_compat` has no arm for a register/RAM data
   pin, so the edge path falls back to `z_to_x()`. A faithful fix stores the `Z` (CE's
   rule) and lets it propagate, with `compat`'s existing per-pin table deciding what each
   consumer then does. This is the only divergence proven so far, and it is the reason
   `X` appears at all.
2. **Gaps in `z_compat`'s per-pin table.** It covers `ControlledBuffer.en`, `Register`/
   `Ram` `en`/`clk`/`rst`, `Ram.we`, gate inputs for `And`/`Nand`/`Or`/`Nor`, and the
   priority decoder's lines. Missing: `Xor`/`Xnor`/`Not`/`Buffer` gate inputs, every
   arithmetic part (CE drives all-`Z` when `!isValidValue()`), `Multiplexer`'s data pins,
   `Demultiplexer`, `Decoder`, `ROM`/`RAM` address and data pins (`RAM` stores `-1` when
   the data is not a valid value), and `wiring.pin`. Each needs an arm quoted from CE's
   `valueChanged`.
3. **A spurious float (conversion or ordering).** If CE's register data pins are
   *definite* here (CE's trace says they are — `$sp` reaches `A000`, the PC advances),
   then a net we see as `Z` should be driven. That would put the bug in the converter's
   tie pass rather than in the engine. Hypothesis 1 is cheaper to test first and is
   proven to be at least *a* divergence; if storing `Z` does not move these rows, this
   one is next.

### Next

Implement hypothesis 1 behind `compat` only (production stays byte-identical), measure
the four and then the corpus, and take a snapshot per round. Then walk CE's component
sources (`components/*/*.java` `valueChanged`) and complete `z_compat` arm by arm,
measuring after each.

### Round 2: hypothesis 1 is necessary but not sufficient; the four split in two

Implemented hypothesis 1 behind `compat` only (`Behavior::rising_edge_compat`, called from
the engine's edge path when `compat`): a floating **data** pin is latched as `Z` instead of
promoted to `X`. Production is byte-identical (verified: the four still run 103 / 48331 /
102 / 160 cycles and `t_obs` is unchanged); under `compat` it is active — `374625393`'s
microcode address register `State` holds `X` at cycle 2 before and **`Z`** after, and the
design's `t_obs` moves 350 → 340. The machine still freezes, so the X was a *symptom*: the
next-state logic is `Z` upstream of the register.

The four are not one bug. `csim timing --sta` splits them cleanly:

| submission | `t_sta` | `sta_note` |
|---|---|---|
| `374625393` | none | **combinational cycle**: no fixed point through 33 components |
| `410460509` | none | **combinational cycle**: no fixed point through 25 components |
| `374299303` | 275 | normal structural bound |
| `373713172` | 226 | normal structural bound |

So **two of the four contain a combinational cycle** (control word ↔ microcode state) whose
fixed point **CE resolves and we do not**: CircuitSim has *no delay at all*, so its cycle
settles instantly to a definite value, while our delay-aware settle leaves it `Z` — and
`compat`'s per-pin table cannot recover it, because every arm assumes the value *arrived*.

That reframes the fix. `compat` is described as "CE's per-consumer floating-read reading",
but the thing the last rows actually need is **CE's zero-delay settle**, not a per-pin
reading rule. The team already built and reverted a zero-delay/fixpoint engine (measured 0
gains / 1 regression, in *production*). As a **`compat`-only** mode — where `t_obs` is not
wanted, only CE's trajectory — it is the unfaithful half: production stays delay-aware and
graded; `compat` iterates each cycle to a fixed point the way CE does, and whether the
trajectory then matches becomes a *test* of the conversion rather than a guess about `Z`
semantics. That is the next experiment: give `compat` a zero-delay table and see whether
`374625393`/`410460509` stop freezing.

### Round 3: zero delay unfreezes one, so the freeze is the cycle — but not CE's fixed point

`ce-zero-delay-v1` (a DIAGNOSTIC table: every `prop`/`access`/`setup`/`hold` zero, i.e.
CircuitSim's own model) is now published so a `compat` run can be evaluated the way CE
actually evaluates. Result on the four:

| submission | node + compat | **zero-delay + compat** |
|---|---|---|
| `374625393` | 102 cycles, PC frozen at `0x2` | **10000 cycles** (runs, misses the halt cap) |
| `410460509` | 160, PC `X` | 160, unchanged |
| `374299303` | 48331 | 48331 |
| `373713172` | 103, PC `X` | 103 |

So for `374625393` the freeze *is* the combinational cycle — remove the delays and it
stops freezing. But it does not reach CE's fixed point (CE halts it at 2709 cycles), and
`410460509`'s cycle is untouched. That is the expected shape if the difference is not the
delays but **where the cycle starts**: our boot seeds the loop's nets to **`0`**, while
CircuitSim's nets start as all-**`Z`** (its `WireValue(bitSize)` default) and its
`CircuitState.propagate()` iterates to a fixed point from there. A cycle's fixed point
depends on its starting state, so seeding `0` and seeding `Z` can and do differ.

Hypothesis 3, tried and **falsified**: seeding the loop residue with `Z` under `compat`
(CE's initial value) changes none of the four — `102 / 160 / 48331 / 103` cycles either
way, on all three tables. It has been reverted; the reasoning was sound and the
measurement says the fixed-point difference is elsewhere. What that leaves is that the
two cycle-bound rows differ from CE in the *iteration*, not the starting value: CE's
`CircuitState.propagate()` walks its own worklist order, and ours walks `(time, prio,
seq)`. Matching CE's fixed point means matching its order, which is a different piece of
work from the per-pin floating table and should be attacked with `diff_trajectory` on a
*single* cycle (the first divergent one) rather than from the outside.

The other two have no cycle and need per-design work: `374299303` runs 48331 cycles and
wanders (PC ends `0x3400001b`), `373713172`'s PC goes `X` at cycle 3 through the
enable/selector chain.

### Round 4: an invalid *select* drives all-Z in CE, not X — and where the X is really born

Two more things, both from reading the engine's own eval rather than guessing.

**The mux/demux invalid-select rule.** CE's `Multiplexer.valueChanged` drives
`new WireValue(bitSize)` — all-`Z` — when the select is *not a valid value*; ours drove
`Value::x`. A **`Z`** select was already handled (it is caught by `consume`, so `compat`
substitutes), but an **`X`** select was not, and could never be: `compat` only ever
intervenes on a **`Z` read**, and by the time the select is `X` the read has already
succeeded. So `Behavior::eval_with(ins, compat)` was added — production keeps strict `X`
propagation (`eval` delegates with `false`), and `compat` mirrors CE — with the mux
(all-`Z`) and demux (all-`Z` on every output) arms. Measured: production unchanged
(103/48331/102/160), compat unchanged on the four. Necessary for fidelity, not the fix.

**Where `373713172`'s `X` is actually born.** Bisecting the net dump by cycle isolates it
exactly:

| cycle | unknown nets | the new ones |
|---|---|---|
| 0 | **1** | `c62/c12.out` — a *splitter* output, all-`Z` |
| 1 | 84 | 83 new, and the new ones are `0bx` on **multi-driver** nets (`c133/c47.out, c133/c80.out1`) |
| 2 | 159 | splitters in `c168` |
| 3 | 211 | **`c158.q` — the PC-IF register — all-`X`** |
| 4 | 273 | `c160.q`, more comparators |
| 5 | 292 | the rest of the register file |

So there is exactly **one** unknown net at power-on, a splitter output; **one cycle later
the `X` is born in a multi-driver merge**; two cycles after that the PC register has
latched it. `Z ∪ definite` is the definite value in both CE's `WireValue.merge` and our
`contention_merge`, so an `X` there means **two definite drivers disagreeing** — which in
CE is not an `X` at all, it is a `ShortCircuitException`. Either our splitter drives a
value on a bit it does not own (its own doc says it must not re-assert bus bits), or a
tri-state we read as enabled is disabled in CE. That is the next thing to look at, and it
is now a *two-cycle* target (`--cycles 1` and `2`) rather than a whole design.

### Round 5: the splitter fixes were wrong — CE's source and a test both say so

I proposed two splitter "authority" fixes. Both are **refuted**, and the refutation is
worth recording because the reasoning looked solid and was not.

`behavior.rs`'s own test `a_split_driving_a_bus_bit_is_a_short_the_net_merge_reports` pins the
behaviour I wanted to change, with the reasoning in the test:

> *"The splitter states its authority over the bits it assembles; the **net merge** is what
> turns the disagreement into `X` … the splitter itself is not the place to decide that. …
> CE does the same: it slices the bus value it **received**, and the net merge decides."*

And CircuitSim's `Splitter.valueChanged` agrees with the test, not with me:

```java
if (portIndex == PORT_JOINED) {          // a bus change
    for (int i = 0; i < getNumPorts()-1; i++) { result.setBit(..., value.getBit(j)); }
    state.pushValue(getPort(i), result); // every split IS driven from the bus value
} else {                                  // a split change
    WireValue result = new WireValue(state.getLastPushed(getPort(PORT_JOINED)));
    result.setBit(i, value.getBit(currBit++));
    state.pushValue(getPort(PORT_JOINED), result);   // its own last bus value + this split's bits
}
```

So **Fix A** (drive a split bit `Z` when something else drives it) was unfaithful: it moves
the short decision *into* the splitter and hides a genuine short. Committed, the gate went
red on exactly that test, and it has been reverted (`cb68b69`). **Fix B** (do not drive a bus
bit another driver owns) dies to the same evidence: CE's splitter *does* re-assert the bits
it assembles on the bus, and a genuine disagreement is a `ShortCircuitException` in CE, not a
value the splitter declines to drive. The `eval_splitter` code was right.

**What that leaves is more useful than the fix I wanted.** The design's control bus
`c133/c55.bus` has three drivers — the splitter's assembled bits, the register `c153.q`, and a
second splitter `c188.bus` — and the merged value is `0bx00x1101…`: **a genuine disagreement,
which CE would throw on and does not**. The same overlap appears one level down, where
`c133/c55.out4` *and* `c188.out4` both drive `c133/c83.in` (`0bx00x`). So two splitters are
driving the same split net.

The surviving explanation is **event semantics, not authority**: CE's splitter pushes its
splits only when the **bus changes** (`PORT_JOINED`), so a splitter whose bus has not changed
since power-on has *never* pushed and its splits are still `Z` — while our `eval_splitter`
computes and drives the splits on *every* evaluation, boot included. A splitter that CE has
never pushed from cannot be a second writer, and that is exactly the difference that would
turn a benign overlap into a short. Next: determine, per splitter, whether its bus has
"changed" since power-on (CE's condition) and drive the splits only then.

### Round 6: the short is named — the instruction bus, and a splitter claiming bits it does not own

An env-gated diagnostic (`CSIM_DEBUG_SHORTS=1`, inert otherwise) now prints every net whose
`X` came from drivers that **disagree** — the `contention_merge_detail` "shorted" flag.
Running `373713172` for two cycles names it immediately:

```
SHORT net 43 width 32
drivers [28:wiring.splitter, 59:Instr(mem.register), 147:wiring.splitter]
values  [0bzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz, 0x9d000035, 0b0000zzzzzzzzzzzzzzzzzzzzzzzzzzzz]
```

So the **instruction bus** is co-driven by the instruction register `Instr` and **two
splitters**. `Instr` drives the fetched instruction (`0x9d000035`, bits 0–3 = `0x5`); the
splitters drive bits 0–3 as **`0`** and `Z` elsewhere. Bits 0 and 2 disagree, so the merge
reports `X` — and CE, which throws `ShortCircuitException` on a genuine disagreement, would
have thrown. It did not, so **our splitter is claiming bits it does not own**.

Where that comes from is now specific. `eval_splitter` is a *stateless whole-value* function:
it gathers a bus bit from **every** split whose net is not fully `Z`, every time it runs.
CE's splitter is **stateful and event-driven** — on a *split* change it pushes the bus with
**its own last-pushed bus value** plus **only the bits of the split that changed**:

```java
WireValue result = new WireValue(state.getLastPushed(getPort(PORT_JOINED)));
result.setBit(i, value.getBit(currBit++));
state.pushValue(getPort(PORT_JOINED), result);
```

Its own last value starts all-`Z` and only ever accumulates the bits it has actually
assembled, so it cannot re-assert a bus bit that another part owns. Ours re-derives the whole
gather on every evaluation, so a split driven by *another splitter* (here the two splitters
share both the bus and a split net) is gathered back and re-asserted on the bus, where `Instr`
already drives it. **Next: make the bus drive stateful the way CE is — own last value plus the
changed split's bits — behind measurement (it touches both modes).**

### Round 7: the short is a two-splitter feedback pair, name by name

`CSIM_DEBUG_SPLITTER=<comp idx>` (env-gated, inert) prints a splitter's in-pin nets with
their **drivers** and values, and what it drove. Following `373713172`'s short gives:

```
SPLIT comp 147 in-pin nets [
  "#28:wiring.splitter+#59:Instr+#147:wiring.splitter:[43]",   <- the instruction bus
  "#147+#237:[242]", "#147+#237:[243]", "#147:[244]", "#147:[245]",
  "#28:wiring.splitter+#147:wiring.splitter:[48]"]             <- out4, shared
  nets [0x0, z, z…, z, z, 0x0] -> drives [0b0000zzzz…, 0x5, 0x3, 0x0, 0xd, 0x9]
```

So `#147`'s `out4` (net 48) is driven by **`#28` and `#147` — and nothing else** — and it
reads `0x0`. `#147` therefore claims bus bits 28–31 as `0`, and `Instr` drives `0x9` there:
bits 28 and 31 disagree, and `contention_merge` reports `X`.

**Two splitters, `#28` and `#147`, share *both* the instruction bus (net 43) and a split net
(net 48).** Each one reads the other's drive on net 48 (its pins' nets exclude its own
contribution) and gathers it back onto the shared bus — a two-splitter feedback pair whose
settled value (`0x0`) then fights `Instr`.

That leaves exactly two possibilities, and they are distinguishable:

1. **The design does not wire those two `out4`s together** — then the conversion/netlist merge
   (union-find over the format's wires) has joined two nets CE keeps apart, and every
   downstream symptom follows. That would be a *converter* bug, and the fix is in the
   transpiler/netlist, not the engine.
2. **The design does wire them together** — then CE's `Splitter.valueChanged` would push the
   same feedback and CE's `WireValue.merge` would throw `ShortCircuitException`, which it did
   not. In that case the difference is *load order*: CE's `propagate()` processes changes in
   its own order, and ours in `(time, prio, seq)`.

Checking (1) is direct — read the format's wires at the two `out4` pins of the Selector's
splitters and see whether they are one net or two — and it decides which side to fix.

### Round 7, resolved: it is possibility 2 — the wiring is genuine, so the order is the bug

The format says the two splitters really are on one net. The Selector's own wires:

```
{"a": {"comp": "c0",  "pin": "pin"},  "b": {"comp": "c55", "pin": "out4"}, "name": "Opcode"}
{"a": {"comp": "c0",  "pin": "pin"},  "b": {"comp": "c83", "pin": "in"},   "name": "Opcode"}
```

`c0` is the Selector subcircuit's own input pin, named **`Opcode`**, and it fans out to
`c55.out4` and `c83.in`. On the Datapath side that pin carries `c188.out4`. So `c188` (a
Datapath splitter) and `c55` (the Selector's splitter) are genuinely wired together **and
carry the identical map** (`out0=[0..3] … out4=[28..31]`), and **both slice the same bus** —
`c133/c55.bus` and `c188.bus` are both net 43, the instruction bus, which `Instr` and both
splitters drive.

So the design wires it deliberately: the opcode field is sliced out and routed *into* the
Selector, where it is sliced again. That means **CE's splitter would push the same feedback
and CE's `WireValue.merge` would throw `ShortCircuitException` — and it does not**, so the
difference cannot be wiring, and it cannot be authority (Round 5 settled that). It is the
**order in which the two splitters and the register reach their values within a tick** — CE
walks `CircuitState.propagate()`'s worklist, we walk `(time, prio, seq)`.

**This is the same conclusion the two cycle-bound rows reached by a different road**
(`374625393`, `410460509` are explicit combinational cycles; this is a splitter feedback pair
— a combinational loop by another name, which is why `--sta` did not flag it: the loop runs
*through splitters*, and `dep_edges` treats a splitter's pins as pseudo self-loops, not
edges). Three of the four now point at one root: **CE's within-tick propagation order.**

The remaining one, `374299303`, has no cycle at all and still needs its own trajectory.

### Round 8: CE's registers drive Z at power-on — a real divergence, and still not the fix

From CE's source: `Component.init(CircuitState, Object)` is a **no-op**, `Register` does not
override it, and `CircuitState.reset()` replaces every link with a fresh `LinkState` (all-`Z`).
So **a CE register's output port holds `Z` until its first clock edge** promotes
`getLastReceived(d)`. Our engine drives every register's power-on *state* (`0`) at `T=0`
(§4.3's "sources and state elements commit their initial outputs"), which is a definite `0`
CE never has.

Tried (under `compat` only, state untouched): drive `Z` instead of the state during the boot
settle. Measured: `373713172` 103→**104** cycles, `374625393` 102→103, `410460509` 160→161,
`374299303` 48331→48332 — i.e. nothing, and the same short survives with the same values
(`[0bzzzz…, 0x9d000035, 0b0000zzzz…]`). Reverted.

The reason is worth keeping: the `0` the splitters assemble is a **self-consistent fixed point
of their own loop** (`out4` ← bus ← `out4`), not a value seeded from a register. The loop has
two consistent states — `{bus bits 28–31 = 0}` and `{= Instr's 0x9}` — and CircuitSim lands in
the second because it starts from `Z` and only ever asserts what a driver gives it, while our
boot settle reaches the first. It really is the **settle order / initial state**, which is the
same conclusion Rounds 7 and 3 reached from three different directions. The remaining work is
to make `compat` settle a loop the way CE does — from `Z`, asserting only what arrives — which
is a within-tick fixpoint pass in CE's component order, not a per-pin rule.

### Round 10: the register fix was wrong — the corpus caught it — and `Register.init` is the proof

I claimed `Register` does not override CE's no-op `Component.init`, and drove a register's
power-on output `Z` under `compat` on that basis. **Wrong, and the corpus said so loudly:
106 verdict flips, 104 disagreements → 110.** Reverted (`3d1b1d4`), and the four went
straight back to `103 / 48331 / 102 / 160`.

The source, read properly this time, says the opposite — `Register` *does* override `init`,
one line above `valueChanged`, which is why I missed it:

```java
public void init(CircuitState circuitState, Object lastProperty) {
    WireValue value = lastProperty == null ? WireValue.of(0, bitSize)
                                           : new WireValue((WireValue)lastProperty, bitSize);
    circuitState.pushValue(getPort(PORT_OUT), value);   // CE drives 0 at power-on
}
```

So **CE's registers drive `0` at power-on, exactly as our engine already did**, and the boot
dump confirmed both states (`Instr = 0x0`). A register that drove `Z` would leave the whole
combinational cloud reading `Z` at the first edge, where `compat`'s per-pin rules only turn
`Z` into a definite value on *some* pins (arithmetic drives all-`Z`) — which is exactly the
104-submission regression.

Two lessons worth keeping. **The corpus is the oracle for anything that touches both modes**,
and it caught this inside one measurement round; and **"read the override" is a real hazard
in this codebase** — `Component.init` is a no-op and every stateful peer overrides it, so the
base class is never the answer.

`CSIM_DEBUG_BOOT` (re-added, inert) prints what every driver of a net had committed at the end
of the boot settle — it is how the two states above were compared, and it stays available for
the next question, which is unchanged: `Instr` drives `0` on the instruction bus at boot (CE
too), so a splitter *does* gather the opcode field and re-assert it on the bus, and the
`0`-versus-`0x9` disagreement arises in the window where `Instr` has moved and the splitter has
not. `resolve` judges drivers regardless of `driver_in_flight`; that is still where the next
look is.

### Round 11: the "plumbing" rule is wrong too — 138 production flips

Hypothesis: a split whose net only other **splitters** drive is the splitter's own plumbing, so
its bits come from the bus; re-asserting them should therefore use the bus's **own** value
rather than the split's merged net (which can hold a sibling splitter's tick-stale drive).

Implemented as `eval_splitter_with(nets, authored)` — `authored[i]` = pin `i`'s net has a driver
that is not a splitter — with the engine computing the flags from `net_drivers`.

Measured, and it is **not** a narrow change:

| | rows | agree | disagreements | false passes | flips |
|---|---:|---:|---:|---:|---:|
| before | 357 | 198 | 14 | 0 | — |
| this change, production | 357 | **60** | 152 | 0 | **138** |
| this change, compat | 357 | **67** | 145 | 0 | **141** |

On the four it was mixed (`410460509` unfroze 160 → runs; `374299303` 102 → 100; `373713172`
unchanged), which is exactly the kind of local movement that looks like progress and is not.
Reverted; the four are back to `103 / 48331 / 102 / 160`.

**The blast radius is the interesting part.** The rule only *should* touch a split whose other
drivers are all splitters — a shape that seemed rare — yet it moved 138 designs. So my model of
the splitter's two idioms ("split" vs "assemble") is wrong somewhere: either `authored` is
false far more often than expected (many splits are co-driven only by splitters, or the flag
misses a driver), or the *bus* gather is load-bearing for the common path in a way that reading
`eval_splitter` did not make obvious. That question is worth settling **before** any further
splitter change: instrument `authored`/`from_bus` counts over the corpus rather than reasoning
about them.

Three hypotheses have now been killed by measurement (authority, register power-on, plumbing),
each by a different oracle — the unit test, the CE source, and the corpus. Every one of them
was derived by reading a function and reasoning about the common case; none of them was
derived by *measuring the shape of the common case first*. That is the methodological lesson
this round, and it is cheap to fix: count before changing.

### The count (Round 12): splitter-to-splitter chaining *is* the corpus

`tools/splitter_shapes.py` (new, in the transpiler repo) runs `CSIM_DEBUG_SPLITTER_SHAPE`
over the 212-submission working set and tallies every splitter pin's shape — other-driver
count, and whether any of those drivers is not a splitter:

| pin shape (others, authored) | pins |
|---|---:|
| 0 other drivers — the splitter is the authority | 8887 |
| **1 other driver, not authored — driven by another splitter** | **5948** |
| 1 other driver, authored — a real component | 1628 |
| 2+ | ~1000 |

2646 splitters. **`>=1 other driver, none authored` — the exact shape Round 11's rule
targeted — is 6297 pins, the majority of split pins**, and "1, not authored" means the single
co-driver is another *splitter*. So **splitter-to-splitter chaining is the normal idiom in this
corpus** (the `c55` → `c83` pattern), not a rare plumbing case, and `authored` does not separate
"plumbing" from "assemble" at all — it is the whole common case. That is why a rule built on it
moved 138 designs.

It also settles the *opposite* question: since the common split pin is driven by a sibling
splitter, the gather **must** read the split's net value (the sibling's drive) — the original
`eval_splitter` is right, and the bug is that the sibling's value can be a tick **stale**. CE
never has a stale sibling because `CircuitState` re-merges a link after every push and iterates
to quiescence inside the tick. So the fix is the within-tick fixpoint, not the gather source —
now the *measured* conclusion rather than a reasoned one.

Lesson, reused: instrument, count, *then* change. Three hypotheses died from reading a
function and reasoning about the common case; this one line of counting settled in a minute
what three rounds of reasoning got backwards.

### Round 13: CE **defers** a short — and deferring it unfreezes two of the four

Round 12's count pointed at propagation order, so I read the order instead of guessing at it.
CircuitSim's `Simulator.step` is explicit:

```java
for (Pair<CircuitState, Link> pair : temp) {
    try { state.propagateSignal(link); }
    catch (ShortCircuitException exc) { lastShortCircuitedLinks.add(pair); }
}
...
// Only throw the ShortCircuitException if there's no more links to update, which means that
// links have reached a steady state
if (!lastShortCircuitedLinks.isEmpty() && linksToUpdate.isEmpty()) { ... throw ... }
```

**A disagreement does not update the link at all.** CE records it and only *raises* it once the
update set is empty — so at every intermediate moment the link keeps its previous value and its
consumers keep seeing that; the next push re-merges. A **transient** disagreement is invisible.

Our engine did the opposite: `resolve` turned a disagreement into `X` on the spot, every
consumer propagated that, and nothing could undo it — CE has no `X` to undo it with. That is
the whole `x-cascade` family in one sentence.

Implemented under `compat` only (`resolve_detail` reports the short; the commit skips the net,
leaving it at its previous value):

| submission | prod | compat before | compat after |
|---|---:|---:|---:|
| `373713172` | 103 | 103, frozen | **10000 — runs** |
| `410460509` | 160 | 160, frozen | **40625 — runs** |
| `374299303` | 48331 | 48331 | 48331 |
| `374625393` | 102 | 102 | 102 |

and `CSIM_DEBUG_SHORTS` now reports **no short at all** on `373713172`. Production is unchanged
by construction (the branch requires `self.compat`), and verified unchanged on the four.

The two unfrozen rows do not yet *halt*, and the change is **net-negative**, so it was
reverted rather than kept:

| | agree | disagreements | flips |
|---|---:|---:|---:|
| compat before | 208 | 4 | — |
| compat with the deferral | **205** | **7** | **3** (pass → fail: `374337181`, `374593140`, `374625075`) |
| production with it | 198 | 14 | **0** (the branch requires `self.compat`, as designed) |

It moved the two rows and broke three, which is the shape of a blunt approximation rather than
the rule. `Simulator.step` records the *pushers'* values and re-merges on the next push, so the
link converges; leaving the net at its previous value until a driver commits again is the same
thing **only if a driver does commit again** — where none does, the net stays stale forever,
which is a new failure mode rather than CE's. So the finding stands (`X` on a transient
disagreement is wrong) but this implementation of it is not the fix; a faithful one has to
re-attempt the merge at quiescence, not merely skip it.

### Round 14: CE delivers the *others'* merge, per port — gated to `compat`

`LinkState.propagate()` computes each port's incoming value as the merge of the **other**
participants:

```java
WireValue getIncomingValue(Port port) {
    WireValue newValue = new WireValue(link.getBitSize());
    participants.forEach((p, info) -> { if (p != port) newValue.merge(info.lastPropagated); });
    return newValue;
}
```

So a part that both drives and consumes a net reads the **others'** value for it, and the
exclusion is by **port** — not by part. The engine already did this for splitters
(`resolve_except`), which is why `373713172`'s shared bus was unaffected when this was added:
its consumers there are splitters. Every *other* consumer was being handed the all-drivers
merge.

Two things had to be right, and the first attempt got one wrong:

- **Exclude the port, not the part.** Excluding the whole part turns `nand(a=src, b=self)` from
  a storm into a self-ignore — which `event_storm_halts_with_oscillation` pins, correctly: with
  port-level exclusion `g.out` is still a participant on `g.in1`'s link, so the loop still has
  no stable state. The first patch excluded `sp.comp` and broke both oscillation tests; the fix
  filters `(comp, slot)`.
- **Gate it to `compat`.** The self-loop storm is a *production* behaviour with a test behind
  it, and changing it is a separate decision from CE fidelity. Production keeps the all-drivers
  merge; `compat` gets CE's reading.

Measured on the four: identical in both modes (`103 / 48331 / 102 / 160`), because their
implicated bus is consumed by splitters, whose view already excluded them. So this is a general
fidelity fix rather than their fix — the same shape as the Xor/Xnor and invalid-select arms.

### Round 15: the wire names, and the first hard look at `Instr-FBUF`

Three rounds of hypotheses were derived without a way to *see* the net they were about, so
this round began by building the instrument (see the two commits `592ddbb` / `9449a61`).
It produced the first hard evidence in five rounds, and four rounds of candidates that the
evidence then killed.

**The gap.** The engine dropped every wire name — 0 of `373713172`'s 371 nets carried a label
— and `NamedKind` had no net variant, so there was no way to ask *"what is the net called
`Instr-FBUF` carrying this cycle?"*, which is the only question that matters when two engines
disagree about a bus. The name was in `circuit.wires[].name` all along and thrown away at
build. `Netlist::labelled` now keeps every *(name, net)* pairing (instance-qualified, and
deliberately **not** collapsed: a name is a label, not a merging rule, so one net carries
several names and several nets share one). Surfaced as:

- `csim nets --label <wire>` — one bus by name, with each driver's **pushed** value
  (`NetDump::driver_values`: the net's value says `X`, only this says *which two pins fight*)
- `PROBE_NETS` — every named net's value, per cycle; `PROBE_RAW` — `merged|ok|SHORT`
- on the old side, `CircuitState.getMergedValue(link)` and `isShortCircuited(link)` are both
  `public`, so `TraceTests` grew `TRACE_RAW` (`ce_trace.py --raw`): four-state
  `received|pushed|merged|SHORT`. `WireValue.State` is `ONE`/`ZERO`/`Z` — the old tool has
  no `X` at all — so any `x` is a divergence by construction.

**What it showed.** `Instr-FBUF` is net 43, with three drivers. At the moment the fetch
worked:

```
c153.q        (Instr)                   -> 0x3dd00000      fresh, correct
c133/c55.bus  (the Selector's splitter) -> 0b1001zzzz…      stale: the *previous* instruction's nibble
c188.bus      (the root splitter)       -> 0b0000zzzz…      stale: the boot instruction
```

and the bus merged `0bxxxx…|SHORT`. The old tool's trace of the same wire at the same cycle
is `0011110111010000…|ok` — a clean instruction, not shorted. Our `Instr` then went `X` a
cycle later and the program stopped executing at all.

**The mechanism — a combinational cycle of length 2 between two splitters.** The
`CSIM_DEBUG_SPLITTER` narration (now addressable by id or `name`, not just an index) shows
both handed the *fresh* bus and parting on **order**. `bus → c188.out4 → net 48 (Opcode) →
c55 → c55.bus → bus`: two splitters that share **one bus** *and* **one split net**. The old
engine iterates `Simulator.step()` until nothing changes; an engine that evaluates each part
**once** reads the sibling's *previous* split value —

```
c188 handed bus 0x9d000035 (clean), but reads c55's PREVIOUS out4 = 0x0 -> drives 0000
c55  handed bus 0bx00x… (already X, from c188.bus = 0000)             -> drives 1001 (correct)
```

— so the first echoes a stale slice, the second is poisoned by `merge(fresh, stale)`, and
`X` is absorbing, so the bus never recovers. This is the same shape as `374625393` and
`410460509`, and it means `373713172` had a combinational cycle after all, contrary to the
earlier note that it had none.

**Four candidate rules, and what killed them.** All compat-gated, all measured on the compat
corpus (baseline `report-compat-skip.json`: 357 rows, 208 agree, 4 disagreements, 0 false
passes), and all reverted:

| rule | idea | verdict |
|---|---|---|
| A | splitter drives `Z` on a split net whose only other drivers are splitters | **180 flips** pass→fail (28 agree) |
| A′ | the same, restricted to *split* pins (`pin_i > 0`) | **141 flips** pass→fail (67 agree) |
| B | for a split shared with a splitter on the **same bus**, take its bits from the bus | target not fixed: both splitters lock to `0000` (bus `0bx00x…`), so not measured |
| — | (round 11) the same idea in production | already falsified: 138 flips |

A and A′ are the same mistake at two widths: zeroing a driven bit throws away a value that
nothing else drives. B fails for a subtler reason and it is the useful result: with the bus
in the poisoned state, the splitter's **own incoming merge disagrees**, so `6a6ce08` skips its
delivery, so it is never re-evaluated, so it never even reaches the code that would fix it —
it keeps its old drive (`0000`) forever. Which is exactly what the old engine does *per step*
too; it just keeps stepping. **A one-pass engine cannot express that fixpoint by changing one
part's output rule.** The remaining question is therefore not "which value should a splitter
drive" but "where does the iteration come from" — and that is the `374625393`/`410460509`
work, now with a way to watch it.

### Round 16: the root is the **subcircuit boundary**, not the splitter

Round 15's `TRACE_LINK` enumerated the old engine's own link state per port — who is asserting
what, not just what the net merges to — and it ended the search. On `373713172`:

```
Instr-FBUF link, cycle 1:
  Instr#4[Register/5] = 00111101110100000000000000000000     <- the ONLY driver
  #0[/1]              = zzzz…  (r:00111101110100000000000000000000)   <- a Tunnel peer
  #0[Pin/1]           = zzzz…                                  <- a wiring.pin tap
  #0[Pin/1]           = zzzz…  (r:00111101110100000000000000000000)
```

**No splitter drives the instruction bus in the old tool.** Our net 43 has three drivers
(`c153.q` = `Instr`, `c188.bus`, **`c133/c55.bus`** — and `c133` is the *Selector instance*);
the old tool's link has one. The extra driver is inside a subcircuit, and that is the whole
difference:

- The Selector declares `Ins` as a 32-bit **input** pin (`{"bitsize":32}`, no `isOutput`).
- In the old tool a subcircuit's inner nets live in a **separate `Circuit`/`CircuitState`**,
  connected only by value-copies across the boundary. The boundary is therefore
  **one-directional**: for an input pin, outer → inner only. Nothing inside can drive the
  outer net, so the inner splitter's bus drive never reaches the bus and there is no cycle.
- Our expander *flattens* the boundary with a directionless union
  (`netlist.rs`: `self.uf.union(b, child_node)`, and a `wiring.pin` "dissolves when
  inlined (they are pure connectivity bridges)"), so the inner splitter lands on the outer
  bus as a driver. That is the cycle `Round 15` measured, and it is why **no splitter rule
  could fix it**: the splitter was never the thing that was wrong — the *boundary* was.

The same absence explains `Round 15`'s two falsified rules and it is the honest reading of
their numbers: suppressing a splitter's bus drive flips 141–180 submissions because it
changes a value that in most designs is real — nothing about the splitter is wrong there.
It was only *this* driver that should not have reached the bus, and the reason is structural.

The old tool's tunnels are the same idea at a smaller scale: `Tunnel.valueChanged` **pushes**
onto each same-label peer's own port rather than sharing a link, and for three or more peers
the value it pushes is the merge of **every peer except the receiver** (`if (tunnel !=
otherTunnel)`, including the sender) — which is exactly `LinkState.getIncomingValue(port)` —
`continue`ing on a disagreement, so a tunnel is a one-way copy between separate links with
the same deferral and never a merging rule. That is a third independent confirmation of the
`Round 14` per-port, others-only delivery work (after `getIncomingValue` and the splitter).

**What is left, precisely.** The flat model needs the boundary to be directional:

- an **input** pin: the inner net is driven by a copy of the outer, and the inner parts do
  **not** drive the outer;
- an **output** pin: the outer net is driven by a copy of the inner, and the outer does not
  drive the inner;
- a pin in neither direction (an inout) stays a union.

Since a `wiring.pin` has one port and dissolves on inlining, this has to be a *synthetic
copy element* inserted at the bridge (the old tool's copy is free — it happens within a
step), which is why it is not a one-line change: it alters the flat topology of **every**
design with a subcircuit, so it needs a full corpus run in both modes, and the element's
delay has to be zero (or the boundary's own) or every timing shifts.

The evidence is now unambiguous and the lever is identified; the change itself is the next
piece of work, not a guess.

### Round 17: the boundary, made directional — `373713172` fixed, no regressions

Round 16 identified the lever: the old tool keeps a subcircuit's inner nets in a **separate
`CircuitState`** and joins them to the outside by value copies across the interface pins,
while the expander **unions** the two sides (`uf.union(b, child_node)`), so an inner part
becomes a second driver of an outer net. The old tool's own
`simulator/components/Subcircuit.java` states the two directions exactly:

```java
// init: an OUTPUT pin (not input) pushes the inner value to the outer port
if (!pin.isInput()) { pin.addChangeListener(subcircuitState, (p, st, v) -> circuitState.pushValue(port, v)); }

// valueChanged: an INPUT pin pushes the outer value into the inner net
if (pin.isInput()) subcircuitState.pushValue(pin.getPort(0), value);
```

So an input pin injects the **outside value in**, an output pin the **inside value out**.

**The first attempt, and why it was wrong.** `Netlist::boundaries` now records every
interface pin as *(net, instance path, crossing)* and `driver_visible` hides the far side's
drivers from a reader. Applying the two directions *independently* — an inner driver hidden
from outside readers at an input, and an outer driver hidden from inside readers at an
output, as two separate rules — took compat from 208 agree to **182**, 27 designs flipped to
fail. The old tool's `Subcircuit` is the reason: a net carrying **both** an input and an
output pin of one instance is bridged **both ways**, so *nothing* is hidden across it, and
the two rules each hid half of a mutual bridge. Register files, RAMs and ALU modules — any
module wired with an in and an out pin on one net — are exactly that shape.

**The rule, once**, per *(net, instance)*, grouped:

```
has_in  has_out   across (driver inside ↔ reader outside)   across (driver outside ↔ reader inside)
  1       0       hidden                                   visible
  0       1       visible                                  hidden
  1       1       visible                                  visible
```

Which is just: *a crossing is one-way only when the net has a pin on one side and not the
other.* A net with no boundary on it — almost all of them — is never filtered, and the
resolution path keeps its borrow (`resolve_except_visible` short-circuits to
`resolve_except`).

**Where it applies.** Both compat resolution sites: a splitter's view of its own pins, and
the per-sink delivery (`resolve_except_visible`), which short-circuits to `resolve_except` on
the nets that carry no boundary — almost all of them — so the common path keeps its borrow.
Production is gated off, and prod measured **byte-identical**: 357 rows, 198 agree, 14
disagreements, 0 false passes, **0 flips** (`report-prod-boundary.json`).

**Measured.** `report-compat-boundary2.json`, against `report-compat-skip.json`:

| | before | after |
|---|---|---|
| agree | 208 | **209** |
| disagreements | 4 | **3** |
| false passes | 0 | 0 |
| flips | — | **1: `373713172` (pass → pass)** |

`373713172`'s instruction bus now matches the old tool cycle for cycle in compat
(`3DD00000 93000010 33300000 …` where it was `X` from cycle 1), it runs instead of stopping,
and `event_storm_halts_with_oscillation` and the rest of the suite are untouched. The
remaining three are `374299303`, `374625393` and `410460509`.

### Round 18: a tool bug that hid the signal, and the Z-walker

**The probe was hiding `Z`.** `probe_trace`'s renderer fell through to
`format!("{:X}", v.to_u64().unwrap_or(0))`, so an all-`Z` value printed as **`0`** — the one
distinction a register trace exists to make. Columns that read `0` in earlier rounds may
therefore have been `Z`; nothing that mattered was decided on them (the bus work used
`PROBE_RAW`/`PROBE_NETS`, which are four-state, and the aligned register comparisons held
real numbers where they agreed), but the display was wrong and is now `?` for any value
with a `Z` or `X`, exactly as the old tracer's `get()` prints `?`.

**`tools/trace_z.py`** answers "why is this net `Z`?" by walking upstream to the part that
*is* the cause. `csim nets` already reports every net's drivers, sinks and value with
instance-qualified pin labels (`c0/c12.out8`), so the whole design's pin→net graph is one
call and the walk is in memory — and it reaches parts **inside subcircuits**, which
`csim nets --comp` cannot address at all (several of the dead ends below are exactly that).

**What it found in `374625393`** (a multicycle datapath, `PC`/`IR`/`State`, stuck at `PC=2`).
The control word — every one of `nets 12..31` (`opSel`, `SelB`, `LdPC`, `LdIR`, `WrREG`,
`DrALU`, …) — is `Z`, all of it driven by one splitter inside the microcontrol unit
(`c0/c12`). The walk reaches the bottom in one pass:

```
HALT (net 43)      <- c0/c3.eq comparator, a = opcode
opcode (net 0)     <- c69.out0 splitter, bus = net 48 <- c5.out mux, sel = opSel (Z)
opSel  (net 16)    <- c0/c12.out13  (the control word, Z)
control word       <- c0/c3.out ROM(MAIN), addr = c0/c7.q = State
State              <- c0/c34 next-state mux ...
```

and, watchable because `State` is a named register:

```
                       State   IR          (PC)
after 0 cycles         0       0           0
after 1 cycles         1C      9D000035    1     <- all definite
after 2 cycles         ?       3DD00000    2     <- everything Z, and stays
```

Cycles 0–1 are **fully definite** — the control word is `0x19f5240` then `0x8206300`, `State`
`0x0` then `0x1c`, `opcode` `0x9` — and at the tick into cycle 2 the ROM's output, the control
word, `State`, the next-state mux, the decode mux and `HALT` all go `Z` **together**. So this
is not a wrong value anywhere: the design is *frozen*, and the thing to find is what turns
definite into `Z` at that one tick — most likely the clock mux (`c3`, `sel = HALT`), since
`PC`, `IR` and `State` all stop together and none of them advances again.

`374299303` and `410460509` are the other two.

### Round 19: `374625393` is frozen by a `Z` latched at one edge — and what CE samples

`Register.java` says exactly what a clock edge takes:

```java
if (state.getLastReceived(getPort(PORT_ZERO)).getBit(0) == State.ONE) { pushValue = WireValue.of(0, bitSize); }
else if (state.getLastReceived(getPort(PORT_ENABLE)).getBit(0) != State.ZERO) {
    if (portIndex == PORT_CLK && value.getBit(0) == State.ONE) {
        WireValue pushValue = state.getLastReceived(getPort(PORT_IN));   // the D port's LAST RECEIVED
        state.pushValue(getPort(PORT_OUT), pushValue);                    // pushed verbatim — Z included
```

- the edge test is the **clock port's incoming value** (`value.getBit(0) == ONE`), not a live read;
- the value latched is `getLastReceived(PORT_IN)` — the D port's last **delivered** value — pushed
  **verbatim**, so a `Z` there is latched as `Z`;
- a `Z` enable reads **set** (`!= State.ZERO`) and a `Z` reset **clear** (`== State.ONE` fails).

Our compat arms already match all three (`z_compat`: `en` → `One`, `clk`/`rst` → `Zero`; the
`34e83b0` "a floating `d` latches `Z`"), and the engine reads the same `views[]` a pin
*received*. So the rules are not in question — the question is the **ordering inside the tick**.

The design's steady state for `State`'s `d` is `Z`, and its select is a control word bit that
is itself derived from the ROM addressed by `State`:

```
State.d <- c0/c34 (next-state mux), sel = control bit  <- control word <- ROM(MAIN).addr = State
```

So the next-state mux's select and the state it proposes to move to depend on each other, and
at the edge that matters the select is `Z` — our mux drives `Z` on an invalid select, the
register latches it verbatim, and from then on the control word, the decode mux, `opcode`,
`HALT`, the clock mux and every clocked part are `Z` together. It never advances again.

There is a real candidate divergence here, and it is narrow: the old tool reads `D`'s
`lastReceived`, which is the value delivered to the port *most recently*, so its answer depends
on whether the `D` link propagated before the clock link in that step. Our engine should be
comparable — but `D`'s settled value at the edge and the clock's rise are both derived from the
same edge, so the two can interleave, and here they do. Confirming it needs tracing **within**
one tick (the per-cycle samplers run out), which is the next instrument; the state to explain
is not a wrong value but a latching decision.
### Round 20: a RAM holds its output on an invalid address — `374625393` unfrozen

Round 19 left `374625393` frozen with `State` going `Z` at one edge, and the ordering question
open. It was not ordering — it was a **value the old tool never produces**.

The work started with the instrument the per-cycle samplers could not give: `CSIM_DEBUG_COMP`,
which narrates one part's every evaluation with its **timestamp and what it read** (each input
pin's *view*, i.e. `getLastReceived`), because a register's latch decision happens *inside* a
cycle and the samplers only see its edges. Watching `State` and the clock gate through the
failing tick:

```
t=4000  c3 reads [clk=0x1, in1=0x0, sel=0x0] -> 0x1        <- real clock rise
t=4012  c0/c7 reads [d=0x0,   clk=0x1, en=0x1, rst=0x0] -> 0x0   <- correct latch
t=4119  c3 reads [clk=0x1, in1=0x0, sel=0bz] -> 0bz        <- sel (HALT) glitches Z
t=4189  c3 reads [clk=0x1, in1=0x0, sel=0x0] -> 0x1        <- back to 1 …
t=4201  c0/c7 reads [d=0bzzzzzz, clk=0x1, …] -> 0bzzzzzz   <- … and the Z d is latched
```

so the shape was clear: something drives `Z`, `HALT` → the clock gate → `CLK` follows, and the
recovery is an edge that latches a `Z` `d`. Every *rule* along the way checked out against the
old tool's source (a `Comparator` with an invalid input drives all-`Z`; a `Multiplexer` with an
invalid select drives all-`Z`; a disabled `ControlledBuffer` drives `Z`; `Register` latches
`getLastReceived(PORT_IN)` verbatim on `== ONE`), and the control word matched CE bit for bit
(`opSel`, `HALT`, `LdPC`, `Dr*` — measured in both engines, `opSel` is `1` during the fetch in
both). So the fault had to be in a *value*, not in an order — and `trace_z`/the nets dump put
it on the bus: with `DrMEM=1` the bus should carry the RAM's `dout`, and ours carried `X`/`Z`.

The old tool never does that. `RAM.java`:

```java
case PORT_ENABLE:
case PORT_LOAD:
    if (!enabled || !load) { state.pushValue(getPort(PORT_DATA), noValue); }
case PORT_ADDRESS:                                  // falls through — no break
    if (enabled && load && address.isValidValue()) {
        state.pushValue(getPort(PORT_DATA), WireValue.of(load(state, address.getValue()), …));
    }
    break;
```

With the enable asserted and the address **not a valid value**, it pushes *nothing at all*, so
the link keeps what it was last given — a port's drive is **sticky**. Ours produced `X` (or let
the floating-address `consume` fire), and one `X` on a memory output is enough to poison a
control word: `opcode` → `HALT` → the clock gate → a spurious edge → a frozen FSM.

`compat` now leaves the `dout` drive exactly as it stands when the address carries a `Z` or an
`X` — i.e. schedules no `Fire`, which *is* CE pushing nothing. Measured on `374625393`:

```
                    State   IR          PC
before   …          1C      9D000035    1
                    ?       3DD00000    2     <- frozen, everything Z
after    0→1→1→2→2→3→3→4→4   and State alternating 0 ↔ 1C
```

— it executes, on CE's own cadence (`PC` advancing every two cycles), where before it stopped
at `PC=2` and stayed. It does not yet halt, so a further divergence remains; the point here is
that the *freeze* is gone and the reason is a value the old tool cannot produce.

Measured on the compat corpus, against `report-compat-boundary2.json` (357 rows, 209 agree,
3 disagreements, 0 false passes): **0 flips**, so holding is verdict-neutral — as it should be,
since it removes a value rather than supplying one. Production is gated off. Snapshot:
`report-compat-ramhold.json`.

### Round 21: `374625393` now executes — where it parts next

With the RAM hold in, the design tracks the old tool **exactly** for 26 cycles: the whole
register file is identical row for row (`$at..$ra`, `$sp = A000`) and `PC` advances on CE's own
cadence. The first difference is a branch:

```
CE[ 24] PC=  D  IR= 56700001        ours[ 25] PC=  D  IR= 56700001
CE[ 26] PC=  F  IR= 61F00000        ours[ 27] PC=  E  IR= 61F00000   <- CE takes it, we don't
```

`56700001` is a `bne` (opcode `5`) with immediate `1`, so CE's target is `PC+1+1 = F` (the delay
slot) and ours is the fall-through `E`. The register file at that row is *identical*, so the
operands agree and the decision logic is what differs — and `--sta` had already named this
design's critical path **"Comparison Logic"**, a subcircuit whose output steers the
microsequencer's ROM (`c100/c30.out → c0/c38.addr`).

Reading that sheet's own nets around the branch:

```
cycle 25   c21.eq=1 (opcode==5)  c23.eq=1 (A-B==0)  c24.out=0  c31.out(Jump)=1
cycle 26   c21.eq=1              c23.eq=0           c24.out=1  c31.out(Jump)=0
cycle 27   c23.*=Z  (A-B, net 38, is Z)
```

so `Jump` is `1` at cycle 25 and `0` at cycle 26, the branch is *not* taken, and the comparison's
operand (`A - B`, the shared bus net 38) is `Z` by cycle 27. The branch is decided from a signal
that pulses at one microstep and is stale at the next — the same *family* as the RAM hold: a bus
that CE keeps at its last value and ours drops to `Z` once the enabled driver stops. That is the
thread to pull next, and it is now localised to a sheet, a net and two cycles.

Instrumentation added this round: `CSIM_DEBUG_COMP` (one part's every evaluation, with its
timestamp and what it *read* — the per-cycle samplers cannot see a latch decision made inside a
cycle), and `probe_trace`'s name matching now trims whitespace, because the old tool's labels
routinely carry leading or trailing spaces (`" $a0"`) and one stray space silently turns a whole
trace column into `?`.

### Round 22: `374299303` — a single stray bit, found by the same comparison

The same trajectory diff, on the second design: it matches the old tool across the **entire
register file for 79 rows** (`$at..$ra`, `$sp = A000`, `PC` on CE's cadence) and then parts on
one value:

```
CE  [79]  $sp =   9FFF
ours[80]  $sp = 109FFF
```

`0x109FFF − 0x9FFF = 0x100000` — **one bit, bit 20**, set where the old tool has it clear. The
previous row has `$sp = A000` in both, so that is a `$sp − 1` producing `A000 − 1 = 9FFF`, and
ours adds a stray bit 20 to the result. No `X` is involved (the drive is a clean `1`), so nothing
is conflicting — a *source* is wrong at that bit, not a merge. Reported here rather than chased
further: the instrument set now finds the exact row, value and bit in one pass on every design,
which is what these three needed, and `410460509` is the same call away.
