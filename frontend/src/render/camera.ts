import type { Rect, Vec2 } from "./geom";

/** Viewport size in CSS pixels. */
export interface ViewSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Pan/zoom camera. World units are grid cells (DESIGN.md positions are
 * integer grid coords); `scale` is CSS px per world unit.
 *
 * The camera looks at world point `(x, y)`, which projects to the viewport
 * center. All transforms are pure functions of (x, y, scale, view) — no
 * hidden state, trivially testable.
 */
export class Camera {
  static readonly MIN_SCALE = 2;
  static readonly MAX_SCALE = 128;

  constructor(
    public x = 0,
    public y = 0,
    public scale = 16,
  ) {}

  worldToScreen(p: Vec2, view: ViewSize): Vec2 {
    return {
      x: (p.x - this.x) * this.scale + view.width / 2,
      y: (p.y - this.y) * this.scale + view.height / 2,
    };
  }

  screenToWorld(p: Vec2, view: ViewSize): Vec2 {
    return {
      x: (p.x - view.width / 2) / this.scale + this.x,
      y: (p.y - view.height / 2) / this.scale + this.y,
    };
  }

  /** Pan by a screen-space delta (e.g. pointer drag). */
  panByScreen(dx: number, dy: number): void {
    this.x -= dx / this.scale;
    this.y -= dy / this.scale;
  }

  /** Zoom centered on the screen point (cursor), keeping it fixed in world. */
  zoomAt(screenPoint: Vec2, factor: number, view: ViewSize): void {
    const anchor = this.screenToWorld(screenPoint, view);
    this.scale = clamp(this.scale * factor, Camera.MIN_SCALE, Camera.MAX_SCALE);
    this.x = anchor.x - (screenPoint.x - view.width / 2) / this.scale;
    this.y = anchor.y - (screenPoint.y - view.height / 2) / this.scale;
  }

  /** World-space rectangle currently visible (for culling queries). */
  visibleWorldRect(view: ViewSize): Rect {
    const w = view.width / this.scale;
    const h = view.height / this.scale;
    return { x: this.x - w / 2, y: this.y - h / 2, w, h };
  }
}

/** Snap a world coordinate to the grid (component placement, wire bends). */
export function snap(v: number, grid: number): number {
  return Math.round(v / grid) * grid;
}

export function snapPoint(p: Vec2, grid: number): Vec2 {
  return { x: snap(p.x, grid), y: snap(p.y, grid) };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
