import type { CsxCircuit } from "../model/csx";
import {
  circuitTree,
  rootCircuitName,
  unplacedCircuits,
  type CircuitTreeNode,
} from "../lib/subcircuit";

/**
 * The circuit hierarchy, as a navigator (the right dock's empty state).
 *
 * The left rail no longer carries a separate "Circuits" explorer: a file's
 * circuits are *definitions*, and what a student needs to see is how they nest
 * from the simulation root. This row per circuit, indented by depth, is that
 * view — click one to open its sheet (which reopens its tab if it was closed).
 * Instances of one definition on one sheet collapse into a single `×N` row, and
 * definitions the root cannot reach sit under "Not instantiated" so they stay
 * reachable.
 */
export default function CircuitTree({
  circuits,
  activeName,
  onOpen,
}: {
  circuits: readonly CsxCircuit[];
  /** The circuit on the canvas (highlighted). */
  activeName: string;
  onOpen: (name: string) => void;
}) {
  const tree = circuitTree(circuits);
  if (tree === null) return null;
  const root = rootCircuitName(circuits);

  const rows: { node: CircuitTreeNode; depth: number }[] = [];
  const flatten = (node: CircuitTreeNode, depth: number): void => {
    rows.push({ node, depth });
    for (const child of node.children) flatten(child, depth + 1);
  };
  flatten(tree, 0);

  const unplaced = unplacedCircuits(circuits);

  return (
    <ul className="circuit-tree" role="tree" aria-label="Circuits">
      {rows.map(({ node, depth }, i) => (
        <li key={`${i}:${node.name}`}>
          <button
            type="button"
            role="treeitem"
            aria-level={depth + 1}
            aria-selected={node.name === activeName}
            aria-current={node.name === activeName ? "true" : undefined}
            className={`circuit-node${node.name === activeName ? " active" : ""}`}
            style={{ paddingLeft: 8 + depth * 15 }}
            title={
              node.repeat
                ? `${node.name} — already shown above`
                : node.name === root
                  ? `${node.name} — the simulation root`
                  : `Open ${node.name}`
            }
            onClick={() => onOpen(node.name)}
          >
            <span className="circuit-node-caret" aria-hidden="true">
              {node.repeat ? "↻" : node.children.length > 0 ? "▾" : "•"}
            </span>
            <span className="circuit-node-name">{node.name}</span>
            {node.repeat && <span className="circuit-node-note">again</span>}
            {!node.repeat && node.count > 1 && (
              <span className="circuit-node-count">×{node.count}</span>
            )}
            {node.name === root && <span className="circuit-node-note">root</span>}
          </button>
        </li>
      ))}
      {unplaced.length > 0 && (
        <li className="circuit-tree-sep" aria-hidden="true">
          Not instantiated
        </li>
      )}
      {unplaced.map((name) => (
        <li key={`unplaced:${name}`}>
          <button
            type="button"
            role="treeitem"
            aria-level={1}
            aria-selected={name === activeName}
            aria-current={name === activeName ? "true" : undefined}
            className={`circuit-node${name === activeName ? " active" : ""}`}
            style={{ paddingLeft: 8 }}
            title={`Open ${name} — no instance places it yet`}
            onClick={() => onOpen(name)}
          >
            <span className="circuit-node-caret" aria-hidden="true">
              •
            </span>
            <span className="circuit-node-name">{name}</span>
            <span className="circuit-node-note">not placed</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
