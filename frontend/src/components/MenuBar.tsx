import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * Application top bar (UI_OVERHAUL.md §9): menu buttons (File / Simulation /
 * Subcircuits / Help) on the left, the current file centered, and the window
 * actions (`right`) at the far end — all on one row, VS Code-style. Pure
 * presentation: menus arrive as data from App.
 */

export type MenuItem =
  | {
      kind?: "item";
      label: string;
      /** Right-aligned hint (e.g. "Ctrl+S"); display only. */
      shortcut?: string;
      /** ✓ checkmark (toggle items). */
      checked?: boolean;
      /** ● radio bullet (exclusive-choice items). */
      radio?: boolean;
      disabled?: boolean;
      onSelect: () => void;
    }
  | { kind: "sep" };

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

export default function MenuBar({
  menus,
  pathLabel,
  right,
}: {
  menus: MenuDef[];
  /** Current file (centered); null = unsaved. */
  pathLabel: string | null;
  /** Right-aligned window actions (undo/redo icons, theme toggle, …). */
  right?: ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open === null) return;
    const onDown = (e: MouseEvent) => {
      if (barRef.current !== null && !barRef.current.contains(e.target as Node)) setOpen(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(null);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="menubar" ref={barRef}>
      {menus.map((m) => (
        <div className="menu" key={m.label}>
          <button
            className={`menu-btn${open === m.label ? " active" : ""}`}
            aria-haspopup="menu"
            aria-expanded={open === m.label}
            onClick={() => setOpen(open === m.label ? null : m.label)}
            onMouseEnter={() => {
              if (open !== null) setOpen(m.label);
            }}
          >
            {m.label}
          </button>
          {open === m.label && (
            <div className="menu-pop" role="menu" aria-label={m.label}>
              {m.items.map((item, i) =>
                item.kind === "sep" ? (
                  <div className="menu-sep" key={i} />
                ) : (
                  <button
                    key={i}
                    role="menuitem"
                    className="menu-item"
                    disabled={item.disabled ?? false}
                    onClick={() => {
                      setOpen(null);
                      item.onSelect();
                    }}
                  >
                    <span className="menu-mark">
                      {item.radio === true
                        ? item.checked === true
                          ? "●"
                          : ""
                        : item.checked === true
                          ? "✓"
                          : ""}
                    </span>
                    <span className="menu-label">{item.label}</span>
                    {item.shortcut !== undefined && (
                      <span className="menu-sc">{item.shortcut}</span>
                    )}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
      <span className="menubar-path" title={pathLabel ?? "unsaved"}>
        {pathLabel ?? "(unsaved)"}
      </span>
      {right !== undefined && <div className="menubar-actions">{right}</div>}
    </div>
  );
}
