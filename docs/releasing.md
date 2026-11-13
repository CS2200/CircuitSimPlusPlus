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

# 1. bump the version in ALL THREE files and add the CHANGELOG.md section for
#    it (all must equal the tag), then commit and push:
git commit -am "release: v0.4.1" && git push origin master && git push public master

# 2. tag, and push the tag to the MIRROR (that is where CI runs):
git tag v0.4.1 && git push public v0.4.1

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

## Signing the macOS build (the TCC fix)

macOS's "Files and Folders" permission store (TCC) keys a folder grant to the
app's **code-signing identity**. An unsigned or ad-hoc build has no stable
identity, so every rebuild looks like a new app and TCC asks for permission
again on every save. We sign with a **stable self-signed certificate** so the
grant survives rebuilds. This is not a paid Apple Developer ID and the app is
**not notarized** — the "unidentified developer" workaround still applies.

### One-time setup

1. Generate the certificate (any OS; `openssl` is the only requirement):

   ```bash
   ./scripts/macos-signing.sh
   ```

   It writes `./macos-signing/` (`certificate.p12`, `certificate.pem`,
   `key.pem`, `certificate.p12.b64`, `password.txt`) and prints the password
   plus the base64 of the `.p12`. That directory is gitignored — never commit it.

   **Keep a backup of the `.p12` and its password** in a password manager or
   another encrypted vault. GitHub Actions secrets are **write-only**: the
   workflow can read them, but you cannot read them back. If you lose the
   backup, the only way to sign again is to regenerate a certificate, which
   changes the app's identity and costs one TCC re-prompt.

2. Set the two secrets on the **public mirror** (the repo whose CI runs):

   ```bash
   gh secret set APPLE_CERTIFICATE          --repo CS2200/CircuitSimPlusPlus < macos-signing/certificate.p12.b64
   gh secret set APPLE_CERTIFICATE_PASSWORD --repo CS2200/CircuitSimPlusPlus < macos-signing/password.txt
   ```

   `APPLE_CERTIFICATE` is the base64 of the `.p12`; `APPLE_CERTIFICATE_PASSWORD`
   is the password the script printed. The script writes both to stdout/stderr
   when you run it; capture them to files if you want to avoid the terminal.

3. Keep the local `macos-signing/` directory as a backup (password manager or
   encrypted vault), or delete it if you already have a copy there. The secret
   is the only copy the workflow can read; the local copy is the only copy you
   can recover.

### What a release does

`release.yml` runs the macOS job only on a `v*` tag. It imports the `.p12` into
a temporary keychain, sets `APPLE_SIGNING_IDENTITY: "CircuitSim++ Self-Signed"`,
and runs `tauri build --target universal-apple-darwin`. Tauri's bundler calls
`codesign` with that identity, so the `.app` is signed and TCC's grant is tied
to the certificate.

If `APPLE_CERTIFICATE` is not set, the import step prints a warning and skips;
the macOS build is still produced, but unsigned. TCC will re-prompt.

### Verify

On a Mac:

```bash
codesign -dv --verbose=4 "CircuitSim++.app"
# expect: Authority=CircuitSim++ Self-Signed
```

`node scripts/check-signing.mjs` (part of `node scripts/build.mjs check`) is a
config gate: it checks the certificate import, the signing identity, the
folder-usage descriptions, and the generator script. It does not run a real
`codesign`.

### If you rotate or lose the secret

- **Rotate:** regenerate the certificate, update both secrets. The next release
  is signed with the new identity; TCC will re-prompt once for the new app.
- **Lose it:** restore the backup `.p12` and password, or regenerate. The app
  is not broken; the only cost is the one-time re-prompt.
- **Keep the identity stable.** Changing the certificate means TCC sees a new
  app, so the folder grant is lost.

### Not covered

- **Notarization.** Signed but not notarized; Gatekeeper still warns
  "unidentified developer". The "right-click → Open" workaround remains.
- **Dev builds.** `tauri dev` and `node scripts/build.mjs desktop` are not
  signed. TCC will prompt there.
- **CI builds.** `frontend.yml` builds unsigned artifacts (no secret); only
  release artifacts are signed.

---

## Versioning — the one thing that must match

Set the **same** version in all three files, and make it equal the tag:

```
tag v0.4.1  ==  Cargo.toml "0.4.1"  ==  crates/app/tauri.conf.json "0.4.1"  ==  frontend/package.json "0.4.1"
```

- `Cargo.toml` (`[workspace.package].version`) — what the shell logs at startup.
- `crates/app/tauri.conf.json` — the version baked into the bundle.
- `frontend/package.json` — `APP_VERSION`, what the update nudge compares against.

Get this wrong and every installed app nags forever (it thinks it is always
behind). A `v*` tag whose core version disagrees with `tauri.conf.json` also
fails `release.yml` before publishing. Check before tagging:

```bash
node scripts/release.mjs --tag v0.4.1 --dry-run --no-build   # refuses on a mismatch
```

---

## Release notes

The GitHub Release body is **not** generated from the git log and is **not** a
wall of signing boilerplate. It is the hand-written section for the version in
[`CHANGELOG.md`](../CHANGELOG.md), plus a short install footer:

```bash
node scripts/changelog.mjs --tag v0.4.1 --install-notes   # what the release body will be
node scripts/changelog.mjs --check                        # the version has a section?
```

- **Write the entry by hand when the work lands.** Note the user-visible change
  and why, with the commit hash for detail; don't paste commit subjects.
- `release.yml` extracts the section at tag time (`scripts/changelog.mjs`) and
  publishes it with `body_path`. `scripts/release.mjs` uses the same source.
- `node scripts/build.mjs check` includes the changelog gate, so a version bump
  with no section fails the commit gate rather than shipping an empty release.
- Override once with `--notes-file <f>` (local release) if you need to.

The install footer covers the download-per-platform and first-launch warning
(right-click → Open on macOS, SmartScreen → Run anyway on Windows). Keep it
short: the long-form install guide lives in the README.

---

## Cutting a release

```bash
# 1. bump the version in all three files + add the CHANGELOG.md section, then
#    commit and push BOTH remotes
git commit -am "release: v0.4.1"
git push origin master
git push public master

# 2. tag and push the tag to the mirror
git tag v0.4.1
git push public v0.4.1
```

3. Watch it: `gh run watch --repo CS2200/CircuitSimPlusPlus` (the `release`
   workflow, ~10 min cold).
4. Verify the release:

```bash
gh release view v0.4.1 --repo CS2200/CircuitSimPlusPlus
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
| macOS asks for folder access on every save | Either the macOS build is unsigned (secret missing) or the signing identity changed (certificate rotated). Set `APPLE_CERTIFICATE` + `APPLE_CERTIFICATE_PASSWORD` and cut a new release; a rotation costs one re-prompt (see [Signing the macOS build](#signing-the-macos-build-the-tcc-fix)). |
| Release warns "APPLE_CERTIFICATE is not set" | The secret is missing; the macOS artifact is unsigned. Set the secret and cut a new release. |
| Release fails "tag … does not match the bundled version" | Bump `tauri.conf.json` (and `Cargo.toml`, `frontend/package.json`) to match, or push the matching tag. |
| Release body is empty or has no changelog | Add a `## [X.Y.Z]` section to `CHANGELOG.md`. `node scripts/build.mjs changelog` catches it locally. |

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
node scripts/release.mjs --tag v0.4.1 --draft       # any OS: create the draft
node scripts/release.mjs --tag v0.4.1 --attach-only # other OSes: attach their bundle
node scripts/release.mjs --tag v0.4.1 --status      # ✓ macOS ✓ Windows ✓ Linux
node scripts/release.mjs --tag v0.4.1 --publish     # draft -> live
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
