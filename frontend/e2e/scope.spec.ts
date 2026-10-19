import { expect, test } from "@playwright/test";

/**
 * UI overhaul §77: the editor says which SCOPE you are in. The top level has no
 * scope mark at all; a subcircuit sheet gets a hue of its own on the active tab,
 * a frame around the canvas, and a chip in the status bar.
 */

test("a subcircuit sheet is marked as its own scope; the top level is not", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".scope-frame")).toHaveCount(0);

  // "+" makes a subcircuit and switches to it; its tab label becomes an input,
  // and Escape keeps the default name.
  await page.getByRole("button", { name: "New subcircuit" }).click();
  await page.keyboard.press("Escape");

  await expect(page.locator(".scope-frame")).toBeVisible();
  await expect(page.locator(".app-statusbar")).toContainText("in sub1");
  await expect(page.locator(".sheet-tab-wrap.active")).toHaveAttribute("data-scope", "subcircuit");

  // Back at the top level: no frame, no chip, and an unmarked tab.
  await page.getByRole("tab", { name: "main" }).click();
  await expect(page.locator(".scope-frame")).toHaveCount(0);
  await expect(page.locator(".app-statusbar")).not.toContainText(
    "instances follow this definition",
  );
  await expect(page.locator(".sheet-tab-wrap.active")).not.toHaveAttribute(
    "data-scope",
    "subcircuit",
  );
});
