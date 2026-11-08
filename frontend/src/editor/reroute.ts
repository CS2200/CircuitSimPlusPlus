import {
  isJoinEndpoint,
  isPinEndpoint,
  type CsxCircuit,
  type CsxWire,
  type Rotation,
} from "../model/csx";
import type { Vec2 } from "../render/geom";
import { compLayout } from "./layout";
import { dirVector, perpendicularDirs, routeLeg, type LegEnd } from "./route";

/** How one wire end resolves for a whole-wire re-route. */
interface EndInfo {
  pos: Vec2;
  /** Allowed facings here — one for a pin, both sides of a junction. */
  ends: LegEnd[];
  pin: boolean;
}

function resolveEnd(
  ep: CsxWire["a"],
  at: Vec2,
  circuit: CsxCircuit,
  circuits: readonly CsxCircuit[],
): EndInfo | null {
  if (isPinEndpoint(ep)) {
    const comp = circuit.components.find((c) => c.id === ep.comp);
    if (comp === undefined) return null;
    const layout = compLayout(comp, circuits);
    const p = layout.pins.find((x) => x.name === ep.pin);
    if (p === undefined) return null;
    return { pos: { x: p.x, y: p.y }, ends: [{ dir: p.facing, body: layout.rect }], pin: true };
  }
  if (isJoinEndpoint(ep)) {
    const parent = circuit.wires[ep.join.wire];
    if (parent === undefined || ep.join.segment + 1 >= parent.points.length) return null;
    const s = parent.points[ep.join.segment];
    const t = parent.points[ep.join.segment + 1];
    const dirs = perpendicularDirs({ x: s[0], y: s[1] }, { x: t[0], y: t[1] });
    return { pos: at, ends: dirs.map((dir) => ({ dir, body: null })), pin: false };
  }
  // A free end carries no facing and is unconstrained.
  return { pos: at, ends: [{ dir: null, body: null }], pin: false };
}

/** Direction of travel on a polyline's last segment (the arrival direction). */
function arrivalDir(pts: readonly Vec2[]): Rotation | null {
  const n = pts.length;
  if (n < 2) return null;
  const a = pts[n - 2];
  const b = pts[n - 1];
  if (Math.abs(b.y - a.y) < 1e-9) return b.x > a.x ? "E" : "W";
  if (Math.abs(b.x - a.x) < 1e-9) return b.y > a.y ? "S" : "N";
  return null;
}

/** The facing whose direction points most toward `toward` from `from`. */
function pickFacing(ends: readonly LegEnd[], from: Vec2, toward: Vec2): LegEnd {
  if (ends.length <= 1) return ends[0];
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  let best = ends[0];
  let bestDot = -Infinity;
  for (const e of ends) {
    const v = e.dir === null ? { x: 0, y: 0 } : dirVector(e.dir);
    const dot = v.x * dx + v.y * dy;
    if (dot > bestDot) {
      bestDot = dot;
      best = e;
    }
  }
  return best;
}

/**
 * Regenerate a wire's polyline from scratch through its **stations**: the two
 * endpoints and, between them, any user-chosen `midpoints` (format v10). Each
 * leg is routed with the router, so the route is a pure function of the station
 * geometry and the pin facings — a full part rotation returns the identical
 * route instead of accumulating a bend per step, **while the user's deliberate
 * bends are kept** (they are the stations).
 *
 * Returns null when an endpoint cannot be resolved, so the caller falls back to
 * the geometry-repair pass.
 */
export function rerouteWire(
  wire: CsxWire,
  circuit: CsxCircuit,
  circuits: readonly CsxCircuit[],
): [number, number][] | null {
  const n = wire.points.length;
  if (n < 2) return null;
  const A = resolveEnd(wire.a, { x: wire.points[0][0], y: wire.points[0][1] }, circuit, circuits);
  const B = resolveEnd(
    wire.b,
    { x: wire.points[n - 1][0], y: wire.points[n - 1][1] },
    circuit,
    circuits,
  );
  if (A === null || B === null) return null;
  // A wire always has at least one pin end; route from whichever end is a pin so
  // a junction's two facings can be offered as the leg's target set.
  const forward = A.pin || !B.pin;
  const start = forward ? A : B;
  const finish = forward ? B : A;
  const mids = (wire.midpoints ?? []).map((m) => ({ x: m[0], y: m[1] }));

  const stations: { pos: Vec2; end: LegEnd; targets: LegEnd[] }[] = [
    { pos: start.pos, end: start.ends[0], targets: start.ends },
    ...mids.map((m) => ({
      pos: m,
      end: { dir: null, body: null } as LegEnd,
      targets: [{ dir: null, body: null } as LegEnd],
    })),
    { pos: finish.pos, end: finish.ends[0], targets: finish.ends },
  ];

  const out: Vec2[] = [];
  let incoming: Rotation | null = null;
  for (let i = 0; i + 1 < stations.length; i++) {
    const s = stations[i];
    const t = stations[i + 1];
    // A junction at the very start has two facings — pick the one pointing at the
    // next station; every other start facing is already determined.
    const aEnd = i === 0 && s.targets.length > 1 ? pickFacing(s.targets, s.pos, t.pos) : s.end;
    const leg = routeLeg(s.pos, aEnd, t.pos, t.targets, { incoming, flip: wire.flip === true });
    if (leg.length < 2) return null;
    out.push(...(i === 0 ? leg : leg.slice(1)));
    incoming = arrivalDir(leg);
  }
  // Concatenate the legs WITHOUT a global collinear merge: a user midpoint is a
  // vertex, and cleanPolyline would merge two collinear legs straight through it.
  const pts = (forward ? out : out.slice().reverse()).map((p) => [p.x, p.y] as [number, number]);
  if (pts.length < 2) return null;
  return pts;
}
