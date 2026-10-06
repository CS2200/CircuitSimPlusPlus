import { useEffect, useRef, useState } from "react";
import { Camera } from "../render/camera";
import { Canvas2DRenderer } from "../render/canvas2d";
import type { Rect } from "../render/geom";
import type { Viewport } from "../render/renderer";
import type { SceneDrawStats, StressScene } from "../render/stressScene";
import { FALLBACK_THEME, resolveTheme, type Theme } from "../render/theme";

/**
 * The one-React-component circuit canvas (DESIGN.md §7.1). React owns the
 * chrome around it; the canvas itself is an immediate-mode renderer driven
 * by a rAF loop. Camera/sim state lives in refs — pointer and sim traffic
 * must never re-render React (60 FPS target with 5k+ wires).
 *
 * Rendering is on-demand: frames are produced when the scene is animating
 * or when the camera/theme/size changed (dirty flag). `scene` is the U1
 * stress harness; U2+ swaps in the real document model with the same
 * culling → layer-batching → Renderer path.
 */

export interface BenchResult {
  frames: number;
  wallMs: number;
  rafFps: number;
  avgRenderMs: number;
  p95RenderMs: number;
  maxRenderMs: number;
}

interface BenchState {
  i: number;
  frames: number;
  bounds: Rect;
  renderTimes: number[];
  stamps: number[];
  resolve: (r: BenchResult) => void;
}

interface FrameSample {
  t: number;
  ms: number;
}

interface LastDraw {
  stats: SceneDrawStats;
  renderMs: number;
  paths: number;
  batches: number;
}

interface Overlay {
  fps: number | null;
  renderMs: number | null;
  draw: LastDraw | null;
}

export interface CircuitCanvasProps {
  scene: StressScene;
  themeName: string;
  animate?: boolean;
}

interface CircuitBenchWindow extends Window {
  __circuitBench?: (frames?: number) => Promise<BenchResult>;
  __circuitStats?: () => LastDraw | null;
}

const BASE_SCALE = 16; // CSS px per grid unit at zoom 1
const FRAME_SAMPLE_CAP = 240;

export default function CircuitCanvas({ scene, themeName, animate = true }: CircuitCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(new Camera(0, 0, BASE_SCALE));
  const viewportRef = useRef<Viewport>({ width: 1, height: 1, dpr: 1 });
  const themeRef = useRef<Theme | null>(null);
  const dirtyRef = useRef(true);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const framesRef = useRef<FrameSample[]>([]);
  const benchRef = useRef<BenchState | null>(null);
  const lastDrawRef = useRef<LastDraw | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({ fps: null, renderMs: null, draw: null });

  // Center the camera on the scene.
  useEffect(() => {
    const cam = cameraRef.current;
    cam.x = scene.bounds.x + scene.bounds.w / 2;
    cam.y = scene.bounds.y + scene.bounds.h / 2;
    cam.scale = BASE_SCALE;
    dirtyRef.current = true;
  }, [scene]);

  // Resolve CSS custom properties into the renderer theme.
  useEffect(() => {
    if (containerRef.current !== null) {
      themeRef.current = resolveTheme(containerRef.current);
    }
    dirtyRef.current = true;
  }, [themeName]);

  // Track container size × device pixel ratio.
  useEffect(() => {
    const el = containerRef.current;
    const canvas = canvasRef.current;
    if (el === null || canvas === null) return;
    const ro = new ResizeObserver(() => {
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(el.clientWidth * dpr));
      canvas.height = Math.max(1, Math.round(el.clientHeight * dpr));
      viewportRef.current = { width: el.clientWidth, height: el.clientHeight, dpr };
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The render loop.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d", { alpha: false });
    if (ctx == null) return;
    const renderer = new Canvas2DRenderer(ctx);
    let raf = 0;
    const frame = (tMs: number) => {
      raf = requestAnimationFrame(frame);
      const bench = benchRef.current;
      if (bench !== null) {
        applyBenchCamera(bench, cameraRef.current);
        dirtyRef.current = true;
      }
      if (!dirtyRef.current && !animate) return;
      dirtyRef.current = false;
      if (animate || bench !== null) scene.setTimeMs(tMs);

      const theme = themeRef.current ?? FALLBACK_THEME;
      const start = performance.now();
      renderer.beginFrame({
        camera: cameraRef.current,
        viewport: viewportRef.current,
        background: theme.bg,
      });
      const drawStats = scene.draw(renderer, theme, cameraRef.current, viewportRef.current);
      renderer.endFrame();
      const renderMs = performance.now() - start;

      const samples = framesRef.current;
      samples.push({ t: tMs, ms: renderMs });
      if (samples.length > FRAME_SAMPLE_CAP) samples.shift();
      lastDrawRef.current = {
        stats: drawStats,
        renderMs,
        paths: renderer.stats.paths,
        batches: renderer.stats.strokeBatches + renderer.stats.fillBatches,
      };

      if (bench !== null) {
        bench.stamps.push(tMs);
        bench.renderTimes.push(renderMs);
        bench.i++;
        if (bench.i >= bench.frames) {
          benchRef.current = null;
          bench.resolve(benchResult(bench));
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [scene, animate]);

  // Wheel zoom must be non-passive to preventDefault (page zoom/scroll).
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      cameraRef.current.zoomAt(
        { x: e.clientX - rect.left, y: e.clientY - rect.top },
        Math.exp(-e.deltaY * 0.0015),
        viewportRef.current,
      );
      dirtyRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, []);

  // Perf overlay, refreshed at 2 Hz.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const recent = framesRef.current.filter((f) => f.t >= now - 1000);
      const fps =
        recent.length > 1
          ? (1000 * (recent.length - 1)) / (recent[recent.length - 1].t - recent[0].t)
          : null;
      const renderMs =
        recent.length > 0 ? recent.reduce((acc, f) => acc + f.ms, 0) / recent.length : null;
      setOverlay({ fps, renderMs, draw: lastDrawRef.current });
    }, 500);
    return () => clearInterval(id);
  }, []);

  // DEV-only benchmark/debug hooks (used by e2e/renderer.spec.ts and humans).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as CircuitBenchWindow;
    w.__circuitBench = (frames = 600) =>
      new Promise<BenchResult>((resolve) => {
        benchRef.current = {
          i: 0,
          frames,
          bounds: scene.bounds,
          renderTimes: [],
          stamps: [],
          resolve,
        };
      });
    w.__circuitStats = () => lastDrawRef.current;
    return () => {
      delete w.__circuitBench;
      delete w.__circuitStats;
    };
  }, [scene]);

  return (
    <div ref={containerRef} className="canvas-host">
      <canvas
        ref={canvasRef}
        className="circuit-canvas"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          dragRef.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerMove={(e) => {
          const drag = dragRef.current;
          if (drag === null) return;
          cameraRef.current.panByScreen(e.clientX - drag.x, e.clientY - drag.y);
          drag.x = e.clientX;
          drag.y = e.clientY;
          dirtyRef.current = true;
        }}
        onPointerUp={(e) => {
          dragRef.current = null;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      <div className="canvas-overlay">
        {overlay.fps === null
          ? "idle"
          : `${overlay.fps.toFixed(0)} fps · ${overlay.renderMs?.toFixed(2)} ms/frame`}
        {overlay.draw !== null &&
          ` · wires ${overlay.draw.stats.visibleWires}/${scene.wires.length}` +
            ` · comps ${overlay.draw.stats.visibleComponents}/${scene.components.length}` +
            ` · paths ${overlay.draw.paths} · batches ${overlay.draw.batches}`}
      </div>
    </div>
  );
}

/** Scripted camera for the benchmark: sweep the scene with a zoom wobble. */
function applyBenchCamera(bench: BenchState, cam: Camera): void {
  const k = bench.i / bench.frames;
  const b = bench.bounds;
  cam.x = b.x + b.w * k;
  cam.y = b.y + b.h / 2 + Math.sin(k * Math.PI * 4) * b.h * 0.3;
  cam.scale = 4 + 18 * (0.5 - 0.5 * Math.cos(k * Math.PI * 6));
}

function benchResult(bench: BenchState): BenchResult {
  const wallMs = bench.stamps[bench.stamps.length - 1] - bench.stamps[0];
  const sorted = [...bench.renderTimes].sort((a, b) => a - b);
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  return {
    frames: bench.frames,
    wallMs,
    rafFps: (1000 * (bench.frames - 1)) / wallMs,
    avgRenderMs: avg,
    p95RenderMs: sorted[Math.floor(sorted.length * 0.95)],
    maxRenderMs: sorted[sorted.length - 1],
  };
}
