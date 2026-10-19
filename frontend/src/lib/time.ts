/**
 * Small time formatters for the autosave surfaces (status bar, recovery,
 * version history). Recent entries matter; exact instants don't.
 */

import { loadBoolPref, PREF_TIME_24H } from "../prefs";

/** The clock preference (Settings → Appearance): 24-hour unless turned off. */
function timeFormat24h(): boolean {
  return loadBoolPref(PREF_TIME_24H, true);
}

/**
 * Local clock time: `HH:MM` by default, or `h:MM AM/PM` when `h24` is false
 * (Settings → Appearance).
 */
export function clockTime(at: number, h24 = timeFormat24h()): string {
  const d = new Date(at);
  const mm = String(d.getMinutes()).padStart(2, "0");
  if (h24) return `${String(d.getHours()).padStart(2, "0")}:${mm}`;
  const hours = d.getHours();
  return `${hours % 12 === 0 ? 12 : hours % 12}:${mm} ${hours < 12 ? "AM" : "PM"}`;
}

/** "just now" / "5 min ago" / "3 h ago" / a date. */
export function relativeAge(at: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return new Date(at).toLocaleDateString();
}

/** Byte count for a size readout. */
export function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
