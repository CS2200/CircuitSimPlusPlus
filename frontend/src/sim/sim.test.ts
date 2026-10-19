import { describe, expect, it } from "vitest";
import { DiffPump, type StampedChange } from "./diffPump";
import { WaveformRecorder } from "./waveform";
import { SimStore } from "./simStore";
import type { NetId, WireValue } from "../ipc/types";

const val = (v: string): WireValue => ({ v, x: "0", z: "0" });
const stamped = (v: string, at?: number): StampedChange => ({ val: val(v), at });

/** Synchronous scheduler: flushes run immediately on push. */
const sync = (cb: () => void): void => cb();

describe("DiffPump (§7.2: ≤1 batch per frame, drop intermediates)", () => {
  it("merges a burst of batches into ONE flush, latest value per net wins", () => {
    const flushes: [ReadonlyMap<NetId, StampedChange>, number, boolean][] = [];
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      (changes, cycle, full) => flushes.push([changes, cycle, full]),
      (cb) => queue.push(cb),
    );
    pump.push({ cycle: 1, full: false, changes: [{ net: 0, val: val("1"), at: 10 }] });
    pump.push({
      cycle: 2,
      full: false,
      changes: [
        { net: 0, val: val("0"), at: 20 },
        { net: 1, val: val("f"), at: 25 },
      ],
    });
    pump.push({ cycle: 3, full: false, changes: [{ net: 0, val: val("1"), at: 30 }] });
    expect(flushes).toHaveLength(0); // nothing until the frame boundary
    expect(queue).toHaveLength(1); // one scheduled flush, not three
    queue.forEach((cb) => cb());
    expect(flushes).toHaveLength(1);
    const [changes, cycle, full] = flushes[0];
    expect(changes.get(0)).toEqual(stamped("1", 30)); // latest, not a backlog of 3
    expect(changes.get(1)).toEqual(stamped("f", 25));
    expect(cycle).toBe(3); // newest batch's cycle
    expect(full).toBe(false);
  });

  it("carries each change's `at` timestamp through the merge (v1.1)", () => {
    const flushes: ReadonlyMap<NetId, StampedChange>[] = [];
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      (changes) => flushes.push(changes),
      (cb) => queue.push(cb),
    );
    pump.push({ cycle: 1, full: false, changes: [{ net: 5, val: val("a"), at: 142.5 }] });
    pump.push({ cycle: 1, full: false, changes: [{ net: 6, val: val("b") }] });
    queue.forEach((cb) => cb());
    expect(flushes).toHaveLength(1);
    expect(flushes[0].get(5)).toEqual(stamped("a", 142.5));
    expect(flushes[0].get(6)).toEqual(stamped("b", undefined));
  });

  it("a full batch flags the whole merged frame (v1.1 initial paint)", () => {
    const flushes: boolean[] = [];
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      (_c, _cycle, full) => flushes.push(full),
      (cb) => queue.push(cb),
    );
    pump.push({ cycle: 0, full: true, changes: [{ net: 0, val: val("0") }] });
    pump.push({ cycle: 0, full: false, changes: [{ net: 1, val: val("1") }] });
    queue.forEach((cb) => cb());
    expect(flushes).toEqual([true]); // one frame, marked full
  });

  it("flushes once per frame boundary under a synchronous scheduler", () => {
    const flushes: number[] = [];
    const pump = new DiffPump((_c, cycle) => flushes.push(cycle), sync);
    pump.push({ cycle: 1, full: false, changes: [{ net: 0, val: val("1") }] });
    pump.push({ cycle: 2, full: false, changes: [{ net: 0, val: val("0") }] });
    expect(flushes).toEqual([1, 2]);
  });

  it("clear() drops unflushed state", () => {
    const flushes: unknown[] = [];
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      () => flushes.push(1),
      (cb) => queue.push(cb),
    );
    pump.push({ cycle: 1, full: false, changes: [{ net: 0, val: val("1") }] });
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
    store.applyDiffs(new Map([[7, stamped("ff", 42)]]), 5);
    expect(store.cycle).toBe(5);
    expect(store.netValues.get(7)).toEqual(val("ff"));
    expect(store.lastChanged).toEqual([{ net: 7, at: 42 }]);
    expect(store.getVersion()).toBeGreaterThan(v0);
    expect(seen).toBe(2);
  });

  it("a full (initial-paint) frame updates values but spawns no pulses", () => {
    const store = new SimStore();
    store.onLoaded(new Map([[0, 7]]), []);
    store.applyDiffs(new Map([[7, stamped("00", 0)]]), 0, /* full */ true);
    expect(store.netValues.get(7)).toEqual(val("00"));
    expect(store.lastChanged).toEqual([]); // nothing "changed" — no U7 pulses
  });

  it("onLoadFailed surfaces errors and clears the loaded state", () => {
    const store = new SimStore();
    store.onLoaded(new Map([[0, 7]]), [
      { name: "pc", kind: "register", comp_id: 1, circuit: "main" },
    ]);
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
    store.onStatus({ running: true, cycle: 10, eff_hz: 1000 });
    store.onHalted({ cycle: 10, reason: "oscillation", details: "comp 2" });
    store.reset();
    expect(store.loaded).toBe(false);
    expect(store.status).toBeNull();
    expect(store.halted).toBeNull();
    expect(store.netValues.size).toBe(0);
  });

  it("tracks shorted nets from the diffs (contract v1.2)", () => {
    const store = new SimStore();
    store.onLoaded(new Map([[0, 7]]), []);

    // The engine flags `contended` only when a net's X is a genuine short —
    // an X that merely flowed in stays unflagged, so the warning cannot misfire.
    store.applyDiffs(new Map([[7, { ...stamped("0", 10), contended: true }]]), 3);
    expect([...store.contendedNets]).toEqual([7]);

    // A later batch without the flag means the fight is over.
    store.applyDiffs(new Map([[7, stamped("1", 20)]]), 4);
    expect(store.contendedNets.size).toBe(0);

    // A run-state reset clears it too.
    store.applyDiffs(new Map([[7, { ...stamped("0", 30), contended: true }]]), 5);
    store.resetRunState();
    expect(store.contendedNets.size).toBe(0);
  });
});

describe("DiffPump raw tap (waveform recording, UI_OVERHAUL §89)", () => {
  it("sees every batch, so a trace keeps cycles the merge would drop", () => {
    const flushes: [ReadonlyMap<NetId, StampedChange>, number][] = [];
    const recorder = new WaveformRecorder();
    const queue: (() => void)[] = [];
    const pump = new DiffPump(
      (changes, cycle) => flushes.push([changes, cycle]),
      (cb) => queue.push(cb),
      (diffs) => recorder.recordBatch(diffs),
    );

    // Three cycles inside one frame — exactly the case a trace cannot afford to
    // lose, and exactly what the merged flush does lose.
    pump.push({ cycle: 1, full: false, changes: [{ net: 0, val: val("1") }] });
    pump.push({ cycle: 2, full: false, changes: [{ net: 0, val: val("2") }] });
    pump.push({ cycle: 3, full: false, changes: [{ net: 0, val: val("3") }] });
    queue.forEach((cb) => cb());

    // The paint path: one flush, latest value only.
    expect(flushes).toHaveLength(1);
    expect(flushes[0][0].get(0)?.val.v).toBe("3");
    expect(flushes[0][1]).toBe(3);

    // The trace: every cycle.
    expect(recorder.samples(0).map((s) => [s.cycle, s.val.v])).toEqual([
      [1, "1"],
      [2, "2"],
      [3, "3"],
    ]);
  });

  it("is optional: a pump with no tap behaves exactly as before", () => {
    const flushes: number[] = [];
    const pump = new DiffPump((_c, cycle) => flushes.push(cycle), sync);
    pump.push({ cycle: 4, full: false, changes: [{ net: 0, val: val("1") }] });
    expect(flushes).toEqual([4]);
  });
});
