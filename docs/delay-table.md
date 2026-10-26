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
| `mem.rom.access` | 50 | **15 + 7/addr‑bit** | small TTL PROM: 16 words → 43 ns, 32×8 → 50 (74S288/82S123 max), 64 → 57, 32K×8 → 120 (27C256‑120) |
| `arith.adder` | `15 + 4/bit` = 139 @32 | **`22 + 6/bit` = 208 @32** | 74LS181 ripple chain (22 ns slice + 25 ns/slice carry) |
| `arith.subtractor` | 139 @32 | **208 @32** | same, subtract mode |
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

### Memory is priced by depth, not by type

`mem.rom` (and `mem.ram`) carry an optional `perAddrBit` term:

```
effective_access(T, words) = access(T) + perAddrBit(T) × ceil(log2(words))
```

because a memory's read time is the **address decoder** plus the array, and the
decoder grows with the word count. `mem.rom` ships `access 15, perAddrBit 7`,
which passes through three real parts:

| words | address bits | model | real part |
|---:|---:|---:|---|
| 16 | 4 | 43 ns | a small control table |
| 32 | 5 | **50 ns** | 74S288 / 82S123 (32×8 bipolar PROM), address access 50 ns max |
| 64 | 6 | 57 ns | 74S188A-class |
| 32768 | 15 | **120 ns** | 27C256‑120, `tACC` 120 ns |

This matters because **every ROM in this corpus is a control table, not program
storage** (the harness bakes the program into `mem.ram`): sampling the converted
designs, 34 of 35 have at least one ROM and they are 16–64 words of 1–28 bits —
`SEQ` 6×16, `Main` 28×64, `CC` 6×16, `EX-ROM` 5×16, `ID/RR-ROM` 3×16. Charging
those the flat `tACC` of a 256-Kbit EPROM over-charged them ~3×, and since a
pipeline stage's bottleneck *was* that ROM, it decided who won. Known compromise:
the line over-charges the middle of the range (a 512×8 74S472 is 55 ns; the model
says 78 ns), because small bipolar PROMs are nearly size-flat while bulk CMOS
EPROMs are not. It is exact at both ends, which is where this corpus lives.

`mem.ram` keeps a flat 70 ns and no `perAddrBit`: in every design here it is one
part (the 62256 that holds the program), so a depth term would only add noise.
The field exists for both kinds so a future table can price a small RAM cheaply.

### The two things this fixes

1. **Memory and the adder are both charged honestly.** The 32Kx8 SRAM is a
   62256‑70 (70 ns) and the EPROM a 27C256‑120 (120 ns); a 32-bit add is a
   real 74LS181 ripple chain at 208 ns. v1 paired a *best-case* memory (50 ns)   with a *worst-case* ALU (ripple, 139 ns), which is the one combination that
   maximizes the ALU's share of the critical path.
2. **The adder asymmetry is what makes pipelining pay *most*.** A one-cycle machine
   serializes **two** adds (PC+4 and the ALU op) into a single clock period; a
   pipeline does one per stage. With a 208 ns ripple adder that serialization is
   expensive — which is the historical argument for pipelining, now visible in
   `t_obs` rather than asserted in a rubric. The 74LS181 datasheet offers ripple
   ("when speed requirements are not stringent") and, with the 9342/74LS182,
   lookahead ("for high speed operation … over extremely long word lengths"); the
   MIPS team's own boards used ripple, so v2 charges ripple. The lookahead variant
   (`22 + 1/bit` = 53 ns @ 32) narrows the margin but does not change the winner —
   see the measurement below.

### Calibration targets

Published machines to sanity-check a design against, rather than a made-up scale:

| machine | clock | basis |
|---|---|---|
| MIPS R2000/12 (2.0 µm CMOS, 5-stage) | **12.5 MHz** (80 ns) | external SRAM 35 ns |
| MIPS R2000/16 | **16.7 MHz** (60 ns) | external SRAM 25 ns |
| Harvey Mudd / MOSIS student MIPS (AMI 0.5 µm) | **7.25 MHz** (138 ns) | 34 undergrads, 160k transistors |

### Measured: pricing the control ROM by depth is what fixed the ranking

`T_obs` (ns, pow), measured on the corpus's design families. The middle column is v2
with the ROM still flat-priced (superseded), the last two are the shipped table
(ripple adder) and its lookahead variant:

| design | v1 | v2 flat‑ROM (ripple) | **v2 shipped (ripple + addr‑ROM)** | v2 lookahead + addr‑ROM |
|---|---:|---:|---:|---:|
| `none.sim` — multicycle baseline | 282 | 415 | 338 | 187 |
| `pipeline-df.sim` — reference 5-stage | 290 | 379 | 369 | — |
| `pipeline-pred.sim` — reference 5-stage + prediction | 322 | 449 | 449 | 195 |
| fastest-clock 5-stage (corpus) | 195 | 250 | **250** | **150** |
| one-cycle datapath (corpus) | 346 | 467 | **467** | 216 |
| a real field design | 494 | 690 | 697 | 467 |

Two conclusions, in order of importance:

1. **The one-cycle machine never wins once a control ROM is priced by depth.** The
   flat 120 ns ROM made the corpus's best pipeline's stage 227 ns — *longer* than a
   one-cycle machine's entire instruction path — so the one-cycle design looked
   unbeatable under a cheap adder. Priced as a 16-word table (~43 ns), that
   pipeline's stage drops to **150 ns**, and it beats the one-cycle machine under
   **both** adder choices: 1.44× with lookahead, 1.87× with ripple. The apparent
   "one-cycle beats everything" result was a ROM mispricing, not an architectural
   truth.
2. **The adder sets the margin, not the winner.** Ripple widens the pipeline's
   advantage (208 ns of serialized adds is expensive); lookahead narrows it. Either
   is self-consistent, and the winner is a pipeline in both.

Why the *memory* fix alone changes nothing: the one-cycle design's critical path is
`PC → mux → RAM → mux → PC` — **one** memory access, not two (its fetch and execute
share the same RAM and overlap), so raising RAM 50→70 lengthens both sides about
equally.

### Measured: cycles per instruction (why a "one-cycle" design is competitive at all)

Cycles per PC change (a `changes:` stop), i.e. cycles per instruction issued:

| design | CPI | note |
|---|---:|---|
| multicycle baseline `none.sim` | **5.35** | microcoded; this is what pipelining/one-cycle buys back |
| reference `pipeline-pred.sim` | **1.01** | 5 stages, prediction |
| fastest-clock 5-stage (corpus) | **1.01** | BTFNT + careful paths |
| one-cycle datapath (corpus) | **1.10** | hardwired control, no pipeline latches |

So the one-cycle design is *not* free lunch: it issues at 1.10 cycles/instruction
against the best pipeline's 1.01. It wins the clock because it carries two costs a
pipeline does not — a **control ROM** in a stage (a 16-entry ROM on the critical
path, 120 ns at real ROM timing) and **forwarding/hazard logic**. A pipeline whose
stage is longer than a one-cycle machine's whole instruction path cannot win, no
matter how many stages it has. That is the CISC-vs-RISC lesson arriving on its own,
and it is the whole reason the adder choice matters: a cheap adder makes the
one-cycle machine's only real penalty (serialized adds) free.

This is a **staff decision** (D13). Either table is self-consistent; v2 states which
it is, and every row names its part.

