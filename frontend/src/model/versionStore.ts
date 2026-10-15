/**
 * Version history store (autosave phase 2).
 *
 * One rolling history per document, keyed the same way as the recovery store
 * (path hash, or a per-session id before the first save). The Tauri build goes
 * through the shell's `history_*` commands — canonical text is produced
 * Rust-side, so a snapshot is byte-identical to a save and dedupes by content.
 * The browser/dev build mirrors the same rules in memory (sessionStorage-
 * backed) so the UI and e2e behave identically.
 */

import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/env";

/** sessionStorage key for the browser/dev backend. */
const MEMORY_KEY = "csx.history.memory";
/** Hard cap on automatic versions per document (named versions are never evicted). */
const KEEP_AUTO = 200;
/** Per-document byte budget for automatic versions. */
const BUDGET_BYTES = 25 * 1024 * 1024;

/**
 * Age tiers for automatic versions: `[maxAgeMs, minGapMs]`, mirroring
 * `history.rs` — a session keeps every step, old history thins out (§41).
 */
const TIERS: [number, number][] = [
  [60 * 60 * 1000, 0],
  [24 * 60 * 60 * 1000, 5 * 60 * 1000],
  [7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000],
  [Number.MAX_SAFE_INTEGER, 24 * 60 * 60 * 1000],
];

function tierGap(ageMs: number): number {
  for (const [maxAge, gap] of TIERS) {
    if (ageMs < maxAge) return gap;
  }
  return 0;
}

export interface VersionMeta {
  id: string;
  at_ms: number;
  label: string;
  /** Promoted by the user: exempt from retention. */
  named: boolean;
  /** Canonical text length. */
  bytes: number;
}

export interface SnapshotResult {
  id: string;
  /** Nothing changed since the previous version. */
  deduped: boolean;
  /** Folded into the previous (recent, automatic) version. */
  coalesced: boolean;
}

export interface HistoryUsage {
  bytes: number;
  documents: number;
}

/** What a history belongs to. */
export interface HistoryTarget {
  /** Real file path (Tauri) or null before the first save. */
  path: string | null;
  /** Per-session id used while the document has no path. */
  docKey: string;
}

export interface HistoryStore {
  /**
   * Record `document` as the newest version. `coalesceMs > 0` folds the write
   * into a recent automatic version (a burst of autosaves becomes one entry).
   */
  snapshot(
    target: HistoryTarget,
    document: unknown,
    label: string,
    at: number,
    coalesceMs: number,
  ): Promise<SnapshotResult>;
  /** Every version, newest first. */
  list(target: HistoryTarget): Promise<VersionMeta[]>;
  /** The canonical `.csx` text of one version. */
  read(target: HistoryTarget, id: string): Promise<string | null>;
  /** Promote a version to "named" with a label. */
  name(target: HistoryTarget, id: string, label: string): Promise<boolean>;
  /** Delete one version. */
  remove(target: HistoryTarget, id: string): Promise<boolean>;
  /** Drop this document's whole history. */
  clear(target: HistoryTarget): Promise<boolean>;
  /** Total footprint, for Settings. */
  usage(): Promise<HistoryUsage>;
}

class TauriHistoryStore implements HistoryStore {
  snapshot(
    target: HistoryTarget,
    document: unknown,
    label: string,
    at: number,
    coalesceMs: number,
  ): Promise<SnapshotResult> {
    return invoke("history_snapshot", {
      path: target.path,
      docKey: target.docKey,
      document,
      label,
      atMs: at,
      coalesceMs,
    });
  }

  list(target: HistoryTarget): Promise<VersionMeta[]> {
    return invoke("history_list", { path: target.path, docKey: target.docKey });
  }

  read(target: HistoryTarget, id: string): Promise<string | null> {
    return invoke("history_read", { path: target.path, docKey: target.docKey, id });
  }

  name(target: HistoryTarget, id: string, label: string): Promise<boolean> {
    return invoke("history_name", { path: target.path, docKey: target.docKey, id, label });
  }

  remove(target: HistoryTarget, id: string): Promise<boolean> {
    return invoke("history_delete", { path: target.path, docKey: target.docKey, id });
  }

  clear(target: HistoryTarget): Promise<boolean> {
    return invoke("history_clear", { path: target.path, docKey: target.docKey });
  }

  usage(): Promise<HistoryUsage> {
    return invoke("history_usage");
  }
}

interface MemVersion {
  meta: VersionMeta;
  /** Content digest (matches the Rust store's FNV-1a hex). */
  hash: string;
  text: string;
}

/** FNV-1a 64-bit hex — the same content digest the Rust store uses. */
function fnv1aHex(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** Browser/dev backend: the same rules as `crates/app/src/history.rs`. */
export class MemoryHistoryStore implements HistoryStore {
  private docs = new Map<string, { nextId: number; versions: MemVersion[] }>();

  constructor() {
    try {
      const raw = sessionStorage.getItem(MEMORY_KEY);
      if (raw === null) return;
      const parsed = JSON.parse(raw) as [string, { nextId: number; versions: MemVersion[] }][];
      for (const [key, doc] of parsed) this.docs.set(key, doc);
    } catch {
      /* no sessionStorage (test) or unreadable — start empty */
    }
  }

  async snapshot(
    target: HistoryTarget,
    document: unknown,
    label: string,
    at: number,
    coalesceMs: number,
  ): Promise<SnapshotResult> {
    const key = targetKey(target);
    const doc = this.docs.get(key) ?? { nextId: 0, versions: [] };
    const text = JSON.stringify(document);
    const hash = fnv1aHex(text);
    const head = doc.versions.at(-1);

    if (head !== undefined) {
      if (head.hash === hash && !head.meta.named) {
        return { id: head.meta.id, deduped: true, coalesced: false };
      }
      const recent = coalesceMs > 0 && !head.meta.named && at - head.meta.at_ms < coalesceMs;
      if (recent) {
        head.meta = { ...head.meta, at_ms: at, label, bytes: text.length };
        head.hash = hash;
        head.text = text;
        this.persist();
        return { id: head.meta.id, deduped: false, coalesced: true };
      }
    }

    const id = String(doc.nextId++);
    doc.versions.push({
      meta: { id, at_ms: at, label, named: false, bytes: text.length },
      hash,
      text,
    });
    this.prune(doc, at);
    this.docs.set(key, doc);
    this.persist();
    return { id, deduped: false, coalesced: false };
  }

  async list(target: HistoryTarget): Promise<VersionMeta[]> {
    const doc = this.docs.get(targetKey(target));
    if (doc === undefined) return [];
    return [...doc.versions].reverse().map((v) => v.meta);
  }

  async read(target: HistoryTarget, id: string): Promise<string | null> {
    return this.docs.get(targetKey(target))?.versions.find((v) => v.meta.id === id)?.text ?? null;
  }

  async name(target: HistoryTarget, id: string, label: string): Promise<boolean> {
    const version = this.docs.get(targetKey(target))?.versions.find((v) => v.meta.id === id);
    if (version === undefined) return false;
    version.meta = { ...version.meta, named: true, label };
    this.persist();
    return true;
  }

  async remove(target: HistoryTarget, id: string): Promise<boolean> {
    const doc = this.docs.get(targetKey(target));
    if (doc === undefined) return false;
    const before = doc.versions.length;
    doc.versions = doc.versions.filter((v) => v.meta.id !== id);
    this.persist();
    return doc.versions.length !== before;
  }

  async clear(target: HistoryTarget): Promise<boolean> {
    const removed = this.docs.delete(targetKey(target));
    this.persist();
    return removed;
  }

  async usage(): Promise<HistoryUsage> {
    let bytes = 0;
    for (const doc of this.docs.values()) {
      for (const version of doc.versions) bytes += version.text.length;
    }
    return { bytes, documents: this.docs.size };
  }

  /** Compress: thin automatic versions by age, then enforce the hard caps. */
  private prune(doc: { versions: MemVersion[] }, now: number): void {
    const kept: MemVersion[] = [];
    let lastAutoAt: number | null = null;
    for (const version of [...doc.versions].reverse()) {
      if (version.meta.named) {
        kept.push(version);
        continue;
      }
      const gap = tierGap(now - version.meta.at_ms);
      const keep = gap === 0 || lastAutoAt === null || lastAutoAt - version.meta.at_ms >= gap;
      if (keep) {
        lastAutoAt = version.meta.at_ms;
        kept.push(version);
      }
    }
    doc.versions = kept.reverse();

    const autos = (): MemVersion[] => doc.versions.filter((v) => !v.meta.named);
    const bytes = (): number => autos().reduce((n, v) => n + v.text.length, 0);
    while (autos().length > KEEP_AUTO || bytes() > BUDGET_BYTES) {
      const i = doc.versions.findIndex((v) => !v.meta.named);
      if (i < 0) break; // everything left is named — never evict those
      doc.versions.splice(i, 1);
    }
  }

  private persist(): void {
    try {
      sessionStorage.setItem(MEMORY_KEY, JSON.stringify([...this.docs.entries()]));
    } catch {
      /* quota/absent — memory-only is fine for dev */
    }
  }
}

/** The key a target maps to (mirrors `recovery::key_for`). */
function targetKey(target: HistoryTarget): string {
  const named = target.path !== null && target.path.trim() !== "";
  return named ? `f${target.path!.toLowerCase()}` : `n${target.docKey}`;
}

let store: HistoryStore | null = null;

/** The active store (Tauri filesystem, or memory in the browser). */
export function historyStore(): HistoryStore {
  store ??= isTauri() ? new TauriHistoryStore() : new MemoryHistoryStore();
  return store;
}

/** Test seam: inject a store (unit tests / e2e). */
export function setHistoryStore(next: HistoryStore | null): void {
  store = next;
}
