import { describe, expect, it } from "vitest";
import { saveStateText } from "./SaveIndicator";

describe("saveStateText (status-bar autosave indicator)", () => {
  it("reports clean / dirty / writing", () => {
    expect(saveStateText({ kind: "clean" }, true)).toBe("All changes saved");
    expect(saveStateText({ kind: "dirty" }, true)).toBe("Unsaved changes");
    expect(saveStateText({ kind: "saving" }, true)).toBe("Saving…");
  });

  it("stamps the time of the last autosave", () => {
    const at = new Date(2026, 0, 2, 9, 5).getTime();
    expect(saveStateText({ kind: "saved", at }, true)).toBe("All changes saved 09:05");
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
