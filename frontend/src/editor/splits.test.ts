import { describe, expect, it } from "vitest";
import {
  DEFAULT_SPLITS,
  evenSplit,
  formatSplitBits,
  parseSplitBits,
  sortSplits,
  splitBusBits,
  splitCoverage,
  splitEntries,
  trimSplits,
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
    expect(coverage.outside).toEqual([]);
  });

  it("reports gaps up to the highest mapped bit when no width is given", () => {
    const coverage = splitCoverage([{ name: "a", bits: [0, 3] }]);
    expect(coverage.busBits).toBe(4);
    expect(coverage.missing).toEqual([1, 2]);
    expect(coverage.duplicates).toEqual([]);
    expect(coverage.outside).toEqual([]);
  });

  it("uses the declared width, so low bits can be tapped from a wide bus", () => {
    const coverage = splitCoverage([{ name: "lo", bits: [0, 1] }], 32);
    expect(coverage.busBits).toBe(32);
    expect(coverage.missing).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
      27, 28, 29, 30, 31,
    ]);
  });

  it("flags mapped bits at or above the declared width", () => {
    const coverage = splitCoverage([{ name: "a", bits: [0, 4] }], 4);
    expect(coverage.outside).toEqual([4]);
    expect(coverage.missing).toEqual([1, 2, 3]);
  });
});

describe("splitBusBits", () => {
  it("prefers the explicit width and falls back to max+1", () => {
    expect(splitBusBits(32, { lo: [0, 1] })).toBe(32);
    expect(splitBusBits(undefined, { lo: [0, 1] })).toBe(2);
    expect(splitBusBits(0, { lo: [0, 1] })).toBe(2);
    expect(splitBusBits(undefined, undefined)).toBe(4); // DEFAULT_SPLITS
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

describe("trimSplits", () => {
  it("drops bits that fall outside the new width and removes empty splits", () => {
    const trimmed = trimSplits(
      [
        { name: "lo", bits: [0, 1] },
        { name: "hi", bits: [2, 3] },
      ],
      2,
    );
    expect(trimmed).toEqual([{ name: "lo", bits: [0, 1] }]);
  });

  it("keeps interior gaps when the width still contains them", () => {
    const trimmed = trimSplits(
      [
        { name: "lo", bits: [0, 1] },
        { name: "hi", bits: [4, 5] },
      ],
      8,
    );
    expect(trimmed).toEqual([
      { name: "lo", bits: [0, 1] },
      { name: "hi", bits: [4, 5] },
    ]);
  });

  it("falls back to one even split when everything is trimmed away", () => {
    const trimmed = trimSplits([{ name: "hi", bits: [4, 5] }], 2);
    expect(trimmed).toEqual([{ name: "b0", bits: [0, 1] }]);
  });
});
