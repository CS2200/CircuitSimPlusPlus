import { describe, expect, it } from "vitest";
import { SAFE_FROM, SAFE_TO, scopeHue } from "./scope";

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

  it("never lands on red, the colour that means an instance view (§98)", () => {
    // `sub2` and `sub5` used to be 336° and 29°: a new subcircuit read as "inside
    // an instance".
    for (let i = 1; i <= 50; i++) {
      for (const name of [`sub${i}`, `circuit${i}`, `alu${i}`]) {
        const hue = scopeHue(name);
        expect(hue).toBeGreaterThanOrEqual(SAFE_FROM);
        expect(hue).toBeLessThanOrEqual(SAFE_TO);
      }
    }
  });
});
