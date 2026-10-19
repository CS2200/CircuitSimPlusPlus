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
  saved: number[][] = [];
  setTransform(...args: number[]): void {
    this.transforms.push(args);
    this.current = args;
  }
  /** The live transform (device pixels per world unit lives in a/d). */
  current: number[] = [1, 0, 0, 1, 0, 0];
  getTransform(): { a: number; b: number; c: number; d: number; e: number; f: number } {
    const [a, b, c, d, e, f] = this.current;
    return { a, b, c, d, e, f };
  }
  save(): void {
    this.saved.push(this.current);
  }
  restore(): void {
    this.current = this.saved.pop() ?? [1, 0, 0, 1, 0, 0];
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
  readonly textCalls: { text: string; font: string; x: number; y: number }[] = [];
  fillText(text: string, x: number, y: number): void {
    this.texts.push(text);
    this.textCalls.push({ text, font: this.font, x, y });
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

describe("text rendering (2026-10-19)", () => {
  it("rasterizes a glyph in device space at its final pixel size", () => {
    const { ctx, renderer, view } = setup();
    renderer.beginFrame(view); // camera scale 16 × dpr 2 = 32 device px per unit
    renderer.drawText(10, 20, "+", { color: "#fff", size: 1, align: "center" });
    renderer.endFrame();

    // The font carries the DEVICE size (world size × 32), the glyph lands on the
    // transformed point, and the camera transform is put back afterwards — the
    // mark was drawn with a ~1px font before, whose quantized metrics pushed
    // "middle" off by a zoom-dependent fraction.
    expect(ctx.textCalls.at(-1)).toEqual({
      text: "+",
      font: "32px system-ui, sans-serif",
      x: 10 * 32 + 800,
      y: 20 * 32 + 600,
    });
    expect(ctx.transforms.at(-1)).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

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
