import { useEffect, useState } from "react";
import { bytesLabel, clockTime, relativeAge } from "../lib/time";
import type { HistoryUsage, VersionMeta } from "../model/versionStore";
import { copyText } from "../lib/clipboard";
import { diffEntries, diffSummary, diffText, type VersionDiff } from "../model/versionDiff";

/**
 * Version-history drawer (UI_OVERHAUL §34): a Google-Docs-style panel that
 * overlays the right dock. Clicking a version previews that circuit on the
 * canvas behind it and lists how it differs from the open document; clicking a
 * version's name renames it in place. Nothing is applied until **Restore this
 * version** (up in the preview banner).
 *
 * History lives in the app data directory keyed by file path, so it does not
 * follow a file that is moved or renamed.
 */
export default function HistoryDrawer({
  versions,
  selectedId,
  usage,
  diff,
  onSelect,
  onRename,
  onClose,
  onNotify,
}: {
  versions: VersionMeta[];
  selectedId: string | null;
  usage: HistoryUsage | null;
  /** The selected version compared with the open document (null while loading). */
  diff: VersionDiff | null;
  onSelect: (id: string) => void;
  onRename: (id: string, label: string) => void;
  onClose: () => void;
  /** Toast line (the copy outcome). */
  onNotify?: (message: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && editingId === null) {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, editingId]);

  const selected = versions.find((v) => v.id === selectedId) ?? null;
  const entries = diff === null ? [] : diffEntries(diff);

  /** Copy the whole comparison (summary + every change, uncapped) as text. */
  const copyDiff = async (): Promise<void> => {
    if (diff === null) return;
    const ok = await copyText(diffText(diff));
    onNotify?.(ok ? "Changes copied to the clipboard" : "Couldn't reach the clipboard");
  };

  const commitRename = (id: string): void => {
    setEditingId(null);
    const label = draft.trim();
    const before = versions.find((v) => v.id === id);
    if (label !== "" && label !== before?.label) onRename(id, label);
  };

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
          <li key={v.id} className={`history-row${v.id === selectedId ? " active" : ""}`}>
            {/* A full-row click target, with the name sitting above it so it can
             *  be edited without selecting the row. */}
            <button
              className="history-select"
              aria-current={v.id === selectedId}
              aria-label={`Preview the version saved ${relativeAge(v.at_ms)}`}
              onClick={() => onSelect(v.id)}
            />
            <div className="history-body">
              <span className="history-when">{relativeAge(v.at_ms)}</span>
              {editingId === v.id ? (
                <input
                  className="history-rename"
                  aria-label="Version name"
                  autoFocus
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onBlur={() => commitRename(v.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitRename(v.id);
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setEditingId(null);
                    }
                  }}
                />
              ) : (
                <button
                  className="history-label"
                  title="Click to rename this version"
                  onClick={() => {
                    setEditingId(v.id);
                    setDraft(v.label);
                  }}
                >
                  {v.label !== "" ? v.label : "Click to name"}
                </button>
              )}
              <span className="history-meta">
                {clockTime(v.at_ms)} · {bytesLabel(v.bytes)}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {selected !== null && (
        <section className="history-diff" aria-label="Changes in this version">
          <div className="history-diff-head">
            <h3>This version vs the open document</h3>
            {entries.length > 0 && (
              <button
                className="history-copy"
                title="Copy these changes to the clipboard"
                onClick={() => void copyDiff()}
              >
                Copy
              </button>
            )}
          </div>
          <p className="history-diff-summary">{diff === null ? "Comparing…" : diffSummary(diff)}</p>
          {entries.length > 0 && (
            <ul className="history-diff-list">
              {entries.map((entry, i) => (
                <li key={i} className={`diff-${entry.kind}`}>
                  {entry.text}
                </li>
              ))}
            </ul>
          )}
        </section>
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
