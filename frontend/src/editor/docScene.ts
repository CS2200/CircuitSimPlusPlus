import type { CircuitDocument } from "../model/document";
import type { CsxCircuit, CsxComponent, CsxWire, Rotation } from "../model/csx";
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
import { rectPath, roundedPath, wirePath } from "../render/paths";
import type { PathCmd, Renderer, WireState } from "../render/renderer";
import { UniformGrid } from "../render/spatial";
import type { Theme } from "../render/theme";
import type { ViolationKind, WireValue } from "../ipc/types";
import { formatValue, type ValueMode } from "../sim/controller";
import { compLayout, type CompLayout } from "./layout";
import { compSize, compSpec } from "./catalog";
import { BUBBLE_R, chipPath, circlePath, gateShape, probePath, rotatePath } from "./shapes";

/**
 * DocScene (FRONTEND.md U3): draws a CircuitDocument circuit and answers
 * hit-tests. Rebuilds its draw model (layouts, batched paths, spatial
 * indexes, net derivation) only when (doc revision, circuit index)
 * changes — editing-scale circuits make rebuilds sub-millisecond.
 *
 * Wire coloring: before data flows, every wire shows a DULL version of its
 * identity color (its custom color, else its net's bus hue) — never flat grey.
 * Once a sim session is loaded (U5) the `sim` draw argument supplies per-wire
 * values and the TRUE color comes in (state colors; buses keep rainbow hues
 * unless X/Z). Selection/hover/net-extent highlights layer on top.
 * (UI_OVERHAUL §35.)
 */

/** A setup/hold violation marker on one component of the open sheet (U7). */
export interface ViolationMarker {
  compId: string;
  kind: ViolationKind;
  detail: string;
}

/** Sim state overlay for one draw pass (U5/U7). */
export interface SimOverlay {
  /** Latest value of the engine net containing this wire, if any. */
  valueForWire(wireIdx: number): WireValue | undefined;
  /** Document component id to ring in the error color (halt marker). */
  haltCompId?: string | null;
  /** Ordered component ids of the observed critical path (U7 highlight). */
  path?: readonly string[] | null;
  /** Setup/hold violation markers on the open sheet (U7, contract v1.1). */
  violations?: readonly ViolationMarker[] | null;
  /** Signal-travel pulses: wire index + phase ∈ [0,1) (U7). */
  pulses?: readonly { wireIdx: number; phase: number }[] | null;
  /** Engine cycle count (a clock's phase when its own output is unwired, §51). */
  cycle?: number;
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

/** Probe `radix` attr (format-v2 §4) → value display mode (default hex). */
function probeDisplayMode(attr: unknown): ValueMode {
  return attr === "unsigned" || attr === "signed" || attr === "hex" ? attr : "hex";
}

// ---- family tints, pin markers and live values (UI_OVERHAUL §21) ----

type TintRole = "in" | "out" | "arith" | "plexer" | "memory" | "io";

/** Family tint a component body takes (null = the plain panel colour). */
function tintRoleOf(comp: CsxComponent): TintRole | null {
  if (comp.type === "wiring.pin") return comp.attrs?.isOutput === true ? "out" : "in";
  if (comp.type.startsWith("arith.")) return "arith";
  if (comp.type.startsWith("plexers.")) return "plexer";
  if (comp.type.startsWith("mem.")) return "memory";
  if (comp.type.startsWith("io.")) return "io";
  return null; // gates keep the classic look; wiring parts stay neutral
}

/**
 * A pin's body (UI_OVERHAUL §21/§55): an output pin is a rounded stadium, an
 * input pin a plain square. Shared by the placed body and the placement ghost
 * so the preview matches exactly what lands.
 */
function pinBodyPath(r: Rect, isOutput: boolean): PathCmd[] {
  if (!isOutput) return rectPath(r.x, r.y, r.w, r.h);
  return roundedPath(
    [
      { x: r.x, y: r.y },
      { x: r.x + r.w, y: r.y },
      { x: r.x + r.w, y: r.y + r.h },
      { x: r.x, y: r.y + r.h },
      { x: r.x, y: r.y },
    ],
    r.h / 2,
  );
}

/** Theme colour behind a tint role / pin kind. */
function tintColor(theme: Theme, role: TintRole): string {
  switch (role) {
    case "in":
      return theme.bus[2];
    case "out":
      return theme.bus[0];
    case "arith":
      return theme.bus[4];
    case "plexer":
      return theme.bus[3];
    case "memory":
      return theme.bus[1];
    case "io":
      return theme.accent;
  }
}

/**
 * A DULL version of a wire's identity color (UI_OVERHAUL §35): mixed halfway
 * toward the background, so an idle wire reads as a subdued tint that the true
 * color brightens out of when data flows.
 */
function dullColor(theme: Theme, color: string): string {
  return mixHex(theme.bg, color, 0.5);
}

/** Mix `base` toward `other` by `t` (0..1); unchanged if either is not a hex. */
function mixHex(base: string, other: string, t: number): string {
  const parse = (hex: string): number[] | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (m === null) return null;
    const n = Number.parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  const a = parse(base);
  const b = parse(other);
  if (a === null || b === null) return base;
  return `#${a
    .map((v, i) => Math.round(v + (b[i] - v) * t))
    .map((v) => v.toString(16).padStart(2, "0"))
    .join("")}`;
}

/**
 * A clock's square wave (UI_OVERHAUL §47): it shows the level the clock drives
 * AND the edge that just happened (▲ rising / ▼ falling), so ticking is visible
 * at a glance. `high === null` (no sim value) draws a neutral wave with no edge
 * marker.
 */
function drawClockWave(renderer: Renderer, theme: Theme, rect: Rect, high: boolean | null): void {
  const x0 = rect.x + 0.3;
  const x1 = rect.x + rect.w - 0.3;
  const yHi = rect.y + rect.h * 0.34;
  const yLo = rect.y + rect.h * 0.66;
  const t = (x1 - x0) / 3;
  const levels = [false, true, high ?? false];
  const wave: PathCmd[] = [];
  let y = levels[0] === true ? yHi : yLo;
  wave.push({ t: "M", x: x0, y });
  for (let i = 1; i < 3; i++) {
    const nx = x0 + t * i;
    wave.push({ t: "L", x: nx, y });
    const ny = levels[i] === true ? yHi : yLo;
    if (ny !== y) wave.push({ t: "L", x: nx, y: ny });
    y = ny;
  }
  wave.push({ t: "L", x: x1, y });
  // The waveform itself is neutral; the segment holding the CURRENT level is the
  // one that lights up (UI_OVERHAUL §52) — no green, no heavy halo.
  renderer.drawPath(wave, { stroke: theme.textDim, lineWidth: 0.12 });
  renderer.flush();
  if (high === null) return;

  const lastY = high ? yHi : yLo;
  renderer.drawPath(
    [
      { t: "M", x: x0 + 2 * t, y: lastY },
      { t: "L", x: x1, y: lastY },
    ],
    { stroke: theme.accent, lineWidth: high ? 0.2 : 0.12, alpha: high ? 1 : 0.5 },
  );

  // ▲ on the rising edge / ▼ on the falling one, at the last transition.
  const edgeX = high ? x0 + t : x0 + 2 * t;
  const midY = (yHi + yLo) / 2;
  const tipY = high ? midY - 0.32 : midY + 0.32;
  const back = high ? 0.18 : -0.18;
  renderer.drawPath(
    [
      { t: "M", x: edgeX, y: midY },
      { t: "L", x: edgeX, y: tipY },
      { t: "M", x: edgeX - 0.16, y: tipY + back },
      { t: "L", x: edgeX, y: tipY },
      { t: "M", x: edgeX + 0.16, y: tipY + back },
      { t: "L", x: edgeX, y: tipY },
    ],
    { stroke: theme.accent, lineWidth: 0.1, alpha: high ? 1 : 0.5 },
  );
  renderer.flush();
}

/** The value a constant shows on its body, in its chosen display radix (§53). */
function constantText(hex: string, radix: unknown, bits: number): string {
  const n = Number.parseInt(hex, 16);
  if (!Number.isFinite(n)) return hex;
  if (radix === "bin") {
    const w = Math.min(32, Math.max(1, bits));
    return `0b${n.toString(2).padStart(w, "0")}`;
  }
  if (radix === "dec") return String(n);
  return `0x${hex.toUpperCase()}`;
}

/** Font size that keeps `text` inside a `w × h` body (never below 0.5). */
function fitTextSize(text: string, w: number, h: number, base = 1): number {
  const byWidth = (w * 0.92) / Math.max(1, text.length * 0.62);
  return Math.max(0.5, Math.min(base, byWidth, h * 0.6));
}

/**
 * Pin whose net value is shown on the body (UI_OVERHAUL §21): clocks, pins,
 * probes, registers, RAM/ROM and I/O parts are all live readouts.
 */
const VALUE_PIN: Readonly<Record<string, string>> = {
  "wiring.clock": "out",
  "wiring.pin": "pin",
  "wiring.probe": "in",
  "mem.register": "q",
  "mem.ram": "dout",
  "mem.rom": "out",
  "io.led": "in",
  "io.hexdisplay": "in",
};

/** Parts that also repeat their value next to the source pin (§21). Memory parts
 * are NOT here: their address and data readouts sit on the body itself (§46), as
 * does the probe's (§36). */
const VALUE_REPEAT: ReadonlySet<string> = new Set(["mem.register"]);

/** CSS font stacks for the text annotation's `font` attr (UI_OVERHAUL §40). */
const TEXT_FONTS: Readonly<Record<string, string>> = {
  sans: "system-ui, sans-serif",
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, monospace",
};

/** Side of the body a part's name label is drawn on (UI_OVERHAUL §28). */
export type LabelPos = "N" | "S" | "W" | "E";

/** Anchor (and text alignment) for a name label around a body rect. */
function labelAnchor(
  rect: Rect,
  pos: LabelPos,
): { x: number; y: number; align: "left" | "center" | "right" } {
  switch (pos) {
    case "S":
      return { x: rect.x + rect.w / 2, y: rect.y + rect.h + 0.9, align: "center" };
    case "W":
      return { x: rect.x - 0.5, y: rect.y + rect.h / 2, align: "right" };
    case "E":
      return { x: rect.x + rect.w + 0.5, y: rect.y + rect.h / 2, align: "left" };
    case "N":
    default:
      return { x: rect.x + rect.w / 2, y: rect.y - 0.9, align: "center" };
  }
}

/**
 * Friendly preview names for pins whose registry name is cryptic
 * (UI_OVERHAUL §33): the comparator's outputs read as words instead of
 * `lt`/`eq`/`gt` in the hover card.
 */
const PIN_DISPLAY: Readonly<Record<string, string>> = {
  lt: "less than",
  eq: "equal to",
  gt: "greater than",
  // Memory control pins read as words in the hover preview (UI_OVERHAUL §52);
  // the format keeps the short registry name (`we`).
  we: "write enable",
  en: "enable",
  rst: "reset",
  addr: "address",
  din: "data in",
  dout: "data out",
};

/** Display name for a pin in the hover preview (falls back to the raw name). */
function pinDisplayName(name: string): string {
  return PIN_DISPLAY[name] ?? name;
}

/** Point at arc-length fraction t ∈ [0,1] along a polyline. */
function pointAlong(points: [number, number][], t: number): Vec2 {
  const first = points[0];
  if (points.length === 1 || t <= 0) return { x: first[0], y: first[1] };
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  let target = total * Math.min(1, t);
  for (let i = 1; i < points.length; i++) {
    const dx = points[i][0] - points[i - 1][0];
    const dy = points[i][1] - points[i - 1][1];
    const len = Math.hypot(dx, dy);
    if (target <= len && len > 0) {
      const f = target / len;
      return { x: points[i - 1][0] + dx * f, y: points[i - 1][1] + dy * f };
    }
    target -= len;
  }
  const last = points[points.length - 1];
  return { x: last[0], y: last[1] };
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
  placing: {
    type: string;
    pos: Vec2;
    rot: CsxComponent["rot"];
    attrs?: Record<string, unknown>;
  } | null;
  /** Box-select rectangle in progress. */
  boxRect: Rect | null;
  /** Shift-click wire info card: which wire + where to anchor the card. */
  wireInfo: { wireIdx: number; pos: Vec2 } | null;
  /** Canvas clock (ms) for animated warnings; absent → static. */
  now?: number;
}

const CELL = 8;
const WIRE_RADIUS = 0.12;
const WIRE_W = 0.16;
const PIN_R = 0.22;
const PICK_TOL = 0.45;
const PIN_TOL = 0.55;
const CORNER_TOL = 0.4;

/**
 * Rendered wire thickness for a bit width (UI_OVERHAUL §15): 1-bit wires keep
 * the base width, buses grow with the SQUARE ROOT of the bit count so 8, 16
 * and 32-bit are each clearly heavier (32-bit ≈ 3.5× a 1-bit wire) without a
 * wide bus swallowing the drawing.
 */
function wireWidthForBits(bits: number): number {
  return WIRE_W * (1 + 0.55 * (Math.sqrt(Math.max(1, bits)) - 1));
}

/**
 * Canvas grid spacing in grid cells for a zoom level (UI_OVERHAUL §15): the
 * smallest power-of-two GROUP of cells that keeps neighbouring lines at least
 * `minPx` apart on screen, so the grid stays readable at every zoom.
 */
export function gridStepFor(scale: number, minPx = 14): number {
  let step = 1;
  while (step * scale < minPx) step *= 2;
  return step;
}

export class DocScene {
  private circuitIdx = -1;
  private revision = -1;
  /** All circuits (subcircuit instances resolve their pins against these). */
  private circuits: readonly CsxCircuit[] = [];
  private layouts = new Map<string, CompLayout>();
  private components: CsxComponent[] = [];
  private wires: CsxWire[] = [];
  private wirePaths: PathCmd[][] = [];
  /** Junction dot positions per wire (at its own join endpoints). */
  private junctionDots: Vec2[] = [];
  private wireIndex = new UniformGrid(CELL);
  private wireNetId: (number | undefined)[] = [];
  private wireBits: number[] = [];
  /** Declared-width disagreement per wire (UI_OVERHAUL §17). */
  private wireMismatch: boolean[] = [];
  /** Last level a clock drove, and when it flipped (UI_OVERHAUL §47). */
  private clockLevel = new Map<string, boolean>();
  private clockChangedAt = new Map<string, number>();
  private nets: NetDerivation = { nets: [], wireToNet: new Map(), pinToNet: new Map(), errors: [] };
  bounds: Rect = { x: 0, y: 0, w: 100, h: 60 };

  /** Rebuild the draw model if the document (or open circuit) changed. */
  sync(doc: CircuitDocument, circuitIdx: number): void {
    if (doc.revision === this.revision && circuitIdx === this.circuitIdx) return;
    this.revision = doc.revision;
    this.circuitIdx = circuitIdx;
    this.circuits = doc.circuits;
    const c = doc.circuit(circuitIdx);
    this.components = c.components;
    this.wires = c.wires;
    this.layouts = new Map(c.components.map((x) => [x.id, compLayout(x, this.circuits)]));
    // Spatial index first: crossing hops for the wire paths need it.
    this.wireIndex = new UniformGrid(CELL);
    c.wires.forEach((w, i) => {
      for (let s = 0; s + 1 < w.points.length; s++) {
        this.wireIndex.insert(i, pointsBounds([p2v(w.points[s]), p2v(w.points[s + 1])]));
      }
    });
    // Wire paths, with a hop where this wire crosses an earlier one
    // (crossing ≠ junction; the hop makes that visible, DESIGN.md §5.2).
    const hops = this.crossingHops(c.wires);
    this.wirePaths = c.wires.map((w, i) => wirePath(w.points.map(p2v), WIRE_RADIUS, hops[i]));
    this.junctionDots = [];
    for (const w of c.wires) {
      if (!isPinEndpoint(w.b)) this.junctionDots.push(p2v(w.points[w.points.length - 1]));
      if (!isPinEndpoint(w.a)) this.junctionDots.push(p2v(w.points[0]));
    }
    this.nets = deriveNets(c);
    this.wireNetId = c.wires.map((_, i) => this.nets.wireToNet.get(i));
    this.wireBits = c.wires.map((_, i) => {
      const netId = this.nets.wireToNet.get(i);
      const net = netId !== undefined ? this.nets.nets[netId] : undefined;
      const inf = inferNetBits(net, this.layouts);
      // Use the WIDEST declared width on the net (UI_OVERHAUL §15): a width
      // edit then shows up immediately, and a net whose endpoints disagree
      // still draws as the bus you wired (the engine reports the mismatch).
      if (inf.conflict.length > 0) return Math.max(1, inf.conflict[inf.conflict.length - 1]);
      return Math.max(1, inf.bits ?? 1);
    });
    // Bitsize mismatch (UI_OVERHAUL §17): a net whose pins declare different
    // widths is flagged per wire (amber halo) and once per net (⚠ badge).
    this.wireMismatch = c.wires.map((_, i) => {
      const netId = this.nets.wireToNet.get(i);
      const net = netId !== undefined ? this.nets.nets[netId] : undefined;
      return inferNetBits(net, this.layouts).conflict.length > 0;
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

  /** Nearest pin of ONE component (drop-on-part wiring, UI_OVERHAUL §13). */
  nearestPinOf(compId: string, world: Vec2): { pin: string; pos: Vec2 } | null {
    const layout = this.layouts.get(compId);
    if (layout === undefined || layout.pins.length === 0) return null;
    let best: { pin: string; pos: Vec2; d: number } | null = null;
    for (const p of layout.pins) {
      const d = Math.hypot(world.x - p.x, world.y - p.y);
      if (best === null || d < best.d) best = { pin: p.name, pos: { x: p.x, y: p.y }, d };
    }
    return best === null ? null : { pin: best.pin, pos: best.pos };
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

  /** True when any wire on this sheet has a declared-width mismatch (§19). */
  hasMismatch(): boolean {
    return this.wireMismatch.some(Boolean);
  }

  netOfPin(compId: string, pin: string): number | undefined {
    return this.nets.pinToNet.get(`${compId}:${pin}`);
  }

  wiresInNet(netId: number): readonly number[] {
    return this.nets.nets[netId]?.wires ?? [];
  }

  /**
   * Text a pin reads with no live sim value (UI_OVERHAUL §40/§48): the
   * configured value of a `wiring.constant` on the same net, else null. Lets a
   * probe — and a RAM's address — show "the value of the thing it is wired to"
   * before/without a run.
   */
  staticPinText(comp: CsxComponent, pin: string): string | null {
    const netId = this.netOfPin(comp.id, pin);
    if (netId === undefined) return null;
    const net = this.nets.nets[netId];
    if (net === undefined) return null;
    for (const key of net.pins) {
      const cid = key.slice(0, key.indexOf(":"));
      const other = this.components.find((c) => c.id === cid);
      if (other?.type === "wiring.constant") {
        const v = other.attrs?.value;
        if (typeof v === "string" && v !== "") return v;
      }
    }
    return null;
  }

  // ---- routing support (editor/route.ts inputs) ----

  /** Outward facing of a pin (which body edge it sits on); null if gone. */
  pinFacing(compId: string, pin: string): Rotation | null {
    const layout = this.layouts.get(compId);
    return layout?.pins.find((p) => p.name === pin)?.facing ?? null;
  }

  /** Component body rect in world units; null if the component is gone. */
  rectOf(compId: string): Rect | null {
    return this.layouts.get(compId)?.rect ?? null;
  }

  /** Endpoints of one wire segment (junction approach directions). */
  segmentPoints(wireIdx: number, segment: number): { a: Vec2; b: Vec2 } | null {
    const w = this.wires[wireIdx];
    if (w === undefined || segment < 0 || segment + 1 >= w.points.length) return null;
    return { a: p2v(w.points[segment]), b: p2v(w.points[segment + 1]) };
  }

  /** Nearest interior bend point of a wire (corner-drag handles). */
  pickWireCorner(
    world: Vec2,
    tol = CORNER_TOL,
  ): { wireIdx: number; pointIdx: number; point: Vec2 } | null {
    const candidates = this.wireIndex.queryRect(inflateRect(pointRect(world), tol));
    let best: { d: number; wireIdx: number; pointIdx: number } | null = null;
    for (const i of candidates) {
      const pts = this.wires[i].points;
      for (let k = 1; k + 1 < pts.length; k++) {
        const d = Math.hypot(world.x - pts[k][0], world.y - pts[k][1]);
        if (d <= tol && (best === null || d < best.d)) {
          best = { d, wireIdx: i, pointIdx: k };
        }
      }
    }
    if (best === null) return null;
    return {
      wireIdx: best.wireIdx,
      pointIdx: best.pointIdx,
      point: p2v(this.wires[best.wireIdx].points[best.pointIdx]),
    };
  }

  /**
   * Floating rotate button above the current component selection: centered
   * over the selection's bounding box, one grid unit above its top edge.
   * Null for an empty/invalid selection (the caller draws and hit-tests it).
   */
  rotateButtonFor(ids: Iterable<string>): { center: Vec2; r: number } | null {
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let any = false;
    for (const id of ids) {
      const rect = this.layouts.get(id)?.rect;
      if (rect === undefined) continue;
      any = true;
      minX = Math.min(minX, rect.x);
      maxX = Math.max(maxX, rect.x + rect.w);
      minY = Math.min(minY, rect.y);
    }
    if (!any) return null;
    return { center: { x: (minX + maxX) / 2, y: minY - 1.15 }, r: 0.62 };
  }

  /**
   * Crossing points per wire index: where wire `i` crosses wire `j > i` at
   * a strict interior of both segments, the later wire `j` gets a hop
   * (rendering only; connectivity is untouched). Shared endpoints and
   * junction meeting points never hop.
   */
  private crossingHops(wires: readonly CsxWire[]): { at: Vec2; axis: "h" | "v" }[][] {
    const hops: { at: Vec2; axis: "h" | "v" }[][] = wires.map(() => []);
    const seen = new Set<string>();
    wires.forEach((wi, i) => {
      for (let s = 0; s + 1 < wi.points.length; s++) {
        const a = p2v(wi.points[s]);
        const b = p2v(wi.points[s + 1]);
        for (const j of this.wireIndex.queryRect(pointsBounds([a, b]))) {
          if (j <= i) continue;
          const wj = wires[j];
          for (let t = 0; t + 1 < wj.points.length; t++) {
            const hit = crossingPoint(a, b, p2v(wj.points[t]), p2v(wj.points[t + 1]));
            if (hit === null) continue;
            const key = `${j}:${hit.at.x}:${hit.at.y}`;
            if (seen.has(key)) continue;
            seen.add(key);
            hops[j].push(hit);
          }
        }
      }
    });
    return hops;
  }

  // ---- drawing ----

  /**
   * Canvas grid (opt-in setting, UI_OVERHAUL §15). Lines are drawn in GROUPS:
   * the step doubles (1, 2, 4, 8 … grid cells) until adjacent lines are at
   * least `GRID_MIN_PX` apart on screen, so the grid stays readable at every
   * zoom instead of collapsing into a wash.
   */
  private drawGrid(renderer: Renderer, theme: Theme, camera: Camera, view: ViewSize): void {
    const step = gridStepFor(camera.scale);
    const rect = camera.visibleWorldRect(view);
    const left = Math.floor(rect.x / step) * step;
    const right = rect.x + rect.w;
    const top = Math.floor(rect.y / step) * step;
    const bottom = rect.y + rect.h;
    const cmds: PathCmd[] = [];
    for (let x = left; x <= right; x += step) {
      cmds.push({ t: "M", x, y: top }, { t: "L", x, y: bottom });
    }
    for (let y = top; y <= bottom; y += step) {
      cmds.push({ t: "M", x: left, y }, { t: "L", x: right, y });
    }
    if (cmds.length === 0) return;
    // 1 CSS px at any zoom (lineWidth is in world units).
    renderer.drawPath(cmds, { stroke: theme.grid, lineWidth: 1 / camera.scale });
    renderer.flush();
  }

  draw(
    renderer: Renderer,
    theme: Theme,
    camera: Camera,
    view: ViewSize,
    selection: SelectionModel,
    overlay: SceneOverlay,
    sim?: SimOverlay,
    grid = false,
    showValues = true,
  ): void {
    const visible = inflateRect(camera.visibleWorldRect(view), 2);

    // Behind everything (the renderer has already filled the background).
    if (grid) this.drawGrid(renderer, theme, camera, view);

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
    // per net + thicker (DLS look, DESIGN.md §7.1 / D8). With a sim loaded,
    // state colors come from the streamed values (buses keep hues unless
    // X/Z — hue is identity, state color is value). Idle wires are a DULL
    // tint of that identity color, not grey (UI_OVERHAUL §35).
    const wireIds = this.wireIndex.queryRect(visible);
    for (const i of wireIds) {
      const selected = selection.hasWire(i);
      const custom = this.wires[i]?.color ?? null;
      const bits = Math.max(1, this.wireBits[i]);
      const isBus = bits > 1;
      const hue = this.wireNetId[i] ?? i;
      const simVal = sim?.valueForWire(i);
      const contested = simVal !== undefined && wireValueState(simVal) === "x";
      // The wire's identity: a user-chosen color (UI_OVERHAUL §12), else the
      // net's bus hue. This is the "true color" the wire brightens into.
      const identity = custom ?? theme.bus[hue % theme.bus.length];
      let stroke: string;
      if (simVal === undefined) {
        // No data yet: a dull version of the identity color, so a drawn wire is
        // tinted rather than flat grey, and the true color can "light up" when
        // data flows (UI_OVERHAUL §35).
        stroke = dullColor(theme, identity);
      } else if (custom !== null && !contested) {
        // A user-chosen color wins over state/bus hues — except contention,
        // which stays red because it is an error signal.
        stroke = custom;
      } else {
        const state = wireValueState(simVal);
        stroke =
          isBus && state !== "x" && state !== "z"
            ? theme.bus[hue % theme.bus.length]
            : theme.wire[state];
      }
      // Thickness ∝ width (UI_OVERHAUL §12/§15): sqrt-ish growth, so 8/16/32
      // bit buses read as clearly different weights beside a 1-bit wire.
      const width = wireWidthForBits(bits);
      // Halos nest: mismatch (widest) → selection → core. A width mismatch
      // BLINKS in the wire's OWN color (UI_OVERHAUL §42) — a pulsing glow rather
      // than a fixed amber ring — while the canvas is animating (§19); selection
      // is an accent halo under the core so a color you just picked shows
      // immediately (§15).
      if (this.wireMismatch[i]) {
        const t = overlay.now;
        const phase = t === undefined ? 0.75 : 0.5 + 0.5 * Math.sin(t / 170);
        renderer.drawPath(this.wirePaths[i], {
          stroke,
          lineWidth: width * (2.1 + 1.0 * phase),
          alpha: 0.3 + 0.7 * phase,
        });
      }
      if (selected) {
        renderer.drawPath(this.wirePaths[i], { stroke: theme.accent, lineWidth: width * 1.9 });
      }
      renderer.drawPath(this.wirePaths[i], {
        stroke,
        lineWidth: selected ? width * 1.25 : width,
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
    const inDots: Vec2[] = [];
    const outDots: Vec2[] = [];
    const otherDots: Vec2[] = [];
    for (const comp of this.components) {
      const layout = this.layouts.get(comp.id)!;
      if (!rectIntersects(layout.rect, visible)) continue;
      const selected = selection.hasComponent(comp.id);
      // Pin terminals are collected up front so every part — including the ones
      // drawn by a special case below (text/splitter/LED) — gets its markers
      // (UI_OVERHAUL §50).
      for (const p of layout.pins) {
        const dot = { x: p.x, y: p.y };
        if (p.kind === "out") outDots.push(dot);
        else if (p.kind === "in") inDots.push(dot);
        else otherDots.push(dot);
      }
      // A text annotation: no body box and no pins — just the label, sitting at
      // the rect's left, vertically centred (UI_OVERHAUL §37). A selection
      // outlines the (invisible) hit box so the annotation can be grabbed.
      if (comp.type === "misc.text") {
        const attrs = comp.attrs ?? {};
        const text = typeof attrs.text === "string" ? attrs.text : "";
        const color =
          typeof attrs.color === "string" && /^#[0-9a-f]{6}$/i.test(attrs.color)
            ? attrs.color
            : theme.text;
        const font = TEXT_FONTS[typeof attrs.font === "string" ? attrs.font : "sans"];
        if (selected) {
          renderer.drawPath(rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h), {
            stroke: theme.accent,
            lineWidth: 0.06,
          });
        }
        renderer.drawText(layout.rect.x + 0.3, layout.rect.y + layout.rect.h / 2, text, {
          color,
          size: 1.2,
          align: "left",
          font,
        });
        renderer.flush();
        continue;
      }
      // A splitter is a bus rail with a tap per split pin (UI_OVERHAUL §46):
      // there is no box body — the old rectangle read as a mux.
      if (comp.type === "wiring.splitter") {
        const railX = layout.rect.x + 0.7;
        const rail: PathCmd[] = [
          { t: "M", x: railX, y: layout.rect.y + 0.25 },
          { t: "L", x: railX, y: layout.rect.y + layout.rect.h - 0.25 },
        ];
        const taps: PathCmd[] = [];
        for (const p of layout.pins) {
          if (p.name === "bus") {
            rail.push({ t: "M", x: p.x, y: p.y }, { t: "L", x: railX, y: p.y });
          } else {
            taps.push({ t: "M", x: railX, y: p.y }, { t: "L", x: p.x, y: p.y });
          }
        }
        renderer.drawPath(rail, { stroke: theme.textDim, lineWidth: 0.22 });
        renderer.drawPath(taps, { stroke: theme.textDim, lineWidth: 0.14 });
        if (selected) {
          renderer.drawPath(
            rectPath(
              layout.rect.x - 0.25,
              layout.rect.y - 0.25,
              layout.rect.w + 0.5,
              layout.rect.h + 0.5,
            ),
            { stroke: theme.accent, lineWidth: 0.06 },
          );
        }
        renderer.flush();
        continue;
      }
      // An LED (UI_OVERHAUL §49): a dome that lights in its own colour and
      // throws a glow when the net it reads drives a 1 — live from the sim, or
      // static from a connected constant, so it lights without a run.
      if (comp.type === "io.led") {
        const attrs = comp.attrs ?? {};
        const color =
          typeof attrs.color === "string" && /^#[0-9a-f]{6}$/i.test(attrs.color)
            ? attrs.color
            : theme.accent;
        const intensity =
          typeof attrs.intensity === "number" ? Math.max(0, Math.min(100, attrs.intensity)) : 80;
        const netId = this.netOfPin(comp.id, "in");
        const wireIdx = netId === undefined ? undefined : this.nets.nets[netId]?.wires[0];
        const live = wireIdx !== undefined ? sim?.valueForWire(wireIdx) : undefined;
        const liveState = live !== undefined ? wireValueState(live) : undefined;
        const stat = this.staticPinText(comp, "in");
        // A constant drives the net for real — trust it over a stale Z/X (§51).
        const on =
          liveState !== undefined && liveState !== "z" && liveState !== "x"
            ? liveState === "high"
            : stat !== null && stat !== "" && Number.parseInt(stat, 16) !== 0;
        const r = Math.min(layout.rect.w, layout.rect.h) * 0.34;
        const lx = layout.rect.x + layout.rect.w / 2;
        const ly = layout.rect.y + layout.rect.h / 2;
        if (on && intensity > 0) {
          // Illuminate the space around it: soft rings in the LED's colour that
          // really bloom at 100% (UI_OVERHAUL §50).
          const k = intensity / 100;
          for (let i = 4; i >= 1; i--) {
            renderer.drawPath(circlePath(lx, ly, r * (1 + 0.55 * i * (0.6 + k))), {
              fill: color,
              alpha: (0.05 + 0.4 * k) / i,
            });
          }
          renderer.flush();
        }
        renderer.drawPath(circlePath(lx, ly, r), { fill: on ? color : theme.panel });
        renderer.drawPath(circlePath(lx, ly, r), { stroke: theme.textDim, lineWidth: 0.12 });
        // Input lead from the pin into the dome (so the connection point is
        // unmistakable), plus the base and two legs (UI_OVERHAUL §50).
        const baseY = ly + r * 0.85;
        renderer.drawPath(
          [
            { t: "M", x: layout.rect.x, y: ly },
            { t: "L", x: lx - r, y: ly },
            { t: "M", x: lx - r * 0.8, y: baseY },
            { t: "L", x: lx + r * 0.8, y: baseY },
            { t: "M", x: lx - r * 0.45, y: baseY },
            { t: "L", x: lx - r * 0.45, y: layout.rect.y + layout.rect.h },
            { t: "M", x: lx + r * 0.45, y: baseY },
            { t: "L", x: lx + r * 0.45, y: layout.rect.y + layout.rect.h },
          ],
          { stroke: theme.textDim, lineWidth: 0.14 },
        );
        if (selected) {
          renderer.drawPath(rectPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h), {
            stroke: theme.accent,
            lineWidth: 0.06,
          });
        }
        renderer.flush();
        continue;
      }
      // Family tint (UI_OVERHAUL §21): a hint of the part's family on its body
      // and a stronger hint on its outline, so pins/memory/arithmetic read
      // apart at a glance without shouting.
      const role = tintRoleOf(comp);
      const tint = role === null ? null : tintColor(theme, role);
      const bodyFill = tint === null ? theme.panel : mixHex(theme.panel, tint, 0.1);
      const strokeStyle = {
        stroke: selected
          ? theme.accent
          : tint === null
            ? theme.panelBorder
            : mixHex(theme.panelBorder, tint, 0.5),
        lineWidth: selected ? 0.22 : 0.12,
      };
      // Distinctive shape (local EAST frame → rotated about the body's
      // center), or a box. The EAST-frame shape is built CENTERED on the
      // (possibly axis-swapped) body rect: for N/S the rect is h×w, so
      // anchoring the shape at rect.x/y would rotate it about the wrong
      // point and draw the body offset from its pins.
      const local = compSize(comp, this.circuits);
      const rot = comp.rot ?? "E";
      const cx = layout.rect.x + layout.rect.w / 2;
      const cy = layout.rect.y + layout.rect.h / 2;
      const shape = gateShape(comp.type, cx - local.w / 2, cy - local.h / 2, local.w, local.h);
      if (shape !== null) {
        renderer.drawPath(rotatePath(shape.body, cx, cy, rot), { fill: bodyFill });
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
        for (const b of bubbles) {
          renderer.drawPath(circlePath(b.x, b.y, BUBBLE_R), { fill: theme.panel });
          renderer.drawPath(circlePath(b.x, b.y, BUBBLE_R), strokeStyle);
        }
        // shaped bodies have no caption — a named part shows its name beside it
        if (comp.name !== undefined && comp.name !== "") {
          const na = labelAnchor(layout.rect, comp.namePos ?? "N");
          renderer.drawText(na.x, na.y, comp.name, {
            color: theme.textDim,
            size: 0.9,
            align: na.align,
          });
        }
      } else {
        // Input pins are square, output pins are rounded (UI_OVERHAUL §21); the
        // probe gets its own pointed-hexagon body (§36).
        const outPin = comp.type === "wiring.pin" && comp.attrs?.isOutput === true;
        const bodyPath =
          comp.type === "wiring.probe"
            ? probePath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h)
            : comp.type === "mem.ram" || comp.type === "mem.rom"
              ? chipPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h)
              : pinBodyPath(layout.rect, outPin);
        renderer.drawPath(bodyPath, { fill: bodyFill });
        renderer.drawPath(bodyPath, strokeStyle);
        const spec = compSpec(comp.type);
        // The body ALWAYS shows the type mark: a symbol where the family has
        // one (arith: + − × ÷ = ~ «), otherwise a short abbreviation (REG, RAM,
        // MUX, …). A user-assigned name is drawn ABOVE the part and never
        // replaces the mark, so a named part stays recognizable
        // (UI_OVERHAUL §17).
        let caption = spec.caption(comp.attrs ?? {});
        // Live values (UI_OVERHAUL §21): constants always show their configured
        // value; clocks, pins, probes, registers, RAM/ROM and I/O show the value
        // on their VALUE_PIN net in place of the mark, with a repeat by the pin.
        let valueText: string | null = null;
        let valuePin: string | null = null;
        if (comp.type === "wiring.constant" && comp.attrs?.value !== undefined) {
          const outPin = layout.pins.find((p) => p.name === "out");
          valueText = constantText(
            String(comp.attrs.value),
            comp.attrs.radix,
            outPin?.bitsize ?? 1,
          );
        } else if (sim !== undefined && showValues) {
          const pinName = VALUE_PIN[comp.type];
          if (pinName !== undefined) {
            const docNet = this.nets.pinToNet.get(`${comp.id}:${pinName}`);
            const wireIdx = docNet !== undefined ? this.nets.nets[docNet]?.wires[0] : undefined;
            const val = wireIdx !== undefined ? sim.valueForWire(wireIdx) : undefined;
            if (val !== undefined) {
              // A single-bit readout is a plain 0/1 — no hex prefix (§21).
              const bits = wireIdx !== undefined ? (this.wireBits[wireIdx] ?? 1) : 1;
              const mode = bits <= 1 ? "unsigned" : probeDisplayMode(comp.attrs?.radix);
              valueText = formatValue(val, mode);
              valuePin = pinName;
            }
          }
        }
        // A constant always drives its net: when the sim reports high-Z/X for it
        // (the session hasn't seen a recent edit yet), read the constant instead
        // of showing a stale Z (UI_OVERHAUL §51).
        if (valueText !== null && valuePin !== null) {
          const docNet = this.nets.pinToNet.get(`${comp.id}:${valuePin}`);
          const wireIdx = docNet !== undefined ? this.nets.nets[docNet]?.wires[0] : undefined;
          const val = wireIdx !== undefined ? sim?.valueForWire(wireIdx) : undefined;
          const st = val !== undefined ? wireValueState(val) : undefined;
          if (st === "z" || st === "x") {
            const stat = this.staticPinText(comp, valuePin);
            if (stat !== null) valueText = stat;
          }
        }
        // Memory parts read out ADDRESS + data on the body instead of the word
        // "RAM"/"ROM" (UI_OVERHAUL §46); everything else shows its value in
        // place of the type mark.
        const isMemory = comp.type === "mem.ram" || comp.type === "mem.rom";
        let addrText: string | null = null;
        if (isMemory && sim !== undefined && showValues) {
          const docNet = this.nets.pinToNet.get(`${comp.id}:addr`);
          const wireIdx = docNet !== undefined ? this.nets.nets[docNet]?.wires[0] : undefined;
          const val = wireIdx !== undefined ? sim.valueForWire(wireIdx) : undefined;
          if (val !== undefined) {
            const bits = wireIdx !== undefined ? (this.wireBits[wireIdx] ?? 1) : 1;
            addrText = formatValue(
              val,
              bits <= 1 ? "unsigned" : probeDisplayMode(comp.attrs?.radix),
            );
            const st = wireValueState(val);
            if (st === "z" || st === "x") {
              // A constant drives the address for real — never show a stale Z
              // because the sim session predates the wiring (UI_OVERHAUL §51).
              addrText = this.staticPinText(comp, "addr") ?? addrText;
            }
          }
        }
        if (valueText !== null && !isMemory) caption = valueText;
        // Static fallback (UI_OVERHAUL §40): with no live sim value, a probe
        // still reads what it is wired to (a directly connected constant).
        if (valueText === null && comp.type === "wiring.probe") {
          const staticVal = this.staticPinText(comp, "in");
          if (staticVal !== null) {
            valueText = staticVal;
            valuePin = "in";
          }
        }
        // A RAM/ROM's ADDRESS also reads its driver before a run (UI_OVERHAUL
        // §48), and over a stale Z/X (§51).
        if (isMemory && addrText === null) {
          addrText = this.staticPinText(comp, "addr");
        }
        if (comp.name !== undefined && comp.name !== "") {
          const na = labelAnchor(layout.rect, comp.namePos ?? "N");
          renderer.drawText(na.x, na.y, comp.name, {
            color: theme.textDim,
            size: 0.9,
            align: na.align,
          });
        }
        // The value is also repeated next to the pin it comes from, for the
        // bigger readouts (registers/probes/memory) — a pin part's whole body
        // already IS that pin, and small I/O parts would just get noisy.
        if (valueText !== null && valuePin !== null && VALUE_REPEAT.has(comp.type)) {
          const pin = layout.pins.find((p) => p.name === valuePin);
          if (pin !== undefined) {
            renderer.drawText(pin.x, pin.y - 0.7, valueText, {
              color: theme.text,
              size: 0.7,
              align: "center",
            });
          }
        }
        // Memory readouts (UI_OVERHAUL §46/§50): the type word plus Addr/Data,
        // stacked and centred in the same light style as the rest.
        if (isMemory) {
          const mc = layout.rect.x + layout.rect.w / 2;
          const mid = layout.rect.y + layout.rect.h / 2;
          [caption, `Addr: ${addrText ?? "—"}`, `Data: ${valueText ?? "—"}`].forEach((line, i) => {
            renderer.drawText(mc, mid + (i - 1) * 1.2, line, {
              color: theme.textDim,
              size: 0.9,
              align: "center",
            });
          });
        }
        // The comparator's three outputs each get their own relation symbol
        // next to the pin (<, =, >) instead of one centered mark
        // (UI_OVERHAUL §31); a clock/idle probe draws its own glyph instead of a
        // type word, and a probe shows ONLY its live value (§36).
        if (comp.type === "arith.comparator") {
          const REL: Record<string, string> = { lt: "<", eq: "=", gt: ">" };
          for (const p of layout.pins) {
            const sym = REL[p.name];
            if (sym === undefined) continue;
            // drawText centres on y (textBaseline: middle), so the symbol sits
            // exactly on the pin's row.
            renderer.drawText(layout.rect.x + layout.rect.w - 0.5, p.y, sym, {
              color: theme.textDim,
              size: 1.1,
              align: "right",
            });
          }
        } else if (comp.type === "wiring.clock") {
          // The clock GLOWS while it drives high and sits dull while low (§47),
          // so its rising/falling edge is readable at a glance; it also flashes
          // briefly on a flip.
          // Level: the clock's own live value when it is wired, else the sim's
          // phase (a clock reads high on even cycles) so an UNWIRED clock still
          // visibly alternates as you tick (UI_OVERHAUL §51).
          const high =
            valueText !== null
              ? valueText !== "0"
              : sim?.cycle !== undefined
                ? sim.cycle % 2 === 0
                : null;
          if (high !== null) {
            const prev = this.clockLevel.get(comp.id);
            if (prev !== undefined && prev !== high && overlay.now !== undefined) {
              this.clockChangedAt.set(comp.id, overlay.now);
            }
            this.clockLevel.set(comp.id, high);
          }
          if (high === true) {
            // A quiet accent ring says "driving 1" without shouting (§52).
            renderer.drawPath(
              rectPath(
                layout.rect.x - 0.18,
                layout.rect.y - 0.18,
                layout.rect.w + 0.36,
                layout.rect.h + 0.36,
              ),
              { stroke: theme.accent, lineWidth: 0.3, alpha: 0.22 },
            );
            renderer.flush();
          }
          const at = this.clockChangedAt.get(comp.id);
          if (at !== undefined && overlay.now !== undefined) {
            const k = 1 - (overlay.now - at) / 450;
            if (k > 0) {
              renderer.drawPath(
                rectPath(
                  layout.rect.x - 0.25,
                  layout.rect.y - 0.25,
                  layout.rect.w + 0.5,
                  layout.rect.h + 0.5,
                ),
                { stroke: theme.accent, lineWidth: 0.16, alpha: k },
              );
              renderer.flush();
            }
          }
          drawClockWave(renderer, theme, layout.rect, high);
        } else if (comp.type === "wiring.probe" && valueText === null) {
          // The probe shows only its value; with nothing to read it stays bare
          // (the pointed shape already says "probe", UI_OVERHAUL §36).
        } else if (isMemory) {
          // RAM/ROM drew its stacked Addr/Data lines above.
        } else {
          renderer.drawText(
            cx,
            cy,
            caption,
            // Values (and symbols, §18) are sized to fit the body, so a 32-bit
            // readout on a small part stays inside it.
            {
              // Values read in the light caption style everywhere — constants
              // included (UI_OVERHAUL §50).
              color: theme.textDim,
              size: fitTextSize(caption, layout.rect.w, layout.rect.h, spec.markSize ?? 1.0),
              align: "center",
            },
          );
        }
        // Subcircuit instances: label each interface pin just inside the
        // box (inputs at the left edge, outputs at the right).
        if (comp.type === "subcircuit") {
          for (const p of layout.pins) {
            const left = p.kind === "in";
            renderer.drawText(
              left ? layout.rect.x + 0.5 : layout.rect.x + layout.rect.w - 0.5,
              p.y + 0.35,
              p.name,
              { color: theme.textDim, size: 0.7, align: left ? "left" : "right" },
            );
          }
        }
      }
    }
    renderer.flush();
    // Pin markers (UI_OVERHAUL §21): input pins are squares, output pins are
    // circles, and a muted colour says which side of the part they are on.
    const inMark = mixHex(theme.panel, theme.bus[2], 0.55);
    const outMark = mixHex(theme.panel, theme.bus[0], 0.6);
    renderer.drawDots(inDots, PIN_R, inMark);
    renderer.drawDots(otherDots, PIN_R, theme.textDim);
    if (outDots.length > 0) {
      for (const d of outDots) {
        renderer.drawPath(circlePath(d.x, d.y, PIN_R), { fill: outMark });
      }
      renderer.flush();
    }

    // Junction dots.
    renderer.drawDots(this.junctionDots, PIN_R * 1.1, theme.wire.disconnected);

    // Corner handles on selected wires (bend dragging).
    if (selection.wires.size > 0) {
      const corners: Vec2[] = [];
      for (const i of selection.wires) {
        const pts = this.wires[i]?.points;
        if (pts === undefined) continue;
        for (let k = 1; k + 1 < pts.length; k++) corners.push(p2v(pts[k]));
      }
      if (corners.length > 0) renderer.drawDots(corners, PIN_R * 0.8, theme.accent);
    }

    // Floating rotate button above the component selection (hidden while
    // wiring/placing, when a click on it would be ambiguous).
    if (overlay.wireInProgress === null && overlay.placing === null) {
      const btn = this.rotateButtonFor(selection.components);
      if (btn !== null) {
        renderer.drawPath(circlePath(btn.center.x, btn.center.y, btn.r), { fill: theme.panel });
        renderer.drawPath(circlePath(btn.center.x, btn.center.y, btn.r), {
          stroke: theme.accent,
          lineWidth: 0.12,
        });
        renderer.drawText(btn.center.x, btn.center.y + 0.04, "↻", {
          color: theme.accent,
          size: btn.r * 1.3,
          align: "center",
        });
        renderer.flush();
      }
    }

    // Propagation pulses (U7): a dot traveling each changed wire.
    if (sim?.pulses != null && sim.pulses.length > 0) {
      for (const pulse of sim.pulses) {
        const w = this.wires[pulse.wireIdx];
        if (w === undefined) continue;
        const p = pointAlong(w.points, pulse.phase);
        renderer.drawPath(circlePath(p.x, p.y, PIN_R * 1.3), { fill: theme.accent });
      }
      renderer.flush();
    }

    // Observed critical path (U7): accent route through the path's
    // components in order, each ringed.
    if (sim?.path != null && sim.path.length > 0) {
      const centers = sim.path
        .map((id) => this.layouts.get(id))
        .filter((l): l is CompLayout => l !== undefined)
        .map((l) => ({ x: l.rect.x + l.rect.w / 2, y: l.rect.y + l.rect.h / 2 }));
      if (centers.length > 1) {
        renderer.drawPath(roundedPath(centers, 0.4), {
          stroke: theme.accent,
          lineWidth: WIRE_W * 1.6,
        });
      }
      for (const c of centers) {
        renderer.drawPath(circlePath(c.x, c.y, 0.5), { stroke: theme.accent, lineWidth: 0.18 });
      }
      renderer.flush();
    }

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

    // Setup/hold violation markers (U7, contract v1.1): same ring idiom as
    // the halt marker but in the theme's violation color, with a ⚠<kind>
    // tag. Hovering a marked component shows the engine's detail text.
    if (sim?.violations != null && sim.violations.length > 0) {
      const hoverId = overlay.hoverHit?.kind === "component" ? overlay.hoverHit.compId : null;
      for (const v of sim.violations) {
        const layout = this.layouts.get(v.compId);
        if (layout === undefined) continue;
        const pad = 0.45;
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
          { stroke: theme.violation, lineWidth: 0.2 },
        );
        renderer.drawText(layout.rect.x + layout.rect.w + pad, layout.rect.y - pad, `⚠ ${v.kind}`, {
          color: theme.violation,
          size: 0.9,
          align: "left",
        });
        renderer.flush();
        if (v.compId === hoverId) {
          drawCard(
            renderer,
            theme,
            { x: layout.rect.x, y: layout.rect.y + layout.rect.h + pad + 0.4 },
            [`${v.kind} violation`, v.detail],
          );
        }
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
        ...(overlay.placing.attrs !== undefined && { attrs: overlay.placing.attrs }),
      };
      const layout = compLayout(ghost, this.circuits);
      // Preview the REAL part: the component's silhouette (gate shape or
      // box) plus its pins — not just the bounding rectangle (UI_OVERHAUL §10).
      const local = compSize(ghost, this.circuits);
      const rot = ghost.rot ?? "E";
      const gcx = layout.rect.x + layout.rect.w / 2;
      const gcy = layout.rect.y + layout.rect.h / 2;
      const shape = gateShape(ghost.type, gcx - local.w / 2, gcy - local.h / 2, local.w, local.h);
      const stroke = { stroke: theme.accent, lineWidth: 0.16 };
      if (shape !== null) {
        renderer.drawPath(rotatePath(shape.body, gcx, gcy, rot), {
          ...stroke,
          fill: "rgba(91,141,239,0.10)",
        });
        for (const extra of shape.extra) {
          renderer.drawPath(rotatePath(extra, gcx, gcy, rot), stroke);
        }
        if (shape.outBubble !== null) {
          const b = rotPt(shape.outBubble.x, shape.outBubble.y, gcx, gcy, rot);
          renderer.drawPath(circlePath(b.x, b.y, BUBBLE_R), stroke);
        }
      } else {
        // Match the placed body: the probe's silhouette is its hexagon, a memory
        // part is a chip, and the splitter is a bus rail (UI_OVERHAUL §50).
        if (ghost.type === "wiring.splitter") {
          const railX = layout.rect.x + 0.7;
          const rail: PathCmd[] = [
            { t: "M", x: railX, y: layout.rect.y + 0.25 },
            { t: "L", x: railX, y: layout.rect.y + layout.rect.h - 0.25 },
          ];
          const taps: PathCmd[] = [];
          for (const p of layout.pins) {
            if (p.name === "bus")
              rail.push({ t: "M", x: p.x, y: p.y }, { t: "L", x: railX, y: p.y });
            else taps.push({ t: "M", x: railX, y: p.y }, { t: "L", x: p.x, y: p.y });
          }
          renderer.drawPath(rail, { ...stroke, lineWidth: 0.22 });
          renderer.drawPath(taps, { ...stroke, lineWidth: 0.14 });
        } else {
          // Match the placed body exactly — an output pin's stadium included
          // (UI_OVERHAUL §55).
          const outPin = ghost.type === "wiring.pin" && ghost.attrs?.isOutput === true;
          const body =
            ghost.type === "wiring.probe"
              ? probePath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h)
              : ghost.type === "mem.ram" || ghost.type === "mem.rom"
                ? chipPath(layout.rect.x, layout.rect.y, layout.rect.w, layout.rect.h)
                : pinBodyPath(layout.rect, outPin);
          renderer.drawPath(body, {
            ...stroke,
            fill: "rgba(91,141,239,0.10)",
          });
        }
      }
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
      // Accent ring + one concise line: the pin's friendly name (the
      // comparator's lt/eq/gt read as words, §33), plus its width only when it
      // is wider than a single bit (§29).
      renderer.drawDots([hit.pos], PIN_R * 1.5, theme.accent);
      const spec = this.layouts.get(hit.compId)?.pins.find((p) => p.name === hit.pin);
      const bits = spec !== undefined && spec.bitsize > 1 ? ` · ${spec.bitsize}b` : "";
      drawCard(renderer, theme, { x: hit.pos.x + 0.6, y: hit.pos.y - 1.0 }, [
        `${pinDisplayName(hit.pin)}${bits}`,
      ]);
    } else if (hit?.kind === "wire" && overlay.wireInProgress !== null) {
      // junction-on-drop preview (only while routing a wire)
      renderer.drawDots([hit.point], PIN_R * 1.3, theme.accent);
    }

    // Wire info card (shift+click): just the value on the wire (UX
    // decision — net metadata was noise). Needs a loaded sim.
    if (overlay.wireInfo !== null) {
      const val = sim?.valueForWire(overlay.wireInfo.wireIdx);
      drawCard(
        renderer,
        theme,
        { x: overlay.wireInfo.pos.x + 0.7, y: overlay.wireInfo.pos.y - 1.6 },
        [val !== undefined ? formatValue(val, "hex") : "no sim loaded"],
      );
    }
  }
}

/** Small floating card (tooltip / info popup) drawn near a world point. */
function drawCard(renderer: Renderer, theme: Theme, pos: Vec2, lines: string[]): void {
  const size = 0.8;
  const lineH = 1.1;
  const padX = 0.45;
  const padY = 0.32;
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

/**
 * Strict-interior crossing of two axis-aligned segments, if any. `axis` is
 * the axis of the second segment (the wire that will hop: horizontal wires
 * bump up, vertical wires bump right). Parallel, degenerate (legacy
 * diagonal) and endpoint-touching configurations return null.
 */
function crossingPoint(a: Vec2, b: Vec2, c: Vec2, d: Vec2): { at: Vec2; axis: "h" | "v" } | null {
  const EPS = 1e-6;
  const abH = Math.abs(a.y - b.y) < 1e-9;
  const abV = Math.abs(a.x - b.x) < 1e-9;
  const cdH = Math.abs(c.y - d.y) < 1e-9;
  const cdV = Math.abs(c.x - d.x) < 1e-9;
  if (abH && cdV) {
    const x = c.x;
    const y = a.y;
    const inA = x > Math.min(a.x, b.x) + EPS && x < Math.max(a.x, b.x) - EPS;
    const inC = y > Math.min(c.y, d.y) + EPS && y < Math.max(c.y, d.y) - EPS;
    return inA && inC ? { at: { x, y }, axis: "v" } : null;
  }
  if (abV && cdH) {
    const x = a.x;
    const y = c.y;
    const inA = y > Math.min(a.y, b.y) + EPS && y < Math.max(a.y, b.y) - EPS;
    const inC = x > Math.min(c.x, d.x) + EPS && x < Math.max(c.x, d.x) - EPS;
    return inA && inC ? { at: { x, y }, axis: "h" } : null;
  }
  return null;
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
