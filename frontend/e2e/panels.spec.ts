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

  // One rail tab per registry group (Debugging included, §90), plus Subcircuits
  // — which is always on the rail now (UI_OVERHAUL §80), hint and all, so the
  // feature is discoverable before anyone has made one.
  await expect(page.locator(".palette-rail [role=tab]")).toHaveCount(9);

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

  await checkGroup("Wiring", "INPUT");
  await checkGroup("Plexers", "MUX");
  // A trapezoid says WHICH plexer it is (§17 rule 3), as its canvas body does: the
  // palette used to draw a bare trapezoid, which is ambiguity, not an icon.
  const muxTile = page
    .locator(".palette-group .palette-item")
    .filter({ has: page.locator(".palette-item-label", { hasText: /^MUX$/ }) });
  await expect(muxTile.locator("svg text")).toHaveText("MUX");
  await checkGroup("Plexers", "DEC");
  await checkGroup("Plexers", "PRI");
  // Arithmetic tiles keep the human name; the body shows the symbol (§18).
  await checkGroup("Arithmetic", "ADD");
  await checkGroup("Memory", "RAM");
  await checkGroup("I/O", "LED");
  await checkGroup("Misc", "TEXT");
  await checkGroup("Debugging", "Breakpoint");
  await checkGroup("Gates", "NAND");

  // Subcircuits has no tiles to check yet (there is nothing to place), and that is
  // the point: its empty state and New button are what make the group worth having.
  await page.locator('[data-group="Subcircuits"]').hover();
  await expect(page.locator(".palette-hint")).toContainText("No subcircuits yet");
  await expect(page.locator(".palette-new")).toBeVisible();

  // Clicking also selects (touch/keyboard paths).
  await page.locator('[data-group="Memory"]').click();
  await expect(page.getByRole("button", { name: "ROM", exact: true })).toBeVisible();
});

test("the first sheet tab clears the palette/editor boundary", async ({ page }) => {
  await page.goto("/");
  const palette = await page.locator(".palette").boundingBox();
  const tab = await page.locator(".sheet-tab-wrap").first().boundingBox();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (palette === null || tab === null || canvas === null) throw new Error("not visible");

  // The tab sits INSIDE the canvas column by a few px: flush, its border lands exactly
  // on the palette's edge, and — since the active tab takes the canvas colour — the
  // boundary reads as one line running down through the tab (maintainer report).
  expect(tab.x).toBeGreaterThan(palette.x + palette.width + 1);
  // …while the canvas itself still starts at the boundary: no drawing moves.
  expect(Math.abs(canvas.x - (palette.x + palette.width))).toBeLessThan(1);
});
