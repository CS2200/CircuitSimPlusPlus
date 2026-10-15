/**
 * Autosave scheduler (autosave, phase 1; "save every change" in §44).
 *
 * Every change is persisted: the first edit after a quiet spell is flushed
 * immediately (leading edge), and a burst of edits coalesces into one trailing
 * flush `idleMs` later. A hard cap bounds how long a continuously-dirty
 * document may go unwritten, and window blur / close / explicit Save force a
 * flush. Persisting is the injected host's job, so this is pure timing logic —
 * unit-tested with fake timers and no React, no real filesystem.
 */

export type FlushReason = "change" | "idle" | "blur" | "close" | "manual";

export interface AutosaveHost {
  /** True when the document has unsaved changes. */
  isDirty(): boolean;
  /** Document revision; bumps on every mutation (and nothing else). */
  revision(): number;
  /** Persist now. Async work is awaited; the host reports its own errors. */
  flush(reason: FlushReason): Promise<void> | void;
}

export interface AutosaveTiming {
  /** Idle time after the last change before the trailing flush fires. */
  idleMs: number;
  /** Upper bound on how long a dirty document may go unflushed. */
  maxDirtyMs: number;
}

export const DEFAULT_AUTOSAVE_TIMING: AutosaveTiming = { idleMs: 1000, maxDirtyMs: 10_000 };

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
   * Report a possible document change. The first change after a quiet spell is
   * flushed at once (leading edge), and further changes coalesce into a trailing
   * flush `idleMs` later; a continuously-dirty document is flushed at the cap.
   * Cheap to call on every editor status update: an unchanged revision is
   * ignored.
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
    // Leading edge: with nothing pending, this change starts a burst, so it is
    // written now rather than waiting out the window.
    const startsBurst = this.timer === null;
    this.cancelTimer();
    if (startsBurst) void this.flush("change");
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
