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

/** Crossing-hop bump radius in grid units (quarter-unit: exact in binary). */
const HOP_RADIUS = 0.25;

/**
 * Wire path with rounded corners AND "crossing hops": where this wire
 * crosses another, it arcs over it with a small quadratic bump, so a
 * crossing can never be mistaken for a junction — junction dots stay the
 * only connectivity cue (DESIGN.md §5.2 copper-first). Hops must lie on
 * straight runs clear of corners; anything too close to a corner or end is
 * skipped (the path stays valid). `axis` is the axis of the wire's own
 * segment the hop sits on (horizontal = bump up, vertical = bump right).
 */
export function wirePath(
  points: readonly Vec2[],
  radius: number,
  hops: readonly { at: Vec2; axis: "h" | "v" }[] = [],
): PathCmd[] {
  const base = roundedPath(points, radius);
  if (hops.length === 0 || points.length < 2) return base;
  const out: PathCmd[] = [];
  let cur: Vec2 | null = null;
  for (const cmd of base) {
    if (cmd.t === "M") {
      cur = { x: cmd.x, y: cmd.y };
      out.push(cmd);
      continue;
    }
    if (cmd.t === "Q") {
      cur = { x: cmd.x, y: cmd.y };
      out.push(cmd);
      continue;
    }
    if (cmd.t === "Z") {
      out.push(cmd);
      continue;
    }
    if (cur === null) {
      cur = { x: cmd.x, y: cmd.y };
      out.push(cmd);
      continue;
    }
    const from = cur;
    const to = { x: cmd.x, y: cmd.y };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) {
      out.push(cmd);
      cur = to;
      continue;
    }
    const ux = dx / len;
    const uy = dy / len;
    const onRun: { t: number; hop: { at: Vec2; axis: "h" | "v" } }[] = [];
    for (const hop of hops) {
      const t = (hop.at.x - from.x) * ux + (hop.at.y - from.y) * uy;
      const off = Math.abs((hop.at.x - from.x) * uy - (hop.at.y - from.y) * ux);
      if (off > 1e-6) continue; // not on this straight run
      if (t <= HOP_RADIUS + 1e-6 || t >= len - HOP_RADIUS - 1e-6) continue; // too close to an end
      onRun.push({ t, hop });
    }
    if (onRun.length === 0) {
      out.push(cmd);
      cur = to;
      continue;
    }
    onRun.sort((a, b) => a.t - b.t);
    for (const { hop } of onRun) {
      const pre = { x: hop.at.x - ux * HOP_RADIUS, y: hop.at.y - uy * HOP_RADIUS };
      const post = { x: hop.at.x + ux * HOP_RADIUS, y: hop.at.y + uy * HOP_RADIUS };
      out.push({ t: "L", x: pre.x, y: pre.y });
      const bx = hop.axis === "h" ? 0 : 2 * HOP_RADIUS;
      const by = hop.axis === "h" ? -2 * HOP_RADIUS : 0;
      out.push({
        t: "Q",
        cx: hop.at.x + bx,
        cy: hop.at.y + by,
        x: post.x,
        y: post.y,
      });
    }
    out.push({ t: "L", x: to.x, y: to.y });
    cur = to;
  }
  return out;
}
