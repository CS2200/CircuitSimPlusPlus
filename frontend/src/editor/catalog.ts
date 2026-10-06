import type { CsxComponent } from "../model/csx";

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
}

export interface CompSpec {
  width(attrs: Readonly<Record<string, unknown>>): number;
  height(attrs: Readonly<Record<string, unknown>>): number;
  pins(attrs: Readonly<Record<string, unknown>>): PinSpec[];
  /** Short caption drawn on the body. */
  caption(attrs: Readonly<Record<string, unknown>>): string;
}

function numAttr(attrs: Readonly<Record<string, unknown>>, key: string, fallback: number): number {
  const v = attrs[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Standard n-input gate: inputs on the left, out on the right. */
function gateSpec(caption: string, minInputs: number): CompSpec {
  return {
    width: () => 5,
    height: (attrs) => Math.max(3, numAttr(attrs, "inputs", 2) + 1),
    pins: (attrs) => {
      const n = Math.max(minInputs, numAttr(attrs, "inputs", 2));
      const h = Math.max(3, n + 1);
      const pins: PinSpec[] = [];
      for (let i = 0; i < n; i++) {
        pins.push({ name: `in${i}`, dx: 0, dy: ((i + 1) * h) / (n + 1), kind: "in" });
      }
      pins.push({ name: "out", dx: 5, dy: h / 2, kind: "out" });
      return pins;
    },
    caption: () => caption,
  };
}

function boxSpec(w: number, h: number, pins: PinSpec[], caption: string): CompSpec {
  return {
    width: () => w,
    height: () => h,
    pins: () => pins,
    caption: () => caption,
  };
}

const BITS = 32; // course default bus width

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
      { name: "in", dx: 0, dy: 1, kind: "in" },
      { name: "out", dx: 3, dy: 1, kind: "out" },
    ],
    "NOT",
  ),
  "gate.buffer": boxSpec(
    3,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in" },
      { name: "out", dx: 3, dy: 1, kind: "out" },
    ],
    "BUF",
  ),

  // Wiring
  "wiring.pin": boxSpec(
    2,
    1,
    [{ name: "port", dx: 2, dy: 0.5, kind: "inout", bitsize: BITS }],
    "PIN",
  ),
  "wiring.constant": boxSpec(
    2,
    1,
    [{ name: "out", dx: 2, dy: 0.5, kind: "out", bitsize: BITS }],
    "CONST",
  ),
  "wiring.clock": boxSpec(2, 2, [{ name: "out", dx: 2, dy: 1, kind: "out" }], "CLK"),
  "wiring.probe": boxSpec(
    2,
    1,
    [{ name: "in", dx: 0, dy: 0.5, kind: "in", bitsize: BITS }],
    "PROBE",
  ),
  "wiring.splitter": boxSpec(
    2,
    5,
    [
      { name: "bus", dx: 0, dy: 2.5, kind: "inout", bitsize: BITS },
      { name: "b0", dx: 2, dy: 0.5, kind: "inout" },
      { name: "b1", dx: 2, dy: 1.5, kind: "inout" },
      { name: "b2", dx: 2, dy: 2.5, kind: "inout" },
      { name: "b3", dx: 2, dy: 3.5, kind: "inout" },
    ],
    "SPLIT",
  ),

  // Plexers
  "plexers.mux": boxSpec(
    4,
    4,
    [
      { name: "in0", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "in1", dx: 0, dy: 3, kind: "in", bitsize: BITS },
      { name: "sel", dx: 2, dy: 4, kind: "in" },
      { name: "out", dx: 4, dy: 2, kind: "out", bitsize: BITS },
    ],
    "MUX",
  ),
  "plexers.demux": boxSpec(
    4,
    4,
    [
      { name: "in", dx: 0, dy: 2, kind: "in", bitsize: BITS },
      { name: "sel", dx: 2, dy: 4, kind: "in" },
      { name: "out0", dx: 4, dy: 1, kind: "out", bitsize: BITS },
      { name: "out1", dx: 4, dy: 3, kind: "out", bitsize: BITS },
    ],
    "DEMUX",
  ),
  "plexers.decoder": boxSpec(
    4,
    4,
    [
      { name: "sel", dx: 0, dy: 2, kind: "in" },
      { name: "out0", dx: 4, dy: 1, kind: "out" },
      { name: "out1", dx: 4, dy: 3, kind: "out" },
    ],
    "DEC",
  ),

  // Arithmetic
  "arith.adder": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BITS },
      { name: "c_in", dx: 3, dy: 0, kind: "in" },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BITS },
      { name: "c_out", dx: 3, dy: 4, kind: "out" },
    ],
    "ADD",
  ),
  "arith.subtractor": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BITS },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BITS },
    ],
    "SUB",
  ),
  "arith.multiplier": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BITS },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BITS },
    ],
    "MUL",
  ),
  "arith.divider": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BITS },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BITS },
    ],
    "DIV",
  ),
  "arith.comparator": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BITS },
      { name: "lt", dx: 6, dy: 1, kind: "out" },
      { name: "eq", dx: 6, dy: 2, kind: "out" },
      { name: "gt", dx: 6, dy: 3, kind: "out" },
    ],
    "CMP",
  ),
  "arith.negator": boxSpec(
    4,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "out", dx: 4, dy: 1, kind: "out", bitsize: BITS },
    ],
    "NEG",
  ),
  "arith.shifter": boxSpec(
    6,
    3,
    [
      { name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BITS },
      { name: "amt", dx: 3, dy: 3, kind: "in" },
      { name: "out", dx: 6, dy: 1.5, kind: "out", bitsize: BITS },
    ],
    "SHIFT",
  ),
  "arith.bit-extender": boxSpec(
    4,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in" },
      { name: "out", dx: 4, dy: 1, kind: "out", bitsize: BITS },
    ],
    "EXT",
  ),

  // Memory
  "mem.register": boxSpec(
    6,
    4,
    [
      { name: "d", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "clk", dx: 0, dy: 2, kind: "in" },
      { name: "en", dx: 0, dy: 3, kind: "in" },
      { name: "q", dx: 6, dy: 1, kind: "out", bitsize: BITS },
    ],
    "REG",
  ),
  "mem.ram": boxSpec(
    10,
    6,
    [
      { name: "addr", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "d", dx: 0, dy: 2, kind: "in", bitsize: BITS },
      { name: "clk", dx: 0, dy: 3, kind: "in" },
      { name: "we", dx: 0, dy: 4, kind: "in" },
      { name: "q", dx: 10, dy: 1, kind: "out", bitsize: BITS },
    ],
    "RAM",
  ),
  "mem.rom": boxSpec(
    10,
    6,
    [
      { name: "addr", dx: 0, dy: 1, kind: "in", bitsize: BITS },
      { name: "clk", dx: 0, dy: 2, kind: "in" },
      { name: "q", dx: 10, dy: 1, kind: "out", bitsize: BITS },
    ],
    "ROM",
  ),

  // Hierarchy (pins come from the referenced circuit's pin components —
  // placeholder geometry until subcircuit editing lands)
  subcircuit: boxSpec(8, 6, [], "SUB"),

  // I/O (UI-only parts)
  "io.button": boxSpec(2, 2, [{ name: "out", dx: 2, dy: 1, kind: "out" }], "BTN"),
  "io.led": boxSpec(1, 1, [{ name: "in", dx: 0, dy: 0.5, kind: "in" }], "LED"),
  "io.hexdisplay": boxSpec(
    3,
    3,
    [{ name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BITS }],
    "HEX",
  ),
};

const FALLBACK = boxSpec(4, 3, [], "?");

export function compSpec(type: string): CompSpec {
  return REGISTRY[type] ?? FALLBACK;
}

/** Palette entries grouped for the UI, in registry order. */
export const PALETTE: { group: string; types: string[] }[] = [
  {
    group: "Gates",
    types: [
      "gate.and",
      "gate.or",
      "gate.xor",
      "gate.not",
      "gate.buffer",
      "gate.nand",
      "gate.nor",
      "gate.xnor",
    ],
  },
  {
    group: "Wiring",
    types: ["wiring.pin", "wiring.constant", "wiring.clock", "wiring.splitter", "wiring.probe"],
  },
  { group: "Plexers", types: ["plexers.mux", "plexers.demux", "plexers.decoder"] },
  {
    group: "Arithmetic",
    types: [
      "arith.adder",
      "arith.subtractor",
      "arith.multiplier",
      "arith.divider",
      "arith.comparator",
      "arith.negator",
      "arith.shifter",
      "arith.bit-extender",
    ],
  },
  { group: "Memory", types: ["mem.register", "mem.ram", "mem.rom"] },
  { group: "I/O", types: ["io.button", "io.led", "io.hexdisplay"] },
];

export function isKnownType(type: string): boolean {
  return type in REGISTRY;
}

export function compSize(comp: Pick<CsxComponent, "type" | "attrs">): { w: number; h: number } {
  const spec = compSpec(comp.type);
  const attrs = comp.attrs ?? {};
  return { w: spec.width(attrs), h: spec.height(attrs) };
}

export function compPins(comp: Pick<CsxComponent, "type" | "attrs">): PinSpec[] {
  return compSpec(comp.type).pins(comp.attrs ?? {});
}
