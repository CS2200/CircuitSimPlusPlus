import { describe, expect, it } from "vitest";
import { Camera, snap, snapPoint } from "./camera";

const view = { width: 800, height: 600 };

describe("Camera", () => {
  it("round-trips world ↔ screen", () => {
    const cam = new Camera(12.5, -4, 24);
    const p = { x: 100.25, y: -30.5 };
    const s = cam.worldToScreen(p, view);
    const w = cam.screenToWorld(s, view);
    expect(w.x).toBeCloseTo(p.x, 10);
    expect(w.y).toBeCloseTo(p.y, 10);
  });

  it("projects the camera center to the viewport center", () => {
    const cam = new Camera(5, 7, 16);
    expect(cam.worldToScreen({ x: 5, y: 7 }, view)).toEqual({ x: 400, y: 300 });
  });

  it("zoomAt keeps the cursor's world point fixed", () => {
    const cam = new Camera(0, 0, 16);
    const cursor = { x: 620, y: 130 };
    const before = cam.screenToWorld(cursor, view);
    cam.zoomAt(cursor, 1.5, view);
    const after = cam.screenToWorld(cursor, view);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    expect(cam.scale).toBeCloseTo(24, 10);
  });

  it("clamps zoom to [MIN_SCALE, MAX_SCALE]", () => {
    const cam = new Camera(0, 0, 16);
    cam.zoomAt({ x: 0, y: 0 }, 1e9, view);
    expect(cam.scale).toBe(Camera.MAX_SCALE);
    cam.zoomAt({ x: 0, y: 0 }, 1e-9, view);
    expect(cam.scale).toBe(Camera.MIN_SCALE);
  });

  it("panByScreen moves the world opposite the drag", () => {
    const cam = new Camera(0, 0, 16);
    cam.panByScreen(160, -32);
    expect(cam.x).toBeCloseTo(-10, 10);
    expect(cam.y).toBeCloseTo(2, 10);
  });

  it("visibleWorldRect covers the viewport in world units", () => {
    const cam = new Camera(10, 20, 8);
    expect(cam.visibleWorldRect(view)).toEqual({ x: -40, y: -17.5, w: 100, h: 75 });
  });
});

describe("snap", () => {
  it("snaps values and points to the nearest grid multiple", () => {
    expect(snap(3.4, 1)).toBe(3);
    expect(snap(3.6, 1)).toBe(4);
    expect(snap(7.25, 0.5)).toBe(7.5);
    expect(snapPoint({ x: 1.2, y: 5.7 }, 0.5)).toEqual({ x: 1, y: 5.5 });
  });
});
