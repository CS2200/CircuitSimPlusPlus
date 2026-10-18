/**
 * Value <-> text in a chosen display radix (UI_OVERHAUL §55). Shared by the
 * Inspector's constant field and the register's inline value editor, so a
 * value is read and typed the same way wherever it is edited.
 */

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
