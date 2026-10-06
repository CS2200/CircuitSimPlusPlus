import { describe, expect, it } from "vitest";
import { Camera } from "./camera";
import { Canvas2DRenderer, type Path2DLike } from "./canvas2d";
import type { FrameView, PathCmd, StrokeStyle } from "./renderer";

/** Recording Path2D stand-in. */
class FakePath implements Path2DLike {
  readonly ops: (string | number)[][] = [];
  moveTo(x: number, y: number): void {
    this.ops.push(["M", x, y]);
  }
  lineTo(x: number, y: number): void {
    this.ops.push(["L", x, y]);
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    this.ops.push(["Q", cx, cy, x, y]);
  }
  closePath(): void {
    this.ops.push(["Z"]);
  }
}

/** Recording 2D context stand-in (only what Canvas2DRenderer touches). */
class FakeCtx {
  fillStyle = "";
  strokeStyle = "";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  font = "";
  textAlign: CanvasTextAlign = "left";
  textBaseline: CanvasTextBaseline = "alphabetic";
  readonly transforms: number[][] = [];
  readonly strokes: string[] = [];
  readonly fills: string[] = [];
  readonly texts: string[] = [];
  readonly clearedWith: string[] = [];
  setTransform(...args: number[]): void {
    this.transforms.push(args);
  }
  fillRect(): void {
    this.clearedWith.push(this.fillStyle);
  }
  stroke(): void {
    this.strokes.push(this.strokeStyle);
  }
  fill(): void {
    this.fills.push(this.fillStyle);
  }
  fillText(text: string): void {
    this.texts.push(text);
  }
}

function setup() {
  const ctx = new FakeCtx();
  const paths: FakePath[] = [];
  const renderer = new Canvas2DRenderer(ctx as unknown as CanvasRenderingContext2D, () => {
    const p = new FakePath();
    paths.push(p);
    return p;
  });
  const view: FrameView = {
    camera: new Camera(0, 0, 16),
    viewport: { width: 800, height: 600, dpr: 2 },
    background: "#16161f",
  };
  return { ctx, paths, renderer, view };
}

const line = (y: number): PathCmd[] => [
  { t: "M", x: 0, y },
  { t: "L", x: 1, y },
];

const red: StrokeStyle = { stroke: "red", lineWidth: 1 };
const blue: StrokeStyle = { stroke: "blue", lineWidth: 1 };

describe("Canvas2DRenderer", () => {
  it("batches paths by style: one stroke pass per color", () => {
    const { ctx, paths, renderer, view } = setup();
    renderer.beginFrame(view);
    renderer.drawPath(line(0), red);
    renderer.drawPath(line(1), blue);
    renderer.drawPath(line(2), red);
    renderer.endFrame();
    expect(paths).toHaveLength(2); // one Path2D per style, not per path
    expect(paths[0].ops).toHaveLength(4); // both red polylines in one batch
    expect(ctx.strokes).toEqual(["red", "blue"]);
    expect(renderer.stats.paths).toBe(3);
    expect(renderer.stats.strokeBatches).toBe(2);
  });

  it("fill and stroke from one style batch", () => {
    const { ctx, paths, renderer, view } = setup();
    renderer.beginFrame(view);
    renderer.drawPath(line(0), { fill: "panel", stroke: "border", lineWidth: 0.5 });
    renderer.endFrame();
    expect(paths).toHaveLength(1);
    expect(ctx.fills).toEqual(["panel"]);
    expect(ctx.strokes).toEqual(["border"]);
  });

  it("flush marks layer boundaries (z-order across layers)", () => {
    const { ctx, paths, renderer, view } = setup();
    renderer.beginFrame(view);
    renderer.drawPath(line(0), { fill: "grid" });
    renderer.flush();
    renderer.drawPath(line(1), { fill: "grid" });
    renderer.endFrame();
    expect(paths).toHaveLength(2); // same style, but two layers → two batches
    expect(ctx.fills).toEqual(["grid", "grid"]);
  });

  it("applies the camera transform, dpr-aware", () => {
    const { ctx, renderer, view } = setup();
    renderer.beginFrame(view);
    expect(ctx.transforms.at(-1)).toEqual([32, 0, 0, 32, 800, 600]);
    expect(ctx.clearedWith).toEqual(["#16161f"]);
  });

  it("queues text and draws it in flush", () => {
    const { ctx, renderer, view } = setup();
    renderer.beginFrame(view);
    renderer.drawText(1, 2, "AND", { color: "#fff", size: 1.1, align: "center" });
    renderer.endFrame();
    expect(ctx.texts).toEqual(["AND"]);
    expect(renderer.stats.texts).toBe(1);
  });

  it("ignores empty path command lists", () => {
    const { ctx, paths, renderer, view } = setup();
    renderer.beginFrame(view);
    renderer.drawPath([], red);
    renderer.endFrame();
    expect(paths).toHaveLength(0);
    expect(ctx.strokes).toHaveLength(0);
  });
});
