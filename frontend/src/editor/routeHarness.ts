import { CircuitDocument } from "../model/document";
import { SelectionModel } from "../model/selection";
import { isFreeEndpoint, isJoinEndpoint, isPinEndpoint } from "../model/csx";
import type { CsxCircuit, CsxComponent, CsxEndpoint, CsxWire, Rotation } from "../model/csx";
import { deriveNets } from "../model/nets";
import type { PointerInfo } from "../components/CanvasHost";
import type { Rect, Vec2 } from "../render/geom";
import { DocScene } from "./docScene";
import { compLayout } from "./layout";
import { compPins, pinShown } from "./catalog";
import { rerouteWire } from "./reroute";
import { ToolMachine } from "./tools";

/**
 * routeHarness — a headless gesture harness for the wire router.
 *
 * The router's per-leg geometry (`editor/route.ts`) is a pure function and is
 * already covered by `route.test.ts`. But the bugs users actually see come from
 * the *orchestration* one level up: a wire is routed one leg per click
 * (`ToolMachine.buildRoute`), earlier legs are frozen, only the first leg knows
 * its pin's body, and junctions drop onto a parent wire that is never
 * re-routed. Those live in the interaction, so they need the interaction.
 *
 * This module drives the REAL `ToolMachine` (no DOM, no canvas — it is already
 * DOM-free) against a mock scene, from a scripted stream of pointer/key events,
 * then checks the resulting document against the invariants the router is
 * supposed to guarantee. Nothing here is imported by the app; it exists for
 * tests and for dumping a failing case to SVG/ASCII.
 *
 * Typical use:
 *
 * ```ts
 * const h = buildHarness({ components: [{ type: "gate.and", pos: [10, 10] }, …] });
 * runScript(h, [
 *   { kind: "click", at: "c1.out" },
 *   { kind: "move",  at: { x: 17, y: 8 } },
 *   { kind: "click", at: { x: 17, y: 8 } },
 *   { kind: "click", at: "c2.in" },
 * ]);
 * expect(check(h)).toEqual([]);        // or expect(toSvg(h)).toMatchSnapshot()
 * ```
 */

const EPS = 1e-9;

/** A pointer event with no buttons held (matches the test-suite convention). */
export function pointer(over: Partial<PointerInfo> = {}): PointerInfo {
  return {
    button: 0,
    buttons: 0,
    shiftKey: false,
    ctrlKey: false,
    altKey: false,
    clientX: 0,
    clientY: 0,
    ...over,
  };
}

// ---- mock scene description ----

export interface HarnessComp {
  /** Symbolic name usable from scripts/wires; defaults to the allocated id. */
  label?: string;
  type: string;
  pos: [number, number];
  rot?: Rotation;
  name?: string;
  attrs?: Record<string, unknown>;
}

export type HarnessEP =
  | { label: string; pin: string }
  | { join: { wire: number; segment: number } }
  | { free: [number, number] };

export interface HarnessWire {
  a: HarnessEP;
  b: HarnessEP;
  points: [number, number][];
  name?: string;
}

export interface HarnessScene {
  components: HarnessComp[];
  /** Pre-existing wires, to exercise junctions / coalescing. */
  wires?: HarnessWire[];
}

export interface HarnessPin {
  ref: string;
  compId: string;
  pin: string;
  pos: Vec2;
  facing: Rotation;
}

export interface Harness {
  doc: CircuitDocument;
  scene: DocScene;
  tool: ToolMachine;
  /** Allocated component ids, in scene order. */
  ids: string[];
  idOf(label: string): string;
  /** World position of a "label.pin" (or "id.pin") reference in the current circuit. */
  pin(ref: string): Vec2;
  /** Every currently-shown pin of the current circuit. */
  pins(): HarnessPin[];
  circuit(): CsxCircuit;
  wires(): readonly CsxWire[];
  /** The circuit (sheet) gestures currently act on. */
  currentCircuit: number;
  circuitCount(): number;
  circuitNames(): string[];
  /** Append a fresh empty circuit and return its index. */
  addCircuit(name: string): number;
  /** Make circuit `idx` the one gestures act on (syncs the scene). */
  switchTo(idx: number): void;
}

function resolveEP(ep: HarnessEP, labelToId: Map<string, string>): CsxEndpoint {
  if ("join" in ep) return { join: { wire: ep.join.wire, segment: ep.join.segment } };
  if ("free" in ep) return { free: [ep.free[0], ep.free[1]] };
  const id = labelToId.get(ep.label);
  if (id === undefined) throw new Error(`routeHarness: unknown component label "${ep.label}"`);
  return { comp: id, pin: ep.pin };
}

/** Build a mock scene: components (and optionally wires) in a fresh document. */
export function buildHarness(scene: HarnessScene): Harness {
  const doc = CircuitDocument.create("harness");
  // Mirror the editor's wiring of the document (App.initDoc): pin names for
  // dangling-wire pruning, and pin GEOMETRY so rotation re-anchors glued wire
  // ends instead of silently leaving them behind. Without these the harness
  // would test a configuration the app never runs.
  doc.pinResolver = (comp) => compPins(comp, doc.circuits).map((p) => p.name);
  doc.pinGeometry = (comp, pin, circuits) => {
    const p = compLayout(comp, circuits ?? doc.circuits).pins.find((x) => x.name === pin);
    return p === undefined ? null : { pos: [p.x, p.y], facing: p.facing };
  };
  // Rotation re-routes a glued wire from the new pin geometry (the same hook the
  // app installs), so the harness exercises the drift fix.
  doc.rerouteWire = rerouteWire;
  const docScene = new DocScene();
  const sel = new SelectionModel();
  // The active circuit lives in a holder so the ToolMachine (built first) and
  // the harness's accessors always read the same, mutable index.
  const ctx = { circuit: 0 };
  const tool = new ToolMachine(
    doc,
    docScene,
    sel,
    () => ctx.circuit,
    () => {},
  );
  const labelToId = new Map<string, string>();
  const ids: string[] = [];
  const bind = (key: string, id: string): void => {
    const prev = labelToId.get(key);
    if (prev !== undefined && prev !== id) {
      throw new Error(`routeHarness: label "${key}" collides with component id "${prev}"`);
    }
    labelToId.set(key, id);
  };
  for (const c of scene.components) {
    const id = doc.addComponent(0, {
      type: c.type,
      pos: c.pos,
      ...(c.rot !== undefined && { rot: c.rot }),
      ...(c.name !== undefined && { name: c.name }),
      ...(c.attrs !== undefined && { attrs: c.attrs }),
    });
    ids.push(id);
    bind(id, id);
    if (c.label !== undefined) bind(c.label, id);
  }
  for (const w of scene.wires ?? []) {
    doc.addWire(0, {
      a: resolveEP(w.a, labelToId),
      b: resolveEP(w.b, labelToId),
      points: w.points.map((p) => [p[0], p[1]] as [number, number]),
      ...(w.name !== undefined && { name: w.name }),
    });
  }
  doc.normalizePinEnds();
  docScene.sync(doc, 0);

  const h: Harness = {
    doc,
    scene: docScene,
    tool,
    ids,
    idOf: (label) => {
      const id = labelToId.get(label);
      if (id === undefined) throw new Error(`routeHarness: unknown component label "${label}"`);
      return id;
    },
    pin: (ref) => {
      const dot = ref.lastIndexOf(".");
      if (dot < 0) throw new Error(`routeHarness: bad pin reference "${ref}"`);
      const key = ref.slice(0, dot);
      const pin = ref.slice(dot + 1);
      const id = labelToId.get(key) ?? key;
      const comp = doc.circuit(ctx.circuit).components.find((c) => c.id === id);
      if (comp === undefined) throw new Error(`routeHarness: unknown component "${id}"`);
      const p = compLayout(comp, doc.circuits).pins.find((x) => x.name === pin);
      if (p === undefined) throw new Error(`routeHarness: ${comp.type} has no pin "${pin}"`);
      return { x: p.x, y: p.y };
    },
    pins: () => {
      const out: HarnessPin[] = [];
      for (const comp of doc.circuit(ctx.circuit).components) {
        for (const p of compLayout(comp, doc.circuits).pins) {
          if (!pinShown(comp, p.name)) continue;
          out.push({
            ref: `${comp.id}.${p.name}`,
            compId: comp.id,
            pin: p.name,
            pos: { x: p.x, y: p.y },
            facing: p.facing,
          });
        }
      }
      return out;
    },
    circuit: () => doc.circuit(ctx.circuit),
    wires: () => doc.circuit(ctx.circuit).wires,
    get currentCircuit() {
      return ctx.circuit;
    },
    set currentCircuit(idx: number) {
      ctx.circuit = idx;
      docScene.sync(doc, idx);
    },
    circuitCount: () => doc.circuits.length,
    circuitNames: () => doc.circuits.map((c) => c.name),
    addCircuit: (name) => {
      const idx = doc.addCircuit(name);
      docScene.sync(doc, idx);
      return idx;
    },
    switchTo: (idx) => {
      ctx.circuit = idx;
      docScene.sync(doc, idx);
    },
  };
  return h;
}

// ---- gesture scripts ----

/** A fixed world point, or a "label.pin" reference resolved at run time. */
export type PointRef = Vec2 | string;

export interface StepMods {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  /** Mouse button (0 left, 2 right); ignored by non-pointer steps. */
  button?: number;
}

export type HarnessStep =
  | ({ kind: "down"; at: PointRef } & StepMods)
  | ({ kind: "move"; at: PointRef } & StepMods)
  | ({ kind: "up"; at?: PointRef } & StepMods)
  | ({ kind: "click"; at: PointRef } & StepMods)
  | ({ kind: "hover"; at: PointRef } & StepMods)
  | { kind: "doubleClick"; at: PointRef }
  | { kind: "flip" }
  | { kind: "finishFree" }
  | { kind: "cancel" }
  | { kind: "rotate"; ccw?: boolean }
  | { kind: "face"; rot: Rotation }
  | { kind: "delete" }
  | { kind: "copy" }
  | { kind: "cut" }
  | { kind: "paste" }
  | { kind: "selectAll" }
  | {
      kind: "startPlacing";
      type: string;
      sticky?: boolean;
      rot?: Rotation;
      attrs?: Record<string, unknown>;
    }
  | { kind: "place"; type: string; at: PointRef; rot?: Rotation; sticky?: boolean }
  | {
      /** Inspector edit: change type/rotation/attrs (may resize the body). */
      kind: "edit";
      id: string;
      patch: { type?: string; rot?: Rotation; name?: string; attrs?: Record<string, unknown> };
    };

function resolvePoint(h: Harness, ref: PointRef): Vec2 {
  return typeof ref === "string" ? h.pin(ref) : ref;
}

function modsOf(s: StepMods): PointerInfo {
  return pointer({
    button: s.button ?? 0,
    shiftKey: s.shift ?? false,
    ctrlKey: s.ctrl ?? false,
    altKey: s.alt ?? false,
  });
}

/** Apply one scripted event through the real editor state machine. */
export function applyStep(h: Harness, s: HarnessStep): void {
  switch (s.kind) {
    case "down":
      h.tool.down(resolvePoint(h, s.at), modsOf(s));
      break;
    case "move":
      h.tool.move(resolvePoint(h, s.at));
      break;
    case "up":
      h.tool.up(modsOf(s), s.at === undefined ? undefined : resolvePoint(h, s.at));
      break;
    case "click": {
      const p = resolvePoint(h, s.at);
      const info = modsOf(s);
      h.tool.down(p, info);
      h.tool.up(info);
      break;
    }
    case "hover":
      h.tool.hover(resolvePoint(h, s.at));
      break;
    case "doubleClick":
      h.tool.doubleClick(resolvePoint(h, s.at));
      break;
    case "flip":
      h.tool.flipRoute();
      break;
    case "finishFree":
      h.tool.finishFree();
      break;
    case "cancel":
      h.tool.cancel();
      break;
    case "rotate":
      h.tool.rotateSelection(s.ccw ?? false);
      break;
    case "face":
      h.tool.faceSelection(s.rot);
      break;
    case "delete":
      h.tool.deleteSelection();
      break;
    case "copy":
      h.tool.copy();
      break;
    case "cut":
      h.tool.cut();
      break;
    case "paste":
      h.tool.paste();
      break;
    case "selectAll":
      h.tool.selectAll();
      break;
    case "startPlacing":
      h.tool.startPlacing(s.type, s.sticky ?? false, s.attrs, s.rot ?? "E");
      break;
    case "place": {
      h.tool.startPlacing(s.type, s.sticky ?? false, undefined, s.rot ?? "E");
      const p = resolvePoint(h, s.at);
      h.tool.down(p, pointer());
      h.tool.up(pointer());
      break;
    }
    case "edit":
      h.doc.updateComponent(h.currentCircuit, s.id, s.patch);
      h.scene.sync(h.doc, h.currentCircuit);
      break;
  }
}

/** Replay a scripted event stream through the real editor state machine. */
export function runScript(h: Harness, steps: readonly HarnessStep[]): void {
  for (const s of steps) applyStep(h, s);
}

/* ------------------------------------------------------------------ */
/* geometry helpers                                                     */
/* ------------------------------------------------------------------ */

function samePoint(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) < EPS && Math.abs(a.y - b.y) < EPS;
}

function pointAt(pts: readonly [number, number][], i: number): Vec2 {
  const p = pts[i];
  return { x: p[0], y: p[1] };
}

/** True when `seg` is axis-aligned; returns its axis or null (diagonal). */
function axisOf(a: Vec2, b: Vec2): "h" | "v" | null {
  if (Math.abs(a.y - b.y) < EPS) return "h";
  if (Math.abs(a.x - b.x) < EPS) return "v";
  return null;
}

/** Collinear overlap length of two axis-aligned segments (0 when not collinear). */
function collinearOverlap(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): number {
  const pH = Math.abs(p0.y - p1.y) < EPS;
  const qH = Math.abs(q0.y - q1.y) < EPS;
  if (pH && qH) {
    if (Math.abs(p0.y - q0.y) > EPS) return 0;
    const lo = Math.max(Math.min(p0.x, p1.x), Math.min(q0.x, q1.x));
    const hi = Math.min(Math.max(p0.x, p1.x), Math.max(q0.x, q1.x));
    return hi - lo;
  }
  if (!pH && !qH) {
    if (Math.abs(p0.x - q0.x) > EPS) return 0;
    const lo = Math.max(Math.min(p0.y, p1.y), Math.min(q0.y, q1.y));
    const hi = Math.min(Math.max(p0.y, p1.y), Math.max(q0.y, q1.y));
    return hi - lo;
  }
  return 0;
}

/** Non-adjacent segments may not overlap or cross (self-tangles). */
function selfOverlaps(pts: readonly Vec2[]): boolean {
  for (let i = 0; i + 2 < pts.length; i++) {
    for (let j = i + 2; j + 1 < pts.length; j++) {
      if (pairTangled(pts[i], pts[i + 1], pts[j], pts[j + 1])) return true;
    }
  }
  return false;
}

function pairTangled(p0: Vec2, p1: Vec2, q0: Vec2, q1: Vec2): boolean {
  const pH = Math.abs(p0.y - p1.y) < EPS;
  const qH = Math.abs(q0.y - q1.y) < EPS;
  if (pH && qH) {
    if (Math.abs(p0.y - q0.y) > EPS) return false;
    const lo = Math.max(Math.min(p0.x, p1.x), Math.min(q0.x, q1.x));
    const hi = Math.min(Math.max(p0.x, p1.x), Math.max(q0.x, q1.x));
    return hi - lo > EPS;
  }
  if (!pH && !qH) {
    if (Math.abs(p0.x - q0.x) > EPS) return false;
    const lo = Math.max(Math.min(p0.y, p1.y), Math.min(q0.y, q1.y));
    const hi = Math.min(Math.max(p0.y, p1.y), Math.max(q0.y, q1.y));
    return hi - lo > EPS;
  }
  const [h0, h1, v0, v1] = pH ? [p0, p1, q0, q1] : [q0, q1, p0, p1];
  const x = v0.x;
  const y = h0.y;
  const inH = x > Math.min(h0.x, h1.x) + EPS && x < Math.max(h0.x, h1.x) - EPS;
  const inV = y > Math.min(v0.y, v1.y) + EPS && y < Math.max(v0.y, v1.y) - EPS;
  return inH && inV;
}

/** Strict-interior overlap of an axis-aligned segment with an inflated rect. */
function segOverlapsRect(s0: Vec2, s1: Vec2, r: Rect, margin: number): boolean {
  const rx = r.x - margin;
  const ry = r.y - margin;
  const x1 = Math.min(s0.x, s1.x);
  const x2 = Math.max(s0.x, s1.x);
  const y1 = Math.min(s0.y, s1.y);
  const y2 = Math.max(s0.y, s1.y);
  return (
    x2 > rx + EPS &&
    x1 < rx + r.w + 2 * margin - EPS &&
    y2 > ry + EPS &&
    y1 < ry + r.h + 2 * margin - EPS
  );
}

function distToSeg(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < EPS) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* ------------------------------------------------------------------ */
/* invariant checking                                                   */
/* ------------------------------------------------------------------ */

export type Severity = "error" | "warn";

export interface Violation {
  kind: string;
  severity: Severity;
  message: string;
  wire?: number;
}

interface Body {
  comp: CsxComponent;
  rect: Rect;
  pins: Vec2[];
}

function bodies(h: Harness): Body[] {
  return h.circuit().components.map((comp) => {
    const layout = compLayout(comp, h.doc.circuits);
    return {
      comp,
      rect: layout.rect,
      pins: layout.pins.map((p) => ({ x: p.x, y: p.y })),
    };
  });
}

/**
 * Every rule the router + document are supposed to hold after a gesture.
 *
 * `error` = a hard correctness violation the router must never produce:
 * structural geometry (a zero-length segment), an endpoint that does not sit on
 * its pin/free coordinate, a junction off its parent segment, a broken document
 * structure, or a broken net.
 *
 * `warn` = a rule the CURRENT editor does not guarantee everywhere. A diagonal
 * segment is intentional after the §65 segment-delete shortcut (but a router
 * route should never contain one). The rest come from routing one leg at a
 * time and only knowing the two bodies on that leg: a mid-path leg gets
 * `{dir:null, body:null}` at both ends, so it cannot see a body it passes; and
 * each leg's self-overlap check is local, so the assembled path can tangle.
 * These are reported so a failing case is legible and so the gaps are tracked —
 * see the `known limitations` tests.
 */
export function check(h: Harness, opts: { clear?: number } = {}): Violation[] {
  const clear = opts.clear ?? 0.5;
  const out: Violation[] = [];
  const wires = h.circuit().wires;
  const bb = bodies(h);

  const push = (kind: string, severity: Severity, message: string, wire?: number): void => {
    out.push({ kind, severity, message, ...(wire !== undefined && { wire }) });
  };

  wires.forEach((w, i) => {
    const pts = w.points.map((p) => ({ x: p[0], y: p[1] }));
    if (pts.length < 2) {
      push("wire-too-short", "error", `wire ${i} has ${pts.length} point(s)`, i);
      return;
    }
    for (let s = 0; s + 1 < pts.length; s++) {
      const ax = axisOf(pts[s], pts[s + 1]);
      if (ax === null) {
        // A diagonal is NOT a hard error: the router only emits orthogonal
        // routes, but the two-click segment delete (UI_OVERHAUL §65) deliberately
        // short-cuts with a diagonal — see document.test "removeSegment drops the
        // bend". Reported so it is visible, tracked as a warning.
        push("diagonal-segment", "warn", `wire ${i} segment ${s} is not axis-aligned`, i);
      } else if (samePoint(pts[s], pts[s + 1])) {
        push("zero-length-segment", "error", `wire ${i} segment ${s} has zero length`, i);
      }
    }
    if (selfOverlaps(pts)) {
      push("self-overlap", "warn", `wire ${i} crosses or overlaps itself`, i);
    }
    // User midpoints (v10) are provenance: each must still be a STRICT-INTERIOR
    // vertex of the route, or the model dropped/misplaced one.
    if (w.midpoints !== undefined) {
      const last = pts.length - 1;
      for (const m of w.midpoints) {
        const interior = pts.some(
          (p, k) => k > 0 && k < last && Math.abs(p.x - m[0]) < EPS && Math.abs(p.y - m[1]) < EPS,
        );
        if (!interior) {
          push(
            "midpoint-off-wire",
            "error",
            `wire ${i} midpoint (${m[0]}, ${m[1]}) is not an interior vertex of its route`,
            i,
          );
        }
      }
    }

    // Endpoint bookkeeping: the drawn path must start/end on the endpoint.
    const ends: { ep: CsxEndpoint; at: Vec2; which: string }[] = [
      { ep: w.a, at: pts[0], which: "a" },
      { ep: w.b, at: pts[pts.length - 1], which: "b" },
    ];
    for (const { ep, at, which } of ends) {
      if (isPinEndpoint(ep)) {
        const comp = h.circuit().components.find((c) => c.id === ep.comp);
        const pin =
          comp === undefined
            ? undefined
            : compLayout(comp, h.doc.circuits).pins.find((p) => p.name === ep.pin);
        if (pin === undefined) {
          push(
            "endpoint-mismatch",
            "error",
            `wire ${i} ${which} references a missing pin ${ep.comp}.${ep.pin}`,
            i,
          );
        } else if (Math.hypot(at.x - pin.x, at.y - pin.y) > EPS) {
          push(
            "endpoint-mismatch",
            "error",
            `wire ${i} ${which} is at (${at.x}, ${at.y}) but pin ${ep.comp}.${ep.pin} is at (${pin.x}, ${pin.y})`,
            i,
          );
        }
      } else if (isFreeEndpoint(ep)) {
        if (Math.hypot(at.x - ep.free[0], at.y - ep.free[1]) > EPS) {
          push(
            "endpoint-mismatch",
            "error",
            `wire ${i} ${which} free end does not match its coordinate`,
            i,
          );
        }
      } else if (isJoinEndpoint(ep)) {
        const parent = wires[ep.join.wire];
        const seg = ep.join.segment;
        if (parent === undefined || seg < 0 || seg + 1 >= parent.points.length) {
          push(
            "junction-off-segment",
            "error",
            `wire ${i} ${which} junctions onto an invalid parent segment`,
            i,
          );
        } else {
          const a = pointAt(parent.points, seg);
          const b = pointAt(parent.points, seg + 1);
          if (distToSeg(at, a, b) > 1e-6) {
            push(
              "junction-off-segment",
              "error",
              `wire ${i} ${which} junction (${at.x}, ${at.y}) is off wire ${ep.join.wire} segment ${seg}`,
              i,
            );
          }
        }
      }
    }

    // Body interaction: never drive through a part; keep `clear` from the rest.
    for (let s = 0; s + 1 < pts.length; s++) {
      for (const body of bb) {
        if (segOverlapsRect(pts[s], pts[s + 1], body.rect, 0)) {
          push(
            "body-crossing",
            "warn",
            `wire ${i} segment ${s} passes through the body of ${body.comp.id} (${body.comp.type})`,
            i,
          );
        } else if (segOverlapsRect(pts[s], pts[s + 1], body.rect, clear)) {
          const incident = body.pins.some((p) => samePoint(p, pts[s]) || samePoint(p, pts[s + 1]));
          if (!incident) {
            push(
              "body-clearance",
              "warn",
              `wire ${i} segment ${s} comes within ${clear} of ${body.comp.id} (${body.comp.type})`,
              i,
            );
          }
        }
      }
    }
  });

  // Two different wires must not run along the same copper for a stretch.
  for (let i = 0; i < wires.length; i++) {
    for (let j = i + 1; j < wires.length; j++) {
      for (let s = 0; s + 1 < wires[i].points.length; s++) {
        for (let t = 0; t + 1 < wires[j].points.length; t++) {
          const ov = collinearOverlap(
            pointAt(wires[i].points, s),
            pointAt(wires[i].points, s + 1),
            pointAt(wires[j].points, t),
            pointAt(wires[j].points, t + 1),
          );
          if (ov > 1e-6) {
            push(
              "wire-overlap",
              "warn",
              `wire ${i} overlaps wire ${j} for ${ov.toFixed(2)} units`,
              i,
            );
          }
        }
      }
    }
  }

  // Document-level structural validity + net derivation.
  for (const msg of h.doc.validateStructure()) push("structure", "error", msg);
  for (const msg of deriveNets(h.circuit()).errors) push("net-error", "error", msg);

  return out;
}

/** Convenience: just the hard violations. */
export function errors(h: Harness, opts?: { clear?: number }): Violation[] {
  return check(h, opts).filter((v) => v.severity === "error");
}

/* ------------------------------------------------------------------ */
/* debugging dumps                                                      */
/* ------------------------------------------------------------------ */

const WIRE_INK = [
  "#e6194b",
  "#3cb44b",
  "#4363d8",
  "#f58231",
  "#911eb4",
  "#42d4f4",
  "#f032e6",
  "#808000",
];

/** Render the whole harness scene (bodies, pins, wires, junctions) as SVG. */
export function toSvg(h: Harness, opts: { scale?: number; pad?: number } = {}): string {
  const scale = opts.scale ?? 14;
  const pad = opts.pad ?? 2;
  const wires = h.circuit().wires;
  const bb = bodies(h);

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const b of bb) {
    see(b.rect.x, b.rect.y);
    see(b.rect.x + b.rect.w, b.rect.y + b.rect.h);
  }
  for (const p of h.pins()) see(p.pos.x, p.pos.y);
  for (const w of wires) for (const p of w.points) see(p[0], p[1]);
  if (!Number.isFinite(minX)) {
    minX = 0;
    minY = 0;
    maxX = 10;
    maxY = 10;
  }
  const vx = minX - pad;
  const vy = minY - pad;
  const vw = maxX - minX + 2 * pad;
  const vh = maxY - minY + 2 * pad;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${vw} ${vh}" ` +
      `width="${vw * scale}" height="${vh * scale}" font-family="monospace" font-size="1.1">`,
  );
  parts.push(`<rect x="${vx}" y="${vy}" width="${vw}" height="${vh}" fill="#ffffff"/>`);
  for (const b of bb) {
    parts.push(
      `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.w}" height="${b.rect.h}" ` +
        `fill="#eef1f5" stroke="#556" stroke-width="0.15"/>`,
    );
    parts.push(
      `<text x="${b.rect.x + b.rect.w / 2}" y="${b.rect.y + b.rect.h / 2 + 0.4}" ` +
        `text-anchor="middle" fill="#334">${b.comp.id}:${b.comp.type}</text>`,
    );
  }
  for (const p of h.pins()) {
    parts.push(`<circle cx="${p.pos.x}" cy="${p.pos.y}" r="0.18" fill="#334"/>`);
  }
  wires.forEach((w, i) => {
    const pts = w.points.map((p) => `${p[0]},${p[1]}`).join(" ");
    const ink = WIRE_INK[i % WIRE_INK.length];
    parts.push(`<polyline points="${pts}" fill="none" stroke="${ink}" stroke-width="0.2"/>`);
    const [lx, ly] = w.points[0];
    parts.push(`<text x="${lx + 0.4}" y="${ly - 0.3}" fill="${ink}">w${i}</text>`);
    if (isJoinEndpoint(w.a))
      parts.push(`<circle cx="${w.points[0][0]}" cy="${w.points[0][1]}" r="0.28" fill="${ink}"/>`);
    if (isJoinEndpoint(w.b)) {
      const last = w.points[w.points.length - 1];
      parts.push(`<circle cx="${last[0]}" cy="${last[1]}" r="0.28" fill="${ink}"/>`);
    }
  });
  parts.push("</svg>");
  return parts.join("\n");
}

/**
 * A coarse ASCII view of the scene for terminal debugging. One character per
 * `step` world units; later glyphs overwrite earlier ones so pins and junctions
 * stay visible over the copper.
 */
export function toAscii(h: Harness, opts: { step?: number; maxCols?: number } = {}): string {
  const step = opts.step ?? 0.5;
  const maxCols = opts.maxCols ?? 160;
  const wires = h.circuit().wires;
  const bb = bodies(h);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const see = (x: number, y: number): void => {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  };
  for (const b of bb) {
    see(b.rect.x, b.rect.y);
    see(b.rect.x + b.rect.w, b.rect.y + b.rect.h);
  }
  for (const w of wires) for (const p of w.points) see(p[0], p[1]);
  if (!Number.isFinite(minX)) return "(empty scene)";
  const cols = Math.min(maxCols, Math.ceil((maxX - minX) / step) + 2);
  const rows = Math.ceil((maxY - minY) / step) + 2;
  const grid: string[][] = Array.from({ length: rows }, () =>
    Array.from({ length: cols }, () => " "),
  );
  const put = (x: number, y: number, ch: string): void => {
    const cx = Math.round((x - minX) / step) + 1;
    const cy = Math.round((y - minY) / step) + 1;
    if (cy >= 0 && cy < rows && cx >= 0 && cx < cols) grid[cy][cx] = ch;
  };
  // Wires first (lowest priority).
  wires.forEach((w, i) => {
    const ch = String.fromCharCode(97 + (i % 26)); // a, b, c…
    for (let s = 0; s + 1 < w.points.length; s++) {
      const a = pointAt(w.points, s);
      const b = pointAt(w.points, s + 1);
      const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
      for (let k = 0; k <= steps; k++) {
        put(a.x + ((b.x - a.x) * k) / steps, a.y + ((b.y - a.y) * k) / steps, ch);
      }
    }
  });
  // Body edges.
  for (const b of bb) {
    for (let x = b.rect.x; x <= b.rect.x + b.rect.w + EPS; x += step) {
      put(x, b.rect.y, "#");
      put(x, b.rect.y + b.rect.h, "#");
    }
    for (let y = b.rect.y; y <= b.rect.y + b.rect.h + EPS; y += step) {
      put(b.rect.x, y, "#");
      put(b.rect.x + b.rect.w, y, "#");
    }
  }
  // Pins on top.
  for (const p of h.pins()) put(p.pos.x, p.pos.y, "o");
  // Junction dots.
  for (const w of wires) {
    for (const ep of [w.a, w.b]) {
      if (!isJoinEndpoint(ep)) continue;
      const at = ep === w.a ? w.points[0] : w.points[w.points.length - 1];
      put(at[0], at[1], "*");
    }
  }
  let out = "";
  for (let y = 0; y < rows; y++) out += grid[y].join("").replace(/\s+$/, "") + "\n";
  return out;
}

/** A one-line-ish human report for a failing case (violations + ASCII view). */
export function report(h: Harness, violations: readonly Violation[]): string {
  const lines = violations.map((v) => `[${v.severity}] ${v.kind}: ${v.message}`);
  return [lines.join("\n") || "(no violations)", "", toAscii(h)].join("\n");
}

/* ------------------------------------------------------------------ */
/* deterministic generation                                             */
/* ------------------------------------------------------------------ */

/** A small linear congruential generator — reproducible corpora. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function shuffle<T>(items: T[], rnd: () => number): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i];
    a[i] = a[j];
    a[j] = tmp;
  }
  return a;
}

/** Gate families with 2–3 pins, safe to place near others. */
const GEN_TYPES = ["gate.and", "gate.or", "gate.xor", "gate.not", "gate.buffer", "gate.nand"];

export interface GeneratedCase {
  seed: number;
  scene: HarnessScene;
  script: HarnessStep[];
}

/**
 * Build one random case: a handful of well-separated gates, then a scripted
 * gesture that routes one or two wires between their pins, with 0–3 mid-path
 * clicks and (sometimes) a junction drop onto the first wire.
 *
 * Components are kept far apart on a coarse grid (as `route.test.ts` does) so
 * the corpus tests the router's choices, not pathological overlapping bodies.
 */
export function generateCase(seed: number): GeneratedCase {
  const rnd = lcg(seed);
  const cols = 3;
  const rows = 3;
  const cells = shuffle(
    Array.from({ length: cols * rows }, (_, i) => i),
    rnd,
  );
  const n = 2 + Math.floor(rnd() * 4); // 2..5 components
  const components: HarnessComp[] = [];
  for (let i = 0; i < n; i++) {
    const cell = cells[i];
    const col = cell % cols;
    const row = Math.floor(cell / cols);
    components.push({
      label: `g${i}`,
      type: GEN_TYPES[Math.floor(rnd() * GEN_TYPES.length)],
      pos: [4 + col * 14, 4 + row * 10],
    });
  }
  const scene: HarnessScene = { components };
  const h = buildHarness(scene);
  const pins = h.pins();
  const bodyRects = h.circuit().components.map((c) => compLayout(c, h.doc.circuits).rect);

  const pick = <T>(arr: T[]): T => arr[Math.floor(rnd() * arr.length)];
  /** A click in genuinely free space (clear of every pin and body). */
  const freePoint = (): Vec2 | null => {
    for (let tries = 0; tries < 30; tries++) {
      const cand = {
        x: 2 + Math.floor(rnd() * (14 * cols)),
        y: 2 + Math.floor(rnd() * (10 * rows)),
      };
      const clearPins = pins.every((p) => Math.hypot(p.pos.x - cand.x, p.pos.y - cand.y) > 2);
      const clearBodies = bodyRects.every(
        (r) =>
          cand.x <= r.x - 1 ||
          cand.x >= r.x + r.w + 1 ||
          cand.y <= r.y - 1 ||
          cand.y >= r.y + r.h + 1,
      );
      if (clearPins && clearBodies) return cand;
    }
    return null;
  };
  const waypoints = (): HarnessStep[] => {
    const steps: HarnessStep[] = [];
    const count = Math.floor(rnd() * 4); // 0..3 planted bends
    for (let k = 0; k < count; k++) {
      const p = freePoint();
      if (p === null) break;
      steps.push({ kind: "move", at: p }, { kind: "click", at: p });
    }
    return steps;
  };

  const start = pick(pins);
  const end = pick(pins.filter((p) => p.ref !== start.ref));
  const script: HarnessStep[] = [
    { kind: "click", at: start.ref },
    ...waypoints(),
    { kind: "click", at: end.ref },
  ];

  // Half the cases add a branch that junctions onto the first wire.
  if (rnd() < 0.5) {
    const first = buildHarness(scene);
    runScript(first, script);
    const wires = first.wires();
    if (wires.length > 0) {
      const w0 = wires[0];
      const seg = Math.floor(rnd() * Math.max(1, w0.points.length - 1));
      const a = pointAt(w0.points, seg);
      const b = pointAt(w0.points, Math.min(seg + 1, w0.points.length - 1));
      const target = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const branchStart = pick(pins.filter((p) => p.ref !== start.ref && p.ref !== end.ref));
      if (branchStart !== undefined) {
        script.push(
          { kind: "click", at: branchStart.ref },
          { kind: "move", at: target },
          { kind: "click", at: target },
        );
      }
    }
  }

  return { seed, scene, script };
}

/** Rebuild a generated case and return the live harness for inspection. */
export function materialize(c: GeneratedCase): Harness {
  const h = buildHarness(c.scene);
  runScript(h, c.script);
  return h;
}

/* ------------------------------------------------------------------ */
/* gesture fuzzer — "every silly thing a student might do"              */
/* ------------------------------------------------------------------ */

/** Part types a fuzzer may place (all size/geometry-safe with default attrs). */
const FUZZ_TYPES = [
  "gate.and",
  "gate.or",
  "gate.xor",
  "gate.nand",
  "gate.nor",
  "gate.xnor",
  "gate.not",
  "gate.buffer",
  "arith.adder",
  "arith.subtractor",
  "arith.comparator",
  "arith.negator",
  "arith.shifter",
  "arith.multiplier",
  "arith.divider",
  "plexers.mux",
  "plexers.decoder",
  "plexers.demux",
  "mem.register",
  "mem.ram",
  "mem.rom",
  "io.led",
  "io.hexdisplay",
  "io.button",
  "wiring.probe",
  "wiring.constant",
  "wiring.clock",
  "wiring.reset",
  "wiring.splitter",
  "wiring.transistor",
  "wiring.power",
  "wiring.ground",
  "wiring.pin",
  "debug.breakpoint",
];

/** A random, possibly-overlapping starting scene (students overlap parts). */
export function fuzzScene(rnd: () => number): HarnessScene {
  const n = 2 + Math.floor(rnd() * 5); // 2..6 parts
  const components: HarnessComp[] = [];
  for (let i = 0; i < n; i++) {
    components.push({
      label: `g${i}`,
      type: FUZZ_TYPES[Math.floor(rnd() * FUZZ_TYPES.length)],
      pos: [Math.round(rnd() * 30), Math.round(rnd() * 20)],
    });
  }
  return { components };
}

export interface FuzzFailure {
  /** Index into the flat step history. */
  index: number;
  step: HarnessStep;
  detail: string;
}

export interface FuzzResult {
  seed: number;
  h: Harness;
  history: HarnessStep[];
  /** Steps that threw (should be none — the machine must absorb confusion). */
  crashes: FuzzFailure[];
  /** Hard-invariant violations (see `check`) observed after a step. */
  violations: FuzzFailure[];
}

const FACES: Rotation[] = ["N", "E", "S", "W"];

/**
 * One random gesture, drawn from what the scene can currently support. Covers
 * the whole pointer + command surface: click-click and drag wiring, junctions,
 * bends, segment slides, cancel/flip/free finishes, shift/right-click, and the
 * component commands (rotate/delete/copy/paste/place), including combinations
 * that make no sense (delete mid-wire, finish on the start pin, right-click
 * while placing…). Targets are resolved to concrete points at draw time so a
 * mutation mid-corpus can never dangle a reference.
 */
export function randomGesture(h: Harness, rnd: () => number): HarnessStep[] {
  const pick = <T>(arr: readonly T[]): T | undefined =>
    arr.length === 0 ? undefined : arr[Math.floor(rnd() * arr.length)];
  const pins = h.pins();
  const wires = h.wires();
  const comps = h.circuit().components;

  const freePos = (): Vec2 => ({ x: Math.round(rnd() * 40 - 4), y: Math.round(rnd() * 32 - 4) });
  const pinPos = (): Vec2 | undefined => pick(pins)?.pos;
  const bodyPos = (): Vec2 | undefined => {
    const c = pick(comps);
    if (c === undefined) return undefined;
    const r = compLayout(c, h.doc.circuits).rect;
    return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  };
  const wireMid = (): Vec2 | undefined => {
    const w = pick(wires);
    if (w === undefined) return undefined;
    const seg = Math.floor(rnd() * Math.max(1, w.points.length - 1));
    const a = w.points[seg];
    const b = w.points[Math.min(seg + 1, w.points.length - 1)];
    return { x: (a[0] + b[0]) / 2, y: (a[1] + b[1]) / 2 };
  };
  const wireCorner = (): Vec2 | undefined => {
    const w = pick(wires);
    if (w === undefined || w.points.length < 3) return undefined;
    const k = 1 + Math.floor(rnd() * (w.points.length - 2));
    return { x: w.points[k][0], y: w.points[k][1] };
  };
  const target = (): Vec2 => {
    const r = rnd();
    if (r < 0.4) return pinPos() ?? freePos();
    if (r < 0.6) return wireMid() ?? freePos();
    if (r < 0.8) return bodyPos() ?? freePos();
    return freePos();
  };
  const dragTo = (from: Vec2): HarnessStep[] => {
    const to = freePos();
    return [
      { kind: "down", at: from },
      { kind: "move", at: to },
      { kind: "up", at: to },
    ];
  };

  const gestures: (() => HarnessStep[])[] = [
    // Single clicks all over the place.
    () => [{ kind: "click", at: target() }],
    () => [{ kind: "click", at: freePos() }],
    () => [{ kind: "click", at: target(), shift: true }],
    () => [{ kind: "click", at: target(), ctrl: true }],
    () => [{ kind: "click", at: target(), button: 2 }],
    () => [{ kind: "doubleClick", at: bodyPos() ?? freePos() }],
    () => [{ kind: "hover", at: target() }],
    // Raw drags: move parts, box-select, slide segments.
    () => dragTo(target()),
    () => dragTo(pinPos() ?? freePos()),
    () => dragTo(wireMid() ?? freePos()),
    () => dragTo(wireCorner() ?? freePos()),
    // Select a wire, then sweep its segment (the slide gesture).
    () => {
      const m = wireMid() ?? freePos();
      return [{ kind: "click", at: m }, ...dragTo(m)];
    },
    // Drag off a pin to a target (drag-wiring).
    () => {
      const to = target();
      return [
        { kind: "down", at: pinPos() ?? freePos() },
        { kind: "move", at: to },
        { kind: "up", at: to },
      ];
    },
    // Click-click wiring with 0–2 waypoints, finishing on any target.
    () => {
      const out: HarnessStep[] = [{ kind: "click", at: pinPos() ?? freePos() }];
      const count = Math.floor(rnd() * 3);
      for (let k = 0; k < count; k++)
        out.push({ kind: "move", at: freePos() }, { kind: "click", at: freePos() });
      out.push({ kind: "click", at: target() });
      return out;
    },
    // Wire from a junction point on an existing wire to a pin.
    () => {
      const out: HarnessStep[] = [{ kind: "click", at: wireMid() ?? freePos() }];
      out.push({ kind: "move", at: target() });
      out.push({ kind: "click", at: target() });
      return out;
    },
    // Wire, flip, cancel.
    () => [{ kind: "click", at: pinPos() ?? freePos() }, { kind: "flip" }, { kind: "cancel" }],
    // Wire, then finish as a hanging free end.
    () => [
      { kind: "click", at: pinPos() ?? freePos() },
      { kind: "move", at: freePos() },
      { kind: "finishFree" },
    ],
    // Finish on the start pin (invalid self-loop) / double-finish.
    () => {
      const p = pinPos() ?? freePos();
      return [
        { kind: "click", at: p },
        { kind: "click", at: p },
        { kind: "click", at: p },
      ];
    },
    // Commands, including nonsensical combinations.
    () => [{ kind: "rotate" }],
    () => [{ kind: "rotate", ccw: true }],
    () => [{ kind: "face", rot: pick(FACES) ?? "E" }],
    () => [{ kind: "delete" }],
    () => [{ kind: "copy" }, { kind: "paste" }],
    () => [{ kind: "cut" }, { kind: "paste" }],
    () => [{ kind: "selectAll" }, { kind: "copy" }, { kind: "paste" }],
    () => [{ kind: "selectAll" }, { kind: "delete" }],
    () => [{ kind: "place", type: pick(FUZZ_TYPES) ?? "gate.and", at: freePos() }],
    () => [
      {
        kind: "place",
        type: pick(FUZZ_TYPES) ?? "gate.and",
        at: target(),
        rot: pick(FACES) ?? "E",
      },
    ],
    () => [
      { kind: "startPlacing", type: pick(FUZZ_TYPES) ?? "gate.and", sticky: true },
      { kind: "cancel" },
    ],
    // Inspector edits: an attrs change can RESIZE a part and move its edge pins.
    () => {
      const c = pick(comps);
      if (c === undefined) return [{ kind: "face", rot: pick(FACES) ?? "E" }];
      const r = rnd();
      if (r < 0.4)
        return [
          {
            kind: "edit",
            id: c.id,
            patch: { attrs: { ...(c.attrs ?? {}), bitsize: 1 + Math.floor(rnd() * 32) } },
          },
        ];
      if (r < 0.6)
        return [
          {
            kind: "edit",
            id: c.id,
            patch: { attrs: { ...(c.attrs ?? {}), value: String(Math.floor(rnd() * 100)) } },
          },
        ];
      if (r < 0.8) return [{ kind: "edit", id: c.id, patch: { rot: pick(FACES) ?? "E" } }];
      return [{ kind: "edit", id: c.id, patch: { type: pick(FUZZ_TYPES) ?? "gate.and" } }];
    },
    // Confused: start wiring, wander, command, then keep wiring.
    () => [
      { kind: "click", at: pinPos() ?? freePos() },
      { kind: "move", at: freePos() },
      { kind: "click", at: freePos() },
      { kind: "rotate" },
      { kind: "click", at: freePos() },
      { kind: "cancel" },
    ],
  ];

  return (pick(gestures) ?? gestures[0])();
}

/**
 * Run `steps` random gestures against a random scene. Never throws: a throwing
 * step is recorded as a crash (the editor is supposed to swallow confusion),
 * and the hard invariants are re-checked after every step.
 */
export function fuzz(seed: number, steps = 40): FuzzResult {
  const rnd = lcg(seed);
  const h = buildHarness(fuzzScene(rnd));
  const history: HarnessStep[] = [];
  const crashes: FuzzFailure[] = [];
  const violations: FuzzFailure[] = [];
  for (let i = 0; i < steps; i++) {
    for (const s of randomGesture(h, rnd)) {
      const at = history.length;
      try {
        applyStep(h, s);
      } catch (e) {
        crashes.push({ index: at, step: s, detail: String(e) });
      }
      history.push(s);
      try {
        for (const v of errors(h)) {
          violations.push({ index: at, step: s, detail: `${v.kind}: ${v.message}` });
        }
      } catch (e) {
        crashes.push({ index: at, step: s, detail: `check threw: ${String(e)}` });
      }
    }
  }
  return { seed, h, history, crashes, violations };
}

/** A readable dump of a fuzz failure: the offending steps + the final scene. */
export function describeFuzz(f: FuzzResult, failures: readonly FuzzFailure[]): string {
  const lines = failures.map(
    (fail) => `step ${fail.index}: ${JSON.stringify(fail.step)}\n  ${fail.detail}`,
  );
  return [...lines, "", toAscii(f.h)].join("\n");
}

/* ------------------------------------------------------------------ */
/* history fuzzer — undo/redo must round-trip every gesture             */
/* ------------------------------------------------------------------ */

export interface HistoryResult {
  seed: number;
  /** How many undo/redo steps the sequence produced. */
  depth: number;
  /** Human-readable round-trip failures (empty when the history is sound). */
  mismatches: string[];
}

function circuitSnapshot(h: Harness): string {
  return JSON.stringify(h.doc.circuits);
}

/**
 * Run `steps` random gestures, then undo the whole history and redo it,
 * checking that the document returns EXACTLY to the baseline and the final
 * state respectively. Undo/redo corruption is otherwise invisible until a user
 * hits Ctrl-Z after an odd sequence.
 */
export function fuzzHistory(seed: number, steps = 40): HistoryResult {
  const rnd = lcg(seed);
  const h = buildHarness(fuzzScene(rnd));
  h.doc.clearHistory();
  const baseline = circuitSnapshot(h);
  for (let i = 0; i < steps; i++) {
    for (const s of randomGesture(h, rnd)) {
      try {
        applyStep(h, s);
      } catch {
        // a swallowed gesture is fine here; we only care about the history
      }
    }
  }
  const depth = h.doc.historyDepth;
  const final = circuitSnapshot(h);

  const mismatches: string[] = [];
  let guard = depth + 10;
  while (h.doc.canUndo && guard-- > 0) h.doc.undo();
  if (guard <= 0) mismatches.push("undo never drained the history");
  if (circuitSnapshot(h) !== baseline) mismatches.push("undo did not restore the baseline");

  guard = depth + 10;
  while (h.doc.canRedo && guard-- > 0) h.doc.redo();
  if (guard <= 0) mismatches.push("redo never drained the history");
  if (circuitSnapshot(h) !== final) mismatches.push("redo did not restore the final state");

  return { seed, depth, mismatches };
}
