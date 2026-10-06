import { test, expect } from "@playwright/test";

test("shell loads and shows the app title", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "CircuitSim++" })).toBeVisible();
});
