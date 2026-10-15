import type { Camera } from "./camera";
import type { ViewSize } from "./camera";
import type { Vec2 } from "./geom";

/**
 * The renderer interface (DESIGN.md §7.1: "renderer hides behind an
 * interface and PixiJS/WebGL slots in locally" if Canvas2D ever profiles
 * insufficient).
 *
 * Everything reduces to two primitives:
 *  - `drawPath` — batched by style: the implementation groups queued paths
 *    by style and issues one draw call per group (DESIGN.md: "group by
 *    state color, single pass per color").
 *  - `drawText` — inherently per-call; queued for the end of the layer.
 *
 * Z-order is expressed by layers: the scene calls `flush()` between layers
 * (grid → wires → components → overlay), so batching never reorders across
 * layers. Within a layer, draw order is by *style*, not submission order —
 * the scene must not rely on intra-layer ordering.
 *
 * All coordinates are world units; the camera transform is applied by the
 * implementation (including line widths — they scale with zoom).
 */

export type PathCmd =
  | { readonly t: "M"; readonly x: number; readonly y: number }
  | { readonly t: "L"; readonly x: number; readonly y: number }
  | {
      readonly t: "Q";
      readonly cx: number;
      readonly cy: number;
      readonly x: number;
      readonly y: number;
    }
  | { readonly t: "Z" };

/** Wire visualization states (DESIGN.md §7.1). */
export type WireState = "low" | "high" | "x" | "z" | "disconnected";

export interface StrokeStyle {
  readonly stroke?: string;
  readonly fill?: string;
  /** World units. */
  readonly lineWidth?: number;
  /** 0..1 paint opacity (pulsing warnings; default 1). */
  readonly alpha?: number;
}

export interface TextStyle {
  readonly color: string;
  /** Font size in world units (scales with zoom). */
  readonly size: number;
  readonly align?: CanvasTextAlign;
}

export interface Viewport extends ViewSize {
  readonly dpr: number;
}

export interface FrameView {
  readonly camera: Camera;
  readonly viewport: Viewport;
  readonly background: string;
}

/** Per-frame draw statistics, for the perf overlay and tests. */
export interface RenderStats {
  paths: number;
  texts: number;
  strokeBatches: number;
  fillBatches: number;
}

export interface Renderer {
  /** Clear + set the world transform. Sizes in CSS px. */
  beginFrame(view: FrameView): void;
  /** Queue a path under its style group. */
  drawPath(cmds: readonly PathCmd[], style: StrokeStyle): void;
  /**
   * Immediate-mode fast path for large numbers of same-colored square dots
   * (the background grid): software rasterizers choke on thousands of tiny
   * subpaths in one fill, but chew through solid-rect blits. Drawn at call
   * time — call it at the point in the layer order where the dots belong.
   */
  drawDots(centers: readonly Vec2[], halfSize: number, color: string): void;
  /** Queue text (drawn after paths within the current layer). */
  drawText(x: number, y: number, text: string, style: TextStyle): void;
  /** Draw all queued geometry since the last flush (layer boundary). */
  flush(): void;
  /** Final flush. */
  endFrame(): void;
  readonly stats: RenderStats;
}

/** Batching group key for a style. */
export function styleKey(s: StrokeStyle): string {
  return `${s.stroke ?? ""}${s.fill ?? ""}${s.lineWidth ?? 1}${s.alpha ?? 1}`;
}
