/**
 * Waveform recording (Design: `frontend/UI_OVERHAUL.md` §89).  The sim viewer
 * draws what the engine already tells us — no new IPC, no engine change.
 *
 * The engine streams `net_diffs`: `{ cycle, full, changes: [{ net, val, at?,
 * contended? }] }`.  `DiffPump` merges those down to AT MOST one batch per
 * animation frame before the UI paints (DESIGN.md §7.2) — deliberately lossy,
 * because a paint only needs the latest value.  A *trace* cannot afford that,
 * so the recorder taps the batches BEFORE the merge (`DiffPump`'s `onRaw`) and
 * keeps every change.
 *
 * **Every change, not every cycle.**  A cycle is not the quantum of the
 * simulation: a *tick* (one clock half-period) is, and the contract says so —
 * `cycle` advances once per clock period while `at` (ns since run start)
 * advances per event.  Keeping one sample per cycle therefore *aliases*
 * anything that moves more than once in a cycle, and the clock is the visible
 * case: it rises and falls inside every single cycle, so a per-cycle trace
 * collapses it into a flat line.  Samples are keyed by `at` instead, and the
 * x-axis is a **fractional cycle** — `cycle + elapsed/period` — so the axis is
 * still measured in cycles, but the edges inside a cycle are visible.
 *
 * The period is derived from the data (the first `at` seen in each cycle), not
 * assumed, so nothing here hard-codes a clock rate.  When the engine sends no
 * `at` at all — a core that only knows cycles — the axis degenerates to whole
 * cycles, exactly the old behaviour, and a fast toggle aliases: that is a
 * limitation of such a core, and `hasTime` says which case you are in.
 *
 * Recording is bounded: `WAVE_SAMPLE_CAP` per net and `WAVE_TOTAL_CAP` overall,
 * oldest-first, with the sacrifice recorded in `truncated` so the view can say
 * so rather than quietly lying about the past.
 */

import type { NetId, NetDiffs, NamedComponent, WireValue } from "../ipc/types";
import { wireValueState } from "../lib/value";
import { breakpointCondition } from "../lib/breakpoint";

/** One value, in effect from `t` until the next sample. */
export interface WaveSample {
  /** Engine event time in ns since run start (`NetChange.at`), or the cycle when absent. */
  t: number;
  /** The cycle this event belongs to — several events share one. */
  cycle: number;
  val: WireValue;
  /** The engine flagged a genuine short circuit at this change (v1.2). */
  contended?: boolean;
}

/** A sample placed on the axis: x is a fractional cycle. */
export interface PlacedSample {
  x: number;
  val: WireValue;
  contended?: boolean;
}

/** A row in the trace. */
export interface WaveSignal {
  /** Stable identity: `n:<name>` for a named part, `w:<wireIdx>` / `p:<comp>.<pin>` for a pick. */
  key: string;
  label: string;
  net: NetId;
  origin: "named" | "picked";
  /** `probe` | `register` | `ram` | `rom` for named parts; `wire` | `pin` | `clock` for picks. */
  kind: string;
  /**
   * The signal's **declared** width where the document knows it (a part's
   * `bitsize`, a pin's spec).  Deliberately not the width of a value's hex masks:
   * masks are nibble-aligned, so a 1-bit signal's mask is already 4 "bits" wide,
   * and a core may report an even wider mask than the signal has (the mock
   * reports 32-bit masks for everything).  Deciding "is this a bus?" from that
   * turns a clock into a bus row.
   */
  bits?: number;
}

/** Whether a row is a bus: its declared width, falling back to the value's masks. */
export function isBus(signal: WaveSignal, latest?: WireValue): boolean {
  const bits = signal.bits ?? (latest === undefined ? 0 : valueBits(latest));
  return bits > 1;
}

/** Per-net sample cap.  A net that changes every tick for a long run is a lot of trace. */
export const WAVE_SAMPLE_CAP = 4096;
/** Overall cap, so a huge design with long runs cannot grow without bound. */
export const WAVE_TOTAL_CAP = 400_000;

function sameValue(a: WireValue, b: WireValue): boolean {
  return a.v === b.v && a.x === b.x && a.z === b.z;
}

export class WaveformRecorder {
  private readonly byNet = new Map<NetId, WaveSample[]>();
  /** First event time seen in each cycle — the time base (a cycle's start). */
  private readonly starts = new Map<number, number>();
  private readonly _truncated = new Set<NetId>();
  private _count = 0;
  private _hasTime = false;
  private _span: { firstT: number; firstCycle: number; lastT: number; lastCycle: number } | null =
    null;

  /** Total samples held (all nets). */
  get sampleCount(): number {
    return this._count;
  }

  /** Nets that lost their oldest history to a cap. */
  get truncated(): ReadonlySet<NetId> {
    return this._truncated;
  }

  /**
   * Whether the engine stamped `at` (ns) on its changes.  False means the axis
   * can only be whole cycles — and that a signal toggling twice in one cycle
   * cannot be drawn.
   */
  get hasTime(): boolean {
    return this._hasTime;
  }

  /**
   * The run's event span, as the two ends to project through the time base.  Kept
   * incrementally so the view never walks every net to find it.
   */
  get timeSpan(): { firstT: number; firstCycle: number; lastT: number; lastCycle: number } | null {
    return this._span;
  }

  /** Last cycle seen, or `null` before anything was recorded. */
  get lastCycle(): number | null {
    if (this.starts.size === 0) return null;
    let max = -Infinity;
    for (const c of this.starts.keys()) if (c > max) max = c;
    return max;
  }

  netCount(): number {
    return this.byNet.size;
  }

  samples(net: NetId): readonly WaveSample[] {
    return this.byNet.get(net) ?? [];
  }

  /** The axis: `t` and a cycle → a fractional cycle.  Cheap enough to rebuild per draw. */
  timebase(): Timebase {
    return new Timebase(this.starts, this._hasTime);
  }

  /**
   * One engine batch, straight from `DiffPump`'s raw tap.
   *
   * A `full` batch (the initial paint after load/resume) seeds every net, so a
   * trace starts defined instead of blank.
   */
  recordBatch(diffs: NetDiffs): void {
    const cycle = diffs.cycle;
    // Defence in depth for the same session boundary: a cycle that goes
    // BACKWARDS means the engine restarted through a path that did not clear us
    // (a load, a reset, a core that re-loads on its own).  The old samples
    // describe a different run, and keeping them would make x non-monotonic, so
    // the trace would overlap itself.  Start again instead.
    if (this._span !== null && cycle < this._span.lastCycle) this.clear();
    for (const change of diffs.changes) {
      const hasAt = typeof change.at === "number" && Number.isFinite(change.at);
      // Without `at` the cycle number is the only clock we have.
      const t = hasAt ? change.at! : cycle;
      if (hasAt) this._hasTime = true;

      const start = this.starts.get(cycle);
      if (start === undefined || t < start) this.starts.set(cycle, t);

      const span = this._span;
      if (span === null) {
        this._span = { firstT: t, firstCycle: cycle, lastT: t, lastCycle: cycle };
      } else {
        if (t < span.firstT) {
          span.firstT = t;
          span.firstCycle = cycle;
        }
        if (t > span.lastT) {
          span.lastT = t;
          span.lastCycle = cycle;
        }
      }

      const contended = change.contended === true;
      const list = this.byNet.get(change.net);
      if (list === undefined) {
        this.byNet.set(change.net, [
          { t, cycle, val: change.val, ...(contended ? { contended } : {}) },
        ]);
        this._count++;
        continue;
      }
      const last = list[list.length - 1];
      // Nothing to record: same value, same contention, seen at the same event
      // time (two batches can describe one event).  A *new* event time with an
      // unchanged value adds nothing to a step trace — the value holds.
      if (
        last !== undefined &&
        sameValue(last.val, change.val) &&
        (last.contended === true) === contended
      ) {
        continue;
      }
      list.push({ t, cycle, val: change.val, ...(contended ? { contended } : {}) });
      this._count++;
      if (list.length > WAVE_SAMPLE_CAP) {
        // Amortised: shed a block, mark the past as incomplete.
        const shed = Math.max(1, Math.floor(WAVE_SAMPLE_CAP / 4));
        list.splice(0, shed);
        this._count -= shed;
        this._truncated.add(change.net);
      }
    }
    if (this._count > WAVE_TOTAL_CAP) this.shedOldest();
  }

  /** Nobody may grow past the total cap: drop the oldest block anywhere. */
  private shedOldest(): void {
    while (this._count > WAVE_TOTAL_CAP) {
      let bestNet: NetId | null = null;
      let bestCycle = Number.POSITIVE_INFINITY;
      let bestLen = 0;
      for (const [net, list] of this.byNet) {
        if (list.length > 1 && list[0].cycle < bestCycle) {
          bestCycle = list[0].cycle;
          bestNet = net;
          bestLen = list.length;
        }
      }
      if (bestNet === null) return; // every net is down to its first sample
      const list = this.byNet.get(bestNet)!;
      const shed = Math.max(1, Math.floor(bestLen / 4));
      list.splice(0, shed);
      this._count -= shed;
      this._truncated.add(bestNet);
    }
  }

  /** Drop everything (circuit unload, or an explicit Clear). */
  clear(): void {
    this.byNet.clear();
    this.starts.clear();
    this._truncated.clear();
    this._count = 0;
    this._hasTime = false;
    this._span = null;
  }
}

/**
 * The x-axis: a fractional cycle.  Cycle `N` starts at `x = N` and ends at
 * `N + 1` — **by construction**, not by a global scale factor, so a cycle's
 * boundaries sit at whole numbers and never move as the run grows.  That is what
 * makes the trace keep its shape: new cycles extend it, they do not squeeze it.
 *
 * An event inside a cycle is placed by its own cycle's *observed* length (the
 * next cycle's start minus this one's), which needs no assumed clock rate and is
 * exactly right for the cycle it belongs to.  The newest, still-open cycle has
 * no successor yet, so it borrows the running median length; when it closes, only
 * that one cycle's events settle into their final place — the rest of the trace
 * is untouched.
 *
 * A core that sends no `at` at all degenerates to whole cycles (`hasTime`), and a
 * signal that moves twice in one cycle then aliases: that is a limitation of such
 * a core, not of the viewer.
 */
export class Timebase {
  private readonly medianDuration: number;

  constructor(
    private readonly starts: ReadonlyMap<number, number>,
    readonly hasTime: boolean,
  ) {
    const gaps: number[] = [];
    const cycles = [...starts.keys()].sort((a, b) => a - b);
    for (let i = 1; i < cycles.length; i++) {
      const span = cycles[i] - cycles[i - 1];
      const gap = (starts.get(cycles[i]) ?? 0) - (starts.get(cycles[i - 1]) ?? 0);
      if (span > 0 && gap > 0) gaps.push(gap / span);
    }
    gaps.sort((a, b) => a - b);
    // The fallback for a cycle with no successor: the observed lengths' **lower**
    // median.  Lower, because the odd cycle is almost always the first one — a
    // full batch lands at t=0 while the first tick's settle is later, so cycle 0
    // is genuinely longer — and an over-estimate would push the live cycle's
    // events right where an under-estimate only shortens an unfinished cycle.
    this.medianDuration = gaps.length > 0 ? gaps[Math.floor((gaps.length - 1) / 2)] : 0;
  }

  /** The observed length of `cycle`, or the running estimate for the open one. */
  duration(cycle: number): number {
    const a = this.starts.get(cycle);
    const b = this.starts.get(cycle + 1);
    if (a !== undefined && b !== undefined && b > a) return b - a;
    return this.medianDuration > 0 ? this.medianDuration : 1;
  }

  /** First event time seen in `cycle` — the cycle's own start, as observed. */
  cycleStart(cycle: number): number {
    const known = this.starts.get(cycle);
    if (known !== undefined) return known;
    let c = cycle;
    let t: number | undefined = known;
    while (t === undefined && c > -1000) {
      c--;
      t = this.starts.get(c);
    }
    if (t === undefined) return 0;
    let acc = t;
    for (let k = c; k < cycle; k++) acc += this.duration(k);
    return acc;
  }

  /**
   * Fractional-cycle position of an event.  Clamped inside its cycle, so x stays
   * monotonic even if an engine stamps a time past the cycle's observed end.
   */
  x(t: number, cycle: number): number {
    if (!this.hasTime) return cycle;
    const dur = this.duration(cycle);
    const frac = (t - this.cycleStart(cycle)) / dur;
    return cycle + Math.min(0.999, Math.max(0, frac));
  }
}

/** Place a net's samples on the axis.  Pure; the view calls it per draw. */
export function projectSamples(samples: readonly WaveSample[], tb: Timebase): PlacedSample[] {
  const out: PlacedSample[] = [];
  for (const s of samples) {
    const x = tb.x(s.t, s.cycle);
    const placed: PlacedSample = { x, val: s.val };
    if (s.contended === true) placed.contended = true;
    out.push(placed);
  }
  return out;
}

/**
 * The sample in effect at `x`: the last one at or before it, or `null` when the
 * trace has nothing that early.
 */
export function valueAt(samples: readonly PlacedSample[], x: number): PlacedSample | null {
  if (samples.length === 0 || x < samples[0].x) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].x <= x) lo = mid;
    else hi = mid - 1;
  }
  return samples[lo];
}

/** One held value over an x range, half-open `[from, to)`. */
export interface StepSegment {
  from: number;
  to: number;
  val: WireValue;
  contended?: boolean;
}

/**
 * Steps covering `[from, to)`.  The first segment is clipped to `from` (the
 * value already in effect when the window opens) and the last holds to `to`.
 */
export function stepSegments(
  samples: readonly PlacedSample[],
  from: number,
  to: number,
): StepSegment[] {
  if (samples.length === 0 || to <= from) return [];
  const start = valueAt(samples, from);
  if (start === null) return [];
  const out: StepSegment[] = [];
  const firstIdx = samples.indexOf(start);
  for (let i = firstIdx; i < samples.length; i++) {
    const s = samples[i];
    if (s.x >= to) break;
    const segFrom = Math.max(from, s.x);
    const next = samples[i + 1]?.x ?? to;
    const segTo = Math.min(to, next);
    if (segTo <= segFrom) continue;
    const seg: StepSegment = { from: segFrom, to: segTo, val: s.val };
    if (s.contended === true) seg.contended = true;
    out.push(seg);
  }
  return out;
}

/** Bits a value carries, from its hex masks (a `0x` string of `n` digits is `4n` bits). */
export function valueBits(val: WireValue): number {
  return Math.max(val.v.length, val.x.length, val.z.length) * 4;
}

/**
 * Compact trace text: `X`/`Z` for an unknown or floating value, `0`/`1` for one
 * bit, upper-case hex otherwise.  A bus is shown as `X` when ANY bit is
 * unknown, which is how the canvas already reads it (`wireValueState`).
 */
export function waveText(val: WireValue, bits: number): string {
  const state = wireValueState(val);
  if (state === "x") return "X";
  if (state === "z") return "Z";
  if (bits <= 1) return state === "high" ? "1" : "0";
  const digits = Math.max(1, Math.ceil(bits / 4));
  return (val.v || "0").toUpperCase().padStart(digits, "0");
}

/**
 * One bit of a value as a 1-bit `WireValue`, so a bus can be expanded into bit
 * lanes that colour exactly like the bus lane does (`wireValueState`).
 * `bit` is 0-based from the LSB; the masks are hex, MSB-first.
 */
export function extractBit(val: WireValue, bit: number): WireValue {
  const digit = Math.floor(bit / 4);
  const mask = 1 << (bit % 4);
  const read = (hex: string): string => {
    const s = hex || "0";
    const pos = s.length - 1 - digit;
    if (pos < 0 || pos >= s.length) return "0";
    const nibble = Number.parseInt(s[pos], 16);
    return Number.isNaN(nibble) || (nibble & mask) === 0 ? "0" : "1";
  };
  return { v: read(val.v), x: read(val.x), z: read(val.z) };
}

/** Lanes shown before a bus is expanded: most significant first, like a readout. */
export function bitLaneIndices(bits: number): number[] {
  const out: number[] = [];
  for (let i = bits - 1; i >= 0; i--) out.push(i);
  return out;
}

/**
 * The rows a fresh trace opens with: every named part the engine exposed a
 * `value_net` for — probes, registers, RAM and ROM.  That is what `NamedComponent`
 * and contract v1.2's `value_net` exist for, and it is always meaningful, which a
 * nameless wire is not.
 */
export function defaultSignals(
  named: readonly NamedComponent[],
  /** Declared width of a named part, from the document (a part's `bitsize`). */
  bitsOf?: (n: NamedComponent) => number | undefined,
): WaveSignal[] {
  const out: WaveSignal[] = [];
  for (const n of named) {
    if (n.value_net === undefined) continue;
    const bits = bitsOf?.(n);
    out.push({
      key: `n:${n.circuit}/${n.name}`,
      label: n.name,
      net: n.value_net,
      origin: "named",
      kind: n.kind,
      ...(bits !== undefined ? { bits } : {}),
    });
  }
  return out;
}

/**
 * The signals a canvas selection resolves to, for **Add selection**.
 *
 * `selectedPins` is resolved by the caller (App), because picking the right pin
 * for a part means the registry's per-type pin specs — a gate's is `out`, a
 * register's is `q` — and that knowledge lives in `editor/catalog.ts`.  All this
 * needs to know is which document wire reaches each pin, and which engine net
 * that wire belongs to (contract v1.2's `net_map`, root sheet only).
 */
export function pickedSignals(opts: {
  wires: readonly { a: unknown; b: unknown }[];
  wireToNet: ReadonlyMap<number, NetId>;
  selectedWires?: readonly number[];
  selectedPins?: readonly { comp: string; pin: string }[];
  /**
   * Declared width of a pin, from the document.  Worth passing: a value's hex
   * masks are nibble-aligned, so a 1-bit signal's mask is already 4 "bits" wide
   * and the masks alone would call every picked 1-bit wire a bus.
   */
  bitsOf?: (comp: string, pin: string) => number | undefined;
}): WaveSignal[] {
  const out: WaveSignal[] = [];
  const seen = new Set<NetId>();

  const add = (
    key: string,
    label: string,
    kind: string,
    net: NetId | undefined,
    pin?: { comp: string; pin: string },
  ): void => {
    if (net === undefined || seen.has(net)) return;
    seen.add(net);
    const bits = pin === undefined ? undefined : opts.bitsOf?.(pin.comp, pin.pin);
    out.push({
      key,
      label,
      net,
      origin: "picked",
      kind,
      ...(bits !== undefined && bits > 0 ? { bits } : {}),
    });
  };

  /** First pin endpoint of a wire — the width of the net it carries. */
  const pinOf = (idx: number): { comp: string; pin: string } | undefined => {
    const w = opts.wires[idx];
    if (w === undefined) return undefined;
    for (const ep of [w.a, w.b]) {
      if (typeof ep === "object" && ep !== null && "comp" in ep && "pin" in ep) {
        return ep as { comp: string; pin: string };
      }
    }
    return undefined;
  };

  for (const idx of opts.selectedWires ?? []) {
    add(`w:${idx}`, `wire ${idx}`, "wire", opts.wireToNet.get(idx), pinOf(idx));
  }
  for (const want of opts.selectedPins ?? []) {
    const at = opts.wires.findIndex((w) =>
      [w.a, w.b].some(
        (ep) =>
          typeof ep === "object" &&
          ep !== null &&
          "comp" in ep &&
          (ep as { comp: string; pin: string }).comp === want.comp &&
          (ep as { comp: string; pin: string }).pin === want.pin,
      ),
    );
    if (at < 0) continue;
    add(
      `p:${want.comp}.${want.pin}`,
      `${want.comp}.${want.pin}`,
      "pin",
      opts.wireToNet.get(at),
      want,
    );
  }
  return out;
}

/**
 * The clocks of the open circuit, as trace rows.
 *
 * A `wiring.clock` is not a *named* part (contract v1.2's `NamedComponent` covers
 * registers, RAM, ROM and probes), so it would never appear on its own — and the
 * clock is the first thing anyone looks at in a trace, and the signal whose
 * aliasing exposed the recording bug this module used to have.  Resolved through
 * the wire that reaches its `out` pin, like any other pick.
 */
export function clockSignals(opts: {
  wires: readonly { a: unknown; b: unknown }[];
  wireToNet: ReadonlyMap<number, NetId>;
  components: readonly { id: string; type: string; name?: string }[];
}): WaveSignal[] {
  const clocks = opts.components.filter((c) => c.type === "wiring.clock");
  const resolved = pickedSignals({
    wires: opts.wires,
    wireToNet: opts.wireToNet,
    selectedPins: clocks.map((c) => ({ comp: c.id, pin: "out" })),
  });
  return resolved.map((sig) => {
    const comp = clocks.find((c) => sig.key === `p:${c.id}.out`);
    // A clock is one bit, whatever mask a core puts on it.
    return {
      ...sig,
      key: `k:${comp?.id ?? sig.key}`,
      kind: "clock",
      label: comp?.name || "clk",
      bits: 1,
    };
  });
}

/**
 * Breakpoints on the sheet being traced (UI_OVERHAUL §90): each watched net →
 * the conditions that stop on it (`= 0x05`). A list, not one string: nothing
 * stops a student putting two breakpoints on one signal (watch 0 here, watch 5
 * there), and the trace must not quietly show only one of them.
 *
 * Resolved the same way as every other trace signal — through the document wire
 * that reaches the part's `in` pin and the engine's `net_map` — so the trace
 * marks the breakpoints the *schematic* has. The engine has nothing to tell us
 * here: a breakpoint changes behavior in the run, but *which* signals are
 * watched is a property of the drawing, and it is the same drawing the trace is
 * being read against.
 */
export function breakpointWatches(opts: {
  wires: readonly { a: unknown; b: unknown }[];
  wireToNet: ReadonlyMap<number, NetId>;
  components: readonly {
    id: string;
    type: string;
    attrs?: Readonly<Record<string, unknown>>;
  }[];
}): Map<NetId, string[]> {
  const watches = new Map<NetId, string[]>();
  const byId = new Map(
    opts.components.filter((c) => c.type === "debug.breakpoint").map((c) => [c.id, c]),
  );
  if (byId.size === 0) return watches;
  opts.wires.forEach((wire, idx) => {
    for (const ep of [wire.a, wire.b]) {
      if (typeof ep !== "object" || ep === null || !("comp" in ep) || !("pin" in ep)) continue;
      const { comp, pin } = ep as { comp: string; pin: string };
      // Only the DATA pin watches a net; `en` is a control input (format-v2 §4
      // keeps the old tool's DATA/ENABLE pair, and only DATA is watched).
      if (pin !== "in") continue;
      const bp = byId.get(comp);
      if (bp === undefined) continue;
      const net = opts.wireToNet.get(idx);
      if (net === undefined) continue;
      const list = watches.get(net);
      const cond = breakpointCondition(bp.attrs);
      if (list === undefined) watches.set(net, [cond]);
      else if (!list.includes(cond)) list.push(cond);
    }
  });
  return watches;
}
