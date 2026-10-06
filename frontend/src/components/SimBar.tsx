import { useState, useSyncExternalStore } from "react";
import type { SimController } from "../sim/controller";
import type { CircuitDocument } from "../model/document";
import type { SimMode } from "../ipc/types";

/**
 * Simulation transport bar (FRONTEND.md U5): play/pause, step tick/cycle,
 * run-to-cycle-N, speed slider (log scale), zero/delay mode toggle, plus
 * cycle/eff-Hz telemetry. Load errors and halts surface as banners.
 *
 * First command auto-loads the current document into the core; editing
 * afterwards makes the loaded sim stale until the next command reloads
 * (auto-reload-on-edit is a U6 refinement).
 */
export default function SimBar({ ctl, doc }: { ctl: SimController; doc: CircuitDocument }) {
  useSyncExternalStore(ctl.store.subscribe, ctl.store.getVersion.bind(ctl.store));
  const s = ctl.store;
  const [hzExp, setHzExp] = useState(10); // slider: hz = 10^(exp/10)
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
        <button
          className="secondary"
          title="Step one full clock cycle"
          onClick={() => withLoadedDoc(() => ctl.stepCycle())}
        >
          cycle
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
          <input
            type="range"
            min={0}
            max={60}
            value={hzExp}
            onChange={(e) => {
              const exp = Number(e.target.value);
              setHzExp(exp);
              if (running) void guard(ctl.play(Math.round(10 ** (exp / 10))));
            }}
          />
          <span>{hz.toLocaleString()} Hz</span>
        </label>
        <button
          className="secondary"
          title="Evaluation mode: zero-delay (fast/debug) vs delay-aware (teaching/grading)"
          onClick={() => withLoadedDoc(() => ctl.setMode(mode === "delay" ? "zero" : "delay"))}
        >
          {mode}
        </button>
        <span className="sim-status">
          {s.loaded ? (
            <>
              cycle {s.cycle}
              {running && s.status !== null && ` · ${s.status.eff_hz.toLocaleString()} Hz eff.`}
              {s.timing !== null && ` · T_obs ${s.timing.t_obs} ns`}
            </>
          ) : (
            "not loaded — any command loads the circuit"
          )}
        </span>
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
