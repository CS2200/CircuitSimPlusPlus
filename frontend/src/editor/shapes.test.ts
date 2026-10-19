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
  });
});
