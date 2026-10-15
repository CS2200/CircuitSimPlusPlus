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
/** Autosave: crash-recovery copy + (named docs) periodic file write. */
export const PREF_AUTOSAVE = "csx.autosave";
/** Autosave also rewrites the real `.csx` (named documents only). */
export const PREF_AUTOSAVE_FILE = "csx.autosave.file";
/** Live value readouts on parts (UI_OVERHAUL §25) — on by default. */
export const PREF_SHOW_VALUES = "csx.showValues";
/** Frame-rate overlay in the canvas corner —
 *  off by default. */
export const PREF_SHOW_PERF = "csx.showPerf";
/** Bit width seeded on newly placed parts. */
export const PREF_DEFAULT_BITS = "csx.defaultBits";
/** Gate input count seeded on newly placed gates. */
export const PREF_DEFAULT_INPUTS = "csx.defaultInputs";
/** Where the transport speed slider starts (exponent: hz = 10^(exp/10)). */
export const PREF_DEFAULT_HZ = "csx.defaultHz";
/** Where a part's name label sits relative to its body (N/S/W/E). */
export const PREF_LABEL_POS = "csx.labelPos";

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

/** Integer preference; missing/corrupt/unreadable → the fallback. */
export function loadNumPref(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isInteger(n) ? n : fallback;
  } catch {
    return fallback;
  }
}

export function saveNumPref(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* preference is best-effort */
  }
}

/** String preference (enum-ish values); anything unreadable → the fallback. */
export function loadStrPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function saveStrPref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* preference is best-effort */
  }
}
