import { useEffect } from "react";
import { bytesLabel, clockTime, relativeAge } from "../lib/time";
import type { HistoryUsage, VersionMeta } from "../model/versionStore";

/**
 * Version history dialog (autosave phase 3): **File ▸ Version history…**
 *
 * Lists this document's versions newest-first, previews the selected one, and
 * acts on it — Restore (loads the snapshot back into the editor; never
 * destructive, it simply becomes the new head), Save a copy…, Name… (promotes
 * the version so retention never evicts it) and Delete.
 *
 * History lives in the app data directory, keyed by file path, so it does not
 * follow a file that is moved or renamed.
 */

/** Component/wire totals for the preview header. */
function summarise(text: string): { circuits: number; components: number; wires: number } | null {
  try {
    const doc = JSON.parse(text) as {
      circuits?: { components?: unknown[]; wires?: unknown[] }[];
    };
    const circuits = doc.circuits ?? [];
    return {
      circuits: circuits.length,
      components: circuits.reduce((n, c) => n + (c.components?.length ?? 0), 0),
      wires: circuits.reduce((n, c) => n + (c.wires?.length ?? 0), 0),
    };
  } catch {
    return null;
  }
}

export default function HistoryDialog({
  versions,
  selectedId,
  preview,
  usage,
  onSelect,
  onRestore,
  onSaveCopy,
  onName,
  onDelete,
  onClose,
}: {
  versions: VersionMeta[];
  selectedId: string | null;
  /** Canonical `.csx` of the selected version (null while loading). */
  preview: string | null;
  usage: HistoryUsage | null;
  onSelect: (id: string) => void;
  onRestore: (id: string) => void;
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
  const summary = preview !== null ? summarise(preview) : null;

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Version history"
      onClick={onClose}
    >
      <div className="settings-card history-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Version history</h2>
          <span className="settings-hint">Kept on this machine, per file path.</span>
        </div>

        <div className="history-body">
          <ul className="history-list" aria-label="Versions">
            {versions.length === 0 && (
              <li className="settings-hint">
                No versions yet — save the file to start the history.
              </li>
            )}
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  className={`history-row${v.id === selectedId ? " active" : ""}`}
                  aria-current={v.id === selectedId}
                  onClick={() => onSelect(v.id)}
                >
                  <span className="history-when">{relativeAge(v.at_ms)}</span>
                  <span className="history-label">
                    {v.named && <span className="history-badge">named</span>}
                    {v.label !== "" ? v.label : "Edit"}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          <div className="history-detail">
            {selected === null ? (
              <p className="settings-hint">Select a version to preview it.</p>
            ) : (
              <>
                <h3>{selected.named ? selected.label : "Version"}</h3>
                <p className="settings-hint">
                  {clockTime(selected.at_ms)} · {bytesLabel(selected.bytes)}
                  {summary !== null &&
                    ` · ${summary.components} parts, ${summary.wires} wires, ${summary.circuits} sheet(s)`}
                </p>
                <div className="history-actions">
                  <button onClick={() => onRestore(selected.id)}>Restore</button>
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
                {preview !== null && (
                  <details className="history-json">
                    <summary>Canonical .csx</summary>
                    <pre>{preview}</pre>
                  </details>
                )}
              </>
            )}
          </div>
        </div>

        <div className="settings-foot">
          <span className="settings-hint">
            {usage !== null ? `${bytesLabel(usage.bytes)} across ${usage.documents} file(s)` : ""}
          </span>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
