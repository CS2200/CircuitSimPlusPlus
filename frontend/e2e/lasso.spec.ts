import { expect, test, type Page } from "@playwright/test";

/**
 * Dragging a SELECTION (UI_OVERHAUL §81). The bug was reported from the lasso:
 * box-select a region, drag it, and junctions stayed behind. The multi-component
 * move path had no coverage — this is it, doing what the report did.
 */

interface CsxDoc {
  circuits: {
    components: { id: string; type: string; pos: [number, number] }[];
    wires: { points: [number, number][] }[];
  }[];
}

async function doc(page: Page): Promise<CsxDoc> {
  return page.evaluate(() =>
    JSON.parse((window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  );
}

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

async function clickWorld(page: Page, wx: number, wy: number): Promise<void> {
  const p = await world(page, wx, wy);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

test("a lassoed selection drags its wires — bends and junctions included", async ({ page }) => {
  await page.goto("/");

  // AND at [0,0] and NOT at [10,0], wired out → in with the router's own path.
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await clickWorld(page, 2.5, 1.5);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "NOT", exact: true }).click();
  await clickWorld(page, 11.5, 1);
  await page.keyboard.press("Escape");
  const before = await doc(page);
  expect(before.circuits[0].components).toHaveLength(2);

  // Wire them (pin → pin, click-click) and keep the router's own path.
  await clickWorld(page, 5, 1.5);
  await clickWorld(page, 10, 1);
  const wired = await doc(page);
  expect(wired.circuits[0].wires).toHaveLength(1);
  const points = wired.circuits[0].wires[0].points;
  expect(points.length).toBeGreaterThan(1);

  // Lasso both parts (empty space → drag a box over them).
  const from = await world(page, -3, -3);
  const to = await world(page, 14, 4);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".app-statusbar")).toContainText("selected");

  // Drag the selection by +10 world units, from inside the AND's body.
  const grab = await world(page, 2.5, 1.5);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + 160, grab.y, { steps: 8 });
  await page.mouse.up();

  const after = await doc(page);
  // The parts moved…
  expect(after.circuits[0].components.map((c) => c.pos)).toEqual([
    [10, 0],
    [20, 0],
  ]);
  // …and EVERY point of the wire moved with them: the whole route, not just the
  // ends it is glued to (a wire that kept its bends came out skewed).
  expect(after.circuits[0].wires[0].points).toEqual(points.map(([x, y]) => [x + 10, y]));
});
