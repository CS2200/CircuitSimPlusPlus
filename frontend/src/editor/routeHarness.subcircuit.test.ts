import { describe, expect, it } from "vitest";
import {
  buildHarness,
  errors,
  lcg,
  report,
  runScript,
  type Harness,
  type HarnessStep,
} from "./routeHarness";
import { compLayout } from "./layout";

type Vec2 = { x: number; y: number };

const click = (at: string | Vec2): HarnessStep => ({ kind: "click", at });

function clean(h: Harness, steps: HarnessStep[]): void {
  runScript(h, steps);
  const bad = errors(h);
  expect(bad.length, bad.length ? report(h, bad) : "").toBe(0);
}

/**
 * Define a sheet `name` with the given ports, then drop an instance of it into
 * `main`. Returns the sheet index, the instance id, and the port component ids.
 */
function define(
  h: Harness,
  name: string,
  ports: { name: string; isOutput?: boolean }[],
): { idx: number; inst: string; pinIds: string[] } {
  const idx = h.addCircuit(name);
  const pinIds = ports.map((p) =>
    h.doc.addComponent(idx, {
      type: "wiring.pin",
      pos: [0, 0],
      name: p.name,
      attrs: p.isOutput ? { isOutput: true, bitsize: 1 } : { bitsize: 1 },
    }),
  );
  h.switchTo(0);
  const inst = h.doc.addComponent(0, {
    type: "subcircuit",
    pos: [12, 10],
    attrs: { circuit: name },
  });
  h.switchTo(0);
  return { idx, inst, pinIds };
}

function center(h: Harness, id: string): Vec2 {
  const c = h.circuit().components.find((x) => x.id === id)!;
  const r = compLayout(c, h.doc.circuits).rect;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function compCenter(h: Harness, circuitIdx: number, id: string): Vec2 {
  const c = h.doc.circuit(circuitIdx).components.find((x) => x.id === id)!;
  const r = compLayout(c, h.doc.circuits).rect;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

function twoGates(): Harness {
  return buildHarness({
    components: [
      { type: "gate.and", pos: [30, 10] },
      { type: "gate.not", pos: [30, 20] },
    ],
  });
}

describe("subcircuits — instance ports", () => {
  it("wires an instance's input and output ports", () => {
    const h = twoGates();
    const [and, not] = h.ids;
    const { inst } = define(h, "sub", [{ name: "a" }, { name: "y", isOutput: true }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    clean(h, [click(`${inst}.y`), click(`${not}.in`)]);
    expect(h.wires()).toHaveLength(2);
  });

  it("renaming a definition's port rewrites the parent's wire", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { idx, inst, pinIds } = define(h, "sub", [{ name: "a" }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    expect(h.wires()[0].b).toEqual({ comp: inst, pin: "a" });
    h.doc.updateComponent(idx, pinIds[0], { name: "x" });
    h.scene.sync(h.doc, 0);
    expect(h.wires()[0].b).toEqual({ comp: inst, pin: "x" });
    expect(errors(h)).toEqual([]);
  });

  it("clearing a port name drops the wires that reached it", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { idx, inst, pinIds } = define(h, "sub", [{ name: "a" }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    h.doc.updateComponent(idx, pinIds[0], { name: "" });
    h.scene.sync(h.doc, 0);
    expect(h.wires()).toHaveLength(0);
    expect(errors(h)).toEqual([]);
  });

  it("rotating and moving the instance re-anchors its wires", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { inst } = define(h, "sub", [{ name: "a" }, { name: "y", isOutput: true }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    const c = center(h, inst);
    clean(h, [
      click(c),
      { kind: "rotate" },
      { kind: "down", at: c },
      { kind: "move", at: { x: c.x + 6, y: c.y + 4 } },
      { kind: "up", at: { x: c.x + 6, y: c.y + 4 } },
    ]);
  });

  it("copies and pastes an instance, keeping names unique", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { inst } = define(h, "sub", [{ name: "a" }, { name: "y", isOutput: true }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    runScript(h, [{ kind: "selectAll" }, { kind: "copy" }, { kind: "paste" }]);
    expect(h.doc.validateStructure()).toEqual([]);
    expect(errors(h)).toEqual([]);
  });
});

describe("subcircuits — nesting", () => {
  it("instantiates a sheet that itself contains an instance", () => {
    const h = twoGates();
    const [and] = h.ids;
    // inner sheet with one output port
    const inner = h.addCircuit("inner");
    h.doc.addComponent(inner, {
      type: "wiring.pin",
      pos: [0, 0],
      name: "o",
      attrs: { isOutput: true, bitsize: 1 },
    });
    // mid sheet: an instance of inner, exposed through a port
    const mid = h.addCircuit("mid");
    h.doc.addComponent(mid, { type: "subcircuit", pos: [4, 4], attrs: { circuit: "inner" } });
    h.doc.addComponent(mid, { type: "wiring.pin", pos: [0, 0], name: "m", attrs: { bitsize: 1 } });
    h.switchTo(0);
    // main: an instance of mid, wired from a gate
    const inst = h.doc.addComponent(0, {
      type: "subcircuit",
      pos: [12, 10],
      attrs: { circuit: "mid" },
    });
    h.switchTo(0);
    clean(h, [click(`${and}.out`), click(`${inst}.m`)]);
    expect(errors(h)).toEqual([]);
    expect(h.doc.validateStructure()).toEqual([]);
  });

  it("instantiates three levels deep", () => {
    const h = twoGates();
    const [and] = h.ids;
    // leaf: one input, one output
    const leaf = h.addCircuit("leaf");
    h.doc.addComponent(leaf, { type: "wiring.pin", pos: [0, 0], name: "i", attrs: { bitsize: 1 } });
    h.doc.addComponent(leaf, {
      type: "wiring.pin",
      pos: [0, 0],
      name: "o",
      attrs: { isOutput: true, bitsize: 1 },
    });
    const wrap = h.addCircuit("wrap");
    h.doc.addComponent(wrap, { type: "subcircuit", pos: [4, 4], attrs: { circuit: "leaf" } });
    h.doc.addComponent(wrap, {
      type: "wiring.pin",
      pos: [0, 0],
      name: "wi",
      attrs: { bitsize: 1 },
    });
    h.doc.addComponent(wrap, {
      type: "wiring.pin",
      pos: [0, 0],
      name: "wo",
      attrs: { isOutput: true, bitsize: 1 },
    });
    h.switchTo(0);
    const top = h.doc.addComponent(0, {
      type: "subcircuit",
      pos: [12, 10],
      attrs: { circuit: "wrap" },
    });
    h.switchTo(0);
    clean(h, [click(`${and}.out`), click(`${top}.wi`)]);
    expect(errors(h)).toEqual([]);
  });
});

describe("subcircuits — placement edges", () => {
  it("rotates an instance to N and wires the moved ports", () => {
    const h = twoGates();
    const [and, not] = h.ids;
    const { inst } = define(h, "sub", [{ name: "a" }, { name: "y", isOutput: true }]);
    clean(h, [click(center(h, inst)), { kind: "rotate" }, { kind: "rotate" }]); // → S → W … to N
    clean(h, [click(center(h, inst)), { kind: "rotate" }]); // ensure a facing was applied
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    clean(h, [click(`${inst}.y`), click(`${not}.in`)]);
    expect(errors(h)).toEqual([]);
  });

  it("junctions onto a wire that ends on an instance port, then moves the instance", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { inst } = define(h, "sub", [{ name: "a" }, { name: "y", isOutput: true }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    // branch onto the wire from a fresh gate
    const extra = h.doc.addComponent(0, { type: "gate.or", pos: [30, 16] });
    h.switchTo(0);
    const mid = { x: 20, y: 12 };
    clean(h, [click(`${extra}.out`), click(mid), click(mid)]);
    const c = center(h, inst);
    clean(h, [
      click(c),
      { kind: "down", at: c },
      { kind: "move", at: { x: c.x + 5, y: c.y - 3 } },
      { kind: "up", at: { x: c.x + 5, y: c.y - 3 } },
    ]);
  });
});

describe("subcircuits — cross-circuit clipboard", () => {
  it("pastes a copied cluster into another sheet", () => {
    const h = twoGates();
    const [and, not] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    runScript(h, [{ kind: "selectAll" }, { kind: "copy" }]);
    const sub = h.addCircuit("sub");
    h.switchTo(sub);
    runScript(h, [{ kind: "paste" }]);
    expect(h.circuit().components.length).toBeGreaterThan(0);
    expect(h.doc.validateStructure()).toEqual([]);
    expect(errors(h)).toEqual([]);
  });

  it("moves a multi-selected wired pair as a rigid unit", () => {
    const h = twoGates();
    const [and, not] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    const ca = center(h, and);
    const cn = center(h, not);
    clean(h, [
      click(ca),
      { kind: "click", at: cn, shift: true },
      { kind: "down", at: ca },
      { kind: "move", at: { x: ca.x - 4, y: ca.y + 2 } },
      { kind: "up", at: { x: ca.x - 4, y: ca.y + 2 } },
    ]);
  });
});

describe("subcircuits — switching sheets mid-wire", () => {
  it("does not attach the wire to a same-id part in the new sheet", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and] = h.ids; // 'c1' in main
    const sub = h.addCircuit("sub");
    // Same ids recur in the new sheet: c1 (with an 'out') and c2 (with an 'in').
    h.doc.addComponent(sub, { type: "gate.or", pos: [10, 10] });
    const subNot = h.doc.addComponent(sub, { type: "gate.not", pos: [20, 10] });
    h.switchTo(0);
    runScript(h, [click(`${and}.out`)]); // start a wire in main
    h.switchTo(sub); // switch sheets WHILE wiring
    runScript(h, [click(`${subNot}.in`)]); // finish — must not wire the new sheet
    expect(h.doc.circuit(sub).wires).toHaveLength(0);
    expect(h.doc.circuit(0).wires).toHaveLength(0);
  });
});

describe("parts — fan-out, distance, splitters, sheet clocks", () => {
  it("fans many wires out of one pin", () => {
    const h = buildHarness({
      components: [
        { type: "gate.buffer", pos: [10, 10] },
        { type: "gate.not", pos: [22, 8] },
        { type: "gate.not", pos: [22, 13] },
        { type: "gate.not", pos: [22, 18] },
      ],
    });
    const [src, a, b, c] = h.ids;
    clean(h, [click(`${src}.out`), click(`${a}.in`)]);
    clean(h, [click(`${src}.out`), click(`${b}.in`)]);
    clean(h, [click(`${src}.out`), click(`${c}.in`)]);
    expect(h.wires()).toHaveLength(3);
  });

  it("routes between pins hundreds of units apart", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [0, 0] },
        { type: "gate.not", pos: [400, 300] },
      ],
    });
    const [and, not] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
  });

  it("wires a splitter's pins to gates", () => {
    const h = buildHarness({
      components: [
        { type: "wiring.splitter", pos: [10, 10] },
        { type: "gate.not", pos: [24, 6] },
        { type: "gate.not", pos: [24, 18] },
      ],
    });
    const [sp, a, b] = h.ids;
    const spPins = h.pins().filter((p) => p.compId === sp);
    expect(spPins.length).toBeGreaterThanOrEqual(2);
    clean(h, [click(`${a}.out`), click(spPins[0].ref)]);
    clean(h, [click(spPins[1].ref), click(`${b}.in`)]);
  });

  it("placing a register inside a sheet creates CLK/RST ports and wires them", () => {
    const h = twoGates();
    const sub = h.addCircuit("sub");
    h.switchTo(sub);
    runScript(h, [{ kind: "place", type: "mem.register", at: { x: 20, y: 12 } }]);
    const names = h
      .circuit()
      .components.filter((c) => c.type === "wiring.pin")
      .map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["CLK", "RST"]));
    expect(errors(h)).toEqual([]);
    expect(h.doc.validateStructure()).toEqual([]);
    for (const w of h.wires()) {
      for (let s = 0; s + 1 < w.points.length; s++) {
        const [ax, ay] = w.points[s];
        const [bx, by] = w.points[s + 1];
        expect(ax !== bx || ay !== by, "no zero-length auto-wire segment").toBe(true);
      }
    }
  });
});

describe("subcircuits — fuzz", () => {
  it("random definitions + wiring + port edits hold every invariant", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      const rnd = lcg(seed);
      const h = buildHarness({
        components: [
          { type: "gate.and", pos: [30, 10] },
          { type: "gate.not", pos: [30, 20] },
        ],
      });
      const [and, not] = h.ids;
      const n = 1 + Math.floor(rnd() * 3);
      const ports: { name: string; isOutput?: boolean }[] = [];
      for (let i = 0; i < n; i++) ports.push({ name: `p${i}`, isOutput: rnd() < 0.5 });
      ports[0] = { name: ports[0].name, isOutput: false }; // at least one input
      ports[ports.length - 1] = { name: ports[ports.length - 1].name, isOutput: true }; // and one output
      const { idx, inst, pinIds } = define(h, "sub", ports);

      const instPins = h.pins().filter((p) => p.compId === inst);
      const input = instPins.find((p) => p.facing === "W");
      const output = instPins.find((p) => p.facing === "E");
      if (input !== undefined) clean(h, [click(`${and}.out`), click(`${input.ref}`)]);
      if (output !== undefined) clean(h, [click(`${output.ref}`), click(`${not}.in`)]);

      // Sometimes edit the definition afterwards; the parent must stay valid.
      const r = rnd();
      if (r < 0.4 && pinIds.length > 0) {
        h.doc.updateComponent(idx, pinIds[0], { name: `q${Math.floor(rnd() * 3)}` });
        h.scene.sync(h.doc, 0);
      } else if (r < 0.6 && pinIds.length > 0) {
        h.doc.updateComponent(idx, pinIds[0], { name: "" });
        h.scene.sync(h.doc, 0);
      }

      const bad = errors(h);
      const structural = h.doc.validateStructure();
      if (bad.length > 0 || structural.length > 0) {
        failures.push(
          `seed ${seed}: ${bad.map((v) => v.message).join("; ")} ${structural.join("; ")}`,
        );
      }
    }
    expect(failures.slice(0, 5).join("\n")).toBe("");
  });
});

describe("subcircuits — editing an instantiated definition", () => {
  it("deleting a definition's port leaves no dangling parent wire", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { idx, inst, pinIds } = define(h, "sub", [{ name: "a" }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    expect(h.wires()).toHaveLength(1);
    // Delete the port component in the definition sheet.
    h.doc.deleteSelection(idx, new Set([pinIds[0]]), new Set());
    h.scene.sync(h.doc, 0);
    const bad = errors(h);
    expect(bad, bad.map((v) => v.message).join("; ")).toEqual([]);
  });

  it("flipping a port's direction re-anchors the parent's wire", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { idx, inst, pinIds } = define(h, "sub", [{ name: "a" }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    // Turn the input port into an output: its pin springs from the left edge to
    // the right, so the parent's wire end must follow.
    h.doc.updateComponent(idx, pinIds[0], { attrs: { isOutput: true, bitsize: 1 } });
    h.scene.sync(h.doc, 0);
    const bad = errors(h);
    expect(bad, bad.map((v) => v.message).join("; ")).toEqual([]);
  });

  it("rotating a port in a definition re-anchors the parent's wire", () => {
    const h = twoGates();
    const [and] = h.ids;
    const { idx, inst, pinIds } = define(h, "sub", [{ name: "a" }]);
    clean(h, [click(`${and}.out`), click(`${inst}.a`)]);
    // Rotate the port component inside its own sheet (R flips its direction).
    h.switchTo(idx);
    runScript(h, [click(compCenter(h, idx, pinIds[0])), { kind: "rotate" }]);
    h.switchTo(0);
    const bad = errors(h);
    expect(bad, bad.map((v) => v.message).join("; ")).toEqual([]);
  });
});

describe("subcircuits — definition-edit fuzz", () => {
  it("random port edits never leave a dangling parent wire", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 250; seed++) {
      const rnd = lcg(seed);
      const h = twoGates();
      const [and] = h.ids;
      const n = 1 + Math.floor(rnd() * 3);
      const ports: { name: string; isOutput?: boolean }[] = [];
      for (let i = 0; i < n; i++) ports.push({ name: `p${i}`, isOutput: rnd() < 0.3 });
      const { idx, inst, pinIds } = define(h, "sub", ports);
      const input = h.pins().find((p) => p.compId === inst && p.facing === "W");
      if (input !== undefined) clean(h, [click(`${and}.out`), click(`${input.ref}`)]);

      for (let k = 0; k < 3; k++) {
        if (pinIds.length === 0) break;
        const pinId = pinIds[Math.floor(rnd() * pinIds.length)];
        const r = rnd();
        if (r < 0.25) {
          h.doc.updateComponent(idx, pinId, { name: `z${Math.floor(rnd() * 3)}` });
        } else if (r < 0.45) {
          h.doc.updateComponent(idx, pinId, { name: "" });
        } else if (r < 0.7) {
          h.switchTo(idx);
          runScript(h, [click(compCenter(h, idx, pinId)), { kind: "rotate" }]);
          h.switchTo(0);
        } else {
          if (h.doc.circuit(idx).components.length <= 1) continue;
          h.doc.deleteSelection(idx, new Set([pinId]), new Set());
        }
        h.scene.sync(h.doc, 0);
        const bad = errors(h);
        const structural = h.doc.validateStructure();
        if (bad.length > 0 || structural.length > 0) {
          failures.push(
            `seed ${seed} k${k}: ${bad.map((v) => v.message).join("; ")} ${structural.join("; ")}`,
          );
          break;
        }
      }
    }
    expect(failures.slice(0, 5).join("\n")).toBe("");
  });
});

describe("robustness — long routes, rotation cycles, circuit history", () => {
  it("keeps a 30-waypoint wire orthogonal and linear in size", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [80, 10] },
      ],
    });
    const [and, not] = h.ids;
    const steps: HarnessStep[] = [click(`${and}.out`)];
    for (let i = 0; i < 30; i++) {
      // Waypoints in empty space, clear of both gates' pins.
      const p = { x: 18 + (i % 12), y: 4 + Math.floor(i / 12) * 8 };
      steps.push({ kind: "move", at: p }, { kind: "click", at: p });
    }
    steps.push(click(`${not}.in`));
    clean(h, steps);
    const pts = h.wires()[0].points;
    expect(pts.length).toBeLessThan(80); // linear, not exponential
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s];
      const [bx, by] = pts[s + 1];
      expect(ax === bx || ay === by, `segment ${s} orthogonal`).toBe(true);
    }
  });

  it("rotating a wired part a full turn restores the original route", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    const orig = JSON.stringify(h.wires()[0].points);
    const c = center(h, not);
    runScript(h, [
      click(c),
      { kind: "rotate" },
      { kind: "rotate" },
      { kind: "rotate" },
      { kind: "rotate" },
    ]);
    expect(errors(h)).toEqual([]);
    const w = h.wires()[0];
    // Re-route-on-rotate is a pure function of the pin geometry, so a full turn
    // returns the identical route instead of accumulating a bend per step.
    expect(JSON.stringify(w.points)).toBe(orig);
    const pa = h.pin(`${and}.out`);
    const pb = h.pin(`${not}.in`);
    expect(w.points[0]).toEqual([pa.x, pa.y]);
    expect(w.points.at(-1)).toEqual([pb.x, pb.y]);
    for (let s = 0; s + 1 < w.points.length; s++) {
      const [ax, ay] = w.points[s];
      const [bx, by] = w.points[s + 1];
      expect(ax === bx || ay === by, `segment ${s} orthogonal`).toBe(true);
    }
  });

  it("circuit add / rename / remove round-trips through undo and redo", () => {
    const h = buildHarness({ components: [{ type: "gate.and", pos: [0, 0] }] });
    const before = JSON.stringify(h.doc.circuits);
    const sub = h.addCircuit("sub");
    h.doc.renameCircuit(sub, "alu");
    h.doc.undo(); // rename
    h.doc.undo(); // add
    expect(JSON.stringify(h.doc.circuits)).toBe(before);
    h.doc.redo();
    h.doc.redo();
    expect(h.doc.circuits[1].name).toBe("alu");
  });
});

describe("large scenes — performance guard", () => {
  it("builds and validates a few hundred parts without blowing up", () => {
    const h = buildHarness({ components: [] });
    const N = 240;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      ids.push(
        h.doc.addComponent(0, {
          type: i % 2 === 0 ? "gate.and" : "gate.buffer",
          pos: [(i % 24) * 6, Math.floor(i / 24) * 5],
        }),
      );
    }
    // Chain neighbours with L wires built from their real pin positions.
    for (let i = 0; i + 1 < N; i += 2) {
      const a = h.circuit().components.find((c) => c.id === ids[i])!;
      const b = h.circuit().components.find((c) => c.id === ids[i + 1])!;
      const pa = compLayout(a, h.doc.circuits).pins.find((p) => p.name === "out")!;
      const pb = compLayout(b, h.doc.circuits).pins.find((p) => p.name === "in")!;
      h.doc.addWire(0, {
        a: { comp: a.id, pin: "out" },
        b: { comp: b.id, pin: "in" },
        points: [
          [pa.x, pa.y],
          [pb.x, pa.y],
          [pb.x, pb.y],
        ],
      });
    }
    h.switchTo(0);
    const t0 = Date.now();
    const bad = errors(h);
    const ms = Date.now() - t0;
    expect(h.doc.validateStructure()).toEqual([]);
    expect(bad.filter((v) => v.kind === "endpoint-mismatch" || v.kind === "structure")).toEqual([]);
    // A generous ceiling: a quadratic regression here would blow past it.
    expect(ms).toBeLessThan(2000);
  });
});
