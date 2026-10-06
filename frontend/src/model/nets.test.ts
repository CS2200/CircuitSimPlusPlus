import { describe, expect, it } from "vitest";
import { CircuitDocument } from "./document";
import type { CsxCircuit } from "./csx";
import { deriveNets } from "./nets";

/** Build a circuit with: w0: and.out → not.in; w1: not.out → join(w0); w2: ram.addr → join(w1); w3: and.out → ram.d0 (fan-out on and.out? no — w0/w3 share and.out). */
function junctionGraph(): CsxCircuit {
  const doc = CircuitDocument.create();
  const c = 0;
  const and = doc.addComponent(c, { type: "gate.and", pos: [0, 0] }); // c1
  const not = doc.addComponent(c, { type: "gate.not", pos: [5, 0] }); // c2
  const ram = doc.addComponent(c, { type: "mem.ram", pos: [10, 0] }); // c3
  doc.addComponent(c, { type: "gate.xor", pos: [20, 0] }); // c4 — unwired
  doc.addWire(c, {
    a: { comp: and, pin: "out" },
    b: { comp: not, pin: "in" },
    points: [
      [3, 1],
      [5, 1],
    ],
  }); // w0
  doc.addWire(c, {
    a: { comp: not, pin: "out" },
    b: { join: { wire: 0, segment: 0 } },
    points: [
      [6, 1],
      [4, 1],
    ],
  }); // w1
  doc.addWire(c, {
    a: { comp: ram, pin: "addr" },
    b: { join: { wire: 1, segment: 0 } },
    points: [
      [10, 1],
      [6, 1],
    ],
  }); // w2
  return doc.circuit(c);
}

describe("deriveNets", () => {
  it("a single pin–pin wire forms one net", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(0, { type: "gate.not", pos: [5, 0] });
    doc.addWire(0, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [3, 1],
        [5, 1],
      ],
    });
    const d = deriveNets(doc.circuit(0));
    expect(d.errors).toEqual([]);
    expect(d.nets).toHaveLength(1);
    expect(d.nets[0].wires).toEqual([0]);
    expect(d.nets[0].pins).toEqual([`${a}:out`, `${b}:in`].sort());
    expect(d.wireToNet.get(0)).toBe(0);
    expect(d.pinToNet.get(`${a}:out`)).toBe(0);
  });

  it("junctions merge wires into one net (junction dot semantics)", () => {
    const d = deriveNets(junctionGraph());
    expect(d.errors).toEqual([]);
    // w0, w1, w2 are one electrical node via junctions
    expect(d.nets).toHaveLength(1);
    expect(d.nets[0].wires).toEqual([0, 1, 2]);
    expect(d.nets[0].pins).toContain("c1:out");
    expect(d.nets[0].pins).toContain("c2:in");
    expect(d.nets[0].pins).toContain("c2:out");
    expect(d.nets[0].pins).toContain("c3:addr");
  });

  it("fan-out: several wires sharing a source pin are one net", () => {
    const doc = CircuitDocument.create();
    const src = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const d1 = doc.addComponent(0, { type: "gate.not", pos: [5, 0] });
    const d2 = doc.addComponent(0, { type: "gate.or", pos: [5, 4] });
    const d3 = doc.addComponent(0, { type: "gate.xor", pos: [5, 8] });
    for (const [i, dst] of [d1, d2, d3].entries()) {
      doc.addWire(0, {
        a: { comp: src, pin: "out" },
        b: { comp: dst, pin: "in" },
        points: [
          [3, 1],
          [5, 1 + i],
        ],
      });
    }
    const d = deriveNets(doc.circuit(0));
    expect(d.nets).toHaveLength(1);
    expect(d.nets[0].wires).toEqual([0, 1, 2]);
  });

  it("disjoint nets get deterministic ids ordered by smallest wire index", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(0, { type: "gate.not", pos: [5, 0] });
    const x = doc.addComponent(0, { type: "gate.or", pos: [10, 0] });
    const y = doc.addComponent(0, { type: "gate.xor", pos: [15, 0] });
    doc.addWire(0, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [3, 1],
        [5, 1],
      ],
    });
    doc.addWire(0, {
      a: { comp: x, pin: "out" },
      b: { comp: y, pin: "in" },
      points: [
        [13, 1],
        [15, 1],
      ],
    });
    const d = deriveNets(doc.circuit(0));
    expect(d.nets).toHaveLength(2);
    expect(d.nets[0].pins).toContain(`${a}:out`);
    expect(d.nets[1].pins).toContain(`${x}:out`);
    expect(d.wireToNet.get(0)).toBe(0);
    expect(d.wireToNet.get(1)).toBe(1);
  });

  it("unwired pins belong to no net", () => {
    const d = deriveNets(junctionGraph());
    expect(d.pinToNet.has("c4:in")).toBe(false);
    expect(d.pinToNet.has("c4:out")).toBe(false);
  });

  it("collects errors on corrupt joins instead of crashing", () => {
    const circuit: CsxCircuit = {
      name: "main",
      components: [
        { id: "c1", type: "gate.and", pos: [0, 0] },
        { id: "c2", type: "gate.not", pos: [5, 0] },
      ],
      wires: [
        {
          a: { comp: "c1", pin: "out" },
          b: { comp: "c2", pin: "in" },
          points: [
            [3, 1],
            [5, 1],
          ],
        },
        {
          a: { comp: "c2", pin: "out" },
          b: { join: { wire: 99, segment: 0 } }, // dangling
          points: [
            [6, 1],
            [4, 1],
          ],
        },
      ],
    };
    const d = deriveNets(circuit);
    expect(d.errors).toHaveLength(1);
    expect(d.errors[0]).toContain("missing wire 99");
    // the healthy wire still derives
    expect(d.nets).toHaveLength(1);
    expect(d.nets[0].wires).toEqual([0]);
  });
});
