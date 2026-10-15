import { test, expect } from "@playwright/test";

test("shell loads with the title bar and menus", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("CircuitSim++");
  await expect(page.getByRole("button", { name: "File", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Help", exact: true })).toBeVisible();
});

test("header shows the document name, the save chip and the action icons", async ({ page }) => {
  await page.goto("/");
  // Row 1: identity + actions (§28).
  await expect(page.locator(".app-title")).toHaveText("(unsaved)");
  await expect(page.locator(".appheader .save-state")).toHaveText("All changes saved");
  await expect(page.getByRole("button", { name: "Undo" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Version history" })).toBeVisible();
  // Row 2: menus and the sim transport share the bar.
  await expect(page.locator(".appheader-bottom .simbar")).toBeVisible();
  await expect(page.locator(".appheader")).toHaveCount(1);
});
