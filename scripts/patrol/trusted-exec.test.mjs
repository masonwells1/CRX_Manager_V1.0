#!/usr/bin/env node
// Tests for patrol's trusted executable / minimal environment layer.
//
// The property under test is that patrol cannot be steered by ambient configuration when
// it runs unattended: fixed executables, a stripped environment, and a refusal to run
// Git's conversion pipeline anywhere a repo-local filter command could execute.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import {
  trustedEnv,
  trustedGhEnv,
  trustedGit,
  dangerousConfigKeys,
  worktreeFilterRisk,
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

// ── dangerous local config detection ────────────────────────────────────────
eq(dangerousConfigKeys("filter.lfs.clean=git-lfs clean -- %f"), ["filter.lfs.clean"], "a clean filter command is dangerous");
eq(dangerousConfigKeys("filter.evil.process=cmd.exe /c calc"), ["filter.evil.process"], "a process filter command is dangerous");
eq(dangerousConfigKeys("filter.x.smudge=whatever"), ["filter.x.smudge"], "a smudge filter command is dangerous");
eq(dangerousConfigKeys("core.fsmonitor=C:/evil.exe"), ["core.fsmonitor"], "an fsmonitor COMMAND is dangerous");
eq(dangerousConfigKeys("core.fsmonitor=true"), [], "an fsmonitor BOOLEAN is not a command and is allowed");
eq(dangerousConfigKeys("core.fsmonitor=false"), [], "fsmonitor=false is allowed");
eq(dangerousConfigKeys("filter.x.clean="), [], "an EMPTY filter value disables the filter rather than running one");
eq(dangerousConfigKeys("user.name=Mason\nbranch.main.remote=origin"), [], "ordinary config is not flagged");
eq(dangerousConfigKeys("diff.foo.textconv=strings"), ["diff.foo.textconv"], "a textconv command is dangerous");
eq(dangerousConfigKeys("core.sshCommand=ssh -o X"), ["core.sshCommand"], "an ssh command override is dangerous");
eq(dangerousConfigKeys(""), [], "empty config is not flagged");
eq(dangerousConfigKeys(null), [], "missing config text does not throw");
{
  const many = dangerousConfigKeys("user.name=x\nfilter.a.clean=evil\ncore.fsmonitor=true\nfilter.b.smudge=evil2");
  eq(many, ["filter.a.clean", "filter.b.smudge"], "every dangerous key is reported and benign ones are not");
}

// ── worktreeFilterRisk fails CLOSED ─────────────────────────────────────────
{
  const risk = worktreeFilterRisk("C:/whatever", () => { throw new Error("boom"); });
  ok(risk !== null, "unreadable local config is treated as RISKY, not as safe");
  ok(/unreadable/.test(risk), "and says why");
}
{
  const risk = worktreeFilterRisk("C:/whatever", () => "filter.evil.clean=cmd /c calc");
  ok(risk !== null, "a configured filter command makes the worktree unscannable");
  ok(/will not run status/.test(risk), "and the reason states patrol refuses to run status there");
}
eq(worktreeFilterRisk("C:/whatever", () => "user.name=Mason"), null, "an ordinary worktree is safe to scan");

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
