import { expect, test, type Page } from "@playwright/test";

/**
 * U5 acceptance (mock side): the full sim control loop against the in-page
 * mock core — load, step, run-to-N, play/pause with live cycle telemetry,
 * watch-panel values, wire state coloring, and the halt path (floating-read
 * banner + component marker).
 *
 * The dev server picks up `VITE_MOCK_CORE=1` from `.env.development`; the
 * page loads the mock demo circuit (?simdemo=1).
 */

interface SimState {
  loaded: boolean;
  running: boolean;
  cycle: number;
  halted: string | null;
  netCount: number;
}

function simState(page: Page): Promise<SimState> {
  return page.evaluate(() =>
    (window as unknown as { __sim: { state: () => SimState } }).__sim.state(),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("/?simdemo=1");
});

test("U5: full sim control loop over the mock core", async ({ page }) => {
  // First command auto-loads the document into the core.
  await page.getByRole("button", { name: "cycle", exact: true }).click();
  await expect
    .poll(() => simState(page), { message: "loaded, one cycle stepped" })
    .toMatchObject({ loaded: true, cycle: 1 });
  await expect(page.locator(".sim-status")).toContainText("cycle 1");

  // Watch panel: pc counted to 1, next_pc shows the adder's output.
  await expect(page.locator('[data-watch="pc"] .watch-value')).toHaveText("0x00000001");
  await expect(page.locator('[data-watch="next_pc"] .watch-value')).toHaveText("0x00000002");

  // Display modes: cycle pc's row to unsigned.
  await page.locator('[data-watch="pc"] .watch-mode').click();
  await expect(page.locator('[data-watch="pc"] .watch-value')).toHaveText("1");

  // run-to-cycle-N.
  await page.locator(".sim-runto input").fill("42");
  await page.getByRole("button", { name: "run to" }).click();
  await expect.poll(() => simState(page)).toMatchObject({ cycle: 42 });
  await expect(page.locator('[data-watch="pc"] .watch-value')).toHaveText("42");

  // Play: cycle advances on its own; pause freezes it.
  await page.locator(".sim-play").click();
  await expect.poll(() => simState(page)).toMatchObject({ running: true });
  const before = (await simState(page)).cycle;
  await expect
    .poll(async () => (await simState(page)).cycle, { message: "cycle advances while running" })
    .toBeGreaterThan(before);
  await page.locator(".sim-play").click(); // pause
  await expect.poll(() => simState(page)).toMatchObject({ running: false });
  const frozen = (await simState(page)).cycle;
  await page.waitForTimeout(300);
  expect((await simState(page)).cycle).toBe(frozen);
  // Timing update arrives on pause (the T_obs critical-path button, U7).
  await expect(page.locator(".sim-tobs")).toContainText("T_obs");
});

test("U5: consuming a floating bus halts with a banner", async ({ page }) => {
  await page.getByRole("button", { name: "tick", exact: true }).click(); // load + 1 tick (clk high)
  await page.getByRole("button", { name: "tick", exact: true }).click(); // clk falls → bus floats
  await page.evaluate(() => {
    const sim = (
      window as unknown as {
        __sim: { poke: (c: number, p: string, v: object) => Promise<void> };
      }
    ).__sim;
    return sim.poke(5, "consume", { v: "0", x: "0", z: "0" }); // comp 5 = buffer
  });
  await expect(page.locator(".sim-banner")).toContainText("floating-read");
  await expect(page.locator(".sim-banner")).toContainText("comp 5");
  await expect.poll(() => simState(page)).toMatchObject({ halted: "floating-read" });
});

test("U5: wires render in sim state colors (lit-circuit baseline)", async ({ page }) => {
  await page.getByRole("button", { name: "tick", exact: true }).click(); // clk high, bus driven
  await expect.poll(() => simState(page)).toMatchObject({ loaded: true, cycle: 0 });
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" });
  await expect(page.locator(".editor-wrap")).toHaveScreenshot("sim-lit.png", {
    maxDiffPixelRatio: 0.02,
  });
});
