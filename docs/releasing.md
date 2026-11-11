# Releasing CircuitSim++

> **CI builds and publishes releases on a public github.com mirror.** GT's GHES
> stays the private source of truth. Pushing a `v*` tag builds macOS + Windows +
> Linux on free hosted runners and opens **one public GitHub Release**, which is
> what the in-app update nudge reads.

Related: [`DESIGN.md`](../DESIGN.md) §9 (rolling releases), decision **D14**
(we ship a self-signed certificate, not a paid Apple Developer ID). Local commit gate:
`node scripts/build.mjs check`.

---

## TL;DR

```bash
# one time:
git remote add public git@github.com:CS2200/CircuitSimPlusPlus.git

# 1. bump the version in BOTH files (they must equal the tag), commit, push:
git commit -am "release: v0.2.0" && git push origin master && git push public master

# 2. tag, and push the tag to the MIRROR (that is where CI runs):
git tag v0.2.0 && git push public v0.2.0

# 3. watch it build; the release appears here:
#    https://github.com/CS2200/CircuitSimPlusPlus/releases
```

No self-hosted runners, no paid signing keys, no three-machine choreography.

---

## Two repos, one source of truth

| remote | repository | role |
|---|---|---|
| `origin` | `github.gatech.edu/CS2200TAs/CircuitSimPlusPlus` | **private, canonical.** Never builds. |
| `public` | `github.com/CS2200/CircuitSimPlusPlus` | **public mirror.** CI, releases, update nudge. |

You develop and merge on GHES, then push the mirror. The mirror is public because
of two hard constraints on GHES (see [Georgia Tech specifics](#georgia-tech-specifics)).

---

## What CI does

All jobs carry `if: github.server_url == 'https://github.com'`, so pushes to GHES
are **skipped** instead of queueing forever on a runner-less server.

| workflow | triggers on | does |
|---|---|---|
| `backend.yml` | backend paths | fixture drift, `fmt`, `clippy -D warnings`, tests, static-musl `csim`, Gradescope image build |
| `frontend.yml` | frontend paths | lint + unit tests, then a **3-OS build matrix** (ubuntu/windows/macos), plus **e2e in a pinned Playwright image** |
| `release.yml` | `v*` tag (or manual) | 3-OS bundles → **one** public GitHub Release |

`release.yml` is the only one that ships anything, and it only runs on a tag.

**Environment (pinned for reproducibility):** GitHub-hosted runners, Linux pinned
to `ubuntu-24.04` (ubuntu-latest is migrating to 26), **Node 24**, Rust from
`rust-toolchain.toml`. macOS ships a **universal** `.dmg` (Apple Silicon +
Intel). Every job has a timeout; CI runs cancel on a newer push, releases never
do. Two secrets are needed for the macOS self-signed certificate
(`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`); `GITHUB_TOKEN` is automatic.

---

## Versioning — the one thing that must match

Set the **same** version in both files, and make it equal the tag:

```
tag v0.2.0  ==  crates/app/tauri.conf.json "0.2.0"  ==  frontend/package.json "0.2.0"
```

- `crates/app/tauri.conf.json` — the version baked into the bundle.
- `frontend/package.json` — `APP_VERSION`, what the update nudge compares against.

Get this wrong and every installed app nags forever (it thinks it is always
behind). Check before tagging:

```bash
node scripts/release.mjs --tag v0.2.0 --dry-run --no-build   # refuses on a mismatch
```

---

## Cutting a release

```bash
# 1. bump the version in both files, commit, push BOTH remotes
git commit -am "release: v0.2.0"
git push origin master
git push public master

# 2. tag and push the tag to the mirror
git tag v0.2.0
git push public v0.2.0
```

3. Watch it: `gh run watch --repo CS2200/CircuitSimPlusPlus` (the `release`
   workflow, ~10 min cold).
4. Verify the release:

```bash
gh release view v0.2.0 --repo CS2200/CircuitSimPlusPlus
```
Expect a macOS **universal** `.dmg` (Apple Silicon + Intel), a Windows NSIS `.exe`
(+ portable zip), Linux `.deb` / `.rpm` / `.AppImage`, and the static `csim`
autograder CLI.

5. Verify the update channel (exactly what the app calls):

```bash
curl -s https://api.github.com/repos/CS2200/CircuitSimPlusPlus/releases/latest | grep tag_name
```

---

## The update nudge

`frontend/src/update.ts` polls, unauthenticated:
`https://api.github.com/repos/CS2200/CircuitSimPlusPlus/releases/latest`

- Semver-compares `tag_name` against the app's baked-in version; if behind, shows
  a dismissible "please upgrade" dialog linking to the release. Never forced,
  never auto-installs (§9).
- **Drafts and prereleases are excluded** from `/releases/latest`, so they never
  nag anyone. `release.yml` publishes non-draft, so a finished tag is live
  immediately.
- Any error (offline, 404, offline network) is a **silent skip** — the app keeps
  working.

---

## E2E screenshot baselines

The canvas snapshot tests are pixel-exact only for a known font + browser, so
`frontend.yml` runs e2e inside the **pinned Playwright image**
(`mcr.microsoft.com/playwright:v1.64.1-noble`) rather than on the bare runner.
The committed `*-chromium-linux.png` baselines were generated inside that image.

After a UI change that legitimately moves pixels, regenerate them in the same
image and commit:

```bash
docker run --rm --ipc=host -v "$PWD:/work" -w /work/frontend \
  mcr.microsoft.com/playwright:v1.64.1-noble \
  bash -lc 'npm ci && npx playwright test --update-snapshots'
```

Bump the image tag whenever `@playwright/test` is bumped, then regenerate.

---

## When something goes wrong

| Symptom | Fix |
|---|---|
| `release` never ran | The tag must be pushed to **`public`** (the mirror), and must match `v*`. |
| Students nagged to upgrade forever | Version ≠ tag. Bump `frontend/package.json` **and** `tauri.conf.json`, cut a new patch. |
| `frontend` e2e red after a UI change | Regenerate baselines in the pinned image (above). |
| Wrong tag / bad release | New patch version. To scrap: `gh release delete vX.Y.Z --cleanup-tag --repo CS2200/CircuitSimPlusPlus` (removes release **and** tag), then redo. |
| A GHES-side job is "skipped" | That is the guard — CI only runs on github.com. |

> **Never move a published tag.** Force-updating a tag students already
> downloaded makes `/releases/latest` lie. Cut a new patch release.

---

## Optional: copy the installers to GHES

A convenience archive — students download from github.com. Do it from a laptop
(keeps a GHES write-token out of the public repo):

```bash
gh auth login --hostname github.gatech.edu      # once
gh release download v0.2.0 --repo CS2200/CircuitSimPlusPlus --dir dist
gh release create v0.2.0 dist/* \
  --repo github.gatech.edu/CS2200TAs/CircuitSimPlusPlus \
  --title v0.2.0 --notes "See the mirror release for the self-signed-build notes."
```

---

## Local fallback: `scripts/release.mjs`

If the mirror (or github.com) is unavailable, you can still cut a release by hand
from the three OS machines — same result, entirely local:

```bash
node scripts/release.mjs --tag v0.2.0 --draft       # any OS: create the draft
node scripts/release.mjs --tag v0.2.0 --attach-only # other OSes: attach their bundle
node scripts/release.mjs --tag v0.2.0 --status      # ✓ macOS ✓ Windows ✓ Linux
node scripts/release.mjs --tag v0.2.0 --publish     # draft -> live
```

Flags: `--tag`, `--target <ref>`, `--draft`, `--attach-only`, `--status`,
`--publish`, `--prerelease`, `--notes-file`, `--no-check`, `--no-build`,
`--dry-run`, `--help`. It enforces the version match and is idempotent.

Note the bundle path is `target/release/bundle/…` at the **repo root** — Cargo
hoists the target dir to the workspace root, so there is no `crates/app/target/`.

---

## Bus factor

The mirror lives in the **`CS2200` GitHub organization**, not a personal account,
so it survives any one person. Keep **at least two org owners** — Org → People →
invite → set role **Owner**. Because the app's update source is *compiled in*,
moving the mirror later means old installs go stale; do infra moves before a
release, not after.

---

## Georgia Tech specifics

`github.gatech.edu` is a self-hosted **GitHub Enterprise Server** (OIT runs the
backend and funds the license; the College of Computing's TSO does front-end
support). It differs from github.com in ways that force the mirror split:

- **No hosted runners**, and none registered — every `runs-on:` would queue for
  24h then fail. (Self-hosted runners *are* possible and free on GHES, but need
  Actions enabled, org/repo admin, and an enterprise action allowlist — a TSO
  request. Not taken.)
- **No public repositories** — GT policy routes public code to github.com. A
  private repo makes `/releases/latest` return 404, so the nudge can never work
  from GHES.
- **Per-OS bundles anyway** — even with runners, one job cannot build macOS +
  Windows + Linux. Hosted runners give us one machine per OS for free.

Support: TSO Help Desk `help@cc` (service front-end); OIT Technology Support
Center `support@oit.gatech.edu`, 404-894-7173 (backend).
