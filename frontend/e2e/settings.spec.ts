import { expect, test } from "@playwright/test";

/**
 * UI overhaul §2 acceptance: the Settings theme picker. Selecting a card
 * applies instantly (data-theme), marks the active card, persists to
 * localStorage, and survives a reload. OLED is the default for a fresh
 * profile.
 */
test("Settings: theme picker applies, persists, and survives reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "oled"); // fresh default

  await page.getByRole("button", { name: "Settings" }).click();
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
  await page.getByRole("button", { name: "Settings" }).click();
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
  await page.getByRole("button", { name: "Settings" }).click();
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
