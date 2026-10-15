import { useRef, useState } from "react";
import { PANEL_LIMITS, clampPanelWidth, type PanelId } from "../panels";

/**
 * Draggable vertical separator for a side panel (UI_OVERHAUL.md §7).
 *
 * The handle is an OVERLAY on the work area's edge (absolute, no layout
 * footprint — the canvas geometry is identical whether or not the panels
 * are resizable, which also keeps the visual-regression baselines stable).
 *
 * `side` names where the panel sits relative to the work area: a "left"
 * panel (the palette) grows with rightward drags; a "right" panel (the
 * dock) grows with leftward drags. The handle is keyboard-accessible
 * (Arrow keys step 8px) and double-click resets the default width.
 *
 * Width updates are live (`onResize`) and persisted on release
 * (`onCommit`), so a drag re-lays-out the app every frame but localStorage
 * is written once.
 */
export default function ResizeHandle({
  panel,
  side,
  width,
  defaultWidth,
  onResize,
  onCommit,
}: {
  panel: PanelId;
  side: "left" | "right";
  /** Current width (controlled by the parent). */
  width: number;
  /** Double-click reset target. */
  defaultWidth: number;
  /** Live width updates while dragging / stepping. */
  onResize: (width: number) => void;
  /** Final width to persist (pointer release, key step, reset). */
  onCommit: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);
  const latest = useRef(width);

  const apply = (next: number) => {
    latest.current = next;
    onResize(next);
  };

  const growKey = side === "left" ? "ArrowRight" : "ArrowLeft";
  const shrinkKey = side === "left" ? "ArrowLeft" : "ArrowRight";
  const limits = PANEL_LIMITS[panel];

  return (
    <div
      className={`resize-handle ${side}${dragging ? " dragging" : ""}`}
      data-panel={panel}
      role="separator"
      aria-orientation="vertical"
      aria-label={`Resize ${panel === "palette" ? "component palette" : "inspector dock"}`}
      aria-valuemin={limits.min}
      aria-valuemax={limits.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize · double-click to reset"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        start.current = { x: e.clientX, width: latest.current };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        const s = start.current;
        if (s === null) return;
        const dx = e.clientX - s.x;
        apply(clampPanelWidth(panel, side === "left" ? s.width + dx : s.width - dx));
      }}
      onPointerUp={(e) => {
        if (start.current === null) return;
        start.current = null;
        setDragging(false);
        e.currentTarget.releasePointerCapture(e.pointerId);
        onCommit(latest.current);
      }}
      onPointerCancel={() => {
        if (start.current === null) return;
        start.current = null;
        setDragging(false);
        onCommit(latest.current);
      }}
      onDoubleClick={() => {
        apply(defaultWidth);
        onCommit(defaultWidth);
      }}
      onKeyDown={(e) => {
        const step = e.key === growKey ? 8 : e.key === shrinkKey ? -8 : 0;
        if (step === 0) return;
        e.preventDefault();
        e.stopPropagation(); // resize keys must not reach the canvas (§22)
        const next = clampPanelWidth(panel, latest.current + step);
        apply(next);
        onCommit(next);
      }}
    />
  );
}
