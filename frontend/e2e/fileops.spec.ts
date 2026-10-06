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
  circuits: { name: string; components: { id: string; type: string }[]; wires: unknown[] }[];
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
    page.once("dialog", (d) => void d.accept());
    await page.getByRole("menuitem", { name: "Open…" }).click();
    const chooser = await page.waitForEvent("filechooser");
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

test("Subcircuits menu: new sheet, switch, rename", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);

  // ---- new sheet via the menu dialog ----
  await openMenu(page, "Subcircuits");
  await page.getByRole("menuitem", { name: "New sheet…" }).click();
  const dialog = page.locator(".name-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("alu");
  await dialog.getByRole("button", { name: "Create" }).click();

  // switched to the new (empty) sheet; the AND gate is back on "main"
  let d = await doc(page);
  expect(d.circuits.map((c) => c.name)).toEqual(["main", "alu"]);
  await expect(page.locator(".app-statusbar")).toContainText("sheet: alu");

  // ---- switch back via the sheet radio list ----
  await openMenu(page, "Subcircuits");
  await page.getByRole("menuitem", { name: "main" }).click();
  await expect(page.locator(".app-statusbar")).toContainText("sheet: main");

  // ---- rename the main sheet ----
  await openMenu(page, "Subcircuits");
  await page.getByRole("menuitem", { name: "Rename current sheet…" }).click();
  await dialog.getByRole("textbox").fill("toplevel");
  await dialog.getByRole("button", { name: "Rename" }).click();
  d = await doc(page);
  expect(d.circuits.map((c) => c.name)).toEqual(["toplevel", "alu"]);
  expect(d.circuits[0].components).toHaveLength(1); // the gate survived
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
