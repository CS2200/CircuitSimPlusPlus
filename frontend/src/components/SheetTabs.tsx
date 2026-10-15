/**
 * Circuit tab strip: one tab per circuit in the file (the top-level sheet
 * first, subcircuits after), horizontally scrollable when they don't fit.
 * Double-click renames; each deletable tab carries an "×" (UI_OVERHAUL §10);
 * the "+" button creates a new subcircuit.
 *
 * `inset` left-pads the strip so the tabs line up with the canvas grid
 * (i.e. clear of the component palette) instead of starting at the window
 * edge, and tracks the palette's live width.
 */
export default function SheetTabs({
  sheets,
  active,
  onSwitch,
  onNew,
  onRename,
  onDelete,
  inset = 0,
}: {
  sheets: readonly string[];
  active: number;
  onSwitch: (i: number) => void;
  onNew: () => void;
  onRename: (i: number) => void;
  /** Delete a circuit sheet (guarded in the document). */
  onDelete?: (i: number) => void;
  /** Left inset in CSS px (the palette's width) to align with the grid. */
  inset?: number;
}) {
  return (
    <div
      className="sheet-tabs"
      role="tablist"
      aria-label="Circuits"
      style={inset > 0 ? { paddingLeft: inset + 8 } : undefined}
    >
      {sheets.map((name, i) => (
        <div key={`${i}:${name}`} className={`sheet-tab-wrap${i === active ? " active" : ""}`}>
          <button
            role="tab"
            aria-selected={i === active}
            className={`sheet-tab${i === active ? " active" : ""}`}
            onClick={() => onSwitch(i)}
            onDoubleClick={() => onRename(i)}
            title={
              i === 0
                ? `${name} — top level (double-click to rename)`
                : `${name} — double-click to rename`
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
  );
}
