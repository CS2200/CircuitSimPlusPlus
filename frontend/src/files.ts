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
import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "./lib/env";

const CSX_FILTERS = [{ name: "CircuitSim++ circuit", extensions: ["csx"] }];
const PNG_FILTERS = [{ name: "PNG image", extensions: ["png"] }];

export { isTauri };

/**
 * Size + mtime of an on-disk file (Tauri only; `null` when absent or outside
 * the shell). The autosave guard uses this to notice edits another program
 * made underneath us.
 */
export async function statFile(path: string): Promise<{ mtime_ms: number; size: number } | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<{ mtime_ms: number; size: number } | null>("file_stat", { path });
  } catch {
    return null;
  }
}

/** Read a file's text by path (Tauri only). Throws when unreadable. */
export function readFileText(path: string): Promise<string> {
  return readTextFile(path);
}

/**
 * Rename (or move) a circuit file in the shell, taking its version history with
 * it (§39). `to` is a full target path; the shell enforces the `.csx`
 * extension and refuses to clobber an existing file. Resolves to the path
 * actually written.
 */
export function renameCircuitFile(from: string, to: string): Promise<string> {
  return invoke<string>("rename_circuit_file", { from, to });
}

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

/**
 * A path the shell can actually write to: it carries a directory separator.
 * Windows answers with backslashes and POSIX with a slash — **both are real
 * paths**, while the bare file name the browser works with is not (§43).
 */
export function isRealFilePath(path: string | null): path is string {
  return path !== null && /[\\/]/.test(path);
}

/** `name` filed in the same directory as `path`, keeping its separator style. */
export function siblingPath(path: string, name: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut < 0 ? name : `${path.slice(0, cut + 1)}${name}`;
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

interface BrowserWritable {
  write: (data: string) => Promise<void>;
  close: () => Promise<void>;
}

interface BrowserFileHandle {
  createWritable: () => Promise<BrowserWritable>;
}

/**
 * The handle from the last browser save. Once a file exists, Ctrl+S writes to
 * it again instead of re-opening the picker (the browser has no path to save
 * to, so the handle stands in for one — §38).
 */
let savedHandle: BrowserFileHandle | null = null;

/** True when the browser can save straight to the last chosen file. */
export function hasSavedFileHandle(): boolean {
  return savedHandle !== null;
}

/** Forget the browser's file (New / Open adopt a different document). */
export function forgetSavedFileHandle(): void {
  savedHandle = null;
}

/**
 * Browser-mode save. With a file already chosen this writes straight to it;
 * otherwise it prefers the File System Access API (Chromium), which gives a
 * real Save-As dialog **and a cancel signal**, and falls back to a download
 * where that is unavailable (or under automation, where a native picker could
 * not be driven). Returns false when the user cancelled.
 */
export async function saveTextFile(
  name: string,
  text: string,
  { forcePicker = false }: { forcePicker?: boolean } = {},
): Promise<boolean> {
  const picker = (
    window as unknown as {
      showSaveFilePicker?: (opts: unknown) => Promise<BrowserFileHandle>;
    }
  ).showSaveFilePicker;
  const automated = typeof navigator !== "undefined" && navigator.webdriver === true;
  if (typeof picker === "function" && !automated) {
    if (!forcePicker && savedHandle !== null) {
      try {
        const writable = await savedHandle.createWritable();
        await writable.write(text);
        await writable.close();
        return true;
      } catch {
        // Permission lapsed, or the file moved: ask for a target again.
        savedHandle = null;
      }
    }
    try {
      const handle = await picker({
        suggestedName: withCsxExtension(name),
        types: [{ description: "CircuitSim++ circuit", accept: { "application/json": [".csx"] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      savedHandle = handle;
      return true;
    } catch (err) {
      // AbortError = the user cancelled; anything else falls back to download.
      if (err instanceof DOMException && err.name === "AbortError") return false;
    }
  }
  downloadTextFile(name, text);
  return true;
}

/**
 * Export the canvas (a `data:image/png;base64,…` URL) to the user: a real file
 * in the shell, a download in the browser. Returns false when the user cancels
 * the save dialog.
 */
export async function saveImageFile(name: string, dataUrl: string): Promise<boolean> {
  const fileName = `${name.replace(/\.png$/i, "")}.png`;
  if (!isTauri()) {
    const a = document.createElement("a");
    a.href = dataUrl;
    a.download = fileName;
    a.click();
    return true;
  }
  const sel = await dialogSave({ defaultPath: fileName, filters: PNG_FILTERS });
  const picked = typeof sel === "string" ? sel.trim() : "";
  if (picked === "") return false; // cancelled — never write a blank path
  const path = /\.png$/i.test(picked) ? picked : `${picked}.png`;
  await invoke("save_image", { path, dataUrl });
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
