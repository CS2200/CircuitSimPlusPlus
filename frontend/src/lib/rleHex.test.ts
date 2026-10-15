import { describe, expect, it } from "vitest";
import {
  MAX_MEMORY_WORDS,
  encodeRleHex,
  hexCells,
  hexWidthFor,
  maskFor,
  parseRleHex,
  wordsFromPasted,
} from "./rleHex";

describe("rle-hex codec (format-v2 §7)", () => {
  it("parses bare words and count-runs", () => {
    expect(parseRleHex("0a 0b 3-ff")).toEqual([0x0a, 0x0b, 0xff, 0xff, 0xff]);
    expect(parseRleHex("ffff")).toEqual([0xffff]);
    expect(parseRleHex("")).toEqual([]);
  });

  it("rejects malformed tokens and hostile expansion", () => {
    expect(() => parseRleHex("zz")).toThrow(/bad token/);
    expect(() => parseRleHex("0-ff")).toThrow(/bad run count/);
    expect(() => parseRleHex("999999999-ffff")).toThrow(/exceeds/);
    expect(parseRleHex("3-ff", 3)).toHaveLength(3);
    expect(() => parseRleHex("3-ff", 2)).toThrow(/exceeds/);
  });

  it("encodes canonically: padded words, runs of ≥ 2 collapsed", () => {
    expect(encodeRleHex([0xa, 0xb, 0xc, 0xc, 0xc], 8)).toBe("0000000a 0000000b 3-0000000c");
    expect(encodeRleHex([1, 1], 4)).toBe("2-0001");
    expect(encodeRleHex([], 4)).toBe("");
    expect(encodeRleHex([0x1ffff], 16)).toBe("000000000001ffff");
    expect(encodeRleHex([0x1f], 2)).toBe("1f");
  });

  it("round-trips through canonical encoding", () => {
    const words = [0, 0, 5, 5, 7, 0xdeadbeef];
    expect(parseRleHex(encodeRleHex(words, 8))).toEqual(words);
  });

  it("width helpers", () => {
    expect(hexWidthFor(1)).toBe(1);
    expect(hexWidthFor(4)).toBe(1);
    expect(hexWidthFor(5)).toBe(2);
    expect(hexWidthFor(32)).toBe(8);
    expect(maskFor(1)).toBe(1);
    expect(maskFor(8)).toBe(0xff);
    expect(maskFor(32)).toBe(0xffffffff);
    expect(hexCells([0x1f, 0], 2)).toEqual(["1f", "00"]);
  });

  it("wordsFromPasted masks to the memory width and reports errors", () => {
    const ok = wordsFromPasted("1ff ff", 8);
    expect(ok.error).toBeNull();
    expect(ok.words).toEqual([0xff, 0xff]);
    const bad = wordsFromPasted("nope", 8);
    expect(bad.error).toMatch(/bad token/);
    expect(bad.words).toEqual([]);
    expect(MAX_MEMORY_WORDS).toBe(1 << 20);
  });
});
