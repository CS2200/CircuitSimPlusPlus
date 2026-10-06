/**
 * Core selection seam (FRONTEND.md U9/U5).
 *
 * `getCore()` returns the backend the UI talks to:
 *  - `VITE_MOCK_CORE=1` → the in-process TypeScript mock (task U9, mock.ts)
 *  - otherwise          → the Tauri command adapter over csim-core (task U5)
 *
 * Consumers code against `CoreApi` (commands) and `CoreEvents` (events) only;
 * swapping implementations touches no consumer code.
 */

import type { CoreApi } from "./types";
import type { CoreEvents } from "./events";
import { mockCore } from "./mock";
import { createTauriCore } from "./tauri";

export interface Core {
  api: CoreApi;
  events: CoreEvents;
}

let tauriCore: Core | null = null;

export function getCore(): Core {
  if (import.meta.env.VITE_MOCK_CORE === "1") {
    return mockCore;
  }
  // Real core: Tauri command adapter over csim-core (task U5).
  tauriCore ??= createTauriCore();
  return tauriCore;
}
