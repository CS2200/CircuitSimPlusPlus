import { expect, test } from "@playwright/test";

/**
 * The `?` shortcuts panel (UI_OVERHAUL §45). It used to be one long table that
 * ran off the bottom of the screen; it is now a two-column, scrollable card that
 * always fits the viewport.
 */
test("?: the shortcuts panel fits the viewport and lists the sections", async ({ page }) => {
  await page.goto("/");
  // The app registers its global key handler in a mount effect; give it a frame.
  await page.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  await page.keyboard.press("?");
  const card = page.locator(".help-shortcuts");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Keyboard & mouse");
  await expect(page.locator(".help-section")).toHaveCount(6);

  const box = await card.boundingBox();
  const vp = page.viewportSize();
  expect(box).not.toBeNull();
  expect(vp).not.toBeNull();
  if (box !== null && vp !== null) {
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
  }

  // Escape dismisses it.
  await page.keyboard.press("Escape");
  await expect(card).toHaveCount(0);
});
