import type { Rect } from "./geom";

/**
 * Uniform-grid spatial hash (DESIGN.md §7.1: "a spatial index for
 * hit-testing"). Items are integer ids with caller-supplied AABBs; the same
 * id may cover multiple cells (and may be inserted under several boxes,
 * e.g. one id per wire segment — queries de-duplicate).
 *
 * Used for: viewport culling during draw, and coarse pick candidates for
 * hit-testing (precise geometry checks happen in the caller, e.g. with
 * `distToSegment`).
 */
export class UniformGrid {
  private readonly cells = new Map<string, Set<number>>();
  private readonly ids = new Set<number>();

  constructor(private readonly cellSize: number) {}

  get size(): number {
    return this.ids.size;
  }

  /** Insert id under every cell overlapping `r`. */
  insert(id: number, r: Rect): void {
    for (const key of this.cellKeys(r)) {
      let cell = this.cells.get(key);
      if (cell === undefined) {
        cell = new Set();
        this.cells.set(key, cell);
      }
      cell.add(id);
    }
    this.ids.add(id);
  }

  /** Remove id; `r` must be the same rect (or rects) it was inserted with. */
  remove(id: number, r: Rect): void {
    for (const key of this.cellKeys(r)) {
      const cell = this.cells.get(key);
      if (cell !== undefined) {
        cell.delete(id);
        if (cell.size === 0) this.cells.delete(key);
      }
    }
    this.ids.delete(id);
  }

  /** Move an item. */
  update(id: number, from: Rect, to: Rect): void {
    this.remove(id, from);
    this.insert(id, to);
  }

  /**
   * Ids with any cell overlapping `r`, in ascending id order (sorted so the
   * result never depends on insertion order).
   */
  queryRect(r: Rect): number[] {
    const found = new Set<number>();
    for (const key of this.cellKeys(r)) {
      const cell = this.cells.get(key);
      if (cell !== undefined) {
        for (const id of cell) found.add(id);
      }
    }
    return [...found].sort((a, b) => a - b);
  }

  clear(): void {
    this.cells.clear();
    this.ids.clear();
  }

  private *cellKeys(r: Rect): Generator<string> {
    const x0 = Math.floor(r.x / this.cellSize);
    const y0 = Math.floor(r.y / this.cellSize);
    const x1 = Math.floor((r.x + r.w) / this.cellSize);
    const y1 = Math.floor((r.y + r.h) / this.cellSize);
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        yield `${cx},${cy}`;
      }
    }
  }
}
