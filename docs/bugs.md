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

- `docs/autograder.md` §1 does not list the `csim nets` subcommand (a conversion-debugging
  aid), and §5 does not document the test-spec fields `pause_on_unknown` /
  `pause_on_breakpoints` — their CLI flags *are* listed, and `pause_on_breakpoints` also
  appears in §3's `halt_reason` note.
