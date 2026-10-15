/**
 * Small integer picker (UI_OVERHAUL §28): every legal value as a clickable
 * cell in an 8-column grid — used for bit widths (1..32) and gate input counts
 * (2..32), so a value is one click and can never be out of range.
 */
export default function NumberPicker({
  value,
  min = 1,
  max = 32,
  label,
  onPick,
}: {
  /** Current value. */
  value: number;
  /** Smallest offerable value (inclusive). */
  min?: number;
  /** Largest offerable value (inclusive). */
  max?: number;
  /** Accessible name for the group (usually the field label). */
  label: string;
  onPick: (value: number) => void;
}) {
  const values = Array.from({ length: Math.max(0, max - min + 1) }, (_, i) => min + i);
  return (
    <div className="bitsize-grid" role="radiogroup" aria-label={label}>
      {values.map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${label} ${n}`}
          data-value={n}
          className={`bitsize-cell${value === n ? " active" : ""}`}
          onClick={() => onPick(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
