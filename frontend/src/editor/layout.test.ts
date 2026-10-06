import { describe, expect, it } from "vitest";
import { compLayout, nextRotation, pinPosition } from "./layout";
import { compPins, compSize, isKnownType, PALETTE } from "./catalog";
import type { CsxComponent } from "../model/csx";

const and2: CsxComponent = { id: "c1", type: "gate.and", pos: [10, 10] };

describe("catalog", () => {
  it("every PALETTE type has a spec", () => {
    for (const group of PALETTE) {
      for (const type of group.types) {
        expect(isKnownType(type), type).toBe(true);
        const size = compSize({ type });
        expect(size.w, type).toBeGreaterThan(0);
        expect(size.h, type).toBeGreaterThan(0);
      }
    }
  });

  it("gate input count scales pins", () => {
    const two = compPins({ type: "gate.and" });
    expect(two.filter((p) => p.kind === "in")).toHaveLength(2);
    const four = compPins({ type: "gate.and", attrs: { inputs: 4 } });
    expect(four.filter((p) => p.kind === "in")).toHaveLength(4);
    expect(compSize({ type: "gate.and", attrs: { inputs: 4 } }).h).toBe(5);
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
