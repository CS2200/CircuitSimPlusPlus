/** 2D geometry primitives shared by the camera, renderer, and spatial index. */

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

/** Axis-aligned bounding box in world coordinates. */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export function vec(x: number, y: number): Vec2 {
  return { x, y };
}

export function rectIntersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function inflateRect(r: Rect, margin: number): Rect {
  return { x: r.x - margin, y: r.y - margin, w: r.w + 2 * margin, h: r.h + 2 * margin };
}

export function unionRects(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return {
    x,
    y,
    w: Math.max(a.x + a.w, b.x + b.w) - x,
    h: Math.max(a.y + a.h, b.y + b.h) - y,
  };
}

/** Bounding box of a point set; empty for no points. */
export function pointsBounds(points: readonly Vec2[]): Rect {
  if (points.length === 0) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = points[0].x;
  let minY = points[0].y;
  let maxX = points[0].x;
  let maxY = points[0].y;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Distance from point p to segment ab — the wire hit-test primitive. */
export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * abx), p.y - (a.y + t * aby));
}
