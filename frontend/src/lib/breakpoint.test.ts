import { describe, expect, it } from "vitest";
import { breakpointCondition } from "./breakpoint";

/**
 * A breakpoint's condition is read on two surfaces — the part's body and the
 * trace's name column (§90) — so it is one function with one set of rules: the
 * `=` says it is a comparison, the radix says how it reads, and the width pads
 * the digits exactly as a constant's readout does.
 */
describe("breakpointCondition", () => {
  it("reads as a comparison, in the configured radix and width", () => {
    expect(breakpointCondition({ bitsize: 8, value: "a5" })).toBe("= 0xA5");
    expect(breakpointCondition({ bitsize: 8, value: "5", radix: "dec" })).toBe("= 5");
    expect(breakpointCondition({ bitsize: 2, value: "1", radix: "bin" })).toBe("= 0b01");
  });

  it("falls back to the format's own defaults on missing or silly attrs", () => {
    expect(breakpointCondition(undefined)).toBe("= 0x0");
    expect(breakpointCondition({})).toBe("= 0x0");
    expect(breakpointCondition({ bitsize: 0 })).toBe("= 0x0");
    // An unknown radix reads as hex rather than as nothing at all.
    expect(breakpointCondition({ radix: "octal", value: "5" })).toBe("= 0x5");
  });
});
