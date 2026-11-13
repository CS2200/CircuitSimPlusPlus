import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacOS, isTauri } from "./env";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36";

afterEach(() => vi.unstubAllGlobals());

describe("isTauri", () => {
  it("is false in a plain browser", () => {
    vi.stubGlobal("window", {});
    expect(isTauri()).toBe(false);
  });

  it("is true when the webview injects its internals", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    expect(isTauri()).toBe(true);
  });
});

describe("isMacOS", () => {
  it("is false in a macOS browser (no overlay chrome there)", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { userAgent: MAC_UA });
    expect(isMacOS()).toBe(false);
  });

  it("is true in the Tauri shell on macOS", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent: MAC_UA });
    expect(isMacOS()).toBe(true);
  });

  it("is false in the Tauri shell on Linux", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    vi.stubGlobal("navigator", { userAgent: LINUX_UA });
    expect(isMacOS()).toBe(false);
  });
});
