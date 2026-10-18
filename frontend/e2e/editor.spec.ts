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
      attrs?: Record<string, unknown>;
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
  await expect(page.locator(".inspector-id")).toHaveText("AND Gate");
  await expect(page.locator(".inspector-type")).toHaveText("c1");
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
  // Portaled inside `.app` (which carries data-accent), so it keeps the chosen
  // accent colour instead of the theme default.
  await expect(page.locator(".app .select-pop")).toHaveCount(1);
  await page.getByRole("option", { name: "Below", exact: true }).click();
  d = await doc(page);
  expect(d.circuits[0].components[0]).toMatchObject({ namePos: "S" });
  // Above is the default, so picking it writes nothing at all.
  await page.getByLabel("Label side").click();
  await page.getByRole("option", { name: "Above", exact: true }).click();
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

test("grid edge lines up with the canvas edge (camera aligned to the grid)", async ({ page }) => {
  await page.goto("/?demo=1");
  // The alignment may land a frame later (initial settle), so poll.
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const cam = (
          window as unknown as { __circuitCamera: () => { x: number; y: number; scale: number } }
        ).__circuitCamera();
        const c = document.querySelector("canvas.circuit-canvas") as HTMLCanvasElement;
        const r = c.getBoundingClientRect();
        const leftWorld = cam.x - r.width / 2 / cam.scale;
        const topWorld = cam.y - r.height / 2 / cam.scale;
        const nearInt = (v: number) => Math.abs(v - Math.round(v)) < 0.01;
        return nearInt(leftWorld) && nearInt(topWorld);
      }),
    )
    .toBe(true);
});

test("an unnamed wiring.pin warns that the file will not load", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-group="Wiring"]').click();
  await page.getByRole("button", { name: "INPUT", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector-id")).toHaveText("Pin");

  // The engine fails the whole load on a blank pin name, so say so up front —
  // next to the Name field — instead of waiting for a generic load failure.
  const note = page.locator('[data-note="unnamed-pin"]');
  await expect(note).toBeVisible();
  await expect(note).toContainText("Name this pin");

  // Naming it clears the warning.
  const name = page.locator(".inspector-row input").first();
  await name.fill("req");
  await name.press("Enter");
  await expect(note).toHaveCount(0);
});

test("splitter: the Inspector edits split pins structurally (not a text box)", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-group="Wiring"]').click();
  await page.getByRole("button", { name: "SPLIT", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector-id")).toBeVisible();

  // One row per split pin (no textarea).
  await expect(page.locator(".inspector-textarea")).toHaveCount(0);
  const rows = await page.locator(".split-row").count();
  expect(rows).toBeGreaterThan(0);

  // Rename the first pin and set its bits; committed on blur.
  await page.getByLabel("Split pin 1 name").fill("lo");
  await page.getByLabel("Split pin 1 bits").fill("0, 1");
  await page.getByLabel("Split pin 1 bits").press("Enter");

  const d = await doc(page);
  const split = d.circuits[0].components.find((c) => c.type === "wiring.splitter");
  expect((split?.attrs?.splits as Record<string, number[]>).lo).toEqual([0, 1]);

  // Add a pin → one more row.
  await page.getByRole("button", { name: "Add pin" }).click();
  await expect(page.locator(".split-row")).toHaveCount(rows + 1);
});

test("Gates: BUFFER places the tri-state buffer (with an enable pin)", async ({ page }) => {
  await page.goto("/");
  // Gates is the default group; the tile is the renamed Buf → BUFFER.
  await page.getByRole("button", { name: "BUFFER", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");
  const d = await doc(page);
  const buf = d.circuits[0].components.find((c) => c.type === "wiring.controlled-buffer");
  expect(buf).toBeTruthy();
  // It carries the bit-width field (the `in`/`out` bus).
  await expect(page.locator(".inspector-id")).toBeVisible();
});

test("palette tooltips name the part, with no gesture boilerplate", async ({ page }) => {
  await page.goto("/");
  // Gates is the default group; BUFFER is the tri-state buffer's tile. The
  // tooltip used to carry "click… Shift-click… R rotates, Esc cancels".
  const tile = page.getByRole("button", { name: "BUFFER", exact: true });
  await expect(tile).toHaveAttribute("title", "Tri-state Buffer");
  await expect(page.getByRole("button", { name: "AND", exact: true })).toHaveAttribute(
    "title",
    "AND Gate",
  );
});

test("clock: Shift+click ticks the sim in place", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __sim?: unknown }).__sim !== undefined);
  await page.locator('[data-group="Wiring"]').click();
  await page.getByRole("button", { name: "CLK", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector-id")).toBeVisible();
  await expect(page.locator(".app-statusbar")).toContainText("1 selected");

  // Shift+click the clock is consumed as a TICK, not a selection toggle
  // (UI_OVERHAUL §47): the selection must stay put.
  await page.keyboard.down("Shift");
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.up("Shift");
  await expect(page.locator(".app-statusbar")).toContainText("1 selected");
});

test("constant: radix display + double-click jumps into the value", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-group="Wiring"]').click();
  await page.getByRole("button", { name: "CONST", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector-id")).toBeVisible();

  const placed = () =>
    doc(page).then((d) => d.circuits[0].components.find((x) => x.type === "wiring.constant"));

  // Double-clicking the constant puts the caret in its value input (UI_OVERHAUL
  // §53). The body is 3x2, centred on the placement click.
  const c0 = await placed();
  const centre = await world(page, c0!.pos[0] + 1.5, c0!.pos[1] + 1);
  await page.mouse.dblclick(centre.x, centre.y);
  await expect(page.getByLabel("Value")).toBeFocused();

  // The base is a 3-button chooser, and the value is typed in that base (§55).
  await page.getByRole("radio", { name: "Bin", exact: true }).click();
  await page.getByLabel("Value").fill("1");
  await page.getByLabel("Value").press("Enter");
  const c = await placed();
  expect(c?.attrs?.radix).toBe("bin");
  expect(c?.attrs?.value).toBe("1");
});

test("priority decoder: places from Plexers and edits its line count", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-group="Plexers"]').click();
  await page.getByRole("button", { name: "PRI", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");
  await expect(page.locator(".inspector-id")).toBeVisible();

  const placed = () =>
    doc(page).then((d) =>
      d.circuits[0].components.find((c) => c.type === "plexers.priority-decoder"),
    );
  expect(await placed()).toBeTruthy();

  // The line count is a 2..8 field (default 4); editing it writes the attr.
  await page.getByLabel("Input lines").fill("8");
  expect((await placed())?.attrs?.inputBits).toBe(8);
});
