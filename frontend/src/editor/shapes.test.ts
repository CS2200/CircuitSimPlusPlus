import { describe, expect, it } from "vitest";
import { gateShape } from "./shapes";

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
