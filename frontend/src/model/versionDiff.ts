/**
 * Structural diff between two documents (version history, UI_OVERHAUL §38).
 *
 * "What changed between the version I'm looking at and the document I have
 * open?" — answered by identity where identity survives a save: components by
 * `id`, wires by their endpoints + drawn path, circuits by name. With no
 * renames/rotations of identity in the format, this is exact for parts and
 * best-effort for wires (a wire re-routed in place reads as one removed + one
 * added, which is honest about what the file says).
 */

import type { CsxCircuit, CsxComponent, CsxWire } from "./csx";
import type { CircuitDocument } from "./document";

/** One field that differs, with both sides shown as short text. */
export interface FieldChange {
  field: string;
  from: string;
  to: string;
}

export interface PartChange {
  id: string;
  type: string;
  fields: FieldChange[];
}

export interface VersionDiff {
  /** Whole sheets present on only one side (by name). */
  sheetsAdded: string[];
  sheetsRemoved: string[];
  partsAdded: { id: string; type: string }[];
  partsRemoved: { id: string; type: string }[];
  changed: PartChange[];
  wiresAdded: number;
  wiresRemoved: number;
}

function isEmpty(diff: VersionDiff): boolean {
  return (
    diff.sheetsAdded.length === 0 &&
    diff.sheetsRemoved.length === 0 &&
    diff.partsAdded.length === 0 &&
    diff.partsRemoved.length === 0 &&
    diff.changed.length === 0 &&
    diff.wiresAdded === 0 &&
    diff.wiresRemoved === 0
  );
}

/** Short, single-line rendering of an attribute value. */
function short(value: unknown): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Every field that distinguishes a part, attrs flattened in. */
function partFields(comp: CsxComponent): Record<string, unknown> {
  return {
    type: comp.type,
    pos: comp.pos,
    rot: comp.rot ?? null,
    name: comp.name ?? null,
    namePos: comp.namePos ?? null,
    ...(comp.attrs ?? {}),
  };
}

function compareFields(before: CsxComponent, after: CsxComponent): FieldChange[] {
  const a = partFields(before);
  const b = partFields(after);
  const out: FieldChange[] = [];
  for (const field of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const from = short(a[field]);
    const to = short(b[field]);
    if (from !== to) out.push({ field, from, to });
  }
  return out;
}

/** Wire identity: both endpoints, the drawn path, and an explicit colour. */
function wireKey(wire: CsxWire): string {
  return JSON.stringify([wire.a, wire.b, wire.points, wire.color ?? null]);
}

function diffCircuit(prev: CsxCircuit, next: CsxCircuit, out: VersionDiff): void {
  const prevById = new Map(prev.components.map((c) => [c.id, c]));
  const nextById = new Map(next.components.map((c) => [c.id, c]));

  for (const [id, comp] of nextById) {
    if (!prevById.has(id)) out.partsAdded.push({ id, type: comp.type });
  }
  for (const [id, comp] of prevById) {
    if (!nextById.has(id)) out.partsRemoved.push({ id, type: comp.type });
  }
  for (const [id, before] of prevById) {
    const after = nextById.get(id);
    if (after === undefined) continue;
    const fields = compareFields(before, after);
    if (fields.length > 0) out.changed.push({ id, type: after.type, fields });
  }

  // Wires are a multiset: identical wires on both sides cancel out.
  const remaining = new Map<string, number>();
  for (const wire of prev.wires) {
    const key = wireKey(wire);
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  for (const wire of next.wires) {
    const key = wireKey(wire);
    const left = remaining.get(key) ?? 0;
    if (left > 0) remaining.set(key, left - 1);
    else out.wiresAdded++;
  }
  for (const left of remaining.values()) out.wiresRemoved += left;
}

/**
 * Changes that turn `current` into `version`: "added" means the version has it
 * and the open document does not.
 */
export function diffDocuments(current: CircuitDocument, version: CircuitDocument): VersionDiff {
  const out: VersionDiff = {
    sheetsAdded: [],
    sheetsRemoved: [],
    partsAdded: [],
    partsRemoved: [],
    changed: [],
    wiresAdded: 0,
    wiresRemoved: 0,
  };
  const currentByName = new Map(current.circuits.map((c) => [c.name, c]));
  const versionByName = new Map(version.circuits.map((c) => [c.name, c]));

  for (const name of versionByName.keys()) {
    if (!currentByName.has(name)) out.sheetsAdded.push(name);
  }
  for (const name of currentByName.keys()) {
    if (!versionByName.has(name)) out.sheetsRemoved.push(name);
  }
  for (const [name, before] of currentByName) {
    const after = versionByName.get(name);
    if (after !== undefined) diffCircuit(before, after, out);
  }
  return out;
}

/** One line for the drawer's change header. */
export function diffSummary(diff: VersionDiff): string {
  if (isEmpty(diff)) return "No differences from the open document";
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const bits: string[] = [];
  if (diff.partsAdded.length > 0) bits.push(`${plural(diff.partsAdded.length, "part")} added`);
  if (diff.partsRemoved.length > 0)
    bits.push(`${plural(diff.partsRemoved.length, "part")} removed`);
  if (diff.changed.length > 0) bits.push(`${plural(diff.changed.length, "part")} changed`);
  if (diff.wiresAdded > 0) bits.push(`${plural(diff.wiresAdded, "wire")} added`);
  if (diff.wiresRemoved > 0) bits.push(`${plural(diff.wiresRemoved, "wire")} removed`);
  if (diff.sheetsAdded.length > 0) bits.push(`sheet ${diff.sheetsAdded.join(", ")} added`);
  if (diff.sheetsRemoved.length > 0) bits.push(`sheet ${diff.sheetsRemoved.join(", ")} removed`);
  return bits.join(" · ");
}

/** One change, with the kind that colours it in the drawer (UI_OVERHAUL §76). */
export interface DiffEntry {
  kind: "added" | "changed" | "removed" | "note";
  text: string;
}

/**
 * The individual changes in drawing order, capped so a big rewrite cannot flood
 * the drawer. Pass `Infinity` for everything, uncapped, as copying does.
 */
export function diffEntries(diff: VersionDiff, limit = 8): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const part of diff.partsAdded)
    out.push({ kind: "added", text: `+ ${part.type} (${part.id})` });
  for (const part of diff.changed) {
    const fields = part.fields.map((f) => `${f.field} ${f.from} → ${f.to}`).join(", ");
    out.push({ kind: "changed", text: `~ ${part.type} (${part.id}): ${fields}` });
  }
  for (const part of diff.partsRemoved)
    out.push({ kind: "removed", text: `− ${part.type} (${part.id})` });
  if (out.length <= limit) {
    if (diff.wiresAdded > 0) out.push({ kind: "added", text: `+ ${diff.wiresAdded} wire(s)` });
    if (diff.wiresRemoved > 0)
      out.push({ kind: "removed", text: `− ${diff.wiresRemoved} wire(s)` });
    return out;
  }
  const kept = out.slice(0, limit);
  kept.push({ kind: "note", text: `…and ${out.length - limit} more` });
  if (diff.wiresAdded > 0) kept.push({ kind: "added", text: `+ ${diff.wiresAdded} wire(s)` });
  if (diff.wiresRemoved > 0) kept.push({ kind: "removed", text: `− ${diff.wiresRemoved} wire(s)` });
  return kept;
}

/** The individual changes as plain text, for tests and the drawer's list. */
export function diffLines(diff: VersionDiff, limit = 8): string[] {
  return diffEntries(diff, limit).map((entry) => entry.text);
}

/**
 * Part ids a version *adds or changes* — what a preview outlines on the canvas
 * (§76). Removals are the one thing a preview cannot mark, because the part is
 * not in that version at all; whole wires have no identity to outline either, so
 * both stay in the list.
 */
export function highlightIds(diff: VersionDiff): string[] {
  return [...diff.partsAdded.map((p) => p.id), ...diff.changed.map((p) => p.id)];
}

/** The whole diff as plain text (summary first), for the clipboard (§76). */
export function diffText(diff: VersionDiff): string {
  return [diffSummary(diff), ...diffLines(diff, Infinity)].join("\n");
}
