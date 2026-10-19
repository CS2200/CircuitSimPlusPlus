import { typeDisplayName } from "../editor/catalog";
import type { CanvasMenuState } from "../editor/tools";

/**
 * Canvas context menu (UI_OVERHAUL §75): a right-click on the canvas offers the
 * commands that fit what is under the pointer — a part, a wire, or bare canvas —
 * and the editor's public commands carry them out (this component only renders
 * and dispatches; the editor owns what is possible).
 *
 * The overlay is positioned in SCREEN coordinates, which is what the editor
 * reports: the press happened at a viewport point, and the menu must sit exactly
 * there whatever the pan and zoom. Dismissal (clicking away, Escape) belongs to
 * the caller, which owns the state.
 */

/** The commands the menu can dispatch (the editor's public command set). */
export type CanvasMenuAction =
  "cut" | "copy" | "paste" | "delete" | "rotate-cw" | "rotate-ccw" | "select-all";

const MENU_NAME = { component: "Component", wire: "Wire", canvas: "Canvas" } as const;

export default function CanvasMenu({
  menu,
  onAction,
  onClose,
}: {
  menu: CanvasMenuState;
  /** Run one command (the caller closes the menu first). */
  onAction: (action: CanvasMenuAction) => void;
  onClose: () => void;
}) {
  // Keyed off what was POINTED at, never off the selection: right-clicking bare
  // canvas must not offer to edit a part selected elsewhere on the sheet. The
  // commands themselves still act on the whole selection, which is why a
  // right-click inside a multi-selection keeps it.
  const items: { id: CanvasMenuAction; label: string; hint?: string; disabled?: boolean }[] = [];
  if (menu.on === "component") {
    items.push(
      { id: "cut", label: "Cut", hint: "Ctrl+X" },
      { id: "copy", label: "Copy", hint: "Ctrl+C" },
      { id: "rotate-cw", label: "Rotate right", hint: "R" },
      { id: "rotate-ccw", label: "Rotate left", hint: "Shift+R" },
      { id: "delete", label: "Delete", hint: "Del" },
    );
  } else if (menu.on === "wire") {
    items.push({
      id: "delete",
      label: menu.segment ? "Delete segment" : menu.wires > 1 ? "Delete wires" : "Delete wire",
      hint: "Del",
    });
  }
  // Paste stays visible (disabled) with an empty clipboard, so the menu teaches
  // it rather than silently hiding the only canvas-wide command there is.
  items.push({ id: "paste", label: "Paste", hint: "Ctrl+V", disabled: !menu.clipboard });
  if (menu.on === "canvas") items.push({ id: "select-all", label: "Select all", hint: "Ctrl+A" });

  let title: string;
  if (menu.on === "component") {
    title =
      menu.components > 1
        ? `${menu.components} parts selected`
        : typeDisplayName(menu.compType ?? "component");
  } else if (menu.on === "wire") {
    title = menu.segment ? "Wire · one segment" : "Wire";
  } else {
    title = "Canvas";
  }

  return (
    <div
      className="canvas-menu"
      role="menu"
      aria-label={`${MENU_NAME[menu.on]} actions`}
      style={{ left: menu.x, top: menu.y }}
    >
      <div className="canvas-menu-title">{title}</div>
      {items.map((item) => (
        <button
          key={item.id}
          role="menuitem"
          disabled={item.disabled ?? false}
          onClick={() => {
            onClose();
            onAction(item.id);
          }}
        >
          <span>{item.label}</span>
          {item.hint !== undefined && <span className="canvas-menu-hint">{item.hint}</span>}
        </button>
      ))}
    </div>
  );
}
