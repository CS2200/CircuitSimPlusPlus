import { describe, expect, it } from "vitest";
import { saveStatePulses, saveStateText } from "./SaveIndicator";

describe("saveStateText (status-bar autosave indicator)", () => {
  it("reports clean / dirty / writing", () => {
    expect(saveStateText({ kind: "clean" }, true)).toBe("Saved");
    // Autosave is going to write this — the tester read "Unsaved changes" as a
    // problem to go fix.
    expect(saveStateText({ kind: "dirty" }, true)).toBe("Saving changes");
    expect(saveStateText({ kind: "saving" }, true)).toBe("Saving…");
  });

  it("stamps the time of the last autosave", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    expect(saveStateText({ kind: "saved", at }, true)).toBe("Saved 09:05");
  });

  it("distinguishes a recovery-only copy from a saved file", () => {
    expect(saveStateText({ kind: "recovered", at: 0 }, true)).toContain("not saved to the file");
  });

  it("surfaces autosave failures", () => {
    expect(saveStateText({ kind: "error", message: "disk full" }, true)).toBe(
      "Autosave failed: disk full",
    );
  });

  it("explains itself when autosave is switched off", () => {
    expect(saveStateText({ kind: "clean" }, false)).toBe("Autosave off");
    expect(saveStateText({ kind: "dirty" }, false)).toBe("Unsaved changes (autosave off)");
  });
});

describe("saveStatePulses (the dot blinks only while writing)", () => {
  it("pulses through the transient write window", () => {
    expect(saveStatePulses({ kind: "dirty" }, true)).toBe(true);
    expect(saveStatePulses({ kind: "saving" }, true)).toBe(true);
  });

  it("stays still once the write has landed", () => {
    expect(saveStatePulses({ kind: "clean" }, true)).toBe(false);
    expect(saveStatePulses({ kind: "saved", at: 0 }, true)).toBe(false);
    // A recovery copy is already on disk — a steady state, not an in-flight write.
    expect(saveStatePulses({ kind: "recovered", at: 0 }, true)).toBe(false);
    expect(saveStatePulses({ kind: "error", message: "disk full" }, true)).toBe(false);
  });

  it("never pulses when autosave is off (its dirty state is steady)", () => {
    expect(saveStatePulses({ kind: "dirty" }, false)).toBe(false);
    expect(saveStatePulses({ kind: "saving" }, false)).toBe(false);
  });
});
