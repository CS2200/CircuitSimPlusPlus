/**
 * Circuit tab strip: one tab per circuit in the file (the top-level sheet
 * first, subcircuits after), horizontally scrollable when they don't fit.
 * Double-click renames; each deletable tab carries an "×" (UI_OVERHAUL §10);
 * the "+" button creates a new subcircuit. The strip sits above the CANVAS
 * column only (§15), so the side panels run the full height.
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
  return (
    <div className="sheet-tabs" role="tablist" aria-label="Circuits">
      {sheets.map((name, i) => (
        <div
          key={`${i}:${name}`}
          className={`sheet-tab-wrap${i === active ? " active" : ""}`}
          // Double-click ANYWHERE on the tab (label, padding or gap) to rename
          // (UI_OVERHAUL §16) — the strip's only rename affordance now that the
          // Subcircuits menu is gone.
          onDoubleClick={() => onRename(i)}
        >
          <button
            role="tab"
            aria-selected={i === active}
            className={`sheet-tab${i === active ? " active" : ""}`}
            onClick={() => onSwitch(i)}
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
  );
}
