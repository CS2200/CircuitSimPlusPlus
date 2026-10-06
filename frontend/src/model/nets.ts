import { isPinEndpoint, pinKey, type CsxCircuit } from "./csx";

/**
 * Client-side net derivation (FRONTEND.md U2): union-find over wire
 * endpoints and junctions (DESIGN.md §5.1 — "nets are derived, not
 * stored"). Powers net-extent hover highlight pre-integration; after U5,
 * the engine's `LoadResult.net_map` is authoritative and this stays as the
 * editing-time derivation (semantics must match — same union-find over the
 * same wire graph).
 *
 * Electrical model: each wire is one node (a junction onto any segment of
 * wire W is electrically W's node); a wire unions its two endpoints.
 * Output ordering is fully deterministic: nets sort by smallest member
 * wire index; member lists are sorted.
 */

export interface NetInfo {
  /** Editor-internal id (n0…nk), stable for a given document state. */
  id: number;
  wires: number[];
  /** Pin members, "compId:pin". */
  pins: string[];
}

export interface NetDerivation {
  nets: NetInfo[];
  wireToNet: Map<number, number>;
  pinToNet: Map<string, number>;
  /** Structural problems found during derivation (never thrown). */
  errors: string[];
}

class UnionFind {
  private readonly parent = new Map<string, string>();

  find(x: string): string {
    let root = x;
    while (true) {
      const p = this.parent.get(root);
      if (p === undefined || p === root) break;
      root = p;
    }
    // Path compression.
    let cur = x;
    while (cur !== root) {
      const next = this.parent.get(cur) ?? cur;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

/** Union-find node key for a wire. */
function wireNode(idx: number): string {
  return `w:${idx}`;
}

/** Union-find node key for a pin endpoint. */
function pinNode(comp: string, pin: string): string {
  return `p:${pinKey(comp, pin)}`;
}

export function deriveNets(circuit: CsxCircuit): NetDerivation {
  const uf = new UnionFind();
  const errors: string[] = [];
  const broken = new Set<number>();

  circuit.wires.forEach((w, i) => {
    const nodeA = endpointNode(w.a, circuit, i, errors);
    const nodeB = endpointNode(w.b, circuit, i, errors);
    if (nodeA === null || nodeB === null) {
      broken.add(i); // broken wire: error marked, belongs to no net
      return;
    }
    // Each wire is one electrical node joining its two endpoints; a junction
    // endpoint resolves to the parent wire's node, merging the two wires.
    uf.union(wireNode(i), nodeA);
    uf.union(wireNode(i), nodeB);
  });

  // Collect groups: every wire belongs to a net; pins ride along.
  const groups = new Map<string, { wires: number[]; pins: string[] }>();
  const pinSet = new Set<string>();

  circuit.wires.forEach((w, i) => {
    if (broken.has(i)) return;
    const root = uf.find(wireNode(i));
    let g = groups.get(root);
    if (g === undefined) {
      g = { wires: [], pins: [] };
      groups.set(root, g);
    }
    g.wires.push(i);
    for (const e of [w.a, w.b]) {
      if (isPinEndpoint(e)) {
        const key = pinKey(e.comp, e.pin);
        if (!pinSet.has(`${i}:${key}`)) {
          pinSet.add(`${i}:${key}`);
          if (!g.pins.includes(key)) g.pins.push(key);
        }
      }
    }
  });

  const netList = [...groups.values()].sort((a, b) => Math.min(...a.wires) - Math.min(...b.wires));
  const nets: NetInfo[] = netList.map((g, id) => ({
    id,
    wires: [...g.wires].sort((a, b) => a - b),
    pins: [...g.pins].sort(),
  }));

  const wireToNet = new Map<number, number>();
  const pinToNet = new Map<string, number>();
  for (const net of nets) {
    for (const i of net.wires) wireToNet.set(i, net.id);
    for (const p of net.pins) pinToNet.set(p, net.id);
  }
  return { nets, wireToNet, pinToNet, errors };
}

function endpointNode(
  e: CsxCircuit["wires"][number]["a"],
  circuit: CsxCircuit,
  wireIdx: number,
  errors: string[],
): string | null {
  if (isPinEndpoint(e)) {
    if (!circuit.components.some((c) => c.id === e.comp)) {
      errors.push(`wire ${wireIdx} references missing component "${e.comp}"`);
      return null;
    }
    return pinNode(e.comp, e.pin);
  }
  if (e.join.wire < 0 || e.join.wire >= circuit.wires.length) {
    errors.push(`wire ${wireIdx} junctions onto missing wire ${e.join.wire}`);
    return null;
  }
  return wireNode(e.join.wire);
}
