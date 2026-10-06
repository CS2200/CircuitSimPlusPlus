import { describe, expect, it } from "vitest";
import { CircuitDocument, removeWiresCascade } from "./document";
import type { CsxDocument } from "./csx";
import { CSX_FORMAT, CSX_VERSION } from "./csx";

/** A small wired circuit: and → not → (junction chain) → ram. */
function fixture() {
  const doc = CircuitDocument.create("test");
  const c = 0;
  const and = doc.addComponent(c, { type: "gate.and", pos: [5, 5] }); // c1
  const not = doc.addComponent(c, { type: "gate.not", pos: [15, 5] }); // c2
  const ram = doc.addComponent(c, { type: "mem.ram", pos: [30, 10], name: "imem" }); // c3
  const w0 = doc.addWire(c, {
    a: { comp: and, pin: "out" },
    b: { comp: not, pin: "in" },
    points: [
      [8, 6],
      [15, 6],
    ],
  });
  const w1 = doc.addWire(c, {
    a: { comp: not, pin: "out" },
    b: { join: { wire: w0, segment: 0 } },
    points: [
      [16, 6],
      [10, 6],
    ],
  });
  const w2 = doc.addWire(c, {
    a: { comp: ram, pin: "addr" },
    b: { join: { wire: w1, segment: 0 } },
    points: [
      [30, 11],
      [16, 6],
    ],
  });
  return { doc, c, and, not, ram, w0, w1, w2 };
}

describe("CircuitDocument.create/fromJson", () => {
  it("creates the v2 envelope with one empty main circuit", () => {
    const doc = CircuitDocument.create("demo");
    expect(doc.data.format).toBe(CSX_FORMAT);
    expect(doc.data.version).toBe(CSX_VERSION);
    expect(doc.data.settings.delayModel).toBe("delay");
    expect(doc.circuits).toHaveLength(1);
    expect(doc.circuit(0)).toEqual({ name: "main", components: [], wires: [] });
    expect(doc.dirty).toBe(false);
  });

  it("round-trips through JSON", () => {
    const { doc } = fixture();
    const back = CircuitDocument.fromJson(doc.toJson());
    expect(back.toJson()).toBe(doc.toJson());
  });

  it("rejects wrong format/version", () => {
    expect(() => CircuitDocument.fromJson(`{"format":"sim","version":1}`)).toThrow("format");
    const bad = { format: CSX_FORMAT, version: 99, circuits: [] };
    expect(() => CircuitDocument.fromJson(JSON.stringify(bad))).toThrow("version");
  });
});

describe("component ops", () => {
  it("allocates unique sequential ids", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(0, { type: "gate.not", pos: [4, 0] });
    expect(a).toBe("c1");
    expect(b).toBe("c2");
    // allocation survives deletions without colliding
    doc.removeComponents(0, new Set([a]));
    expect(doc.addComponent(0, { type: "gate.xor", pos: [8, 0] })).toBe("c3");
  });

  it("moveComponent translates pos and glues attached wire endpoints", () => {
    const { doc, c, and, not, w0, w1 } = fixture();
    doc.moveComponent(c, and, { x: 2, y: 3 });
    const circuit = doc.circuit(c);
    expect(circuit.components.find((x) => x.id === and)?.pos).toEqual([7, 8]);
    // w0's a-side point is glued to the moved component; b-side is not
    expect(circuit.wires[w0].points[0]).toEqual([10, 9]);
    expect(circuit.wires[w0].points[1]).toEqual([15, 6]);
    // w1 is attached to `not`, not `and` — untouched
    expect(circuit.wires[w1].points).toEqual([
      [16, 6],
      [10, 6],
    ]);
    void not;
  });

  it("consecutive moves of the same component coalesce into one undo step", () => {
    const { doc, c, and } = fixture();
    const before = doc.toJson();
    const depth = doc.historyDepth;
    doc.moveComponent(c, and, { x: 1, y: 0 });
    doc.moveComponent(c, and, { x: 1, y: 0 });
    doc.moveComponent(c, and, { x: 0, y: 2 });
    expect(doc.historyDepth).toBe(depth + 1);
    expect(doc.circuit(c).components.find((x) => x.id === and)?.pos).toEqual([7, 7]);
    expect(doc.undo()).toBe(true);
    expect(doc.toJson()).toBe(before);
  });

  it("moves of different components do not coalesce", () => {
    const { doc, c, and, not } = fixture();
    const depth = doc.historyDepth;
    doc.moveComponent(c, and, { x: 1, y: 0 });
    doc.moveComponent(c, not, { x: 1, y: 0 });
    expect(doc.historyDepth).toBe(depth + 2);
  });

  it("removeComponents deletes attached wires with junction cascade", () => {
    const { doc, c, not } = fixture();
    doc.removeComponents(c, new Set([not]));
    const circuit = doc.circuit(c);
    expect(circuit.components.map((x) => x.id)).toEqual(["c1", "c3"]);
    // w0 touches `not`; w1 junctions onto w0; w2 junctions onto w1 → all gone
    expect(circuit.wires).toHaveLength(0);
    expect(doc.undo()).toBe(true);
    expect(doc.circuit(c).wires).toHaveLength(3);
  });
});

describe("wire ops", () => {
  it("rejects invalid wires", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    expect(() =>
      doc.addWire(0, {
        a: { join: { wire: 0, segment: 0 } },
        b: { join: { wire: 0, segment: 0 } },
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toThrow("pin endpoint");
    expect(() =>
      doc.addWire(0, {
        a: { comp: "nope", pin: "out" },
        b: { comp: a, pin: "in" },
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toThrow('missing component "nope"');
    expect(() =>
      doc.addWire(0, {
        a: { comp: a, pin: "out" },
        b: { comp: a, pin: "out" },
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toThrow("back to itself");
    expect(() =>
      doc.addWire(0, {
        a: { comp: a, pin: "out" },
        b: { join: { wire: 99, segment: 0 } },
        points: [
          [0, 0],
          [1, 1],
        ],
      }),
    ).toThrow("missing wire 99");
  });

  it("removeWires cascades through junction chains", () => {
    const { doc, c, w0 } = fixture();
    doc.removeWires(c, new Set([w0]));
    expect(doc.circuit(c).wires).toHaveLength(0); // w1, w2 junctioned on → gone too
    expect(doc.undo()).toBe(true);
    expect(doc.circuit(c).wires).toHaveLength(3);
  });

  it("renumbers survivors' join targets after deletion", () => {
    const doc = CircuitDocument.create();
    const c = 0;
    const a = doc.addComponent(c, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(c, { type: "gate.not", pos: [5, 0] });
    const r = doc.addComponent(c, { type: "mem.ram", pos: [10, 0] });
    doc.addWire(c, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [3, 1],
        [5, 1],
      ],
    }); // w0
    doc.addWire(c, {
      a: { comp: a, pin: "out" },
      b: { comp: r, pin: "addr" },
      points: [
        [3, 1],
        [10, 1],
      ],
    }); // w1
    doc.addWire(c, {
      a: { comp: b, pin: "out" },
      b: { join: { wire: 1, segment: 0 } },
      points: [
        [6, 1],
        [7, 1],
      ],
    }); // w2 → joins w1
    doc.removeWires(c, new Set([0]));
    const wires = doc.circuit(c).wires;
    expect(wires).toHaveLength(2);
    expect(wires[1].b).toEqual({ join: { wire: 0, segment: 0 } }); // renumbered 1→0
  });

  it("updateWirePoints replaces the polyline and coalesces", () => {
    const { doc, c, w0 } = fixture();
    const depth = doc.historyDepth;
    doc.updateWirePoints(c, w0, [
      [8, 6],
      [12, 9],
      [15, 6],
    ]);
    doc.updateWirePoints(c, w0, [
      [8, 6],
      [12, 10],
      [15, 6],
    ]);
    expect(doc.historyDepth).toBe(depth + 1);
    expect(doc.circuit(c).wires[w0].points[1]).toEqual([12, 10]);
    doc.undo();
    expect(doc.circuit(c).wires[w0].points).toEqual([
      [8, 6],
      [15, 6],
    ]);
  });
});

describe("undo/redo invariants", () => {
  it("a mixed op sequence undoes byte-identically and redoes fully", () => {
    const doc = CircuitDocument.create();
    const empty = doc.toJson();
    const c = 0;
    const a = doc.addComponent(c, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(c, { type: "gate.not", pos: [5, 0] });
    doc.addWire(c, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [3, 1],
        [5, 1],
      ],
    });
    doc.moveComponent(c, a, { x: 2, y: 2 });
    doc.removeComponents(c, new Set([b]));
    const final = doc.toJson();

    while (doc.undo()) {
      // walk all the way back
    }
    expect(doc.toJson()).toBe(empty);
    while (doc.redo()) {
      // replay everything
    }
    expect(doc.toJson()).toBe(final);
  });

  it("a new op clears the redo stack", () => {
    const doc = CircuitDocument.create();
    doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    doc.undo();
    expect(doc.canRedo).toBe(true);
    doc.addComponent(0, { type: "gate.not", pos: [5, 0] });
    expect(doc.canRedo).toBe(false);
  });

  it("exposes undo/redo labels for the menu items", () => {
    const doc = CircuitDocument.create();
    doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    expect(doc.peekUndoLabel()).toBe("place gate.and");
    doc.undo();
    expect(doc.peekRedoLabel()).toBe("place gate.and");
  });

  it("fires the history-event hook (provenance journal attach point)", () => {
    const doc = CircuitDocument.create();
    const events: string[] = [];
    doc.onHistoryEvent = (e) => events.push(`${e.kind}:${e.label}`);
    doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    doc.undo();
    doc.redo();
    expect(events).toEqual([
      "execute:place gate.and",
      "undo:place gate.and",
      "redo:place gate.and",
    ]);
  });
});

describe("dirty tracking", () => {
  it("ops mark dirty; markClean resets", () => {
    const doc = CircuitDocument.create();
    expect(doc.dirty).toBe(false);
    doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    expect(doc.dirty).toBe(true);
    doc.markClean();
    expect(doc.dirty).toBe(false);
    doc.undo(); // differs from saved state again
    expect(doc.dirty).toBe(true);
  });

  it("revision increments on execute/undo/redo", () => {
    const doc = CircuitDocument.create();
    const r0 = doc.revision;
    doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    doc.undo();
    doc.redo();
    expect(doc.revision).toBe(r0 + 3);
  });
});

describe("validateStructure (soft, editor-side)", () => {
  it("reports duplicates and dangling references without throwing", () => {
    const bad: CsxDocument = {
      format: CSX_FORMAT,
      version: CSX_VERSION,
      name: "bad",
      settings: { delayModel: "delay", clockHz: 1, delayTable: "t" },
      circuits: [
        {
          name: "main",
          components: [
            { id: "c1", type: "gate.and", pos: [0, 0], name: "x" },
            { id: "c1", type: "gate.not", pos: [4, 0], name: "x" },
          ],
          wires: [
            {
              a: { comp: "ghost", pin: "out" },
              b: { join: { wire: 7, segment: 0 } },
              points: [
                [0, 0],
                [1, 1],
              ],
            },
          ],
        },
      ],
    };
    const errors = CircuitDocument.fromData(bad).validateStructure();
    expect(errors.some((e) => e.includes('duplicate component id "c1"'))).toBe(true);
    expect(errors.some((e) => e.includes('duplicate name "x"'))).toBe(true);
    expect(errors.some((e) => e.includes('missing component "ghost"'))).toBe(true);
    expect(errors.some((e) => e.includes("missing wire 7"))).toBe(true);
  });

  it("a well-formed document validates clean", () => {
    const { doc } = fixture();
    expect(doc.validateStructure()).toEqual([]);
  });
});

describe("removeWiresCascade (pure helper)", () => {
  it("is a no-op for an empty root set", () => {
    const wires = fixture().doc.circuit(0).wires;
    expect(removeWiresCascade(wires, new Set())).toEqual(wires);
  });
});
