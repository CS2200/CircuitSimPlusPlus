import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryRecoveryStore,
  newDocKey,
  recoveryStore,
  setRecoveryStore,
  type RecoveryWrite,
} from "./recovery";

const DOC = { format: "circuitsim-plus-plus", version: 3, name: "t" };

function entry(over: Partial<RecoveryWrite> = {}): RecoveryWrite {
  return {
    path: null,
    docKey: "session-1",
    name: "untitled",
    label: "Placed gate.and",
    at: 100,
    document: DOC,
    ...over,
  };
}

afterEach(() => setRecoveryStore(null));

describe("MemoryRecoveryStore (browser/dev backend)", () => {
  it("writes, lists, reads, and discards", async () => {
    const store = new MemoryRecoveryStore();
    const key = await store.write(entry({ path: "/home/me/alu.csx", name: "alu", at: 5 }));
    expect(key).toBe("f/home/me/alu.csx");

    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ key, path: "/home/me/alu.csx", name: "alu", at_ms: 5 });

    const text = await store.read(key);
    expect(text).toBe(JSON.stringify(DOC));

    expect(await store.discard(key)).toBe(true);
    expect(await store.read(key)).toBeNull();
    expect(await store.discard(key)).toBe(false);
  });

  it("keys a pathless document by its per-session id", async () => {
    const store = new MemoryRecoveryStore();
    const key = await store.write(entry({ docKey: "abc123" }));
    expect(key).toBe("nabc123");
    // A later write for the same session replaces (one rolling copy).
    await store.write(entry({ docKey: "abc123", at: 200, name: "renamed" }));
    const listed = await store.list();
    expect(listed).toHaveLength(1);
    expect(listed[0].name).toBe("renamed");
  });

  it("lists newest first", async () => {
    const store = new MemoryRecoveryStore();
    await store.write(entry({ path: "/a.csx", at: 10 }));
    await store.write(entry({ path: "/b.csx", at: 30 }));
    await store.write(entry({ path: "/c.csx", at: 20 }));
    expect((await store.list()).map((m) => m.at_ms)).toEqual([30, 20, 10]);
  });
});

describe("recoveryStore()", () => {
  it("uses the in-memory backend outside Tauri (node/browser tests)", () => {
    expect(recoveryStore()).toBeInstanceOf(MemoryRecoveryStore);
  });

  it("returns the injected store once set", async () => {
    const fake = new MemoryRecoveryStore();
    setRecoveryStore(fake);
    expect(recoveryStore()).toBe(fake);
  });
});

describe("newDocKey", () => {
  it("produces distinct non-empty ids", () => {
    const a = newDocKey();
    const b = newDocKey();
    expect(a).not.toBe("");
    expect(a).not.toBe(b);
  });
});
