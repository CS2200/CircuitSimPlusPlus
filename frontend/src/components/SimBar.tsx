import { useEffect, useState, useSyncExternalStore } from "react";
import type { SimController } from "../sim/controller";
import type { CircuitDocument } from "../model/document";
import type { LoadError } from "../ipc/types";
import {
  CircuitIcon,
  CloseIcon,
  PauseIcon,
  PlayIcon,
  ResetIcon,
  StepIcon,
  WaveIcon,
} from "./icons";

/**
 * Slider notches at the "nice" clock values (slider exponents, where
 * hz = 10^(exp/10)): 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000 Hz. Decades get
 * a taller mark (UI_OVERHAUL §19).
 */
const SPEED_NOTCHES = [0, 3, 7, 10, 13, 17, 20, 23, 27, 30];
const DECADE_EXPS = new Set([0, 10, 20, 30]);

/**
 * Simulation transport bar (FRONTEND.md U5; restyled UI_OVERHAUL §94): play /
 * pause, step one tick, reset, run-to-cycle-N, the speed slider (log scale),
 * and the cycle / effective-Hz telemetry. Load errors and halts surface as a
 * banner under the header.
 *
 * Commands auto-load the current document into the core, and reload it when
 * the editor changed since the last load (the engine holds its own snapshot,
 * so edits are invisible to it until a command re-syncs).
 */
export default function SimBar({
  ctl,
  doc,
  onReset,
  pathOn,
  onTogglePath,
  hzExp,
  onHzExp,
  waveOpen = false,
  onToggleWave,
  onLocateError,
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
  /** The waveform viewer is showing (§96: its toggle lives here, beside Play). */
  waveOpen?: boolean;
  onToggleWave?: () => void;
  /** Jump to the part a load error names (§100); absent = no Fix buttons. */
  onLocateError?: (err: LoadError) => void;
}) {
  useSyncExternalStore(ctl.store.subscribe, ctl.store.getVersion.bind(ctl.store));
  const s = ctl.store;
  const [runTo, setRunTo] = useState("");
  const [cmdError, setCmdError] = useState<string | null>(null);
  const hz = Math.round(10 ** (hzExp / 10));
  const running = s.status?.running ?? false;
  /** Paused at a breakpoint — a stop, but not a failure (docs/ipc.md §3). */
  // A breakpoint and a floating read are both *pauses* (contract v1.4): the run carries on
  // when play is pressed again, so the bar offers that rather than looking stuck.
  const paused = s.halted?.reason === "breakpoint" || s.halted?.reason === "floating-read";

  const guard = (p: Promise<void>) => p.catch((e: unknown) => setCmdError(String(e)));

  const withLoadedDoc = async (cmd: () => Promise<void>) => {
    setCmdError(null);
    // Reloads when nothing is loaded *or* the editor changed since the last
    // load, so edits are never simulated against a stale snapshot.
    const ok = await ctl.resync(doc);
    if (!ok) return;
    await guard(cmd());
  };

  /**
   * One tick, force-stopping a running clock first. While playing, the play
   * thread owns the timeline, so a bare step would be a no-op — Ctrl+J after
   * Ctrl+K must stop the clock and then take its tick.
   */
  const stepOneTick = async () => {
    if (ctl.store.status?.running ?? false) await guard(ctl.pause());
    await withLoadedDoc(() => ctl.stepTick());
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
        void stepOneTick();
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

  /**
   * What the banner is saying, as one string: dismissing it (×) hides THAT
   * message only — a different problem, or the same one coming back after a
   * fix, shows again (UI_OVERHAUL §99).
   */
  const bannerKey = JSON.stringify([
    s.halted?.cycle,
    s.halted?.reason,
    s.halted?.details,
    s.loadErrors[0]?.message,
    s.loadErrors.length,
    cmdError,
    s.contendedNets.size,
  ]);
  const [dismissedBanner, setDismissedBanner] = useState<string | null>(null);
  const bannerUp =
    (s.halted !== null ||
      s.loadErrors.length > 0 ||
      cmdError !== null ||
      s.contendedNets.size > 0) &&
    dismissedBanner !== bannerKey;

  return (
    <>
      <div className={`simbar${running ? " running" : ""}`}>
        <div className="sim-group sim-transport">
          <button
            className="sim-play"
            aria-label={running ? "Pause" : "Run"}
            aria-pressed={running}
            title={running ? "Pause (Ctrl+K)" : "Run until a halt or a breakpoint (Ctrl+K)"}
            onClick={() => (running ? guard(ctl.pause()) : withLoadedDoc(() => ctl.play(hz)))}
          >
            {running ? <PauseIcon /> : <PlayIcon />}
          </button>
          {/* The accessible name stays the bare verb the keyboard help uses. */}
          <button
            className="sim-btn"
            aria-label="tick"
            title="Step one tick — half a clock cycle; stops the clock if running (Ctrl+J)"
            onClick={() => void stepOneTick()}
          >
            <StepIcon />
            <span className="sim-btn-label">Tick</span>
          </button>
          <button
            className="sim-btn"
            title="Reset: fresh engine state; memory autoload files re-apply (Ctrl+R)"
            onClick={() => void onReset()}
          >
            <ResetIcon />
            <span className="sim-btn-label">Reset</span>
          </button>
        </div>
        <div className="sim-group sim-runto">
          <input
            type="number"
            min={0}
            placeholder="cycle #"
            aria-label="Run to cycle"
            value={runTo}
            onChange={(e) => setRunTo(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && runTo !== "") {
                void withLoadedDoc(() => ctl.runUntil(Number(runTo)));
              }
            }}
          />
          <button
            className="sim-btn"
            disabled={runTo === ""}
            title="Run until the simulation reaches this cycle"
            onClick={() => withLoadedDoc(() => ctl.runUntil(Number(runTo)))}
          >
            Run to
          </button>
        </div>
        <label className="sim-group sim-speed" title={`Clock speed: ${hz.toLocaleString()} Hz`}>
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
            {/* The notch strip is inset by the thumb radius and the slider's
             *  thumb is a fixed 12px, so a notch at fraction f sits exactly
             *  where the thumb centre lands (UI_OVERHAUL §19). */}
            <span className="sim-notches">
              {SPEED_NOTCHES.map((exp) => (
                <span
                  key={exp}
                  className={`sim-notch${DECADE_EXPS.has(exp) ? " major" : ""}`}
                  style={{ left: `${((exp / 30) * 100).toFixed(3)}%` }}
                  title={`${Math.round(10 ** (exp / 10)).toLocaleString()} Hz`}
                />
              ))}
            </span>
          </span>
          <span className="sim-speed-value">{hz.toLocaleString()} Hz</span>
        </label>
        <span
          className={`sim-status${running ? " live" : ""}`}
          title={running ? "Running — the clock is advancing" : "Paused — the current cycle"}
        >
          <span className="sim-status-dot" aria-hidden="true" />
          {s.loaded ? (
            <>
              cycle {s.cycle}
              {running && s.status !== null && ` · ${s.status.eff_hz.toLocaleString()} Hz eff.`}
            </>
          ) : (
            "not loaded — any command loads the circuit"
          )}
        </span>
        {onToggleWave !== undefined && (
          // The trace is what a run PRODUCES, so its door sits with the run
          // controls, labelled — it used to be an unlabelled icon in the
          // header's top-right corner that nobody found (§96).
          <button
            className={`sim-wave${waveOpen ? " active" : ""}`}
            aria-label={waveOpen ? "Back to the circuit" : "Waveform viewer"}
            aria-pressed={waveOpen}
            title={
              waveOpen
                ? "Back to the circuit (Ctrl+Alt+W)"
                : "Waveform viewer — trace signals over time (Ctrl+Alt+W)"
            }
            onClick={onToggleWave}
          >
            {waveOpen ? <CircuitIcon /> : <WaveIcon />}
            <span className="sim-btn-label">{waveOpen ? "Circuit" : "Waveform"}</span>
          </button>
        )}
        {s.timing !== null && (
          <button
            className={`sim-tobs${pathOn ? " active" : ""}`}
            aria-pressed={pathOn}
            title="Observed critical path (DTA) — click to highlight it on the canvas"
            onClick={onTogglePath}
          >
            T_obs {s.timing.t_obs} ns
          </button>
        )}
      </div>
      {bannerUp && (
        <div className={`sim-banner${paused ? " breakpoint" : ""}`} role="alert">
          <button
            type="button"
            className="sim-banner-close"
            aria-label="Dismiss"
            title="Dismiss — it comes back if the problem changes"
            onClick={() => {
              setDismissedBanner(bannerKey);
              setCmdError(null);
            }}
          >
            <CloseIcon />
          </button>
          {s.halted !== null &&
            (paused ? (
              // A breakpoint is not a failure (docs/ipc.md §3): the run stopped
              // where it was asked to and the transport stays armed, so the
              // banner says what to do next rather than what went wrong.
              <span className="sim-breakpoint">
                ⏸ Breakpoint at cycle {s.halted.cycle} — {haltMessage(s.halted.details)}. Step or
                run to continue.
              </span>
            ) : (
              <span>
                ⛔ Halted at cycle {s.halted.cycle} — {s.halted.reason}: {s.halted.details}
              </span>
            ))}
          {s.loadErrors.length > 0 && (
            // Every problem, WHERE it is, and a way there (§100): the bare first
            // message gave no sheet, so a problem on another sheet looked like
            // one that refused to clear after the visible one was fixed.
            <div className="sim-load-errors">
              <span>
                ⛔ Load failed ({s.loadErrors.length}{" "}
                {s.loadErrors.length === 1 ? "error" : "errors"}) — it clears by itself once fixed:
              </span>
              <ul>
                {s.loadErrors.slice(0, 3).map((e, i) => (
                  <li key={i}>
                    <span className="sim-err-msg">{e.message}</span>
                    {e.circuit !== "" && <span className="sim-err-where"> on “{e.circuit}”</span>}
                    {onLocateError !== undefined && locatable(e) && (
                      <button
                        type="button"
                        className="sim-err-fix"
                        onClick={() => onLocateError(e)}
                        title="Go to the part this is about"
                      >
                        Fix
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {s.loadErrors.length > 3 && <span>…and {s.loadErrors.length - 3} more</span>}
            </div>
          )}
          {cmdError !== null && <span>⛔ {cmdError}</span>}
          {s.contendedNets.size > 0 && (
            <span className="sim-short" data-short-nets={s.contendedNets.size}>
              ⚠ Short circuit — {s.contendedNets.size} net
              {s.contendedNets.size === 1 ? "" : "s"} driven both high and low, so the value there
              is unknown (X). Two enabled drivers are fighting: the wire is highlighted in red.
            </span>
          )}
        </div>
      )}
    </>
  );
}

/** A load error the editor can point at: it names a component, by id or index. */
function locatable(e: LoadError): boolean {
  return e.comp_id !== undefined || /component '[^']+'/.test(e.message);
}

/**
 * A halt's message without the contract's `comp <id> pin "<pin>": ` prefix
 * (docs/ipc.md §5). The banner is a sentence, and the part it names is already
 * ringed on the canvas — the one place the id belongs is the console.
 */
function haltMessage(details: string): string {
  return details.replace(/^comp \d+ pin "[^"]*":\s*/, "");
}
