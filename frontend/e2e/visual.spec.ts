import { expect, test } from "@playwright/test";
import { expectScreenshot } from "./screenshots";

/**
 * U4 visual regression: the deterministic demo circuit (?demo=1) in every
 * preconfigured theme. Dark is the fresh-profile default (UI_OVERHAUL §2);
 * OLED is pinned explicitly (it is no longer auto-selected) so its committed
 * baseline keeps validating. Dark/Light are unchanged pre-overhaul palettes.
 * Baselines are committed per platform; a new platform's first run writes them
 * (see e2e/screenshots.ts). Review changes against the DLS reference look by
 * eye (human sign-off per FRONTEND.md U4).
 */
test("demo circuit renders consistently across themes", async ({ page }, testInfo) => {
  // Freeze animations (the width-mismatch warning pulses) so the baseline is
  // deterministic; the canvas is still drawn in full. Pin OLED directly (with
  // the migration marker, so the OLED→Dark one-shot does not override it).
  await page.addInitScript(() => {
    localStorage.setItem("csx.pulses", "0");
    localStorage.setItem("csx.theme", "oled");
    localStorage.setItem("csx.theme.oled-migrated", "1");
  });
  await page.goto("/?demo=1");
  const canvas = page.locator("canvas.circuit-canvas");
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(400); // let the first frames settle
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" }); // fps text is nondeterministic

  const shot = page.locator(".editor-wrap");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "oled");
  await expectScreenshot(shot, testInfo, "demo-oled.png", { maxDiffPixelRatio: 0.02 });

  const pick = async (id: "dark" | "light") => {
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByRole("menuitem", { name: "Settings…" }).click();
    await page.locator(`[data-theme-option="${id}"]`).click();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  };

  await pick("dark");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "dark");
  await expectScreenshot(shot, testInfo, "demo-dark.png", { maxDiffPixelRatio: 0.02 });

  await pick("light");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  await expectScreenshot(shot, testInfo, "demo-light.png", { maxDiffPixelRatio: 0.02 });
});
