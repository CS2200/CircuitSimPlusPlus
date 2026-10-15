import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ACCENTS,
  DEFAULT_ACCENT,
  DEFAULT_THEME,
  THEMES,
  isAccentId,
  isLightTheme,
  isThemeId,
  loadAccentPref,
  loadThemePref,
  saveAccentPref,
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

describe("light/dark classification", () => {
  it("marks exactly the light-side themes", () => {
    expect(isLightTheme("light")).toBe(true);
    expect(isLightTheme("paper")).toBe(true);
    expect(isLightTheme("oled")).toBe(false);
    expect(isLightTheme("dark")).toBe(false);
    expect(isLightTheme("midnight")).toBe(false);
    expect(isLightTheme("contrast")).toBe(false);
  });

  it("catalog carries at least one theme per side", () => {
    expect(THEMES.some((t) => t.light === true)).toBe(true);
    expect(THEMES.some((t) => t.light !== true)).toBe(true);
  });
});

describe("accent catalog", () => {
  it("has unique ids and includes the default (auto)", () => {
    const ids = ACCENTS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_ACCENT);
    expect(DEFAULT_ACCENT).toBe("auto");
  });

  it("isAccentId accepts exactly the catalog ids", () => {
    for (const a of ACCENTS) expect(isAccentId(a.id)).toBe(true);
    for (const bad of ["", "purple", 7, null, undefined, {}]) {
      expect(isAccentId(bad)).toBe(false);
    }
  });
});

describe("accent preference", () => {
  it("defaults to auto when nothing is stored", () => {
    expect(loadAccentPref()).toBe("auto");
  });

  it("round-trips a stored choice", () => {
    saveAccentPref("violet");
    expect(loadAccentPref()).toBe("violet");
  });

  it("falls back on unknown values and stays silent on storage errors", () => {
    g.localStorage!.setItem("csx.accent", "chartreuse");
    expect(loadAccentPref()).toBe("auto");
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as FakeStorage;
    expect(loadAccentPref()).toBe("auto");
    expect(() => saveAccentPref("rose")).not.toThrow();
  });
});
