/**
 * Selection model (FRONTEND.md U2): which components/wires in the OPEN
 * circuit are selected. Selection is editor state — not serialized, not
 * undoable. `version` bumps on every change so React can subscribe cheaply.
 *
 * A selection can also be **narrowed to one drawn segment** of a wire
 * (UI_OVERHAUL §65): the second click on an already-selected wire means "just
 * this piece", so Delete takes the piece rather than everything. The wire stays
 * in `wires` alongside it, so the rest of the editor keeps working.
 */
export interface SegmentRef {
  /** Index of the wire the segment belongs to. */
  wire: number;
  /** Index of the segment within that wire's polyline. */
  seg: number;
}

export class SelectionModel {
  readonly components = new Set<string>();
  readonly wires = new Set<number>();
  /** The narrowed piece, if any (mutually inclusive with `wires`). */
  segment: SegmentRef | null = null;
  private _version = 0;

  get version(): number {
    return this._version;
  }

  get isEmpty(): boolean {
    return this.components.size === 0 && this.wires.size === 0;
  }

  get size(): number {
    return this.components.size + this.wires.size;
  }

  hasComponent(id: string): boolean {
    return this.components.has(id);
  }

  hasWire(idx: number): boolean {
    return this.wires.has(idx);
  }

  /** Replace the selection (and drop any narrowing). */
  set(components: Iterable<string>, wires: Iterable<number>): void {
    this.components.clear();
    this.wires.clear();
    for (const id of components) this.components.add(id);
    for (const i of wires) this.wires.add(i);
    this.segment = null;
    this._version++;
  }

  /** Narrow to one segment of one wire (§65) — our wire stays selected. */
  narrowToSegment(wire: number, seg: number): void {
    this.set([], [wire]);
    this.segment = { wire, seg };
    this._version++;
  }

  toggleComponent(id: string): void {
    if (!this.components.delete(id)) this.components.add(id);
    this.segment = null;
    this._version++;
  }

  toggleWire(idx: number): void {
    if (!this.wires.delete(idx)) this.wires.add(idx);
    this.segment = null;
    this._version++;
  }

  clear(): void {
    if (this.isEmpty && this.segment === null) return;
    this.components.clear();
    this.wires.clear();
    this.segment = null;
    this._version++;
  }
}
