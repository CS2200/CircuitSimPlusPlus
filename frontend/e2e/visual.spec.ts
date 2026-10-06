import { expect, test } from "@playwright/test";

/**
 * U4 visual regression: the deterministic demo circuit (?demo=1) in both
 * themes. Baselines are committed; review changes against the DLS
 * reference look by eye (human sign-off per FRONTEND.md U4).
 */
test("demo circuit renders consistently (dark + light)", async ({ page }) => {
  await page.goto("/?demo=1");
  const canvas = page.locator("canvas.circuit-canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(400); // let the first frames settle
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" }); // fps text is nondeterministic
  await expect(page.locator(".editor-wrap")).toHaveScreenshot("demo-dark.png", {
    maxDiffPixelRatio: 0.02,
  });
  await page.getByRole("button", { name: "Light theme" }).click();
  await page.waitForTimeout(400);
  await expect(page.locator(".editor-wrap")).toHaveScreenshot("demo-light.png", {
    maxDiffPixelRatio: 0.02,
  });
});
