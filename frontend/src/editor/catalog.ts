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
 * lines). Attr names and defaults follow format-v2 §4: `selectBits`
 * (mux/demux, default 1) and `inputBits` (decoder, default 2).
 */
function plexerSpec(
  caption: string,
  flavor: "in" | "out" | "out-no-in",
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

function subcircuitHeight(
  attrs: Readonly<Record<string, unknown>>,
  circuits: readonly CsxCircuit[],
): number {
  const target = subcircuitTarget(attrs, circuits);
  if (target === undefined) return SUB_MIN_H;
  const { inputs, outputs } = circuitInterface(target);
  return Math.max(SUB_MIN_H, 2 * Math.max(inputs.length, outputs.length));
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
  const h = subcircuitHeight(attrs, circuits);
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
      dx: SUB_W,
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
  "wiring.splitter": splitterSpec(),

  // Plexers (pin sets scale with the select width: n = 2^select data lines)
  "plexers.mux": plexerSpec("MUX", "in"),
  "plexers.demux": plexerSpec("DEMUX", "out"),
  "plexers.decoder": plexerSpec("DECODER", "out-no-in", "inputBits", 2),

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
    "+",
    { label: "ADD", markSize: 1.7 },
  ),
  "arith.subtractor": boxSpec(
    6,
    4,
    [
      { name: "a", dx: 0, dy: 1, kind: "in", bitsize: BUS_WIDTH },
      { name: "b", dx: 0, dy: 3, kind: "in", bitsize: BUS_WIDTH },
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
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
      { name: "out", dx: 6, dy: 2, kind: "out", bitsize: BUS_WIDTH },
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
  "arith.shifter": boxSpec(
    6,
    3,
    [
      { name: "in", dx: 0, dy: 1.5, kind: "in", bitsize: BUS_WIDTH },
      { name: "amt", dx: 3, dy: 3, kind: "in" },
      { name: "out", dx: 6, dy: 1.5, kind: "out", bitsize: BUS_WIDTH },
    ],
    "\u00ab",
    { label: "SHIFT", markSize: 1.7 },
  ),
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
      key: string;
      label: string;
      kind: "text";
      placeholder?: string;
      group?: string;
      hint?: string;
    }
  | { key: string; label: string; kind: "boolean"; group?: string; hint?: string }
  | {
      key: string;
      label: string;
      kind: "select";
      options: { value: string; label: string }[];
      group?: string;
      hint?: string;
    }
  /** 1..32 picker (format-v2 widths). */
  | {
      key: string;
      label: string;
      kind: "bitsize";
      /** Effective default when the attr is absent (format-v2 §4). */
      dflt?: number;
      group?: string;
      hint?: string;
    }
  /** Comma-separated string list (e.g. negateInputs). */
  | {
      key: string;
      label: string;
      kind: "list";
      placeholder?: string;
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
  kind: "bitsize",
  group: "Width",
};

/** Same field, but a hex display defaults to 4 bits (format-v2 §4). */
const HEX_BITSIZE_FIELD: AttrField = {
  key: "bitsize",
  label: "Bit size",
  kind: "bitsize",
  dflt: 4,
  group: "Width",
  hint: "A hex display decodes four bits per digit.",
};

const DELAY_FIELD: AttrField = {
  key: "delay",
  label: "Delay override",
  kind: "number",
  min: 0,
  max: 1_000_000,
  placeholder: "auto",
  group: "Timing",
  hint: "Per-instance delay in raw timing units (format-v2 §6); blank uses the delay table.",
};

const RADIX_OPTIONS = [
  { value: "unsigned", label: "Unsigned" },
  { value: "signed", label: "Signed" },
  { value: "hex", label: "Hex" },
];

/**
 * Every attribute format-v2 §4 defines for a type, grouped for the Inspector
 * (§18): Width / Options / Timing. Names and defaults mirror the engine's
 * `components.rs` so what the panel writes is exactly what loads.
 */
export function editableAttrs(type: string): AttrField[] {
  if (type.startsWith("gate.")) {
    const fields: AttrField[] = [BITSIZE_FIELD];
    if (type !== "gate.not" && type !== "gate.buffer") {
      fields.push(
        {
          key: "inputs",
          label: "Inputs",
          kind: "number",
          min: 2,
          max: 64,
          placeholder: "2",
          group: "Width",
        },
        {
          key: "negateInputs",
          label: "Negated inputs",
          kind: "list",
          placeholder: "in0, in2",
          group: "Options",
          hint: "Input pins drawn with an inverting bubble.",
        },
      );
    }
    fields.push(DELAY_FIELD);
    return fields;
  }
  if (type.startsWith("arith.")) {
    switch (type) {
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
          DELAY_FIELD,
        ];
      case "arith.bit-extender":
        return [
          { key: "inBits", label: "In bits", kind: "bitsize", dflt: 8, group: "Width" },
          {
            key: "outBits",
            label: "Out bits",
            kind: "bitsize",
            dflt: 16,
            group: "Width",
            hint: "Wider than the input width (format-v2 §4).",
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
          DELAY_FIELD,
        ];
      default:
        return [BITSIZE_FIELD, DELAY_FIELD];
    }
  }
  switch (type) {
    case "wiring.pin":
      return [
        BITSIZE_FIELD,
        {
          key: "isOutput",
          label: "Output pin",
          kind: "boolean",
          group: "Options",
          hint: "An output pin is driven by this circuit; an input pin drives its net.",
        },
        { key: "radix", label: "Radix", kind: "select", group: "Options", options: RADIX_OPTIONS },
        DELAY_FIELD,
      ];
    case "wiring.constant":
      return [
        BITSIZE_FIELD,
        {
          key: "value",
          label: "Value (hex)",
          kind: "text",
          placeholder: "0",
          group: "Options",
          hint: "Hex string; must fit the bit size.",
        },
        DELAY_FIELD,
      ];
    case "wiring.clock":
      return [DELAY_FIELD];
    case "wiring.splitter":
      return [
        {
          key: "splits",
          label: "Splits",
          kind: "splits",
          placeholder: "b0: 0",
          group: "Options",
          hint: "One `pin: bit,bit` line per pin; every bus bit is used once. Bus width = highest bit + 1.",
        },
        DELAY_FIELD,
      ];
    case "wiring.probe":
      return [
        BITSIZE_FIELD,
        { key: "radix", label: "Radix", kind: "select", group: "Options", options: RADIX_OPTIONS },
        DELAY_FIELD,
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
        DELAY_FIELD,
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
        DELAY_FIELD,
      ];
    case "mem.register":
      return [BITSIZE_FIELD, DELAY_FIELD];
    case "mem.ram":
    case "mem.rom":
      // `autoload` and `contents` are edited by the Inspector's Memory
      // section (file picker + hex-table dialog), not as plain fields.
      return [
        BITSIZE_FIELD,
        {
          key: "depth",
          label: "Depth (words)",
          kind: "number",
          min: 1,
          max: 1_048_576,
          placeholder: "256",
          group: "Width",
          hint: "Power of two, up to 2^20.",
        },
        DELAY_FIELD,
      ];
    case "subcircuit":
      return [{ key: "circuit", label: "Circuit", kind: "select", group: "Options", options: [] }];
    case "io.hexdisplay":
      return [HEX_BITSIZE_FIELD, DELAY_FIELD];
    case "io.button":
    case "io.led":
      return [BITSIZE_FIELD, DELAY_FIELD];
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

export function compSize(
  comp: Pick<CsxComponent, "type" | "attrs">,
  circuits?: readonly CsxCircuit[],
): { w: number; h: number } {
  if (comp.type === "subcircuit" && circuits !== undefined) {
    return { w: SUB_W, h: subcircuitHeight(comp.attrs ?? {}, circuits) };
  }
  const spec = compSpec(comp.type);
  const attrs = comp.attrs ?? {};
  return { w: spec.width(attrs), h: spec.height(attrs) };
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
