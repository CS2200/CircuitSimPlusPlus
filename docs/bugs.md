# Bugs

**Current bugs only.** The log of everything found and fixed — every round, with its measurements
and its reasoning — is in [`bugs-archive.md`](bugs-archive.md). This file is what is *open now*.

---

## 1. The verdict depends on the delay table (the last open property)

`submission_374625393` (4200 datapath) **passes under `mips-r2000-2um-v1` and fails under
`cs2200-74ls-v1`**. Measured 2026-10-29, the harness's own conversion, its program (`pow.hex`),
its stop rule (`stable:PC:100` / `changes:PC:10000`, `--cycles 150000`):

| mode | table | halt | stop | cycles | `t_obs` |
|---|---|---|---|---|---|
| graded | `mips-r2000-2um-v1` | stop | `stable` | 1666 | 194 |
| graded | `cs2200-74ls-v1` | stop | `stable` | 52 | 449 |
| compat | `mips-r2000-2um-v1` | stop | `stable` | 2833 | 135 |
| compat | `cs2200-74ls-v1` | stop | `changes` | 18421 | 480 |

In the grading mode the harness runs (`CSIM_COMPAT=1`), the 74-series row stops on
`changes:PC:10000` — the harness's own "the program did not halt" — so the *verdict* moves with
the table. That is the property `docs/derived-clock.md` calls **H1**, and it is false.

**Why the corpus still looks clean:** the converter **pins the MIPS table**, so no corpus run has
ever taken the 74-series verdict. A clean corpus and this bug are not in conflict — they measure
different things. The check for it belongs in the corpus harness and needs a capability it does
not have: running one design under a *chosen* table.

**What is known about the mechanism:** not enough. It is not the edge race — the barrier removes
that, and the graded rows above both halt. The two remaining routes to a table-dependent *value*
are the glitch (a pulse narrower than `t_pd`, below) and the resolution of a combinational cycle
whose nets float. A design that *doesn't halt* under one table means a **value** moved, not just a
clock period, so it is one of those two. Naming which one needs a trace comparison between the two
tables on this design, which the harness cannot do yet either.

## 2. A narrow pulse is swallowed where CE passes it (known divergence, deliberate)

A pulse narrower than a gate's `t_pd` is filtered by an inertial gate here and propagated by CE,
which has no time at all. `docs/bugs.md`'s archive has the history; the current statement is
`a_narrow_pulse_survives_a_wire_but_not_a_gate` in `crates/core/src/delay.rs`, and it is a
*decision* rather than a defect: our gate models the physics, CE models a tick.

## 3. Documentation gaps (not lies — omissions)

- `docs/format-v2.md` does not mention `mem.rom`'s attribute set, the wire `name` field, or
  `wiring.reset`.
- `docs/autograder.md` does not list the `csim nets` subcommand, `--stop`, `--pause-on-unknown`
  or `--compat`, nor the spec fields `pause_on_breakpoints` / `pause_on_unknown`.
