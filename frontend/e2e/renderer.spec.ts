import { expect, test } from "@playwright/test";

test.describe.configure({ retries: 1 });

// The benchmark below gates *render cost*, so it measures whatever else the
// machine is doing: with several workers running SwiftShader side by side, a
// momentary spike can push a p95 over the 60 FPS budget. One retry absorbs a
// spike; a real regression fails twice and still fails.
/**
 * U1 acceptance: the stress scene (5,000 wires + 1,500 components) renders
 * and pans/zooms at interactive frame rates. The bench gates per-frame
 * render cost against the 16.7 ms budget; wall rAF fps is logged for the
 * report (it includes present/composite overhead of the headless
 * environment, which real GPU-backed webviews don't have).
 *
 * Note: functions passed to page.evaluate/waitForFunction are serialized to
 * the browser — they must not reference Node-side helpers, hence the inline
 * window casts.
 */

interface BenchResult {
  frames: number;
  wallMs: number;
  rafFps: number;
  avgRenderMs: number;
  p95RenderMs: number;
  maxRenderMs: number;
}

test("canvas renders the stress scene (non-blank)", async ({ page }) => {
  await page.goto("/?stress=1");
  const canvas = page.locator("canvas.circuit-canvas");
  await expect(canvas).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __circuitStats?: () => unknown }).__circuitStats?.() != null,
  );

  const stats = await page.evaluate(() =>
    (
      window as unknown as {
        __circuitStats: () => { stats: { visibleWires: number; visibleComponents: number } };
      }
    ).__circuitStats(),
  );
  expect(stats.stats.visibleWires).toBeGreaterThan(0);
  expect(stats.stats.visibleComponents).toBeGreaterThan(0);

  // Pixel-level: many distinct colors on screen (wires, comps, grid, bg).
  const distinct = await page.evaluate(() => {
    const c = document.querySelector("canvas.circuit-canvas") as HTMLCanvasElement;
    const ctx = c.getContext("2d")!;
    const colors = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const x = Math.floor((((i * 53) % 200) * (c.width - 1)) / 200);
      const y = Math.floor((((i * 97) % 200) * (c.height - 1)) / 200);
      colors.add(Array.from(ctx.getImageData(x, y, 1, 1).data).join(","));
    }
    return colors.size;
  });
  expect(distinct).toBeGreaterThan(3);
});

test("U1 acceptance: stress scene benchmark (measured, reported)", async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto("/?stress=1");
  await page.waitForFunction(
    () => (window as unknown as { __circuitBench?: unknown }).__circuitBench !== undefined,
  );
  const result = await page.evaluate(() =>
    (window as unknown as { __circuitBench: (n: number) => Promise<BenchResult> }).__circuitBench(
      300,
    ),
  );
  console.log(
    `U1 BENCH — ${result.frames} frames · rAF ${result.rafFps.toFixed(1)} fps · ` +
      `render avg ${result.avgRenderMs.toFixed(2)} ms · p95 ${result.p95RenderMs.toFixed(2)} ms · ` +
      `max ${result.maxRenderMs.toFixed(2)} ms`,
  );
  // Gate on per-frame render cost being inside the 60 FPS budget even under
  // software raster (headless SwiftShader — the worst case; real webviews
  // GPU-accelerate Canvas2D). Wall rAF fps includes present overhead we
  // don't control, so it is reported, not gated.
  expect(result.avgRenderMs).toBeLessThan(16.7);
  expect(result.p95RenderMs).toBeLessThan(16.7);
});
