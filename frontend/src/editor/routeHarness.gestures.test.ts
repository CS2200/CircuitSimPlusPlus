import { describe, expect, it } from "vitest";
import {
  applyStep,
  buildHarness,
  errors,
  fuzzHistory,
  lcg,
  randomGesture,
  report,
  runScript,
  type Harness,
  type HarnessStep,
  type PointRef,
} from "./routeHarness";
import { compLayout } from "./layout";

type Vec2 = { x: number; y: number };

/**
 * The gesture zoo: every pointer/keyboard gesture the editor accepts, driven
 * through the real ToolMachine against a small fixed scene, so a regression in
 * any one of them is a named, readable failure rather than a mystery.
 */
function zoo(): Harness {
  return buildHarness({
    components: [
      { type: "gate.and", pos: [10, 10] },
      { type: "gate.not", pos: [20, 10] },
      { type: "gate.or", pos: [30, 10] },
      { type: "gate.nand", pos: [10, 20] },
    ],
  });
}

function center(h: Harness, id: string): Vec2 {
  const c = h.circuit().components.find((x) => x.id === id)!;
  const r = compLayout(c, h.doc.circuits).rect;
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

/** Run a scripted gesture and assert only the hard invariants. */
function clean(h: Harness, steps: HarnessStep[]): void {
  runScript(h, steps);
  const bad = errors(h);
  expect(bad.length, bad.length > 0 ? report(h, bad) : "").toBe(0);
}

const down = (at: PointRef): HarnessStep => ({ kind: "down", at });
const move = (at: PointRef): HarnessStep => ({ kind: "move", at });
const up = (at: PointRef): HarnessStep => ({ kind: "up", at });
const click = (at: PointRef): HarnessStep => ({ kind: "click", at });

describe("gesture zoo — placing & selection", () => {
  it("places a part, rotates the ghost, then places; Esc cancels", () => {
    const h = zoo();
    const n0 = h.circuit().components.length;
    runScript(h, [
      { kind: "startPlacing", type: "gate.xor" },
      { kind: "rotate" },
      { kind: "click", at: { x: 40, y: 30 } },
      { kind: "startPlacing", type: "gate.and", sticky: true },
      { kind: "cancel" },
    ]);
    expect(h.circuit().components.length).toBe(n0 + 1);
  });

  it("selects by click, toggles with shift, clears on empty space", () => {
    const h = zoo();
    const [and, not] = h.ids;
    runScript(h, [
      click(center(h, and)),
      { kind: "click", at: center(h, not), shift: true },
      click({ x: 0, y: 40 }), // empty → box/clear
    ]);
    expect(errors(h)).toEqual([]);
  });

  it("double-clicks a part (inspector) and right-clicks (context menu)", () => {
    const h = zoo();
    const [and] = h.ids;
    runScript(h, [
      { kind: "doubleClick", at: center(h, and) },
      { kind: "click", at: center(h, and), button: 2 },
    ]);
    expect(errors(h)).toEqual([]);
  });
});

describe("gesture zoo — moving & rotating parts", () => {
  it("drags a part (wires glued)", () => {
    const h = zoo();
    const [and, not] = h.ids;
    const c = center(h, not);
    clean(h, [
      click(`${and}.out`),
      click(`${not}.in`),
      down(c),
      move({ x: c.x + 4, y: c.y + 3 }),
      up({ x: c.x + 4, y: c.y + 3 }),
    ]);
  });

  it("rotates a wired part through every facing", () => {
    for (let i = 0; i < 4; i++) {
      const h = zoo();
      const [and, not] = h.ids;
      clean(h, [
        click(`${and}.out`),
        click(`${not}.in`),
        click(center(h, not)),
        { kind: "rotate" },
      ]);
    }
  });

  it("faces a wired part with the arrow keys", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [
      click(`${and}.out`),
      click(`${not}.in`),
      click(center(h, not)),
      { kind: "face", rot: "N" },
      { kind: "face", rot: "S" },
    ]);
  });
});

describe("gesture zoo — wiring", () => {
  it("wire pin → pin (click-click)", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
  });

  it("wire with 0–3 planted waypoints", () => {
    for (const n of [0, 1, 2, 3]) {
      const h = zoo();
      const [and, not] = h.ids;
      const steps: HarnessStep[] = [click(`${and}.out`)];
      for (let k = 0; k < n; k++) steps.push(move({ x: 14 + k, y: 6 }), click({ x: 14 + k, y: 6 }));
      steps.push(click(`${not}.in`));
      clean(h, steps);
    }
  });

  it("wire by dragging a pin to a target", () => {
    const h = zoo();
    const [and] = h.ids;
    const t = { x: 20, y: 11 };
    clean(h, [down(`${and}.out`), move(t), up(t)]);
  });

  it("wire released over empty space hangs a free end", () => {
    const h = zoo();
    const [and] = h.ids;
    clean(h, [down(`${and}.out`), move({ x: 5, y: 30 }), up({ x: 5, y: 30 })]);
    expect(h.wires()[0].b).toMatchObject({ free: [5, 30] });
  });

  it("wire dropped onto a wire creates a junction", () => {
    const h = zoo();
    const [and, not, or] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    clean(h, [click(`${or}.out`), move({ x: 17, y: 11.2 }), click({ x: 17, y: 11.2 })]);
    expect(h.wires()[1].b).toMatchObject({ join: { wire: 0 } });
  });

  it("drags off an existing wire to start a branch", () => {
    const h = zoo();
    const [and, not, or] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    clean(h, [down({ x: 17, y: 11.3 }), move(`${or}.in0`), up(`${or}.in0`)]);
    expect(h.wires().length).toBe(2);
  });

  it("Enter finishes a wire with a free end", () => {
    const h = zoo();
    const [and] = h.ids;
    clean(h, [click(`${and}.out`), move({ x: 5, y: 25 }), { kind: "finishFree" }]);
  });

  it("X flips the corner while routing", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [click(`${and}.out`), { kind: "flip" }, click(`${not}.in`)]);
  });

  it("snaps waypoint clicks to the half grid (no phantom jog on a pin row)", () => {
    const h = zoo();
    const [and, not] = h.ids;
    // and.out sits at y = 11.5; click a waypoint on that exact row.
    runScript(h, [
      click(`${and}.out`),
      move({ x: 18, y: 11.5 }),
      click({ x: 18, y: 11.5 }),
      click(`${not}.in`),
    ]);
    const pts = h.wires()[0].points;
    expect(pts[1]).toEqual([18, 11.5]); // straight east off the pin — no bump
  });

  it("Esc abandons a wire in progress", () => {
    const h = zoo();
    const [and] = h.ids;
    runScript(h, [click(`${and}.out`), move({ x: 6, y: 6 }), { kind: "cancel" }]);
    expect(h.wires()).toHaveLength(0);
  });
});

describe("gesture zoo — confused & mistaken", () => {
  it("finishes a wire on its own start pin (invalid, swallowed)", () => {
    const h = zoo();
    const [and] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${and}.out`), click(`${and}.out`)]);
    expect(errors(h)).toEqual([]);
  });

  it("clicking the start pin again cancels the wire (no spurious bend)", () => {
    const h = zoo();
    const [and, not] = h.ids;
    runScript(h, [click(`${and}.out`), click(`${and}.out`)]);
    expect(h.tool.isWiring).toBe(false);
    expect(h.wires()).toHaveLength(0);
    // …and starting over still works.
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    expect(h.wires()).toHaveLength(1);
  });

  it("clicking the same waypoint twice records a single midpoint", () => {
    const h = zoo();
    const [and, not] = h.ids;
    runScript(h, [
      click(`${and}.out`),
      { kind: "move", at: { x: 16, y: 4 } },
      click({ x: 16, y: 4 }),
      click({ x: 16, y: 4 }), // confused double-click
      click(`${not}.in`),
    ]);
    expect(h.wires()[0].midpoints).toEqual([[16, 4]]);
    expect(errors(h)).toEqual([]);
  });

  it("dragging off a pin and releasing back on it cancels (no dangling stub)", () => {
    const h = zoo();
    const [and] = h.ids;
    runScript(h, [
      { kind: "down", at: `${and}.out` },
      { kind: "move", at: { x: 30, y: 30 } },
      { kind: "up", at: `${and}.out` }, // release back on the source pin
    ]);
    expect(h.wires()).toHaveLength(0);
    expect(h.tool.isWiring).toBe(false);
  });

  it("wires in→out of the SAME part (self-loop, swallowed)", () => {
    const h = zoo();
    const [and] = h.ids;
    runScript(h, [click(`${and}.in0`), click(`${and}.out`)]);
    expect(errors(h)).toEqual([]);
  });

  it("starts, cancels, and restarts a wire", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [
      click(`${and}.out`),
      move({ x: 16, y: 6 }),
      { kind: "cancel" },
      click(`${and}.out`),
      click(`${not}.in`),
    ]);
  });

  it("right-clicks to cancel a wire in progress", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [
      click(`${and}.out`),
      { kind: "click", at: { x: 16, y: 6 }, button: 2 },
      click(`${not}.in`),
    ]);
  });

  it("deletes the wire's target, then keeps wiring", () => {
    const h = zoo();
    const [and, not, or] = h.ids;
    clean(h, [
      click(`${and}.out`),
      click(`${not}.in`),
      click(center(h, not)),
      { kind: "delete" },
      click(`${and}.out`),
      click(`${or}.in0`),
    ]);
  });

  it("copies and pastes a wired pair", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [
      click(center(h, and)),
      { kind: "click", at: center(h, not), shift: true },
      click(`${and}.out`),
      click(`${not}.in`),
      { kind: "selectAll" },
      { kind: "copy" },
      { kind: "paste" },
    ]);
  });

  it("cuts and pastes a wired pair", () => {
    const h = zoo();
    const [and, not] = h.ids;
    clean(h, [
      click(`${and}.out`),
      click(`${not}.in`),
      { kind: "selectAll" },
      { kind: "cut" },
      { kind: "paste" },
    ]);
  });

  it("drops a dragged wire onto a part's body (nearest pin)", () => {
    const h = zoo();
    const [and, not] = h.ids;
    const c = center(h, not);
    clean(h, [down(`${and}.out`), move({ x: c.x + 0.3, y: c.y }), up({ x: c.x + 0.3, y: c.y })]);
    expect(h.wires()[0].b).toMatchObject({ comp: not });
  });

  it("places overlapping parts and wires across them", () => {
    const h = zoo();
    runScript(h, [
      { kind: "place", type: "gate.xor", at: { x: 12, y: 11 } },
      { kind: "place", type: "gate.or", at: { x: 12, y: 11 } },
    ]);
    expect(errors(h)).toEqual([]);
  });
});

describe("gesture zoo — multi-pin parts & junction chains", () => {
  it("wires several pins of a multi-pin register, with fan-in onto one input", () => {
    const h = buildHarness({
      components: [
        { type: "mem.register", pos: [10, 10], attrs: { bitsize: 8 } },
        { type: "gate.not", pos: [22, 10] },
        { type: "gate.not", pos: [22, 16] },
      ],
    });
    const [reg, a, b] = h.ids;
    clean(h, [click(`${reg}.q`), click(`${a}.in`)]);
    clean(h, [click(`${reg}.d`), click(`${b}.in`)]);
    clean(h, [click(`${reg}.q`), click(`${b}.in`)]); // second wire onto b.in
    expect(h.wires().length).toBe(3);
  });

  it("chains a junction onto a child wire", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
        { type: "gate.or", pos: [30, 10] },
        { type: "gate.buffer", pos: [10, 20] },
      ],
    });
    const [and, not, or, buf] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]); // wire 0
    clean(h, [click(`${or}.out`), move({ x: 17, y: 11.2 }), click({ x: 17, y: 11.2 })]); // wire 1 → join 0
    const parentSeg = h.wires()[1].points;
    const mid = {
      x: (parentSeg[0][0] + parentSeg[1][0]) / 2,
      y: (parentSeg[0][1] + parentSeg[1][1]) / 2,
    };
    clean(h, [click(`${buf}.out`), move(mid), click(mid)]); // wire 2 → join 1
    expect(errors(h)).toEqual([]);
  });

  it("survives moving a part that a junction chain hangs off", () => {
    const h = buildHarness({
      components: [
        { type: "gate.and", pos: [10, 10] },
        { type: "gate.not", pos: [20, 10] },
        { type: "gate.or", pos: [30, 10] },
      ],
    });
    const [and, not, or] = h.ids;
    clean(h, [click(`${and}.out`), click(`${not}.in`)]);
    clean(h, [click(`${or}.out`), move({ x: 17, y: 11.2 }), click({ x: 17, y: 11.2 })]);
    const c = center(h, and);
    clean(h, [down(c), move({ x: c.x - 4, y: c.y + 3 }), up({ x: c.x - 4, y: c.y + 3 })]);
    expect(errors(h)).toEqual([]);
  });
});

describe("gesture zoo — inspector edits mid-wire", () => {
  it("re-anchors the start when the part is rotated mid-wire", () => {
    const h = zoo();
    const [and, not] = h.ids;
    runScript(h, [
      click(`${and}.out`), // start a wire at and.out
      { kind: "edit", id: and, patch: { rot: "S" } }, // Inspector rotate, mid-wire
      click(`${not}.in`), // finish
    ]);
    expect(errors(h)).toEqual([]);
    const w = h.wires()[0];
    const pin = h.pin(`${and}.out`);
    expect(w.points[0]).toEqual([pin.x, pin.y]);
  });
});

describe("gesture zoo — undo/redo round-trips", () => {
  it("restores the exact baseline after undoing any random sequence, then redoes", () => {
    const bad: string[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      const r = fuzzHistory(seed, 30);
      if (r.mismatches.length > 0) bad.push(`seed ${seed}: ${r.mismatches.join("; ")}`);
    }
    expect(bad.slice(0, 5).join("\n")).toBe("");
  });
});

describe("gesture zoo — fuzz smoke (never throws)", () => {
  it("absorbs any random gesture sequence without throwing", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 150; seed++) {
      const rnd = lcg(seed);
      const h = zoo();
      for (let i = 0; i < 40; i++) {
        for (const s of randomGesture(h, rnd)) {
          try {
            applyStep(h, s);
          } catch (e) {
            failures.push(`seed ${seed} step ${i} ${JSON.stringify(s)}: ${String(e)}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5).join("\n")).toBe("");
  });

  it("keeps every user midpoint a vertex of its route across random edits", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 300; seed++) {
      const rnd = lcg(seed);
      const h = zoo();
      for (let i = 0; i < 40; i++) {
        for (const s of randomGesture(h, rnd)) {
          applyStep(h, s);
          const v = errors(h).find((x) => x.kind === "midpoint-off-wire");
          if (v !== undefined) {
            failures.push(`seed ${seed} step ${i}: ${v.message}`);
          }
        }
      }
    }
    expect(failures.slice(0, 5).join("\n")).toBe("");
  });
});

describe("gesture zoo — structural commands don't corrupt geometry", () => {
  it("cancels an in-progress wire when its start part is rotated", () => {
    const h = zoo();
    const [and] = h.ids;
    runScript(h, [
      click(center(h, and)), // select the start part
      click(`${and}.out`), // start a wire from it
      { kind: "rotate" }, // rotate the start part MID-wire → wire is abandoned
      move({ x: 6, y: 6 }),
      { kind: "finishFree" },
    ]);
    expect(h.wires()).toHaveLength(0);
    expect(errors(h)).toEqual([]);
  });

  it("keeps component names unique when a named cluster is pasted", () => {
    const h = buildHarness({
      components: [
        { type: "mem.register", pos: [10, 10], name: "pc", attrs: { bitsize: 8 } },
        { type: "gate.not", pos: [20, 10] },
      ],
    });
    const [pc, not] = h.ids;
    runScript(h, [
      click(`${pc}.q`),
      click(`${not}.in`),
      { kind: "selectAll" },
      { kind: "copy" },
      { kind: "paste" },
    ]);
    expect(h.doc.validateStructure()).toEqual([]);
  });

  it("auto-wires a placed register's clock/reset without a degenerate segment", () => {
    const h = buildHarness({ components: [{ type: "gate.and", pos: [10, 10] }] });
    runScript(h, [{ kind: "place", type: "mem.register", at: { x: 24, y: 12 } }]);
    expect(h.doc.validateStructure()).toEqual([]);
    expect(errors(h)).toEqual([]);
    for (const w of h.wires()) {
      for (let s = 0; s + 1 < w.points.length; s++) {
        const [ax, ay] = w.points[s];
        const [bx, by] = w.points[s + 1];
        expect(ax !== bx || ay !== by, "no zero-length auto-wire segment").toBe(true);
      }
    }
  });
});

/**
 * The wiring invariants the random-gesture fuzzer must hold across a whole
 * confusing sequence: no zero-length segment (a degenerate pin→junction
 * collapse), and no stale user midpoint. Both are hard errors in `check`.
 */
describe("gesture zoo — no wire degenerates across random edits", () => {
  it("never leaves a zero-length segment or a stale midpoint", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= 250; seed++) {
      const rnd = lcg(seed);
      const h = zoo();
      for (let i = 0; i < 40; i++) {
        for (const s of randomGesture(h, rnd)) {
          applyStep(h, s);
          const v = errors(h).find(
            (x) => x.kind === "zero-length-segment" || x.kind === "midpoint-off-wire",
          );
          if (v !== undefined) failures.push(`seed ${seed}: ${v.message}`);
        }
      }
    }
    expect(failures.slice(0, 5).join("\n")).toBe("");
  });
});
