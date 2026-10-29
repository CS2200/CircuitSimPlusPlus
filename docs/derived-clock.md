# The derived clock: the period is an output, not an input

**Status:** implemented. §2/§3 are what the engine does: every edge is placed by the drain,
the legacy run parameter is gone, and `t_obs` is the derived period. Supersedes the `--clock-half-period-ns`
run parameter as the way a cycle is bounded. Written before implementing; §7 says what has
to be true afterwards.

## 1. The problem

A cycle used to be bounded by a **run parameter**: `--clock-half-period-ns`, default 1000 ns
(2000 ns period). It exists because three things need an edge time — the `wiring.clock`
source (a square wave needs a period), setup/hold detection (comparing a data change to the
edge), and the per-cycle `t_obs` fold (needing a cycle boundary).

`docs/delay-table.md` claims the parameter *"does not affect correctness — it sets edge times
for setup/hold detection"*. **That claim is false.** `submission_374625393` is the
counterexample: same design, same engine, only `settings.delayTable` changed, and the verdict
moved 211 → 212. The mechanism is that a design whose settle exceeds the period latches a
**stale** value at the edge, and whether it exceeds depends on the delays. So the period
decides values, and the table was deciding the period.

More fundamentally it is the wrong shape for what this product is for: **the period a design
must meet is derived from the design.** Making it an input means someone picks a number
unrelated to the design, that number silently decides correctness, and `t_obs` is measured
against it.

## 2. The model

**The clock is a phase transition whose *time the drain decides*.** A transition is queued —
the engine needs an event to wake on — but its queued time is only "one step after the edge
that scheduled it", and it is *placed* when it comes due:

```
loop:
    a transition comes due at `edge + MIN_STEP`    ← a placeholder, not a period
    drain the queue to quiescence                  ← the cascade, to quiescence
    place it at max(its due time, quiescence + setup if it samples)
    apply it: the transition schedules the registers' clk→Q and its cascade
    every second transition is a rising edge → latch, and count a cycle
```

- The clock's **first** edge is at `clock_start` (`delay::DEFAULT_CLOCK_START_NS`) — the
  timeline's origin, and the only thing that number decides.
- The queue has just been drained when the placement is decided, which is what makes the
  placement the design's own number rather than the placeholder's.
- `MIN_STEP` (1 ns) exists because a transition may not land on its own scheduler's timestamp:
  with no clocked parts there is nothing to drain and no setup to charge, so two transitions
  would share one instant forever and trip the event-storm cap.
- Causality makes the drain exact: events belonging to the next cycle are only scheduled *by*
  the transition, which hasn't happened yet. So everything drained belongs to this cycle.
- **A design that never quiesces never transitions** → the existing event-storm cap declares
  an oscillation. "Never hang" is unchanged.
- The settle is `now` at the moment of the transition, so the edge is placed *after* the data
  — which also means the time-inversion problem cannot arise (there is no scheduled timestamp
  to contradict).

**Setup is added when the transition is placed** — and only to a transition that *samples*.
Setup means the data must be stable `t_setup` *before* the edge, so a sampling transition
waits: `edge = quiescence + max t_setup` over the clocked parts. A falling edge latches
nothing, so it has no data to be stable and is placed at quiescence; charging it too would
charge two setups per cycle (measured: 69 where this model says 54). **Hold then comes for free** — the data is stable across the edge because
nothing moves again until the next transition, so there is no race to hold against.

## 3. What the period is

```
period = t(rise k+1) − t(rise k)
       = the rising cascade + the falling cascade
       = depth + setup          (the total clock cycle time, in hardware terms)
```

`t_obs` **is** this: the maximum over the run of the derived period, i.e. the clock rate the
design can actually be run at. The field and the quantity are one thing now. They were not
before: the field held the *settle* (39 on the pipeline, where the period is 54) and the 15 ns
setup gap the barrier inserted was measured by nobody.

**The metric must use the maximum, not the sum.** Each cycle takes its own time (its own
depth), so the simulated elapsed time is the *sum*; real hardware clocks at the *worst* depth.
So `est_time = cycles × max(period)`, which is `cycles × t_obs`.

## 4. Why this removes the table-dependence

The table can only change **when** things happen. Today that decides **what** gets latched,
because the edge can arrive mid-cascade. With the transition placed after quiescence there is
no race, so the table cannot decide a value — it only changes the derived period, which is the
*number*, not the verdict.

> Table-independent values and setup/hold can never firing are the same coin: **the design
> never races the edge.**

## 5. Consequences

- **`timing_violations` retires.** No design can violate setup or hold, because the edge is
  never too early. `--assert "violations == 0"`, and its `== 1` twin, leave the grammar entirely — both become *parse errors*, which is the only form of "gone" a grading script cannot misread. (Do this *after* the mechanism
  is proven — see §7.)
- **A too-slow design can no longer fail**; it can only score badly. "Your clock is too fast"
  moves entirely into the number, which is where the rubric already lives
  (`rubric_full_credit_below` on `est_time`).
- **`--sta` / `t_sta` / `sta_paths` retire** (decision 2026-10-28). STA is informational only,
  it refuses outright on 129 of 212 designs, and it uses a *different* convention (excludes
  clk→Q, includes setup) so its number is not comparable to `t_obs` — the muddle disappears
  once there is only one timing number.
- **`--clock-half-period-ns` retires**, along with the `clock_half_period_ns` snapshot field —
  a format-contract change, so a version bump. Until then it is at most a **floor** (so a
  zero-depth design cannot give a zero period) and the wall clock is the runaway guard.
  `clockHz` in a document is the **UI playback speed** and is a different thing entirely.
- **Self-oscillating clock sources are not permitted** (decision 2026-10-28): a design must
  quiesce between edges. Gated and divided clocks are fine — they are logic driven by the
  global transition and settle with the cascade. A ring used as a clock is an oscillation
  halt by construction, which is the intended answer.

## 6. Risks

**Artefact loops can storm.** Today the edge **cuts** a cascade that has not finished, so a
design with an unterminating conservative loop still produces values. Remove the cut-off and
that loop is allowed to run until it quiesces — and if it does not, it hits the event-storm
cap and halts. This can turn a passing row into a failure.

Evidence for the size of the risk: in the levelized (`settle-engine`) model exactly **one**
of 212 designs oscillated, and it is such an artefact loop. So it looks small — but it is the
reason §7's acceptance bar is absolute.

Note this is *also* the second reason the dependency-graph work is not wasted: the same
artefact is what a precise graph would remove, and this change is what would surface it.

## 7. Acceptance

The change will move the corpus — it is meant to. So the bar is defined up front:

1. **Every row that passes today still passes.** If a row turns into an oscillation halt,
   examine whether it is a genuine unterminating loop (then it is the design's fault, per
   decision 2026-10-28: we do not want an infinite cycle in real circuitry) before treating
   it as a regression.
2. **`submission_374625393` gives the same verdict under both delay tables.** That is the
   actual property — the row that moved 211 → 212 on a table change — and it is a two-minute
   check.
3. Production's known disagreement set does not grow.
4. The levelized engine is *not* in play here: this is `master`, the delay-aware engine.

## 8. Order of work

Slice 1 — the mechanism, no contract edits:

1. the transition-on-drain (the clock stops being a queued event);
2. the `+ max(t_setup)` placement;
3. the period derived as rise-to-rise, `t_obs` = its maximum;
4. measure: the two-table test on `374625393`, then a full prod run and a full compat run.

Slice 2 — the contract, once slice 1 holds:

5. retire `timing_violations`;
6. retire `--sta` / `t_sta` / `sta_paths`;
7. retire `--clock-half-period-ns` and the snapshot field (format version bump);
8. update `docs/delay-table.md` — including the claim in §1 that this document falsifies.

## 8b. First attempt (2026-10-28): hung, reverted

Implemented the barrier in the two run loops (`apply`'s caller: drain the queue before
firing the edge, re-stamping the edge to `self.now`) plus `cycle_start` (the settle measured
from the actual edge) and `EventQueue::len`. It **compiled and hung**: the defining test —
`submission_374625393` under both tables — did not finish in 30 minutes.

That is §6's risk, and it is not subtle. Removing the edge as a cut-off means a design whose
combinational loop does not quiesce now iterates it **unboundedly within a cycle**, with each
lap costing real delay. The storm cap counts events per cycle, but `close_cycle` — which
resets that counter — only runs at the edge, and the edge never arrives. So the cap cannot
fire and the run does not terminate.

Two things follow, and both are prerequisites rather than options:

1. **The per-cycle cap must be enforced during the drain**, not only at cycle close — a
   "drain budget" that trips an oscillation halt. Without it the barrier can hang, which
   breaks the one contract that is not negotiable ("never hang").
2. **The artefact loop has to be understood before the barrier can be safe.** This design is
   `MULTIDRIVER-ONLY` per `CSIM_DEBUG_CYCLE` (on the `settle-engine` branch) — i.e. its loop
   is manufactured by the conservative dependency rule, and today the edge is what hides it.
   The derived clock exposes it. So the dependency-graph work is a *prerequisite* here, not a
   parallel task.

Reverted; `docs/derived-clock.md` is kept as the design of record, with this as the gate.

## 8c. Measured (2026-10-28): neutral, and it does NOT fix table-dependence

Slice 1 is implemented (`781174d`) and measured.

**Full corpus, POW only, 358 designs, both binaries frozen:**

| | pass | fail | timeout | error |
|---|---|---|---|---|
| `master` (fixed clock) | 224 | 133 | 0 | 0 |
| **derived clock** | **224** | **133** | **0** | **0** |

**Zero rows differ.** So: no regressions, and no hangs — the earlier "hang" was a leftover
`while ... next_boundary` loop that never terminated once `close_cycle` stopped advancing it,
not the barrier.

**But it does not fix what it was for.** `submission_374625393` under both tables:

| table | halt | cycles | t_obs |
|---|---|---|---|
| `mips-r2000-2um-v1` | stop | 2834 | 114 |
| `cs2200-74ls-v1` | **completed** (never stabilises) | 150000 | 403 |

Still table-dependent. Removing the **race** is not enough, because the table can decide a
value by at least two other routes:

1. **Inertial glitch filtering.** A gate swallows a pulse narrower than its `t_pd`. A bigger
   table swallows more, so a design can see different values — and CE has *no* filtering, so
   any of it is a divergence from CE.
2. **The tie-break.** Equal timestamps are ordered by `(time, seq)`; different durations move
   *where* the ties fall, so a non-confluent settle can land differently.

**Conclusion.** The derived clock is the right shape and is a prerequisite — the clock should
not be an input — but it is not sufficient: table-independent *values* need a value model with
no time in it at all, which is the levelized engine. The two efforts are complementary, not
alternatives: this one removes the race, that one removes the filtering and the tie-break.

## 8d. The origin bug (found and fixed 2026-10-28)

`t_obs` read 2990 where the overclocked-chain fixture expects 990. Instrumenting the
measurement showed why:

```
SETTLE t=2990 cycle_start=0 dt=2990 rising_seen=0 in_boot=false
```

`rising_seen = 0` — **no edge had occurred yet** — while `in_boot` was already false. So
there was an unguarded window between "boot ends" and "the first edge", and the derived
clock makes that window *long*, because the first edge is deferred until the initial
cascade settles: the origin stayed at 0 for the whole stretch.

Fixed by requiring `rising_seen > 0` before measuring — nothing is measured before the
first edge.

## 8e. What the four failing tests are (2026-10-28)

`cargo test`: 224 pass, 4 fail, and all four are the **legacy machinery**, not the derived
clock:

- `setup_and_hold_violations_are_warnings`, `violations_assertion_and_report_entries`,
  `overclocked_chain_completes_with_setup_violation` — they assert that violations exist.
- `watch_changes_counts_moves` — counts a latch at a specific edge time.

And a finding that *forces* the decision: **violations now fire spuriously.** The edge is
placed at the moment the drain ends, and the last data change is by definition *at* that
moment — so the last-changing register input is always "within `t_setup` of the edge" by
the tracking rule. So the tracking cannot be kept as-is: with a derived clock it reports
violations that are structurally meaningless.

Which means retiring the violation machinery is not optional decoration — it is the
resolution of three of the four failures.

## 10. Test plan

Grouped by **property**, because that is what a test here is for — a test that asserts a
number without naming the property is how the four retired fixtures rotted.

Fixture vocabulary: *unit* = a hand-built document in `delay.rs` tests; *integration* = a
`.csx` under `tests/fixtures/`; *corpus* = the 358 designs; *hand-computed* = delay numbers
chosen so the expected period can be derived on paper (`gate.not` 2 ns, `mem.register` 4 ns
clk→Q, setup 2 — all in `crates/core/data/mips-r2000-2um-v1.json`).

### A. The barrier — an edge never overtakes the logic

| # | property | how |
|---|---|---|
| A1 | a chain **longer than the nominal period** still latches the **settled** value | unit: the old 250-inverter fixture, asserting the register's *value* rather than a warning. This replaced the `overclocked_chain_completes_with_setup_violation` fixture |
| A2 | no edge fires while data events are pending | unit: after each edge, assert the queue holds only the next clock (the barrier's contract, from the inside) |
| A3 | edge times are **strictly increasing** | unit: run a long cascade, assert the edge-time sequence is monotone (this is the inversion guard) |
| A4 | a cascade spilling past the nominal period is **completed** before the edge | unit: assert the value *and* that the edge lands after the spill |

### B. The period

| # | property | how |
|---|---|---|
| B1 | `t_obs` = **settle + setup**, exactly | **done**: `t_obs` *is* the derived period (rise-to-rise), so the pipeline reports 54 = 39 + 15 and `est_time = cycles × period`. The question this row used to carry — which number `est_time` should mean — was answered by implementing §3 |
| B2 | `t_obs` = the **max** over cycles, not the sum | **done**: `settling_mux_json` — a short and a long path carrying the same value, selected by a mux. Each path is *pinned* first and the two periods asserted to differ (the control), then the select toggles and `t_obs` must equal the long one |
| B3 | **setup is included** | **done**: two tables identical but for the register's `t_setup`; the period moves by exactly the delta |
| B4 | a design that never changes after the first edge → `t_obs` = 0 | **retired as written**, and the row was the tell: 0 was reachable only while the metric was the settle. Under §3 a static design's period is `0 + setup`, which is what A1's fixture asserts now. (A design with *one* cycle reports 0 — no rise-to-rise pair exists to measure, which is why `alu.csx` still reads 0 in the golden table.) |
| B5 | the period is a **floor**, not a schedule | unit: the clock parameter set to wildly different values gives the same verdict and the same `t_obs` |

### C. Retired contract (slice 2 — write these when the fields go)

| # | property | how |
|---|---|---|
| C1 | **no** design reports a violation, for any poke pattern | **done**: there is no violation surface left to report. A near-edge register poke (golden) and a RAM `we`+`din` poke (delay.rs) assert the *values* they produce |
| C2 | `--assert "violations == 0"` is vacuous; `violations == 1` can never pass | **done**: the keyword is out of the grammar, so both spellings are parse errors (autograde's bad-assertion list) |
| C3 | `timing_violations` is **absent or always zero** in the report | **done**: absent — asserted on the serialized report, because "always zero" is what invites the vacuous assertion C2 retires |
| C4 | `--clock-half-period-ns` is accepted and **ignored** (or removed) | integration — **done**: removed, rejected by clap, and a savestate carrying the field is refused (snapshot format 3). The origin is one shared constant, `delay::DEFAULT_CLOCK_START_NS` |
| C5 | `--sta` / `t_sta` / `sta_paths` are gone | integration — **done**: the flags are rejected by clap and the report carries none of the three |

### D. Loops and non-quiescence — the "never hang" contract

| # | property | how |
|---|---|---|
| D1 | a **ring oscillator** halts with an oscillation | unit — and note this is the test that would have caught the `next_boundary` hang: the cap must fire *inside a drain* |
| D2 | a **settling** loop (an SR latch) settles and latches | unit |
| D3 | a **conservative** loop — a graph cycle with no real one (a shared bus, mutually exclusive drivers) — runs, does not storm, and gives CE's values | **done**: two buffers sharing a bus and gated *by* that bus, so `ba -> bus -> ba.en` closes a loop the delay engine must simply settle. The test asserts the loop is really there (via `on_cycle`) before asserting the value, so it cannot pass on a design that has no loop |
| D4 | the drain is **bounded**: a non-quiescing cascade trips the cap rather than growing | unit: assert the queue length stays bounded and the halt is an oscillation |

### E. Determinism and state

| # | property | how |
|---|---|---|
| E1 | same design twice → identical trace hash | unit |
| E2 | snapshot mid-run → resume → bit-identical to an uninterrupted run | unit (**must include `cycle_start`**, which the snapshot now carries) |
| E3 | `step_tick` (one edge) equals `run(1)` | unit |
| E4 | the derived edge times reproduce on a second engine built from the same document | **done**: every edge time compared, not just the final hash (E1) — a difference that cancelled out by the end would still show |

### F. Clocks

| # | property | how |
|---|---|---|
| F1 | a **gated** clock works — the gate settles as part of the cascade | integration |
| F2 | a **divided** clock (a counter bit on `clk`) works, and is count-based | integration |
| F3 | a **self-oscillating** source (a ring driving `clk`) is an oscillation halt, not a hang | unit |
| F4 | with **wire delay on**, the same edge reaching sinks at different times still completes the cascade first | **done**: lengthening the *clock's* wire lengthens the period by **twice** the wire's delay — the wire carries both transitions — which can only be true if the clock's arrival is a cascade event rather than a scheduled time |

### G. Corpus — the regression gate

| # | property | how |
|---|---|---|
| G1 | **verdict-neutral**: the A/B over all 358 has zero differing rows | corpus: `pow-check.py`, both binaries frozen (it currently reports master 224/133/0 and derived 224/133/0) |
| G2 | no timeouts in that A/B | corpus |
| G3 | the prod and compat harness runs do not gain disagreements | corpus: `tools/check_submissions.py` |

### H. Fidelity to CE — the goal, currently expected to fail

| # | property | how | status |
|---|---|---|---|
| H1 | the **same verdict under any delay table** for a chosen design | corpus: `374625393` under `mips-r2000-2um-v1` and `cs2200-74ls-v1` | **fails today** (stop @2834 vs never stabilises). Its *mechanism* is now pinned in-repo as `a_glitch_dependent_design_is_table_dependent` (the same pulse, two tables, two answers), so the class is visible in CI; the failing row itself still needs the private design, and the check for it belongs to the corpus harness |
| H2 | a pulse narrower than `t_pd` is swallowed by us and **passed by CE** | **done**: one test, `a_narrow_pulse_survives_a_wire_but_not_a_gate` — the wire half agrees with CE, the gate half is where we differ, and the test says so | known divergence, pinned |

### I. Fixtures to replace, not repair

- `overclocked_chain_completes_with_setup_violation` → **A1** (assert the value, not a warning). Its current `t_obs = 0` assertion is a property of the fixture, not the engine.
- `neg-setup-violation.csx` → repurpose as "a near-edge poke is **not** reported" (**C1**).
- `setup_and_hold_violations_are_warnings` → delete; superseded by **C1**.
- `autograde::violations_assertion_and_report_entries` → already deleted.

### J. What none of these cover, and should be said out loud

Every test above pins **our** behaviour. Only **H1** and the corpus A/B speak to the actual
goal — a verdict that does not move when the table does — and **H1 fails**. So the honest
statement of where the test suite would be after all of this: thoroughly pinned, internally
consistent, and still unable to claim CE fidelity. That claim needs H1 green, and H1 needs a
value model with no time in it.

## 9. What does not change

The event queue, per-sink views, transport/inertial delays, the tie-break, the `on_cycle`
priority class, snapshot/resume, and every other part of the delay-aware engine. The change
is *how a cycle is bounded*, not how a value propagates.
