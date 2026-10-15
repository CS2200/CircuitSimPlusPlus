import { expect, test, type Page } from "@playwright/test";

/**
 * UI overhaul §2/§9 acceptance: the Settings theme picker (now under
 * File ▸ Settings…) and the title bar's light/dark toggle. Selecting a card
 * applies instantly (data-theme), marks the active card, persists to
 * localStorage, and survives a reload. OLED is the default for a fresh
 * profile.
 */

/** Open the Settings dialog via the top bar's File menu. */
async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
}

test("Settings: theme picker applies, persists, and survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "oled"); // fresh default

  await openSettings(page);
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();

  // The active card is marked; pick Light.
  await expect(page.locator('[data-theme-option="oled"]')).toHaveAttribute("aria-checked", "true");
  await page.locator('[data-theme-option="light"]').click();
  await expect(page.locator('[data-theme-option="light"]')).toHaveAttribute("aria-checked", "true");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("csx.theme"))).toBe("light");

  // Escape closes; the choice survives a reload, and the picker reflects it.
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  await openSettings(page);
  await expect(page.locator('[data-theme-option="light"]')).toHaveAttribute("aria-checked", "true");

  // Accent color applies through data-accent and persists.
  await page.locator('[data-accent-option="violet"]').click();
  await expect(page.locator(".app")).toHaveAttribute("data-accent", "violet");
  expect(await page.evaluate(() => localStorage.getItem("csx.accent"))).toBe("violet");

  // Behavior toggles persist too (pulses off).
  await page.getByLabel("Animate signal pulses").uncheck();
  expect(await page.evaluate(() => localStorage.getItem("csx.pulses"))).toBe("0");

  await page.keyboard.press("Escape");
  await page.reload();
  await expect(page.locator(".app")).toHaveAttribute("data-accent", "violet");
  await openSettings(page);
  await expect(page.locator('[data-accent-option="violet"]')).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByLabel("Animate signal pulses")).not.toBeChecked();

  // Reset to defaults restores the shipped appearance.
  await page.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "oled");
  await expect(page.locator(".app")).toHaveAttribute("data-accent", "auto");
  await expect(page.getByLabel("Animate signal pulses")).toBeChecked();
});

test("top bar: the light/dark toggle flips themes and restores the dark family", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "oled"); // dark family default

  await page.getByRole("button", { name: "Switch to light theme" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "light");
  expect(await page.evaluate(() => localStorage.getItem("csx.theme"))).toBe("light");

  await page.getByRole("button", { name: "Switch to dark theme" }).click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "oled");
});
