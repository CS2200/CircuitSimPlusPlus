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
  fillStyle: unknown = "";
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
    this.clearedWith.push(String(this.fillStyle));
  }
  stroke(): void {
    this.strokes.push(this.strokeStyle);
  }
  fill(): void {
    this.fills.push(typeof this.fillStyle === "string" ? this.fillStyle : "gradient");
    this.shadowsAtFill.push({ blur: this.shadowBlur, dy: this.shadowOffsetY });
  }
  shadowColor = "";
  shadowBlur = 0;
  shadowOffsetX = 0;
  shadowOffsetY = 0;
  readonly shadowsAtFill: { blur: number; dy: number }[] = [];
  readonly gradients: { y0: number; y1: number; stops: [number, string][] }[] = [];
  createLinearGradient(_x0: number, y0: number, _x1: number, y1: number) {
    const g = { y0, y1, stops: [] as [number, string][] };
    this.gradients.push(g);
    return { addColorStop: (at: number, c: string) => g.stops.push([at, c]) };
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

describe("component bodies (UI_OVERHAUL §97)", () => {
  it("fills top-to-bottom, casts a zoom-scaled shadow, then outlines without one", () => {
    const { ctx, renderer, view } = setup();
    renderer.beginFrame(view); // 16 px/unit × dpr 2 = 32 device px per world unit
    renderer.drawBody(line(0), {
      fill: "#202020",
      fillTop: "#404040",
      y0: 2,
      y1: 5,
      stroke: "#888888",
      lineWidth: 0.1,
      shadow: { color: "rgba(0,0,0,0.5)", blur: 0.5, dy: 0.25 },
    });
    // The gradient runs over the body's own extent, lighter at the top.
    expect(ctx.gradients).toEqual([
      {
        y0: 2,
        y1: 5,
        stops: [
          [0, "#404040"],
          [1, "#202020"],
        ],
      },
    ]);
    expect(ctx.fills).toEqual(["gradient"]);
    // Shadow sizes are world units scaled to device pixels (the spec ignores
    // the transform for shadows), so a shadow keeps its size relative to the part.
    expect(ctx.shadowsAtFill).toEqual([{ blur: 16, dy: 8 }]);
    // The outline comes after the restore: no shadow on the stroke.
    expect(ctx.strokes).toEqual(["#888888"]);
    expect(ctx.saved).toHaveLength(0);
  });

  it("is a flat fill with no gradient or shadow when none is asked for", () => {
    const { ctx, renderer, view } = setup();
    renderer.beginFrame(view);
    renderer.drawBody(line(0), { fill: "#202020" });
    expect(ctx.gradients).toEqual([]);
    expect(ctx.fills).toEqual(["#202020"]);
    expect(ctx.strokes).toEqual([]);
  });
});
