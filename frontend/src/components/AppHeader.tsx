import type { ReactNode } from "react";

/**
 * Application header (UI_OVERHAUL.md §28): a Docs-style two-row bar.
 *
 *   row 1   [logo] alu.csx  ·  Saved 14:32              undo redo | history | theme
 *   row 2   File  Edit  View  Tools  Help    play tick reset run-to speed T_obs
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
  onRenameFile,
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
  /** Given when clicking the title should name/rename the file. */
  onRenameFile?: () => void;
  /** Save-state chip beside the title (absent in stress mode). */
  status?: ReactNode;
  /** Row-2 left: the menu buttons, or null when there are none. */
  menus?: ReactNode;
  /** Row-1 right: undo / redo / history / theme. */
  actions: ReactNode;
  /** Row-2 right: the sim transport (absent in stress mode). */
  transport?: ReactNode;
}) {
  return (
    <header className="appheader">
      {/* The app name stays in the accessibility tree; the bar itself is the
       *  chrome (the document name is what belongs on screen). */}
      <h1 className="sr-only">CircuitSim++</h1>
      <div className="appheader-top">
        <span className="app-logo" title="CircuitSim++">
          {logo}
        </span>
        {onRenameFile === undefined ? (
          <span className="app-title" title={titleTooltip ?? title}>
            {title}
          </span>
        ) : (
          <button
            className="app-title app-title-editable"
            title={`${titleTooltip ?? title} — click to rename`}
            onClick={onRenameFile}
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
