import type { Camera, ViewSize } from "./camera";
import { inflateRect, pointsBounds, unionRects, type Rect, type Vec2 } from "./geom";
import { rectPath, roundedPath } from "./paths";
import type { PathCmd, Renderer, WireState } from "./renderer";
import { UniformGrid } from "./spatial";
import type { Theme } from "./theme";

/**
 * U1 acceptance harness: a deterministic synthetic scene of 5,000 wires +
 * 1,500 components (FRONTEND.md U1 "done when": pan/zoom/drag at 60 FPS).
 * U2 replaces this with the real `.csx` document model; the draw path
 * (culling → layer batching → renderer) is the production shape.
 *
 * All geometry is precomputed at generation (path command arrays are shared
 * across frames — no per-frame allocation), and wire-state animation is a
 * pure function of (wire id, time bucket), so frames allocate nothing
 * except the grid dots and query result arrays.
 */

export const STRESS_WIRE_COUNT = 5000;
export const STRESS_COMPONENT_COUNT = 1500;

const CELL_SIZE = 8;
const WIRE_RADIUS = 0.12; // DESIGN.md App. B.1: ~0.12 grid units
const WIRE_WIDTH_1BIT = 0.16;
const WIRE_WIDTH_BUS = 0.3;
const CHURN_MS = 300; // state animation bucket length
const GRID_MIN_SCREEN_STEP = 14; // px between grid dots before doubling step

export interface StressComponent {
  readonly id: number;
  readonly body: PathCmd[];
  readonly pins: PathCmd[];
  readonly label: string;
  readonly labelX: number;
  readonly labelY: number;
  readonly aabb: Rect;
}

export interface StressWire {
  readonly id: number;
  readonly points: readonly Vec2[];
  readonly rounded: PathCmd[];
  readonly straight: PathCmd[];
  readonly bitsize: number;
  readonly baseState: WireState;
  readonly aabb: Rect;
}

export interface SceneDrawStats {
  readonly visibleWires: number;
  readonly visibleComponents: number;
}

export class StressScene {
  private constructor(
    readonly wires: readonly StressWire[],
    readonly components: readonly StressComponent[],
    readonly bounds: Rect,
    private readonly wireIndex: UniformGrid,
    private readonly compIndex: UniformGrid,
  ) {}

  private bucket = 0;

  static generate(seed = 0xc5110): StressScene {
    const rand = mulberry32(seed);
    const wireIndex = new UniformGrid(CELL_SIZE);
    const compIndex = new UniformGrid(CELL_SIZE);
    let bounds: Rect = { x: 0, y: 0, w: 1, h: 1 };

    // Components on a jittered 50×30 grid.
    const components: StressComponent[] = [];
    const kinds = [
      { label: "AND", w: 5, h: 3, pinsL: 2, pinsR: 1 },
      { label: "OR", w: 5, h: 3, pinsL: 2, pinsR: 1 },
      { label: "XOR", w: 5, h: 3, pinsL: 2, pinsR: 1 },
      { label: "REG", w: 6, h: 4, pinsL: 2, pinsR: 2 },
      { label: "MUX", w: 4, h: 4, pinsL: 3, pinsR: 1 },
      { label: "RAM", w: 10, h: 6, pinsL: 3, pinsR: 2 },
    ];
    for (let i = 0; i < STRESS_COMPONENT_COUNT; i++) {
      const col = i % 50;
      const row = Math.floor(i / 50);
      const kind = kinds[Math.floor(rand() * kinds.length)];
      const x = 4 + col * 8 + (rand() - 0.5) * 3;
      const y = 4 + row * 6 + (rand() - 0.5) * 2;
      const pins: PathCmd[] = [];
      for (let p = 0; p < kind.pinsL; p++) {
        const py = y + (kind.h * (p + 1)) / (kind.pinsL + 1);
        pins.push({ t: "M", x: x - 0.7, y: py }, { t: "L", x, y: py });
      }
      for (let p = 0; p < kind.pinsR; p++) {
        const py = y + (kind.h * (p + 1)) / (kind.pinsR + 1);
        pins.push({ t: "M", x: x + kind.w, y: py }, { t: "L", x: x + kind.w + 0.7, y: py });
      }
      const aabb: Rect = { x: x - 0.7, y, w: kind.w + 1.4, h: kind.h };
      components.push({
        id: i,
        body: rectPath(x, y, kind.w, kind.h),
        pins,
        label: kind.label,
        labelX: x + kind.w / 2,
        labelY: y + kind.h / 2,
        aabb,
      });
      compIndex.insert(i, aabb);
      bounds = unionRects(bounds, aabb);
    }

    // Wires: random Manhattan polylines across the scene.
    const wires: StressWire[] = [];
    const sceneW = 50 * 8 + 8;
    const sceneH = 30 * 6 + 8;
    for (let i = 0; i < STRESS_WIRE_COUNT; i++) {
      let x = Math.round(rand() * (sceneW - 40)) + 4;
      let y = Math.round(rand() * (sceneH - 20)) + 4;
      const points: Vec2[] = [{ x, y }];
      const segs = 1 + Math.floor(rand() * 4);
      let horizontal = rand() < 0.5;
      for (let s = 0; s < segs; s++) {
        const len = 2 + Math.floor(rand() * 18);
        const dir = rand() < 0.5 ? 1 : -1;
        if (horizontal) x += len * dir;
        else y += len * dir;
        points.push({ x, y });
        horizontal = !horizontal;
      }
      const r = rand();
      const baseState: WireState =
        r < 0.45 ? "low" : r < 0.8 ? "high" : r < 0.88 ? "z" : r < 0.92 ? "x" : "disconnected";
      const rb = rand();
      const bitsize = rb < 0.6 ? 1 : rb < 0.85 ? 8 : 32;
      const aabb = pointsBounds(points);
      wires.push({
        id: i,
        points,
        rounded: roundedPath(points, WIRE_RADIUS),
        straight: roundedPath(points, 0),
        bitsize,
        baseState,
        aabb,
      });
      // Index per segment (tighter culling; segment-level pick candidates).
      for (let s = 0; s + 1 < points.length; s++) {
        wireIndex.insert(i, pointsBounds([points[s], points[s + 1]]));
      }
      bounds = unionRects(bounds, aabb);
    }

    return new StressScene(wires, components, bounds, wireIndex, compIndex);
  }

  /** Advance the deterministic state-churn clock (demo of state colors). */
  setTimeMs(tMs: number): void {
    this.bucket = Math.floor(tMs / CHURN_MS);
  }

  /** Wire state: a deterministic function of (id, time bucket) — no RNG per frame. */
  wireState(wire: StressWire): WireState {
    const h = hashInt(wire.id);
    if (h % 8 === this.bucket % 8) {
      return ((h ^ this.bucket) & 1) === 0 ? "high" : "low";
    }
    return wire.baseState;
  }

  /** Draw one frame: cull → grid layer → wire layer → component layer. */
  draw(renderer: Renderer, theme: Theme, camera: Camera, view: ViewSize): SceneDrawStats {
    const visible = inflateRect(camera.visibleWorldRect(view), 2);
    const wireIds = this.wireIndex.queryRect(visible);
    const compIds = this.compIndex.queryRect(visible);

    drawGrid(renderer, theme.grid, visible, camera.scale);

    const radius = camera.scale >= 4 ? WIRE_RADIUS : 0; // LOD: skip rounding when tiny
    for (const id of wireIds) {
      const wire = this.wires[id];
      renderer.drawPath(radius > 0 ? wire.rounded : wire.straight, {
        stroke: wireColor(theme, wire, this.wireState(wire)),
        lineWidth: wire.bitsize > 1 ? WIRE_WIDTH_BUS : WIRE_WIDTH_1BIT,
      });
    }
    renderer.flush();

    const showLabels = camera.scale >= 8; // LOD: skip labels when tiny
    for (const id of compIds) {
      const c = this.components[id];
      renderer.drawPath(c.body, { fill: theme.panel });
      renderer.drawPath(c.body, { stroke: theme.panelBorder, lineWidth: 0.12 });
      renderer.drawPath(c.pins, { stroke: theme.textDim, lineWidth: 0.1 });
      if (showLabels) {
        renderer.drawText(c.labelX, c.labelY, c.label, {
          color: theme.textDim,
          size: 1.1,
          align: "center",
        });
      }
    }
    renderer.flush();

    return { visibleWires: wireIds.length, visibleComponents: compIds.length };
  }
}

/** Per-wire color: state colors for 1-bit nets, rainbow hues for buses (DLS look). */
function wireColor(theme: Theme, wire: StressWire, state: WireState): string {
  if (state !== "low" && state !== "high") return theme.wire[state];
  if (wire.bitsize > 1) return theme.bus[wire.id % theme.bus.length];
  return theme.wire[state];
}

/** Adaptive dot grid: step doubles until dots are ≥ ~12 CSS px apart. */
function drawGrid(renderer: Renderer, color: string, visible: Rect, scale: number): void {
  let step = 1;
  while (step * scale < GRID_MIN_SCREEN_STEP) step *= 2;
  const r = 0.055 * Math.min(step, 2);
  const dots: Vec2[] = [];
  const x0 = Math.ceil(visible.x / step) * step;
  const y0 = Math.ceil(visible.y / step) * step;
  for (let x = x0; x <= visible.x + visible.w; x += step) {
    for (let y = y0; y <= visible.y + visible.h; y += step) {
      dots.push({ x, y });
    }
  }
  renderer.drawDots(dots, r, color);
}

function hashInt(i: number): number {
  let h = Math.imul(i + 0x9e3779b9, 2654435761);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return h >>> 0;
}

/** Deterministic PRNG (scene generation must be reproducible). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
