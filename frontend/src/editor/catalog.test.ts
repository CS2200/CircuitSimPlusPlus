import { describe, expect, it } from "vitest";
import {
  showsBodyCaption,
  circuitInterface,
  compPins,
  compSize,
  compSpec,
  defaultAttrs,
  editableAttrs,
  memAddrBits,
  typeDisplayName,
  type AttrField,
} from "./catalog";
import type { CsxCircuit } from "../model/csx";
import { gateShape } from "./shapes";

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
    // A breakpoint keeps its mark on the body and shows what it watches under
    // it (docScene draws the condition; §90), so the mark is just "BP".
    expect(compSpec("debug.breakpoint").caption({})).toBe("BP");
    // `in` first: the engine identifies the watched pin by slot, and `en` gates
    // the watch (format-v2 §4) — the old tool's DATA/ENABLE pair.
    expect(
      compSpec("debug.breakpoint")
        .pins({ bitsize: 8 })
        .map((p) => [p.name, p.kind, p.bitsize ?? 1]),
    ).toEqual([
      ["in", "in", 8],
      ["en", "in", 1],
    ]);
    expect(
      compSpec("debug.breakpoint")
        .pins({})
        .find((p) => p.name === "in")?.bitsize,
    ).toBe(1);
    // UI_OVERHAUL §88: the full CircuitSim CE enable chain is on the part.
    expect(
      compSpec("plexers.priority-decoder")
        .pins({})
        .map((p) => p.name),
    ).toEqual(["in0", "in1", "in2", "in3", "out", "valid", "en_in", "en_out"]);
    const eight = compSpec("plexers.priority-decoder").pins({ inputBits: 8 });
    expect(eight.filter((p) => p.kind === "in").map((p) => p.name)).toEqual([
      "in0",
      "in1",
      "in2",
      "in3",
      "in4",
      "in5",
      "in6",
      "in7",
      "en_in",
    ]);
    expect(eight.find((p) => p.name === "out")?.bitsize).toBe(3);
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
    // A breakpoint's value is edited in the chosen radix, exactly like a
    // constant's (§55), and `radix` is display-only on both (§90).
    expect(keys("debug.breakpoint")).toEqual(["bitsize", "value", "radix"]);
    expect(keys("gate.and")).toEqual(["bitsize", "inputs"]);
    expect(keys("gate.not")).toEqual(["bitsize"]);
    expect(keys("mem.ram")).toEqual(["addrBits", "bitsize"]);
    expect(keys("mem.rom")).toEqual(["addrBits", "bitsize"]);
    // The register shows its stored value, so it carries a base chooser (§57).
    expect(keys("mem.register")).toEqual(["bitsize", "radix"]);
    expect(keys("io.button")).toEqual(["bitsize"]);
    expect(keys("subcircuit")).toEqual(["circuit", "width", "height"]);
  });

  it("a value readout sizes its body to the declared width (§56)", () => {
    const w = (type: string, attrs: Record<string, unknown>): number => compSize({ type, attrs }).w;
    // The base: as wide as the digits need, and no wider.
    expect(w("wiring.constant", { bitsize: 1 })).toBe(3);
    expect(w("wiring.constant", { bitsize: 4 })).toBe(3);
    // 8 bits is one hex digit more, so the box grows a little — this is the
    // mismatch the screenshot showed, two widths drawn identically.
    expect(w("wiring.constant", { bitsize: 8 })).toBe(3.5);
    expect(w("wiring.constant", { bitsize: 32 })).toBe(7.8); // 0x00000000
    expect(w("wiring.constant", { bitsize: 32, radix: "bin" })).toBe(25.1); // 32 bits
    expect(w("wiring.constant", { bitsize: 32, radix: "dec" })).toBe(7.8); // 10 digits
    expect(w("wiring.probe", { bitsize: 32 })).toBe(w("wiring.constant", { bitsize: 32 }));
  });

  it("a constant's `out` rides the box edge; a probe's `in` does not move", () => {
    const konst = { type: "wiring.constant", attrs: { bitsize: 32 } };
    expect(compPins(konst)[0].dx).toBe(compSize(konst).w);
    // The probe points along its pin, so its body grows behind it.
    expect(compPins({ type: "wiring.probe", attrs: { bitsize: 32 } })[0].dx).toBe(0);
  });

  it("a memory offers both widths as one-click picks, never a dropdown", () => {
    const widths = editableAttrs("mem.ram").filter((f) => f.group === "Width");
    expect(widths.map((f) => [f.key, f.label, f.kind])).toEqual([
      ["addrBits", "Address Bits", "picker"],
      ["bitsize", "Data Bits", "picker"],
    ]);
  });

  it("picking an address width resizes the memory, trimming an over-long image", () => {
    const addr = editableAttrs("mem.ram").find(
      (f): f is AttrField & { kind: "picker" } => f.key === "addrBits",
    );
    // The word count IS the address space, so one pick writes both.
    expect(addr?.attrsFor?.(4, {})).toEqual({ addrBits: 4, depth: 16 });
    expect(addr?.attrsFor?.(12, { bitsize: 32 })).toEqual({ addrBits: 12, depth: 4096 });
    // An image longer than the new size is a load error, so the tail goes with
    // the resize (6 words → 4 words; canonical runs preserved).
    expect(addr?.attrsFor?.(2, { bitsize: 32, contents: "6-0000000a" })).toEqual({
      addrBits: 2,
      depth: 4,
      contents: "4-0000000a",
    });
    // One that still fits is left exactly as it is.
    expect(addr?.attrsFor?.(4, { bitsize: 32, contents: "3-0000000a" })).toEqual({
      addrBits: 4,
      depth: 16,
    });
  });

  it("a memory's address width follows depth, unless addrBits says otherwise", () => {
    // Engine-identical rule (components.rs's `addr_width`): 256 words → 8 bits.
    expect(memAddrBits({ depth: 256 })).toBe(8);
    expect(memAddrBits({})).toBe(8); // the 256-word default
    // Explicit wins, both directions: a window, or room for X past the end.
    expect(memAddrBits({ depth: 256, addrBits: 4 })).toBe(4);
    expect(memAddrBits({ depth: 16, addrBits: 12 })).toBe(12);
    // Out of range falls back to the derived width, exactly as the engine
    // does (it reports the attr and uses the default, so the file still fails
    // to load — the UI just must not draw a width the core will never use).
    expect(memAddrBits({ depth: 256, addrBits: 0 })).toBe(8);
    expect(memAddrBits({ depth: 256, addrBits: 99 })).toBe(8);
  });

  it("names a type in plain words for the Inspector header (§57)", () => {
    expect(typeDisplayName("plexers.mux")).toBe("Multiplexer");
    expect(typeDisplayName("mem.register")).toBe("Register");
    expect(typeDisplayName("debug.breakpoint")).toBe("Breakpoint");
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
    // A breakpoint is placed watching for 0 on a one-bit line — the format's
    // defaults, written out so the body's readout is never blank (§90).
    expect(defaultAttrs("debug.breakpoint")).toEqual({ value: "0" });
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

describe("an instance's terminals follow its definition (§77)", () => {
  const MAIN: CsxCircuit = { name: "main", components: [], wires: [] };
  const withAlu = (c: CsxCircuit) => [MAIN, c];

  it("a renamed or added inner pin shows up on the instance", () => {
    expect(
      compPins({ type: "subcircuit", attrs: { circuit: "alu" } }, CIRCUITS).map((p) => p.name),
    ).toEqual(["a", "b", "y", "zero"]);

    const edited: CsxCircuit = {
      ...ALU,
      components: [
        ...ALU.components.map((c) => (c.name === "b" ? { ...c, name: "b2" } : c)),
        pin("carry"),
      ],
    };
    expect(
      compPins({ type: "subcircuit", attrs: { circuit: "alu" } }, withAlu(edited)).map(
        (p) => p.name,
      ),
    ).toEqual(["a", "b2", "carry", "y", "zero"]);
  });

  it("a port that crosses west swaps edges on the instance", () => {
    // The rotation itself pairs rot ↔ isOutput (document.ts, §77); what is checked
    // here is the consequence on the other side of the hierarchy.
    const edited: CsxCircuit = {
      ...ALU,
      components: ALU.components.map((c) =>
        c.name === "a"
          ? { ...c, rot: "W" as const, attrs: { ...(c.attrs ?? {}), isOutput: true } }
          : c,
      ),
    };
    const a = compPins({ type: "subcircuit", attrs: { circuit: "alu" } }, withAlu(edited)).find(
      (p) => p.name === "a",
    );
    expect(a?.kind).toBe("out");
    expect(a?.dx).toBe(8); // the right edge, where outputs live
  });
});

describe("an instance box that carries its own size (§79)", () => {
  const box = (attrs: Record<string, unknown>, circuits: readonly CsxCircuit[] = CIRCUITS) =>
    compSize({ type: "subcircuit", attrs }, circuits);

  const TALL: CsxCircuit = {
    name: "tall",
    components: [pin("a"), pin("b"), pin("c"), pin("d"), pin("q", { isOutput: true })],
    wires: [],
  };

  it("derives the box from the pins when nothing is set", () => {
    expect(box({ circuit: "alu" })).toEqual({ w: 8, h: 4 }); // 2 + 2 pins → minimum
    expect(box({ circuit: "tall" }, [TALL])).toEqual({ w: 8, h: 8 }); // 4 pins → 2 × 4
  });

  it("takes an explicit width and height", () => {
    expect(box({ circuit: "alu", width: 14, height: 10 })).toEqual({ w: 14, h: 10 });
  });

  it("never crowds the pins: the floor is one grid unit apart, not the roomy default", () => {
    // 4 pins on the longer side sit at (i+1)·h/5, so h = 5 is the tightest legal box.
    expect(box({ circuit: "tall", height: 3 }, [TALL]).h).toBe(5);
    expect(box({ circuit: "alu", width: 2 }).w).toBe(8); // below the minimum width
  });

  it("falls back to the derived box for nonsense or out-of-range values", () => {
    expect(box({ circuit: "tall", height: 9000 }, [TALL]).h).toBe(8);
    expect(box({ circuit: "tall", height: "big" }, [TALL]).h).toBe(8);
    expect(box({ circuit: "tall", height: -2 }, [TALL]).h).toBe(8);
  });

  it("moves the output pins to the new right edge", () => {
    const pins = compPins({ type: "subcircuit", attrs: { circuit: "alu", width: 14 } }, CIRCUITS);
    expect(pins.filter((p) => p.kind === "out").every((p) => p.dx === 14)).toBe(true);
    expect(pins.filter((p) => p.kind === "in").every((p) => p.dx === 0)).toBe(true);
    // …and a taller box spreads them further down it.
    const tall = compPins({ type: "subcircuit", attrs: { circuit: "alu", height: 12 } }, CIRCUITS);
    expect(tall.filter((p) => p.kind === "in").map((p) => p.dy)).toEqual([4, 8]);
  });
});

describe("showsBodyCaption (§17 rule 3 / §83)", () => {
  it("marks the shaped bodies whose outline cannot say what they are", () => {
    for (const type of ["plexers.mux", "plexers.demux", "wiring.power", "wiring.ground"]) {
      expect(showsBodyCaption(type)).toBe(true);
    }
  });

  it("leaves gates shape-only — their outline is the mark", () => {
    for (const type of ["gate.and", "gate.nand", "gate.not", "misc.text", "wiring.transistor"]) {
      expect(showsBodyCaption(type)).toBe(false);
    }
  });

  it("covers exactly the shaped types that carry a caption", () => {
    // The canvas draws a caption on a shaped body only through this predicate, so the
    // two lists cannot drift — and every marked type must be shaped and have a caption.
    for (const type of ["plexers.mux", "plexers.demux", "wiring.power", "wiring.ground"]) {
      expect(gateShape(type, 0, 0, 3, 2)).not.toBeNull();
      expect(compSpec(type).caption({})).not.toBe("");
    }
  });
});
