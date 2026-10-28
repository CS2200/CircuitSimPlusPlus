# The derived clock: the period is an output, not an input

**Status:** design + implementation plan, 2026-10-28. Supersedes the `--clock-half-period-ns`
run parameter as the way a cycle is bounded. Written before implementing; §7 says what has
to be true afterwards.

## 1. The problem

A cycle is bounded today by a **run parameter**: `--clock-half-period-ns`, default 1000 ns
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

**The clock is not an event with a time. It is a phase transition that happens when the event
queue drains.**

```
loop:
    apply events until the queue is empty        ← the cascade, to quiescence
    advance the clock phase (a transition, stamped `now`)
    the transition schedules the registers' clk→Q and its cascade
    every second transition is a rising edge → latch, and count a cycle
```

- The queue is never "empty except for the clock" — the clock is not queued at all, so
  *empty* means *quiesced*.
- Causality makes the drain exact: events belonging to the next cycle are only scheduled *by*
  the transition, which hasn't happened yet. So everything drained belongs to this cycle.
- **A design that never quiesces never transitions** → the existing event-storm cap declares
  an oscillation. "Never hang" is unchanged.
- The settle is `now` at the moment of the transition, so the edge is placed *after* the data
  — which also means the time-inversion problem cannot arise (there is no scheduled timestamp
  to contradict).

**Setup is added when the transition is placed.** Setup means the data must be stable
`t_setup` *before* the edge, so the transition waits: `edge = quiescence + max t_setup` over
the clocked parts. **Hold then comes for free** — the data is stable across the edge because
nothing moves again until the next transition, so there is no race to hold against.

## 3. What the period is

```
period = t(rise k+1) − t(rise k)
       = the rising cascade + the falling cascade
       = depth + setup          (the total clock cycle time, in hardware terms)
```

`t_obs` **is** this: the maximum over the run of the derived period, i.e. the clock rate the
design can actually be run at. It is now the same quantity as the period — today they are two
unrelated numbers (2000 ns and ~80 ns), and that mismatch is what feels wrong.

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
  never too early. `--assert "violations == 0"` becomes vacuous. (Do this *after* the mechanism
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

## 9. What does not change

The event queue, per-sink views, transport/inertial delays, the tie-break, the `on_cycle`
priority class, snapshot/resume, and every other part of the delay-aware engine. The change
is *how a cycle is bounded*, not how a value propagates.
