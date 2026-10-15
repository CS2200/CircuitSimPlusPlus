import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryHistoryStore,
  historyStore,
  setHistoryStore,
  type HistoryTarget,
} from "./versionStore";

const T: HistoryTarget = { path: "/home/me/alu.csx", docKey: "session-1" };

function doc(name: string): unknown {
  return { format: "circuitsim-plus-plus", version: 3, name, settings: {}, circuits: [] };
}

afterEach(() => setHistoryStore(null));

describe("MemoryHistoryStore (browser/dev backend)", () => {
  it("writes, lists (newest first), and reads versions", async () => {
    const store = new MemoryHistoryStore();
    const a = await store.snapshot(T, doc("a"), "Placed gate.and", 100, 0);
    const b = await store.snapshot(T, doc("b"), "Wired net", 200, 0);
    expect(a.deduped).toBe(false);
    expect(b.coalesced).toBe(false);

    const listed = await store.list(T);
    expect(listed).toHaveLength(2);
    expect(listed[0].id).toBe(b.id); // newest first
    expect(listed[0].label).toBe("Wired net");
    expect(listed[1].id).toBe(a.id);

    expect(JSON.parse((await store.read(T, a.id))!)).toEqual(doc("a"));
    expect(await store.read(T, "nope")).toBeNull();
  });

  it("dedupes identical content and adds nothing", async () => {
    const store = new MemoryHistoryStore();
    const first = await store.snapshot(T, doc("same"), "Saved", 100, 0);
    const again = await store.snapshot(T, doc("same"), "Saved", 200, 0);
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.id);
    expect(await store.list(T)).toHaveLength(1);
  });

  it("coalesces a recent automatic version, then starts a new one", async () => {
    const store = new MemoryHistoryStore();
    const first = await store.snapshot(T, doc("v1"), "Edit", 1_000, 60_000);
    const second = await store.snapshot(T, doc("v2"), "Edit", 30_000, 60_000);
    expect(second.coalesced).toBe(true);
    expect(second.id).toBe(first.id);
    expect(await store.list(T)).toHaveLength(1);
    expect(JSON.parse((await store.read(T, first.id))!)).toEqual(doc("v2")); // latest state

    const third = await store.snapshot(T, doc("v3"), "Edit", 200_000, 60_000);
    expect(third.coalesced).toBe(false);
    expect(await store.list(T)).toHaveLength(2);
  });

  it("keeps named versions when automatic ones are pruned", async () => {
    const store = new MemoryHistoryStore();
    const milestone = await store.snapshot(T, doc("keep"), "Milestone", 0, 0);
    expect(await store.name(T, milestone.id, "Before refactor")).toBe(true);

    // Flood past the automatic-version cap (all these edits are "recent", so
    // the age tiers keep every one of them until the hard cap bites).
    for (let i = 0; i < 250; i++) {
      await store.snapshot(T, doc(`auto${i}`), "Edit", 10_000 + i, 0);
    }
    const listed = await store.list(T);
    const named = listed.filter((v) => v.named);
    expect(named).toHaveLength(1);
    expect(named[0].label).toBe("Before refactor");
    expect(listed.length).toBeLessThanOrEqual(201);
  });

  it("removes one version and clears a whole history", async () => {
    const store = new MemoryHistoryStore();
    const a = await store.snapshot(T, doc("a"), "a", 1, 0);
    await store.snapshot(T, doc("b"), "b", 2, 0);

    expect(await store.remove(T, a.id)).toBe(true);
    expect(await store.remove(T, a.id)).toBe(false);
    expect(await store.list(T)).toHaveLength(1);

    expect(await store.clear(T)).toBe(true);
    expect(await store.list(T)).toEqual([]);
    expect(await store.clear(T)).toBe(false);
  });

  it("keys history by path, or by session id before the first save", async () => {
    const store = new MemoryHistoryStore();
    await store.snapshot(T, doc("named"), "a", 1, 0);
    await store.snapshot({ path: null, docKey: "abc" }, doc("unnamed"), "b", 1, 0);
    expect(await store.list(T)).toHaveLength(1);
    expect(await store.list({ path: null, docKey: "abc" })).toHaveLength(1);
    expect(await store.list({ path: null, docKey: "other" })).toEqual([]);
    // Windows path case is not significant for the key.
    expect(
      await store.snapshot({ path: "/HOME/ME/ALU.CSX", docKey: "x" }, doc("c"), "c", 2, 0),
    ).toBeTruthy();
    expect(await store.list(T)).toHaveLength(2);
  });

  it("reports usage across documents", async () => {
    const store = new MemoryHistoryStore();
    expect(await store.usage()).toEqual({ bytes: 0, documents: 0 });
    await store.snapshot(T, doc("a"), "a", 1, 0);
    await store.snapshot({ path: "/b.csx", docKey: "b" }, doc("b"), "b", 1, 0);
    const usage = await store.usage();
    expect(usage.documents).toBe(2);
    expect(usage.bytes).toBeGreaterThan(0);
  });
});

describe("historyStore()", () => {
  it("uses the in-memory backend outside Tauri (node/browser tests)", () => {
    expect(historyStore()).toBeInstanceOf(MemoryHistoryStore);
  });

  it("returns the injected store once set", () => {
    const fake = new MemoryHistoryStore();
    setHistoryStore(fake);
    expect(historyStore()).toBe(fake);
  });
});
