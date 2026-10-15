/**
 * Theme catalog + preference persistence (frontend/UI_OVERHAUL.md §2).
 *
 * Themes are data: each id maps to a CSS custom-property block in
 * styles.css (`[data-theme="<id>"]`), and the canvas reads the variables
 * back through `resolveTheme`. Adding a theme = one CSS block + one
 * catalog entry (DESIGN.md §7.1 / D8: accessibility palettes are
 * drop-ins, not refactors).
 *
 * The choice is a per-user, per-machine preference (localStorage) — never
 * written into the `.csx` document.
 */

export type ThemeId = "oled" | "dark" | "light";

export interface ThemeMeta {
  readonly id: ThemeId;
  readonly name: string;
  /** One-line description on the Settings card. */
  readonly blurb: string;
  /** Preview chips (bg, panel, accent, high wire) — display only. */
  readonly swatches: readonly [string, string, string, string];
}

/** Picker order; `DEFAULT_THEME` must be present. */
export const THEMES: readonly ThemeMeta[] = [
  {
    id: "oled",
    name: "OLED",
    blurb: "True black — designed for OLED panels",
    swatches: ["#000000", "#0a0a0e", "#7aa2ff", "#2ee87a"],
  },
  {
    id: "dark",
    name: "Dark",
    blurb: "The classic deep-gray workspace",
    swatches: ["#16161f", "#22222e", "#5b8def", "#40dc82"],
  },
  {
    id: "light",
    name: "Light",
    blurb: "Bright, high-contrast workspace",
    swatches: ["#f4f4f8", "#ffffff", "#3b6fd4", "#1faa53"],
  },
];

export const DEFAULT_THEME: ThemeId = "oled";

const STORAGE_KEY = "csx.theme";

export function isThemeId(value: unknown): value is ThemeId {
  return value === "oled" || value === "dark" || value === "light";
}

/** Read the persisted theme; missing/unknown/unreadable → the default. */
export function loadThemePref(): ThemeId {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isThemeId(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME; // no localStorage (headless/test) — stay silent
  }
}

/** Persist the theme; storage failures (private mode, quota) are non-fatal. */
export function saveThemePref(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    /* preference is best-effort */
  }
}
