import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/** Stand-in for the hidden textarea the legacy path uses. */
function stubDocument(): { value: string; exec: ReturnType<typeof vi.fn> } {
  const area = {
    value: "",
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    select: vi.fn(),
  };
  const exec = vi.fn(() => true);
  vi.stubGlobal("document", {
    createElement: () => area,
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: exec,
  } as unknown as Document);
  return {
    get value() {
      return area.value;
    },
    exec,
  };
}

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the async clipboard when it is there", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to a hidden textarea when the clipboard refuses", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error("denied");
        }),
      },
    });
    const area = stubDocument();
    expect(await copyText("hello")).toBe(true);
    expect(area.value).toBe("hello");
    expect(area.exec).toHaveBeenCalled();
  });

  it("reports failure instead of throwing", async () => {
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      createElement: () => {
        throw new Error("no DOM");
      },
      body: {},
    });
    expect(await copyText("hello")).toBe(false);
  });
});
