import { expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * File menu + menu bar acceptance (browser/mock mode): New / Open / Save-As
 * round-trip the document through the UI; the tab strip's "+" adds a
 * subcircuit and double-clicking a tab renames one (the Subcircuits menu is
 * retired — UI_OVERHAUL §16) and the palette manages
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

/** Create a subcircuit via the strip's "+" and name it in place (§60). */
async function newSubcircuit(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name: "New subcircuit" }).click();
  const input = page.getByRole("textbox", { name: "Circuit name" });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press("Enter");
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
    await expect(page.locator(".app-title")).toHaveText("saved.csx");
    await expect.poll(async () => (await doc(page)).circuits[0].components.length).toBe(0);
    expect((await doc(page)).name).toBe("untitled");

    // ---- New clears the canvas ----
    await placeAndGate(page);
    await openMenu(page, "File");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("menuitem", { name: "New Circuit" }).click();
    await expect(page.locator(".app-title")).toHaveText("(unsaved)");
    await expect.poll(async () => (await doc(page)).circuits[0].components.length).toBe(0);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test("Subcircuits: tabs create, switch, rename", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);

  // ---- new subcircuit via the tab strip's "+" (named inline in the tab) ----
  await newSubcircuit(page, "alu");

  // switched to the new (empty) tab; the AND gate is back on "main"
  let d = await doc(page);
  expect(d.circuits.map((c) => c.name)).toEqual(["main", "alu"]);
  await expect(page.getByRole("tab", { name: "alu" })).toHaveAttribute("aria-selected", "true");

  // ---- switch back via the tab strip ----
  await page.getByRole("tab", { name: "main" }).click();
  await expect(page.getByRole("tab", { name: "main" })).toHaveAttribute("aria-selected", "true");

  // ---- rename the main circuit (double-click ANYWHERE on its tab) ----
  await page.locator(".sheet-tab-wrap", { hasText: "main" }).dblclick({ position: { x: 4, y: 4 } });
  const renameInput = page.getByRole("textbox", { name: "Circuit name" });
  await renameInput.fill("toplevel");
  await renameInput.press("Enter");
  d = await doc(page);
  expect(d.circuits.map((c) => c.name)).toEqual(["toplevel", "alu"]);
  expect(d.circuits[0].components).toHaveLength(1); // the gate survived
});

test("Subcircuits: define an interface with pins, place an instance", async ({ page }) => {
  await page.goto("/");

  // ---- new subcircuit "alu" with an input pin a and an output pin y ----
  await newSubcircuit(page, "alu");

  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  // input pin placed world-anchored at [-4,0] (the INPUT tile faces left); its
  // 2×1 body center at (-3, 0.5) is clicked to select it (the Inspector opens
  // on the right). World anchoring avoids sub-pixel snapping surprises when the
  // chrome height changes.
  await openPaletteGroup(page, "Wiring");
  await page.getByRole("button", { name: "INPUT", exact: true }).click();
  const pin1Spot = await world(page, -3, 0.5); // center → body [-4,0]
  await page.mouse.click(pin1Spot.x, pin1Spot.y);
  await page.keyboard.press("Escape");
  const pin1Body = await world(page, -3, 0.5);
  await page.mouse.click(pin1Body.x, pin1Body.y);
  await expect(page.locator(".inspector-type")).toHaveText("c1");
  await page.getByPlaceholder("(unnamed)").fill("a");
  await page.getByPlaceholder("(unnamed)").press("Enter");

  // second pin at [5,0] from the OUTPUT tile (seeds isOutput + rot W)
  await openPaletteGroup(page, "Wiring");
  await page.getByRole("button", { name: "OUTPUT", exact: true }).click();
  const pin2Spot = await world(page, 6, 0.5); // center → body [5,0]
  await page.mouse.click(pin2Spot.x, pin2Spot.y);
  await page.keyboard.press("Escape");
  const pin2Body = await world(page, 6, 0.5);
  await page.mouse.click(pin2Body.x, pin2Body.y);
  await expect(page.locator(".inspector-type")).toHaveText("c2"); // panel switched before typing
  await page.getByPlaceholder("(unnamed)").fill("y");
  await page.getByPlaceholder("(unnamed)").press("Enter");

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
  await page.getByRole("button", { name: "INPUT", exact: true }).click();
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
  await newSubcircuit(page, "alu");
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

test("sim transport bar: log slider with notches, run-to", async ({ page }) => {
  await page.goto("/?simdemo=1");

  // The retired Simulation menu's controls live in the transport bar now.
  await page.getByRole("button", { name: "tick" }).click();
  const status = page.locator(".sim-status");
  await expect(status).toContainText("cycle");

  // Log scale: slider exponent 20 → 10^2 = 100 Hz, with notches at the round
  // values (UI_OVERHAUL §19).
  await expect(page.locator(".sim-notch")).toHaveCount(10);
  await expect(page.locator(".sim-notch.major")).toHaveCount(4);
  await page.locator(".sim-speed input[type=range]").fill("20");
  await expect(page.locator(".sim-speed-value")).toHaveText("100 Hz");

  // Run to cycle N from the transport bar.
  await page.locator(".sim-runto input").fill("5");
  await page.getByRole("button", { name: "run to" }).click();
  await expect(status).toContainText("cycle 5");
});

test("the header title edits in place, and Ctrl+S then writes without asking again", async ({
  page,
}) => {
  await page.goto("/");

  // Clicking "(unsaved)" turns the title into a field (§39).
  await expect(page.locator(".app-title")).toHaveText("(unsaved)");
  await page.locator(".app-title-editable").click();
  const field = page.locator(".app-title-input");
  await expect(field).toBeVisible();
  await expect(field).toBeFocused();

  // Escape leaves the old name in place.
  await field.fill("discard me");
  await field.press("Escape");
  await expect(page.locator(".app-title")).toHaveText("(unsaved)");

  // Enter commits: the document is named and saved under that name.
  await page.locator(".app-title-editable").click();
  await page.locator(".app-title-input").fill("alu");
  const first = page.waitForEvent("download");
  await page.locator(".app-title-input").press("Enter");
  await first;
  await expect(page.locator(".app-title")).toHaveText("alu");
  expect((await doc(page)).name).toBe("alu");

  // A later edit + Ctrl+S saves again with no new name.
  await page.locator('[data-group="Gates"]').click();
  await page.getByRole("button", { name: "AND", exact: true }).click();
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Escape");

  const again = page.waitForEvent("download");
  await page.keyboard.press("Control+s");
  await again;
  await expect(page.locator(".app-title")).toHaveText("alu");
  await expect(page.locator(".app-title")).not.toHaveText("(unsaved)");
});

test("Misc: a text annotation stores and edits its text", async ({ page }) => {
  await page.goto("/");

  await openPaletteGroup(page, "Misc");
  await page.getByRole("button", { name: "TEXT", exact: true }).click();
  const spot = await world(page, 0, 0);
  await page.mouse.click(spot.x, spot.y);
  await page.keyboard.press("Escape");

  // Born with visible text (UI_OVERHAUL §37), then edited in the Inspector.
  await expect(page.locator(".inspector-id")).toBeVisible();
  // A text annotation is just its text: no Name / Rotation / Label-side rows
  // (§40/§42), but it does offer Font.
  await expect(page.getByLabel("Name")).toHaveCount(0);
  await expect(page.getByLabel("Rotation")).toHaveCount(0);
  await expect(page.getByLabel("Label side")).toHaveCount(0);
  await page.getByLabel("Text").fill("hello");
  await page.getByLabel("Text").press("Enter");
  await page.getByLabel("Font").click();
  await page.getByRole("option", { name: "Serif", exact: true }).click();

  const d = await doc(page);
  const note = d.circuits[0].components.find((c) => c.type === "misc.text");
  expect(note?.attrs?.text).toBe("hello");
  expect(note?.attrs?.font).toBe("serif");
});

test("Sheet tabs: middle-click offers Rename and Delete", async ({ page }) => {
  await page.goto("/");

  // Create a subcircuit through the strip's "+".
  await newSubcircuit(page, "sub1");

  // Middle-click the subcircuit tab → our menu, not the browser default.
  await page.getByRole("tab", { name: "sub1" }).click({ button: "middle" });
  const menu = page.getByRole("menu", { name: "sub1 actions" });
  await expect(menu).toBeVisible();

  // Rename… edits the label in place — no popup (UI_OVERHAUL §60).
  await menu.getByRole("menuitem", { name: "Rename…" }).click();
  const input = page.getByRole("textbox", { name: "Circuit name" });
  await expect(input).toBeFocused();
  await input.press("Escape");
  await expect(page.getByRole("tab", { name: "sub1" })).toBeVisible();

  // Delete removes the sheet.
  await page.getByRole("tab", { name: "sub1" }).click({ button: "middle" });
  await page
    .getByRole("menu", { name: "sub1 actions" })
    .getByRole("menuitem", { name: "Delete" })
    .click();
  await expect(page.getByRole("tab", { name: "sub1" })).toHaveCount(0);
});
