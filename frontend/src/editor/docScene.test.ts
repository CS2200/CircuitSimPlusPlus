import { describe, expect, it } from "vitest";
import { fitValueLine } from "./docScene";

/**
 * Value readouts must stay inside their part (UI_OVERHAUL §56): a short value is
 * shown whole and readable, a wide one (a 32-bit binary, say) is shortened with
 * an ellipsis — hovering then reveals the whole thing.
 */
describe("fitValueLine", () => {
  it("keeps a short value whole and readable", () => {
    const r = fitValueLine("0x0", 3, 2);
    expect(r.full).toBe(true);
    expect(r.text).toBe("0x0");
    expect(r.size).toBeGreaterThanOrEqual(0.6);
  });

  it("shortens a long binary readout so it fits the body", () => {
    const bits = `0b${"1".repeat(32)}`;
    const r = fitValueLine(bits, 3, 2);
    expect(r.full).toBe(false);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text.length).toBeLessThan(bits.length);
    // The shortened line really fits: chars × size × 0.62 ≤ usable width.
    expect(r.text.length * r.size * 0.62).toBeLessThanOrEqual(3 * 0.86 + 1e-9);
  });
});
