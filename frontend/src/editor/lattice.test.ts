import { describe, expect, it } from "vitest";
import { compPins } from "./catalog";
import { CircuitDocument } from "../model/document";

/**
 * Pins are the connection points, so every pin offset must sit on the shared
 * **connection lattice** (0.5 grid units) — the resolution wire editing snaps
 * to. A pin at a third/fifth between grid lines can never be reached by a
 * click, and a wire extended along its row gets a phantom half-unit jog. This
 * guards the symbol library against drifting off the lattice.
 */

const TYPES = [
  "arith.adder",
  "arith.bit-extender",
  "arith.comparator",
  "arith.divider",
  "arith.multiplier",
  "arith.negator",
  "arith.shifter",
  "arith.subtractor",
  "debug.breakpoint",
  "gate.and",
  "gate.buffer",
  "gate.nand",
  "gate.nor",
  "gate.not",
  "gate.or",
  "gate.xnor",
  "gate.xor",
  "io.button",
  "io.hexdisplay",
  "io.led",
  "mem.ram",
  "mem.register",
  "mem.rom",
  "misc.text",
  "plexers.decoder",
  "plexers.demux",
  "plexers.mux",
  "plexers.priority-decoder",
  "wiring.clock",
  "wiring.constant",
  "wiring.controlled-buffer",
  "wiring.ground",
  "wiring.pin",
  "wiring.power",
  "wiring.probe",
  "wiring.reset",
  "wiring.splitter",
  "wiring.transistor",
];

const ATTRS: Record<string, unknown>[] = [
  {},
  { inputs: 2 },
  { inputs: 3 },
  { inputs: 4 },
  { inputBits: 2 },
  { inputBits: 4 },
  { inputBits: 8 },
  { bitsize: 8 },
  { splits: 4 },
  { select: 1 },
  { select: 2 },
  { select: 3 },
];

const onLattice = (v: number): boolean => Math.abs(v * 2 - Math.round(v * 2)) < 1e-9;

describe("pin geometry — connection lattice", () => {
  it("every part's pins land on the 0.5 grid", () => {
    const bad: string[] = [];
    for (const type of TYPES) {
      for (const attrs of ATTRS) {
        let pins;
        try {
          pins = compPins({ type, attrs }, []);
        } catch {
          continue; // attrs not valid for this type — skip that combination
        }
        for (const p of pins) {
          if (!onLattice(p.dx) || !onLattice(p.dy)) {
            bad.push(`${type} ${JSON.stringify(attrs)} ${p.name} = (${p.dx}, ${p.dy})`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("subcircuit instance pins land on the 0.5 grid", () => {
    const bad: string[] = [];
    for (const n of [1, 2, 3, 4, 5]) {
      const doc = CircuitDocument.create("a");
      const sub = doc.addCircuit("sub");
      for (let i = 0; i < n; i++) {
        doc.addComponent(sub, { type: "wiring.pin", pos: [0, 0], name: `i${i}` });
        doc.addComponent(sub, {
          type: "wiring.pin",
          pos: [0, 0],
          name: `o${i}`,
          attrs: { isOutput: true },
        });
      }
      const inst = doc.addComponent(0, {
        type: "subcircuit",
        pos: [0, 0],
        attrs: { circuit: "sub" },
      });
      const comp = doc.circuit(0).components.find((c) => c.id === inst)!;
      for (const p of compPins(comp, doc.circuits)) {
        if (!onLattice(p.dx) || !onLattice(p.dy)) {
          bad.push(`subcircuit(${n} ports) ${p.name} = (${p.dx}, ${p.dy})`);
        }
      }
    }
    expect(bad).toEqual([]);
  });
});
