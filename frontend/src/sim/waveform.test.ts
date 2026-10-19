import { describe, expect, it } from "vitest";

import type { NamedComponent, NetDiffs, WireValue } from "../ipc/types";
import {
  WAVE_SAMPLE_CAP,
  WaveformRecorder,
  clockSignals,
  isBus,
  bitLaneIndices,
  defaultSignals,
  extractBit,
  pickedSignals,
  projectSamples,
  stepSegments,
  valueAt,
  valueBits,
  waveText,
  type WaveSignal,
} from "./waveform";

const hex = (v: number, bits = 4): WireValue => ({
  v: v.toString(16).padStart(Math.ceil(bits / 4), "0"),
  x: "0",
  z: "0",
});
const X = (bits = 1): WireValue => ({ v: "0", x: "1".repeat(Math.ceil(bits / 4)), z: "0" });
const Z = (bits = 1): WireValue => ({ v: "0", x: "0", z: "1".repeat(Math.ceil(bits / 4)) });

/** One engine batch: `cycle` advances once per clock period, `at` per event. */
const batch = (
  cycle: number,
  changes: Array<[number, WireValue, number]>,
  full = false,
): NetDiffs => ({
  cycle,
  full,
  changes: changes.map(([net, val, at]) => ({ net, val, at })),
});

describe("WaveformRecorder: every event, not every cycle", () => {
  it("keeps both halves of a cycle, so a clock is a square wave", () => {
    // The mock states its own model: `cycle = tick / 2`, and `at = tick * 50`.
    // Two events share cycle 0 (clk rises at 0, falls at 50) — recording one
    // sample per cycle collapses them and the clock comes out flat, which is
    // exactly the bug this pins.
    const r = new WaveformRecorder();
    // Mock-shaped: falls at the start of each cycle, rises half a cycle later.
    r.recordBatch(
      batch(0, [
        [1, hex(0, 1), 0],
        [1, hex(1, 1), 50],
      ]),
    );
    r.recordBatch(
      batch(1, [
        [1, hex(0, 1), 100],
        [1, hex(1, 1), 150],
      ]),
    );
    r.recordBatch(
      batch(2, [
        [1, hex(0, 1), 200],
        [1, hex(1, 1), 250],
      ]),
    );
    const s = r.samples(1);
    expect(s.map((x) => [x.cycle, x.t, x.val.v])).toEqual([
      [0, 0, "0"],
      [0, 50, "1"],
      [1, 100, "0"],
      [1, 150, "1"],
      [2, 200, "0"],
      [2, 250, "1"],
    ]);

    // Placed on the axis, the two halves of a cycle sit at .0 and .5.
    const tb = r.timebase();
    expect(tb.hasTime).toBe(true);
    expect(projectSamples(s, tb).map((p) => p.x)).toEqual([0, 0.5, 1, 1.5, 2, 2.5]);

    // And the trace alternates, half a cycle at each level: a square wave, not
    // the flat line a per-cycle sample produced.
    const segs = stepSegments(projectSamples(s, tb), 0, 3);
    expect(segs.map((g) => [g.from, g.to, g.val.v])).toEqual([
      [0, 0.5, "0"],
      [0.5, 1, "1"],
      [1, 1.5, "0"],
      [1.5, 2, "1"],
      [2, 2.5, "0"],
      [2.5, 3, "1"],
    ]);
  });

  it("places each cycle by its own observed length, so widths stay put", () => {
    const r = new WaveformRecorder();
    // Four cycles, each 200ns, one event each.
    for (let c = 0; c < 4; c++) r.recordBatch(batch(c, [[1, hex(c), c * 200]]));
    const tb = r.timebase();
    expect(tb.x(0, 0)).toBe(0);
    expect(tb.x(200, 1)).toBe(1);
    expect(tb.x(300, 1)).toBe(1.5); // halfway through cycle 1 (200..400)
    expect(r.lastCycle).toBe(3);
    expect(r.timeSpan).toEqual({ firstT: 0, firstCycle: 0, lastT: 600, lastCycle: 3 });
  });

  it("keeps an odd cycle's own width instead of rescaling the trace", () => {
    // The mock's first cycle really is longer: the full batch lands at t=0 while
    // the first tick's settle is at t=70, so cycle 0 runs 0..120 and cycle 1
    // 120..220.  Each cycle is one axis unit regardless — so cycle 0 shows a
    // longer low period, and nothing that follows is squeezed.
    const r = new WaveformRecorder();
    r.recordBatch(
      batch(0, [
        [1, hex(0, 1), 0],
        [1, hex(1, 1), 70],
      ]),
    );
    r.recordBatch(
      batch(1, [
        [1, hex(0, 1), 120],
        [1, hex(1, 1), 170],
      ]),
    );
    r.recordBatch(
      batch(2, [
        [1, hex(0, 1), 220],
        [1, hex(1, 1), 270],
      ]),
    );
    const tb = r.timebase();
    expect(projectSamples(r.samples(1), tb).map((p) => Math.round(p.x * 1e4) / 1e4)).toEqual([
      0, 0.5833, 1, 1.5, 2, 2.5,
    ]);
    // Cycle boundaries are whole numbers and stay there as more arrive.
    expect(tb.x(120, 1)).toBe(1);
    expect(tb.x(320, 3)).toBe(3);
  });

  it("does not move a cycle boundary when later cycles arrive", () => {
    // The property the scope model rests on: a cycle's edges are whole numbers,
    // so a growing run extends the trace instead of rescaling it.
    const r = new WaveformRecorder();
    r.recordBatch(
      batch(0, [
        [1, hex(0, 1), 0],
        [1, hex(1, 1), 50],
      ]),
    );
    r.recordBatch(
      batch(1, [
        [1, hex(0, 1), 100],
        [1, hex(1, 1), 150],
      ]),
    );
    const before = projectSamples(r.samples(1), r.timebase()).map((p) => p.x);
    for (let c = 2; c < 20; c++) {
      r.recordBatch(
        batch(c, [
          [1, hex(0, 1), c * 100],
          [1, hex(1, 1), c * 100 + 50],
        ]),
      );
    }
    const after = projectSamples(r.samples(1), r.timebase()).map((p) => p.x);
    expect(after.slice(0, before.length)).toEqual(before);
    // …and every cycle still occupies exactly one unit.
    expect(after[after.length - 1]).toBe(19.5);
  });

  it("keeps x inside its cycle even if the engine stamps past the end", () => {
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[1, hex(0), 0]]));
    r.recordBatch(batch(1, [[1, hex(1), 100]]));
    const tb = r.timebase();
    // An event stamped late must not land in the next cycle — x stays monotonic.
    expect(tb.x(150, 1)).toBeLessThanOrEqual(1.999);
    expect(tb.x(150, 1)).toBeGreaterThan(1);
  });

  it("falls back to whole cycles when the core sends no `at`", () => {
    const r = new WaveformRecorder();
    r.recordBatch({ cycle: 0, full: true, changes: [{ net: 1, val: hex(0) }] });
    r.recordBatch({ cycle: 1, full: false, changes: [{ net: 1, val: hex(1) }] });
    expect(r.hasTime).toBe(false);
    const tb = r.timebase();
    const placed = projectSamples(r.samples(1), tb);
    expect(placed.map((p) => p.x)).toEqual([0, 1]);
  });

  it("records no sample while a value holds, but records contention", () => {
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[1, hex(0, 1), 0]]));
    r.recordBatch(batch(0, [[1, hex(0, 1), 50]])); // same value, later event: nothing to draw
    expect(r.samples(1)).toHaveLength(1);
    r.recordBatch(batch(1, [[1, hex(0, 1), 100]]));
    expect(r.samples(1)).toHaveLength(1);
    // An X that becomes a *contended* X *is* news: the lane underlines it.
    r.recordBatch({
      cycle: 1,
      full: false,
      changes: [{ net: 1, val: X(4), at: 150, contended: true }],
    });
    r.recordBatch({ cycle: 2, full: false, changes: [{ net: 1, val: hex(5), at: 200 }] });
    expect(r.samples(1).map((s) => [s.t, s.val.v, s.contended === true])).toEqual([
      [0, "0", false],
      [150, "0", true],
      [200, "5", false],
    ]);
  });

  it("bounds itself, keeping the newest and admitting it dropped the past", () => {
    const r = new WaveformRecorder();
    for (let c = 0; c < WAVE_SAMPLE_CAP + 50; c++) {
      r.recordBatch(batch(c, [[1, hex(c % 16), c]]));
    }
    const s = r.samples(1);
    expect(s.length).toBeLessThanOrEqual(WAVE_SAMPLE_CAP);
    expect(s[s.length - 1].cycle).toBe(WAVE_SAMPLE_CAP + 49);
    expect(r.truncated.has(1)).toBe(true);
  });

  it("starts a fresh trace when the engine's cycle goes backwards", () => {
    // A load or reset that did not clear the recorder: cycles 0..3 are the old
    // run, and appending the new run's cycle 0 after them would put x out of
    // order — which is how a trace ends up overlapping itself.
    const r = new WaveformRecorder();
    for (let c = 0; c < 4; c++) r.recordBatch(batch(c, [[1, hex(c, 1), c * 100]]));
    expect(r.lastCycle).toBe(3);
    r.recordBatch(
      batch(0, [
        [1, hex(0, 1), 0],
        [1, hex(1, 1), 50],
      ]),
    );
    expect(r.lastCycle).toBe(0);
    expect(r.samples(1).map((s) => [s.cycle, s.t])).toEqual([
      [0, 0],
      [0, 50],
    ]);
    // …and the axis stays monotonic.
    const xs = projectSamples(r.samples(1), r.timebase()).map((p) => p.x);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });

  it("clears on request", () => {
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[1, hex(1), 0]]));
    r.clear();
    expect(r.netCount()).toBe(0);
    expect(r.timeSpan).toBeNull();
    expect(r.sampleCount).toBe(0);
    expect(r.hasTime).toBe(false);
  });
});

describe("valueAt and stepSegments on the axis", () => {
  const r = new WaveformRecorder();
  r.recordBatch(batch(3, [[1, hex(1), 300]]));
  r.recordBatch(batch(8, [[1, hex(2), 800]]));
  // Cycle 3 starts at t=300 and cycle 8 at t=800, so the derived period is 100ns
  // per cycle and these two events sit at whole cycles 3 and 8.
  const placed = projectSamples(r.samples(1), r.timebase());

  it("is null before the first sample", () => {
    expect(valueAt(placed, -1)).toBeNull();
  });

  it("holds a value between samples, on either side of an edge", () => {
    expect(valueAt(placed, 2)).toBeNull(); // before the trace starts
    expect(valueAt(placed, 3)?.val.v).toBe("1");
    expect(valueAt(placed, 5)?.val.v).toBe("1");
    expect(valueAt(placed, 8)?.val.v).toBe("2");
    expect(valueAt(placed, 100)?.val.v).toBe("2");
  });

  it("clips a window and holds the last value to its end", () => {
    expect(stepSegments(placed, 5, 9).map((g) => [g.from, g.to, g.val.v])).toEqual([
      [5, 8, "1"],
      [8, 9, "2"],
    ]);
  });

  it("returns nothing for an empty window or an empty trace", () => {
    expect(stepSegments(placed, 8, 8)).toEqual([]);
    expect(stepSegments([], 0, 10)).toEqual([]);
  });
});

describe("value rendering", () => {
  it("reads one bit as 0/1 and an unknown or floating value symbolically", () => {
    expect(waveText(hex(0, 1), 1)).toBe("0");
    expect(waveText(hex(1, 1), 1)).toBe("1");
    expect(waveText(X(1), 1)).toBe("X");
    expect(waveText(Z(1), 1)).toBe("Z");
  });

  it("pads a bus to its declared width and marks any unknown bit as X", () => {
    expect(waveText(hex(0xabc, 16), 16)).toBe("0ABC");
    expect(waveText(hex(5, 8), 8)).toBe("05");
    expect(waveText({ v: "f", x: "0", z: "0" }, 8)).toBe("0F");
    expect(waveText({ v: "0", x: "8", z: "0" }, 8)).toBe("X");
  });

  it("counts bits carried by the masks", () => {
    expect(valueBits(hex(1, 1))).toBe(4);
    expect(valueBits(hex(1, 16))).toBe(16);
  });
});

describe("bit expansion", () => {
  const val: WireValue = { v: "05", x: "00", z: "00" };

  it("extracts bits from the LSB up, across a nibble boundary", () => {
    expect(extractBit(val, 0).v).toBe("1");
    expect(extractBit(val, 1).v).toBe("0");
    expect(extractBit(val, 2).v).toBe("1");
    expect(extractBit(val, 3).v).toBe("0");
    expect(extractBit(val, 7).v).toBe("0");
    expect(extractBit(val, 40).v).toBe("0");
  });

  it("carries X and Z through to the bit lane", () => {
    expect(extractBit({ v: "0", x: "4", z: "0" }, 2).x).toBe("1");
    expect(extractBit({ v: "0", x: "0", z: "1" }, 0).z).toBe("1");
  });

  it("decides bus rows from the DECLARED width, not a value's masks", () => {
    // The mock reports a 32-bit mask for a 1-bit clock; deciding from the mask
    // would draw the clock as a bus.
    const clock: WaveSignal = {
      key: "k",
      label: "clk",
      net: 1,
      origin: "picked",
      kind: "clock",
      bits: 1,
    };
    const wide: WireValue = { v: "00000001", x: "00000000", z: "00000000" };
    expect(isBus(clock, wide)).toBe(false);
    const bus: WaveSignal = {
      key: "n",
      label: "pc",
      net: 2,
      origin: "named",
      kind: "register",
      bits: 32,
    };
    expect(isBus(bus, wide)).toBe(true);
    // With no declared width the masks are all there is to go on — and they are
    // nibble-aligned, which is exactly why the app resolves a width for every
    // signal it can rather than leaning on this.
    const picked: WaveSignal = {
      key: "w:3",
      label: "wire 3",
      net: 3,
      origin: "picked",
      kind: "wire",
    };
    expect(isBus(picked, wide)).toBe(true);
  });

  it("lists the lanes most significant first", () => {
    expect(bitLaneIndices(4)).toEqual([3, 2, 1, 0]);
  });
});

describe("defaultSignals", () => {
  const named: NamedComponent[] = [
    { name: "pc", kind: "register", circuit: "main", comp_id: 3, value_net: 11 },
    { name: "clk", kind: "probe", circuit: "main", comp_id: 4 },
    { name: "din", kind: "ram", circuit: "main", comp_id: 9, value_net: 20 },
  ];

  it("takes every named part the engine gave a value_net", () => {
    expect(defaultSignals(named).map((s) => [s.label, s.net])).toEqual([
      ["pc", 11],
      ["din", 20],
    ]);
  });

  it("skips a part with no value_net rather than inventing one", () => {
    expect(defaultSignals(named).some((s) => s.label === "clk")).toBe(false);
  });

  it("takes each part's declared width from the caller", () => {
    const bits = new Map([
      ["pc", 32],
      ["din", 8],
    ]);
    const s = defaultSignals(named, (n) => bits.get(n.name));
    expect(s.map((x) => [x.label, x.bits])).toEqual([
      ["pc", 32],
      ["din", 8],
    ]);
  });
});

describe("pickedSignals (Add selection)", () => {
  const wires = [
    { a: { comp: "c1", pin: "out" }, b: { comp: "c2", pin: "in" } },
    { a: { join: { wire: 0, segment: 0 } }, b: { comp: "c3", pin: "d" } },
  ];
  const wireToNet = new Map([
    [0, 11],
    [1, 12],
  ]);

  it("resolves a selected wire to its engine net", () => {
    const s = pickedSignals({ wires, wireToNet, selectedWires: [1] });
    expect(s.map((x) => [x.key, x.net])).toEqual([["w:1", 12]]);
  });

  it("resolves a selected pin through the wire that reaches it", () => {
    const s = pickedSignals({ wires, wireToNet, selectedPins: [{ comp: "c1", pin: "out" }] });
    expect(s.map((x) => [x.label, x.net])).toEqual([["c1.out", 11]]);
  });

  it("carries each pick's declared width from the document", () => {
    const bits = (comp: string, pin: string) =>
      comp === "c1" && pin === "out" ? 32 : pin === "in" ? 8 : undefined;
    const byWire = pickedSignals({ wires, wireToNet, selectedWires: [0], bitsOf: bits });
    expect(byWire.map((x) => [x.label, x.bits])).toEqual([["wire 0", 32]]);
    const byPin = pickedSignals({
      wires,
      wireToNet,
      selectedPins: [{ comp: "c2", pin: "in" }],
      bitsOf: bits,
    });
    expect(byPin.map((x) => [x.label, x.bits])).toEqual([["c2.in", 8]]);
  });

  it("never lists the same net twice, and skips a pin with no net", () => {
    const s = pickedSignals({
      wires,
      wireToNet,
      selectedWires: [0],
      selectedPins: [
        { comp: "c1", pin: "out" },
        { comp: "c9", pin: "out" },
      ],
    });
    expect(s).toHaveLength(1);
    expect(s[0].net).toBe(11);
  });
});

describe("clockSignals", () => {
  const wires = [
    { a: { comp: "clk1", pin: "out" }, b: { comp: "r1", pin: "clk" } },
    { a: { comp: "g1", pin: "out" }, b: { comp: "r1", pin: "d" } },
  ];
  const wireToNet = new Map([
    [0, 7],
    [1, 8],
  ]);
  const components = [
    { id: "clk1", type: "wiring.clock", name: "" },
    { id: "g1", type: "gate.and" },
    { id: "r1", type: "mem.register", name: "pc" },
  ];

  it("adds the clock, which is never a named part", () => {
    const s = clockSignals({ wires, wireToNet, components });
    expect(s.map((x) => [x.key, x.label, x.kind, x.net])).toEqual([["k:clk1", "clk", "clock", 7]]);
  });

  it("uses the clock's own name when it has one, and skips an unwired clock", () => {
    const named = clockSignals({
      wires,
      wireToNet,
      components: [
        { id: "clk1", type: "wiring.clock", name: "CLK50" },
        { id: "clk2", type: "wiring.clock" },
      ],
    });
    expect(named.map((x) => x.label)).toEqual(["CLK50"]);
  });
});
