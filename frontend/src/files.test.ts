import { afterEach, describe, expect, it, vi } from "vitest";
import {
  forgetSavedFileHandle,
  hasSavedFileHandle,
  isRealFilePath,
  saveTextFile,
  siblingPath,
} from "./files";

/**
 * Browser save (Â§38). The reuse rule â€” Ctrl+S writes the file it already has
 * instead of re-opening the picker â€” only exists in the browser and is skipped
 * under automation, so it is pinned here against a stubbed picker.
 */

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

function setGlobal(name: "window" | "navigator", value: unknown): void {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

function restoreGlobal(name: "window" | "navigator", descriptor?: PropertyDescriptor): void {
  if (descriptor === undefined) delete (globalThis as Record<string, unknown>)[name];
  else Object.defineProperty(globalThis, name, descriptor);
}

interface StubHandle {
  writes: string[];
}

/** Install a stub File System Access picker; returns its call log + handles. */
function installPicker(): { picker: ReturnType<typeof vi.fn>; handles: StubHandle[] } {
  const handles: StubHandle[] = [];
  const picker = vi.fn(async () => {
    const handle: StubHandle = { writes: [] };
    handles.push(handle);
    return {
      createWritable: async () => ({
        write: async (data: string) => {
          handle.writes.push(data);
        },
        close: async () => undefined,
      }),
    };
  });
  setGlobal("window", { showSaveFilePicker: picker });
  setGlobal("navigator", { webdriver: false });
  return { picker, handles };
}

afterEach(() => {
  forgetSavedFileHandle();
  restoreGlobal("window", originalWindow);
  restoreGlobal("navigator", originalNavigator);
});

describe("saveTextFile (browser mode)", () => {
  it("asks once, then writes the same file on later saves", async () => {
    const { picker, handles } = installPicker();

    expect(hasSavedFileHandle()).toBe(false);
    expect(await saveTextFile("alu.csx", "one")).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(hasSavedFileHandle()).toBe(true);

    // Second save: same file, no prompt.
    expect(await saveTextFile("alu.csx", "two")).toBe(true);
    expect(picker).toHaveBeenCalledTimes(1);
    expect(handles[0].writes).toEqual(["one", "two"]);
  });

  it("forcePicker asks again (Save As / rename)", async () => {
    const { picker, handles } = installPicker();
    await saveTextFile("alu.csx", "one");
    await saveTextFile("alu2.csx", "two", { forcePicker: true });
    expect(picker).toHaveBeenCalledTimes(2);
    expect(handles[1].writes).toEqual(["two"]);
  });

  it("a cancelled picker writes nothing and keeps no handle", async () => {
    setGlobal("window", {
      showSaveFilePicker: vi.fn(async () => {
        throw new DOMException("cancelled", "AbortError");
      }),
    });
    setGlobal("navigator", { webdriver: false });

    expect(await saveTextFile("alu.csx", "one")).toBe(false);
    expect(hasSavedFileHandle()).toBe(false);
  });

  it("forgetting the file makes the next save ask again (New / Open)", async () => {
    const { picker } = installPicker();
    await saveTextFile("alu.csx", "one");
    forgetSavedFileHandle();
    await saveTextFile("other.csx", "two");
    expect(picker).toHaveBeenCalledTimes(2);
  });
});

describe("path helpers (Â§40)", () => {
  it("treats Windows and POSIX paths as real, bare names as not", () => {
    expect(isRealFilePath("C:\\Users\\me\\alu.csx")).toBe(true);
    expect(isRealFilePath("/home/me/alu.csx")).toBe(true);
    expect(isRealFilePath("alu.csx")).toBe(false);
    expect(isRealFilePath("(unsaved)")).toBe(false);
    expect(isRealFilePath(null)).toBe(false);
  });

  it("files a name beside the original, keeping its separator", () => {
    expect(siblingPath("C:\\Users\\me\\alu.csx", "alu2.csx")).toBe("C:\\Users\\me\\alu2.csx");
    expect(siblingPath("/home/me/alu.csx", "alu2.csx")).toBe("/home/me/alu2.csx");
    expect(siblingPath("alu.csx", "alu2.csx")).toBe("alu2.csx");
  });
});
