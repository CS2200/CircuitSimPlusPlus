import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_THEME, normalizeColor, resolveTheme } from "./theme";

/**
 * Canvas theme resolution (DESIGN.md §7.1). The colour math in `docScene`
 * parses `#rrggbb`, so `resolveTheme` must never hand it a background-equal
 * fallback for a colour the engine serialized as `rgb(...)` — that is the
 * "wires vanish against the canvas" failure this guards (docs/bugs.md).
 */

describe("normalizeColor", () => {
  it("passes canonical hex through", () => {
    expect(normalizeColor("#5a85b3", "#000000")).toBe("#5a85b3");
    expect(normalizeColor("  #FFFFFF ", "#000000")).toBe("#ffffff");
  });

  it("expands shorthand hex", () => {
    expect(normalizeColor("#abc", "#000000")).toBe("#aabbcc");
  });

  it("converts rgb()/rgba() (a webview may serialize custom properties this way)", () => {
    expect(normalizeColor("rgb(74, 143, 216)", "#000000")).toBe("#4a8fd8");
    expect(normalizeColor("rgba(0, 0, 0, 0.5)", "#000000")).toBe("#000000");
    expect(normalizeColor("rgba(0, 0, 0, 0)", "#123456")).toBe("#123456");
    expect(normalizeColor("rgb(255 255 255 / 100%)", "#000000")).toBe("#ffffff");
  });

  it("returns the fallback for empty or unparseable values", () => {
    expect(normalizeColor("", "#123456")).toBe("#123456");
    expect(normalizeColor("color(display-p3 0 0 0)", "#123456")).toBe("#123456");
    expect(normalizeColor("tomato", "#123456")).toBe("#123456");
  });
});

describe("resolveTheme", () => {
  const original = globalThis.getComputedStyle;

  afterEach(() => {
    globalThis.getComputedStyle = original;
  });

  it("normalizes every palette colour to hex, whatever the engine returns", () => {
    // A webview that reports custom properties as rgb() instead of the authored
    // hex: the theme must still come out as hex so `mixHex` works.
    const values: Record<string, string> = {
      "--bg": "rgb(0, 0, 0)",
      "--grid": "rgb(19, 19, 24)",
      "--panel": "rgb(10, 10, 14)",
      "--panel-border": "rgb(38, 38, 46)",
      "--text": "rgb(242, 242, 247)",
      "--text-dim": "rgb(156, 156, 173)",
      "--accent": "rgb(122, 162, 255)",
      "--wire-low": "rgb(74, 143, 216)",
      "--wire-high": "rgb(46, 232, 122)",
      "--wire-x": "rgb(255, 92, 82)",
      "--wire-z": "rgb(125, 125, 136)",
      "--wire-disconnected": "rgb(118, 118, 128)",
      "--bus-a": "rgb(255, 201, 77)",
      "--bus-b": "rgb(197, 140, 255)",
      "--bus-c": "rgb(90, 230, 245)",
      "--bus-d": "rgb(255, 133, 189)",
      "--bus-e": "rgb(201, 247, 90)",
      "--violation": "rgb(255, 171, 61)",
    };
    globalThis.getComputedStyle = (() => ({
      getPropertyValue: (name: string) => values[name] ?? "",
    })) as unknown as typeof getComputedStyle;

    const theme = resolveTheme({} as Element);
    expect(theme.bg).toBe("#000000");
    expect(theme.wire.high).toBe("#2ee87a");
    expect(theme.bus[0]).toBe("#ffc94d");
    // Every value is a hex string, never the raw rgb() input.
    for (const c of [theme.bg, theme.wire.low, theme.bus[4], theme.violation]) {
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("falls back to the dark palette when properties are absent", () => {
    globalThis.getComputedStyle = (() => ({
      getPropertyValue: () => "",
    })) as unknown as typeof getComputedStyle;
    const theme = resolveTheme({} as Element);
    expect(theme.bg).toBe(FALLBACK_THEME.bg);
    expect(theme.wire.high).toBe(FALLBACK_THEME.wire.high);
  });
});
