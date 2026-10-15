import { useEffect, useState, useSyncExternalStore } from "react";
import type { SimController } from "../sim/controller";
import type { CircuitDocument } from "../model/document";
import type { SimMode } from "../ipc/types";

/**
 * Slider notches at the "nice" clock values (slider exponents, where
 * hz = 10^(exp/10)): 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000 Hz. Decades get
 * a taller mark (UI_OVERHAUL §15).
 */
const SPEED_NOTCHES = [0, 3, 7, 10, 13, 17, 20, 23, 27, 30];
const DECADE_EXPS = new Set([0, 10, 20, 30]);

/**
 * Simulation transport bar (FRONTEND.md U5): play/pause, step tick/cycle,
 * run-to-cycle-N, speed slider (log scale), zero/delay mode toggle, plus
 * cycle/eff-Hz telemetry. Load errors and halts surface as banners.
 *
 * First command auto-loads the current document into the core; editing
 * afterwards makes the loaded sim stale until the next command reloads
 * (auto-reload-on-edit is a U6 refinement).
 */
export default function SimBar({
  ctl,
  doc,
  onReset,
  pathOn,
  onTogglePath,
  hzExp,
  onHzExp,
}: {
  ctl: SimController;
  doc: CircuitDocument;
  /** Reset = engine reset + autoload re-applies (DESIGN.md §5.2). */
  onReset: () => Promise<void>;
  /** Critical-path highlight toggle state (U7). */
  pathOn: boolean;
  onTogglePath: () => void;
  /** Speed slider exponent (hz = 10^(exp/10)); lifted to App so the
   *  Simulation menu's speed presets share the same state. */
  hzExp: number;
  onHzExp: (exp: number) => void;
}) {
  useSyncExternalStore(ctl.store.subscribe, ctl.store.getVersion.bind(ctl.store));
  const s = ctl.store;
  const [runTo, setRunTo] = useState("");
  const [cmdError, setCmdError] = useState<string | null>(null);
  const hz = Math.round(10 ** (hzExp / 10));
  const running = s.status?.running ?? false;

  const guard = (p: Promise<void>) => p.catch((e: unknown) => setCmdError(String(e)));

  const withLoadedDoc = async (cmd: () => Promise<void>) => {
    setCmdError(null);
    if (!ctl.store.loaded) {
      const ok = await ctl.load(doc);
      if (!ok) return;
    }
    await guard(cmd());
  };

  // Sim keyboard map (UX decision): Ctrl+J step one tick, Ctrl+R reset,
  // Ctrl+K run (until halt) / pause. Handled here so they work regardless
  // of canvas focus; text fields are left alone.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      const target = e.target as HTMLElement | null;
      if (target !== null && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const key = e.key.toLowerCase();
      if (key === "j") {
        e.preventDefault();
        void withLoadedDoc(() => ctl.stepTick());
      } else if (key === "r") {
        e.preventDefault(); // not the browser reload
        void onReset();
      } else if (key === "k") {
        e.preventDefault();
        if (ctl.store.status?.running ?? false) void guard(ctl.pause());
        else void withLoadedDoc(() => ctl.play(hz));
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctl, doc, hz, onReset]);

  const mode: SimMode = s.status?.mode ?? "delay";

  return (
    <>
      <div className="simbar">
        <button
          className="sim-play"
          title={running ? "Pause" : "Run"}
          onClick={() => (running ? guard(ctl.pause()) : withLoadedDoc(() => ctl.play(hz)))}
        >
          {running ? "⏸" : "⏵"}
        </button>
        <button
          className="secondary"
          title="Step one tick (half clock cycle)"
          onClick={() => withLoadedDoc(() => ctl.stepTick())}
        >
          tick
        </button>
        <span className="sim-runto">
          <input
            type="number"
            min={0}
            placeholder="cycle N"
            value={runTo}
            onChange={(e) => setRunTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && runTo !== "") {
                void withLoadedDoc(() => ctl.runUntil(Number(runTo)));
              }
            }}
          />
          <button
            className="secondary"
            disabled={runTo === ""}
            onClick={() => withLoadedDoc(() => ctl.runUntil(Number(runTo)))}
          >
            run to
          </button>
        </span>
        <label className="sim-speed" title={`Clock speed: ${hz.toLocaleString()} Hz`}>
          <span className="sim-speed-slider">
            <input
              type="range"
              min={0}
              max={30}
              step={1}
              value={hzExp}
              aria-label="Clock speed"
              onChange={(e) => {
                const exp = Number(e.target.value);
                onHzExp(exp);
                if (running) void guard(ctl.play(Math.round(10 ** (exp / 10))));
              }}
            />
            <span className="sim-notches">
              {SPEED_NOTCHES.map((exp) => (
                <span
                  key={exp}
                  className={`sim-notch${DECADE_EXPS.has(exp) ? " major" : ""}`}
                  style={{ left: `${(exp / 30) * 100}%` }}
                  title={`${Math.round(10 ** (exp / 10)).toLocaleString()} Hz`}
                />
              ))}
            </span>
          </span>
          <span className="sim-speed-value">{hz.toLocaleString()} Hz</span>
        </label>
        <button
          className="secondary"
          title="Reset: fresh engine state; memory autoload files re-apply (§5.2)"
          onClick={() => void onReset()}
        >
          reset
        </button>
        <span className="sim-status">
          {s.loaded ? (
            <>
              cycle {s.cycle} ·{" "}
              <button
                className="sim-mode"
                title={`Simulation mode: ${mode} — click for ${
                  mode === "delay" ? "zero-delay" : "delay-aware"
                }`}
                onClick={() =>
                  void withLoadedDoc(() => ctl.setMode(mode === "delay" ? "zero" : "delay"))
                }
              >
                {mode}
              </button>
              {running && s.status !== null && ` · ${s.status.eff_hz.toLocaleString()} Hz eff.`}
            </>
          ) : (
            "not loaded — any command loads the circuit"
          )}
        </span>
        {s.timing !== null && (
          <button
            className={`sim-tobs${pathOn ? " active" : ""}`}
            title={
              s.timing.violations.length > 0
                ? `Observed critical path (DTA) — click to highlight. Setup/hold: ${s.timing.violations
                    .map((v) => `${v.kind} @ comp ${v.comp_id} (${v.circuit})`)
                    .join(", ")}`
                : "Observed critical path (DTA) — click to highlight it on the canvas"
            }
            onClick={onTogglePath}
          >
            T_obs {s.timing.t_obs} ns
            {s.timing.violations.length > 0 && (
              <span className="sim-violations">
                {" "}
                · ⚠ {s.timing.violations.length} violation
                {s.timing.violations.length === 1 ? "" : "s"}
              </span>
            )}
          </button>
        )}
      </div>
      {(s.halted !== null || s.loadErrors.length > 0 || cmdError !== null) && (
        <div className="sim-banner" role="alert">
          {s.halted !== null && (
            <span>
              ⛔ Halted at cycle {s.halted.cycle} — {s.halted.reason}: {s.halted.details}
            </span>
          )}
          {s.loadErrors.length > 0 && (
            <span>
              ⛔ Load failed ({s.loadErrors.length} {s.loadErrors.length === 1 ? "error" : "errors"}
              ): {s.loadErrors[0].message}
            </span>
          )}
          {cmdError !== null && <span>⛔ {cmdError}</span>}
        </div>
      )}
    </>
  );
}
