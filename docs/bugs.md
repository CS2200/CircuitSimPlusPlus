# Bugs

**Current bugs only.** The log of everything found and fixed — every round, with its measurements
and its reasoning — is in [`bugs-archive.md`](bugs-archive.md). This file is what is *open now*.

---

## 1. A clock that returns to 1 inside one instant is a second edge for us and not for CE

**The engine's one structural difference from CircuitSim CE, and the reason a verdict can still
depend on the delay table.**

CE's simulator is a **round-based fixed-point iteration over links**: `Simulator.step()` moves a
*dirty set* one wave at a time, and `LinkState.propagate()` notifies a port **only when the value
it received changed**. A signal that changes several times inside one round collapses to the
value the net settled to — the intermediate values are never delivered (source: the course's
`CircuitSim`, `simulator/Simulator.java`, `simulator/CircuitState.java`).

We are delay-aware: **every change is its own event**, with its own arrival time. A wire really
does carry a pulse, so this is a feature — the derived period comes from it. But it also means a
transient is a value, and a clock pin that goes `1 -> 0 -> 1` *within one instant* is **two
rising edges** for us where CE would deliver one. The register latches an extra time.

**Measured (`submission_374625393`, compat, the harness's own conversion).** The three real tables
agree and halt (`mips` 2833 / `74ls-v2` 2835 / `74ls-v1` 2835, `PC=0x11`). The one table that
still disagrees is the diagnostic `ce-zero-delay-v1`, which never halts — and it is exactly the
one that reports this condition:

| table | verdict | `clock_glitches` |
|---|---|---|
| `mips-r2000-2um-v1` | halts, 2833 | 0 |
| `cs2200-74ls-v2` | halts, 2835 | 0 |
| `cs2200-74ls-v1` | halts, 2835 | 0 |
| `ce-zero-delay-v1` | **never halts**, 18576 | **60, over 20 parts** (`PC`, `IR`, `State`, the RAM, the register file) |

Two earlier hypotheses about this design are now settled and were both wrong, which is worth
keeping: it is not a *setup* race — instrumenting the real arrival at every derived register's `d`
pin fires `max(rise, last_d + t_setup)` **zero** times under `74ls-v1` and once (2 ns) under
`mips`. And it is not `--compat` reading `Z` as `0` — compat keeps `Z` as `Z` (CE's rule) and
production promotes it to `X`.

**What is fixed.** A rising edge now requires a **definite** low (`clk_armed`,
`docs/derived-clock.md` §11), which removed the *other* route — a gated clock dipping to `Z` (a
tri-state bus hand-off) and its recovery being read as an edge. That is what moved `74ls-v1` from
18421 cycles to 2835.

**What is not, and what a real fix needs.** Coalescing a settle, i.e. separating *transport*
(when a value arrives — keep the time; the derived period depends on it) from *decision* (what an
edge-sensitive part does — take the **settled** level, once per drain). That is CE's semantics
grafted onto a timed engine; it is a core change and needs the goldens re-blessed and the whole
corpus re-verified. The only thing that removes the dependence at the root is a value model with
no time in it (the levelized `settle-engine`), which is the wrong direction for this product — no
time means no derived period.

**Shipped for now.** `clock_glitches` on the report: a diagnostic that names the parts and cycles
where this happened. It changes no verdict, and it turns a *silent* table-dependent design into a
visible one — the LANDMINE note in `docs/delay-table.md` says the failure is otherwise invisible,
and this is how it stops being.

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
