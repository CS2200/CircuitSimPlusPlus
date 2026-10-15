import { expect, test, type Page } from "@playwright/test";

/**
 * UI overhaul §7 acceptance: resizable side panels (drag, persist,
 * double-click reset, keyboard step) and palette component glyphs (every
 * sidebar entry has an SVG miniature next to its name).
 */

async function widthOf(page: Page, selector: string): Promise<number> {
  const box = await page.locator(selector).boundingBox();
  if (box === null) throw new Error(`${selector} not visible`);
  return box.width;
}

/** Drag a resize handle horizontally by `dx` screen px. */
async function dragHandle(page: Page, panel: "palette" | "dock", dx: number): Promise<void> {
  const handle = page.locator(`[data-panel="${panel}"]`);
  const box = await handle.boundingBox();
  if (box === null) throw new Error(`handle ${panel} not visible`);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + dx, cy, { steps: 6 });
  await page.mouse.up();
}

test("palette resizes by drag, persists across reload, resets on double-click", async ({
  page,
}) => {
  await page.goto("/");
  const before = await widthOf(page, ".palette");
  expect(before).toBe(190); // default (rail + body)

  await dragHandle(page, "palette", 60);
  const grown = await widthOf(page, ".palette");
  expect(grown).toBeGreaterThan(before + 40);
  expect(await page.evaluate(() => localStorage.getItem("csx.panel.palette"))).toBe(
    String(Math.round(grown)),
  );

  // Persisted on this machine: a reload restores the width.
  await page.reload();
  expect(Math.abs((await widthOf(page, ".palette")) - grown)).toBeLessThan(1.5);

  // Double-click the separator resets the default.
  await page.locator('[data-panel="palette"]').dblclick();
  expect(Math.abs((await widthOf(page, ".palette")) - 190)).toBeLessThan(1.5);

  // Keyboard: ArrowRight on the focused handle grows by 8px.
  await page.locator('[data-panel="palette"]').focus();
  await page.keyboard.press("ArrowRight");
  expect(Math.abs((await widthOf(page, ".palette")) - 198)).toBeLessThan(1.5);

  // Clamped at the maximum (320): a huge drag never exceeds it.
  await dragHandle(page, "palette", 600);
  expect(await widthOf(page, ".palette")).toBe(320);
});

test("dock resizes by drag (grows leftward) with its own bounds", async ({ page }) => {
  await page.goto("/");
  const before = await widthOf(page, ".right-dock");
  expect(before).toBe(256); // default 16rem

  await dragHandle(page, "dock", -60);
  const grown = await widthOf(page, ".right-dock");
  expect(grown).toBeGreaterThan(before + 40);
  expect(await page.evaluate(() => localStorage.getItem("csx.panel.dock"))).toBe(
    String(Math.round(grown)),
  );

  // Clamped at the minimum (220): dragging far right shrinks no further.
  await dragHandle(page, "dock", 600);
  expect(await widthOf(page, ".right-dock")).toBe(220);
});

test("palette rail groups: hover swaps the body; every item keeps its icon", async ({ page }) => {
  await page.goto("/");

  // One rail tab per registry group (Subcircuits appears only with >1 circuit).
  await expect(page.locator(".palette-rail [role=tab]")).toHaveCount(6);

  // Gates is the default group.
  await expect(page.getByRole("button", { name: "AND", exact: true })).toBeVisible();

  const checkGroup = async (group: string, sample: string) => {
    await page.locator(`[data-group="${group}"]`).hover();
    await expect(page.getByRole("button", { name: sample, exact: true })).toBeVisible();
    const items = page.locator(".palette-group .palette-item");
    const count = await items.count();
    expect(count).toBeGreaterThan(0);
    expect(await items.locator("svg.comp-icon").count()).toBe(count);
  };

  await checkGroup("Wiring", "PIN");
  await checkGroup("Plexers", "MUX");
  await checkGroup("Plexers", "DECODER");
  await checkGroup("Arithmetic", "ADD");
  await checkGroup("Memory", "RAM");
  await checkGroup("I/O", "LED");
  await checkGroup("Gates", "NAND");

  // Clicking also selects (touch/keyboard paths).
  await page.locator('[data-group="Memory"]').click();
  await expect(page.getByRole("button", { name: "ROM", exact: true })).toBeVisible();
});
