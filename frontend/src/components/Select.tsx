import { useEffect, useRef, useState } from "react";

/**
 * App dropdown (UI_OVERHAUL §28): a button plus an INLINE option list styled
 * like the menu-bar popups, so selects look native to the app instead of the
 * OS. Inline (not absolutely positioned) on purpose — the Inspector and the
 * settings pane both scroll, and a floating popup would be clipped by them.
 */
export default function Select<T extends string | number>({
  value,
  options,
  label,
  onChange,
  disabled = false,
}: {
  value: T;
  options: readonly { value: T; label: string }[];
  /** Accessible name (also how tests target it). */
  label: string;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current !== null && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  return (
    <div className="select" ref={ref}>
      <button
        type="button"
        className="select-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="select-value">{current?.label ?? ""}</span>
        <span className="select-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="select-pop" role="listbox" aria-label={label}>
          {options.map((o) => (
            <button
              key={String(o.value)}
              type="button"
              role="option"
              aria-selected={o.value === value}
              className={`select-item${o.value === value ? " active" : ""}`}
              onClick={() => {
                onChange(o.value);
                setOpen(false);
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
