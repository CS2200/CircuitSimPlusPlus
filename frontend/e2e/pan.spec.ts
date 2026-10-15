import { expect, test, type Page } from "@playwright/test";

/**
 * UI overhaul §1 acceptance: pan gestures. Right-drag and Shift+left-drag
 * pan the camera; presses that never move keep their click semantics
 * (right-click cancels placing, Shift+click toggles selection). Middle-drag
 * and Space+left-drag pan as before.
 */

async function camera(page: Page): Promise<{ x: number; y: number; scale: number }> {
  return page.evaluate(() =>
    (
      window as unknown as { __circuitCamera: () => { x: number; y: number; scale: number } }
    ).__circuitCamera(),
  );
}

async function center(page: Page): Promise<{ x: number; y: number }> {
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** Press, sweep, release — with an optional held modifier key. */
async function drag(
  page: Page,
  from: { x: number; y: number },
  dx: number,
  dy: number,
  button: "left" | "middle" | "right",
  modifier?: "Shift",
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  if (modifier !== undefined) await page.keyboard.down(modifier);
  await page.mouse.down({ button });
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + (dx * i) / 6, from.y + (dy * i) / 6);
  }
  await page.mouse.up({ button });
  if (modifier !== undefined) await page.keyboard.up(modifier);
}

/**
 * Pan moves the camera by the drag delta, give or take the grid snap (< half a
 * cell) applied when the gesture ends (UI_OVERHAUL §41).
 */
function expectPanned(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThan(0.6);
}

test("right-drag pans the camera", async ({ page }) => {
  await page.goto("/");
  const c = await center(page);
  const before = await camera(page);
  await drag(page, c, 120, 60, "right");
  const after = await camera(page);
  // The camera snaps the canvas edge onto a grid line when the gesture ends
  // (UI_OVERHAUL §41), so the delta is the drag ± up to half a cell.
  expectPanned(after.x, before.x - 120 / before.scale);
  expectPanned(after.y, before.y - 60 / before.scale);
});

test("Shift+left-drag pans without touching the selection", async ({ page }) => {
  await page.goto("/");
  const c = await center(page);
  const before = await camera(page);
  await drag(page, c, -96, 48, "left", "Shift");
  const after = await camera(page);
  expectPanned(after.x, before.x + 96 / before.scale);
  expectPanned(after.y, before.y - 48 / before.scale);
  await expect(page.locator(".app-statusbar")).not.toContainText("selected");
});

test("middle-drag still pans (regression guard)", async ({ page }) => {
  await page.goto("/");
  const c = await center(page);
  const before = await camera(page);
  await drag(page, c, 96, 0, "middle");
  const after = await camera(page);
  expectPanned(after.x, before.x - 96 / before.scale);
});

test("right-click without movement still cancels placement", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await expect(page.locator(".app-statusbar")).toContainText("placing gate.and");

  const c = await center(page);
  const before = await camera(page);
  await page.mouse.click(c.x, c.y, { button: "right" });

  await expect(page.locator(".app-statusbar")).not.toContainText("placing");
  await expect(page.getByRole("button", { name: "AND", exact: true })).not.toHaveClass(/active/);
  const after = await camera(page);
  expect(after.x).toBeCloseTo(before.x, 3); // a click never pans
});

test("Shift+click without movement still toggles selection", async ({ page }) => {
  await page.goto("/");
  // Place AND centered so its body lands at [0,0] (center 2.5,1.5), NOT at
  // [10,0] (center 11.5,1); body centers are (2.5,1.5)/(11.5,1).
  await page.getByRole("button", { name: "AND", exact: true }).click();
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  const cam = await camera(page);
  const w2s = (wx: number, wy: number) => ({
    x: box.x + box.width / 2 + (wx - cam.x) * cam.scale,
    y: box.y + box.height / 2 + (wy - cam.y) * cam.scale,
  });
  const and = w2s(2.5, 1.5);
  await page.mouse.click(and.x, and.y);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "NOT", exact: true }).click();
  const not = w2s(11.5, 1);
  await page.mouse.click(not.x, not.y);
  await page.keyboard.press("Escape");

  // Plain click selects the AND; Shift+click adds the NOT.
  const andBody = w2s(2.5, 1.5);
  const notBody = w2s(11.5, 1);
  await page.mouse.click(andBody.x, andBody.y);
  await expect(page.locator(".app-statusbar")).toContainText("1 selected");
  await page.keyboard.down("Shift");
  await page.mouse.click(notBody.x, notBody.y);
  await page.keyboard.up("Shift");
  await expect(page.locator(".app-statusbar")).toContainText("2 selected");
});
