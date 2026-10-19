import { expect, test, type Page } from "@playwright/test";

/**
 * UI overhaul §75: the canvas context menu. A right CLICK — press and release
 * with no movement, the same gate that keeps right-DRAG panning — opens a menu
 * for whatever is under the pointer. The two older right-click meanings are
 * unchanged and stay pinned elsewhere: a gesture in progress is cancelled
 * (pan.spec.ts), and an idle click on a subcircuit instance jumps to its
 * definition (fileops.spec.ts).
 */

interface CsxDoc {
  circuits: { components: { id: string; type: string; pos: [number, number] }[] }[];
}

async function doc(page: Page): Promise<CsxDoc> {
  return page.evaluate(() =>
    JSON.parse((window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  );
}

/** World → screen, from the live camera (the mapping the canvas itself uses). */
async function world(page: Page, wx: number, wy: number): Promise<{ x: number; y: number }> {
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  const cam = await page.evaluate(() =>
    (
      window as unknown as { __circuitCamera: () => { x: number; y: number; scale: number } }
    ).__circuitCamera(),
  );
  return {
    x: box.x + (wx - cam.x) * cam.scale + box.width / 2,
    y: box.y + (wy - cam.y) * cam.scale + box.height / 2,
  };
}

async function clickCanvas(
  page: Page,
  wx: number,
  wy: number,
  button: "left" | "right" = "left",
): Promise<void> {
  const p = await world(page, wx, wy);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y, { button });
}

/** Place one AND gate: body [0,0], centered on world (2.5,1.5). */
async function placeAnd(page: Page): Promise<void> {
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await clickCanvas(page, 2.5, 1.5);
  await page.keyboard.press("Escape");
}

test("right-click a part opens its menu, and Delete takes it away", async ({ page }) => {
  await page.goto("/");
  await placeAnd(page);
  expect((await doc(page)).circuits[0].components).toHaveLength(1);

  await clickCanvas(page, 2.5, 1.5, "right");
  const menu = page.getByRole("menu", { name: "Component actions" });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText(/and/i); // the header names what it will hit
  await expect(menu.getByRole("menuitem", { name: "Rotate left" })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Paste" })).toBeDisabled(); // nothing copied

  await menu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("menu")).toHaveCount(0); // picking closes it
  expect((await doc(page)).circuits[0].components).toHaveLength(0);
});

test("bare canvas offers Paste only once something is copied; Escape closes it", async ({
  page,
}) => {
  await page.goto("/");
  await placeAnd(page);

  // Off the part (placed at the origin): canvas-wide commands only.
  await clickCanvas(page, 12, 10, "right");
  const menu = page.getByRole("menu", { name: "Canvas actions" });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Paste" })).toBeDisabled();
  await expect(menu.getByRole("menuitem", { name: "Select all" })).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // Copy the gate, then the very same menu offers a live Paste.
  await clickCanvas(page, 2.5, 1.5);
  await page.keyboard.press("Control+c");
  await clickCanvas(page, 12, 10, "right");
  await expect(page.getByRole("menuitem", { name: "Paste" })).toBeEnabled();
});

test("right-drag still pans, and opens nothing", async ({ page }) => {
  await page.goto("/");
  await placeAnd(page);
  const p = await world(page, 2.5, 1.5);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down({ button: "right" });
  for (let i = 1; i <= 6; i++) await page.mouse.move(p.x + 20 * i, p.y + 10 * i);
  await page.mouse.up({ button: "right" });
  await expect(page.getByRole("menu")).toHaveCount(0);
  expect((await doc(page)).circuits[0].components).toHaveLength(1); // nothing was hit
});
