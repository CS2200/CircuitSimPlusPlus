/**
 * Autosave scheduler (autosave, phase 1).
 *
 * The trigger is *3 s of idle* after the last document change, plus a hard cap
 * so a long stretch of continuous editing still gets flushed, plus forced
 * flushes on window blur / close / explicit Save. Persisting is the injected
 * host's job, so this is pure timing logic — unit-tested with fake timers and
 * no React, no real filesystem.
 */

export type FlushReason = "idle" | "blur" | "close" | "manual";

export interface AutosaveHost {
  /** True when the document has unsaved changes. */
  isDirty(): boolean;
  /** Document revision; bumps on every mutation (and nothing else). */
  revision(): number;
  /** Persist now. Async work is awaited; the host reports its own errors. */
  flush(reason: FlushReason): Promise<void> | void;
}

export interface AutosaveTiming {
  /** Idle time after the last change before the debounce fires. */
  idleMs: number;
  /** Upper bound on how long a dirty document may go unflushed. */
  maxDirtyMs: number;
}

export const DEFAULT_AUTOSAVE_TIMING: AutosaveTiming = { idleMs: 3000, maxDirtyMs: 30000 };

export class AutosaveController {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirtySince: number | null = null;
  private lastRevision = -1;
  private flushing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly host: AutosaveHost,
    private readonly timing: AutosaveTiming = DEFAULT_AUTOSAVE_TIMING,
    /** Wall clock; injectable so the max-dirty cap is testable. */
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Report a possible document change. Restarts the idle debounce while dirty
   * (so continuous editing waits for a pause) and flushes at once once the
   * dirty window hits the cap. Cheap to call on every editor status update:
   * an unchanged revision is ignored.
   */
  notifyChanged(): void {
    if (this.disposed) return;
    const revision = this.host.revision();
    if (revision === this.lastRevision) return;
    this.lastRevision = revision;
    if (!this.host.isDirty()) {
      this.cancelTimer();
      this.dirtySince = null;
      return;
    }
    const now = this.now();
    this.dirtySince ??= now;
    if (now - this.dirtySince >= this.timing.maxDirtyMs) {
      void this.flush("idle");
      return;
    }
    this.cancelTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush("idle");
    }, this.timing.idleMs);
  }

  /**
   * Flush now (blur / close / explicit save). A clean document is skipped
   * except for `"manual"`. Flushes are serialized so a pending one always
   * completes before the next starts.
   */
  async flush(reason: FlushReason): Promise<void> {
    if (this.disposed) return;
    this.cancelTimer();
    if (reason !== "manual" && !this.host.isDirty()) return;
    this.flushing = this.flushing
      .then(async () => {
        this.dirtySince = null;
        await this.host.flush(reason);
      })
      .catch(() => {
        /* the host reports its own errors (toast + save state) */
      });
    await this.flushing;
  }

  /** True while a debounce is pending or the document is dirty-flushed-later. */
  get pending(): boolean {
    return this.timer !== null;
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private cancelTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
