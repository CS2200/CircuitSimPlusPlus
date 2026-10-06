/**
 * Selection model (FRONTEND.md U2): which components/wires in the OPEN
 * circuit are selected. Selection is editor state — not serialized, not
 * undoable. `version` bumps on every change so React can subscribe cheaply.
 */
export class SelectionModel {
  readonly components = new Set<string>();
  readonly wires = new Set<number>();
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

  /** Replace the selection. */
  set(components: Iterable<string>, wires: Iterable<number>): void {
    this.components.clear();
    this.wires.clear();
    for (const id of components) this.components.add(id);
    for (const i of wires) this.wires.add(i);
    this._version++;
  }

  toggleComponent(id: string): void {
    if (!this.components.delete(id)) this.components.add(id);
    this._version++;
  }

  toggleWire(idx: number): void {
    if (!this.wires.delete(idx)) this.wires.add(idx);
    this._version++;
  }

  clear(): void {
    if (this.isEmpty) return;
    this.components.clear();
    this.wires.clear();
    this._version++;
  }
}
