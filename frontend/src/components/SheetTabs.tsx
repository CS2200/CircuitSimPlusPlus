/**
 * Circuit tab strip: one tab per circuit in the file (the top-level sheet
 * first, subcircuits after), horizontally scrollable when they don't fit.
 * Double-click renames; the "+" button creates a new subcircuit.
 */
export default function SheetTabs({
  sheets,
  active,
  onSwitch,
  onNew,
  onRename,
}: {
  sheets: readonly string[];
  active: number;
  onSwitch: (i: number) => void;
  onNew: () => void;
  onRename: (i: number) => void;
}) {
  return (
    <div className="sheet-tabs" role="tablist" aria-label="Circuits">
      {sheets.map((name, i) => (
        <button
          key={`${i}:${name}`}
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
