import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Camera } from "../render/camera";
import { Canvas2DRenderer } from "../render/canvas2d";
import type { Rect, Vec2 } from "../render/geom";
import type { Viewport } from "../render/renderer";
import { FALLBACK_THEME, resolveTheme, type Theme } from "../render/theme";
import { gridStepFor } from "../editor/docScene";

/**
 * CanvasHost — the shared plumbing for every full-canvas view (editor,
 * stress harness): one <canvas>, a pan/zoom camera, a dpr-aware resize
 * observer, an on-demand rAF render loop (dirty-flag; `animate` forces
 * every frame), a 2 Hz perf overlay, and pointer plumbing that translates
 * DOM events into WORLD coordinates for the scene's tool handlers.
 *
 * Pan (UI_OVERHAUL.md §1): middle-drag, Space+left-drag, right-drag, and
 * Shift+left-drag. The two "click-or-pan" buttons (right, Shift+left) are
 * disambiguated by a small movement threshold: a press that never moves is
 * delivered to the scene as a click (synthesized down(+up) for Shift+left,
 * down for right), a press that moves pans the camera instead — so
 * right-click cancel/subcircuit-jump and Shift+click keep their meaning.
 * Zoom: wheel (anchored at cursor).
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
  /** Show the frame-rate overlay in the corner (Settings → Canvas). */
  showPerf?: boolean;
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

/** Screen-px movement before a right / Shift+left press becomes a pan. */
const PAN_THRESHOLD_PX = 4;

/** A press held back until it's known to be a click, not a pan. */
interface PendingPan {
  x: number;
  y: number;
  /** The mouse button of the press (2 = right, 0 = left). */
  button: number;
}

export default function CanvasHost({
  draw,
  animate = false,
  showPerf = false,
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
  const pendingRef = useRef<PendingPan | null>(null);
  const spaceRef = useRef(false);
  const framesRef = useRef<FrameSample[]>([]);
  const benchRef = useRef<BenchState | null>(null);
  const lastRenderMsRef = useRef<number | null>(null);
  const [fpsText, setFpsText] = useState<string>("idle");
  const alignTimerRef = useRef<number | null>(null);
  const seenSizeRef = useRef(false);

  /**
   * Snap the camera so the canvas's top-left corner lies on a grid line
   * (UI_OVERHAUL §41). Skipped when the nudge would be more than ~8 px, so a
   * pan/zoom at high magnification never lurches; parts stay on the grid either
   * way (they share the camera transform).
   */
  const alignToGrid = useCallback((): void => {
    const cam = cameraRef.current;
    const beforeX = cam.x;
    const beforeY = cam.y;
    cam.alignToGrid(viewportRef.current, gridStepFor(cam.scale));
    if (Math.hypot(cam.x - beforeX, cam.y - beforeY) * cam.scale > 8) {
      cam.x = beforeX;
      cam.y = beforeY;
      return;
    }
    dirtyRef.current = true;
  }, []);

  /** Align once the wheel settles (zooming changes the edge's grid phase). */
  const scheduleAlign = useCallback((): void => {
    if (alignTimerRef.current !== null) window.clearTimeout(alignTimerRef.current);
    alignTimerRef.current = window.setTimeout(() => {
      alignTimerRef.current = null;
      alignToGrid();
    }, 160);
  }, [alignToGrid]);

  // Center the camera on the scene bounds.
  useEffect(() => {
    if (sceneBounds === undefined) return;
    const cam = cameraRef.current;
    cam.x = sceneBounds.x + sceneBounds.w / 2;
    cam.y = sceneBounds.y + sceneBounds.h / 2;
    cam.scale = BASE_SCALE;
    alignToGrid();
    dirtyRef.current = true;
  }, [sceneBounds, alignToGrid]);

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
      // Use the FRACTIONAL layout size (getBoundingClientRect) and the ACTUAL
      // backing/CSS ratio. `clientWidth` rounds to an integer and
      // `devicePixelRatio` is nominal, so on fractional DPRs (Windows 125%/150%)
      // the transform scaled the drawing off the real CSS box — the grid landed
      // a fraction of a pixel away from the chrome that shares its edge
      // (UI_OVERHAUL §37).
      const rect = el.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(w * dpr));
      canvas.height = Math.max(1, Math.round(h * dpr));
      viewportRef.current = { width: w, height: h, dpr: canvas.width / w };
      // Align immediately on the first sizing (so the initial view is flush),
      // but debounce later resizes — aligning mid-drag would jitter the content
      // as the dock is resized (UI_OVERHAUL §41).
      if (!seenSizeRef.current) {
        seenSizeRef.current = true;
        alignToGrid();
      } else {
        scheduleAlign();
      }
      dirtyRef.current = true;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [alignToGrid, scheduleAlign]);

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
      scheduleAlign();
      dirtyRef.current = true;
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [scheduleAlign]);

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
        onContextMenu={(e) => e.preventDefault()}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          if (e.button === 1 || (e.button === 0 && spaceRef.current)) {
            panRef.current = { x: e.clientX, y: e.clientY };
            return;
          }
          // Right-drag and Shift+left-drag PAN (UI_OVERHAUL §1): hold the
          // press back until we know it isn't a drag. Released without
          // movement, the scene gets a synthesized click, so right-click
          // cancel / subcircuit jump and Shift+click keep working.
          if (e.button === 2 || (e.button === 0 && e.shiftKey && !e.ctrlKey && !e.metaKey)) {
            pendingRef.current = { x: e.clientX, y: e.clientY, button: e.button };
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
          const pending = pendingRef.current;
          if (pending !== null) {
            const dx = e.clientX - pending.x;
            const dy = e.clientY - pending.y;
            if (Math.hypot(dx, dy) >= PAN_THRESHOLD_PX) {
              // Pan by the full press delta so content tracks the cursor
              // from the press point (the threshold only gates intent).
              pendingRef.current = null;
              cameraRef.current.panByScreen(dx, dy);
              panRef.current = { x: e.clientX, y: e.clientY };
              dirtyRef.current = true;
            }
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
            alignToGrid();
            return;
          }
          const pending = pendingRef.current;
          if (pending !== null) {
            // Never moved: this was a click, not a pan. Deliver it whole
            // (left: down+up; right: down only — up is a no-op for it).
            pendingRef.current = null;
            const world = worldOf(e);
            const info = { ...infoOf(e), button: pending.button };
            onPointerDown?.(world, info);
            if (pending.button === 0) onPointerUp?.(world, info);
            return;
          }
          onPointerUp?.(worldOf(e), infoOf(e));
        }}
        onPointerCancel={() => {
          pendingRef.current = null;
          panRef.current = null;
        }}
        onDoubleClick={(e) => {
          onDoubleClick?.(worldOf(e), infoOf(e));
        }}
      />
      {showPerf && (
        <div className="canvas-overlay">
          {fpsText}
          {overlayExtra}
        </div>
      )}
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
