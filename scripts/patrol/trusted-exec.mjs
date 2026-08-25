#!/usr/bin/env node
// Trusted executable + minimal environment for patrol.
//
// Resolving `git` / `gh` / `powershell` from PATH lets anything earlier on PATH impersonate
// them, and inheriting Git configuration lets global/system config steer the process. Both
// are removed here with fixed absolute executables under one minimal environment — the
// pattern PR #455 established for the proof wrapper. Cheap, and it fails closed when a
// trusted executable is absent rather than falling back to a lookup.
//
// SCOPE, stated so it is not over-read: this does NOT fully defend against repository-LOCAL
// Git configuration. `git status` runs Git's conversion pipeline, so a repo-local
// `filter.*.clean` executes — verified by execution on 2026-08-25, not assumed. The
// fsmonitor half of that surface IS closed, by a command-line override that cannot fail
// open (see SAFE_BY_CONSTRUCTION below); the filter half has no generic off switch.
//
// That residual exposure is the repo's existing baseline, not something patrol adds:
// `scripts/fleet-status.mjs` runs `git status --porcelain -uall` in EVERY worktree
// (`dirtyCount()`, line 225) through a bare `execFileSync("git", …)` — a PATH lookup
// inheriting the full ambient environment, with no config scan and none of the hardening
// above. Patrol after this change is strictly better protected than a command Mason already
// runs whenever he asks "where are we at?". See the note at the foot of this file for the
// scanner that tried to close the filter half, and why it was deleted rather than fixed.

import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const GIT_CANDIDATES = process.platform === "win32"
  ? ["C:\\Program Files\\Git\\cmd\\git.exe", "C:\\Program Files\\Git\\bin\\git.exe"]
  : ["/usr/bin/git", "/usr/local/bin/git"];

const GH_CANDIDATES = process.platform === "win32"
  ? ["C:\\Program Files\\GitHub CLI\\gh.exe", "C:\\Program Files (x86)\\GitHub CLI\\gh.exe"]
  : ["/usr/bin/gh", "/usr/local/bin/gh", "/opt/homebrew/bin/gh"];

const PWSH_CANDIDATES = process.platform === "win32"
  ? [path.join(process.env.SystemRoot || "C:\\Windows", "System32\\WindowsPowerShell\\v1.0\\powershell.exe")]
  : [];

function fixedExecutable(candidates, label) {
  const hit = candidates.find((c) => existsSync(c));
  // Fail closed: falling back to a PATH lookup here would reintroduce the exact
  // impersonation this module exists to remove.
  if (!hit) throw new Error(`patrol requires a fixed trusted ${label} executable; none of the known paths exist`);
  return hit;
}

export const trustedGit = () => fixedExecutable(GIT_CANDIDATES, "git");
export const trustedGh = () => fixedExecutable(GH_CANDIDATES, "gh");
export const trustedPowershell = () => fixedExecutable(PWSH_CANDIDATES, "powershell");

// One minimal environment for every child process. Inherited GIT_DIR / GIT_WORK_TREE /
// GIT_CONFIG_* style overrides are dropped by construction — only the names below survive.
export function trustedEnv(extraNames = []) {
  const env = {};
  for (const name of ["SystemRoot", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "HOME", "USERPROFILE", ...extraNames]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.GIT_NO_REPLACE_OBJECTS = "1";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GCM_INTERACTIVE = "never";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_ATTR_NOSYSTEM = "1";
  const systemPath = process.platform === "win32"
    ? path.join(env.SystemRoot || env.WINDIR || "C:\\Windows", "System32")
    : "/usr/bin:/bin";
  env.PATH = `${path.dirname(trustedGit())}${path.delimiter}${systemPath}`;
  return env;
}

// `gh` needs its credential and host configuration to work at all, so those names are
// admitted deliberately and nothing else is.
export function trustedGhEnv() {
  return trustedEnv(["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_CONFIG_DIR", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"]);
}

// `-c core.fsmonitor=false` is SAFE BY CONSTRUCTION and belongs here rather than in a
// scanner. Command-line `-c` outranks repository-local config, so this closes the
// fsmonitor vector outright — no config read, no parsing, nothing that can fail open.
//
// Measured 2026-08-25 against real repositories rather than assumed:
//   plain `git status`               → the configured command EXECUTED
//   `git -c core.fsmonitor= status`  → blocked
//   `git -c core.fsmonitor=false …`  → blocked
//
// It does NOT close the `filter.*.clean` vector, and no generic flag does — the same probe
// showed `-c core.attributesFile=NUL` still executes the filter, and suppressing one
// requires naming its driver, which means reading the config first. That read is exactly
// the scanner deleted at the foot of this file for failing open three rounds running.
// So: take the vector that closes for free, and do not pretend the other one is closed.
// Exported so a caller that must use its OWN spawn (different failure semantics) still
// applies the identical override. A second launcher that rebuilt the argument list by
// hand is exactly how the fsmonitor vector stayed open in patrol-sources.mjs.
export const SAFE_BY_CONSTRUCTION = ["-c", "core.fsmonitor=false"];

export function git(args, { cwd, timeout = 20_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return execFileSync(trustedGit(), ["--no-replace-objects", ...SAFE_BY_CONSTRUCTION, ...args], {
    cwd, encoding: "utf8", timeout, maxBuffer,
    stdio: ["ignore", "pipe", "ignore"], env: trustedEnv(), windowsHide: true, shell: false,
  });
}

export function gh(args, { timeout = 90_000, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return execFileSync(trustedGh(), args, {
    encoding: "utf8", timeout, maxBuffer,
    stdio: ["ignore", "pipe", "pipe"], env: trustedGhEnv(), windowsHide: true, shell: false,
  });
}

export function powershell(script, { timeout = 30_000 } = {}) {
  return execFileSync(trustedPowershell(), ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8", timeout,
    stdio: ["ignore", "pipe", "ignore"], env: trustedEnv(), windowsHide: true, shell: false,
  });
}

// ── REMOVED 2026-08-25: the repository-config filter guard ──────────────────
//
// `worktreeFilterRisk()` / `dangerousConfigKeys()` used to live here: they scanned each
// worktree's Git config for command-bearing filters and refused to run `git status` where
// one existed. Mason approved deleting them.
//
// Why: the guard existed for the SCHEDULED threat model — patrol running hourly, unattended,
// under his account. That capability was dropped, and the guard was not re-justified against
// what remained. Interactive patrol runs `git status` exactly as `/fleet` and every npm
// script in this repo already do: PATH-resolved, unscanned. The guard bought no protection
// over that existing baseline.
//
// What it cost: three consecutive adversarial review rounds each found it failing OPEN —
// an unguarded provenance call, error-text matching that swallowed every failure, then
// boolean forms (`yes`/`on`/`1`/valueless) it did not recognise. Each fix was right for the
// case in hand and wrong for the next. A novel mechanism that repeatedly fails open, guarding
// a door already open elsewhere, is worse than no mechanism: it invites false confidence.
//
// If patrol is ever scheduled, this is part of the design pass that decision requires —
// see `docs/manual/KNOWN_ISSUES.md`. Do not reinstate it piecemeal.
//
// The fixed-executable + minimal-environment layer above STAYS. It is cheap, has never
// misbehaved, and removes PATH impersonation and ambient Git configuration outright.
