/**
 * Diff pump (DESIGN.md §7.2): the UI consumes AT MOST one `net_diffs` batch
 * per animation frame; intermediate states are dropped — never a backlog.
 *
 * Batches pushed between frames are MERGED into one pending map (latest
 * value per net wins — that *is* the dropping), then flushed once per frame
 * via an injectable scheduler (rAF in the app, synchronous in tests).
 */

import type { NetDiffs, NetId, WireValue } from "../ipc/types";

export type FlushHandler = (changes: ReadonlyMap<NetId, WireValue>, cycle: number) => void;

export class DiffPump {
  private pending = new Map<NetId, WireValue>();
  private latestCycle = 0;
  private scheduled = false;

  constructor(
    private readonly onFlush: FlushHandler,
    private readonly schedule: (cb: () => void) => void = (cb) => requestAnimationFrame(() => cb()),
  ) {}

  /** Merge one engine batch into the pending frame. */
  push(diffs: NetDiffs): void {
    for (const c of diffs.changes) this.pending.set(c.net, c.val);
    this.latestCycle = diffs.cycle;
    if (!this.scheduled) {
      this.scheduled = true;
      this.schedule(() => this.flush());
    }
  }

  /** Apply the merged frame exactly once. */
  private flush(): void {
    this.scheduled = false;
    if (this.pending.size === 0) return;
    const changes = this.pending;
    this.pending = new Map();
    this.onFlush(changes, this.latestCycle);
  }

  /** Drop unflushed state (circuit unload). */
  clear(): void {
    this.pending.clear();
  }
}
