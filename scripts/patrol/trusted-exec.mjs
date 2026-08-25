#!/usr/bin/env node
// Trusted executable + minimal environment for patrol.
//
// Patrol is meant to run on a schedule, unattended, under Mason's OS account. That raises
// the bar above "a script he runs by hand": resolving `git` / `gh` / `powershell` from
// PATH lets anything earlier on PATH impersonate them, and inheriting Git configuration
// lets global/system config steer the process. Worse, `git status` runs Git's worktree
// conversion pipeline, so a repository-local `filter.<name>.clean` command executes —
// hourly, across 28 worktrees, as him.
//
// This mirrors the pattern PR #455 established for the proof wrapper: fixed absolute
// executables, one minimal environment, and no ambient configuration.
//
// What this does NOT do: `GIT_ATTR_NOSYSTEM` disables the *system* attributes file but
// not an in-repo `.gitattributes`, and there is no environment switch that disables
// repository-local filters. So a filter is handled by REFUSING to scan that worktree
// (see `worktreeFilterRisk`) rather than by hoping it is benign.

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

export function git(args, { cwd, timeout = 20_000, maxBuffer = 32 * 1024 * 1024 } = {}) {
  return execFileSync(trustedGit(), ["--no-replace-objects", ...args], {
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

// ── repository-local filter / hook risk ─────────────────────────────────────
// `git status` applies clean filters, so a worktree whose LOCAL config defines a filter
// command can execute it. No environment variable disables repo-local filters, so the
// only safe answer is not to run status there.
//
// Reading config is itself safe: `git config --list` never runs a filter.
const DANGEROUS_KEY = /^(filter\.[^=]*\.(clean|smudge|process)|core\.fsmonitor|diff\.[^=]*\.textconv|core\.sshcommand|core\.gitproxy|uploadpack\.packobjectshook)=/i;

export function dangerousConfigKeys(configListText) {
  // A Set, not an array: without the worktreeConfig extension Git's `--worktree` scope
  // falls back to reporting local config, so the two reads overlap and a key would
  // otherwise be listed twice in the refusal message.
  const out = new Set();
  for (const line of String(configListText ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (!DANGEROUS_KEY.test(trimmed)) continue;
    const [key, ...rest] = trimmed.split("=");
    const value = rest.join("=").trim();
    // `core.fsmonitor=false|true` is a boolean, not a command — only a command is a risk.
    if (/^core\.fsmonitor$/i.test(key) && /^(true|false|)$/i.test(value)) continue;
    if (value === "") continue; // an empty value disables the filter rather than running one
    out.add(key);
  }
  return [...out];
}

// Returns null when the worktree is safe to scan, or a reason string when it is not.
// Unreadable config fails CLOSED — an unknown configuration is not a safe one.
export function worktreeFilterRisk(wtPath, runGit = git) {
  // BOTH scopes. Reading only `--local` missed per-worktree configuration, which Git
  // consumes whenever `extensions.worktreeConfig` is enabled — a command-bearing filter or
  // fsmonitor there bypassed the guard entirely.
  //
  // `--worktree` errors when the extension is off, which is the common case and NOT a
  // risk signal; that specific error is tolerated. Any other unreadable scope fails CLOSED,
  // because an unknown configuration is not a safe one.
  let text = "";
  try {
    text += runGit(["config", "--local", "--list"], { cwd: wtPath, timeout: 10_000 });
  } catch (e) {
    return `local Git configuration is unreadable (${String(e.message).slice(0, 80)}) — not scanned`;
  }
  // Whether the per-worktree scope EXISTS is decided from the local config we just read,
  // not from error text. An execFileSync failure message embeds the whole command line —
  // which contains "--worktree" — so pattern-matching the error treated EVERY failure
  // (not a repository, permission denied, timeout) as "extension disabled" and failed
  // OPEN. The unit test missed it because a hand-written Error lacks that command line.
  const worktreeScopeEnabled = /^extensions\.worktreeconfig=true$/im.test(text);
  if (worktreeScopeEnabled) {
    try {
      text += `\n${runGit(["config", "--worktree", "--list"], { cwd: wtPath, timeout: 10_000 })}`;
    } catch (e) {
      // The scope is enabled, so this read had to succeed. Any failure is unknown config.
      return `per-worktree Git configuration is unreadable (${String(e.message ?? "").slice(0, 80)}) — not scanned`;
    }
  }
  const keys = dangerousConfigKeys(text);
  if (keys.length === 0) return null;
  return `Git config defines executable ${keys.join(", ")} — patrol will not run status here`;
}
