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

**`cs2200-74ls-v2` is the current table** (2026-10-25) and `cs2200-74ls-v1`
remains published, unchanged, so designs and reports written against it keep
grading identically. Both are **DRAFT** — 74LS-family TTL datasheet *typical*
propagation delays, period-authentic for the course (DESIGN.md §4.4), pending
staff finalization (D13). Only ratios matter for scoring, but the units are ns
so TAs can say "your clock would run at X MHz".

v2 exists because v1 paired its **worst-case ALU with its best-case memory**:
a ripple adder (139 ns for 32 bits) against 50 ns SRAM/ROM. That inverts the
regime the course is about. The MIPS R2000's own datasheet says its clock was
set by its external SRAM — *"Uses standard SRAMs — R2000/12 35 ns access time"*,
12.5 MHz, *"both cache memories accessed during a single CPU cycle"* — so a
single-cycle machine has to pay **two** memory accesses in series while a
pipeline pays one per stage. v1 made that second access cheap, which is why it
under-rewarded pipelining; v2 charges real parts. See "v2" below.

When staff finalize the numbers a further version is added; older files keep
working unchanged.

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
- `wire` — wire transport delay constant: `units × num / den` (floor),
  applied to **per-path** lengths (see "Wire delay semantics" below).
  `num = 0` disables wire delay; `den = 0` is invalid.
- `components` — map from component type string (`docs/format-v2.md`
  registry) to an entry with optional integer fields (absent = 0):
  - `prop` — combinational propagation delay; clk→Q for `mem.register`.
  - `perBit` — ripple-carry scaling, **adders only**
    (`arith.adder`/`arith.subtractor`): added once per bit beyond the
    first of the instance's bitsize.
  - `setup` / `hold` — register and RAM write discipline (§4.3).
  - `access` — RAM/ROM read settling time.

Unknown fields anywhere in the document are rejected.

## Wire delay is OFF for the first production run (2026-10-22)

**Every wire contributes 0 ns.** The table ships `"wire": { "num": 0 }`, so
`arrival(sink) = driver commit time` and only **component** delays count. This is a
deliberate Head-TA decision for the first term CircuitSim++ runs in production, and it
is not merely cosmetic:

- a conversion has to reproduce **CircuitSim CE**, which has *no* delay at all. Wire
  delays brought **clock skew** with them — an edge reaching each register at a
  different time, depending on how much wire sat between it and the clock source —
  where CE's edge is atomic, every clocked part latching the values from *before* it.
  A converted CPU lost its first instruction to exactly that: the PC (clocked first)
  advanced, the new PC reached the I-MEM, and the IF/ID latch (clocked later) latched
  the *next* fetch instead. With wires off, that class of race is gone by construction;
- `t_obs` and `t_sta` therefore measure **component delays only** while this is in
  force, so their absolute values are not comparable with earlier runs;
- the per-path machinery below is still built and still exercised by tests (which
  switch `wire.num` back on for themselves) — turning `num` back on restores it
  exactly, wire lengths and all.

## Wire delay semantics (contract v1.2, F14) — inert while `wire.num = 0`

Wire delay is **per-path, never net-lumped**: a sink pin's arrival is

```
arrival(sink) = driver commit time + path_len(driver → that sink) × num / den
```

where `path_len` is the shortest path through the net's wire graph (pins and
junctions as nodes, drawn segments weighted by length) in grid units.
Consequences, all normative:

- **Unused stub branches do not inflate other sinks' delays.** (The pre-v1.1
  lumped model summed every wire on the net for every sink; a long meander on
  a branch penalized unrelated sinks.)
- Every transition is reproduced at every sink, however narrow the pulse —
  transport, per §4.3. On multi-driver nets (tri-state buses) the delay uses
  the **nearest** driver's path per sink (single-driver nets are exact).
- **Junction attachment:** a junction onto segment `s` of a target wire
  attaches at the segment's **midpoint** (the format records no
  intra-segment position).
- **Manhattan fallback (kept from v1):** a wire with empty `points`
  contributes the Manhattan distance between its endpoint *components'*
  `pos` positions (a single straight segment). The UI always saves drawn
  paths, so hand-drawn circuits get exact lengths.
- STA uses the same per-path lengths (informational only, below).
- **While `wire.num = 0` (the shipped state) every term above is 0**: the lengths are
  computed, they simply do not contribute. See the section above.

## Clock for grading runs

There is **one global clock domain** (DESIGN.md §4.3): a `clock` component mirrors the
global clock, so an edge reaches every clocked part at the same instant. With wire delay
off that is true by construction (`arrival = commit time` for every sink); if wires are
turned back on, the clock must stay skew-free, because CE's atomic edge is what the course
designs (and their conversions) are built on.

The delay engine's global clock half-period is a run parameter,
`--clock-half-period-ns` / `clock_half_period_ns` (spec), default **1000
ns** (2000 ns period). It does not affect correctness — it sets edge times
for setup/hold detection — and it no longer bounds what can be graded: a
design whose propagation exceeds the period produces setup/hold warnings and
wrong-but-deterministic latching, never a floating-read halt (F6). The
teaching point stands: `T_obs` tells you how fast the clock may go.

## Timing conventions: DTA vs STA (F13)

The two numbers in a report measure different things, deliberately:

| | **DTA `t_obs`** (grading) | **STA `t_sta`** (informational) |
|---|---|---|
| What | max observed per-cycle settle over the run | structural longest path |
| Start of measurement | the clock **edge** (clk→Q of the launching register **included**) | the launching register's output (arrival 0; clk→Q **excluded**) |
| End of measurement | last change at any register/RAM data-input view (setup **excluded**) | arrival at a register/RAM data input **plus the destination's setup time** (the textbook clock-period bound) |
| Paths | only sensitized ones | all structural ones — may include paths the design never uses |

STA is informational only (decision D11): always labeled
*"structural bound — may include paths your design never uses"*. Both
metrics use the same table and the same per-path wire lengths, so on a
design whose critical path is exercised, `t_sta ≈ t_obs + setup`.

## Lookup semantics

For a component instance of type `T` with bitsize `b`:

```
effective_prop(T, b) = components[T].prop + components[T].perBit × (b − 1)
```

An instance's timing comes **only** from its type's table entry; there is no
per-instance override (DESIGN.md §4.3). Component types absent from `components`
(wiring pins/constants/clocks/probes/splitters, `arith.bit-extender`, `debug.breakpoint`,
inert `io.*`) are ideal: zero delay — an observer must not perturb what it observes.

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
| plexers.priority-decoder   |   12 |      — |     — |    — |      — |
| arith.adder/subtractor     |   15 |      4 |     — |    — |      — |
| arith.multiplier/divider   |   15 |      — |     — |    — |      — |
| arith.comparator/negator   |   15 |      — |     — |    — |      — |
| arith.shifter              |   15 |      — |     — |    — |      — |
| mem.register               |   20 |      — |    15 |    5 |      — |
| mem.ram                    |    — |      — |    15 |    5 |     50 |
| mem.rom                    |    — |      — |     — |    — |     50 |
| wire                       | 1 ns per 10 grid units                    |

The JSON file is the source of truth; this table is documentation.

## v2: the recalibration (2026-10-25)

`crates/core/data/cs2200-74ls-v2.json`. Same regime, real parts, and every row
carries a `source` naming the part and parameter it came from — so a student can
check any number against a datasheet instead of guessing what the grader thinks.

### What changed and why

| | v1 | v2 | the part |
|---|---:|---:|---|
| `mem.ram.access` | 50 | **70** | 62256‑70, `tAA` 70 ns (write `tSD` 30, so `setup` 15→30) |
| `mem.rom.access` | 50 | **120** | 27C256‑120, `tACC` 120 ns |
| `arith.adder` | `15 + 4/bit` = 139 @32 | **`22 + 1/bit` = 53 @32** | 74LS181 slice (22 ns typ) + 74LS182 carry lookahead |
| `arith.subtractor` | 139 @32 | **53 @32** | same, subtract mode |
| `arith.comparator` | 15 | **26** | 74LS688 8-bit identity comparator |
| `arith.negator` | 15 | **22** | 74LS181 in `0 − B` mode |
| `plexers.mux` | 12 | **9** | 74LS157 data→Y 9 ns typ (select→Y 15–23) |
| `plexers.decoder` | 12 | **22** | 74LS138 |
| `plexers.demux` | 12 | **22** | 74LS139 |
| `plexers.priority-decoder` | 12 | **19** | 74LS148 |
| `mem.register` | prop 20 / setup 15 | **prop 15 / setup 20** | 74LS374 clk→Q 15 ns typ, `tsu` 20, `th` 5 |
| `arith.shifter` | 15 | **9** | 74LS157, one mux level |

Unchanged because v1 already matched datasheets: `gate.*` (74LS00/02/04/08/32/86/266),
`wiring.controlled-buffer` (74LS125/244), `hold` = 5, and `wire` = **off**
(`num: 0`, the Head-TA decision above — turning it back on is a separate,
deliberate step, and v2 does not smuggle it in).

`arith.multiplier`/`arith.divider` are **estimates** (200 ns): no single TTL part
exists, and neither appears in the corpus. They are marked as estimates in their
`source` strings rather than dressed up as datasheets.

### The two things this fixes

1. **Memory is no longer the cheap element.** A 32-bit add (53 ns) now costs
   *less* than one SRAM access (70 ns), which is the R2000's own proportion:
   its 60–80 ns cycle was ~45% external SRAM. A design that does fetch and
   execute in one cycle must therefore pay two accesses in series; a pipeline
   pays one per stage. That is the historical argument for pipelining, and it
   is now visible in `t_obs` rather than asserted in a rubric.
2. **The lookahead adder is the default.** The 74LS181 datasheet offers ripple
   ("when speed requirements are not stringent") and, with the 9342/74LS182,
   lookahead ("for high speed operation … over extremely long word lengths").
   v2 charges the lookahead, because that is what a board replicating MIPS
   would use — and because it stops the adder from being an artefactual floor
   that no amount of pipelining can remove. A ripple design is still slower and
   the path report will say so.

### Calibration targets

Published machines to sanity-check a design against, rather than a made-up scale:

| machine | clock | basis |
|---|---|---|
| MIPS R2000/12 (2.0 µm CMOS, 5-stage) | **12.5 MHz** (80 ns) | external SRAM 35 ns |
| MIPS R2000/16 | **16.7 MHz** (60 ns) | external SRAM 25 ns |
| Harvey Mudd / MOSIS student MIPS (AMI 0.5 µm) | **7.25 MHz** (138 ns) | 34 undergrads, 160k transistors |

### Measured: the adder choice, not the memory, decides whether pipelining pays

`T_obs` (ns) for the same design under the two tables, and under a v2 variant whose
only difference is a **ripple** adder (`22 + 6/bit` = 208 ns @ 32 bits — the 74LS181's
"when speed requirements are not stringent" mode):

| design | v1 | v2 (lookahead) | v2 (ripple) |
|---|---:|---:|---:|
| `none.sim` — multicycle baseline | 282 | 327 | 415 |
| `pipeline-df.sim` — reference 5-stage | 290 | 224 | 379 |
| `pipeline-pred.sim` — reference 5-stage + prediction | 322 | 272 | 449 |
| single-cycle datapath (corpus) | 346 | **216** | **467** |
| fastest-clock 5-stage (corpus) | 195 | 227 | 250 |
| a real field design | 494 | 460 | 690 |

Two things this measured, both worth knowing before choosing:

1. **The memory fix alone does not separate a one-cycle machine from a pipeline.**
   The one-cycle design's critical path is `PC → mux → RAM → mux → PC`: **one**
   memory access, not two (its fetch and execute share the same small RAM and
   overlap). Raising RAM 50→70 lengthens both designs by about the same amount.
2. **The adder is the lever.** A one-cycle machine serializes *two* adds (PC+4 and
   the ALU op); a pipeline does one per stage. So a cheap adder removes the very
   term that penalizes serialization: with the lookahead adder the one-cycle
   machine wins (216 vs 227); with the **ripple** adder it loses by ~1.9× (467 vs
   250). The RISC argument for pipelining in this table is therefore carried by the
   adder, which is exactly why the MIPS team's choice of adder matters more than
   their choice of memory.

This is a **staff decision** (D13): shipping the lookahead makes a well-built
one-cycle machine the fastest design in the corpus; shipping the ripple restores
the pipeline's advantage and matches the 74LS181 in its slow mode. Either is
self-consistent — the table states which, and every row names its part.

