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

## Setup checklist (when we get to it)

- [ ] Create the **public github.com repo** (owner/name TBD — e.g.
      `<owner>/CircuitSimPlusPlus`).
- [ ] Add it as a second remote and push the mirror
      (`git remote add public git@github.com:<owner>/CircuitSimPlusPlus.git`).
- [ ] **Restore the CI workflows** — `backend.yml`, `frontend.yml`,
      `release.yml` (recover the versions from git history before commit
      `9638eb3`). On github.com, `actions/upload-artifact@v4` **does** work
      (the v3 requirement was GHES-only).
- [ ] **Revert the update nudge to github.com**: in `frontend/src/update.ts`
      set `RELEASES_HOST = "github.com"`, `RELEASES_API = "https://api.github.com"`,
      and `GITHUB_REPO = "<owner>/CircuitSimPlusPlus"`. (The `?updateRepo=`
      override fix stays.)
- [ ] Add `--mirror-to-ghes` to `scripts/release.mjs`.
- [ ] Update `releasing.md` to describe the new flow.

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
