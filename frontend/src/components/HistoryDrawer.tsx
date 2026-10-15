import { useEffect } from "react";
import { bytesLabel, clockTime, relativeAge } from "../lib/time";
import type { HistoryUsage, VersionMeta } from "../model/versionStore";

/**
 * Version-history drawer (UI_OVERHAUL §33): a Google-Docs-style panel that
 * overlays the right dock. Clicking a version previews that circuit on the
 * canvas behind it; nothing is applied until **Restore this version**.
 *
 * History lives in the app data directory keyed by file path, so it does not
 * follow a file that is moved or renamed.
 */
export default function HistoryDrawer({
  versions,
  selectedId,
  usage,
  onSelect,
  onSaveCopy,
  onName,
  onDelete,
  onClose,
}: {
  versions: VersionMeta[];
  selectedId: string | null;
  usage: HistoryUsage | null;
  onSelect: (id: string) => void;
  onSaveCopy: (id: string) => void;
  onName: (id: string) => void;
  onDelete: (id: string) => void;
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

  const selected = versions.find((v) => v.id === selectedId) ?? null;

  return (
    <aside className="history-drawer" aria-label="Version history">
      <header className="history-head">
        <h2>Version history</h2>
        <button className="icon-btn" aria-label="Close version history" onClick={onClose}>
          ×
        </button>
      </header>

      <ul className="history-list">
        {versions.length === 0 && (
          <li className="history-empty">No versions yet — save the file to start the history.</li>
        )}
        {versions.map((v) => (
          <li key={v.id}>
            <button
              className={`history-row${v.id === selectedId ? " active" : ""}`}
              aria-current={v.id === selectedId}
              onClick={() => onSelect(v.id)}
            >
              <span className="history-when">
                {relativeAge(v.at_ms)}
                {v.named && <span className="history-badge">named</span>}
              </span>
              <span className="history-label">{v.label !== "" ? v.label : "Edit"}</span>
              <span className="history-meta">
                {clockTime(v.at_ms)} · {bytesLabel(v.bytes)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {selected !== null && (
        <div className="history-actions">
          <div className="history-actions-row">
            <button className="secondary" onClick={() => onSaveCopy(selected.id)}>
              Save a copy…
            </button>
            <button className="secondary" onClick={() => onName(selected.id)}>
              Name…
            </button>
            <button className="secondary" onClick={() => onDelete(selected.id)}>
              Delete
            </button>
          </div>
        </div>
      )}

      <footer className="history-foot">
        <span>
          {usage !== null
            ? `${bytesLabel(usage.bytes)} on disk · ${usage.documents} file(s)`
            : "Stored on this machine, per file path"}
        </span>
      </footer>
    </aside>
  );
}
