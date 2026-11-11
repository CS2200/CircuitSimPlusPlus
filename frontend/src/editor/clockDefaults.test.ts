import { describe, expect, it } from "vitest";
import { CircuitDocument } from "../model/document";
import { applyClockDefaults, nextPlaceSeq } from "./clockDefaults";
import { isPinEndpoint } from "../model/csx";
import { pinShown } from "./catalog";
import { compLayout } from "./layout";
import { rectIntersects } from "../render/geom";

function doc(): CircuitDocument {
  return CircuitDocument.create();
}

/** Place a part the way the editor does: one undo step for it and its default wiring. */
function place(d: CircuitDocument, type: string, pos: [number, number] = [10, 10]): string {
  const key = `place:${nextPlaceSeq()}`;
  const id = d.addComponent(0, { type, pos }, key);
  applyClockDefaults(d, 0, id, type, key);
  return id;
}

describe("placing a clocked part wires its clock and reset", () => {
  it("gives a register a CLK source and an RST source, and names the wires", () => {
    const d = doc();
    const r = place(d, "mem.register");
    const c = d.circuits[0];
    // The root's CLK **is** the design's own clock and its RST **is** the design's own
    // reset: both are source *parts*, because a root `CLK`/`RST` pin would have nothing
    // driving it (§4.3).
    expect(c.components.filter((x) => x.type === "wiring.clock")).toHaveLength(1);
    expect(c.components.filter((x) => x.type === "wiring.reset")).toHaveLength(1);
    // `addWire` canonicalises the endpoints, so find the wire by the pin it reached.
    const wired = (pin: string) =>
      c.wires.filter((w) =>
        [w.a, w.b].some((e) => isPinEndpoint(e) && e.comp === r && e.pin === pin),
      );
    expect(wired("clk")).toHaveLength(1);
    expect(wired("rst")).toHaveLength(1);
    expect(wired("clk")[0].name).toBe("CLK");
    expect(wired("rst")[0].name).toBe("RST");
  });

  it("puts the clock and reset in separate free slots, off the part", () => {
    const d = doc();
    const r = place(d, "mem.register");
    const c = d.circuits[0];
    const compById = (id: string) => c.components.find((x) => x.id === id)!;
    const clamp = c.components.find((x) => x.type === "wiring.clock")!;
    const reset = c.components.find((x) => x.type === "wiring.reset")!;
    const regRect = compLayout(compById(r), d.circuits).rect;
    const clockRect = compLayout(compById(clamp.id), d.circuits).rect;
    const resetRect = compLayout(compById(reset.id), d.circuits).rect;
    expect(rectIntersects(clockRect, resetRect)).toBe(false);
    expect(rectIntersects(clockRect, regRect)).toBe(false);
    expect(rectIntersects(resetRect, regRect)).toBe(false);
    // Both sources are distinct components, not aliases of one another.
    expect(clamp.id).not.toBe(reset.id);
  });

  it("keeps the default wire off the register body", () => {
    const d = doc();
    const r = place(d, "mem.register");
    const c = d.circuits[0];
    const reg = c.components.find((x) => x.id === r)!;
    const regRect = compLayout(reg, d.circuits).rect;
    // Every interior sample of every default wire stays outside the register's
    // body: the source is placed on the control-pin side.
    for (const w of c.wires) {
      for (let s = 0; s + 1 < w.points.length; s++) {
        for (let t = 0; t <= 1; t += 0.1) {
          const x = w.points[s][0] + (w.points[s + 1][0] - w.points[s][0]) * t;
          const y = w.points[s][1] + (w.points[s + 1][1] - w.points[s][1]) * t;
          const inside =
            x > regRect.x &&
            x < regRect.x + regRect.w &&
            y > regRect.y &&
            y < regRect.y + regRect.h;
          expect(inside).toBe(false);
        }
      }
    }
  });

  it("reuses one source for every part, and one undo step for a placement", () => {
    const d = doc();
    const a = place(d, "mem.register", [10, 10]);
    const b = place(d, "mem.register", [10, 30]);
    const c = d.circuits[0];
    expect(c.components.filter((x) => x.type === "wiring.clock")).toHaveLength(1);
    expect(c.components.filter((x) => x.type === "wiring.reset")).toHaveLength(1);
    const touches = (e: (typeof c.wires)[number]["a"], id: string) =>
      isPinEndpoint(e) && e.comp === id;
    const touching = (id: string) => c.wires.filter((w) => touches(w.a, id) || touches(w.b, id));
    for (const id of [a, b]) expect(touching(id)).toHaveLength(2);
    // Undo once: the second placement *and* its wiring go away together — and the first
    // placement keeps its wiring (which is why the key must be unique per placement).
    const wires = c.wires.length;
    d.undo();
    expect(d.circuits[0].components.some((x) => x.id === b)).toBe(false);
    expect(d.circuits[0].wires.length).toBeLessThan(wires);
    expect(d.circuits[0].wires.filter((w) => touches(w.a, a) || touches(w.b, a))).toHaveLength(2);
  });

  it("keeps a subcircuit's CLK/RST ports in separate free slots", () => {
    const d = doc();
    const sub = d.addCircuit("sub");
    const key = `place:${nextPlaceSeq()}`;
    const r = d.addComponent(sub, { type: "mem.register", pos: [10, 10] }, key);
    applyClockDefaults(d, sub, r, "mem.register", key);
    const c = d.circuit(sub);
    const ports = c.components.filter((x) => x.type === "wiring.pin");
    expect(ports.map((p) => p.name).sort()).toEqual(["CLK", "RST"]);
    const rects = ports.map((p) => compLayout(p, d.circuits).rect);
    expect(rectIntersects(rects[0], rects[1])).toBe(false);
    const regRect = compLayout(
      c.components.find((x) => x.id === r)!,
      d.circuits,
    ).rect;
    expect(rects.some((x) => rectIntersects(x, regRect))).toBe(false);
  });

  it("accepts CLOCK/RESET in any capitalisation when finding an existing source", () => {
    const d = doc();
    const src = d.addComponent(0, { type: "wiring.pin", pos: [0, 0], name: "Clock" });
    const rst = d.addComponent(0, { type: "wiring.pin", pos: [0, 10], name: "reset" });
    const r = place(d, "mem.register");
    const c = d.circuits[0];
    expect(c.components.some((x) => x.name === "CLK")).toBe(false);
    const to = c.wires
      .flatMap((w) => [w.a, w.b])
      .filter(isPinEndpoint)
      .map((e) => e.comp)
      .filter((id) => id !== r);
    expect(to).toContain(src);
    expect(to).toContain(rst);
  });

  it("leaves an unclocked part alone", () => {
    const d = doc();
    const g = place(d, "gate.and");
    expect(d.circuits[0].wires).toHaveLength(0);
    expect(d.circuits[0].components.some((x) => x.id === g)).toBe(true);
  });
});

describe("show/hide clock and reset are gone", () => {
  it("draws the pins whatever the (legacy) attrs say", () => {
    expect(pinShown({ type: "mem.register", attrs: {} }, "clk")).toBe(true);
    expect(pinShown({ type: "mem.register", attrs: {} }, "rst")).toBe(true);
    expect(pinShown({ type: "mem.ram", attrs: { showClk: false, showRst: false } }, "clk")).toBe(
      true,
    );
  });
});
