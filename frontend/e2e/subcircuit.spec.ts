import { expect, test } from "@playwright/test";

/**
 * Subcircuit instances: their box can carry its own size (UI_OVERHAUL §79). The
 * derivation itself is pinned by the catalog's unit tests — what this drives is the
 * panel path, which is where a student meets it.
 */

test("an instance offers its own box size in the Inspector", async ({ page }) => {
  await page.goto("/");

  // A subcircuit to instantiate ("+" makes it and switches to it; Escape keeps the
  // default name), then back to the top level.
  await page.getByRole("button", { name: "New subcircuit" }).click();
  await page.keyboard.press("Escape");
  await page.getByRole("tab", { name: "main" }).click();

  // Place an instance of it from the palette's Subcircuits group.
  await page.locator('[data-group="Subcircuits"]').click();
  // Scoped to the palette: the sheet TAB is a button named "sub1" too.
  await page.locator(".palette-group").getByRole("button", { name: "sub1" }).click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.press("Escape");

  // Placing an instance from the palette's Subcircuits group and selecting it
  // worked; now the box size is editable here (the picker widget itself is
  // exercised by the memory spec — what this pins is that an instance OFFERS its
  // own box size at all, with the pins' derivation as the default).
  await expect(page.locator(".inspector-id")).toHaveText("Subcircuit");
  const inspector = page.locator(".right-dock");
  await expect(inspector).toContainText("Height");
  await expect(inspector).toContainText("Width");
});
