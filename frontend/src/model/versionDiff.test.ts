import { describe, expect, it } from "vitest";
import { CSX_FORMAT, CSX_VERSION } from "./csx";
import { CircuitDocument } from "./document";
import { diffDocuments, diffLines, diffSummary } from "./versionDiff";

type Part = { id: string; type: string; pos?: [number, number]; attrs?: Record<string, unknown> };
type Wire = { points: [number, number][] };

function doc(parts: Part[] = [], wires: Wire[] = [], sheets?: Record<string, unknown>[]) {
  const circuitOf = (components: Part[], wiresIn: Wire[]) => ({
    name: "main",
    components: components.map((c) => ({ pos: [0, 0] as [number, number], ...c })),
    wires: wiresIn.map((w, i) => ({
      a: { comp: `w${i}`, pin: "y" },
      b: { comp: `w${i}`, pin: "a" },
      points: w.points,
    })),
  });
  return CircuitDocument.fromData({
    format: CSX_FORMAT,
    version: CSX_VERSION,
    name: "untitled",
    settings: { clockHz: 1, delayTable: "cs2200-74ls-v1" },
    circuits: sheets ?? [circuitOf(parts, wires)],
  } as never);
}

const gate = (id: string, bits: number): Part => ({ id, type: "gate.and", attrs: { bits } });

describe("diffDocuments (current → version)", () => {
  it("reports no differences for the same document", () => {
    const a = doc([gate("1", 4)]);
    const diff = diffDocuments(a, doc([gate("1", 4)]));
    expect(diffSummary(diff)).toBe("No differences from the open document");
    expect(diffLines(diff)).toEqual([]);
  });

  it("finds added, removed and changed parts", () => {
    const current = doc([gate("1", 4), { id: "2", type: "gate.not" }]);
    const version = doc([gate("1", 8), gate("3", 2)]);
    const diff = diffDocuments(current, version);

    expect(diff.partsAdded).toEqual([{ id: "3", type: "gate.and" }]);
    expect(diff.partsRemoved).toEqual([{ id: "2", type: "gate.not" }]);
    expect(diff.changed).toEqual([
      { id: "1", type: "gate.and", fields: [{ field: "bits", from: "4", to: "8" }] },
    ]);
    expect(diffSummary(diff)).toBe("1 part added · 1 part removed · 1 part changed");
    expect(diffLines(diff)).toEqual([
      "+ gate.and (3)",
      "~ gate.and (1): bits 4 → 8",
      "− gate.not (2)",
    ]);
  });

  it("counts wires as a multiset, so identical wires cancel out", () => {
    const shared: Wire = { points: [[0, 0], [1, 0]] };
    const current = doc([], [shared, { points: [[2, 0], [3, 0]] }]);
    const version = doc([], [shared, { points: [[4, 0], [5, 0]] }]);
    const diff = diffDocuments(current, version);
    expect(diff.wiresAdded).toBe(1);
    expect(diff.wiresRemoved).toBe(1);
    expect(diffSummary(diff)).toBe("1 wire added · 1 wire removed");
  });

  it("notices a moved part", () => {
    const current = doc([{ id: "1", type: "gate.and", pos: [0, 0] }]);
    const version = doc([{ id: "1", type: "gate.and", pos: [4, 6] }]);
    const diff = diffDocuments(current, version);
    expect(diff.changed).toEqual([
      { id: "1", type: "gate.and", fields: [{ field: "pos", from: "[0,0]", to: "[4,6]" }] },
    ]);
  });

  it("names whole sheets that appear or disappear", () => {
    const main = { name: "main", components: [], wires: [] };
    const alu = { name: "alu", components: [], wires: [] };
    const diff = diffDocuments(doc([], [], [main]), doc([], [], [main, alu]));
    expect(diff.sheetsAdded).toEqual(["alu"]);
    expect(diffSummary(diff)).toBe("sheet alu added");
  });

  it("caps the detail list on a big rewrite", () => {
    const parts = Array.from({ length: 12 }, (_, i) => gate(String(i), 1));
    const diff = diffDocuments(doc([]), doc(parts));
    const lines = diffLines(diff, 5);
    expect(lines).toHaveLength(6); // 5 kept + "…and N more"
    expect(lines[5]).toContain("more");
  });
});
