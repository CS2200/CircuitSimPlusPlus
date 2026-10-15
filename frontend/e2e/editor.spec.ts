import { expect, test, type Page } from "@playwright/test";

/**
 * U3 acceptance: place, wire, junction, drag, delete-branch, undo-all —
 * one continuous interaction flow driven through the real UI (palette +
 * canvas pointer events), asserting on the document JSON after each step.
 *
 * The editor camera starts at world (0,0), scale 16 CSS px per grid unit —
 * world→screen = bbox center + world × 16.
 */

interface CsxDoc {
  circuits: {
    name: string;
    components: {
      id: string;
      type: string;
      pos: [number, number];
      rot?: string;
      namePos?: string;
    }[];
    wires: {
      a: unknown;
      b: unknown;
      points: [number, number][];
    }[];
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

test("U3 acceptance: place, wire, junction, drag, delete-branch, undo-all", async ({ page }) => {
  await page.goto("/");

  // ---- place: AND centered at world (2.5,1.5) → body [0,0]; NOT likewise ----
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await clickWorld(page, 2.5, 1.5);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "NOT", exact: true }).click();
  await clickWorld(page, 11.5, 1);
  await page.keyboard.press("Escape");

  let d = await doc(page);
  expect(d.circuits[0].components).toHaveLength(2);
  expect(d.circuits[0].components[0]).toMatchObject({ type: "gate.and", pos: [0, 0] });
  expect(d.circuits[0].components[1]).toMatchObject({ type: "gate.not", pos: [10, 0] });
  const [and, not] = d.circuits[0].components.map((c) => c.id);

  // ---- click the AND → Inspector (right dock) → rename + bitsize ----
  const body = await world(page, 2.5, 1.5);
  await page.mouse.click(body.x, body.y);
  await expect(page.locator(".inspector-id")).toHaveText("c1");
  await page.getByLabel("Name").fill("my-and");
  await page.getByLabel("Name").press("Enter");
  // Bit width is a 1..32 picker grid (UI_OVERHAUL §28).
  await page.locator('.bitsize-grid[aria-label="Bit size"] [data-value="8"]').click();
  d = await doc(page);
  expect(d.circuits[0].components[0]).toMatchObject({ name: "my-and", attrs: { bitsize: 8 } });

  // ---- per-part name side (UI_OVERHAUL §28): the app dropdown writes namePos
  // and OVERLAYS the panel — opening it must not push the rows down (§29) ----
  const sideBtn = page.getByLabel("Label side");
  const sidebar = page.locator(".inspector");
  const heightBefore = await sidebar.evaluate((el) => el.scrollHeight);
  await sideBtn.click();
  await expect(page.getByRole("option", { name: "Below", exact: true })).toBeVisible();
  // Overlay, not inline: the panel's content height is unchanged while open.
  expect(await sidebar.evaluate((el) => el.scrollHeight)).toBe(heightBefore);
  await page.getByRole("option", { name: "Below", exact: true }).click();
  d = await doc(page);
  expect(d.circuits[0].components[0]).toMatchObject({ namePos: "S" });
  // Choosing "Default" clears the override (the part follows the app default).
  await page.getByLabel("Label side").click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  d = await doc(page);
  expect(d.circuits[0].components[0]).not.toHaveProperty("namePos");

  // ---- wire: AND.out (5,1.5) → NOT.in (10,1), routed with an escape
  // stub east + a Z jog, entering the input pin from the west ----
  await clickWorld(page, 5, 1.5);
  await clickWorld(page, 10, 1);
  d = await doc(page);
  expect(d.circuits[0].wires).toHaveLength(1);
  expect(d.circuits[0].wires[0].a).toEqual({ comp: and, pin: "out" });
  expect(d.circuits[0].wires[0].b).toEqual({ comp: not, pin: "in" });
  expect(d.circuits[0].wires[0].points).toEqual([
    [5, 1.5],
    [9, 1.5],
    [9, 1],
    [10, 1],
  ]);

  // ---- junction: click NOT.out (13,1), then click wire 0's segment ----
  const [ax, ay] = d.circuits[0].wires[0].points[0];
  const [bx, by] = d.circuits[0].wires[0].points[1];
  await clickWorld(page, 13, 1);
  await clickWorld(page, (ax + bx) / 2, (ay + by) / 2);
  d = await doc(page);
  expect(d.circuits[0].wires).toHaveLength(2);
  expect(d.circuits[0].wires[1].a).toEqual({ comp: not, pin: "out" });
  expect(d.circuits[0].wires[1].b).toEqual({ join: { wire: 0, segment: 0 } });

  // ---- drag: move the AND +3 units; the glued wire endpoint follows ----
  const from = await world(page, 2.5, 1.5);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(from.x + i * 8, from.y); // 48px = 3 grid units
  }
  await page.mouse.up();
  d = await doc(page);
  expect(d.circuits[0].components[0].pos).toEqual([3, 0]);
  expect(d.circuits[0].wires[0].points[0]).toEqual([8, 1.5]);

  // ---- delete-branch: selecting the parent wire + Del cascades to the junction wire ----
  // Click the parent's bend point (corner handles select the wire; the
  // midpoint of the short stub segment is within pin pickup range).
  const bend = d.circuits[0].wires[0].points[1];
  await clickWorld(page, bend[0], bend[1]);
  await page.keyboard.press("Delete");
  d = await doc(page);
  expect(d.circuits[0].wires).toHaveLength(0); // junction child went with its parent
  expect(d.circuits[0].components).toHaveLength(2);

  // ---- undo-all: back to an empty circuit ----
  for (let i = 0; i < 12; i++) {
    d = await doc(page);
    if (d.circuits[0].components.length === 0 && d.circuits[0].wires.length === 0) break;
    await page.keyboard.press("Control+z");
  }
  d = await doc(page);
  expect(d.circuits[0].components).toHaveLength(0);
  expect(d.circuits[0].wires).toHaveLength(0);
});
