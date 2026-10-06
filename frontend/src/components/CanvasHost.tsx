import { useEffect, useRef, useState, type ReactNode } from "react";
import { Camera } from "../render/camera";
import { Canvas2DRenderer } from "../render/canvas2d";
import type { Rect, Vec2 } from "../render/geom";
import type { Viewport } from "../render/renderer";
import { FALLBACK_THEME, resolveTheme, type Theme } from "../render/theme";

/**
 * CanvasHost — the shared plumbing for every full-canvas view (editor,
 * stress harness): one <canvas>, a pan/zoom camera, a dpr-aware resize
 * observer, an on-demand rAF render loop (dirty-flag; `animate` forces
 * every frame), a 2 Hz perf overlay, and pointer plumbing that translates
 * DOM events into WORLD coordinates for the scene's tool handlers.
 *
 * Pan: middle-drag, or Space + left-drag. Zoom: wheel (anchored at cursor).
 * Left/right clicks and hovers go to the scene handlers.
 *
 * React never re-renders on the 60 FPS path — camera/viewport/sim-adjacent
 * state lives in refs; `revision` is the external "model changed" signal.
 */

export interface PointerInfo {
  button: number;
  buttons: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export interface CanvasHostProps {
  /** Draw one frame (cull → layer-batch → renderer). Must be cheap to swap: kept in a ref. */
  draw: (
    renderer: Canvas2DRenderer,
    camera: Camera,
    view: Viewport,
    theme: Theme,
    tMs: number,
  ) => void;
  /** Redraw every frame (animations); otherwise redraw on dirty only. */
  animate?: boolean;
  /** External dirty signal — bump when the underlying model changed. */
  revision?: number;
  themeName?: string;
  /** World-space bounds used to center the camera initially and for the bench sweep. */
  sceneBounds?: Rect;
  /** Install the DEV `__circuitBench(frames)` hook (scripted camera sweep + render timing). */
  bench?: boolean;
  onPointerDown?: (world: Vec2, info: PointerInfo) => void;
  onPointerMove?: (world: Vec2, info: PointerInfo) => void;
  onPointerUp?: (world: Vec2, info: PointerInfo) => void;
  onDoubleClick?: (world: Vec2, info: PointerInfo) => void;
  /** Pointer moved with no buttons pressed (ghost tracking, cursor readout). */
  onHover?: (world: Vec2) => void;
  /** HTML5 drop (palette drag-in), translated to world coords. */
  onDropWorld?: (world: Vec2, e: React.DragEvent) => void;
  /** Extra content in the perf overlay. */
  overlayExtra?: ReactNode;
}

interface BenchState {
  i: number;
  frames: number;
  bounds: Rect;
  renderTimes: number[];
  stamps: number[];
  resolve: (r: BenchResult) => void;
}

export interface BenchResult {
  frames: number;
  wallMs: number;
  rafFps: number;
  avgRenderMs: number;
  p95RenderMs: number;
  maxRenderMs: number;
}

interface FrameSample {
  t: number;
  ms: number;
}

interface CircuitBenchWindow extends Window {
  __circuitBench?: (frames?: number) => Promise<BenchResult>;
}

const BASE_SCALE = 16;
const FRAME_SAMPLE_CAP = 240;

export default function CanvasHost({
  draw,
  animate = false,
  revision = 0,
  themeName = "dark",
  sceneBounds,
  bench = false,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onDoubleClick,
  onHover,
  onDropWorld,
  overlayExtra,
}: CanvasHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraRef = useRef(new Camera(0, 0, BASE_SCALE));
  const viewportRef = useRef<Viewport>({ width: 1, height: 1, dpr: 1 });
  const themeRef = useRef<Theme | null>(null);
  const dirtyRef = useRef(true);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const panRef = useRef<{ x: number; y: number } | null>(null);
  const spaceRef = useRef(false);
  const framesRef = useRef<FrameSample[]>([]);
  const benchRef = useRef<BenchState | null>(null);
  const lastRenderMsRef = useRef<number | null>(null);
  const [fpsText, setFpsText] = useState<string>("idle");

  // Center the camera on the scene bounds.
  useEffect(() => {
    if (sceneBounds === undefined) return;
    const cam = cameraRef.current;
    cam.x = sceneBounds.x + sceneBounds.w / 2;
    cam.y = sceneBounds.y + sceneBounds.h / 2;
    cam.scale = BASE_SCALE;
    dirtyRef.current = true;
  }, [sceneBounds]);

  // Theme resolution.
  useEffect(() => {
    if (containerRef.current !== null) themeRef.current = resolveTheme(containerRef.current);
    dirtyRef.current = true;
  }, [themeName]);

  // External dirty signal.
  useEffect(() => {
    dirtyRef.current = true;
  }, [revision]);

  // Size tracking.
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

  // Render loop.
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d", { alpha: false });
    if (ctx == null) return;
    const renderer = new Canvas2DRenderer(ctx);
    let raf = 0;
    const frame = (tMs: number) => {
      raf = requestAnimationFrame(frame);
      const benchState = benchRef.current;
      if (benchState !== null) {
        applyBenchCamera(benchState, cameraRef.current);
        dirtyRef.current = true;
      }
      if (!dirtyRef.current && !animate) return;
      dirtyRef.current = false;

      const theme = themeRef.current ?? FALLBACK_THEME;
      const start = performance.now();
      renderer.beginFrame({
        camera: cameraRef.current,
        viewport: viewportRef.current,
        background: theme.bg,
      });
      drawRef.current(renderer, cameraRef.current, viewportRef.current, theme, tMs);
      renderer.endFrame();
      const renderMs = performance.now() - start;
      lastRenderMsRef.current = renderMs;

      const samples = framesRef.current;
      samples.push({ t: tMs, ms: renderMs });
      if (samples.length > FRAME_SAMPLE_CAP) samples.shift();

      if (benchState !== null) {
        benchState.stamps.push(tMs);
        benchState.renderTimes.push(renderMs);
        benchState.i++;
        if (benchState.i >= benchState.frames) {
          benchRef.current = null;
          benchState.resolve(benchResult(benchState));
        }
      }
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [animate]);

  // Wheel zoom (non-passive to preventDefault).
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

  // Space held = pan mode (with left button).
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code === "Space" && (e.target === document.body || e.target === canvasRef.current)) {
        spaceRef.current = true;
        e.preventDefault();
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === "Space") spaceRef.current = false;
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Perf overlay at 2 Hz.
  useEffect(() => {
    const id = setInterval(() => {
      const now = performance.now();
      const recent = framesRef.current.filter((f) => f.t >= now - 1000);
      if (recent.length > 1) {
        const fps = (1000 * (recent.length - 1)) / (recent[recent.length - 1].t - recent[0].t);
        const ms = recent.reduce((acc, f) => acc + f.ms, 0) / recent.length;
        setFpsText(`${fps.toFixed(0)} fps · ${ms.toFixed(2)} ms/frame`);
      } else {
        setFpsText("idle");
      }
    }, 500);
    return () => clearInterval(id);
  }, []);

  // DEV bench hook.
  useEffect(() => {
    if (!import.meta.env.DEV || !bench || sceneBounds === undefined) return;
    const w = window as unknown as CircuitBenchWindow;
    w.__circuitBench = (frames = 600) =>
      new Promise<BenchResult>((resolve) => {
        benchRef.current = {
          i: 0,
          frames,
          bounds: sceneBounds,
          renderTimes: [],
          stamps: [],
          resolve,
        };
      });
    return () => {
      delete w.__circuitBench;
    };
  }, [bench, sceneBounds]);

  // DEV camera hook (e2e world→screen mapping).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const w = window as unknown as {
      __circuitCamera?: () => { x: number; y: number; scale: number };
    };
    w.__circuitCamera = () => {
      const c = cameraRef.current;
      return { x: c.x, y: c.y, scale: c.scale };
    };
    return () => {
      delete w.__circuitCamera;
    };
  }, []);

  /** Minimal mouse-ish shape both PointerEvent and MouseEvent satisfy. */
  interface CanvasMouse {
    clientX: number;
    clientY: number;
    button: number;
    buttons: number;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
  }

  const worldOf = (e: CanvasMouse): Vec2 => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return cameraRef.current.screenToWorld(
      { x: e.clientX - rect.left, y: e.clientY - rect.top },
      viewportRef.current,
    );
  };

  const infoOf = (e: CanvasMouse): PointerInfo => ({
    button: e.button,
    buttons: e.buttons,
    shiftKey: e.shiftKey,
    ctrlKey: e.ctrlKey,
    altKey: e.altKey,
  });

  return (
    <div
      ref={containerRef}
      className="canvas-host"
      onDragOver={(e) => {
        if (onDropWorld !== undefined) e.preventDefault();
      }}
      onDrop={(e) => {
        if (onDropWorld === undefined) return;
        e.preventDefault();
        const rect = canvasRef.current!.getBoundingClientRect();
        onDropWorld(
          cameraRef.current.screenToWorld(
            { x: e.clientX - rect.left, y: e.clientY - rect.top },
            viewportRef.current,
          ),
          e,
        );
      }}
    >
      <canvas
        ref={canvasRef}
        className="circuit-canvas"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
            panRef.current = { x: e.clientX, y: e.clientY };
            return;
          }
          onPointerDown?.(worldOf(e), infoOf(e));
        }}
        onPointerMove={(e) => {
          const pan = panRef.current;
          if (pan !== null) {
            cameraRef.current.panByScreen(e.clientX - pan.x, e.clientY - pan.y);
            pan.x = e.clientX;
            pan.y = e.clientY;
            dirtyRef.current = true;
            return;
          }
          const world = worldOf(e);
          if (e.buttons === 0) onHover?.(world);
          else onPointerMove?.(world, infoOf(e));
        }}
        onPointerUp={(e) => {
          e.currentTarget.releasePointerCapture(e.pointerId);
          if (panRef.current !== null) {
            panRef.current = null;
            return;
          }
          onPointerUp?.(worldOf(e), infoOf(e));
        }}
        onDoubleClick={(e) => {
          onDoubleClick?.(worldOf(e), infoOf(e));
        }}
      />
      <div className="canvas-overlay">
        {fpsText}
        {overlayExtra}
      </div>
    </div>
  );
}

/** Scripted camera for the benchmark: sweep the bounds with a zoom wobble. */
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
