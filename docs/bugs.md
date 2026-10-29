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

**The mechanism, named (2026-10-29).** `PC` and `IR` are **clocked by the microcode ROM's own
output** (`MAIN.out`) — a *derived* clock. That same ROM output is the control word that enables
them (`LdPC`/`LdIR`), and the datapath it selects feeds their `d`. So the latch edge, the enable
and the data all descend from one net's fanout along paths of different lengths, and the table's
per-component delays decide **which arrives first**. The barrier guarantees a settled cloud before
the *global* edge and says nothing about this one (the F2 finding), so `PC`/`IR` sample whatever
is on their `d` when the ROM's output rises — mid-cascade.

The staircase, which is what says *race* rather than *too slow* (the four shipped tables, same
design, same program, same stop rule, grading mode):

| table | `mem.rom.access` | register prop/setup | verdict | cycles |
|---|---|---|---|---|
| `ce-zero-delay-v1` | 0 | 0 / 0 | **FAIL** (changes) | 19995 |
| `mips-r2000-2um-v1` | 2 (+1 per addr bit) | 4 / 2 | PASS | 2833 |
| `cs2200-74ls-v2` | 15 (+7 per addr bit) | 15 / 20 | PASS | 2835 |
| `cs2200-74ls-v1` | 50 (flat) | 20 / 15 | **FAIL** (changes) | 18421 |

A "slower than a threshold" story would be monotone; this is not. `74ls-v2` has *slower* cycles
than `74ls-v1` (`t_obs` 562 vs 480) and passes, while a flat 50 ns ROM read fails. What flips the
verdict is the *ordering* of two arrivals, and it flips independently at both ends of the scale —
zero delay fails too, because with every delay at 0 the order is decided by the engine's
same-timestamp tie-break, which is not CE's order (CE passes this design, at 2709 cycles).

**So the property H1 asserts is not achievable while we model time.** A derived clock's race *is*
table-dependent; the only ways to make the verdict table-independent are to treat every edge like
the global one (make a derived edge wait for the data it samples — a real engine change, and one
that contradicts what `f2` currently documents as the hardware's own behaviour), or to stop
modeling derived clocks as edges at all.
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
