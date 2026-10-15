import { describe, expect, it } from "vitest";
import type { Rotation } from "../model/csx";
import type { Rect, Vec2 } from "../render/geom";
import { inflateRect, rectIntersects } from "../render/geom";
import {
  cleanPolyline,
  dirVector,
  perpendicularDirs,
  polylineLength,
  routeLeg,
  type LegEnd,
} from "./route";

const P = (x: number, y: number): Vec2 => ({ x, y });

// A 2-input AND at (10,10) [out pin (15,11.5) facing E] and a NOT at
// (20,10) [in pin (20,11) facing W] — the exact geometry of the old
// "wire skims the gate edge" regression (tools.test.ts).
const AND_BODY: Rect = { x: 10, y: 10, w: 5, h: 3 };
const NOT_BODY: Rect = { x: 20, y: 10, w: 3, h: 2 };
const OUT_END: LegEnd = { dir: "E", body: AND_BODY };
const IN_END: LegEnd = { dir: "W", body: NOT_BODY };

describe("routeLeg — escape/entry stubs", () => {
  it("routes out → in as the natural Z (turn late by default)", () => {
    expect(routeLeg(P(15, 11.5), OUT_END, P(20, 11), IN_END)).toEqual([
      P(15, 11.5),
      P(19, 11.5),
      P(19, 11),
      P(20, 11),
    ]);
  });

  it("flip (X while routing) turns early instead", () => {
    expect(routeLeg(P(15, 11.5), OUT_END, P(20, 11), IN_END, { flip: true })).toEqual([
      P(15, 11.5),
      P(16, 11.5),
      P(16, 11),
      P(20, 11),
    ]);
  });

  it("aligned facing pins collapse to a straight wire", () => {
    const bodyA: Rect = { x: -5, y: -2, w: 5, h: 4 };
    const bodyB: Rect = { x: 6, y: -2, w: 5, h: 4 };
    expect(
      routeLeg(P(0, 0), { dir: "E", body: bodyA }, P(6, 0), { dir: "W", body: bodyB }),
    ).toEqual([P(0, 0), P(6, 0)]);
  });

  it("routes around when the target sits 'behind' the source facing", () => {
    // Source out facing E at (-4,0); target faces E at (10,0): the wire
    // must leave east, loop over both bodies, and come back west.
    const bodyA: Rect = { x: -9, y: -1.5, w: 5, h: 3 };
    const bodyB: Rect = { x: 5, y: -1.5, w: 5, h: 3 };
    expect(
      routeLeg(P(-4, 0), { dir: "E", body: bodyA }, P(10, 0), { dir: "E", body: bodyB }),
    ).toEqual([P(-4, 0), P(-3, 0), P(-3, -2), P(11, -2), P(11, 0), P(10, 0)]);
  });

  it("vertical pins: S out → N in turns late (keeps travelling south)", () => {
    const bodyA: Rect = { x: -1, y: -5, w: 2, h: 5 }; // pin (0,0) on the bottom edge
    const bodyB: Rect = { x: 3, y: 4, w: 2, h: 5 }; // pin (4,4) on the top edge
    expect(
      routeLeg(P(0, 0), { dir: "S", body: bodyA }, P(4, 4), { dir: "N", body: bodyB }),
    ).toEqual([P(0, 0), P(0, 3), P(4, 3), P(4, 4)]);
  });

  it("junction entries are perpendicular to the parent segment", () => {
    const bodyA: Rect = { x: 4, y: 2, w: 5, h: 2 }; // pin (9,3) facing E
    const ends: LegEnd[] = [
      { dir: "E", body: null },
      { dir: "W", body: null },
    ];
    // Vertical parent at x=2; the source sits right of it. Either side is
    // allowed; the short route (over the gate, entering from the right)
    // wins.
    expect(routeLeg(P(9, 3), { dir: "E", body: bodyA }, P(2, 3), ends)).toEqual([
      P(9, 3),
      P(10, 3),
      P(10, 1.5),
      P(3, 1.5),
      P(3, 3),
      P(2, 3),
    ]);
  });

  it("is deterministic", () => {
    const once = routeLeg(P(15, 11.5), OUT_END, P(20, 11), IN_END);
    const twice = routeLeg(P(15, 11.5), OUT_END, P(20, 11), IN_END);
    expect(once).toEqual(twice);
  });
});

describe("routeLeg — helpers", () => {
  it("cleanPolyline merges collinear runs but keeps reversals", () => {
    expect(cleanPolyline([P(0, 0), P(1, 0), P(2, 0)])).toEqual([P(0, 0), P(2, 0)]);
    expect(cleanPolyline([P(0, 0), P(1, 0), P(0.5, 0)])).toEqual([P(0, 0), P(1, 0), P(0.5, 0)]);
    expect(cleanPolyline([P(0, 0), P(0, 0), P(0, 2)])).toEqual([P(0, 0), P(0, 2)]);
  });

  it("perpendicularDirs follows the parent segment axis", () => {
    expect(perpendicularDirs(P(0, 0), P(5, 0))).toEqual(["N", "S"]);
    expect(perpendicularDirs(P(0, 0), P(0, 5))).toEqual(["E", "W"]);
  });
});

describe("routeLeg — invariants (seeded random corpus)", () => {
  function lcg(seed: number): () => number {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    };
  }

  /** A random component body with one pin on a random edge. */
  function randomEnd(rnd: () => number): { body: Rect; pin: Vec2; dir: Rotation } {
    const bx = Math.round(rnd() * 40) - 20;
    const by = Math.round(rnd() * 40) - 20;
    const w = 2 + Math.floor(rnd() * 5);
    const h = 2 + Math.floor(rnd() * 5);
    const body: Rect = { x: bx, y: by, w, h };
    const side = Math.floor(rnd() * 4);
    const t = 0.5 + Math.round(rnd() * 2 * (w - 1)) / 2;
    const u = 0.5 + Math.round(rnd() * 2 * (h - 1)) / 2;
    switch (side) {
      case 0:
        return { body, pin: P(bx, by + u), dir: "W" };
      case 1:
        return { body, pin: P(bx + w, by + u), dir: "E" };
      case 2:
        return { body, pin: P(bx + t, by), dir: "N" };
      default:
        return { body, pin: P(bx + t, by + h), dir: "S" };
    }
  }

  function assertInvariants(pts: Vec2[], a: Vec2, aEnd: LegEnd, b: Vec2, bEnd: LegEnd): void {
    expect(pts.length).toBeGreaterThanOrEqual(2);
    expect(pts[0]).toEqual(a);
    expect(pts.at(-1)).toEqual(b);
    for (let i = 0; i + 1 < pts.length; i++) {
      const dx = pts[i + 1].x - pts[i].x;
      const dy = pts[i + 1].y - pts[i].y;
      expect(Math.abs(dx) > 1e-9 || Math.abs(dy) > 1e-9, "no zero-length segments").toBe(true);
      expect(Math.abs(dx) < 1e-9 || Math.abs(dy) < 1e-9, "axis-aligned only").toBe(true);
    }
    if (aEnd.dir !== null) {
      const dx = pts[1].x - pts[0].x;
      const dy = pts[1].y - pts[0].y;
      const v = dirVector(aEnd.dir);
      expect(dx * v.x + dy * v.y).toBeGreaterThan(0);
      expect(Math.abs(dx * v.y - dy * v.x)).toBeLessThan(1e-9);
      expect(polylineLength([pts[0], pts[1]])).toBeGreaterThanOrEqual(1 - 1e-9);
    }
    if (bEnd.dir !== null) {
      const n = pts.length;
      const dx = pts[n - 1].x - pts[n - 2].x;
      const dy = pts[n - 1].y - pts[n - 2].y;
      const v = dirVector(bEnd.dir);
      expect(dx * v.x + dy * v.y).toBeLessThan(0);
      expect(Math.abs(dx * v.y - dy * v.x)).toBeLessThan(1e-9);
      expect(polylineLength([pts[n - 2], pts[n - 1]])).toBeGreaterThanOrEqual(1 - 1e-9);
    }
    // Clearance: non-incident segments stay 0.4+ away from both bodies.
    const slack = 0.4;
    const boxes: { rect: Rect; pin: Vec2 }[] = [];
    if (aEnd.body !== null) boxes.push({ rect: aEnd.body, pin: a });
    if (bEnd.body !== null) boxes.push({ rect: bEnd.body, pin: b });
    for (let i = 0; i + 1 < pts.length; i++) {
      for (const { rect, pin } of boxes) {
        const incident =
          (Math.abs(pts[i].x - pin.x) < 1e-9 && Math.abs(pts[i].y - pin.y) < 1e-9) ||
          (Math.abs(pts[i + 1].x - pin.x) < 1e-9 && Math.abs(pts[i + 1].y - pin.y) < 1e-9);
        if (incident) continue;
        const rx = rect.x - slack;
        const ry = rect.y - slack;
        const overlapX =
          Math.max(pts[i].x, pts[i + 1].x) > rx + 1e-9 &&
          Math.min(pts[i].x, pts[i + 1].x) < rx + rect.w + 2 * slack - 1e-9;
        const overlapY =
          Math.max(pts[i].y, pts[i + 1].y) > ry + 1e-9 &&
          Math.min(pts[i].y, pts[i + 1].y) < ry + rect.h + 2 * slack - 1e-9;
        expect(overlapX && overlapY, "clearance from component bodies").toBe(false);
      }
    }
  }

  it("400 random pin-to-pin routes hold every rule", () => {
    const rnd = lcg(20261015);
    let checked = 0;
    while (checked < 400) {
      const A = randomEnd(rnd);
      const B = randomEnd(rnd);
      // Keep the corpus to well-separated gates: paths that are forced to
      // squeeze between touching bodies may legitimately fall back.
      if (rectIntersects(inflateRect(A.body, 1.5), inflateRect(B.body, 1.5))) continue;
      const aEnd: LegEnd = { dir: A.dir, body: A.body };
      const bEnd: LegEnd = { dir: B.dir, body: B.body };
      const pts = routeLeg(A.pin, aEnd, B.pin, bEnd);
      assertInvariants(pts, A.pin, aEnd, B.pin, bEnd);
      checked++;
    }
  });

  it("200 junction drops (two allowed facings) hold every rule", () => {
    const rnd = lcg(424242);
    let checked = 0;
    while (checked < 200) {
      const A = randomEnd(rnd);
      const target = P(Math.round(rnd() * 30) - 5, Math.round(rnd() * 30) - 5);
      // Keep the target clear of the source body (same rationale as above).
      const near: Rect = { x: target.x, y: target.y, w: 0, h: 0 };
      if (rectIntersects(inflateRect(A.body, 2), near)) continue;
      const parentH = rnd() < 0.5;
      const dirs: Rotation[] = parentH ? ["N", "S"] : ["E", "W"];
      const ends: LegEnd[] = dirs.map((dir) => ({ dir, body: null }));
      const aEnd: LegEnd = { dir: A.dir, body: A.body };
      const pts = routeLeg(A.pin, aEnd, target, ends);
      assertInvariants(pts, A.pin, aEnd, target, { dir: null, body: null });
      checked++;
    }
  });
});
