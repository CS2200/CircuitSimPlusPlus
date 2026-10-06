import { describe, expect, it } from "vitest";
import { SelectionModel } from "./selection";

describe("SelectionModel", () => {
  it("starts empty", () => {
    const s = new SelectionModel();
    expect(s.isEmpty).toBe(true);
    expect(s.size).toBe(0);
  });

  it("set replaces the whole selection and bumps version", () => {
    const s = new SelectionModel();
    const v0 = s.version;
    s.set(["c1", "c2"], [0]);
    expect(s.hasComponent("c1")).toBe(true);
    expect(s.hasComponent("c2")).toBe(true);
    expect(s.hasWire(0)).toBe(true);
    expect(s.size).toBe(3);
    expect(s.version).toBeGreaterThan(v0);
    s.set(["c9"], []);
    expect(s.hasComponent("c1")).toBe(false);
    expect(s.hasComponent("c9")).toBe(true);
    expect(s.hasWire(0)).toBe(false);
  });

  it("toggles members individually", () => {
    const s = new SelectionModel();
    s.toggleComponent("c1");
    s.toggleComponent("c1");
    s.toggleWire(3);
    expect(s.hasComponent("c1")).toBe(false);
    expect(s.hasWire(3)).toBe(true);
  });

  it("clear resets; clearing an empty selection is a no-op (no version bump)", () => {
    const s = new SelectionModel();
    const v0 = s.version;
    s.clear();
    expect(s.version).toBe(v0);
    s.set(["c1"], []);
    s.clear();
    expect(s.isEmpty).toBe(true);
    expect(s.version).toBeGreaterThan(v0);
  });
});
