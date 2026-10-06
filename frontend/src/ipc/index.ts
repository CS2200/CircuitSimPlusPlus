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

export interface Core {
  api: CoreApi;
  events: CoreEvents;
}

export function getCore(): Core {
  if (import.meta.env.VITE_MOCK_CORE === "1") {
    return mockCore;
  }
  // TODO(U5): return the Tauri adapter (src/ipc/tauri.ts) here.
  throw new Error(
    "csim-core adapter is not implemented until task U5; run with VITE_MOCK_CORE=1 to use the mock core",
  );
}
