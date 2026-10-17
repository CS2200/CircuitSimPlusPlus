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
