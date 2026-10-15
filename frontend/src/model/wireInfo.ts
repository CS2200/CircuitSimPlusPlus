import type { CsxCircuit, CsxComponent, CsxEndpoint } from "./csx";
import { isPinEndpoint } from "./csx";
import { deriveNets } from "./nets";

/**
 * Wire facts the Inspector needs (UI_OVERHAUL §12/§17): buses have no width
 * of their own — width is a property of the driving pin (format-v2 §5.2). So
 * a wire's width control edits the source component's `bitsize`, and the
 * color is a wire-level property. `widths` reports the declared widths across
 * the whole net so a mismatch can be surfaced.
 *
 * Pure: the caller injects the pin resolver (the editor's catalog owns
 * rendering geometry; the model stays catalog-free).
 */

export interface WireInfo {
  /** Effective width in bits (from the driving pin; 1 when unknown). */
  bitsize: number;
  /** The pin that sources the net, when one of the wire's ends drives. */
  driver: { compId: string; pin: string } | null;
  /** Distinct declared pin widths on the net, ascending; >1 = mismatch. */
  widths: number[];
}

export interface WirePin {
  name: string;
  kind: string;
  bitsize?: number;
}

/** Distinct declared pin widths across the wire's net (ascending). */
function netWidths(
  circuit: CsxCircuit,
  wireIdx: number,
  pinsOf: (comp: CsxComponent) => readonly WirePin[],
): number[] {
  const nets = deriveNets(circuit);
  const netId = nets.wireToNet.get(wireIdx);
  if (netId === undefined) return [];
  const sizes = new Set<number>();
  for (const key of nets.nets[netId]?.pins ?? []) {
    const [compId, pinName] = key.split(":");
    const comp = circuit.components.find((c) => c.id === compId);
    if (comp === undefined) continue;
    const pin = pinsOf(comp).find((p) => p.name === pinName);
    if (pin !== undefined) sizes.add(Math.max(1, pin.bitsize ?? 1));
  }
  return [...sizes].sort((a, b) => a - b);
}

export function wireInfo(
  circuit: CsxCircuit,
  wireIdx: number,
  pinsOf: (comp: CsxComponent) => readonly WirePin[],
): WireInfo {
  const wire = circuit.wires[wireIdx];
  if (wire === undefined) return { bitsize: 1, driver: null, widths: [] };
  const widths = netWidths(circuit, wireIdx, pinsOf);
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
      return { bitsize: bits, driver: { compId: comp.id, pin: end.pin }, widths };
    }
  }
  return { bitsize: fallback, driver: null, widths };
}
