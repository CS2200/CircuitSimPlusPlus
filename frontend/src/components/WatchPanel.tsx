import { useState, useSyncExternalStore } from "react";
import { formatValue, type SimController, type ValueMode } from "../sim/controller";
import MemoryInspector from "./MemoryInspector";

/**
 * Watch panel (FRONTEND.md U5/U6): named probes/registers with per-row
 * display mode (unsigned/signed/hex, DESIGN.md §7.1); RAM/ROM rows open
 * the memory inspector. Values stream from net_diffs via the SimStore.
 */
export default function WatchPanel({ ctl }: { ctl: SimController }) {
  useSyncExternalStore(ctl.store.subscribe, ctl.store.getVersion.bind(ctl.store));
  const [modes, setModes] = useState<ReadonlyMap<string, ValueMode>>(new Map());
  const [inspect, setInspect] = useState<string | null>(null);
  const named = ctl.store.named;

  if (!ctl.store.loaded || named.length === 0) return null;

  const cycleMode = (name: string) => {
    const order: ValueMode[] = ["unsigned", "signed", "hex"];
    const cur = modes.get(name) ?? "hex";
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setModes(new Map(modes).set(name, next));
  };

  return (
    <aside className="watch-panel">
      <div className="palette-group-title">Watch</div>
      {named.map((n) => {
        const mode = modes.get(n.name) ?? "hex";
        const value = ctl.watchValue(n);
        const isMem = n.kind === "ram" || n.kind === "rom";
        return (
          <div className="watch-row" key={n.name} data-watch={n.name}>
            <span className="watch-name" title={`${n.kind} (comp ${n.comp_id})`}>
              {n.name}
            </span>
            {isMem ? (
              <button
                className="watch-value watch-mem"
                title="Open memory inspector"
                onClick={() => setInspect(inspect === n.name ? null : n.name)}
              >
                inspect…
              </button>
            ) : (
              <span className={`watch-value${value === undefined ? " watch-unknown" : ""}`}>
                {formatValue(value, mode)}
              </span>
            )}
            <button
              className="watch-mode"
              title="Display mode: unsigned / signed / hex"
              onClick={() => cycleMode(n.name)}
            >
              {mode === "unsigned" ? "u" : mode === "signed" ? "s" : "x"}
            </button>
          </div>
        );
      })}
      {inspect !== null && (
        <MemoryInspector ctl={ctl} name={inspect} onClose={() => setInspect(null)} />
      )}
    </aside>
  );
}
