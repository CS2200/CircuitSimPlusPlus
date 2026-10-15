import { useEffect, useRef, useState } from "react";

/**
 * Circuit tab strip: one tab per circuit in the file (the top-level sheet
 * first, subcircuits after), horizontally scrollable when they don't fit.
 * Double-click renames; a MIDDLE-click (or the "×") offers Rename/Delete
 * (UI_OVERHAUL §37); the "+" button creates a new subcircuit. The strip sits
 * above the CANVAS column only (§15), so the side panels run the full height.
 */
export default function SheetTabs({
  sheets,
  active,
  onSwitch,
  onNew,
  onRename,
  onDelete,
}: {
  sheets: readonly string[];
  active: number;
  onSwitch: (i: number) => void;
  onNew: () => void;
  onRename: (i: number) => void;
  /** Delete a circuit sheet (guarded in the document). */
  onDelete?: (i: number) => void;
}) {
  // Middle-click menu (UI_OVERHAUL §37): Rename / Delete for that sheet.
  const [menu, setMenu] = useState<{ i: number; x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (menu === null) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current?.contains(e.target as Node) === true) return;
      setMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [menu]);

  return (
    <>
      <div className="sheet-tabs" role="tablist" aria-label="Circuits">
        {sheets.map((name, i) => (
          <div
            key={`${i}:${name}`}
            className={`sheet-tab-wrap${i === active ? " active" : ""}`}
            // Double-click ANYWHERE on the tab (label, padding or gap) to rename
            // (UI_OVERHAUL §16) — the strip's only rename affordance now that the
            // Subcircuits menu is gone.
            onDoubleClick={() => onRename(i)}
            // Middle-click (button 1): suppress Chromium's autoscroll/gesture
            // default and open our Rename/Delete menu instead.
            onMouseDown={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              setMenu({ i, x: e.clientX, y: e.clientY });
            }}
          >
            <button
              role="tab"
              aria-selected={i === active}
              className={`sheet-tab${i === active ? " active" : ""}`}
              onClick={() => onSwitch(i)}
              title={
                i === 0
                  ? `${name} — top level (double-click to rename)`
                  : `${name} — double-click or middle-click to rename/delete`
              }
            >
              {name}
            </button>
            {onDelete !== undefined && sheets.length > 1 && (
              <button
                className="sheet-tab-close"
                aria-label={`Delete ${name}`}
                title={`Delete "${name}"`}
                onClick={() => onDelete(i)}
                onDoubleClick={(e) => e.stopPropagation()}
              >
                ×
              </button>
            )}
          </div>
        ))}
        <button
          className="sheet-tab sheet-new"
          onClick={onNew}
          title="New subcircuit"
          aria-label="New subcircuit"
        >
          +
        </button>
      </div>
      {menu !== null && (
        <div
          ref={menuRef}
          className="sheet-tab-menu"
          role="menu"
          aria-label={`${sheets[menu.i]} actions`}
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            role="menuitem"
            onClick={() => {
              const i = menu.i;
              setMenu(null);
              onRename(i);
            }}
          >
            Rename…
          </button>
          {onDelete !== undefined && sheets.length > 1 && (
            <button
              role="menuitem"
              onClick={() => {
                const i = menu.i;
                setMenu(null);
                onDelete(i);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </>
  );
}
