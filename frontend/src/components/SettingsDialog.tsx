import { PULSE_SPEEDS } from "../sim/pulses";
import { useEffect, useState } from "react";
import { bytesLabel } from "../lib/time";
import { ACCENTS, THEMES, type AccentId, type ThemeId } from "../theme";
import type { HistoryUsage } from "../model/versionStore";
import Select from "./Select";

/**
 * Settings panel (UI_OVERHAUL §25): a sectioned settings dialog — a nav
 * column on the left, that section's controls on the right, a footer with the
 * reset. Everything applies live and persists per machine (no Apply button);
 * the controls are plain rows so a section reads like a list of choices.
 *
 * Sections: Appearance, Canvas, Editing, Simulation, Autosave, Startup. Pure
 * presentation — all state lives in App.
 */

const SECTIONS = [
  { id: "appearance", label: "Appearance" },
  { id: "canvas", label: "Canvas" },
  { id: "editing", label: "Editing" },
  { id: "simulation", label: "Simulation" },
  { id: "autosave", label: "Autosave" },
  { id: "startup", label: "Startup" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

/** Select choices (kept small: these are sensible starter values). */
const BIT_CHOICES = [1, 2, 4, 8, 16, 32];
const INPUT_CHOICES = [2, 3, 4, 6, 8];
const HZ_CHOICES = [
  { exp: 0, label: "1 Hz" },
  { exp: 10, label: "10 Hz" },
  { exp: 20, label: "100 Hz" },
  { exp: 30, label: "1 kHz" },
];

export default function SettingsDialog({
  theme,
  accent,
  pulsesOn,
  gridOn,
  time24h,
  autosaveOn,
  autosaveFileOn,
  pulseSpeed,
  onPulseSpeed,
  showValues,
  showPerf,
  defaultBits,
  defaultInputs,
  pauseOnUnknown,
  defaultHz,
  updateCheckOn,
  historyUsage,
  onClearHistory,
  onTheme,
  onAccent,
  onPulses,
  onGrid,
  onTime24h,
  onAutosave,
  onAutosaveFile,
  onShowValues,
  onShowPerf,
  onDefaultBits,
  onDefaultInputs,
  onPauseOnUnknown,
  onDefaultHz,
  onUpdateCheck,
  onReset,
  onClose,
}: {
  theme: ThemeId;
  accent: AccentId;
  pulsesOn: boolean;
  gridOn: boolean;
  /** Timestamps: 24-hour (default) or `h:MM AM/PM`. */
  time24h: boolean;
  onTime24h: (v: boolean) => void;
  /** Autosave: crash-recovery copy + (named docs) periodic file write. */
  autosaveOn: boolean;
  /** Autosave rewrites the real `.csx` for named documents (default on). */
  autosaveFileOn: boolean;
  /** Pulse speed as a percentage (100 = normal, UI_OVERHAUL §70). */
  pulseSpeed: number;
  onPulseSpeed: (v: number) => void;
  showValues: boolean;
  showPerf: boolean;
  /** Bit width seeded on newly placed parts. */
  defaultBits: number;
  /** Gate input count seeded on newly placed gates. */
  defaultInputs: number;
  /** Show a memory part's clock pin on placement (§93). */
  pauseOnUnknown: boolean;
  /** Show a memory part's reset pin on placement (§93). */
  onPauseOnUnknown: (v: boolean) => void;
  /** Default clock-speed exponent (hz = 10^(exp/10)). */
  defaultHz: number;
  updateCheckOn: boolean;
  /** Version-history footprint, or null while it is loading. */
  historyUsage: HistoryUsage | null;
  onClearHistory: () => void;
  onTheme: (id: ThemeId) => void;
  onAccent: (id: AccentId) => void;
  onPulses: (v: boolean) => void;
  onGrid: (v: boolean) => void;
  onAutosave: (v: boolean) => void;
  onAutosaveFile: (v: boolean) => void;
  onShowValues: (v: boolean) => void;
  onShowPerf: (v: boolean) => void;
  onDefaultBits: (v: number) => void;
  onDefaultInputs: (v: number) => void;

  onDefaultHz: (v: number) => void;
  onUpdateCheck: (v: boolean) => void;
  /** Back to the shipped defaults (theme, accent, toggles). */
  onReset: () => void;
  onClose: () => void;
}) {
  const [section, setSection] = useState<SectionId>("appearance");

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

  const toggle = (
    label: string,
    hint: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    disabled = false,
  ): JSX.Element => (
    <label className="settings-toggle">
      <span className="settings-toggle-label">
        {label}
        <span className="settings-hint">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );

  const choose = (
    label: string,
    hint: string,
    value: number,
    choices: { value: number; label: string }[],
    onPick: (v: number) => void,
  ): JSX.Element => (
    <div className="settings-row">
      <span className="settings-row-label">
        {label}
        <span className="settings-hint">{hint}</span>
      </span>
      <Select label={label} value={value} options={choices} onChange={onPick} />
    </div>
  );

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onClick={onClose}
    >
      <div className="settings-card settings-panel" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>Settings</h2>
          <button className="settings-close" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="settings-body">
          <nav className="settings-nav" role="tablist" aria-label="Settings sections">
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                role="tab"
                aria-selected={section === s.id}
                className={`settings-nav-btn${section === s.id ? " active" : ""}`}
                onClick={() => setSection(s.id)}
              >
                {s.label}
              </button>
            ))}
          </nav>

          <div className="settings-pane" role="tabpanel" aria-label={section}>
            {section === "appearance" && (
              <>
                <section className="settings-section">
                  <h3>Theme</h3>
                  <p className="settings-hint">
                    Applies instantly and is remembered on this machine.
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
                                background:
                                  "linear-gradient(90deg, var(--accent) 50%, var(--grid) 50%)",
                              }
                        }
                        onClick={() => onAccent(a.id)}
                      >
                        {accent === a.id ? "✓" : ""}
                      </button>
                    ))}
                  </div>
                  {toggle(
                    "24-hour clock",
                    "Timestamps read 14:32; turn this off for 2:32 PM.",
                    time24h,
                    onTime24h,
                  )}
                </section>
              </>
            )}

            {section === "canvas" && (
              <section className="settings-section">
                <h3>Canvas</h3>
                {toggle(
                  "Show grid",
                  "Coarse groups of cells that stay evenly spaced as you zoom.",
                  gridOn,
                  onGrid,
                )}
                {toggle(
                  "Show live values",
                  "Clocks, pins, registers and I/O read out their current value.",
                  showValues,
                  onShowValues,
                )}
                {choose(
                  "Pulse speed",
                  "How fast a value travels along a wire — longer is calmer.",
                  pulseSpeed,
                  PULSE_SPEEDS.map((s) => ({ value: s, label: s === 100 ? "Normal" : `${s}%` })),
                  onPulseSpeed,
                )}
                {toggle(
                  "Animate signal pulses",
                  "Values travelling along wires glow as the simulation runs.",
                  pulsesOn,
                  onPulses,
                )}
                {toggle(
                  "Show performance overlay",
                  "Frame rate and render time in the canvas corner.",
                  showPerf,
                  onShowPerf,
                )}
              </section>
            )}

            {section === "editing" && (
              <section className="settings-section">
                <h3>New components</h3>
                {choose(
                  "Default bit width",
                  "Seeded when you place a part that has a width.",
                  defaultBits,
                  BIT_CHOICES.map((b) => ({ value: b, label: `${b} bit${b === 1 ? "" : "s"}` })),
                  onDefaultBits,
                )}
                {choose(
                  "Default gate inputs",
                  "Seeded when you place an AND/OR/XOR family gate.",
                  defaultInputs,
                  INPUT_CHOICES.map((n) => ({ value: n, label: `${n} inputs` })),
                  onDefaultInputs,
                )}
                {toggle(
                  "Stop when a part reads an unknown value",
                  "A floating input reads as X (unknown) and the run carries on. On, the " +
                    "editor stops on the first one and names the part and pin — press play " +
                    "to continue from there.",
                  pauseOnUnknown,
                  onPauseOnUnknown,
                )}
              </section>
            )}

            {section === "simulation" && (
              <section className="settings-section">
                <h3>Transport</h3>
                {choose(
                  "Default clock speed",
                  "Where the speed slider starts (the transport bar owns it while running).",
                  defaultHz,
                  HZ_CHOICES.map((h) => ({ value: h.exp, label: h.label })),
                  onDefaultHz,
                )}
                <p className="settings-hint">
                  Everything else about running a circuit — play, tick, run-to, reset — lives in the
                  transport bar above the canvas.
                </p>
              </section>
            )}

            {section === "autosave" && (
              <section className="settings-section">
                <h3>Autosave</h3>
                {toggle(
                  "Autosave",
                  "Keeps a crash-recovery copy as you edit — the first change after a pause is written at once.",
                  autosaveOn,
                  onAutosave,
                )}
                {toggle(
                  "Also save the file automatically",
                  "Named files only, written atomically. Save As… is still available.",
                  autosaveFileOn,
                  onAutosaveFile,
                  !autosaveOn,
                )}
                <p className="settings-hint">
                  {historyUsage !== null
                    ? `Version history: ${bytesLabel(historyUsage.bytes)} across ${historyUsage.documents} file(s), kept on this machine per file path.`
                    : "Version history is kept on this machine, per file path."}
                </p>
                <button className="settings-action" onClick={onClearHistory}>
                  Clear this file's history
                </button>
              </section>
            )}

            {section === "startup" && (
              <section className="settings-section">
                <h3>Startup</h3>
                {toggle(
                  "Check for updates on launch",
                  "Asks GitHub once per launch; failures are silent.",
                  updateCheckOn,
                  onUpdateCheck,
                )}
              </section>
            )}
          </div>
        </div>

        <div className="settings-foot">
          <button onClick={onReset}>Reset to defaults</button>
          <span className="settings-hint">Preferences are stored on this machine</span>
        </div>
      </div>
    </div>
  );
}
