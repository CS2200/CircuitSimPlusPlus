/**
 * Boolean interface preferences (per-user, per-machine localStorage) that
 * are not theme data: signal-pulse animation on the canvas and the startup
 * update check (DESIGN.md §9). Missing/corrupt/unreadable storage falls
 * back to the default; writes are best-effort (private mode, quota).
 */

export const PREF_PULSES = "csx.pulses";
export const PREF_UPDATE_CHECK = "csx.updateCheck";
/** Canvas grid overlay (UI_OVERHAUL §15) — off by default. */
export const PREF_GRID = "csx.grid";

export function loadBoolPref(key: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === "1") return true;
    if (v === "0") return false;
    return fallback; // missing or unreadable value — stay silent
  } catch {
    return fallback; // no localStorage (headless/test)
  }
}

export function saveBoolPref(key: string, value: boolean): void {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {
    /* preference is best-effort */
  }
}
