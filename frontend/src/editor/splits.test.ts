import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPLITS,
  evenSplit,
  formatSplitBits,
  parseSplitBits,
  resizeSplits,
  sortSplits,
  splitCoverage,
  splitEntries,
} from "./splits";

/**
 * The splitter's UI is range-based and name-free (issue 4): these are the pure
 * parse/format/coverage/reflow rules the Inspector and the catalog share.
 */

describe("parseSplitBits", () => {
  it("parses single bits and comma/space-separated lists", () => {
    expect(parseSplitBits("0")).toEqual({ bits: [0], error: null });
    expect(parseSplitBits("0, 2  5")).toEqual({ bits: [0, 2, 5], error: null });
  });

  it("parses an ascending range inclusively", () => {
    expect(parseSplitBits("0-3")).toEqual({ bits: [0, 1, 2, 3], error: null });
  });

  it("parses a descending range backwards (the direction is meaningful)", () => {
    expect(parseSplitBits("7-4")).toEqual({ bits: [7, 6, 5, 4], error: null });
  });

  it("mixes ranges and singles in one row", () => {
    expect(parseSplitBits("0-3, 8, 12-15")).toEqual({
      bits: [0, 1, 2, 3, 8, 12, 13, 14, 15],
      error: null,
    });
  });

  it("reports a bad token without dropping the good ones", () => {
    const parsed = parseSplitBits("0-3, what, 8");
    expect(parsed.bits).toEqual([0, 1, 2, 3, 8]);
    expect(parsed.error).toContain("what");
  });

  it("accepts a range with spaces around the dash", () => {
    expect(parseSplitBits("0 - 2").bits).toEqual([0, 1, 2]);
  });
});

describe("formatSplitBits", () => {
  it("is empty for no bits", () => {
    expect(formatSplitBits([])).toBe("");
  });

  it("compresses ascending and descending runs into ranges", () => {
    expect(formatSplitBits([0, 1, 2, 3])).toBe("0-3");
    expect(formatSplitBits([3, 2, 1, 0])).toBe("3-0");
  });

  it("keeps a lone bit alone and joins the pieces with commas", () => {
    expect(formatSplitBits([5])).toBe("5");
    expect(formatSplitBits([0, 2, 3])).toBe("0, 2-3");
    expect(formatSplitBits([0, 1, 2, 3, 8, 7, 6])).toBe("0-3, 8-6");
  });

  it("round-trips every canonical spelling", () => {
    for (const bits of [[0], [0, 1], [7, 6, 5, 4], [0, 2, 3], [0, 1, 2, 3, 8, 7, 6]]) {
      expect(parseSplitBits(formatSplitBits(bits)).bits).toEqual(bits);
    }
  });
});

describe("sortSplits", () => {
  it("orders by lowest bit, then highest, then name", () => {
    const sorted = sortSplits([
      { name: "hi", bits: [8, 9] },
      { name: "lo", bits: [0, 1] },
      { name: "mid", bits: [4, 5] },
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["lo", "mid", "hi"]);
  });

  it("puts empty rows last", () => {
    const sorted = sortSplits([
      { name: "empty", bits: [] },
      { name: "b", bits: [2] },
    ]);
    expect(sorted.map((s) => s.name)).toEqual(["b", "empty"]);
  });
});

describe("splitEntries", () => {
  it("reads the attr into name/bits entries", () => {
    expect(splitEntries({ lo: [0, 1], hi: [2, 3] })).toEqual([
      { name: "lo", bits: [0, 1] },
      { name: "hi", bits: [2, 3] },
    ]);
  });

  it("falls back to the default mapping for a missing or empty value", () => {
    expect(splitEntries(undefined)).toEqual(
      Object.entries(DEFAULT_SPLITS).map(([name, bits]) => ({ name, bits: [...bits] })),
    );
    expect(splitEntries({})).toHaveLength(4);
  });
});

describe("splitCoverage", () => {
  it("counts bus bits, missing bits, duplicates, and outputs", () => {
    const coverage = splitCoverage([
      { name: "a", bits: [0, 1, 2] },
      { name: "b", bits: [2, 3] },
    ]);
    expect(coverage.outputs).toBe(2);
    expect(coverage.busBits).toBe(4);
    expect(coverage.duplicates).toEqual([2]);
    expect(coverage.missing).toEqual([]);
  });

  it("reports gaps up to the highest mapped bit", () => {
    const coverage = splitCoverage([{ name: "a", bits: [0, 3] }]);
    expect(coverage.busBits).toBe(4);
    expect(coverage.missing).toEqual([1, 2]);
    expect(coverage.duplicates).toEqual([]);
  });
});

describe("evenSplit", () => {
  it("distributes the bus evenly, ascending, with the remainder first", () => {
    expect(evenSplit(8, 4)).toEqual([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 7],
    ]);
    expect(evenSplit(10, 3)).toEqual([
      [0, 1, 2, 3],
      [4, 5, 6],
      [7, 8, 9],
    ]);
  });

  it("keeps every output non-empty", () => {
    expect(evenSplit(2, 4)).toEqual([[0], [1]]);
    expect(evenSplit(0, 3)).toEqual([[0]]);
  });
});

describe("resizeSplits", () => {
  it("extends the last split with the new bits", () => {
    const resized = resizeSplits(
      [
        { name: "lo", bits: [0, 1] },
        { name: "hi", bits: [2, 3] },
      ],
      6,
    );
    expect(resized).toEqual([
      { name: "lo", bits: [0, 1] },
      { name: "hi", bits: [2, 3, 4, 5] },
    ]);
  });

  it("truncates and drops a split that becomes empty", () => {
    const resized = resizeSplits(
      [
        { name: "lo", bits: [0, 1] },
        { name: "hi", bits: [2, 3] },
      ],
      2,
    );
    expect(resized).toEqual([{ name: "lo", bits: [0, 1] }]);
  });

  it("fills a gap from the last split when the bus grows", () => {
    const resized = resizeSplits([{ name: "sparse", bits: [0, 2] }], 4);
    expect(resized[0].bits).toEqual([0, 2, 1, 3]);
  });
});
