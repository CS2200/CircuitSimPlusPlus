/**
 * `rle-hex-v1` (docs/format-v2.md §7): the memory-image encoding used by
 * `attrs.contents` and by `.hex` autoload files. A token is a bare hex word
 * or `count-word` (a run). Canonical encoding pads words to the memory's hex
 * width and collapses runs of length ≥ 2.
 *
 * Decoders bound expansion so a hostile `999999999-ffff` can never OOM the UI
 * (format-v2 §7/§11).
 */

/** Documented memory depth cap (format-v2 §8) — the expansion bound. */
export const MAX_MEMORY_WORDS = 1 << 20;

/** Hex digits needed to display a `bitsize`-wide word. */
export function hexWidthFor(bitsize: number): number {
  return Math.max(1, Math.ceil(Math.max(1, bitsize) / 4));
}

/** Mask for a `bitsize`-wide word (bitsize ≥ 32 → all ones). */
export function maskFor(bitsize: number): number {
  return bitsize >= 32 ? 0xffffffff : (1 << Math.max(1, bitsize)) - 1;
}

/** Parse an rle-hex image into words (index 0 = address 0). */
export function parseRleHex(text: string, maxWords = MAX_MEMORY_WORDS): number[] {
  const out: number[] = [];
  const trimmed = text.trim();
  if (trimmed === "") return out;
  for (const token of trimmed.split(/\s+/)) {
    const run = /^(\d+)-([0-9a-fA-F]{1,16})$/.exec(token);
    if (run !== null) {
      const count = Number(run[1]);
      if (!Number.isFinite(count) || count < 1) {
        throw new Error(`rle-hex: bad run count in "${token}"`);
      }
      if (out.length + count > maxWords) {
        throw new Error(`rle-hex: image exceeds ${maxWords} words`);
      }
      const value = Number(BigInt(`0x${run[2]}`));
      for (let i = 0; i < count; i++) out.push(value);
      continue;
    }
    if (!/^[0-9a-fA-F]{1,16}$/.test(token)) {
      throw new Error(`rle-hex: bad token "${token}"`);
    }
    if (out.length + 1 > maxWords) throw new Error(`rle-hex: image exceeds ${maxWords} words`);
    out.push(Number(BigInt(`0x${token}`)));
  }
  return out;
}

/** Canonical rle-hex: words padded to `hexWidth` digits, runs ≥ 2 collapsed. */
export function encodeRleHex(words: readonly number[], hexWidth: number): string {
  const width = Math.max(1, Math.round(hexWidth));
  const hex = (word: number): string => (word >>> 0).toString(16).padStart(width, "0");
  const tokens: string[] = [];
  let i = 0;
  while (i < words.length) {
    const value = words[i] >>> 0;
    let run = 1;
    while (i + run < words.length && words[i + run] >>> 0 === value) run++;
    tokens.push(run >= 2 ? `${run}-${hex(value)}` : hex(value));
    i += run;
  }
  return tokens.join(" ");
}

/** Padded hex cells for the table (one per word), `hexWidth` digits each. */
export function hexCells(words: readonly number[], hexWidth: number): string[] {
  const width = Math.max(1, Math.round(hexWidth));
  return words.map((w) => (w >>> 0).toString(16).padStart(width, "0"));
}

/**
 * Parse user-pasted hex (rle-hex or plain whitespace-separated words),
 * masking each value to the memory's bitsize. Returns an error message
 * instead of throwing so the dialog can show it inline.
 */
export function wordsFromPasted(
  text: string,
  bitsize: number,
  maxWords = MAX_MEMORY_WORDS,
): { words: number[]; error: string | null } {
  try {
    const mask = maskFor(bitsize);
    return { words: parseRleHex(text, maxWords).map((w) => (w & mask) >>> 0), error: null };
  } catch (err) {
    return { words: [], error: err instanceof Error ? err.message : String(err) };
  }
}
