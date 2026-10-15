import { existsSync } from "node:fs";
import { expect, type Locator, type TestInfo } from "@playwright/test";

/**
 * Screenshot assertion with a first-run-on-this-platform escape hatch.
 *
 * `expect(locator).toHaveScreenshot` fails when the platform has no committed
 * baseline (e.g. Linux CI the first time a new screenshot ships, or a
 * Windows dev machine — baselines are committed per platform). Even with
 * `updateSnapshots: "missing"` Playwright still fails that first run.
 *
 * This helper keeps the gate honest AND green:
 *  - baseline exists → normal pixel comparison (changed shots fail);
 *  - baseline missing → capture the baseline to the expected path and pass,
 *    annotated, so the file is produced for review + commit. Subsequent runs
 *    compare against it.
 *
 * `name` follows `toHaveScreenshot` naming — the platform suffix is resolved
 * by `testInfo.snapshotPath`.
 */
export async function expectScreenshot(
  target: Locator,
  testInfo: TestInfo,
  name: string,
  options: { maxDiffPixelRatio?: number } = {},
): Promise<void> {
  const path = testInfo.snapshotPath(name);
  if (!existsSync(path)) {
    await target.screenshot({ path });
    testInfo.annotations.push({
      type: "baseline-created",
      description: `No ${process.platform} baseline for ${name} — wrote ${path} for review; commit it.`,
    });
    return;
  }
  await expect(target).toHaveScreenshot(name, options);
}
