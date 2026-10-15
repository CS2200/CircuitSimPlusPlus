import { useMemo, useState } from "react";
import { encodeRleHex, hexCells, hexWidthFor, wordsFromPasted } from "../lib/rleHex";

/**
 * Memory contents editor (UI_OVERHAUL §11): paste hex values and review them
 * as a hex table over the whole memory, then apply the canonical rle-hex
 * image to `attrs.contents` (docs/format-v2.md §7). The dialog is
 * file-level — it edits the circuit's embedded image, not the running
 * engine's memory.
 */

const PAGE_WORDS = 256; // 16 rows × 16 columns
const COLS = 16;
const PREFILL_LIMIT = 8192; // don't dump a 64k-word image into a textarea

export default function MemContentsDialog({
  depth,
  bitsize,
  initial,
  onApply,
  onClose,
}: {
  /** Memory depth in words (format-v2 §4). */
  depth: number;
  /** Word width in bits. */
  bitsize: number;
  /** Current `attrs.contents` (rle-hex) or null. */
  initial: string | null;
  /** Apply the canonical image (null = no contents). */
  onApply: (contents: string | null) => void;
  onClose: () => void;
}) {
  const width = hexWidthFor(bitsize);
  const [text, setText] = useState<string>(() =>
    initial !== null && initial.length <= PREFILL_LIMIT ? initial : "",
  );
  const parsed = useMemo(
    () => wordsFromPasted(text, bitsize, Math.max(depth, 1)),
    [text, bitsize, depth],
  );
  const [page, setPage] = useState(0);

  const words = parsed.words;
  const pageCount = Math.max(1, Math.ceil(depth / PAGE_WORDS));
  const safePage = Math.min(page, pageCount - 1);
  const cells = hexCells(words.slice(safePage * PAGE_WORDS, (safePage + 1) * PAGE_WORDS), width);
  const tooMany = words.length > depth;

  const apply = () => {
    if (parsed.error !== null || tooMany) return;
    onApply(words.length === 0 ? null : encodeRleHex(words, width));
    onClose();
  };

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Memory contents"
      onClick={onClose}
    >
      <div className="help-card mem-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>
          Memory contents{" "}
          <span className="prop-type">
            {depth} × {bitsize}b
          </span>
        </h2>
        <label className="mem-paste">
          <span>Paste hex values (space/newline separated; `count-value` runs allowed)</span>
          <textarea
            value={text}
            spellCheck={false}
            placeholder="e.g. 0a 0b 3-ff"
            onChange={(e) => {
              setText(e.target.value);
              setPage(0);
            }}
          />
        </label>
        {parsed.error !== null && <p className="mem-error">{parsed.error}</p>}
        {parsed.error === null && tooMany && (
          <p className="mem-error">
            {words.length.toLocaleString()} words exceed the memory depth ({depth.toLocaleString()}
            ).
          </p>
        )}
        {parsed.error === null && !tooMany && (
          <p className="settings-hint">
            {words.length.toLocaleString()} of {depth.toLocaleString()} words set · values shown in
            hex
          </p>
        )}

        <div className="mem-table-wrap">
          <table className="mem-grid mem-table">
            <tbody>
              {Array.from({ length: Math.ceil((cells.length || 1) / COLS) }, (_, row) => {
                const base = safePage * PAGE_WORDS + row * COLS;
                return (
                  <tr key={row}>
                    <td className="mem-rowaddr">{(base >>> 0).toString(16).padStart(6, "0")}</td>
                    {Array.from({ length: COLS }, (_, col) => {
                      const value = cells[row * COLS + col];
                      return (
                        <td className="mem-cell" key={col}>
                          {value ?? ""}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="mem-dialog-foot">
          <button
            className="secondary"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="settings-hint">
            page {safePage + 1} / {pageCount}
          </span>
          <button
            className="secondary"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            aria-label="Next page"
          >
            ›
          </button>
          <button className="secondary" onClick={() => setText("")}>
            Clear all
          </button>
          <span className="mem-dialog-spacer" />
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={apply} disabled={parsed.error !== null || tooMany}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
