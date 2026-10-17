import { describe, expect, it } from "vitest";
import {
  circuitInterface,
  compPins,
  compSize,
  compSpec,
  defaultAttrs,
  editableAttrs,
  typeDisplayName,
} from "./catalog";
import type { CsxCircuit } from "../model/csx";

/**
 * Catalog geometry for the hierarchy pair: `wiring.pin` (the subcircuit
 * interface) and `subcircuit` instances. Instance pin names/order/direction
 * mirror the netlist (B3): the target's named pin components in document
 * order, subcircuit inputs on the left edge, outputs on the right.
 */

describe("body marks (UI_OVERHAUL §17)", () => {
  it("arithmetic parts use the symbol, not an abbreviation", () => {
    const marks = [
      "arith.adder",
      "arith.subtractor",
      "arith.multiplier",
      "arith.divider",
      "arith.comparator",
      "arith.negator",
      "arith.shifter",
    ].map((t) => compSpec(t).caption({}));
    expect(marks).toEqual(["+", "\u2212", "\u00d7", "\u00f7", "=", "~", "\u00ab"]);
    // …and the palette keeps the human name (§18).
    expect(compSpec("arith.adder").label).toBe("ADD");
    expect(compSpec("arith.shifter").markSize).toBeGreaterThan(1);
  });

  it("non-symbol families keep a short abbreviation", () => {
    expect(compSpec("mem.register").caption({})).toBe("REG");
    expect(compSpec("mem.ram").caption({})).toBe("RAM");
    expect(compSpec("plexers.mux").caption({})).toBe("MUX");
    expect(compSpec("plexers.decoder").caption({})).toBe("DEC");
    expect(compSpec("plexers.priority-decoder").caption({})).toBe("PRI");
  });
});

describe("properties coverage (UI_OVERHAUL §18)", () => {
  const keys = (type: string): string[] => editableAttrs(type).map((f) => f.key);

  it("exposes every attr the engine accepts, with format-v2 names", () => {
    // Timing is unit-wide (format-v2 §6): the panel offers no `delay` field
    // for any part (§26).
    expect(keys("arith.shifter")).toEqual(["bitsize", "shift"]);
    expect(keys("arith.bit-extender")).toEqual(["inBits", "outBits", "mode"]);
    expect(keys("plexers.mux")).toEqual(["bitsize", "selectBits"]);
    expect(keys("plexers.decoder")).toEqual(["inputBits"]);
    expect(keys("plexers.priority-decoder")).toEqual(["inputBits"]);
    expect(keys("wiring.probe")).toEqual(["bitsize", "radix"]);
    expect(keys("wiring.splitter")).toEqual(["splits"]);
    expect(keys("gate.and")).toEqual(["bitsize", "inputs"]);
    expect(keys("gate.not")).toEqual(["bitsize"]);
    expect(keys("mem.ram")).toEqual(["bitsize", "depth"]);
    // The register shows its stored value, so it carries a base chooser (§57).
    expect(keys("mem.register")).toEqual(["bitsize", "radix"]);
    expect(keys("io.button")).toEqual(["bitsize"]);
    expect(keys("subcircuit")).toEqual(["circuit"]);
  });

  it("names a type in plain words for the Inspector header (§57)", () => {
    expect(typeDisplayName("plexers.mux")).toBe("Multiplexer");
    expect(typeDisplayName("mem.register")).toBe("Register");
    expect(typeDisplayName("unknown.thing")).toBe("unknown.thing");
  });

  it("groups fields for the Inspector", () => {
    const groups = editableAttrs("arith.bit-extender").map((f) => f.group);
    expect(groups).toEqual(["Width", "Width", "Options"]);
  });

  it("seeds the REQUIRED splitter mapping on placement", () => {
    expect(defaultAttrs("wiring.splitter")).toEqual({
      splits: { b0: [0], b1: [1], b2: [2], b3: [3] },
    });
    expect(defaultAttrs("gate.and")).toBeUndefined();
    // A placed-with-defaults splitter is valid geometry (bus width 4).
    const pins = compPins({ type: "wiring.splitter", attrs: defaultAttrs("wiring.splitter") });
    expect(pins.find((p) => p.name === "bus")?.bitsize).toBe(4);
    expect(pins.map((p) => p.name)).toEqual(["bus", "b0", "b1", "b2", "b3"]);
  });

  it("the bit extender reads inBits/outBits, not bitsize", () => {
    const pins = compPins({ type: "arith.bit-extender" });
    expect(pins.find((p) => p.name === "in")?.bitsize).toBe(8);
    expect(pins.find((p) => p.name === "out")?.bitsize).toBe(16);
  });
});

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
