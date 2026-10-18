/**
 * The toast text for a save (P2 "save with warnings").
 *
 * A save that WROTE the file but found validation problems is still a success:
 * refusing the write would lose a student's mid-edit draft, so the engine
 * writes it and hands the problems back as warnings. This phrasing reports the
 * count, says the file was written, and points at the previous good state.
 */

/** `Saved alu.csx`, or a warning with the issue count. */
export function saveToastText(name: string, issues: number): string {
  if (issues === 0) return `Saved ${name}`;
  return (
    `Saved ${name} with ${issues} issue${issues === 1 ? "" : "s"} to fix — ` +
    "the last clean version is in Version history"
  );
}
