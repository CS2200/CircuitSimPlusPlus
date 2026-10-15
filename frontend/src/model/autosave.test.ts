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
  it("flushes 3 s after the last change", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged();

    await vi.advanceTimersByTimeAsync(2999);
    expect(h.flushes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.flushes).toEqual(["idle"]);
  });

  it("debounces: a change inside the window restarts the timer", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged();

    await vi.advanceTimersByTimeAsync(2000);
    h.edit(); // user kept typing
    ctrl.notifyChanged();
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.flushes).toEqual([]); // window restarted, still < 3 s idle
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.flushes).toEqual(["idle"]);
  });

  it("ignores status updates that did not change the revision", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged();
    ctrl.notifyChanged(); // e.g. a cursor move — same revision
    ctrl.notifyChanged();

    await vi.advanceTimersByTimeAsync(3000);
    expect(h.flushes).toEqual(["idle"]); // exactly one
  });

  it("flushes at the max-dirty cap while editing never pauses", async () => {
    const h = makeHost();
    let clock = 0;
    const ctrl = new AutosaveController(h.host, { idleMs: 3000, maxDirtyMs: 10000 }, () => clock);
    h.edit();
    ctrl.notifyChanged();

    // Continuous activity: a change every second, so the idle timer never fires.
    for (let i = 0; i < 10; i++) {
      clock += 1000;
      await vi.advanceTimersByTimeAsync(1000);
      h.edit();
      ctrl.notifyChanged();
    }
    await Promise.resolve(); // the cap's flush runs on a microtask
    await Promise.resolve();
    expect(h.flushes).toEqual(["idle"]); // the cap fired, not the debounce
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

    h.edit();
    ctrl.notifyChanged();
    await ctrl.flush("blur");
    expect(h.flushes).toEqual(["blur"]);

    h.edit();
    await ctrl.flush("close");
    expect(h.flushes).toEqual(["blur", "close"]);

    // "manual" always runs (an explicit Save path may want its own flush).
    await ctrl.flush("manual");
    expect(h.flushes).toEqual(["blur", "close", "manual"]);
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

  it("stops after dispose", async () => {
    const h = makeHost();
    const ctrl = new AutosaveController(h.host);
    h.edit();
    ctrl.notifyChanged();
    ctrl.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.flushes).toEqual([]);
  });
});
