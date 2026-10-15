import { useEffect } from "react";
import { THEMES, type ThemeId } from "../theme";

/**
 * Settings dialog (frontend/UI_OVERHAUL.md §2): today, the Appearance
 * section with the preconfigured theme picker. Selecting a card applies
 * live (the caller updates `data-theme` + persists) — no Apply button.
 *
 * Pure presentation: theme state lives in App.
 */
export default function SettingsDialog({
  theme,
  onTheme,
  onClose,
}: {
  theme: ThemeId;
  onTheme: (id: ThemeId) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div className="settings-card" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="settings-close" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>
        <section className="settings-section">
          <h3>Appearance</h3>
          <p className="settings-hint">
            Theme — applies instantly and is remembered on this machine.
          </p>
          <div className="theme-grid" role="radiogroup" aria-label="Theme">
            {THEMES.map((t) => (
              <button
                key={t.id}
                className={`theme-card${theme === t.id ? " active" : ""}`}
                data-theme-option={t.id}
                role="radio"
                aria-checked={theme === t.id}
                title={t.blurb}
                onClick={() => onTheme(t.id)}
              >
                <span className="theme-swatches" aria-hidden="true">
                  {t.swatches.map((c) => (
                    <span key={c} style={{ background: c }} />
                  ))}
                </span>
                <span className="theme-name">{t.name}</span>
                <span className="theme-blurb">{t.blurb}</span>
                {theme === t.id && (
                  <span className="theme-check" aria-hidden="true">
                    ✓
                  </span>
                )}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
