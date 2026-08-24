#!/usr/bin/env node
// Tests for protected-identity-guard.mjs — the native Write|Edit route.
// Run: node .claude/hooks/protected-identity-guard.test.mjs
//
// The point of this guard is the route no pathname pattern can see: an alias is
// created by ANY means, then written through under an innocent name. The tests
// therefore create a REAL hard link and drive the REAL hook, rather than
// asserting against a pattern table that could agree with the same mistake.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
let pass = 0;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) { assert.equal(a, b, m); pass++; }

function runHook(payload, cwd) {
  return spawnSync(process.execPath, [path.join(__dirname, "protected-identity-guard.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CLAUDE_PROJECT_DIR: cwd || repoRoot },
  });
}
const isDeny = (r) => r.stdout.includes('"permissionDecision":"deny"');

const scratch = mkdtempSync(path.join(os.tmpdir(), "crx-identity-guard-"));

// An ordinary file is writable — the guard must not tax normal work.
const ordinary = path.join(scratch, "ordinary.txt");
writeFileSync(ordinary, "hello\n");
eq(runHook({ tool_name: "Write", tool_input: { file_path: ordinary, content: "x" } }).stdout.trim(), "", "an ordinary file is writable");
eq(runHook({ tool_name: "Write", tool_input: { file_path: path.join(scratch, "brand-new.txt"), content: "x" } }).stdout.trim(), "", "creating a brand-new file is allowed");

// A second pathname for a protected hook must deny on every native write shape,
// even though nothing in the path resembles a protected location.
const protectedHook = path.join(repoRoot, ".claude", "hooks", "bash-safety-lib.mjs");
const alias = path.join(scratch, "innocuous-notes.mjs");
let linked = false;
try {
  linkSync(protectedHook, alias);
  linked = true;
} catch {
  // Cross-volume or permission-restricted environments cannot create the alias
  // at all, so the route this guard closes does not exist there.
}
if (linked) {
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: alias, content: "HOSTILE" } })), "Write through a hard-link alias of a protected hook is denied");
  ok(isDeny(runHook({ tool_name: "Edit", tool_input: { file_path: alias, old_string: "a", new_string: "b" } })), "Edit through a hard-link alias of a protected hook is denied");
  // A relative spelling resolves against the project dir, so it must deny too.
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: path.relative(repoRoot, alias).replaceAll("\\", "/"), content: "x" } }, repoRoot)), "a relative spelling of the alias is denied");
  // Alternate field spellings must not become a way past the guard.
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { path: alias, content: "x" } })), "the `path` field spelling is denied too");
}

// Git control files choose programs Git runs. A hostile `core.fsmonitor` or
// `core.attributesfile` executes on the next ordinary Git command, so writing
// one is arbitrary execution and must deny by PATHNAME — identity cannot cover a
// file that does not exist yet, and creating it is the attack (Codex, 2026-08-24).
for (const control of [
  path.join(repoRoot, ".git", "config"),
  path.join(repoRoot, ".git", "config.worktree"),
  path.join(repoRoot, ".git", "info", "attributes"),
  path.join(repoRoot, ".git", "info", "exclude"),
  path.join(repoRoot, ".gitattributes"),
  path.join(repoRoot, ".gitignore"),
]) {
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: control, content: "x" } })), `writing ${path.basename(control)} is denied`);
}
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: ".git/info/attributes", content: "* filter=x" } }, repoRoot)), "a relative Git attributes path is denied even when the file does not exist yet");
eq(runHook({ tool_name: "Write", tool_input: { file_path: path.join(scratch, "config"), content: "x" } }).stdout.trim(), "", "an unrelated file merely named config is allowed");

// Malformed and empty payloads must not throw; the guard fails open loudly and
// the pathname-shaped protections still apply on this route.
eq(runHook({ tool_name: "Write", tool_input: {} }).stdout.trim(), "", "a payload with no target is allowed");
eq(spawnSync(process.execPath, [path.join(__dirname, "protected-identity-guard.mjs")], { input: "not json", encoding: "utf8" }).stdout.trim(), "", "a malformed payload fails open rather than throwing");

rmSync(scratch, { recursive: true, force: true });
ok(!existsSync(scratch), "scratch fixture removed");

console.log(`protected-identity-guard: ${pass} assertions passed`);
