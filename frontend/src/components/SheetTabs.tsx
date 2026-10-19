import { useEffect, useRef, useState, type CSSProperties } from "react";

/**
 * Circuit tab strip: one tab per circuit in the file (the top-level sheet
 * first, subcircuits after), horizontally scrollable when they don't fit.
 * A new tab slides in and its label becomes an inline input — type the name
 * right in the tab; double-click a tab to rename it the same way. No popups
 * (UI_OVERHAUL §60). A MIDDLE-click (or the "×") offers Rename/Delete; the "+"
 * creates a new subcircuit. The strip sits above the CANVAS column only (§15),
 * so the side panels run the full height.
 */
export default function SheetTabs({
  sheets,
  active,
  onSwitch,
  onNew,
  onRename,
  onDelete,
  renaming = null,
  onCommitRename,
  onCancelRename,
  enterIdx = null,
  scopeHue = null,
}: {
  sheets: readonly string[];
  active: number;
  onSwitch: (i: number) => void;
  onNew: () => void;
  onRename: (i: number) => void;
  /** Delete a circuit sheet (guarded in the document). */
  onDelete?: (i: number) => void;
  /** Sheet index whose label is being edited inline, or null. */
  renaming?: number | null;
  onCommitRename?: (i: number, name: string) => void;
  onCancelRename?: () => void;
  /** Sheet index that just appeared — plays its slide-in animation. */
  enterIdx?: number | null;
  /** Hue of the active sheet's SCOPE when it is a subcircuit (§77), else null. */
  scopeHue?: number | null;
}) {
  // Right-click / middle-click menu (UI_OVERHAUL §37): Rename / Delete for that
  // sheet.
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
        {sheets.map((name, i) => {
          const editing = renaming === i;
          return (
            <div
              key={`${i}:${name}`}
              className={`sheet-tab-wrap${i === active ? " active" : ""}${
                i === enterIdx ? " enter" : ""
              }`}
              // Double-click ANYWHERE on the tab (label, padding or gap) to rename
              // in place (UI_OVERHAUL §16/§60).
              onDoubleClick={() => {
                if (!editing) onRename(i);
              }}
              // A subcircuit sheet is a different scope: the active tab carries
              // that scope's hue (§77), and the attribute lets CSS and tests say
              // which kind of sheet it is without re-deriving it.
              data-scope={i === active && scopeHue !== null ? "subcircuit" : undefined}
              style={
                i === active && scopeHue !== null
                  ? ({ "--scope-hue": String(scopeHue) } as CSSProperties)
                  : undefined
              }
              // Right-click (or middle-click) opens the Rename / Delete menu.
              // Right-click is the discoverable one; middle-click is kept for
              // muscle memory (it used to be the only way in).
              onContextMenu={(e) => {
                e.preventDefault(); // ours, not the browser's
                setMenu({ i, x: e.clientX, y: e.clientY });
              }}
              onMouseDown={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                setMenu({ i, x: e.clientX, y: e.clientY });
              }}
            >
              {editing ? (
                <TabRenameInput
                  initial={name}
                  onCommit={(v) => onCommitRename?.(i, v)}
                  onCancel={() => onCancelRename?.()}
                />
              ) : (
                <button
                  role="tab"
                  aria-selected={i === active}
                  className={`sheet-tab${i === active ? " active" : ""}`}
                  onClick={() => onSwitch(i)}
                  title={
                    i === 0
                      ? `${name} — top level (double-click or right-click to rename)`
                      : `${name} — double-click or right-click to rename/delete`
                  }
                >
                  {name}
                </button>
              )}
              {!editing && onDelete !== undefined && sheets.length > 1 && (
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
          );
        })}
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

/** Inline tab label editor (UI_OVERHAUL §60): type the name right in the tab. */
function TabRenameInput({
  initial,
  onCommit,
  onCancel,
}: {
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // One outcome per edit — guards the blur that follows an Enter/Escape.
  const doneRef = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (run: () => void) => {
    if (doneRef.current) return;
    doneRef.current = true;
    run();
  };
  const commit = () => {
    const v = value.trim();
    finish(() => (v === "" || v === initial ? onCancel() : onCommit(v)));
  };

  return (
    <input
      ref={ref}
      className="sheet-tab-input"
      value={value}
      aria-label="Circuit name"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          // Keep Escape from also cancelling the tool selection, etc.
          e.preventDefault();
          e.stopPropagation();
          finish(onCancel);
        }
      }}
    />
  );
}
