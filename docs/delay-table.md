# Delay Table

Normative specification for the delay tables the delay-aware engine
grades against (DESIGN.md §4.4, decision D13; BACKEND.md task B7).

A delay table is **versioned data, not code**. Published tables ship as
JSON files in `crates/core/data/` and are embedded into the `csim`
binary, so every run is reproducible without external files and the
numbers behind every reported `T_obs` are named exactly. A `.csx` file
selects a table by name via `settings.delayTable` (see
`docs/format-v2.md`); an **unknown name is a load-time error** that lists
the available tables — the engine never guesses or silently defaults.

## Status

`cs2200-74ls-v1` is a **DRAFT**: its values are 74LS-family TTL
datasheet *typical* propagation delays, period-authentic for the course
(DESIGN.md §4.4), pending staff finalization (D13). Only ratios matter
for scoring, but the units are ns so TAs can say "your clock would run
at X MHz". When staff finalize the numbers, a **new table version**
(e.g. `cs2200-74ls-v2`) is added; v1 files keep working unchanged.

## Schema

```json
{
  "name": "cs2200-74ls-v1",
  "status": "DRAFT",
  "units": "ns",
  "wire": { "num": 1, "den": 10 },
  "components": {
    "gate.not":     { "prop": 9 },
    "arith.adder":  { "prop": 15, "perBit": 4 },
    "mem.register": { "prop": 20, "setup": 15, "hold": 5 },
    "mem.ram":      { "access": 50, "setup": 15, "hold": 5 },
    "mem.rom":      { "access": 50 }
  }
}
```

- `name` — table identifier; must equal the file's basename.
- `status` — informational provenance marker (`"DRAFT"` until finalized).
- `units` — must be `"ns"`. All integer fields below are in these units.
- `wire` — net transport delay: `wire_len × num / den` (floor), where
  `wire_len` is the net's accumulated drawn wire length in grid units
  (§5.2). `num = 0` disables wire delay; `den = 0` is invalid.
- `components` — map from component type string (`docs/format-v2.md`
  registry) to an entry with optional integer fields (absent = 0):
  - `prop` — combinational propagation delay; clk→Q for `mem.register`.
  - `perBit` — ripple-carry scaling, **adders only**
    (`arith.adder`/`arith.subtractor`): added once per bit beyond the
    first of the instance's bitsize.
  - `setup` / `hold` — register and RAM write discipline (§4.3).
  - `access` — RAM/ROM read settling time.

Unknown fields anywhere in the document are rejected.

## Lookup semantics

For a component instance of type `T` with bitsize `b`:

```
effective_prop(T, b) = components[T].prop + components[T].perBit × (b − 1)
```

An instance attribute `attrs.delay` **overrides `effective_prop`**
(highest precedence, DESIGN.md §4.3); it never touches `setup`/`hold`/
`access` or the wire constant. Component types absent from `components`
(wiring pins/constants/clocks/probes/splitters, `arith.bit-extender`,
inert `io.*`) are ideal: zero delay.

## Validation rules

A table is rejected (all issues reported at once) when:

1. `name` is empty, or `units` is not `"ns"`, or `wire.den` is 0;
2. a `components` key is not a known component type string (a misspelled
   entry must not silently zero a delay);
3. a **required** entry is missing — every type with a nonzero delay in
   the reference table must be defined: all `gate.*`,
   `wiring.controlled-buffer`, all `plexers.*`, all `arith.*` except
   `arith.bit-extender`, and `mem.register`/`mem.ram`/`mem.rom`;
4. `perBit` appears on a type other than `arith.adder`/`arith.subtractor`.

## Reference values (`cs2200-74ls-v1`, DRAFT)

| Type                       | prop | perBit | setup | hold | access |
|----------------------------|-----:|-------:|------:|-----:|-------:|
| gate.not / gate.buffer     |    9 |      — |     — |    — |      — |
| gate.and/or/nand/nor       |   10 |      — |     — |    — |      — |
| gate.xor/xnor              |   12 |      — |     — |    — |      — |
| wiring.controlled-buffer   |   10 |      — |     — |    — |      — |
| plexers.mux/demux/decoder  |   12 |      — |     — |    — |      — |
| arith.adder/subtractor     |   15 |      4 |     — |    — |      — |
| arith.multiplier/divider   |   15 |      — |     — |    — |      — |
| arith.comparator/negator   |   15 |      — |     — |    — |      — |
| arith.shifter              |   15 |      — |     — |    — |      — |
| mem.register               |   20 |      — |    15 |    5 |      — |
| mem.ram                    |    — |      — |    15 |    5 |     50 |
| mem.rom                    |    — |      — |     — |    — |     50 |
| wire                       | 1 ns per 10 grid units                    |

The JSON file is the source of truth; this table is documentation.
