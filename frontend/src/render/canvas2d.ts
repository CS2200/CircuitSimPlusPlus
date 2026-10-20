import type { Vec2 } from "./geom";
import type { FrameView, PathCmd, Renderer, RenderStats, StrokeStyle, TextStyle } from "./renderer";
import { styleKey } from "./renderer";

/** Subset of Path2D used by the renderer (DI seam for tests). */
export interface Path2DLike {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  closePath(): void;
}

interface StyleBatch {
  readonly style: StrokeStyle;
  readonly path: Path2DLike;
}

interface TextOp {
  readonly x: number;
  readonly y: number;
  readonly text: string;
  readonly style: TextStyle;
}

/**
 * Canvas 2D renderer (DESIGN.md §7.1 — "hand-rolled Canvas 2D inside one
 * React component"). Paths are accumulated into one `Path2D` per style and
 * flushed with a single `stroke()`/`fill()` per group ("group by state
 * color, single pass per color"). `flush()` marks a layer boundary: layers
 * preserve z-order, styles batch within a layer.
 */
export class Canvas2DRenderer implements Renderer {
  readonly stats: RenderStats = { paths: 0, texts: 0, strokeBatches: 0, fillBatches: 0 };
  private readonly batches = new Map<string, StyleBatch>();
  private texts: TextOp[] = [];

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly createPath: () => Path2DLike = () => new Path2D(),
  ) {}

  beginFrame(view: FrameView): void {
    const { camera, viewport, background } = view;
    const { width, height, dpr } = viewport;
    this.batches.clear();
    this.texts.length = 0;
    this.stats.paths = 0;
    this.stats.texts = 0;
    this.stats.strokeBatches = 0;
    this.stats.fillBatches = 0;

    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.fillStyle = background;
    // Cover the whole backing store even when the effective dpr rounds the
    // other axis by a sub-pixel (never leave an unfilled sliver at the edge).
    this.ctx.fillRect(0, 0, width + 1, height + 1);
    this.ctx.setTransform(
      dpr * camera.scale,
      0,
      0,
      dpr * camera.scale,
      dpr * (width / 2 - camera.x * camera.scale),
      dpr * (height / 2 - camera.y * camera.scale),
    );
  }

  drawPath(cmds: readonly PathCmd[], style: StrokeStyle): void {
    if (cmds.length === 0) return;
    const key = styleKey(style);
    let batch = this.batches.get(key);
    if (batch === undefined) {
      batch = { style, path: this.createPath() };
      this.batches.set(key, batch);
    }
    appendCmds(batch.path, cmds);
    this.stats.paths++;
  }

  drawDashedPath(cmds: readonly PathCmd[], style: StrokeStyle, dash: readonly number[]): void {
    if (cmds.length === 0) return;
    const path = this.createPath();
    appendCmds(path, cmds);
    this.ctx.globalAlpha = style.alpha ?? 1;
    if (style.fill !== undefined) {
      this.ctx.fillStyle = style.fill;
      this.ctx.fill(path as unknown as Path2D);
      this.stats.fillBatches++;
    }
    if (style.stroke !== undefined) {
      this.ctx.strokeStyle = style.stroke;
      this.ctx.lineWidth = style.lineWidth ?? 1;
      this.ctx.lineCap = "round";
      this.ctx.lineJoin = "round";
      this.ctx.setLineDash([...dash]);
      this.ctx.stroke(path as unknown as Path2D);
      this.ctx.setLineDash([]);
      this.stats.strokeBatches++;
    }
    this.ctx.globalAlpha = 1;
    this.stats.paths++;
  }

  drawDots(centers: readonly Vec2[], halfSize: number, color: string): void {
    if (centers.length === 0) return;
    this.ctx.fillStyle = color;
    const d = 2 * halfSize;
    for (const c of centers) {
      this.ctx.fillRect(c.x - halfSize, c.y - halfSize, d, d);
    }
  }

  drawText(x: number, y: number, text: string, style: TextStyle): void {
    this.texts.push({ x, y, text, style });
    this.stats.texts++;
  }

  /**
   * Text width in world units (UI_OVERHAUL §91). Measured the way the flush
   * rasterizes: in device space with a font sized to the live scale, then
   * divided back out — so the world-unit answer is the same one the glyphs are
   * laid out with, at every zoom.
   */
  measureText(text: string, size: number, font?: string): number {
    const t = this.ctx.getTransform();
    const scale = Math.hypot(t.a, t.b) || 1;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.font = `${size * scale}px ${font ?? "system-ui, sans-serif"}`;
    const w = this.ctx.measureText(text).width / scale;
    this.ctx.restore();
    return w;
  }

  flush(): void {
    for (const { style, path } of this.batches.values()) {
      this.ctx.globalAlpha = style.alpha ?? 1;
      if (style.fill !== undefined) {
        this.ctx.fillStyle = style.fill;
        this.ctx.fill(path as unknown as Path2D);
        this.stats.fillBatches++;
      }
      if (style.stroke !== undefined) {
        this.ctx.strokeStyle = style.stroke;
        this.ctx.lineWidth = style.lineWidth ?? 1;
        this.ctx.lineCap = "round";
        this.ctx.lineJoin = "round";
        this.ctx.stroke(path as unknown as Path2D);
        this.stats.strokeBatches++;
      }
    }
    this.ctx.globalAlpha = 1;
    // Text is rasterized in DEVICE space at its final pixel size. A font set in
    // world units (~1px for a body mark) has its metrics quantized at that size,
    // so `textBaseline = "middle"` lands a fraction of a WORLD pixel off — and
    // the camera then multiplies that by the zoom, which is why marks read
    // off-centre on a zoomed-in canvas and looked fine zoomed out. Positioning
    // the glyph at the transformed point with a font sized to the live scale
    // keeps it exact at every zoom.
    const t = this.ctx.getTransform();
    const textScale = Math.hypot(t.a, t.b) || 1;
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const op of this.texts) {
      this.ctx.fillStyle = op.style.color;
      this.ctx.font = `${op.style.size * textScale}px ${op.style.font ?? "system-ui, sans-serif"}`;
      this.ctx.textAlign = op.style.align ?? "left";
      this.ctx.textBaseline = "middle";
      this.ctx.fillText(op.text, t.a * op.x + t.c * op.y + t.e, t.b * op.x + t.d * op.y + t.f);
    }
    this.ctx.restore();
    this.batches.clear();
    this.texts.length = 0;
  }

  endFrame(): void {
    this.flush();
  }
}

function appendCmds(path: Path2DLike, cmds: readonly PathCmd[]): void {
  for (const c of cmds) {
    switch (c.t) {
      case "M":
        path.moveTo(c.x, c.y);
        break;
      case "L":
        path.lineTo(c.x, c.y);
        break;
      case "Q":
        path.quadraticCurveTo(c.cx, c.cy, c.x, c.y);
        break;
      case "Z":
        path.closePath();
        break;
    }
  }
}
