#!/usr/bin/env node
// Local release driver — one machine per OS.
//
// github.gatech.edu is GitHub Enterprise Server and this org has no Actions
// runners, so CI cannot build or publish anything. Tauri desktop bundles are
// also per-OS: a macOS .dmg needs Xcode, the Windows installer needs NSIS, the
// Linux packages need webkit2gtk. No single machine can build all three, so
// the three of you split it by OS and attach to one release.
//
// The release is created as a DRAFT. A draft is invisible to students and to
// the in-app update nudge (which reads /releases/latest), so it only goes live
// once every platform's asset is attached.
//
//   1. Captain (any OS): bump the version, commit, push to master, then
//        node scripts/release.mjs --tag v0.2.0 --draft
//      builds this OS, pushes the tag, and opens a draft release.
//
//   2. The other two, once the tag exists:
//        git fetch --tags && git checkout v0.2.0
//        node scripts/release.mjs --tag v0.2.0 --attach-only
//      builds their OS and uploads it to the draft.
//
//   3. Captain finishes:
//        node scripts/release.mjs --tag v0.2.0 --status    # all 3 platforms present?
//        node scripts/release.mjs --tag v0.2.0 --publish   # draft -> live
//
// Everyone needs the `gh` CLI authenticated once:
//   gh auth login --hostname github.gatech.edu
//
// Bump `version` in BOTH crates/app/tauri.conf.json and frontend/package.json
// and commit before releasing: the first names the bundle, the second is what
// the update nudge compares against. The script refuses a mismatch.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "target", "release", "bundle");
const TAURI_CONF = path.join(ROOT, "crates", "app", "tauri.conf.json");
const FRONTEND_PKG = path.join(ROOT, "frontend", "package.json");

const UNSIGNED_NOTES = `**These builds are unsigned** (team decision — no paid signing certificate).
Your OS will warn; the builds are fine. One-time workaround:

- **macOS:** right-click the app → **Open** → Open. (Or: \`xattr -d com.apple.quarantine "CircuitSim++.app"\`)
- **Windows:** SmartScreen → **More info** → **Run anyway**.

Linux: desktop \`.deb\`/\`.AppImage\` builds are attached when built on Linux; the
autograder CLI (\`csim\`) is built separately with \`node scripts/build.mjs musl\`.`;

let DRY = false;

// --- small process helpers ---------------------------------------------------

function binName() {
  return `node ${path.relative(ROOT, fileURLToPath(import.meta.url))}`;
}

function fail(message, ...hints) {
  process.stderr.write(`\n  error: ${message}\n`);
  for (const hint of hints) process.stderr.write(`  ${hint}\n`);
  process.exit(2);
}

function capture(cmd, args, { cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8" });
  if (r.error) return { status: null, out: "", err: String(r.error.message) };
  return { status: r.status, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

function quote(arg) {
  return /[\s"]/.test(arg) ? JSON.stringify(arg) : arg;
}

/** Run, failing the script on a non-zero exit. In --dry-run mode, only prints. */
function run(cmd, args, { cwd = ROOT } = {}) {
  const line = `${cmd} ${args.map(quote).join(" ")}`;
  if (DRY) {
    process.stdout.write(`\n==> (dry run) ${line}\n`);
    return 0;
  }
  process.stdout.write(`\n==> ${line}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) fail(`could not run "${cmd}"`, String(r.error.message));
  if (r.status !== 0) fail(`"${line}" exited ${r.status}`);
  return 0;
}

/** Run, returning the exit status instead of failing (for idempotent steps). */
function tryRun(cmd, args, { cwd = ROOT } = {}) {
  const line = `${cmd} ${args.map(quote).join(" ")}`;
  if (DRY) {
    process.stdout.write(`\n==> (dry run) ${line}\n`);
    return 0;
  }
  process.stdout.write(`\n==> ${line}\n`);
  const r = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (r.error) fail(`could not run "${cmd}"`, String(r.error.message));
  return r.status;
}

// --- repository / host -------------------------------------------------------

function remoteInfo() {
  const url = capture("git", ["remote", "get-url", "--push", "origin"]).out;
  if (!url) fail("no `origin` remote", "this script publishes through the repo it lives in");
  let m = url.match(/^[^@/]+@([^:]+):(.+?)(?:\.git)?$/); // git@host:owner/repo.git
  if (!m) m = url.match(/^https?:\/\/([^/]+)\/(.+?)(?:\.git)?$/); // https://host/owner/repo.git
  if (!m) fail(`cannot parse the origin URL: ${url}`);
  return { host: m[1], repo: m[2], flag: `${m[1]}/${m[2]}` };
}

// --- versions + bundles ------------------------------------------------------

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function bundleFiles() {
  const plan = {
    darwin: [["dmg", /\.dmg$/i]],
    win32: [["nsis", /\.exe$/i]],
    linux: [
      ["deb", /\.deb$/i],
      ["appimage", /\.AppImage$/i],
      ["rpm", /\.rpm$/i],
    ],
  }[process.platform];
  if (!plan) fail(`unsupported release platform: ${process.platform}`);

  const files = [];
  for (const [kind, re] of plan) {
    const dir = path.join(BUNDLE, kind);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (re.test(name)) files.push(path.join(dir, name));
  }
  if (files.length === 0) {
    fail(
      `no ${process.platform} bundles under ${path.relative(ROOT, BUNDLE)}/`,
      "build them first (drop --no-build), or run this on the OS you are shipping for",
    );
  }
  return files;
}

// --- preflight ---------------------------------------------------------------

function preflight(opts, repo) {
  if (capture("git", ["rev-parse", "--is-inside-work-tree"]).out !== "true") {
    fail("not inside a git working tree");
  }
  if (capture("gh", ["--version"]).status !== 0) {
    fail("the `gh` CLI is required to publish the release", `then: gh auth login --hostname ${repo.host}`);
  }
  if (capture("gh", ["auth", "status", "--hostname", repo.host]).status !== 0) {
    const hint = `run: gh auth login --hostname ${repo.host}`;
    if (DRY) process.stderr.write(`  warning: gh is not authenticated for ${repo.host} (${hint})\n`);
    else fail(`gh is not authenticated for ${repo.host}`, hint);
  }
  const building = opts.build && !opts.statusMode && !opts.publishMode;
  if (building && capture("git", ["status", "--porcelain"]).out !== "") {
    const hint = "commit or stash first; a release tag must point at committed code";
    if (DRY) process.stderr.write(`  warning: working tree is dirty (${hint})\n`);
    else fail("working tree is dirty", hint);
  }
}

// --- tag / draft / publish / status ------------------------------------------

function ensureTag(tag, target) {
  const exists = capture("git", ["rev-parse", "-q", "--verify", `refs/tags/${tag}`]).status === 0;
  if (exists) {
    process.stdout.write(`\n    tag ${tag} already exists locally — leaving it alone\n`);
  } else {
    run("git", ["tag", "-a", tag, "-m", `CircuitSim++ ${tag}`, ...(target ? [target] : [])]);
  }
  run("git", ["push", "origin", tag]); // no-op if already pushed
}

function publish(tag, repo, files, opts) {
  const view = DRY ? { status: 1 } : capture("gh", ["release", "view", tag, "--repo", repo.flag]);
  const exists = view.status === 0;

  if (opts.attachOnly && !exists && !DRY) {
    fail(
      `release ${tag} does not exist on ${repo.flag}`,
      "the captain must run `--draft` first (and push the tag), then retry",
    );
  }

  if (!opts.attachOnly && !exists) {
    // Create first; if another teammate won the race, fall back to upload.
    const created = tryRun("gh", [
      "release",
      "create",
      tag,
      ...files,
      "--repo",
      repo.flag,
      "--title",
      tag,
      "--notes-file",
      notesFile(opts),
      ...(opts.draft ? ["--draft"] : []),
      ...(opts.prerelease ? ["--prerelease"] : []),
    ]);
    if (created === 0 || DRY) return;
    process.stdout.write(`\n    release ${tag} was created by someone else — uploading instead\n`);
  } else {
    process.stdout.write(`\n    release ${tag} exists — uploading assets\n`);
  }
  run("gh", ["release", "upload", tag, ...files, "--repo", repo.flag, "--clobber"]);
}

function notesFile(opts) {
  if (opts.notesFile) return opts.notesFile;
  const tmp = path.join(tmpdir(), `circuitsimpp-release-notes-${opts.tag}.md`);
  if (!DRY) writeFileSync(tmp, UNSIGNED_NOTES + "\n");
  return tmp;
}

function status(tag, repo) {
  const view = capture("gh", ["release", "view", tag, "--repo", repo.flag, "--json", "assets,isDraft,isPrerelease"]);
  if (view.status !== 0) fail(`no release ${tag} on ${repo.flag}`, view.err);

  const data = JSON.parse(view.out);
  const isMac = (a) => /\.dmg$/i.test(a) || /\.app\.zip$/i.test(a);
  const isWin = (a) => /\.(exe|msi)$/i.test(a) || /windows.*\.zip$/i.test(a);
  const isLinux = (a) => /\.(deb|rpm|AppImage)$/i.test(a);
  const names = data.assets.map((a) => a.name);
  const have = { macOS: names.some(isMac), Windows: names.some(isWin), Linux: names.some(isLinux) };

  process.stdout.write(`\n  release ${tag} (${data.isDraft ? "DRAFT" : data.isPrerelease ? "prerelease" : "published"})\n`);
  for (const a of data.assets) process.stdout.write(`    - ${a.name}\n`);
  process.stdout.write(`\n  platforms:\n`);
  for (const [os, ok] of Object.entries(have)) {
    process.stdout.write(`    ${ok ? "✓" : "✗"} ${os}\n`);
  }
  const missing = Object.entries(have).filter(([, ok]) => !ok).map(([os]) => os);
  if (missing.length) {
    process.stdout.write(`\n  still missing: ${missing.join(", ")} — have that teammate run \`--attach-only\`\n`);
  } else {
    process.stdout.write(`\n  all platforms attached — publish with \`--publish\`\n`);
  }
}

function unpublishDraft(tag, repo, opts) {
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repo.flag,
    "--draft=false",
    ...(opts.prerelease ? ["--prerelease"] : ["--latest"]),
  ]);
  process.stdout.write(`\n  ${tag} is now live\n`);
}

// --- entry -------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    tag: null,
    target: null,
    notesFile: null,
    attachOnly: false,
    draft: false,
    publishMode: false,
    statusMode: false,
    prerelease: false,
    dryRun: false,
    check: true,
    build: true,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) fail(`option ${a} needs a value`);
      return v;
    };
    switch (a) {
      case "--tag":
        opts.tag = value();
        break;
      case "--target":
        opts.target = value();
        break;
      case "--notes-file":
        opts.notesFile = value();
        break;
      case "--attach-only":
        opts.attachOnly = true;
        break;
      case "--draft":
        opts.draft = true;
        break;
      case "--publish":
        opts.publishMode = true;
        break;
      case "--status":
        opts.statusMode = true;
        break;
      case "--prerelease":
        opts.prerelease = true;
        break;
      case "--dry-run":
      case "-n":
        opts.dryRun = true;
        break;
      case "--no-check":
        opts.check = false;
        break;
      case "--no-build":
        opts.build = false;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        fail(`unknown option: ${a}`, `run \`${binName()} --help\``);
    }
  }
  return opts;
}

function help() {
  process.stdout.write(`\nUsage: ${binName()} [options]

One machine per OS: cut a draft release, attach each OS, then publish.

Release flow:
  captain:  ${binName()} --tag v0.2.0 --draft
  others:   git fetch --tags && git checkout v0.2.0
            ${binName()} --tag v0.2.0 --attach-only
  captain:  ${binName()} --tag v0.2.0 --status
            ${binName()} --tag v0.2.0 --publish

Options:
  --tag <vX.Y.Z>   Release tag. Default: v<version from tauri.conf.json>.
  --target <ref>   Commit/branch for a brand-new tag. Default: current HEAD.
  --draft          Create the release as a draft (recommended: invisible until published).
  --attach-only    Never create the tag/release; build this OS and upload to the existing one.
  --status         Show the release's assets and which platforms are missing.
  --publish        Flip a draft release live (and mark it latest).
  --prerelease     Mark the release a prerelease (never latest; nudge ignores it).
  --notes-file <f> Release notes. Default: the unsigned-build workaround text.
  --no-check       Skip the commit gate (scripts/build.mjs check) before building.
  --no-build       Publish bundles already under target/release/bundle/ (skip tauri build).
  -n, --dry-run    Print the plan; change nothing.
  -h, --help       Show this help.
`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return help();
  DRY = opts.dryRun;

  const repo = remoteInfo();
  preflight(opts, repo);

  const tauri = readJson(TAURI_CONF);
  const frontend = readJson(FRONTEND_PKG);
  const version = tauri.version;
  const tag = opts.tag ?? `v${version}`;
  opts.tag = tag;

  // --status / --publish act on a tag, not on a build; skip the version guard.
  if (!opts.statusMode && !opts.publishMode) {
    if (tag.replace(/^v/, "") !== version) {
      fail(
        `tag ${tag} does not match the version in crates/app/tauri.conf.json (${version})`,
        "bump the version and commit, or pass the matching --tag",
      );
    }
    if (frontend.version !== version) {
      fail(
        `frontend/package.json is ${frontend.version} but tauri.conf.json is ${version}`,
        "the in-app update nudge reads the frontend version; bump both and commit",
      );
    }
  }

  if (opts.statusMode) return status(tag, repo);
  if (opts.publishMode) return unpublishDraft(tag, repo, opts);

  process.stdout.write(`\n    release ${tag} on ${repo.flag} (${process.platform})${opts.draft ? " [draft]" : ""}\n`);

  if (opts.check) run(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "check"]);
  if (opts.build) run(process.execPath, [path.join(ROOT, "scripts", "build.mjs"), "desktop"]);
  if (!opts.attachOnly) ensureTag(tag, opts.target);

  const files = bundleFiles();
  process.stdout.write(`    assets:\n${files.map((f) => `      ${path.relative(ROOT, f)}`).join("\n")}\n`);
  publish(tag, repo, files, opts);

  process.stdout.write(`\nDone: ${tag}${opts.draft ? " (draft — run --status then --publish when all OSes are in)" : ""}\n`);
}

main();
