import { describe, expect, it } from "vitest";
import { TAG_H, TAG_TIP, gateShape, tunnelTagBox, tunnelTagTextAt } from "./shapes";

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
  const at = { x: 5, y: 10 };

  it("points at the wire end from one of four sides", () => {
    // Point south (a wire running east): the body is above the wire end.
    const south = tunnelTagBox(at, "S", 3);
    expect(south.x).toBeCloseTo(5 - 1.5, 6);
    expect(south.y).toBeCloseTo(10 - TAG_TIP - TAG_H, 6);
    expect(south.y + south.h).toBeCloseTo(10, 6);
    // Point north (a wire running west): the body is below.
    const north = tunnelTagBox(at, "N", 3);
    expect(north.x).toBeCloseTo(5 - 1.5, 6);
    expect(north.y).toBeCloseTo(10, 6);
    expect(north.y + north.h).toBeCloseTo(10 + TAG_TIP + TAG_H, 6);
    // Point west (a wire running north): the point is the west edge and the body is
    // east of it.
    const west = tunnelTagBox(at, "W", 3);
    expect(west.x).toBeCloseTo(5, 6);
    expect(west.x + west.w).toBeCloseTo(5 + TAG_TIP + 3, 6);
    expect(west.y).toBeCloseTo(10 - TAG_H / 2, 6);
    // Point east (a wire running south): the point is the east edge, the body west.
    const east = tunnelTagBox(at, "E", 3);
    expect(east.x + east.w).toBeCloseTo(5, 6);
    expect(east.x).toBeCloseTo(5 - TAG_TIP - 3, 6);
    expect(east.y).toBeCloseTo(10 - TAG_H / 2, 6);
  });

  it("keeps the body landscape whatever the point does", () => {
    // CircuitSim CE writes four polygons, not one rotated four ways: the label stays
    // a wide, flat chip in every direction (its width is the name's, its height the
    // tag's), so a short name never stands up in a tall box.
    const flat = [tunnelTagBox(at, "S", 4), tunnelTagBox(at, "N", 4)];
    for (const b of flat) {
      expect(b.w).toBeCloseTo(4, 6);
      expect(b.h).toBeCloseTo(TAG_TIP + TAG_H, 6);
    }
    const side = [tunnelTagBox(at, "W", 4), tunnelTagBox(at, "E", 4)];
    for (const b of side) {
      expect(b.w).toBeCloseTo(TAG_TIP + 4, 6);
      expect(b.h).toBeCloseTo(TAG_H, 6);
    }
  });

  it("puts the label in the body's middle, flat, for every direction", () => {
    expect(tunnelTagTextAt(at, "S", 4)).toEqual({ x: 5, y: 10 - TAG_TIP - TAG_H / 2 });
    expect(tunnelTagTextAt(at, "N", 4)).toEqual({ x: 5, y: 10 + TAG_TIP + TAG_H / 2 });
    expect(tunnelTagTextAt(at, "W", 4)).toEqual({ x: 5 + TAG_TIP + 2, y: 10 });
    expect(tunnelTagTextAt(at, "E", 4)).toEqual({ x: 5 - TAG_TIP - 2, y: 10 });
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
