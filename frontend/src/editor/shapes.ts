import type { PathCmd } from "../render/renderer";
import type { Vec2 } from "../render/geom";
import { roundedPath } from "../render/paths";

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

/**
 * Height budget of a gate's fixed SYMBOL (UI_OVERHAUL §44): the AND/OR shape
 * keeps a 2-input gate's size, and extra inputs hang on the straight input-edge
 * line that grows with them instead of stretching the symbol.
 */
const CAP_H = 3;

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
 * IC-style chip body for RAM/ROM (UI_OVERHAUL §46): a rounded rectangle with a
 * small notch pip on its bottom edge, so a memory part reads as a chip. Shared
 * by the placed body and the placement ghost.
 */
export function chipPath(x: number, y: number, w: number, h: number): PathCmd[] {
  const inset = 0.3;
  const cx = x + w / 2;
  const nr = 0.6;
  return [
    { t: "M", x: x + inset, y },
    { t: "L", x: x + w - inset, y },
    { t: "Q", cx: x + w, cy: y, x: x + w, y: y + inset },
    { t: "L", x: x + w, y: y + h - inset },
    { t: "Q", cx: x + w, cy: y + h, x: x + w - inset, y: y + h },
    { t: "L", x: x + inset, y: y + h },
    { t: "Q", cx: x, cy: y + h, x, y: y + h - inset },
    { t: "L", x, y: y + inset },
    { t: "Q", cx: x, cy: y, x: x + inset, y },
    { t: "Z" },
    // orientation notch (a pip bulging up into the bottom edge)
    { t: "M", x: cx - nr, y: y + h },
    { t: "Q", cx, cy: y + h - nr * 1.4, x: cx + nr, y: y + h },
  ];
}

/**
 * Pointed-hexagon body for the probe (UI_OVERHAUL §40): a shape that reads as
 * "probe" without a type word. Shared by the placed body, the placement ghost
 * and the palette icon, so the preview matches the part you get.
 */
export function probePath(x: number, y: number, w: number, h: number): PathCmd[] {
  const k = Math.min(h, w / 2);
  return roundedPath(
    [
      { x: x + k / 2, y },
      { x: x + w - k / 2, y },
      { x: x + w, y: y + h / 2 },
      { x: x + w - k / 2, y: y + h },
      { x: x + k / 2, y: y + h },
      { x, y: y + h / 2 },
      { x: x + k / 2, y },
    ],
    0.08,
  );
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
    case "gate.nand":
    case "gate.or":
    case "gate.nor":
    case "gate.xor":
    case "gate.xnor": {
      // The SYMBOL keeps a 2-input gate's size, vertically centred. Extra inputs
      // never reshape it: they hang on a straight vertical input-edge line that
      // grows to hold them all (UI_OVERHAUL §44).
      const capH = Math.min(h, CAP_H);
      const capY = y + (h - capH) / 2;
      const negated = type === "gate.nand" || type === "gate.nor" || type === "gate.xnor";
      const back = type === "gate.xor" || type === "gate.xnor";
      const bw = w - (negated ? 2 * BUBBLE_R : 0);
      const body =
        type === "gate.and" || type === "gate.nand"
          ? andPath(x, capY, bw, capH)
          : orPath(x, capY, bw, capH);
      const extra: PathCmd[][] = [];
      if (back) extra.push(xorBackPath(x, capY, bw, capH));
      if (h > capH) {
        // The input edge: one straight line that every input pin attaches to.
        extra.push([
          { t: "M", x, y },
          { t: "L", x, y: y + h },
        ]);
      }
      return {
        body,
        extra,
        outBubble: negated ? { x: x + w - BUBBLE_R, y: y + h / 2 } : null,
      };
    }
    case "gate.not":
      return {
        body: triPath(x, y, w - 2 * BUBBLE_R, h),
        extra: [],
        outBubble: { x: x + w - BUBBLE_R, y: y + h / 2 },
      };
    case "gate.buffer":
      return { body: triPath(x, y, w, h), extra: [], outBubble: null };
    case "io.button": {
      // A push button (UI_OVERHAUL §48): a round cap with a plunger + a lead out
      // to its pin, not a box.
      const cx = x + w / 2;
      const cy = y + h / 2;
      const r = Math.min(w, h) * 0.3;
      return {
        body: circlePath(cx, cy, r),
        extra: [
          // plunger stem, cap bar, and the lead to the output pin
          [
            { t: "M", x: cx, y: cy - r },
            { t: "L", x: cx, y: y + h * 0.1 },
          ],
          [
            { t: "M", x: cx - w * 0.24, y: y + h * 0.1 },
            { t: "L", x: cx + w * 0.24, y: y + h * 0.1 },
          ],
          [
            { t: "M", x: cx + r, y: cy },
            { t: "L", x: x + w, y: cy },
          ],
        ],
        outBubble: null,
      };
    }
    case "wiring.controlled-buffer":
      // A buffer triangle with an enable lead on the bottom edge (UI_OVERHAUL
      // §43): the extra stroke connects the body's lower slanted edge to the
      // `en` pin at (x + w/2, y + h).
      return {
        body: triPath(x, y, w, h),
        extra: [
          [
            { t: "M", x: x + w / 2, y: y + (3 * h) / 4 },
            { t: "L", x: x + w / 2, y: y + h },
          ],
        ],
        outBubble: null,
      };
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
