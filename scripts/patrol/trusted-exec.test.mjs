#!/usr/bin/env node
// Tests for patrol's trusted executable / minimal environment layer.
//
// The property under test is that patrol cannot be steered by ambient configuration when
// it runs unattended: fixed executables, a stripped environment, and a refusal to run
// Git's conversion pipeline anywhere a repo-local filter command could execute.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  trustedEnv,
  trustedGhEnv,
  trustedGit,
  git as patrolGit,
} from "./trusted-exec.mjs";

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); pass++; };

// ── fixed executables ───────────────────────────────────────────────────────
{
  const g = trustedGit();
  ok(existsSync(g), "the trusted git executable resolves to a real absolute path");
  ok(/[/\\]/.test(g), "and is a path, not a bare name a PATH shim could satisfy");
}

// ── minimal environment ─────────────────────────────────────────────────────
{
  const env = trustedEnv();
  eq(env.GIT_CONFIG_NOSYSTEM, "1", "system Git config is disabled");
  eq(env.GIT_CONFIG_GLOBAL, process.platform === "win32" ? "NUL" : "/dev/null", "global Git config is pointed at nowhere");
  eq(env.GIT_NO_REPLACE_OBJECTS, "1", "replacement objects are disabled");
  eq(env.GIT_ATTR_NOSYSTEM, "1", "the system attributes file is disabled");
  eq(env.GIT_TERMINAL_PROMPT, "0", "Git cannot prompt for credentials on an unattended run");

  // Inherited overrides must be dropped BY CONSTRUCTION (allowlist), not by blocklist.
  for (const leak of ["GIT_DIR", "GIT_WORK_TREE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) {
    ok(!(leak in env), `${leak} is not carried into the child environment`);
  }
  ok(!env.PATH.split(process.platform === "win32" ? ";" : ":").includes("."), "the current directory is never on PATH");
  ok(env.PATH.includes(trustedGit().replace(/[/\\][^/\\]+$/, "")), "PATH is narrowed to the trusted Git directory plus the system directory");
}
{
  // gh needs its own credentials; that is a deliberate, enumerated exception.
  const env = trustedGhEnv();
  ok("GIT_CONFIG_NOSYSTEM" in env, "the gh environment keeps the same Git hardening");
  for (const leak of ["GIT_DIR", "GIT_SSH_COMMAND"]) ok(!(leak in env), `${leak} is not carried into the gh environment either`);
}

// ── the fsmonitor vector is closed BY EXECUTION, not by inspection ──────────
// A real repository, a real command-bearing `core.fsmonitor`, patrol's real `git()`. The
// payload writes a marker file; if patrol's invocation runs it, the marker exists. This
// replaces the deleted config SCANNER, which passed unit tests while failing open three
// review rounds running — every one of those tests asserted against a hand-built fake.
{
  const dir = mkdtempSync(path.join(tmpdir(), "patrol-fsmon-"));
  // The control must NOT inherit the ambient environment. Run under husky's pre-commit,
  // `GIT_INDEX_FILE` (and friends) are set and point at the PARENT repo, so a bare
  // execFileSync here operated on the wrong index and the payload silently never fired —
  // the control failed while the code under test was fine. Strip every GIT_* name so this
  // measures the temp repository and nothing else. `unhardenedEnv` deliberately keeps a
  // normal PATH and no `-c` overrides: it is the UNPROTECTED baseline, not a second
  // hardened call, or the control would prove nothing.
  const unhardenedEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));
  const raw = (a, o) => execFileSync(trustedGit(), a, { cwd: dir, encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "ignore"], env: unhardenedEnv, ...o });
  raw(["init", "-q"]);
  raw(["config", "user.email", "t@t"]);
  raw(["config", "user.name", "t"]);
  const marker = path.join(dir, "FSMON_FIRED.txt");
  const hook = path.join(dir, "fsmon.cmd");
  writeFileSync(hook, `@echo off\r\necho fired > "${marker}"\r\necho /\r\n`);
  raw(["config", "core.fsmonitor", hook.replace(/\\/g, "/")]);
  writeFileSync(path.join(dir, "a.txt"), "hello\n");

  // Control FIRST: prove the payload really fires through an UNHARDENED call, so a
  // "blocked" result below cannot be an inert fixture quietly proving nothing.
  try { raw(["status", "--porcelain"]); } catch { /* the payload's exit status is irrelevant */ }
  ok(existsSync(marker), "CONTROL: an unhardened `git status` DOES execute repo-local core.fsmonitor");
  rmSync(marker, { force: true });
  ok(!existsSync(marker), "control marker cleared before the real measurement");

  // Now patrol's own invocation.
  try { patrolGit(["status", "--porcelain"], { cwd: dir }); } catch { /* ditto */ }
  ok(!existsSync(marker), "patrol's git() does NOT execute repo-local core.fsmonitor — closed by -c override, not by scanning");

  rmSync(dir, { recursive: true, force: true });
}
{
  // The override must be present on EVERY git call, not just the one that was tested —
  // and ahead of the caller's own args so a caller cannot position around it.
  const src = readFileSync(new URL("./trusted-exec.mjs", import.meta.url), "utf8");
  const body = src.slice(src.indexOf("export function git("));
  const call = body.slice(0, body.indexOf("\n}"));
  ok(/SAFE_BY_CONSTRUCTION/.test(call), "git() applies the safe-by-construction overrides");
  ok(call.indexOf("SAFE_BY_CONSTRUCTION") < call.indexOf("...args"), "and applies them BEFORE the caller's arguments");
}
{
  // The deleted scanner must stay deleted. Re-adding it piecemeal is the documented
  // failure mode, so its absence is asserted rather than left to reviewer memory.
  const mod = readFileSync(new URL("./trusted-exec.mjs", import.meta.url), "utf8");
  for (const gone of ["export function worktreeFilterRisk", "export function dangerousConfigKeys"]) {
    ok(!mod.includes(gone), `the config scanner stays deleted (${gone})`);
  }
  ok(/REMOVED 2026-08-25/.test(mod), "and the file records WHY, so the next reader does not reinstate it");
}

// ── no patrol module may resolve an executable from PATH ────────────────────
// The hardening was incomplete once already: patrol-report.mjs still called
// execFileSync("git", ...) to resolve the repo, and that is the FIRST line an unattended
// run reaches, so a PATH shim executed straight past the fixed-executable layer. This
// sweeps every module rather than trusting that the last audit was thorough.
{
  const dir = new URL("./", import.meta.url);
  const modules = [
    "patrol-report.mjs", "patrol-scan.mjs", "patrol-sources.mjs",
    "patrol-classify.mjs", "patrol-render.mjs", "patrol-monitor.mjs",
  ];
  for (const name of modules) {
    const src = readFileSync(new URL(name, dir), "utf8");
    // A bare-name first argument to execFileSync/spawnSync is a PATH lookup.
    const bare = src.match(/(?:execFileSync|spawnSync)\(\s*["'](git|gh|powershell|pwsh|cmd|bash|sh)["']/g) ?? [];
    eq(bare, [], `${name} never resolves git/gh/powershell from PATH`);
  }
}

console.log(`patrol-trusted-exec: ${pass} assertions passed`);
