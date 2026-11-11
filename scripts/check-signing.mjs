#!/usr/bin/env node
// Release-signing gate (DESIGN.md §9, D14).
//
// The macOS "Files and Folders" prompt is a TCC grant tied to the app's
// code-signing identity. An unsigned or ad-hoc build changes that identity on
// every rebuild, so TCC re-prompts on every save. The fix is a stable
// self-signed certificate: the release workflow imports it and signs the app
// with `APPLE_SIGNING_IDENTITY`. This gate keeps that wiring from silently
// drifting away.
//
//   node scripts/check-signing.mjs
//
// It checks:
//   * the app's `bundle.macOS.infoPlist` documents the folder access it uses,
//   * the release workflow imports a certificate and signs the macOS build,
//   * the certificate generator exists and is executable.
//
// It does NOT run a real codesign (that needs macOS and the certificate); it
// checks the configuration that makes the release build sign.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TAURI_CONF = path.join(ROOT, "crates", "app", "tauri.conf.json");
const RELEASE_WORKFLOW = path.join(ROOT, ".github", "workflows", "release.yml");
const SIGNING_SCRIPT = path.join(ROOT, "scripts", "macos-signing.sh");

const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};

const read = (file) => readFileSync(file, "utf8");

// --- app bundle ---------------------------------------------------------------
const conf = JSON.parse(read(TAURI_CONF));
const macos = conf.bundle?.macOS ?? {};
const info = macos.infoPlist ?? {};

for (const key of [
  "NSDocumentsFolderUsageDescription",
  "NSDesktopFolderUsageDescription",
  "NSDownloadsFolderUsageDescription",
]) {
  check(
    typeof info[key] === "string" && info[key].trim().length > 0,
    `crates/app/tauri.conf.json: bundle.macOS.infoPlist.${key} is missing`,
  );
}

// --- release workflow --------------------------------------------------------
const workflow = read(RELEASE_WORKFLOW);

check(
  workflow.includes("APPLE_CERTIFICATE"),
  ".github/workflows/release.yml: the macOS certificate import step is missing",
);
check(
  workflow.includes("APPLE_SIGNING_IDENTITY"),
  ".github/workflows/release.yml: the macOS build is not signed with APPLE_SIGNING_IDENTITY",
);
check(
  /security\s+import\s+certificate\.p12/.test(workflow),
  ".github/workflows/release.yml: the imported .p12 is not installed into the keychain",
);
check(
  /APPLE_SIGNING_IDENTITY:\s*"CircuitSim\+\+ Self-Signed"/.test(workflow),
  ".github/workflows/release.yml: APPLE_SIGNING_IDENTITY does not match the certificate identity",
);

// --- generator ---------------------------------------------------------------
let scriptStat = null;
try {
  scriptStat = statSync(SIGNING_SCRIPT);
} catch {
  // handled below
}
check(
  scriptStat !== null && scriptStat.isFile(),
  "scripts/macos-signing.sh is missing",
);
if (scriptStat) {
  check(
    (scriptStat.mode & 0o111) !== 0,
    "scripts/macos-signing.sh is not executable",
  );
}

// --- report ------------------------------------------------------------------
if (problems.length > 0) {
  process.stderr.write("\n  signing gate failed:\n");
  for (const problem of problems) process.stderr.write(`  - ${problem}\n`);
  process.stderr.write("\n");
  process.exit(1);
}

process.stdout.write("  signing gate ok: stable macOS certificate + app bundle docs\n");
