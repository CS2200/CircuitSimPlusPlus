import { describe, expect, it } from "vitest";
import { compLayout, nextRotation, pinPosition } from "./layout";
import { compPins, compSize, isKnownType, PALETTE } from "./catalog";
import type { CsxComponent } from "../model/csx";

const and2: CsxComponent = { id: "c1", type: "gate.and", pos: [10, 10] };

describe("catalog", () => {
  it("every PALETTE type has a spec", () => {
    for (const group of PALETTE) {
      for (const item of group.items) {
        expect(isKnownType(item.type), item.type).toBe(true);
        const size = compSize({ type: item.type });
        expect(size.w, item.type).toBeGreaterThan(0);
        expect(size.h, item.type).toBeGreaterThan(0);
      }
    }
  });

  it("gate input count scales pins", () => {
    const two = compPins({ type: "gate.and" });
    expect(two.filter((p) => p.kind === "in")).toHaveLength(2);
    const four = compPins({ type: "gate.and", attrs: { inputs: 4 } });
    expect(four.filter((p) => p.kind === "in")).toHaveLength(4);
    // Extra inputs grow the body TALLER (the pins keep their spacing) while the
    // output cap stays a 2-input gate's size (UI_OVERHAUL §44).
    expect(compSize({ type: "gate.and", attrs: { inputs: 4 } }).h).toBe(5);
    expect(compSize({ type: "gate.and", attrs: { inputs: 4 } }).w).toBe(5);
    expect(compSize({ type: "gate.and" }).w).toBe(5);
  });

  it("plexer pin sets scale with the select width (format-v2 §4 attrs)", () => {
    expect(compPins({ type: "plexers.mux" }).filter((p) => p.name.startsWith("in"))).toHaveLength(
      2,
    );
    const mux4 = compPins({ type: "plexers.mux", attrs: { selectBits: 2 } });
    expect(mux4.filter((p) => p.name.startsWith("in"))).toHaveLength(4);
    // The decoder's default is 2 input bits (4 outputs), like the engine.
    expect(
      compPins({ type: "plexers.decoder" }).filter((p) => p.name.startsWith("out")),
    ).toHaveLength(4);
    const dec8 = compPins({ type: "plexers.decoder", attrs: { inputBits: 3 } });
    expect(dec8.filter((p) => p.name.startsWith("out"))).toHaveLength(8);
  });

  /**
   * Pin names/widths must match the engine registry (format-v2 §4): the core
   * rejects a wire to a pin it does not know (`format/validate.rs`), so a
   * mismatch makes the part unwireable. These are the types that used to drift
   * (adder carry, subtractor borrow, divider quot/rem, decoder select).
   */
  it("pin names track the engine registry (format-v2 §4)", () => {
    const names = (type: string, attrs?: Record<string, unknown>) =>
      compPins({ type, ...(attrs !== undefined ? { attrs } : {}) }).map((p) => p.name);
    expect(names("arith.adder")).toEqual(["a", "b", "cin", "out", "cout"]);
    expect(names("arith.subtractor")).toEqual(["a", "b", "bin", "out", "bout"]);
    expect(names("arith.divider")).toEqual(["a", "b", "quot", "rem"]);
    expect(names("arith.shifter")).toEqual(["in", "amt", "out"]);
    expect(names("plexers.mux")).toEqual(["in0", "in1", "sel", "out"]);
    expect(names("plexers.demux")).toEqual(["in", "sel", "out0", "out1"]);
    // The decoder's select IS its data input — a bus named `in`, not a `sel`.
    expect(names("plexers.decoder")).toEqual(["in", "out0", "out1", "out2", "out3"]);
  });

  it("select / amount pins carry the engine's widths", () => {
    const width = (type: string, name: string, attrs?: Record<string, unknown>) =>
      compPins({ type, ...(attrs !== undefined ? { attrs } : {}) }).find((p) => p.name === name)
        ?.bitsize;
    expect(width("plexers.mux", "sel", { selectBits: 3 })).toBe(3);
    expect(width("plexers.demux", "sel", { selectBits: 2 })).toBe(2);
    expect(width("plexers.decoder", "in", { inputBits: 3 })).toBe(3);
    expect(width("arith.shifter", "amt", { bitsize: 32 })).toBe(5);
    expect(width("arith.shifter", "amt", { bitsize: 1 })).toBe(1);
    expect(width("arith.shifter", "in", { bitsize: 8 })).toBe(8);
  });

  it("a memory's addr pin follows its DEPTH, not its data width", () => {
    // The editor used to give `addr` the data width (default 1 bit!), so a
    // fresh RAM drew a 1-bit address while the core indexed 256 words — and a
    // correct 8-bit address was reported as a width mismatch.
    const width = (type: string, name: string, attrs: Record<string, unknown>) =>
      compPins({ type, attrs }).find((p) => p.name === name)?.bitsize;
    // 256 words → 8 address bits; the data side is untouched by depth.
    expect(width("mem.ram", "addr", { depth: 256, bitsize: 8 })).toBe(8);
    expect(width("mem.ram", "din", { depth: 256, bitsize: 8 })).toBe(8);
    expect(width("mem.ram", "dout", { depth: 256, bitsize: 8 })).toBe(8);
    expect(width("mem.rom", "addr", { depth: 256, bitsize: 8 })).toBe(8);
    expect(width("mem.rom", "out", { depth: 256, bitsize: 8 })).toBe(8);
    // The address space drives it: 16 words → 4 bits, 1 word → 1 bit.
    expect(width("mem.ram", "addr", { depth: 16, bitsize: 8 })).toBe(4);
    expect(width("mem.ram", "addr", { depth: 1, bitsize: 8 })).toBe(1);
    expect(width("mem.ram", "addr", { depth: 1024, bitsize: 8 })).toBe(10);
    // A fresh RAM (no attrs) is the 256-word default → 8 bits, 1-bit data.
    expect(width("mem.ram", "addr", {})).toBe(8);
    expect(width("mem.ram", "din", {})).toBe(1);
    // Address and data widths are independent.
    expect(width("mem.ram", "addr", { depth: 4, bitsize: 32 })).toBe(2);
    expect(width("mem.ram", "dout", { depth: 4, bitsize: 32 })).toBe(32);
  });
});

describe("compLayout", () => {
  it("places pins in world coordinates (EAST default)", () => {
    const layout = compLayout(and2);
    expect(layout.rect).toEqual({ x: 10, y: 10, w: 5, h: 3 });
    const out = layout.pins.find((p) => p.name === "out");
    expect(out).toMatchObject({ x: 15, y: 11.5, kind: "out" });
    const ins = layout.pins.filter((p) => p.kind === "in");
    expect(ins.map((p) => p.x)).toEqual([10, 10]);
  });

  it("SOUTH rotates 90° clockwise about the body center", () => {
    const s = compLayout({ ...and2, rot: "S" });
    expect(s.rect).toEqual({ x: 10, y: 10, w: 3, h: 5 }); // 90° swaps w/h
    // out pin EAST offset (+2.5, 0) → SOUTH (0, +2.5) → bottom edge
    const out = s.pins.find((p) => p.name === "out");
    expect(out).toMatchObject({ x: 11.5, y: 15 });
  });

  it("WEST mirrors to the left edge (180°)", () => {
    const w = compLayout({ ...and2, rot: "W" });
    expect(w.rect).toEqual({ x: 10, y: 10, w: 5, h: 3 }); // 180° keeps w/h
    const out = w.pins.find((p) => p.name === "out");
    expect(out).toMatchObject({ x: 10, y: 11.5 });
  });

  it("NORTH/SOUTH swap width and height", () => {
    const n = compLayout({ ...and2, rot: "N" });
    expect(n.rect).toEqual({ x: 10, y: 10, w: 3, h: 5 });
    // EAST out pin (offset +2.5, 0 from center) rotates NORTH → (0, -2.5)
    const out = n.pins.find((p) => p.name === "out");
    expect(out).toMatchObject({ x: 11.5, y: 10 });
  });

  it("pinPosition returns the absolute point or null", () => {
    expect(pinPosition(and2, "out")).toEqual({ x: 15, y: 11.5 });
    expect(pinPosition(and2, "nope")).toBeNull();
  });

  it("pins carry their outward facing (edge they sit on)", () => {
    const layout = compLayout(and2);
    const out = layout.pins.find((p) => p.name === "out");
    expect(out?.facing).toBe("E");
    expect(layout.pins.find((p) => p.name === "in0")?.facing).toBe("W");
    expect(layout.pins.find((p) => p.name === "in1")?.facing).toBe("W");
  });

  it("facing follows rotation (E→S→W→N)", () => {
    const s = compLayout({ ...and2, rot: "S" });
    // output rotates onto the bottom edge; inputs onto the top edge
    expect(s.pins.find((p) => p.name === "out")?.facing).toBe("S");
    expect(s.pins.find((p) => p.name === "in0")?.facing).toBe("N");
    const w = compLayout({ ...and2, rot: "W" });
    expect(w.pins.find((p) => p.name === "out")?.facing).toBe("W");
    expect(w.pins.find((p) => p.name === "in0")?.facing).toBe("E");
    const n = compLayout({ ...and2, rot: "N" });
    expect(n.pins.find((p) => p.name === "out")?.facing).toBe("N");
    expect(n.pins.find((p) => p.name === "in0")?.facing).toBe("S");
  });

  it("every registry pin classifies onto an unambiguous edge", () => {
    // Component types whose pins sit on body edges (the router relies on
    // this). Subcircuits take circuit context; covered by catalog tests.
    const types = [
      "gate.and",
      "gate.or",
      "gate.xor",
      "gate.nand",
      "gate.nor",
      "gate.xnor",
      "gate.not",
      "gate.buffer",
      "wiring.pin",
      "wiring.constant",
      "wiring.clock",
      "wiring.probe",
      "wiring.splitter",
      "plexers.mux",
      "plexers.demux",
      "plexers.decoder",
      "plexers.priority-decoder",
      "arith.adder",
      "arith.shifter",
      "mem.register",
      "mem.ram",
      "mem.rom",
      "io.button",
      "io.led",
    ];
    for (const type of types) {
      const comp: CsxComponent = { id: "c", type, pos: [0, 0] };
      const layout = compLayout(comp);
      for (const p of layout.pins) {
        const onEdge =
          Math.abs(p.x - layout.rect.x) < 1e-9 ||
          Math.abs(p.x - (layout.rect.x + layout.rect.w)) < 1e-9 ||
          Math.abs(p.y - layout.rect.y) < 1e-9 ||
          Math.abs(p.y - (layout.rect.y + layout.rect.h)) < 1e-9;
        expect(onEdge, `${type}.${p.name}`).toBe(true);
      }
    }
  });
});

describe("nextRotation", () => {
  it("cycles E→S→W→N→E with undefined = E", () => {
    expect(nextRotation(undefined)).toBe("S");
    expect(nextRotation("E")).toBe("S");
    expect(nextRotation("S")).toBe("W");
    expect(nextRotation("W")).toBe("N");
    expect(nextRotation("N")).toBe("E");
  });
});
