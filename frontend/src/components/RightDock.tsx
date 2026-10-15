import type { ReactNode } from "react";

/**
 * Right dock (frontend/UI_OVERHAUL.md §3.1): tabs for the component
 * Inspector and the Watch panel. Both panels stay mounted — the inactive
 * one is `hidden` — so watch display modes and an open memory inspector
 * survive tab hops.
 */

export type DockTab = "inspector" | "watch";

const TABS: readonly { id: DockTab; label: string }[] = [
  { id: "inspector", label: "Inspector" },
  { id: "watch", label: "Watch" },
];

export default function RightDock({
  tab,
  onTab,
  inspector,
  watch,
}: {
  tab: DockTab;
  onTab: (tab: DockTab) => void;
  inspector: ReactNode;
  watch: ReactNode;
}) {
  return (
    <aside className="right-dock" aria-label="Details">
      <div className="dock-tabs" role="tablist" aria-label="Right dock">
        {TABS.map((t) => (
          <button
            key={t.id}
            id={`dock-tab-${t.id}`}
            role="tab"
            className={`dock-tab${tab === t.id ? " active" : ""}`}
            aria-selected={tab === t.id}
            aria-controls={`dock-panel-${t.id}`}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div
        id="dock-panel-inspector"
        role="tabpanel"
        aria-labelledby="dock-tab-inspector"
        className="dock-panel"
        hidden={tab !== "inspector"}
      >
        {inspector}
      </div>
      <div
        id="dock-panel-watch"
        role="tabpanel"
        aria-labelledby="dock-tab-watch"
        className="dock-panel"
        hidden={tab !== "watch"}
      >
        {watch}
      </div>
    </aside>
  );
}
