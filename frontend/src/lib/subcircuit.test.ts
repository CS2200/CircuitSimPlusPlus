import { describe, expect, it } from "vitest";
import type { CsxCircuit } from "../model/csx";
import {
  circuitTree,
  instantiators,
  rootCircuitName,
  unplacedCircuits,
  usedByText,
} from "./subcircuit";

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

describe("circuitTree / rootCircuitName", () => {
  it("roots at `main` when present, else the first circuit", () => {
    // `main` wins wherever it sits…
    expect(rootCircuitName([SPARE, MAIN, ALU])).toBe("main");
    // …otherwise the first circuit is the root.
    expect(rootCircuitName([REGFILE, SPARE])).toBe("regfile");
    expect(rootCircuitName([])).toBeNull();
  });

  it("nests definitions from the root and counts repeated instances", () => {
    const cpu: CsxCircuit = {
      name: "cpu",
      components: [inst("a", "alu"), inst("b", "reg"), inst("c", "reg")],
      wires: [],
    };
    const main: CsxCircuit = {
      name: "main",
      components: [inst("m1", "cpu"), inst("m2", "cpu")],
      wires: [],
    };
    const alu: CsxCircuit = { name: "alu", components: [], wires: [] };
    const reg: CsxCircuit = { name: "reg", components: [], wires: [] };
    const tree = circuitTree([main, cpu, alu, reg]);
    expect(tree?.name).toBe("main");
    expect(tree?.children.map((n) => [n.name, n.count])).toEqual([["cpu", 2]]);
    expect(tree?.children[0].children.map((n) => [n.name, n.count])).toEqual([
      ["alu", 1],
      ["reg", 2],
    ]);
  });

  it("marks a repeated definition instead of recursing forever", () => {
    const a: CsxCircuit = { name: "a", components: [inst("x", "b")], wires: [] };
    const b: CsxCircuit = { name: "b", components: [inst("y", "a")], wires: [] };
    const back = circuitTree([a, b])?.children[0].children[0];
    expect(back?.name).toBe("a");
    expect(back?.repeat).toBe(true);
    expect(back?.children).toEqual([]);
  });

  it("lists the definitions the root cannot reach", () => {
    // `regfile` places `alu` but nothing places `regfile`; `spare` is unplaced.
    expect(unplacedCircuits(CIRCUITS)).toEqual(["regfile", "spare"]);
  });
});
