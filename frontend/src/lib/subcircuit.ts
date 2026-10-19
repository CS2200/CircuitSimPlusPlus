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
