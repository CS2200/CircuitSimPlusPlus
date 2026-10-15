import { expect, test, type Page } from "@playwright/test";

/**
 * Wire styling (UI_OVERHAUL §12): selecting a wire opens the Inspector's
 * wire section — a color swatch row and a width control. Width comes from
 * the driving pin (format-v2 §5.2), so the control edits the source
 * component's `bitsize`; color is stored on the wire itself.
 */

interface CsxDoc {
  circuits: {
    components: { id: string; type: string; attrs?: Record<string, unknown> }[];
    wires: { color?: string }[];
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

test("wire section: color swatch and width (driver bitsize)", async ({ page }) => {
  await page.goto("/");

  // AND centered at (2.5,1.5) → body [0,0]; NOT centered at (11.5,1) → [10,0].
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await clickWorld(page, 2.5, 1.5);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "NOT", exact: true }).click();
  await clickWorld(page, 11.5, 1);
  await page.keyboard.press("Escape");

  // Wire AND.out (5,1.5) → NOT.in (10,1); then select it on a segment interior.
  await clickWorld(page, 5, 1.5);
  await clickWorld(page, 10, 1);
  await clickWorld(page, 7.5, 1.5);
  await expect(page.locator(".inspector-id")).toHaveText(/wire/);
  await expect(page.locator(".inspector-type")).toContainText("1-bit");

  // Color: a swatch sets the wire's own color (format-v2 §2 `color`).
  await page.getByRole("button", { name: "Wire color #40dc82" }).click();
  expect((await doc(page)).circuits[0].wires[0].color).toBe("#40dc82");
  // …and "Default" clears it again.
  await page.getByRole("button", { name: "Default color" }).click();
  expect((await doc(page)).circuits[0].wires[0].color).toBeUndefined();
  await page.getByRole("button", { name: "Wire color #4dd0e1" }).click();

  // Width: the control edits the driving component's bitsize (the AND).
  await page.getByLabel("Width (bits)").fill("8");
  const d = await doc(page);
  expect(d.circuits[0].components.find((c) => c.type === "gate.and")?.attrs?.bitsize).toBe(8);
  await expect(page.locator(".inspector-type")).toContainText("8-bit");
});
