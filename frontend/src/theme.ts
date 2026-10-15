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

export type ThemeId = "oled" | "dark" | "midnight" | "contrast" | "light" | "paper";

export interface ThemeMeta {
  readonly id: ThemeId;
  readonly name: string;
  /** One-line description on the Settings card. */
  readonly blurb: string;
  /** Preview chips (bg, panel, accent, high wire) — display only. */
  readonly swatches: readonly [string, string, string, string];
  /** Light themes pair with the moon→sun toggle; dark ones with sun→moon. */
  readonly light?: boolean;
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
    id: "midnight",
    name: "Midnight",
    blurb: "Deep navy with a soft blue glow",
    swatches: ["#0a0f1e", "#131b2e", "#6d9eff", "#34d399"],
  },
  {
    id: "contrast",
    name: "High contrast",
    blurb: "Stark black & yellow — maximum separation",
    swatches: ["#000000", "#0c0c0c", "#ffd400", "#5aa7ff"],
  },
  {
    id: "light",
    name: "Light",
    blurb: "Bright, high-contrast workspace",
    swatches: ["#f4f4f8", "#ffffff", "#3b6fd4", "#1faa53"],
    light: true,
  },
  {
    id: "paper",
    name: "Paper",
    blurb: "Warm, low-glare light theme",
    swatches: ["#f7f4ec", "#fffdf8", "#b25a2a", "#2f9e44"],
    light: true,
  },
];

export const DEFAULT_THEME: ThemeId = "oled";

/** True for themes that pair with the light side of the light/dark toggle. */
export function isLightTheme(id: ThemeId): boolean {
  return THEMES.find((t) => t.id === id)?.light === true;
}

// ---- accent color (Settings → Accent color) ----

/**
 * Accent overrides: independent of the theme, stored as a `data-accent`
 * attribute (CSS blocks in styles.css). "auto" keeps the theme's own
 * accent. Applies to focus rings, selection, buttons and the on-canvas
 * selection highlight alike (everything reads `--accent`).
 */
export type AccentId = "auto" | "blue" | "violet" | "teal" | "green" | "amber" | "rose";

export interface AccentMeta {
  readonly id: AccentId;
  readonly name: string;
  /** Swatch color; null = the theme's own accent ("auto"). */
  readonly hex: string | null;
}

export const ACCENTS: readonly AccentMeta[] = [
  { id: "auto", name: "Theme default", hex: null },
  { id: "blue", name: "Blue", hex: "#5b8def" },
  { id: "violet", name: "Violet", hex: "#8b5cf6" },
  { id: "teal", name: "Teal", hex: "#14b8a6" },
  { id: "green", name: "Green", hex: "#22c55e" },
  { id: "amber", name: "Amber", hex: "#f59e0b" },
  { id: "rose", name: "Rose", hex: "#f43f5e" },
];

export const DEFAULT_ACCENT: AccentId = "auto";

const ACCENT_KEY = "csx.accent";

export function isAccentId(value: unknown): value is AccentId {
  return ACCENTS.some((a) => a.id === value);
}

/** Read the persisted accent; missing/unknown/unreadable → the default. */
export function loadAccentPref(): AccentId {
  try {
    const stored = localStorage.getItem(ACCENT_KEY);
    return isAccentId(stored) ? stored : DEFAULT_ACCENT;
  } catch {
    return DEFAULT_ACCENT; // no localStorage (headless/test) — stay silent
  }
}

/** Persist the accent; storage failures are non-fatal. */
export function saveAccentPref(id: AccentId): void {
  try {
    localStorage.setItem(ACCENT_KEY, id);
  } catch {
    /* preference is best-effort */
  }
}

const STORAGE_KEY = "csx.theme";

export function isThemeId(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
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
