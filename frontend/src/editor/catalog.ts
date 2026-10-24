import { encodeRleHex, hexWidthFor, parseRleHex } from "../lib/rleHex";
import type { CsxCircuit, CsxComponent } from "../model/csx";

/**
 * Component metadata catalog (FRONTEND.md U3): pin geometry + body sizes
 * per registry type (naming pinned in docs/tasks/README.md §4). Frontend
 * owns RENDERING metadata; Backend owns semantics — the pin sets here are
 * for drawing, hit-testing, and wire endpoint placement.
 *
 * Geometry convention: a component's `pos` is its body's top-left corner
 * in grid units, EAST rotation. Pins are offsets from that origin; other
 * rotations are derived in layout.ts. U4 replaces box bodies with
 * distinctive gate shapes — pin positions stay.
 */

export type PinKind = "in" | "out" | "inout";

export interface PinSpec {
  name: string;
  dx: number;
  dy: number;
  kind: PinKind;
  /** Multi-bit pin width (for thickness ∝ bitsize); 1 when omitted. */
  bitsize?: number;
  /** Draw an inversion bubble at this pin (gate input negation, `negate`). */
  bubble?: boolean;
}

export interface CompSpec {
  width(attrs: Readonly<Record<string, unknown>>): number;
  height(attrs: Readonly<Record<string, unknown>>): number;
  pins(attrs: Readonly<Record<string, unknown>>): PinSpec[];
  /** Body mark: a symbol where the family has one, else a short abbreviation. */
  caption(attrs: Readonly<Record<string, unknown>>): string;
  /** Human name for the palette tile (defaults to the body mark). */
  label?: string;
  /** Body-mark scale — symbols read better a little larger (default 1). */
  markSize?: number;
}

function numAttr(attrs: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = attrs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/**
 * Pin width from attrs.bitsize (1..32, default 1 — format-v2's default).
 * This is what makes the properties dialog's "Bit size" field real:
 * thickness ∝ bitsize and sim values both read pin widths from here.
 */
export function bitsOf(attrs: Readonly<Record<string, unknown>>, dflt = 1): number {
  return uintAttr(attrs, "bitsize", dflt);
}

/**
 * The shifter's `amt` pin width: how many bits it takes to index `bitsize`
 * values. Mirrors the engine's `addr_width(bitsize)` (min 1), so a 32-bit
 * shifter's amount input is 5 bits wide on both sides.
 */
function shiftAmountBits(attrs: Readonly<Record<string, unknown>>): number {
  const b = bitsOf(attrs);
  return Math.max(1, 32 - Math.clz32(b - 1));
}

/** Default `depth` for a memory (format-v2 §4). */
const DEFAULT_MEM_DEPTH = 256;

/**
 * A memory's `addr` pin width: `ceil(log2(depth))`, min 1 — the engine's exact
 * `addr_width` (format-v2 §4). A 256-word RAM therefore takes an **8-bit**
 * address.
 *
 * This used to fall through to `bitsOf` (the DATA width, default 1), so a fresh
 * RAM drew a 1-bit `addr` while the core used 8 — the editor then flagged a
 * perfectly correct 8-bit address as a width mismatch, and the pin widths on
 * screen had nothing to do with the address space.
 */
export function memAddrBits(attrs: Readonly<Record<string, unknown>>): number {
  // `addrBits` decouples the address width from the address SPACE (format-v2
  // §4/§9): an explicit width wins, in both directions — fewer bits address a
  // window of the memory, more leave the extra addresses reading X. Absent, the
  // width follows `depth`.
  const explicit = attrs["addrBits"];
  if (
    typeof explicit === "number" &&
    Number.isInteger(explicit) &&
    explicit >= 1 &&
    explicit <= 32
  ) {
    return explicit; // in range: the engine takes it as written (components.rs)
  }
  const depth = Math.max(1, Math.floor(numAttr(attrs, "depth", DEFAULT_MEM_DEPTH)));
  return Math.max(1, 32 - Math.clz32(depth - 1));
}

/**
 * Picking a memory's address width resizes it. In the editor a memory's size is
 * its address space (`depth = 2^addrBits`); the FORMAT keeps the two
 * independent, so a hand-authored or autograder file can still say "256 words,
 * 4 address bits" (format-v2 §9) — the picker just normalizes once it is used.
 *
 * An embedded image longer than the new size would be a load error ("image has
 * N words, exceeding the limit of M"), so the tail is dropped along with the
 * resize; Undo is the way back.
 */
function memoryWidthPatch(
  bits: number,
  attrs: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const depth = 2 ** bits;
  const patch: Record<string, unknown> = { addrBits: bits, depth };
  const contents = attrs["contents"];
  if (typeof contents === "string" && contents.trim() !== "") {
    const words = parseRleHex(contents);
    if (words.length > depth) {
      patch["contents"] = encodeRleHex(words.slice(0, depth), hexWidthFor(bitsOf(attrs)));
    }
  }
  return patch;
}

/** Integer attr clamped to 1..32 (format-v2's bit-width range). */
function uintAttr(
  attrs: Readonly<Record<string, unknown>>,
  key: string,
  dflt: number,
  max = 32,
): number {
  const v = attrs[key];
  if (typeof v !== "number" || !Number.isInteger(v)) return dflt;
  return Math.max(1, Math.min(max, v));
}

/**
 * Standard n-input gate: inputs on the left, out on the right. The body grows
 * TALLER with the input count so the pins keep their spacing, but the rounded /
 * pointed OUTPUT cap stays a 2-input gate's size — only the flat input side
 * grows (UI_OVERHAUL §44, see `shapes.ts`'s `CAP_H`).
 */
function gateSpec(caption: string, minInputs: number): CompSpec {
  // A bubbled input (`negate`) widens the body by one grid unit, exactly as
  // CircuitSim CE does, so the bubble sits inside the input edge and the pin
  // stays on the outline (format-v2 §4).
  const negatedInputs = (attrs: Readonly<Record<string, unknown>>): number[] =>
    Array.isArray(attrs.negate) ? (attrs.negate as number[]) : [];
  const bodyWidth = (attrs: Readonly<Record<string, unknown>>): number =>
    negatedInputs(attrs).length > 0 ? 6 : 5;
  return {
    width: bodyWidth,
    height: (attrs) => Math.max(3, numAttr(attrs, "inputs", 2) + 1),
    pins: (attrs) => {
      const n = Math.max(minInputs, numAttr(attrs, "inputs", 2));
      const h = Math.max(3, n + 1);
      const width = bitsOf(attrs); // bitwise multi-bit gates (DLS-style)
      const bubbled = negatedInputs(attrs);
      const pins: PinSpec[] = [];
      for (let i = 0; i < n; i++) {
        pins.push({
          name: `in${i}`,
          dx: 0,
          dy: ((i + 1) * h) / (n + 1),
          kind: "in",
          bitsize: width,
          bubble: bubbled.includes(i),
        });
      }
      pins.push({
        name: "out",
        dx: bodyWidth(attrs),
        dy: h / 2,
        kind: "out",
        bitsize: width,
      });
      return pins;
    },
    caption: () => caption,
  };
}

/**
 * Box component with a static pin list. `bitsize: BUS_WIDTH` in the list
 * marks an attr-driven bus pin (resolved via bitsOf); any other bitsize
 * is literal.
 */
function boxSpec(
  w: number,
  h: number,
  pins: PinSpec[],
  caption: string,
  extra: { label?: string; markSize?: number; defaultBits?: number } = {},
): CompSpec {
  const spec: CompSpec = {
    width: () => w,
    height: () => h,
    pins: (attrs) =>
      pins.map((p) =>
        p.bitsize === BUS_WIDTH ? { ...p, bitsize: bitsOf(attrs, extra.defaultBits ?? 1) } : p,
      ),
    caption: () => caption,
  };
  return withExtras(spec, extra);
}

/**
 * The body width a value readout needs (UI_OVERHAUL §56): the WIDEST text the
 * declared bit width can print in the chosen base — `0x` + one digit per nibble,
 * `0b` + one per bit, or the most decimal digits the width can hold.
 *
 * Sizing on the declared width rather than on the current value is what keeps
 * the box still while a value is typed, and it is the only rule a probe can use
 * at all: a probe's value is live, so "fit what it shows" would resize the part
 * on every clock.
 *
 * The readout is drawn at size 1 in a box `w` wide, of which `fitValueLine`
 * gives the text `0.86 × w`; a character is 0.62 units, so the digits need
 * `0.72 × chars` and the rest is air, so text never touches the edge.
 */
export function readoutWidth(bits: number, radix: unknown): number {
  const b = Math.min(32, Math.max(1, bits));
  // Hex pads to the nibble count, binary to the bit count, and decimal needs no
  // prefix — just the most digits `b` bits can print (32 bits → 10).
  const chars =
    radix === "bin" ? 2 + b : radix === "dec" ? Math.ceil(b * Math.log10(2)) : 2 + hexWidthFor(b);
  const w = chars * 0.72 + 0.6;
  return Math.max(3, Math.round(w * 20) / 20); // to a tidy 0.05
}

/** Attach the optional palette label / body-mark scale to a spec. */
function withExtras(
  spec: CompSpec,
  extra: { label?: string; markSize?: number; defaultBits?: number },
): CompSpec {
  return {
    ...spec,
    ...(extra.label !== undefined && { label: extra.label }),
    ...(extra.markSize !== undefined && { markSize: extra.markSize }),
  };
}

/**
 * mux/demux/decoder with select-width-driven pin sets (n = 2^select data
 * lines). Pin names AND widths mirror the engine registry (format-v2 §4), so
 * every pin here has a counterpart the core will resolve:
 *
 *   mux      in0..in{n-1}, sel (selectBits wide), out
 *   demux    in, sel (selectBits wide), out0..out{n-1}
 *   decoder  in (inputBits wide), out0..out{n-1}   — the select IS the input
 *
 * `selectKey`/`selectDefault` give the select width: `selectBits` (mux/demux,
 * default 1) or `inputBits` (decoder, default 2).
 */
function plexerSpec(
  caption: string,
  flavor: "mux" | "demux" | "decoder",
  selectKey = "selectBits",
  selectDefault = 1,
): CompSpec {
  const n = (attrs: Readonly<Record<string, unknown>>) =>
    2 ** numAttr(attrs, selectKey, selectDefault);
  const h = (attrs: Readonly<Record<string, unknown>>) => Math.max(4, n(attrs) + 1);
  return {
    width: () => 4,
    height: h,
    pins: (attrs) => {
      const count = n(attrs);
      const height = h(attrs);
      const width = bitsOf(attrs);
      const selWidth = numAttr(attrs, selectKey, selectDefault);
      const pins: PinSpec[] = [];
      const outputs = (bitsize: number) => {
        for (let i = 0; i < count; i++) {
          pins.push({
            name: `out${i}`,
            dx: 4,
            dy: ((i + 1) * height) / (count + 1),
            kind: "out",
            bitsize,
          });
        }
      };
      if (flavor === "mux") {
        for (let i = 0; i < count; i++) {
          pins.push({
            name: `in${i}`,
            dx: 0,
            dy: ((i + 1) * height) / (count + 1),
            kind: "in",
            bitsize: width,
          });
        }
        pins.push({ name: "sel", dx: 2, dy: height, kind: "in", bitsize: selWidth });
        pins.push({ name: "out", dx: 4, dy: height / 2, kind: "out", bitsize: width });
      } else if (flavor === "demux") {
        pins.push({ name: "in", dx: 0, dy: height / 2, kind: "in", bitsize: width });
        pins.push({ name: "sel", dx: 2, dy: height, kind: "in", bitsize: selWidth });
        outputs(width);
      } else {
        // The decoder's select bits are its DATA input (engine `in`), not a
        // separate `sel` — one bus pin on the left.
        pins.push({ name: "in", dx: 0, dy: height / 2, kind: "in", bitsize: selWidth });
        outputs(1);
      }
      return pins;
    },
    caption: () => caption,
  };
}

/**
 * Priority decoder (`plexers.priority-decoder`): N single-bit input lines
 * (in0 = lowest priority) → the binary index of the highest-numbered
 * asserted line (`out`, ⌈log2 N⌉ bits) plus a `valid` flag, on the right
 * edge.  Named for the palette wording the course uses (UI_OVERHAUL §54);
 * behaviorally it is the standard priority encoder.
 *
 * The enable chain is CircuitSim CE's (`en_in` on the bottom edge, `en_out`
 * on the top, UI_OVERHAUL §88): chain `en_out` into the next stage's `en_in`,
 * the stage that finds something asserts `valid` and drops `en_out`.
 */
function priorityDecoderSpec(): CompSpec {
  const lines = (attrs: Readonly<Record<string, unknown>>) =>
    Math.max(2, numAttr(attrs, "inputBits", 4));
  const height = (attrs: Readonly<Record<string, unknown>>) => Math.max(4, lines(attrs) + 1);
  return {
    width: () => 4,
    height,
    pins: (attrs) => {
      const count = lines(attrs);
      const h = height(attrs);
      const outBits = Math.max(1, 32 - Math.clz32(count - 1));
      const pins: PinSpec[] = [];
      for (let i = 0; i < count; i++) {
        pins.push({
          name: `in${i}`,
          dx: 0,
          dy: ((i + 1) * h) / (count + 1),
          kind: "in",
          bitsize: 1,
        });
      }
      pins.push({ name: "out", dx: 4, dy: h / 3, kind: "out", bitsize: outBits });
      pins.push({ name: "valid", dx: 4, dy: (2 * h) / 3, kind: "out", bitsize: 1 });
      // The cascade: `en_in` enters at the bottom, `en_out` leaves at the top, so
      // stacking stages routes the chain upward (CircuitSim CE's layout).
      pins.push({ name: "en_in", dx: 2, dy: h, kind: "in", bitsize: 1 });
      pins.push({ name: "en_out", dx: 2, dy: 0, kind: "out", bitsize: 1 });
      return pins;
    },
    caption: () => "PRI",
  };
}

const BUS_WIDTH = 32; // sentinel: attr-driven bus pin (boxSpec resolves via bitsOf)

/** Default splitter mapping (format-v2 §4 requires `splits`): b{i} = bus bit i. */
const DEFAULT_SPLITS: Readonly<Record<string, number[]>> = {
  b0: [0],
  b1: [1],
  b2: [2],
  b3: [3],
};

/** Parsed `splits` attr: named pins → bus bit indices (LSB first). */
function splitsOf(attrs: Readonly<Record<string, unknown>>): { name: string; bits: number[] }[] {
  const raw = attrs["splits"];
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const entries: { name: string; bits: number[] }[] = [];
    for (const [name, bits] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(bits)) continue;
      entries.push({
        name,
        bits: bits.filter(
          (b): b is number => typeof b === "number" && Number.isInteger(b) && b >= 0,
        ),
      });
    }
    if (entries.length > 0) return entries;
  }
  return Object.entries(DEFAULT_SPLITS).map(([name, bits]) => ({ name, bits: [...bits] }));
}

/** Bus plumbing: one bidirectional pin per `splits` key plus the bus itself. */
function splitterSpec(): CompSpec {
  return {
    width: () => 2,
    height: (attrs) => Math.max(2, splitsOf(attrs).length + 1),
    pins: (attrs) => {
      const splits = splitsOf(attrs);
      const h = Math.max(2, splits.length + 1);
      const busWidth = Math.max(
        1,
        ...splits.map((s) => (s.bits.length === 0 ? 1 : Math.max(...s.bits) + 1)),
      );
      const pins: PinSpec[] = [{ name: "bus", dx: 0, dy: h / 2, kind: "inout", bitsize: busWidth }];
      splits.forEach((s, i) => {
        pins.push({
          name: s.name,
          dx: 2,
          dy: ((i + 1) * h) / (splits.length + 1),
          kind: "inout",
          bitsize: Math.max(1, s.bits.length),
        });
      });
      return pins;
    },
    caption: () => "SPLIT",
    markSize: 0.65,
  };
}

/**
 * Attrs seeded when a component is first placed, so the document is valid
 * from the first click even where format-v2 §4 marks an attr REQUIRED
 * (the splitter's bit mapping).
 */
export function defaultAttrs(type: string): Record<string, unknown> | undefined {
  if (type === "wiring.splitter") return { splits: { ...DEFAULT_SPLITS } };
  // A constant always carries a value so it drives its net from the start
  // (UI_OVERHAUL §36): default 0.
  if (type === "wiring.constant") return { value: "0" };
  // An annotation is born with visible text so it can be grabbed and edited.
  if (type === "misc.text") return { text: "Text" };
  // A breakpoint's condition is written out too, so the body says what it is
  // watching for from the moment it is placed (`= 0x05`, format-v2 §4's default).
  if (type === "debug.breakpoint") return { value: "0" };
  return undefined;
}

// ---- subcircuit instances (hierarchy) ----

/** Instance box width; height scales with the interface size. */
const SUB_W = 8;
const SUB_MIN_H = 4;

/**
 * A circuit's interface: its named `wiring.pin` components in DOCUMENT
 * ORDER (the netlist's bridge order, task B3), split by direction from the
 * circuit's own perspective: an "input" pin drives the circuit's internals
 * (isOutput unset), an "output" pin is driven by them (isOutput: true).
 */
export function circuitInterface(c: CsxCircuit): {
  inputs: CsxComponent[];
  outputs: CsxComponent[];
} {
  const pins = c.components.filter(
    (x) => x.type === "wiring.pin" && x.name !== undefined && x.name !== "",
  );
  return {
    inputs: pins.filter((x) => x.attrs?.isOutput !== true),
    outputs: pins.filter((x) => x.attrs?.isOutput === true),
  };
}

function subcircuitTarget(
  attrs: Readonly<Record<string, unknown>>,
  circuits: readonly CsxCircuit[],
): CsxCircuit | undefined {
  const name = attrs["circuit"];
  return typeof name === "string" ? circuits.find((c) => c.name === name) : undefined;
}

/** Largest box an instance may ask for, in grid units (the engine checks the same). */
const SUB_MAX = 400;

/**
 * An explicit box dimension: nonsense or out-of-range falls back to the derived
 * size, and a legal-but-too-small value is clamped UP to `min` rather than refused
 * (UI_OVERHAUL §79 — the user asked for a small box, so they get the smallest one
 * the pins allow).
 */
function boxSize(value: unknown, min: number, dflt: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return dflt;
  const v = Math.round(value);
  if (v <= 0 || v > SUB_MAX) return dflt;
  return Math.max(min, v);
}

/**
 * The instance's box: the pins' own size unless the instance carries `width` /
 * `height` (UI_OVERHAUL §79). The pins sit at `(i+1)·h/(n+1)`, so an explicit
 * height may shrink a tall default but never below `n + 1` — one grid unit apart —
 * and the default stays the generous `2·n` the catalog always derived.
 */
export function subcircuitSize(
  attrs: Readonly<Record<string, unknown>>,
  circuits: readonly CsxCircuit[],
): { w: number; h: number } {
  const target = subcircuitTarget(attrs, circuits);
  const iface = target === undefined ? null : circuitInterface(target);
  const pins = iface === null ? 0 : Math.max(iface.inputs.length, iface.outputs.length);
  return {
    w: boxSize(attrs["width"], SUB_W, SUB_W),
    h: boxSize(attrs["height"], Math.max(SUB_MIN_H, pins + 1), Math.max(SUB_MIN_H, 2 * pins)),
  };
}

/**
 * Instance-side pins: subcircuit inputs on the LEFT edge, outputs on the
 * RIGHT, each group spread top-to-bottom in the target's document order
 * (gate-style spacing). Pin name = the pin component's `name`; width = its
 * `bitsize`. Unknown target → no pins (validation reports the error).
 */
export function subcircuitPins(
  attrs: Readonly<Record<string, unknown>>,
  circuits: readonly CsxCircuit[],
): PinSpec[] {
  const target = subcircuitTarget(attrs, circuits);
  if (target === undefined) return [];
  const { inputs, outputs } = circuitInterface(target);
  const { w, h } = subcircuitSize(attrs, circuits);
  const pins: PinSpec[] = [];
  inputs.forEach((p, i) => {
    pins.push({
      name: p.name ?? "",
      dx: 0,
      dy: ((i + 1) * h) / (inputs.length + 1),
      kind: "in",
      bitsize: bitsOf(p.attrs ?? {}),
    });
  });
  outputs.forEach((p, i) => {
    pins.push({
      name: p.name ?? "",
      dx: w,
      dy: ((i + 1) * h) / (outputs.length + 1),
      kind: "out",
      bitsize: bitsOf(p.attrs ?? {}),
    });
  });
  return pins;
}

const REGISTRY: Record<string, CompSpec> = {
  // Gates (DESIGN.md §6)
  "gate.and": gateSpec("AND", 2),
  "gate.or": gateSpec("OR", 2),
  "gate.xor": gateSpec("XOR", 2),
  "gate.nand": gateSpec("NAND", 2),
  "gate.nor": gateSpec("NOR", 2),
  "gate.xnor": gateSpec("XNOR", 2),
  "gate.not": boxSpec(
    3,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 3, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "NOT",
  ),
  "gate.buffer": boxSpec(
    3,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 3, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "BUF",
  ),
  // Tri-state buffer (format-v2 §4 `wiring.controlled-buffer`, BACKEND.md B4):
  // a buffer with an `en` control on the BOTTOM edge (§24). Exposed as the
  // palette's BUFFER tile (UI_OVERHAUL §43).
  "wiring.controlled-buffer": boxSpec(
    3,
    3,
    [
      { name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BUS_WIDTH },
      { name: "en", dx: 1.5, dy: 3, kind: "in" },
      { name: "out", dx: 3, dy: 1.5, kind: "out", bitsize: BUS_WIDTH },
    ],
    "BUF",
    { label: "BUFFER" },
  ),

  // Wiring
  // The subcircuit interface (format-v2 §5): a pin's `name` is required and
  // becomes the instance-side pin name; its single terminal is named "pin"
  // (backend registry). An input pin (isOutput unset) DRIVES its circuit
  // → kind "out"; an output pin is driven → kind "in". Canonical geometry
  // faces EAST (terminal at dx=w); placement defaults put input pins at
  // rot E (body faces left) and output pins at rot W (body faces right).
  "wiring.pin": {
    width: () => 2,
    height: () => 1,
    pins: (attrs) => [
      {
        name: "pin",
        dx: 2,
        dy: 0.5,
        kind: attrs?.isOutput === true ? "in" : "out",
        bitsize: bitsOf(attrs ?? {}),
      },
    ],
    caption: () => "PIN",
  },
  // The constant is roomy enough to read its value (UI_OVERHAUL §55): 3x2,
  // its `out` on the right edge.
  // A pass gate (UI_OVERHAUL §73): the controlled buffer with a `gate` control,
  // so a floating gate halts naming the pin the part actually has.
  "wiring.transistor": boxSpec(
    3,
    3,
    [
      { name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BUS_WIDTH },
      { name: "gate", dx: 1.5, dy: 3, kind: "in" },
      { name: "out", dx: 3, dy: 1.5, kind: "out", bitsize: BUS_WIDTH },
    ],
    "FET",
    { label: "TRANSISTOR" },
  ),

  // Power / ground (UI_OVERHAUL §71): fixed 1-bit sources drawn like a constant —
  // the caption IS the value, and there is nothing to configure.
  "wiring.power": boxSpec(3, 2, [{ name: "out", dx: 3, dy: 1, kind: "out", bitsize: 1 }], "1"),
  "wiring.ground": boxSpec(3, 2, [{ name: "out", dx: 3, dy: 1, kind: "out", bitsize: 1 }], "0"),
  // A constant's body IS its value (UI_OVERHAUL §56): the box is sized to the
  // readout it will draw, so a wide word is shown whole rather than cut with an
  // ellipsis, and the `out` pin rides the box's right edge — a pin that sits on
  // an edge stays on that edge (layout.ts), and its wires follow (document.ts).
  "wiring.constant": {
    width: (attrs) => readoutWidth(bitsOf(attrs), attrs["radix"]),
    height: () => 2,
    pins: (attrs) => [
      {
        name: "out",
        dx: readoutWidth(bitsOf(attrs), attrs["radix"]),
        dy: 1,
        kind: "out",
        bitsize: bitsOf(attrs),
      },
    ],
    caption: () => "CONST",
  },
  "wiring.clock": boxSpec(2, 2, [{ name: "out", dx: 2, dy: 1, kind: "out" }], "CLK"),
  // The reset source (DESIGN.md §4.3) — the same shape as the general-purpose button, so a
  // graded run sees it released; the square contact in `shapes.ts` is what marks it out.
  "wiring.reset": boxSpec(3, 2, [{ name: "out", dx: 3, dy: 1, kind: "out" }], "RST"),
  // The probe's pointed shape points along its `in` pin, so it grows AWAY from
  // that pin: the pin stays put (dx 0), the body extends behind it, and the
  // readout fits without pushing into whatever the probe is watching
  // (UI_OVERHAUL §56).
  "wiring.probe": {
    width: (attrs) => readoutWidth(bitsOf(attrs), attrs["radix"]),
    height: () => 2,
    pins: (attrs) => [{ name: "in", dx: 0, dy: 1, kind: "in", bitsize: bitsOf(attrs) }],
    caption: () => "PROBE",
  },
  "wiring.splitter": splitterSpec(),

  // Debugging (UI_OVERHAUL §90): a watcher, not a part of the logic. `in` is the
  // watched value (DATA) and `en` gates the watch (ENABLE). Its shape is
  // CircuitSim CE's BreakpointPeer exactly (UI_OVERHAUL §93): `en` on the left
  // edge, `in` on the bottom, on a 4×4 body — the old part worked, and a
  // converted schematic's wires should land exactly where they always did. The
  // body reads out the condition (`= 0x05`, docScene) instead of the mark alone.
  "debug.breakpoint": boxSpec(
    4,
    4,
    [
      // `in` first: the engine identifies the watched pin by SLOT (format-v2
      // §4), and `en` gates the watch — the old tool's DATA/ENABLE pair.
      { name: "in", dx: 2, dy: 4, kind: "in", bitsize: BUS_WIDTH },
      { name: "en", dx: 0, dy: 1, kind: "in" },
    ],
    "BP",
    { label: "Breakpoint" },
  ),

  // Plexers (pin sets scale with the select width: n = 2^select data lines)
  "plexers.mux": plexerSpec("MUX", "mux"),
  "plexers.demux": plexerSpec("DEMUX", "demux"),
  "plexers.decoder": plexerSpec("DEC", "decoder", "inputBits", 2),
  "plexers.priority-decoder": priorityDecoderSpec(),

  // Arithmetic. Pin names mirror the engine registry (format-v2 §4): carry
  // in/out are `cin`/`cout`, the subtractor's borrow is `bin`/`bout`, and the
  // divider emits `quot`/`rem` — never `c_in`/`c_out`, which the core rejects.
  "arith.adder": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "cin", dx: 3, dy: 0, kind: "in" },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
      { name: "cout", dx: 3, dy: 4, kind: "out" },
    ],
    "+",
    { label: "ADD", markSize: 1.7 },
  ),
  "arith.subtractor": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "bin", dx: 3, dy: 0, kind: "in" },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
      { name: "bout", dx: 3, dy: 4, kind: "out" },
    ],
    "\u2212",
    { label: "SUB", markSize: 1.7 },
  ),
  "arith.multiplier": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
    ],
    "\u00d7",
    { label: "MUL", markSize: 1.7 },
  ),
  "arith.divider": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "quot", dx: 6, dy: 1, kind: "out", bitsize: BUS_WIDTH },
      { name: "rem", dx: 6, dy: 3, kind: "out", bitsize: BUS_WIDTH },
    ],
    "\u00f7",
    { label: "DIV", markSize: 1.7 },
  ),
  "arith.comparator": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "lt", dx: 6, dy: 1, kind: "out" },
      { name: "eq", dx: 6, dy: 2, kind: "out" },
      { name: "gt", dx: 6, dy: 3, kind: "out" },
    ],
    "=",
    { label: "CMP", markSize: 1.7 },
  ),
  "arith.negator": boxSpec(
    4,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 4, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "~",
    { label: "NEG", markSize: 1.7 },
  ),
  // `amt` is `addr_width(bitsize)` wide in the engine, so the shifter needs a
  // hand-written spec — boxSpec has one BUS_WIDTH sentinel and both `in`/`out`
  // would take it.
  "arith.shifter": {
    width: () => 6,
    height: () => 3,
    pins: (attrs) => [
      { name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: bitsOf(attrs) },
      { name: "amt", dx: 3, dy: 3, kind: "in", bitsize: shiftAmountBits(attrs) },
      { name: "out", dx: 6, dy: 1.5, kind: "out", bitsize: bitsOf(attrs) },
    ],
    caption: () => "\u00ab",
    label: "SHIFT",
    markSize: 1.7,
  },
  // Bit extender: inBits → outBits with zero/sign extension (format-v2 §4).
  "arith.bit-extender": {
    width: () => 4,
    height: () => 2,
    pins: (attrs) => [
      { name: "in", dx: 0, dy: 1, kind: "in", bitsize: uintAttr(attrs, "inBits", 8) },
      { name: "out", dx: 4, dy: 1, kind: "out", bitsize: uintAttr(attrs, "outBits", 16) },
    ],
    caption: () => "EXT",
    label: "EXT",
    markSize: 1.5,
  },

  // Memory. Clock and write-enable inputs sit on the BOTTOM edge, the way
  // they're drawn on a data sheet (UI_OVERHAUL §24); pin names follow
  // format-v2 §4 exactly (d/clk/en/q, addr/din/dout/we/clk, addr/out).
  "mem.register": boxSpec(
    6,
    4,
    [
      { name: "d", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "en", dx: 0, dy: 3, kind: "in" },
      { name: "clk", dx: 2, dy: 4, kind: "in" },
      { name: "rst", dx: 4, dy: 4, kind: "in" },
      { name: "q", dx: 6, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "REG",
  ),
  // Clock and write-enable left→right on the bottom edge (we spaced under
  // dout), and din spread
  // further from addr (UI decision).
  // The `addr` pin is as wide as the ADDRESS SPACE (`ceil(log2 depth)`), not the
  // data width — see `memAddrBits`; `din`/`dout` follow `bitsize`.
  "mem.ram": {
    width: () => 10,
    height: () => 6,
    pins: (attrs) => [
      { name: "addr", dx: 0, dy: 1, kind: "in", bitsize: memAddrBits(attrs) },
      { name: "din", dx: 0, dy: 4, kind: "in", bitsize: bitsOf(attrs) },
      { name: "dout", dx: 10, dy: 1, kind: "out", bitsize: bitsOf(attrs) },
      { name: "clk", dx: 3, dy: 6, kind: "in" },
      { name: "rst", dx: 7, dy: 6, kind: "in" },
      { name: "we", dx: 9, dy: 6, kind: "in" },
    ],
    caption: () => "RAM",
  },
  "mem.rom": {
    width: () => 10,
    height: () => 6,
    pins: (attrs) => [
      { name: "addr", dx: 0, dy: 3, kind: "in", bitsize: memAddrBits(attrs) },
      { name: "out", dx: 10, dy: 3, kind: "out", bitsize: bitsOf(attrs) },
    ],
    caption: () => "ROM",
  },

  // Hierarchy (pins come from the referenced circuit's wiring.pin
  // components — see subcircuitPins below; compPins/compSize special-case
  // this type with the document's circuits as context)
  subcircuit: {
    width: () => SUB_W,
    height: () => SUB_MIN_H,
    pins: () => [], // static fallback — the real pins need circuit context
    caption: (attrs) =>
      typeof attrs.circuit === "string" && attrs.circuit !== "" ? attrs.circuit : "SUB",
  },

  // I/O (UI-only parts)
  // Wider than tall so the plunger/cap can point right, along the lead to the
  // output pin (UI decision: the button image is rotated 90° clockwise).
  "io.button": boxSpec(3, 2, [{ name: "out", dx: 3, dy: 1, kind: "out" }], "BTN"),
  "io.led": boxSpec(1, 1, [{ name: "in", dx: 0.5, dy: 1, kind: "in" }], "LED"),
  // One 7-segment digit: the input is a single hex nibble (4 bits), so a
  // 4-bit constant drives it without a width mismatch. Taller than wide so the
  // digit has a display-like aspect (UI decisions).
  "io.hexdisplay": boxSpec(3, 4, [{ name: "in", dx: 0, dy: 2, kind: "in", bitsize: 4 }], "HEX"),

  // Misc (UI_OVERHAUL §37): a free-form text annotation. No pins, no body box
  // on the canvas; width tracks the text so selection/marquee match it.
  "misc.text": {
    width: (attrs) => {
      const text = typeof attrs.text === "string" ? attrs.text : "";
      return Math.max(4, Math.round(text.length * 0.6) + 2);
    },
    height: () => 2,
    pins: () => [],
    caption: () => "",
  },
};

const FALLBACK = boxSpec(4, 3, [], "?");

export function compSpec(type: string): CompSpec {
  return REGISTRY[type] ?? FALLBACK;
}

/**
 * Plain, full human name per component type (UI_OVERHAUL §57) — the Inspector
 * header reads "Multiplexer", not `plexers.mux`.
 */
const TYPE_NAMES: Readonly<Record<string, string>> = {
  "gate.and": "AND Gate",
  "gate.or": "OR Gate",
  "gate.xor": "XOR Gate",
  "gate.nand": "NAND Gate",
  "gate.nor": "NOR Gate",
  "gate.xnor": "XNOR Gate",
  "gate.not": "NOT Gate",
  "gate.buffer": "Buffer",
  "wiring.controlled-buffer": "Tri-state Buffer",
  "wiring.pin": "Pin",
  "wiring.constant": "Constant",
  "wiring.clock": "Clock",
  "wiring.reset": "Reset",
  "wiring.probe": "Probe",
  "wiring.power": "Power",
  "wiring.ground": "Ground",
  "wiring.transistor": "Transistor",
  "wiring.splitter": "Splitter",
  "plexers.mux": "Multiplexer",
  "plexers.demux": "Demultiplexer",
  "plexers.decoder": "Decoder",
  "plexers.priority-decoder": "Priority Decoder",
  "arith.adder": "Adder",
  "arith.subtractor": "Subtractor",
  "arith.multiplier": "Multiplier",
  "arith.divider": "Divider",
  "arith.comparator": "Comparator",
  "arith.negator": "Negator",
  "arith.shifter": "Shifter",
  "arith.bit-extender": "Bit Extender",
  "mem.register": "Register",
  "mem.ram": "RAM",
  "mem.rom": "ROM",
  "io.button": "Button",
  "io.led": "LED",
  "io.hexdisplay": "Hex Display",
  subcircuit: "Subcircuit",
  "misc.text": "Text",
  "debug.breakpoint": "Breakpoint",
};

/** Full human name for a component type (falls back to the raw type string). */
export function typeDisplayName(type: string): string {
  return TYPE_NAMES[type] ?? type;
}

/** Palette entries grouped for the UI, in registry order. */
/** A palette tile: the type it places plus an optional placement seed. */
export interface PaletteItem {
  /** Component type this tile places. */
  type: string;
  /** Tile label override (defaults to the spec's label/caption). */
  label?: string;
  /** Attrs seeded on placement, merged over `defaultAttrs` + Editing prefs. */
  attrs?: Record<string, unknown>;
  /** Seed rotation (defaults east); an output pin seeds west. */
  rot?: CsxComponent["rot"];
  /** Seed a `wiring.pin`'s name (`CLK`/`RST`: the clock and reset the editor wires a
   * placed part to — `editor/clockDefaults.ts`). */
  name?: string;
}

export const PALETTE: { group: string; items: PaletteItem[] }[] = [
  {
    group: "Gates",
    items: [
      { type: "gate.and" },
      { type: "gate.or" },
      { type: "gate.xor" },
      { type: "gate.not" },
      // BUFFER is the tri-state buffer (an `en` pin) — the plain `gate.buffer`
      // still loads in old files but is no longer offered (UI_OVERHAUL §43).
      { type: "wiring.controlled-buffer", label: "BUFFER" },
      { type: "gate.nand" },
      { type: "gate.nor" },
      { type: "gate.xnor" },
    ],
  },
  {
    group: "Wiring",
    // Input and output are SEPARATE tiles (UI_OVERHAUL §36): the direction is
    // chosen by which pin you place, never by an Inspector toggle. An output
    // pin seeds `isOutput` and faces west (body points right).
    items: [
      { type: "wiring.pin", label: "INPUT" },
      { type: "wiring.pin", label: "OUTPUT", attrs: { isOutput: true }, rot: "W" },
      // The design's clock and reset are **sources**, not pins: `wiring.clock` drives the
      // square wave, `wiring.reset` is the square reset button — the one clearly deliberate
      // button on a sheet. A placed part wires itself to whichever is in its circuit, and
      // to a `wiring.pin` named `CLK`/`RST` only where a subcircuit boundary needs a port
      // (a net cannot cross one). There is deliberately no "CLK PIN"/"RST PIN" tile: the
      // CLK/RST *names* are a convenience the editor uses when it looks for a source (any
      // capitalisation accepted), never a joining rule (format-v2 §9) — and the engine
      // binds nothing by name, so an old file's `CLK`/`RST` pins keep working unchanged.
      { type: "wiring.clock" },
      { type: "wiring.reset" },
      { type: "wiring.constant" },
      { type: "wiring.splitter" },
      { type: "wiring.probe" },
      { type: "wiring.power" },
      { type: "wiring.ground" },
      { type: "wiring.transistor" },
    ],
  },
  {
    group: "Plexers",
    items: [
      { type: "plexers.mux" },
      { type: "plexers.demux" },
      { type: "plexers.decoder" },
      { type: "plexers.priority-decoder" },
    ],
  },
  {
    group: "Arithmetic",
    items: [
      { type: "arith.adder" },
      { type: "arith.subtractor" },
      { type: "arith.multiplier" },
      { type: "arith.divider" },
      { type: "arith.comparator" },
      { type: "arith.negator" },
      { type: "arith.shifter" },
      { type: "arith.bit-extender" },
    ],
  },
  {
    group: "Memory",
    items: [{ type: "mem.register" }, { type: "mem.ram" }, { type: "mem.rom" }],
  },
  {
    group: "I/O",
    items: [{ type: "io.button" }, { type: "io.led" }, { type: "io.hexdisplay" }],
  },
  {
    group: "Misc",
    items: [{ type: "misc.text", label: "TEXT" }],
  },
  {
    // Its own section, like CircuitSim CE's "Debugging": a breakpoint is not a
    // building block, it is a way to stop the run and look (UI_OVERHAUL §90).
    group: "Debugging",
    items: [{ type: "debug.breakpoint" }],
  },
];

export function isKnownType(type: string): boolean {
  return type in REGISTRY;
}

// ---- property editing (double-click dialog, FRONTEND.md U3 UX) ----

export type AttrField =
  | {
      key: string;
      label: string;
      kind: "number";
      min: number;
      max: number;
      placeholder?: string;
      group?: string;
      hint?: string;
    }
  | {
      /** A drag bar (UI_OVERHAUL §50), e.g. the LED's brightness. */
      key: string;
      label: string;
      kind: "slider";
      min: number;
      max: number;
      /** Shown when the attr is absent. */
      dflt: number;
      group?: string;
      hint?: string;
    }
  | {
      key: string;
      label: string;
      kind: "text";
      placeholder?: string;
      group?: string;
      hint?: string;
    }
  /** A value typed/read in the component's selected radix (constant, §55). */
  | {
      key: string;
      label: string;
      kind: "radix-value";
      placeholder?: string;
      group?: string;
      hint?: string;
    }
  /** A segmented base chooser (constant `radix`, §55). */
  | {
      key: string;
      label: string;
      kind: "radix";
      options: { value: string; label: string }[];
      group?: string;
      hint?: string;
    }
  | {
      key: string;
      label: string;
      kind: "boolean";
      /** The value the *engine* applies when the attribute is absent (format-v2 §4),
       * so the checkbox shows the effective default rather than a misleading unchecked. */
      dflt?: boolean;
      group?: string;
      hint?: string;
    }
  | { key: string; label: string; kind: "color"; group?: string; hint?: string }
  | {
      key: string;
      label: string;
      kind: "select";
      options: { value: string; label: string }[];
      group?: string;
      hint?: string;
    }
  /** Integer picker grid (bit widths 1..32, gate inputs 2..32). */
  | {
      key: string;
      label: string;
      kind: "picker";
      /** Effective default when the attr is absent (format-v2 §4). */
      dflt?: number;
      /**
       * Effective value when the attr is absent, computed from the component's
       * attrs (the memory address width follows `depth` unless `addrBits` is
       * set). Wins over `dflt`.
       */
      derive?: (attrs: Readonly<Record<string, unknown>>) => number;
      /**
       * The whole attr patch a pick writes, when one pick means more than one
       * attr (a memory's word count follows its address width). Defaults to
       * `{ [key]: value }`.
       */
      attrsFor?: (
        value: number,
        attrs: Readonly<Record<string, unknown>>,
      ) => Record<string, unknown>;
      /** Inclusive range offered (defaults 1..32). */
      min?: number;
      max?: number;
      group?: string;
      hint?: string;
    }
  /** `pin: bit,bit` line map (wiring.splitter `splits`). */
  | {
      key: string;
      label: string;
      kind: "splits";
      placeholder?: string;
      group?: string;
      hint?: string;
    };

const BITSIZE_FIELD: AttrField = {
  key: "bitsize",
  label: "Bit size",
  kind: "picker",
  group: "Width",
};

/** Same field, but a hex display defaults to 4 bits (format-v2 §4). */
const HEX_BITSIZE_FIELD: AttrField = {
  key: "bitsize",
  label: "Bit size",
  kind: "picker",
  dflt: 4,
  group: "Width",
};

/** The base chooser shared by every readout: constants, pins, probes,
 * registers, memory and I/O (UI_OVERHAUL §56/§57). */
const RADIX_FIELD: AttrField = {
  key: "radix",
  label: "Show as",
  kind: "radix",
  group: "Options",
  options: [
    { value: "hex", label: "Hex" },
    { value: "bin", label: "Bin" },
    { value: "dec", label: "Dec" },
  ],
};

/**
 * Every attribute the panel offers for a type, grouped for the Inspector
 * (§18): Width / Options. Names and defaults mirror the engine's
 * `components.rs` so what the panel writes is exactly what loads. Timing is
 * unit-wide: the format has no per-instance `delay` override (dropped in v3)
 * and the panel offers none (§26).
 */
/** The two width picks a memory part shows, in one place for RAM and ROM. */
const MEMORY_WIDTH_FIELDS: AttrField[] = [
  {
    key: "addrBits",
    label: "Address Bits",
    kind: "picker",
    derive: memAddrBits,
    attrsFor: memoryWidthPatch,
    group: "Width",
    hint: "Sets the size too: 2^bits words.",
  },
  { ...BITSIZE_FIELD, label: "Data Bits" },
];

export function editableAttrs(type: string): AttrField[] {
  return baseFields(type);
}

/** A type's own fields (the panel offers no `delay` override, §26). */
function baseFields(type: string): AttrField[] {
  if (type.startsWith("gate.")) {
    const fields: AttrField[] = [BITSIZE_FIELD];
    if (type !== "gate.not" && type !== "gate.buffer") {
      fields.push({
        key: "inputs",
        label: "Inputs",
        kind: "picker",
        dflt: 2,
        min: 2,
        max: 32,
        group: "Width",
      });
      // Gate inputs are not plain any more: `negate` lists the inputs that carry an
      // inversion bubble (format-v2 §4), restored after §24 removed it — a dropped
      // bubble is different logic, and every pipelined course design uses them.
    }
    return fields;
  }
  if (type.startsWith("arith.")) {
    switch (type) {
      case "arith.comparator":
        return [
          BITSIZE_FIELD,
          // `Comparison Type` in the old format, and 2's complement is CE's default —
          // dropping it compares unsigned, which flips branch conditions
          // (format-v2 §4).
          {
            key: "signed",
            label: "Signed (2's complement)",
            kind: "boolean",
            dflt: true,
            group: "Options",
            hint: "Off compares unsigned, as CE's “Unsigned” comparison type.",
          },
        ];
      case "arith.shifter":
        return [
          BITSIZE_FIELD,
          {
            key: "shift",
            label: "Shift",
            kind: "select",
            group: "Options",
            options: [
              { value: "ll", label: "Logical left" },
              { value: "lr", label: "Logical right" },
              { value: "ar", label: "Arithmetic right" },
              { value: "rl", label: "Rotate left" },
              { value: "rr", label: "Rotate right" },
            ],
          },
        ];
      case "arith.bit-extender":
        return [
          { key: "inBits", label: "In bits", kind: "picker", dflt: 8, group: "Width" },
          {
            key: "outBits",
            label: "Out bits",
            kind: "picker",
            dflt: 16,
            group: "Width",
          },
          {
            key: "mode",
            label: "Extend mode",
            kind: "select",
            group: "Options",
            options: [
              { value: "zero", label: "Zero extend" },
              { value: "sign", label: "Sign extend" },
            ],
          },
        ];
      default:
        return [BITSIZE_FIELD];
    }
  }
  switch (type) {
    case "wiring.pin":
      // Direction (input/output) is chosen by the palette tile, not here
      // (UI_OVERHAUL §36) — so the panel only edits width + radix.
      return [BITSIZE_FIELD, RADIX_FIELD];
    case "wiring.constant":
      // The value is edited in whichever radix is selected, so you never have
      // to think in hex unless you pick hex (UI_OVERHAUL §55); double-click
      // jumps straight into the value input.
      return [
        BITSIZE_FIELD,
        { key: "value", label: "Value", kind: "radix-value", placeholder: "0", group: "Options" },
        {
          key: "radix",
          label: "Show as",
          kind: "radix",
          group: "Options",
          options: [
            { value: "hex", label: "Hex" },
            { value: "bin", label: "Bin" },
            { value: "dec", label: "Dec" },
          ],
        },
      ];
    case "wiring.clock":
      return [];
    case "wiring.controlled-buffer":
      return [BITSIZE_FIELD];
    case "misc.text":
      // The annotation body IS this text (UI_OVERHAUL §37/§40).
      return [
        { key: "text", label: "Text", kind: "text", placeholder: "note…", group: "Options" },
        { key: "color", label: "Color", kind: "color", group: "Options" },
        {
          key: "font",
          label: "Font",
          kind: "select",
          group: "Options",
          options: [
            { value: "sans", label: "Sans" },
            { value: "serif", label: "Serif" },
            { value: "mono", label: "Mono" },
          ],
        },
      ];
    case "wiring.splitter":
      return [
        {
          key: "splits",
          label: "Splits",
          kind: "splits",
          placeholder: "b0: 0",
          group: "Options",
        },
      ];
    case "wiring.probe":
      return [BITSIZE_FIELD, RADIX_FIELD];
    case "debug.breakpoint":
      // The same two knobs as a constant's readout — how wide the watched value
      // is, and how it reads — plus the value itself, edited in whichever radix
      // is selected, so you never have to think in hex unless you pick hex
      // (UI_OVERHAUL §55/§90).
      return [
        BITSIZE_FIELD,
        {
          key: "value",
          label: "Stop when",
          kind: "radix-value",
          placeholder: "0",
          group: "Options",
        },
        RADIX_FIELD,
      ];
    case "plexers.mux":
    case "plexers.demux":
      return [
        BITSIZE_FIELD,
        {
          key: "selectBits",
          label: "Select bits",
          kind: "number",
          min: 1,
          max: 8,
          placeholder: "1",
          group: "Width",
        },
      ];
    case "plexers.decoder":
      return [
        {
          key: "inputBits",
          label: "Input bits",
          kind: "number",
          min: 1,
          max: 8,
          placeholder: "2",
          group: "Width",
        },
      ];
    case "plexers.priority-decoder":
      return [
        {
          key: "inputBits",
          label: "Input lines",
          kind: "number",
          min: 2,
          max: 8,
          placeholder: "4",
          group: "Width",
        },
      ];
    case "mem.register":
      // The register shows its stored value on the body, in the chosen base —
      // and its clock/reset pins are opt-in (§93): the pins always exist (an
      // old-format file wires them), so showing one is a view choice, and an
      // unwired one reads its default (rst 0, clk the circuit clock).
      return [BITSIZE_FIELD, RADIX_FIELD];
    case "mem.ram":
      // `autoload` and `contents` are edited by the Inspector's Memory
      // section (file picker + hex-table dialog), not as plain fields.
      // Both widths are one-click picks, the way bit widths are everywhere
      // else (§28): a memory reads as Address Bits + Data Bits, never as a
      // dropdown. There is no separate word-count field: a memory's size IS its
      // address space, so the address pick is what resizes it.
      return [...MEMORY_WIDTH_FIELDS];
    case "mem.rom":
      // A ROM has no clock or reset: it reads as soon as an address arrives,
      // so it carries the width fields only (UI_OVERHAUL §93).
      return [...MEMORY_WIDTH_FIELDS];
    case "subcircuit":
      // Its box (UI_OVERHAUL §79): the same one-click width pickers everything
      // else uses. Leaving them alone means "derive from the pins", which is what
      // every pre-§79 file does; choosing one makes the size explicit.
      return [
        { key: "circuit", label: "Circuit", kind: "select", group: "Options", options: [] },
        { key: "width", label: "Width", kind: "picker", min: SUB_W, max: SUB_MAX, group: "Width" },
        {
          key: "height",
          label: "Height",
          kind: "picker",
          min: SUB_MIN_H,
          max: SUB_MAX,
          group: "Width",
        },
      ];
    case "io.hexdisplay":
      return [HEX_BITSIZE_FIELD];
    case "io.button":
      return [BITSIZE_FIELD];
    case "io.led":
      // LED look + glow (UI_OVERHAUL §49). The LED is a 1-bit indicator — it
      // has no bit-size field (UI_OVERHAUL §55).
      return [
        { key: "color", label: "Color", kind: "color", group: "Options" },
        {
          key: "intensity",
          label: "Brightness",
          kind: "slider",
          min: 0,
          max: 100,
          dflt: 80,
          group: "Options",
        },
      ];
    default:
      return [];
  }
}

/**
 * Shaped bodies that still say WHICH part they are (UI_OVERHAUL §17 rule 3).
 *
 * A trapezoid is ambiguous, so a plexer's shape carries its abbreviation on the body;
 * a NAND's outline is unmistakable, so gates stay shape-only. Power and ground are in
 * for the same reason as a plexer: a rake and a bar do not name a supply.
 *
 * ONE predicate, because the canvas body pass and the palette icon must agree — they
 * had drifted, and the palette drew bare trapezoids for a while (UI_OVERHAUL §83).
 */
export function showsBodyCaption(type: string): boolean {
  return (
    type === "plexers.mux" ||
    type === "plexers.demux" ||
    type === "wiring.power" ||
    type === "wiring.ground"
  );
}

export function compSize(
  comp: Pick<CsxComponent, "type" | "attrs">,
  circuits?: readonly CsxCircuit[],
): { w: number; h: number } {
  if (comp.type === "subcircuit" && circuits !== undefined) {
    return subcircuitSize(comp.attrs ?? {}, circuits);
  }
  const spec = compSpec(comp.type);
  const attrs = comp.attrs ?? {};
  return { w: spec.width(attrs), h: spec.height(attrs) };
}

/**
 * Whether one of a part's pins is DRAWN and connectable (UI_OVERHAUL §93). The
 * clock and reset pins of a memory part are always in the model — a converted
 * old-format schematic wires them, and every endpoint must resolve — but they
 * are hidden unless the part says otherwise, so a new schematic is not covered
 * in clock/reset stubs. `showClk` / `showRst`, absent meaning hidden; every
 * other pin of every other part is always shown.
 */
/**
 * Whether a pin is drawn. Always true: `clk` and `rst` are in the model whether or not they
 * are wired (format-v2 §4), so the editor draws them, and the old per-part **Show clock
 * pin** / **Show reset pin** toggles are gone — the UI now wires a placed part's clock and
 * reset for you (`editor/clockDefaults.ts`), which is a better answer than hiding the pin.
 *
 * `showClk`/`showRst` remain *legal* attributes: an old file that carries them still loads,
 * and they are ignored rather than rejected.
 */
// The parameters stay in the signature because every call site passes them; the answer no
// longer depends on either.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function pinShown(_comp: Pick<CsxComponent, "type" | "attrs">, _pin: string): boolean {
  return true;
}

export function compPins(
  comp: Pick<CsxComponent, "type" | "attrs">,
  circuits?: readonly CsxCircuit[],
): PinSpec[] {
  if (comp.type === "subcircuit") {
    return subcircuitPins(comp.attrs ?? {}, circuits ?? []);
  }
  return compSpec(comp.type).pins(comp.attrs ?? {});
}
