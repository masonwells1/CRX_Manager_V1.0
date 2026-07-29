#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseGitIdentity } from "./check-local-git-identity.mjs";
import { scratchHookEnvironment } from "../.claude/hooks/git-test-env.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const checkerPath = path.join(scriptDir, "check-local-git-identity.mjs");
const tempRoot = mkdtempSync(path.join(tmpdir(), "crx-git-identity-"));

function git(cwd, args, inheritedEnv = process.env) {
  return execFileSync("git", args, {
    cwd,
    env: scratchHookEnvironment(cwd, inheritedEnv),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commandIdentity(name, email) {
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

function runChecker(cwd, environment) {
  return spawnSync(process.execPath, [checkerPath], {
    cwd,
    env: environment,
    encoding: "utf8",
  });
}

try {
  assert.deepEqual(
    parseGitIdentity("Mason <mason@croprxsolutions.com> 1785331153 -0500\n"),
    { name: "Mason", email: "mason@croprxsolutions.com", timestamp: "1785331153", timezone: "-0500" },
    "parser retains each resolved identity field",
  );
  assert.equal(parseGitIdentity("Mason <mason@croprxsolutions.com> invalid -0500"), null, "malformed Git identity is rejected");
  assert.equal(parseGitIdentity("Mason <mason@croprxsolutions.com> 1 -0500 extra"), null, "trailing identity content is rejected");

  const parent = path.join(tempRoot, "sacrificial-parent");
  mkdirSync(parent, { recursive: true });
  git(parent, ["init", "-b", "main"]);
  writeFileSync(path.join(parent, "SENTINEL.txt"), "parent stays untouched\n", "utf8");
  git(parent, ["add", "SENTINEL.txt"]);
  git(parent, ["commit", "-m", "sacrificial parent"], { ...process.env, ...commandIdentity("Sacrificial Parent", "parent@example.test") });
  const parentHeadBefore = git(parent, ["rev-parse", "HEAD"]);
  const parentConfigBefore = readFileSync(path.join(parent, ".git", "config"), "utf8");

  const fixture = path.join(tempRoot, "fixture");
  mkdirSync(fixture, { recursive: true });
  const hostileRedirects = {
    ...process.env,
    GIT_DIR: path.join(parent, ".git"),
    GIT_COMMON_DIR: path.join(parent, ".git"),
    GIT_CONFIG: path.join(parent, ".git", "config"),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
    GIT_OBJECT_DIRECTORY: path.join(parent, ".git", "objects"),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(parent, ".git", "objects"),
    GIT_INDEX_FILE: path.join(parent, ".git", "index"),
    GIT_WORK_TREE: parent,
    GIT_SHALLOW_FILE: path.join(parent, ".git", "shallow"),
    GIT_REPLACE_REF_BASE: path.join(parent, ".git", "refs", "replace"),
  };

  // The complete repository-local sanitizer removes every hostile redirect
  // before setup commands can reach the parent repository.
  git(fixture, ["init", "-b", "main"], hostileRedirects);
  writeFileSync(path.join(fixture, "fixture.txt"), "fixture commit only\n", "utf8");
  git(fixture, ["add", "fixture.txt"], hostileRedirects);
  git(fixture, ["commit", "-m", "fixture commit"], {
    ...hostileRedirects,
    ...commandIdentity("Fixture Test", "fixture@example.test"),
  });

  assert.equal(git(parent, ["rev-parse", "HEAD"]), parentHeadBefore, "hostile redirects cannot mutate the sacrificial parent head");
  assert.equal(readFileSync(path.join(parent, ".git", "config"), "utf8"), parentConfigBefore, "hostile redirects cannot mutate the sacrificial parent config");
  assert.equal(readFileSync(path.join(parent, "SENTINEL.txt"), "utf8"), "parent stays untouched\n", "sacrificial parent worktree stays unchanged");
  assert.equal(
    git(fixture, ["log", "-1", "--format=%an <%ae>|%cn <%ce>"], hostileRedirects),
    "Fixture Test <fixture@example.test>|Fixture Test <fixture@example.test>",
    "fixture receives its own command-scoped test identity and commit",
  );

  const masonEnv = {
    ...scratchHookEnvironment(fixture, hostileRedirects),
    ...commandIdentity("Mason", "mason@croprxsolutions.com"),
  };
  let result = runChecker(fixture, masonEnv);
  assert.equal(result.status, 0, `correct command-scoped Mason identity passes: ${result.stderr}`);

  result = runChecker(fixture, { ...masonEnv, GIT_AUTHOR_NAME: "Wrong Author" });
  assert.notEqual(result.status, 0, "wrong author identity rejects");
  assert.match(result.stderr, /author identity must resolve exactly/, "wrong author diagnostic identifies the role");

  result = runChecker(fixture, { ...masonEnv, GIT_COMMITTER_EMAIL: "wrong-committer@example.test" });
  assert.notEqual(result.status, 0, "wrong committer identity rejects");
  assert.match(result.stderr, /committer identity must resolve exactly/, "wrong committer diagnostic identifies the role");

  result = runChecker(fixture, {
    ...masonEnv,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.bare",
    GIT_CONFIG_VALUE_0: "true",
  });
  assert.notEqual(result.status, 0, "core.bare=true rejects");
  assert.match(result.stderr, /core\.bare must resolve exactly to false/, "bare diagnostic is explicit");

  console.log("check-local-git-identity: 14 assertions passed");
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
