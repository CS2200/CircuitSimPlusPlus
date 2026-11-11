import { useEffect, useState, type MouseEvent } from "react";
import type { NamedComponent, Watch } from "../ipc/types";
import Select from "./Select";

/**
 * "Run until…" (contract v1.6): define one or more stop conditions and run. Each
 * watches a named register/probe — `stable` (unchanged for N boundaries),
 * `changes` (N transitions), `reaches` (becomes a value) or `is` (equals a
 * value). The engine stops with `reason: "stop"` when one holds, and the run
 * carries on from there like a breakpoint. `stable`/`changes` are the two halves
 * of CS 2200's CPU rule (PC unchanged for 100 / PC changed 10000 times).
 */

type When = Watch["when"];

interface Row {
  name: string;
  when: When;
  /** `cycles`/`count` as text, or a value literal, depending on `when`. */
  arg: string;
}

const WHEN_OPTIONS: readonly { value: When; label: string }[] = [
  { value: "stable", label: "is stable for" },
  { value: "changes", label: "changes" },
  { value: "reaches", label: "reaches" },
  { value: "is", label: "is" },
];

/** One-line description of each condition, shown under its row. */
const WHEN_HINT: Record<When, string> = {
  stable:
    "Stops when the value has not changed for that many cycle boundaries — a hang / no-progress check.",
  changes:
    "Stops after the value has changed that many times — a runaway bound (e.g. an instruction count).",
  reaches:
    "Stops the moment the value becomes this one (a transition); already holding it does not count.",
  is: "Stops whenever the value equals this one at a boundary (a level); already true counts.",
};

/** The arg text for a stored watch. */
function argOf(w: Watch): string {
  switch (w.when) {
    case "stable":
      return String(w.cycles);
    case "changes":
      return String(w.count);
    default:
      return w.value;
  }
}

function defaultRow(name: string): Row {
  return { name, when: "stable", arg: "100" };
}

export default function RunUntilDialog({
  named,
  initial,
  onRun,
  onClose,
}: {
  named: readonly NamedComponent[];
  /** Last-used conditions, so reopening shows what you ran. */
  initial: readonly Watch[];
  onRun: (watch: Watch[]) => void;
  onClose: () => void;
}) {
  // Only registers and probes carry a watchable value (the engine's
  // `named_value` returns none for a RAM/ROM).
  const watchable = named.filter((n) => n.kind === "register" || n.kind === "probe");
  const nameOptions = watchable.map((n) => ({ value: n.name, label: n.name }));
  const [rows, setRows] = useState<Row[]>(() =>
    initial.length > 0
      ? initial.map((w) => ({ name: w.name, when: w.when, arg: argOf(w) }))
      : [defaultRow(watchable[0]?.name ?? "")],
  );
  const [error, setError] = useState<string | null>(null);
  /** Viewport position of the condition help popover (null = hidden). */
  const [help, setHelp] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const setRow = (i: number, patch: Partial<Row>): void =>
    setRows((prev) => prev.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  /** Toggle the condition-help popover, anchored under the "?" that opened it. */
  const toggleHelp = (e: MouseEvent<HTMLButtonElement>): void => {
    e.stopPropagation();
    if (help !== null) {
      setHelp(null);
      return;
    }
    // Read the rect now: `e.currentTarget` is null by the time a state updater
    // runs, so it must not be captured lazily.
    const r = e.currentTarget.getBoundingClientRect();
    const width = 380;
    setHelp({
      left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)),
      top: r.bottom + 6,
    });
  };

  const run = (): void => {
    const out: Watch[] = [];
    for (const r of rows) {
      if (r.name === "") {
        setError("Pick a register or probe to watch.");
        return;
      }
      if (r.when === "stable" || r.when === "changes") {
        const n = Number(r.arg);
        if (!Number.isInteger(n) || n <= 0) {
          setError("Cycles and transitions must be a positive whole number.");
          return;
        }
        out.push(
          r.when === "stable"
            ? { when: "stable", name: r.name, cycles: n }
            : { when: "changes", name: r.name, count: n },
        );
      } else {
        const value = r.arg.trim();
        if (value === "") {
          setError("Enter a value (0x…, 0b…, or decimal).");
          return;
        }
        out.push({ when: r.when, name: r.name, value });
      }
    }
    onRun(out);
  };

  const argLabel = (when: When): string =>
    when === "stable" ? "cycles" : when === "changes" ? "count" : "value";

  return (
    <div
      className="help-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Run until"
      onClick={onClose}
    >
      <div
        className="help-card run-until"
        onClick={(e) => {
          e.stopPropagation();
          setHelp(null);
        }}
      >
        <h2>Run until…</h2>
        {watchable.length === 0 ? (
          <p className="settings-hint">
            Nothing to watch yet — name a register or probe (Inspector) first. A watch reads a named
            register&apos;s stored value or a probe&apos;s input.
          </p>
        ) : (
          <>
            <p className="settings-hint">
              Run until <em>any</em> condition holds. Each watches a named register or probe; the
              run then stops and continues from there like a breakpoint.
            </p>
            <div className="watch-rows">
              {rows.map((r, i) => (
                <div className="watch-row-block" key={i}>
                  <div className="watch-row">
                    <Select
                      label={`Condition ${i + 1} component`}
                      value={r.name}
                      options={nameOptions}
                      onChange={(name) => setRow(i, { name })}
                    />
                    <Select
                      label={`Condition ${i + 1} type`}
                      value={r.when}
                      options={WHEN_OPTIONS}
                      onChange={(when) =>
                        setRow(i, {
                          when,
                          // Value literals and counts read differently; reset the
                          // arg to a sensible default when the type changes.
                          arg: when === "stable" ? "100" : when === "changes" ? "10000" : "0",
                        })
                      }
                    />
                    <input
                      className="watch-arg"
                      value={r.arg}
                      spellCheck={false}
                      aria-label={`Condition ${i + 1} ${argLabel(r.when)}`}
                      placeholder={argLabel(r.when)}
                      onChange={(e) => setRow(i, { arg: e.target.value })}
                    />
                    <button
                      type="button"
                      className="secondary watch-help"
                      aria-label={`Condition ${i + 1} help`}
                      aria-expanded={help !== null}
                      title="What do these conditions mean?"
                      onClick={toggleHelp}
                    >
                      ?
                    </button>
                    <button
                      type="button"
                      className="secondary watch-remove"
                      aria-label={`Remove condition ${i + 1}`}
                      disabled={rows.length <= 1}
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </div>
                  <p className="watch-hint">{WHEN_HINT[r.when]}</p>
                </div>
              ))}
            </div>
            <div className="inspector-buttons inspector-buttons-full">
              <button
                type="button"
                className="secondary"
                onClick={() => setRows([...rows, defaultRow(watchable[0]?.name ?? "")])}
              >
                Add condition
              </button>
            </div>
          </>
        )}
        {error !== null && <p className="mem-error">{error}</p>}
        <div className="mem-dialog-foot">
          <span className="mem-dialog-spacer" />
          <button className="secondary" onClick={onClose}>
            Cancel
          </button>
          <button onClick={run} disabled={watchable.length === 0}>
            Run
          </button>
        </div>
      </div>
      {help !== null && (
        <div
          className="run-until-help-pop"
          role="note"
          style={{ left: help.left, top: help.top }}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="run-until-help-title">Stop conditions</p>
          <table>
            <thead>
              <tr>
                <th>Condition</th>
                <th>Stops when…</th>
                <th>First boundary?</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  <code>is stable for N</code>
                </td>
                <td>the value is identical for N boundaries</td>
                <td>no — the first only observes</td>
              </tr>
              <tr>
                <td>
                  <code>changes N</code>
                </td>
                <td>the value has changed at N boundaries</td>
                <td>no — a settled start counts 0</td>
              </tr>
              <tr>
                <td>
                  <code>reaches V</code>
                </td>
                <td>
                  the value <em>becomes</em> V (a transition)
                </td>
                <td>no — already V isn&apos;t a transition</td>
              </tr>
              <tr>
                <td>
                  <code>is V</code>
                </td>
                <td>
                  the value <em>equals</em> V (a level)
                </td>
                <td>yes — already true counts</td>
              </tr>
            </tbody>
          </table>
          <p className="run-until-help-note">
            Evaluated at every rising clock edge. <em>Any</em> condition stops the run; the one that
            fired is spent, and the run continues from there like a breakpoint.
          </p>
        </div>
      )}
    </div>
  );
}
