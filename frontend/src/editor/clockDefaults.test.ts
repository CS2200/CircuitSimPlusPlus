import { describe, expect, it } from "vitest";
import { CircuitDocument } from "../model/document";
import { applyClockDefaults, nextPlaceSeq } from "./clockDefaults";
import { isPinEndpoint } from "../model/csx";
import { pinShown } from "./catalog";

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
    // The root's CLK **is** the design's own clock (a `CLK` pin would have nothing
    // ticking it); the reset is a pin, so a design can be reset on purpose.
    expect(c.components.filter((x) => x.type === "wiring.clock")).toHaveLength(1);
    expect(c.components.some((x) => x.type === "wiring.pin" && x.name === "RST")).toBe(true);
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

  it("reuses one source for every part, and one undo step for a placement", () => {
    const d = doc();
    const a = place(d, "mem.register", [10, 10]);
    const b = place(d, "mem.register", [10, 30]);
    const c = d.circuits[0];
    expect(c.components.filter((x) => x.type === "wiring.clock")).toHaveLength(1);
    expect(c.components.filter((x) => x.name === "RST")).toHaveLength(1);
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
