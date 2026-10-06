import { describe, expect, it } from "vitest";
import { circuitInterface, compPins, compSize, compSpec } from "./catalog";
import type { CsxCircuit } from "../model/csx";

/**
 * Catalog geometry for the hierarchy pair: `wiring.pin` (the subcircuit
 * interface) and `subcircuit` instances. Instance pin names/order/direction
 * mirror the netlist (B3): the target's named pin components in document
 * order, subcircuit inputs on the left edge, outputs on the right.
 */

function pin(name: string, attrs?: Record<string, unknown>, id?: string) {
  return { id: id ?? name, type: "wiring.pin", pos: [0, 0] as [number, number], name, attrs };
}

const ALU: CsxCircuit = {
  name: "alu",
  components: [
    pin("a"),
    pin("b"),
    pin("y", { isOutput: true }),
    pin("zero", { isOutput: true }),
    { id: "g1", type: "gate.and", pos: [4, 0] }, // not a pin — ignored
    pin(""), // unnamed — not part of the interface
  ],
  wires: [],
};

const CIRCUITS: readonly CsxCircuit[] = [{ name: "main", components: [], wires: [] }, ALU];

describe("wiring.pin spec", () => {
  it("names its terminal 'pin' (backend registry name, not 'port')", () => {
    expect(compPins({ type: "wiring.pin" }).map((p) => p.name)).toEqual(["pin"]);
  });

  it("drives its circuit when an input pin, is driven when an output pin", () => {
    expect(compPins({ type: "wiring.pin" })[0].kind).toBe("out");
    expect(compPins({ type: "wiring.pin", attrs: { isOutput: true } })[0].kind).toBe("in");
  });

  it("carries the bitsize attr on the terminal", () => {
    expect(compPins({ type: "wiring.pin", attrs: { bitsize: 8 } })[0].bitsize).toBe(8);
  });
});

describe("circuitInterface", () => {
  it("splits named pins by isOutput, in document order", () => {
    const { inputs, outputs } = circuitInterface(ALU);
    expect(inputs.map((p) => p.name)).toEqual(["a", "b"]);
    expect(outputs.map((p) => p.name)).toEqual(["y", "zero"]);
  });
});

describe("subcircuit instance pins", () => {
  const inst = { type: "subcircuit", attrs: { circuit: "alu" } };

  it("inputs on the left edge, outputs on the right, document order top-to-bottom", () => {
    const pins = compPins(inst, CIRCUITS);
    expect(pins.map((p) => [p.name, p.dx, p.kind])).toEqual([
      ["a", 0, "in"],
      ["b", 0, "in"],
      ["y", 8, "out"],
      ["zero", 8, "out"],
    ]);
    // spread within the box height, in order
    const ins = pins.filter((p) => p.kind === "in");
    expect(ins[0].dy).toBeLessThan(ins[1].dy);
    const outs = pins.filter((p) => p.kind === "out");
    expect(outs[0].dy).toBeLessThan(outs[1].dy);
  });

  it("instance pin widths come from the pin components' bitsize", () => {
    const wide: CsxCircuit = {
      name: "wide",
      components: [pin("bus", { bitsize: 16 }), pin("q", { isOutput: true, bitsize: 16 })],
      wires: [],
    };
    const pins = compPins({ type: "subcircuit", attrs: { circuit: "wide" } }, [wide]);
    expect(pins.map((p) => p.bitsize)).toEqual([16, 16]);
  });

  it("unknown target → no pins (engine validation reports the error)", () => {
    expect(compPins({ type: "subcircuit", attrs: { circuit: "nope" } }, CIRCUITS)).toEqual([]);
  });

  it("box height scales with the larger side", () => {
    expect(compSize(inst, CIRCUITS)).toEqual({ w: 8, h: 4 }); // 2+2 pins → min height
    const tall: CsxCircuit = {
      name: "tall",
      components: [pin("a"), pin("b"), pin("c"), pin("d"), pin("q", { isOutput: true })],
      wires: [],
    };
    expect(compSize({ type: "subcircuit", attrs: { circuit: "tall" } }, [tall]).h).toBe(8);
  });

  it("caption shows the target circuit name", () => {
    expect(compPins(inst, CIRCUITS).length).toBe(4);
    expect(compSpec("subcircuit").caption({ circuit: "alu" })).toBe("alu");
    expect(compSpec("subcircuit").caption({})).toBe("SUB");
  });
});
