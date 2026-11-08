import { describe, expect, it } from "vitest";
import { isJoinEndpoint } from "../model/csx";
import {
  buildHarness,
  check,
  errors,
  generateCase,
  materialize,
  report,
  runScript,
  toSvg,
  type Harness,
  type HarnessStep,
} from "./routeHarness";

// AND at (10,10): out pin (14,11.5) facing E. NOT at (20,10): in pin (20,11)
// facing W. The exact geometry of the classic "wire skims the gate edge" case.
function andNot(): Harness {
  return buildHarness({
    components: [
      { type: "gate.and", pos: [10, 10] },
      { type: "gate.not", pos: [20, 10] },
    ],
  });
}

/** Run a script and fail with a readable report (violations + ASCII map). */
function runExpectingClean(h: Harness, script: HarnessStep[]): void {
  runScript(h, script);
  const bad = errors(h);
  expect(bad.length, bad.length > 0 ? report(h, bad) : "").toBe(0);
}

describe("routeHarness — gesture replay", () => {
  it("routes pin → pin with a facing escape + Z jog", () => {
    const h = andNot();
    const [and, not] = h.ids;
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "click", at: `${not}.in` },
    ]);
    const wires = h.wires();
    expect(wires).toHaveLength(1);
    expect(wires[0].a).toEqual({ comp: and, pin: "out" });
    expect(wires[0].b).toEqual({ comp: not, pin: "in" });
    expect(wires[0].points).toEqual([
      [14, 11.5],
      [19, 11.5],
      [19, 11],
      [20, 11],
    ]);
    expect(errors(h)).toEqual([]);
  });

  it("plants bends with clicks, each segment orthogonally routed", () => {
    const h = andNot();
    const [and, not] = h.ids;
    runExpectingClean(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "move", at: { x: 17, y: 8 } },
      { kind: "click", at: { x: 17, y: 8 } }, // waypoint above-right of out
      { kind: "click", at: `${not}.in` },
    ]);
    expect(h.wires()[0].points).toEqual([
      [14, 11.5],
      [17, 11.5],
      [17, 8],
      [19, 8],
      [19, 11],
      [20, 11],
    ]);
  });

  it("keeps multiple waypoints orthogonal (regression: anchors folded onto themselves)", () => {
    // Two planted bends before finishing. Before the fix, `finishOrBend`
    // appended the full accumulated route back onto the anchors, so every
    // extra waypoint doubled the point list and produced diagonals/reversals.
    const h = andNot();
    const [and, not] = h.ids;
    runExpectingClean(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "move", at: { x: 17, y: 8 } },
      { kind: "click", at: { x: 17, y: 8 } },
      { kind: "move", at: { x: 17, y: 4 } },
      { kind: "click", at: { x: 17, y: 4 } },
      { kind: "click", at: `${not}.in` },
    ]);
    const pts = h.wires()[0].points;
    for (let s = 0; s + 1 < pts.length; s++) {
      const [ax, ay] = pts[s];
      const [bx, by] = pts[s + 1];
      expect(ax === bx || ay === by, `segment ${s} is orthogonal`).toBe(true);
    }
  });

  it("X flips the corner preference mid-route", () => {
    const h = andNot();
    const [and, not] = h.ids;
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "flip" },
      { kind: "click", at: `${not}.in` },
    ]);
    expect(h.wires()[0].points).toEqual([
      [14, 11.5],
      [15, 11.5],
      [15, 11],
      [20, 11],
    ]);
  });

  it("clicking again after finishing starts a fresh gesture, not a re-route", () => {
    const h = andNot();
    const [and, not] = h.ids;
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "click", at: `${not}.in` },
      { kind: "click", at: { x: 17.5, y: 11.5 } }, // click ON the finished wire
    ]);
    expect(h.wires()).toHaveLength(1);
    expect(h.wires()[0].points).toEqual([
      [14, 11.5],
      [19, 11.5],
      [19, 11],
      [20, 11],
    ]);
    expect(h.tool.isWiring).toBe(false);
  });

  it("drops a second wire as a junction onto the first", () => {
    const h = andNot();
    const [and, not] = h.ids;
    // wire 0: and.out → not.in
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "click", at: `${not}.in` },
    ]);
    // wire 1: start from not.out and drop onto wire 0's first segment
    runScript(h, [
      { kind: "click", at: `${not}.out` },
      { kind: "move", at: { x: 17.5, y: 11.2 } },
      { kind: "click", at: { x: 17.5, y: 11.2 } },
    ]);
    const wires = h.wires();
    expect(wires).toHaveLength(2);
    expect(wires[1].a).toEqual({ comp: not, pin: "out" });
    expect(wires[1].b).toMatchObject({ join: { wire: 0 } });
    // The junction invariant (a join must lie on its parent segment) is a hard
    // rule, and is the whole point of exercising junctions in the harness.
    expect(errors(h)).toEqual([]);
  });

  it("re-anchors pasted junctions onto the pasted parent, not the original", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
        { type: "gate.or", pos: [30, 10] },
      ],
    });
    const [and, not, or] = h.ids;
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "click", at: `${not}.in` },
    ]);
    runScript(h, [
      { kind: "click", at: `${or}.out` },
      { kind: "move", at: { x: 17, y: 11.2 } },
      { kind: "click", at: { x: 17, y: 11.2 } }, // junction onto wire 0
    ]);
    expect(h.wires()).toHaveLength(2);
    runScript(h, [{ kind: "selectAll" }, { kind: "copy" }, { kind: "paste" }]);
    // Original wires 0,1; the paste lands at 2,3. The pasted branch must
    // junction onto the PASTED trunk (2), never the original (0).
    const wires = h.wires();
    expect(wires).toHaveLength(4);
    expect(wires[1].b).toMatchObject({ join: { wire: 0 } });
    expect(wires[3].b).toMatchObject({ join: { wire: 2 } });
    expect(isJoinEndpoint(wires[3].b)).toBe(true);
    expect(errors(h)).toEqual([]);
  });

  it("flags a wire driven through a component body", () => {
    const h = andNot();
    const [and, not] = h.ids;
    const inside = { x: 10.5, y: 12.5 }; // strictly inside the AND's body
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "move", at: inside },
      { kind: "click", at: inside },
      { kind: "click", at: `${not}.in` },
    ]);
    expect(check(h).some((v) => v.kind === "body-crossing")).toBe(true);
  });

  it("is deterministic (same script, same geometry)", () => {
    const script: HarnessStep[] = [];
    const h1 = andNot();
    const [and, not] = h1.ids;
    script.push(
      { kind: "click", at: `${and}.out` },
      { kind: "move", at: { x: 17, y: 8 } },
      { kind: "click", at: { x: 17, y: 8 } },
      { kind: "click", at: `${not}.in` },
    );
    runScript(h1, script);
    const h2 = andNot();
    runScript(h2, script);
    expect(h1.wires()).toEqual(h2.wires());
  });

  it("renders a debug dump", () => {
    const h = andNot();
    const [and, not] = h.ids;
    runScript(h, [
      { kind: "click", at: `${and}.out` },
      { kind: "click", at: `${not}.in` },
    ]);
    expect(toSvg(h)).toContain("<polyline");
  });
});

describe("routeHarness — generated corpus", () => {
  it("200 generated multi-click / junction cases hold the hard invariants", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 200; seed++) {
      const h = materialize(generateCase(seed));
      const bad = errors(h);
      if (bad.length > 0) failures.push(`seed ${seed}:\n${report(h, bad)}`);
    }
    expect(failures.slice(0, 3).join("\n\n")).toBe("");
  });

  it("generated cases replay deterministically", () => {
    for (let seed = 1; seed <= 50; seed++) {
      const c = generateCase(seed);
      expect(materialize(c).wires()).toEqual(materialize(c).wires());
    }
  });

  it("exercises the known multi-leg gaps (so the checks are not vacuous)", () => {
    const kinds = new Set<string>();
    for (let seed = 1; seed <= 200; seed++) {
      for (const v of check(materialize(generateCase(seed)))) kinds.add(v.kind);
    }
    expect([...kinds].sort()).toEqual(
      expect.arrayContaining(["body-crossing", "self-overlap", "wire-overlap"]),
    );
  });
});

/**
 * Known limitations of the CURRENT router, captured as expected failures so
 * they are tracked rather than forgotten. Each assertion states the ideal; when
 * the router is fixed, `it.fails` starts reporting "unexpected pass" and the
 * test is promoted to a normal one.
 *
 * Root cause of both: a wire is routed one leg per click, and a mid-path leg
 * gets `{ dir: null, body: null }` at both ends, so it sees no component at
 * all; and `validLeg`'s self-overlap check only sees the current leg.
 */
describe("routeHarness — known router limitations", () => {
  it.fails("a mid-path leg avoids the component bodies in the scene", () => {
    // seed 7 plants a bend that forces a leg straight through a gate.nand.
    const h = materialize(generateCase(7));
    expect(check(h).filter((v) => v.kind === "body-crossing")).toEqual([]);
  });

  it.fails("the assembled multi-click path never crosses itself", () => {
    const h = materialize(generateCase(1));
    expect(check(h).filter((v) => v.kind === "self-overlap")).toEqual([]);
  });

  it.fails("two wires never share a run of copper", () => {
    const h = materialize(generateCase(1));
    expect(check(h).filter((v) => v.kind === "wire-overlap")).toEqual([]);
  });
});
