import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { encodeRleHex, hexWidthFor, maskFor, parseRleHex, wordsFromPasted } from "../lib/rleHex";

/**
 * Memory contents editor (UI_OVERHAUL §11/§14): a hex GRID over the whole
 * memory. Click a cell and the values you paste (or type) fill in from that
 * address — no separate paste box — with `count-value` runs accepted. Applying
 * writes the canonical rle-hex image to `attrs.contents` (docs/format-v2.md
 * §7); the dialog edits the circuit's embedded image, not the running engine.
 */

const PAGE_WORDS = 256; // 16 rows × 16 columns per page
const COLS = 16;

/** Spreadsheet-style arrow navigation (address offsets). */
const ARROW_DELTA: Readonly<Record<string, number | undefined>> = {
  ArrowUp: -COLS,
  ArrowDown: COLS,
  ArrowLeft: -1,
  ArrowRight: 1,
};

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
  const mask = maskFor(bitsize);
  const pageCount = Math.max(1, Math.ceil(depth / PAGE_WORDS));

  const [cells, setCells] = useState<Map<number, number>>(() => {
    if (initial === null) return new Map();
    try {
      return new Map(parseRleHex(initial, Math.max(depth, 1)).map((w, i) => [i, (w & mask) >>> 0]));
    } catch {
      return new Map();
    }
  });
  const [page, setPage] = useState(0);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  // Cell 0 starts focused/selected so a paste works without a first click.
  const [focusAddr, setFocusAddr] = useState<number | null>(0);
  const gridRef = useRef<HTMLDivElement>(null);

  // Move the caret to the cell a paste/keyboard jump landed on.
  useEffect(() => {
    if (focusAddr === null) return;
    const input = gridRef.current?.querySelector<HTMLInputElement>(`[data-addr="${focusAddr}"]`);
    input?.focus();
    input?.select();
    setFocusAddr(null);
  }, [focusAddr]);

  const cellText = (addr: number): string => {
    const v = cells.get(addr);
    return v === undefined ? "" : (v >>> 0).toString(16).padStart(width, "0");
  };

  /** Type into one cell: hex only, kept to the memory's width, empty clears. */
  const setCell = (addr: number, raw: string): void => {
    const digits = raw.replace(/[^0-9a-fA-F]/g, "").slice(-width);
    setError(null);
    setCells((prev) => {
      const next = new Map(prev);
      if (digits === "") next.delete(addr);
      else next.set(addr, (Number(BigInt(`0x${digits}`)) & mask) >>> 0);
      return next;
    });
  };

  /** Paste into the grid, filling from the selected cell onward. */
  const onPaste = (e: ClipboardEvent): void => {
    e.preventDefault();
    const { words, error: err } = wordsFromPasted(
      e.clipboardData.getData("text"),
      bitsize,
      Math.max(depth, 1),
    );
    if (err !== null) {
      setError(err);
      return;
    }
    if (words.length === 0) return;
    const start = Math.min(sel, Math.max(0, depth - 1));
    const take = Math.min(words.length, depth - start);
    setCells((prev) => {
      const next = new Map(prev);
      for (let i = 0; i < take; i++) next.set(start + i, words[i]);
      return next;
    });
    setError(
      take < words.length
        ? `Only ${depth - start} word${depth - start === 1 ? "" : "s"} fit before the end of the memory`
        : null,
    );
    const landed = Math.min(start + take, depth - 1);
    setPage(Math.floor(landed / PAGE_WORDS));
    setSel(landed);
    setFocusAddr(landed);
  };

  /** Arrow keys walk the grid like a spreadsheet. */
  const onKeyDown = (e: KeyboardEvent): void => {
    const delta = ARROW_DELTA[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const target = sel + delta;
    if (target < 0 || target >= depth) return;
    setPage(Math.floor(target / PAGE_WORDS));
    setSel(target);
    setFocusAddr(target);
  };

  const apply = (): void => {
    if (error !== null) return;
    let max = -1;
    for (const addr of cells.keys()) if (addr > max) max = addr;
    if (max < 0) {
      onApply(null);
      onClose();
      return;
    }
    const words: number[] = new Array<number>(max + 1).fill(0);
    for (const [addr, value] of cells) if (addr <= max) words[addr] = value;
    onApply(encodeRleHex(words, width));
    onClose();
  };

  const pageStart = page * PAGE_WORDS;
  const count = Math.max(0, Math.min(PAGE_WORDS, depth - pageStart));
  const rowCount = Math.max(1, Math.ceil(count / COLS));
  const selLabel = `0x${sel.toString(16).toUpperCase().padStart(width, "0")}`;

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Memory contents"
      onClick={onClose}
      onPaste={onPaste}
    >
      <div className="help-card mem-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>
          Memory contents{" "}
          <span className="prop-type">
            {depth} × {bitsize}b
          </span>
        </h2>
        <p className="settings-hint">
          Click a cell, then paste or type hex values — they fill from there. Runs like{" "}
          <code>4-00</code> are accepted; values are stored padded to {width} hex digits.
        </p>
        {error !== null && <p className="mem-error">{error}</p>}
        <p className="settings-hint">
          {cells.size.toLocaleString()} of {depth.toLocaleString()} words set · cell {selLabel}
        </p>

        <div className="mem-table-wrap" ref={gridRef} onKeyDown={onKeyDown}>
          <table className="mem-grid mem-table">
            <tbody>
              {Array.from({ length: rowCount }, (_, row) => (
                <tr key={row}>
                  <td className="mem-rowaddr">
                    {(pageStart + row * COLS).toString(16).padStart(6, "0")}
                  </td>
                  {Array.from({ length: COLS }, (_, col) => {
                    const addr = pageStart + row * COLS + col;
                    if (addr >= pageStart + count) return <td className="mem-cell" key={col} />;
                    return (
                      <td className="mem-cell" key={col}>
                        <input
                          className="mem-cell-input"
                          data-addr={addr}
                          value={cellText(addr)}
                          style={{ width: `${Math.max(3, width + 1)}ch` }}
                          spellCheck={false}
                          autoComplete="off"
                          aria-label={`word ${addr}`}
                          onFocus={() => setSel(addr)}
                          onChange={(e) => setCell(addr, e.target.value)}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mem-dialog-foot">
          <button
            className="secondary"
            disabled={page <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="settings-hint">
            page {page + 1} / {pageCount}
          </span>
          <button
            className="secondary"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            aria-label="Next page"
          >
            ›
          </button>
          <button
            className="secondary"
            onClick={() => {
              setCells(new Map());
              setError(null);
            }}
          >
            Clear all
          </button>
          <span className="mem-dialog-spacer" />
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={apply} disabled={error !== null}>
            Apply
          </button>
        </div>
      </div>
    </div>
  );
}
