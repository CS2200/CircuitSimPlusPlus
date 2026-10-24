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
import { compSpec } from "./catalog";
import { pinPosition } from "./layout";
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
            { type: want, pos: [placed.pos[0], placed.pos[1] - 6] },
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
          pos: [placed.pos[0] - 8, placed.pos[1]],
          name: def.label,
          attrs: { bitsize: 1 },
        },
        coalesceKey,
      );
      circuit = doc.circuits[circuitIdx];
      source = circuit.components.find((x) => x.id === id);
    }
    if (source === undefined) continue;

    // The model wants a real polyline (a wire needs ≥ 2 points); a Manhattan L between
    // the two pins is what the old tool's routing produced, and re-routing is one drag.
    const from = { comp: compId, pin: pin.name };
    const to = { comp: source.id, pin: pinOf(source, "out") };
    const circuits = doc.circuits;
    const here = circuits[circuitIdx].components;
    const a = pinPosition(
      here.find((x) => x.id === from.comp)!,
      from.pin,
      circuits,
    );
    const b = pinPosition(
      here.find((x) => x.id === to.comp)!,
      to.pin,
      circuits,
    );
    if (a === null || b === null) continue;
    doc.addWire(
      circuitIdx,
      {
        a: from,
        b: to,
        points: [
          [a.x, a.y],
          [a.x, b.y],
          [b.x, b.y],
        ],
        name: def.label,
      },
      coalesceKey,
    );
  }
}
