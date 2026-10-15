import type { Rotation } from "../model/csx";
import type { Rect, Vec2 } from "../render/geom";

/**
 * Orthogonal route generator — the wire-aesthetics engine (DESIGN.md §7.1
 * "wires look circuit-like", App. B.1 — the DLS look).
 *
 * A *leg* is the path between two consecutive points of one wire: pin →
 * waypoint, waypoint → waypoint, or waypoint → pin/junction. An end that
 * sits on a pin carries the pin's outward facing (`dir`) and its component
 * body rect (`body`): the route leaves such an end along its facing (an
 * "escape stub") and approaches a target end *against* its facing, from
 * outside the body. Ends with `dir: null` (waypoints, the free cursor, a
 * junction before a side is chosen) are unconstrained.
 *
 * Candidates are enumerated (straight, both single-corner Ls, four
 * around-the-bodies detours), filtered by deterministic validation
 * (axis-aligned only, stub/approach directions respected, no reversals,
 * no self-overlap, component clearance), then scored: fewest corners,
 * then shortest, then "turn as late as possible" (keep travelling along
 * the incoming direction before turning) — inverted to "turn early" by the
 * X key while routing (`flip`). Ties fall back to candidate order, so the
 * output is a pure function of its inputs.
 */

export interface LegEnd {
  /** Outward pin facing; the wire leaves along it (or enters against it). */
  dir: Rotation | null;
  /** Component body of the pin (clearance obstacle); null when free. */
  body: Rect | null;
}

export interface RouteOptions {
  /** Escape stub length in grid units (default 1). */
  stub?: number;
  /** Minimum clearance from component bodies in grid units (default 0.5). */
  clearance?: number;
  /** Corner-flip preference (X while routing): prefer turning early. */
  flip?: boolean;
  /** Direction of travel arriving at `a` — an immediate reversal is rejected. */
  incoming?: Rotation | null;
}

const EPS = 1e-9;
const DEFAULT_STUB = 1;
const DEFAULT_CLEARANCE = 0.5;

const DIRS: Record<Rotation, Vec2> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

export function dirVector(d: Rotation): Vec2 {
  return DIRS[d];
}

export function moveDir(p: Vec2, d: Rotation, len: number): Vec2 {
  const v = DIRS[d];
  return { x: p.x + v.x * len, y: p.y + v.y * len };
}

function negate(v: Vec2): Vec2 {
  return { x: -v.x, y: -v.y };
}

function distPoint(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

/**
 * Entry facings for a junction onto `a`→`b`: perpendicular to the parent
 * segment (a horizontal parent is entered vertically and vice versa).
 */
export function perpendicularDirs(a: Vec2, b: Vec2): Rotation[] {
  return Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? ["N", "S"] : ["E", "W"];
}

/** Remove consecutive duplicates and collinear same-direction points. */
export function cleanPolyline(points: readonly Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last !== undefined && samePoint(last, p)) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let i = 1; i + 1 < out.length;) {
    const a = out[i - 1];
    const b = out[i];
    const c = out[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const bcx = c.x - b.x;
    const bcy = c.y - b.y;
    const collinear = Math.abs(abx * bcy - aby * bcx) < EPS;
    const sameDir = abx * bcx + aby * bcy > 0;
    if (collinear && sameDir) out.splice(i, 1);
    else i++;
  }
  return out;
}

export function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distPoint(points[i - 1], points[i]);
  return total;
}

/** Axis of an axis-aligned segment, or null when diagonal/degenerate. */
function axisOf(a: Vec2, b: Vec2): "h" | "v" | null {
  if (Math.abs(a.y - b.y) < EPS) return "h";
  if (Math.abs(a.x - b.x) < EPS) return "v";
  return null;
}

/** True when `seg` runs along direction `dir`. */
function alignedWith(seg: Vec2, dir: Vec2): boolean {
  const cross = seg.x * dir.y - seg.y * dir.x;
  const dot = seg.x * dir.x + seg.y * dir.y;
  return Math.abs(cross) < 1e-9 && dot > EPS;
}

/** Strict-interior overlap of an axis-aligned segment with an inflated rect. */
function overlapsRect(s0: Vec2, s1: Vec2, r: Rect, margin: number): boolean {
  const rx = r.x - margin;
  const ry = r.y - margin;
  const x1 = Math.min(s0.x, s1.x);
  const x2 = Math.max(s0.x, s1.x);
  const y1 = Math.min(s0.y, s1.y);
  const y2 = Math.max(s0.y, s1.y);
  return (
    x2 > rx + EPS &&
    x1 < rx + r.w + 2 * margin - EPS &&
    y2 > ry + EPS &&
    y1 < ry + r.h + 2 * margin - EPS
  );
}

/** Non-adjacent segment pairs may not overlap or cross (self-tangles). */
function selfOverlaps(pts: readonly Vec2[]): boolean {
  for (let i = 0; i + 1 < pts.length; i++) {
    for (let j = i + 2; j + 1 < pts.length; j++) {
      if (pairTangled(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

function pairTangled(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): boolean {
  const pH = Math.abs(p0.y - p1.y) < EPS;
  const qH = Math.abs(q0.y - q1.y) < EPS;
  if (pH && qH) {
    if (Math.abs(p0.y - q0.y) > EPS) return false;
    const lo = Math.max(Math.min(p0.x, p1.x), Math.min(q0.x, q1.x));
    const hi = Math.min(Math.max(p0.x, p1.x), Math.max(q0.x, q1.x));
    return hi - lo > EPS;
  }
  if (!pH && !qH) {
    if (Math.abs(p0.x - q0.x) > EPS) return false;
    const lo = Math.max(Math.min(p0.y, p1.y), Math.min(q0.y, q1.y));
    const hi = Math.min(Math.max(p0.y, p1.y), Math.max(q0.y, q1.y));
    return hi - lo > EPS;
  }
  const [h0, h1, v0, v1] = pH ? [p0, p1, q0, q1] : [q0, q1, p0, p1];
  const x = v0.x;
  const y = h0.y;
  const inH = x > Math.min(h0.x, h1.x) + EPS && x < Math.max(h0.x, h1.x) - EPS;
  const inV = y > Math.min(v0.y, v1.y) + EPS && y < Math.max(v0.y, v1.y) - EPS;
  return inH && inV;
}

/** Candidate point lists for one (dirA, dirB) combination. */
function candidates(
  a: Vec2,
  b: Vec2,
  dA: Rotation | null,
  dB: Rotation | null,
  stub: number,
  clear: number,
  bodyA: Rect | null,
  bodyB: Rect | null,
): Vec2[][] {
  const P1 = dA === null ? a : moveDir(a, dA, stub);
  const P2 = dB === null ? b : moveDir(b, dB, stub);
  const bodies = [bodyA, bodyB].filter((r): r is Rect => r !== null);
  const xs = [a.x, b.x, P1.x, P2.x, ...bodies.flatMap((r) => [r.x, r.x + r.w])];
  const ys = [a.y, b.y, P1.y, P2.y, ...bodies.flatMap((r) => [r.y, r.y + r.h])];
  const xL = Math.min(...xs) - clear;
  const xR = Math.max(...xs) + clear;
  const yT = Math.min(...ys) - clear;
  const yB = Math.max(...ys) + clear;
  const out: Vec2[][] = [
    [a, P1, { x: P2.x, y: P1.y }, P2, b],
    [a, P1, { x: P1.x, y: P2.y }, P2, b],
    [a, P1, { x: P1.x, y: yT }, { x: P2.x, y: yT }, P2, b],
    [a, P1, { x: P1.x, y: yB }, { x: P2.x, y: yB }, P2, b],
    [a, P1, { x: xL, y: P1.y }, { x: xL, y: P2.y }, P2, b],
    [a, P1, { x: xR, y: P1.y }, { x: xR, y: P2.y }, P2, b],
  ];
  // Two-stage staircases: travel one axis to a lane, cross to the other
  // lane, then drop into the second end's stub corridor. Needed when the
  // direct L/detour shapes are blocked by one of the two bodies.
  const xLanes = [xL, xR, P1.x, P2.x];
  const yLanes = [yT, yB, P1.y, P2.y];
  for (const xl of xLanes) {
    for (const yl of yLanes) {
      out.push([a, P1, { x: P1.x, y: yl }, { x: xl, y: yl }, { x: xl, y: P2.y }, P2, b]);
      out.push([a, P1, { x: xl, y: P1.y }, { x: xl, y: yl }, { x: P2.x, y: yl }, P2, b]);
    }
  }
  return out;
}

function validLeg(
  pts: readonly Vec2[],
  a: Vec2,
  dA: Rotation | null,
  b: Vec2,
  dB: Rotation | null,
  stub: number,
  bodyA: Rect | null,
  bodyB: Rect | null,
  clear: number,
  incoming: Rotation | null,
): boolean {
  const n = pts.length;
  if (n < 2 || !samePoint(pts[0], a) || !samePoint(pts[n - 1], b)) return false;

  // Orthogonal segments only, no zero-length pieces.
  for (let i = 0; i + 1 < n; i++) {
    if (axisOf(pts[i], pts[i + 1]) === null) return false;
    if (samePoint(pts[i], pts[i + 1])) return false;
  }
  // No immediate reversal between consecutive segments.
  for (let i = 0; i + 2 < n; i++) {
    const d1x = pts[i + 1].x - pts[i].x;
    const d1y = pts[i + 1].y - pts[i].y;
    const d2x = pts[i + 2].x - pts[i + 1].x;
    const d2y = pts[i + 2].y - pts[i + 1].y;
    if (d1x * d2x + d1y * d2y < -EPS) return false;
  }
  if (selfOverlaps(pts)) return false;

  // Escape stub: leave `a` along dA, never reversing the incoming travel.
  const s0 = { x: pts[1].x - pts[0].x, y: pts[1].y - pts[0].y };
  if (dA !== null) {
    if (!alignedWith(s0, DIRS[dA])) return false;
    if (Math.hypot(s0.x, s0.y) < stub - EPS) return false;
  }
  if (incoming !== null) {
    const iv = DIRS[incoming];
    const backward = s0.x * iv.x + s0.y * iv.y < -EPS;
    const collinear = Math.abs(s0.x * iv.y - s0.y * iv.x) < EPS;
    if (backward && collinear) return false;
  }
  // Facing entry: approach `b` against dB (outside → in), stub respected.
  const sN = { x: pts[n - 1].x - pts[n - 2].x, y: pts[n - 1].y - pts[n - 2].y };
  if (dB !== null) {
    if (!alignedWith(sN, negate(DIRS[dB]))) return false;
    if (Math.hypot(sN.x, sN.y) < stub - EPS) return false;
  }

  // Component clearance: end segments (touching their own pin) use the
  // plain body — they start exactly on its edge; every other segment keeps
  // `clear` distance from both bodies.
  const checks: { rect: Rect; pin: Vec2 }[] = [];
  if (bodyA !== null) checks.push({ rect: bodyA, pin: a });
  if (bodyB !== null) checks.push({ rect: bodyB, pin: b });
  for (let i = 0; i + 1 < n; i++) {
    for (const { rect, pin } of checks) {
      const incident = samePoint(pts[i], pin) || samePoint(pts[i + 1], pin);
      if (overlapsRect(pts[i], pts[i + 1], rect, incident ? 0 : clear)) return false;
    }
  }
  return true;
}

/**
 * Route one leg. `bEnds` may hold several allowed target facings (a
 * junction onto a segment allows either side); the best candidate across
 * all combinations wins. Always returns at least `[a]`; when every
 * candidate is rejected (pathological overlapping bodies), falls back to
 * the plain single-corner H-first shape.
 */
export function routeLeg(
  a: Vec2,
  aEnd: LegEnd,
  b: Vec2,
  bEnds: LegEnd | readonly LegEnd[],
  o: RouteOptions = {},
): Vec2[] {
  if (samePoint(a, b)) return [{ x: a.x, y: a.y }];
  const stub = o.stub ?? DEFAULT_STUB;
  const clear = o.clearance ?? DEFAULT_CLEARANCE;
  const flip = o.flip ?? false;
  const incoming = o.incoming ?? null;
  const ends: readonly LegEnd[] = Array.isArray(bEnds)
    ? (bEnds as readonly LegEnd[])
    : [bEnds as LegEnd];

  let best: { pts: Vec2[]; corners: number; len: number; first: number } | null = null;
  for (const bEnd of ends) {
    for (const raw of candidates(a, b, aEnd.dir, bEnd.dir, stub, clear, aEnd.body, bEnd.body)) {
      const pts = cleanPolyline(raw);
      if (!validLeg(pts, a, aEnd.dir, b, bEnd.dir, stub, aEnd.body, bEnd.body, clear, incoming)) {
        continue;
      }
      const corners = pts.length - 2;
      const len = Math.round(polylineLength(pts) * 1e6);
      const first = Math.round(distPoint(pts[0], pts[1]) * 1e6) * (flip ? 1 : -1);
      const better =
        best === null ||
        corners < best.corners ||
        (corners === best.corners && (len < best.len || (len === best.len && first < best.first)));
      if (better) best = { pts, corners, len, first };
    }
  }
  if (best !== null) return best.pts;

  // Fallback: never fail — plain H-first corner (may ignore clearance).
  const fb = cleanPolyline([a, { x: b.x, y: a.y }, b]);
  return fb.length >= 2
    ? fb
    : [
        { x: a.x, y: a.y },
        { x: b.x, y: b.y },
      ];
}
