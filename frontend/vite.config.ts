/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port 1420 + strictPort are part of the Tauri contract (crates/app/tauri.conf.json).
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  // This is a desktop bundle, not a web page: a ~0.5 MB JS payload is fine, so
  // do not warn about it on every build.
  build: {
    chunkSizeWarningLimit: 700,
  },
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
