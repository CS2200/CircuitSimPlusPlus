import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadBoolPref, PREF_PULSES, PREF_UPDATE_CHECK, saveBoolPref } from "./prefs";

/**
 * Settings-pass preferences: boolean toggles persisted per machine. The
 * vitest environment is node — stand up a minimal localStorage to exercise
 * the read/write/fallback paths (the real module guards its absence).
 */

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  clear(): void {
    this.map.clear();
  }
}

const g = globalThis as unknown as { localStorage?: FakeStorage };
const hadStorage = "localStorage" in globalThis;

beforeEach(() => {
  g.localStorage = new FakeStorage();
});

afterEach(() => {
  if (!hadStorage) delete g.localStorage;
});

describe("boolean preferences", () => {
  it("defaults to the fallback when nothing is stored", () => {
    expect(loadBoolPref(PREF_PULSES, true)).toBe(true);
    expect(loadBoolPref(PREF_UPDATE_CHECK, true)).toBe(true);
    expect(loadBoolPref("csx.missing", false)).toBe(false);
  });

  it("round-trips both values", () => {
    saveBoolPref(PREF_PULSES, false);
    expect(loadBoolPref(PREF_PULSES, true)).toBe(false);
    saveBoolPref(PREF_PULSES, true);
    expect(loadBoolPref(PREF_PULSES, false)).toBe(true);
  });

  it("falls back on unreadable values", () => {
    g.localStorage!.setItem(PREF_UPDATE_CHECK, "yes");
    expect(loadBoolPref(PREF_UPDATE_CHECK, true)).toBe(true);
    expect(loadBoolPref(PREF_UPDATE_CHECK, false)).toBe(false);
  });

  it("stays silent when storage throws or is absent", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as FakeStorage;
    expect(loadBoolPref(PREF_PULSES, true)).toBe(true);
    expect(() => saveBoolPref(PREF_PULSES, false)).not.toThrow();

    delete g.localStorage;
    expect(loadBoolPref(PREF_PULSES, false)).toBe(false);
    expect(() => saveBoolPref(PREF_PULSES, true)).not.toThrow();
  });
});
