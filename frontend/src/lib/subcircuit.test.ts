import { describe, expect, it } from "vitest";
import type { CsxCircuit } from "../model/csx";
import { instantiators, usedByText } from "./subcircuit";

const inst = (id: string, circuit: string) => ({
  id,
  type: "subcircuit",
  pos: [0, 0] as [number, number],
  attrs: { circuit },
});

const MAIN: CsxCircuit = { name: "main", components: [inst("i1", "alu")], wires: [] };
const REGFILE: CsxCircuit = { name: "regfile", components: [inst("i2", "alu")], wires: [] };
const ALU: CsxCircuit = { name: "alu", components: [], wires: [] };
const SPARE: CsxCircuit = { name: "spare", components: [], wires: [] };
const CIRCUITS = [MAIN, REGFILE, ALU, SPARE];

describe("instantiators", () => {
  it("names every sheet that places the circuit, in document order", () => {
    expect(instantiators(CIRCUITS, "alu")).toEqual(["main", "regfile"]);
  });

  it("says nothing for a definition nobody places", () => {
    expect(instantiators(CIRCUITS, "spare")).toEqual([]);
    expect(usedByText(CIRCUITS, "spare")).toBe("not placed yet");
  });

  it("reads the component's target, not just the name", () => {
    // A wire endpoint or a label that happens to say "alu" is not an instance.
    const noisy: CsxCircuit = {
      name: "main",
      components: [{ id: "w", type: "wiring.pin", pos: [0, 0], name: "alu" }],
      wires: [],
    };
    expect(instantiators([noisy, ALU], "alu")).toEqual([]);
  });
});

describe("usedByText", () => {
  it("phrases one and several", () => {
    expect(usedByText(CIRCUITS, "alu")).toBe("used by main, regfile");
  });
});
