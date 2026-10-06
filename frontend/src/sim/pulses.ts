/**
 * Propagation pulses (FRONTEND.md U7, UI side): at low sim speeds, signals
 * visibly travel along wires — one pulse dot per changed net per wire,
 * animated over PULSE_MS of wall time.
 *
 * v1 uses diff-batch arrival as the trigger (a value CHANGED on this net).
 * The full M4 version positions pulses from engine event timestamps
 * (transport delay, DESIGN.md §4.3) once the contract carries them; the
 * tracker API already speaks in "spawn at time" terms to make that swap
 * local. Wall-clock here is presentation only — never the eval path (§4.6).
 */

import type { NetId } from "../ipc/types";

export const PULSE_MS = 350;

export interface Pulse {
  net: NetId;
  /** rAF timestamp (ms) at which the pulse started. */
  t0: number;
}

export class PulseTracker {
  private pulses: Pulse[] = [];

  /** Spawn a pulse for each changed net. */
  spawn(nets: readonly NetId[], tNow: number): void {
    for (const net of nets) this.pulses.push({ net, t0: tNow });
  }

  /**
   * Live pulses at `tNow`, as (net, phase) with phase ∈ [0,1). Expired
   * pulses are reaped. Returns null when nothing is animating (so the
   * canvas can drop back to dirty-driven rendering).
   */
  active(tNow: number): { net: NetId; phase: number }[] | null {
    if (this.pulses.length === 0) return null;
    const live: { net: NetId; phase: number }[] = [];
    const keep: Pulse[] = [];
    for (const p of this.pulses) {
      const phase = (tNow - p.t0) / PULSE_MS;
      if (phase < 1) {
        live.push({ net: p.net, phase });
        keep.push(p);
      }
    }
    this.pulses = keep;
    return live.length === 0 ? null : live;
  }

  clear(): void {
    this.pulses = [];
  }
}
