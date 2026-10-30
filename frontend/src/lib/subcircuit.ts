import type { CsxCircuit } from "../model/csx";

/**
 * Subcircuit helpers (UI_OVERHAUL §80).
 *
 * A definition means nothing on its own — what matters is who places it. The
 * palette's Subcircuits group and the scope bar both ask the same question ("which
 * sheets instantiate this circuit?"), so the answer lives here rather than being
 * re-derived per screen.
 */

/** Sheets that place an instance of `name`, in document order. */
export function instantiators(circuits: readonly CsxCircuit[], name: string): string[] {
  const out: string[] = [];
  for (const circuit of circuits) {
    const uses = circuit.components.some(
      (c) => c.type === "subcircuit" && c.attrs?.["circuit"] === name,
    );
    if (uses && !out.includes(circuit.name)) out.push(circuit.name);
  }
  return out;
}

/** One phrase for the UI: "used by main, alu", or "not placed yet". */
export function usedByText(circuits: readonly CsxCircuit[], name: string): string {
  const users = instantiators(circuits, name);
  return users.length === 0 ? "not placed yet" : `used by ${users.join(", ")}`;
}

/**
 * The engine's simulation root: the circuit named `main` when it exists, else
 * the first circuit (format-v2 §3). This is what the hierarchy tree is rooted
 * at, so it agrees with the netlist the simulator actually builds.
 */
export function rootCircuitName(circuits: readonly CsxCircuit[]): string | null {
  if (circuits.length === 0) return null;
  return circuits.some((c) => c.name === "main") ? "main" : circuits[0].name;
}

/** One node of the instantiation tree (a circuit *definition*). */
export interface CircuitTreeNode {
  name: string;
  /** How many instances of it sit on the parent (`×N`). */
  count: number;
  /** Definitions its own sheet instantiates (deduped siblings), outermost first. */
  children: CircuitTreeNode[];
  /** Already an ancestor — a repeated definition; drawn but not expanded. */
  repeat: boolean;
}

/** The distinct subcircuit targets used inside `name`, in document order, counted. */
function usedTargets(
  circuits: readonly CsxCircuit[],
  name: string,
): { target: string; count: number }[] {
  const c = circuits.find((x) => x.name === name);
  if (c === undefined) return [];
  const order: string[] = [];
  const counts = new Map<string, number>();
  for (const comp of c.components) {
    if (comp.type !== "subcircuit") continue;
    const target = comp.attrs?.["circuit"];
    // A dangling target has no node to open; validation reports it elsewhere.
    if (typeof target !== "string" || target === "") continue;
    if (!circuits.some((x) => x.name === target)) continue;
    if (!counts.has(target)) order.push(target);
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  return order.map((target) => ({ target, count: counts.get(target) ?? 1 }));
}

/**
 * The instantiation tree as a struggling student sees it: rooted at the
 * simulation root, each definition nested under the sheet that places it, with
 * a count when a sheet holds several instances. Siblings are deduped by target,
 * so 32 registers read as one node (`reg ×32`) rather than 32 rows.
 */
export function circuitTree(circuits: readonly CsxCircuit[]): CircuitTreeNode | null {
  const root = rootCircuitName(circuits);
  if (root === null) return null;
  const build = (name: string, ancestors: readonly string[]): CircuitTreeNode => {
    const repeat = ancestors.includes(name);
    const children = repeat
      ? []
      : usedTargets(circuits, name).map(({ target, count }) => ({
          ...build(target, [...ancestors, name]),
          count,
        }));
    return { name, count: 1, children, repeat };
  };
  return build(root, []);
}

/**
 * Definitions the root cannot reach (never placed, or only used by an
 * unreachable island). They still belong on the navigator so they can be
 * opened and edited; the tree just cannot show them under `main`.
 */
export function unplacedCircuits(circuits: readonly CsxCircuit[]): string[] {
  const root = rootCircuitName(circuits);
  if (root === null) return [];
  const reachable = new Set<string>();
  const walk = (name: string): void => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const { target } of usedTargets(circuits, name)) walk(target);
  };
  walk(root);
  return circuits.map((c) => c.name).filter((n) => !reachable.has(n));
}
