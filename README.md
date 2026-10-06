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
| [`docs/ipc.md`](docs/ipc.md) | **Normative** core↔UI contract (v1.1) |
| [`docs/tasks/`](docs/tasks/README.md) | Execution history: ownership map, agent task lists, status |

## Repository layout

```
crates/
  core/     csim-core — simulation engine (both modes), .csx format, STA/DTA,
            autograder API, Session (the api::Sim the UI drives)
  cli/      csim — headless autograder / CLI binary
  app/      csim-app — Tauri desktop shell (thin adapter over csim-core)
frontend/   React 18 + TypeScript + Vite UI (canvas editor, sim controls)
tests/      .csx fixtures (ALU, FSM, multicycle & 5-stage CPUs, negatives)
gradescope/ Dockerfile for the autograder image
docs/       Specs and task lists (above)
```

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Rust | recent stable (developed on 1.98) | via rustup preferred (needed for the musl target) |
| Node.js | ≥ 22 | includes npm |
| Playwright browsers | — | `npx playwright install --with-deps chromium` (e2e only) |
| Linux webview deps | — | desktop app only: `sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf` (Ubuntu; equivalents on other distros) |

The backend (`csim-core` + `csim`) has **no system dependencies** — it builds
anywhere Rust does, and statically links for the autograder.

## Backend: build, test, run

```bash
# Build + test the workspace default members (core + cli; not the Tauri shell)
cargo build
cargo test -p csim-core -p csim          # ~193 tests
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
`CSIM_BLESS=1 cargo test -p csim-core --test golden` and record *why* in the
commit message.

## Frontend: develop, test, build

```bash
cd frontend
npm install

npm run dev            # Vite dev server on :1420 — runs against the in-app
                       # MOCK core (frontend/.env.development sets VITE_MOCK_CORE=1),
                       # so UI work needs no Rust

npm run test           # unit tests (vitest, ~182)
npm run test:e2e       # Playwright (needs browsers, see prerequisites)
npm run lint           # eslint + prettier --check
npm run build          # tsc --noEmit && vite build → frontend/dist
```

The UI is organized around a menu bar: **File** (New / Open / Save / Save As
— native dialogs in the shell, download/upload fallbacks in the browser),
**Simulation** (step/run-to/reset, speed presets, zero/delay mode,
critical-path highlight), and **Subcircuits** (sheet create/rename/switch).
File shortcuts: Ctrl+O open, Ctrl+S save, Ctrl+Shift+S save-as. Saving always
goes through the engine's canonical serializer (`save_circuit`), never local
JSON.

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

1. Set `GITHUB_REPO` in `frontend/src/update.ts` (owner/repo — the update
   nudge silently skips until then).
2. Push a tag: `git tag v0.2.0 && git push origin v0.2.0`.
3. `.github/workflows/release.yml` builds the desktop bundles on
   macOS/Windows/Linux and publishes a GitHub Release with the unsigned-build
   workaround text (macOS: right-click → Open; Windows: SmartScreen → "More
   info" → "Run anyway" — decision D14: we ship unsigned).
4. Older installs nudge users to upgrade on startup (never forced).

## CI

| Workflow | Trigger | What it does |
|---|---|---|
| `.github/workflows/backend.yml` | backend paths | fmt, clippy `-D warnings`, tests, musl build, Gradescope image build |
| `.github/workflows/frontend.yml` | frontend paths | lint, unit, e2e, unsigned Tauri bundles (3 OS matrix) |
| `.github/workflows/release.yml` | tags `v*` | release artifacts + release notes |

## Conventions for contributors

- **Contracts are pinned.** `docs/ipc.md` + `crates/core/src/api.rs` +
  `frontend/src/ipc/types.ts` are one contract in three spellings; change all
  three together and note it in DESIGN.md. The `.csx` schema lives in
  `docs/format-v2.md`; bump `version` for breaking changes and ship a migration.
- **Ownership boundaries** (from the parallel build): backend owns
  `crates/core`, `crates/cli`, `tests`; frontend owns `frontend/`, `crates/app`;
  `DESIGN.md`/`docs/tasks/` are maintainer-owned. See `docs/tasks/README.md`.
- Gates before committing: `cargo fmt --all && cargo clippy --workspace
  --all-targets -- -D warnings && cargo test --workspace` and, if you touched
  `frontend/`, `npm run lint && npm run test && npm run build` (+ `test:e2e`).
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
