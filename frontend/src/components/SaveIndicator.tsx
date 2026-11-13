/**
 * Header save indicator (autosave, phase 1; restyled UI_OVERHAUL §94).
 *
 * Autosave is quiet on success and loud on failure, so the indicator is the
 * main feedback: which of clean / dirty / writing / recovered / failed the
 * document currently is. `saveStateText` is pure so it is unit-tested without
 * rendering. The chip carries the state as `data-kind`, so the dot beside the
 * text can be green (safe), amber (a write is pending) or red (failed) without
 * the text changing.
 */

import { clockTime } from "../lib/time";

export type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "recovered"; at: number }
  | { kind: "error"; message: string };

/** The one-line status text (also the unit under test). */
export function saveStateText(state: SaveState, autosaveOn: boolean): string {
  if (!autosaveOn)
    return state.kind === "dirty" ? "Unsaved changes (autosave off)" : "Autosave off";
  switch (state.kind) {
    case "clean":
      return "Saved";
    case "dirty":
      // Autosave WILL write this, so say so rather than sounding an alarm
      // (the tester read "Unsaved changes" as a problem to go fix).
      return "Saving changes";
    case "saving":
      return "Saving…";
    case "saved":
      return `Saved ${clockTime(state.at)}`;
    case "recovered":
      return "Autosaved locally — not saved to the file yet";
    case "error":
      return `Autosave failed: ${state.message}`;
  }
}

/** Dot colour class: what the state means for the person's work. */
function tone(state: SaveState, autosaveOn: boolean): "ok" | "pending" | "error" | "off" {
  if (!autosaveOn) return state.kind === "dirty" ? "pending" : "off";
  switch (state.kind) {
    case "clean":
    case "saved":
      return "ok";
    case "dirty":
    case "saving":
    case "recovered":
      return "pending";
    case "error":
      return "error";
  }
}

/**
 * Whether the dot blinks — i.e. a write is in flight or queued (UI_OVERHAUL
 * §109). Colour and motion are separate: a **steady** amber state (a recovery
 * copy that is already on disk, or unsaved changes while autosave is off) is
 * "pending" but sits still, because nothing is happening. Only the transient
 * `dirty`/`saving` window during an autosave pulses.
 */
export function saveStatePulses(state: SaveState, autosaveOn: boolean): boolean {
  return autosaveOn && (state.kind === "dirty" || state.kind === "saving");
}

export default function SaveIndicator({
  state,
  autosaveOn,
}: {
  state: SaveState;
  autosaveOn: boolean;
}) {
  const text = saveStateText(state, autosaveOn);
  const title =
    autosaveOn && (state.kind === "recovered" || state.kind === "saved")
      ? `Last autosave ${clockTime(state.at)} — preferences are stored on this machine`
      : text;
  return (
    <span
      className={`save-state${state.kind === "error" ? " save-state-error" : ""}`}
      data-kind={tone(state, autosaveOn)}
      data-pulse={saveStatePulses(state, autosaveOn) ? "true" : undefined}
      role="status"
      aria-live="polite"
      title={title}
    >
      <span className="save-dot" aria-hidden="true" />
      {text}
    </span>
  );
}
