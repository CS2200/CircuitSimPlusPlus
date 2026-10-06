import { expect, test } from "@playwright/test";

/**
 * U7 (UI side): timing_update → T_obs banner → click highlights the
 * observed critical path on the canvas (component ids from the report).
 * The mock emits a fixed T_obs with the pc → adder → pc path.
 *
 * Full acceptance (pipeline5.csx fixture, event-timestamp pulses, real
 * engine) lands with the joint smoke test after Backend B9/B11.
 */
test("U7: T_obs banner toggles the critical-path highlight", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await page.locator(".sim-runto input").fill("10");
  await page.getByRole("button", { name: "run to" }).click();

  const tobs = page.locator(".sim-tobs");
  await expect(tobs).toBeVisible();
  await expect(tobs).toContainText("T_obs 42.5 ns");

  await tobs.click();
  await expect(tobs).toHaveClass(/active/);
  // Let pulses from the run expire so the baseline is deterministic.
  await page.waitForTimeout(600);
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" });
  await expect(page.locator(".editor-wrap")).toHaveScreenshot("timing-path.png", {
    maxDiffPixelRatio: 0.02,
  });
  await tobs.click();
  await expect(tobs).not.toHaveClass(/active/);
});
