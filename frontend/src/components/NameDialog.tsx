import { useEffect, useRef, useState } from "react";

/**
 * Tiny single-field text modal (sheet names, run-to cycle). The app carries
 * its own because `window.prompt` is unsupported in WKWebView/WebView2 —
 * only the Linux WebKitGTK webview has it.
 */
export default function NameDialog({
  title,
  initial,
  submitLabel = "OK",
  onSubmit,
  onCancel,
}: {
  title: string;
  initial: string;
  submitLabel?: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCancel();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onCancel]);

  const submit = () => {
    const v = value.trim();
    if (v !== "") onSubmit(v);
  };

  return (
    <div className="help-overlay" onClick={onCancel}>
      <div className="help-card name-dialog" onClick={(e) => e.stopPropagation()}>
        <h2>{title}</h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label={title}
          />
          <div className="prop-actions">
            <button type="button" className="secondary" onClick={onCancel}>
              Cancel
            </button>
            <button type="submit" disabled={value.trim() === ""}>
              {submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
