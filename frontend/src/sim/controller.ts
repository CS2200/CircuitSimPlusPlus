/**
 * Sim controller (FRONTEND.md U5): the glue between a `Core` (mock or real
 * Tauri adapter — same seams), the `SimStore`, and the editor document.
 *
 * Owns: event wiring (net_diffs → DiffPump → store; status/halt/timing →
 * store), command delegation, and document-side resolution (watch values,
 * halt-highlight component) using the CompId = components-array-index
 * convention (format-v2 §5).
 */

import type { Core } from "../ipc";
import type {
  CompId,
  LoadResult,
  NamedComponent,
  NetId,
  SimMode,
  WireIdx,
  WireValue,
} from "../ipc/types";
import { IpcEvents } from "../ipc/types";
import type { Unlisten } from "../ipc/events";
import { CircuitDocument } from "../model/document";
import { isPinEndpoint } from "../model/csx";
import { DiffPump } from "./diffPump";
import { SimStore } from "./simStore";

/** Watch panel display modes (DESIGN.md §7.1). */
export type ValueMode = "unsigned" | "signed" | "hex";

/** Pin carrying a named component's watchable value. */
const VALUE_PIN: Record<NamedComponent["kind"], string> = {
  register: "q",
  ram: "q",
  rom: "q",
  probe: "in",
};

export class SimController {
  readonly store = new SimStore();
  private readonly pump: DiffPump;
  private readonly unlisteners: Unlisten[] = [];
  private doc: CircuitDocument | null = null;

  constructor(
    private readonly core: Core,
    /** Frame scheduler for the diff pump (rAF in the app, sync in tests). */
    schedule?: (cb: () => void) => void,
  ) {
    this.pump = new DiffPump((changes, cycle) => this.store.applyDiffs(changes, cycle), schedule);
    this.unlisteners.push(
      this.core.events.on(IpcEvents.NetDiffs, (d) => this.pump.push(d)),
      this.core.events.on(IpcEvents.SimStatus, (s) => this.store.onStatus(s)),
      this.core.events.on(IpcEvents.SimHalted, (h) => this.store.onHalted(h)),
      this.core.events.on(IpcEvents.TimingUpdate, (t) => this.store.onTiming(t)),
    );
  }

  dispose(): void {
    for (const u of this.unlisteners) u();
  }

  /** Load the editor document into the core. Returns true on success. */
  async load(doc: CircuitDocument): Promise<boolean> {
    this.doc = doc;
    this.pump.clear();
    // Reset BEFORE the call: cores emit the initial full-state batch during
    // loadCircuit, and those diffs must land on a clean store (onLoaded
    // below must not wipe them).
    this.store.reset();
    let result: LoadResult;
    try {
      result = await this.core.api.loadCircuit({ bytes: encode(doc.toJson()) });
    } catch (err) {
      this.store.onLoadFailed([{ kind: "other", message: String(err), circuit: doc.name }]);
      return false;
    }
    if (!result.ok) {
      this.store.onLoadFailed(result.errors);
      return false;
    }
    const wireToNet = new Map<WireIdx, NetId>();
    for (const entry of result.net_map) {
      for (const w of entry.wires) wireToNet.set(w, entry.net);
    }
    this.store.onLoaded(wireToNet, result.named);
    return true;
  }

  unload(): void {
    this.pump.clear();
    this.store.reset();
    this.doc = null;
  }

  // ---- commands (delegate; errors propagate to the caller's UI) ----

  play(hz: number): Promise<void> {
    return this.core.api.play(hz);
  }

  pause(): Promise<void> {
    return this.core.api.pause();
  }

  stepTick(): Promise<void> {
    return this.core.api.stepTick();
  }

  stepCycle(): Promise<void> {
    return this.core.api.stepCycles(1);
  }

  runUntil(cycle: number): Promise<void> {
    return this.core.api.runUntil(cycle);
  }

  setMode(mode: SimMode): Promise<void> {
    return this.core.api.setMode(mode);
  }

  poke(compId: CompId, pin: string, value: WireValue): Promise<void> {
    return this.core.api.poke(compId, pin, value);
  }

  // ---- document-side resolution ----

  /** Current value of a watch-addressable component, if its net is known. */
  watchValue(named: NamedComponent): WireValue | undefined {
    if (this.doc === null || this.store.wireToNet === null) return undefined;
    const comp = this.doc.circuit(0).components[named.comp_id];
    if (comp === undefined) return undefined;
    const pin = VALUE_PIN[named.kind];
    const wireIdx = this.doc
      .circuit(0)
      .wires.findIndex(
        (w) =>
          (isPinEndpoint(w.a) && w.a.comp === comp.id && w.a.pin === pin) ||
          (isPinEndpoint(w.b) && w.b.comp === comp.id && w.b.pin === pin),
      );
    if (wireIdx < 0) return undefined;
    const net = this.store.wireToNet.get(wireIdx);
    return net === undefined ? undefined : this.store.netValues.get(net);
  }

  /** Component to highlight for the current halt, if identifiable. */
  haltHighlight(): CompId | null {
    const halted = this.store.halted;
    if (halted === null || this.doc === null) return null;
    // Convention used by the mock (and requested of the engine): details
    // carries "comp <id>" for the offending component.
    const byId = /comp (\d+)/.exec(halted.details);
    if (byId !== null) {
      const idx = Number(byId[1]);
      if (this.doc.circuit(0).components[idx] !== undefined) return idx;
    }
    const byName = this.store.named.find((n) => halted.details.includes(n.name));
    return byName !== undefined ? byName.comp_id : null;
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * Format a 4-state value for the watch panel. X anywhere dominates (per-bit
 * rendering is a U6 refinement); all-Z shows as Z.
 */
export function formatValue(val: WireValue | undefined, mode: ValueMode): string {
  if (val === undefined) return "—";
  if (val.x !== "" && BigInt(`0x${val.x}`) !== 0n) return "X";
  if (val.z !== "" && BigInt(`0x${val.z}`) !== 0n) {
    const v = val.v === "" ? 0n : BigInt(`0x${val.v}`);
    if (v === 0n) return "Z";
  }
  const v = val.v === "" ? 0n : BigInt(`0x${val.v}`);
  const bits = BigInt(Math.max(1, val.v.length * 4));
  switch (mode) {
    case "hex":
      return `0x${val.v === "" ? "0" : val.v}`;
    case "unsigned":
      return v.toString(10);
    case "signed": {
      const top = 1n << (bits - 1n);
      const signed = (v & top) !== 0n ? v - (1n << bits) : v;
      return signed.toString(10);
    }
  }
}
