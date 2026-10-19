import { useEffect } from "react";

/**
 * "Save your work?" prompt (2026-10-19): shown when the window is asked to
 * close while the document has unsaved changes.
 *
 * This is the *before* half of what the crash-recovery dialog used to do after
 * the fact: a clean close is a decision the person is present for, so we ask
 * here and let the recovery dialog be what it says it is — a net for sessions
 * that ended without closing (a crash).
 *
 * Save writes the document (a Save As dialog only when it has never been named);
 * Don't save throws the changes away; Cancel keeps the app open. Escape is
 * Cancel — the choice that loses nothing.
 */

/** What the close guard decided. */
export type CloseChoice = "save" | "discard" | "cancel";

export default function ClosePrompt({
  name,
  onChoose,
}: {
  /** Document name, for the body copy. */
  name: string;
  onChoose: (choice: CloseChoice) => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onChoose("cancel");
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onChoose]);

  return (
    <div className="help-overlay" role="dialog" aria-modal="true" aria-label="Save your work">
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Save your work?</h2>
          <span className="settings-hint">
            {name} has unsaved changes — closing now would lose them.
          </span>
        </div>
        <div className="settings-foot">
          <button className="secondary" onClick={() => onChoose("discard")}>
            Don&apos;t save
          </button>
          <button className="secondary" onClick={() => onChoose("cancel")}>
            Cancel
          </button>
          <button onClick={() => onChoose("save")}>Save</button>
        </div>
      </div>
    </div>
  );
}
