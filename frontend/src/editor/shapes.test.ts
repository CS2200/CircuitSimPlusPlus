import { describe, expect, it } from "vitest";
import { BUBBLE_R, circlePath, gateShape, rotatePath } from "./shapes";

describe("gateShape", () => {
  it("AND: closed D-shaped body, no bubble", () => {
    const s = gateShape("gate.and", 10, 10, 5, 3)!;
    expect(s.body.at(-1)).toEqual({ t: "Z" });
    expect(s.outBubble).toBeNull();
    expect(s.extra).toHaveLength(0);
    // flat left edge at x, bulge to x+w
    expect(s.body[0]).toEqual({ t: "M", x: 10, y: 10 });
  });

  it("NAND = AND shape shrunk by the bubble + output bubble at the tip", () => {
    const s = gateShape("gate.nand", 10, 10, 5, 3)!;
    expect(s.outBubble).toEqual({ x: 10 + 5 - BUBBLE_R, y: 11.5 });
    // body ends before the bubble
    const xs = s.body.map((c) => ("x" in c ? c.x : Infinity));
    expect(Math.max(...xs.filter((x) => x !== Infinity))).toBeLessThanOrEqual(10 + 5 - BUBBLE_R);
  });

  it("NOT = triangle + bubble; BUFFER = triangle, no bubble", () => {
    expect(gateShape("gate.not", 0, 0, 3, 2)!.outBubble).not.toBeNull();
    expect(gateShape("gate.buffer", 0, 0, 3, 2)!.outBubble).toBeNull();
  });

  it("XOR = OR + back arc; XNOR adds a bubble", () => {
    expect(gateShape("gate.xor", 0, 0, 5, 3)!.extra).toHaveLength(1);
    const xnor = gateShape("gate.xnor", 0, 0, 5, 3)!;
    expect(xnor.extra).toHaveLength(1);
    expect(xnor.outBubble).not.toBeNull();
  });

  it("mux is a trapezoid, wide side left; demux flips", () => {
    const mux = gateShape("plexers.mux", 0, 0, 4, 4)!.body;
    const demux = gateShape("plexers.demux", 0, 0, 4, 4)!.body;
    // mux: first point top-left at full height edge; demux: inset
    expect(mux[0]).toEqual({ t: "M", x: 0, y: 0 });
    expect((demux[0] as { y: number }).y).toBeGreaterThan(0);
  });

  it("box families return null", () => {
    expect(gateShape("mem.ram", 0, 0, 10, 6)).toBeNull();
    expect(gateShape("arith.adder", 0, 0, 6, 4)).toBeNull();
  });
});

describe("circlePath", () => {
  it("is closed with arc endpoints exactly on the circle", () => {
    const cmds = circlePath(5, 5, 2);
    expect(cmds.at(-1)).toEqual({ t: "Z" });
    for (const c of cmds) {
      if (c.t === "M" || c.t === "L" || c.t === "Q") {
        expect(Math.hypot(c.x - 5, c.y - 5)).toBeCloseTo(2, 9);
      }
    }
  });
});

describe("rotatePath", () => {
  it("S rotates 90° clockwise about the center (y-down)", () => {
    const out = rotatePath([{ t: "M", x: 1, y: 0 }], 0, 0, "S");
    expect(out[0]).toMatchObject({ x: 0, y: 1 });
  });

  it("W mirrors", () => {
    const out = rotatePath([{ t: "Q", cx: 1, cy: 1, x: 2, y: 0 }], 0, 0, "W");
    expect(out[0]).toMatchObject({ cx: -1, cy: -1, x: -2, y: 0 });
  });

  it("E is identity", () => {
    const cmds = [{ t: "M", x: 1, y: 2 } as const];
    expect(rotatePath(cmds, 0, 0, "E")).toBe(cmds);
  });
});
