import { expect, test } from "@playwright/test";

/**
 * U7 (UI side): timing_update → T_obs banner → click highlights the
 * observed critical path on the canvas (component ids from the report).
 * The mock emits a fixed T_obs with the pc → adder → pc path plus one
 * synthetic setup violation on the pc register (contract v1.1), so the
 * setup/hold marker path is exercised end to end.
 *
 * Full acceptance (pipeline5.csx fixture, real engine) lands with the
 * joint smoke test after Backend B9/B11.
 */

interface TimingUpdate {
  t_obs: number;
  est_time: number;
  violations: { circuit: string; comp_id: number; kind: string; detail: string }[];
  top_paths: { circuit: string; comps: number[]; delay_ns: number }[];
}

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
  await page.waitForTimeout(800);
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" });
  await expect(page.locator(".editor-wrap")).toHaveScreenshot("timing-path.png", {
    maxDiffPixelRatio: 0.02,
  });
  await tobs.click();
  await expect(tobs).not.toHaveClass(/active/);
});

test("U7 (v1.1): setup violation → count badge + current-sheet register marker", async ({
  page,
}) => {
  await page.goto("/?simdemo=1");
  await page.locator(".sim-runto input").fill("10");
  await page.getByRole("button", { name: "run to" }).click();

  // The count is derived from the violations LIST (contract v1.1).
  await expect(page.locator(".sim-violations")).toHaveText("· ⚠ 1 violation");

  // The violation names the demo document's own circuit and resolves to a
  // marker on the current sheet (the pc register).
  const timing = await page.evaluate(() =>
    (window as unknown as { __sim: { timing: () => TimingUpdate | null } }).__sim.timing(),
  );
  expect(timing?.violations).toHaveLength(1);
  expect(timing?.violations[0]).toMatchObject({ circuit: "mock-counter-demo", kind: "setup" });
  const markers = await page.evaluate(() =>
    (
      window as unknown as {
        __sim: { violationMarkers: () => { compId: string; kind: string; detail: string }[] };
      }
    ).__sim.violationMarkers(),
  );
  expect(markers).toHaveLength(1);
  expect(markers[0].kind).toBe("setup");
  expect(markers[0].detail).toContain("t_setup");

  // The marker renders on the canvas (ring + ⚠setup tag on the register).
  await page.waitForTimeout(800); // pulses expire → deterministic pixels
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" });
  await expect(page.locator(".editor-wrap")).toHaveScreenshot("timing-violation.png", {
    maxDiffPixelRatio: 0.02,
  });
});
