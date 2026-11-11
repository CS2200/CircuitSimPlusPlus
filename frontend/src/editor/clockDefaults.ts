/**
 * Wire a newly placed part's `clk`/`rst` pins to the circuit's clock and reset — the UI's
 * half of the rule in DESIGN.md §4.3 ("Clock — one source, by default"; the reset source is
 * the bullet below it).
 *
 * CircuitSim CE's parts follow **one global clock**, so no course design ever has an
 * unwired clock. In the new model the pins are always in the part (format-v2 §4), so a
 * placement would otherwise drop a component into a design that reads a floating net — the
 * exact situation the old tool avoided by not having the pin at all. Placing therefore
 * wires it: **at the root to the design's own source parts** — the `wiring.clock` and the
 * `wiring.reset`, creating either when absent — and in a **subcircuit** to a `wiring.pin`
 * named `CLK` / `RST`, creating that port when the circuit has none. A subcircuit needs the
 * port because a net cannot cross a circuit boundary; a root pin would be a control nothing
 * drives.
 *
 * The convention is a *convenience*, not a format rule. A wire's `name` is a **label, not a
 * joining rule** (format-v2 §9) — the connection is the wire, and the label is what makes
 * the canvas read like the course's tunnels. `CLOCK`/`RESET` in any capitalisation are
 * accepted when *finding* a source, because people type `Clock`; the Inspector says what
 * the convention is, and a **custom clock stays a re-route away** — a part whose `clk` is
 * fed by logic follows that logic, not the global clock.
 *
 * One undo step: the caller passes the placement's coalesce key, so the part and the wiring
 * it caused undo together.
 */
import { compSize, compSpec } from "./catalog";
import { compLayout, pinPosition } from "./layout";
import { inflateRect, rectIntersects, type Rect, type Vec2 } from "../render/geom";
import { routeLeg, type LegEnd } from "./route";
import type { CircuitDocument } from "../model/document";
import type { CsxCircuit, CsxComponent } from "../model/csx";

/** Which pins are wired by default, the names a source may already carry, and the label a
 * created source gets. Case-insensitive on the way *in*, canonical on the way *out*. */
const DEFAULTS: Record<string, { aliases: string[]; label: string }> = {
  clk: { aliases: ["clk", "clock"], label: "CLK" },
  rst: { aliases: ["rst", "reset"], label: "RST" },
};

let placeSeq = 0;

/**
 * A fresh coalesce key for one placement: it groups the placed part with the wiring this
 * module adds for it, and — being unique — never merges two placements into one undo step.
 */
export function nextPlaceSeq(): number {
  return ++placeSeq;
}

/** The pin of a source component a default wire attaches to. */
const SOURCE_PIN: Record<string, string> = {
  "wiring.pin": "pin",
  "wiring.clock": "out",
  "wiring.reset": "out",
};

/**
 * The source part a **root** circuit's default prefers, per convention (DESIGN.md §4.3).
 * A root `CLK`/`RST` pin would have nothing driving it — the design's clock and reset are
 * parts, so the root gets the part instead. Subcircuits still get a `wiring.pin` named
 * `CLK`/`RST`, because a net cannot cross a circuit boundary and the port is the bridge.
 */
const ROOT_SOURCE: Record<string, string> = {
  CLK: "wiring.clock",
  RST: "wiring.reset",
};

function findSource(c: CsxCircuit, aliases: string[]): CsxComponent | undefined {
  return c.components.find(
    (x) => x.type === "wiring.pin" && aliases.includes((x.name ?? "").toLowerCase()),
  );
}

function pinOf(comp: CsxComponent, preferred?: string): string {
  const known = SOURCE_PIN[comp.type];
  if (known !== undefined) return known;
  const pins = compSpec(comp.type).pins(comp.attrs ?? {});
  if (preferred !== undefined) {
    const hit = pins.find((p) => p.name === preferred && p.kind !== "in");
    if (hit !== undefined) return hit.name;
  }
  const out = pins.find((p) => p.kind === "out");
  return (out ?? pins[0]).name;
}

/** Does an axis-aligned segment (possibly diagonal) touch `r`? Slab clip. */
function segmentHitsRect(a: Vec2, b: Vec2, r: Rect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const p = [-dx, dx, -dy, dy];
  const q = [a.x - r.x, r.x + r.w - a.x, a.y - r.y, r.y + r.h - a.y];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const t = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
      if (t0 > t1) return false;
    }
  }
  return true;
}

/** True when a body rect is clear of every component body and wire segment. */
function freeRect(doc: CircuitDocument, circuitIdx: number, rect: Rect, margin: number): boolean {
  const circuits = doc.circuits;
  const inflated = inflateRect(rect, margin);
  for (const comp of circuits[circuitIdx].components) {
    if (rectIntersects(inflated, compLayout(comp, circuits).rect)) return false;
  }
  for (const w of circuits[circuitIdx].wires) {
    for (let s = 0; s + 1 < w.points.length; s++) {
      const a = { x: w.points[s][0], y: w.points[s][1] };
      const b = { x: w.points[s + 1][0], y: w.points[s + 1][1] };
      if (segmentHitsRect(a, b, inflated)) return false;
    }
  }
  return true;
}

/**
 * A free spot for a default clock/reset source. Clocked parts put their control
 * pins on the bottom edge, so "below the part" is tried first: the default wire
 * then leaves down and never crosses the body. Later rings step farther out
 * when the near slots are occupied; each caller creates its source immediately,
 * so the clock and reset cannot land on top of each other.
 */
export function freeSourcePosition(
  doc: CircuitDocument,
  circuitIdx: number,
  placed: CsxComponent,
  sourceType: string,
): [number, number] {
  const circuits = doc.circuits;
  const pr = compLayout(placed, circuits).rect;
  const attrs = sourceType === "wiring.pin" ? { bitsize: 1 } : {};
  const { w, h } = compSize({ type: sourceType, attrs }, circuits);
  const gap = 2;
  for (let ring = 0; ring < 8; ring++) {
    const d = gap + ring * 4;
    const candidates: [number, number][] = [
      [pr.x, pr.y + pr.h + d], // below-left
      [pr.x + pr.w + d, pr.y + pr.h + d], // below-right
      [pr.x + pr.w + d, pr.y], // right
      [pr.x - w - d, pr.y], // left
      [pr.x, pr.y - h - d], // above-left
      [pr.x + pr.w + d, pr.y - h - d], // above-right
      [pr.x - w - d, pr.y + pr.h - h], // left-below
      [pr.x - w - d, pr.y - h - d], // left-above
    ];
    for (const [x, y] of candidates) {
      if (freeRect(doc, circuitIdx, { x, y, w, h }, 1)) return [x, y];
    }
  }
  return [pr.x, pr.y + pr.h + gap];
}

/** The pin's route end: its outward facing and the body it must clear. */
function legEnd(comp: CsxComponent, pin: string, circuits: readonly CsxCircuit[]): LegEnd {
  const layout = compLayout(comp, circuits);
  const p = layout.pins.find((x) => x.name === pin);
  return { dir: p?.facing ?? null, body: layout.rect };
}

/** Orthogonal default wire, clearance-aware; falls back to a plain L. */
function routeDefault(a: Vec2, aEnd: LegEnd, b: Vec2, bEnd: LegEnd): [number, number][] {
  const raw = routeLeg(a, aEnd, b, bEnd);
  const pts = raw.filter(
    (p, i) => i === 0 || Math.abs(p.x - raw[i - 1].x) > 1e-9 || Math.abs(p.y - raw[i - 1].y) > 1e-9,
  );
  if (pts.length >= 2) return pts.map((p) => [p.x, p.y] as [number, number]);
  return [
    [a.x, a.y],
    [b.x, b.y],
  ];
}

/**
 * Wire `compId`'s default pins (see the module doc). Called right after a placement, with
 * that placement's coalesce key.
 */
export function applyClockDefaults(
  doc: CircuitDocument,
  circuitIdx: number,
  compId: string,
  type: string,
  coalesceKey: string,
): void {
  const placed = doc.circuits[circuitIdx]?.components.find((x) => x.id === compId);
  if (placed === undefined) return;

  for (const pin of compSpec(type).pins(placed.attrs ?? {})) {
    const def = DEFAULTS[pin.name.toLowerCase()];
    if (def === undefined) continue;

    let circuit = doc.circuits[circuitIdx];
    let source: CsxComponent | undefined = findSource(circuit, def.aliases);

    // The design's own clock and reset at the root: a part follows them, and a root
    // `CLK`/`RST` pin would have nothing driving it.
    if (source === undefined && circuitIdx === 0) {
      const want = ROOT_SOURCE[def.label];
      if (want !== undefined) {
        source = circuit.components.find((x) => x.type === want);
        if (source === undefined) {
          const id = doc.addComponent(
            circuitIdx,
            { type: want, pos: freeSourcePosition(doc, circuitIdx, placed, want) },
            coalesceKey,
          );
          circuit = doc.circuits[circuitIdx];
          source = circuit.components.find((x) => x.id === id);
        }
      }
    }

    if (source === undefined) {
      const id = doc.addComponent(
        circuitIdx,
        {
          type: "wiring.pin",
          pos: freeSourcePosition(doc, circuitIdx, placed, "wiring.pin"),
          name: def.label,
          attrs: { bitsize: 1 },
        },
        coalesceKey,
      );
      circuit = doc.circuits[circuitIdx];
      source = circuit.components.find((x) => x.id === id);
    }
    if (source === undefined) continue;

    // The model wants a real polyline (a wire needs ≥ 2 points). The router
    // leaves each pin along its facing and clears both bodies, so a source
    // below the part gives a wire that does not cross the part's own copper.
    const from = { comp: compId, pin: pin.name };
    const to = { comp: source.id, pin: pinOf(source, "out") };
    const circuits = doc.circuits;
    const here = circuits[circuitIdx].components;
    const fromComp = here.find((x) => x.id === from.comp);
    const toComp = here.find((x) => x.id === to.comp);
    if (fromComp === undefined || toComp === undefined) continue;
    const a = pinPosition(fromComp, from.pin, circuits);
    const b = pinPosition(toComp, to.pin, circuits);
    if (a === null || b === null) continue;
    if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9) continue; // coincident
    const points = routeDefault(
      a,
      legEnd(fromComp, from.pin, circuits),
      b,
      legEnd(toComp, to.pin, circuits),
    );
    doc.addWire(
      circuitIdx,
      {
        a: from,
        b: to,
        points,
        name: def.label,
      },
      coalesceKey,
    );
  }
}
