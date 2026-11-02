# Keeping dependencies current

The mirror repo has **Issues and Pull Requests disabled**, so there is **no
Dependabot/Renovate** — updates are done by hand, on GHES (canonical), like
everything else. This is the short guide, including the couplings that bite.

Run the local gate after any bump: `node scripts/build.mjs check` (+ the e2e
suite; see below).

## What is pinned where

| Thing | Pinned in |
|---|---|
| Node | `frontend/package.json` `engines` + `.nvmrc` + the CI `setup-node` |
| Rust | `rust-toolchain.toml` |
| CI runner OSes | `.github/workflows/*.yml` (`ubuntu-24.04`; windows/macos `-latest`) |
| The e2e browser | the Playwright **container image tag** in `frontend.yml` |

## GitHub Actions

Bump the **major tag** (`actions/checkout@v7`, …). Current floor:

```bash
grep -rhoE 'uses: [^ ]+' .github/workflows | sort -u
```
Compare against `gh api repos/<owner>/<repo>/releases/latest --jq .tag_name`.
Because `.github/workflows/**` is in every workflow's path filter, a
workflow-only change is validated by CI on push.

> Note: `upload-artifact@v4+` / `download-artifact@v4+` are **not** supported on
> GHES. We only run on github.com, so this is fine — but if CI ever moves to
> GHES, they must drop to `v3`.

## npm (frontend)

```bash
npm --prefix frontend outdated              # what's behind
npm --prefix frontend install <pkg>@latest  # bump one (rewrites package.json)
npm --prefix frontend update <pkg>          # in-range only
npm --prefix frontend audit                 # should stay at 0
```

Couplings and current holds:

- **`@playwright/test` ↔ the Playwright image ↔ the e2e baselines.** Bumping the
  package requires bumping the image tag in `frontend.yml` **and** regenerating
  the committed baselines *inside that image* (see `releasing.md`), otherwise CI
  e2e renders differently and fails. Do all three in one commit.
- **TypeScript is capped by the linter.** `typescript-eslint` (latest *and*
  canary) peer-requires `typescript <6.1.0`, so we hold at **6.0.x** even though
  TS 7 is out. Revisit when `typescript-eslint` supports it.
- **`@types/node` tracks the Node runtime**, not "latest". We run Node 24, so the
  types are `^24`. Bumping the types to 26 while running 24 would let code use
  APIs that do not exist at runtime.
- **`react-hooks` v7 bundles the React Compiler ruleset** (refs, purity,
  set-state-in-effect, …). `eslint.config.js` enforces it at its recommended
  level; the code satisfies it. The one exception is a scoped
  `eslint-disable` on the Inspector panel's memory-image `useMemo` (the compiler
  can't preserve that memo; the memo is a real perf guard). New violations are
  lint errors — if one is a genuine false positive, suppress it *at the line*
  with a reason, not by weakening the config.
- **`minimatch` is force-pinned to `^11`** via `overrides` because eslint 10 /
  typescript-eslint 8 still resolve the vulnerable 10.x. Drop the override once
  they ship a fix.
- React 19 removed the **global `JSX` namespace**: import it (`type JSX` from
  `react`) instead of using `JSX.Element` bare.

## Cargo (workspace)

```bash
cargo update                 # within semver ranges (safe)
cargo build && cargo test    # or the gate
```
Major bumps live in `Cargo.toml` `[workspace.dependencies]` (`thiserror` is
already 2). `tauri` stays on the 2 line. Bump the workspace `version` in step
with `tauri.conf.json` + `frontend/package.json` when cutting a release.

## Verify

`node scripts/build.mjs check` covers lint + unit + build. It does **not** run
e2e; run it too when frontend behavior could change:

```bash
docker run --rm --ipc=host -v "$PWD:/work" -w /work/frontend \
  mcr.microsoft.com/playwright:v1.64.1-noble bash -lc 'npm ci && npx playwright test'
```
