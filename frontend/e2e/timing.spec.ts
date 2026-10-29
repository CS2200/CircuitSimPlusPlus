import { expect, test } from "@playwright/test";
import { expectScreenshot } from "./screenshots";

/**
 * U7 (UI side): timing_update → T_obs banner → click highlights the
 * observed critical path on the canvas (component ids from the report).
 * The mock emits a fixed T_obs with the pc → adder → pc path.
 *
 * Full acceptance (pipeline5.csx fixture, real engine) lands with the
 * joint smoke test after Backend B9/B11.
 */

test.beforeEach(async ({ page }) => {
  // Pin the dark palette so the committed screenshots keep validating it
  // (UI_OVERHAUL §4; theme coverage lives in the visual/settings specs).
  await page.addInitScript(() => localStorage.setItem("csx.theme", "dark"));
  // Freeze the pulsing width-mismatch warning for a deterministic baseline.
  await page.addInitScript(() => localStorage.setItem("csx.pulses", "0"));
});

test("U7: T_obs banner toggles the critical-path highlight", async ({ page }, testInfo) => {
  await page.goto("/?simdemo=1");
  await page.locator(".sim-runto input").fill("10");
  await page.getByRole("button", { name: "run to" }).click();

  const tobs = page.locator(".sim-tobs");
  await expect(tobs).toBeVisible();
  await expect(tobs).toContainText("T_obs 42.5 ns");

  await tobs.click();
  await expect(tobs).toHaveClass(/active/);
  // Let pulses from the run expire so the baseline is deterministic.
  await page.waitForTimeout(800);
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" });
  await expectScreenshot(page.locator(".editor-wrap"), testInfo, "timing-path.png", {
    maxDiffPixelRatio: 0.02,
  });
  await tobs.click();
  await expect(tobs).not.toHaveClass(/active/);
});
