# Bugs

**Current bugs only.** The log of everything found and fixed — every round, with its measurements
and its reasoning — is in [`bugs-archive.md`](bugs-archive.md). This file is what is *open now*.

---

## 1. A narrow pulse is swallowed where CE passes it (known divergence, deliberate)

A pulse narrower than a gate's `t_pd` is filtered by an inertial gate here and propagated by CE,
which has no time at all. `docs/bugs.md`'s archive has the history; the current statement is
`a_narrow_pulse_survives_a_wire_but_not_a_gate` in `crates/core/src/delay.rs`, and it is a
*decision* rather than a defect: our gate models the physics, CE models a tick.

## 2. Documentation gaps (not lies — omissions)

- `docs/format-v2.md` does not mention `mem.rom`'s attribute set, the wire `name` field, or
  `wiring.reset`.
- `docs/autograder.md` does not list the `csim nets` subcommand, `--stop`, `--pause-on-unknown`
  or `--compat`, nor the spec fields `pause_on_breakpoints` / `pause_on_unknown`.
