import { defineConfig } from "@playwright/test";

// E2E runs against the Vite dev server (not the Tauri shell).
export default defineConfig({
  testDir: "./e2e",
  webServer: {
    command: "npm run dev",
    port: 1420,
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: "http://localhost:1420" },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
