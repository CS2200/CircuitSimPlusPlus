import type { CircuitDocument } from "../model/document";
import type { CsxComponent, CsxWire } from "../model/csx";
import { isPinEndpoint } from "../model/csx";
import { deriveNets, type NetDerivation, type NetInfo } from "../model/nets";
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
import type { PathCmd, Renderer, WireState } from "../render/renderer";
import { UniformGrid } from "../render/spatial";
import type { Theme } from "../render/theme";
import type { WireValue } from "../ipc/types";
import { formatValue, type ValueMode } from "../sim/controller";
import { compLayout, type CompLayout } from "./layout";
import { compSize, compSpec } from "./catalog";
import { BUBBLE_R, circlePath, gateShape, rotatePath } from "./shapes";

/**
 * DocScene (FRONTEND.md U3): draws a CircuitDocument circuit and answers
 * hit-tests. Rebuilds its draw model (layouts, batched paths, spatial
 * indexes, net derivation) only when (doc revision, circuit index)
 * changes — editing-scale circuits make rebuilds sub-millisecond.
 *
 * Wire coloring: pre-load everything is "disconnected" (neutral); when a
 * sim session is loaded (U5) the `sim` draw argument supplies per-wire
 * values and wires render in state colors (buses keep rainbow hues unless
 * X/Z). Selection/hover/net-extent highlights layer on top.
 */

/** Sim state overlay for one draw pass (U5). */
export interface SimOverlay {
  /** Latest value of the engine net containing this wire, if any. */
  valueForWire(wireIdx: number): WireValue | undefined;
  /** Document component id to ring in the error color (halt marker). */
  haltCompId?: string | null;
}

/** Collapse a 4-state value to a render state (X dominates, then Z). */
export function wireValueState(val: WireValue): WireState {
  if (maskNonzero(val.x)) return "x";
  if (maskNonzero(val.z) && !maskNonzero(val.v)) return "z";
  return maskNonzero(val.v) ? "high" : "low";
}

function maskNonzero(hex: string): boolean {
  return hex !== "" && BigInt(`0x${hex}`) !== 0n;
}

/** Probe `display` attr → watch value mode (default hex). */
function probeDisplayMode(attr: unknown): ValueMode {
  return attr === "unsigned" || attr === "signed" || attr === "hex" ? attr : "hex";
}

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
  /** Shift-click wire info card: which wire + where to anchor the card. */
  wireInfo: { wireIdx: number; pos: Vec2 } | null;
}

const CELL = 8;
const WIRE_RADIUS = 0.12;
const WIRE_W = 0.16;
const WIRE_BUS = 0.3;
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
  private wireNetId: (number | undefined)[] = [];
  private wireBits: number[] = [];
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
    this.wireNetId = c.wires.map((_, i) => this.nets.wireToNet.get(i));
    this.wireBits = c.wires.map((_, i) => {
      const netId = this.nets.wireToNet.get(i);
      const net = netId !== undefined ? this.nets.nets[netId] : undefined;
      const inf = inferNetBits(net, this.layouts);
      return inf.conflict.length > 0 ? 1 : (inf.bits ?? 1);
    });
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
    sim?: SimOverlay,
  ): void {
    const visible = inflateRect(camera.visibleWorldRect(view), 2);

    // Net-extent highlight: on PIN hover (the no-tunnels navigability
    // feature, DESIGN.md §7.1) and for the wire info card. Idle wire hover
    // does nothing (UX decision).
    let highlightWires: Set<number> | null = null;
    {
      const netId =
        overlay.hoverHit?.kind === "pin"
          ? this.netOfPin(overlay.hoverHit.compId, overlay.hoverHit.pin)
          : overlay.wireInfo !== null
            ? this.netOfWire(overlay.wireInfo.wireIdx)
            : undefined;
      if (netId !== undefined) highlightWires = new Set(this.wiresInNet(netId));
    }

    // Wires layer: single-bit wires in state colors; buses rainbow-hued
    // per net + thicker (DLS look, DESIGN.md §7.1 / D8). With a sim
    // loaded, state colors come from the streamed values (buses keep hues
    // unless X/Z — hue is identity, state color is value).
    const wireIds = this.wireIndex.queryRect(visible);
    for (const i of wireIds) {
      const selected = selection.hasWire(i);
      const isBus = this.wireBits[i] > 1;
      const hue = this.wireNetId[i] ?? i;
      const simVal = sim?.valueForWire(i);
      let stroke: string;
      if (selected) {
        stroke = theme.accent;
      } else if (simVal !== undefined) {
        const state = wireValueState(simVal);
        stroke =
          isBus && state !== "x" && state !== "z"
            ? theme.bus[hue % theme.bus.length]
            : theme.wire[state];
      } else {
        stroke = isBus ? theme.bus[hue % theme.bus.length] : theme.wire.disconnected;
      }
      renderer.drawPath(this.wirePaths[i], {
        stroke,
        lineWidth: selected ? WIRE_W * 1.8 : isBus ? WIRE_BUS : WIRE_W,
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
      const strokeStyle = {
        stroke: selected ? theme.accent : theme.panelBorder,
        lineWidth: selected ? 0.22 : 0.12,
      };
      // Distinctive shape (local EAST frame → rotated about the center), or a box.
      const local = compSize(comp);
      const shape = gateShape(comp.type, layout.rect.x, layout.rect.y, local.w, local.h);
      const rot = comp.rot ?? "E";
      const cx = layout.rect.x + layout.rect.w / 2;
      const cy = layout.rect.y + layout.rect.h / 2;
      if (shape !== null) {
        renderer.drawPath(rotatePath(shape.body, cx, cy, rot), { fill: theme.panel });
        renderer.drawPath(rotatePath(shape.body, cx, cy, rot), strokeStyle);
        for (const extra of shape.extra) {
          renderer.drawPath(rotatePath(extra, cx, cy, rot), strokeStyle);
        }
        // output bubble (NAND/NOR/XNOR/NOT) + per-input negation bubbles
        const bubbles: Vec2[] = [];
        if (shape.outBubble !== null) {
          const b = shape.outBubble;
          const p = rotPt(b.x, b.y, cx, cy, rot);
          bubbles.push(p);
        }
        const negate = comp.attrs?.negateInputs;
        if (Array.isArray(negate)) {
          for (const pinName of negate) {
            const pin = layout.pins.find((p) => p.name === pinName);
            if (pin !== undefined) bubbles.push({ x: pin.x, y: pin.y });
          }
        }
        for (const b of bubbles) {
          renderer.drawPath(circlePath(b.x, b.y, BUBBLE_R), { fill: theme.panel });
          renderer.drawPath(circlePath(b.x, b.y, BUBBLE_R), strokeStyle);
        }
        // shaped bodies have no caption — a named part shows its name above
        if (comp.name !== undefined && comp.name !== "") {
          renderer.drawText(cx, layout.rect.y - 0.8, comp.name, {
            color: theme.textDim,
            size: 0.9,
            align: "center",
          });
        }
      } else {
        renderer.drawPath(rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h), {
          fill: theme.panel,
        });
        renderer.drawPath(
          rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h),
          strokeStyle,
        );
        const spec = compSpec(comp.type);
        let caption =
          comp.name !== undefined && comp.name !== "" ? comp.name : spec.caption(comp.attrs ?? {});
        // Probe value display (U6): with a sim loaded, probes show their
        // net's value in the configured display mode; the name moves above.
        if (comp.type === "wiring.probe" && sim !== undefined) {
          const docNet = this.nets.pinToNet.get(`${comp.id}:in`);
          const wireIdx = docNet !== undefined ? this.nets.nets[docNet]?.wires[0] : undefined;
          const val = wireIdx !== undefined ? sim.valueForWire(wireIdx) : undefined;
          if (val !== undefined) {
            caption = formatValue(val, probeDisplayMode(comp.attrs?.display));
            if (comp.name !== undefined && comp.name !== "") {
              renderer.drawText(cx, layout.rect.y - 0.8, comp.name, {
                color: theme.textDim,
                size: 0.9,
                align: "center",
              });
            }
          }
        }
        renderer.drawText(
          layout.rect.x + layout.rect.w / 2,
          layout.rect.y + layout.rect.h / 2,
          caption,
          { color: theme.textDim, size: 1.0, align: "center" },
        );
      }
      for (const p of layout.pins) pinDots.push({ x: p.x, y: p.y });
    }
    renderer.flush();
    renderer.drawDots(pinDots, PIN_R, theme.textDim);

    // Junction dots.
    renderer.drawDots(this.junctionDots, PIN_R * 1.1, theme.wire.disconnected);

    // Halt marker (U5): ring the offending component in the error color.
    if (sim?.haltCompId != null) {
      const layout = this.layouts.get(sim.haltCompId);
      if (layout !== undefined) {
        const pad = 0.6;
        renderer.drawPath(
          roundedPath(
            [
              { x: layout.rect.x - pad, y: layout.rect.y - pad },
              { x: layout.rect.x + layout.rect.w + pad, y: layout.rect.y - pad },
              { x: layout.rect.x + layout.rect.w + pad, y: layout.rect.y + layout.rect.h + pad },
              { x: layout.rect.x - pad, y: layout.rect.y + layout.rect.h + pad },
              { x: layout.rect.x - pad, y: layout.rect.y - pad },
            ],
            0.5,
          ),
          { stroke: theme.wire.x, lineWidth: 0.22 },
        );
        renderer.flush();
      }
    }

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

    // Hover feedback (pins only — idle wire hover does nothing):
    const hit = overlay.hoverHit;
    if (hit?.kind === "pin") {
      // accent ring + name tooltip
      renderer.drawDots([hit.pos], PIN_R * 1.5, theme.accent);
      const spec = this.layouts.get(hit.compId)?.pins.find((p) => p.name === hit.pin);
      drawCard(renderer, theme, { x: hit.pos.x + 0.7, y: hit.pos.y - 1.4 }, [
        hit.pin,
        spec !== undefined ? `${spec.kind} · ${spec.bitsize}b` : "",
      ]);
    } else if (hit?.kind === "wire" && overlay.wireInProgress !== null) {
      // junction-on-drop preview (only while routing a wire)
      renderer.drawDots([hit.point], PIN_R * 1.3, theme.accent);
    }

    // Wire info card (shift+click): net bitsize inferred from components + value.
    if (overlay.wireInfo !== null) {
      const netId = this.netOfWire(overlay.wireInfo.wireIdx);
      const net = netId !== undefined ? this.nets.nets[netId] : undefined;
      const inference = inferNetBits(net, this.layouts);
      const bitsLine =
        inference.conflict.length > 0
          ? `⚠ bitsize mismatch (${inference.conflict.join(" ≠ ")})`
          : `${inference.bits ?? 1}-bit net`;
      const statsLine = `${net?.wires.length ?? 1} wires · ${net?.pins.length ?? 0} pins`;
      const width = inference.bits ?? 1;
      const valueLine = width <= 8 ? "Z".repeat(width) : `${"Z".repeat(8)}… (×${width} floating)`;
      drawCard(
        renderer,
        theme,
        { x: overlay.wireInfo.pos.x + 0.7, y: overlay.wireInfo.pos.y - 2.2 },
        [bitsLine, valueLine, statsLine],
      );
    }
  }
}

/** Small floating card (tooltip / info popup) drawn near a world point. */
function drawCard(renderer: Renderer, theme: Theme, pos: Vec2, lines: string[]): void {
  const size = 0.9;
  const lineH = 1.3;
  const padX = 0.5;
  const padY = 0.4;
  const w = Math.max(...lines.map((l) => l.length)) * size * 0.62 + 2 * padX;
  const h = lines.length * lineH + 2 * padY;
  renderer.drawPath(rectPath(pos.x, pos.y, w, h), { fill: theme.panel });
  renderer.drawPath(rectPath(pos.x, pos.y, w, h), { stroke: theme.panelBorder, lineWidth: 0.08 });
  renderer.flush();
  lines.forEach((line, i) => {
    renderer.drawText(pos.x + padX, pos.y + padY + lineH * (i + 0.5), line, {
      color: i === 0 ? theme.text : theme.textDim,
      size,
      align: "left",
    });
  });
  renderer.flush();
}

/** Infer a net's bit width from the pin metadata of its member components. */
function inferNetBits(
  net: NetInfo | undefined,
  layouts: ReadonlyMap<string, CompLayout>,
): { bits: number | null; conflict: number[] } {
  if (net === undefined) return { bits: null, conflict: [] };
  const sizes = new Set<number>();
  for (const key of net.pins) {
    const [compId, pinName] = key.split(":");
    const pin = layouts.get(compId)?.pins.find((p) => p.name === pinName);
    if (pin !== undefined) sizes.add(pin.bitsize);
  }
  const arr = [...sizes].sort((a, b) => a - b);
  return arr.length <= 1 ? { bits: arr[0] ?? null, conflict: [] } : { bits: null, conflict: arr };
}

function p2v(p: [number, number]): Vec2 {
  return { x: p[0], y: p[1] };
}

/** Rotate one point about a center (same convention as layout.ts). */
function rotPt(x: number, y: number, cx: number, cy: number, rot: "N" | "E" | "S" | "W"): Vec2 {
  const ox = x - cx;
  const oy = y - cy;
  switch (rot) {
    case "E":
      return { x, y };
    case "S":
      return { x: cx - oy, y: cy + ox };
    case "W":
      return { x: cx - ox, y: cy - oy };
    case "N":
      return { x: cx + oy, y: cy - ox };
  }
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
  // Empty circuit: start at the origin, not some arbitrary offset.
  if (rects.length === 0 && wires.length === 0) return { x: -25, y: -18, w: 50, h: 36 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
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
