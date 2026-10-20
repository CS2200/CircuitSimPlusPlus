/**
 * Value <-> text in a chosen display radix (UI_OVERHAUL §55). Shared by the
 * Inspector's constant field and the register's inline value editor, so a
 * value is read and typed the same way wherever it is edited.
 */

import { hexWidthFor } from "./rleHex";

/**
 * A stored value read out on a part's body: the configured radix, PADDED to the
 * part's width — so widening a pin to 8 bits shows two hex digits where 4 bits
 * showed one. It used to echo the stored string verbatim, so a wider pin looked
 * identical (the tester expected the text to grow with the bit size). This lives
 * here beside {@link formatRadixValue} because more than the canvas reads it now:
 * a breakpoint's condition reads the same on its body and in the trace's name
 * column (UI_OVERHAUL §90), exactly as `lib/value.ts` keeps a value's *colour* the
 * same in both places (§35).
 */
export function radixText(hex: string, radix: unknown, bits: number): string {
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return hex;
  const w = Math.min(32, Math.max(1, bits));
  if (radix === "bin") return `0b${n.toString(2).padStart(w, "0")}`;
  if (radix === "dec") return String(n);
  return `0x${n.toString(16).toUpperCase().padStart(hexWidthFor(w), "0")}`;
}

/** Render a stored hex value in `radix` for display (no 0x/0b prefix). */
export function formatRadixValue(hex: string, radix: string, bits: number): string {
  const n = Number.parseInt(hex === "" ? "0" : hex, 16);
  if (!Number.isFinite(n)) return hex;
  if (radix === "bin") return n.toString(2).padStart(Math.min(32, Math.max(1, bits)), "0");
  if (radix === "dec") return String(n);
  return hex.toUpperCase();
}

/**
 * Parse text typed in `radix` back to a normalized hex string, or null when it
 * is not a valid/representable value for the bit width.
 */
export function parseRadixValue(text: string, radix: string, bits: number): string | null {
  const t = text
    .trim()
    .replace(/^0[xX]/, "")
    .replace(/^0[bB]/, "");
  if (t === "") return "0";
  const ok = radix === "bin" ? /^[01]+$/ : radix === "dec" ? /^[0-9]+$/ : /^[0-9a-fA-F]+$/;
  if (!ok.test(t)) return null;
  const n = Number.parseInt(t, radix === "bin" ? 2 : radix === "dec" ? 10 : 16);
  if (!Number.isFinite(n)) return null;
  if (n >= 2 ** Math.min(32, Math.max(1, bits))) return null; // doesn't fit
  return n.toString(16);
}

/**
 * Like {@link parseRadixValue} but MASKING to the width instead of rejecting
 * overflow: extra high bits/digits are dropped at the most-significant end, so
 * continued typing behaves like a fixed-width shift (1 then 0 on a 1-bit
 * register → 0). Returns null only for invalid characters.
 */
export function parseRadixValueMasked(text: string, radix: string, bits: number): string | null {
  const t = text
    .trim()
    .replace(/^0[xX]/, "")
    .replace(/^0[bB]/, "");
  if (t === "") return null;
  const ok = radix === "bin" ? /^[01]+$/ : radix === "dec" ? /^[0-9]+$/ : /^[0-9a-fA-F]+$/;
  if (!ok.test(t)) return null;
  const n = Number.parseInt(t, radix === "bin" ? 2 : radix === "dec" ? 10 : 16);
  if (!Number.isFinite(n)) return null;
  const w = Math.min(32, Math.max(1, bits));
  const mask = w >= 32 ? 0xffffffff : 2 ** w - 1;
  return ((n & mask) >>> 0).toString(16);
}
