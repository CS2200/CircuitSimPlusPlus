import { describe, expect, it } from "vitest";
import { componentDelayText, wireDelayPerUnit, wireDelayText } from "./delayTable";

/**
 * The table is data read at build time, so these pin the *mapping* to prose the
 * user reads — the numbers themselves live in the engine's table and are
 * checked by the Rust side.
 */
describe("delay table readout", () => {
  it("summarises a plain gate, a wide adder and a register", () => {
    expect(componentDelayText("gate.and")).toBe("prop 10 ns");
    expect(componentDelayText("arith.adder")).toBe("prop 15 ns + 4/bit");
    expect(componentDelayText("mem.register")).toBe("prop 20 ns · setup 15 ns · hold 5 ns");
    expect(componentDelayText("mem.ram")).toBe("access 50 ns · setup 15 ns · hold 5 ns");
  });

  it("says nothing about parts with no published cost", () => {
    expect(componentDelayText("subcircuit")).toBeNull();
    expect(componentDelayText("wiring.pin")).toBeNull();
    expect(componentDelayText("misc.text")).toBeNull();
  });

  it("prices a wire by its path length — currently at zero", () => {
    // Wire propagation ships *off* (`"wire": { "num": 0 }`): only component delays count
    // for the first production run (Head-TA decision, docs/delay-table.md). The pricing
    // functions still read the table, so the constant stays data, not code.
    expect(wireDelayPerUnit()).toBe(0);
    expect(wireDelayText(20)).toContain("≈ 0.0 ns");
  });
});
