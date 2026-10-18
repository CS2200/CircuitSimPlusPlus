import { expect, test, type Page } from "@playwright/test";

/**
 * Version history (UI_OVERHAUL §34/§38), browser/mock mode.
 *
 * The drawer overlays the right dock, previews the selected version on the
 * canvas, lists how it differs from the open document, and renames a version
 * when its name is clicked. Versions are taken on every successful save; in the
 * browser the store is sessionStorage-backed (the Tauri shell keeps it in the
 * app data directory), so every path here is the real one.
 */

const DRAWER = "Version history";

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
  await page.getByRole("button", { name: "Version history" }).click();
  const drawer = page.getByRole("complementary", { name: DRAWER });
  await expect(drawer).toBeVisible();
  return drawer;
}

/** Pixel fingerprint of the preview canvas: different versions must differ. */
function previewHash(page: Page): Promise<string> {
  return page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>(".history-preview canvas");
    return c === null ? "" : c.toDataURL().slice(-3000);
  });
}

test("version history: the top-bar button opens the drawer", async ({ page }) => {
  await page.goto("/");
  await openHistory(page);
});

test("version history: previews switch with the selection, and Restore applies one", async ({
  page,
}) => {
  await page.goto("/");

  await placeAndGate(page);
  await saveAs(page); // version 1 — one component
  await placeAndGate(page);
  await saveAs(page); // version 2 — two components

  const drawer = await openHistory(page);
  const rows = drawer.locator(".history-row");
  await expect(rows).toHaveCount(2);

  // The drawer opens on the newest version: it previews the canvas, and the
  // change list says there is nothing to report.
  await expect(page.locator(".history-preview")).toBeVisible();
  await expect(page.locator(".history-preview-text")).toContainText("Viewing an older version");
  await expect(drawer.locator(".history-diff-summary")).toHaveText(
    "No differences from the open document",
  );
  await expect.poll(async () => (await previewHash(page)).length).toBeGreaterThan(100);
  const newest = await previewHash(page);

  // The older version: a different circuit, and one part missing from it.
  await rows.nth(1).click();
  await expect.poll(async () => previewHash(page)).not.toBe(newest);
  await expect(drawer.locator(".history-diff-summary")).toHaveText("1 part removed");
  await expect(drawer.locator(".history-diff-list")).toContainText("− gate.and");

  // Restore is the only thing that touches the document.
  await page.getByRole("button", { name: "Restore this version" }).click();
  await expect(page.locator(".history-preview")).toHaveCount(0);
  await expect.poll(async () => (await doc(page)).circuits[0].components.length).toBe(1);
});

test("version history: click a name to rename it, then clear from Settings", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);
  await saveAs(page);

  const drawer = await openHistory(page);
  await drawer.locator(".history-label").first().click();
  const field = drawer.locator(".history-rename");
  await field.fill("Milestone");
  await field.press("Enter");
  await expect(drawer.locator(".history-label").first()).toHaveText("Milestone");

  await page.keyboard.press("Escape"); // Escape closes the drawer
  await expect(drawer).toHaveCount(0);

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
