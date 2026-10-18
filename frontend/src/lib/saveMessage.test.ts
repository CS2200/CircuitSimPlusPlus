import { describe, expect, it } from "vitest";
import { saveToastText } from "./saveMessage";

/**
 * Saving a document that fails validation is not an error any more: the engine
 * writes it (losing a mid-edit draft is worse) and reports the problems as
 * warnings, so the toast must say "saved" AND name the issue count, pointing at
 * the last clean version for the previous good state.
 */
describe("saveToastText", () => {
  it("is a plain confirmation when the document is clean", () => {
    expect(saveToastText("alu.csx", 0)).toBe("Saved alu.csx");
  });

  it("says the file WAS saved, counts the issues, and points at history", () => {
    const one = saveToastText("alu.csx", 1);
    expect(one).toContain("Saved alu.csx");
    expect(one).toContain("1 issue to fix");
    expect(one).toContain("Version history");

    const many = saveToastText("alu.csx", 3);
    expect(many).toContain("3 issues to fix");
    // Never "Save failed": the bytes are on disk.
    expect(many).not.toContain("failed");
  });
});
