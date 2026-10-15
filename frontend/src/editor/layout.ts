import type { CsxCircuit, CsxComponent, Rotation } from "../model/csx";
import type { Rect, Vec2 } from "../render/geom";
import { compSize, compPins, type PinKind } from "./catalog";

/**
 * World-space geometry for placed components (FRONTEND.md U3): body rect,
 * absolute pin positions, rotation handling. This is the single source of
 * truth shared by drawing, hit-testing, and wire-endpoint placement.
 *
 * Rotation semantics: `pos` is the top-left corner of the body in EAST;
 * the body rotates about its CENTER (so `pos` stays the grid anchor for
 * file stability, and the body rect is what moves on the screen).
 */

export interface PinLayout {
  name: string;
  x: number;
  y: number;
  kind: PinKind;
  bitsize: number;
  /**
   * Outward direction of the pin: the body edge it sits on, in world
   * orientation. Wire routing uses this to leave a pin perpendicular to
   * its edge and to approach a target pin from the correct side
   * (editor/route.ts).
   */
  facing: Rotation;
}

/** Pin facing from its offset within the (unrotated) body: nearest edge. */
function pinFacing(dx: number, dy: number, w: number, h: number): Rotation {
  const dL = dx;
  const dR = w - dx;
  const dT = dy;
  const dB = h - dy;
  const min = Math.min(dL, dR, dT, dB);
  if (min === dL) return "W";
  if (min === dR) return "E";
  if (min === dT) return "N";
  return "S";
}

/** Rotate a compass direction with the component's rotation (E→S→W→N cycle). */
function rotateDir(dir: Rotation, rot: Rotation): Rotation {
  const order: Rotation[] = ["E", "S", "W", "N"];
  const steps = order.indexOf(rot);
  return order[(order.indexOf(dir) + steps) % 4];
}

export interface CompLayout {
  rect: Rect;
  pins: PinLayout[];
}

export function compLayout(comp: CsxComponent, circuits?: readonly CsxCircuit[]): CompLayout {
  const { w, h } = compSize(comp, circuits);
  const rot: Rotation = comp.rot ?? "E";
  const rotated = rot === "N" || rot === "S";
  const rw = rotated ? h : w;
  const rh = rotated ? w : h;
  const rect: Rect = { x: comp.pos[0], y: comp.pos[1], w: rw, h: rh };
  const cx = rect.x + rw / 2;
  const cy = rect.y + rh / 2;
  const pins = compPins(comp, circuits).map((p) => {
    // offset from body center, then rotate about the center.
    // Rotation naming = direction the component faces; the R key cycles
    // E → S → W → N in 90° clockwise steps (y-down screen coordinates).
    const ox = p.dx - w / 2;
    const oy = p.dy - h / 2;
    let rx: number;
    let ry: number;
    switch (rot) {
      case "E": // 0°
        rx = ox;
        ry = oy;
        break;
      case "S": // 90° cw
        rx = -oy;
        ry = ox;
        break;
      case "W": // 180°
        rx = -ox;
        ry = -oy;
        break;
      case "N": // 270° cw
        rx = oy;
        ry = -ox;
        break;
    }
    return {
      name: p.name,
      x: cx + rx,
      y: cy + ry,
      kind: p.kind,
      bitsize: p.bitsize ?? 1,
      facing: rotateDir(pinFacing(p.dx, p.dy, w, h), rot),
    };
  });
  return { rect, pins };
}

export function pinPosition(
  comp: CsxComponent,
  pinName: string,
  circuits?: readonly CsxCircuit[],
): Vec2 | null {
  const layout = compLayout(comp, circuits);
  const pin = layout.pins.find((p) => p.name === pinName);
  return pin === undefined ? null : { x: pin.x, y: pin.y };
}

export function nextRotation(rot: Rotation | undefined): Rotation {
  switch (rot) {
    case undefined:
    case "E":
      return "S";
    case "S":
      return "W";
    case "W":
      return "N";
    case "N":
      return "E";
  }
}

/** Inverse of nextRotation (used by arrow-key rotation, UI_OVERHAUL §20). */
export function prevRotation(rot: Rotation | undefined): Rotation {
  switch (rot) {
    case undefined:
    case "E":
      return "N";
    case "N":
      return "W";
    case "W":
      return "S";
    case "S":
      return "E";
  }
}
