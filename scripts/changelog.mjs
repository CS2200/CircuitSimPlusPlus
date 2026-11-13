#!/usr/bin/env node
// Release notes from the hand-written changelog.
//
// The GitHub Release body is the CHANGELOG.md section for the released version
// plus a short install footer. Nothing is generated from the git log: the
// changelog is written by hand as work lands, and this script only extracts
// the right section so CI and `scripts/release.mjs` publish the same text.
//
//   node scripts/changelog.mjs --tag v0.4.1 --install-notes
//   node scripts/changelog.mjs --check          # version from tauri.conf.json
//
// `--check` is part of the commit gate (`node scripts/build.mjs check`): it
// fails if the version in `crates/app/tauri.conf.json` has no changelog
// section, so a version bump cannot ship without notes.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHANGELOG = path.join(ROOT, "CHANGELOG.md");
const TAURI_CONF = path.join(ROOT, "crates", "app", "tauri.conf.json");

// Shown under every release. Keep it to "how to install and what the first
// launch looks like" — not another essay about signing. Details live in the
// README's install section.
const INSTALL_NOTES = `> **Install:** grab your platform's asset below.
>
> - **macOS** (universal, Apple silicon + Intel): open the \`.dmg\`, drag the
>   app to Applications. The build is self-signed but not notarized, so the
>   first launch is right-click → **Open** → **Open**.
> - **Windows:** run the NSIS \`-setup.exe\`, or unzip the portable zip.
>   SmartScreen → **More info** → **Run anyway**.
> - **Linux:** \`.deb\` / \`.rpm\` / \`.AppImage\`; the static \`csim\` CLI is
>   attached for headless / Gradescope use.`;

function usage() {
  process.stdout.write(`\nUsage: node scripts/changelog.mjs [options]

Extract a release's notes from CHANGELOG.md.

Options:
  --tag <vX.Y.Z>       Release tag to extract (leading "v" optional).
  --version <X.Y.Z>    Same, without the tag spelling.
  --install-notes      Append the short install footer.
  --check              Fail unless the version being released has a section.
  --list               List the sections present (newest first).
  -h, --help           Show this help.

With no --tag/--version, the version comes from crates/app/tauri.conf.json.
`);
}

function readChangelog() {
  try {
    return readFileSync(CHANGELOG, "utf8");
  } catch {
    process.stderr.write(`\n  error: cannot read CHANGELOG.md at ${CHANGELOG}\n`);
    process.exit(2);
  }
}

function currentVersion() {
  const conf = JSON.parse(readFileSync(TAURI_CONF, "utf8"));
  return conf.version;
}

/** All section headings, newest first: { version, heading, body }. */
function sections() {
  const lines = readChangelog().split("\n");
  const out = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(/^##\s+\[([^\]]+)\]/);
    if (m) {
      current = { version: m[1], heading: line, body: [] };
      out.push(current);
      continue;
    }
    if (current) current.body.push(line);
  }
  return out.map((s) => ({ ...s, body: s.body.join("\n").trim() }));
}

function normalize(value) {
  return String(value ?? "").replace(/^v/, "");
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { tag: null, check: false, install: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--tag":
        opts.tag = argv[++i] ?? null;
        break;
      case "--version":
        opts.tag = argv[++i] ?? null;
        break;
      case "--install-notes":
        opts.install = true;
        break;
      case "--check":
        opts.check = true;
        break;
      case "--list":
        opts.list = true;
        break;
      case "-h":
      case "--help":
        return usage();
      default:
        process.stderr.write(`\n  error: unknown option: ${a}\n`);
        return usage();
    }
  }

  if (opts.list) {
    for (const s of sections()) process.stdout.write(`${s.version}\n`);
    return;
  }

  const version = normalize(opts.tag ?? currentVersion());
  // A prerelease tag (v0.5.0-rc.1) still uses the core version's section.
  const candidates = [version, version.replace(/-.*$/, "")];
  const match = sections().find((s) => candidates.includes(s.version));

  if (opts.check) {
    if (!match) {
      process.stderr.write(
        `\n  changelog gate failed: CHANGELOG.md has no "## [${version}]" section\n` +
          `  add one for the version in crates/app/tauri.conf.json before releasing\n`,
      );
      process.exit(1);
    }
    if (match.body === "") {
      process.stderr.write(
        `\n  changelog gate failed: "## [${version}]" in CHANGELOG.md is empty\n`,
      );
      process.exit(1);
    }
    process.stdout.write(`  changelog gate ok: "## [${version}]" has notes\n`);
    return;
  }

  if (!match) {
    process.stderr.write(
      `\n  error: CHANGELOG.md has no "## [${version}]" section\n` +
        `  run \`node scripts/changelog.mjs --list\` to see the versions present\n`,
    );
    process.exit(2);
  }

  const parts = [match.body];
  if (opts.install) parts.push(INSTALL_NOTES);
  process.stdout.write(`${parts.join("\n\n")}\n`);
}

main();
