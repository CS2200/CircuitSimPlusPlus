import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PANEL_WIDTHS,
  PANEL_LIMITS,
  clampPanelWidth,
  loadPanelWidth,
  savePanelWidth,
  type PanelId,
} from "./panels";

/**
 * UI overhaul §7: panel-width preferences. The vitest environment is node —
 * stand up a minimal localStorage (the module guards against its absence).
 */

class FakeStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, String(value));
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

describe("clampPanelWidth", () => {
  it("clamps into the panel's bounds and rounds", () => {
    expect(clampPanelWidth("palette", 100)).toBe(PANEL_LIMITS.palette.min);
    expect(clampPanelWidth("palette", 9999)).toBe(PANEL_LIMITS.palette.max);
    expect(clampPanelWidth("palette", 200.6)).toBe(201);
    expect(clampPanelWidth("dock", 300)).toBe(300);
  });

  it("falls back to the default for non-finite values", () => {
    expect(clampPanelWidth("palette", Number.NaN)).toBe(DEFAULT_PANEL_WIDTHS.palette);
    expect(clampPanelWidth("dock", Number.POSITIVE_INFINITY)).toBe(DEFAULT_PANEL_WIDTHS.dock);
  });
});

describe("panel width preference", () => {
  it("defaults per panel when nothing is stored", () => {
    expect(loadPanelWidth("palette")).toBe(DEFAULT_PANEL_WIDTHS.palette);
    expect(loadPanelWidth("dock")).toBe(DEFAULT_PANEL_WIDTHS.dock);
  });

  it("round-trips stored widths (clamped on write)", () => {
    savePanelWidth("palette", 240);
    expect(loadPanelWidth("palette")).toBe(240);
    savePanelWidth("dock", 9999); // clamps to max
    expect(loadPanelWidth("dock")).toBe(PANEL_LIMITS.dock.max);
  });

  it("clamps out-of-range stored values on read", () => {
    g.localStorage!.setItem("csx.panel.palette", "50");
    expect(loadPanelWidth("palette")).toBe(PANEL_LIMITS.palette.min);
  });

  it("falls back on corrupt values or storage errors", () => {
    g.localStorage!.setItem("csx.panel.dock", "wide");
    expect(loadPanelWidth("dock")).toBe(DEFAULT_PANEL_WIDTHS.dock);
    g.localStorage = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as FakeStorage;
    expect(loadPanelWidth("palette")).toBe(DEFAULT_PANEL_WIDTHS.palette);
    expect(() => savePanelWidth("dock" as PanelId, 300)).not.toThrow();
  });

  it("stays silent when localStorage is absent", () => {
    delete g.localStorage;
    expect(loadPanelWidth("dock")).toBe(DEFAULT_PANEL_WIDTHS.dock);
    expect(() => savePanelWidth("palette", 200)).not.toThrow();
  });
});
