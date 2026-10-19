/**
 * Waveform recording (Design: `frontend/UI_OVERHAUL.md` §89).  The sim viewer
 * draws what the engine already tells us — no new IPC, no engine change.
 *
 * The engine streams `net_diffs`: `{ cycle, full, changes: [{ net, val, at?,
 * contended? }] }`.  `DiffPump` merges those down to AT MOST one batch per
 * animation frame before the UI paints (DESIGN.md §7.2) — deliberately lossy,
 * because a paint only needs the latest value.  A *trace* cannot afford that:
 * at speed, many cycles pass between frames, and a merged batch keeps only the
 * last value of each net, so whole cycles would vanish from the picture.
 *
 * So the recorder taps the batches BEFORE the merge (`DiffPump`'s `onRaw`) and
 * keeps **one sample per cycle per net** — the value the net settled to that
 * cycle, which is exactly what a cycle-axis trace shows.  Repeated changes
 * inside one cycle collapse to the last one; an unchanging net keeps a single
 * sample, and `valueAt` walks back to it.  That is compact (a 2000-net design
 * that runs still costs one entry per net) and it is lossless at the
 * resolution the axis actually has.
 *
 * The recording is bounded: `WAVE_SAMPLE_CAP` per net and `WAVE_TOTAL_CAP`
 * overall, oldest-first, with the sacrifice recorded in `truncated` so the view
 * can say so rather than quietly lying about the past.
 */

import type { NetId, NetDiffs, NamedComponent, WireValue } from "../ipc/types";
import { wireValueState } from "../lib/value";

/** One value, in effect from `cycle` until the next sample. */
export interface CycleSample {
  cycle: number;
  val: WireValue;
  /** The engine flagged a genuine short circuit at this change (v1.2). */
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

/** Per-net sample cap.  A net that changes every cycle for 2048 cycles is a lot of trace. */
export const WAVE_SAMPLE_CAP = 2048;
/** Overall cap, so a huge design with long runs cannot grow without bound. */
export const WAVE_TOTAL_CAP = 400_000;

function sameValue(a: WireValue, b: WireValue): boolean {
  return a.v === b.v && a.x === b.x && a.z === b.z;
}

export class WaveformRecorder {
  private readonly byNet = new Map<NetId, CycleSample[]>();
  private readonly _truncated = new Set<NetId>();
  private _count = 0;
  private _first = Number.POSITIVE_INFINITY;
  private _last = 0;

  /** Total samples held (all nets). */
  get sampleCount(): number {
    return this._count;
  }

  /** Nets that lost their oldest history to a cap. */
  get truncated(): ReadonlySet<NetId> {
    return this._truncated;
  }

  /** Cycles seen, or `null` before anything was recorded. */
  get span(): { first: number; last: number } | null {
    return this._count === 0 ? null : { first: this._first, last: this._last };
  }

  netCount(): number {
    return this.byNet.size;
  }

  samples(net: NetId): readonly CycleSample[] {
    return this.byNet.get(net) ?? [];
  }

  /**
   * One engine batch, straight from `DiffPump`'s raw tap.
   *
   * A `full` batch (the initial paint after load/resume) seeds every net at its
   * cycle, so a trace starts defined instead of blank.
   */
  recordBatch(diffs: NetDiffs): void {
    const cycle = diffs.cycle;
    for (const change of diffs.changes) {
      const list = this.byNet.get(change.net);
      if (list === undefined) {
        this.byNet.set(change.net, [this.makeSample(cycle, change.val, change.contended)]);
        this._count++;
      } else {
        const last = list[list.length - 1];
        if (last.cycle === cycle) {
          // Same cycle: the later value wins — the sample is replaced, not added,
          // because a cycle axis has no finer resolution than the cycle.
          last.val = change.val;
          if (change.contended === true) last.contended = true;
          else delete last.contended;
        } else if (!sameValue(last.val, change.val)) {
          // A change: one new sample.  (No sample for a cycle in which the net
          // did not move — `valueAt` walks back to the one still in effect.)
          list.push(this.makeSample(cycle, change.val, change.contended));
          this._count++;
        }
        if (list.length > WAVE_SAMPLE_CAP) {
          // Amortised: shed a block, mark the past as incomplete.
          const shed = Math.max(1, Math.floor(WAVE_SAMPLE_CAP / 4));
          list.splice(0, shed);
          this._count -= shed;
          this._truncated.add(change.net);
        }
      }
      if (cycle < this._first) this._first = cycle;
      if (cycle > this._last) this._last = cycle;
    }
    // Global cap: shed whole nets' older halves until we are under.
    if (this._count > WAVE_TOTAL_CAP) this.shedOldest();
  }

  private makeSample(cycle: number, val: WireValue, contended?: boolean): CycleSample {
    const s: CycleSample = { cycle, val };
    if (contended === true) s.contended = true;
    return s;
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
    this._truncated.clear();
    this._count = 0;
    this._first = Number.POSITIVE_INFINITY;
    this._last = 0;
  }
}

/**
 * The value in effect during `cycle`: the last sample at or before it, or `null`
 * when the trace has nothing that early.
 */
export function valueAt(samples: readonly CycleSample[], cycle: number): CycleSample | null {
  if (samples.length === 0 || cycle < samples[0].cycle) return null;
  let lo = 0;
  let hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (samples[mid].cycle <= cycle) lo = mid;
    else hi = mid - 1;
  }
  return samples[lo];
}

/** One held value over a cycle range, half-open `[from, to)`. */
export interface StepSegment {
  from: number;
  to: number;
  val: WireValue;
  contended?: boolean;
}

/**
 * Steps covering `[from, to)`.  Only the samples that matter are visited, and
 * the first segment is clipped to `from` (the value that was already in effect
 * when the window opens).
 */
export function stepSegments(
  samples: readonly CycleSample[],
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
    if (s.cycle >= to) break;
    const segFrom = Math.max(from, s.cycle);
    const next = samples[i + 1]?.cycle ?? to;
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
