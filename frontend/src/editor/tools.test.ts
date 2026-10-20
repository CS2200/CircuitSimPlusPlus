import { describe, expect, it } from "vitest";
import { CircuitDocument } from "../model/document";
import { SelectionModel } from "../model/selection";
import type { PointerInfo } from "../components/CanvasHost";
import { DocScene } from "./docScene";
import { pinPosition } from "./layout";
import { tagWidth } from "./docScene";
import { TAG_TIP } from "./shapes";
import { copySelection, manhattanRoute, ToolMachine, type CanvasMenuState } from "./tools";

const PI = (over: Partial<PointerInfo> = {}): PointerInfo => ({
  button: 0,
  buttons: 0,
  shiftKey: false,
  ctrlKey: false,
  altKey: false,
  clientX: 0,
  clientY: 0,
  ...over,
});

function setup() {
  const doc = CircuitDocument.create("t");
  const scene = new DocScene();
  const sel = new SelectionModel();
  const tool = new ToolMachine(
    doc,
    scene,
    sel,
    () => 0,
    () => {},
  );
  const sync = () => scene.sync(doc, 0);
  // AND at [10,10]: in0 (10,11), in1 (10,12), out (15,11.5)
  const and = doc.addComponent(0, { type: "gate.and", pos: [10, 10] });
  // NOT at [20,10]: in (20,11), out (23,11)
  const not = doc.addComponent(0, { type: "gate.not", pos: [20, 10] });
  sync();
  return { doc, scene, sel, tool, sync, and, not };
}

describe("placing", () => {
  it("places components centered on the click (grid-rounded); Esc cancels", () => {
    const { doc, tool } = setup();
    tool.startPlacing("gate.or");
    tool.hover({ x: 30.4, y: 20.6 });
    // gate.or is 5×3: the body's CENTER lands on the cursor
    expect(tool.overlay().placing?.pos).toEqual({ x: 28, y: 19 });
    tool.down({ x: 30.4, y: 20.6 }, PI());
    expect(doc.circuit(0).components.at(-1)).toMatchObject({ type: "gate.or", pos: [28, 19] });
    // one placement per palette pick - the next click is just a click
    tool.down({ x: 40, y: 30 }, PI());
    expect(doc.circuit(0).components).toHaveLength(3);
    expect(tool.placingType).toBeNull();
  });

  it("sticky placement (shift-pick) keeps placing until cancelled", () => {
    const { doc, tool } = setup();
    tool.startPlacing("gate.or", true);
    tool.down({ x: 30, y: 20 }, PI());
    tool.down({ x: 40, y: 30 }, PI());
    expect(doc.circuit(0).components).toHaveLength(4);
    expect(tool.placingType).toBe("gate.or");
    tool.cancel();
    tool.down({ x: 50, y: 40 }, PI());
    expect(doc.circuit(0).components).toHaveLength(4);
  });

  it("R rotates the ghost before placing", () => {
    const { doc, tool } = setup();
    tool.startPlacing("gate.or");
    tool.rotateSelection();
    tool.down({ x: 30, y: 20 }, PI());
    expect(doc.circuit(0).components.at(-1)?.rot).toBe("S");
  });

  it("arrows point the ghost and the selection at an absolute facing", () => {
    const { doc, tool, and } = setup();
    // Ghost: an arrow sets the facing outright (and is idempotent).
    tool.startPlacing("gate.or");
    tool.faceSelection("N");
    tool.faceSelection("N");
    tool.down({ x: 30, y: 20 }, PI());
    expect(doc.circuit(0).components.at(-1)?.rot).toBe("N");
    tool.cancel();

    // Selection: right → East, left → West, up → North (absolute, not a step).
    tool.down({ x: 12, y: 11 }, PI()); // the AND's body
    tool.up(PI());
    tool.faceSelection("W");
    expect(doc.circuit(0).components.find((c) => c.id === and)?.rot).toBe("W");
    tool.faceSelection("N");
    expect(doc.circuit(0).components.find((c) => c.id === and)?.rot).toBe("N");
    tool.faceSelection("S");
    expect(doc.circuit(0).components.find((c) => c.id === and)?.rot).toBe("S");
    tool.faceSelection("E");
    expect(doc.circuit(0).components.find((c) => c.id === and)?.rot).toBe("E");
    // R still steps the cycle (E→S), and ccw reverses it.
    tool.rotateSelection();
    expect(doc.circuit(0).components.find((c) => c.id === and)?.rot).toBe("S");
    tool.rotateSelection(true);
    expect(doc.circuit(0).components.find((c) => c.id === and)?.rot).toBe("E");
  });
});

describe("wiring", () => {
  it("routes pin → pin orthogonally with a facing escape + Z jog", () => {
    const { doc, tool, and, not } = setup();
    tool.down({ x: 15, y: 11.5 }, PI()); // and.out
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI()); // not.in
    tool.up(PI());
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(1);
    expect(wires[0].a).toEqual({ comp: and, pin: "out" });
    expect(wires[0].b).toEqual({ comp: not, pin: "in" });
    // leaves the output east, jogs late, enters the input pin from the west
    expect(wires[0].points).toEqual([
      [15, 11.5],
      [19, 11.5],
      [19, 11],
      [20, 11],
    ]);
  });

  /** A bare machine with one wire's worth of components (no AND/NOT). */
  function bareTool() {
    const doc = CircuitDocument.create("t");
    const scene = new DocScene();
    const tool = new ToolMachine(
      doc,
      scene,
      new SelectionModel(),
      () => 0,
      () => {},
    );
    const sync = () => scene.sync(doc, 0);
    const attrsOf = (id: string) => doc.circuit(0).components.find((c) => c.id === id)?.attrs;
    const connect = (from: { x: number; y: number }, to: { x: number; y: number }) => {
      tool.down(from, PI());
      tool.up(PI());
      tool.down(to, PI()); // the wire commits on the second click
      tool.up(PI());
    };
    return { doc, scene, tool, sync, attrsOf, connect };
  }

  it("a probe adopts the width of what it is connected to", () => {
    const { doc, sync, attrsOf, connect } = bareTool();
    const konst = doc.addComponent(0, {
      type: "wiring.constant",
      pos: [10, 10],
      attrs: { value: "1", bitsize: 32 },
    });
    const probe = doc.addComponent(0, { type: "wiring.probe", pos: [20, 10] });
    sync();
    expect(attrsOf(probe)?.bitsize).toBeUndefined(); // default 1 bit, no attr

    // The constant's body is sized to its readout, so its edge-mounted `out` is
    // not at x=13 any more — ask the layout where the pin really is (§56).
    const out = pinPosition(doc.circuit(0).components[0], "out")!;
    connect(out, { x: 20, y: 11 }); // konst.out → probe.in

    expect(doc.circuit(0).wires).toHaveLength(1);
    expect(attrsOf(konst)?.bitsize).toBe(32); // the driver is untouched
    expect(attrsOf(probe)?.bitsize).toBe(32); // the probe matched it
  });

  it("a breakpoint adopts the width of what it watches (§90)", () => {
    const { doc, sync, attrsOf, connect } = bareTool();
    doc.addComponent(0, {
      type: "wiring.constant",
      pos: [10, 10],
      attrs: { value: "1", bitsize: 8 },
    });
    const bp = doc.addComponent(0, {
      type: "debug.breakpoint",
      pos: [20, 10],
      attrs: { value: "0" },
    });
    sync();

    // The constant's `out` pin (sized to its readout, §56) → the breakpoint's
    // `in` (x=20, y=10.5).
    connect(pinPosition(doc.circuit(0).components[0], "out")!, { x: 20, y: 10.5 });

    // Watching a bus while declaring one bit would be the width mismatch the
    // watcher exists to avoid; the condition's own value is untouched.
    expect(attrsOf(bp)?.bitsize).toBe(8);
    expect(attrsOf(bp)?.value).toBe("0");
  });

  it("shift+click a wire reads its value, cycling binary → hex → decimal (§56)", () => {
    const { doc, sync, tool, connect } = bareTool();
    doc.addComponent(0, {
      type: "wiring.constant",
      pos: [10, 10],
      attrs: { value: "1", bitsize: 32 },
    });
    doc.addComponent(0, { type: "wiring.probe", pos: [20, 10] });
    sync();
    const out = pinPosition(doc.circuit(0).components[0], "out")!;
    connect(out, { x: 20, y: 11 });
    // Partway along the wire: clear of both pins, so the card is about the WIRE.
    const mid = { x: out.x + 1.1, y: 11 };
    const inspect = () => {
      tool.down(mid, PI({ shiftKey: true }));
      tool.up(PI({ shiftKey: true }));
      return tool.overlay().wireInfo;
    };
    expect(inspect()).toMatchObject({ wireIdx: 0, mode: "bin" }); // the bits first
    expect(inspect()?.mode).toBe("hex"); // then the compact readings
    expect(inspect()?.mode).toBe("unsigned");
    expect(inspect()?.mode).toBe("bin"); // and around again
  });

  it("shift+click a tunnel's TAG reads the tunnel it hides (§56)", () => {
    const { doc, sync, tool, connect } = bareTool();
    doc.addComponent(0, {
      type: "wiring.constant",
      pos: [10, 10],
      attrs: { value: "1", bitsize: 4 },
    });
    doc.addComponent(0, { type: "wiring.probe", pos: [20, 10], attrs: { bitsize: 4 } });
    sync();
    const out = pinPosition(doc.circuit(0).components[0], "out")!;
    connect(out, { x: 20, y: 11 });
    doc.setWireName(0, 0, "T");
    sync();

    // The tag lies along the wire, just east of the pin the point aims back at
    // (§91) — that body is the handle a HIDDEN route has to answer on.
    const handle = { x: out.x + TAG_TIP + tagWidth("T") / 2, y: out.y };
    tool.down(handle, PI({ shiftKey: true }));
    tool.up(PI({ shiftKey: true }));
    expect(tool.overlay().wireInfo).toMatchObject({ wireIdx: 0, mode: "bin" });
  });

  it("a 1-bit source leaves a probe's default width alone", () => {
    const { doc, sync, attrsOf, connect } = bareTool();
    doc.addComponent(0, { type: "wiring.constant", pos: [10, 10], attrs: { value: "1" } });
    const probe = doc.addComponent(0, { type: "wiring.probe", pos: [20, 10] });
    sync();

    connect(pinPosition(doc.circuit(0).components[0], "out")!, { x: 20, y: 11 });

    // No attr written: the width already matches, so nothing churns.
    expect(attrsOf(probe)?.bitsize).toBeUndefined();
  });

  it("plants bends with clicks, each segment orthogonally routed", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.move({ x: 17, y: 11 });
    tool.down({ x: 17, y: 8 }, PI()); // waypoint above-right of the out pin
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI()); // finish on not.in
    tool.up(PI());
    expect(doc.circuit(0).wires[0].points).toEqual([
      [15, 11.5],
      [17, 11.5],
      [17, 8],
      [19, 8],
      [19, 11],
      [20, 11],
    ]);
  });

  it("dragging pin → pin finishes the wire on release (UI_OVERHAUL §13)", () => {
    const { doc, tool, and, not } = setup();
    tool.down({ x: 15, y: 11.5 }, PI()); // press on and.out
    tool.move({ x: 17, y: 9 }); // sweep out
    tool.move({ x: 20, y: 11 }); // over not.in
    tool.up(PI(), { x: 20, y: 11 }); // release → the wire commits HERE
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(1);
    expect(wires[0].a).toEqual({ comp: and, pin: "out" });
    expect(wires[0].b).toEqual({ comp: not, pin: "in" });
    expect(wires[0].points).toEqual([
      [15, 11.5],
      [19, 11.5],
      [19, 11],
      [20, 11],
    ]);
    expect(tool.isWiring).toBe(false);

    // …and the next click SELECTS the wire instead of re-routing it.
    tool.down({ x: 17.5, y: 11.5 }, PI());
    tool.up(PI());
    expect(doc.circuit(0).wires).toHaveLength(1);
    expect(tool.isWiring).toBe(false);
  });

  it("a swept release over empty space keeps routing (nothing to attach to)", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.move({ x: 15, y: 6 });
    tool.up(PI(), { x: 15, y: 6 });
    expect(tool.isWiring).toBe(true);
    expect(doc.circuit(0).wires).toHaveLength(0);
    tool.cancel();
  });

  it("a swept release on a part's body attaches to its nearest pin", () => {
    const { doc, tool, and, not } = setup();
    tool.down({ x: 15, y: 11.5 }, PI()); // press on and.out
    tool.move({ x: 20.8, y: 11.2 }); // onto the NOT's body, nearest in (20,11)
    tool.up(PI(), { x: 20.8, y: 11.2 });
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(1);
    expect(wires[0].a).toEqual({ comp: and, pin: "out" });
    expect(wires[0].b).toEqual({ comp: not, pin: "in" });
    expect(tool.isWiring).toBe(false);
  });

  it("after a drag, a click plants the waypoint where clicked and keeps routing", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.move({ x: 15, y: 6 }); // drag the ghost out
    tool.up(PI()); // release: still wiring, nothing planted
    expect(tool.isWiring).toBe(true);
    expect(doc.circuit(0).wires).toHaveLength(0);
    tool.down({ x: 15, y: 6 }, PI()); // click plants the waypoint
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI()); // click finishes
    tool.up(PI());
    expect(doc.circuit(0).wires[0].points).toEqual([
      [15, 11.5],
      [16, 11.5],
      [16, 6],
      [15, 6],
      [15, 11],
      [20, 11],
    ]);
  });

  it("dropping onto a wire creates a junction (dot) onto the right segment", () => {
    const { doc, tool, not } = setup();
    // base wire: and.out → not.in, straight horizontal segment
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    // now wire from not.out dropped onto the middle of wire 0
    tool.down({ x: 23, y: 11 }, PI());
    tool.up(PI());
    tool.down({ x: 17.5, y: 11.2 }, PI()); // on the segment (15,11.5)→(20,11)
    tool.up(PI());
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(2);
    expect(wires[1].a).toEqual({ comp: not, pin: "out" });
    expect(wires[1].b).toEqual({ join: { wire: 0, segment: 0 } });
    // the junction coordinate (last point of the child wire) lies ON the parent segment
    const [ax, ay] = wires[0].points[0];
    const [bx, by] = wires[0].points[1];
    const [jx, jy] = wires[1].points.at(-1)!;
    const cross = (bx - ax) * (jy - ay) - (by - ay) * (jx - ax);
    expect(Math.abs(cross)).toBeLessThan(1e-9);
  });

  it("dragging off a wire starts wiring from a junction", () => {
    const { doc, tool, not } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    // press on the wire, drag away, drop on not.out
    tool.down({ x: 17, y: 11.3 }, PI());
    tool.move({ x: 20, y: 14 });
    tool.up(PI());
    tool.down({ x: 23, y: 11 }, PI());
    tool.up(PI());
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(2);
    expect(wires[1].a).toEqual({ join: { wire: 0, segment: 0 } });
    expect(wires[1].b).toEqual({ comp: not, pin: "out" });
  });

  it("X flips the corner preference while routing", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.flipRoute(); // flip the Z: turn early instead of late
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    expect(doc.circuit(0).wires[0].points).toEqual([
      [15, 11.5],
      [16, 11.5],
      [16, 11],
      [20, 11],
    ]);
  });

  it("dragging a wire bend re-routes the adjacent legs (one undo step)", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    // wire is now [[15,11.5],[19,11.5],[19,11],[20,11]]
    const depth = doc.historyDepth;
    tool.down({ x: 19, y: 11.5 }, PI()); // grab the first bend
    tool.move({ x: 21, y: 9 }); // drag it up-right
    tool.up(PI());
    expect(doc.circuit(0).wires[0].points).toEqual([
      [15, 11.5],
      [21, 11.5],
      [21, 9],
      [19, 9],
      [19, 11],
      [20, 11],
    ]);
    expect(doc.historyDepth).toBe(depth + 1);
    // no component was dragged by the gesture
    expect(doc.circuit(0).components).toHaveLength(2);
  });

  it("a dragged bend deselects the wire on release; pressing it re-selects (§55)", () => {
    const { sel, tool, sync } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    sync();
    // press the bend: the wire highlights while you drag it…
    tool.down({ x: 19, y: 11.5 }, PI());
    expect(sel.hasWire(0)).toBe(true);
    tool.move({ x: 21, y: 9 });
    tool.up(PI());
    // …and is no longer selected once released…
    expect(sel.hasWire(0)).toBe(false);
    sync();
    // …but pressing the handle again highlights it for another drag.
    tool.down({ x: 21, y: 11.5 }, PI());
    expect(sel.hasWire(0)).toBe(true);
  });

  it("a second click narrows a wire to the segment under the cursor (§65)", () => {
    const { doc, sel, tool, sync } = setup();
    // Draw a wire, then give it a bend we can point at.
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    doc.updateWirePoints(0, 0, [
      [15, 11.5],
      [18, 11.5],
      [20, 11],
    ]);
    sync();

    // First click: the whole wire, nothing narrowed.
    tool.down({ x: 16.5, y: 11.5 }, PI());
    tool.up(PI());
    expect(sel.hasWire(0)).toBe(true);
    expect(sel.segment).toBeNull();

    // Second click on the same piece: just that segment.
    tool.down({ x: 16.5, y: 11.5 }, PI());
    tool.up(PI());
    expect(sel.segment).toEqual({ wire: 0, seg: 0 });

    // Delete takes the piece: the wire survives, one bend shorter.
    tool.deleteSelection();
    const wires = doc.circuit(0).wires;
    expect(wires).toHaveLength(1);
    expect(wires[0].points).toHaveLength(2);
    expect(sel.segment).toBeNull();
  });

  it("the canvas cursor hints at pins, wires and idle space (UI_OVERHAUL §55)", () => {
    const { tool, sync } = setup();
    // over the AND's in0 pin → wiring
    tool.hover({ x: 10, y: 11 });
    expect(tool.cursor).toBe("crosshair");
    // draw a wire, then hover its body → draggable
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    sync();
    tool.hover({ x: 17, y: 11.5 });
    expect(tool.cursor).toBe("pointer");
    // empty space → the CSS pan cursor stands
    tool.hover({ x: 40, y: 40 });
    expect(tool.cursor).toBeUndefined();
  });

  it("a bend drag that cannot move does not change the wire", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    const before = JSON.stringify(doc.circuit(0).wires[0].points);
    tool.down({ x: 19, y: 11.5 }, PI());
    tool.move({ x: 19, y: 11.4 }); // snaps onto the next bend → refused
    tool.up(PI());
    expect(JSON.stringify(doc.circuit(0).wires[0].points)).toBe(before);
  });

  it("Esc cancels an in-progress wire", () => {
    const { doc, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 17, y: 8 }, PI()); // bend
    tool.up(PI());
    tool.cancel();
    expect(doc.circuit(0).wires).toHaveLength(0);
    expect(tool.isBusy).toBe(false);
  });
});

describe("manhattanRoute", () => {
  it("returns no corner when already aligned", () => {
    expect(manhattanRoute({ x: 0, y: 0 }, { x: 5, y: 0 })).toEqual([]);
    expect(manhattanRoute({ x: 0, y: 0 }, { x: 0, y: 5 })).toEqual([]);
  });

  it("goes horizontal-first when |dx| ≥ |dy|, vertical-first otherwise", () => {
    expect(manhattanRoute({ x: 0, y: 0 }, { x: 5, y: 2 })).toEqual([{ x: 5, y: 0 }]);
    expect(manhattanRoute({ x: 0, y: 0 }, { x: 2, y: 5 })).toEqual([{ x: 0, y: 5 }]);
  });
});

describe("hover + info + double-click", () => {
  it("idle hover over a wire does nothing", () => {
    const { tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    tool.hover({ x: 17, y: 11.3 }); // over wire 0
    expect(tool.overlay().hoverHit).toBeNull();
    tool.hover({ x: 15, y: 11.5 }); // over and.out pin
    expect(tool.overlay().hoverHit).toMatchObject({ kind: "pin", pin: "out" });
  });

  it("hovering a tunnel tag targets the wire it names (UI_OVERHAUL §91)", () => {
    const { doc, tool, sync } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    doc.setWireName(0, 0, "BUS_A");
    sync();

    // The tag lies along the wire east of its pin end (15, 11.5) — that is the handle.
    tool.hover({ x: 16.5, y: 11.5 });
    expect(tool.overlay().hoverHit).toMatchObject({ kind: "wire", wireIdx: 0, label: true });
    // Clear of the tag (and of the wire): nothing is a target there.
    tool.hover({ x: 17, y: 9 });
    expect(tool.overlay().hoverHit).toBeNull();
  });

  it("shift+click a wire shows its info card; any click dismisses it", () => {
    const { tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    tool.down({ x: 17, y: 11.4 }, PI({ shiftKey: true }));
    expect(tool.overlay().wireInfo).toMatchObject({ wireIdx: 0 });
    tool.down({ x: 40, y: 30 }, PI()); // click empty space
    expect(tool.overlay().wireInfo).toBeNull();
  });

  it("double-click on a component selects it and fires onEditComponent", () => {
    const { sel, tool } = setup();
    let edited: string | null = null;
    tool.onEditComponent = (id) => {
      edited = id;
    };
    tool.doubleClick({ x: 12, y: 11 }); // AND body
    expect(edited).toBe("c1");
    expect(sel.components.has("c1")).toBe(true);
    tool.doubleClick({ x: 50, y: 40 }); // empty
    expect(edited).toBe("c1"); // unchanged
  });
});

describe("selection + drag", () => {
  it("click selects a component; Shift toggles", () => {
    const { sel, tool } = setup();
    tool.down({ x: 12, y: 11 }, PI()); // AND body
    tool.up(PI());
    expect(sel.components.has("c1")).toBe(true);
    tool.down({ x: 21, y: 11 }, PI({ shiftKey: true })); // NOT body, additive
    tool.up(PI({ shiftKey: true }));
    expect(sel.components.has("c2")).toBe(true);
    expect(sel.components.size).toBe(2);
  });

  it("dragging a component moves it (grid-snapped) as ONE undo step", () => {
    const { doc, tool } = setup();
    const before = doc.circuit(0).components[0].pos;
    const depth = doc.historyDepth;
    tool.down({ x: 12, y: 11 }, PI());
    tool.move({ x: 12.6, y: 11 }); // crosses threshold
    tool.move({ x: 14.6, y: 11 });
    tool.move({ x: 15.4, y: 13 });
    tool.up(PI());
    expect(doc.circuit(0).components[0].pos).toEqual([before[0] + 3, before[1] + 2]);
    expect(doc.historyDepth).toBe(depth + 1);
    doc.undo();
    expect(doc.circuit(0).components[0].pos).toEqual(before);
  });

  it("box select grabs components and wires in the rect", () => {
    const { sel, tool } = setup();
    tool.down({ x: 8, y: 9 }, PI());
    tool.move({ x: 25, y: 14 });
    tool.up(PI());
    expect(sel.components.size).toBe(2);
    // no wires yet — both comps selected but nothing wired
    expect(sel.wires.size).toBe(0);
  });

  it("Ctrl+box select adds to the existing selection (Shift now pans)", () => {
    const { sel, tool } = setup();
    tool.down({ x: 12, y: 11 }, PI()); // select the AND
    tool.up(PI());
    expect(sel.components.size).toBe(1);
    tool.down({ x: 8, y: 9 }, PI({ ctrlKey: true }));
    tool.move({ x: 25, y: 14 });
    tool.up(PI({ ctrlKey: true }));
    expect(sel.components.size).toBe(2); // AND kept + NOT added
  });

  it("the floating rotate button above the selection rotates it", () => {
    const { doc, scene, tool } = setup();
    tool.down({ x: 12, y: 11 }, PI()); // select the AND (body 10,10 → 15,13)
    tool.up(PI());
    expect(scene.rotateButtonFor([])).toBeNull();
    // Button center = (midX, top − 1.15) = (12.5, 8.85), radius 0.62.
    tool.down({ x: 12.5, y: 8.85 }, PI());
    tool.up(PI());
    expect(doc.circuit(0).components[0].rot).toBe("S");
    // The click did not clear the selection.
    expect(doc.circuit(0).components).toHaveLength(2);
  });
});

describe("delete / copy / paste / rotate", () => {
  it("delete removes selection with junction cascade, one undo step", () => {
    const { doc, sel, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    tool.down({ x: 23, y: 11 }, PI()); // wire from not.out onto wire 0
    tool.up(PI());
    tool.down({ x: 17, y: 11.3 }, PI());
    tool.up(PI());
    expect(doc.circuit(0).wires).toHaveLength(2);
    tool.selectAll();
    expect(sel.wires.size).toBe(2);
    const depth = doc.historyDepth;
    tool.deleteSelection();
    expect(doc.circuit(0).components).toHaveLength(0);
    expect(doc.circuit(0).wires).toHaveLength(0);
    expect(doc.historyDepth).toBe(depth + 1);
    doc.undo();
    expect(doc.circuit(0).components).toHaveLength(2);
    expect(doc.circuit(0).wires).toHaveLength(2);
    expect(doc.circuit(0).wires[1].b).toEqual({ join: { wire: 0, segment: 0 } });
  });

  it("copy/paste duplicates with new ids, offset, and remapped endpoints", () => {
    const { doc, sel, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI());
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI());
    tool.up(PI());
    tool.selectAll();
    tool.copy();
    tool.paste();
    const circuit = doc.circuit(0);
    expect(circuit.components).toHaveLength(4);
    expect(circuit.wires).toHaveLength(2);
    const pasted = circuit.components.slice(2);
    expect(pasted[0].pos).toEqual([11, 11]); // offset +1
    expect(sel.components.has(pasted[0].id)).toBe(true);
    // pasted wire references the pasted components, not the originals
    expect(circuit.wires[1].a).toEqual({ comp: pasted[0].id, pin: "out" });
    expect(circuit.wires[1].b).toEqual({ comp: pasted[1].id, pin: "in" });
    doc.undo();
    expect(doc.circuit(0).components).toHaveLength(2);
  });

  it("copy of a junction chain remaps join targets", () => {
    const doc = CircuitDocument.create();
    const a = doc.addComponent(0, { type: "gate.and", pos: [0, 0] });
    const b = doc.addComponent(0, { type: "gate.not", pos: [6, 0] });
    const c = doc.addComponent(0, { type: "gate.or", pos: [12, 0] });
    doc.addWire(0, {
      a: { comp: a, pin: "out" },
      b: { comp: b, pin: "in" },
      points: [
        [5, 1],
        [6, 1],
      ],
    });
    doc.addWire(0, {
      a: { comp: b, pin: "out" },
      b: { join: { wire: 0, segment: 0 } },
      points: [
        [9, 1],
        [5.5, 1],
      ],
    });
    doc.addWire(0, {
      a: { comp: c, pin: "in0" },
      b: { join: { wire: 1, segment: 0 } },
      points: [
        [12, 1],
        [9, 1],
      ],
    });
    const clip = copySelection(doc.circuit(0), new Set([a, b, c]));
    expect(clip.wires).toHaveLength(3);
    expect(clip.wires[1].b).toEqual({ join: { wire: 0, segment: 0 } });
    expect(clip.wires[2].b).toEqual({ join: { wire: 1, segment: 0 } });
  });

  it("copy drops wires that leave the selection (no dangling endpoints)", () => {
    const doc = CircuitDocument.create();
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
    // only one side selected → wire is not copied
    const clip = copySelection(doc.circuit(0), new Set([a]));
    expect(clip.components).toHaveLength(1);
    expect(clip.wires).toHaveLength(0);
  });

  it("rotate cycles selected components", () => {
    const { doc, tool } = setup();
    tool.down({ x: 12, y: 11 }, PI());
    tool.up(PI());
    tool.rotateSelection();
    expect(doc.circuit(0).components[0].rot).toBe("S");
    tool.rotateSelection();
    expect(doc.circuit(0).components[0].rot).toBe("W");
    doc.undo();
    expect(doc.circuit(0).components[0].rot).toBe("S");
  });
});

describe("context menu (§75)", () => {
  it("right-clicking a part selects it and reports the component menu", () => {
    const { tool, sel } = setup();
    const seen: CanvasMenuState[] = [];
    tool.onCanvasMenu = (m) => seen.push(m);
    tool.down({ x: 12, y: 11 }, PI({ button: 2, clientX: 40, clientY: 55 }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      x: 40,
      y: 55,
      on: "component",
      compType: "gate.and",
      components: 1,
      wires: 0,
      segment: false,
      clipboard: false,
    });
    expect(sel.components.size).toBe(1); // the part became the selection
    expect(sel.segment).toBeNull();
  });

  it("right-clicking bare canvas keeps the selection and reports the clipboard", () => {
    const { tool, sel } = setup();
    const seen: CanvasMenuState[] = [];
    tool.onCanvasMenu = (m) => seen.push(m);
    tool.down({ x: 12, y: 11 }, PI());
    tool.up(PI());
    tool.copy(); // the clipboard now holds the AND
    tool.down({ x: 60, y: 40 }, PI({ button: 2 }));
    expect(seen.at(-1)).toMatchObject({ on: "canvas", components: 1, clipboard: true });
    expect(sel.components.size).toBe(1); // a click off the part keeps it selected
  });

  it("right-clicking inside a multi-selection keeps all of it", () => {
    const { doc, sel, tool } = setup();
    sel.set(
      doc.circuit(0).components.map((c) => c.id),
      [],
    );
    const seen: CanvasMenuState[] = [];
    tool.onCanvasMenu = (m) => seen.push(m);
    tool.down({ x: 12, y: 11 }, PI({ button: 2 })); // the AND, already selected
    expect(seen.at(-1)).toMatchObject({ on: "component", components: 2 });
    expect(sel.components.size).toBe(2);
  });

  it("a right-click that cancels a gesture opens no menu", () => {
    const { tool } = setup();
    let calls = 0;
    tool.onCanvasMenu = () => calls++;
    tool.startPlacing("gate.or");
    tool.down({ x: 30, y: 20 }, PI({ button: 2 }));
    expect(calls).toBe(0);
    expect(tool.placingType).toBeNull();
  });

  it("right-clicking a wire offers the wire menu", () => {
    const { doc, scene, sel, tool } = setup();
    tool.down({ x: 15, y: 11.5 }, PI()); // and.out
    tool.up(PI());
    tool.down({ x: 20, y: 11 }, PI()); // not.in
    tool.up(PI());
    const wire = doc.circuit(0).wires[0];
    // Anywhere ON the route but clear of the bodies: let the scene's own picker
    // find such a point, since the route's shape is the router's business.
    const probe = wire.points
      .slice(0, -1)
      .map(([x, y], i) => ({
        x: (x + wire.points[i + 1][0]) / 2,
        y: (y + wire.points[i + 1][1]) / 2,
      }))
      .find((p) => scene.pickComponent(p) === null && scene.pickWire(p) !== null);
    if (probe === undefined) throw new Error("no clear point on the route to probe");
    const seen: CanvasMenuState[] = [];
    tool.onCanvasMenu = (m) => seen.push(m);
    tool.down(probe, PI({ button: 2 }));
    expect(seen.at(-1)).toMatchObject({ on: "wire", components: 0, wires: 1, segment: false });
    expect([...sel.wires]).toEqual([0]); // the wire became the selection
  });
});
