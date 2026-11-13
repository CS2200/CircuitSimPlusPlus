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

/**
 * True only in the Tauri shell on macOS (§107). The macOS window uses an
 * overlay title bar, so its traffic lights float over the app's own header and
 * the header insets to clear them; that chrome exists only in the packaged app,
 * not a macOS browser (dev/e2e), hence the `isTauri()` gate. The webview's
 * `navigator.userAgent` ("Macintosh; Intel Mac OS X") is the probe — there is no
 * os plugin dependency for a single boolean.
 */
export function isMacOS(): boolean {
  return (
    isTauri() && typeof navigator !== "undefined" && /Macintosh|Mac OS X/.test(navigator.userAgent)
  );
}
