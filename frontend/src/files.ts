/**
 * File open/save plumbing (FRONTEND.md U6).
 *
 * In the Tauri shell these use the native dialog + fs plugins, so paths are
 * REAL — the engine loads via `load_circuit{path}` and memory autoloads
 * resolve next to the circuit file (DESIGN.md §5.2/§11). In a plain browser
 * (mock-core dev, e2e) they fall back to a hidden `<input type=file>` and a
 * blob download; the browser never sees a real path.
 */

import { open as dialogOpen, save as dialogSave } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { isTauri } from "./lib/env";

const CSX_FILTERS = [{ name: "CircuitSim++ circuit", extensions: ["csx"] }];

export { isTauri };

export interface OpenedCircuit {
  /** Real path (Tauri) or null (browser — file paths are not exposed). */
  path: string | null;
  /** File name only — for labels and Save-As suggestions. */
  name: string;
  text: string;
}

export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** Prompt for a circuit to open; null when the user cancels. */
export async function openCircuitFile(): Promise<OpenedCircuit | null> {
  if (isTauri()) {
    const sel = await dialogOpen({ multiple: false, directory: false, filters: CSX_FILTERS });
    if (sel === null) return null;
    const text = await readTextFile(sel);
    return { path: sel, name: baseName(sel), text };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csx,application/json";
    input.style.display = "none";
    // Must be attached: Chromium ignores programmatic clicks on detached
    // file inputs.
    document.body.appendChild(input);
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        input.remove();
        return resolve(null);
      }
      file.text().then(
        (text) => {
          input.remove();
          resolve({ path: null, name: file.name, text });
        },
        () => {
          input.remove();
          resolve(null);
        },
      );
    };
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    // Deferred: Chromium drops a file chooser for an input that is created
    // AND clicked within the same synchronous event-handler block.
    setTimeout(() => input.click(), 0);
  });
}

/** Ensure a `.csx` extension on a user-chosen save target. */
export function withCsxExtension(path: string): string {
  return /\.csx$/i.test(path) ? path : `${path}.csx`;
}

/**
 * Choose where to save (Tauri only): native save dialog → a real path the
 * engine writes through `save_circuit`. Null on cancel.
 */
export async function pickSavePath(
  suggestedName: string,
  currentPath: string | null,
): Promise<string | null> {
  const sel = await dialogSave({
    defaultPath: currentPath ?? suggestedName,
    filters: CSX_FILTERS,
  });
  // Cancelled: the plugin answers null/undefined (defensively also ""), and a
  // blank answer must never be turned into a write (UI_OVERHAUL §20).
  const picked = typeof sel === "string" ? sel.trim() : "";
  return picked === "" ? null : withCsxExtension(picked);
}

/**
 * Browser-mode save: prefer the File System Access API (Chromium), which gives
 * a real Save-As dialog **and a cancel signal**; fall back to a download where
 * it is unavailable (or under automation, where a native picker could not be
 * driven). Returns false when the user cancelled.
 */
export async function saveTextFile(name: string, text: string): Promise<boolean> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<{
        createWritable: () => Promise<{
          write: (data: string) => Promise<void>;
          close: () => Promise<void>;
        }>;
      }>;
    }
  ).showSaveFilePicker;
  const automated = typeof navigator !== "undefined" && navigator.webdriver === true;
  if (typeof picker === "function" && !automated) {
    try {
      const handle = await picker({
        suggestedName: withCsxExtension(name),
        types: [{ description: "CircuitSim++ circuit", accept: { "application/json": [".csx"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return true;
    } catch (err) {
      // AbortError = the user cancelled; anything else falls back to download.
      if (err instanceof DOMException && err.name === "AbortError") return false;
    }
  }
  downloadTextFile(name, text);
  return true;
}

/** Browser-mode save: deliver the serialized document as a download. */
export function downloadTextFile(name: string, text: string): void {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = withCsxExtension(name);
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ---- memory images (UI_OVERHAUL §11) ----

const HEX_FILTERS = [{ name: "Memory image", extensions: ["hex", "txt", "dat"] }];

export interface PickedHexFile {
  /** Real path (Tauri) or null (browser — paths are not exposed). */
  path: string | null;
  name: string;
  text: string;
}

/**
 * Pick a `.hex` memory image (rle-hex-v1). Tauri returns a REAL path, so the
 * memory can `autoload` from it (resolved next to the circuit file); the
 * browser reads the image and the caller embeds it as `contents` instead.
 * Null on cancel.
 */
export async function pickHexFile(): Promise<PickedHexFile | null> {
  if (isTauri()) {
    const sel = await dialogOpen({ multiple: false, directory: false, filters: HEX_FILTERS });
    if (sel === null) return null;
    const text = await readTextFile(sel);
    return { path: sel, name: baseName(sel), text };
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".hex,.txt,.dat,text/plain";
    input.style.display = "none";
    document.body.appendChild(input);
    input.onchange = () => {
      const file = input.files?.[0];
      if (file === undefined) {
        input.remove();
        return resolve(null);
      }
      file.text().then(
        (text) => {
          input.remove();
          resolve({ path: null, name: file.name, text });
        },
        () => {
          input.remove();
          resolve(null);
        },
      );
    };
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    setTimeout(() => input.click(), 0);
  });
}

/**
 * Path of `target` relative to the directory of `circuitPath`, or null when
 * they are not on the same tree (the engine resolves autoloads relative to
 * the circuit file, sandboxed to its directory — DESIGN.md §11).
 */
export function relativeToCircuit(circuitPath: string, target: string): string | null {
  const norm = (p: string): string => p.replace(/\\/g, "/");
  const dir = norm(circuitPath).replace(/\/[^/]*$/, "");
  const t = norm(target);
  if (dir === "" || !t.toLowerCase().startsWith(`${dir.toLowerCase()}/`)) return null;
  return t.slice(dir.length + 1);
}
