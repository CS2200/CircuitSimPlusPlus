import type { PathCmd } from "../render/renderer";
import type { Vec2 } from "../render/geom";

/**
 * Distinctive gate shapes (DESIGN.md §6 visual language: "a NAND is
 * recognizably 'AND shape + bubble'"; per-input negation bubbles are
 * configuration, not parts). Shapes are drawn in the component's local
 * EAST frame: origin = body top-left, w×h = body size (from the catalog),
 * output on the right.
 *
 * All curves are quadratic Béziers (the renderer's PathCmd set). Circles
 * use the standard 4-quad approximation (control offset r·(4/3)·tan(π/8)).
 */

/** Circle path centered at (cx, cy): 8 quadratic segments, best-fit k ≈ 0.412·r. */
export function circlePath(cx: number, cy: number, r: number): PathCmd[] {
  const k = 0.4118 * r; // quadratic best-fit (curve midpoint lies on the circle)
  const d = r / Math.SQRT2; // 45° projection
  return [
    { t: "M", x: cx + r, y: cy },
    { t: "Q", cx: cx + r, cy: cy + k, x: cx + d, y: cy + d },
    { t: "Q", cx: cx + k, cy: cy + r, x: cx, y: cy + r },
    { t: "Q", cx: cx - k, cy: cy + r, x: cx - d, y: cy + d },
    { t: "Q", cx: cx - r, cy: cy + k, x: cx - r, y: cy },
    { t: "Q", cx: cx - r, cy: cy - k, x: cx - d, y: cy - d },
    { t: "Q", cx: cx - k, cy: cy - r, x: cx, y: cy - r },
    { t: "Q", cx: cx + k, cy: cy - r, x: cx + d, y: cy - d },
    { t: "Q", cx: cx + r, cy: cy - k, x: cx + r, y: cy },
    { t: "Z" },
  ];
}

/** AND body: flat left, straight top/bottom, semicircular right side. */
function andPath(x: number, y: number, w: number, h: number): PathCmd[] {
  const r = h / 2;
  const ax = x + w - r; // arc center x
  const k = r * 1.05; // bulge control distance (slightly past semicircle)
  return [
    { t: "M", x, y },
    { t: "L", x: ax, y },
    { t: "Q", cx: ax + k, cy: y, x: ax + r, y: y + r },
    { t: "Q", cx: ax + k, cy: y + h, x: ax, y: y + h },
    { t: "L", x, y: y + h },
    { t: "Z" },
  ];
}

/** OR body: concave back, convex top/bottom meeting at a point on the right. */
function orPath(x: number, y: number, w: number, h: number): PathCmd[] {
  const tipX = x + w;
  const midY = y + h / 2;
  return [
    { t: "M", x, y },
    // top edge: convex curve to the tip
    { t: "Q", cx: x + w * 0.55, cy: y + h * 0.04, x: tipX, y: midY },
    // bottom edge: convex curve back to the lower-left
    { t: "Q", cx: x + w * 0.55, cy: y + h * 0.96, x, y: y + h },
    // back edge: concave curve up to the start
    { t: "Q", cx: x + w * 0.22, cy: midY, x, y },
    { t: "Z" },
  ];
}

/** The extra back arc that turns an OR into an XOR (open path, offset left). */
function xorBackPath(x: number, y: number, w: number, h: number): PathCmd[] {
  const bx = x - 0.7;
  return [
    { t: "M", x: bx, y },
    { t: "Q", cx: bx + w * 0.22, cy: y + h / 2, x: bx, y: y + h },
  ];
}

/** Triangle body for NOT/BUFFER (output at the right vertex). */
function triPath(x: number, y: number, w: number, h: number): PathCmd[] {
  return [
    { t: "M", x, y },
    { t: "L", x: x + w, y: y + h / 2 },
    { t: "L", x, y: y + h },
    { t: "Z" },
  ];
}

/** Trapezoid for mux (wide input side → narrow output side) / demux (flip). */
function trapPath(x: number, y: number, w: number, h: number, wideLeft: boolean): PathCmd[] {
  const inset = h * 0.18;
  const l0 = wideLeft ? y : y + inset;
  const l1 = wideLeft ? y + h : y + h - inset;
  const r0 = wideLeft ? y + inset : y;
  const r1 = wideLeft ? y + h - inset : y + h;
  return [
    { t: "M", x, y: l0 },
    { t: "L", x: x + w, y: r0 },
    { t: "L", x: x + w, y: r1 },
    { t: "L", x, y: l1 },
    { t: "Z" },
  ];
}

export const BUBBLE_R = 0.38;

/** Rotate path commands about a center point (E identity; S = 90° cw, y-down). */
export function rotatePath(
  cmds: PathCmd[],
  cx: number,
  cy: number,
  rot: "N" | "E" | "S" | "W",
): PathCmd[] {
  if (rot === "E") return cmds;
  const rotPt = (x: number, y: number): Vec2 => {
    const ox = x - cx;
    const oy = y - cy;
    switch (rot) {
      case "S":
        return { x: cx - oy, y: cy + ox };
      case "W":
        return { x: cx - ox, y: cy - oy };
      case "N":
        return { x: cx + oy, y: cy - ox };
    }
  };
  return cmds.map((c) => {
    if (c.t === "Z") return c;
    const p = rotPt(c.x, c.y);
    if (c.t === "Q") {
      const q = rotPt(c.cx, c.cy);
      return { t: "Q", cx: q.x, cy: q.y, x: p.x, y: p.y };
    }
    return { ...c, x: p.x, y: p.y };
  });
}

export type GateFamily = "and" | "or" | "xor" | "tri";

export interface GateShape {
  /** The closed body outline (fill + stroke). */
  body: PathCmd[];
  /** Extra open strokes (e.g. the XOR back arc). */
  extra: PathCmd[][];
  /** Output bubble center, if the output is negated (NAND/NOR/XNOR/NOT). */
  outBubble: Vec2 | null;
}

/**
 * Body shape for a component type in its local EAST frame. `gate.*` get
 * distinctive shapes; mux/demux get trapezoids; everything else keeps the
 * clean box (register/RAM/arithmetic families, U4 polish may refine).
 *
 * For negated-output variants the body is shrunk left by 2·BUBBLE_R so the
 * bubble sits inside the catalog's pin footprint (pin stays at dx = w).
 */
export function gateShape(
  type: string,
  x: number,
  y: number,
  w: number,
  h: number,
): GateShape | null {
  switch (type) {
    case "gate.and":
      return { body: andPath(x, y, w, h), extra: [], outBubble: null };
    case "gate.nand":
      return {
        body: andPath(x, y, w - 2 * BUBBLE_R, h),
        extra: [],
        outBubble: { x: x + w - BUBBLE_R, y: y + h / 2 },
      };
    case "gate.or":
      return { body: orPath(x, y, w, h), extra: [], outBubble: null };
    case "gate.nor":
      return {
        body: orPath(x, y, w - 2 * BUBBLE_R, h),
        extra: [],
        outBubble: { x: x + w - BUBBLE_R, y: y + h / 2 },
      };
    case "gate.xor":
      return { body: orPath(x, y, w, h), extra: [xorBackPath(x, y, w, h)], outBubble: null };
    case "gate.xnor":
      return {
        body: orPath(x, y, w - 2 * BUBBLE_R, h),
        extra: [xorBackPath(x, y, w - 2 * BUBBLE_R, h)],
        outBubble: { x: x + w - BUBBLE_R, y: y + h / 2 },
      };
    case "gate.not":
      return {
        body: triPath(x, y, w - 2 * BUBBLE_R, h),
        extra: [],
        outBubble: { x: x + w - BUBBLE_R, y: y + h / 2 },
      };
    case "gate.buffer":
      return { body: triPath(x, y, w, h), extra: [], outBubble: null };
    case "plexers.mux":
      return { body: trapPath(x, y, w, h, true), extra: [], outBubble: null };
    case "plexers.demux":
      return { body: trapPath(x, y, w, h, false), extra: [], outBubble: null };
    default:
      return null; // box families
  }
}

/** Bubble paths for a gate shape (output bubble + per-input negation bubbles). */
export function bubblePaths(shape: GateShape, inputBubbles: Vec2[]): PathCmd[][] {
  const out: PathCmd[][] = [];
  if (shape.outBubble !== null)
    out.push(circlePath(shape.outBubble.x, shape.outBubble.y, BUBBLE_R));
  for (const p of inputBubbles) out.push(circlePath(p.x, p.y, BUBBLE_R));
  return out;
}
