import type { CircuitDocument } from "../model/document";
import type { CsxComponent, CsxWire } from "../model/csx";
import { isPinEndpoint } from "../model/csx";
import { deriveNets, type NetDerivation } from "../model/nets";
import type { SelectionModel } from "../model/selection";
import type { Camera, ViewSize } from "../render/camera";
import {
  distToSegment,
  inflateRect,
  pointsBounds,
  rectIntersects,
  type Rect,
  type Vec2,
} from "../render/geom";
import { rectPath, roundedPath } from "../render/paths";
import type { PathCmd, Renderer } from "../render/renderer";
import { UniformGrid } from "../render/spatial";
import type { Theme } from "../render/theme";
import { compLayout, type CompLayout } from "./layout";
import { compSpec } from "./catalog";

/**
 * DocScene (FRONTEND.md U3): draws a CircuitDocument circuit and answers
 * hit-tests. Rebuilds its draw model (layouts, batched paths, spatial
 * indexes, net derivation) only when (doc revision, circuit index)
 * changes — editing-scale circuits make rebuilds sub-millisecond.
 *
 * Wire coloring pre-integration: everything is "disconnected" (neutral)
 * until U5 streams real net states; selection/hover/net-extent highlights
 * layer on top.
 */

export type PinHit = { kind: "pin"; compId: string; pin: string; pos: Vec2 };
export type WireHit = { kind: "wire"; wireIdx: number; segment: number; point: Vec2 };
export type CompHit = { kind: "component"; compId: string };
export type Hit = PinHit | WireHit | CompHit;

/** Transient render state owned by the tool machine (ghosts + hover). */
export interface SceneOverlay {
  hoverHit: Hit | null;
  /** Wire currently being routed (points so far + cursor). */
  wireInProgress: Vec2[] | null;
  /** Component type being placed + ghost position. */
  placing: { type: string; pos: Vec2; rot: CsxComponent["rot"] } | null;
  /** Box-select rectangle in progress. */
  boxRect: Rect | null;
}

const CELL = 8;
const WIRE_RADIUS = 0.12;
const WIRE_W = 0.16;
const PIN_R = 0.22;
const PICK_TOL = 0.45;
const PIN_TOL = 0.55;

export class DocScene {
  private circuitIdx = -1;
  private revision = -1;
  private layouts = new Map<string, CompLayout>();
  private components: CsxComponent[] = [];
  private wires: CsxWire[] = [];
  private wirePaths: PathCmd[][] = [];
  /** Junction dot positions per wire (at its own join endpoints). */
  private junctionDots: Vec2[] = [];
  private wireIndex = new UniformGrid(CELL);
  private nets: NetDerivation = { nets: [], wireToNet: new Map(), pinToNet: new Map(), errors: [] };
  bounds: Rect = { x: 0, y: 0, w: 100, h: 60 };

  /** Rebuild the draw model if the document (or open circuit) changed. */
  sync(doc: CircuitDocument, circuitIdx: number): void {
    if (doc.revision === this.revision && circuitIdx === this.circuitIdx) return;
    this.revision = doc.revision;
    this.circuitIdx = circuitIdx;
    const c = doc.circuit(circuitIdx);
    this.components = c.components;
    this.wires = c.wires;
    this.layouts = new Map(c.components.map((x) => [x.id, compLayout(x)]));
    this.wirePaths = c.wires.map((w) => roundedPath(w.points.map(p2v), WIRE_RADIUS));
    this.junctionDots = [];
    for (const w of c.wires) {
      if (!isPinEndpoint(w.b)) this.junctionDots.push(p2v(w.points[w.points.length - 1]));
      if (!isPinEndpoint(w.a)) this.junctionDots.push(p2v(w.points[0]));
    }
    this.wireIndex = new UniformGrid(CELL);
    c.wires.forEach((w, i) => {
      for (let s = 0; s + 1 < w.points.length; s++) {
        this.wireIndex.insert(i, pointsBounds([p2v(w.points[s]), p2v(w.points[s + 1])]));
      }
    });
    this.nets = deriveNets(c);
    this.bounds = computeBounds(
      c.components.map((x) => this.layouts.get(x.id)!.rect),
      c.wires,
    );
  }

  // ---- hit testing ----

  /** Nearest pin within tolerance (for wiring start/finish + hover). */
  pickPin(world: Vec2, tol = PIN_TOL): PinHit | null {
    let best: { d: number; compId: string; pin: string; pos: Vec2 } | null = null;
    for (const [id, layout] of this.layouts) {
      for (const p of layout.pins) {
        const d = Math.hypot(world.x - p.x, world.y - p.y);
        if (d <= tol && (best === null || d < best.d)) {
          best = { d, compId: id, pin: p.name, pos: { x: p.x, y: p.y } };
        }
      }
    }
    return best === null
      ? null
      : { kind: "pin", compId: best.compId, pin: best.pin, pos: best.pos };
  }

  /** Nearest wire segment within tolerance (junction placement + selection). */
  pickWire(world: Vec2, tol = PICK_TOL): WireHit | null {
    const candidates = this.wireIndex.queryRect(inflateRect(pointRect(world), tol));
    let best: { d: number; wireIdx: number; segment: number; point: Vec2 } | null = null;
    for (const i of candidates) {
      const pts = this.wires[i].points;
      for (let s = 0; s + 1 < pts.length; s++) {
        const a = p2v(pts[s]);
        const b = p2v(pts[s + 1]);
        const d = distToSegment(world, a, b);
        if (d <= tol && (best === null || d < best.d)) {
          best = { d, wireIdx: i, segment: s, point: nearestOnSegment(world, a, b) };
        }
      }
    }
    return best === null ? null : { kind: "wire", ...best };
  }

  /** Topmost component body under the point (for dragging/selecting). */
  pickComponent(world: Vec2): CompHit | null {
    for (let i = this.components.length - 1; i >= 0; i--) {
      const comp = this.components[i];
      const rect = this.layouts.get(comp.id)!.rect;
      if (
        world.x >= rect.x &&
        world.x <= rect.x + rect.w &&
        world.y >= rect.y &&
        world.y <= rect.y + rect.h
      ) {
        return { kind: "component", compId: comp.id };
      }
    }
    return null;
  }

  /** Pins-first picking (what the pointer means at this spot). */
  pick(world: Vec2): Hit | null {
    return this.pickPin(world) ?? this.pickWire(world) ?? this.pickComponent(world);
  }

  /** Everything intersecting a world rect (box select). */
  pickRect(rect: Rect): { components: string[]; wires: number[] } {
    const components = this.components
      .filter((x) => rectIntersects(this.layouts.get(x.id)!.rect, rect))
      .map((x) => x.id);
    const wires = this.wireIndex
      .queryRect(rect)
      .filter((i) => rectIntersects(pointsBounds(this.wires[i].points.map(p2v)), rect));
    return { components, wires };
  }

  netOfWire(wireIdx: number): number | undefined {
    return this.nets.wireToNet.get(wireIdx);
  }

  netOfPin(compId: string, pin: string): number | undefined {
    return this.nets.pinToNet.get(`${compId}:${pin}`);
  }

  wiresInNet(netId: number): readonly number[] {
    return this.nets.nets[netId]?.wires ?? [];
  }

  // ---- drawing ----

  draw(
    renderer: Renderer,
    theme: Theme,
    camera: Camera,
    view: ViewSize,
    selection: SelectionModel,
    overlay: SceneOverlay,
  ): void {
    const visible = inflateRect(camera.visibleWorldRect(view), 2);

    // net-extent highlight set
    let highlightWires: Set<number> | null = null;
    if (overlay.hoverHit !== null) {
      const netId =
        overlay.hoverHit.kind === "wire"
          ? this.netOfWire(overlay.hoverHit.wireIdx)
          : overlay.hoverHit.kind === "pin"
            ? this.netOfPin(overlay.hoverHit.compId, overlay.hoverHit.pin)
            : undefined;
      if (netId !== undefined) highlightWires = new Set(this.wiresInNet(netId));
    }

    // Wires layer.
    const wireIds = this.wireIndex.queryRect(visible);
    for (const i of wireIds) {
      const selected = selection.hasWire(i);
      renderer.drawPath(this.wirePaths[i], {
        stroke: selected ? theme.accent : theme.wire.disconnected,
        lineWidth: selected ? WIRE_W * 1.8 : WIRE_W,
      });
    }
    renderer.flush();
    // Net-extent highlight pass (hover brighten, DESIGN.md §7.1).
    if (highlightWires !== null) {
      for (const i of highlightWires) {
        renderer.drawPath(this.wirePaths[i], { stroke: theme.accent, lineWidth: WIRE_W * 2.2 });
      }
      renderer.flush();
    }

    // Components layer.
    const pinDots: Vec2[] = [];
    for (const comp of this.components) {
      const layout = this.layouts.get(comp.id)!;
      if (!rectIntersects(layout.rect, visible)) continue;
      const selected = selection.hasComponent(comp.id);
      renderer.drawPath(rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h), {
        fill: theme.panel,
      });
      renderer.drawPath(rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h), {
        stroke: selected ? theme.accent : theme.panelBorder,
        lineWidth: selected ? 0.22 : 0.12,
      });
      const spec = compSpec(comp.type);
      const caption =
        comp.name !== undefined && comp.name !== "" ? comp.name : spec.caption(comp.attrs ?? {});
      renderer.drawText(
        layout.rect.x + layout.rect.w / 2,
        layout.rect.y + layout.rect.h / 2,
        caption,
        {
          color: theme.textDim,
          size: 1.0,
          align: "center",
        },
      );
      for (const p of layout.pins) pinDots.push({ x: p.x, y: p.y });
    }
    renderer.flush();
    renderer.drawDots(pinDots, PIN_R, theme.textDim);
    // Hovered pin gets an accent ring-dot.
    if (overlay.hoverHit?.kind === "pin") {
      renderer.drawDots([overlay.hoverHit.pos], PIN_R * 1.5, theme.accent);
    }

    // Junction dots.
    renderer.drawDots(this.junctionDots, PIN_R * 1.1, theme.wire.disconnected);

    // Tool ghosts.
    if (overlay.wireInProgress !== null && overlay.wireInProgress.length >= 2) {
      renderer.drawPath(roundedPath(overlay.wireInProgress, WIRE_RADIUS), {
        stroke: theme.accent,
        lineWidth: WIRE_W,
      });
      renderer.flush();
    }
    if (overlay.placing !== null) {
      const ghost: CsxComponent = {
        id: "$ghost",
        type: overlay.placing.type,
        pos: [overlay.placing.pos.x, overlay.placing.pos.y],
        rot: overlay.placing.rot ?? "E",
      };
      const layout = compLayout(ghost);
      renderer.drawPath(rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h), {
        stroke: theme.accent,
        lineWidth: 0.15,
      });
      renderer.flush();
      renderer.drawDots(
        layout.pins.map((p) => ({ x: p.x, y: p.y })),
        PIN_R,
        theme.accent,
      );
    }
    if (overlay.boxRect !== null) {
      const r = overlay.boxRect;
      renderer.drawPath(rectPath(r.x, r.y, r.w, r.h), { fill: "rgba(91,141,239,0.15)" });
      renderer.drawPath(rectPath(r.x, r.y, r.w, r.h), { stroke: theme.accent, lineWidth: 0.08 });
      renderer.flush();
    }

    // Junction marker on the wire the cursor is over (junction-on-drop preview).
    if (overlay.hoverHit?.kind === "wire") {
      renderer.drawDots([overlay.hoverHit.point], PIN_R * 1.3, theme.accent);
    }
  }
}

function p2v(p: [number, number]): Vec2 {
  return { x: p[0], y: p[1] };
}

function pointRect(p: Vec2): Rect {
  return { x: p.x, y: p.y, w: 0, h: 0 };
}

function nearestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const lenSq = abx * abx + aby * aby;
  if (lenSq === 0) return a;
  let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / lenSq;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + t * abx, y: a.y + t * aby };
}

function computeBounds(rects: Rect[], wires: CsxWire[]): Rect {
  let minX = 0;
  let minY = 0;
  let maxX = 100;
  let maxY = 60;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  for (const w of wires) {
    const b = pointsBounds(w.points.map(p2v));
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  const pad = 20;
  return { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
}
