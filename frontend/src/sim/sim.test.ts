import { describe, expect, it } from "vitest";
import { DiffPump } from "./diffPump";
import { SimStore } from "./simStore";
import type { NetId, WireValue } from "../ipc/types";

const val = (v: string): WireValue => ({ v, x: "0", z: "0" });

/** Synchronous scheduler: flushes run immediately on push. */
const sync = (cb: () => void): void => cb();

describe("DiffPump (§7.2: ≤1 batch per frame, drop intermediates)", () => {
  it("merges a burst of batches into ONE flush, latest value per net wins", () => {
    const flushes: [ReadonlyMap<NetId, WireValue>, number][] = [];
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      (changes, cycle) => flushes.push([changes, cycle]),
      (cb) => queue.push(cb),
    );
    pump.push({ cycle: 1, changes: [{ net: 0, val: val("1") }] });
    pump.push({
      cycle: 2,
      changes: [
        { net: 0, val: val("0") },
        { net: 1, val: val("f") },
      ],
    });
    pump.push({ cycle: 3, changes: [{ net: 0, val: val("1") }] });
    expect(flushes).toHaveLength(0); // nothing until the frame boundary
    expect(queue).toHaveLength(1); // one scheduled flush, not three
    queue.forEach((cb) => cb());
    expect(flushes).toHaveLength(1);
    const [changes, cycle] = flushes[0];
    expect(changes.get(0)).toEqual(val("1")); // latest, not a backlog of 3
    expect(changes.get(1)).toEqual(val("f"));
    expect(cycle).toBe(3); // newest batch's cycle
  });

  it("flushes once per frame boundary under a synchronous scheduler", () => {
    const flushes: number[] = [];
    const pump = new DiffPump((_c, cycle) => flushes.push(cycle), sync);
    pump.push({ cycle: 1, changes: [{ net: 0, val: val("1") }] });
    pump.push({ cycle: 2, changes: [{ net: 0, val: val("0") }] });
    expect(flushes).toEqual([1, 2]);
  });

  it("clear() drops unflushed state", () => {
    const flushes: unknown[] = [];
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      () => flushes.push(1),
      (cb) => queue.push(cb),
    );
    pump.push({ cycle: 1, changes: [{ net: 0, val: val("1") }] });
    pump.clear();
    queue.forEach((cb) => cb());
    expect(flushes).toHaveLength(0);
  });
});

describe("SimStore", () => {
  it("applies flushed diffs and notifies subscribers with a version bump", () => {
    const store = new SimStore();
    let seen = 0;
    store.subscribe(() => seen++);
    store.onLoaded(new Map([[0, 7]]), []);
    expect(store.loaded).toBe(true);
    expect(store.wireToNet?.get(0)).toBe(7);
    const v0 = store.getVersion();
    store.applyDiffs(new Map([[7, val("ff")]]), 5);
    expect(store.cycle).toBe(5);
    expect(store.netValues.get(7)).toEqual(val("ff"));
    expect(store.getVersion()).toBeGreaterThan(v0);
    expect(seen).toBe(2);
  });

  it("onLoadFailed surfaces errors and clears the loaded state", () => {
    const store = new SimStore();
    store.onLoaded(new Map([[0, 7]]), [{ name: "pc", kind: "register", comp_id: 1 }]);
    store.onLoadFailed([{ kind: "parse", message: "bad json", circuit: "main", wire_idx: 3 }]);
    expect(store.loaded).toBe(false);
    expect(store.wireToNet).toBeNull();
    expect(store.named).toEqual([]);
    expect(store.loadErrors).toHaveLength(1);
    expect(store.loadErrors[0].wire_idx).toBe(3);
  });

  it("reset() returns to the pre-load state", () => {
    const store = new SimStore();
    store.onLoaded(new Map(), []);
    store.onStatus({ running: true, cycle: 10, mode: "delay", eff_hz: 1000 });
    store.onHalted({ cycle: 10, reason: "oscillation", details: "comp 2" });
    store.reset();
    expect(store.loaded).toBe(false);
    expect(store.status).toBeNull();
    expect(store.halted).toBeNull();
    expect(store.netValues.size).toBe(0);
  });
});
