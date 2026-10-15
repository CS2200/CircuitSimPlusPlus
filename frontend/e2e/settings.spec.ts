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

/** Switch to a section of the sectioned settings panel (UI_OVERHAUL §25). */
async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole("dialog", { name: "Settings" })
    .getByRole("tab", { name, exact: true })
    .click();
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

  // Behavior toggles persist too (pulses off) — they live in the Canvas
  // section of the sectioned panel (UI_OVERHAUL §25).
  await openSection(page, "Canvas");
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
  await openSection(page, "Canvas");
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

test("Settings: the canvas grid overlay toggles and persists", async ({ page }) => {
  await page.goto("/");
  // Off by default (the pref is written on load, so it lands as "0").
  expect(await page.evaluate(() => localStorage.getItem("csx.grid"))).toBe("0");

  const gridToggle = () =>
    page
      .getByRole("dialog", { name: "Settings" })
      .locator(".settings-toggle", { hasText: "Show grid" })
      .locator("input");

  await openSettings(page);
  await openSection(page, "Canvas");
  await expect(gridToggle()).not.toBeChecked();
  await gridToggle().check();
  expect(await page.evaluate(() => localStorage.getItem("csx.grid"))).toBe("1");

  await page.keyboard.press("Escape");
  await page.reload();
  await openSettings(page);
  await openSection(page, "Canvas");
  await expect(gridToggle()).toBeChecked();
});

test("Settings: sectioned panel — new themes, accents and editing prefs persist", async ({
  page,
}) => {
  await page.goto("/");
  await openSettings(page);

  // A new theme from the catalogue applies and persists (UI_OVERHAUL §25).
  await page.locator('[data-theme-option="nord"]').click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "nord");
  expect(await page.evaluate(() => localStorage.getItem("csx.theme"))).toBe("nord");
  await page.locator('[data-theme-option="dracula"]').click();
  await expect(page.locator(".app")).toHaveAttribute("data-theme", "dracula");

  // A new accent likewise.
  await page.locator('[data-accent-option="cyan"]').click();
  await expect(page.locator(".app")).toHaveAttribute("data-accent", "cyan");

  // Editing prefs seed new parts: 8-bit AND with 4 inputs.
  await openSection(page, "Editing");
  await page.getByLabel("Default bit width").selectOption("8");
  await page.getByLabel("Default gate inputs").selectOption("4");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "AND", exact: true }).click();
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  const d = (await page.evaluate(() =>
    JSON.parse((window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  )) as { circuits: { components: { type: string; attrs?: Record<string, unknown> }[] }[] };
  const and = d.circuits[0].components.find((c) => c.type === "gate.and");
  expect(and?.attrs).toMatchObject({ bitsize: 8, inputs: 4 });
  expect(await page.evaluate(() => localStorage.getItem("csx.defaultBits"))).toBe("8");
});
