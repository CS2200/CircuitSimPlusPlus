#!/usr/bin/env node
// CircuitSim++ build runner.
//
// A thin, cross-platform convenience wrapper over the commands documented in
// README.md. It is NOT a second source of truth: every step here is the same
// command CI runs (.github/workflows/backend.yml, frontend.yml), so if a gate
// changes, change it in one place and keep the three in sync.
//
//   node scripts/build.mjs            # default target: check (backend + frontend)
//   node scripts/build.mjs --list     # show every target
//   node scripts/build.mjs musl ui    # run targets in order
//
// Node >= 22 is already a hard prerequisite of this repo (see README), so this
// needs no new tooling on any of the three release OSes.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.join(ROOT, "frontend");
const APP = path.join(ROOT, "crates", "app");
const IS_WINDOWS = process.platform === "win32";

// npm / tauri are launcher scripts, not real binaries, so Windows needs the
// .cmd shims; everywhere else the plain name works.
const NPM = IS_WINDOWS ? "npm.cmd" : "npm";
const tauriBin = path.join(
  FRONTEND,
  "node_modules",
  ".bin",
  IS_WINDOWS ? "tauri.cmd" : "tauri",
);

const npm = (script) => ({ cmd: NPM, args: ["--prefix", FRONTEND, "run", script] });
const cargo = (...args) => ({ cmd: "cargo", args });

// --- targets -----------------------------------------------------------------
// Each target is a list of steps run in order, stopping at the first failure.
const TARGETS = {
  build: {
    help: "cargo build — workspace default members (core + cli, no webview deps)",
    steps: [cargo("build")],
  },

  lint: {
    help: "format check + clippy -D warnings for core + cli (mirrors backend.yml)",
    steps: [
      cargo("fmt", "--all", "--", "--check"),
      cargo("clippy", "-p", "csim-core", "-p", "csim", "--all-targets", "--", "-D", "warnings"),
    ],
  },

  test: {
    help: "backend unit/integration tests (csim-core + csim)",
    steps: [cargo("test", "-p", "csim-core", "-p", "csim")],
  },

  "check:backend": {
    help: "the backend commit gate: fmt, clippy, tests",
    steps: ["lint", "test"],
  },

  ui: {
    help: "frontend production build — tsc --noEmit && vite build -> frontend/dist",
    requiresFrontend: true,
    steps: [npm("build")],
  },

  "check:frontend": {
    help: "the frontend commit gate: lint, unit tests, production build",
    requiresFrontend: true,
    steps: [npm("lint"), npm("test"), npm("build")],
  },

  check: {
    help: "the full commit gate: backend then frontend (default target)",
    steps: ["check:backend", "check:frontend"],
  },

  e2e: {
    help: "Playwright end-to-end (needs `npx playwright install --with-deps chromium`)",
    requiresFrontend: true,
    steps: [npm("test:e2e")],
  },

  musl: {
    help: "static musl release of the autograder CLI (needs `rustup target add ...`)",
    steps: [cargo("build", "-p", "csim", "--release", "--target", "x86_64-unknown-linux-musl")],
  },

  desktop: {
    help: "packaged Tauri desktop bundles (needs Linux webview deps)",
    requiresFrontend: true,
    steps: [{ cmd: tauriBin, args: ["build"], cwd: APP }],
  },

  image: {
    help: "the Gradescope autograder Docker image (needs Docker)",
    steps: [{ cmd: "docker", args: ["build", "-t", "csim-autograder", "-f", "gradescope/Dockerfile", "."] }],
  },
};

// --- runner ------------------------------------------------------------------
const seen = new Set();

function resolve(name) {
  const target = TARGETS[name];
  if (!target) {
    fail(`unknown target "${name}"`, `run \`${binName()} --list\` to see the available targets`);
  }
  seen.add(name);
  if (target.requiresFrontend && !existsSync(path.join(FRONTEND, "node_modules"))) {
    fail(
      `target "${name}" needs frontend dependencies`,
      `install them first: ${NPM} --prefix frontend ci`,
    );
  }
  return target;
}

function binName() {
  return `node ${path.relative(ROOT, fileURLToPath(import.meta.url))}`;
}

function fail(message, hint) {
  process.stderr.write(`\n  error: ${message}\n`);
  if (hint) process.stderr.write(`  ${hint}\n`);
  process.exit(2);
}

function runSteps(name, ancestry = []) {
  const target = resolve(name);
  const trail = [...ancestry, name].join(" > ");

  for (const step of target.steps) {
    if (typeof step === "string") {
      // A reference to another target — e.g. check:backend -> lint + test.
      runSteps(step, [...ancestry, name]);
      continue;
    }
    process.stdout.write(`\n==> [${trail}] ${step.cmd} ${step.args.join(" ")}\n`);
    const result = spawnSync(step.cmd, step.args, {
      cwd: step.cwd ?? ROOT,
      stdio: "inherit",
      env: { ...process.env, CARGO_TERM_COLOR: process.env.CARGO_TERM_COLOR ?? "always" },
    });
    if (result.error) {
      fail(`could not run "${step.cmd}"`, String(result.error.message));
    }
    if (result.status !== 0) {
      process.stderr.write(`\n  FAILED: [${trail}] ${step.cmd} ${step.args.join(" ")}\n`);
      process.exit(result.status ?? 1);
    }
  }
}

function list() {
  process.stdout.write(`\nUsage: ${binName()} [target ...]   (default: check)\n\nTargets:\n`);
  for (const [name, target] of Object.entries(TARGETS)) {
    process.stdout.write(`  ${name.padEnd(16)} ${target.help ?? ""}\n`);
  }
  process.stdout.write("\n");
}

// --- entry -------------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("-h") || args.includes("--help")) {
  list();
} else if (args.includes("-l") || args.includes("--list")) {
  list();
} else {
  const requested = args.filter((a) => !a.startsWith("-"));
  if (requested.some((a) => a.startsWith("-"))) {
    fail(`unknown option`, `run \`${binName()} --list\``);
  }
  for (const name of requested.length ? requested : ["check"]) {
    runSteps(name);
  }
  const summary = [...seen].join(", ");
  process.stdout.write(`\nAll good: ${summary}\n`);
}
