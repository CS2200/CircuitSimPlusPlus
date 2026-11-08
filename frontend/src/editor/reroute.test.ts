import { describe, expect, it } from "vitest";
import { buildHarness, errors, runScript, type Harness } from "./routeHarness";
import { rerouteWire } from "./reroute";
import { compLayout } from "./layout";

type Vec2 = { x: number; y: number };
const click = (at: string | Vec2) => ({ kind: "click" as const, at });

function onSeg(p: [number, number], a: [number, number], b: [number, number]): boolean {
  const cross = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
  if (Math.abs(cross) > 1e-6) return false;
  const dot = (p[0] - a[0]) * (b[0] - a[0]) + (p[1] - a[1]) * (b[1] - a[1]);
  const len2 = (b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2;
  return dot >= -1e-6 && dot <= len2 + 1e-6;
}

function threeGates(): Harness {
  return buildHarness({
    components: [
      { type: "gate.and", pos: [10, 10] },
      { type: "gate.not", pos: [20, 10] },
      { type: "gate.or", pos: [30, 10] },
    ],
  });
}

describe("rerouteWire — whole-wire regenerate", () => {
  it("routes pin → pin with both endpoints on their pins", () => {
    const h = threeGates();
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    const pts = rerouteWire(h.circuit().wires[0], h.circuit(), h.doc.circuits)!;
    expect(pts).not.toBeNull();
    const pa = h.pin(`${and}.out`);
    const pb = h.pin(`${not}.in`);
    expect(pts[0]).toEqual([pa.x, pa.y]);
    expect(pts.at(-1)).toEqual([pb.x, pb.y]);
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      expect(ax === bx || ay === by, "orthogonal").toBe(true);
    }
  });

  it("keeps a free end exactly where it hangs", () => {
    const h = buildHarness({ components: [{ type: "gate.and", pos: [10, 10] }] });
    const [and] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 5, y: 25 } },
      { kind: "finishFree" },
    ]);
    const pts = rerouteWire(h.circuit().wires[0], h.circuit(), h.doc.circuits)!;
    expect(pts.at(-1)).toEqual([5, 25]);
    const pa = h.pin(`${and}.out`);
    expect(pts[0]).toEqual([pa.x, pa.y]);
  });

  it("enters a junction perpendicular and lands on the parent segment", () => {
    const h = threeGates();
    const [and, not, or] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    runScript(h, [
      click(`${or}.out`),
      { kind: "move", at: { x: 17, y: 11.2 } },
      click({ x: 17, y: 11.2 }),
    ]);
    const c = h.circuit();
    const branch = c.wires[1];
    const pts = rerouteWire(branch, c, h.doc.circuits)!;
    expect(branch.b).toMatchObject({ join: {} });
    const join = branch.b;
    if (!("join" in join)) throw new Error("expected a join end");
    const parent = c.wires[join.join.wire];
    const seg = join.join.segment;
    expect(onSeg(pts.at(-1)!, parent.points[seg], parent.points[seg + 1])).toBe(true);
    // Approaches across the parent's axis: the last segment is perpendicular.
    const p = pts.at(-1)!;
    const q = pts.at(-2)!;
    const parentHorizontal = Math.abs(parent.points[seg][1] - parent.points[seg + 1][1]) < 1e-9;
    expect(parentHorizontal ? p[1] !== q[1] : p[0] !== q[0]).toBe(true);
  });

  it("returns null when an endpoint cannot be resolved", () => {
    const h = threeGates();
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    const w = { ...h.circuit().wires[0], a: { comp: "missing", pin: "out" } };
    expect(rerouteWire(w, h.circuit(), h.doc.circuits)).toBeNull();
  });
});

describe("rotation re-route — integration", () => {
  it("re-routes a junction branch when its source part rotates", () => {
    const h = threeGates();
    const [and, not, or] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    runScript(h, [
      click(`${or}.out`),
      { kind: "move", at: { x: 17, y: 11.2 } },
      click({ x: 17, y: 11.2 }),
    ]);
    // Select the OR and rotate it: its branch is re-routed from the new pin.
    const orc = h.circuit().components.find((c) => c.id === or)!;
    const r = compLayout(orc, h.doc.circuits).rect;
    runScript(h, [
      click({ x: r.x + r.w / 2, y: r.y + r.h / 2 }),
      { kind: "rotate" },
      { kind: "rotate" },
    ]);
    const bad = errors(h);
    expect(bad, bad.map((v) => v.message).join("; ")).toEqual([]);
  });

  it("a single rotation yields a minimal, orthogonal route (no accumulation)", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    const before = h.wires()[0].points.length;
    const c = h.circuit().components.find((x) => x.id === not)!;
    const r = compLayout(c, h.doc.circuits).rect;
    runScript(h, [click({ x: r.x + r.w / 2, y: r.y + r.h / 2 }), { kind: "rotate" }]);
    // One rotation can add at most a couple of bends; it must not balloon.
    expect(h.wires()[0].points.length).toBeLessThanOrEqual(before + 3);
    expect(errors(h)).toEqual([]);
  });

  it("stays valid when a wire WITH a hand-planted midpoint has its part rotated", () => {
    // A hand-planted midpoint is now PRESERVED (v10): the re-route passes through
    // it instead of flattening the wire.
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 16, y: 4 } },
      click({ x: 16, y: 4 }),
      click(`${not}.in`),
    ]);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    const c = h.circuit().components.find((x) => x.id === not)!;
    const r = compLayout(c, h.doc.circuits).rect;
    runScript(h, [click({ x: r.x + r.w / 2, y: r.y + r.h / 2 }), { kind: "rotate" }]);
    const bad = errors(h);
    expect(bad, bad.map((v) => v.message).join("; ")).toEqual([]);
    const w = h.wires()[0];
    // The deliberate midpoint survives AND stays a vertex of the route.
    expect(w.midpoints).toEqual([[16, 4]]);
    expect(w.points.some((p) => p[0] === 16 && p[1] === 4)).toBe(true);
    const pa = h.pin(`${and}.out`);
    const pb = h.pin(`${not}.in`);
    expect(w.points[0]).toEqual([pa.x, pa.y]);
    expect(w.points.at(-1)).toEqual([pb.x, pb.y]);
  });

  it("a full turn preserves a wire's midpoint and restores its route", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 16, y: 4 } },
      click({ x: 16, y: 4 }),
      click(`${not}.in`),
    ]);
    const orig = JSON.stringify(h.wires()[0].points);
    const c = h.circuit().components.find((x) => x.id === not)!;
    const r = compLayout(c, h.doc.circuits).rect;
    runScript(h, [
      click({ x: r.x + r.w / 2, y: r.y + r.h / 2 }),
      { kind: "rotate" },
      { kind: "rotate" },
      { kind: "rotate" },
      { kind: "rotate" },
    ]);
    expect(errors(h)).toEqual([]);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    expect(JSON.stringify(h.wires()[0].points)).toBe(orig);
  });
});

describe("clearWireMidpoints", () => {
  it("drops the field and tidies the route in one step", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 16, y: 4 } },
      click({ x: 16, y: 4 }),
      click(`${not}.in`),
    ]);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    h.doc.clearWireMidpoints(0, 0);
    expect(h.wires()[0].midpoints).toBeUndefined();
    const bad = errors(h);
    expect(bad, bad.map((v) => v.message).join("; ")).toEqual([]);
    // Undo restores the midpoint (one undo step).
    h.doc.undo();
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
  });

  it("is a no-op when the wire has no midpoints", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    const depth = h.doc.historyDepth;
    h.doc.clearWireMidpoints(0, 0);
    expect(h.doc.historyDepth).toBe(depth);
  });
});

describe("wire midpoints — maintenance across edits", () => {
  const twoGates = () =>
    buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });

  const withMidpoint = (h: Harness): void => {
    const [and, not] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 16, y: 4 } },
      click({ x: 16, y: 4 }),
      click(`${not}.in`),
    ]);
  };

  it("offsets midpoints when a wire is pasted", () => {
    const h = twoGates();
    withMidpoint(h);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    runScript(h, [{ kind: "selectAll" }, { kind: "copy" }, { kind: "paste" }]);
    expect(h.wires()[1].midpoints).toEqual([[17, 5]]); // paste offset +1, +1
  });

  it("offsets midpoints when a whole wire translates with both parts", () => {
    const h = twoGates();
    withMidpoint(h);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    const [and, not] = h.ids;
    // Both ends are pins of moved parts → the wire translates WHOLE, so the
    // user midpoint rides along.
    h.doc.moveComponents(0, new Set([and, not]), { x: 4, y: -2 });
    h.scene.sync(h.doc, 0);
    expect(h.wires()[0].midpoints).toEqual([[20, 2]]);
  });

  it("keeps a midpoint when its bend is dragged (it moves with the bend)", () => {
    const h = twoGates();
    withMidpoint(h);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    runScript(h, [
      { kind: "down", at: { x: 16, y: 4 } },
      { kind: "move", at: { x: 16, y: 2 } },
      { kind: "up", at: { x: 16, y: 2 } },
    ]);
    expect(h.wires()[0].midpoints).toEqual([[16, 2]]);
    expect(errors(h)).toEqual([]);
  });

  it("clears several wires' midpoints in a single undo step", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.or", pos: [10, 20] },
        { type: "gate.not", pos: [24, 12] },
      ],
    });
    const [and, or, not] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 18, y: 4 } },
      click({ x: 18, y: 4 }),
      click(`${not}.in`),
    ]);
    runScript(h, [
      click(`${or}.out`),
      { kind: "move", at: { x: 18, y: 24 } },
      click({ x: 18, y: 24 }),
      click(`${not}.in`),
    ]);
    expect(h.wires()[0].midpoints).toBeDefined();
    expect(h.wires()[1].midpoints).toBeDefined();
    const depth = h.doc.historyDepth;
    h.doc.clearWireMidpoints(0, [0, 1]);
    expect(h.doc.historyDepth).toBe(depth + 1); // ONE step for both
    expect(h.wires()[0].midpoints).toBeUndefined();
    expect(h.wires()[1].midpoints).toBeUndefined();
  });
});

describe("wire flip (X) — preserved across re-route", () => {
  it("keeps an X-flipped wire's shape through a full turn", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), { kind: "flip" }, click(`${not}.in`)]);
    const flipped = JSON.stringify(h.wires()[0].points);
    expect(h.wires()[0].flip).toBe(true);
    // Sanity: the flip really changed the shape (corner near the source).
    expect(flipped).toContain("[15,11.5]");
    const r = compLayout(
      h.circuit().components.find((x) => x.id === not)!,
      h.doc.circuits,
    ).rect;
    runScript(h, [
      click({ x: r.x + r.w / 2, y: r.y + r.h / 2 }),
      { kind: "rotate" },
      { kind: "rotate" },
      { kind: "rotate" },
      { kind: "rotate" },
    ]);
    expect(errors(h)).toEqual([]);
    expect(h.wires()[0].flip).toBe(true);
    expect(JSON.stringify(h.wires()[0].points)).toBe(flipped);
  });

  it("omits flip on an ordinary wire", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${not}.in`)]);
    expect(h.wires()[0].flip).toBeUndefined();
  });
});
