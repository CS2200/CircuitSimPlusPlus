import { expect, test } from "@playwright/test";

/**
 * U8: the update nudge — fetches the latest release tag (stubbed here),
 * shows the dialog when behind, "don't show again" persists per version.
 * The repo is selected via the ?updateRepo= dev hook (production repo is
 * set once the GitHub remote exists).
 */

const LATEST = { tag_name: "v99.0.0", html_url: "https://example.test/rel/v99.0.0" };

test("U8: nudge appears when behind, dismissal persists per version", async ({ page }) => {
  let fetched = 0;
  await page.route("https://api.github.com/repos/o/r/releases/latest", (route) => {
    fetched++;
    void route.fulfill({ json: LATEST });
  });

  await page.goto("/?updateRepo=o/r");
  const nudge = page.locator(".update-nudge");
  await expect(nudge).toBeVisible();
  await expect(nudge).toContainText("99.0.0");
  await expect(nudge.locator(".update-link")).toHaveAttribute("href", LATEST.html_url);
  expect(fetched).toBeGreaterThanOrEqual(1); // StrictMode double-mount in dev

  // Dismiss permanently → gone, and stays gone across a reload.
  await nudge.getByRole("button", { name: /Don't show again/ }).click();
  await expect(nudge).not.toBeVisible();
  await page.reload();
  await page.waitForTimeout(400); // give the check time to fire
  await expect(nudge).toHaveCount(0);
  const afterReload = fetched;
  expect(afterReload).toBeGreaterThanOrEqual(2); // it checked — the dismissal hid it
});

test("U8: offline check fails silently (no dialog, no crash)", async ({ page }) => {
  await page.route("https://api.github.com/**", (route) => void route.abort());
  await page.goto("/?updateRepo=o/r");
  await expect(page.locator("h1")).toHaveText("CircuitSim++");
  await page.waitForTimeout(400);
  await expect(page.locator(".update-nudge")).toHaveCount(0);
});

test("U8: About card shows version + unsigned-build workaround", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "About" }).click();
  const card = page.locator(".help-card");
  await expect(card).toContainText("Version 0.1.0");
  await expect(card).toContainText("unsigned");
  await expect(card).toContainText("SmartScreen");
  await page.keyboard.press("Escape");
});
