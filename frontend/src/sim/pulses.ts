/**
 * Propagation pulses (FRONTEND.md U7, UI side): at low sim speeds, signals
 * visibly travel along wires — one pulse dot per changed net per wire,
 * animated over PULSE_MS of wall time.
 *
 * Spawn timing (contract v1.1): changes carry `at` (ns since run start) in
 * delay mode. Within one flushed frame, a pulse's spawn is STAGGERED by its
 * event time relative to the frame's earliest event, so sequential settle
 * (clk→Q) visibly precedes the combinational cloud — the causal order the
 * transport/inertial model teaches (DESIGN.md §4.3). The ns→ms mapping is
 * a presentation scale (NS_STAGGER window compressed into one PULSE_MS);
 * wall-clock here is presentation only — never the eval path (§4.6).
 * Changes without `at` (zero mode) spawn at batch arrival, as before.
 */

import type { NetId } from "../ipc/types";
import type { NetChangeEvent } from "./simStore";

export const PULSE_MS = 350;
/** Engine-ns window that maps to one PULSE_MS of spawn stagger. */
const NS_STAGGER = 100;

export interface Pulse {
  net: NetId;
  /** rAF timestamp (ms) at which the pulse starts (may be in the future). */
  t0: number;
}

export class PulseTracker {
  private pulses: Pulse[] = [];

  /**
   * Spawn a pulse for each changed net. Events with `at` stagger relative
   * to the frame's earliest timestamp; untimed events spawn immediately.
   */
  spawn(events: readonly NetChangeEvent[], tNow: number): void {
    let atMin = Infinity;
    for (const e of events) {
      if (e.at !== undefined) atMin = Math.min(atMin, e.at);
    }
    for (const e of events) {
      const stagger =
        e.at === undefined || atMin === Infinity
          ? 0
          : Math.min(PULSE_MS, ((e.at - atMin) / NS_STAGGER) * PULSE_MS);
      this.pulses.push({ net: e.net, t0: tNow + stagger });
    }
  }

  /**
   * Live pulses at `tNow`, as (net, phase) with phase ∈ [0,1). Expired
   * pulses are reaped; future (staggered) pulses are kept but not yet
   * rendered. Returns null when nothing is animating (so the canvas can
   * drop back to dirty-driven rendering).
   */
  active(tNow: number): { net: NetId; phase: number }[] | null {
    if (this.pulses.length === 0) return null;
    const live: { net: NetId; phase: number }[] = [];
    const keep: Pulse[] = [];
    for (const p of this.pulses) {
      const phase = (tNow - p.t0) / PULSE_MS;
      if (phase < 1) {
        keep.push(p);
        if (phase >= 0) live.push({ net: p.net, phase });
      }
    }
    this.pulses = keep;
    return keep.length === 0 ? null : live;
  }

  clear(): void {
    this.pulses = [];
  }
}
