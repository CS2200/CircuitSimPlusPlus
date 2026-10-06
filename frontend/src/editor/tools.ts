import type { CircuitDocument } from "../model/document";
import type { CsxComponent, CsxEndpoint, CsxWire } from "../model/csx";
import { isPinEndpoint } from "../model/csx";
import type { SelectionModel } from "../model/selection";
import { snap, snapPoint } from "../render/camera";
import type { Rect, Vec2 } from "../render/geom";
import type { PointerInfo } from "../components/CanvasHost";
import { nextRotation } from "./layout";
import type { DocScene, Hit, SceneOverlay } from "./docScene";

/**
 * ToolMachine (FRONTEND.md U3): the editor interaction state machine,
 * DOM-free and unit-testable. Pointer/key events go in (world coords),
 * document ops + selection + overlay state come out. The React host
 * (EditorCanvas) subscribes via `onChange` to re-render.
 *
 * Gestures:
 *  - click empty space         box select (Shift adds); click = clear
 *  - click component/wire      select (Shift toggles)
 *  - drag component body       move selection, wires glued (one undo step)
 *  - click a pin               start wiring: every further CLICK plants a
 *                              bend exactly where clicked; finish on a pin,
 *                              or drop onto a wire → junction dot; Esc /
 *                              right-click cancels. Dragging from a pin is
 *                              the same as clicking it — releasing the
 *                              button never commits anything (click-driven
 *                              routing only; UX decision).
 *  - drag from a wire          start wiring with a junction at the press point
 *  - R rotate · Del delete · Ctrl+C/V copy-paste · Ctrl+A select all
 *    (undo/redo and key dispatch live in EditorCanvas/App)
 */

type DragState =
  | { kind: "idle" }
  | {
      kind: "maybe-drag";
      start: Vec2;
      wireStart: { wireIdx: number; segment: number; point: Vec2 } | null;
    }
  | { kind: "dragging"; start: Vec2; applied: Vec2 }
  | { kind: "boxing"; start: Vec2; current: Vec2; additive: boolean };

interface WiringState {
  from: CsxEndpoint;
  /** Planted anchor points (first = the from-endpoint coordinate). */
  anchors: Vec2[];
  cursor: Vec2;
}

/**
 * Orthogonal route between two anchors: zero points when already aligned,
 * else one corner — horizontal-first when |dx| ≥ |dy| (wires look
 * circuit-like, never diagonal).
 */
export function manhattanRoute(a: Vec2, b: Vec2): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 || dy === 0) return [];
  return Math.abs(dx) >= Math.abs(dy) ? [{ x: b.x, y: a.y }] : [{ x: a.x, y: b.y }];
}

function dedupPoints(points: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (last === undefined || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  return out;
}

const DRAG_THRESHOLD = 0.3; // grid units before a press becomes a drag
const PASTE_OFFSET = 1;

export class ToolMachine {
  private drag: DragState = { kind: "idle" };
  private wiring: WiringState | null = null;
  private placing: {
    type: string;
    pos: Vec2;
    rot: CsxComponent["rot"];
    /** Placement attrs (e.g. a subcircuit instance's target circuit). */
    attrs?: Record<string, unknown>;
    /** Shift-picked from the palette: keep placing until cancelled. */
    sticky: boolean;
  } | null = null;
  private hoverHit: Hit | null = null;
  private wireInfo: { wireIdx: number; pos: Vec2 } | null = null;
  private clipboard: { components: CsxComponent[]; wires: CsxWire[] } | null = null;
  /** Fired when a component is double-clicked (properties dialog). */
  onEditComponent?: (compId: string) => void;
  /** Right-click on a subcircuit instance: jump to its definition (App switches tabs). */
  onOpenSubcircuit?: (circuit: string) => void;
  /** Bumped on every state change so the host re-renders. */
  version = 0;

  constructor(
    private readonly doc: CircuitDocument,
    private readonly scene: DocScene,
    private readonly selection: SelectionModel,
    private readonly circuitIdx: () => number,
    private readonly onChange: () => void,
  ) {}

  // ---- external triggers ----

  startPlacing(type: string, sticky = false, attrs?: Record<string, unknown>): void {
    this.cancel();
    this.placing = { type, pos: { x: 0, y: 0 }, rot: "E", attrs, sticky };
    this.changed();
  }

  /** Esc / right-click: abort wiring, placement, or any in-progress gesture. */
  cancel(): void {
    const any =
      this.wiring !== null ||
      this.placing !== null ||
      this.drag.kind !== "idle" ||
      this.wireInfo !== null;
    this.wiring = null;
    this.placing = null;
    this.drag = { kind: "idle" };
    this.wireInfo = null;
    if (any) this.changed();
  }

  // ---- pointer input ----

  down(world: Vec2, info: PointerInfo): void {
    if (info.button === 2) {
      // Idle right-click on a subcircuit instance opens its definition;
      // otherwise right-click is the universal cancel.
      if (this.placing === null && this.wiring === null && this.drag.kind === "idle") {
        const hit = this.scene.pickComponent(world);
        if (hit !== null) {
          const comp = this.doc
            .circuit(this.circuitIdx())
            .components.find((c) => c.id === hit.compId);
          const target = comp?.type === "subcircuit" ? comp.attrs?.circuit : undefined;
          if (typeof target === "string" && target !== "") {
            this.onOpenSubcircuit?.(target);
            return;
          }
        }
      }
      this.cancel();
      return;
    }
    if (info.button !== 0) return;
    // any fresh gesture dismisses the wire info card
    this.wireInfo = null;

    if (this.placing !== null) {
      const p = this.placing;
      this.doc.addComponent(this.circuitIdx(), {
        type: p.type,
        pos: [snap(p.pos.x, 1), snap(p.pos.y, 1)],
        rot: p.rot,
        ...(p.attrs !== undefined && { attrs: p.attrs }),
      });
      // One placement per palette pick; shift-picked (sticky) keeps placing
      // until Esc/right-click (UX decision).
      if (!p.sticky) this.placing = null;
      this.changed();
      return;
    }

    if (this.wiring !== null) {
      this.wiringClick(world);
      return;
    }

    const pin = this.scene.pickPin(world);
    if (pin !== null) {
      this.wiring = {
        from: { comp: pin.compId, pin: pin.pin },
        anchors: [pin.pos],
        cursor: pin.pos,
      };
      this.changed();
      return;
    }

    const wire = this.scene.pickWire(world);
    if (wire !== null) {
      if (info.shiftKey) {
        // shift+click a wire → what's on it (net info card)
        this.wireInfo = { wireIdx: wire.wireIdx, pos: world };
        this.changed();
        return;
      }
      if (!this.selection.hasWire(wire.wireIdx)) {
        this.selection.set([], [wire.wireIdx]);
      }
      // a DRAG from a wire starts wiring with a junction at the press point
      this.drag = {
        kind: "maybe-drag",
        start: world,
        wireStart: { wireIdx: wire.wireIdx, segment: wire.segment, point: wire.point },
      };
      this.changed();
      return;
    }

    const comp = this.scene.pickComponent(world);
    if (comp !== null) {
      if (info.shiftKey) {
        this.selection.toggleComponent(comp.compId);
      } else if (!this.selection.hasComponent(comp.compId)) {
        this.selection.set([comp.compId], []);
      }
      this.drag = { kind: "maybe-drag", start: world, wireStart: null };
      this.changed();
      return;
    }

    this.drag = { kind: "boxing", start: world, current: world, additive: info.shiftKey };
    this.changed();
  }

  move(world: Vec2): void {
    this.hover(world);
    if (this.wiring !== null) {
      this.wiring.cursor = world;
      this.changed();
      return;
    }
    switch (this.drag.kind) {
      case "maybe-drag": {
        const d = Math.hypot(world.x - this.drag.start.x, world.y - this.drag.start.y);
        if (d <= DRAG_THRESHOLD) break;
        if (this.drag.wireStart !== null) {
          // drag off a wire → wire starting at a junction on it
          const ws = this.drag.wireStart;
          this.wiring = {
            from: { join: { wire: ws.wireIdx, segment: ws.segment } },
            anchors: [ws.point],
            cursor: world,
          };
          this.drag = { kind: "idle" };
        } else {
          this.drag = { kind: "dragging", start: this.drag.start, applied: { x: 0, y: 0 } };
        }
        this.changed();
        break;
      }
      case "dragging": {
        // grid-quantized total delta — no per-event rounding jumps
        const total = {
          x: snap(world.x - this.drag.start.x, 1),
          y: snap(world.y - this.drag.start.y, 1),
        };
        const delta = { x: total.x - this.drag.applied.x, y: total.y - this.drag.applied.y };
        if (delta.x !== 0 || delta.y !== 0) {
          if (this.selection.components.size > 0) {
            this.doc.moveComponents(this.circuitIdx(), this.selection.components, delta);
          }
          this.drag = { ...this.drag, applied: total };
        }
        break;
      }
      case "boxing":
        this.drag = { ...this.drag, current: world };
        this.changed();
        break;
      case "idle":
        break;
    }
  }

  up(info: PointerInfo): void {
    if (info.button !== 0) return;
    // Wiring is click-driven: releasing the button (even after a drag that
    // started on a pin/wire) commits NOTHING — the next click plants the
    // bend or finishes the wire.
    if (this.wiring !== null) {
      this.drag = { kind: "idle" };
      return;
    }
    if (this.drag.kind === "boxing") {
      const rect = normRect(this.drag.start, this.drag.current);
      const found = this.scene.pickRect(rect);
      if (this.drag.additive) {
        const comps = new Set(this.selection.components);
        const wires = new Set(this.selection.wires);
        for (const id of found.components) comps.add(id);
        for (const i of found.wires) wires.add(i);
        this.selection.set(comps, wires);
      } else {
        this.selection.set(found.components, found.wires);
      }
    }
    this.drag = { kind: "idle" };
    this.changed();
  }

  hover(world: Vec2): void {
    if (this.placing !== null) {
      this.placing = { ...this.placing, pos: world };
      this.changed();
      return;
    }
    // While wiring, pins + wires are live targets (junction preview); idle
    // hover is pins first (net-extent highlight) then component bodies (so
    // violation markers can show their detail card) — hovering a wire
    // still does nothing.
    const hit =
      this.wiring !== null
        ? this.scene.pick(world)
        : (this.scene.pickPin(world) ?? this.scene.pickComponent(world) ?? null);
    if (JSON.stringify(hit ?? null) !== JSON.stringify(this.hoverHit ?? null)) {
      this.hoverHit = hit;
      this.changed();
    }
  }

  /** Double-click: edit a component's properties. */
  doubleClick(world: Vec2): void {
    const comp = this.scene.pickComponent(world);
    if (comp !== null) this.onEditComponent?.(comp.compId);
  }

  // ---- commands (keyboard/menu) ----

  rotateSelection(): void {
    if (this.placing !== null) {
      this.placing = { ...this.placing, rot: nextRotation(this.placing.rot) };
      this.changed();
      return;
    }
    if (this.selection.components.size > 0) {
      this.doc.rotateComponents(this.circuitIdx(), this.selection.components);
      this.changed();
    }
  }

  deleteSelection(): void {
    if (this.selection.isEmpty) return;
    this.doc.deleteSelection(this.circuitIdx(), this.selection.components, this.selection.wires);
    this.selection.clear();
    this.changed();
  }

  copy(): void {
    if (this.selection.isEmpty) return;
    this.clipboard = copySelection(this.doc.circuit(this.circuitIdx()), this.selection.components);
    this.changed();
  }

  paste(): void {
    if (this.clipboard === null || this.clipboard.components.length === 0) return;
    const { components, wires } = this.clipboard;
    const pasted = this.doc.paste(this.circuitIdx(), components, wires, {
      x: PASTE_OFFSET,
      y: PASTE_OFFSET,
    });
    this.selection.set(pasted, []);
    this.changed();
  }

  selectAll(): void {
    const c = this.doc.circuit(this.circuitIdx());
    this.selection.set(
      c.components.map((x) => x.id),
      c.wires.map((_, i) => i),
    );
    this.changed();
  }

  // ---- overlay for the renderer ----

  overlay(): SceneOverlay {
    return {
      hoverHit: this.hoverHit,
      wireInProgress: this.wiring !== null ? this.routePreview() : null,
      placing: this.placing,
      boxRect: this.drag.kind === "boxing" ? normRect(this.drag.start, this.drag.current) : null,
      wireInfo: this.wireInfo,
    };
  }

  get isBusy(): boolean {
    return this.wiring !== null || this.placing !== null || this.drag.kind !== "idle";
  }

  get placingType(): string | null {
    return this.placing?.type ?? null;
  }

  get isWiring(): boolean {
    return this.wiring !== null;
  }

  // ---- internals ----

  /** The ghost route: planted anchors + manhattan-routed segment to the cursor. */
  private routePreview(): Vec2[] {
    const w = this.wiring!;
    const last = w.anchors.at(-1)!;
    const cursor = snapPoint(w.cursor, 1);
    return dedupPoints([...w.anchors, ...manhattanRoute(last, cursor), cursor]);
  }

  /** Click while wiring: finish on a pin/wire, else plant a bend. */
  private wiringClick(world: Vec2): void {
    this.finishOrBend(world);
  }

  /**
   * Finish the wire when `world` is on a valid target (a pin that isn't the
   * start pin, or a wire → junction); otherwise plant a bend.
   */
  private finishOrBend(world: Vec2): void {
    const w = this.wiring!;
    // finish on a pin (but never the pin we started from)?
    const pin = this.scene.pickPin(world);
    if (
      pin !== null &&
      !(isPinEndpoint(w.from) && w.from.comp === pin.compId && w.from.pin === pin.pin)
    ) {
      this.commitWire(w, { comp: pin.compId, pin: pin.pin }, pin.pos);
      return;
    }
    // finish by dropping onto a wire (junction dot, DESIGN.md §5.2)?
    const wire = this.scene.pickWire(world);
    if (wire !== null) {
      this.commitWire(w, { join: { wire: wire.wireIdx, segment: wire.segment } }, wire.point);
      return;
    }
    // otherwise plant a bend (the full manhattan-routed segment)
    const last = w.anchors.at(-1)!;
    const cursor = snapPoint(world, 1);
    w.anchors.push(...manhattanRoute(last, cursor), cursor);
    this.changed();
  }

  private commitWire(w: WiringState, b: CsxEndpoint, endPos: Vec2): void {
    const last = w.anchors.at(-1)!;
    const points: [number, number][] = dedupPoints([
      ...w.anchors,
      ...manhattanRoute(last, endPos),
      endPos,
    ]).map((p) => [p.x, p.y]);
    if (points.length >= 2) {
      try {
        this.doc.addWire(this.circuitIdx(), { a: w.from, b, points });
      } catch {
        // invalid wire (e.g. onto itself): abort quietly
      }
    }
    this.wiring = null;
    this.changed();
  }

  private changed(): void {
    // Picking reads the scene's draw model — keep it fresh (revision-gated).
    this.scene.sync(this.doc, this.circuitIdx());
    this.version++;
    this.onChange();
  }
}

function normRect(a: Vec2, b: Vec2): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x),
    h: Math.abs(a.y - b.y),
  };
}

/**
 * Copy a component selection: the selected components plus every wire
 * whose BOTH endpoints resolve inside the copy (pin → copied component;
 * junction → copied parent wire, recursively). Junction indices are
 * remapped to the new wire order. A wire never dangles.
 */
export function copySelection(
  c: { components: CsxComponent[]; wires: CsxWire[] },
  compSet: ReadonlySet<string>,
): { components: CsxComponent[]; wires: CsxWire[] } {
  const components = c.components.filter((x) => compSet.has(x.id)).map((x) => structuredClone(x));
  const copiedOld = new Set<number>();
  let grew = true;
  while (grew) {
    grew = false;
    c.wires.forEach((w, i) => {
      if (copiedOld.has(i)) return;
      const okA = isPinEndpoint(w.a) ? compSet.has(w.a.comp) : copiedOld.has(w.a.join.wire);
      const okB = isPinEndpoint(w.b) ? compSet.has(w.b.comp) : copiedOld.has(w.b.join.wire);
      if (okA && okB) {
        copiedOld.add(i);
        grew = true;
      }
    });
  }
  const remap = new Map<number, number>();
  let n = 0;
  c.wires.forEach((_, i) => {
    if (copiedOld.has(i)) remap.set(i, n++);
  });
  const wires: CsxWire[] = [];
  c.wires.forEach((w, i) => {
    if (!copiedOld.has(i)) return;
    const clone = structuredClone(w);
    for (const e of [clone.a, clone.b]) {
      if (!isPinEndpoint(e)) e.join.wire = remap.get(e.join.wire)!;
    }
    wires.push(clone);
  });
  return { components, wires };
}
