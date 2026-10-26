import { CloseIcon, PlusIcon } from "./icons";

/** One circuit as the explorer lists it. */
export interface ExplorerEntry {
  name: string;
  /** Components on the sheet. */
  parts: number;
  /** Where it is placed ("used by main", "not placed yet"); empty for the top level. */
  note: string;
}

/**
 * Circuits explorer (UI_OVERHAUL §99), like VS Code's file explorer: every
 * circuit in the file, whether or not its tab is open. Click a circuit to open
 * it; × closes its tab (the circuit stays in the file and in this list);
 * double-click renames; the trash deletes it, after asking.
 *
 * Pure presentation — the open/closed set and every action live in App.
 */
export default function CircuitExplorer({
  entries,
  active,
  hidden,
  onOpen,
  onClose,
  onRename,
  onDelete,
  onNew,
}: {
  entries: readonly ExplorerEntry[];
  /** Index of the circuit on the canvas. */
  active: number;
  /** Circuits whose tabs are closed. */
  hidden: ReadonlySet<number>;
  onOpen: (i: number) => void;
  onClose: (i: number) => void;
  onRename: (i: number) => void;
  onDelete: (i: number) => void;
  onNew: () => void;
}) {
  const openCount = entries.length - hidden.size;
  return (
    <div className="explorer" role="tabpanel" aria-label="Circuits">
      <p className="palette-hint explorer-hint">
        Closing a tab keeps the circuit — reopen it here.
      </p>
      <ul className="explorer-list">
        {entries.map((e, i) => {
          const open = !hidden.has(i);
          return (
            <li
              key={`${i}:${e.name}`}
              className={`explorer-row${i === active ? " active" : ""}${open ? " open" : ""}`}
            >
              <button
                className="explorer-main"
                title={
                  i === active
                    ? `${e.name} — on the canvas (double-click to rename)`
                    : `Open ${e.name}${open ? "" : " (its tab is closed)"}`
                }
                onClick={() => onOpen(i)}
                onDoubleClick={() => onRename(i)}
              >
                <span className="explorer-glyph" aria-hidden="true">
                  <SheetGlyph top={i === 0} />
                </span>
                <span className="explorer-text">
                  <span className="explorer-name">{e.name}</span>
                  <span className="explorer-meta">
                    {i === 0 ? "top level" : e.note} · {e.parts} part{e.parts === 1 ? "" : "s"}
                  </span>
                </span>
                {open && <span className="explorer-open-dot" title="Tab open" />}
              </button>
              <span className="explorer-actions">
                {open && openCount > 1 && (
                  <button
                    className="explorer-act"
                    aria-label={`Close ${e.name}`}
                    title="Close its tab (the circuit stays in the file)"
                    onClick={() => onClose(i)}
                  >
                    <CloseIcon />
                  </button>
                )}
                {entries.length > 1 && (
                  <button
                    className="explorer-act explorer-delete"
                    aria-label={`Delete ${e.name}`}
                    title="Delete this circuit from the file…"
                    onClick={() => onDelete(i)}
                  >
                    <TrashGlyph />
                  </button>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <button className="palette-new explorer-new" onClick={onNew}>
        <PlusIcon /> New subcircuit
      </button>
    </div>
  );
}

/** A sheet of paper; the top level gets a star in its corner. */
function SheetGlyph({ top }: { top: boolean }) {
  return (
    <svg
      viewBox="0 0 20 20"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinejoin="round"
    >
      <path d="M5 2.8h6.5L15 6.3v10.9H5z" />
      <path d="M11.5 2.8v3.5H15" />
      {top ? (
        <path
          d="m10 9.2.9 1.8 2 .3-1.4 1.4.3 2-1.8-.9-1.8.9.3-2-1.4-1.4 2-.3z"
          fill="currentColor"
          stroke="none"
        />
      ) : (
        <path d="M7.5 10.5h5M7.5 13.5h5" strokeLinecap="round" />
      )}
    </svg>
  );
}

function TrashGlyph() {
  return (
    <svg
      viewBox="0 0 20 20"
      width={16}
      height={16}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6h12M8 6V4.2h4V6M5.5 6l.8 10.2h7.4l.8-10.2M8.6 9v4.8M11.4 9v4.8" />
    </svg>
  );
}
