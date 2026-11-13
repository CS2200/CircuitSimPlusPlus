/**
 * Splitter mapping helpers (UI_OVERHAUL §41).
 *
 * A `wiring.splitter`'s `splits` attr maps each split pin's **name** to the bus
 * bit indices that pin carries (index 0 of the array is the pin's LSB). The name
 * is a wire identity, not a label anyone wants to type, so the Inspector hides
 * it and orders rows by the bus bits instead. This module is the pure half of
 * that editor: parse the raw attr, parse/format a row's bit text as ranges
 * (`0-3`, `7-4` — the direction is meaningful), and check coverage.
 *
 * The `.csx` format is unchanged: names stay in the file, and the engine still
 * sorts split pins by name. The UI just never shows them.
 */

export interface SplitEntry {
  /** Internal pin name (wire identity); never shown in the UI. */
  name: string;
  /** Bus bit indices in the order this split carries them (array position = bit). */
  bits: number[];
}

/** Default splitter mapping (format-v2 §4 requires `splits`): b{i} = bus bit i. */
export const DEFAULT_SPLITS: Readonly<Record<string, number[]>> = {
  b0: [0],
  b1: [1],
  b2: [2],
  b3: [3],
};

/** One raw `splits` value as entries, falling back to the default mapping. */
export function splitEntries(value: unknown): SplitEntry[] {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: SplitEntry[] = [];
    for (const [name, bits] of Object.entries(value as Record<string, unknown>)) {
      if (!Array.isArray(bits)) continue;
      out.push({
        name,
        bits: bits.filter(
          (b): b is number => typeof b === "number" && Number.isInteger(b) && b >= 0,
        ),
      });
    }
    if (out.length > 0) return out;
  }
  return Object.entries(DEFAULT_SPLITS).map(([name, bits]) => ({ name, bits: [...bits] }));
}

/** The lowest bus bit a row carries (Infinity for an empty row). */
function lowestBit(entry: SplitEntry): number {
  return entry.bits.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...entry.bits);
}

/** Display order: by lowest bit, then highest bit, then name (all deterministic). */
export function sortSplits(entries: readonly SplitEntry[]): SplitEntry[] {
  return [...entries].sort((a, b) => {
    const al = lowestBit(a);
    const bl = lowestBit(b);
    if (al !== bl) return al - bl;
    const ah = a.bits.length === 0 ? -1 : Math.max(...a.bits);
    const bh = b.bits.length === 0 ? -1 : Math.max(...b.bits);
    if (ah !== bh) return ah - bh;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Parse one split's bit text. Tokens are comma/space separated; each is a bit
 * (`5`) or an inclusive range (`0-3` ascending, `7-4` descending). Invalid
 * tokens are reported but do not abort the parse.
 */
export function parseSplitBits(text: string): { bits: number[]; error: string | null } {
  const bits: number[] = [];
  let error: string | null = null;
  // `0 - 2` is the same range as `0-2`; tighten the dash before tokenizing.
  for (const token of text
    .replace(/\s*-\s*/g, "-")
    .split(/[\s,]+/)
    .filter((t) => t !== "")) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(token);
    if (range !== null) {
      const a = Number(range[1]);
      const b = Number(range[2]);
      if (a <= b) for (let i = a; i <= b; i++) bits.push(i);
      else for (let i = a; i >= b; i--) bits.push(i);
      continue;
    }
    if (/^\d+$/.test(token)) {
      bits.push(Number(token));
      continue;
    }
    error ??= `not a bit or range: "${token}"`;
  }
  return { bits, error };
}

/**
 * Compress a bit list back into range text, preserving direction and order:
 * `[0,1,2,3]` → `"0-3"`, `[7,6,5,4]` → `"7-4"`, `[0,2,3]` → `"0, 2-3"`.
 */
export function formatSplitBits(bits: readonly number[]): string {
  if (bits.length === 0) return "";
  const parts: string[] = [];
  let i = 0;
  while (i < bits.length) {
    const dir = i + 1 < bits.length ? bits[i + 1] - bits[i] : 0;
    let j = i;
    if (Math.abs(dir) === 1) {
      while (j + 1 < bits.length && bits[j + 1] - bits[j] === dir) j++;
    }
    parts.push(j > i ? `${bits[i]}-${bits[j]}` : `${bits[i]}`);
    i = j + 1;
  }
  return parts.join(", ");
}

export interface SplitCoverage {
  /** Declared bus width (the `busBits` attr), or max(mapped)+1 for old docs. */
  busBits: number;
  /** Bus bits in 0..busBits-1 that no split carries (allowed; shown as unmapped). */
  missing: number[];
  /** Mapped bits at or above `busBits` — invalid. */
  outside: number[];
  /** Bus bits carried by more than one split (in more than one position). */
  duplicates: number[];
  /** Number of split outputs. */
  outputs: number;
}

/** The declared bus width, falling back to the legacy max(mapped)+1 inference. */
export function splitBusBits(busBits: unknown, splits: unknown): number {
  if (typeof busBits === "number" && Number.isInteger(busBits) && busBits >= 1) return busBits;
  return splitCoverage(splitEntries(splits)).busBits;
}

/**
 * Coverage facts for the editor's live summary. Unmapped bits are legal — a
 * splitter can tap a subset of a bus. The invalid mappings are a bit outside
 * the declared width, a bit carried by more than one pin, and an empty split
 * (which the engine also rejects).
 */
export function splitCoverage(
  entries: readonly SplitEntry[],
  declaredBusBits?: number,
): SplitCoverage {
  const counts = new Map<number, number>();
  let max = -1;
  for (const entry of entries) {
    for (const bit of entry.bits) {
      counts.set(bit, (counts.get(bit) ?? 0) + 1);
      if (bit > max) max = bit;
    }
  }
  const busBits =
    declaredBusBits !== undefined && Number.isInteger(declaredBusBits) && declaredBusBits >= 1
      ? declaredBusBits
      : Math.max(1, max + 1);
  const missing: number[] = [];
  for (let bit = 0; bit < busBits; bit++) if (!counts.has(bit)) missing.push(bit);
  const outside = [...counts.keys()].filter((bit) => bit >= busBits).sort((a, b) => a - b);
  const duplicates = [...counts.entries()]
    .filter(([, n]) => n > 1)
    .map(([bit]) => bit)
    .sort((a, b) => a - b);
  return { busBits, missing, outside, duplicates, outputs: entries.length };
}

/**
 * Evenly distribute `bits` bus bits across `outputs` splits, ascending:
 * 16 bits / 3 outputs → `[0..5], [6..10], [11..15]`. Clamped so every output
 * gets at least one bit (a split must be non-empty).
 */
export function evenSplit(bits: number, outputs: number): number[][] {
  const total = Math.max(1, Math.floor(bits));
  const count = Math.max(1, Math.min(Math.floor(outputs), total));
  const base = Math.floor(total / count);
  const extra = total % count;
  const out: number[][] = [];
  let bit = 0;
  for (let i = 0; i < count; i++) {
    const width = base + (i < extra ? 1 : 0);
    const row: number[] = [];
    for (let j = 0; j < width; j++) row.push(bit++);
    out.push(row);
  }
  return out;
}

/**
 * Trim a mapping to `busBits`: bits at or above the width are dropped, splits
 * left empty are removed, and a fully-empty mapping falls back to one even
 * split. Used when the top "Bus bits" number shrinks; widening leaves the
 * mapping alone, so the extra bits stay unmapped.
 */
export function trimSplits(entries: readonly SplitEntry[], busBits: number): SplitEntry[] {
  const next = entries
    .map((entry) => ({
      name: entry.name,
      bits: entry.bits.filter((bit) => bit < busBits),
    }))
    .filter((entry) => entry.bits.length > 0);
  if (next.length > 0) return next;
  return evenSplit(busBits, 1).map((bits, i) => ({ name: `b${i}`, bits }));
}
