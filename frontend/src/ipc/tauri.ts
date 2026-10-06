/**
 * Real-core adapter (FRONTEND.md U5): `CoreApi`/`CoreEvents` over the Tauri
 * IPC bridge — commands via `invoke`, events via `listen`, exactly the
 * contract in docs/ipc.md / README §3. `crates/app` exposes the matching
 * command/event names (delegating to `csim_core::api`).
 *
 * Selected by `getCore()` when `VITE_MOCK_CORE` is not "1". In a plain
 * browser (no Tauri runtime) `invoke` rejects — the dev workflow uses the
 * mock; this adapter is exercised by the packaged app and the joint smoke
 * test.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CoreApi } from "./types";
import type { CoreEvents, CoreEventHandler, CoreEventName, Unlisten } from "./events";
import type { CompId, LoadResult, SaveResult, SimMode, WireValue } from "./types";

class TauriEvents implements CoreEvents {
  on<E extends CoreEventName>(event: E, handler: CoreEventHandler<E>): Unlisten {
    let unlisten: Unlisten | null = null;
    // listen() resolves asynchronously; handlers installed slightly late is
    // fine because the engine cannot emit before a command is issued, and
    // every command follows subscription setup.
    void listen<Parameters<CoreEventHandler<E>>[0]>(event, (e) => handler(e.payload)).then((u) => {
      unlisten = u;
    });
    return () => {
      unlisten?.();
    };
  }
}

class TauriCore implements CoreApi {
  loadCircuit(src: { path?: string; bytes?: Uint8Array }): Promise<LoadResult> {
    return invoke("load_circuit", {
      path: src.path ?? null,
      bytes: src.bytes !== undefined ? Array.from(src.bytes) : null,
    });
  }

  saveCircuit(path: string, document: unknown): Promise<SaveResult> {
    return invoke("save_circuit", { path, document });
  }

  play(hz: number): Promise<void> {
    return invoke("sim_play", { hz });
  }

  pause(): Promise<void> {
    return invoke("sim_pause");
  }

  stepTick(): Promise<void> {
    return invoke("sim_step_tick");
  }

  stepCycles(n: number): Promise<void> {
    return invoke("sim_step_cycles", { n });
  }

  runUntil(cycle: number): Promise<void> {
    return invoke("sim_run_until", { cycle });
  }

  setMode(mode: SimMode): Promise<void> {
    return invoke("sim_set_mode", { mode });
  }

  poke(compId: CompId, pin: string, value: WireValue): Promise<void> {
    return invoke("poke", { compId, pin, value });
  }

  memRead(name: string, addr: number, len: number): Promise<WireValue[]> {
    return invoke("mem_read", { name, addr, len });
  }

  memWrite(name: string, addr: number, values: WireValue[]): Promise<void> {
    return invoke("mem_write", { name, addr, values });
  }

  snapshot(path: string): Promise<void> {
    return invoke("snapshot", { path });
  }

  resume(path: string): Promise<void> {
    return invoke("resume", { path });
  }
}

/** The real-core session: Tauri commands + Tauri events. */
export function createTauriCore(): { api: CoreApi; events: CoreEvents } {
  return { api: new TauriCore(), events: new TauriEvents() };
}
