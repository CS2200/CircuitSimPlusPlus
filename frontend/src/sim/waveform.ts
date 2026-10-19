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
  /** `probe` | `register` | `ram` | `rom` for named parts; `wire` | `pin` for picks. */
  kind: string;
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
 * `N + 1`, so the axis is measured in cycles (the model the course reasons in)
 * while events inside one are placed by their real time.
 */
export class Timebase {
  private readonly firstT: number;
  private readonly firstCycle: number;
  private readonly lastT: number;
  private readonly period: number;

  constructor(
    private readonly starts: ReadonlyMap<number, number>,
    readonly hasTime: boolean,
  ) {
    let first = Number.POSITIVE_INFINITY;
    let firstCycle = 0;
    let last = Number.NEGATIVE_INFINITY;
    const cycles: number[] = [];
    for (const [cycle, t] of starts) {
      if (t < first) {
        first = t;
        firstCycle = cycle;
      }
      if (t > last) last = t;
      cycles.push(cycle);
    }
    cycles.sort((a, b) => a - b);
    this.firstT = Number.isFinite(first) ? first : 0;
    this.firstCycle = Number.isFinite(first) ? firstCycle : 0;
    this.lastT = Number.isFinite(last) ? last : 0;
    // The period is *derived*: the median gap between cycle starts, so a gap in
    // the data (a cycle where nothing moved) does not skew it.
    const gaps: number[] = [];
    for (let i = 1; i < cycles.length; i++) {
      const g = (starts.get(cycles[i]) ?? 0) - (starts.get(cycles[i - 1]) ?? 0);
      if (g > 0) gaps.push(g / (cycles[i] - cycles[i - 1]));
    }
    gaps.sort((a, b) => a - b);
    const median = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)] : 0;
    this.period = median > 0 ? median : Math.max(1, this.lastT - this.firstT);
  }

  /** Fractional-cycle position of an event. */
  x(t: number, cycle: number): number {
    if (!this.hasTime) return cycle;
    const start = this.cycleStart(cycle);
    return cycle + (t - start) / this.period;
  }

  /** First event time seen in `cycle` — the cycle's own start, as observed. */
  cycleStart(cycle: number): number {
    const known = this.starts.get(cycle);
    if (known !== undefined) return known;
    // No event in that cycle: place it by extrapolating from the first one, so
    // the axis stays linear across a gap.
    return this.firstT + (cycle - this.firstCycle) * this.period;
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
export function defaultSignals(named: readonly NamedComponent[]): WaveSignal[] {
  const out: WaveSignal[] = [];
  for (const n of named) {
    if (n.value_net === undefined) continue;
    out.push({
      key: `n:${n.circuit}/${n.name}`,
      label: n.name,
      net: n.value_net,
      origin: "named",
      kind: n.kind,
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
}): WaveSignal[] {
  const out: WaveSignal[] = [];
  const seen = new Set<NetId>();

  const add = (key: string, label: string, kind: string, net: NetId | undefined): void => {
    if (net === undefined || seen.has(net)) return;
    seen.add(net);
    out.push({ key, label, net, origin: "picked", kind });
  };

  for (const idx of opts.selectedWires ?? []) {
    add(`w:${idx}`, `wire ${idx}`, "wire", opts.wireToNet.get(idx));
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
    add(`p:${want.comp}.${want.pin}`, `${want.comp}.${want.pin}`, "pin", opts.wireToNet.get(at));
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
    return { ...sig, key: `k:${comp?.id ?? sig.key}`, kind: "clock", label: comp?.name || "clk" };
  });
}
