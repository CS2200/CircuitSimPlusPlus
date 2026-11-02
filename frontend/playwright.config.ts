import { defineConfig } from "@playwright/test";

// E2E runs against the Vite dev server (not the Tauri shell).
export default defineConfig({
  testDir: "./e2e",
  // CI reruns a flaky test instead of failing the build (Playwright's own
  // recommendation); local runs stay strict. Trace the first retry so a real
  // flake still leaves evidence.
  retries: process.env.CI ? 2 : 0,
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: !process.env.CI,
  },
  use: {
    baseURL: "http://localhost:1420",
    // Pin the viewport (and DPR) so the canvas screenshots are reproducible:
    // Playwright's default viewport could change between versions, silently
    // invalidating every committed baseline. Baselines are committed for Linux
    // only (CI renders there); see e2e/screenshots.ts.
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
