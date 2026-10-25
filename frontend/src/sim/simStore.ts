/**
 * Sim session state (FRONTEND.md U5): the one mutable holder of everything
 * the core has told us — net values (applied via the DiffPump), run status,
 * halt/timing events, and the net_map wiring the engine's net ids back to
 * document wire indices.
 *
 * The canvas is an imperative renderer: it subscribes to `version` bumps
 * and reads `netValues` directly (no per-frame React state). Panels use
 * `useSyncExternalStore` on `subscribe`/`getVersion`.
 */

import type {
  LoadError,
  NamedComponent,
  NetId,
  SimHalted,
  SimStatus,
  TimingUpdate,
  WireIdx,
  WireValue,
} from "../ipc/types";
import type { StampedChange } from "./diffPump";

/** One net change in the latest flushed frame (U7 pulse spawn input). */
export interface NetChangeEvent {
  net: NetId;
  /** Delay-mode event time (ns since run start), when the engine sent one. */
  at?: number;
}

export class SimStore {
  /** Latest value per engine net. Mutated in place; `version` signals. */
  readonly netValues = new Map<NetId, WireValue>();
  /** ROOT-sheet document wire index → engine net (contract v1.4: only the
   *  `instance === ""` entries of LoadResult.net_map). */
  wireToNet: ReadonlyMap<WireIdx, NetId> | null = null;
  /**
   * Per-instance wire → net, keyed by instance path (`""` = root). A
   * subcircuit sheet opened as a *specific instance* uses its own path here,
   * so its wires read the values of that instance — never another instance's,
   * and never a definition's (which has no values).
   */
  wireToNetByInstance: ReadonlyMap<string, ReadonlyMap<WireIdx, NetId>> = new Map();
  /** Engine net → document wire indices (U7 pulses; built in onLoaded). */
  netToWires: ReadonlyMap<NetId, WireIdx[]> | null = null;
  named: readonly NamedComponent[] = [];
  loadErrors: readonly LoadError[] = [];
  status: SimStatus | null = null;
  halted: SimHalted | null = null;
  timing: TimingUpdate | null = null;

  /** Nets changed by the latest flushed frame (U7 pulse animations). */
  lastChanged: readonly NetChangeEvent[] = [];

  /**
   * Nets whose `X` is a genuine **short circuit** — two enabled drivers
   * fighting, per the engine's `contended` flag (contract v1.2). Empty unless
   * the engine flagged one, so the warning cannot misfire on an `X` that merely
   * flowed in (a divide-by-zero, an `X` mux select).
   */
  private readonly _contended = new Set<NetId>();

  private _loaded = false;
  private _version = 0;
  private _cycle = 0;
  private readonly listeners = new Set<() => void>();

  /** Latest cycle known — from diff batches (steps) or status (play/pause). */
  get cycle(): number {
    return this._cycle;
  }

  get loaded(): boolean {
    return this._loaded;
  }

  /** Nets currently shorted (see `_contended`). */
  get contendedNets(): ReadonlySet<NetId> {
    return this._contended;
  }

  getVersion(): number {
    return this._version;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private bump(): void {
    this._version++;
    for (const l of this.listeners) l();
  }

  /**
   * A circuit loaded successfully: wire the net map. Does NOT clear
   * netValues — the initial full-state batch arrives DURING loadCircuit
   * (before the result), so clearing belongs to the load path's reset().
   */
  onLoaded(wireToNetByInstance: Map<string, Map<WireIdx, NetId>>, named: NamedComponent[]): void {
    this.wireToNetByInstance = wireToNetByInstance;
    // The root sheet keeps the flat map the rest of the UI (waveform, pulses)
    // already keys on.
    this.wireToNet = wireToNetByInstance.get("") ?? new Map();
    const reverse = new Map<NetId, WireIdx[]>();
    for (const [wire, net] of this.wireToNet) {
      const list = reverse.get(net);
      if (list === undefined) reverse.set(net, [wire]);
      else list.push(wire);
    }
    this.netToWires = reverse;
    this.named = named;
    this.loadErrors = [];
    this.status = null;
    this.halted = null;
    this.timing = null;
    this._loaded = true;
    this.bump();
  }

  /** Load failed (collected errors, never thrown — contract). */
  onLoadFailed(errors: LoadError[]): void {
    this.reset();
    this.loadErrors = errors;
    this.bump();
  }

  /**
   * One flushed frame of merged diffs (from DiffPump). A `full` frame is
   * the v1.1 initial paint after load/resume: it updates values but spawns
   * NO pulses (nothing "changed" — everything simply is).
   */
  applyDiffs(changes: ReadonlyMap<NetId, StampedChange>, cycle: number, full = false): void {
    for (const [net, change] of changes) {
      this.netValues.set(net, change.val);
      // The engine sends `contended` only when true (contract v1.2), so an
      // absent flag is a definite "not shorted" — clear it, don't keep a stale.
      if (change.contended === true) this._contended.add(net);
      else this._contended.delete(net);
    }
    this.lastChanged = full ? [] : [...changes].map(([net, change]) => ({ net, at: change.at }));
    this._cycle = cycle;
    this.bump();
  }

  /** Memory contents changed out-of-band (mem_write has no event). */
  touch(): void {
    this.bump();
  }

  onStatus(status: SimStatus): void {
    this.status = status;
    this._cycle = status.cycle;
    this.bump();
  }

  onHalted(halted: SimHalted): void {
    this.halted = halted;
    this.bump();
  }

  onTiming(timing: TimingUpdate): void {
    this.timing = timing;
    this.bump();
  }

  /**
   * Engine reset (same circuit stays loaded): keep the load-derived
   * topology (net maps, named components); clear run state only. The
   * engine answers with a `full: true` batch that repaints values.
   */
  resetRunState(): void {
    this.netValues.clear();
    this._contended.clear();
    this.lastChanged = [];
    this.status = null;
    this.halted = null;
    this.timing = null;
    this._cycle = 0;
    this.bump();
  }

  /** Unload: everything back to the pre-load state. */
  reset(): void {
    this.netValues.clear();
    this._contended.clear();
    this.lastChanged = [];
    this.wireToNet = null;
    this.wireToNetByInstance = new Map();
    this.netToWires = null;
    this.named = [];
    this.loadErrors = [];
    this.status = null;
    this.halted = null;
    this.timing = null;
    this._loaded = false;
    this._cycle = 0;
    this.bump();
  }
}
