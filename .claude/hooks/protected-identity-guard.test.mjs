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
import { existsSync, linkSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

// REGRESSION — a protected file is not an alias of ITSELF. The first cut of this
// guard compared identities alone, so editing a protected hook at its own real
// path matched its own identity and denied: the guard's error text says "edit the
// real path", which was the one thing it refused. Wiring that onto a second write
// route would have left the harness uneditable through the agent tools.
const realHook = path.join(repoRoot, ".claude", "hooks", "bash-safety-lib.mjs");
eq(runHook({ tool_name: "Edit", tool_input: { file_path: realHook, old_string: "a", new_string: "b" } }, repoRoot).stdout.trim(), "", "editing a protected hook at its OWN real path is allowed");
eq(runHook({ tool_name: "Write", tool_input: { file_path: ".claude/hooks/bash-safety-lib.mjs", content: "x" } }, repoRoot).stdout.trim(), "", "the repo-relative spelling of the real path is allowed");

// The NATIVE PATCH route. A patch carries its destinations inside a free-form
// body, so a guard reading only file_path sees nothing to check. These drive the
// real hook with real patch bodies rather than asserting against a parser.
if (linked) {
  const beginPatch = ["*** Begin Patch", `*** Update File: ${alias}`, "@@", "-a", "+b", "*** End Patch"].join("\n");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: beginPatch } })), "a patch whose destination is an alias of a protected hook is denied");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { input: beginPatch } })), "the `input` field spelling of a patch body is denied too");
  const unified = [`--- a/${alias}`, `+++ b/${alias}`, "@@ -1 +1 @@", "-a", "+b"].join("\n");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: unified } })), "a unified-diff patch destination is denied");
  // EVERY destination is checked, not just the first: one patch can carry a
  // benign file and a hostile one in the same body.
  const mixed = ["*** Begin Patch", `*** Update File: ${path.join(scratch, "ordinary.txt")}`, "@@", "+x", `*** Update File: ${alias}`, "@@", "+y", "*** End Patch"].join("\n");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: mixed } })), "a patch is denied when ANY of its destinations aliases a protected file");
  // A patch touching only ordinary files must still work — the rule is not a tax
  // on normal patching.
  const benign = ["*** Begin Patch", `*** Update File: ${path.join(scratch, "ordinary.txt")}`, "@@", "+x", "*** End Patch"].join("\n");
  eq(runHook({ tool_name: "apply_patch", tool_input: { patch: benign } }).stdout.trim(), "", "a patch touching only ordinary files is allowed");
}

// PROOF FORGERY. A new file in the review state directory certifies a change the
// gate will later trust. Identity cannot see it — a file that does not exist yet
// has no inode — so the destination is canonicalised first.
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: ".claude/session-state/codex-review-deadbeef.json", content: "{}" } }, repoRoot)), "creating a new proof file is denied");
ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: ["*** Begin Patch", "*** Add File: .claude/session-state/codex-review-deadbeef.json", "@@", "+{}", "*** End Patch"].join("\n") } }, repoRoot)), "adding a proof file through the patch route is denied");
// The ack valve is the ONE designed agent-writable file there; stop-wrap.mjs
// instructs the agent to write it, so protecting it would break session close-out.
eq(runHook({ tool_name: "Write", tool_input: { file_path: ".claude/session-state/stop-wrap-ack.json", content: "{}" } }, repoRoot).stdout.trim(), "", "the stop-wrap ack valve stays writable");

// A JUNCTION launders the protected directory out of the pathname entirely: the
// supplied path never spells session-state, so every text matcher misses it.
const junction = path.join(scratch, "notes-dir");
let junctioned = false;
try {
  symlinkSync(path.join(repoRoot, ".claude", "session-state"), junction, "junction");
  junctioned = true;
} catch {
  // Environments without junction/symlink permission cannot mount this route.
}
if (junctioned) {
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: path.join(junction, "codex-review-deadbeef.json"), content: "{}" } })), "creating a proof through a junction is denied");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: ["*** Begin Patch", `*** Add File: ${path.join(junction, "codex-review-deadbeef.json")}`, "@@", "+{}", "*** End Patch"].join("\n") } })), "adding a proof through a junction is denied on the patch route");
}

// An existing proof file reached through a hard-link alias is caught by identity,
// which is the dimension the text matchers in review-proof-guard cannot supply.
const stateDir = path.join(repoRoot, ".claude", "session-state");
let existingProof = "";
try {
  existingProof = (readdirSync(stateDir).find((name) => /^codex-review-.*\.json$/.test(name)) || "");
} catch {
  // No state directory in this checkout; the route does not exist here.
}
if (existingProof) {
  const proofAlias = path.join(scratch, "meeting-notes.json");
  let proofLinked = false;
  try {
    linkSync(path.join(stateDir, existingProof), proofAlias);
    proofLinked = true;
  } catch {
    // Cross-volume or permission-restricted environments cannot create the alias.
  }
  if (proofLinked) {
    ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: proofAlias, content: "{}" } })), "writing an existing proof through a hard-link alias is denied");
    ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: ["*** Begin Patch", `*** Update File: ${proofAlias}`, "@@", "+{}", "*** End Patch"].join("\n") } })), "patching an existing proof through a hard-link alias is denied");
  }
}

rmSync(scratch, { recursive: true, force: true });
ok(!existsSync(scratch), "scratch fixture removed");

console.log(`protected-identity-guard: ${pass} assertions passed`);
