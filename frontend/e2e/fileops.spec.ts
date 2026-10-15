import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * File menu + menu bar acceptance (browser/mock mode): New / Open / Save-As
 * round-trip the document through the UI; the Subcircuits menu manages
 * sheets. The Tauri shell path (native dialogs + engine-side file writes)
 * is covered by manual smoke — CI drives the browser fallbacks
 * (input[type=file] + download), which share all document logic.
 */

interface CsxDoc {
  name: string;
  circuits: {
    name: string;
    components: {
      id: string;
      type: string;
      pos: [number, number];
      name?: string;
      rot?: string;
      attrs?: Record<string, unknown>;
    }[];
    wires: unknown[];
  }[];
}

async function doc(page: Page): Promise<CsxDoc> {
  return page.evaluate(() =>
    JSON.parse((window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  );
}

async function openMenu(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("menu", { name })).toBeVisible();
}

/** World→screen via the live camera (same helper as editor.spec). */
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

/** Switch the palette's activity rail to `group` (UI_OVERHAUL §8). */
async function openPaletteGroup(page: Page, group: string): Promise<void> {
  await page.locator(`[data-group="${group}"]`).click();
}

/** Place one AND gate at the canvas center (dirty-ifies the document). */
async function placeAndGate(page: Page): Promise<void> {
  await openPaletteGroup(page, "Gates");
  await page.getByRole("button", { name: "AND", exact: true }).click();
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Escape");
}

test("File menu: New / Open / Save-As round-trip", async ({ page }) => {
  const scratch = mkdtempSync(join(tmpdir(), "csx-e2e-"));
  try {
    await page.goto("/");

    // ---- Save As… downloads the (empty) document ----
    await openMenu(page, "File");
    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("menuitem", { name: "Save As…" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("untitled.csx");
    const savedPath = join(scratch, "saved.csx");
    await download.saveAs(savedPath);

    // ---- place a gate: document is now dirty and non-empty ----
    await placeAndGate(page);
    expect((await doc(page)).circuits[0].components).toHaveLength(1);

    // ---- dirty guard: Open asks for confirmation; cancel keeps the doc ----
    await openMenu(page, "File");
    page.once("dialog", (d) => void d.dismiss());
    await page.getByRole("menuitem", { name: "Open…" }).click();
    // no file chooser appears (the confirm was dismissed) — doc unchanged
    await expect(page.getByRole("menu", { name: "File" })).toHaveCount(0);
    expect((await doc(page)).circuits[0].components).toHaveLength(1);

    // ---- Open (accepting the confirm) loads the file from disk ----
    await openMenu(page, "File");
    // Register BEFORE the click: the chooser can fire before a post-click
    // waitForEvent would be registered (confirm resolves fast → race).
    const chooserPromise = page.waitForEvent("filechooser");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("menuitem", { name: "Open…" }).click();
    const chooser = await chooserPromise;
    await chooser.setFiles(savedPath);
    // The browser reads the file asynchronously — wait for the adopted
    // (empty) document to land; never read the doc the same tick.
    await expect(page.locator(".menubar-path")).toHaveText("saved.csx");
    await expect.poll(async () => (await doc(page)).circuits[0].components.length).toBe(0);
    expect((await doc(page)).name).toBe("untitled");

    // ---- New clears the canvas ----
    await placeAndGate(page);
    await openMenu(page, "File");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("menuitem", { name: "New Circuit" }).click();
    await expect(page.locator(".menubar-path")).toHaveText("(unsaved)");
    await expect.poll(async () => (await doc(page)).circuits[0].components.length).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Subcircuits: tabs create, switch, rename", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);

  // ---- new subcircuit via the tab strip's "+" ----
  await page.getByRole("button", { name: "New subcircuit" }).click();
  const dialog = page.locator(".name-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("alu");
  await dialog.getByRole("button", { name: "Create" }).click();

  // switched to the new (empty) tab; the AND gate is back on "main"
  let d = await doc(page);
  expect(d.circuits.map((c) => c.name)).toEqual(["main", "alu"]);
  await expect(page.getByRole("tab", { name: "alu" })).toHaveAttribute("aria-selected", "true");

  // ---- switch back via the tab strip ----
  await page.getByRole("tab", { name: "main" }).click();
  await expect(page.getByRole("tab", { name: "main" })).toHaveAttribute("aria-selected", "true");

  // ---- rename the main circuit (double-click its tab) ----
  await page.getByRole("tab", { name: "main" }).dblclick();
  await dialog.getByRole("textbox").fill("toplevel");
  await dialog.getByRole("button", { name: "Rename" }).click();
  d = await doc(page);
  expect(d.circuits.map((c) => c.name)).toEqual(["toplevel", "alu"]);
  expect(d.circuits[0].components).toHaveLength(1); // the gate survived
});

test("Subcircuits: define an interface with pins, place an instance", async ({ page }) => {
  await page.goto("/");

  // ---- new subcircuit "alu" with an input pin a and an output pin y ----
  await openMenu(page, "Subcircuits");
  await page.getByRole("menuitem", { name: "New subcircuit…" }).click();
  const dialog = page.locator(".name-dialog");
  await dialog.getByRole("textbox").fill("alu");
  await dialog.getByRole("button", { name: "Create" }).click();

  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // input pin placed world-anchored at [-4,0] (default is an INPUT, faces
  // left); its 2×1 body center at (-3, 0.5) is clicked to select it (the
  // Inspector opens on the right). World anchoring avoids sub-pixel
  // snapping surprises when the chrome height changes.
  await openPaletteGroup(page, "Wiring");
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  const pin1Spot = await world(page, -3, 0.5); // center → body [-4,0]
  await page.mouse.click(pin1Spot.x, pin1Spot.y);
  await page.keyboard.press("Escape");
  const pin1Body = await world(page, -3, 0.5);
  await page.mouse.click(pin1Body.x, pin1Body.y);
  await expect(page.locator(".inspector-id")).toHaveText("c1");
  await page.getByPlaceholder("(unnamed)").fill("a");
  await page.getByPlaceholder("(unnamed)").press("Enter");

  // second pin at [5,0], made an OUTPUT via the Inspector (rot mirrors to W)
  await openPaletteGroup(page, "Wiring");
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  const pin2Spot = await world(page, 6, 0.5); // center → body [5,0]
  await page.mouse.click(pin2Spot.x, pin2Spot.y);
  await page.keyboard.press("Escape");
  const pin2Body = await world(page, 6, 0.5);
  await page.mouse.click(pin2Body.x, pin2Body.y);
  await expect(page.locator(".inspector-id")).toHaveText("c2"); // panel switched before typing
  await page.getByPlaceholder("(unnamed)").fill("y");
  await page.getByPlaceholder("(unnamed)").press("Enter");
  await page.getByRole("checkbox").check();

  let d = await doc(page);
  const alu = d.circuits.find((c) => c.name === "alu")!;
  const pins = alu.components.filter((c) => c.type === "wiring.pin");
  expect(pins.map((p) => p.name)).toEqual(["a", "y"]);
  expect(pins[1].attrs?.isOutput).toBe(true);
  expect(pins[1].rot).toBe("W"); // output faces right by default
  expect(pins[0].rot ?? "E").toBe("E"); // input faces left by default

  // ---- back on main: the palette offers "alu" as a placeable instance ----
  await page.getByRole("tab", { name: "main" }).click();
  await openPaletteGroup(page, "Subcircuits");
  await page.locator(".palette-group .palette-item").first().click();
  await page.mouse.click(center.x, center.y - 80);
  await page.keyboard.press("Escape");

  d = await doc(page);
  const inst = d.circuits[0].components.find((c) => c.type === "subcircuit");
  expect(inst?.attrs?.circuit).toBe("alu");

  // ---- placing a second copy works too (multiple instances) ----
  await openPaletteGroup(page, "Subcircuits");
  await page.locator(".palette-group .palette-item").first().click();
  await page.mouse.click(center.x, center.y + 80);
  await page.keyboard.press("Escape");
  d = await doc(page);
  expect(d.circuits[0].components.filter((c) => c.type === "subcircuit")).toHaveLength(2);
});

test("Wiring: a pin terminal connects to a gate (regression: 'pin' not 'port')", async ({
  page,
}) => {
  await page.goto("/");

  // PIN placed world-anchored at [-6,0] → terminal at (-4,0.5).
  await openPaletteGroup(page, "Wiring");
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  const pinSpot = await world(page, -6, 0);
  await page.mouse.click(pinSpot.x, pinSpot.y);
  await page.keyboard.press("Escape");
  // AND placed world-anchored at [1,-1] → in0 at (1,0).
  await openPaletteGroup(page, "Gates");
  await page.getByRole("button", { name: "AND", exact: true }).click();
  const andSpot = await world(page, 1, -1);
  await page.mouse.click(andSpot.x, andSpot.y);
  await page.keyboard.press("Escape");

  // wire: pin terminal → gate in0 (click-click). Aim at the ACTUAL placed
  // pin positions read back from the document — placement snapping depends
  // on sub-pixel layout, so hard-coded world offsets are brittle.
  const placed = await doc(page);
  const pinComp = placed.circuits[0].components.find((c) => c.type === "wiring.pin");
  const andComp = placed.circuits[0].components.find((c) => c.type === "gate.and");
  if (pinComp === undefined || andComp === undefined) throw new Error("placements missing");
  const terminalWorld = { x: pinComp.pos[0] + 2, y: pinComp.pos[1] + 0.5 }; // terminal dx=2 dy=0.5
  const in0World = { x: andComp.pos[0], y: andComp.pos[1] + 1 }; // in0 dx=0 dy=1
  const terminal = await world(page, terminalWorld.x, terminalWorld.y);
  await page.mouse.click(terminal.x, terminal.y);
  const in0 = await world(page, in0World.x, in0World.y);
  await page.mouse.click(in0.x, in0.y);

  const d = await doc(page);
  expect(d.circuits[0].wires).toHaveLength(1);
  const w = d.circuits[0].wires[0] as { a: { pin?: string }; b: { pin?: string } };
  expect(w.a.pin).toBe("pin"); // the wiring.pin terminal — engine-valid
  expect(w.b.pin).toBe("in0");
});

test("Subcircuits: right-click an instance jumps to its definition tab", async ({ page }) => {
  await page.goto("/");
  await openMenu(page, "Subcircuits");
  await page.getByRole("menuitem", { name: "New subcircuit…" }).click();
  const dialog = page.locator(".name-dialog");
  await dialog.getByRole("textbox").fill("alu");
  await dialog.getByRole("button", { name: "Create" }).click();
  await expect(page.getByRole("tab", { name: "alu" })).toHaveAttribute("aria-selected", "true");

  // place an instance on main, then right-click it
  await page.getByRole("tab", { name: "main" }).click();
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  const c = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await openPaletteGroup(page, "Subcircuits");
  await page.locator(".palette-group .palette-item").first().click();
  await page.mouse.click(c.x, c.y); // instance body centered on the canvas center
  await page.keyboard.press("Escape");
  await expect(page.getByRole("tab", { name: "main" })).toHaveAttribute("aria-selected", "true");

  await page.mouse.click(c.x, c.y, { button: "right" });
  await expect(page.getByRole("tab", { name: "alu" })).toHaveAttribute("aria-selected", "true");
});

test("Simulation menu: mode radio + speed preset + run-to dialog", async ({ page }) => {
  await page.goto("/?simdemo=1");

  await openMenu(page, "Simulation");
  await expect(page.getByRole("menuitem", { name: "Step tick" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Run to cycle…" })).toBeVisible();

  // mode radios reflect and drive the sim store (loads the demo on demand)
  await page.getByRole("menuitem", { name: "Zero-delay mode" }).click();
  await expect(page.locator(".sim-status")).toContainText("zero");
  await openMenu(page, "Simulation");
  await page.getByRole("menuitem", { name: "Delay-aware mode" }).click();
  await expect(page.locator(".sim-status")).toContainText("delay");

  // speed preset mirrors into the transport slider readout
  await openMenu(page, "Simulation");
  await page.getByRole("menuitem", { name: "100 Hz" }).click();
  await expect(page.locator(".sim-speed")).toContainText("100 Hz");

  // run-to via the menu dialog
  await openMenu(page, "Simulation");
  await page.getByRole("menuitem", { name: "Run to cycle…" }).click();
  const dialog = page.locator(".name-dialog");
  await dialog.getByRole("textbox").fill("5");
  await dialog.getByRole("button", { name: "Run" }).click();
  await expect(page.locator(".sim-status")).toContainText("cycle 5");
});
