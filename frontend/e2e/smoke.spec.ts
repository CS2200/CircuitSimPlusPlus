import { test, expect } from "@playwright/test";

test("shell loads with the title bar and menus", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("CircuitSim++");
  await expect(page.getByRole("button", { name: "File", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Help", exact: true })).toBeVisible();
});
