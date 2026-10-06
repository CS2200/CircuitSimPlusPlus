import type { WireState } from "./renderer";

/**
 * Theme resolved from CSS custom properties (DESIGN.md §7.1 / D8: palettes
 * are data, not code — a colorblind-accessibility pass is a theme drop-in).
 * `resolveTheme` reads the variables from an element's computed style;
 * fallbacks mirror the dark theme so tests and headless runs still work.
 */
export interface Theme {
  readonly bg: string;
  readonly grid: string;
  readonly panel: string;
  readonly panelBorder: string;
  readonly text: string;
  readonly textDim: string;
  readonly accent: string;
  /** Per-state wire colors. */
  readonly wire: Readonly<Record<WireState, string>>;
  /** Per-bus rainbow hues (multi-bit wires), indexed by bus id. */
  readonly bus: readonly string[];
}

export const FALLBACK_THEME: Theme = {
  bg: "#16161f",
  grid: "#23232f",
  panel: "#22222e",
  panelBorder: "#34344a",
  text: "#e6e6f0",
  textDim: "#9a9ab0",
  accent: "#5b8def",
  wire: {
    low: "#3a6ea5",
    high: "#40dc82",
    x: "#e5534b",
    z: "#8a8a8a",
    disconnected: "#2c2c3a",
  },
  bus: ["#f0b43c", "#b478e6", "#4dd0e1", "#f368a0", "#b8e34d"],
};

export function resolveTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string => {
    const value = cs.getPropertyValue(name).trim();
    return value === "" ? fallback : value;
  };
  return {
    bg: v("--bg", FALLBACK_THEME.bg),
    grid: v("--grid", FALLBACK_THEME.grid),
    panel: v("--panel", FALLBACK_THEME.panel),
    panelBorder: v("--panel-border", FALLBACK_THEME.panelBorder),
    text: v("--text", FALLBACK_THEME.text),
    textDim: v("--text-dim", FALLBACK_THEME.textDim),
    accent: v("--accent", FALLBACK_THEME.accent),
    wire: {
      low: v("--wire-low", FALLBACK_THEME.wire.low),
      high: v("--wire-high", FALLBACK_THEME.wire.high),
      x: v("--wire-x", FALLBACK_THEME.wire.x),
      z: v("--wire-z", FALLBACK_THEME.wire.z),
      disconnected: v("--wire-disconnected", FALLBACK_THEME.wire.disconnected),
    },
    bus: [
      v("--bus-a", FALLBACK_THEME.bus[0]),
      v("--bus-b", FALLBACK_THEME.bus[1]),
      v("--bus-c", FALLBACK_THEME.bus[2]),
      v("--bus-d", FALLBACK_THEME.bus[3]),
      v("--bus-e", FALLBACK_THEME.bus[4]),
    ],
  };
}
