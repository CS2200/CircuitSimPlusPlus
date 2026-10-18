import { expect, test, type Page } from "@playwright/test";

/**
 * Autosave + crash recovery (phase 1), browser/mock mode.
 *
 * The browser has no filesystem, so no file is rewritten; the recovery store is
 * `sessionStorage`-backed there, and that is exactly what makes
 * "crash → relaunch → recover" testable: a reload stands in for relaunching
 * the app. The Tauri path (atomic file rewrite via `save_circuit`, app-data
 * recovery store) is covered by the Rust unit tests plus manual smoke.
 */

const INDICATOR = ".save-state";
const RECOVERY_DIALOG = "Recover unsaved work";

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

test("autosave keeps a recovery copy as soon as the edit happens", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(INDICATOR)).toHaveText("Saved");

  await placeAndGate(page);
  // The change is persisted on the leading edge, so the indicator moves off
  // "saved" immediately; browser mode cannot write a file, so the honest end
  // state is a recovery copy only (the shell reads "Saved <time>").
  await expect(page.locator(INDICATOR)).not.toHaveText(/^Saved/);
  await expect(page.locator(INDICATOR)).toContainText("Autosaved locally", { timeout: 15000 });
});

test("crash recovery: the autosaved copy survives a relaunch and restores", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);
  await expect(page.locator(INDICATOR)).toContainText("Autosaved locally", { timeout: 15000 });

  // Relaunch with an unsaved document.
  await page.reload();

  const dialog = page.getByRole("dialog", { name: RECOVERY_DIALOG });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Restore" }).click();
  await expect(dialog).toHaveCount(0);

  // The recovered document is back in the editor — and dirty again, so
  // autosave and the unsaved-changes prompt keep protecting it.
  expect((await doc(page)).circuits[0].components).toHaveLength(1);
  await expect(page.locator(INDICATOR)).not.toHaveText(/^Saved/);
});

test("discarding a recovery copy clears it for good", async ({ page }) => {
  await page.goto("/");
  await placeAndGate(page);
  await expect(page.locator(INDICATOR)).toContainText("Autosaved locally", { timeout: 15000 });

  await page.reload();
  const dialog = page.getByRole("dialog", { name: RECOVERY_DIALOG });
  await dialog.getByRole("button", { name: "Discard" }).click();
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole("dialog", { name: RECOVERY_DIALOG })).toHaveCount(0);
});

test("autosave can be turned off in Settings", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: "Settings…" }).click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.getByRole("tab", { name: "Autosave" }).click();
  await settings.getByRole("checkbox", { name: /^Autosave/ }).uncheck();
  await page.keyboard.press("Escape");
  await expect(page.locator(INDICATOR)).toHaveText("Autosave off");

  await placeAndGate(page);
  await expect(page.locator(INDICATOR)).toHaveText("Unsaved changes (autosave off)");
  // Well past the (now disabled) idle window: a relaunch still has nothing.
  await page.waitForTimeout(3500);
  await page.reload();
  await expect(page.getByRole("dialog", { name: RECOVERY_DIALOG })).toHaveCount(0);
});
