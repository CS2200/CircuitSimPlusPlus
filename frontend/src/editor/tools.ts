import type { CircuitDocument } from "../model/document";
import type { CsxCircuit, CsxComponent, CsxEndpoint, CsxWire, Rotation } from "../model/csx";
import { isPinEndpoint } from "../model/csx";
import type { SelectionModel } from "../model/selection";
import { snap, snapPoint } from "../render/camera";
import { compSize } from "./catalog";
import type { Rect, Vec2 } from "../render/geom";
import type { PointerInfo } from "../components/CanvasHost";
import { nextRotation, prevRotation } from "./layout";
import type { DocScene, Hit, SceneOverlay } from "./docScene";
import { cleanPolyline, dirVector, perpendicularDirs, routeLeg, type LegEnd } from "./route";

/**
 * ToolMachine (FRONTEND.md U3): the editor interaction state machine,
 * DOM-free and unit-testable. Pointer/key events go in (world coords),
 * document ops + selection + overlay state come out. The React host
 * (EditorCanvas) subscribes via `onChange` to re-render.
 *
 * Gestures:
 *  - click empty space         box select (Ctrl/Shift adds); click = clear
 *  - click component/wire      select (Shift toggles)
 *  - drag component body       move selection, wires glued (one undo step)
 *  - click a pin               start wiring: every further CLICK plants a
 *                              bend exactly where clicked; the route leaves
 *                              pins along their facing and enters targets
 *                              from the correct side (editor/route.ts);
 *                              X flips the corner preference; finish on a
 *                              pin, or drop onto a wire → junction dot;
 *                              Esc / right-click cancels. A DRAG from a pin
 *                              (press → sweep → release) finishes the wire on
 *                              release, over a pin/wire under the pointer
 *                              (UI_OVERHAUL §13), so both gestures work.
 *  - drag from a wire          start wiring with a junction at the press point
 *  - drag a wire bend          re-route the two adjacent legs through the
 *                              dragged point (corner handles select the wire)
 *  - R rotate · Del delete · Ctrl+C/V copy-paste · Ctrl+A select all
 *    (undo/redo and key dispatch live in EditorCanvas/App)
 *
 * Pan/zoom live in CanvasHost (UI_OVERHAUL.md §1: middle-drag,
 * Space+left-drag, right-drag, Shift+left-drag pan) — the machine only ever
 * sees clicks and plain-left gestures.
 */

/** What the pointer is over, for the canvas cursor hint (UI_OVERHAUL §55). */
type HoverCursor = "none" | "pin" | "bend" | "wire" | "target";

type DragState =
  | { kind: "idle" }
  | {
      kind: "maybe-drag";
      start: Vec2;
      wireStart: { wireIdx: number; segment: number; point: Vec2 } | null;
    }
  | { kind: "dragging"; start: Vec2; applied: Vec2 }
  | { kind: "wire-bend"; wireIdx: number; pointIdx: number; original: [number, number][] }
  | { kind: "boxing"; start: Vec2; current: Vec2; additive: boolean };

interface WiringState {
  from: CsxEndpoint;
  /** Start-end routing context: pin facing + body, or junction exit dir. */
  startDir: Rotation | null;
  startBody: Rect | null;
  /** Planted anchor points (first = the from-endpoint coordinate). */
  anchors: Vec2[];
  cursor: Vec2;
  /** X key while routing: prefer turning early (corner flip). */
  flip: boolean;
}

/**
 * Orthogonal route between two free anchors: zero points when already
 * aligned, else one corner — horizontal-first when |dx| ≥ |dy|. Superseded
 * by editor/route.ts for all editor legs; kept for its unit contract and
 * for callers that genuinely have no facing/obstacle context.
 */
export function manhattanRoute(a: Vec2, b: Vec2): Vec2[] {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (dx === 0 || dy === 0) return [];
  return Math.abs(dx) >= Math.abs(dy) ? [{ x: b.x, y: a.y }] : [{ x: a.x, y: b.y }];
}

/** Direction of travel between the last two points (null when unknown). */
function incomingDir(points: readonly Vec2[]): Rotation | null {
  const n = points.length;
  if (n < 2) return null;
  const p = points[n - 2];
  const q = points[n - 1];
  if (Math.abs(q.y - p.y) < 1e-9) return q.x > p.x ? "E" : "W";
  if (Math.abs(q.x - p.x) < 1e-9) return q.y > p.y ? "S" : "N";
  return null;
}

function dot2(a: Vec2, b: Vec2): number {
  return a.x * b.x + a.y * b.y;
}

function p2v(p: [number, number]): Vec2 {
  return { x: p[0], y: p[1] };
}

const DRAG_THRESHOLD = 0.3; // grid units before a press becomes a drag
const PASTE_OFFSET = 1;
/**
 * Pin grab radius used when a DRAG-release finishes a wire (UI_OVERHAUL §13):
 * a whole grid unit, so dropping the wire anywhere on the target part's edge
 * connects to its nearest terminal instead of silently staying in routing
 * mode (the bug that made wiring feel unusable).
 */
const RELEASE_PIN_TOL = 1;

/**
 * Body top-left for a placement whose CENTER sits at `pos` (UI_OVERHAUL §10):
 * the ghost follows the cursor under its middle — like the palette drag-drop
 * path — instead of hanging the body's top-left off the pointer. Rounded to
 * whole grid units because `.csx` positions are integers.
 */
function placementBodyPos(
  p: { type: string; pos: Vec2; attrs?: Record<string, unknown> },
  circuits: readonly CsxCircuit[],
): Vec2 {
  const { w, h } = compSize({ type: p.type, attrs: p.attrs ?? {} }, circuits);
  return { x: Math.round(p.pos.x - w / 2), y: Math.round(p.pos.y - h / 2) };
}

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
  /** What the pointer is over — drives the canvas cursor hint (§55). */
  private hoverCursor: HoverCursor = "none";
  /** The wire a press started on (a bend drag or a junction wire), if any. */
  private pressWireIdx: number | null = null;
  /** The momentary io.button currently held, if any. */
  private pressButton: string | null = null;
  private wireInfo: { wireIdx: number; pos: Vec2 } | null = null;
  /**
   * Left-press origin and whether the pointer has swept past
   * `DRAG_THRESHOLD` since. Distinguishes a drag-wire gesture (press on a
   * pin/wire → sweep → release) from a click: a swept release finishes the
   * wire on whatever is under the pointer. Click-click wiring is unaffected.
   */
  private pressStart: Vec2 | null = null;
  private pressSwept = false;
  private clipboard: { components: CsxComponent[]; wires: CsxWire[] } | null = null;
  /** Fired when a component is double-clicked (opens the right-dock Inspector). */
  onEditComponent?: (compId: string, focusField?: string) => void;
  /** Fired by Shift+click on a clock: step the simulation one tick (§47). */
  onTick?: () => void;
  /** Right-click on a subcircuit instance: jump to its definition (App switches tabs). */
  onOpenSubcircuit?: (circuit: string) => void;
  /**
   * A momentary push button held down (`down` true) or released (`down` false):
   * drives its `out` pin while pressed (UI decision).
   */
  onButton?: (compId: string, down: boolean) => void;
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

  startPlacing(
    type: string,
    sticky = false,
    attrs?: Record<string, unknown>,
    rot: CsxComponent["rot"] = "E",
  ): void {
    this.cancel();
    this.placing = { type, pos: { x: 0, y: 0 }, rot, attrs, sticky };
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
    this.pressStart = null;
    this.pressSwept = false;
    this.pressWireIdx = null;
    if (this.pressButton !== null) {
      this.onButton?.(this.pressButton, false);
      this.pressButton = null;
    }
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
    // Track this press: a press that sweeps (before releasing) is a drag.
    this.pressStart = world;
    this.pressSwept = false;
    this.pressWireIdx = null;

    if (this.placing !== null) {
      const p = this.placing;
      const body = placementBodyPos(p, this.doc.circuits);
      const placed = this.doc.addComponent(this.circuitIdx(), {
        type: p.type,
        pos: [body.x, body.y],
        rot: p.rot,
        ...(p.attrs !== undefined && { attrs: p.attrs }),
      });
      // Select what was just placed: the natural follow-up is to rotate, edit
      // or wire it, and R/arrows/Delete act on the selection (UI_OVERHAUL §23).
      this.selection.set([placed], []);
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

    // Floating rotate button above the selection (drawn by DocScene; the
    // hit area mirrors it — checked before pins so it always wins).
    const rot = this.scene.rotateButtonFor(this.selection.components);
    if (rot !== null && Math.hypot(world.x - rot.center.x, world.y - rot.center.y) <= rot.r) {
      this.rotateSelection();
      return;
    }

    const pin = this.scene.pickPin(world);
    if (pin !== null) {
      this.wiring = {
        from: { comp: pin.compId, pin: pin.pin },
        startDir: this.scene.pinFacing(pin.compId, pin.pin),
        startBody: this.scene.rectOf(pin.compId),
        anchors: [pin.pos],
        cursor: pin.pos,
        flip: false,
      };
      this.changed();
      return;
    }

    // Interior bend points of existing wires drag directly (before the
    // wire-body check, so grabbing a corner never starts a junction wire).
    const corner = this.scene.pickWireCorner(world);
    if (corner !== null && !info.shiftKey) {
      if (!this.selection.hasWire(corner.wireIdx)) {
        this.selection.set([], [corner.wireIdx]);
      }
      this.pressWireIdx = corner.wireIdx;
      this.drag = {
        kind: "wire-bend",
        wireIdx: corner.wireIdx,
        pointIdx: corner.pointIdx,
        original: this.doc
          .circuit(this.circuitIdx())
          .wires[corner.wireIdx].points.map((p) => [p[0], p[1]] as [number, number]),
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
      this.pressWireIdx = wire.wireIdx;
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
      const hitComp = this.doc
        .circuit(this.circuitIdx())
        .components.find((x) => x.id === comp.compId);
      if (hitComp?.type === "io.button") {
        // Momentary push button (UI decision): its `out` is 1 only while held.
        this.selection.set([comp.compId], []);
        this.pressButton = comp.compId;
        this.onButton?.(comp.compId, true);
        this.changed();
        return;
      }
      if (info.shiftKey) {
        // Shift+click a clock ticks the sim once, in place (UI_OVERHAUL §47) —
        // an in-place way to advance the waveform you're looking at.
        const hit = this.doc
          .circuit(this.circuitIdx())
          .components.find((x) => x.id === comp.compId);
        if (hit?.type === "wiring.clock") {
          this.onTick?.();
          return;
        }
        this.selection.toggleComponent(comp.compId);
      } else if (!this.selection.hasComponent(comp.compId)) {
        this.selection.set([comp.compId], []);
      }
      this.drag = { kind: "maybe-drag", start: world, wireStart: null };
      this.changed();
      return;
    }

    this.drag = {
      kind: "boxing",
      start: world,
      current: world,
      additive: info.shiftKey || info.ctrlKey,
    };
    this.changed();
  }

  /**
   * Shift+press on a clock ticks the sim immediately (UI_OVERHAUL §50): doing it
   * on the PRESS means the Shift+left PAN gesture never swallows it. Returns
   * true when the press was consumed.
   */
  tickClockAt(world: Vec2): boolean {
    if (this.placing !== null || this.wiring !== null) return false;
    const hit = this.scene.pickComponent(world);
    if (hit === null) return false;
    const comp = this.doc.circuit(this.circuitIdx()).components.find((x) => x.id === hit.compId);
    if (comp?.type !== "wiring.clock") return false;
    this.onTick?.();
    return true;
  }

  move(world: Vec2): void {
    this.hover(world);
    // Drag-vs-click: remember whether this press has travelled far enough to
    // count as a drag (drives drag-wiring on release).
    if (this.pressStart !== null && !this.pressSwept) {
      if (Math.hypot(world.x - this.pressStart.x, world.y - this.pressStart.y) > DRAG_THRESHOLD) {
        this.pressSwept = true;
      }
    }
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
          // drag off a wire → wire starting at a junction on it; the exit
          // direction is decided once, at gesture start (stable preview)
          const ws = this.drag.wireStart;
          const seg = this.scene.segmentPoints(ws.wireIdx, ws.segment);
          const dirs = seg === null ? null : perpendicularDirs(seg.a, seg.b);
          const dragVec = { x: world.x - ws.point.x, y: world.y - ws.point.y };
          const startDir =
            dirs === null
              ? null
              : dirs.reduce((best, dir) =>
                  dot2(dirVector(dir), dragVec) > dot2(dirVector(best), dragVec) ? dir : best,
                );
          this.wiring = {
            from: { join: { wire: ws.wireIdx, segment: ws.segment } },
            startDir,
            startBody: null,
            anchors: [ws.point],
            cursor: world,
            flip: false,
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
            this.changed();
          }
          this.drag = { ...this.drag, applied: total };
        }
        break;
      }
      case "wire-bend": {
        // Slide one interior bend point. A corner has no free axis (its
        // neighbours pin both coordinates), so dragging it re-routes the two
        // adjacent legs through the new point — recomputed from the drag's
        // original snapshot every event (stable, orthogonal, pin-aware).
        const d = this.drag;
        const circuit = this.doc.circuit(this.circuitIdx());
        const w = circuit.wires[d.wireIdx];
        if (w === undefined || d.pointIdx <= 0 || d.pointIdx + 1 >= d.original.length) break;
        const p = snapPoint(world, 1);
        const prev = d.original[d.pointIdx - 1];
        const next = d.original[d.pointIdx + 1];
        const cur = d.original[d.pointIdx];
        const stuck =
          (p.x === prev[0] && p.y === prev[1]) ||
          (p.x === next[0] && p.y === next[1]) ||
          (p.x === cur[0] && p.y === cur[1]);
        if (stuck) break; // keep every segment non-zero-length
        // Facing/body context when the neighbour IS a wire endpoint (a pin).
        const ctxA: LegEnd =
          d.pointIdx === 1 && isPinEndpoint(w.a)
            ? { dir: this.scene.pinFacing(w.a.comp, w.a.pin), body: this.scene.rectOf(w.a.comp) }
            : { dir: null, body: null };
        const ctxB: LegEnd =
          d.pointIdx === d.original.length - 2 && isPinEndpoint(w.b)
            ? { dir: this.scene.pinFacing(w.b.comp, w.b.pin), body: this.scene.rectOf(w.b.comp) }
            : { dir: null, body: null };
        const leg1 = routeLeg(p2v(prev), ctxA, p, { dir: null, body: null });
        const leg2 = routeLeg(p, { dir: null, body: null }, p2v(next), ctxB);
        const points: [number, number][] = cleanPolyline([
          ...d.original.slice(0, d.pointIdx).map(p2v),
          ...leg1.slice(1),
          ...leg2.slice(1),
          ...d.original.slice(d.pointIdx + 1).map(p2v),
        ]).map((q) => [q.x, q.y]);
        this.doc.updateWirePoints(this.circuitIdx(), d.wireIdx, points);
        this.changed();
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

  up(info: PointerInfo, world?: Vec2): void {
    if (info.button !== 0) return;
    if (this.pressButton !== null) {
      // Release the momentary button.
      this.onButton?.(this.pressButton, false);
      this.pressButton = null;
      this.pressStart = null;
      this.pressSwept = false;
      this.pressWireIdx = null;
      this.changed();
      return;
    }
    const swept = this.pressSwept;
    const fromWire = this.pressWireIdx;
    this.pressStart = null;
    this.pressSwept = false;
    this.pressWireIdx = null;
    // Wiring (UI_OVERHAUL §13) supports both gestures:
    //  - click-click: a press WITHOUT movement commits nothing — the next
    //    click plants a waypoint or finishes the wire (unchanged);
    //  - drag: pressing on a pin/wire, sweeping, and releasing finishes the
    //    wire on the pin/wire under the pointer. Without this, a drag-released
    //    wire stayed in routing mode and every later click bent it — which
    //    made wiring feel broken.
    if (this.wiring !== null) {
      const w = this.wiring;
      if (swept) {
        const release = world ?? w.cursor;
        const routed = this.releaseRoute(w, release);
        if (routed !== null) {
          this.commitWire(w, routed.b, routed.points);
          this.drag = { kind: "idle" };
          return;
        }
      }
      this.drag = { kind: "idle" };
      // A junction-wire dragged off a wire and dropped without connecting
      // leaves the source wire unselected (UI_OVERHAUL §55).
      if (swept && fromWire !== null) {
        this.deselectWires();
        this.changed();
      }
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
    // A wire grabbed and dragged (a bend moved) must not stay highlighted once
    // released — press the handle again to keep editing it (UI_OVERHAUL §55).
    if (swept && fromWire !== null) this.deselectWires();
    this.changed();
  }

  /** Clear the wire selection but keep selected components (UI_OVERHAUL §55). */
  private deselectWires(): void {
    if (this.selection.wires.size > 0) {
      this.selection.set(new Set(this.selection.components), []);
    }
  }

  /** Classify what is under the pointer for the cursor hint (UI_OVERHAUL §55). */
  private hoverCursorAt(world: Vec2): HoverCursor {
    if (this.wiring !== null) return "target";
    if (this.scene.pickPin(world) !== null) return "pin";
    if (this.scene.pickWireCorner(world) !== null) return "bend";
    if (this.scene.pickWire(world) !== null) return "wire";
    return "none";
  }

  hover(world: Vec2): void {
    if (this.placing !== null) {
      this.placing = { ...this.placing, pos: world };
      this.changed();
      return;
    }
    // Cursor hint (UI_OVERHAUL §55): signal what a press here would grab or
    // start, so wiring/dragging is discoverable.
    const cursor = this.hoverCursorAt(world);
    if (cursor !== this.hoverCursor) {
      this.hoverCursor = cursor;
      this.changed();
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

  /**
   * Double-click: select the component and open the right-dock Inspector
   * (UI_OVERHAUL §3.2 — kept as a shortcut; single selection alone also
   * opens the Inspector).
   */
  doubleClick(world: Vec2): void {
    const comp = this.scene.pickComponent(world);
    if (comp !== null) {
      this.selection.set([comp.compId], []);
      // Double-clicking a constant or a register puts you straight into its
      // value input (UI_OVERHAUL §53; registers poke a live value).
      const hit = this.doc.circuit(this.circuitIdx()).components.find((x) => x.id === comp.compId);
      const valueField = hit?.type === "wiring.constant" || hit?.type === "mem.register";
      this.onEditComponent?.(comp.compId, valueField ? "value" : undefined);
      this.changed();
    }
  }

  // ---- commands (keyboard/menu) ----

  /** R: step the rotation cycle (E→S→W→N); ccw reverses it. */
  rotateSelection(ccw = false): void {
    if (this.placing !== null) {
      const rot = this.placing.rot;
      this.placing = { ...this.placing, rot: ccw ? prevRotation(rot) : nextRotation(rot) };
      this.changed();
      return;
    }
    if (this.selection.components.size > 0) {
      this.doc.rotateComponents(this.circuitIdx(), this.selection.components, ccw);
      this.changed();
    }
  }

  /**
   * Arrow keys: make the selection (or the placement ghost) face the direction
   * of the arrow — right → East, left → West, up → North, down → South. This
   * is absolute, not a step: the part ends up pointing at that arrow whatever
   * it faced before (UI_OVERHAUL §22).
   */
  faceSelection(rot: Rotation): void {
    if (this.placing !== null) {
      if (this.placing.rot === rot) return;
      this.placing = { ...this.placing, rot };
      this.changed();
      return;
    }
    if (this.selection.components.size > 0) {
      this.doc.setRotation(this.circuitIdx(), this.selection.components, rot);
      this.changed();
    }
  }

  deleteSelection(): void {
    if (this.selection.isEmpty) return;
    this.doc.deleteSelection(this.circuitIdx(), this.selection.components, this.selection.wires);
    this.selection.clear();
    this.changed();
  }

  /** Cut (UI_OVERHAUL §36): copy the selection, then delete it. */
  cut(): void {
    if (this.selection.isEmpty) return;
    this.clipboard = copySelection(this.doc.circuit(this.circuitIdx()), this.selection.components);
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
      // The ghost carries the RESOLVED body position, so what you see while
      // hovering is exactly where the click will drop it (centered).
      placing:
        this.placing === null
          ? null
          : { ...this.placing, pos: placementBodyPos(this.placing, this.doc.circuits) },
      boxRect: this.drag.kind === "boxing" ? normRect(this.drag.start, this.drag.current) : null,
      wireInfo: this.wireInfo,
    };
  }

  get isBusy(): boolean {
    return this.wiring !== null || this.placing !== null || this.drag.kind !== "idle";
  }

  /** CSS cursor for the canvas given the current gesture/hover (UI_OVERHAUL §55). */
  get cursor(): string | undefined {
    if (this.placing !== null) return "copy";
    if (this.wiring !== null) return "crosshair";
    if (this.drag.kind === "wire-bend") return "grabbing";
    if (this.drag.kind === "dragging") return "move";
    switch (this.hoverCursor) {
      case "pin":
        return "crosshair";
      case "bend":
        return "move";
      case "wire":
        return "pointer";
      default:
        return undefined; // leave the pan cursor to the CSS
    }
  }

  get placingType(): string | null {
    return this.placing?.type ?? null;
  }

  get isWiring(): boolean {
    return this.wiring !== null;
  }

  // ---- internals ----

  /** X while routing: flip the corner preference of the leg being drawn. */
  flipRoute(): void {
    if (this.wiring === null) return;
    this.wiring.flip = !this.wiring.flip;
    this.changed();
  }

  /** The ghost route: planted anchors + the leg to the cursor/target. */
  private routePreview(): Vec2[] {
    return this.buildRoute(this.wiring!, this.wiring!.cursor).points;
  }

  /**
   * Route through the planted anchors to `world`. Finishing on a pin uses
   * the pin's facing; dropping onto a wire enters perpendicular to it;
   * otherwise the leg follows the snapped cursor.
   */
  private buildRoute(
    w: WiringState,
    world: Vec2,
    pinTol?: number,
  ): { points: Vec2[]; finish: { b: CsxEndpoint; endPos: Vec2 } | null } {
    const last = w.anchors.at(-1)!;
    const firstLeg = w.anchors.length === 1;
    const aEnd: LegEnd = firstLeg
      ? { dir: w.startDir, body: w.startBody }
      : { dir: null, body: null };
    const incoming = incomingDir(w.anchors);

    const pin = this.scene.pickPin(world, pinTol);
    if (
      pin !== null &&
      !(isPinEndpoint(w.from) && w.from.comp === pin.compId && w.from.pin === pin.pin)
    ) {
      const bEnd: LegEnd = {
        dir: this.scene.pinFacing(pin.compId, pin.pin),
        body: this.scene.rectOf(pin.compId),
      };
      const leg = routeLeg(last, aEnd, pin.pos, bEnd, { flip: w.flip, incoming });
      return {
        points: cleanPolyline([...w.anchors, ...leg.slice(1)]),
        finish: { b: { comp: pin.compId, pin: pin.pin }, endPos: pin.pos },
      };
    }
    const wire = this.scene.pickWire(world);
    if (wire !== null) {
      const seg = this.scene.segmentPoints(wire.wireIdx, wire.segment);
      const dirs = seg === null ? null : perpendicularDirs(seg.a, seg.b);
      const ends: LegEnd[] =
        dirs === null ? [{ dir: null, body: null }] : dirs.map((dir) => ({ dir, body: null }));
      const leg = routeLeg(last, aEnd, wire.point, ends, { flip: w.flip, incoming });
      return {
        points: cleanPolyline([...w.anchors, ...leg.slice(1)]),
        finish: {
          b: { join: { wire: wire.wireIdx, segment: wire.segment } },
          endPos: wire.point,
        },
      };
    }
    const cursor = snapPoint(world, 1);
    const leg = routeLeg(last, aEnd, cursor, { dir: null, body: null }, { flip: w.flip, incoming });
    return { points: cleanPolyline([...w.anchors, ...leg.slice(1)]), finish: null };
  }

  /** Click while wiring: finish on a pin/wire, else plant a bend. */
  private wiringClick(world: Vec2): void {
    this.finishOrBend(world);
  }

  /**
   * Finish the wire when `world` is on a valid target (a pin that isn't the
   * start pin, or a wire → junction); otherwise plant a waypoint.
   */
  private finishOrBend(world: Vec2): void {
    const w = this.wiring!;
    const { points, finish } = this.buildRoute(w, world);
    if (finish !== null) {
      this.commitWire(w, finish.b, points);
      return;
    }
    w.anchors.push(...points.slice(1));
    this.changed();
  }

  private commitWire(w: WiringState, b: CsxEndpoint, points: readonly Vec2[]): void {
    const pts: [number, number][] = points.map((p) => [p.x, p.y]);
    if (pts.length >= 2) {
      try {
        this.doc.addWire(this.circuitIdx(), { a: w.from, b, points: pts });
      } catch {
        // invalid wire (e.g. onto itself): abort quietly
      }
    }
    this.wiring = null;
    this.drag = { kind: "idle" };
    // A finished wire is never left selected: the next click starts a fresh
    // gesture instead of re-routing the wire just produced (component
    // selections are preserved).
    this.selection.set(new Set(this.selection.components), new Set());
    this.changed();
  }

  /**
   * Where a drag-released wire lands (UI_OVERHAUL §13): a pin/wire under the
   * pointer, or — when the drop is on a part's BODY rather than exactly on a
   * terminal — that part's nearest pin (big parts are mostly body, and
   * missing the terminal used to leave the gesture stuck in routing mode).
   * Null when there is nothing to attach to.
   */
  private releaseRoute(w: WiringState, release: Vec2): { b: CsxEndpoint; points: Vec2[] } | null {
    const near = this.buildRoute(w, release, RELEASE_PIN_TOL);
    if (near.finish !== null) return { b: near.finish.b, points: near.points };
    const comp = this.scene.pickComponent(release);
    if (comp === null) return null;
    // Dropping back on the wire's own source part is not a connection.
    if (isPinEndpoint(w.from) && w.from.comp === comp.compId) return null;
    const pin = this.scene.nearestPinOf(comp.compId, release);
    if (pin === null) return null;
    const snapped = this.buildRoute(w, pin.pos, 0.6);
    return snapped.finish === null ? null : { b: snapped.finish.b, points: snapped.points };
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
