import { useState, useSyncExternalStore } from "react";
import { formatValue, type SimController, type ValueMode } from "../sim/controller";

/**
 * Watch panel (FRONTEND.md U5): named probes/registers (and memories —
 * their inspector is U6) with per-row display mode (unsigned/signed/hex,
 * DESIGN.md §7.1). Values stream from net_diffs via the SimStore.
 */
export default function WatchPanel({ ctl }: { ctl: SimController }) {
  useSyncExternalStore(ctl.store.subscribe, ctl.store.getVersion.bind(ctl.store));
  const [modes, setModes] = useState<ReadonlyMap<string, ValueMode>>(new Map());
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
        return (
          <div className="watch-row" key={n.name} data-watch={n.name}>
            <span className="watch-name" title={`${n.kind} (comp ${n.comp_id})`}>
              {n.name}
            </span>
            <span className={`watch-value${value === undefined ? " watch-unknown" : ""}`}>
              {n.kind === "ram" || n.kind === "rom" ? "(inspector: U6)" : formatValue(value, mode)}
            </span>
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
    </aside>
  );
}
