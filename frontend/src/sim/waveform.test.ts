import { describe, expect, it } from "vitest";

import type { NamedComponent, NetDiffs, WireValue } from "../ipc/types";
import {
  WAVE_SAMPLE_CAP,
  WaveformRecorder,
  bitLaneIndices,
  defaultSignals,
  extractBit,
  pickedSignals,
  stepSegments,
  valueAt,
  valueBits,
  waveText,
} from "./waveform";

const hex = (v: number, bits = 4): WireValue => ({
  v: v.toString(16).padStart(Math.ceil(bits / 4), "0"),
  x: "0",
  z: "0",
});
const X = (bits = 1): WireValue => ({ v: "0", x: "1".repeat(Math.ceil(bits / 4)), z: "0" });
const Z = (bits = 1): WireValue => ({ v: "0", x: "0", z: "1".repeat(Math.ceil(bits / 4)) });

const batch = (cycle: number, changes: Array<[number, WireValue]>, full = false): NetDiffs => ({
  cycle,
  full,
  changes: changes.map(([net, val]) => ({ net, val })),
});

describe("WaveformRecorder", () => {
  it("keeps every cycle even when many arrive before a paint", () => {
    // The whole point: DiffPump merges batches per frame, so a recorder that
    // read the merged frame would see only cycle 3's value.
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[7, hex(0)]]));
    r.recordBatch(batch(1, [[7, hex(1)]]));
    r.recordBatch(batch(2, [[7, hex(2)]]));
    r.recordBatch(batch(3, [[7, hex(3)]]));
    expect(r.samples(7).map((s) => [s.cycle, s.val.v])).toEqual([
      [0, "0"],
      [1, "1"],
      [2, "2"],
      [3, "3"],
    ]);
    expect(r.span).toEqual({ first: 0, last: 3 });
  });

  it("collapses repeated changes inside one cycle to the last value", () => {
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[1, hex(0)]]));
    r.recordBatch(batch(5, [[1, hex(9)]]));
    r.recordBatch(batch(5, [[1, hex(3)]]));
    expect(r.samples(1).map((s) => [s.cycle, s.val.v])).toEqual([
      [0, "0"],
      [5, "3"],
    ]);
  });

  it("holds a value across cycles in which nothing changed", () => {
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[1, hex(0)]]));
    r.recordBatch(batch(1, [[1, hex(0)]])); // same value: no new sample
    r.recordBatch(batch(9, [[1, hex(1)]]));
    expect(r.samples(1).length).toBe(2);
    expect(valueAt(r.samples(1), 4)?.val.v).toBe("0");
    expect(valueAt(r.samples(1), 9)?.val.v).toBe("1");
  });

  it("seeds the initial full batch so a trace starts defined", () => {
    const r = new WaveformRecorder();
    r.recordBatch(
      batch(
        0,
        [
          [1, hex(0)],
          [2, hex(7)],
        ],
        true,
      ),
    );
    expect(r.netCount()).toBe(2);
    expect(valueAt(r.samples(2), 0)?.val.v).toBe("7");
  });

  it("carries the contention flag, and clears it on the next change", () => {
    const r = new WaveformRecorder();
    r.recordBatch({ cycle: 0, full: false, changes: [{ net: 1, val: X(4), contended: true }] });
    expect(r.samples(1)[0].contended).toBe(true);
    r.recordBatch(batch(1, [[1, hex(5)]]));
    expect(r.samples(1)[1].contended).toBeUndefined();
  });

  it("bounds itself, keeping the newest and admitting it dropped the past", () => {
    const r = new WaveformRecorder();
    for (let c = 0; c < WAVE_SAMPLE_CAP + 50; c++) {
      r.recordBatch(batch(c, [[1, hex(c % 16)]]));
    }
    const s = r.samples(1);
    expect(s.length).toBeLessThanOrEqual(WAVE_SAMPLE_CAP);
    // Newest kept.
    expect(s[s.length - 1].cycle).toBe(WAVE_SAMPLE_CAP + 49);
    expect(r.truncated.has(1)).toBe(true);
  });

  it("clears on request", () => {
    const r = new WaveformRecorder();
    r.recordBatch(batch(0, [[1, hex(1)]]));
    r.clear();
    expect(r.netCount()).toBe(0);
    expect(r.span).toBeNull();
    expect(r.sampleCount).toBe(0);
  });
});

describe("valueAt", () => {
  const r = new WaveformRecorder();
  r.recordBatch(batch(3, [[1, hex(1)]]));
  r.recordBatch(batch(8, [[1, hex(2)]]));
  const s = r.samples(1);

  it("is null before the first sample", () => {
    expect(valueAt(s, 2)).toBeNull();
  });
  it("is exact on a sample boundary and holds between samples", () => {
    expect(valueAt(s, 3)?.val.v).toBe("1");
    expect(valueAt(s, 5)?.val.v).toBe("1");
    expect(valueAt(s, 8)?.val.v).toBe("2");
    expect(valueAt(s, 100)?.val.v).toBe("2");
  });
});

describe("stepSegments", () => {
  const r = new WaveformRecorder();
  r.recordBatch(batch(0, [[1, hex(1)]]));
  r.recordBatch(batch(2, [[1, hex(2)]]));
  r.recordBatch(batch(6, [[1, hex(3)]]));
  const s = r.samples(1);

  it("clips the window and holds the tail to its end", () => {
    const segs = stepSegments(s, 1, 8);
    expect(segs.map((g) => [g.from, g.to, g.val.v])).toEqual([
      [1, 2, "1"],
      [2, 6, "2"],
      [6, 8, "3"],
    ]);
  });

  it("returns nothing before the trace starts or for an empty window", () => {
    expect(stepSegments(s, -5, -1)).toEqual([]);
    expect(stepSegments(s, 4, 4)).toEqual([]);
    expect(stepSegments([], 0, 10)).toEqual([]);
  });

  it("covers a window that falls entirely inside one held value", () => {
    const segs = stepSegments(s, 3, 5);
    expect(segs.map((g) => [g.from, g.to, g.val.v])).toEqual([[3, 5, "2"]]);
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
    // A bus with one X bit reads as X, matching how the canvas colours it.
    expect(waveText({ v: "f", x: "0", z: "0" }, 8)).toBe("0F");
    expect(waveText({ v: "0", x: "8", z: "0" }, 8)).toBe("X");
  });

  it("counts bits carried by the masks", () => {
    expect(valueBits(hex(1, 1))).toBe(4);
    expect(valueBits(hex(1, 16))).toBe(16);
  });
});

describe("bit expansion", () => {
  // 0x5 across two nibbles: bit 0 and bit 2 set.
  const val: WireValue = { v: "05", x: "00", z: "00" };

  it("extracts bits from the LSB up, across a nibble boundary", () => {
    expect(extractBit(val, 0).v).toBe("1");
    expect(extractBit(val, 1).v).toBe("0");
    expect(extractBit(val, 2).v).toBe("1");
    expect(extractBit(val, 3).v).toBe("0");
    expect(extractBit(val, 7).v).toBe("0");
    // Beyond the masks is 0, not a crash.
    expect(extractBit(val, 40).v).toBe("0");
  });

  it("carries X and Z through to the bit lane", () => {
    expect(extractBit({ v: "0", x: "4", z: "0" }, 2).x).toBe("1");
    expect(extractBit({ v: "0", x: "0", z: "1" }, 0).z).toBe("1");
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
    const s = pickedSignals({
      wires,
      wireToNet,
      selectedPins: [{ comp: "c1", pin: "out" }],
    });
    expect(s.map((x) => [x.label, x.net])).toEqual([["c1.out", 11]]);
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
