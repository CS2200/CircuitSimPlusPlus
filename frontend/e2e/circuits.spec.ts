import { expect, test, type Page } from "@playwright/test";

/**
 * Circuits: the sheet tabs, the right-dock hierarchy tree, and deleting.
 *
 * The rail used to carry a separate "Circuits" explorer beside the Subcircuits
 * group — two answers to "which circuits exist". The hierarchy now lives in the
 * right dock's empty state (`CircuitTree`): every circuit nested from the
 * simulation root, one click to open a sheet (reopening a closed tab).
 */

async function newSubcircuit(page: Page): Promise<void> {
  await page.getByRole("button", { name: "New subcircuit" }).first().click();
  await page.keyboard.press("Escape"); // keep the default name
}

const docJson = async (page: Page) =>
  JSON.parse(
    await page.evaluate(() => (window as unknown as { __circuitDoc: () => string }).__circuitDoc()),
  ) as {
    circuits: {
      name: string;
      components: { type: string; name?: string; attrs?: Record<string, unknown> }[];
    }[];
  };

const tree = (page: Page) => page.getByRole("tree", { name: "Circuits" });

test("closing a tab keeps the circuit; the tree reopens it; delete asks", async ({ page }) => {
  await page.goto("/");
  await newSubcircuit(page);
  await expect(page.getByRole("tab", { name: "sub1" })).toHaveAttribute("aria-selected", "true");

  // × closes the TAB, not the circuit.
  await page.getByRole("button", { name: "Close sub1" }).first().click();
  await expect(page.getByRole("tab", { name: "sub1" })).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "main" })).toHaveAttribute("aria-selected", "true");
  expect((await docJson(page)).circuits.map((c) => c.name)).toEqual(["main", "sub1"]);

  // The circuit tree lists it (nothing places it yet) and opens it again.
  await expect(tree(page)).toContainText("sub1");
  await tree(page).getByRole("treeitem", { name: /sub1/ }).click();
  await expect(page.getByRole("tab", { name: "sub1" })).toHaveAttribute("aria-selected", "true");

  // Delete asks, in the app's own dialog; Cancel keeps it, Delete removes it.
  await page.getByRole("tab", { name: "sub1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  const ask = page.getByRole("dialog", { name: 'Delete "sub1"?' });
  await ask.getByRole("button", { name: "Cancel" }).click();
  expect((await docJson(page)).circuits).toHaveLength(2);

  await page.getByRole("tab", { name: "sub1" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete…" }).click();
  await page
    .getByRole("dialog", { name: 'Delete "sub1"?' })
    .getByRole("button", { name: "Delete" })
    .click();
  expect((await docJson(page)).circuits.map((c) => c.name)).toEqual(["main"]);
});

test("the tree nests instances from the root, and a node opens its sheet", async ({ page }) => {
  await page.goto("/");
  await newSubcircuit(page); // sub1 becomes active
  await page.getByRole("tab", { name: "main" }).click();

  // Place one instance of sub1 in main, so main → sub1 in the tree.
  await page.locator('[data-group="Subcircuits"]').click();
  await page.locator(".palette-group").getByRole("button", { name: "sub1" }).click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.press("Escape");
  // Deselect so the right dock falls back to the hierarchy tree.
  await page.mouse.click(canvas.x + 60, canvas.y + 60);

  await expect(tree(page).getByRole("treeitem", { name: /main/ })).toBeVisible();
  await expect(tree(page).getByRole("treeitem", { name: /sub1/ })).toBeVisible();

  await tree(page).getByRole("treeitem", { name: /sub1/ }).click();
  await expect(page.getByRole("tab", { name: "sub1" })).toHaveAttribute("aria-selected", "true");
});

test("renaming a subcircuit retargets its instances", async ({ page }) => {
  await page.goto("/");
  await newSubcircuit(page);
  await page.getByRole("tab", { name: "main" }).click();

  // An instance of sub1 in main.
  await page.locator('[data-group="Subcircuits"]').click();
  await page.locator(".palette-group").getByRole("button", { name: "sub1" }).click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.press("Escape");

  // Rename the definition's tab; the instance must follow (it addresses the
  // circuit by name, so leaving the old name behind failed the whole file).
  await page.getByRole("tab", { name: "sub1" }).dblclick();
  const name = page.getByRole("textbox", { name: "Circuit name" });
  await name.fill("alu");
  await name.press("Enter");

  const doc = (await docJson(page)).circuits;
  expect(doc.map((c) => c.name)).toEqual(["main", "alu"]);
  const instance = doc[0].components.find((c) => c.type === "subcircuit");
  expect(instance?.attrs?.circuit).toBe("alu");
});

test("a placed pin is named, so nothing fails to load", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-group="Wiring"]').click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  await page.getByRole("button", { name: "INPUT", exact: true }).click();
  await page.mouse.click(canvas.x + canvas.width / 2 - 120, canvas.y + canvas.height / 2);
  await page.getByRole("button", { name: "OUTPUT", exact: true }).click();
  await page.mouse.click(canvas.x + canvas.width / 2 + 120, canvas.y + canvas.height / 2);
  const pins = (await docJson(page)).circuits[0].components.filter((c) => c.type === "wiring.pin");
  expect(pins.map((p) => p.name)).toEqual(["in0", "out0"]);
  // No "name this pin" nag, and no load banner.
  await expect(page.locator('[data-note="unnamed-pin"]')).toHaveCount(0);
  await page.waitForTimeout(400); // past the live re-sync
  await expect(page.locator(".sim-banner")).toHaveCount(0);
});

test("a load error clears once fixed, and the banner can be dismissed", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-group="Wiring"]').click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  await page.getByRole("button", { name: "INPUT", exact: true }).click();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.press("Escape");

  // Break it: clear the pin's name (the engine refuses an unnamed pin).
  await page.getByPlaceholder("(unnamed)").fill("");
  await page.getByPlaceholder("(unnamed)").press("Enter");
  await page.getByRole("button", { name: "tick", exact: true }).click();
  const banner = page.locator(".sim-banner");
  await expect(banner).toContainText("Load failed");

  // Dismiss hides it…
  await banner.getByRole("button", { name: "Dismiss" }).click();
  await expect(banner).toHaveCount(0);

  // …and fixing the problem clears the error by itself (no command needed).
  await page.getByPlaceholder("(unnamed)").fill("a");
  await page.getByPlaceholder("(unnamed)").press("Enter");
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __sim: { state: () => { loaded: boolean } } }).__sim.state()
            .loaded,
      ),
    )
    .toBe(true);
  await expect(banner).toHaveCount(0);
});

test("a load error on ANOTHER sheet says where it is, and Fix goes there (§100)", async ({
  page,
}) => {
  await page.goto("/");
  // A pin on sub1 with its name cleared — then back on main, tab closed.
  await newSubcircuit(page);
  await page.locator('[data-group="Wiring"]').click();
  const canvas = await page.locator("canvas.circuit-canvas").boundingBox();
  if (canvas === null) throw new Error("canvas not visible");
  await page.getByRole("button", { name: "INPUT", exact: true }).click();
  await page.mouse.click(canvas.x + canvas.width / 2, canvas.y + canvas.height / 2);
  await page.keyboard.press("Escape");
  await page.getByPlaceholder("(unnamed)").fill("");
  await page.getByPlaceholder("(unnamed)").press("Enter");
  await page.getByRole("button", { name: "Close sub1" }).first().click();
  await expect(page.getByRole("tab", { name: "main" })).toHaveAttribute("aria-selected", "true");

  // The banner names the sheet, not just the part.
  const banner = page.locator(".sim-banner");
  await expect(banner).toContainText("Load failed");
  await expect(banner).toContainText("on “sub1”");

  // Fix opens sub1 (its tab was closed), selects the pin, focuses its Name.
  await banner.getByRole("button", { name: "Fix" }).click();
  await expect(page.getByRole("tab", { name: "sub1" })).toHaveAttribute("aria-selected", "true");
  const nameField = page.getByPlaceholder("(unnamed)");
  await expect(nameField).toBeFocused();

  // Naming it clears the banner by itself.
  await page.keyboard.type("req");
  await page.keyboard.press("Enter");
  await expect(banner).toHaveCount(0);
});
