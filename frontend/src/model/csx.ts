/**
 * TypeScript mirror of the `.csx` file format v4 (DESIGN.md §5.2). The
 * normative prose + JSON Schema is backend-owned (docs/format-v2.md, task
 * B2); the backend's canonical serializer and validator are authoritative —
 * saving goes through the `save_circuit` IPC command, never local JSON.
 * These types exist so the editor can hold, edit, and derive structure
 * from a document.
 *
 * Format rules that shape this model (DESIGN.md §5.2):
 *  - wires are edges: exactly two endpoints, at least one a pin; the other
 *    may be a junction onto a segment of another wire;
 *  - wire identity = index into the circuit's `wires` array (join targets
 *    are indices) — deletion cascades to junction dependents and survivors
 *    are renumbered;
 *  - nets are DERIVED (union-find), never stored (§5.1).
 */

export const CSX_FORMAT = "circuitsim-plus-plus";
/** Must equal `FORMAT_VERSION` in `crates/core/src/format/mod.rs`. */
export const CSX_VERSION = 4;

export interface CsxSettings {
  clockHz: number;
  /** Published delay table id, e.g. "cs2200-74ls-v1" (DESIGN.md §4.4). */
  delayTable: string;
}

export type Rotation = "N" | "E" | "S" | "W";

export interface CsxComponent {
  id: string;
  /** Pinned registry type string (docs/tasks/README.md §4): "gate.and", "mem.ram", … */
  type: string;
  /** Grid position [x, y]. */
  pos: [number, number];
  rot?: Rotation;
  /** Optional; REQUIRED on autograder-exposed parts (must be unique per circuit). */
  name?: string;
  /**
   * Cosmetic side for this part's name label (UI_OVERHAUL §28): one of
   * `N`/`E`/`S`/`W`. Absent = follow the app's "Default name position"
   * preference. The engine ignores it beyond round-tripping it
   * (docs/format-v2.md §2).
   */
  namePos?: Rotation;
  attrs?: Record<string, unknown>;
}

/** A wire endpoint on a component pin. */
export interface CsxPinEndpoint {
  comp: string;
  pin: string;
}

/** A wire endpoint junctioned onto a segment of another wire (renders as a dot). */
export interface CsxJoinEndpoint {
  join: { wire: number; segment: number };
}

export type CsxEndpoint = CsxPinEndpoint | CsxJoinEndpoint;

export interface CsxWire {
  a: CsxEndpoint;
  b: CsxEndpoint;
  /** Drawn path, INCLUDING both endpoint coordinates (first = a-side, last = b-side). */
  points: [number, number][];
  /**
   * Optional user-chosen stroke color (`#rrggbb`, UI_OVERHAUL §12). Absent =
   * the renderer's state/bus colors. Purely cosmetic: the engine ignores it
   * beyond round-tripping it (docs/format-v2.md §2).
   */
  color?: string;
  /**
   * Optional NAME: a labelled wire is a **tunnel** (UI_OVERHAUL §86) — the UI hides its
   * route while it is unselected and reveals it, dashed, on selection, with a straight
   * guide to each partner. The connection is still this wire's own geometry; the name
   * is a label, not a merging rule (docs/format-v2.md §9).
   */
  name?: string;
}

export interface CsxCircuit {
  name: string;
  components: CsxComponent[];
  wires: CsxWire[];
}

export interface CsxDocument {
  format: typeof CSX_FORMAT;
  version: typeof CSX_VERSION;
  name: string;
  settings: CsxSettings;
  circuits: CsxCircuit[];
}

export function isPinEndpoint(e: CsxEndpoint): e is CsxPinEndpoint {
  return "comp" in e;
}

/** Editor-side pin identity: "compId:pin". */
export function pinKey(comp: string, pin: string): string {
  return `${comp}:${pin}`;
}
