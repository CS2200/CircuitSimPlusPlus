import { describe, expect, it } from "vitest";
import { clockTime, relativeAge } from "./time";

describe("clockTime", () => {
  const at = (h: number, m: number) => new Date(2026, 0, 2, h, m).getTime();

  it("is 24-hour by default (unchanged)", () => {
    expect(clockTime(at(14, 32), true)).toBe("14:32");
    expect(clockTime(at(9, 5), true)).toBe("09:05");
  });

  it("reads as h:MM AM/PM when the 24-hour pref is off", () => {
    expect(clockTime(at(14, 32), false)).toBe("2:32 PM");
    expect(clockTime(at(9, 5), false)).toBe("9:05 AM");
    // Midnight and noon are the classic 12-hour edge cases.
    expect(clockTime(at(0, 7), false)).toBe("12:07 AM");
    expect(clockTime(at(12, 0), false)).toBe("12:00 PM");
  });
});

describe("relativeAge", () => {
  it("says how long ago, then falls back to a date", () => {
    const now = new Date(2026, 0, 2, 12, 0).getTime();
    expect(relativeAge(now - 10_000, now)).toBe("just now");
    expect(relativeAge(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeAge(now - 3 * 3600_000, now)).toBe("3 h ago");
    expect(relativeAge(now - 48 * 3600_000, now)).toMatch(/\d/); // a date
  });
});
