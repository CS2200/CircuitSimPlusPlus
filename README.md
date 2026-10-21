# CircuitSim++

A clean-slate rewrite of the classic CircuitSim logic simulator used in Georgia
Tech's CS 2110/2200: a deterministic Rust simulation core, a headless autograder
CLI for Gradescope, and a Tauri + React desktop app.

**Read first:** [`DESIGN.md`](DESIGN.md) is the normative design spec. The doc map:

| Doc | What it pins |
|---|---|
| [`DESIGN.md`](DESIGN.md) | Architecture, simulation semantics, goals, decisions (D1–D14) |
| [`docs/format-v2.md`](docs/format-v2.md) | The `.csx` file format + simulation semantics (§9) |
| [`docs/delay-table.md`](docs/delay-table.md) | Delay model, 74LS timing table, DTA/STA conventions |
| [`docs/autograder.md`](docs/autograder.md) | Exit codes, assertion grammar, test-spec & snapshot schemas |
| [`docs/ipc.md`](docs/ipc.md) | **Normative** core↔UI contract (v1.2) |
| [`docs/releasing.md`](docs/releasing.md) | How releases are cut on GT's runner-less GHES (3 machines, one per OS) |
| [`docs/distribution.md`](docs/distribution.md) | Distribution & update plan: public github.com mirror (decided, not built) |
| [`docs/tasks/`](docs/tasks/README.md) | Execution history: ownership map, agent task lists, status |

## Repository layout

```
crates/
  core/     csim-core — delay-aware simulation engine, .csx format, STA/DTA,
            autograder API, Session (the api::Sim the UI drives)
  cli/      csim — headless autograder / CLI binary
  app/      csim-app — Tauri desktop shell (thin adapter over csim-core)
frontend/   React 18 + TypeScript + Vite UI (canvas editor, sim controls)
tests/      .csx fixtures (ALU, FSM, multicycle & 5-stage CPUs, negatives)
gradescope/ Dockerfile for the autograder image
scripts/    build runner — `node scripts/build.mjs` (thin wrapper, see below)
docs/       Specs and task lists (above)
```

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | recent stable (developed on 1.98) | via rustup preferred (needed for the musl target) |
| Node.js | ≥ 22 | includes npm |
| Python | 3.8+ | fixture drift gate (`node scripts/build.mjs fixtures`); `PYTHON=` overrides the interpreter |
| Playwright browsers | — | `npx playwright install --with-deps chromium` (e2e only) |
| Linux webview deps | — | desktop app only: `sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` (Ubuntu; equivalents on other distros) |

The backend (`csim-core` + `csim`) has **no system dependencies** — it builds
anywhere Rust does, and statically links for the autograder.

## Build runner

`scripts/build.mjs` is a thin, cross-platform wrapper over the exact commands
below and is the project's commit gate. It adds no dependency (Node ≥ 22 is
already required).

```bash
node scripts/build.mjs            # default: the full commit gate (backend + frontend)
node scripts/build.mjs --list     # every target
node scripts/build.mjs musl ui    # run targets in order, stop on first failure
```

| Target | What it runs |
|---|---|
| `build` | `cargo build` (default members: core + cli) |
| `lint` | format check + clippy `-D warnings` (core + cli) |
| `test` | backend tests |
| `fixtures` | regenerate the `.csx` fixtures into a temp dir and diff — no drift |
| `check:backend` | `fixtures` + `lint` + `test` |
| `ui` | frontend production build → `frontend/dist` |
| `check:frontend` | `lint` + `test` + `build` |
| `check` | `check:backend` + `check:frontend` (default) |
| `e2e` | Playwright (needs browsers, see prerequisites) |
| `musl` | static musl release of the CLI |
| `desktop` | packaged Tauri bundles (needs Linux webview deps) |
| `image` | the Gradescope Docker image |

The raw commands remain authoritative; the runner just saves retyping them.

## Backend: build, test, run

Prefer the runner for the common cases (`node scripts/build.mjs build lint test
musl`); the raw invocations below are what it and CI execute.

```bash
# Build + test the workspace default members (core + cli; not the Tauri shell)
cargo build
cargo test -p csim-core -p csim          # 200 tests (unit + 9 golden + CLI)
cargo clippy -p csim-core -p csim --all-targets -- -D warnings
cargo fmt --all -- --check

# The CLI
cargo run -p csim -- run tests/fixtures/pipeline5.csx \
    --load imem=tests/fixtures/program.hex \
    --cycles 500000 --timeout 60s \
    --assert "mem('dmem')[0] == 10" \
    --json report.json                   # exit code = grading outcome (docs/autograder.md)

cargo run -p csim -- validate file.csx   # parse + netlist checks, all errors listed
cargo run -p csim -- timing file.csx     # DTA observed critical paths (--sta for static)
cargo run -p csim -- snapshot/resume ... # deterministic savestates

# Static musl binary (as deployed on Gradescope; needs rustup)
rustup target add x86_64-unknown-linux-musl
cargo build -p csim --release --target x86_64-unknown-linux-musl
```

**Determinism is a hard invariant** (DESIGN.md §4.6): no `HashMap` iteration,
floats, wall-clock, or RNG in evaluation/serialization paths. The golden
trace-hash suite (`crates/core/tests/golden.rs`) is the tripwire — if an
intentional engine change alters traces, re-bless with
`CSIM_BLESS=1 cargo test -p csim-core --test golden -- --nocapture` and record
*why* in the commit message. Note the bless **prints** the refreshed table; it
does not rewrite the file, so paste the new `t_obs`/`trace_hash` values into
`SCENARIOS` (the plain run must then pass on its own).

The fixtures are generated and committed: `tests/gen/gen_fixtures.py` +
`tests/gen/gen_cpus.py` write `tests/fixtures/`, and
`node scripts/build.mjs fixtures` regenerates them into a temp dir and diffs, so
they cannot drift from their generators unnoticed (a hand-authored fixture —
`sanity.csx` — is listed as such in the checker). After a format, pin or
delay-table change: regenerate in place *first*, then re-bless the goldens on
top.

## Frontend: develop, test, build

Prefer `node scripts/build.mjs ui` / `check:frontend` for the build and gate;
`npm run dev` stays a direct command since it is long-running.

```bash
cd frontend
npm install

npm run dev            # Vite dev server on :1420 — runs against the in-app
                       # MOCK core (frontend/.env.development sets VITE_MOCK_CORE=1),
                       # so UI work needs no Rust

npm run test           # unit tests (vitest, 342)
npm run test:e2e       # Playwright (needs browsers, see prerequisites)
npm run lint           # eslint + prettier --check
npm run build          # tsc --noEmit && vite build → frontend/dist
```

The UI is a VS Code-style **top bar** (File / Edit / View / Help) over a
**transport bar** (play-pause, step one tick, reset, run-to, speed presets, live
`T_obs`), a **palette** rail of part families, a **right-dock Inspector** for the
selection, and a **sheet-tab strip** with one tab per circuit. Preferences —
theme, accent, grid, live values, default label side, 12-/24-hour timestamps,
autosave — live in **File → Settings…** (the only path to theme, light or dark);
byte-level history is **File → Version history…** (Ctrl+Alt+H). A zoom slider
sits at the bottom edge of the canvas.

A subcircuit's interface is its named **pin components** (`wiring.pin`): input
pins face left by default, output pins (`isOutput`) face right. Instances are
placed from the palette's Subcircuits group (any number of copies); the
instance's pins mirror the target's interface — inputs on the left edge, outputs
on the right, in document order, matching the netlist's bridge order. Double-click
a tab to rename it, "+" to add a subcircuit, right-click for the tab menu. File
shortcuts: Ctrl+O open, Ctrl+S save, Ctrl+Shift+S save-as. Saving always goes
through the engine's canonical serializer (`save_circuit`), never local JSON.

The browser-based dev flow uses the mock; the **real engine** is exercised
through the Tauri shell. Gotcha: `.env.development` forces the mock in *every*
dev server, including one launched by `tauri dev` — override it explicitly:

```bash
# Full desktop app, REAL csim-core Session (native window; hot-reloads the UI)
cd crates/app
VITE_MOCK_CORE=0 ../../frontend/node_modules/.bin/tauri dev

# Packaged desktop app (production builds don't read .env.development, so the
# real core is the default there; unsigned dmg/zip/exe — see "Releasing")
cd crates/app
../../frontend/node_modules/.bin/tauri build
./../../target/release/csim-app        # or install the bundle
```

`crates/app` needs the Linux webview deps above to compile; it's excluded from
the workspace `default-members` so backend work never pays that cost. The
frontend selects its core at runtime: `VITE_MOCK_CORE=1` → TypeScript mock,
otherwise the Tauri bridge (`frontend/src/ipc/tauri.ts` → `csim_core::session::Session`).
Both implement the same `CoreApi` contract (`frontend/src/ipc/types.ts` ⇔
`crates/core/src/api.rs` — keep them field-for-field identical; `docs/ipc.md`
is normative and changes there need human sign-off). Note: `tauri dev`/`build`
run their before-commands from the *parent of the config directory* (classic
`src-tauri` layout assumption) — hence `npm --prefix ../frontend …` in
`tauri.conf.json`.

## Autograder image (Gradescope)

```bash
docker build -t csim-autograder -f gradescope/Dockerfile .
docker run --rm --memory=2g csim-autograder   # in-image fixture self-test
```

The image builds the musl-static `csim`, runs the full test suite during the
build, and self-tests a fixture at container start so a broken image never
reaches students. M1 acceptance: a ~3.4k-component 5-stage pipeline grades in
well under 10 s with ~3 MB RSS in a 2 GB container. Grading contract (exit
codes, assertions, test-spec files): `docs/autograder.md`.

## Releasing (DESIGN.md §9)

There is **no CI**: `github.gatech.edu` is GT's on-prem GitHub Enterprise
Server, which provides no hosted runners and has none registered. Tauri bundles
are also per-OS, so releases are cut locally by the three OS owners (Mac /
Windows / Linux) with `scripts/release.mjs`: the captain opens a **draft**
release, each owner attaches their OS, then it is published.

**Full guide — read [`docs/releasing.md`](docs/releasing.md).** The short form:

```bash
# once per teammate:  gh auth login --hostname github.gatech.edu
# captain, after bumping the version in BOTH crates/app/tauri.conf.json and
# frontend/package.json, and pushing master:
node scripts/release.mjs --tag v0.2.0 --draft
# the other two, once the tag is pushed:
git fetch --tags && git checkout v0.2.0
node scripts/release.mjs --tag v0.2.0 --attach-only
# captain, when --status shows all three platforms:
node scripts/release.mjs --tag v0.2.0 --status
node scripts/release.mjs --tag v0.2.0 --publish
```

## CI

The commit gate is `node scripts/build.mjs check` (backend fixture
drift/fmt/clippy/test, then frontend lint/test/build). Run it locally before
committing — there are no runners to run it for you.

## Conventions for contributors

- **Contracts are pinned.** `docs/ipc.md` + `crates/core/src/api.rs` +
  `frontend/src/ipc/types.ts` are one contract in three spellings; change all
  three together and note it in DESIGN.md. The `.csx` schema lives in
  `docs/format-v2.md`; bump `version` for breaking changes and ship a migration.
- **Ownership boundaries** (from the parallel build): backend owns
  `crates/core`, `crates/cli`, `tests`; frontend owns `frontend/`, `crates/app`;
  `DESIGN.md`/`docs/tasks/` are maintainer-owned. See `docs/tasks/README.md`.
- Gates before committing: the runner does exactly the documented gate —
  `node scripts/build.mjs check` (backend fixture drift/fmt/clippy/test, then
  frontend lint/test/build). Equivalently by hand: `cargo fmt --all && cargo
  clippy --workspace --all-targets -- -D warnings && cargo test --workspace` and,
  if you touched `frontend/`, `npm run lint && npm run test && npm run build`
  (+ `test:e2e`).
- Docs-as-code: semantic decisions get written into the `docs/` specs in the
  same commit as the behavior, not left in comments.

## Troubleshooting

- **`cargo check -p csim-app` fails on Linux** → missing webview deps (see
  prerequisites). Backend crates never need them.
- **Playwright can't find browsers** → `npx playwright install --with-deps chromium`.
- **Port 1420 in use** → Vite is pinned to it (`strictPort`) because
  `crates/app/tauri.conf.json` points at it; free the port or close the other dev server.
- **npm warns about blocked install scripts (esbuild)** → benign; the build
  works. Approve with `npm install-scripts approve esbuild` if your setup
  requires it.
- **Golden tests fail after an intentional engine change** → re-bless (see
  Backend section) and justify in the commit message.
- **Stale build worktrees** → `../backend` and `../frontend` were the
  parallel-build worktrees and are fully merged; remove them with
  `git worktree remove ../backend ../frontend` when convenient.
