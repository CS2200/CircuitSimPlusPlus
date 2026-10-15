import { expect, test, type Page } from "@playwright/test";

/**
 * Version history (autosave phase 3), browser/mock mode.
 *
 * Versions are taken on every successful save; in the browser the store is
 * sessionStorage-backed (the Tauri shell keeps them in the app data directory),
 * so everything here exercises the real list / preview / restore / name / clear
 * paths without a filesystem.
 */

const HISTORY_DIALOG = "Version history";

interface CsxDoc {
  circuits: { components: unknown[] }[];
}

async function doc(page: Page): Promise<CsxDoc> {
  return page.evaluate(() =>
    JSON.parse((window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  );
}

/** Place one AND gate at the canvas center (dirty-ifies the document). */
async function placeAndGate(page: Page): Promise<void> {
  await page.locator('[data-group="Gates"]').click();
  await page.getByRole("button", { name: "AND", exact: true }).click();
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("Escape");
}

async function openMenu(page: Page, name: string): Promise<void> {
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page.getByRole("menu", { name })).toBeVisible();
}

/** Save As… (a download in the browser) — the save that takes a version. */
async function saveAs(page: Page): Promise<void> {
  await openMenu(page, "File");
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: "Save As…" }).click();
  await download;
}

async function openHistory(page: Page) {
  await openMenu(page, "File");
  await page.getByRole("menuitem", { name: "Version history…" }).click();
  const dialog = page.getByRole("dialog", { name: HISTORY_DIALOG });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("version history: the top-bar button opens the dialog", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Version history" }).click();
  await expect(page.getByRole("dialog", { name: HISTORY_DIALOG })).toBeVisible();
});

test("version history: two saves, then restore the earlier one", async ({ page }) => {
  await page.goto("/");

  await placeAndGate(page);
  await saveAs(page); // version 1 — one component
  await placeAndGate(page);
  await saveAs(page); // version 2 — two components

  const dialog = await openHistory(page);
  const rows = dialog.locator(".history-row");
  await expect(rows).toHaveCount(2);

  // Newest first: the second row is the one-component version.
  await rows.nth(1).click();
  await expect(dialog.locator(".history-detail")).toContainText("1 parts");

  await dialog.getByRole("button", { name: "Restore" }).click();
  await expect(dialog).toHaveCount(0);

  // The old snapshot is back in the editor (and dirty again).
  await expect.poll(async () => (await doc(page)).circuits[0].components.length).toBe(1);
});

test("version history: name a version, then clear the history", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);
  await saveAs(page);

  const dialog = await openHistory(page);
  await dialog.getByRole("button", { name: "Name…" }).click();
  await page.getByPlaceholder("(unnamed)").fill("Milestone");
  await page.getByRole("button", { name: "Name", exact: true }).click();
  // A named version is badged, and survives retention.
  await expect(dialog.locator(".history-badge")).toHaveText("named");

  await page.keyboard.press("Escape"); // close the history dialog

  // Settings ▸ Autosave: the usage readout + "clear this file's history".
  await openMenu(page, "File");
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Autosave" }).click();
  await expect(settings).toContainText("across 1 file(s)");

  page.once("dialog", (d) => void d.accept()); // the clear confirmation
  await settings.getByRole("button", { name: "Clear this file's history" }).click();
  await expect(settings).toContainText("across 0 file(s)");
});
