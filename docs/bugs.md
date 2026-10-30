# Bugs

**Current bugs only.** The log of everything found and fixed — every round, with its measurements
and its reasoning — is in [`bugs-archive.md`](bugs-archive.md). This file is what is *open now*.

---

## 1. A splitter whose map disagrees with its net's width **panics** the engine (`no run report`)

`Value::contention_merge_detail` (`value.rs:670`) asserts that every driver's width equals the net's:

```rust
assert_eq!(d.width, width, "contention_merge: driver width {} != net width {width}", d.width);
```

A **splitter** can violate that. The engine drives each split output at the **map length**
(`eval_splitter`) while the net it drives is as wide as the **pin** — and `behavior.rs:939` already
records exactly this:

> CE builds each split output at the **port's** width (`Splitter.valueChanged`:
> `new WireValue(getPort(i).getLink().getBitSize())`), while `eval_splitter` builds it at the map
> length — a difference that would be silenced wherever a split's net has a single driver, since
> `contention_merge` only asserts widths when there are two.

So with `split_map_len(pin) != port width` **and two or more drivers on that net**, the assert fires:
a **panic**, so there is **no report at all**, and the harness records

    no run report: ... width 4 != net width 1

The engine *detects* the shape and then discards it: `delay.rs:2336` prints `!M{map_len}` for each
affected pin, behind **`CSIM_DEBUG_SPLITTER_SHAPE`**, to stderr. Nothing reaches the report or the
exit code.

**Reachability: latent.** **0 of 357** corpus rows at HEAD reach it. It fired on **18** designs under a
perturbing engine change (the reverted clock rule, the commit before `c783e35`), because changed latch
times changed which nets contend:

| widths | designs |
|---|---|
| `4 != 1` | `374337181`, `374503283`, `374615381`, `374624058`, `374625075`, `408346931`, `409547175`, `409848157`, `410231691`, `410460509`, `410758907`, `410961281` |
| `16 != 32` | `374539543`, `374622735`, `409950542` |
| `4 != 16` | `374624040`, `410421963` |
| `4 != 32` | `404296506` |

Several distinct shapes — a class, not one converter bug.

**Why the loader does not reject it.** `netlist.rs:461` checks that the *pins* on a net agree on width
(`LoadErrorKind::BitsizeMismatch`, "net connects pins of different widths"). A splitter's `splits` map
is not a pin width, so a map that disagrees with its port width loads clean and only surfaces later, as
a wrong-width *value*.

**Why it matters more than a normal bug.** The engine's contract is "never panics" (`autograde.rs`:
*"Run the full grading flow … Never panics; never hangs"*). A panic is the one failure mode that yields
**no verdict**, which is worse than a wrong one and is invisible in a corpus summary that compares
verdicts.

**Fix, in order of preference.**
1. **Never panic on a loaded design.** `contention_merge_detail` should treat a width disagreement as
   a diagnostic — `X` on the affected bits, and a `short-circuit`/`malformed` report entry — the way
   every other malformed-but-loaded shape is handled.
2. **Make the shape check load-time** rather than an env-gated `eprintln!`: a splitter whose map
   length differs from its split pin's width (or whose map exceeds the bus width) is a document error
   exactly like `BitsizeMismatch`, so converter output is rejected up front.
3. Both — (2) for a clean error, (1) so nothing can panic if one slips through.

Earliest evidence: `/tmp/opencode/settle-compat.json` (the reverted-rule corpus run) lists the 18 rows.

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
