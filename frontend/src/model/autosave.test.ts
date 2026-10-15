import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutosaveController, type AutosaveHost, type FlushReason } from "./autosave";

/** A controllable host: flip `edit()` to make the document dirty + bump revision. */
function makeHost() {
  const state = { revision: 0, dirty: false };
  const flushes: FlushReason[] = [];
  const host: AutosaveHost = {
    isDirty: () => state.dirty,
    revision: () => state.revision,
    flush: (reason) => {
      flushes.push(reason);
      state.dirty = false; // a successful flush saves the document
    },
  };
  return {
    host,
    flushes,
    edit(): void {
      state.revision++;
      state.dirty = true;
    },
    makeDirtyOnly(): void {
      state.dirty = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("AutosaveController", () => {
  it("writes the first change at once, then the tail of the burst", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged(); // leading edge

    await vi.advanceTimersByTimeAsync(0);
    expect(h.flushes).toEqual(["change"]);

    h.edit(); // the user kept typing
    ctrl.notifyChanged();
    await vi.advanceTimersByTimeAsync(999);
    expect(h.flushes).toEqual(["change"]); // still coalescing the burst
    await vi.advanceTimersByTimeAsync(1);
    expect(h.flushes).toEqual(["change", "idle"]);
  });

  it("ignores status updates that did not change the revision", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged();
    ctrl.notifyChanged(); // e.g. a cursor move — same revision
    ctrl.notifyChanged();

    await vi.advanceTimersByTimeAsync(1000);
    expect(h.flushes).toEqual(["change"]); // exactly one write
  });

  it("flushes at the max-dirty cap while editing never pauses", async () => {
    const h = makeHost();
    let clock = 0;
    const ctrl = new AutosaveController(h.host, { idleMs: 3000, maxDirtyMs: 10000 }, () => clock);
    h.edit();
    ctrl.notifyChanged(); // leading flush
    await vi.advanceTimersByTimeAsync(0);

    // Continuous activity: a change every second, so the idle timer never fires.
    for (let i = 0; i < 11; i++) {
      clock += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      h.edit();
      ctrl.notifyChanged();
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flushes).toEqual(["change", "idle"]); // the cap fired, not the debounce
  });

  it("does not schedule anything while the document is clean", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    ctrl.notifyChanged(); // clean
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.flushes).toEqual([]);
    expect(ctrl.pending).toBe(false);
  });

  it("force-flushes on blur/close, and skips a clean document", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);

    await ctrl.flush("blur"); // clean → nothing
    expect(h.flushes).toEqual([]);

    // Autosave already took this change, so a later blur finds nothing to do.
    h.edit();
    ctrl.notifyChanged();
    await vi.advanceTimersByTimeAsync(0); // the leading flush lands
    expect(h.flushes).toEqual(["change"]);
    await ctrl.flush("blur"); // clean now → skipped
    expect(h.flushes).toEqual(["change"]);

    // A forced flush still covers a dirty document autosave has not seen yet.
    h.edit();
    await ctrl.flush("close");
    expect(h.flushes).toEqual(["change", "close"]);

    // "manual" always runs (an explicit Save path may want its own flush).
    await ctrl.flush("manual");
    expect(h.flushes).toEqual(["change", "close", "manual"]);
  });

  it("serializes overlapping flushes (a pending write finishes first)", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const host: AutosaveHost = {
      isDirty: () => true,
      revision: () => 1,
      flush: async (reason) => {
        order.push(`start:${reason}`);
        await gate; // both flushes wait on the same gate → released once
        order.push(`end:${reason}`);
      },
    };
    const ctrl = new AutosaveController(host);
    const first = ctrl.flush("blur");
    const second = ctrl.flush("close");
    // The first flush is in flight; the second must not have started yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start:blur"]);

    release();
    await first;
    await second;
    expect(order).toEqual(["start:blur", "end:blur", "start:close", "end:close"]);
  });

  it("stops after dispose (a write already queued still lands)", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged(); // queued on the leading edge
    await vi.advanceTimersByTimeAsync(0);
    expect(h.flushes).toEqual(["change"]);

    ctrl.dispose();
    h.edit();
    ctrl.notifyChanged(); // ignored now
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.flushes).toEqual(["change"]);
  });
});
