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

  // …and the panel is a door into the definition, not just the canvas (§80).
  await page.getByRole("button", { name: "Edit definition" }).click();
  await expect(page.locator(".scope-bar")).toContainText("sub1");
});

test("the panel is there first, and a definition is a place you can enter and leave", async ({
  page,
}) => {
  await page.goto("/");

  // Before any subcircuit exists the group is still on the rail, with an empty
  // state and the way to make one (§80).
  await page.locator('[data-group="Subcircuits"]').click();
  await expect(page.locator(".palette-hint")).toContainText("No subcircuits yet");
  await page.locator(".palette-new").click();
  await page.keyboard.press("Escape"); // keeps the default name
  await page.getByRole("tab", { name: "main" }).click();

  // Place an instance of it: the tile says where it is used, and that changes the
  // moment it is placed.
  await page.locator('[data-group="Subcircuits"]').click();
  const tile = page.locator(".palette-group").getByRole("button", { name: "sub1" });
  await expect(tile).toContainText("not placed yet");
  await tile.click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  const center = { x: canvas.x + canvas.width / 2, y: canvas.y + canvas.height / 2 };
  await page.mouse.click(center.x, center.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector-id")).toHaveText("Subcircuit");
  await expect(tile).toContainText("used by main");

  // Double-clicking the instance opens the definition, and the scope bar says so
  // and knows the way back.
  await page.mouse.dblclick(center.x, center.y);
  await expect(page.locator(".scope-bar")).toContainText("sub1");
  await expect(page.locator(".scope-bar")).toContainText("used by main");
  await expect(page.locator(".scope-frame")).toBeVisible();

  await page.locator(".scope-back").click();
  await expect(page.locator(".scope-frame")).toHaveCount(0);
  await expect(page.locator(".scope-bar")).toHaveCount(0);
});
