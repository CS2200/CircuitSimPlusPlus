import type { CsxCircuit, CsxComponent, CsxEndpoint } from "./csx";
import { isPinEndpoint } from "./csx";

/**
 * Wire facts the Inspector needs (UI_OVERHAUL §12): buses have no width of
 * their own — width is a property of the driving pin (format-v2 §5.2). So a
 * wire's width control edits the source component's `bitsize`, and the color
 * is a wire-level property.
 *
 * Pure: the caller injects the pin resolver (the editor's catalog owns
 * rendering geometry; the model stays catalog-free).
 */

export interface WireInfo {
  /** Effective width in bits (from the driving pin; 1 when unknown). */
  bitsize: number;
  /** The pin that sources the net, when one of the wire's ends drives. */
  driver: { compId: string; pin: string } | null;
}

export interface WirePin {
  name: string;
  kind: string;
  bitsize?: number;
}

export function wireInfo(
  circuit: CsxCircuit,
  wireIdx: number,
  pinsOf: (comp: CsxComponent) => readonly WirePin[],
): WireInfo {
  const wire = circuit.wires[wireIdx];
  if (wire === undefined) return { bitsize: 1, driver: null };
  const ends: CsxEndpoint[] = [wire.a, wire.b];
  let fallback = 1;
  for (const end of ends) {
    if (!isPinEndpoint(end)) continue;
    const comp = circuit.components.find((c) => c.id === end.comp);
    if (comp === undefined) continue;
    const pin = pinsOf(comp).find((p) => p.name === end.pin);
    if (pin === undefined) continue;
    const bits = Math.max(1, pin.bitsize ?? 1);
    fallback = Math.max(fallback, bits);
    if (pin.kind === "out" || pin.kind === "inout") {
      return { bitsize: bits, driver: { compId: comp.id, pin: end.pin } };
    }
  }
  return { bitsize: fallback, driver: null };
}
