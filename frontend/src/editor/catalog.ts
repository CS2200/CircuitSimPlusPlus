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

/**
 * Pin width from attrs.bitsize (1..32, default 1 — format-v2's default).
 * This is what makes the properties dialog's "Bit size" field real:
 * thickness ∝ bitsize and sim values both read pin widths from here.
 */
export function bitsOf(attrs: Readonly<Record<string, unknown>>, dflt = 1): number {
  const v = attrs["bitsize"];
  if (typeof v !== "number" || !Number.isInteger(v)) return dflt;
  return Math.max(1, Math.min(32, v));
}

/** Standard n-input gate: inputs on the left, out on the right. */
function gateSpec(caption: string, minInputs: number): CompSpec {
  return {
    width: () => 5,
    height: (attrs) => Math.max(3, numAttr(attrs, "inputs", 2) + 1),
    pins: (attrs) => {
      const n = Math.max(minInputs, numAttr(attrs, "inputs", 2));
      const h = Math.max(3, n + 1);
      const width = bitsOf(attrs); // bitwise multi-bit gates (DLS-style)
      const pins: PinSpec[] = [];
      for (let i = 0; i < n; i++) {
        pins.push({
          name: `in${i}`,
          dx: 0,
          dy: ((i + 1) * h) / (n + 1),
          kind: "in",
          bitsize: width,
        });
      }
      pins.push({ name: "out", dx: 5, dy: h / 2, kind: "out", bitsize: width });
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
function boxSpec(w: number, h: number, pins: PinSpec[], caption: string): CompSpec {
  return {
    width: () => w,
    height: () => h,
    pins: (attrs) =>
      pins.map((p) => (p.bitsize === BUS_WIDTH ? { ...p, bitsize: bitsOf(attrs) } : p)),
    caption: () => caption,
  };
}

/** mux/demux/decoder with attrs.selBits-driven pin sets (n = 2^selBits data lines). */
function plexerSpec(caption: string, flavor: "in" | "out" | "out-no-in"): CompSpec {
  const n = (attrs: Readonly<Record<string, unknown>>) => 2 ** numAttr(attrs, "selBits", 1);
  const h = (attrs: Readonly<Record<string, unknown>>) => Math.max(4, n(attrs) + 1);
  return {
    width: () => 4,
    height: h,
    pins: (attrs) => {
      const count = n(attrs);
      const height = h(attrs);
      const width = bitsOf(attrs);
      const pins: PinSpec[] = [];
      if (flavor === "in") {
        for (let i = 0; i < count; i++) {
          pins.push({
            name: `in${i}`,
            dx: 0,
            dy: ((i + 1) * height) / (count + 1),
            kind: "in",
            bitsize: width,
          });
        }
        pins.push({ name: "out", dx: 4, dy: height / 2, kind: "out", bitsize: width });
      } else {
        if (flavor === "out") {
          pins.push({ name: "in", dx: 0, dy: height / 2, kind: "in", bitsize: width });
        }
        for (let i = 0; i < count; i++) {
          pins.push({
            name: `out${i}`,
            dx: 4,
            dy: ((i + 1) * height) / (count + 1),
            kind: "out",
            bitsize: flavor === "out" ? width : 1,
          });
        }
      }
      pins.push({ name: "sel", dx: 2, dy: height, kind: "in" });
      return pins;
    },
    caption: () => caption,
  };
}

const BUS_WIDTH = 32; // sentinel: attr-driven bus pin (boxSpec resolves via bitsOf)

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

  // Wiring
  "wiring.pin": boxSpec(
    2,
    1,
    [{ name: "port", dx: 2, dy: 0.5, kind: "inout", bitsize: BUS_WIDTH }],
    "PIN",
  ),
  "wiring.constant": boxSpec(
    2,
    1,
    [{ name: "out", dx: 2, dy: 0.5, kind: "out", bitsize: BUS_WIDTH }],
    "CONST",
  ),
  "wiring.clock": boxSpec(2, 2, [{ name: "out", dx: 2, dy: 1, kind: "out" }], "CLK"),
  "wiring.probe": boxSpec(
    2,
    1,
    [{ name: "in", dx: 0, dy: 0.5, kind: "in", bitsize: BUS_WIDTH }],
    "PROBE",
  ),
  "wiring.splitter": boxSpec(
    2,
    5,
    [
      { name: "bus", dx: 0, dy: 2.5, kind: "inout", bitsize: BUS_WIDTH },
      { name: "b0", dx: 2, dy: 0.5, kind: "inout" },
      { name: "b1", dx: 2, dy: 1.5, kind: "inout" },
      { name: "b2", dx: 2, dy: 2.5, kind: "inout" },
      { name: "b3", dx: 2, dy: 3.5, kind: "inout" },
    ],
    "SPLIT",
  ),

  // Plexers (pin sets scale with attrs.selBits: n = 2^selBits data lines)
  "plexers.mux": plexerSpec("MUX", "in"),
  "plexers.demux": plexerSpec("DEMUX", "out"),
  "plexers.decoder": plexerSpec("DEC", "out-no-in"),

  // Arithmetic
  "arith.adder": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "c_in", dx: 3, dy: 0, kind: "in" },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
      { name: "c_out", dx: 3, dy: 4, kind: "out" },
    ],
    "ADD",
  ),
  "arith.subtractor": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
    ],
    "SUB",
  ),
  "arith.multiplier": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
    ],
    "MUL",
  ),
  "arith.divider": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
    ],
    "DIV",
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
    "CMP",
  ),
  "arith.negator": boxSpec(
    4,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 4, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "NEG",
  ),
  "arith.shifter": boxSpec(
    6,
    3,
    [
      { name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BUS_WIDTH },
      { name: "amt", dx: 3, dy: 3, kind: "in" },
      { name: "out", dx: 6, dy: 1.5, kind: "out", bitsize: BUS_WIDTH },
    ],
    "SHIFT",
  ),
  "arith.bit-extender": boxSpec(
    4,
    2,
    [
      { name: "in", dx: 0, dy: 1, kind: "in" },
      { name: "out", dx: 4, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "EXT",
  ),

  // Memory
  "mem.register": boxSpec(
    6,
    4,
    [
      { name: "d", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "clk", dx: 0, dy: 2, kind: "in" },
      { name: "en", dx: 0, dy: 3, kind: "in" },
      { name: "q", dx: 6, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "REG",
  ),
  "mem.ram": boxSpec(
    10,
    6,
    [
      { name: "addr", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "d", dx: 0, dy: 2, kind: "in", bitsize: BUS_WIDTH },
      { name: "clk", dx: 0, dy: 3, kind: "in" },
      { name: "we", dx: 0, dy: 4, kind: "in" },
      { name: "q", dx: 10, dy: 1, kind: "out", bitsize: BUS_WIDTH },
    ],
    "RAM",
  ),
  "mem.rom": boxSpec(
    10,
    6,
    [
      { name: "addr", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "clk", dx: 0, dy: 2, kind: "in" },
      { name: "q", dx: 10, dy: 1, kind: "out", bitsize: BUS_WIDTH },
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
    [{ name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BUS_WIDTH }],
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

// ---- property editing (double-click dialog, FRONTEND.md U3 UX) ----

export type AttrField =
  | { key: string; label: string; kind: "number"; min: number; max: number }
  | { key: string; label: string; kind: "text" }
  | { key: string; label: string; kind: "select"; options: { value: string; label: string }[] };

const BITSIZE_FIELD: AttrField = {
  key: "bitsize",
  label: "Bit size",
  kind: "number",
  min: 1,
  max: 32,
};

/** Attr fields the properties dialog shows per type (attrs.* in the .csx schema). */
export function editableAttrs(type: string): AttrField[] {
  if (type.startsWith("gate.")) {
    const fields = [BITSIZE_FIELD];
    if (type !== "gate.not" && type !== "gate.buffer") {
      fields.push({ key: "inputs", label: "Inputs", kind: "number", min: 2, max: 8 });
    }
    return fields;
  }
  if (type.startsWith("arith.")) return [BITSIZE_FIELD];
  switch (type) {
    case "wiring.pin":
      return [BITSIZE_FIELD];
    case "wiring.constant":
      return [
        BITSIZE_FIELD,
        { key: "value", label: "Value", kind: "number", min: 0, max: 4294967295 },
      ];
    case "wiring.probe":
      return [
        BITSIZE_FIELD,
        {
          key: "display",
          label: "Display",
          kind: "select",
          options: [
            { value: "unsigned", label: "Unsigned" },
            { value: "signed", label: "Signed" },
            { value: "hex", label: "Hex" },
          ],
        },
      ];
    case "wiring.splitter":
      return [BITSIZE_FIELD];
    case "plexers.mux":
    case "plexers.demux":
    case "plexers.decoder":
      return [
        BITSIZE_FIELD,
        { key: "selBits", label: "Select bits", kind: "number", min: 1, max: 4 },
      ];
    case "mem.register":
      return [BITSIZE_FIELD];
    case "mem.ram":
    case "mem.rom":
      return [
        BITSIZE_FIELD,
        { key: "depth", label: "Depth (words)", kind: "number", min: 1, max: 65536 },
        { key: "autoload", label: "Autoload file", kind: "text" },
      ];
    case "subcircuit":
      return [{ key: "circuit", label: "Circuit", kind: "text" }];
    case "io.led":
    case "io.hexdisplay":
      return [BITSIZE_FIELD];
    default:
      return [];
  }
}

/** Gate types the dialog's type swapper offers (same pin names, De Morgan family). */
export const GATE_TYPE_OPTIONS = [
  "gate.and",
  "gate.or",
  "gate.xor",
  "gate.nand",
  "gate.nor",
  "gate.xnor",
  "gate.not",
  "gate.buffer",
] as const;

export function compSize(comp: Pick<CsxComponent, "type" | "attrs">): { w: number; h: number } {
  const spec = compSpec(comp.type);
  const attrs = comp.attrs ?? {};
  return { w: spec.width(attrs), h: spec.height(attrs) };
}

export function compPins(comp: Pick<CsxComponent, "type" | "attrs">): PinSpec[] {
  return compSpec(comp.type).pins(comp.attrs ?? {});
}
