import { describe, expect, it } from "vitest";
import type { CsxWire } from "../model/csx";
import {
  clockLevelOf,
  danglingPins,
  ellipsize,
  fitValueLine,
  memPreviewWord,
  pickWireLabelAt,
  readableOn,
  tunnelTagSites,
  valueTextAtWidth,
} from "./docScene";

/**
 * A long subcircuit pin name must not spill across the instance box: it is cut
 * with an ellipsis (same treatment as the value readouts).
 */
describe("ellipsize", () => {
  it("leaves a label that fits untouched", () => {
    expect(ellipsize("EXACTLY8", 8)).toBe("EXACTLY8");
    expect(ellipsize("sel", 8)).toBe("sel");
  });

  it("cuts a long label and marks it with an ellipsis", () => {
    expect(ellipsize("very_long_pin_name", 6)).toBe("very_…");
  });
});

/**
 * A clock must not "light up" when the circuit is merely loaded or edited: an
 * unwired clock is idle (neutral) until its first rising edge, so a reload —
 * which resets the cycle to 0 — cannot paint it high. (Bug report: "the clock
 * lights up on arbitrary circuit modifications".)
 */
describe("clockLevelOf", () => {
  it("prefers the value the engine actually drives", () => {
    expect(clockLevelOf(true, 0)).toBe(true);
    expect(clockLevelOf(false, 7)).toBe(false);
  });

  it("is idle (neutral) before the first rising edge", () => {
    expect(clockLevelOf(undefined, 0)).toBeNull();
    expect(clockLevelOf(undefined, undefined)).toBeNull();
  });

  it("alternates as an unwired clock is ticked", () => {
    expect(clockLevelOf(undefined, 1)).toBe(false);
    expect(clockLevelOf(undefined, 2)).toBe(true);
  });
});

describe("danglingPins", () => {
  const gate = [
    { name: "in0", kind: "in" as const },
    { name: "in1", kind: "in" as const },
    { name: "out", kind: "out" as const },
  ];

  it("flags the unconnected inputs of a part that is otherwise wired up", () => {
    // Output wired, no inputs: the classic "forgot to connect it".
    expect(danglingPins(gate, (p) => p === "out").map((p) => p.name)).toEqual(["in0", "in1"]);
    // One input wired: only the open one is flagged.
    expect(danglingPins(gate, (p) => p === "in0").map((p) => p.name)).toEqual(["in1"]);
  });

  it("stays quiet for an untouched part and for a fully wired one", () => {
    expect(danglingPins(gate, () => false)).toEqual([]);
    expect(danglingPins(gate, () => true)).toEqual([]);
  });

  it("never flags outputs or inouts", () => {
    // A decoder's unused outputs are not mistakes.
    const dec = [
      { name: "in", kind: "in" as const },
      { name: "out0", kind: "out" as const },
      { name: "out1", kind: "out" as const },
    ];
    expect(danglingPins(dec, (p) => p === "in")).toEqual([]);
    // A splitter's taps are plumbing, not inputs the user owes.
    const split = [
      { name: "bus", kind: "inout" as const },
      { name: "b0", kind: "inout" as const },
    ];
    expect(danglingPins(split, (p) => p === "bus")).toEqual([]);
    const ram = [
      { name: "addr", kind: "in" as const },
      { name: "din", kind: "in" as const },
      { name: "dout", kind: "out" as const },
    ];
    expect(danglingPins(ram, (p) => p === "addr").map((p) => p.name)).toEqual(["din"]);
  });
});

describe("valueTextAtWidth", () => {
  const hex = (h: string) => ({ v: h, x: "", z: "" });

  it("pads hex to the pin's width, so 4 bits is 1 char and 8 bits is 2", () => {
    expect(valueTextAtWidth(hex("5"), "hex", 4)).toBe("0x5");
    expect(valueTextAtWidth(hex("5"), "hex", 8)).toBe("0x05");
    expect(valueTextAtWidth(hex(""), "hex", 8)).toBe("0x00");
    expect(valueTextAtWidth(hex("5"), "hex", 32)).toBe("0x00000005");
  });

  it("pads binary to the bit count and leaves decimal alone", () => {
    expect(valueTextAtWidth(hex("5"), "bin", 8)).toBe("0b00000101");
    // A decimal number has no fixed digit count.
    expect(valueTextAtWidth(hex("ff"), "unsigned", 8)).toBe("255");
  });

  it("keeps a single-bit readout bare and X/Z symbolic", () => {
    expect(valueTextAtWidth(hex("1"), "unsigned", 1)).toBe("1");
    expect(valueTextAtWidth({ v: "", x: "1", z: "" }, "hex", 8)).toBe("X");
    expect(valueTextAtWidth({ v: "", x: "", z: "1" }, "hex", 8)).toBe("Z");
  });
});

describe("readableOn", () => {
  it("keeps a colour that contrasts with the sheet", () => {
    expect(readableOn("#ffffff", "#101010", "#e8e8ee")).toBe("#ffffff"); // white on dark
    expect(readableOn("#101010", "#f4f4f8", "#e8e8ee")).toBe("#101010"); // black on light
  });

  it("falls back when the colour would vanish into the sheet", () => {
    // The reported case: a white note opened in a light theme.
    expect(readableOn("#ffffff", "#f4f4f8", "#1a1a22")).toBe("#1a1a22");
    expect(readableOn("#fafafa", "#ffffff", "#000000")).toBe("#000000");
    // …and the mirror: black text on a near-black sheet.
    expect(readableOn("#000000", "#101010", "#ffffff")).toBe("#ffffff");
  });
});

describe("memPreviewWord", () => {
  it("reads the word the DOCUMENT's image holds at that address", () => {
    // rle-hex-v1: bare words in address order, `n-vv` = n repeats of vv.
    const contents = "0a 0b 2-ff";
    expect(memPreviewWord(contents, 0, 8)).toBe(0x0a);
    expect(memPreviewWord(contents, 1, 8)).toBe(0x0b);
    expect(memPreviewWord(contents, 2, 8)).toBe(0xff);
    expect(memPreviewWord(contents, 3, 8)).toBe(0xff);
  });

  it("is null when there is no image, no address, or the address is past the end", () => {
    // A file `autoload` is engine-only: the editor holds no image for it.
    expect(memPreviewWord(undefined, 0, 8)).toBeNull();
    expect(memPreviewWord("0a", null, 8)).toBeNull();
    expect(memPreviewWord("0a", 4, 8)).toBeNull();
    // A malformed image is the Inspector's problem, not the canvas's.
    expect(memPreviewWord("zz", 0, 8)).toBeNull();
  });

  it("masks the word to the memory's data width", () => {
    expect(memPreviewWord("1ff", 0, 4)).toBe(0x0f);
  });
});

/**
 * Value readouts must stay inside their part (UI_OVERHAUL §56): a short value is
 * shown whole and readable, a wide one (a 32-bit binary, say) is shortened with
 * an ellipsis — hovering then reveals the whole thing.
 */
describe("fitValueLine", () => {
  it("keeps a short value whole and readable", () => {
    const r = fitValueLine("0x0", 3, 2);
    expect(r.full).toBe(true);
    expect(r.text).toBe("0x0");
    expect(r.size).toBeGreaterThanOrEqual(0.6);
  });

  it("shortens a long binary readout so it fits the body", () => {
    const bits = `0b${"1".repeat(32)}`;
    const r = fitValueLine(bits, 3, 2);
    expect(r.full).toBe(false);
    expect(r.text.endsWith("…")).toBe(true);
    expect(r.text.length).toBeLessThan(bits.length);
    // The shortened line really fits: chars × size × 0.62 ≤ usable width.
    expect(r.text.length * r.size * 0.62).toBeLessThanOrEqual(3 * 0.86 + 1e-9);
  });
});

describe("tunnel labels (UI_OVERHAUL §87)", () => {
  const wire = (over: Partial<CsxWire>): CsxWire => ({
    a: { comp: "c1", pin: "out" },
    b: { comp: "c2", pin: "in" },
    points: [
      [0, 0],
      [4, 0],
    ],
    ...over,
  });

  it("plants a tag at each PIN endpoint only, and none at a junction", () => {
    // The wire runs east out of `a` and west into `b`, so each tag points back down
    // the wire at its own pin: west at `a`, east at `b`, both lying along the wire
    // (UI_OVERHAUL §91).
    expect(tunnelTagSites(wire({ name: "T" }))).toEqual([
      { at: { x: 0, y: 0 }, dir: "W" },
      { at: { x: 4, y: 0 }, dir: "E" },
    ]);
    // A join end is a junction, not a place a tunnel was drawn.
    expect(tunnelTagSites(wire({ name: "T", b: { join: { wire: 0, segment: 1 } } }))).toEqual([
      { at: { x: 0, y: 0 }, dir: "W" },
    ]);
    // Unnamed: no tag at all, and a wire with no points yet has nowhere to put one.
    expect(tunnelTagSites(wire({}))).toEqual([]);
    expect(tunnelTagSites(wire({ name: "T", points: [] }))).toEqual([]);
  });

  it("reorients with the wire: a vertical tunnel's tags point up and down", () => {
    // This wire runs north out of `a` (at the bottom) and south into `b` (at the top).
    const vertical = wire({
      name: "T",
      points: [
        [0, 4],
        [0, 0],
      ],
    });
    expect(tunnelTagSites(vertical).map((s) => s.dir)).toEqual(["S", "N"]);
  });

  it("orients by the pin's facing when the caller knows it", () => {
    // A pin facing east: the body hangs east of it in every case, whatever the wire
    // does — which is what keeps a converted spoke (whose copper may run inward,
    // through the part) from putting its tag on top of the part.
    const facing = (): "E" => "E";
    expect(tunnelTagSites(wire({ name: "T" }), facing).map((s) => s.dir)).toEqual(["W", "W"]);
    // The same pin, with the wire drawn inward instead: still west, still outside.
    const inward = wire({
      name: "T",
      points: [
        [0, 0],
        [-4, 0],
      ],
    });
    expect(tunnelTagSites(inward, facing).map((s) => s.dir)).toEqual(["W", "W"]);
    // Without a facing, the wire decides (the hand-drawn case).
    expect(tunnelTagSites(inward).map((s) => s.dir)).toEqual(["E", "W"]);
  });

  it("hits the tag, not the route, so a hidden tunnel stays clickable", () => {
    const wires = [wire({ name: "T" })];
    // The body of the tag at `a` lies east along the wire (its point is on the pin),
    // and the one at `b` lies west along it.
    expect(pickWireLabelAt(wires, { x: 1.0, y: 0.1 })).toMatchObject({
      wireIdx: 0,
      label: true,
    });
    expect(pickWireLabelAt(wires, { x: 3.0, y: 0 })?.wireIdx).toBe(0);
    // Clear of both tags and of the route below them: nothing.
    expect(pickWireLabelAt(wires, { x: 2, y: 2 })).toBeNull();
    // A plain wire has no tag to hit.
    expect(pickWireLabelAt([wire({})], { x: 1.0, y: 0.1 })).toBeNull();
  });

  it("sizes the box from the measured name when it can measure", () => {
    // One tag only (the far end is a junction), so the two boxes cannot cover the
    // middle between them.
    const wires = [wire({ name: "T", b: { join: { wire: 0, segment: 1 } } })];
    // A caller with real metrics (the scene uses `Renderer.measureText`) hands the
    // box its width: a wide name is then clickable as far out as it is drawn.
    const wide = (): number => 4;
    expect(pickWireLabelAt(wires, { x: 2.6, y: 0 }, undefined, { tagWidthOf: wide })?.wireIdx).toBe(
      0,
    );
    // Without metrics the estimate rules, and the same point is outside the tag.
    expect(pickWireLabelAt(wires, { x: 2.6, y: 0 })).toBeNull();
  });
});
