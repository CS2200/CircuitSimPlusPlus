# CircuitSim++ — Design & Specification

**Status:** v1.0-draft — integrated. M0–M5 built and merged; contract **v1.2** (`docs/ipc.md`) is the live IPC norm and the file format is at **v4** (`docs/format-v2.md` is normative — §5 below is the original sketch, kept as design intent); amendments below are ratified.

**Changelog v0.4 → v1.0-draft (integration amendments, ratified after the parallel build)**

_IPC contract (now normative in docs/ipc.md, v1.2):_

- `timing_update.violations` is a structured list `{circuit, comp_id, kind, detail}[]` (was count-only; count = length). Report keeps a `timing_violations` count field per §8.2.
- `net_diffs.changes[]` gains optional `at` (ns since run start) - true propagation animation.
- `NetDiffs.full`: the one initial full-state batch after load/resume/reset — the documented exception to "diffs only."
- `sim_reset` command added: fresh power-on + autoload re-apply (G6 delivered end-to-end).
- CompId on the wire = document-order index within the referenced circuit (never post-flatten); hierarchical designs attribute via `circuit` fields; `sim_halted.details` is machine-parseable (`comp <id> pin "<name>": …`).
- Tick = one clock half-period. `top_paths` entries carry `{circuit, comps, delay_ns}`; `NamedComponent` gains `circuit`; hierarchical memory addressing is `instance/…/name`.

_Schema/semantics ratifications (now normative in docs/format-v2.md §9, docs/delay-table.md, docs/autograder.md):_

- Resource caps: bitsize ≤ 32; gate inputs ≤ 32; select bits ≤ 8; memory depth ≤ 2²⁰ and power-of-2; splitter pins ≤ 64.
- Power-on state: **RAM powers on `X`** — an uninitialized word is unknown, and a read of it propagates `X` like any other unknown value (docs/format-v2.md §9) — while **registers still power on 0** (legacy compatibility; under review, see docs/bugs.md). Deterministic either way: `X` is as reproducible as `0`. Combinational feedback nets seed 0, splitters seed Z (they carry, never originate).
- Divide-by-zero → X; mux with X select passes when all inputs are equal, else X.
- The per-pin floating-consume table (gates always; mux selected input only; controlled-buffer data only while enabled; register D only while enabled at an edge; probes/pins/splitters/breakpoints never).
- `clock_half_period_ns` engine parameter (CLI default 1000 ns).
- **Boot settle**: the delay engine settles to quiescence before cycle accounting begins — overclocked designs now correctly yield setup/hold violations instead of spurious floating-read halts.
- **Wire delay is per-path** (driver→sink path length × constant; stubs never inflate other sinks; Manhattan fallback for missing points) — layout cannot unfairly change a student's grade.
- STA totals include destination setup time; DTA settle is edge-to-settle including clk→Q (convention table in delay-table.md).
- Exit-code taxonomy, assertion grammar, JSON test-spec schema, snapshot schema: `docs/autograder.md`.
- `wiring.controlled-buffer` added to the component registry (required by §4.1 tri-state; omitted from the original list).
- Gate pins are named `in0..inN`/`out` (the §5.2 sketch's `a`/`b` was illustrative).

_Deferred:_ **P1 — free wire endpoints** (`{free: [x,y]}`: dangling wires, draw-wires-first, delete-component-keep-wires). Proposed by the frontend build; needs schema + editor op + engine semantics. Not scheduled.

**Changelog since v1.0-draft**

- **IPC contract v1.2** (`docs/ipc.md`): `NamedComponent.value_net` — the engine net carrying a named part's watchable value, so a register's readout and the Watch panel work even when its value pin is unwired; and `NetChange.contended` — `X` that is a genuine driver fight, so the sim bar can call a short circuit a short circuit.
- **File format v4** (`docs/format-v2.md` §1/§4): `mem.register` and `mem.ram` lost their `rst` pin (register `d, clk, en, q`; RAM `addr, din, dout, we, clk`). The pin existed because the old simulator had no memory autoload: a reset wire was how a circuit restarted. `sim_reset` (which re-applies autoload) replaced it, so the pin was dead weight — and a reset trace across a schematic hid what the clock was doing. A v3 → v4 migration drops wiring to the retired pins, so a file saved before this change still opens.
- **One path to the theme, one bus colour:** the header's light/dark toggle was removed (Settings → Appearance is the only entry) and per-net rainbow hues narrowed to a single themeable bus colour — a wire's own `color` still wins (D8).
- **UI robustness pass:** `misc.text` annotations gained an inert behavior (placing one used to make the whole document unloadable), readouts pad to their pin's declared width, a memory's `addr` pin is as wide as its address space, wired-up parts blink unconnected inputs, and the tester's transport/wiring fixes landed (typed cycle input, wiring hint in the status bar, 12-/24-hour timestamps, bottom zoom slider). Log: `docs/bugs.md`.

**Audience:** CS 2200 TA team, implementers (human or agent).
**Scope:** Clean-slate rewrite of CircuitSim (Java/JavaFX, `com.ra4king.circuitsim`, format `1.11.2-CE`) as a Rust simulation core with a Tauri + React desktop frontend, a headless autograder CLI, and a new graph-based file format.

**Changelog v0.3 → v0.4**

| Change                                                                                                                                         | Driver             |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Delay model resolved: **hybrid — transport delay on wires, inertial delay on gates, clk→Q + setup/hold on registers** (matches the curriculum) | Team decision (D1) |
| Extension resolved: `.csx`                                                                                                                     | Team decision (D4) |
| Delay table gains wire-delay and hold-time entries                                                                                             | Consequence of D1  |

**Changelog v0.2 → v0.3**

| Change                                                                                                                                                                                     | Driver                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Grading timing metric is **DTA** (the delay-aware engine measures observed per-cycle settle times during the grading run); STA demoted to an optional, clearly-labeled informational field | Team: microcode ROMs and multi-use buses make STA's structural worst case full of unreachable paths — confusing to students; the course test suite exercises every instruction and every branch predict/mispredict case |
| Floating-input semantics: **consuming** a floating value halts the simulation with an error ("electrically, it shouldn't float")                                                           | Team decision                                                                                                                                                                                                           |
| Transport vs inertial delay explained (§4.3); transport remains the recommended default                                                                                                    | Team question                                                                                                                                                                                                           |
| Clock/reset pins: **not hidden** — resolved                                                                                                                                                | Team decision                                                                                                                                                                                                           |
| Distribution: unsigned DMG/zip with documented Gatekeeper/SmartScreen workarounds                                                                                                          | Team: too broke to sign                                                                                                                                                                                                 |
| Provenance journal: deferred post-MVP; doubles as undo-history data (reads as an editing aid, not surveillance); forgery acknowledged — deterrent-grade only                               | Team decision                                                                                                                                                                                                           |
| Delay table: approach resolved — 74LS-era TTL datasheet typicals (period-authentic for the course's 70s–90s material); concrete values TBD by staff                                        | Team decision                                                                                                                                                                                                           |
| Colorblind support: palettes stay swappable; dedicated accessibility pass deferred (no colorblind students this semester)                                                                  | Team decision                                                                                                                                                                                                           |
| §7.0 added: Web-vs-Native renderer comparison (now that the renderer is custom either way)                                                                                                 | Team question                                                                                                                                                                                                           |
| Appendix B.3 added: v0.1 net-centric proposal vs. adopted wire-centric model                                                                                                               | Team request                                                                                                                                                                                                            |
| Milestones: event-driven engine pulled into M0 (grading depends on it); M4 becomes visualization-only                                                                                      | Consequence of DTA                                                                                                                                                                                                      |

(v0.1→v0.2: wire-centric format; tunnels/named nets removed; legacy converter dropped; multi-clock dropped; counter dropped; autoload-on-every-reset; WASM rejected; BSD licensing confirmed; DLS appendix.)

---

## 1. Background & Motivation

CircuitSim is the Java-based logic simulator used in CS 2110/2200 at Georgia Tech. Written in a weekend by Roi Atalla (2110 senior TA), massaged into the course by Austin Adams, later extended by Henry Bui; 2200 adopted it. The current 2110 staff lack the bandwidth for a rewrite and have given us (2200) permission to take it over. The license (BSD) permits this; we keep attribution.

Pain points, ranked by how much they hurt:

- **Autograder economics.** Gradescope runs on ~2 GB RAM instances. A real EC-project submission (14 subcircuits, 3,443 components) loads and simulates slowly under the JVM. A Rust core fixes this directly.
- **Unfair grading metric.** Cycle-count-only grading let trivial 2-stage pipelines out-score genuine 5-stage pipelines. The autograder must factor in clock-cycle length so scores reflect real processor speed (§4.4, §8).
- **UX friction.** Reset wipes RAM → multi-click reload of the program every time. Wiring/overlap confusion. No visibility into _why_ a wire is wrong.
- **Aesthetics.** We want Sebastian Lague's Digital-Logic-Sim look — smooth, colorful, state-revealing wires — but with real gate symbols and our course's component set.

Clean-sheet rewrite. The old codebase is reference reading only; no code or files are ported (course circuits will be rebuilt by hand).

---

## 2. Goals & Non-Goals

### 2.1 Goals

| #   | Goal                                              | Success criterion                                                                                                                                                                                                              |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| G1  | Fast, small simulation core in Rust               | EC-project-scale circuit (~3.4k components) loads < 250 ms; course-scale programs (tens of thousands of cycles) grade in seconds in a 2 GB container; RSS < 256 MB                                                             |
| G2  | Headless autograder with a **timing-fair metric** | Deterministic CLI: load circuit, preload multiple named memories, run N cycles on the delay-aware engine, assert state, measure observed timing, emit JSON report with `cycles`, `T_obs`, `est_time = cycles × T_obs`, speedup |
| G3  | Graph-based file format, "copper-first"           | Wires are explicit edges between pins (explicit junctions, no geometric inference, no named nets/tunnels); netlist derived by union-find at load                                                                               |
| G4  | Pretty, modern desktop UI                         | Tauri + React; canvas-rendered; 60 FPS with ~5k visible wires on low-end iGPUs; DLS-style state-colored wires with real gate symbols                                                                                           |
| G5  | Propagation-delay awareness                       | Delay-aware event-driven engine powers both the teaching visualization **and** the autograder's timing measurement — what you see is what you're graded on                                                                     |
| G6  | Student QoL                                       | RAM autoload-from-file on every reset; probes; clear error visualization (contention, floating, oscillation); named memories/registers accessible to autograder                                                                |
| G7  | Rolling delivery                                  | Update nudge from GitHub Releases so an early MVP can ship and improve continuously                                                                                                                                            |

### 2.2 Non-Goals (v1)

- Analog/mixed-signal simulation.
- Built-in Verilog/VHDL import. (The external Yosys transpiler is a separate tool; if it's wanted again it needs a new emitter — v2 has no tunnels to lean on. Out of scope for v1.)
- Conversion of legacy `.sim` files (course material is rebuilt by hand).
- Multi-clock-domain designs (never used in this course).
- ~~Waveform viewer~~ — **now in v1** (UI_OVERHAUL §89). It turned out to need no new
  engine or IPC surface: it is a view over the `net_diffs` stream the UI already receives,
  tapped before the per-frame merge so a trace keeps every cycle (§7.2).
- Browser/web builds — **explicitly rejected**: desktop app; students install real software.

---

## 3. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Tauri desktop app                        │
│  ┌──────────────────────────┐   ┌────────────────────────┐  │
│  │  React + TS frontend     │◀─▶│  Rust app shell        │  │
│  │  (canvas renderer, CSS   │   │  (sessions, file I/O,  │  │
│  │   themes, editor UI)     │   │   diff streaming,      │  │
│  │                          │   │   update checker)      │  │
│  └──────────────────────────┘   └───────────┬────────────┘  │
└─────────────────────────────────────────────┼───────────────┘
                                              │ (in-process)
┌─────────────────────────────────────────────┼───────────────┐
│  csim-cli (headless autograder binary)      │               │
│  ─ pure Rust, no webview, musl-static ──────┤               │
│                                             ▼               │
│                    ┌─────────────────────────────────┐      │
│                    │  csim-core (Rust library crate) │      │
│                    │  • file format v2 (serde)       │      │
│                    │  • netlist builder (union-find  │      │
│                    │    over wires, flatten,         │      │
│                    │    levelize, cycle detection)   │      │
│                    │  • delay-aware event engine     │      │
│                    │    (grading + DTA measurement)  │      │
│                    │  • optional static timing       │      │
│                    │    analysis (informational)     │      │
│                    │  • component behaviors          │      │
│                    │  • autograder API (snapshots,   │      │
│                    │    named access, assertions)    │      │
│                    └─────────────────────────────────┘      │
└─────────────────────────────────────────────┘
```

**Hard architectural rule:** `csim-core` depends on nothing UI- or platform-specific. This is what guarantees the interactive app and the Gradescope autograder are _behaviorally identical by construction_ — same engine, same semantics, same results. (That, not web ambitions, is the reason for core purity.)

```
Cargo.toml            # workspace
crates/
  core/               # csim-core: everything above
  cli/                # csim-cli: autograder/headless runner
  app/                # Tauri shell (src-tauri)
frontend/             # React + TypeScript + Vite
docs/                 # this document, format spec, autograder spec, delay table
tests/
  fixtures/           # hand-built course circuits (ALU, datapath, pipelines)
```

---

## 4. Simulation Engine

### 4.1 Value model: four-state logic

Each bit on a net: `0`, `1`, `X` (unknown/error), `Z` (undriven/floating).

- **Contention** (two enabled drivers disagree) → `X`, wire highlighted as shorted in the UI. (Contrast: DLS picks a random winner — fine for demos, unacceptable for grading.)
- **Floating** (no enabled driver) → `Z`, rendered distinctly (a bus idling between transactions is normal and displays as `Z`). But **consuming** a floating value is an electrical bug, so it is a _simulation-halting error_: if a `Z` reaches any gate input, or a register's D input at a clock edge while enabled, or a RAM/ROM port during an access, the simulation stops, the error names the component and pin, and the UI highlights it. Autograder: distinct exit code. (Resolved D3. Watch-item: if idle-bus false positives prove annoying in practice, a later pull-up/pull-down component is the escape hatch — see §13.)
- Tri-state exists because `ControlledBuffer` buses are central to this course; `Z` must mean something.

### 4.2 One engine: delay-aware only

Earlier drafts shipped a second, **zero-delay** engine — a levelized "evaluate
every component each cycle" fast path, selected by `settings.delayModel`. It
was **removed**. In practice the event-driven delay-aware engine (§4.3) is
_faster_ on real designs, because it only does work where a value actually
changes, while the zero-delay engine re-evaluated the entire circuit every
cycle whether or not anything was static. The delay-aware engine is also what
grading and the timing instrument already use, so one engine means one set of
semantics and one determinism story instead of two.

The format's `settings.delayModel` field went with it: v2 documents migrate to
v3 by dropping the field (docs/format-v2.md §2).

### 4.3 Delay-aware mode (teaching + grading engine)

Event-driven: components and wires have delays from the published delay table (§4.4). Events are processed from a timestamp-ordered queue; ties broken by a monotonic sequence number assigned in component-index order - so runs are bit-for-bit reproducible.

**The delay model (resolved D1): the physically-motivated hybrid the curriculum already teaches** — transport on wires, inertial on gates, timed registers:

- **Wires — transport delay.** A wire is a pure delay line: every transition at one end is reproduced at the other end `d_wire` later, however narrow the pulse. `d_wire` scales with wire length via a table constant. **`num` is 0 for the first production run** (Head-TA decision): only component delays count, which also removes *clock skew*, because a clock edge is delivered per sink like any other transition. Real silicon has skew and accounting for it is legitimate, so treat this as a simplification: **if wire propagation is turned back on, the clock must stay skew-free (below), or a converted design can latch a value a cycle early.**
- **Clock — one source, by default.** A `clk` pin on a net nothing drives follows the **circuit's global clock** (the `clock` component's ticks, or the engine's global edge), so every uncustom clocked part sees one atomic edge — CE's own model (a single oscillator toggling every clocked part). A `clk` pin that **is** driven follows whatever drives it, so custom clocks (an inverted clock, a gated/enabled clock, a divided one) remain expressible and are *not* forced onto the global edge. The UI wires a placed part to the design's `wiring.clock` at the root — and to a `CLK` port inside a subcircuit, because a net cannot cross a circuit boundary — and lets a user re-route one; the engine does not care which it sees.
- **Reset — one source too, and it is a *part*.** `wiring.reset` is the design's reset source: a **square** button (`io.button`'s round one stays general-purpose) driving 1 while held and 0 otherwise, starting released so a graded run sees it deasserted. A placed part wires itself to it at the root and to an `RST` port inside a subcircuit. It exists as a *type* — not as a `RST` naming convention — so the tooling can recognise the design's reset exactly as it recognises the clock; a wire's name is a label, not a joining rule (format-v2 §9), and an old file's `CLK`/`RST` pins keep working unchanged. **A floating `rst` is `X` (v6)**, not a deasserted reset: the engine does not decide what an unwired control means, so the three writers do — the editor places this part, the transpiler writes a constant for a converted design, and the v5 → v6 migration adds one for an older file (format-v2 §5.1).
- **Gates — inertial delay.** A gate's inputs must hold a new value for ≥ its `t_pd` before the output commits; an input pulse narrower than `t_pd` is swallowed (the pending output event is cancelled if the input reverts first). Sub-delay glitches get filtered — as in real silicon, and as taught in the curriculum. (Implementation: per-gate pending-event bookkeeping; recompute + reschedule on each input event.)
- **Registers — clock-to-Q + setup/hold.** On a clock edge, D is sampled; Q updates `clk→Q` later — a register written this cycle is not stable at its output until `clk→Q` after the edge. The engine also _detects_ setup/hold violations (D changed within `t_setup` before the edge or within `t_hold` after) and reports them as **warnings**, counted in the UI and the autograder report (`timing_violations`), without corrupting state: the latch still happens, deterministically. (Modeling metastability as `X` is a possible post-MVP refinement; v1 keeps behavior benign and flags the lesson. The autograder can enforce strictness with `--assert "violations == 0"`.)
- **RAM/ROM** — reads settle after the table's access time; writes obey the same edge + setup discipline as registers.

(The two textbook flavors, for reference: _transport_ passes every transition shifted by `d`; _inertial_ filters pulses narrower than `d`. We use each where hardware uses it.)

### 4.4 Timing measurement: DTA (grading) + STA (informational only)

**Problem:** cycle counts alone let a trivial 2-stage pipeline beat a real 5-stage pipeline. Real processor speed is `cycles × clock_period`, and the clock period is bounded below by the longest combinational path that actually has to settle in a cycle.

**Decision (resolved D11): Dynamic Timing Analysis.**

- The grading run executes on the **delay-aware engine** (§4.3) using the published delay table. For each clock cycle, the engine records that cycle's **settle time**: the timestamp of the last input change at any register/memory input, measured from cycle start. `T_obs` = maximum settle time over the whole run. Metric: `est_time = cycles × T_obs`; speedup vs. the course baseline processor's `est_time`.
- **Why DTA over STA (static/worst-case), per the team:** students implement microcode in ROMs and reuse buses in patterns their control unit never actually exercises (double-back-to-back, indirect stores, …). STA would report and highlight structurally-possible paths the microcode can never sensitize — misleading grades _and_ confused students. The course test suite already exercises every instruction and every branch predict/mispredict combination, giving DTA effective coverage for this ISA.
- **Residual caveat (documented, accepted):** DTA is only as good as the suite — a path never sensitized scores _optimistically_ (favors the student). Mitigations: the comprehensive suite; and the report may optionally include `T_sta` (STA worst-case, computed in linear time, clearly labeled "structural bound — may include paths your design never uses") as an informational field for TAs eyeballing anomalies. UI path-highlighting uses **observed** (DTA) paths by default; STA paths only on explicit request.
- **Determinism:** the event engine's tie-breaking is fixed (§4.6), so DTA results are exactly reproducible — same file, same program, same `T_obs`, every run, every platform.
- **Performance reality check:** course programs are small — baseline cycle counts: POW 8,129 / FIB 32,312 / TwoSum 12,314. Even at ~10⁴ events/cycle that's ~10⁸–10⁹ events total: seconds in Rust on the target container. (The team's memoize/parallelize idea stays in the back pocket if future workloads grow; not needed at course scale.)
- **A 2-stage pipeline now loses honestly:** its single long register-to-register path is exercised on essentially every cycle, so `T_obs` reflects it immediately.

**Delay table (D13):** published, versioned (`settings.delayTable`, e.g. `"cs2200-74ls-v1"`). Approach resolved: derive from **74LS-family TTL datasheet typical propagation delays** — period-authentic for the course's late-70s/80s/early-90s material. Illustrative draft anchors (**staff to finalize against datasheets before M0 ends**): NOT ≈ 9 ns; AND/NAND ≈ 10 ns; OR/NOR ≈ 10 ns; XOR/XNOR ≈ 12–15 ns; 2:1 MUX ≈ 12 ns; adder scales per-bit (ripple) with full-adder carry ≈ 15–25 ns; register clk→Q ≈ 20 ns, setup ≈ 15–20 ns, hold ≈ 5 ns; wire delay ≈ 1 ns per N grid units (N staff-tunable; 0 disables wire delay); RAM/ROM access ≈ era-SRAM (50–100 ns). Values are arbitrary-unit-consistent; only ratios matter for scoring, but ns units let TAs talk about "your clock would run at X MHz," which students love.

### 4.5 Feedback, loops, and oscillation

- Combinational cycles are detected at compile time (SCC analysis). Event-storm detection bounds every run; non-convergence marks all nets in the cycle `X` and raises a visible oscillation error. The simulator never hangs.
- Subcircuit-instantiation cycles in the hierarchy are a load-time error.
- Unlike DLS, nothing is ever resolved randomly. Ever.

### 4.6 Determinism rules for core contributors

- No `HashMap`/`HashSet` iteration order may affect evaluation, serialization, or output — index-ordered `Vec`s (or `BTreeMap`/`IndexMap`) everywhere it matters.
- No floating point, wall-clock, or RNG in the evaluation path.
- Same file + same mode + same inputs ⇒ identical trace on every platform.

### 4.7 Clock

Single global clock domain. A `clock` component places a clock source; multiple clock components all mirror the same global clock (harmless, e.g. for layout convenience). No multi-clock support.

---

## 5. File Format v2 (wire-centric, graph-based)

### 5.1 Design principles

1. **Copper-first.** Students draw wires; wires are what gets saved. No named nets, no tunnels — connectivity you can't see doesn't exist. (Pedagogy: at the end of the day it's all copper and silicon. Also: tunnel labels are visual clutter, and aesthetics is a first-class goal.)
2. **Still a true graph.** Each wire is an explicit edge between two endpoints; an endpoint is a component pin _or_ an explicit junction onto a segment of another wire. Unlike legacy `.sim`, no connectivity is ever guessed from coordinates.
3. **Nets are derived, not stored.** At load (and incrementally in the editor), union-find over wire endpoints/junctions yields nets in O(n·α(n)). Nets get internal IDs (`n0…nk`) used by the engine and the UI diff-stream — never exposed to students. Net-extent hover-highlight (the feature that makes untangled wiring navigable without tunnels) is therefore still trivial. (See Appendix B.3 for why this model beat the net-centric alternative.)
4. **Human-readable, diff-friendly JSON:** canonical serialization (2-space indent, sorted keys, stable IDs) so student circuits live happily in git.
5. **Versioned from day one:** `format` + `version`; breaking changes ship with a migration.

### 5.2 Schema sketch (normative JSON Schema lands in M0)

```jsonc
{
  "format": "circuitsim-plus-plus",
  "version": 4,
  "name": "LC-5200 Datapath",
  "settings": {
    "clockHz": 1,
    "delayTable": "cs2200-74ls-v1", // published cost table (§4.4)
  },
  "circuits": [
    {
      "name": "main",
      "components": [
        {
          "id": "c17",
          "type": "gate.and",
          "pos": [15, 10],
          "rot": "E",
          "name": "", // optional; REQUIRED on autograder-exposed parts
          "attrs": { "bitsize": 32 },
          // pins have no connectivity fields at all — wires own connectivity
        },
        {
          "id": "c88",
          "type": "mem.ram",
          "pos": [40, 20],
          "name": "imem", // autograder-visible
          "attrs": {
            "bitsize": 32,
            "depth": 65536,
            "autoload": "program.hex", // file image loaded at startup AND on every reset
            "contents": "0000 4-0001 ...", // optional embedded RLE-hex (legacy-compatible encoding)
          },
        },
        {
          "id": "c90",
          "type": "subcircuit",
          "pos": [60, 10],
          "attrs": { "circuit": "alu" },
          // pins come from the alu circuit's pin components, referenced by
          // wires below — explicit, never positional-by-coordinates
        },
      ],
      "wires": [
        {
          "a": { "comp": "c17", "pin": "out" },
          "b": { "comp": "c88", "pin": "addr" },
          "points": [
            [18, 11],
            [30, 11],
            [30, 21],
            [38, 21],
          ], // drawn path; rounded at render
        },
        {
          "a": { "comp": "c21", "pin": "out" },
          "b": { "join": { "wire": 0, "segment": 1 } }, // junction onto wire 0
          "points": [
            [24, 5],
            [24, 11],
          ],
        },
      ],
    },
  ],
}
```

Wire rules (mirroring the proven DLS model, App. B):

- Every wire has exactly two endpoints; **at least one endpoint is a pin** (the other may be a junction onto another wire's segment). A junction renders as a dot.
- Fan-out = multiple wires sharing a source pin. Buses have no width of their own — width is a property of the driving pin; validation requires all pins on a derived net to agree on bitsize (mismatch = error, both locations pointed out in the UI).
- Deleting a wire deletes wires junctioned onto it (no dangling `join` references). The editor offers both granularities: Delete on a wire takes it **and** its junction dependents (delete branch), while a second click narrows the selection to one drawn segment — Delete then drops the bend that segment turns at, so the wire takes a shortcut and both endpoints stay attached (delete segment; a wire with no bends is just that segment, so it goes entirely).
- Wires/junctions are scoped to a single circuit; cross-hierarchy connection happens only through subcircuit pins.

Validation on load (collect **all** errors; never panic; never partially load): every pin reference and junction resolves; bitsize agreement per derived net; `name`s unique per circuit; hierarchy acyclic; IDs unique.

### 5.3 Extension

`.csx` (resolved D4).

---

## 6. Component Library (v1)

| Category                                                                                  | Components                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Gates                                                                                     | `and or xor not buffer nand nor xnor` — configurable input count (2..32); the De Morgan "bubbled" variants are separate parts, not a per-input setting                                                                                                               |
| Wiring                                                                                    | `pin` (subcircuit I/O; bitsize; value display mode: unsigned/signed/hex), `constant`, `clock` (mirrors the global clock), `splitter` (arbitrary bit mapping — the bus plumbing), `probe` (named value display; autograder-readable), `power` / `ground` (fixed 1-bit |
| sources with no attrs) and `transistor` (a gate-driven pass gate with `in` / `gate` /     |
| `out`, its own kind so a halt names `gate` rather than `en`)                              |
| Plexers                                                                                   | `mux`, `demux`, `decoder`, `priority-decoder`                                                                                                                                                                                                                        |
| Arithmetic                                                                                | `adder`, `subtractor`, `multiplier`, `divider`, `comparator`, `negator`, `shifter`, `bit-extender`                                                                                                                                                                   |
| Memory                                                                                    | `register`, `ram`, `rom` — RAM/ROM expose `name`, `autoload`, embedded `contents`, and an address width independent of the word count (`addrBits`, derived from `depth` unless set)                                                                                  |
| Hierarchy                                                                                 | `subcircuit` (pins referenced by name from wires; an instance may carry                                                                                                                                                                                              |
| `width` / `height` in grid units — unset derives the box from its pin count, and the pins |
| are never crowded)                                                                        |
| I/O (UI-only)                                                                             | button, LED, hex display, text annotation (`misc.text`) — inert headless                                                                                                                                                                                             |
| Debugging                                                                                 | `breakpoint` — watches `in` for a `value` while `en` is armed; hitting one **pauses** the run and the next step continues (the one halt that is not a fault). The old tool's `BreakpointPeer`, kept instead of substituted with a probe                                                                                              |

Deliberately **excluded**: tunnels, named wires, `counter` (register + adder is the lesson), any "black-box convenience" parts that hide the underlying logic from students.

**Visual language:** consistent shape per family (cleaned-up distinctive shapes); a NAND is recognizably "AND shape + bubble." Wire aesthetics per Appendix B.

---

## 7. Frontend (Tauri + React) — confirmed stack

### 7.0 Renderer host: Web vs Native (team question — comparison)

Now that we know the circuit canvas is a custom renderer either way, the honest trade-off:

|                                                                                           | **Web (Tauri + React + Canvas2D)** — chosen                                                                                                   | **Native Rust (egui / wgpu)**                                                                                     |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Circuit renderer itself                                                                   | Custom Canvas2D — a few hundred lines, batched vector paths                                                                                   | Custom egui/wgpu paint — _same_ few hundred lines; renderer is the cheap part in both worlds                      |
| Everything _around_ the canvas (menus, palette, dialogs, probe panel, themes, animations) | HTML/CSS — the fastest known path to "very, very pretty"; trivial gradients, transitions, layout; this is where 90% of UI polish effort lives | Hand-built widgets; no CSS; every pretty detail is custom code; egui is functional, not beautiful, out of the box |
| Iteration speed                                                                           | Hot reload; huge ecosystem; easy to vibe-code                                                                                                 | Rust compile cycles; small ecosystem for fancy UI                                                                 |
| Sim ↔ UI boundary                                                                         | Serialized diff-stream (a few KB/frame — measured design, §7.1)                                                                               | Zero-copy, in-process                                                                                             |
| Platform risk                                                                             | Webview fragmentation (WebKitGTK / WebView2 / WKWebView) → CI on all three from M2; Gradescope never touches a webview                        | No webview; one language end-to-end; smaller binary                                                               |
| Team fit                                                                                  | Matches stated goal: "use CSS/JS/HTML, easy to vibe code"                                                                                     | Rejected in v0.1 for exactly that reason                                                                          |

**Verdict: stay with Tauri + React + custom Canvas2D.** The renderer costs the same either way; web tech wins decisively on the chrome, which is where the aesthetic goal lives. And because `csim-core` is UI-agnostic, the decision is reversible without touching the engine.

### 7.1 Stack & rendering

- **Stack:** Tauri 2, React 18+, TypeScript, Vite.
- **Circuit canvas: hand-rolled Canvas 2D inside one React component.** On `react-canvas` specifically: **no** — the Flipboard `react-canvas` library has been unmaintained for years; the maintained scene-graph equivalents (react-konva) keep a per-node retained tree, which is overhead we don't need when a frame is 5k+ batched wire paths. A custom renderer with a spatial index for hit-testing is _less_ code than fighting a scene graph and gives exact control over batching, zoom-dependent detail, and state-color pass ordering. (DLS reaches the same conclusion: immediate-mode drawing via its own SebVis layer.) React owns the chrome. If Canvas2D ever profiles insufficient, the renderer hides behind an interface and PixiJS/WebGL slots in locally.
- **Theming:** CSS custom properties; dark and light themes; **one themeable bus colour** (per-net rainbow hues read as noise on a busy datapath; a wire's own `color` still wins). Palettes are data, not code, so a dedicated colorblind-accessibility pass later is a theme drop-in, not a refactor (deferred — no colorblind students this semester; resolved D8).
- **Wire rendering (the DLS look, App. B):** quadratic-Bézier-rounded corners, per-state colors (low / high / `X` error / `Z` floating / disconnected), thickness option ∝ bitsize, hover = brighten + net-extent highlight (the no-tunnels navigability feature).
- **Editing:** drag-and-drop palette; click-drag wire routing with placeable bends; junction on drop-onto-wire; drag components with wires attached; copy/paste; multi-select; undo/redo; probe value display modes (unsigned/signed/hex).
- **Simulation control:** play/pause/step-tick/step-cycle, speed slider (time compression), run-to-cycle-N, watch panel of named probes/registers, savestate/restore.
- **Clock pins: shown, not hidden (resolved D2).** De-emphasized visually; one-click "connect to global clock." Hiding invites magic; showing teaches synchronous design. There are no _reset_ pins: resetting is the session's job (§8, `sim_reset`).

### 7.2 IPC & streaming

Sim runs on a dedicated Rust thread. The UI never receives full per-tick state:

- Core emits **diffs**: `(internal_net_id, new_value)` for changed nets + cycle counter. A few KB per frame at most.
- UI consumes ≤ 1 batch per animation frame; at high sim speeds intermediate states are dropped — display shows the latest, never a backlog. That merge is for *painting*: a consumer that needs history (the waveform viewer, §89) taps the batches **before** it (`DiffPump`'s `onRaw`), so a cycle in which a net moved is never lost. The engine still sends nothing extra.
- Controls (load/play/pause/step/poke/speed) via Tauri commands; state via events.
- Nets are engine-internal and reach the UI only as identifiers: `LoadResult.net_map` (net ↔ wires)
  and, since contract **v1.2**, `NamedComponent.value_net`. The engine gives **every pin** a net —
  even an unwired one — so a named part's readout keeps working with its value output left open
  (a register with `q` unconnected still shows its stored value). The same version flags a net whose
  `X` is a real driver fight (`NetChange.contended`), so the UI can call a short circuit a short
  circuit — an `X` that merely flowed in (divide-by-zero, an `X` mux select) stays unflagged.

---

## 8. Autograder Interface (`csim-cli`)

Pure Rust, statically linked (`x86_64-unknown-linux-musl`), no webview, no JVM. Students never touch it — they submit through Gradescope; clunky-is-fine is acceptable here, JSON-in/JSON-out is the contract.

### 8.1 Invocation model

```bash
csim run submission.csx \
  --load imem=program.hex \      # any number of named memories
  --load dmem=data.hex \
  --cycles 500000 \
  --timeout 60s \
  --assert "probe('result') == 0x2A" \
  --assert "mem('dmem')[0x100] == 0x1234" \
  --json report.json
# DTA is the default and the only mode (the zero-delay engine was removed)
```

Other subcommands: `csim validate file.csx`, `csim timing file.csx --paths 10` (observed-critical-path detail), `csim snapshot …` / `csim resume …`.

### 8.2 Report contract

- Exit codes: 0 = all assertions passed; distinct non-zero for assertion-failure / cycle-limit / timeout / oscillation / **floating-read** / malformed-file.
- JSON report: `cycles`, `halt_reason`, `T_obs`, `est_time`, `speedup_vs_baseline`, `timing_violations` (setup/hold warnings, §4.3), per-assertion results, top-k observed critical paths (with component identities for UI highlight), optional `T_sta` (informational, clearly labeled), peak RSS, wall time.
- Named access: any component with a `name` (RAM, ROM, register, probe) is addressable; names validated unique at load.
- Determinism per §4.6; identical submissions get identical reports on any grader instance.

### 8.3 Test-spec file

Optional JSON/YAML spec replacing long flag lists: setup (memory loads, pokes, clock config), run limits, assertions, and **rubric thresholds on `est_time`** (e.g., full credit below X) — the "arbitrary metric" hook for the performance project.

---

### 8.4 Stop conditions (`stop`, contract v1.3)

A run otherwise ends on its cycle budget, a fault, or a `debug.breakpoint`. A course's "the
program has finished" rule is none of those — CircuitSim CE itself has **no halt concept at
all** (a design simply stops changing), so every harness reconstructed it *outside* the
engine: the tester API's `Clock.tickUntil(maxTicks, stop)`, CS 2200's "the PC/state register
stopped changing" and "IR holds HALT", CS 2110's "the `isHalt` pin is 1". `stop` makes it a
first-class condition, evaluated at every cycle boundary (the settled state a grader reads
after a clock tick):

| `when` | holds when | the rule it expresses |
| --- | --- | --- |
| `stable` | the value has been identical across N consecutive boundaries | the EC pipeline's "PC unchanged for 100 ticks"; project 1's "the microcode state register stopped changing" |
| `reaches` | the value **becomes** X — a transition, like `debug.breakpoint` | CS 2110's "the `isHalt` pin is 1" |
| `is` | the value **equals** X — a level, so it can hold before the first cycle, exactly as `tickUntil` tests its predicate | "the IR opcode is HALT" |

`name` addresses what `probe('…')` reads; a **unique** `/`-suffix is accepted too, because a
watch's name comes from the design's own labelling (`PC-IF`, `State`) while an assertion's is
written by the grader with the full path — ambiguity is an error, never a guess. A watch that
holds **disarms**, and the run reports `halt_reason: "stop"` with it in `stop`, so `cycles`
then *is* the **cycle count to completion** (`stop.last_change_cycle` is the cycle the value
last moved, which is what the course graders report). `expect_halt` now means "one of these
must hold". The same primitive is `Sim::set_watch`, which is what lets the editor offer "run
until it halts" — the old tool's Ctrl-K, automated.

## 9. Distribution & Updates

- **Packaging:** GitHub Actions matrix builds → Tauri bundles: macOS `.dmg`, Windows `.zip`/`.exe`. Hosted on GitHub Releases (and/or mirrored to Canvas).
- **Unsigned (team decision — too broke to sign; resolved D14):** ship without code signing; distribute a one-line workaround with the download — macOS: right-click → Open (or `xattr -d com.apple.quarantine`); Windows: SmartScreen → "More info" → "Run anyway." If the professor ever wants to fund/own an Apple Developer ID, notarization slots into CI unchanged.
- **Update nudge:** on startup the app fetches the latest release tag from our GitHub repo, semver-compares, and (if behind) shows a friendly "please upgrade" dialog with a download link. Never forced, never auto-installs. This is what makes rolling development safe: ship an MVP better than CircuitSim, perfect it over the semester.
- Linux: no packaged desktop build promised; the autograder CLI is the Linux artifact (TAs can build the app from source).

---

## 10. Academic Integrity Signals

Honest scoping: **none of this is proof; all of it is cheap evidence + deterrence**, consistent with the team's stance (learning from friends is fine; wholesale copying / undisclosed full AI generation is not). And yes — anything client-side is forgeable with enough effort; the bar is "too annoying to be worth forging," not "impossible." (Legacy `revisionSignatures` was the same idea, same property; dropped, D9.)

1. **Submission similarity (the high-value one).** Offline TA tool: flatten each submission's netlist, compute structural fingerprints (Weisfeiler–Lehman-style graph hashes + component-type/degree histograms), then pairwise-compare across the cohort — "MOSS for circuits." Renamed/moved copies collide hard under graph fingerprints. Pure post-hoc analysis; zero impact on students.
2. **Provenance journal (deferred — post-MVP).** When built: an append-only, coarse edit log embedded in the file (timestamps + aggregate event counts: components placed/deleted, paste operations with size) that **doubles as the undo-history backing store** — it reads as an editing aid, not a "did you cheat tracker." A circuit appearing in one 400-component paste reads differently from three weeks of edits. No keystroke/mouse tracking; nothing leaves the machine until submission.
3. **AI generation:** there is no reliable detector and we will not pretend otherwise. Practical mitigations: the journal above (no history + appears-at-once is a flag for a chat, not a verdict), plus spot-check "explain your datapath" walkthroughs for flagged submissions. Policy stays humane: tools are fine, learning must be demonstrable.

---

## 11. Robustness, Limits, Security

- **Untrusted files:** parser fuzzing in CI; graceful error lists instead of panics; subcircuit nesting depth cap; post-flatten instance cap (configurable, default ~1M) so corrupt files can't OOM the grader. (No student-facing component limits — the old simulator's limits were a bug, not a feature.)
- **CLI resource caps:** wall-clock timeout, cycle limit, RSS guard.
- **Autoload paths** resolve relative to the circuit file, sandboxed to its directory tree by default (CLI flag to relax) — a submission can't read the grader's filesystem.
- **Integrity fields:** none embedded for tamper-proofing (§10 handles integrity socially/statistically).

---

## 12. Alternatives Considered

| Alternative                                   | Verdict             | Rationale                                                                                                                                                                             |
| --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Optimize/patch the Java CircuitSim            | **Rejected**        | JVM footprint/startup on 2 GB graders is the core complaint; weekend-built codebase; clean rewrite wins. Kept as behavior reference only.                                             |
| Fork Logisim-evolution / Digital              | **Rejected**        | Same JVM problem; deep-fork cost; not the aesthetic target.                                                                                                                           |
| Electron instead of Tauri                     | **Rejected**        | Bundles Chromium (~hundreds of MB idle) — against the small/fast goal. Accepted Tauri risk: webview fragmentation → CI on all three OSes from M2; Gradescope never touches a webview. |
| Native Rust UI (egui / wgpu / Slint)          | **Rejected for v1** | Full comparison in §7.0: renderer costs the same either way; web chrome wins on beauty-per-effort; core stays UI-agnostic so it's reversible.                                         |
| Browser-only app (core → WASM)                | **Rejected**        | Team decision: desktop-only by design — students install and use real software.                                                                                                       |
| `react-canvas` for the canvas                 | **Rejected**        | Unmaintained for years. Scene-graph alternatives (react-konva) add per-node overhead with no win at 5k+ wires. Hand-rolled Canvas2D + spatial index.                                  |
| Keep legacy `.sim` format / write a converter | **Rejected**        | Geometric connectivity inference is the root of the wiring pain; course circuits are rebuilt by hand; legacy spec kept as Appendix A reference only.                                  |
| Net-centric format (pins name net IDs)        | **Rejected**        | Requires named-net bookkeeping students can't see; wire-centric (DLS-proven) matches copper-first pedagogy; nets derived by union-find instead. Full comparison: Appendix B.3.        |
| STA as the grading metric                     | **Rejected**        | Structural worst case counts microcode/bus paths students never sensitize — misleading grades, confused students. DTA primary; STA kept as optional informational field (§4.4).       |

---

## 13. Risks & Flaws

1. **~~Propagation delays vs. autograder determinism~~** — resolved: all engines deterministic (§4.6); grading runs the delay-aware engine; DTA supplies timing (§4.4).
2. **DTA coverage dependence** — a path never sensitized scores optimistically (favors the student). Mitigations: comprehensive suite (already exists); optional informational `T_sta`; accepted by team.
3. **Scope creep** — mitigated by rolling releases + update nudge (§9): MVP that already beats CircuitSim, then continuous polish. Visualization polish and integrity tooling are explicitly post-MVP.
4. **Webview fragmentation (Tauri)** — CI on all three OSes from the first UI milestone; canvas renderer is the only perf-sensitive surface; Gradescope uses CLI only.
5. **Floating-read strictness** — halting on consumed `Z` is electrically honest but may false-positive on idle tri-state buses feeding gates directly (rather than register inputs). Watch-item: if it annoys in practice, add a pull-up/pull-down component or a per-pin tolerance flag. Spec stays strict for v1 (team decision D3).
6. **Determinism traps in Rust** — §4.6 codified; enforced in `csim-core` review.
7. **Unnamed memories/registers** — students will forget to name them; load-time warnings + UI nudge when a memory is placed; CLI errors clearly on ambiguous `--load`.
8. **No-tunnels UX risk** — long-range connections can become spaghetti. Mitigations: good wire-routing tools (placeable bends, segment drag), net-extent highlight, subcircuit discipline taught in labs. Accepted trade-off (team decision).
9. **Provenance journal forgery/privacy** — deferred, coarse, disclosed, deterrent-only (§10).
10. **Team Rust ramp-up** — keep `csim-core` small, invariants documented (§4.6), sub-agent tasks scoped per crate against the contracts in this doc.

---

## 14. Milestones

| Phase                       | Deliverable                                                                                                                                                                                                                                                     | Depends on               |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| **M0** Foundations          | Cargo workspace; format JSON Schema; value model; union-find netlist builder; flatten/levelize; cycle detection; **delay-aware event engine (inertial gates + transport wires + timed registers)**; STA (informational); **draft 74LS delay table**; unit tests | —                        |
| **M1** Autograder           | `csim-cli`: run/load/assert/**DTA timing**/report; snapshot/resume; musl build; Gradescope Docker image                                                                                                                                                         | M0                       |
| **M2** Desktop shell        | Tauri app; canvas editor (palette, wire routing w/ bends & junctions, pan/zoom, select, undo); diff-streamed sim controls                                                                                                                                       | M0                       |
| **M3** Library + visuals    | All §6 components; gate shapes; DLS-style wire rendering; error highlighting (contention/floating/oscillation); probe watch panel                                                                                                                               | M2                       |
| **M4** Timing visualization | Propagation animation (signals visibly traveling wires); **observed-critical-path highlight in UI (from DTA)**; setup/hold violation markers                                                                                                                    | M0 (parallel with M2/M3) |
| **M5** Polish & ship        | RAM autoload UI, savestates, themes, update-nudge, unsigned installers + workaround docs, perf hardening                                                                                                                                                        | M3                       |
| **Post-MVP**                | Integrity tooling (similarity runner + provenance-journal-as-undo-history); colorblind accessibility pass; optional metastability-as-`X` modeling                                                                                                               | —                        |

MVP for limited student pilot = M0–M3. Performance-project readiness = + M5. M4 any time after M0.

**Execution:** M0/M1 and M2–M5 are decomposed into parallel sub-agent task lists in `docs/tasks/` (`README.md` = ownership map + pinned IPC contract; `BACKEND.md`; `FRONTEND.md`).

---

## 15. Open Decisions

| #   | Question                    | Recommendation                                                                                                                       | Status                    |
| --- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| D1  | Delay model                 | **Hybrid: transport wires + inertial gates + register clk→Q/setup/hold (§4.3) — resolved (team; matches curriculum)**                | ✅ resolved               |
| D2  | Hide clock pins?            | **No — resolved (team)**; de-emphasize + auto-connect. The `rst` inputs themselves were removed in format v4 — reset is `sim_reset`. | ✅ resolved               |
| D3  | Floating input semantics    | **Halt-on-consume — resolved (team)**; watch-item §13.5                                                                              | ✅ resolved               |
| D4  | Extension                   | **`.csx` — resolved (team)**                                                                                                         | ✅ resolved               |
| D7  | Tunnels?                    | **No tunnels, no named nets — resolved (team)**                                                                                      | ✅ resolved               |
| D8  | Wire palette                | **One themeable bus colour + per-state wire colours; accessibility pass later — resolved (team)**                                    | ✅ resolved               |
| D9  | Legacy `revisionSignatures` | **Dropped — resolved (team)**                                                                                                        | ✅ resolved               |
| D10 | Name/licensing              | **Resolved** — BSD-licensed original, 2110 permission granted; keep attribution                                                      | ✅ resolved               |
| D11 | Grading timing metric       | **DTA primary; STA informational-only — resolved (team)**                                                                            | ✅ resolved               |
| D12 | Provenance journal          | **Deferred post-MVP; doubles as undo history — resolved (team)**                                                                     | ✅ resolved               |
| D13 | Delay-table values          | Approach resolved: 74LS typicals; concrete values TBD by staff before M0 ends                                                        | approach ✅ / values open |
| D14 | Code signing                | **Unsigned + workaround docs — resolved (team)**                                                                                     | ✅ resolved               |

**All decisions resolved.** Only D13's concrete delay-table numbers remain, and they block nothing — the engine ships with the draft 74LS values and the table is data, not code.

---

## Appendix A — Legacy `.sim` format (reference only; no converter will be built)

From real files (`v1.11.2-CE`):

- Top level: `version`, `globalBitSize`, `clockSpeed`, `circuits[]`, `revisionSignatures`.
- Circuit: `name`, `components[]`, `wires[]`.
- Component: `name` = Java FQCN (e.g. `...peers.gates.NotGatePeer`), `x`, `y`, `properties` (string→string: `Label`, `Bitsize`, `Direction`, splitter `Fanouts`/per-bit maps, RLE-hex memory contents).
- Wire: `{x, y, length, isHorizontal}` — pure geometry; connectivity inferred by the app. The thing v2 eliminates.
- Subcircuit pin order inferred from pin **coordinates** — fragile; v2 references pins explicitly.
- Transpiler-generated files connect everything via same-label `Tunnel`s (e.g. 3,443-component EC CPU with 0 `wires[]` entries) — evidence the community already wanted a graph abstraction.
- Memory contents: run-length-encoded hex (`count-value` runs, space-separated). v2 keeps this encoding (`rle-hex-v1`) for embedded `contents` and autoload files, since assemblers already emit it.
- Historical note: tunnel connectivity resolution in the Java app is O(n²) — only ever hit by the one student pushing multi-thousand-component designs, but it validates doing connectivity structurally.

## Appendix B — Lessons from studying Digital-Logic-Sim (source)

DLS (Unity/C#, builds on itch.io) — what its source actually does:

### B.1 Worth adopting

- **Wire model** (`WireDescription`): each wire is an edge — `SourcePinAddress → TargetPinAddress`, with `WireConnectionType` = `ToPins | ToWireSource | ToWireTarget`, i.e. a wire may terminate on **another wire's segment** (`ConnectedWireIndex/SegmentIndex`), plus a `Points[]` polyline. This is exactly the wire-centric model in §5, and it's proven in the precise UI style we want.
- **Wire aesthetics** (`WireDrawer`): interior polyline points rounded with quadratic Béziers (curve radius ~0.12 grid units, ~20 segments). Theme (`DrawSettings`): arrays of low/high colors **indexed per bus** (that's the rainbow-bus look in the videos), hover = brightened variant, disconnected = neutral. Cheap to reproduce on Canvas2D.
- **Pin cosmetics** (`PinDescription`): per-pin color coding and value display modes (unsigned / signed / hex) — adopt for pins and probes.
- **Threading**: sim on its own thread, main thread enqueues modification commands — same shape as our diff-stream design.
- **Their own TODO list** reads like our roadmap: combinational LUTs, skip-if-inputs-unchanged (activity-driven eval), flatten-to-primitives network. Independent validation of the architecture; those three are Phase-5 perf ideas for us.

### B.2 Explicitly not adopted

- **The simulator core.** DLS _deliberately_ injects randomness: conflicting inputs on a pin "choose randomly," and every ~100 frames it randomly reorders not-yet-ready chips "to allow variety in the outcomes of race conditions" (SR-latch-style). Charming for a demo; disqualifying for an autograder. We do fixed tie-breaking and `X` on contention (§4.1, §4.6).
- Recursive per-chip evaluation without flattening or levelization — doesn't scale to 3.4k-component processors; we flatten + levelize (§4.2).
- Block-style chips instead of gate symbols — by prior team decision we use real gate shapes.

### B.3 The v0.1 proposal (net-centric) vs. DLS's model (wire-centric) — how they differ

|                                | **Net-centric (v0.1 proposal — rejected)**                                                                                                    | **Wire-centric (DLS — adopted, §5)**                                                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stored truth                   | Nets are first-class objects with IDs; each pin names its net ID; nets carry route geometry                                                   | Wires are first-class edges; each wire's endpoints are pin addresses or explicit junctions onto another wire's segment; wires carry their own polylines |
| Nets                           | Stored, named — an invisible abstraction students must trust                                                                                  | **Derived** at load by union-find over wire endpoints; internal IDs only; students never see them                                                       |
| Fan-out                        | One net, many pins                                                                                                                            | Multiple edges from one source pin — visually identical, structurally explicit                                                                          |
| Edit semantics                 | Deleting one drawn segment forces geometric re-analysis: did the net split? which pins move to the new net? Net IDs churn as nets merge/split | Deleting a wire deletes an edge (plus its junction dependents). No re-inference, no ID churn                                                            |
| Netlist build                  | Map lookup                                                                                                                                    | Union-find — O(n·α(n)), trivial                                                                                                                         |
| Net-extent hover highlight     | Trivial                                                                                                                                       | Equally trivial (union-find result is cached in the editor)                                                                                             |
| Fit to "copper-first" pedagogy | Poor — connectivity exists in an invisible table                                                                                              | Exact — what's drawn is what's saved is what's simulated                                                                                                |

Both reduce to the same net graph internally, so the simulation engine is identical either way; the difference is entirely in the student-facing model and edit invariants. Wire-centric won on pedagogy (nothing invisible), edit simplicity, and being proven in the exact aesthetic we're targeting.
