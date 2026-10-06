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

const CSX_FILTERS = [{ name: "CircuitSim++ circuit", extensions: ["csx"] }];

/** True inside the Tauri webview (the plugins' bridge is present). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
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
  return sel === null ? null : withCsxExtension(sel);
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
