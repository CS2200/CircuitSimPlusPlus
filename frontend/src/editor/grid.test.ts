import { describe, expect, it } from "vitest";
import { gridStepFor } from "./docScene";

describe("canvas grid groups (UI_OVERHAUL §15)", () => {
  it("doubles the group size until lines are at least 14 px apart", () => {
    expect(gridStepFor(30)).toBe(1); // 30 px — a line every cell
    expect(gridStepFor(14)).toBe(1);
    expect(gridStepFor(13)).toBe(2); // 26 px
    expect(gridStepFor(7)).toBe(2); // 14 px
    expect(gridStepFor(6.9)).toBe(4); // 27.6 px
    expect(gridStepFor(3.4)).toBe(8); // 27.2 px
    expect(gridStepFor(1)).toBe(16);
    expect(gridStepFor(0.5)).toBe(32);
  });
});
