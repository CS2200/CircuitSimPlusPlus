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

/** Place one AND gate at the canvas center (dirty-ifies the document). */
async function placeAndGate(page: Page): Promise<void> {
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
    const opened = await doc(page);
    expect(opened.name).toBe("untitled");
    expect(opened.circuits[0].components).toHaveLength(0);
    await expect(page.locator(".menubar-path")).toHaveText("saved.csx");

    // ---- New clears the canvas ----
    await placeAndGate(page);
    await openMenu(page, "File");
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("menuitem", { name: "New Circuit" }).click();
    const fresh = await doc(page);
    expect(fresh.circuits[0].components).toHaveLength(0);
    await expect(page.locator(".menubar-path")).toHaveText("(unsaved)");
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

  // input pin at the center: default placement is an INPUT (faces left).
  // Placement anchors the body top-left to the cursor; the 2×1 pin body
  // center is +16,+8 CSS px at the default zoom — dblclick there.
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  await page.mouse.click(center.x - 60, center.y);
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(center.x - 60 + 16, center.y + 8);
  await page.getByPlaceholder("(unnamed)").fill("a");
  await page.getByRole("button", { name: "Apply" }).click();

  // second pin, made an OUTPUT via the properties dialog (rot mirrors to W)
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  await page.mouse.click(center.x + 60, center.y);
  await page.keyboard.press("Escape");
  await page.mouse.dblclick(center.x + 60 + 16, center.y + 8);
  await page.getByPlaceholder("(unnamed)").fill("y");
  await page.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Apply" }).click();

  let d = await doc(page);
  const alu = d.circuits.find((c) => c.name === "alu")!;
  const pins = alu.components.filter((c) => c.type === "wiring.pin");
  expect(pins.map((p) => p.name)).toEqual(["a", "y"]);
  expect(pins[1].attrs?.isOutput).toBe(true);
  expect(pins[1].rot).toBe("W"); // output faces right by default
  expect(pins[0].rot ?? "E").toBe("E"); // input faces left by default

  // ---- back on main: the palette offers "alu" as a placeable instance ----
  await page.getByRole("tab", { name: "main" }).click();
  await page.locator(".palette-group", { hasText: "Subcircuits" }).getByRole("button").click();
  await page.mouse.click(center.x, center.y - 80);
  await page.keyboard.press("Escape");

  d = await doc(page);
  const inst = d.circuits[0].components.find((c) => c.type === "subcircuit");
  expect(inst?.attrs?.circuit).toBe("alu");

  // ---- placing a second copy works too (multiple instances) ----
  await page.locator(".palette-group", { hasText: "Subcircuits" }).getByRole("button").click();
  await page.mouse.click(center.x, center.y + 80);
  await page.keyboard.press("Escape");
  d = await doc(page);
  expect(d.circuits[0].components.filter((c) => c.type === "subcircuit")).toHaveLength(2);
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
