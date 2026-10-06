import { describe, expect, it } from "vitest";
import { Camera } from "./camera";
import type { Vec2 } from "./geom";
import type { PathCmd, Renderer, RenderStats, StrokeStyle, TextStyle } from "./renderer";
import {
  StressScene,
  STRESS_COMPONENT_COUNT,
  STRESS_WIRE_COUNT,
  type SceneDrawStats,
} from "./stressScene";
import { FALLBACK_THEME } from "./theme";

/** Records draw calls; no canvas needed. */
class RecordingRenderer implements Renderer {
  paths = 0;
  texts = 0;
  flushes = 0;
  dotCount = 0;
  readonly styleKeys = new Set<string>();
  readonly stats: RenderStats = { paths: 0, texts: 0, strokeBatches: 0, fillBatches: 0 };
  beginFrame(): void {}
  drawPath(cmds: readonly PathCmd[], style: StrokeStyle): void {
    if (cmds.length > 0) {
      this.paths++;
      this.styleKeys.add(JSON.stringify(style));
    }
  }
  drawText(x: number, y: number, text: string, style: TextStyle): void {
    void [x, y, text, style];
    this.texts++;
  }
  drawDots(centers: readonly Vec2[], halfSize: number, color: string): void {
    void [halfSize, color];
    this.dotCount = centers.length;
  }
  flush(): void {
    this.flushes++;
  }
  endFrame(): void {
    this.flush();
  }
}

function drawWith(scene: StressScene, cam: Camera, width = 800, height = 600) {
  const renderer = new RecordingRenderer();
  const stats: SceneDrawStats = scene.draw(renderer, FALLBACK_THEME, cam, { width, height });
  return { renderer, stats };
}

describe("StressScene (U1 acceptance harness)", () => {
  it("generates 5,000 wires + 1,500 components", () => {
    const scene = StressScene.generate();
    expect(scene.wires).toHaveLength(STRESS_WIRE_COUNT);
    expect(scene.components).toHaveLength(STRESS_COMPONENT_COUNT);
  });

  it("generation is deterministic", () => {
    const a = StressScene.generate();
    const b = StressScene.generate();
    expect(JSON.stringify(a.wires[123])).toBe(JSON.stringify(b.wires[123]));
    expect(JSON.stringify(a.components[77])).toBe(JSON.stringify(b.components[77]));
    expect(a.bounds).toEqual(b.bounds);
  });

  it("state churn is a pure function of (wire, time)", () => {
    const scene = StressScene.generate();
    scene.setTimeMs(0);
    const t0 = scene.wires.slice(0, 300).map((w) => scene.wireState(w));
    scene.setTimeMs(900);
    const t3 = scene.wires.slice(0, 300).map((w) => scene.wireState(w));
    scene.setTimeMs(0);
    expect(scene.wires.slice(0, 300).map((w) => scene.wireState(w))).toEqual(t0);
    expect(t3).not.toEqual(t0); // some wires actually churn
  });

  it("culls to the viewport: small view draws a subset, full view draws all", () => {
    const scene = StressScene.generate();
    const corner = new Camera(scene.bounds.x + 12, scene.bounds.y + 12, 16);
    const small = drawWith(scene, corner);
    expect(small.stats.visibleWires).toBeLessThan(scene.wires.length / 4);
    expect(small.stats.visibleComponents).toBeLessThan(scene.components.length / 4);

    const full = new Camera(
      scene.bounds.x + scene.bounds.w / 2,
      scene.bounds.y + scene.bounds.h / 2,
      2,
    );
    const big = drawWith(scene, full, 1600, 1200);
    expect(big.stats.visibleWires).toBe(scene.wires.length);
    expect(big.stats.visibleComponents).toBe(scene.components.length);
  });

  it("draws grid dots (immediate) + two batched layers (wires, components)", () => {
    const scene = StressScene.generate();
    const cam = new Camera(scene.bounds.x + 12, scene.bounds.y + 12, 16);
    const { renderer } = drawWith(scene, cam);
    expect(renderer.dotCount).toBeGreaterThan(0);
    expect(renderer.flushes).toBe(2); // wire layer, component layer
    // wire states low/high/z/x/disconnected + bus hues + panel styles
    expect(renderer.styleKeys.size).toBeGreaterThanOrEqual(5);
    expect(renderer.paths).toBeGreaterThan(0);
  });

  it("labels are a zoom-dependent LOD", () => {
    const scene = StressScene.generate();
    const zoomedIn = drawWith(scene, new Camera(scene.bounds.x + 12, scene.bounds.y + 12, 16));
    expect(zoomedIn.renderer.texts).toBeGreaterThan(0);
    const zoomedOut = drawWith(scene, new Camera(scene.bounds.x + 12, scene.bounds.y + 12, 3));
    expect(zoomedOut.renderer.texts).toBe(0);
  });
});
