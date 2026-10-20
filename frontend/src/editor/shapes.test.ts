import { describe, expect, it } from "vitest";
import { TAG_H, TAG_TIP, gateShape, tunnelTagPath } from "./shapes";

/**
 * Power / ground glyphs (UI_OVERHAUL §72): a rake and a bar, drawn inside the
 * body rect the layout hands in. They exist so a schematic reads like a
 * schematic; no committed screenshot contains one, so the geometry is pinned
 * here instead.
 */
describe("power / ground glyphs", () => {
  it("draws a shaped body for each, inside the rect", () => {
    for (const type of ["wiring.power", "wiring.ground"]) {
      const shape = gateShape(type, 0, 0, 3, 2);
      expect(shape).not.toBeNull();
      expect(shape!.body.length).toBeGreaterThan(2);
      for (const cmd of shape!.body) {
        if (cmd.t === "Z") continue;
        expect(cmd.x).toBeGreaterThanOrEqual(0);
        expect(cmd.x).toBeLessThanOrEqual(3);
        expect(cmd.y).toBeGreaterThanOrEqual(0);
        expect(cmd.y).toBeLessThanOrEqual(2);
      }
    }
  });

  it("leaves box families alone (they draw their own rect)", () => {
    expect(gateShape("gate.and", 0, 0, 5, 3)).not.toBeNull(); // gates are shaped
    expect(gateShape("wiring.constant", 0, 0, 3, 2)).toBeNull();
    // A breakpoint is a box too: its mark and its condition are body text
    // (docScene §90), not a silhouette.
    expect(gateShape("debug.breakpoint", 0, 0, 3, 2)).toBeNull();
  });
});

describe("tunnel tag (UI_OVERHAUL §91)", () => {
  it("hangs above its anchor and points down at it", () => {
    const path = tunnelTagPath(5, 10, 3);
    let minY = Infinity;
    let maxY = -Infinity;
    let minX = Infinity;
    let maxX = -Infinity;
    for (const cmd of path) {
      if (cmd.t === "Z" || cmd.t === "Q") continue;
      minY = Math.min(minY, cmd.y);
      maxY = Math.max(maxY, cmd.y);
      minX = Math.min(minX, cmd.x);
      maxX = Math.max(maxX, cmd.x);
    }
    // The tag never reaches below the wire end, and its tip IS the wire end.
    expect(maxY).toBe(10);
    expect(minY).toBeCloseTo(10 - TAG_TIP - TAG_H, 6);
    // Centred on the anchor, no wider than its body.
    expect(minX).toBeGreaterThanOrEqual(5 - 1.5);
    expect(maxX).toBeLessThanOrEqual(5 + 1.5);
    // A tag whose text is wider grows sideways, not downwards.
    const wide = tunnelTagPath(5, 10, 6);
    const wideX = wide.filter((c) => c.t !== "Z").map((c) => (c.t === "Q" ? c.cx : c.x));
    expect(Math.min(...wideX)).toBeCloseTo(2, 6);
  });
});

describe("transistor glyph (UI_OVERHAUL §78)", () => {
  it("draws a symbol inside the rect, with the channel broken in three", () => {
    const shape = gateShape("wiring.transistor", 0, 0, 3, 2);
    expect(shape).not.toBeNull();
    for (const cmd of shape!.body) {
      if (cmd.t === "Z") continue;
      expect(cmd.x).toBeGreaterThanOrEqual(0);
      expect(cmd.x).toBeLessThanOrEqual(3);
      expect(cmd.y).toBeGreaterThanOrEqual(0);
      expect(cmd.y).toBeLessThanOrEqual(2);
    }
    // The gate plate is a full-height line; the channel is three shorter ones, so
    // the symbol is recognisable as a MOSFET rather than a box.
    const moves = shape!.body.filter((c) => c.t === "M").length;
    expect(moves).toBeGreaterThanOrEqual(7);
    expect(shape!.body.length).toBeGreaterThan(moves);
  });

  it("is no longer a box family", () => {
    expect(gateShape("wiring.transistor", 0, 0, 3, 2)).not.toBeNull();
    expect(gateShape("mem.register", 0, 0, 3, 2)).toBeNull();
  });
});
