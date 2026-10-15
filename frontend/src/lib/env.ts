/**
 * Runtime environment probes.
 *
 * The Tauri webview injects `__TAURI_INTERNALS__`; a plain browser (mock-core
 * dev, e2e) does not. Kept in its own module so callers that only need the
 * flag don't pull in the Tauri plugin packages — importing those is wasteful
 * and, under vitest's node environment, noisy.
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
