import { useEffect } from "react";
import { baseName } from "../files";
import type { RecoveryMeta } from "../model/recovery";

/**
 * "Recover unsaved work" dialog (autosave, phase 1): shown once on launch when
 * the crash-recovery store holds a copy of a document that was never saved.
 * Restore loads it into the editor (it comes back dirty, so autosave/Save
 * protect it again); Discard throws the copy away.
 */

/** Relative age for the dialog — recent copies matter, exact times don't. */
function ageLabel(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = new Date(at);
  return d.toLocaleDateString();
}

export default function RecoveryDialog({
  entries,
  onRestore,
  onDiscard,
  onClose,
}: {
  entries: RecoveryMeta[];
  onRestore: (key: string) => void;
  /** `"all"` discards every listed copy. */
  onDiscard: (key: string | "all") => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Recover unsaved work"
      onClick={onClose}
    >
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Recover unsaved work</h2>
          <span className="settings-hint">Autosaved copies from an earlier session.</span>
        </div>
        <section className="settings-section">
          <ul className="recovery-list">
            {entries.map((e) => (
              <li key={e.key} className="recovery-row">
                <span className="recovery-meta">
                  <strong>{e.path !== null ? baseName(e.path) : e.name}</strong>
                  <span className="settings-hint">
                    {ageLabel(e.at_ms)}
                    {e.label !== "" ? ` · ${e.label}` : ""}
                  </span>
                </span>
                <span className="recovery-actions">
                  <button onClick={() => onRestore(e.key)}>Restore</button>
                  <button className="secondary" onClick={() => onDiscard(e.key)}>
                    Discard
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
        <div className="settings-foot">
          {entries.length > 1 && (
            <button className="secondary" onClick={() => onDiscard("all")}>
              Discard all
            </button>
          )}
          <span className="settings-hint">Recovery copies live in this machine's app data</span>
        </div>
      </div>
    </div>
  );
}
