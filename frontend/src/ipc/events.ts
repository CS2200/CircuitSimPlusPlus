/**
 * Event-subscription seam for the IPC contract (docs/ipc.md §3).
 *
 * The pinned contract specifies *which* events exist and their payloads; how
 * the frontend subscribes is implementation-specific: the real adapter (task
 * U5) wraps Tauri's `listen()`, while the mock (task U9) dispatches
 * in-process. Both satisfy `CoreEvents`, so swapping implementations (see
 * `index.ts`) touches no consumer code.
 */

import type { NetDiffs, SimHalted, SimStatus, TimingUpdate } from "./types";
import { IpcEvents } from "./types";

/** Event name → payload, exactly the contract in docs/ipc.md §3. */
export interface CoreEventPayloads {
  [IpcEvents.NetDiffs]: NetDiffs;
  [IpcEvents.SimStatus]: SimStatus;
  [IpcEvents.SimHalted]: SimHalted;
  [IpcEvents.TimingUpdate]: TimingUpdate;
}

export type CoreEventName = keyof CoreEventPayloads;

export type CoreEventHandler<E extends CoreEventName> = (payload: CoreEventPayloads[E]) => void;

/** Mirrors Tauri's `unlisten` convention so adapters are drop-in compatible. */
export type Unlisten = () => void;

export interface CoreEvents {
  on<E extends CoreEventName>(event: E, handler: CoreEventHandler<E>): Unlisten;
}

/**
 * In-process dispatcher implementing `CoreEvents`. Used by the mock core and
 * available to unit tests. Dispatch is synchronous, in subscription order.
 */
export class CoreEventEmitter implements CoreEvents {
  private readonly handlers: { [E in CoreEventName]: Set<CoreEventHandler<E>> } = {
    [IpcEvents.NetDiffs]: new Set(),
    [IpcEvents.SimStatus]: new Set(),
    [IpcEvents.SimHalted]: new Set(),
    [IpcEvents.TimingUpdate]: new Set(),
  };

  on<E extends CoreEventName>(event: E, handler: CoreEventHandler<E>): Unlisten {
    const set = this.handlers[event] as Set<CoreEventHandler<E>>;
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** Mock/test side: dispatch an event to all current subscribers. */
  emit<E extends CoreEventName>(event: E, payload: CoreEventPayloads[E]): void {
    const set = this.handlers[event] as Set<CoreEventHandler<E>>;
    for (const handler of set) {
      handler(payload);
    }
  }
}
