import { expect, test, type Page } from "@playwright/test";

/**
 * Wire interactions (UI_OVERHAUL §12/§13):
 *  - drag-wiring: press on a pin, sweep, release on a pin → the wire commits
 *    (a drag-release used to commit nothing, leaving the gesture in routing
 *    mode so every later click bent the phantom wire — the reported "clicking
 *    a wire re-routes it" bug);
 *  - the Inspector's wire section: color swatches + a width control that
 *    edits the net's driving component `bitsize` (format-v2 §5.2).
 */

interface CsxDoc {
  circuits: {
    components: { id: string; type: string; attrs?: Record<string, unknown> }[];
    wires: { color?: string; points: [number, number][] }[];
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
    x: box.x + box.width / 2 + (wx - cam.x) * cam.scale,
    y: box.y + box.height / 2 + (wy - cam.y) * cam.scale,
  };
}

async function clickWorld(page: Page, wx: number, wy: number): Promise<void> {
  const p = await world(page, wx, wy);
  await page.mouse.click(p.x, p.y);
}

/** AND at (2.5,1.5), NOT at (11.5,1) — bodies [0,0] and [10,0]. */
async function placeParts(page: Page): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await clickWorld(page, 2.5, 1.5);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "NOT", exact: true }).click();
  await clickWorld(page, 11.5, 1);
  await page.keyboard.press("Escape");
}

test("drag-wiring: releasing on the target pin commits the wire", async ({ page }) => {
  await placeParts(page);

  // Press on AND.out (5,1.5), sweep to NOT.in (10,1), release there.
  const a = await world(page, 5, 1.5);
  const b = await world(page, 10, 1);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();

  let d = await doc(page);
  expect(d.circuits[0].wires).toHaveLength(1);
  expect(d.circuits[0].wires[0].points[0]).toEqual([5, 1.5]);
  expect(d.circuits[0].wires[0].points.at(-1)).toEqual([10, 1]);
  const settled = JSON.stringify(d.circuits[0].wires[0].points);

  // Clicking the wire selects it (no re-route, no stray wire)…
  await clickWorld(page, 7.5, 1.5);
  await expect(page.locator(".inspector-id")).toHaveText("Wire");

  // …and clicking a component afterwards selects THAT component instead of
  // bending the wire (the "even if I click something else it reroutes it" bug).
  await clickWorld(page, 2.5, 1.5);
  await expect(page.locator(".inspector-id")).toHaveText("AND Gate");
  await clickWorld(page, 20, 4);
  d = await doc(page);
  expect(d.circuits[0].wires).toHaveLength(1);
  expect(JSON.stringify(d.circuits[0].wires[0].points)).toBe(settled);
});

test("wire section: color swatch (no manual width)", async ({ page }) => {
  await placeParts(page);

  // Wire AND.out (5,1.5) → NOT.in (10,1); then select it on a segment interior.
  await clickWorld(page, 5, 1.5);
  await clickWorld(page, 10, 1);
  await clickWorld(page, 7.5, 1.5);
  await expect(page.locator(".inspector-id")).toHaveText("Wire");
  // A wire has no manual width control — its width is inferred from its parts.
  await expect(page.locator('.bitsize-grid[aria-label="Width (bits)"]')).toHaveCount(0);
  // Its design delay is per drawn path (docs/delay-table.md): the row exists and
  // carries a number (the exact format is the table's business).
  const delayRow = page.locator(".inspector-row").filter({ hasText: "Delay" });
  await expect(delayRow).toBeVisible();
  await expect(delayRow).toContainText(/[0-9]/);

  // Color: a swatch sets the wire's own color (format-v2 §2 `color`).
  await page.getByRole("button", { name: "Wire color #40dc82" }).click();
  expect((await doc(page)).circuits[0].wires[0].color).toBe("#40dc82");
  // …and "Default" clears it again.
  await page.getByRole("button", { name: "Default color" }).click();
  expect((await doc(page)).circuits[0].wires[0].color).toBeUndefined();
  await page.getByRole("button", { name: "Wire color #4dd0e1" }).click();
});
