import { describe, expect, it } from "vitest";
import { PulseTracker, PULSE_MS } from "./pulses";

describe("PulseTracker (U7)", () => {
  it("spawned pulses advance phase over PULSE_MS, then expire", () => {
    const t = new PulseTracker();
    t.spawn([{ net: 3 }, { net: 7 }], 1000);
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
    t.spawn([{ net: 1 }], 0);
    t.spawn([{ net: 2 }], PULSE_MS / 2);
    const live = t.active(PULSE_MS / 2)!;
    expect(live).toEqual([
      { net: 1, phase: 0.5 },
      { net: 2, phase: 0 },
    ]);
    t.clear();
    expect(t.active(PULSE_MS / 2 + 1)).toBeNull();
  });

  it("`at` timestamps stagger spawns: later events start later (v1.1)", () => {
    const t = new PulseTracker();
    // 20 ns apart → 20% of PULSE_MS stagger (100 ns window = one PULSE_MS).
    t.spawn(
      [
        { net: 1, at: 20 },
        { net: 2, at: 40 },
      ],
      1000,
    );
    // At tNow the first pulse is live; the second is still pending (phase<0
    // → kept but not rendered), so only net 1 shows.
    expect(t.active(1000)).toEqual([{ net: 1, phase: 0 }]);
    // At the stagger boundary both are live, causally ordered.
    const live = t.active(1000 + 0.2 * PULSE_MS)!;
    expect(live).toEqual([
      { net: 1, phase: 0.2 },
      { net: 2, phase: 0 },
    ]);
    // The staggered pulse outlives the immediate one by the stagger.
    const late = t.active(1000 + PULSE_MS)!;
    expect(late).toEqual([{ net: 2, phase: 0.8 }]);
    expect(t.active(1000 + PULSE_MS * 1.2 + 1)).toBeNull();
  });

  it("untimed events (zero mode) spawn immediately even alongside timed ones", () => {
    const t = new PulseTracker();
    t.spawn([{ net: 1, at: 50 }, { net: 2 }], 0);
    const live = t.active(0)!;
    expect(live).toEqual([
      { net: 1, phase: 0 },
      { net: 2, phase: 0 },
    ]);
  });

  it("huge `at` spreads clamp the stagger to one PULSE_MS", () => {
    const t = new PulseTracker();
    t.spawn(
      [
        { net: 1, at: 0 },
        { net: 2, at: 1_000_000 },
      ],
      0,
    );
    // net 2 starts exactly one PULSE_MS after tNow, no further.
    expect(t.active(PULSE_MS)).toEqual([{ net: 2, phase: 0 }]);
    expect(t.active(2 * PULSE_MS)).toBeNull();
  });
});
