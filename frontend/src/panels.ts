/**
 * Side-panel widths (frontend/UI_OVERHAUL.md §7): the component palette and
 * the right dock are user-resizable, and the widths are remembered per
 * machine — same pattern as the theme preference (localStorage, best-effort,
 * clamped to sane bounds).
 */

export type PanelId = "palette" | "dock";

export interface PanelLimits {
  readonly min: number;
  readonly max: number;
}

/** Clamp bounds in CSS pixels (DIPs). */
export const PANEL_LIMITS: Readonly<Record<PanelId, PanelLimits>> = {
  palette: { min: 150, max: 320 },
  dock: { min: 220, max: 420 },
};

/** Defaults match the pre-resize layout (190px palette, 16rem dock). */
export const DEFAULT_PANEL_WIDTHS: Readonly<Record<PanelId, number>> = {
  palette: 190,
  dock: 256,
};

const STORAGE_KEYS: Readonly<Record<PanelId, string>> = {
  palette: "csx.panel.palette",
  dock: "csx.panel.dock",
};

/** Clamp a width into the panel's bounds; NaN/Infinity → the default. */
export function clampPanelWidth(id: PanelId, width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_PANEL_WIDTHS[id];
  const { min, max } = PANEL_LIMITS[id];
  return Math.round(Math.min(max, Math.max(min, width)));
}

/** Read the persisted width; missing/unknown/unreadable → the default. */
export function loadPanelWidth(id: PanelId): number {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS[id]);
    if (raw === null) return DEFAULT_PANEL_WIDTHS[id];
    const width = Number(raw);
    return Number.isFinite(width) ? clampPanelWidth(id, width) : DEFAULT_PANEL_WIDTHS[id];
  } catch {
    return DEFAULT_PANEL_WIDTHS[id]; // no localStorage (headless/test) — stay silent
  }
}

/** Persist a width; storage failures (private mode, quota) are non-fatal. */
export function savePanelWidth(id: PanelId, width: number): void {
  try {
    localStorage.setItem(STORAGE_KEYS[id], String(clampPanelWidth(id, width)));
  } catch {
    /* preference is best-effort */
  }
}
