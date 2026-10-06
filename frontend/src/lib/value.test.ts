import { describe, it, expect } from "vitest";
import { formatWireValue } from "./value";

describe("formatWireValue", () => {
  it("formats plain bits, MSB first", () => {
    expect(formatWireValue({ v: "a", x: "0", z: "0" })).toBe("1010");
  });

  it("formats X and Z bits", () => {
    // v=0101, x=1000, z=0010 → X 1 Z 1
    expect(formatWireValue({ v: "5", x: "8", z: "2" })).toBe("X1Z1");
  });

  it("handles empty masks", () => {
    expect(formatWireValue({ v: "", x: "", z: "" })).toBe("");
  });

  it("width comes from the longest mask", () => {
    expect(formatWireValue({ v: "1fa3", x: "", z: "" })).toBe("0001111110100011");
  });
});
