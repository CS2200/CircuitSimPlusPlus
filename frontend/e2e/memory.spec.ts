import { expect, test, type Page } from "@playwright/test";

/**
 * Inspector memory loading (UI_OVERHAUL §11): mem.ram/mem.rom get two loading
 * methods — paste hex values into a table dialog (writes `attrs.contents`),
 * or pick a `.hex` image with the file selector (autoload path in the Tauri
 * shell; embedded image in browser/mock mode, which is how e2e runs). The
 * old Watch-tab memory inspector is retired for now.
 */

interface CsxDoc {
  circuits: {
    name: string;
    components: { id: string; type: string; name?: string; attrs?: Record<string, unknown> }[];
  }[];
}

async function doc(page: Page): Promise<CsxDoc> {
  return page.evaluate(() =>
    JSON.parse((window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  );
}

/** World→screen via the live camera (same helper as editor.spec). */
async function world(page: Page, wx: number, wy: number): Promise<{ x: number; y: number }> {
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not laid out");
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

/** Select imem (body center at world (7,17) in the mock demo). */
async function selectImem(page: Page): Promise<void> {
  const p = await world(page, 7, 17);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator(".inspector-type")).toHaveText("mem.ram");
}

function imemAttrs(d: CsxDoc): Record<string, unknown> | undefined {
  return d.circuits[0].components.find((c) => c.type === "mem.ram" && c.name === "imem")?.attrs;
}

test("Inspector memory: paste hex into the table and apply it to contents", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await selectImem(page);

  await page.getByRole("button", { name: "Edit hex…" }).click();
  const dialog = page.getByRole("dialog", { name: "Memory contents" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill("0a 0b 2-ff");

  // The popup table shows every value in hex, padded to the memory width.
  await expect(dialog.locator(".mem-table")).toContainText("0000000a");
  await expect(dialog.locator(".mem-table")).toContainText("000000ff");
  await expect(dialog).toContainText("4 of");

  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).not.toBeVisible();

  const contents = String(imemAttrs(await doc(page))?.contents ?? "");
  expect(contents).toContain("0000000a");
  expect(contents).toContain("2-000000ff"); // canonical run encoding
});

test("Inspector memory: choosing a .hex file embeds the image (browser mode)", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await selectImem(page);

  const chooserPromise = page.waitForEvent("filechooser");
  await page.getByRole("button", { name: "Choose file…" }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({
    name: "prog.hex",
    mimeType: "text/plain",
    buffer: Buffer.from("de ad\nbe ef"),
  });

  // Browser mode has no real paths: the image is embedded in the document.
  await expect(page.locator(".toast")).toContainText("Embedded");
  const attrs = imemAttrs(await doc(page));
  expect(String(attrs?.contents ?? "")).toContain("000000de");
  await expect(page.locator(".inspector-mem-contents")).toContainText("4 words");
});
