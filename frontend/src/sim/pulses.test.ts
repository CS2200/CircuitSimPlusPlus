import { describe, expect, it } from "vitest";
import { PulseTracker, PULSE_MS } from "./pulses";

describe("PulseTracker (U7)", () => {
  it("spawned pulses advance phase over PULSE_MS, then expire", () => {
    const t = new PulseTracker();
    t.spawn([3, 7], 1000);
    expect(t.active(1000)).toEqual([
      { net: 3, phase: 0 },
      { net: 7, phase: 0 },
    ]);
    const mid = t.active(1000 + PULSE_MS / 2)!;
    expect(mid[0].phase).toBeCloseTo(0.5);
    expect(t.active(1000 + PULSE_MS)).toBeNull(); // expired
    expect(t.active(1000 + PULSE_MS + 10)).toBeNull(); // stays empty
  });

  it("phases are per-spawn time; clear() drops everything", () => {
    const t = new PulseTracker();
    t.spawn([1], 0);
    t.spawn([2], PULSE_MS / 2);
    const live = t.active(PULSE_MS / 2)!;
    expect(live).toEqual([
      { net: 1, phase: 0.5 },
      { net: 2, phase: 0 },
    ]);
    t.clear();
    expect(t.active(PULSE_MS / 2 + 1)).toBeNull();
  });
});
