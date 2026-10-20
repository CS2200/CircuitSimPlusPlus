# Autograder Interface — `csim` CLI (normative)

**Status:** Implemented by `crates/cli` + `crates/core/src/autograde.rs` (BACKEND.md tasks
B9/B10; contract v1.2). Where this file and `DESIGN.md` §8 disagree, `DESIGN.md` wins (route
corrections through the human). This document is the normative realization of the §8 contract:
exit codes, the assertion language, the JSON test-spec, the snapshot format, named-component
addressing, and memory preloading + sandboxing.

## 1. Subcommands

```bash
csim run submission.csx [--load name=file]... [--cycles N] [--timeout 60s] [--rss-cap-mb M]
    [--assert "..."]... [--spec spec.json] [--baseline-est-time N]
    [--expect-halt] [--clock-half-period-ns N] [--sta] [--paths K]
    [--allow-outside-autoload] [--json report.json]
csim validate file.csx
csim timing file.csx [--paths K] [--cycles N] [--sta] [--json out.json]
csim snapshot file.csx --out state.json [--cycles N] [--clock-half-period-ns N]
csim resume state.json [--cycles N] [--json out.json]
```

- `run` — the grading flow: load → preload memories → run under limits → assertions →
  JSON report + exit code. The delay-aware engine (DTA) is the only engine.
- `validate` — full load check: parse, document validation, **and netlist build** (a
  bitsize-mismatch net fails validation too, F8). Prints `{ "ok": bool, "errors": [LoadError] }`;
  exit 0 or 6.
- `timing` — **observed (DTA) timing is primary** (F9): runs the grading engine for
  `--cycles` cycles (default **1000**; 0 disables) and reports `dta.{cycles, t_obs, est_time,
top_paths}`. `--sta` adds the informational structural bound (`t_sta`, `sta_paths`, and a
  `sta_note` label; see docs/delay-table.md for the STA vs DTA conventions).
- `snapshot`/`resume` — savestates, §5.

## 2. Exit codes (§8.2)

| code | meaning                                                                                                                                 |
| ---: | --------------------------------------------------------------------------------------------------------------------------------------- |
|    0 | all assertions passed                                                                                                                   |
|    1 | assertion failure (also: contention or other abnormal halts without their own code)                                                     |
|    2 | cycle limit: the budget was consumed while `expect_halt` was set                                                                        |
|    3 | timeout / RSS guard tripped (`halt_reason` `"timeout"` / `"resource-limit"`)                                                            |
|    4 | oscillation halt                                                                                                                        |
|    5 | floating-read halt                                                                                                                      |
|    6 | malformed file (parse/validation/netlist/preload errors)                                                                                |
|   64 | CLI usage error (bad flags, unreadable spec, unknown assertion target/memory/poke pin — a _configuration_ error, not a grading outcome) |

Precedence: **6 → engine halt (4/5/1) → 3 → 2 → 1 → 0**. A run that consumes its cycle budget
_without_ halting is the course's normal model (run N cycles, check state); exit 2 is reserved
for specs that explicitly declare `expect_halt` (the design was supposed to stop on its own).

## 3. The JSON report (§8.2)

Every simulation-derived field is bit-identical across runs and machines (§4.6);
`wall_time_ms` and `peak_rss_bytes` are telemetry and vary by machine.

| field                            | meaning                                                                                                                                             |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cycles`                         | rising edges executed                                                                                                                               |
| `halt_reason`                    | `"completed" \| "cycle-limit" \| "oscillation" \| "floating-read" \| "contention" \| "breakpoint" \| "error" \| "timeout" \| "resource-limit" \| "malformed-file"`  |
| `halt_details`                   | `comp <id> pin "<pin>": <message>` when attributable (root-sheet document-order id; see `docs/ipc.md` §3's `sim_halted`), else a plain message      |
| `t_obs`                          | max observed per-cycle settle time, ns                                                                                                              |
| `est_time`                       | `cycles × t_obs`, saturating                                                                                                                        |
| `speedup_vs_baseline`            | `baseline_est_time / est_time`; `null` without a baseline or when `est_time == 0`                                                                   |
| `timing_violations`              | **count** of setup/hold warnings (the §8.2 field name)                                                                                              |
| `violation_details`              | the warnings: `[{ circuit, comp_id, kind: "setup"\|"hold", detail }]` with document-order `comp_id` within `circuit`                                |
| `assertions`                     | per-assertion `{ assertion, passed, actual, expected }`                                                                                             |
| `top_paths`                      | observed critical paths: `[{ circuit, comps: [comp_id], delay_ns }]`; a path crossing circuit boundaries is split into consecutive per-circuit runs |
| `t_sta`, `sta_note`              | informational structural bound (only with `--sta` / `include_sta`); STA totals include the destination register's setup time (docs/delay-table.md)  |
| `delay_table`                    | table provenance, e.g. `"cs2200-74ls-v1 (DRAFT)"`                                                                                                   |
| `trace_hash`                     | FNV-1a over the applied event stream (the §4.6 determinism tripwire)                                                                                |
| `rubric_full_credit`             | `est_time < rubric_full_credit_below` when a threshold was given, else `null`                                                                       |
| `errors`                         | the load/validation `[LoadError]` list when `halt_reason` is `"malformed-file"`; empty otherwise (F10: one malformed-file JSON shape everywhere)    |
| `peak_rss_bytes`, `wall_time_ms` | telemetry                                                                                                                                           |

## 4. Assertion language

```text
assertion := probe-expr | mem-expr | violations-expr
probe-expr := "probe(" "'" name "'" ")" cmp literal     # named probe OR register value
mem-expr   := "mem(" "'" name "'" ")" "[" literal "]" cmp literal
violations-expr := "violations" cmp literal            # setup/hold warning count
cmp        := "==" | "!=" | "<" | "<=" | ">" | ">="
literal    := "0x" hex+ | "0X" hex+ | "0b" bin+ | "0B" bin+ | dec+
name       := any characters except "'"
```

Whitespace is insignificant between tokens. A compared value containing `X`/`Z` bits never
equals a literal — the assertion fails and the masks are shown (§4.1: X is not a number).
Unknown names, wrong kinds (`probe()` on a memory, `mem()` on a probe), and malformed syntax
are **configuration errors** (exit 64), not grading outcomes.

## 5. Test-spec file (§8.3, JSON)

`--spec file.json` replaces long flag lists; CLI flags override spec fields. Unknown fields
are rejected. Relative load paths resolve against the **spec file's directory** (§11).

```jsonc
{
  "cycles": 500000, // → run limit
  "timeout_ms": 60000,
  "rss_cap_bytes": 268435456,
  "baseline_est_time": 100000,
  "expect_halt": false,
  "top_paths": 10,
  "include_sta": false,
  "rubric_full_credit_below": 90000, // §8.3 rubric hook
  "clock_half_period_ns": 1000, // delay-mode clock (default 1000)
  "loads": [{ "memory": "imem", "file": "program.hex" }],
  "pokes": [{ "target": "reset_pin", "value": "0x1", "at": 0 }], // value: §4 literal syntax; at: ns
  "assertions": ["probe('result') == 0x2A", "violations == 0"],
}
```

## 6. Snapshot files (`csim snapshot` / `csim resume`)

Self-contained JSON — the circuit travels with the state:

```jsonc
{
  "format": "csim-snapshot",
  "version": 2,
  "clock_half_period_ns": 1000,
  "cycles_run": 500,
  "circuit": {/* the full .csx document */},
  "state": {/* delay-engine snapshot format version 2 */},
}
```

`resume` re-validates the embedded circuit **fully** (parse shape, document validation,
netlist build, delay-table resolution) before restoring — a hand-corrupted snapshot is a
clean exit-6 error, never a panic (§11, F2). Engine-state blobs are versioned by the engine
(`state.version`); a mismatched version or shape is a clean error. Snapshots are
same-build artifacts: restoring across engine-semantics changes is rejected by the
version/shape checks.

## 7. Named-component addressing (§8.2)

Any `mem.ram`/`mem.rom`/`mem.register`/`wiring.probe` with a `name` is addressable. Names
are unique per circuit; nested instances are addressed by **hierarchical name** — the plain
name at root level, `instance/.../name` when nested (F12; instance _ids_ from the document
guarantee uniqueness):

```bash
csim run cpu.csx --load imem=prog.hex            # root-level imem
csim run soc.csx --load u1/imem=prog.hex         # imem inside subcircuit instance u1
--assert "probe('u2/alu/result') == 0x2A"        # nested probe
```

## 8. Memory preloading: `--load` vs `autoload`, and the sandbox (§11)

- **`attrs.autoload`** (in the `.csx`): the image is loaded at startup **and on every
  reset** (DESIGN §5.2, G6). Paths resolve relative to the **circuit file's directory** and
  must stay inside its directory tree — a submission can't read the grader's filesystem.
  `--allow-outside-autoload` relaxes this. Autoloads are discovered by hierarchical name
  (§7), so memories inside subcircuit instances autoload correctly.
  A memory that is not preloaded **powers on `X`**, not 0 (docs/format-v2.md §9): real RAM
  has no defined power-on contents, so an assertion over a word nobody initialized now
  _fails_ rather than passing on a zero, and a trace over one carries `X`. Preload a memory
  (or have the circuit write it) when a task expects defined contents — which is also the
  check that catches a submission that reads storage it never set up.

- **`--load name=file`** (CLI): a one-shot preload for the grading run, addressed by
  hierarchical name; an explicit `--load` **overrides** the same memory's `autoload` attr.
  `--load` paths are TA-controlled and resolve against the current directory (not sandboxed).

Image files are `rle-hex-v1` (docs/format-v2.md §7), bounded by the memory's depth. A word
wider than the memory's bitsize, an image longer than the depth, and an oversized poke value
are **clean errors** (exit 64 configuration / exit 6 malformed), never panics (§11, F1/F3/F5).
A memory whose `depth` attr is omitted uses the documented default (256, docs/format-v2.md
§4).
