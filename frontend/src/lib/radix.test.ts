import { describe, expect, it } from "vitest";
import { radixText } from "./radix";

/**
 * `radixText` is the readout a stored value gets on a part's body — and now in
 * the trace's name column too (a breakpoint's condition, UI_OVERHAUL §90). It
 * grows with the pin's width (`0x5` → `0x05`), so changing the bit size is
 * visible wherever the value is shown.
 *
 * These assertions used to live in `editor/docScene.test.ts`, next to the
 * canvas's copy of the function; they moved here with the function, because
 * more than the canvas reads it now.
 */
describe("radixText", () => {
  it("pads hex to the pin's width, so a wider pin shows more characters", () => {
    expect(radixText("5", "hex", 4)).toBe("0x5");
    expect(radixText("5", "hex", 8)).toBe("0x05");
    expect(radixText("5", "hex", 32)).toBe("0x00000005");
    // The stored string's own padding is irrelevant — the width rules.
    expect(radixText("0a", "hex", 4)).toBe("0xA");
  });

  it("pads binary to the exact bit count", () => {
    expect(radixText("5", "bin", 8)).toBe("0b00000101");
    expect(radixText("1", "bin", 2)).toBe("0b01");
  });

  it("leaves decimal unpadded (a number has no fixed digit count)", () => {
    expect(radixText("5", "dec", 8)).toBe("5");
    expect(radixText("ff", "dec", 8)).toBe("255");
  });

  it("falls back to hex for an unknown radix and clamps a silly width", () => {
    expect(radixText("5", "octal", 4)).toBe("0x5");
    expect(radixText("5", "hex", 0)).toBe("0x5");
    expect(radixText("5", "hex", 99)).toBe("0x00000005");
  });
});
