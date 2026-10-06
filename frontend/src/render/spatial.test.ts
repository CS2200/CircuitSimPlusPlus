import { describe, expect, it } from "vitest";
import { UniformGrid } from "./spatial";

describe("UniformGrid", () => {
  it("returns overlapping items, deduplicated and ascending", () => {
    const g = new UniformGrid(4);
    g.insert(3, { x: 0, y: 0, w: 10, h: 1 }); // spans several cells
    g.insert(1, { x: 100, y: 100, w: 2, h: 2 });
    g.insert(2, { x: 3, y: 3, w: 2, h: 2 });
    expect(g.queryRect({ x: -1, y: -1, w: 6, h: 6 })).toEqual([2, 3]);
    expect(g.queryRect({ x: 99, y: 99, w: 4, h: 4 })).toEqual([1]);
    expect(g.queryRect({ x: 500, y: 500, w: 4, h: 4 })).toEqual([]);
    expect(g.size).toBe(3);
  });

  it("remove deletes the item from every cell", () => {
    const g = new UniformGrid(4);
    g.insert(1, { x: 0, y: 0, w: 10, h: 1 });
    g.remove(1, { x: 0, y: 0, w: 10, h: 1 });
    expect(g.queryRect({ x: -1, y: -1, w: 20, h: 5 })).toEqual([]);
    expect(g.size).toBe(0);
  });

  it("update moves an item", () => {
    const g = new UniformGrid(4);
    g.insert(7, { x: 0, y: 0, w: 1, h: 1 });
    g.update(7, { x: 0, y: 0, w: 1, h: 1 }, { x: 40, y: 40, w: 1, h: 1 });
    expect(g.queryRect({ x: -1, y: -1, w: 4, h: 4 })).toEqual([]);
    expect(g.queryRect({ x: 39, y: 39, w: 4, h: 4 })).toEqual([7]);
  });

  it("handles negative coordinates", () => {
    const g = new UniformGrid(4);
    g.insert(1, { x: -10, y: -10, w: 2, h: 2 });
    expect(g.queryRect({ x: -11, y: -11, w: 4, h: 4 })).toEqual([1]);
  });

  it("scales to stress-scene sizes", () => {
    const g = new UniformGrid(8);
    for (let i = 0; i < 20000; i++) {
      g.insert(i, { x: (i % 200) * 2, y: Math.floor(i / 200), w: 1, h: 1 });
    }
    expect(g.size).toBe(20000);
    expect(g.queryRect({ x: 0, y: 0, w: 10, h: 10 }).length).toBeGreaterThan(0);
  });
});
