import { expect, test, type Page } from "@playwright/test";
import { expectScreenshot } from "./screenshots";

/**
 * U5 acceptance (mock side): the full sim control loop against the in-page
 * mock core — load, step, run-to-N, play/pause with live cycle telemetry,
 * wire state coloring, and the halt path (floating-read
 * banner + component marker).
 *
 * The dev server picks up `VITE_MOCK_CORE=1` from `.env.development`; the
 * page loads the mock demo circuit (?simdemo=1).
 */

interface SimState {
  loaded: boolean;
  running: boolean;
  cycle: number;
  halted: string | null;
  netCount: number;
}

function simState(page: Page): Promise<SimState> {
  return page.evaluate(() =>
    (window as unknown as { __sim: { state: () => SimState } }).__sim.state(),
  );
}

/** Click a point in world coordinates on the circuit canvas. */
async function clickWorld(page: Page, wx: number, wy: number): Promise<void> {
  const box = await page.locator("canvas.circuit-canvas").boundingBox();
  if (box === null) throw new Error("canvas not visible");
  const cam = await page.evaluate(() =>
    (
      window as unknown as { __circuitCamera: () => { x: number; y: number; scale: number } }
    ).__circuitCamera(),
  );
  await page.mouse.click(
    box.x + (wx - cam.x) * cam.scale + box.width / 2,
    box.y + (wy - cam.y) * cam.scale + box.height / 2,
  );
}

test.beforeEach(async ({ page }) => {
  // Pin the dark palette: these screenshots validate the classic dark
  // rendering (UI_OVERHAUL §4 — theme-picker coverage lives in the
  // visual/settings specs).
  await page.addInitScript(() => localStorage.setItem("csx.theme", "dark"));
  // Freeze the pulsing width-mismatch warning for a deterministic baseline.
  await page.addInitScript(() => localStorage.setItem("csx.pulses", "0"));
  await page.goto("/?simdemo=1");
});

test("U5: full sim control loop over the mock core", async ({ page }) => {
  // First command auto-loads the document into the core; two ticks = one
  // full clock cycle in delay mode (the old "cycle" button is gone).
  await page.getByRole("button", { name: "tick", exact: true }).click();
  await page.getByRole("button", { name: "tick", exact: true }).click();
  await expect
    .poll(() => simState(page), { message: "loaded, one cycle stepped" })
    .toMatchObject({ loaded: true, cycle: 1 });
  await expect(page.locator(".sim-status")).toContainText("cycle 1");

  // (The Watch tab is retired for now — UI_OVERHAUL §11 — so there is no
  // watch-panel value assertion here; the cycle counter is the telemetry.)

  // run-to-cycle-N.
  await page.locator(".sim-runto input").fill("42");
  await page.getByRole("button", { name: "run to" }).click();
  await expect.poll(() => simState(page)).toMatchObject({ cycle: 42 });

  // Play: cycle advances on its own; pause freezes it.
  await page.locator(".sim-play").click();
  await expect.poll(() => simState(page)).toMatchObject({ running: true });
  const before = (await simState(page)).cycle;
  await expect
    .poll(async () => (await simState(page)).cycle, { message: "cycle advances while running" })
    .toBeGreaterThan(before);
  await page.locator(".sim-play").click(); // pause
  await expect.poll(() => simState(page)).toMatchObject({ running: false });
  const frozen = (await simState(page)).cycle;
  await page.waitForTimeout(300);
  expect((await simState(page)).cycle).toBe(frozen);
  // Timing update arrives on pause (the T_obs critical-path button, U7).
  await expect(page.locator(".sim-tobs")).toContainText("T_obs");
});

test("U5: consuming a floating bus halts with a banner", async ({ page }) => {
  await page.getByRole("button", { name: "tick", exact: true }).click(); // load + 1 tick (clk high)
  await page.getByRole("button", { name: "tick", exact: true }).click(); // clk falls → bus floats
  await page.evaluate(() => {
    const sim = (
      window as unknown as {
        __sim: { poke: (c: number, p: string, v: object) => Promise<void> };
      }
    ).__sim;
    return sim.poke(5, "consume", { v: "0", x: "0", z: "0" }); // comp 5 = buffer
  });
  await expect(page.locator(".sim-banner")).toContainText("floating-read");
  await expect(page.locator(".sim-banner")).toContainText("comp 5");
  await expect.poll(() => simState(page)).toMatchObject({ halted: "floating-read" });
});

test("sim shortcuts: Ctrl+J tick, Ctrl+K run/pause, Ctrl+R reset", async ({ page }) => {
  await page.goto("/?simdemo=1");
  // wait for effects (the DEV hook proves the key listeners are attached)
  await page.waitForFunction(() => (window as unknown as { __sim?: unknown }).__sim !== undefined);
  // Ctrl+J loads + steps one tick (clk rises, pc latches — still cycle 0)
  await page.keyboard.press("Control+j");
  await expect.poll(() => simState(page)).toMatchObject({ loaded: true, cycle: 0 });
  await page.keyboard.press("Control+j"); // clk falls
  await expect.poll(() => simState(page)).toMatchObject({ cycle: 1 });
  // Ctrl+K runs until halted/paused; Ctrl+K again pauses.
  await page.keyboard.press("Control+k");
  await expect.poll(() => simState(page)).toMatchObject({ running: true });
  await page.keyboard.press("Control+k");
  await expect.poll(() => simState(page)).toMatchObject({ running: false });
  // Ctrl+R resets to a fresh load (+ autoload toast).
  await page.keyboard.press("Control+r");
  await expect.poll(() => simState(page)).toMatchObject({ loaded: true, cycle: 0 });
  await expect(page.locator(".toast")).toContainText("Reset");
});

test("Ctrl+J while the clock is running force-stops it", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await page.waitForFunction(() => (window as unknown as { __sim?: unknown }).__sim !== undefined);

  // Ctrl+K hands the timeline to the play loop…
  await page.keyboard.press("Control+k");
  await expect.poll(() => simState(page)).toMatchObject({ running: true });

  // …so a bare step would be a no-op. Ctrl+J must stop the clock, not leave it
  // spinning (the reported "Ctrl+J after Ctrl+K did nothing" bug).
  await page.keyboard.press("Control+j");
  await expect.poll(() => simState(page)).toMatchObject({ running: false });
});

test("U5: a geometry-only edit (rotate) does not reboot the simulation", async ({ page }) => {
  await page.goto("/?simdemo=1");
  await page.waitForFunction(() => (window as unknown as { __sim?: unknown }).__sim !== undefined);
  const tick = page.getByRole("button", { name: "tick", exact: true });
  await tick.click();
  await tick.click();
  await expect
    .poll(() => simState(page), { message: "one full cycle stepped" })
    .toMatchObject({ loaded: true, cycle: 1 });
  const before = await simState(page);

  // Select the adder and rotate it: the geometry changes, the netlist does not,
  // so the engine must NOT reload. A reload reboots the sim and drops the cycle
  // counter to 0 — the old "any edit looks like a reset / the clock lights up"
  // bug. (This also pins the decision that `rot` is geometry, not netlist.)
  await clickWorld(page, 24, 3);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(500); // well past the 140 ms live-resync debounce

  expect((await simState(page)).cycle).toBe(before.cycle);
});

test("U5: structural edits re-sync the engine live (no tick needed)", async ({ page }) => {
  // The mount-time pre-load puts the *empty* untitled document in the engine.
  // A part placed afterwards must appear there on its own — level-triggered
  // values show immediately, without waiting for a command (the stale-engine
  // bug made every command inert and shift-click read "no sim loaded").
  await page.goto("/");
  await page.waitForFunction(() => (window as unknown as { __sim?: unknown }).__sim !== undefined);
  await expect
    .poll(() => simState(page), { message: "empty document pre-loaded" })
    .toMatchObject({ loaded: true, netCount: 0 });

  // Place AND + NOT and wire them — all AFTER the mount pre-load, no command.
  await page.locator('[data-group="Gates"]').click();
  await page.getByRole("button", { name: "AND", exact: true }).click();
  await clickWorld(page, 2.5, 1.5);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "NOT", exact: true }).click();
  await clickWorld(page, 11.5, 1);
  await page.keyboard.press("Escape");
  await clickWorld(page, 5, 1.5); // AND.out
  await clickWorld(page, 10, 1); // NOT.in

  // The debounced live re-sync reloads the *edited* circuit with no command:
  // the engine paints its nets on its own, at a fresh power-on (cycle 0).
  await expect
    .poll(async () => (await simState(page)).netCount, { message: "nets painted on edit" })
    .toBeGreaterThan(0);
  expect((await simState(page)).cycle).toBe(0); // settled without a tick
});

test("U5: wires render in sim state colors (lit-circuit baseline)", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: "tick", exact: true }).click(); // clk high, bus driven
  await expect.poll(() => simState(page)).toMatchObject({ loaded: true, cycle: 0 });
  await page.waitForTimeout(600); // let propagation pulses expire (deterministic baseline)
  await page.addStyleTag({ content: ".canvas-overlay { display: none }" });
  await expectScreenshot(page.locator(".editor-wrap"), testInfo, "sim-lit.png", {
    maxDiffPixelRatio: 0.02,
  });
});

test("waveform viewer: traces the run and takes the canvas selection", async ({ page }) => {
  const tick = page.getByRole("button", { name: "tick", exact: true });
  await tick.click(); // loads the document into the core
  await tick.click();
  await tick.click(); // cycle 2

  // Select the sheet BEFORE opening: the viewer takes over the canvas area, so
  // "Add selection" consumes the selection that was already made.
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Control+Alt+w");

  await expect(page.locator(".wave-view")).toBeVisible();
  // The cursor readout starts at the newest recorded cycle.  It may lag the
  // engine's cycle number, and correctly so: a cycle in which no net changed
  // adds no sample to the trace.
  await expect(page.locator(".wave-bar-text").last()).toHaveText(/^cycle \d+$/);
  const rows = async (): Promise<number> =>
    Number(
      /(\d+) rows?/.exec(await page.locator(".wave-bar-text").first().innerText())?.[1] ?? "0",
    );
  const before = await rows();

  // The selection resolves to each part's OUTPUT pin and the trace grows.
  await page.getByRole("button", { name: /Add selection/ }).click();
  await expect
    .poll(rows, { message: "the trace gained the selected signals" })
    .toBeGreaterThan(before);

  // The sim transport lives in the header, so it still drives the run while the
  // viewer is open — and the trace follows it to the live edge.
  const cycle = async (): Promise<number> =>
    Number(/cycle (\d+)/.exec(await page.locator(".wave-bar-text").last().innerText())?.[1] ?? "0");
  const atOpen = await cycle();
  await page.locator(".sim-runto input").fill("12");
  await page.getByRole("button", { name: "run to" }).click();
  await expect.poll(cycle, { message: "the trace followed the run" }).toBeGreaterThan(atOpen);

  // The header button is the toggle: while the viewer is up it offers the way
  // back, and clicking it closes the view — no reaching for the bar's Close.
  const back = page.getByRole("button", { name: "Back to the circuit" });
  await expect(back).toBeVisible();
  await expect(back).toHaveAttribute("aria-pressed", "true");
  await back.click();
  await expect(page.locator(".wave-view")).toHaveCount(0);
  await expect(page.locator("canvas.circuit-canvas")).toBeVisible();
  // …and the same button is the viewer again.
  const again = page.getByRole("button", { name: "Waveform viewer" });
  await expect(again).toBeVisible();
  await again.click();
  await expect(page.locator(".wave-view")).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".wave-view")).toHaveCount(0);
});
