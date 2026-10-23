import {
  CSX_FORMAT,
  CSX_VERSION,
  isPinEndpoint,
  type CsxCircuit,
  type CsxComponent,
  type CsxDocument,
  type CsxEndpoint,
  type CsxWire,
  type Rotation,
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
  /** A tunnel label (UI_OVERHAUL §86). A name is a *label*, not a joining rule — the
   * connection is the wire (docs/format-v2.md §9). */
  name?: string;
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

  /**
   * Editor-injected pin geometry: world position + outward facing of a
   * named pin (editor/layout.compLayout). Set by the editor so rotation
   * can re-anchor glued wire ends and re-stub them along the new facing.
   * Without it, rotation leaves wire geometry untouched.
   */
  pinGeometry?: (
    comp: CsxComponent,
    pin: string,
  ) => { pos: [number, number]; facing: Rotation } | null;

  static create(name = "untitled"): CircuitDocument {
    return new CircuitDocument({
      format: CSX_FORMAT,
      version: CSX_VERSION,
      name,
      settings: { clockHz: 1, delayTable: "cs2200-74ls-v1" },
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
    migrate(data);
    if (data.version !== CSX_VERSION) {
      throw new Error(`unsupported .csx version ${JSON.stringify(data.version)}`);
    }
    if (!Array.isArray(data.circuits)) {
      throw new Error("malformed .csx: circuits is not an array");
    }
    migratePinTerminals(data);
    return new CircuitDocument(data);
  }

  /** Test/debug serialization; saving goes through the backend's canonical serializer. */
  toJson(): string {
    return JSON.stringify(this.data, null, 2);
  }

  get name(): string {
    return this.data.name;
  }

  /**
   * Rename the document (the `.csx` `name` field). The FILE's name comes from
   * its path; this keeps the two in step when naming a new document or saving
   * under a new name (§38). Marks the document dirty — the JSON changed.
   */
  rename(name: string): void {
    const clean = name.trim();
    if (clean === "" || clean === this.data.name) return;
    this.data.name = clean;
    this._dirty = true;
    this._revision++;
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

  /**
   * Mark the document unsaved without a structural change — used when an
   * imported/restored document must be protected by autosave and the
   * unsaved-changes prompt (e.g. restoring a crash-recovery copy).
   */
  markDirty(): void {
    this._dirty = true;
    this._revision++;
  }

  /** Drop undo/redo stacks (e.g. after loading a document from disk). */
  clearHistory(): void {
    this.history.clear();
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

  /**
   * Delete a circuit (a sheet). Guarded: the last circuit cannot be removed,
   * and a circuit still instantiated by a `subcircuit` component elsewhere is
   * refused — the reference would dangle (the engine would report it at
   * load). Undoable like every other op.
   */
  removeCircuit(idx: number): void {
    const c = this.circuit(idx);
    if (this.data.circuits.length <= 1) {
      throw new Error("a document needs at least one circuit");
    }
    const referenced = this.data.circuits.some((other) =>
      other.components.some((comp) => comp.type === "subcircuit" && comp.attrs?.circuit === c.name),
    );
    if (referenced) {
      throw new Error(`"${c.name}" is still instantiated — delete its instances first`);
    }
    this.exec(
      `delete circuit "${c.name}"`,
      undefined,
      this.data.circuits.filter((_, i) => i !== idx),
    );
  }

  /** Place a component; returns its allocated id. */
  addComponent(circuitIdx: number, init: ComponentInit, coalesceKey?: string): string {
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
      coalesceKey,
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
    const movedWires: number[] = [];
    const wiresMoved = c.wires.map((w, i) => {
      const glueA = isPinEndpoint(w.a) && ids.has(w.a.comp);
      const glueB = isPinEndpoint(w.b) && ids.has(w.b.comp);
      if (!glueA && !glueB) return w;
      movedWires.push(i);
      // Both ends are PINS of dragged parts: the wire is the same shape somewhere
      // else, so it translates WHOLE — interior bends included. Moving only the
      // endpoints turned a Z-route into a skew (UI_OVERHAUL §81).
      if (glueA && glueB) {
        return {
          ...w,
          points: w.points.map((p) => [p[0] + delta.x, p[1] + delta.y] as [number, number]),
        };
      }
      // Otherwise a JOINED end travels with the drag exactly as a pin end does: a
      // junction belongs to the cluster, so it must not stay behind. The
      // re-seating pass below then puts it back exactly on its parent's segment —
      // a no-op when the parent came along, a slide along the parent when it did
      // not. (A wire always has at least one pin end, so at most one end is a
      // join.)
      const joinA = !isPinEndpoint(w.a);
      const joinB = !isPinEndpoint(w.b);
      // The end segment's axis BEFORE the move: after translating the endpoint,
      // that segment may turn diagonal — repairEnd() slides the adjacent bend so
      // the wire keeps leaving the pin orthogonally ("routes stretch", never skew).
      const axisA = glueA ? segmentAxis(w.points[0], w.points[1]) : null;
      const axisB = glueB
        ? segmentAxis(w.points[w.points.length - 1], w.points[w.points.length - 2])
        : null;
      let points = w.points.map((p, i) => {
        const moving =
          (i === 0 && (glueA || joinA)) || (i === w.points.length - 1 && (glueB || joinB));
        return moving ? ([p[0] + delta.x, p[1] + delta.y] as [number, number]) : p;
      });
      if (glueA && !glueB) points = repairEnd(points, "a", axisA);
      if (glueB && !glueA) points = repairEnd(points, "b", axisB);
      return { ...w, points };
    });
    // Moved parents stretch their junction children's targets with them.
    let wires = wiresMoved;
    for (const i of movedWires) wires = reprojectJunctionDependents(wires, i);
    const key = `move:${circuitIdx}:${[...ids].sort().join(",")}`;
    const label = ids.size === 1 ? `move ${[...ids][0]}` : `move ${ids.size} components`;
    this.exec(label, key, this.replaceCircuit(circuitIdx, { ...c, components, wires }));
  }

  /** Cycle rotation for a set of components as one command (ccw = reverse). */
  rotateComponents(circuitIdx: number, ids: ReadonlySet<string>, ccw = false): void {
    if (ids.size === 0) return;
    this.applyRotation(circuitIdx, ids, ccw ? prevRot : nextRot, "rotate");
  }

  /**
   * Point a set of components at an ABSOLUTE facing (arrow keys, §22): the
   * arrow that matches the direction makes the part face that way, whatever it
   * faced before. No-op when they already face that way.
   */
  setRotation(circuitIdx: number, ids: ReadonlySet<string>, rot: CsxComponent["rot"]): void {
    if (ids.size === 0) return;
    const c = this.circuit(circuitIdx);
    const already = [...ids].every(
      (id) => (c.components.find((x) => x.id === id)?.rot ?? "E") === rot,
    );
    if (already) return;
    this.applyRotation(circuitIdx, ids, () => rot, `face ${rot ?? "E"}`);
  }

  /** Shared rotation op: remap each selected part's rotation, fix its wires. */
  private applyRotation(
    circuitIdx: number,
    ids: ReadonlySet<string>,
    map: (rot: CsxComponent["rot"]) => CsxComponent["rot"],
    verb: string,
  ): void {
    const c = this.circuit(circuitIdx);
    const components = c.components.map((x) => (ids.has(x.id) ? rotatedComponent(x, map) : x));
    // Pins rotate about the body center: wires glued to a rotated component
    // must follow (re-anchored + re-stubbed along the new facing).
    const byId = new Map(components.map((x) => [x.id, x]));
    const wires = this.followGeometry(c.wires, ids, byId);
    const label = ids.size === 1 ? `${verb} ${[...ids][0]}` : `${verb} ${ids.size} components`;
    this.exec(label, undefined, this.replaceCircuit(circuitIdx, { ...c, components, wires }));
  }

  /**
   * Re-attach every wire end glued to a pin of `ids`, against `byId`'s CURRENT
   * layout, then re-seat the junction children of any wire that actually moved.
   * Wraps the editor's `pinGeometry`; without it geometry stays untouched.
   *
   * Callers: rotation (pins swing about the body centre) and `updateComponent`
   * (an attrs edit can RESIZE a part — a constant's body grows to fit a wide
   * value, taking its edge-mounted `out` pin with it) and load (§56's healing
   * of a file whose wire ends were written against older symbol sizes).
   */
  private followGeometry(
    wires: CsxWire[],
    ids: ReadonlySet<string>,
    byId: ReadonlyMap<string, CsxComponent>,
  ): CsxWire[] {
    const geom = this.pinGeometry;
    if (geom === undefined) return wires;
    const moved: number[] = [];
    let next = wires.map((w, i) => {
      const followed = followWire(w, ids, byId, geom);
      if (!samePoints(followed.points, w.points)) moved.push(i);
      return followed;
    });
    for (const i of moved) next = reprojectJunctionDependents(next, i);
    return next;
  }

  /**
   * Resolve every pin end in every circuit against the CURRENT layout, and save
   * nothing: no undo entry, no dirty flag. A wire end that names a pin IS at
   * that pin (the model's own promise); a file can name a pin whose body has
   * since been sized differently — a hand-authored one, a converted one, or one
   * this app wrote before a symbol grew (§56). Nothing moves unless a point was
   * actually stale, so this is the identity on a file already in step.
   *
   * The editor calls it once per load, which is why it writes through
   * `replaceCircuits` rather than `exec`: the loaded document has no history yet
   * and must not read as unsaved.
   */
  normalizePinEnds(): void {
    if (this.pinGeometry === undefined) return;
    let changed = false;
    const circuits = this.data.circuits.map((c) => {
      const byId = new Map(c.components.map((x) => [x.id, x]));
      const wires = this.followGeometry(c.wires, new Set(byId.keys()), byId);
      if (!changed && !sameWireList(wires, c.wires)) changed = true;
      return wires === c.wires ? c : { ...c, wires };
    });
    if (changed) this.replaceCircuits(circuits);
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
   *
   * `coalesceKey` (optional): consecutive edits carrying the same key merge
   * into one undo step — the right-dock Inspector uses per-field keys so a
   * typing burst or a stepper spree undoes as one edit (UI_OVERHAUL §3.3).
   */
  updateComponent(
    circuitIdx: number,
    id: string,
    patch: {
      type?: string;
      rot?: CsxComponent["rot"];
      name?: string;
      /** `null` clears the override (the part follows the app default again). */
      namePos?: CsxComponent["namePos"] | null;
      attrs?: Record<string, unknown>;
    },
    coalesceKey?: string,
  ): void {
    const c = this.circuit(circuitIdx);
    const comp = c.components.find((x) => x.id === id);
    if (comp === undefined) throw new Error(`no component "${id}" in circuit "${c.name}"`);
    const updated: CsxComponent = {
      ...comp,
      ...(patch.type !== undefined && { type: patch.type }),
      ...(patch.rot !== undefined && { rot: patch.rot }),
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.namePos !== undefined && patch.namePos !== null && { namePos: patch.namePos }),
      ...(patch.attrs !== undefined && { attrs: patch.attrs }),
    };
    if (patch.namePos === null) delete updated.namePos;
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
    // An attrs edit can RESIZE the part, and a pin that sits on an edge rides
    // that edge (a constant's `out`): the wires glued to it follow (UI_OVERHAUL
    // §56), in this same undo step.
    wires = this.followGeometry(wires, new Set([id]), new Map([[id, updated]]));
    this.exec(
      `edit ${id}`,
      coalesceKey,
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
  addWire(circuitIdx: number, w: WireInit, coalesceKey?: string): number {
    const c = this.circuit(circuitIdx);
    validateWire(c, w);
    this.exec(
      "add wire",
      coalesceKey,
      this.replaceCircuit(circuitIdx, {
        ...c,
        wires: [...c.wires, w],
      }),
    );
    return c.wires.length;
  }

  /**
   * Replace a wire's polyline (bend/segment drags; consecutive edits of the
   * same wire coalesce into one undo step). Junction dependents follow:
   * their terminal points are re-projected onto the (clamped) target
   * segment and their end segments repaired — see
   * [`reprojectJunctionDependents`].
   */
  updateWirePoints(
    circuitIdx: number,
    wireIdx: number,
    points: [number, number][],
    label = "edit wire route",
    // `null` = its own undo step (the default key merges drag sequences).
    coalesceKey: string | null = `points:${circuitIdx}:${wireIdx}`,
  ): void {
    const c = this.circuit(circuitIdx);
    const w = c.wires[wireIdx];
    if (w === undefined) throw new RangeError(`no wire at index ${wireIdx}`);
    if (points.length < 2) throw new Error("a wire needs at least 2 points");
    let wires = c.wires.map((x, i) =>
      i === wireIdx ? { ...x, points: points.map((p) => [p[0], p[1]] as [number, number]) } : x,
    );
    wires = reprojectJunctionDependents(wires, wireIdx);
    this.exec(
      label,
      coalesceKey ?? undefined,
      this.replaceCircuit(circuitIdx, {
        ...c,
        wires,
      }),
    );
  }

  /**
   * Delete one drawn SEGMENT of a wire (UI_OVERHAUL §65, the two-click
   * narrowing): the leg goes and the wire takes a shortcut past the bend it
   * turned at. A wire *is* a connection — its endpoints are pin attachment
   * points — so they are never touched; only bends (interior points) can
   * disappear. A wire drawn without bends is nothing *but* that leg, so
   * deleting its segment deletes the wire (with the usual junction cascade).
   * Junction dependents follow via [`updateWirePoints`]'s re-projection.
   */
  removeSegment(circuitIdx: number, wireIdx: number, segment: number): void {
    const c = this.circuit(circuitIdx);
    const w = c.wires[wireIdx];
    if (w === undefined) return;
    const last = w.points.length - 1;
    if (last <= 1) {
      // Straight (or undrawn): there is no bend to drop.
      this.removeWires(circuitIdx, new Set([wireIdx]));
      return;
    }
    const seg = Math.max(0, Math.min(segment, last - 1));
    // Drop the bend this segment turns at: its far end, unless that is the
    // wire's endpoint — then its near end is the interior one.
    const drop = seg + 1 <= last - 1 ? seg + 1 : seg;
    const points = w.points
      .filter((_, i) => i !== drop)
      .map((p) => [p[0], p[1]] as [number, number]);
    // No coalescing: a delete is a discrete step, not a drag sequence.
    this.updateWirePoints(circuitIdx, wireIdx, points, "remove wire segment", null);
  }

  /**
   * Set (or clear, with `null`) a wire's cosmetic color (UI_OVERHAUL §12).
   * Cleared wires drop the key entirely so canonical files stay clean.
   * Consecutive edits of one wire coalesce into a single undo step.
   */
  setWireColor(circuitIdx: number, wireIdx: number, color: string | null): void {
    const c = this.circuit(circuitIdx);
    const w = c.wires[wireIdx];
    if (w === undefined) throw new RangeError(`no wire at index ${wireIdx}`);
    if ((w.color ?? null) === color) return;
    const wires = c.wires.map((x, i) => {
      if (i !== wireIdx) return x;
      const next: CsxWire = { ...x };
      if (color === null) delete next.color;
      else next.color = color;
      return next;
    });
    this.exec(
      color === null ? "clear wire color" : "wire color",
      `color:${circuitIdx}:${wireIdx}`,
      this.replaceCircuit(circuitIdx, { ...c, wires }),
    );
  }
  /**
   * Set (or clear, with `null`/`""`) a wire's NAME — the label that makes it a tunnel
   * (UI_OVERHAUL §86). Cleared wires drop the key entirely so canonical files stay
   * clean. Consecutive edits of one wire coalesce into a single undo step.
   */
  setWireName(circuitIdx: number, wireIdx: number, name: string | null): void {
    const c = this.circuit(circuitIdx);
    const w = c.wires[wireIdx];
    if (w === undefined) throw new RangeError(`no wire at index ${wireIdx}`);
    if ((w.name ?? null) === name) return;
    const wires = c.wires.map((x, i) => {
      if (i !== wireIdx) return x;
      const next: CsxWire = { ...x };
      if (name === null) delete next.name;
      else next.name = name;
      return next;
    });
    this.exec(
      name === null ? "clear wire name" : "name wire",
      `wirename:${circuitIdx}:${wireIdx}`,
      this.replaceCircuit(circuitIdx, { ...c, wires }),
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

/**
 * Load-time version migrations, mirroring the backend's `format::migrate`
 * (`crates/core/src/format/mod.rs`). Each step upgrades a document **one**
 * version and the steps run in order, so a file several versions behind is
 * walked forward — a v2 file also predates v3 and v5, so v2 → v3 → v5 is the
 * real path. v4 is skipped on purpose: it was the version that removed the
 * `rst` pin, and v5 has it back (§93), so nothing has to be dropped and a
 * v3/v4 file only gains the pin-visibility flags.
 */
function migrate(data: CsxDocument): void {
  let version = data.version as number;
  if (version === 2) {
    dropDelayModel(data);
    version = 3;
  }
  if (version >= 3 && version < 5) {
    revealWiredControlPins(data);
    version = CSX_VERSION;
  }
  if (version !== (data.version as number)) {
    data.version = version as typeof CSX_VERSION;
  }
}

/**
 * v2 → v3: `settings.delayModel` ("zero" | "delay") and the per-instance
 * `attrs.delay` override were dropped — the zero-delay engine was removed
 * (every file is delay-aware) and timing is unit-wide.
 */
function dropDelayModel(data: CsxDocument): void {
  const settings = data.settings as unknown as Record<string, unknown> | undefined;
  if (settings !== undefined) delete settings.delayModel;
  for (const c of data.circuits ?? []) {
    for (const comp of c.components ?? []) {
      if (comp.attrs !== undefined) delete comp.attrs.delay;
    }
  }
}

/**
 * v3/v4 → v5: `mem.register`/`mem.ram` carry `showClk`/`showRst` (UI_OVERHAUL
 * §93) — display-only flags for two pins that are always in the model. A part
 * whose clock or reset pin a **wire names** keeps that pin visible: the wiring is
 * the proof it is wanted, and it is how a schematic drawn before these flags
 * comes forward looking exactly as it did. Nothing is dropped.
 */
function revealWiredControlPins(data: CsxDocument): void {
  for (const c of data.circuits ?? []) {
    const wired = new Set<string>();
    for (const w of c.wires ?? []) {
      for (const e of [w.a, w.b]) {
        if (isPinEndpoint(e) && (e.pin === "clk" || e.pin === "rst")) {
          wired.add(`${e.comp}:${e.pin}`);
        }
      }
    }
    if (wired.size === 0) continue;
    for (const comp of c.components ?? []) {
      if (comp.type !== "mem.register" && comp.type !== "mem.ram") continue;
      const showClk = wired.has(`${comp.id}:clk`);
      const showRst = wired.has(`${comp.id}:rst`);
      if (!showClk && !showRst) continue;
      comp.attrs ??= {};
      if (showClk) comp.attrs.showClk = true;
      if (showRst) comp.attrs.showRst = true;
    }
  }
}

/**
 * Backward compatibility: early frontend builds called the `wiring.pin`
 * terminal "port"; the backend registry has always named it "pin". Files
 * saved (browser download) during that window carry "port" endpoints that
 * fail engine validation (unresolved-pin) — rename them on load.
 */
function migratePinTerminals(data: CsxDocument): void {
  for (const c of data.circuits) {
    const pinComps = new Set(c.components.filter((x) => x.type === "wiring.pin").map((x) => x.id));
    for (const w of c.wires) {
      for (const e of [w.a, w.b]) {
        if (isPinEndpoint(e) && e.pin === "port" && pinComps.has(e.comp)) {
          e.pin = "pin";
        }
      }
    }
  }
}

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
/**
 * Rotate one component (UI_OVERHAUL §77).
 *
 * A `wiring.pin` also carries its DIRECTION, and the format keeps that in
 * `attrs.isOutput`: the core derives a subcircuit's interface from it (its
 * `is_output` flag, not from rotation), and the palette seeds the pairing "faces
 * west = output, anything else = input". Keeping the two in step is what makes
 * rotating a port inside a definition move that pin's terminal to the other side
 * of every instance of the circuit.
 *
 * The attribute is kept canonical — an output writes `isOutput: true`, an input
 * leaves it out, exactly as the palette does — so rotating a pin back and forth
 * cannot leave a trail of `isOutput: false` for the version diff to report.
 */
function rotatedComponent(
  comp: CsxComponent,
  map: (rot: CsxComponent["rot"]) => CsxComponent["rot"],
): CsxComponent {
  const rot = map(comp.rot);
  if (comp.type !== "wiring.pin") return { ...comp, rot };
  const attrs = { ...(comp.attrs ?? {}) };
  if (rot === "W") attrs.isOutput = true;
  else delete attrs.isOutput;
  return { ...comp, rot, attrs };
}

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

/** Inverse cycle (E→N→W→S) — arrow-key rotation the other way (§20). */
function prevRot(rot: CsxComponent["rot"]): CsxComponent["rot"] {
  switch (rot) {
    case undefined:
    case "E":
      return "N";
    case "N":
      return "W";
    case "W":
      return "S";
    case "S":
      return "E";
  }
}

// ---- wire-geometry repair (keeps routes orthogonal across edits) ----

const REPAIR_EPS = 1e-9;

const FACING_VEC: Record<Rotation, { x: number; y: number }> = {
  N: { x: 0, y: -1 },
  E: { x: 1, y: 0 },
  S: { x: 0, y: 1 },
  W: { x: -1, y: 0 },
};

/** Axis a pin's escape stub runs along for a given facing. */
function facingAxis(facing: Rotation): "h" | "v" {
  return facing === "E" || facing === "W" ? "h" : "v";
}

/** Exact point comparison: authored coordinates are exact, so no tolerance. */
function samePoints(a: readonly [number, number][], b: readonly [number, number][]): boolean {
  return a.length === b.length && a.every((p, i) => p[0] === b[i][0] && p[1] === b[i][1]);
}

function sameWireList(a: readonly CsxWire[], b: readonly CsxWire[]): boolean {
  return a.length === b.length && a.every((w, i) => w === b[i]);
}

/**
 * Follow a part's geometry with one wire (UI_OVERHAUL §56/§81): an end that
 * names a pin of a part in `ids` returns to that pin, its adjacent bend is
 * nudged onto the pin's new facing side so the stub never dives back through
 * the body, and the end segment is repaired so the route stays orthogonal —
 * never a diagonal stub. Pure, and the identity when nothing moved (same point
 * list in, same object out), which is what lets the caller cheaply tell which
 * wires really changed. A join end, an orphaned reference, and a pin that did
 * not move are all left exactly as they were.
 */
export function followWire(
  w: CsxWire,
  ids: ReadonlySet<string>,
  byId: ReadonlyMap<string, CsxComponent>,
  geom: NonNullable<CircuitDocument["pinGeometry"]>,
): CsxWire {
  const ends: ("a" | "b")[] = [];
  if (isPinEndpoint(w.a) && ids.has(w.a.comp)) ends.push("a");
  if (isPinEndpoint(w.b) && ids.has(w.b.comp)) ends.push("b");
  if (ends.length === 0 || w.points.length < 2) return w;
  let points = w.points.map((p) => [p[0], p[1]] as [number, number]);
  for (const end of ends) {
    const ep = end === "a" ? w.a : w.b;
    if (!isPinEndpoint(ep)) continue;
    const comp = byId.get(ep.comp);
    if (comp === undefined) continue;
    const g = geom(comp, ep.pin);
    if (g === null) continue; // orphan endpoint: leave geometry alone
    const idx = end === "a" ? 0 : points.length - 1;
    points[idx] = [g.pos[0], g.pos[1]];
    // A 180° rotation — or a grown body — puts the pin somewhere else: nudge
    // the adjacent bend onto the facing side so the stub stays on its axis.
    if (points.length >= 3) {
      const adjIdx = end === "a" ? 1 : points.length - 2;
      const adj = points[adjIdx];
      const v = FACING_VEC[g.facing];
      const along = (adj[0] - g.pos[0]) * v.x + (adj[1] - g.pos[1]) * v.y;
      if (along < 0) {
        if (v.x !== 0) {
          adj[0] = g.pos[0] + v.x * Math.max(Math.abs(adj[0] - g.pos[0]), 0.5);
        } else {
          adj[1] = g.pos[1] + v.y * Math.max(Math.abs(adj[1] - g.pos[1]), 0.5);
        }
      }
    }
    points = repairEnd(points, end, facingAxis(g.facing));
  }
  return samePoints(points, w.points) ? w : { ...w, points };
}

/** Axis of an axis-aligned segment; null when diagonal or zero-length. */
function segmentAxis(a: [number, number], b: [number, number]): "h" | "v" | null {
  if (Math.abs(a[1] - b[1]) < REPAIR_EPS && Math.abs(a[0] - b[0]) < REPAIR_EPS) return null;
  if (Math.abs(a[1] - b[1]) < REPAIR_EPS) return "h";
  if (Math.abs(a[0] - b[0]) < REPAIR_EPS) return "v";
  return null;
}

/**
 * Re-establish orthogonality after one endpoint of a wire moved. Walks
 * inward from that end, alternating segment axes h/v (the pattern every
 * generated route follows): each segment is forced onto its expected axis
 * by sliding the next break point's perpendicular coordinate; the far
 * endpoint never moves — when the walk reaches it, a corner is spliced in
 * instead. Pure; returns a new point list.
 */
export function repairEnd(
  points: readonly [number, number][],
  end: "a" | "b",
  axis: "h" | "v" | null,
): [number, number][] {
  const pts = points.map((p) => [p[0], p[1]] as [number, number]);
  if (axis === null || pts.length < 2) return pts;
  const forward = end === "a";
  const at = (i: number) => (forward ? i : pts.length - 1 - i);
  let want: "h" | "v" = axis;
  let i = 0;
  let guard = pts.length + 2;
  while (i + 1 < pts.length && guard-- > 0) {
    const p = pts[at(i)];
    const q = pts[at(i + 1)];
    if (segmentAxis(p, q) !== want) {
      if (at(i + 1) === (forward ? pts.length - 1 : 0)) {
        // The far end is the other wire endpoint — splice in a corner.
        const corner: [number, number] = want === "h" ? [q[0], p[1]] : [p[0], q[1]];
        pts.splice(forward ? at(i + 1) : at(i), 0, corner);
        return pts;
      }
      if (want === "h") q[1] = p[1];
      else q[0] = p[0];
      if (Math.abs(q[0] - p[0]) < REPAIR_EPS && Math.abs(q[1] - p[1]) < REPAIR_EPS) {
        pts.splice(at(i + 1), 1); // collapsed onto p — drop it, retry the same axis
        continue;
      }
    }
    want = want === "h" ? "v" : "h";
    i++;
  }
  return pts;
}

/** Closest point on segment ab (clamped projection). */
function nearestOnSegment(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): [number, number] {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return [a[0], a[1]];
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return [a[0] + t * abx, a[1] + t * aby];
}

/**
 * Junction geometry invariant: a join endpoint must lie on its target
 * segment. After a wire's polyline changed, every LATER wire joining onto a
 * moved wire gets its terminal point re-projected onto the (clamped)
 * segment, its segment reference fixed up, and its end segment repaired.
 * Parents always precede children (a join only targets earlier wires), so a
 * single forward pass suffices. Pure.
 */
export function reprojectJunctionDependents(
  wires: readonly CsxWire[],
  movedIdx: number,
): CsxWire[] {
  const out: CsxWire[] = wires.slice();
  const moved = new Set<number>([movedIdx]);

  /** Seat one joined endpoint of `w` on its (live) parent segment; null if it is
   *  a pin end, degenerate, or its parent is not there. */
  const seat = (w: CsxWire, end: "a" | "b"): CsxWire | null => {
    const ep = w[end];
    if (isPinEndpoint(ep)) return null;
    const parent = out[ep.join.wire];
    if (parent === undefined || parent.points.length < 2 || w.points.length < 2) return null;
    const segment = Math.max(0, Math.min(ep.join.segment, parent.points.length - 2));
    const pts = w.points.map((p) => [p[0], p[1]] as [number, number]);
    const idx = end === "a" ? 0 : pts.length - 1;
    const adjIdx = end === "a" ? 1 : pts.length - 2;
    const axis = segmentAxis(pts[idx], pts[adjIdx]);
    pts[idx] = nearestOnSegment(pts[idx], parent.points[segment], parent.points[segment + 1]);
    return {
      ...w,
      [end]: { join: { wire: ep.join.wire, segment } },
      points: repairEnd(pts, end, axis),
    };
  };

  // The wire's OWN joins first (UI_OVERHAUL §81): a branch dragged away from a
  // parent that is staying put still has to end up ON that parent — and the
  // dependents pass below only ever touches its children.
  for (const end of ["a", "b"] as const) {
    const seated = seat(out[movedIdx], end);
    if (seated !== null) out[movedIdx] = seated;
  }
  for (let i = movedIdx + 1; i < wires.length; i++) {
    const w = out[i];
    let next: CsxWire | null = null;
    for (const end of ["a", "b"] as const) {
      const ep = (next ?? w)[end];
      if (isPinEndpoint(ep) || !moved.has(ep.join.wire)) continue;
      const seated = seat(next ?? w, end);
      if (seated !== null) next = seated;
    }
    if (next !== null) {
      out[i] = next;
      moved.add(i);
    }
  }
  return out;
}
