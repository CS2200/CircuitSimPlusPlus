import { expect, test, type Locator, type Page } from "@playwright/test";

/**
 * Inspector memory loading (UI_OVERHAUL §11/§14): mem.ram/mem.rom get two
 * loading methods — a hex GRID where you select a cell and paste the values
 * (they fill from that address; `attrs.contents`), or a `.hex` file picked
 * with the file selector (autoload path in the Tauri shell; embedded image in
 * browser/mock mode, which is how e2e runs). The old Watch-tab memory
 * inspector is retired for now.
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

/**
 * Wait until the mock demo has loaded and its camera has settled. The demo
 * auto-fits its view on mount; reading the camera before that yields a stale
 * origin and the click lands on the wrong point (a real race in this flow).
 */
async function ready(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as unknown as {
      __circuitCamera?: () => { x: number; y: number; scale: number };
      __camKey?: string;
    };
    const c = w.__circuitCamera?.();
    if (c == null) return false;
    const key = `${c.x},${c.y},${c.scale}`;
    const settled = w.__camKey === key;
    w.__camKey = key;
    return settled;
  });
}

/** Select imem (body center at world (7,17) in the mock demo). */
async function selectImem(page: Page): Promise<void> {
  await ready(page);
  const p = await world(page, 7, 17);
  await page.mouse.click(p.x, p.y);
  await expect(page.locator(".inspector-id")).toHaveText("RAM");
}

function imemAttrs(d: CsxDoc): Record<string, unknown> | undefined {
  return d.circuits[0].components.find((c) => c.type === "mem.ram" && c.name === "imem")?.attrs;
}

/** Paste text into an element (synthetic paste event: no clipboard grants). */
async function pasteInto(target: Locator, text: string): Promise<void> {
  await target.evaluate((el, value) => {
    const data = new DataTransfer();
    data.setData("text/plain", value);
    el.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  }, text);
}

test("Inspector memory: select a cell, paste, and apply to contents", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await selectImem(page);

  await page.getByRole("button", { name: "Edit hex…" }).click();
  const dialog = page.getByRole("dialog", { name: "Memory contents" });
  await expect(dialog).toBeVisible();

  // Select the first cell and paste — values fill from there, no paste box.
  await dialog.locator('input[data-addr="0"]').click();
  await pasteInto(dialog, "0a 0b 2-ff");
  await expect(dialog.locator('input[data-addr="0"]')).toHaveValue("0000000a");
  await expect(dialog.locator('input[data-addr="1"]')).toHaveValue("0000000b");
  await expect(dialog.locator('input[data-addr="2"]')).toHaveValue("000000ff");
  await expect(dialog.locator('input[data-addr="3"]')).toHaveValue("000000ff");

  // A later cell pastes from THAT cell onward.
  await dialog.locator('input[data-addr="8"]').click();
  await pasteInto(dialog, "deadbeef");
  await expect(dialog.locator('input[data-addr="8"]')).toHaveValue("deadbeef");
  await expect(dialog.locator('input[data-addr="9"]')).toHaveValue("");

  // Typing into one cell edits just that word.
  await dialog.locator('input[data-addr="9"]').fill("2a");
  await expect(dialog.locator('input[data-addr="9"]')).toHaveValue("0000002a");

  await dialog.getByRole("button", { name: "Apply" }).click();
  await expect(dialog).not.toBeVisible();

  const contents = String(imemAttrs(await doc(page))?.contents ?? "");
  expect(contents).toContain("0000000a");
  expect(contents).toContain("2-000000ff"); // canonical run encoding
  expect(contents).toContain("0000002a");
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

test("Inspector memory: one Clear — it lives in the editor, and it empties the image", async ({
  page,
}) => {
  await page.goto("/?simdemo=1");
  await selectImem(page);

  // The panel offers choosing a file and editing the image; the bare `Clear`
  // that used to sit between them (and did something different) is gone.
  await expect(page.getByRole("button", { name: "Clear", exact: true })).toHaveCount(0);

  // Set an image through the editor, then clear it through the same editor.
  await page.getByRole("button", { name: "Edit hex…" }).click();
  const dialog = page.getByRole("dialog", { name: "Memory contents" });
  await dialog.locator('input[data-addr="0"]').click();
  await pasteInto(dialog, "0a 0b");
  await dialog.getByRole("button", { name: "Apply" }).click();
  expect(String(imemAttrs(await doc(page))?.contents ?? "")).toContain("0000000a");

  await page.getByRole("button", { name: "Edit hex…" }).click();
  await expect(dialog.locator('input[data-addr="0"]')).toHaveValue("0000000a");
  await dialog.getByRole("button", { name: "Clear all" }).click();
  await expect(dialog.locator('input[data-addr="0"]')).toHaveValue("");
  await dialog.getByRole("button", { name: "Apply" }).click();
  expect(imemAttrs(await doc(page))?.contents).toBeFalsy();
  await expect(page.locator(".inspector-mem-contents")).toContainText("0 words");
});

test("Inspector memory: both widths are one-click picks, and the address one follows depth", async ({
  page,
}) => {
  await page.goto("/?simdemo=1");
  await selectImem(page); // 32-bit, 256 words

  // Two pickers, the way every other bit width is chosen — and the address
  // picker shows the DERIVED width (8 for 256 words) while `addrBits` is absent.
  await expect(page.getByRole("radio", { name: "Address Bits 8" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await expect(page.getByRole("radio", { name: "Data Bits 32" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(imemAttrs(await doc(page))?.addrBits).toBeUndefined();

  // Shrinking the memory moves the derived width with it — the picker tracks
  // `depth` for as long as `addrBits` is absent.
  await page.getByRole("spinbutton", { name: "Words" }).fill("16");
  await expect(page.getByRole("radio", { name: "Address Bits 4" })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  expect(imemAttrs(await doc(page))?.addrBits).toBeUndefined();

  // Picking a width makes it explicit, independent of the word count from then
  // on; the data width is never involved.
  await page.getByRole("radio", { name: "Address Bits 12" }).click();
  const attrs = imemAttrs(await doc(page));
  expect(attrs?.addrBits).toBe(12);
  expect(attrs?.depth).toBe(16);
  expect(attrs?.bitsize).toBe(32);
});
