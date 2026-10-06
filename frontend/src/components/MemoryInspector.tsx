import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { SimController } from "../sim/controller";
import type { WireValue } from "../ipc/types";

/**
 * RAM/ROM inspector (FRONTEND.md U6): paged hex-grid viewer/editor over the
 * `mem_read`/`mem_write` commands. Read-only while running (edits resume on
 * pause); values refresh on any sim-state change while paused (steps,
 * pokes, reset — autoload-restored images show up after a reset reload).
 */

const WORDS_PER_ROW = 8;
const ROWS_PER_PAGE = 16;
const PAGE_WORDS = WORDS_PER_ROW * ROWS_PER_PAGE;

function hex(v: WireValue): string {
  if (v.x !== "" && BigInt(`0x${v.x}`) !== 0n) return "X";
  if (v.z !== "" && BigInt(`0x${v.z}`) !== 0n && (v.v === "" || BigInt(`0x${v.v}`) === 0n))
    return "Z";
  return (v.v === "" ? "0" : v.v).padStart(8, "0");
}

export default function MemoryInspector({
  ctl,
  name,
  onClose,
}: {
  ctl: SimController;
  name: string;
  onClose: () => void;
}) {
  useSyncExternalStore(ctl.store.subscribe, ctl.store.getVersion.bind(ctl.store));
  const running = ctl.store.status?.running ?? false;
  const [base, setBase] = useState(0);
  const [words, setWords] = useState<WireValue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<number | null>(null);
  const [editText, setEditText] = useState("");

  const version = ctl.store.getVersion();
  const refresh = useCallback(() => {
    ctl
      .memRead(name, base, PAGE_WORDS)
      .then((w) => {
        setWords(w);
        setError(null);
      })
      .catch((e: unknown) => setError(String(e)));
  }, [ctl, name, base]);

  // Refresh on page change and on any paused-state sim change (§7.2:
  // mem_read is a command — poll only when it is cheap and meaningful).
  useEffect(() => {
    if (!running) refresh();
  }, [refresh, running, version]);

  const commitEdit = () => {
    if (editing === null) return;
    const text = editText.trim().replace(/^0x/, "");
    if (/^[0-9a-fA-F]{1,8}$/.test(text)) {
      void ctl
        .memWrite(name, base + editing, [{ v: text, x: "", z: "" }])
        .then(refresh)
        .catch((e: unknown) => setError(String(e)));
    }
    setEditing(null);
  };

  return (
    <div className="memory-inspector" data-mem={name}>
      <div className="memory-inspector-head">
        <strong>{name}</strong>
        <span className="mem-addr">
          @{" "}
          <input
            type="number"
            min={0}
            value={base}
            onChange={(e) => setBase(Math.max(0, Number(e.target.value)))}
          />
        </span>
        <button className="secondary" onClick={() => setBase(Math.max(0, base - PAGE_WORDS))}>
          ◀
        </button>
        <button className="secondary" onClick={() => setBase(base + PAGE_WORDS)}>
          ▶
        </button>
        {running && <span className="mem-running">running — read-only</span>}
        <button className="mem-close" onClick={onClose} title="Close inspector">
          ✕
        </button>
      </div>
      {error !== null && <div className="mem-error">{error}</div>}
      {words !== null && (
        <table className="mem-grid">
          <tbody>
            {Array.from({ length: ROWS_PER_PAGE }, (_, r) => (
              <tr key={r}>
                <td className="mem-rowaddr">
                  {(base + r * WORDS_PER_ROW).toString(16).padStart(4, "0")}
                </td>
                {Array.from({ length: WORDS_PER_ROW }, (_, c) => {
                  const i = r * WORDS_PER_ROW + c;
                  const w = words[i];
                  return editing === i ? (
                    <td key={c} className="mem-cell mem-editing">
                      <input
                        autoFocus
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onBlur={commitEdit}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitEdit();
                          if (e.key === "Escape") setEditing(null);
                        }}
                      />
                    </td>
                  ) : (
                    <td
                      key={c}
                      className={`mem-cell${running ? "" : " editable"}`}
                      title={running ? "read-only while running" : "click to edit"}
                      onClick={() => {
                        if (running || w === undefined) return;
                        setEditing(i);
                        setEditText(hex(w));
                      }}
                    >
                      {w === undefined ? "…" : hex(w)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
