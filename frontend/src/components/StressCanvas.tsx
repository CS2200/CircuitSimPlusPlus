import { useCallback, useEffect, useMemo, useRef } from "react";
import CanvasHost, { type CanvasHostProps } from "./CanvasHost";
import type { SceneDrawStats, StressScene } from "../render/stressScene";

/**
 * The U1 stress-scene harness on CanvasHost plumbing (dev/perf tool,
 * reachable via ?stress=1). Installs the __circuitStats debug hook the
 * renderer e2e spec reads.
 */

interface CircuitStatsWindow extends Window {
  __circuitStats?: () => { stats: SceneDrawStats } | null;
}

export default function StressCanvas({
  scene,
  themeName,
  animate,
}: {
  scene: StressScene;
  themeName: string;
  animate: boolean;
}) {
  const lastDrawRef = useRef<{ stats: SceneDrawStats } | null>(null);

  const draw = useCallback<CanvasHostProps["draw"]>(
    (renderer, camera, view, theme, tMs) => {
      scene.setTimeMs(tMs);
      const stats = scene.draw(renderer, theme, camera, view);
      lastDrawRef.current = { stats };
    },
    [scene],
  );

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as CircuitStatsWindow;
    w.__circuitStats = () => lastDrawRef.current;
    return () => {
      delete w.__circuitStats;
    };
  }, []);

  const bounds = useMemo(() => scene.bounds, [scene]);
  return (
    <CanvasHost
      draw={draw}
      animate={animate}
      themeName={themeName}
      sceneBounds={bounds}
      bench
      overlayExtra={` · wires ${scene.wires.length} · comps ${scene.components.length}`}
    />
  );
}
