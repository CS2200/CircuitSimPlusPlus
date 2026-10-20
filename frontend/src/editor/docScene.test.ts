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
  valueTextAtWidth,
  wireLabelSpots,
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

  it("places a label above each PIN endpoint only, and none at a junction", () => {
    expect(wireLabelSpots(wire({ name: "T" }))).toEqual([
      { x: 0, y: -0.9 },
      { x: 4, y: -0.9 },
    ]);
    // A join end is a junction, not a place a tunnel was drawn.
    expect(wireLabelSpots(wire({ name: "T", b: { join: { wire: 0, segment: 1 } } }))).toEqual([
      { x: 0, y: -0.9 },
    ]);
    // Unnamed: no label at all, and a wire with no points yet has nowhere to put one.
    expect(wireLabelSpots(wire({}))).toEqual([]);
    expect(wireLabelSpots(wire({ name: "T", points: [] }))).toEqual([]);
  });

  it("hits the label, not the route, so a hidden tunnel stays clickable", () => {
    const wires = [wire({ name: "T" })];
    // On the label above endpoint a.
    expect(pickWireLabelAt(wires, { x: 0.1, y: -0.8 })?.wireIdx).toBe(0);
    // On the label above endpoint b.
    expect(pickWireLabelAt(wires, { x: 3.9, y: -1.0 })?.wireIdx).toBe(0);
    // Far from either label.
    expect(pickWireLabelAt(wires, { x: 2, y: -0.9 })).toBeNull();
    // A plain wire has no label to hit.
    expect(pickWireLabelAt([wire({})], { x: 0.1, y: -0.8 })).toBeNull();
  });
});
