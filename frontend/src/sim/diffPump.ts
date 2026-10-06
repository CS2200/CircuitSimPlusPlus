/**
 * Diff pump (DESIGN.md §7.2): the UI consumes AT MOST one `net_diffs` batch
 * per animation frame; intermediate states are dropped — never a backlog.
 *
 * Batches pushed between frames are MERGED into one pending map (latest
 * value per net wins — that *is* the dropping), then flushed once per frame
 * via an injectable scheduler (rAF in the app, synchronous in tests). Each
 * change keeps its v1.1 `at` timestamp (latest batch's, like the value) so
 * U7 pulses can spawn from engine event times. `full` is OR-ed across the
 * merged batches: a full (initial-paint) frame never spawns pulses.
 */

import type { NetDiffs, NetId, WireValue } from "../ipc/types";

/** A flushed change: the value plus its delay-mode event time (if any). */
export interface StampedChange {
  val: WireValue;
  at?: number;
}

export type FlushHandler = (
  changes: ReadonlyMap<NetId, StampedChange>,
  cycle: number,
  full: boolean,
) => void;

export class DiffPump {
  private pending = new Map<NetId, StampedChange>();
  private pendingFull = false;
  private latestCycle = 0;
  private scheduled = false;

  constructor(
    private readonly onFlush: FlushHandler,
    private readonly schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(() => cb()),
  ) {}

  /** Merge one engine batch into the pending frame. */
  push(diffs: NetDiffs): void {
    for (const c of diffs.changes) this.pending.set(c.net, { val: c.val, at: c.at });
    this.pendingFull ||= diffs.full;
    this.latestCycle = diffs.cycle;
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Apply the merged frame exactly once. */
  private flush(): void {
    this.scheduled = false;
    if (this.pending.size === 0 && !this.pendingFull) return;
    const changes = this.pending;
    const full = this.pendingFull;
    this.pending = new Map();
    this.pendingFull = false;
    this.onFlush(changes, this.latestCycle, full);
  }

  /** Drop unflushed state (circuit unload). */
  clear(): void {
    this.pending.clear();
    this.pendingFull = false;
  }
}
