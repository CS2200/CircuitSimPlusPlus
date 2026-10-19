# Backend Agent — Task List

> **Status (2026-10-06, human): COMPLETE.** B1–B11 all landed and merged to master,
> plus the integration fix round (panic-on-input cluster, boot-settle floating semantics,
> final-cycle T_obs fold, per-path wire delays, Session/api::Sim keystone, CLI fixes,
> docs/autograder.md + format-v2 §9 + delay-table conventions). Gates: 193 tests green,
> clippy/fmt/doc clean, Gradescope image verified in a 2 GB container (both CPUs grade
> in ~0.01 s; ~25× under the M1 time budget, ~3 MB RSS). Remaining known minor items:
> Q6 (`--timeout` overflow), Q9 (cross-mode resume error message), Q10 (snapshot exit-code
> mapping) — non-blocking follow-ups.

**Mission:** Build `csim-core` (simulation engine) and `csim-cli` (headless autograder) per `DESIGN.md` — Milestones M0 + M1, plus the engine side of M4.
**Owns:** `crates/core/**`, `crates/cli/**`, `tests/**`, `docs/format-v2.md`, `docs/delay-table.md`, `crates/core/data/**`, `.github/workflows/backend.yml`, root `Cargo.toml`.
**Never touches:** `frontend/**`, `crates/app/**`, `docs/tasks/**`, `DESIGN.md`, `docs/ipc.md`.

Execute in order. Do not start a task until its dependencies are accepted. After each task: run its acceptance commands and report the output.

---

## B0 — Workspace scaffolding

> ✅ **Done (human, 2026-10-06).** Workspace, `csim-core`/`csim` crates, the full `core::api`
> contract (`crates/core/src/api.rs`, with serialization round-trip tests), clap CLI skeleton,
> and `backend.yml` are landed and verified: `cargo fmt`, `cargo clippy -D warnings`,
> `cargo test -p csim-core -p csim` all green. **Start at B1.**

**Spec:** DESIGN.md §3. **Depends on:** —

- Cargo workspace: `crates/core` (lib, name `csim-core`), `crates/cli` (bin, name `csim`). No external deps beyond: `serde`, `serde_json`, `clap`, `thiserror`, `indexmap`. (Ask the human before adding any other dependency.)
- CI `backend.yml`: fmt, clippy `-D warnings`, tests, on ubuntu + `x86_64-unknown-linux-musl` cross build of `csim`.
- `crates/core/src/api.rs`: the public API surface from README §3 as Rust types + a `Sim` trait with `unimplemented!()` bodies. This file is the integration contract; it exists before any engine code.

**Done when:** `cargo build --workspace`, `cargo test --workspace`, and `cargo build -p csim --target x86_64-unknown-linux-musl --release` all pass in CI.

## B1 — Value model & core types

**Spec:** DESIGN.md §4.1, §4.6. **Depends on:** B0

- `Value`: arbitrary-width 4-state vector as three machine-word masks (`ones`, `xs`, `zs`) — matches README §3 wire encoding exactly.
- ID newtypes: `CompId(u32)`, `WireIdx(u32)`, `NetId(u32)`, `CircuitIdx(u32)`.
- Determinism guard: evaluation/serialization paths use `Vec`/`IndexMap`/`BTreeMap` only. Add a clippy allow-list comment block explaining §4.6 at the top of `core/src/lib.rs`.

**Done when:** unit tests for `Value` ops (and/or/xor/not/mux-select/contention-merge/width ops) pass, including X/Z propagation truth tables.

## B2 — `.csx` file format v2

**Spec:** DESIGN.md §5. **Depends on:** B1

- Serde models matching §5.2 exactly (`format`, `version`, `settings`, `circuits[]`, components, wires with `join` endpoints). Write `docs/format-v2.md` as the normative prose spec + JSON Schema.
- Canonical serializer: 2-space indent, sorted keys, stable ordering — saving twice is byte-identical.
- Validator (§5.2): collects **all** errors, never panics, never partial-loads: unresolved pins/joins, bitsize disagreement per net, duplicate names, hierarchy cycles, duplicate IDs.
- RLE-hex codec for memory `contents`/`autoload` (legacy-compatible `rle-hex-v1`, App. A).

**Done when:** round-trip tests (parse→serialize→parse = identical); ≥ 15 invalid-fixture tests each producing the expected error list; `csim validate` subcommand live.

## B3 — Netlist builder

**Spec:** DESIGN.md §4.2 steps 1–2, §5.2 wire rules. **Depends on:** B2

- Union-find over wire endpoints + junctions → nets (internal `NetId`s, never exposed in files).
- Hierarchy flattening: inline subcircuits (recursive, depth-capped), map subcircuit pins by **name**; memories/registers stay primitive.
- Checks: net bitsize agreement; floating-net detection (no driver); driver count per net.

**Done when:** tests: nested subcircuits (≥ 3 deep), junction graphs incl. junction-deletion ordering, fan-out buses, and every error class. A flattened ~3.4k-component synthetic circuit builds < 50 ms.

## B4 — Component behaviors

**Spec:** DESIGN.md §6. **Depends on:** B3

- `Behavior` trait: zero-delay `eval(inputs) -> outputs` + timing params (for B6). Implement the full §6 registry: gates (configurable input count + per-input negation bubbles), splitter (arbitrary bit maps), mux/demux/decoder, arithmetic (incl. bit-width-scaling adder), register (enable, clk→Q/setup/hold params), RAM/ROM (async read, sync write, `name`, `autoload`, embedded contents), pin/constant/clock/probe, controlled buffer (tri-state), subcircuit (post-flatten passthrough), io.* stubs (inert).
- Floating-consume rule (§4.1): consuming `Z` = halting error naming comp+pin (register D only when enabled at edge; RAM only during access).

**Done when:** per-component truth-table tests pass, incl. bubbled-gate De Morgan equivalences and tri-state bus contention → `X`.

## B5 — Zero-delay engine

> **Removed.** The zero-delay engine was deleted in favour of the delay-aware
> engine (which is faster on real designs and is what grading/timing already
> used). DESIGN.md §4.2; `settings.delayModel` is gone (format v3).

**Spec:** DESIGN.md §4.2, §4.5. **Depends on:** B4

- Levelization (Kahn) over the flattened netlist; cycle step = latch-all + single sorted sweep.
- Combinational cycles: bounded fixed-point; non-convergence → nets in cycle = `X`, oscillation error, **never hang**.
- Snapshot/restore (engine state ↔ bytes).

**Done when:** tests: known-answer runs on fixtures; SR-latch oscillation test terminates with `X` + error; snapshot/resume mid-run is bit-identical to uninterrupted run.

## B6 — Delay-aware engine (grading engine) + DTA

**Spec:** DESIGN.md §4.3, §4.4. **Depends on:** B5

- Event queue keyed `(time, seq)`; `seq` assigned in component-index order → bit-for-bit reproducibility (§4.6).
- **Transport wires:** delay ∝ length (table constant; 0 disables). **Inertial gates:** cancel-and-reschedule pending output events on input revert. **Registers:** clk→Q; setup/hold violation **detection** → warning list (latch still happens, deterministically).
- **DTA instrumentation:** per-cycle settle time (last register/memory-input event per cycle) → running `T_obs`; top-k observed critical paths (component IDs).
- RAM/ROM access-time settling on reads.

**Done when:** tests: glitch narrower than `t_pd` is swallowed (gate) but passes (wire); setup/hold violation fixtures produce warnings; **the same run executed twice produces identical event-trace hashes**; a fixture pipeline's `T_obs` matches a hand-computed value within 0 error.

## B7 — Delay table

**Spec:** DESIGN.md §4.4 (D13). **Depends on:** B6

- `docs/delay-table.md` + `crates/core/data/cs2200-74ls-v1.json`: draft 74LS-typical values from DESIGN.md (marked DRAFT), incl. per-bit scaling rules (adders), register clk→Q/setup/hold, wire-delay constant, RAM/ROM access.
- Loader + validation; per-instance `attrs.delay` override precedence.

**Done when:** tests: table loads, overrides apply, unknown table name = clean error.

## B8 — STA (informational)

**Spec:** DESIGN.md §4.4. **Depends on:** B7

- Longest-path DP over the flattened DAG with table delays → `T_sta` + top-k structural paths. Pure-combinational cycles = clean STA error.

**Done when:** tests agree with hand-computed values on ≥ 3 fixtures; runs in < 100 ms on the 3.4k-component synthetic circuit.

## B9 — Autograder API

**Spec:** DESIGN.md §8.2. **Depends on:** B6, B7, B8

- `core::autograde`: named-component access (mem read/write by name, probe read), memory preload from file, assertion evaluator (`probe('x') == 0x2A`, `mem('dmem')[0x100] == v`, `violations == 0`), run limits (cycles/timeout/RSS guard), error taxonomy → exit codes (§8.2), JSON report struct (all §8.2 fields).

**Done when:** unit tests per assertion type + every exit-code path exercised.

## B10 — `csim` CLI

**Spec:** DESIGN.md §8. **Depends on:** B9

- `clap` subcommands: `run`, `validate`, `timing --paths k`, `snapshot`, `resume` (§8.1 surface). `--mode zero|delay` (default `delay`), `--load name=file` (repeatable), `--assert` (repeatable), `--json`.
- `gradescope/Dockerfile`: musl-static `csim` + fixture sanity self-test.

**Done when (M1 acceptance):** end-to-end: grade `tests/fixtures/pipeline5.csx` running a provided program hex; report JSON contains correct `cycles`, `T_obs`, `est_time`, assertion results; total runtime < 10 s in a 2 GB container; RSS < 256 MB.

## B11 — Fixtures & golden tests

**Spec:** DESIGN.md §14. **Depends on:** B10

- Generated `.csx` fixtures in `tests/fixtures/`: `alu.csx`, `fsm.csx`, `multicycle.csx`, `pipeline5.csx`, plus negative fixtures (floating-read, contention, oscillation, setup-violation, bitsize-mismatch). They are output of `tests/gen/gen_fixtures.py` + `tests/gen/gen_cpus.py` (plus the hand-authored `sanity.csx`), which stay the source of truth for what a fixture contains.
- Golden event-trace tests: trace hash per fixture pinned in CI (determinism tripwire per §4.6).

**Done when:** CI runs the full golden suite on every push; a deliberate determinism-breaking change (e.g., HashMap iteration) fails CI; and `node scripts/check-fixtures.mjs` regenerates every fixture into a temp dir and diffs it, so a fixture can never drift from its generator unnoticed — which it did once, when the generators were left emitting the previous format header while the committed files moved on.

---

**Definition of done for the whole backend:** M0+M1 acceptance in DESIGN.md §14, all acceptance commands above green in CI, `cargo doc -p csim-core` builds with every public item documented.
