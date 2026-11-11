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
  /** Setup/hold violation markers (U7) — distinct from halt red and accent. */
  readonly violation: string;
}

/**
 * Canonicalize a CSS color to `#rrggbb` so the contrast/mix math (which parses
 * hex — `mixHex`/`luminance` in `editor/docScene.ts`) is robust no matter how
 * the engine serializes a custom property. Some webviews return `rgb(r, g, b)`
 * (or a wide-gamut `color(...)`) from `getComputedStyle` for a custom property
 * instead of the authored hex; before, `mixHex` silently fell back to its
 * `base` argument, which for a wire is the BACKGROUND color — so the wire was
 * drawn in (or near) the canvas colour and vanished against it. Anything that
 * cannot be parsed falls back to a theme colour rather than to transparent.
 */
export function normalizeColor(value: string, fallback: string): string {
  const text = value.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex !== null) {
    const h = hex[1].toLowerCase();
    return h.length === 3 ? `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}` : `#${h}`;
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)/i.exec(
    text,
  );
  if (rgb !== null) {
    // A fully transparent value is not a usable palette colour.
    if (rgb[4] !== undefined) {
      const alpha = rgb[4].endsWith("%") ? Number(rgb[4].slice(0, -1)) / 100 : Number(rgb[4]);
      if (!(alpha > 0)) return fallback;
    }
    const byte = (s: string): string =>
      Math.max(0, Math.min(255, Math.round(Number(s))))
        .toString(16)
        .padStart(2, "0");
    return `#${byte(rgb[1])}${byte(rgb[2])}${byte(rgb[3])}`;
  }
  return fallback;
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
    low: "#5a85b3",
    high: "#40dc82",
    x: "#e5534b",
    z: "#8a8a8a",
    // Neutral for junction dots and other off/undriven marks. Idle WIRES no
    // longer use it — they show a dull tint of their identity colour (§35).
    disconnected: "#808092",
  },
  bus: ["#f0b43c", "#b478e6", "#4dd0e1", "#f368a0", "#b8e34d"],
  violation: "#ff9e3d",
};

export function resolveTheme(el: Element): Theme {
  const cs = getComputedStyle(el);
  const v = (name: string, fallback: string): string =>
    normalizeColor(cs.getPropertyValue(name), fallback);
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
    violation: v("--violation", FALLBACK_THEME.violation),
  };
}
