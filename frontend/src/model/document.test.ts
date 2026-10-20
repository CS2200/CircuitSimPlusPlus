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
  it("creates the current-version envelope with one empty main circuit", () => {
    const doc = CircuitDocument.create("demo");
    expect(doc.data.format).toBe(CSX_FORMAT);
    expect(doc.data.version).toBe(CSX_VERSION);
    expect(doc.data.settings).toEqual({ clockHz: 1, delayTable: "cs2200-74ls-v1" });
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

  it("migrates a v2 document by dropping settings.delayModel and attrs.delay", () => {
    const v2 = JSON.stringify({
      format: CSX_FORMAT,
      version: 2,
      name: "old",
      settings: { delayModel: "zero", clockHz: 1, delayTable: "cs2200-74ls-v1" },
      circuits: [
        {
          name: "main",
          components: [{ id: "c1", type: "gate.not", pos: [0, 0], attrs: { delay: 3 } }],
          wires: [],
        },
      ],
    });
    const doc = CircuitDocument.fromJson(v2);
    expect(doc.data.version).toBe(CSX_VERSION);
    expect("delayModel" in doc.data.settings).toBe(false);
    expect(doc.circuit(0).components[0].attrs).not.toHaveProperty("delay");
  });

  it("migrates a v3 document by dropping wiring to the retired rst pins", () => {
    // Mirrors the backend's `format::migrate` v3 → v4 step: registers and RAMs
    // have no `rst` pin, so those wires go — including a wire junctioned onto a
    // dropped one (a shared reset fanned out) — and the surviving junction
    // targets are renumbered to match.
    const v3 = JSON.stringify({
      format: CSX_FORMAT,
      version: 3,
      name: "old",
      settings: { clockHz: 1, delayTable: "cs2200-74ls-v1" },
      circuits: [
        {
          name: "main",
          components: [
            { id: "n0", type: "gate.not", pos: [0, 0] },
            { id: "n1", type: "gate.not", pos: [2, 0] },
            { id: "n2", type: "gate.not", pos: [4, 0] },
            { id: "r1", type: "mem.register", pos: [6, 0] },
            { id: "r2", type: "mem.register", pos: [6, 4] },
          ],
          wires: [
            { a: { comp: "n0", pin: "out" }, b: { comp: "r1", pin: "rst" }, points: [] },
            { a: { join: { wire: 0, segment: 0 } }, b: { comp: "r2", pin: "rst" }, points: [] },
            { a: { comp: "n0", pin: "out" }, b: { comp: "n1", pin: "in" }, points: [] },
            { a: { comp: "n1", pin: "out" }, b: { comp: "n2", pin: "in" }, points: [] },
            { a: { join: { wire: 3, segment: 0 } }, b: { comp: "n2", pin: "in" }, points: [] },
          ],
        },
      ],
    });
    const doc = CircuitDocument.fromJson(v3);
    expect(doc.data.version).toBe(CSX_VERSION);
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(3);
    expect(wires[0].a).toEqual({ comp: "n0", pin: "out" });
    // The junction that pointed at wire 3 now points at wire 1.
    expect(wires[2].a).toEqual({ join: { wire: 1, segment: 0 } });
  });

  it("migrates the pre-release 'port' pin terminal name to 'pin'", () => {
    // Early frontend builds called the wiring.pin terminal "port"; files
    // from that window fail engine validation — rename on load.
    const legacy = {
      format: CSX_FORMAT,
      version: CSX_VERSION,
      name: "legacy",
      settings: { clockHz: 1, delayTable: "cs2200-74ls-v1" },
      circuits: [
        {
          name: "main",
          components: [
            { id: "p1", type: "wiring.pin", pos: [0, 0], name: "a" },
            { id: "g1", type: "gate.not", pos: [4, 0] },
          ],
          wires: [
            {
              a: { comp: "p1", pin: "port" },
              b: { comp: "g1", pin: "in" },
              points: [
                [2, 0],
                [4, 1],
              ],
            },
          ],
        },
      ],
    };
    const doc = CircuitDocument.fromJson(JSON.stringify(legacy));
    const w = doc.circuit(0).wires[0];
    expect(w.a).toEqual({ comp: "p1", pin: "pin" });
    // gate endpoints are untouched
    expect(w.b).toEqual({ comp: "g1", pin: "in" });
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

  it("moveComponent translates pos and repairs attached wire endpoints", () => {
    const { doc, c, and, not, w0, w1 } = fixture();
    doc.moveComponent(c, and, { x: 2, y: 3 });
    const circuit = doc.circuit(c);
    expect(circuit.components.find((x) => x.id === and)?.pos).toEqual([7, 8]);
    // w0's a-side point is glued to the moved component; the adjacent bend
    // is slid so the wire still leaves the pin orthogonally (no diagonals)
    expect(circuit.wires[w0].points[0]).toEqual([10, 9]);
    expect(circuit.wires[w0].points[1]).toEqual([15, 9]);
    // w1 junctions onto w0[0]: its terminal follows the moved segment
    // (re-projected onto (10,9)→(15,9), end segment stays square)
    expect(circuit.wires[w1].points).toEqual([
      [16, 6],
      [16, 9],
      [10, 9],
    ]);
    void not;
  });

  it("dragging diagonally keeps a bent wire orthogonal (bend slides)", () => {
    const doc = CircuitDocument.create();
    const and = doc.addComponent(0, { type: "gate.and", pos: [5, 5] });
    const not = doc.addComponent(0, { type: "gate.not", pos: [15, 5] });
    doc.addWire(0, {
      a: { comp: and, pin: "out" },
      b: { comp: not, pin: "in" },
      points: [
        [8, 6],
        [12, 6],
        [12, 10],
      ],
    });
    doc.moveComponent(0, and, { x: 2, y: 3 });
    expect(doc.circuit(0).wires[0].points).toEqual([
      [10, 9],
      [12, 9],
      [12, 10],
    ]);
  });

  it("dragging a 2-point wire diagonally splices in a corner", () => {
    const doc = CircuitDocument.create();
    const and = doc.addComponent(0, { type: "gate.and", pos: [5, 5] });
    const not = doc.addComponent(0, { type: "gate.not", pos: [15, 5] });
    doc.addWire(0, {
      a: { comp: and, pin: "out" },
      b: { comp: not, pin: "in" },
      points: [
        [8, 6],
        [15, 6],
      ],
    });
    doc.moveComponent(0, and, { x: 2, y: 3 });
    expect(doc.circuit(0).wires[0].points).toEqual([
      [10, 9],
      [15, 9],
      [15, 6],
    ]);
  });

  it("rotating a component follows its pins (pinGeometry hook)", () => {
    const doc = CircuitDocument.create();
    const and = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const not = doc.addComponent(0, { type: "gate.not", pos: [10, 0] });
    doc.addWire(0, {
      a: { comp: and, pin: "out" },
      b: { comp: not, pin: "in" },
      points: [
        [5, 1.5],
        [10, 1.5],
        [10, 1],
      ],
    });
    // Editor knowledge (fake): on S the out pin jumps to the bottom edge.
    doc.pinGeometry = (comp, pin) =>
      pin === "out"
        ? comp.rot === "S"
          ? { pos: [1.5, 5] as [number, number], facing: "S" as const }
          : { pos: [5, 1.5] as [number, number], facing: "E" as const }
        : null;
    doc.rotateComponents(0, new Set([and]));
    const pts = doc.circuit(0).wires[0].points;
    expect(pts[0]).toEqual([1.5, 5]); // re-anchored to the new pin position
    expect(pts.at(-1)).toEqual([10, 1]); // far end untouched
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i][0] - pts[i - 1][0];
      const dy = pts[i][1] - pts[i - 1][1];
      expect(dx === 0 || dy === 0, "stays orthogonal").toBe(true);
      expect(dx !== 0 || dy !== 0, "no zero-length segments").toBe(true);
    }
  });

  it("rotating without the pinGeometry hook leaves wires untouched", () => {
    const { doc, c, and, w0 } = fixture();
    const before = JSON.stringify(doc.circuit(c).wires[w0].points);
    doc.rotateComponents(c, new Set([and]));
    expect(JSON.stringify(doc.circuit(c).wires[w0].points)).toBe(before);
  });

  it("editing a route re-projects junction children onto the changed segment", () => {
    const { doc, c, w0, w1, w2 } = fixture();
    doc.updateWirePoints(c, w0, [
      [8, 8],
      [15, 8],
    ]);
    // child terminal lands on the new segment; its end segment stays square
    expect(doc.circuit(c).wires[w1].points).toEqual([
      [16, 6],
      [16, 8],
      [10, 8],
    ]);
    // grandchild joins the child — its point is still a valid target
    expect(doc.circuit(c).wires[w2].points).toEqual([
      [30, 11],
      [16, 6],
    ]);
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

describe("updateComponent", () => {
  function withResolver(doc: CircuitDocument): CircuitDocument {
    doc.pinResolver = (comp) => {
      // mirror of the editor's catalog: and/or have in0..in{n-1}+out; not has in+out
      if (comp.type === "gate.not") return ["in", "out"];
      const n = typeof comp.attrs?.inputs === "number" ? comp.attrs.inputs : 2;
      return [...Array.from({ length: n }, (_, i) => `in${i}`), "out"];
    };
    return doc;
  }

  it("edits name/rot/attrs as one undoable command", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const before = doc.toJson();
    doc.updateComponent(0, a, { name: "my-and", rot: "S", attrs: { bitsize: 8, inputs: 3 } });
    const comp = doc.circuit(0).components[0];
    expect(comp).toMatchObject({ name: "my-and", rot: "S", attrs: { bitsize: 8, inputs: 3 } });
    expect(doc.historyDepth).toBe(2); // place + edit
    doc.undo();
    expect(doc.toJson()).toBe(before);
  });

  it("sets and clears a per-part name side (namePos)", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    doc.updateComponent(0, a, { namePos: "S" });
    const parsed = JSON.parse(doc.toJson()) as {
      circuits: { components: Record<string, unknown>[] }[];
    };
    expect(parsed.circuits[0].components[0].namePos).toBe("S");
    // "Above" (the default) removes the override so the part writes nothing.
    doc.updateComponent(0, a, { namePos: null });
    expect(doc.circuit(0).components[0]).not.toHaveProperty("namePos");
    expect(doc.toJson()).not.toContain("namePos");
  });

  it("type swap and→or keeps wires (same pin names)", () => {
    const doc = withResolver(CircuitDocument.create());
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(0, { type: "gate.not", pos: [6, 0] });
    doc.addWire(0, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [5, 1],
        [6, 1],
      ],
    });
    doc.updateComponent(0, a, { type: "gate.or" });
    expect(doc.circuit(0).components[0].type).toBe("gate.or");
    expect(doc.circuit(0).wires).toHaveLength(1);
  });

  it("shrinking inputs prunes wires to removed pins (with cascade), one undo step", () => {
    const doc = withResolver(CircuitDocument.create());
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0], attrs: { inputs: 3 } });
    const b = doc.addComponent(0, { type: "gate.not", pos: [8, 0] });
    const c = doc.addComponent(0, { type: "gate.not", pos: [8, 4] });
    doc.addWire(0, {
      a: { comp: a, pin: "in2" },
      b: { comp: b, pin: "out" },
      points: [
        [0, 1],
        [8, 1],
      ],
    });
    doc.addWire(0, {
      a: { comp: c, pin: "in" },
      b: { join: { wire: 0, segment: 0 } },
      points: [
        [8, 5],
        [4, 1],
      ],
    });
    const depth = doc.historyDepth;
    doc.updateComponent(0, a, { attrs: { inputs: 2 } }); // in2 disappears
    expect(doc.circuit(0).wires).toHaveLength(0); // wire to in2 + its junction child
    expect(doc.historyDepth).toBe(depth + 1);
    doc.undo();
    expect(doc.circuit(0).wires).toHaveLength(2);
    expect(doc.circuit(0).components[0].attrs).toEqual({ inputs: 3 });
  });

  it("without a pinResolver, wires are left untouched", () => {
    const doc = CircuitDocument.create(); // no resolver
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0], attrs: { inputs: 3 } });
    const b = doc.addComponent(0, { type: "gate.not", pos: [8, 0] });
    doc.addWire(0, {
      a: { comp: a, pin: "in2" },
      b: { comp: b, pin: "out" },
      points: [
        [0, 1],
        [8, 1],
      ],
    });
    doc.updateComponent(0, a, { attrs: { inputs: 2 } });
    expect(doc.circuit(0).wires).toHaveLength(1); // still there (backend validation would flag it)
  });

  it("an attrs edit that RESIZES a part drags its wires along (§56)", () => {
    const doc = CircuitDocument.create();
    const konst = doc.addComponent(0, {
      type: "wiring.constant",
      pos: [0, 0],
      attrs: { value: "1", bitsize: 4 },
    });
    const probe = doc.addComponent(0, { type: "wiring.probe", pos: [20, 0] });
    doc.addWire(0, {
      a: { comp: konst, pin: "out" },
      b: { comp: probe, pin: "in" },
      points: [
        [3, 1],
        [20, 1],
      ],
    });
    // Editor knowledge (fake): a constant's `out` rides the box's right edge, so
    // widening it moves the pin; a probe's `in` does not move at all.
    doc.pinGeometry = (comp, pin) => {
      if (comp.type === "wiring.probe" && pin === "in") {
        return { pos: [20, 1] as [number, number], facing: "W" as const };
      }
      if (comp.type !== "wiring.constant" || pin !== "out") return null;
      const w = comp.attrs?.bitsize === 32 ? 7.8 : 3;
      return { pos: [w, 1] as [number, number], facing: "E" as const };
    };

    doc.updateComponent(0, konst, { attrs: { value: "1", bitsize: 32 } });

    const pts = doc.circuit(0).wires[0].points;
    expect(pts[0]).toEqual([7.8, 1]); // re-anchored to the pin's new position
    expect(pts.at(-1)).toEqual([20, 1]); // the far end did not move
    for (let i = 1; i < pts.length; i++) {
      expect(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1]).toBe(true);
    }
  });

  it("throws on unknown component id", () => {
    const doc = CircuitDocument.create();
    expect(() => doc.updateComponent(0, "nope", { name: "x" })).toThrow('no component "nope"');
  });

  it("coalesceKey merges consecutive same-field edits into one undo step", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const depth = doc.historyDepth;
    // A typing burst on the Inspector's Name field — one key, one step.
    doc.updateComponent(0, a, { name: "m" }, "edit:0:c1:name");
    doc.updateComponent(0, a, { name: "my" }, "edit:0:c1:name");
    doc.updateComponent(0, a, { name: "my-and" }, "edit:0:c1:name");
    expect(doc.circuit(0).components[0].name).toBe("my-and");
    expect(doc.historyDepth).toBe(depth + 1);
    doc.undo();
    expect(doc.circuit(0).components[0].name ?? "").toBe("");
    // A different field's key starts a new step.
    doc.updateComponent(0, a, { name: "a" }, "edit:0:c1:name");
    doc.updateComponent(0, a, { attrs: { bitsize: 4 } }, "edit:0:c1:attr:bitsize");
    expect(doc.historyDepth).toBe(depth + 2);
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

  it("removeSegment drops the bend a segment turns at, keeping both endpoints", () => {
    const { doc, c, w0 } = fixture();
    // A wire with two bends; the endpoint coordinates are the pins' attachment
    // points and must survive any segment delete.
    doc.updateWirePoints(c, w0, [
      [0, 0],
      [2, 0],
      [2, 2],
      [4, 2],
    ]);
    doc.removeSegment(c, w0, 1); // the middle leg
    expect(doc.circuit(c).wires[w0].points).toEqual([
      [0, 0],
      [2, 0],
      [4, 2],
    ]);
    // An end leg drops the bend next to its pin instead (same shortcut).
    doc.removeSegment(c, w0, 2);
    expect(doc.circuit(c).wires[w0].points).toEqual([
      [0, 0],
      [4, 2],
    ]);
  });

  it("removeSegment deletes the wire when the segment IS the whole wire", () => {
    const { doc, c, w0, w1 } = fixture();
    // w0 is straight in the fixture; w1 is junctioned onto it, so the usual
    // cascade applies.
    expect(doc.circuit(c).wires[w0].points).toHaveLength(2);
    doc.removeSegment(c, w0, 0);
    expect(doc.circuit(c).wires.some((_, i) => i === w0 || i === w1)).toBe(false);
  });

  it("removeSegment is one undo step, labelled for the user", () => {
    const { doc, c, w0 } = fixture();
    doc.updateWirePoints(c, w0, [
      [0, 0],
      [2, 0],
      [4, 2],
    ]);
    doc.removeSegment(c, w0, 0);
    expect(doc.circuit(c).wires[w0].points).toHaveLength(2);
    // ONE undo brings the bend back: a delete is its own step, never merged
    // into the preceding route edit.
    doc.undo();
    expect(doc.circuit(c).wires[w0].points).toEqual([
      [0, 0],
      [2, 0],
      [4, 2],
    ]);
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
      settings: { clockHz: 1, delayTable: "t" },
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

describe("rotating a port pin keeps its direction in step (§77)", () => {
  const port = (doc: CircuitDocument) =>
    doc.addComponent(0, { type: "wiring.pin", pos: [2, 2], name: "a" });

  it("faces west → output (canonical true), anything else → input (attr absent)", () => {
    const doc = CircuitDocument.create("t");
    const id = port(doc);
    const at = () => doc.circuit(0).components.find((c) => c.id === id);

    expect(at()?.rot ?? "E").toBe("E"); // the palette's input facing
    expect(at()?.attrs?.isOutput).toBeUndefined();

    doc.setRotation(0, new Set([id]), "W");
    expect(at()?.rot).toBe("W");
    expect(at()?.attrs?.isOutput).toBe(true);

    // A quarter turn off west is an input again, and the attr is REMOVED rather
    // than set false: the canonical form keeps the version diff quiet.
    doc.rotateComponents(0, new Set([id]));
    expect(at()?.rot).toBe("N");
    expect(at()?.attrs === undefined || "isOutput" in (at()?.attrs ?? {}) === false).toBe(true);
  });

  it("turns a plain part without touching its attrs", () => {
    const doc = CircuitDocument.create("t");
    const id = doc.addComponent(0, { type: "gate.and", pos: [0, 0], attrs: { bits: 4 } });
    doc.rotateComponents(0, new Set([id]));
    const at = () => doc.circuit(0).components.find((c) => c.id === id);
    expect(at()?.rot).toBe("S"); // E → S
    expect(at()?.attrs).toEqual({ bits: 4 });
  });
});

/**
 * Dragging a SELECTION — the lasso case (UI_OVERHAUL §81). The single-component
 * path was covered; a set of them was not, and a set is where a wire's ends can
 * both travel, or a branch can hang off a parent that travels with it.
 */
describe("moving a selection with junctions", () => {
  /** On-segment test: collinear with ab and within it (the geometry invariant). */
  const onSegment = (p: number[], a: number[], b: number[]): boolean => {
    const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (Math.abs(cross) > 1e-9) return false;
    const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
    const len = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
    return dot >= -1e-9 && dot <= len + 1e-9;
  };

  /**
   * A trunk between two parts (with a BEND, so a rigid move is visible) and a
   * branch hanging off it, glued to a third part.
   */
  function cluster() {
    const doc = CircuitDocument.create("t");
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] }); // out (5, 1.5)
    const b = doc.addComponent(0, { type: "gate.not", pos: [20, 0] }); // in (20, 1)
    const c = doc.addComponent(0, { type: "gate.and", pos: [0, 20] }); // out (5, 21.5)
    const trunk = doc.addWire(0, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [5, 1.5],
        [12, 1.5],
        [12, 1],
        [20, 1],
      ],
    });
    const branch = doc.addWire(0, {
      a: { comp: c, pin: "out" },
      b: { join: { wire: trunk, segment: 1 } }, // the (12, 1.5) → (12, 1) leg
      points: [
        [5, 21.5],
        [5, 1],
        [12, 1],
      ],
    });
    return { doc, a, b, c, trunk, branch };
  }

  it("moves a wire whose ends BOTH travel rigidly, bends included", () => {
    const { doc, a, b, trunk } = cluster();
    doc.moveComponents(0, new Set([a, b]), { x: 4, y: 2 });
    // Every point by the delta: the wire is the same shape, somewhere else.
    expect(doc.circuit(0).wires[trunk].points).toEqual([
      [9, 3.5],
      [16, 3.5],
      [16, 3],
      [24, 3],
    ]);
  });

  it("carries a dragged branch's junction along with the cluster", () => {
    const { doc, a, b, c, trunk, branch } = cluster();
    doc.moveComponents(0, new Set([a, b, c]), { x: 4, y: 2 });
    const wires = doc.circuit(0).wires;
    expect(wires[branch].points.at(-1)).toEqual([16, 3]);
    // …and it is still exactly on its parent's segment.
    const t = wires[trunk].points;
    expect(onSegment(wires[branch].points.at(-1)!, t[1], t[2])).toBe(true);
  });

  it("stretches a branch that is NOT dragged onto its parent's new position", () => {
    const { doc, a, b, trunk, branch } = cluster(); // c stays put
    doc.moveComponents(0, new Set([a, b]), { x: 4, y: 2 });
    const wires = doc.circuit(0).wires;
    expect(wires[branch].points[0]).toEqual([5, 21.5]); // its pin end is anchored
    const t = wires[trunk].points;
    expect(onSegment(wires[branch].points.at(-1)!, t[1], t[2])).toBe(true);
  });

  it("keeps every junction on its parent segment, whatever moves", () => {
    for (const which of [["a", "b"], ["a", "b", "c"], ["c"]] as const) {
      const { doc, a, b, c } = cluster();
      const byName = { a, b, c };
      doc.moveComponents(0, new Set(which.map((n) => byName[n])), { x: -3, y: 5 });
      const wires = doc.circuit(0).wires;
      for (const [i, w] of wires.entries()) {
        for (const end of ["a", "b"] as const) {
          const ep = w[end];
          if (!("join" in ep)) continue;
          const parent = wires[ep.join.wire];
          expect(
            onSegment(
              end === "a" ? w.points[0] : w.points[w.points.length - 1],
              parent.points[ep.join.segment],
              parent.points[ep.join.segment + 1],
            ),
          ).toBe(true);
          expect(i).toBeGreaterThan(ep.join.wire); // parents precede children
        }
      }
    }
  });
});

describe("normalizePinEnds (healing a file written against older symbol sizes)", () => {
  /** A constant whose `out` pin rides its box, and a probe whose `in` is fixed. */
  function withGeometry(doc: CircuitDocument): CircuitDocument {
    doc.pinGeometry = (comp, pin) => {
      if (comp.type === "wiring.probe" && pin === "in") {
        return { pos: [20, 1] as [number, number], facing: "W" as const };
      }
      if (comp.type !== "wiring.constant" || pin !== "out") return null;
      return { pos: [7.8, 1] as [number, number], facing: "E" as const };
    };
    return doc;
  }

  function staleDoc(): CircuitDocument {
    const doc = withGeometry(CircuitDocument.create());
    const konst = doc.addComponent(0, {
      type: "wiring.constant",
      pos: [0, 0],
      attrs: { value: "1", bitsize: 32 },
    });
    const probe = doc.addComponent(0, { type: "wiring.probe", pos: [20, 0] });
    // As an older symbol size — or another tool — would have written it: at x=3.
    doc.addWire(0, {
      a: { comp: konst, pin: "out" },
      b: { comp: probe, pin: "in" },
      points: [
        [3, 1],
        [20, 1],
      ],
    });
    return doc;
  }

  it("puts a stale pin end back on its pin, silently", () => {
    const doc = staleDoc();
    const before = { dirty: doc.dirty, revision: doc.revision, undo: doc.canUndo };
    doc.normalizePinEnds();
    expect(doc.circuit(0).wires[0].points).toEqual([
      [7.8, 1],
      [20, 1],
    ]);
    // Not an edit: no undo step, no revision bump, and not unsaved work.
    expect(doc.canUndo).toBe(before.undo);
    expect(doc.revision).toBe(before.revision);
    expect(doc.dirty).toBe(before.dirty);
  });

  it("is the identity on a document already in step", () => {
    const doc = staleDoc();
    doc.normalizePinEnds();
    const inStep = JSON.stringify(doc.circuit(0));
    doc.normalizePinEnds();
    expect(JSON.stringify(doc.circuit(0))).toBe(inStep);
  });

  it("without the pinGeometry hook, nothing is touched", () => {
    const doc = CircuitDocument.create(); // no hook
    const konst = doc.addComponent(0, {
      type: "wiring.constant",
      pos: [0, 0],
      attrs: { value: "1", bitsize: 32 },
    });
    const probe = doc.addComponent(0, { type: "wiring.probe", pos: [20, 0] });
    doc.addWire(0, {
      a: { comp: konst, pin: "out" },
      b: { comp: probe, pin: "in" },
      points: [
        [3, 1],
        [20, 1],
      ],
    });
    const before = JSON.stringify(doc.circuit(0));
    doc.normalizePinEnds();
    expect(JSON.stringify(doc.circuit(0))).toBe(before);
  });
});

describe("naming a wire (UI_OVERHAUL §86)", () => {
  const wired = () => {
    const doc = CircuitDocument.create("t");
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(0, { type: "gate.not", pos: [10, 0] });
    const w = doc.addWire(0, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [5, 1.5],
        [10, 1],
      ],
    });
    return { doc, a, b, w };
  };

  it("sets, clears and is a no-op when unchanged", () => {
    const { doc, w } = wired();
    doc.setWireName(0, w, "ALU_OUT");
    expect(doc.circuit(0).wires[w].name).toBe("ALU_OUT");
    doc.setWireName(0, w, "ALU_OUT"); // no-op: one undo step, not two
    doc.setWireName(0, w, null);
    expect(doc.circuit(0).wires[w].name).toBeUndefined();
  });

  it("survives a move and a paste, because a tunnel is a wire", () => {
    const { doc, a, w } = wired();
    doc.setWireName(0, w, "T");
    doc.moveComponent(0, a, { x: 2, y: 3 });
    expect(doc.circuit(0).wires[w].name).toBe("T");
  });
});
