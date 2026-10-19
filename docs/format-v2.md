# `.csx` — CircuitSim++ File Format v4 (normative)

> The file name is historical (`format-v2.md`); this document specifies the
> **current** format, version 4.

**Status:** Implemented by `crates/core/src/format/` (BACKEND.md task B2). Where this file and
`DESIGN.md` §5 disagree, `DESIGN.md` wins (route corrections through the human). The §5.2 block
in `DESIGN.md` is a _sketch_; this document is the _normative_ realization.

## 1. Identity, versioning, extension

- File extension: `.csx` (DESIGN.md §5.3, D4).
- Top-level `format` must be the string `"circuitsim-plus-plus"`.
- Top-level `version` must be `4`. Breaking changes bump `version` and ship with a migration
  (§5.1); this build understands version 4 and walks older files forward one version at a
  time (see below).
- Encoding: UTF-8 JSON. Files are student-facing and live in git — see §6 (canonical form).

## 2. Document structure

```jsonc
{
  "format": "circuitsim-plus-plus",
  "version": 4,
  "name": "LC-5200 Datapath",
  "settings": {
    "clockHz": 1, // UI clock speed at load time
    "delayTable": "cs2200-74ls-v1", // published, versioned delay table (§4.4, docs/delay-table.md); unknown name = load error
  },
  "circuits": [/* ... */],
}
```

Circuit names are unique within a document. One circuit is conventionally `"main"`.

### Migrations

- **v2 → v3** drops `settings.delayModel` (`"zero" | "delay"`) and the
  per-instance `attrs.delay` override. The zero-delay engine was removed
  (DESIGN.md §4.2) — every document is delay-aware — and timing is unit-wide
  (the delay table alone, §4.3) — so neither field carries meaning. Migration
  is automatic on load: a v2 file loads and is re-saved as v3 with both
  removed, regardless of their old values.
- **v3 → v4** drops wiring to the retired `rst` pins of `mem.register` and
  `mem.ram` (§4). Resetting a circuit is the session's job (`sim_reset`, which
  also re-applies memory autoload), never a pin's, so the pin — and every wire
  reaching it — is gone. A wire **junctioned onto** a dropped wire goes with it
  (its net no longer exists; that is the shape a shared reset fanned out into),
  and the surviving wires are renumbered so every `join` target still points at
  the same neighbour.
- Version 1 predates the migration chain and is rejected with an
  `unsupported format version` error.

### Circuit

```jsonc
{
  "name": "alu",
  "components": [/* ... */],
  "wires": [/* ... */],
}
```

### Component

```jsonc
{
  "id": "c17", // author-assigned, unique within the circuit
  "type": "gate.and", // type string, see §4
  "pos": [15, 10], // grid coordinates of the origin
  "rot": "E", // "N" | "E" | "S" | "W" (default "E")
  "name": "", // optional; REQUIRED on autograder-exposed parts and on wiring.pin
  "namePos": "N", // optional label side; "N" | "E" | "S" | "W" (absent = UI default)
  "attrs": {/* per-type, see §4 */},
}
```

Pins have **no connectivity fields** — wires own connectivity (copper-first, §5.1). Unknown
fields on any object in this section are rejected (`deny_unknown_fields`); unknown `attrs`
keys are rejected per-type (a typo'd attr is an error, never silently ignored).

- `namePos` (optional, UI_OVERHAUL §28): which side of the body a part's `name` label is
  drawn on, reusing the compass letters of `rot`. **Purely presentational** — the engine
  ignores it beyond round-tripping it — and omitted when unset (like a wire's `color`), so
  files written before it existed stay byte-identical.

### Wire and endpoints

```jsonc
{
  "a": { "comp": "c17", "pin": "out" }, // pin endpoint
  "b": { "join": { "wire": 0, "segment": 1 } }, // junction endpoint
  "points": [
    [18, 11],
    [30, 11],
    [30, 21],
  ], // drawn polyline, a → b
  "color": "#ff0000", // optional cosmetic stroke (§6)
}
```

- `color` (optional, UI_OVERHAUL §12): a `"#rrggbb"` string the UI may set
  per wire to override the renderer's state/bus colors. **Purely
  presentational** — the engine ignores it beyond round-tripping it — and it
  is **omitted when unset**, so uncolored files stay byte-identical (§6
  exception to "every field always emitted").

- Every wire has exactly two endpoints; **at least one endpoint is a pin** (the other may be a
  junction onto another wire's segment). A junction renders as a dot.
- `join.wire` is an index into the circuit's `wires` array. A wire may not join itself.
- `join.segment` indexes the target wire's polyline segments: a wire with `k` points has
  `k − 1` segments (0-based); a wire with empty `points` has exactly one implied straight
  segment (`segment` must be `0`).
- `points` is the drawn path in absolute grid coordinates, ordered from endpoint `a` to
  endpoint `b`, attachment points included. Coordinates may be fractional: component pins can
  sit on half-grid (or finer) positions, so drawn geometry is not integer-only. Canonical
  serialization emits whole values as JSON integers (`[[1, 2]]`, never `[[1.0, 2.0]]`), which
  keeps pre-fractional files byte-identical. Empty `points` means a straight line between the
  computed attachment points (the UI derives pin positions from `pos`/`rot`).
- Fan-out = multiple wires sharing one source pin. Buses have no width of their own — width
  is a property of the driving pin (§5.2).
- Wires/junctions are scoped to their circuit; cross-hierarchy connection happens only
  through subcircuit pins.
- Nets are **derived** at load (union-find) and never stored (§5.1).

## 3. Subcircuits

A `subcircuit` component has `attrs.circuit` naming the target circuit. Its pins are the
target circuit's **named** `wiring.pin` components, referenced by name from wire endpoints —
never by position or coordinates (§5.2, App. A). The instantiation hierarchy must be acyclic
and at most 64 levels deep (§11).

When the hierarchy is flattened for simulation, `wiring.pin` components inside inlined
subcircuits dissolve (they are pure connectivity bridges); at the root they stay primitive —
they are the design's external I/O. The **simulation root** is the circuit named `"main"` if
present, else the first circuit in `circuits`.

## 4. Component registry (type strings, pins, attrs)

Type strings are pinned by `docs/tasks/README.md` §4. There is **no per-instance
delay attribute**: timing is unit-wide, from the published delay table (§6).

| Type                                      | Pins                                            | Attrs (defaults)                                                                                                                                                                            |
| ----------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate.not`, `gate.buffer`                 | `in`, `out`                                     | `bitsize` (1)                                                                                                                                                                               |
| `gate.and` `or` `xor` `nand` `nor` `xnor` | `in0`..`in{inputs-1}`, `out`                    | `bitsize` (1), `inputs` (2; 2..=32)                                                                                                                                                         |
| `wiring.controlled-buffer` ⚠️¹            | `in`, `en`, `out`                               | `bitsize` (1)                                                                                                                                                                               |
| `wiring.pin`                              | `pin`                                           | `bitsize` (1), `isOutput` (false), `radix` ("unsigned" \| "signed" \| "hex" \| "bin" \| "dec") — display-only                                                                               |
| `wiring.transistor`                       | `in`, `gate`, `out`                             | `bitsize` (1) — a pass gate: the `in` value while `gate` is 1, `Z` while it is 0, `X` while it is unknown (a floating `gate` halts naming `gate`)                                           |
| `wiring.power` / `wiring.ground`          | `out`                                           | _none_ — a fixed 1-bit `1` / `0` source (UI_OVERHAUL §71); the same behaviour kind as `wiring.constant`, so a stray attr is an unknown-attr error                                           |
| `wiring.constant`                         | `out`                                           | `bitsize` (1), `value` ("0") — hex string, must fit `bitsize`; `radix` ("hex" \| "bin" \| "dec") — display-only                                                                             |
| `wiring.clock`                            | `out`                                           | —                                                                                                                                                                                           |
| `wiring.splitter`                         | `bus` + one per `splits` key                    | `splits` (required): object mapping pin name → array of bus bit indices (index 0 of each array = that pin's LSB). Every bus bit must be covered exactly once; bus width = max index + 1     |
| `wiring.probe`                            | `in`                                            | `bitsize` (1), `radix` ("unsigned" \| "signed" \| "hex" \| "bin" \| "dec") — display-only                                                                                                   |
| `plexers.mux`                             | `in0`..`in{2^sel−1}`, `sel`, `out`              | `bitsize` (1), `selectBits` (1; 1..=8)                                                                                                                                                      |
| `plexers.demux`                           | `in`, `sel`, `out0`..`out{2^sel−1}`             | `bitsize` (1), `selectBits` (1)                                                                                                                                                             |
| `plexers.decoder`                         | `in`, `out0`..`out{2^in−1}`                     | `inputBits` (2; 1..=8)                                                                                                                                                                      |
| `plexers.priority-decoder`                | `in0`..`in{N−1}`, `en_in`, `out` (⌈log₂N⌉ bits), `valid`, `en_out` | `inputBits` (4; 2..=8). Highest-numbered asserted input line → its binary index on `out`; `valid` high iff any input is asserted. `en_in`/`en_out` are CircuitSim CE's enable chain: a stage that is enabled but asserts nothing raises `en_out` for the next stage, and the stage that finds something asserts `valid` and drops `en_out`. A driven `0` on `en_in` disables the stage; an **unconnected** `en_in` is enabled (§9) |
| `arith.adder`                             | `a`, `b`, `cin`, `out`, `cout`                  | `bitsize` (1)                                                                                                                                                                               |
| `arith.subtractor`                        | `a`, `b`, `bin`, `out`, `bout`                  | `bitsize` (1)                                                                                                                                                                               |
| `arith.multiplier`                        | `a`, `b`, `out` (out = 2×bitsize)               | `bitsize` (1)                                                                                                                                                                               |
| `arith.divider`                           | `a`, `b`, `quot`, `rem`                         | `bitsize` (1)                                                                                                                                                                               |
| `arith.comparator`                        | `a`, `b`, `lt`, `eq`, `gt`                      | `bitsize` (1)                                                                                                                                                                               |
| `arith.negator`                           | `in`, `out`                                     | `bitsize` (1)                                                                                                                                                                               |
| `arith.shifter`                           | `in`, `amt`, `out`                              | `bitsize` (1), `shift` ("ll" \| "lr" \| "ar" \| "rl" \| "rr")                                                                                                                               |
| `arith.bit-extender`                      | `in`, `out`                                     | `inBits` (8), `outBits` (16; > inBits), `mode` ("zero" \| "sign")                                                                                                                           |
| `mem.register`                            | `d`, `clk`, `en`, `q`                           | `bitsize` (1), `radix` ("unsigned" \| "signed" \| "hex" \| "bin" \| "dec") — display-only                                                                                                   |
| `mem.ram`                                 | `addr`, `din`, `dout`, `we`, `clk`              | `bitsize` (1), `depth` (256; power of two, ≤ 2²⁰), `addrBits` (unset — the derived width `ceil(log2 depth)`, 1..=32), `autoload` (null — path, see §7), `contents` (null — RLE-hex, see §7) |
| `mem.rom`                                 | `addr`, `out`                                   | same as `mem.ram`                                                                                                                                                                           |
| `subcircuit`                              | from target circuit's named pins                | `circuit` (required)                                                                                                                                                                        |
| `io.button`, `io.led`, `io.hexdisplay`    | `out` / `in` / `in`                             | `bitsize` (1; 4 for hexdisplay) — inert headless. `io.led` also takes `color` ("" = theme accent, else `#rrggbb`) and `intensity` (80; 0..=100 glow strength)                               |
| `misc.text`                               | — (no pins)                                     | `text` ("") — free-form annotation; `color` ("" = theme text, else `#rrggbb`); `font` ("sans" \| "serif" \| "mono")                                                                         |

⚠️¹ `wiring.controlled-buffer` is required by BACKEND.md B4 ("controlled buffer (tri-state)")
and §4.1's tri-state semantics but is absent from the pinned registry list in
`docs/tasks/README.md` §4 — flagged to the human; the name is this document's assignment.
The editor offers it as the Gates palette's **BUFFER** tile (`en` on the bottom edge);
the plain `gate.buffer` still loads in existing files but is no longer placeable
(UI_OVERHAUL §43).

**Deviations from the DESIGN.md §5.2 sketch** (sketch is illustrative, this table is
normative): gate inputs are named `in0`, `in1`, … (not `a`, `b`).

## 5. Load-time validation

Loading collects **all** errors; it never panics and never partially loads (§5.2).
`LoadError.comp_id` is the component's index in the named circuit's `components` array
(document order); `wire_idx` is the wire's index in `wires`.

Checks, in order:

1. `format` / `version` values.
2. Circuit names unique.
3. Per circuit: component ids unique; component names unique; `wiring.pin` components named;
   type known; attrs valid (types, ranges, known keys, splitter coverage, `value` fits
   `bitsize`, `contents` parses as RLE-hex within the depth limit).
4. Per wire: endpoint comp refs resolve; pin names resolve (including subcircuit pins against
   the target circuit's named pins); joins resolve (wire exists, not self, segment in range);
   at least one pin endpoint.
5. Subcircuit hierarchy acyclic; nesting depth ≤ 64.

Checked at netlist build (still a load-time error; implemented in BACKEND.md task B3 because
subcircuit port widths only exist after flattening): bitsize agreement per derived net,
floating nets, driver counts.

## 6. Canonical serialization (§5.1)

Machine-written files use exactly one byte layout:

- 2-space indent; object keys sorted (recursively); array order preserved (`components`,
  `wires`, `points`, …); every field always emitted (defaults are explicit, e.g. `"name":
""`, `"points": []`); single trailing newline. The one exception is the
  optional cosmetic `wire.color` (§2): omitted when unset so uncolored files
  stay byte-identical.

Saving twice is byte-identical; parsing and re-saving is byte-identical. This is what makes
student circuits diff-friendly in git.

## 7. Memory contents: `rle-hex-v1` (App. A)

Used by `attrs.contents` and by `.hex` autoload files (assemblers already emit this):

```text
image := "" | token ( ws+ token )*
token := value | count "-" value
count := [1-9][0-9]*           (decimal; 0 is not a valid count)
value := [0-9a-fA-F]{1,16}     (hex; at most one machine word)
```

A bare `value` is one word; `count-value` is `count` consecutive copies. Canonical encoding
collapses runs of length ≥ 2 and zero-pads values to the memory's hex width. Decoders must
bound expansion (`max_words`) — a hostile `999999999-ffff` must not OOM the process (§11).
A `contents` image longer than the memory's `depth` is a **load error** (F3), and a word
that does not fit the memory's `bitsize` is a **load error** in `contents` and a clean
configuration error in `--load`/autoload files (F1) — never a panic, never silent zeroing.
Autoload paths resolve relative to the circuit file, sandboxed to its directory tree (§11),
and address memories by hierarchical name (see §9 "Named access" and docs/autograder.md
§7–8; F12).

## 8. Implementation limits (§11)

`bitsize` ≤ 32 (the course word size; derived pin widths may exceed it — a 32-bit
multiplier's `out` is 64 bits); gate `inputs` ≤ 32; `selectBits`/`inputBits` ≤ 8;
memory `depth` ≤ 2²⁰;
split pins ≤ 64; splitter bus bits < 32; hierarchy depth ≤ 64; post-flatten instance cap
~1M (enforced in B3). These bound corrupt files, not students — no real course circuit comes
close.

## 9. Simulation semantics (ratified engine decisions)

The file format is semantics-neutral; this section records the normative simulation
semantics the engine implements for circuits written in it (references: DESIGN.md §4;
details in `crates/core/src/{behavior,delay}.rs` module docs and docs/autograder.md).

**Values and state initialization.**

- A wire's optional `name` is a **label, not a joining rule**: two wires sharing one are
  connected by their geometry like any other wires, and the engine ignores the name beyond
  round-tripping it. It exists so a _tunnel_ (UI_OVERHAUL §86) can be carried in the file —
  the new tool's replacement for the old format's `Tunnel` component, which the transpiler
  materialises as the spanning wire that format only implied.
- Four-state logic per DESIGN.md §4.1. **RAM powers on `X`**: a word that no
  `contents`/autoload image defines, and that no write has touched, reads `X`. Real RAM
  has no defined power-on contents, so a program that reads storage it never initialized
  must see that rather than a zero — assuming zero is not a decision a simulator should
  make on the student's behalf. Anything an image or a write _does_ define is defined,
  explicitly including a zero (`2-2a 00` and a written 0 are zeros, not unknowns).
  Grading stays deterministic: `X` is as reproducible as `0`, and what is now visible is
  the value a student needs to see. **Registers still power on at 0** — a legacy
  compatibility choice under review (docs/bugs.md carries the question for the Head TA).
- A register has **no reset input**: it latches `d` on a rising edge while `en` is asserted and
  holds otherwise. A circuit restarts through the session (`sim_reset`), not through a pin.
- Combinational feedback (feedback loop nets) is **seeded to 0 at power-on** —
  deterministic (§4.5: nothing is ever resolved randomly). Splitters are excepted: they
  carry values but never originate them.
- RAM `depth` must be a power of two (validation), and its `addr` pin is
  `ceil(log2 depth)` wide by default; `addrBits` overrides that (`mem.rom` too), so the
  address width belongs to the design rather than to the word count. Fewer bits than the
  depth needs address a **window** of the memory — the rest is loaded but unreachable;
  more bits leave the extra addresses on the past-end path below. A write with `X` in the
  address is dropped (target unknown). The **editor** does not express a window: picking an
  address width there sets `depth = 2^addrBits` (a memory's size _is_ its address space, so
  there is no word-count field), and an embedded image longer than the new size is trimmed
  to fit. The format keeps both attributes independent for hand-authored and autograder
  files that need the extra storage.
- The defensive past-end path (reads `X`, writes drop) covers the `depth = 1` corner, an
  over-wide `addrBits`, and the lenient post-validation path.
- Divide by zero yields quotient and remainder `X`. A mux with an `X` select outputs the
  data value when all data inputs are equal, else `X`.

**The floating-consume table (§4.1, D3).** Consuming a floating (`Z`) value is a
simulation-halting error naming the component and pin. What counts as _consuming_:

| Component                       | Consumes                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------- |
| gates (incl. not/buffer)        | every input                                                                         |
| controlled buffer               | `en` always; `in` only while `en ≠ 0`                                               |
| mux                             | `sel` always; the selected data input (all of them if `sel` is `X`)                 |
| demux / decoder                 | all inputs                                                                          |
| priority decoder                | its input lines, and only while `en_in` is enabled; `en_in` **never** consumes, so an unconnected enable means *enabled* rather than a floating-read halt (`en_in` driven `0` disables, `X` is conservative) |
| arithmetic                      | all inputs                                                                          |
| register (rising edge only)     | `en` always; `d` only when `en ≠ 0`                                                 |
| RAM                             | `addr` continuously (async read); `we` at the edge; `din` at the edge when `we ≠ 0` |
| ROM                             | `addr` continuously                                                                 |
| pin / probe / LED / hex display | **nothing** — they _observe_; an idle bus displaying as `Z` is legal                |
| splitter                        | **nothing** — it is plumbing; `Z`/`X` flow through to the eventual consumer         |

When a control input is `X` (mux select, buffer enable, register enable, RAM
write-enable), behaviors consume _conservatively_ — any input that could affect the output.
The engine enforces register/RAM edge rules immediately and combinational rules via a
per-consumer cycle-close sweep (a pin that consumes still seeing a never-driven `Z` view
halts; driven-then-idle tri-state buses and in-flight arrivals in overclocked designs never
halt — F6).

**Delay-model semantics** (details: docs/delay-table.md).

- The grading clock is a run parameter (`--clock-half-period-ns`, default 1000 ns;
  docs/delay-table.md). The delay engine runs a **boot settle** (power-on events to
  quiescence, no clock edges) before cycle accounting, and closes the in-progress final
  cycle at run end so its settle counts toward `T_obs` (F7).
- Wire delay is **per-path** per sink (F14; junctions attach at segment midpoints;
  Manhattan fallback for empty `points` — all in docs/delay-table.md).
- Inertial gates: an input change reschedules the pending commit; if the recomputed
  outputs equal the already-scheduled ones, the commit keeps its original time (no defer).
- Setup/hold boundaries: a change `d` is a **setup** violation iff
  `edge − t_setup < d ≤ edge`; a **hold** violation iff `edge ≤ d < edge + t_hold`.
  Violations are warnings; the latch still happens, deterministically. RAM tracks `din`,
  `addr`, and `we`.
- Engine caps (§11 backstops): event storms halt at 1M events/cycle (`Oscillation`,
  also the boot-settle quiescence cap). These bound corrupt/pathological inputs, not
  students.

**Named access.** Autograder/watch-visible components (`mem.ram/rom`, `mem.register`,
`wiring.probe` with a `name`) are addressed by hierarchical name: the plain name at root,
`instance/.../name` when nested (docs/autograder.md §7). Their wire-facing `comp_id`s are
document-order indices within the defining circuit (contract v1.2).

**Reporting pointers.** Exit-code taxonomy, assertion grammar, JSON test-spec, snapshot
schema, and the `est_time`/`timing_violations`/`errors` report fields: docs/autograder.md.

## 10. JSON Schema

Structural schema (Draft 2020-12). Per-type `attrs` constraints are normative in §4's table;
the schema constrains common shapes only.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://circuitsim-plus-plus/schema/csx-v4.json",
  "title": "CircuitSim++ .csx v3",
  "type": "object",
  "additionalProperties": false,
  "required": ["format", "version", "name", "settings", "circuits"],
  "properties": {
    "format": { "const": "circuitsim-plus-plus" },
    "version": { "const": 4 },
    "name": { "type": "string" },
    "settings": {
      "type": "object",
      "additionalProperties": false,
      "required": ["clockHz", "delayTable"],
      "properties": {
        "clockHz": { "type": "integer", "minimum": 0 },
        "delayTable": { "type": "string" }
      }
    },
    "circuits": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["name"],
        "properties": {
          "name": { "type": "string" },
          "components": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["id", "type", "pos"],
              "properties": {
                "id": { "type": "string" },
                "type": { "type": "string" },
                "pos": {
                  "type": "array",
                  "prefixItems": [{ "type": "integer" }, { "type": "integer" }],
                  "minItems": 2,
                  "maxItems": 2
                },
                "rot": { "enum": ["N", "E", "S", "W"], "default": "E" },
                "name": { "type": "string", "default": "" },
                "namePos": { "enum": ["N", "E", "S", "W"] },
                "attrs": { "type": "object", "default": {} }
              }
            }
          },
          "wires": {
            "type": "array",
            "items": {
              "type": "object",
              "additionalProperties": false,
              "required": ["a", "b"],
              "properties": {
                "a": { "$ref": "#/$defs/endpoint" },
                "b": { "$ref": "#/$defs/endpoint" },
                "color": { "type": "string", "pattern": "^#[0-9a-fA-F]{6}$" },
                "points": {
                  "type": "array",
                  "default": [],
                  "items": {
                    "type": "array",
                    "prefixItems": [{ "type": "number" }, { "type": "number" }],
                    "minItems": 2,
                    "maxItems": 2
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  "$defs": {
    "endpoint": {
      "oneOf": [
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["comp", "pin"],
          "properties": {
            "comp": { "type": "string" },
            "pin": { "type": "string" }
          }
        },
        {
          "type": "object",
          "additionalProperties": false,
          "required": ["join"],
          "properties": {
            "join": {
              "type": "object",
              "additionalProperties": false,
              "required": ["wire", "segment"],
              "properties": {
                "wire": { "type": "integer", "minimum": 0 },
                "segment": { "type": "integer", "minimum": 0 }
              }
            }
          }
        }
      ]
    }
  }
}
```
