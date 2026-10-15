import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEMES,
  isThemeId,
  loadThemePref,
  saveThemePref,
  type ThemeId,
} from "./theme";

/**
 * UI overhaul §2: theme catalog + preference persistence. The vitest
 * environment is node — stand up a minimal localStorage to exercise the
 * read/write/fallback paths (the real module guards against its absence).
 */

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
  }
  removeItem(key: string): void {
    this.map.delete(key);
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

describe("theme catalog", () => {
  it("has unique ids and includes the default", () => {
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_THEME);
  });

  it("isThemeId accepts exactly the catalog ids", () => {
    for (const t of THEMES) expect(isThemeId(t.id)).toBe(true);
    for (const bad of ["", "solarized", 42, null, undefined, {}]) {
      expect(isThemeId(bad)).toBe(false);
    }
  });
});

describe("theme preference", () => {
  it("defaults to OLED when nothing is stored", () => {
    expect(loadThemePref()).toBe("oled");
    expect(DEFAULT_THEME).toBe("oled");
  });

  it("round-trips a stored choice", () => {
    saveThemePref("light");
    expect(loadThemePref()).toBe("light");
    saveThemePref("dark");
    expect(loadThemePref()).toBe("dark");
  });

  it("falls back to the default on unknown or corrupt values", () => {
    g.localStorage!.setItem("csx.theme", "tomato");
    expect(loadThemePref()).toBe("oled");
    g.localStorage!.setItem("csx.theme", " ");
    expect(loadThemePref()).toBe("oled");
  });

  it("stays silent when storage throws (private mode)", () => {
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as FakeStorage;
    expect(loadThemePref()).toBe("oled");
    expect(() => saveThemePref("dark" as ThemeId)).not.toThrow();
  });

  it("stays silent when localStorage is absent", () => {
    delete g.localStorage;
    expect(loadThemePref()).toBe("oled");
    expect(() => saveThemePref("dark")).not.toThrow();
  });
});
