import { describe, expect, it } from "vitest";
import { scopeHue } from "./scope";

describe("scopeHue", () => {
  it("is stable for a name, and always a hue", () => {
    expect(scopeHue("alu")).toBe(scopeHue("alu"));
    for (const name of ["main", "alu", "regfile", "sub1", ""]) {
      const hue = scopeHue(name);
      expect(Number.isInteger(hue)).toBe(true);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("keeps the default subcircuit names apart", () => {
    const hues = ["sub1", "sub2", "sub3", "sub4"].map(scopeHue);
    expect(new Set(hues).size).toBe(4);
  });
});
