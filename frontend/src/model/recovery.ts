/**
 * Crash-recovery store (autosave, phase 1).
 *
 * While a document is dirty we keep one rolling recovery copy of it, so an
 * unsaved edit survives a crash. In the Tauri build this goes through the
 * shell's `autosave_recover_*` commands — the webview deliberately has no
 * filesystem-write scope. In a plain browser (mock-core dev, e2e) the same
 * interface is backed by memory: the UI behaves identically, but nothing
 * persists across a reload there.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/env";

/** sessionStorage key for the browser/dev backend (one bucket, small data). */
const MEMORY_KEY = "csx.recovery.memory";

/** One recovery write (the whole document, plus dialog metadata). */
export interface RecoveryWrite {
  /** Real file path, or null when the document has never been saved. */
  path: string | null;
  /** Stable id for a document with no path yet (per app session). */
  docKey: string;
  name: string;
  /** Last edit label (undo label at flush time); display only. */
  label: string;
  /** Wall-clock ms since the epoch. */
  at: number;
  /** The document as `.csx` JSON. */
  document: unknown;
}

/** A stored recovery, as listed in the "Recover unsaved work" dialog. */
export interface RecoveryMeta {
  key: string;
  path: string | null;
  name: string;
  label: string;
  at_ms: number;
}

export interface RecoveryStore {
  /** Store (or replace) the copy for this document; returns its key. */
  write(entry: RecoveryWrite): Promise<string>;
  /** Every stored recovery, newest first. */
  list(): Promise<RecoveryMeta[]>;
  /** The stored `.csx` document text, or null. */
  read(key: string): Promise<string | null>;
  /** Remove one recovery; true when something was removed. */
  discard(key: string): Promise<boolean>;
}

/** Tauri: the shell owns the filesystem (see `crates/app/src/recovery.rs`). */
class TauriRecoveryStore implements RecoveryStore {
  write(entry: RecoveryWrite): Promise<string> {
    return invoke("autosave_recover_write", {
      path: entry.path,
      docKey: entry.docKey,
      name: entry.name,
      label: entry.label,
      atMs: entry.at,
      document: entry.document,
    });
  }

  list(): Promise<RecoveryMeta[]> {
    return invoke("autosave_recover_list");
  }

  read(key: string): Promise<string | null> {
    return invoke("autosave_recover_read", { key });
  }

  discard(key: string): Promise<boolean> {
    return invoke("autosave_recover_discard", { key });
  }
}

/**
 * Browser/dev: identical shape. Backed by `sessionStorage` when available, so
 * a reload in the same tab behaves like reopening the app (that is what makes
 * the recovery flow testable in the browser); otherwise it is process memory.
 * Nothing here is a substitute for the Tauri store.
 */
export class MemoryRecoveryStore implements RecoveryStore {
  private readonly entries = new Map<string, { meta: RecoveryMeta; text: string }>();

  constructor() {
    this.load();
  }

  async write(entry: RecoveryWrite): Promise<string> {
    const named = entry.path !== null && entry.path.trim() !== "";
    const key = named ? `f${entry.path!.toLowerCase()}` : `n${entry.docKey}`;
    this.entries.set(key, {
      meta: {
        key,
        path: entry.path,
        name: entry.name,
        label: entry.label,
        at_ms: entry.at,
      },
      text: JSON.stringify(entry.document),
    });
    this.persist();
    return key;
  }

  async list(): Promise<RecoveryMeta[]> {
    return [...this.entries.values()].map((e) => e.meta).sort((a, b) => b.at_ms - a.at_ms);
  }

  async read(key: string): Promise<string | null> {
    return this.entries.get(key)?.text ?? null;
  }

  async discard(key: string): Promise<boolean> {
    const removed = this.entries.delete(key);
    this.persist();
    return removed;
  }

  private load(): void {
    try {
      const raw = sessionStorage.getItem(MEMORY_KEY);
      if (raw === null) return;
      for (const e of JSON.parse(raw) as { meta: RecoveryMeta; text: string }[]) {
        this.entries.set(e.meta.key, e);
      }
    } catch {
      /* no sessionStorage (node/test) or unreadable — start empty */
    }
  }

  private persist(): void {
    try {
      sessionStorage.setItem(MEMORY_KEY, JSON.stringify([...this.entries.values()]));
    } catch {
      /* quota or absent — the in-memory copy still works */
    }
  }
}

let store: RecoveryStore | null = null;

/** The active store (Tauri filesystem, or memory in the browser). */
export function recoveryStore(): RecoveryStore {
  store ??= isTauri() ? new TauriRecoveryStore() : new MemoryRecoveryStore();
  return store;
}

/** Test seam: inject a store (unit tests / e2e). */
export function setRecoveryStore(next: RecoveryStore | null): void {
  store = next;
}

/** A per-session id for documents that have never been saved to a path. */
export function newDocKey(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  if (c?.randomUUID !== undefined) return c.randomUUID();
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
