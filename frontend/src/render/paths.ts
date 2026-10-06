import type { Vec2 } from "./geom";
import type { PathCmd } from "./renderer";

/**
 * Polyline with quadratic-Bézier rounded interior corners — the DLS wire
 * look (DESIGN.md App. B.1: curve radius ~0.12 grid units). The radius is
 * clamped to half the shorter adjacent segment so short segments don't
 * self-intersect.
 */
export function roundedPath(points: readonly Vec2[], radius: number): PathCmd[] {
  const cmds: PathCmd[] = [];
  if (points.length === 0) return cmds;
  cmds.push({ t: "M", x: points[0].x, y: points[0].y });
  if (points.length < 3 || radius <= 0) {
    for (let i = 1; i < points.length; i++) {
      cmds.push({ t: "L", x: points[i].x, y: points[i].y });
    }
    return cmds;
  }
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i - 1];
    const b = points[i];
    const c = points[i + 1];
    const inLen = Math.hypot(b.x - a.x, b.y - a.y);
    const outLen = Math.hypot(c.x - b.x, c.y - b.y);
    if (inLen === 0 || outLen === 0) continue; // degenerate doubled point
    const r = Math.min(radius, inLen / 2, outLen / 2);
    cmds.push({
      t: "L",
      x: b.x - ((b.x - a.x) / inLen) * r,
      y: b.y - ((b.y - a.y) / inLen) * r,
    });
    cmds.push({
      t: "Q",
      cx: b.x,
      cy: b.y,
      x: b.x + ((c.x - b.x) / outLen) * r,
      y: b.y + ((c.y - b.y) / outLen) * r,
    });
  }
  const last = points[points.length - 1];
  cmds.push({ t: "L", x: last.x, y: last.y });
  return cmds;
}

/** Axis-aligned rectangle outline. */
export function rectPath(x: number, y: number, w: number, h: number): PathCmd[] {
  return [
    { t: "M", x, y },
    { t: "L", x: x + w, y },
    { t: "L", x: x + w, y: y + h },
    { t: "L", x, y: y + h },
    { t: "Z" },
  ];
}

/** Polyline through an explicit point list (no rounding). */
export function polylinePath(points: readonly Vec2[]): PathCmd[] {
  return roundedPath(points, 0);
}

/** Small filled square (grid dots, junction placeholders). */
export function dotPath(x: number, y: number, halfSize: number): PathCmd[] {
  return rectPath(x - halfSize, y - halfSize, 2 * halfSize, 2 * halfSize);
}
