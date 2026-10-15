import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * App dropdown (UI_OVERHAUL §28/§29): a button plus an option list styled like
 * the menu-bar popups. The list is **portaled to the body** and positioned with
 * `position: fixed`, so it OVERLAYS the surrounding UI instead of pushing it
 * down, and it is never clipped by the scrolling panel that owns the button
 * (the Inspector dock and the settings pane both scroll). It flips above the
 * button when there is not enough room below.
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
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{
    left: number;
    minWidth: number;
    maxWidth: number;
    top?: number;
    bottom?: number;
    maxHeight: number;
  } | null>(null);
  const current = options.find((o) => o.value === value);

  const place = useCallback(() => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r === undefined) return;
    const gap = 4;
    // Prefer below; flip above only when the space below is tight and there
    // is more room above.
    const below = window.innerHeight - r.bottom >= 180 || r.top < 180;
    setPos({
      left: r.left,
      minWidth: r.width,
      maxWidth: window.innerWidth - r.left - 8,
      top: below ? r.bottom + gap : undefined,
      bottom: below ? undefined : window.innerHeight - r.top + gap,
      maxHeight: (below ? window.innerHeight - r.bottom : r.top) - gap - 8,
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    place();
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) === true || popRef.current?.contains(t) === true) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, place]);

  return (
    <div className="select">
      <button
        ref={btnRef}
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
      {open &&
        pos !== null &&
        createPortal(
          <div
            ref={popRef}
            className="select-pop"
            role="listbox"
            aria-label={label}
            style={{
              left: pos.left,
              minWidth: pos.minWidth,
              maxWidth: pos.maxWidth,
              top: pos.top,
              bottom: pos.bottom,
              maxHeight: pos.maxHeight,
            }}
          >
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
          </div>,
          document.body,
        )}
    </div>
  );
}
