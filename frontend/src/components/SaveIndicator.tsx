/**
 * Status-bar save indicator (autosave, phase 1).
 *
 * Autosave is quiet on success and loud on failure, so the indicator is the
 * main feedback: which of clean / dirty / writing / recovered / failed the
 * document currently is. `saveStateText` is pure so it is unit-tested without
 * rendering.
 */

export type SaveState =
  | { kind: "clean" }
  | { kind: "dirty" }
  | { kind: "saving" }
  | { kind: "saved"; at: number }
  | { kind: "recovered"; at: number }
  | { kind: "error"; message: string };

/** Local wall-clock `HH:MM`. */
function clockAt(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The one-line status text (also the unit under test). */
export function saveStateText(state: SaveState, autosaveOn: boolean): string {
  if (!autosaveOn)
    return state.kind === "dirty" ? "Unsaved changes (autosave off)" : "Autosave off";
  switch (state.kind) {
    case "clean":
      return "All changes saved";
    case "dirty":
      return "Unsaved changes";
    case "saving":
      return "Saving…";
    case "saved":
      return `All changes saved ${clockAt(state.at)}`;
    case "recovered":
      return "Autosaved locally — not saved to the file yet";
    case "error":
      return `Autosave failed: ${state.message}`;
  }
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
      ? `Last autosave ${clockAt(state.at)} — preferences are stored on this machine`
      : text;
  return (
    <span
      className={`save-state${state.kind === "error" ? " save-state-error" : ""}`}
      role="status"
      aria-live="polite"
      title={title}
    >
      {text}
    </span>
  );
}
