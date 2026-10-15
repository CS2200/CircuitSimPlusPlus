/**
 * Bit-width picker (UI_OVERHAUL §18): every legal width 1..32 as a clickable
 * cell in an 8×4 grid, so setting a width is one click instead of typing a
 * number (format-v2 widths are 1..32).
 */
export default function BitsizePicker({
  value,
  label,
  onPick,
}: {
  /** Current width in bits (1..32). */
  value: number;
  /** Accessible name for the group (usually the field label). */
  label: string;
  onPick: (bits: number) => void;
}) {
  return (
    <div className="bitsize-grid" role="radiogroup" aria-label={label}>
      {Array.from({ length: 32 }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`bitsize ${n}`}
          data-bitsize={n}
          className={`bitsize-cell${value === n ? " active" : ""}`}
          onClick={() => onPick(n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}
