import { describe, expect, it } from "vitest";
import { dotPath, rectPath, roundedPath } from "./paths";

describe("roundedPath", () => {
  it("two points → straight M/L", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
        0.12,
      ),
    ).toEqual([
      { t: "M", x: 0, y: 0 },
      { t: "L", x: 5, y: 0 },
    ]);
  });

  it("rounds an interior corner with a quadratic Bézier (DLS look)", () => {
    const cmds = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      0.12,
    );
    expect(cmds).toHaveLength(4);
    expect(cmds[0]).toEqual({ t: "M", x: 0, y: 0 });
    expect(cmds[1]).toMatchObject({ t: "L" });
    expect((cmds[1] as { x: number }).x).toBeCloseTo(9.88, 10);
    expect(cmds[2]).toMatchObject({ t: "Q", cx: 10, cy: 0 });
    expect((cmds[2] as { y: number }).y).toBeCloseTo(0.12, 10);
    expect(cmds[3]).toEqual({ t: "L", x: 10, y: 10 });
  });

  it("clamps the radius to half the shortest adjacent segment", () => {
    const cmds = roundedPath(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 0.2 },
        { x: 0, y: 0.2 },
      ],
      0.12,
    );
    // corner (10,0): in=10, out=0.2 → r=0.1
    expect(cmds[1]).toMatchObject({ t: "L" });
    expect((cmds[1] as { x: number }).x).toBeCloseTo(9.9, 10);
    expect(cmds[2]).toMatchObject({ t: "Q", cx: 10, cy: 0 });
    expect((cmds[2] as { y: number }).y).toBeCloseTo(0.1, 10);
    // corner (10,0.2): in=0.2, out=10 → r=0.1
    expect(cmds[3]).toMatchObject({ t: "L" });
    expect((cmds[3] as { y: number }).y).toBeCloseTo(0.1, 10);
    expect(cmds[4]).toMatchObject({ t: "Q", cx: 10, cy: 0.2 });
    expect((cmds[4] as { x: number }).x).toBeCloseTo(9.9, 10);
    expect(cmds[5]).toEqual({ t: "L", x: 0, y: 0.2 });
  });

  it("radius ≤ 0 → plain polyline", () => {
    expect(
      roundedPath(
        [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
        0,
      ),
    ).toEqual([
      { t: "M", x: 0, y: 0 },
      { t: "L", x: 1, y: 0 },
      { t: "L", x: 1, y: 1 },
    ]);
  });

  it("empty input → no commands", () => {
    expect(roundedPath([], 0.12)).toEqual([]);
  });
});

describe("rectPath / dotPath", () => {
  it("rect outline is a closed path", () => {
    const cmds = rectPath(1, 2, 3, 4);
    expect(cmds[0]).toEqual({ t: "M", x: 1, y: 2 });
    expect(cmds.at(-1)).toEqual({ t: "Z" });
  });

  it("dot is a small closed square", () => {
    const cmds = dotPath(5, 5, 0.1);
    expect(cmds[0]).toMatchObject({ t: "M" });
    expect((cmds[0] as { x: number }).x).toBeCloseTo(4.9, 10);
    expect(cmds.at(-1)).toEqual({ t: "Z" });
  });
});
