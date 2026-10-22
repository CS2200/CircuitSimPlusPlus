/**
 * The published delay table, read at BUILD time — the normative data is
 * `crates/core/data/cs2200-74ls-v1.json` (docs/delay-table.md), so the editor
 * shows exactly the numbers the engine uses instead of a second copy that could
 * drift.
 *
 * What the Inspector shows are *table* values: what a part contributes by design
 * (and what STA bounds). The timing report's `top_paths` carry what a run
 * actually observed (DTA). They are deliberately different numbers: one explains
 * the design, the other grades it.
 */
import table from "../../../crates/core/data/cs2200-74ls-v1.json";

/** One component kind's entries in the table, all optional per kind. */
interface KindDelay {
  /** Propagation delay from an input to the output (ns). */
  prop?: number;
  /** Extra delay per bit beyond the first (wide arithmetic). */
  perBit?: number;
  /** Memory read access time (ns). */
  access?: number;
  /** Setup window before the clock edge (ns). */
  setup?: number;
  /** Hold window after the clock edge (ns). */
  hold?: number;
}

const KINDS = table.components as Record<string, KindDelay>;

/** Per-grid-unit wire delay in ns, from the table's `wire` fraction. */
export function wireDelayPerUnit(): number {
  const wire = table.wire as { num: number; den: number };
  return wire.num / wire.den;
}

/**
 * One line of table timings for a component type ("prop 20 ns · setup 15 ns ·
 * hold 5 ns"), or null when the table says nothing about it (a subcircuit, a
 * pin, a text annotation — parts with no published cost).
 */
export function componentDelayText(type: string): string | null {
  const d = KINDS[type];
  if (d === undefined) return null;
  const parts: string[] = [];
  if (d.prop !== undefined) {
    parts.push(
      d.perBit === undefined ? `prop ${d.prop} ns` : `prop ${d.prop} ns + ${d.perBit}/bit`,
    );
  }
  if (d.access !== undefined) parts.push(`access ${d.access} ns`);
  if (d.setup !== undefined) parts.push(`setup ${d.setup} ns`);
  if (d.hold !== undefined) parts.push(`hold ${d.hold} ns`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** Table delay for a wire of `length` grid units (per-path, docs/delay-table.md). */
export function wireDelayText(lengthUnits: number): string {
  // Wire propagation ships off (`wire.num = 0`, Head-TA decision): say so rather than
  // showing a "0.00 ns/unit" that looks like a property of this particular wire.
  if (wireDelayPerUnit() === 0) {
    return `≈ 0.0 ns (${lengthUnits.toFixed(1)} units · wire propagation is off)`;
  }
  const ns = lengthUnits * wireDelayPerUnit();
  return `≈ ${ns.toFixed(1)} ns (${lengthUnits.toFixed(1)} units × ${wireDelayPerUnit().toFixed(2)} ns)`;
}
