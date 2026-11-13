import { expect, test, type Page } from "@playwright/test";

/**
 * Hover-menu robustness (UI_OVERHAUL §20, hardened in §106). Menus open on
 * hover, switch as the pointer crosses the bar, and close when it leaves — but
 * a hairline between a button and its popup (or the lower edge of the bar)
 * must not read as "left", or the menu flickers shut mid-reach. These tests
 * pin the three paths that regressed: reaching into a popup, skimming below
 * the bar, and changing bars.
 */

async function button(page: Page, name: string) {
  const b = page.getByRole("button", { name, exact: true });
  await expect(b).toBeVisible();
  return b;
}

test("hovering a menu, then reaching into it, keeps it open", async ({ page }) => {
  await page.goto("/");
  const file = await button(page, "File");
  const fb = (await file.boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);

  const pop = page.locator('.menu-pop[aria-label="File"]');
  await expect(pop).toBeVisible();

  // Travel down across the seam between the button and its popup.
  const item = page.getByRole("menuitem", { name: "New Circuit" });
  const ib = (await item.boundingBox())!;
  await page.mouse.move(ib.x + 20, ib.y + ib.height / 2, { steps: 12 });
  await expect(pop).toBeVisible();
  await expect(item).toBeVisible();
});

test("the pointer may skim below the bar without the menu flickering shut", async ({ page }) => {
  await page.goto("/");
  const file = await button(page, "File");
  const view = await button(page, "View");
  const fb = (await file.boundingBox())!;
  const vb = (await view.boundingBox())!;

  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  const pop = page.locator('.menu-pop[aria-label="File"]');
  await expect(pop).toBeVisible();

  // Drop just below the button row (the seam the popup sits under) and sweep
  // across it; the menu must stay put rather than close and reopen.
  const y = fb.y + fb.height + 2;
  await page.mouse.move(fb.x + 2, y, { steps: 6 });
  await page.mouse.move(vb.x + vb.width - 2, y, { steps: 30 });
  await page.waitForTimeout(300);
  await expect(pop).toBeVisible();
});

test("crossing the bar switches menus without closing", async ({ page }) => {
  await page.goto("/");
  const file = await button(page, "File");
  const fb = (await file.boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  await expect(page.locator('.menu-pop[aria-label="File"]')).toBeVisible();

  const edit = await button(page, "Edit");
  const eb = (await edit.boundingBox())!;
  await page.mouse.move(eb.x + eb.width / 2, eb.y + eb.height / 2, { steps: 8 });
  await expect(page.locator('.menu-pop[aria-label="Edit"]')).toBeVisible();
  await expect(page.locator('.menu-pop[aria-label="File"]')).toHaveCount(0);
});

test("leaving the bar closes the open menu", async ({ page }) => {
  await page.goto("/");
  const file = await button(page, "File");
  const fb = (await file.boundingBox())!;
  await page.mouse.move(fb.x + fb.width / 2, fb.y + fb.height / 2);
  const pop = page.locator('.menu-pop[aria-label="File"]');
  await expect(pop).toBeVisible();

  await page.mouse.move(640, 500);
  await expect(pop).toHaveCount(0);
});
