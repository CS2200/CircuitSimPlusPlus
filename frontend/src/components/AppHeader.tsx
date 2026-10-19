import { useRef, useState, type ReactNode } from "react";

/**
 * Application header (UI_OVERHAUL.md §28): a Docs-style two-row bar.
 *
 *   row 1   [logo] alu.csx  ·  Saved 14:32                    undo redo | history
 *   row 2   File  Edit  View  Help        play tick reset run-to speed T_obs
 *
 * The sim transport lives *inside* row 2 instead of owning a row of its own, so
 * the chrome stays two rows tall while the identity and the menus read like a
 * document editor. Purely structural: the menus, the action icons and the
 * transport all arrive from App.
 */
export default function AppHeader({
  logo,
  title,
  titleTooltip,
  renameValue,
  onRename,
  status,
  menus,
  actions,
  transport,
}: {
  /** App mark, drawn in the accent colour. */
  logo: ReactNode;
  /** File name; "(unsaved)" before the first save. */
  title: string;
  /** Full path, for the hover tooltip. */
  titleTooltip?: string;
  /** The name the inline editor starts from; absent = the title is a label. */
  renameValue?: string;
  /** Commit an inline rename (Enter or blur). */
  onRename?: (name: string) => void;
  /** Save-state chip beside the title (absent in stress mode). */
  status?: ReactNode;
  /** Row-2 left: the menu buttons, or null when there are none. */
  menus?: ReactNode;
  /** Row-1 right: undo / redo / history / theme. */
  actions: ReactNode;
  /** Row-2 right: the sim transport (absent in stress mode). */
  transport?: ReactNode;
}) {
  // Inline title editing (§39): click → a bordered field, exactly like a
  // document editor. Enter or blur commits, Escape puts the old name back.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  /** Guards the double commit Enter-then-blur would otherwise fire. */
  const settled = useRef(false);

  const editTitle = () => {
    settled.current = false;
    setDraft(renameValue ?? "");
    setEditing(true);
  };

  const commitTitle = () => {
    if (settled.current) return;
    settled.current = true;
    setEditing(false);
    const clean = draft.trim();
    if (clean !== "" && clean !== (renameValue ?? "")) onRename?.(clean);
  };

  const cancelTitle = () => {
    settled.current = true;
    setEditing(false);
  };
  return (
    <header className="appheader">
      {/* The app name stays in the accessibility tree; the bar itself is the
       *  chrome (the document name is what belongs on screen). */}
      <h1 className="sr-only">CircuitSim++</h1>
      <div className="appheader-top">
        <span className="app-logo" title="CircuitSim++">
          {logo}
        </span>
        {renameValue === undefined || onRename === undefined ? (
          <span className="app-title" title={titleTooltip ?? title}>
            {title}
          </span>
        ) : editing ? (
          <input
            className="app-title app-title-input"
            aria-label="File name"
            autoFocus
            value={draft}
            size={Math.max(10, draft.length + 2)}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                e.stopPropagation();
                cancelTitle();
              }
            }}
          />
        ) : (
          <button
            className="app-title app-title-editable"
            title={`${titleTooltip ?? title} — click to rename`}
            onClick={editTitle}
          >
            {title}
          </button>
        )}
        {status}
        <div className="appheader-actions">{actions}</div>
      </div>
      {(menus !== undefined || transport !== undefined) && (
        <div className="appheader-bottom">
          {menus}
          {transport !== undefined && <div className="appheader-transport">{transport}</div>}
        </div>
      )}
    </header>
  );
}
