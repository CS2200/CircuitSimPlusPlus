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
  SaveResult,
  ViolationKind,
  WireIdx,
  WireValue,
} from "../ipc/types";
import { IpcEvents } from "../ipc/types";
import type { Unlisten } from "../ipc/events";
import { CircuitDocument } from "../model/document";
import { isPinEndpoint, type CsxEndpoint } from "../model/csx";
import { DiffPump } from "./diffPump";
import { SimStore } from "./simStore";

/** Watch panel display modes (DESIGN.md §7.1). */
export type ValueMode = "unsigned" | "signed" | "hex" | "bin";

/** Pin carrying a named component's watchable value (mirrors the engine). */
const VALUE_PIN: Record<NamedComponent["kind"], string> = {
  register: "q",
  ram: "dout",
  rom: "out",
  probe: "in",
};

/** Connectivity of one wire endpoint: a pin, or the wire a junction joins. */
function endpointKey(e: CsxEndpoint): string {
  return isPinEndpoint(e) ? `${e.comp}.${e.pin}` : `#${e.join.wire}`;
}

/**
 * Engine-relevant fingerprint of a document: each circuit's components
 * (id/type/name/attrs) and each wire's endpoints. Geometry — component
 * positions, `rot`, wire `points`, colours — is presentational: the core
 * derives connectivity purely from component ids and pin names
 * (docs/format-v2.md §5). So dragging a part or bending a wire leaves this
 * fingerprint unchanged, and the engine must NOT be reloaded: a reload reboots
 * the sim (clocked state clears, the cycle counter returns to 0), which made
 * every layout tweak look like the circuit had reset.
 */
function netlistSignature(doc: CircuitDocument): string {
  const parts: string[] = [];
  for (const c of doc.data.circuits) {
    parts.push(`circuit ${c.name}`);
    for (const comp of c.components) {
      parts.push(` ${comp.id} ${comp.type} ${comp.name ?? ""} ${JSON.stringify(comp.attrs ?? {})}`);
    }
    for (const w of c.wires) {
      parts.push(` ${endpointKey(w.a)} ${endpointKey(w.b)}`);
    }
  }
  return parts.join("\n");
}

export class SimController {
  readonly store = new SimStore();
  private readonly pump: DiffPump;
  private readonly unlisteners: Unlisten[] = [];
  private doc: CircuitDocument | null = null;
  /**
   * How the live document was loaded: a file path (reload from disk keeps
   * memory autoloads relative to it, §11) or null for an in-memory/untitled
   * document (reload re-encodes the editor's current JSON).
   */
  private loadedPath: string | null = null;
  /**
   * Netlist fingerprint at the last successful load (see `netlistSignature`),
   * or null when nothing is loaded. A geometry-only edit leaves it unchanged,
   * so it does not force a reload.
   */
  private loadedSig: string | null = null;
  /**
   * Tail of the load chain — loads are serialized. Two overlapping loads would
   * interleave their initial full-state diff batches and both mutate the
   * store, leaving whichever finished last to win; chaining guarantees the
   * newest load also resets last, so its snapshot is the one that sticks.
   */
  private loading: Promise<boolean> = Promise.resolve(true);
  /**
   * Locally poked register values (component id → hex). The register readout
   * comes from its `q` net, which is delay-gated (updates only when the engine's
   * time advances) and absent entirely when `q` is unwired — so a live poke is
   * shown optimistically here until the next command supersedes it.
   */
  private readonly pokedRegs = new Map<string, string>();
  /**
   * In-progress inline register edit (component id + the text typed so far).
   * Each keystroke appends a digit and pokes immediately (no Enter); a command
   * or Escape ends the edit.
   */
  private regEdit: { compId: string; text: string } | null = null;

  constructor(
    private readonly core: Core,
    /** Frame scheduler for the diff pump (rAF in the app, sync in tests). */
    schedule?: (cb: () => void) => void,
  ) {
    this.pump = new DiffPump(
      (changes, cycle, full) => this.store.applyDiffs(changes, cycle, full),
      schedule,
    );
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
    return this.loadInto(
      doc,
      () => this.core.api.loadCircuit({ bytes: encode(doc.toJson()) }),
      null,
    );
  }

  /**
   * Load a document FROM DISK into the core (File → Open in the Tauri
   * shell): the engine reads the file itself, so memory autoloads resolve
   * relative to the circuit's directory (DESIGN.md §5.2). `doc` is the
   * editor's own copy of the same file (parsed by the frontend).
   */
  async loadFromPath(doc: CircuitDocument, path: string): Promise<boolean> {
    return this.loadInto(doc, () => this.core.api.loadCircuit({ path }), path);
  }

  /**
   * Queue a load behind any in-flight one (see `loading`) and run it. Commands
   * and the live re-sync can both fire loads, so they must not overlap.
   */
  private loadInto(
    doc: CircuitDocument,
    invokeLoad: () => Promise<LoadResult>,
    path: string | null,
  ): Promise<boolean> {
    const previous = this.loading;
    const next = (async () => {
      await previous.catch(() => false);
      return this.performLoad(doc, invokeLoad, path);
    })();
    this.loading = next.catch(() => false);
    return next;
  }

  private async performLoad(
    doc: CircuitDocument,
    invokeLoad: () => Promise<LoadResult>,
    path: string | null,
  ): Promise<boolean> {
    this.doc = doc;
    this.loadedPath = path;
    this.loadedSig = null;
    this.clearPoked();
    this.pump.clear();
    // Reset BEFORE the call: cores emit the initial full-state batch during
    // loadCircuit, and those diffs must land on a clean store (onLoaded
    // below must not wipe them).
    this.store.reset();
    let result: LoadResult;
    try {
      result = await invokeLoad();
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
    this.loadedSig = netlistSignature(doc);
    return true;
  }

  /**
   * True when the engine's loaded snapshot no longer matches the editor's
   * netlist — something the core cares about (a part, a wire, an attribute)
   * changed since the last load. Geometry-only edits (a part dragged, a wire
   * bent) leave the netlist identical and are NOT stale, so they do not reboot
   * the simulation. `false` while nothing is loaded.
   */
  isStale(doc: CircuitDocument): boolean {
    return this.loadedSig !== null && this.loadedSig !== netlistSignature(doc);
  }

  /**
   * Bring the engine up to date with `doc`, reloading only when needed: a
   * no-op while the loaded document is current, a fresh load when nothing is
   * loaded or the editor changed since the last load. A document that came
   * from disk reloads from its path (memory autoloads stay relative to it,
   * §11); an in-memory/untitled one re-encodes its current JSON.
   *
   * Commands go through here rather than checking `store.loaded` alone: the
   * mount-time pre-load marks an empty document as loaded, so `loaded` would
   * otherwise stay true while edits pile up in the editor un-simulated.
   */
  async resync(doc: CircuitDocument): Promise<boolean> {
    if (this.store.loaded && !this.isStale(doc)) return true;
    return this.loadedPath !== null ? this.loadFromPath(doc, this.loadedPath) : this.load(doc);
  }

  /**
   * Save through the core's canonical serializer (File → Save). The real
   * backend writes via the live session, so one is created (by loading the
   * current document) when the user saves before ever running the sim.
   */
  async save(doc: CircuitDocument, path: string): Promise<SaveResult> {
    if (!this.store.loaded) {
      const ok = await this.load(doc);
      if (!ok) return { ok: false, errors: [...this.store.loadErrors] };
    }
    return this.core.api.saveCircuit(path, doc.data);
  }

  unload(): void {
    this.pump.clear();
    this.clearPoked();
    this.store.reset();
    this.doc = null;
    this.loadedPath = null;
    this.loadedSig = null;
  }

  /**
   * Engine reset (DESIGN.md §5.2): fresh power-on state; autoload images
   * re-apply. The engine answers with a `full: true` batch that repaints
   * the store, so clear first like a load.
   */
  async reset(): Promise<void> {
    this.pump.clear();
    this.clearPoked();
    this.store.resetRunState();
    return this.core.api.reset();
  }

  // ---- commands (delegate; errors propagate to the caller's UI) ----

  play(hz: number): Promise<void> {
    this.clearPoked();
    return this.core.api.play(hz);
  }

  pause(): Promise<void> {
    return this.core.api.pause();
  }

  stepTick(): Promise<void> {
    this.clearPoked();
    return this.core.api.stepTick();
  }

  stepCycle(): Promise<void> {
    this.clearPoked();
    return this.core.api.stepCycles(1);
  }

  runUntil(cycle: number): Promise<void> {
    this.clearPoked();
    return this.core.api.runUntil(cycle);
  }

  poke(compId: CompId, pin: string, value: WireValue): Promise<void> {
    return this.core.api.poke(compId, pin, value);
  }

  /** Record a poked register value so the canvas shows it immediately. */
  rememberPokedRegister(compId: string, hex: string): void {
    this.pokedRegs.set(compId, hex);
  }

  /** The optimistic value poked into a register, if any (see `pokedRegs`). */
  pokedRegister(compId: string): string | undefined {
    return this.pokedRegs.get(compId);
  }

  /** Begin/continue an inline register edit (App drives the keystrokes). */
  setRegisterEdit(compId: string, text: string): void {
    this.regEdit = { compId, text };
  }

  /** End the inline register edit (Escape/Enter or a command). */
  clearRegisterEdit(): void {
    this.regEdit = null;
  }

  /** The in-progress inline register edit, if any. */
  registerEdit(): { compId: string; text: string } | null {
    return this.regEdit;
  }

  /** Any command supersedes an optimistic poke (the readout comes from nets). */
  private clearPoked(): void {
    if (this.pokedRegs.size > 0) this.pokedRegs.clear();
    this.regEdit = null;
  }

  memRead(name: string, addr: number, len: number): Promise<WireValue[]> {
    return this.core.api.memRead(name, addr, len);
  }

  memWrite(name: string, addr: number, values: WireValue[]): Promise<void> {
    // mem_write has no event; touch so inspectors/watch refresh.
    return this.core.api.memWrite(name, addr, values).then(() => this.store.touch());
  }

  // ---- document-side resolution ----

  /**
   * Current value of a watch-addressable component, if its net is known.
   *
   * `value_net` (contract v1.2) is authoritative: the engine nets every pin, so
   * it covers an unwired value pin and a component inside a subcircuit. Older
   * cores — and the mock, which derives its nets from wires — fall back to
   * resolving the value pin's wire, which only reaches the root sheet.
   */
  watchValue(named: NamedComponent): WireValue | undefined {
    if (named.value_net !== undefined) return this.store.netValues.get(named.value_net);
    if (this.doc === null || this.store.wireToNet === null) return undefined;
    const root = this.doc.circuit(0);
    // net_map is root-circuit-only (contract v1.1): subcircuit internals
    // have no wire→net mapping to resolve against.
    if (named.circuit !== root.name) return undefined;
    const comp = root.components[named.comp_id];
    if (comp === undefined) return undefined;
    const pin = VALUE_PIN[named.kind];
    const wireIdx = root.wires.findIndex(
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
    // Convention (contract v1.1, docs/ipc.md §5): details starts with
    // `comp <CompId> pin "<pin>":` for component-attributable halts; the id
    // is root-sheet document-order (subcircuit culprits report their
    // enclosing instance).
    const byId = /comp (\d+)/.exec(halted.details);
    if (byId !== null) {
      const idx = Number(byId[1]);
      if (this.doc.circuit(0).components[idx] !== undefined) return idx;
    }
    const byName = this.store.named.find((n) => halted.details.includes(n.name));
    return byName !== undefined ? byName.comp_id : null;
  }

  /**
   * Setup/hold violation markers for the CURRENT sheet (U7): violations
   * whose `circuit` matches the viewed sheet, resolved to document comp
   * ids. Violations in other circuits are filtered out (contract v1.1).
   */
  violationMarkers(sheetName?: string): { compId: string; kind: ViolationKind; detail: string }[] {
    const timing = this.store.timing;
    if (timing === null || this.doc === null) return [];
    const idx = sheetName === undefined ? 0 : this.doc.circuitIdxByName(sheetName);
    if (idx < 0) return []; // stale sheet name (e.g. mid-open) — no markers
    const sheet = this.doc.circuit(idx);
    const out: { compId: string; kind: ViolationKind; detail: string }[] = [];
    for (const v of timing.violations) {
      if (v.circuit !== sheet.name) continue;
      const comp = sheet.components[v.comp_id];
      if (comp !== undefined) out.push({ compId: comp.id, kind: v.kind, detail: v.detail });
    }
    return out;
  }

  /**
   * Observed settle time of that same critical path (ns) — the *measured* number
   * beside a part's design cost (UI_OVERHAUL §74). Null when the path is not on
   * the viewed sheet, the same contract v1.1 filter `topPathIds` applies.
   */
  topPathDelay(sheetName?: string): number | null {
    const timing = this.store.timing;
    if (timing === null || this.doc === null) return null;
    const top = timing.top_paths[0];
    if (top === undefined || top.comps.length === 0) return null;
    const name = sheetName ?? this.doc.circuit(0).name;
    return top.circuit === name ? top.delay_ns : null;
  }

  /**
   * The top observed critical path as document comp ids — only when the
   * path's `circuit` is the viewed sheet (contract v1.1 filter).
   */
  topPathIds(sheetName?: string): string[] | null {
    const timing = this.store.timing;
    if (timing === null || this.doc === null) return null;
    const top = timing.top_paths[0];
    if (top === undefined || top.comps.length === 0) return null;
    const name = sheetName ?? this.doc.circuit(0).name;
    if (top.circuit !== name) return null;
    const idx = this.doc.circuitIdxByName(name);
    if (idx < 0) return null; // stale sheet name (e.g. mid-open)
    const sheet = this.doc.circuit(idx);
    return top.comps
      .map((idx) => sheet.components[idx]?.id)
      .filter((id): id is string => id !== undefined);
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
    case "bin":
      return `0b${v.toString(2)}`;
    case "unsigned":
      return v.toString(10);
    case "signed": {
      const top = 1n << (bits - 1n);
      const signed = (v & top) !== 0n ? v - (1n << bits) : v;
      return signed.toString(10);
    }
  }
}
