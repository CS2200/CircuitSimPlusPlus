import { useEffect, useRef } from "react";

/**
 * A yes/no question in the app's own dialog style (UI_OVERHAUL §99) — used where
 * an action destroys something, like deleting a circuit. Replaces
 * `window.confirm`, which is unstyled, blocks the page, and reads like an error.
 *
 * Escape and clicking outside cancel; Enter confirms (the confirm button takes
 * focus, so the keyboard path is the natural one).
 */
export default function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  /** The confirm button is styled as destructive. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onCancel}
    >
      <div className="settings-card confirm-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>{title}</h2>
        </div>
        <p className="settings-hint confirm-body">{body}</p>
        <div className="settings-foot confirm-foot">
          <button className="secondary" onClick={onCancel}>
            Cancel
          </button>
          <button ref={confirmRef} className={danger ? "danger" : undefined} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
