/**
 * Breakpoint readouts (UI_OVERHAUL §90). One formatter, because "what does this
 * breakpoint stop on?" is asked in two places — the part's body on the canvas and
 * the trace's name column — and the two had better agree, exactly as a value's
 * colour does between the canvas and the trace (§35).
 */

import { radixText } from "./radix";

/** The default watched value: the format's, so an untouched part reads `= 0x0`. */
const DEFAULT_VALUE = "0";
const RADIXES = ["hex", "bin", "dec"] as const;

/** The `value` attr as a hex string (mirrors the engine's parse). */
function valueOf(attrs: Readonly<Record<string, unknown>> | undefined): string {
  const value = attrs?.["value"];
  return typeof value === "string" ? value : DEFAULT_VALUE;
}

/** The `radix` attr, restricted to what the engine accepts. */
function radixOf(attrs: Readonly<Record<string, unknown>> | undefined): string {
  const radix = attrs?.["radix"];
  return typeof radix === "string" && (RADIXES as readonly string[]).includes(radix)
    ? radix
    : "hex";
}

/** The `bitsize` attr in the pin-width range the registry allows (1..=32). */
function bitsOf(attrs: Readonly<Record<string, unknown>> | undefined): number {
  const bits = attrs?.["bitsize"];
  return typeof bits === "number" && Number.isFinite(bits)
    ? Math.min(32, Math.max(1, Math.round(bits)))
    : 1;
}

/**
 * What a breakpoint stops on, as text: `= 0x05` for an 8-bit hex readout, `= 5`
 * in decimal, `= 0b00000101` in binary. The `=` is part of it: the condition is a
 * comparison, and a bare `0x05` on a body would read as a value being *carried*
 * rather than one being *watched for*.
 */
export function breakpointCondition(attrs: Readonly<Record<string, unknown>> | undefined): string {
  return `= ${radixText(valueOf(attrs), radixOf(attrs), bitsOf(attrs))}`;
}
