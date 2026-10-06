import {
  CSX_FORMAT,
  CSX_VERSION,
  isPinEndpoint,
  type CsxCircuit,
  type CsxComponent,
  type CsxDocument,
  type CsxEndpoint,
  type CsxWire,
} from "./csx";
import { UndoHistory, type Command, type HistoryEvent } from "./history";

/**
 * The editor's circuit document (FRONTEND.md U2) — a mutable, undoable
 * holder of a `.csx` document.
 *
 * Invariants maintained by every op:
 *  - wire endpoints resolve: pins name existing components; joins name an
 *    existing wire and a valid segment (DESIGN.md §5.2);
 *  - every wire has at least one pin endpoint (no join–join wires);
 *  - deleting wires cascades to junction dependents, and survivors' join
 *    indices are renumbered (wire identity = array index);
 *  - component ids are unique per circuit;
 *  - entries are NEVER mutated in place — ops replace array entries, so
 *    history snapshots (shared by reference) stay valid. This is what
 *    makes undo both cheap and correct.
 */

/** Ops that produce a new document state are applied as snapshot commands. */
class SnapshotCmd implements Command {
  constructor(
    readonly label: string,
    readonly coalesceKey: string | undefined,
    private readonly before: CsxCircuit[],
    private after: CsxCircuit[], // mutable: drag coalescing advances it
  ) {}

  apply(doc: CircuitDocument): void {
    doc.replaceCircuits(this.after);
  }

  revert(doc: CircuitDocument): void {
    doc.replaceCircuits(this.before);
  }

  mergeWith(next: Command): void {
    this.after = (next as SnapshotCmd).after;
  }
}

export interface ComponentInit {
  type: string;
  pos: [number, number];
  rot?: CsxComponent["rot"];
  name?: string;
  attrs?: Record<string, unknown>;
}

export interface WireInit {
  a: CsxEndpoint;
  b: CsxEndpoint;
  points: [number, number][];
}

export class CircuitDocument {
  private readonly history = new UndoHistory();
  private _dirty = false;
  private _revision = 0;

  private constructor(readonly data: CsxDocument) {
    this.history.onEvent = (e) => this.onHistoryEvent?.(e);
  }

  /** Coarse edit-event stream — the post-MVP provenance journal hook (DESIGN.md §10). */
  onHistoryEvent?: (e: HistoryEvent) => void;

  /**
   * Editor-injected pin knowledge: given a component, return its current
   * pin names. The model treats pin names as opaque (Backend owns
   * semantics); the editor layer sets this so `updateComponent` can prune
   * wires whose pins disappear after a type/attr change.
   */
  pinResolver?: (comp: CsxComponent) => string[];

  static create(name = "untitled"): CircuitDocument {
    return new CircuitDocument({
      format: CSX_FORMAT,
      version: CSX_VERSION,
      name,
      settings: { delayModel: "delay", clockHz: 1, delayTable: "cs2200-74ls-v1" },
      circuits: [{ name: "main", components: [], wires: [] }],
    });
  }

  /** Wrap existing data WITHOUT validating structure (backend validation is authoritative). */
  static fromData(data: CsxDocument): CircuitDocument {
    return new CircuitDocument(data);
  }

  static fromJson(text: string): CircuitDocument {
    const data = JSON.parse(text) as CsxDocument;
    if (data.format !== CSX_FORMAT) {
      throw new Error(`not a CircuitSim++ file (format=${JSON.stringify(data.format)})`);
    }
    if (data.version !== CSX_VERSION) {
      throw new Error(`unsupported .csx version ${JSON.stringify(data.version)}`);
    }
    if (!Array.isArray(data.circuits)) {
      throw new Error("malformed .csx: circuits is not an array");
    }
    return new CircuitDocument(data);
  }

  /** Test/debug serialization; saving goes through the backend's canonical serializer. */
  toJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  get name(): string {
    return this.data.name;
  }

  get revision(): number {
    return this._revision;
  }

  get dirty(): boolean {
    return this._dirty;
  }

  /** Called after a successful save. */
  markClean(): void {
    this._dirty = false;
  }

  get canUndo(): boolean {
    return this.history.canUndo;
  }

  get canRedo(): boolean {
    return this.history.canRedo;
  }

  get historyDepth(): number {
    return this.history.depth;
  }

  peekUndoLabel(): string | null {
    return this.history.peekUndoLabel();
  }

  peekRedoLabel(): string | null {
    return this.history.peekRedoLabel();
  }

  undo(): boolean {
    const ok = this.history.undo(this);
    if (ok) this.touch();
    return ok;
  }

  redo(): boolean {
    const ok = this.history.redo(this);
    if (ok) this.touch();
    return ok;
  }

  // ---- circuit access ----

  get circuits(): readonly CsxCircuit[] {
    return this.data.circuits;
  }

  circuit(idx: number): CsxCircuit {
    const c = this.data.circuits[idx];
    if (c === undefined) {
      throw new RangeError(`no circuit at index ${idx} (have ${this.data.circuits.length})`);
    }
    return c;
  }

  circuitIdxByName(name: string): number {
    return this.data.circuits.findIndex((c) => c.name === name);
  }

  // ---- ops (each is one undoable command) ----

  addCircuit(name: string): number {
    this.assertCircuitNameFree(name);
    this.exec(`add circuit "${name}"`, undefined, [
      ...this.data.circuits,
      { name, components: [], wires: [] },
    ]);
    return this.data.circuits.length - 1;
  }

  renameCircuit(idx: number, name: string): void {
    const c = this.circuit(idx);
    if (c.name === name) return;
    this.assertCircuitNameFree(name);
    this.exec(`rename circuit to "${name}"`, undefined, this.replaceCircuit(idx, { ...c, name }));
  }

  /** Place a component; returns its allocated id. */
  addComponent(circuitIdx: number, init: ComponentInit): string {
    const c = this.circuit(circuitIdx);
    const id = allocComponentId(c);
    const comp: CsxComponent = {
      id,
      type: init.type,
      pos: init.pos,
      ...(init.rot !== undefined && { rot: init.rot }),
      ...(init.name !== undefined && { name: init.name }),
      ...(init.attrs !== undefined && { attrs: init.attrs }),
    };
    this.exec(
      `place ${init.type}`,
      undefined,
      this.replaceCircuit(circuitIdx, {
        ...c,
        components: [...c.components, comp],
      }),
    );
    return id;
  }

  /**
   * Drag a component by `delta`: its pos moves and the ENDPOINT-ADJACENT
   * points of wires glued to its pins translate with it (wires stay
   * attached — endpoints reference pins by id, and the polyline's first/
   * last point tracks the pin). Consecutive moves of the same component
   * coalesce into one undo step (one drag = one undo).
   */
  moveComponent(circuitIdx: number, id: string, delta: { x: number; y: number }): void {
    this.moveComponents(circuitIdx, new Set([id]), delta);
  }

  /**
   * Drag a SET of components as ONE undoable command (multi-select drag).
   * Consecutive moves of the same set coalesce (one drag = one undo).
   */
  moveComponents(
    circuitIdx: number,
    ids: ReadonlySet<string>,
    delta: { x: number; y: number },
  ): void {
    if (ids.size === 0 || (delta.x === 0 && delta.y === 0)) return;
    const c = this.circuit(circuitIdx);
    for (const id of ids) {
      if (!c.components.some((x) => x.id === id)) {
        throw new Error(`no component "${id}" in circuit "${c.name}"`);
      }
    }
    const components = c.components.map((x) =>
      ids.has(x.id)
        ? { ...x, pos: [x.pos[0] + delta.x, x.pos[1] + delta.y] as [number, number] }
        : x,
    );
    const wires = c.wires.map((w) => {
      const glueA = isPinEndpoint(w.a) && ids.has(w.a.comp);
      const glueB = isPinEndpoint(w.b) && ids.has(w.b.comp);
      if (!glueA && !glueB) return w;
      const points = w.points.map((p, i) => {
        const glued = (i === 0 && glueA) || (i === w.points.length - 1 && glueB);
        return glued ? ([p[0] + delta.x, p[1] + delta.y] as [number, number]) : p;
      });
      return { ...w, points };
    });
    const key = `move:${circuitIdx}:${[...ids].sort().join(",")}`;
    const label = ids.size === 1 ? `move ${[...ids][0]}` : `move ${ids.size} components`;
    this.exec(label, key, this.replaceCircuit(circuitIdx, { ...c, components, wires }));
  }

  /** Cycle rotation (E→S→W→N) for a set of components as one command. */
  rotateComponents(circuitIdx: number, ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    const c = this.circuit(circuitIdx);
    const components = c.components.map((x) => (ids.has(x.id) ? { ...x, rot: nextRot(x.rot) } : x));
    const label = ids.size === 1 ? `rotate ${[...ids][0]}` : `rotate ${ids.size} components`;
    this.exec(label, undefined, this.replaceCircuit(circuitIdx, { ...c, components }));
  }

  /** Delete a selection (components + their wires + selected wires) as ONE command. */
  deleteSelection(
    circuitIdx: number,
    compIds: ReadonlySet<string>,
    wireIdxs: ReadonlySet<number>,
  ): void {
    if (compIds.size === 0 && wireIdxs.size === 0) return;
    const c = this.circuit(circuitIdx);
    const components = c.components.filter((x) => !compIds.has(x.id));
    const roots = new Set(wireIdxs);
    c.wires.forEach((w, i) => {
      const onA = isPinEndpoint(w.a) && compIds.has(w.a.comp);
      const onB = isPinEndpoint(w.b) && compIds.has(w.b.comp);
      if (onA || onB) roots.add(i);
    });
    const wires = removeWiresCascade(c.wires, roots);
    const n = compIds.size + wireIdxs.size;
    this.exec(
      `delete ${n} item${n === 1 ? "" : "s"}`,
      undefined,
      this.replaceCircuit(circuitIdx, {
        ...c,
        components,
        wires,
      }),
    );
  }

  /**
   * Paste a clipboard (components + wires) with an offset: fresh ids are
   * allocated, pin references remapped, geometry translated. Returns the
   * new component ids (for selecting the paste). Junction targets must be
   * remapped already (see copySelection) — a dangling join is dropped.
   */
  paste(
    circuitIdx: number,
    components: CsxComponent[],
    wires: CsxWire[],
    offset: { x: number; y: number },
  ): string[] {
    const c = this.circuit(circuitIdx);
    const idMap = new Map<string, string>();
    const newComps: CsxComponent[] = [];
    let scratch = { ...c, components: [...c.components] };
    for (const comp of components) {
      const id = allocComponentId(scratch);
      scratch = { ...scratch, components: [...scratch.components, { ...comp, id }] };
      idMap.set(comp.id, id);
      newComps.push({ ...comp, id });
    }
    const moved: CsxComponent[] = newComps.map((x) => ({
      ...x,
      pos: [x.pos[0] + offset.x, x.pos[1] + offset.y] as [number, number],
    }));
    const newWires: CsxWire[] = [];
    for (const w of wires) {
      const a = remapPasteEndpoint(w.a, idMap);
      const b = remapPasteEndpoint(w.b, idMap);
      if (a === null || b === null) continue; // endpoint outside the paste → drop
      newWires.push({
        a,
        b,
        points: w.points.map((p) => [p[0] + offset.x, p[1] + offset.y] as [number, number]),
      });
    }
    this.exec(
      `paste ${components.length} components`,
      undefined,
      this.replaceCircuit(circuitIdx, {
        ...c,
        components: [...c.components, ...moved],
        wires: [...c.wires, ...newWires],
      }),
    );
    return moved.map((x) => x.id);
  }

  /**
   * Edit a component's type/rotation/name/attrs as one undoable command.
   * If the edit removes pins (e.g. fewer gate inputs, type swap), wires
   * referencing the vanished pins are removed too (with junction cascade)
   * — requires `pinResolver` to be set (editor layer); without it, wires
   * are left untouched.
   */
  updateComponent(
    circuitIdx: number,
    id: string,
    patch: {
      type?: string;
      rot?: CsxComponent["rot"];
      name?: string;
      attrs?: Record<string, unknown>;
    },
  ): void {
    const c = this.circuit(circuitIdx);
    const comp = c.components.find((x) => x.id === id);
    if (comp === undefined) throw new Error(`no component "${id}" in circuit "${c.name}"`);
    const updated: CsxComponent = {
      ...comp,
      ...(patch.type !== undefined && { type: patch.type }),
      ...(patch.rot !== undefined && { rot: patch.rot }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.attrs !== undefined && { attrs: patch.attrs }),
    };
    const components = c.components.map((x) => (x.id === id ? updated : x));

    let wires = c.wires;
    if (this.pinResolver !== undefined) {
      const pins = new Set(this.pinResolver(updated));
      const dangling = new Set<number>();
      wires.forEach((w, i) => {
        for (const e of [w.a, w.b]) {
          if (isPinEndpoint(e) && e.comp === id && !pins.has(e.pin)) {
            dangling.add(i);
            break;
          }
        }
      });
      if (dangling.size > 0) wires = removeWiresCascade(wires, dangling);
    }
    this.exec(
      `edit ${id}`,
      undefined,
      this.replaceCircuit(circuitIdx, { ...c, components, wires }),
    );
  }

  /** Delete components and every wire touching them (with junction cascades). */
  removeComponents(circuitIdx: number, ids: ReadonlySet<string>): void {
    const c = this.circuit(circuitIdx);
    if (ids.size === 0) return;
    const components = c.components.filter((x) => !ids.has(x.id));
    if (components.length === c.components.length) return; // nothing to delete
    const attached = new Set<number>();
    c.wires.forEach((w, i) => {
      const onA = isPinEndpoint(w.a) && ids.has(w.a.comp);
      const onB = isPinEndpoint(w.b) && ids.has(w.b.comp);
      if (onA || onB) attached.add(i);
    });
    const wires = removeWiresCascade(c.wires, attached);
    const label = ids.size === 1 ? `delete ${[...ids][0]}` : `delete ${ids.size} components`;
    this.exec(label, undefined, this.replaceCircuit(circuitIdx, { ...c, components, wires }));
  }

  /** Add a wire; returns its index. Throws on any invariant violation. */
  addWire(circuitIdx: number, w: WireInit): number {
    const c = this.circuit(circuitIdx);
    validateWire(c, w);
    this.exec(
      "add wire",
      undefined,
      this.replaceCircuit(circuitIdx, {
        ...c,
        wires: [...c.wires, w],
      }),
    );
    return c.wires.length;
  }

  /** Replace a wire's polyline (bend drags in U3; consecutive edits coalesce). */
  updateWirePoints(circuitIdx: number, wireIdx: number, points: [number, number][]): void {
    const c = this.circuit(circuitIdx);
    const w = c.wires[wireIdx];
    if (w === undefined) throw new RangeError(`no wire at index ${wireIdx}`);
    if (points.length < 2) throw new Error("a wire needs at least 2 points");
    const wires = c.wires.map((x, i) => (i === wireIdx ? { ...x, points } : x));
    this.exec(
      "edit wire route",
      `points:${circuitIdx}:${wireIdx}`,
      this.replaceCircuit(circuitIdx, {
        ...c,
        wires,
      }),
    );
  }

  /** Delete wires; junction dependents cascade (DESIGN.md §5.2 "delete branch"). */
  removeWires(circuitIdx: number, indices: ReadonlySet<number>): void {
    const c = this.circuit(circuitIdx);
    if (indices.size === 0) return;
    const wires = removeWiresCascade(c.wires, indices);
    const label = indices.size === 1 ? "delete wire" : `delete ${indices.size} wires`;
    this.exec(label, undefined, this.replaceCircuit(circuitIdx, { ...c, wires }));
  }

  // ---- soft structural validation (editor-side; the backend's validator is authoritative) ----

  validateStructure(): string[] {
    const errors: string[] = [];
    for (const c of this.data.circuits) {
      const ids = new Set<string>();
      for (const comp of c.components) {
        if (ids.has(comp.id)) errors.push(`${c.name}: duplicate component id "${comp.id}"`);
        ids.add(comp.id);
      }
      const names = new Set<string>();
      for (const comp of c.components) {
        if (comp.name !== undefined && comp.name !== "") {
          if (names.has(comp.name)) errors.push(`${c.name}: duplicate name "${comp.name}"`);
          names.add(comp.name);
        }
      }
      c.wires.forEach((w, i) => {
        for (const e of [w.a, w.b]) {
          if (isPinEndpoint(e)) {
            if (!c.components.some((x) => x.id === e.comp)) {
              errors.push(`${c.name}: wire ${i} references missing component "${e.comp}"`);
            }
          } else if (e.join.wire < 0 || e.join.wire >= c.wires.length) {
            errors.push(`${c.name}: wire ${i} junctions onto missing wire ${e.join.wire}`);
          } else if (
            e.join.segment < 0 ||
            e.join.segment >= c.wires[e.join.wire].points.length - 1
          ) {
            errors.push(
              `${c.name}: wire ${i} junctions onto invalid segment of wire ${e.join.wire}`,
            );
          }
        }
        if (!isPinEndpoint(w.a) && !isPinEndpoint(w.b)) {
          errors.push(`${c.name}: wire ${i} has no pin endpoint (join–join wires are invalid)`);
        }
      });
    }
    return errors;
  }

  // ---- internals (history commands use these; not for general consumers) ----

  /** @internal */
  replaceCircuits(next: CsxCircuit[]): void {
    this.data.circuits = next;
  }

  private replaceCircuit(idx: number, next: CsxCircuit): CsxCircuit[] {
    return this.data.circuits.map((c, i) => (i === idx ? next : c));
  }

  private exec(label: string, coalesceKey: string | undefined, next: CsxCircuit[]): void {
    this.history.execute(this, new SnapshotCmd(label, coalesceKey, this.data.circuits, next));
    this.touch();
  }

  private touch(): void {
    this._dirty = true;
    this._revision++;
  }

  private assertCircuitNameFree(name: string): void {
    if (this.data.circuits.some((c) => c.name === name)) {
      throw new Error(`a circuit named "${name}" already exists`);
    }
  }
}

// ---- pure structural helpers (exported for tests) ----

/** Allocate the next unique component id within a circuit: c1, c2, … */
export function allocComponentId(c: CsxCircuit): string {
  let max = 0;
  for (const comp of c.components) {
    const m = /^c(\d+)$/.exec(comp.id);
    if (m !== null) max = Math.max(max, Number(m[1]));
  }
  let id = `c${max + 1}`;
  while (c.components.some((x) => x.id === id)) id = `c${++max + 1}`;
  return id;
}

/** Wire op validation per DESIGN.md §5.2. Throws Error with a precise message. */
export function validateWire(c: CsxCircuit, w: WireInit): void {
  if (w.points.length < 2) throw new Error("a wire needs at least 2 points");
  if (!isPinEndpoint(w.a) && !isPinEndpoint(w.b)) {
    throw new Error("a wire needs at least one pin endpoint (join–join wires are invalid)");
  }
  for (const e of [w.a, w.b]) {
    if (isPinEndpoint(e)) {
      if (!c.components.some((x) => x.id === e.comp)) {
        throw new Error(`wire endpoint references missing component "${e.comp}"`);
      }
    } else {
      if (e.join.wire < 0 || e.join.wire >= c.wires.length) {
        throw new Error(`wire junctions onto missing wire ${e.join.wire}`);
      }
      const parent = c.wires[e.join.wire];
      if (e.join.segment < 0 || e.join.segment >= parent.points.length - 1) {
        throw new Error(
          `wire junctions onto segment ${e.join.segment} of wire ${e.join.wire}, ` +
            `which has ${parent.points.length - 1} segment(s)`,
        );
      }
    }
  }
  if (isPinEndpoint(w.a) && isPinEndpoint(w.b) && w.a.comp === w.b.comp && w.a.pin === w.b.pin) {
    throw new Error(`wire loops from ${w.a.comp}.${w.a.pin} back to itself`);
  }
}

/**
 * Remove wires by index, cascading to junction dependents (recursively) and
 * renumbering survivors' join targets. Pure: returns a new array; entries
 * not affected are shared by reference.
 */
export function removeWiresCascade(wires: CsxWire[], roots: ReadonlySet<number>): CsxWire[] {
  const removed = new Set(roots);
  let grew = true;
  while (grew) {
    grew = false;
    wires.forEach((w, i) => {
      if (removed.has(i)) return;
      for (const e of [w.a, w.b]) {
        if (!isPinEndpoint(e) && removed.has(e.join.wire)) {
          removed.add(i);
          grew = true;
          break;
        }
      }
    });
  }
  const remap = new Map<number, number>();
  let n = 0;
  wires.forEach((_, i) => {
    if (!removed.has(i)) remap.set(i, n++);
  });
  const out: CsxWire[] = [];
  wires.forEach((w, i) => {
    if (removed.has(i)) return;
    out.push({ ...w, a: remapJoin(w.a, remap), b: remapJoin(w.b, remap) });
  });
  return out;
}

function remapJoin(e: CsxEndpoint, remap: ReadonlyMap<number, number>): CsxEndpoint {
  if (isPinEndpoint(e)) return e;
  const wire = remap.get(e.join.wire);
  if (wire === undefined) {
    // Invariant violation — the closure should have removed this wire too.
    throw new Error(`internal: dangling junction onto wire ${e.join.wire} after cascade`);
  }
  return { join: { wire, segment: e.join.segment } };
}

/** Remap a pin endpoint's component id through the paste id map; null if outside the paste. */
function remapPasteEndpoint(
  e: CsxEndpoint,
  idMap: ReadonlyMap<string, string>,
): CsxEndpoint | null {
  if (isPinEndpoint(e)) {
    const comp = idMap.get(e.comp);
    return comp === undefined ? null : { comp, pin: e.pin };
  }
  return e; // junction targets were already remapped by copySelection
}

/** Rotation cycle E→S→W→N (mirrors editor/layout.nextRotation; kept local to stay schema-only). */
function nextRot(rot: CsxComponent["rot"]): CsxComponent["rot"] {
  switch (rot) {
    case undefined:
    case "E":
      return "S";
    case "S":
      return "W";
    case "W":
      return "N";
    case "N":
      return "E";
  }
}
