# Releasing CircuitSim++

> **How we ship desktop builds without CI.** `github.gatech.edu` is GitHub
> Enterprise Server and this org has **no Actions runners**, so nothing builds
> on push. Tauri desktop bundles are also **per-OS** — a macOS `.dmg` needs
> Xcode, the Windows installer needs NSIS, the Linux packages need webkit2gtk —
> so no single machine can build all three. We have one machine per OS; this is
> the protocol that turns that into a release.

Related: [`DESIGN.md`](../DESIGN.md) §9 (rolling releases), decision **D14**
(we ship unsigned). The commit gate is `node scripts/build.mjs check`.

---

## TL;DR

```bash
# captain (any OS), after bumping the version and pushing master:
node scripts/release.mjs --tag v0.2.0 --draft

# the other two, once the tag exists:
git fetch --tags && git checkout v0.2.0
node scripts/release.mjs --tag v0.2.0 --attach-only

# captain, when all three platforms are in:
node scripts/release.mjs --tag v0.2.0 --status
node scripts/release.mjs --tag v0.2.0 --publish
```

The release is created as a **draft**. A draft is invisible to students *and* to
the in-app update nudge (which reads `/releases/latest`), so it only goes live
once every platform's asset is attached.

---

## Why there is no CI (Georgia Tech specifics)

`github.gatech.edu` is a **self-hosted GitHub Enterprise Server (GHES)** —
OIT runs the backend and funds the license; the College of Computing's
Technology Services Organization (TSO) does front-end support. It is *not*
github.com, which changes three things:

- **No hosted runners.** GHES provides no GitHub-hosted runners, and this org
  has registered no self-hosted ones — every `runs-on:` would queue for 24h and
  then fail. Self-hosted runners *are* possible (and **free on GHES** — the
  March-2026 per-minute runner fee explicitly does not apply to GHES), but they
  need Actions enabled, repo/org admin, and an enterprise action allowlist,
  i.e. a request to TSO. We did not take that route.
- **No cross-OS build anyway.** Even with runners, one job can't build macOS +
  Windows + Linux; a Tauri build targets the OS it runs on. That is why one
  machine per OS is the natural shape.
- **No public repositories.** GT policy routes public code to github.com, so
  everything here is private. This is why the in-app update nudge — which polls
  `/releases/latest` unauthenticated — silently no-ops: a private repo 404s the
  API. Harmless, not a bug.

The `.github/workflows/` files were therefore removed and replaced by
`scripts/release.mjs`, run by hand on each OS.

Support: TSO Help Desk `help@cc` (service front-end); OIT Technology Support
Center `support@oit.gatech.edu`, 404-894-7173 (backend).

---

## Who does what

One person is the **release captain** for a given release (rotate freely — the
OS doesn't matter). The other two are the remaining OS owners.

| Role | Owns |
|---|---|
| Captain | the version bump, the tag, the draft release, and the final publish |
| Mac owner | the macOS `.dmg` |
| Windows owner | the Windows NSIS `.exe` |
| Linux owner | the `.deb` / `.rpm` / AppImage (and the optional `csim` CLI) |

The **tag is the handoff point**: the captain pushes it, everyone else builds
from it, and nothing is published until it is complete.

---

## One-time setup (each person)

Common: **Node ≥ 22**, **Rust (stable)**, and the **`gh` CLI**.

```bash
gh auth login --hostname github.gatech.edu   # authenticate to the GHES host
npm --prefix frontend ci                     # frontend deps (Vite/Tauri CLI)
```

Per OS build prerequisites (Tauri's own list):

- **macOS:** `xcode-select --install`
- **Linux (Arch):**
  `sudo pacman -S webkit2gtk-4.1 base-devel curl wget file openssl appmenu-gtk-module libappindicator-gtk3 librsvg`
- **Linux (Debian/Ubuntu):**
  `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`
- **Windows:** the *Desktop development with C++* MSVC build tools, plus
  WebView2 (already present on Win10 1803+). NSIS is fetched by Tauri
  automatically.

> **Windows only:** the fixture gate shells out to `python3`, which usually
> doesn't exist there. Either run with `$env:PYTHON = "python"` set, or use
> `--no-check` on Windows and let the gate pass on another OS.

---

## Bump the version (captain, once)

Set `version` to the same new value in **both** files and commit:

- `crates/app/tauri.conf.json` — the version baked into the bundle.
- `frontend/package.json` — `APP_VERSION`, the number the in-app update nudge
  compares against.

They must equal the tag (minus its leading `v`). `release.mjs` **refuses to run
on a mismatch**, so a forgotten bump fails loudly instead of shipping a bundle
that nags everyone forever.

```
<tag v0.2.0>  ==  tauri.conf.json "0.2.0"  ==  frontend/package.json "0.2.0"
```

---

## The release: draft → attach → publish

### 0. Captain — cut the draft

```bash
git checkout master && git pull
# bump version in both files, then:
git commit -am "release: v0.2.0" && git push origin master
node scripts/release.mjs --tag v0.2.0 --draft
```

This runs `build.mjs check`, builds the captain's OS bundle, pushes the annotated
tag, and opens a **draft** release with the unsigned-build notes. The pushed tag
is the signal for the others to start.

### 1. The other two — build and attach

```bash
git fetch --tags && git checkout v0.2.0
node scripts/release.mjs --tag v0.2.0 --attach-only
```

Each builds its own OS from the *tagged* commit and uploads to the draft.
`--attach-only` refuses to run if the draft isn't there yet, and re-running it
is safe (assets are uploaded with `--clobber`).

### 2. Captain — verify and publish

```bash
node scripts/release.mjs --tag v0.2.0 --status    # ✓ macOS  ✓ Windows  ✓ Linux
node scripts/release.mjs --tag v0.2.0 --publish   # draft → live, marked latest
```

`--status` lists the attached assets, marks which platforms are present, and
names the ones still missing. **Do not publish until all three are in.**

---

## Command reference

```
node scripts/release.mjs [options]
```

| Flag | Effect |
|---|---|
| `--tag <vX.Y.Z>` | Release tag. Default: `v<version from tauri.conf.json>`. |
| `--target <ref>` | Commit/branch for a brand-new tag. Default: current `HEAD`. |
| `--draft` | Create the release as a draft (recommended). |
| `--attach-only` | Never create the tag/release; build this OS and upload to the existing one. |
| `--status` | Show the release's assets and which platforms are missing. |
| `--publish` | Flip a draft release live (and mark it latest). |
| `--prerelease` | Mark a prerelease (never latest; the nudge ignores it). |
| `--notes-file <f>` | Release notes. Default: the unsigned-build workaround text. |
| `--no-check` | Skip the commit gate (`build.mjs check`) before building. |
| `--no-build` | Publish bundles already under `target/release/bundle/`. |
| `-n`, `--dry-run` | Print the plan; change nothing. |
| `-h`, `--help` | Usage. |

### What the script guarantees

- **Version consistency** — refuses to run if the tag, `tauri.conf.json`, and
  `frontend/package.json` disagree.
- **Same commit for everyone** — you build a checked-out tag, not a drifting
  `master`.
- **`--attach-only` can't invent a release** — it errors if the draft is absent.
- **Idempotent** — if two people race, the loser falls back to `release upload`
  instead of failing.
- **Draft → publish is explicit** — the release, and the `/releases/latest`
  nudge, stay dark until you say so.

---

## Drafts and the update nudge

The app polls `https://github.gatech.edu/api/v3/repos/<repo>/releases/latest`
(see `frontend/src/update.ts`) on startup and shows a dismissible "please
upgrade" dialog if it is behind. Two consequences:

- **Drafts and prereleases are excluded** from `releases/latest`, so a
  half-assembled or experimental release never nags anyone.
- **The repo must be readable without auth** for students' apps to see it. If
  `CS2200TAs/CircuitSimPlusPlus` is private, that endpoint 404s and the nudge
  silently skips. Likewise it skips if `github.gatech.edu` isn't reachable
  (e.g. off-campus without VPN). Both are silent by design, not bugs.

---

## When something goes wrong

| Symptom | Fix |
|---|---|
| Build failed before the tag was pushed | Nothing to undo; fix and re-run. The tag was never created. |
| Need to replace an asset | Re-run `--attach-only` from that OS (it `--clobber`s). |
| Forgot a platform | `--status` names it; that teammate re-runs `--attach-only`. |
| Wrong tag or wrong commit | Prefer a new patch version. To scrap it: `gh release delete vX.Y.Z --cleanup-tag` (deletes the release **and** the tag), then redo. |
| Draft is stuck / stale | Delete it with `gh release delete vX.Y.Z` (keep the tag with no `--cleanup-tag`) and re-run. |
| `gh` not authenticated | `gh auth login --hostname github.gatech.edu`. |

> **Never move a published tag.** Force-updating a tag that students already
> downloaded from makes "latest" lie. Cut a new patch release instead.

---

## Doing it by hand (if the script is unavailable)

```bash
node scripts/build.mjs check          # the commit gate
node scripts/build.mjs desktop        # bundles -> target/release/bundle/

git tag -a v0.2.0 -m "CircuitSim++ v0.2.0" && git push origin v0.2.0

gh release create v0.2.0 \
  target/release/bundle/dmg/*.dmg \   # macOS
  --repo github.gatech.edu/CS2200TAs/CircuitSimPlusPlus \
  --title v0.2.0 --draft --notes "…unsigned-build workaround…"

gh release upload v0.2.0 <other-os-assets> --repo … --clobber   # other OSes
gh release edit   v0.2.0 --repo … --draft=false --latest        # publish
```

Note the bundle path is `target/release/bundle/…` at the **repo root** — Cargo
hoists the target directory to the workspace root, so there is no
`crates/app/target/`.
