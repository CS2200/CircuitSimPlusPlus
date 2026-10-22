# Distribution & Updates — plan

> **Status: decided, not yet built (2026-10-21).** Today releases are still cut
> privately on three machines — see [`releasing.md`](releasing.md) for the
> process that actually runs. This doc records the plan so all three of us agree
> before anyone sets it up. Nothing here is wired up yet.

## The problem, in one paragraph

GT runs its own **private, on-prem GitHub Enterprise Server** at
`github.gatech.edu` (public IP `143.215.77.100`) with **no Actions runners**,
and GT **does not allow public repositories** on it. The app's update check is
an *unauthenticated* HTTPS GET from a native process — it has no browser SSO
session — so anything behind LDAP (including a GT-hosted website) can't serve
it, and a private GHES repo returns `404`. Meanwhile, Tauri desktop bundles are
per-OS, so one machine can't build all three.

## Options considered

| | Source / builds | Public host | CI | Nudge works off-campus |
|---|---|---|---|---|
| A | GHES + 3 local machines | none | none | ❌ |
| B | GHES + 3 local machines | Azure Blob | none | ✅ |
| **C** | **public github.com mirror** | **github.com Releases** | **free hosted 3-OS** | ✅ |
| D | public mirror | Azure Blob | Azure Pipelines | ✅ |

Notes that drove the choice:

- **Azure is hosting, not CI.** Microsoft-hosted Azure agents cannot reach a
  firewalled GHES, so Azure Pipelines would still need a public mirror to build
  from — no better than C, with more moving parts. Azure Blob/Static Web Apps
  *are* a fine public host (free to enable, student credit covers it), which is
  what option B uses.
- **Self-hosted runners on GHES are possible and free** (the 2026 per-minute
  runner fee explicitly excludes GHES), but need Actions enabled, org/repo
  admin, and an enterprise action allowlist — i.e. a request to CoC TSO. Parked.

## Decision: option C

- **GHES stays canonical.** We keep developing on `github.gatech.edu`; a
  **public mirror on github.com** is pushed for builds and distribution.
- **CI runs on github.com.** Free hosted macOS + Windows + Linux runners build
  the bundles on a tag and publish a **GitHub Release** there. No self-hosted
  runners, no keys, no three-machine choreography.
- **The update nudge polls `api.github.com`** (public, unauthenticated, works
  from anywhere).
- **Installers are copied back to GHES manually**, from a maintainer's machine
  (not from CI), so no GHES write-token ever lives in a public repo.

## How it will work

```
   develop / PRs                 git push (mirror)               tag v0.2.0
┌───────────────────┐        ┌───────────────────────┐      ┌────────────────────────┐
│  github.gatech.edu │  ───▶ │  github.com (PUBLIC)   │ ───▶ │ GitHub-hosted runners   │
│  private canonical │        │  source mirror         │      │ macos + windows + linux │
└───────────────────┘        └───────────────────────┘      └───────────┬────────────┘
         ▲                                                              │ one release job
         │  optional manual backport (gh)                               ▼
         └───────────────────────────────────────────  GitHub Release (public, free)
                                                                       │
                             app nudge → api.github.com (no auth) ──────┘
```

## Setup walkthrough (with rationale)

Placeholders: `OWNER` = the github.com account/org you create the public repo
under; `CSIM` = `OWNER/CircuitSimPlusPlus`.

### 0. Why any of this works

Three independent facts line up:

1. **GitHub.com public repos get free hosted macOS + Windows + Linux runners.**
   That is the whole reason we can't do CI on GHES but can on github.com — the
   *hosting*, not the git server, is what we're borrowing.
2. **A public repo's `releases/latest` is readable with no auth.** So the app's
   update check (a native, session-less HTTPS GET) can finally get a `200`.
3. **GT's GHES is internet-reachable** (public IP `143.215.77.100`), so our
   laptops — and the release job — can still talk to it for the optional copy
   back.

Nothing about *the app* changes. It still runs on students' machines, unsigned,
and still talks to a GitHub API. We're just moving the build/release/update
signal from a private GHES to a public github.com copy.

### 1. Create the public github.com repo

Create an **empty** repo (`OWNER/CircuitSimPlusPlus`) — no README, no .gitignore,
no license. Set it **public**.

**Why:** *public* is the switch that turns on both free hosted runners and
anonymous `releases/latest`. An empty repo keeps the first push conflict-free.

### 2. Add the mirror remote and push the code

```bash
git remote add public git@github.com:OWNER/CircuitSimPlusPlus.git
git push public master
git push public --tags        # only if you already have old tags to mirror
```

**Why:** GitHub Actions builds the code that's *in the github.com repo*. The
mirror must contain the source at the exact commit you tag. GHES stays
canonical; `public` is a push target, not a fork.

### 3. Restore the CI workflows (and fix the old bug)

Recover them from history, then apply the known correction:

```bash
git show 9638eb3^:.github/workflows/backend.yml  > .github/workflows/backend.yml
git show 9638eb3^:.github/workflows/frontend.yml > .github/workflows/frontend.yml
git show 9638eb3^:.github/workflows/release.yml  > .github/workflows/release.yml
```

Then **fix the bundle paths** in `frontend.yml` and `release.yml`:
`crates/app/target/release/bundle/...` → **`target/release/bundle/...`**.

**Why the restore works:** the runners exist here, so `runs-on: ubuntu-latest`
etc. finally mean something. `actions/upload-artifact@v4` is *also* fine here —
the v3-only rule was a GHES limitation, not a github.com one.

**Why the path fix:** `CircuitSimPlusPlus` is a Cargo **workspace**, so Cargo
hoists the build output to `<repo>/target/`, and Tauri's bundles land in
`target/release/bundle/{dmg,nsis,deb,...}`. The committed workflows (a)
pointed at the non-existent `crates/app/target/...`, (b) reused `body:` with
`generate_release_notes`, and (c) had two matrix jobs racing to create the same
release. Use the single-publisher version: each OS job uploads an artifact, then
one `release` job with `permissions: contents: write` downloads them and
publishes once.

> Tip: `release.yml` should keep `on: push: tags: ["v*"]` and drop the `prod`
> branch trigger (that was for the GHES world). The `GITHUB_TOKEN` is automatic;
> **no secrets are needed**.

### 4. Point the update nudge at github.com

In `frontend/src/update.ts`:

```ts
export const RELEASES_HOST = "github.com";
export const RELEASES_API = "https://api.github.com";
export const GITHUB_REPO = "OWNER/CircuitSimPlusPlus";
```

**Why:** the previous values pointed at `github.gatech.edu/api/v3`, which 404s
because a private repo rejects anonymous reads. Public github.com returns `200`,
from any network, with no login. (The `?updateRepo=` override fix stays.)

### 5. Bump the version and push a tag

```bash
# set the SAME version in BOTH:
#   crates/app/tauri.conf.json   (the bundle version)
#   frontend/package.json        (APP_VERSION the nudge compares against)
git commit -am "release: v0.2.0"
git push public master
git tag v0.2.0 && git push public v0.2.0
```

**Why:** `release.yml` triggers on `v*` **tags**. The tag, `tauri.conf.json`,
and `frontend/package.json` must all agree on `0.2.0`, or the bundle version and
the version the nudge compares will disagree. Push the tag to **`public`** —
that's the repo whose Actions run.

### 6. Watch it build, verify the release

Actions tab → the matrix runs on ubuntu/windows/macos → the single release job
publishes. Confirm the release has:

- macOS `.dmg`
- Windows NSIS `.exe` (+ the zip)
- Linux `.deb` / `.rpm` / `.AppImage`

**Why it succeeds now:** all three OSes are real hosted machines, each building
natively (Xcode on macOS, NSIS on Windows, webkit2gtk on Linux) — exactly what
"per-OS, can't cross-compile" demands. Bundles come from `target/release/bundle`.

### 7. Confirm the nudge path

Unauthenticated check (should be `200`, JSON `tag_name` = `v0.2.0`):

```bash
curl -s https://api.github.com/repos/OWNER/CircuitSimPlusPlus/releases/latest \
  | grep tag_name
```

**Why:** public + unauthenticated + `/latest` skips drafts/prereleases. That's
precisely `checkForUpdate()`.

### 8. Optional: copy the installers back to GHES

```bash
gh auth login --hostname github.gatech.edu      # once
gh release download v0.2.0 --repo OWNER/CircuitSimPlusPlus --dir dist
gh release create v0.2.0 dist/* \
  --repo github.gatech.edu/CS2200TAs/CircuitSimPlusPlus \
  --title v0.2.0 --notes-file /tmp/unsigned-notes.md
# or, if the GHES release exists:
gh release upload v0.2.0 dist/* --repo github.gatech.edu/CS2200TAs/CircuitSimPlusPlus --clobber
```

**Why:** GHES is on a public IP, so `gh` reaches it from your laptop and from
CI. Doing it by hand keeps a GHES write-token out of the public repo.

### 9. Update the docs

Mark `distribution.md` as built; simplify `releasing.md` to the new flow; and
revisit `DESIGN.md §9` (human-owned) — it still says "never auto-installs".

### Rollback

Delete the github.com repo (or flip it private). Nothing on GHES changes, and
the app falls back to a silent no-op if `api.github.com` can't be read.


## The update nudge

**Today:** `checkForUpdate()` fetches
`https://github.gatech.edu/api/v3/repos/CS2200TAs/CircuitSimPlusPlus/releases/latest`
unauthenticated. The repo is private → `404` → **silent no-op**. The version,
dismissal-per-version, and the "check for updates" preference all work; only the
fetch fails.

**Under C:** the same code, pointed at `api.github.com` against the public
mirror. It returns `200` from anywhere, drafts and prereleases are excluded, and
the "Download" link opens the public release (no GHES login). That is exactly
what `DESIGN.md §9` describes.

**Possible later upgrade (not now):** Tauri's `updater` plugin gives a
*consent-based* install — "Update to X?" → **Install** / **Later**, never forced
and never silent. It needs a minisign keypair, `createUpdaterArtifacts`, a
`latest.json` manifest on the public host, and it revises §9's "never
auto-installs". Its weak spot is **macOS on unsigned builds**, where the updater
is flaky. Revisit only if the nudge link isn't enough.

## Optional: backport installers to GHES

Keeps a GT-hosted copy without putting a token in the public repo. After a
github.com release is live:

```bash
# 1) pull the built assets from the public release
gh release download v0.2.0 --repo <owner>/CircuitSimPlusPlus --dir dist

# 2) publish them on GHES (create, or upload if it already exists)
gh release create v0.2.0 dist/* \
  --repo github.gatech.edu/CS2200TAs/CircuitSimPlusPlus \
  --title v0.2.0 --notes-file /tmp/unsigned-notes.md
# ...or, if the GHES release already exists:
gh release upload v0.2.0 dist/* \
  --repo github.gatech.edu/CS2200TAs/CircuitSimPlusPlus --clobber
```

To be folded into `scripts/release.mjs` as `--mirror-to-ghes`. This works because
GHES is internet-reachable; it's a convenience copy, not the primary download.

## Open questions

- Who owns the public github.com repo, and under which account/org.
- Whether publishing the source publicly is actually fine with CoC (no FERPA in
  the repo, but it is course code).
- Whether to keep chasing self-hosted runners on GHES (a TSO ticket) — C makes
  it unnecessary.
- `DESIGN.md §9` is human-owned and still says "never auto-installs"; it needs a
  one-line revisit if we ever add the Tauri updater.
