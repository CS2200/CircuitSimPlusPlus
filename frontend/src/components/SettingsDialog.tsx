import { useEffect } from "react";
import { ACCENTS, THEMES, type AccentId, type ThemeId } from "../theme";

/**
 * Settings dialog (top-bar revamp): Appearance (themes + accent color),
 * Canvas (signal-pulse animation / grid), Autosave (crash recovery + file
 * rewrite) and Startup (update check). Every switch applies live and persists
 * per machine — no Apply button.
 *
 * Pure presentation: all state lives in App.
 */
export default function SettingsDialog({
  theme,
  accent,
  pulsesOn,
  gridOn,
  autosaveOn,
  autosaveFileOn,
  updateCheckOn,
  onTheme,
  onAccent,
  onPulses,
  onGrid,
  onAutosave,
  onAutosaveFile,
  onUpdateCheck,
  onReset,
  onClose,
}: {
  theme: ThemeId;
  accent: AccentId;
  pulsesOn: boolean;
  /** Coarse canvas grid overlay (default off). */
  gridOn: boolean;
  /** Autosave: crash-recovery copy + (named docs) periodic file write. */
  autosaveOn: boolean;
  /** Autosave rewrites the real `.csx` for named documents (default on). */
  autosaveFileOn: boolean;
  updateCheckOn: boolean;
  onTheme: (id: ThemeId) => void;
  onAccent: (id: AccentId) => void;
  onPulses: (v: boolean) => void;
  onGrid: (v: boolean) => void;
  onAutosave: (v: boolean) => void;
  onAutosaveFile: (v: boolean) => void;
  onUpdateCheck: (v: boolean) => void;
  /** Back to the shipped defaults (theme, accent, toggles). */
  onReset: () => void;
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
          <h3>Theme</h3>
          <p className="settings-hint">Applies instantly and is remembered on this machine.</p>
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

        <section className="settings-section">
          <h3>Accent color</h3>
          <p className="settings-hint">Focus rings, selection and highlights.</p>
          <div className="accent-row" role="radiogroup" aria-label="Accent color">
            {ACCENTS.map((a) => (
              <button
                key={a.id}
                className={`accent-swatch${accent === a.id ? " active" : ""}`}
                data-accent-option={a.id}
                role="radio"
                aria-checked={accent === a.id}
                aria-label={a.name}
                title={a.name}
                style={
                  a.hex !== null
                    ? { background: a.hex, color: "rgba(255, 255, 255, 0.92)" }
                    : {
                        background: "linear-gradient(90deg, var(--accent) 50%, var(--grid) 50%)",
                      }
                }
                onClick={() => onAccent(a.id)}
              >
                {accent === a.id ? "✓" : ""}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3>Canvas</h3>
          <label className="settings-toggle">
            <span>Animate signal pulses</span>
            <input
              type="checkbox"
              checked={pulsesOn}
              onChange={(e) => onPulses(e.target.checked)}
            />
          </label>
          <label className="settings-toggle">
            <span>
              Show grid
              <span className="settings-hint">
                Coarse groups of cells that stay evenly spaced as you zoom.
              </span>
            </span>
            <input type="checkbox" checked={gridOn} onChange={(e) => onGrid(e.target.checked)} />
          </label>
        </section>

        <section className="settings-section">
          <h3>Autosave</h3>
          <label className="settings-toggle">
            <span>
              Autosave
              <span className="settings-hint">
                Keeps a crash-recovery copy 3 s after you stop editing.
              </span>
            </span>
            <input
              type="checkbox"
              checked={autosaveOn}
              onChange={(e) => onAutosave(e.target.checked)}
            />
          </label>
          <label className="settings-toggle">
            <span>
              Also save the file automatically
              <span className="settings-hint">
                Named files only, written atomically. Save As… is still available.
              </span>
            </span>
            <input
              type="checkbox"
              checked={autosaveFileOn}
              disabled={!autosaveOn}
              onChange={(e) => onAutosaveFile(e.target.checked)}
            />
          </label>
        </section>

        <section className="settings-section">
          <h3>Startup</h3>
          <label className="settings-toggle">
            <span>Check for updates on launch</span>
            <input
              type="checkbox"
              checked={updateCheckOn}
              onChange={(e) => onUpdateCheck(e.target.checked)}
            />
          </label>
        </section>

        <div className="settings-foot">
          <button onClick={onReset}>Reset to defaults</button>
          <span className="settings-hint">Preferences are stored on this machine</span>
        </div>
      </div>
    </div>
  );
}
