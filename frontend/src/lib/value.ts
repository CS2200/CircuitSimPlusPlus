import type { WireValue } from "../ipc/types";

/**
 * Format a 4-state wire value as a bit string (MSB first), e.g. "01XZ".
 * X wins over Z if a bit were ever (illegally) in both masks.
 */
export function formatWireValue(val: WireValue): string {
  const v = BigInt(`0x${val.v || "0"}`);
  const x = BigInt(`0x${val.x || "0"}`);
  const z = BigInt(`0x${val.z || "0"}`);
  const width = Math.max(val.v.length, val.x.length, val.z.length) * 4;
  if (width === 0) return "";

  let out = "";
  for (let i = width - 1; i >= 0; i--) {
    const bit = 1n << BigInt(i);
    if ((x & bit) !== 0n) out += "X";
    else if ((z & bit) !== 0n) out += "Z";
    else out += (v & bit) !== 0n ? "1" : "0";
  }
  return out;
}
