import { expect, test, type Page } from "@playwright/test";

/**
 * U6 acceptance: set a RAM autoload image, run, modify RAM via poke
 * (mem_write), reset → the inspector shows the file image restored
 * (DESIGN.md §5.2 reset semantics) with a confirming toast.
 *
 * The mock's autoload convention embeds the image inline: "hex:<rle-hex>".
 */

interface SimState {
  loaded: boolean;
  running: boolean;
  cycle: number;
  halted: string | null;
  netCount: number;
}

function simState(page: Page): Promise<SimState> {
  return page.evaluate(() =>
    (window as unknown as { __sim: { state: () => SimState } }).__sim.state(),
  );
}

/** World→screen via the live camera (same helper as editor.spec). */
async function world(page: Page, wx: number, wy: number): Promise<{ x: number; y: number }> {
  const cam = await page.evaluate(() => {
    const c = (
      window as unknown as { __circuitCamera: () => { x: number; y: number; scale: number } }
    ).__circuitCamera();
    return c;
  });
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not laid out");
  return {
    x: box.x + box.width / 2 + (wx - cam.x) * cam.scale,
    y: box.y + box.height / 2 + (wy - cam.y) * cam.scale,
  };
}

test("U6: autoload → poke-modify → reset restores the image (with toast)", async ({ page }) => {
  await page.goto("/?simdemo=1");

  // Set the autoload image on imem through the Inspector (right dock).
  const imemCenter = await world(page, 7, 17); // imem body center
  await page.mouse.click(imemCenter.x, imemCenter.y);
  const inspector = page.locator(".inspector");
  await expect(inspector).toBeVisible();
  const autoload = inspector.locator('.inspector-row:has-text("Autoload") input');
  await autoload.fill("hex:0a 0b 0c");
  await autoload.press("Enter");

  // Load (any command loads); the selection opened the Inspector tab, so
  // switch the right dock to Watch and open the memory inspector.
  await page.getByRole("button", { name: "tick", exact: true }).click();
  await expect.poll(() => simState(page)).toMatchObject({ loaded: true });
  await page.getByRole("tab", { name: "Watch" }).click();
  await page.locator('[data-watch="imem"] .watch-mem').click();
  const grid = page.locator('.memory-inspector[data-mem="imem"] .mem-grid');
  await expect(grid).toBeVisible();
  const firstRow = grid.locator("tr").first();
  await expect(firstRow).toContainText("0000000a");
  await expect(firstRow).toContainText("0000000b");
  await expect(firstRow).toContainText("0000000c");

  // Modify RAM via poke (mem_write) — inspector refreshes while paused.
  await page.evaluate(() =>
    (
      window as unknown as {
        __sim: { memWrite: (n: string, a: number, v: object[]) => Promise<void> };
      }
    ).__sim.memWrite("imem", 0, [{ v: "dead", x: "", z: "" }]),
  );
  await expect(firstRow).toContainText("0000dead");

  // Reset: engine reset + autoload re-applies → image restored + toast.
  await page.getByRole("button", { name: "reset" }).click();
  await expect(page.locator(".toast")).toContainText("imem");
  await expect(firstRow).toContainText("0000000a");
  await expect(firstRow).not.toContainText("0000dead");
});

test("U6: inspector is read-only while running", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await page.getByRole("button", { name: "tick", exact: true }).click(); // load
  await page.locator('[data-watch="imem"] .watch-mem').click();
  const inspector = page.locator('.memory-inspector[data-mem="imem"]');
  await expect(inspector).toBeVisible();
  // Edit a cell while paused (works), then while running (blocked).
  await inspector.locator(".mem-cell").nth(1).click();
  await inspector.locator(".mem-editing input").fill("ff");
  await inspector.locator(".mem-editing input").press("Enter");
  await expect(inspector.locator(".mem-cell").nth(1)).toHaveText("000000ff");
  await page.locator(".sim-play").click();
  await expect.poll(() => simState(page)).toMatchObject({ running: true });
  await expect(inspector.locator(".mem-running")).toBeVisible();
  await inspector.locator(".mem-cell").nth(2).click();
  await expect(inspector.locator(".mem-editing")).toHaveCount(0); // no editor opened
});
