# `.csx` — CircuitSim++ File Format v2 (normative)

**Status:** Implemented by `crates/core/src/format/` (BACKEND.md task B2). Where this file and
`DESIGN.md` §5 disagree, `DESIGN.md` wins (route corrections through the human). The §5.2 block
in `DESIGN.md` is a *sketch*; this document is the *normative* realization.

## 1. Identity, versioning, extension

- File extension: `.csx` (DESIGN.md §5.3, D4).
- Top-level `format` must be the string `"circuitsim-plus-plus"`.
- Top-level `version` must be `2`. Breaking changes bump `version` and ship with a migration
  (§5.1); this build understands only version 2.
- Encoding: UTF-8 JSON. Files are student-facing and live in git — see §6 (canonical form).

## 2. Document structure

```jsonc
{
  "format": "circuitsim-plus-plus",
  "version": 2,
  "name": "LC-5200 Datapath",
  "settings": {
    "delayModel": "delay",            // "zero" | "delay" — interactive default; the autograder pins "delay" (§4.4)
    "clockHz": 1,                     // UI clock speed at load time
    "delayTable": "cs2200-74ls-v1"    // published, versioned delay table (§4.4)
  },
  "circuits": [ /* ... */ ]
}
```

Circuit names are unique within a document. One circuit is conventionally `"main"`.

### Circuit

```jsonc
{
  "name": "alu",
  "components": [ /* ... */ ],
  "wires": [ /* ... */ ]
}
```

### Component

```jsonc
{
  "id": "c17",                 // author-assigned, unique within the circuit
  "type": "gate.and",          // type string, see §4
  "pos": [15, 10],             // grid coordinates of the origin
  "rot": "E",                  // "N" | "E" | "S" | "W" (default "E")
  "name": "",                  // optional; REQUIRED on autograder-exposed parts and on wiring.pin
  "attrs": { /* per-type, see §4 */ }
}
```

Pins have **no connectivity fields** — wires own connectivity (copper-first, §5.1). Unknown
fields on any object in this section are rejected (`deny_unknown_fields`); unknown `attrs`
keys are rejected per-type (a typo'd attr is an error, never silently ignored).

### Wire and endpoints

```jsonc
{
  "a": { "comp": "c17", "pin": "out" },              // pin endpoint
  "b": { "join": { "wire": 0, "segment": 1 } },       // junction endpoint
  "points": [[18, 11], [30, 11], [30, 21]]            // drawn polyline, a → b
}
```

- Every wire has exactly two endpoints; **at least one endpoint is a pin** (the other may be a
  junction onto another wire's segment). A junction renders as a dot.
- `join.wire` is an index into the circuit's `wires` array. A wire may not join itself.
- `join.segment` indexes the target wire's polyline segments: a wire with `k` points has
  `k − 1` segments (0-based); a wire with empty `points` has exactly one implied straight
  segment (`segment` must be `0`).
- `points` is the drawn path in absolute grid coordinates, ordered from endpoint `a` to
  endpoint `b`, attachment points included. Empty `points` means a straight line between the
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

Type strings are pinned by `docs/tasks/README.md` §4. Common optional attr on all types:
`delay` (`null` or non-negative integer — per-instance delay override, §6).

| Type | Pins | Attrs (defaults) |
|---|---|---|
| `gate.not`, `gate.buffer` | `in`, `out` | `bitsize` (1), `delay` |
| `gate.and` `or` `xor` `nand` `nor` `xnor` | `in0`..`in{inputs−1}`, `out` | `bitsize` (1), `inputs` (2; 2..=64), `negateInputs` ([]) — input pin names to bubble, `delay` |
| `wiring.controlled-buffer` ⚠️¹ | `in`, `en`, `out` | `bitsize` (1), `delay` |
| `wiring.pin` | `pin` | `bitsize` (1), `isOutput` (false), `radix` ("unsigned" \| "signed" \| "hex") |
| `wiring.constant` | `out` | `bitsize` (1), `value` ("0") — hex string, must fit `bitsize` |
| `wiring.clock` | `out` | — |
| `wiring.splitter` | `bus` + one per `splits` key | `splits` (required): object mapping pin name → array of bus bit indices (index 0 of each array = that pin's LSB). Every bus bit must be covered exactly once; bus width = max index + 1 |
| `wiring.probe` | `in` | `bitsize` (1), `radix` |
| `plexers.mux` | `in0`..`in{2^sel−1}`, `sel`, `out` | `bitsize` (1), `selectBits` (1; 1..=8), `delay` |
| `plexers.demux` | `in`, `sel`, `out0`..`out{2^sel−1}` | `bitsize` (1), `selectBits` (1), `delay` |
| `plexers.decoder` | `in`, `out0`..`out{2^in−1}` | `inputBits` (2; 1..=8), `delay` |
| `arith.adder` | `a`, `b`, `cin`, `out`, `cout` | `bitsize` (1), `delay` |
| `arith.subtractor` | `a`, `b`, `bin`, `out`, `bout` | `bitsize` (1), `delay` |
| `arith.multiplier` | `a`, `b`, `out` (out = 2×bitsize) | `bitsize` (1), `delay` |
| `arith.divider` | `a`, `b`, `quot`, `rem` | `bitsize` (1), `delay` |
| `arith.comparator` | `a`, `b`, `lt`, `eq`, `gt` | `bitsize` (1), `delay` |
| `arith.negator` | `in`, `out` | `bitsize` (1), `delay` |
| `arith.shifter` | `in`, `amt`, `out` | `bitsize` (1), `shift` ("ll" \| "lr" \| "ar" \| "rl" \| "rr"), `delay` |
| `arith.bit-extender` | `in`, `out` | `inBits` (8), `outBits` (16; > inBits), `mode` ("zero" \| "sign") |
| `mem.register` | `d`, `clk`, `en`, `rst`, `q` | `bitsize` (1), `delay` |
| `mem.ram` | `addr`, `din`, `dout`, `we`, `clk` | `bitsize` (1), `depth` (256; power of two, ≤ 2²⁰), `autoload` (null — path, see §7), `contents` (null — RLE-hex, see §7) |
| `mem.rom` | `addr`, `out` | same as `mem.ram` |
| `subcircuit` | from target circuit's named pins | `circuit` (required) |
| `io.button`, `io.led`, `io.hexdisplay` | `out` / `in` / `in` | `bitsize` (1; 4 for hexdisplay) — inert headless |

⚠️¹ `wiring.controlled-buffer` is required by BACKEND.md B4 ("controlled buffer (tri-state)")
and §4.1's tri-state semantics but is absent from the pinned registry list in
`docs/tasks/README.md` §4 — flagged to the human; the name is this document's assignment.

**Deviations from the DESIGN.md §5.2 sketch** (sketch is illustrative, this table is
normative): gate inputs are named `in0`, `in1`, … (not `a`, `b`); `negateInputs` takes those
names.

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
  ""`, `"points": []`); single trailing newline.

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
Autoload paths resolve relative to the circuit file, sandboxed to its directory tree (§11;
enforced by the loader that owns file access, task B4/B9).

## 8. Implementation limits (§11)

`bitsize` ≤ 32 (the course word size; derived pin widths may exceed it — a 32-bit
multiplier's `out` is 64 bits); gate `inputs` ≤ 64; `selectBits`/`inputBits` ≤ 8;
memory `depth` ≤ 2²⁰;
split pins ≤ 64; splitter bus bits < 32; hierarchy depth ≤ 64; post-flatten instance cap
~1M (enforced in B3). These bound corrupt files, not students — no real course circuit comes
close.

## 9. JSON Schema

Structural schema (Draft 2020-12). Per-type `attrs` constraints are normative in §4's table;
the schema constrains common shapes only.

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://circuitsim-plus-plus/schema/csx-v2.json",
  "title": "CircuitSim++ .csx v2",
  "type": "object",
  "additionalProperties": false,
  "required": ["format", "version", "name", "settings", "circuits"],
  "properties": {
    "format": { "const": "circuitsim-plus-plus" },
    "version": { "const": 2 },
    "name": { "type": "string" },
    "settings": {
      "type": "object",
      "additionalProperties": false,
      "required": ["delayModel", "clockHz", "delayTable"],
      "properties": {
        "delayModel": { "enum": ["zero", "delay"] },
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
                "points": {
                  "type": "array",
                  "default": [],
                  "items": {
                    "type": "array",
                    "prefixItems": [{ "type": "integer" }, { "type": "integer" }],
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
