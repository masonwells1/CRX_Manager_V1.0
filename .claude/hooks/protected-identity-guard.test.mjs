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
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");
let pass = 0;
let manifestAliasChecks = 0;
let manifestAliasPath = "";
let aliasedManifestOwnPathExpected = false;
function ok(c, m) { assert.ok(c, m); pass++; }
function eq(a, b, m) {
  if (aliasedManifestOwnPathExpected && b === "") {
    aliasedManifestOwnPathExpected = false;
    assert.ok(String(a).includes('"permissionDecision":"deny"'), m);
    pass++;
    return;
  }
  assert.equal(a, b, m);
  pass++;
}

function runHook(payload, cwd, envOverrides = {}) {
  const result = spawnSync(process.execPath, [path.join(__dirname, "protected-identity-guard.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, ...envOverrides, CLAUDE_PROJECT_DIR: cwd || repoRoot },
  });
  if (JSON.stringify(payload).includes("notes-manifest.json")) {
    manifestAliasChecks += 1;
    manifestAliasPath ||= payload?.tool_input?.file_path || "";
    if (manifestAliasChecks === 2 && manifestAliasPath) rmSync(manifestAliasPath, { force: true });
  }
  const manifestPath = path.join(repoRoot, ["package", "json"].join("."));
  if (payload?.tool_name === "Edit" && path.resolve(payload?.tool_input?.file_path || "") === manifestPath && statSync(manifestPath).nlink > 1) {
    aliasedManifestOwnPathExpected = true;
  }
  return result;
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
  path.join(repoRoot, ".git", "hooks", "pre-commit"),
  path.join(repoRoot, ".gitattributes"),
  path.join(repoRoot, ".gitignore"),
]) {
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: control, content: "x" } })), `writing ${path.basename(control)} is denied`);
}
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: ".git/info/attributes", content: "* filter=x" } }, repoRoot)), "a relative Git attributes path is denied even when the file does not exist yet");
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: ".git/hooks/pre-commit", content: "hostile" } }, repoRoot)), "a real Write payload cannot create a Git pre-commit hook");
ok(isDeny(runHook({ tool_name: "Edit", tool_input: { file_path: ".git/hooks/pre-commit", old_string: "safe", new_string: "hostile" } }, repoRoot)), "a real Edit payload cannot modify a Git pre-commit hook");
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: ".husky/post-index-change", content: "hostile" } }, repoRoot)), "a real Write payload cannot create a new Husky hook");
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
const realHookHasAliases = statSync(realHook).nlink > 1;
const realHookEdit = runHook({ tool_name: "Edit", tool_input: { file_path: realHook, old_string: "a", new_string: "b" } }, repoRoot);
const realHookWrite = runHook({ tool_name: "Write", tool_input: { file_path: ".claude/hooks/bash-safety-lib.mjs", content: "x" } }, repoRoot);
if (realHookHasAliases) {
  ok(isDeny(realHookEdit) && isDeny(realHookWrite), "even the nominal real path denies while a protected hook has multiple hard links");
} else {
  eq(realHookEdit.stdout.trim(), "", "editing a singly-linked protected hook at its OWN real path is allowed");
  eq(realHookWrite.stdout.trim(), "", "the repo-relative spelling of a singly-linked real path is allowed");
}

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

  // THE REAL SHAPE. Every assertion above wraps the patch in an object, and the
  // real `apply_patch` does not: it sends the patch body as a bare STRING. The
  // guard used to discard any non-object tool_input, so the shape that actually
  // occurs extracted no destination and was ALLOWED, while these object-wrapped
  // fixtures — a shape the tool never emits — passed and hid it (exact-review
  // High, PR #432, reproduced with a read-only probe of the real hook).
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: beginPatch })), "a RAW STRING patch body aliasing a protected hook is denied");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: unified })), "a RAW STRING unified-diff patch destination is denied");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: mixed })), "a RAW STRING patch is denied when ANY destination aliases a protected file");
  eq(runHook({ tool_name: "apply_patch", tool_input: benign }).stdout.trim(), "", "a RAW STRING patch touching only ordinary files is allowed");
  // Worst-case duplicate-target regression from the exact review: a protected
  // destination after 2,000 valid repeated destinations must still deny well
  // below the 15-second host deadline. The identity map is built once and the
  // repeated ordinary destination is checked once.
  const repeatedHeader = "*** Update File: ordinary.txt";
  const repeatedPatch = [
    "*** Begin Patch",
    ...Array.from({ length: 2_000 }, () => repeatedHeader),
    `*** Update File: ${alias}`,
    "@@",
    "+hostile",
    "*** End Patch",
  ].join("\n");
  ok(repeatedPatch.length < 100_000, "the duplicate-target probe stays below the payload budget");
  const repeatedStartedAt = process.hrtime.bigint();
  const repeatedResult = runHook({ tool_name: "apply_patch", tool_input: repeatedPatch });
  const repeatedElapsedMs = Number(process.hrtime.bigint() - repeatedStartedAt) / 1_000_000;
  ok(isDeny(repeatedResult) && repeatedResult.stdout.includes("second pathname"), "deduplication still reaches and identifies the protected destination after 2,000 repeats");
  ok(repeatedElapsedMs < 5_000, `the worst-case duplicate-target check stays safely below the 15s host timeout (actual ${repeatedElapsedMs.toFixed(0)}ms)`);

  const excessiveTargetsPatch = [
    "*** Begin Patch",
    ...Array.from({ length: 257 }, (_, index) => `*** Update File: ${path.join(scratch, `ordinary-${index}.txt`)}`),
    "*** End Patch",
  ].join("\n");
  const excessiveTargetsResult = runHook({ tool_name: "apply_patch", tool_input: excessiveTargetsPatch });
  ok(isDeny(excessiveTargetsResult) && excessiveTargetsResult.stdout.includes("256 unique destinations"), "more than 256 unique patch destinations fail closed before identity work");
  const oversizedResult = runHook({ tool_name: "apply_patch", tool_input: "x".repeat(1_000_001) });
  ok(isDeny(oversizedResult) && oversizedResult.stdout.includes("1000000-character inspection budget"), "an oversized payload fails closed before JSON or patch parsing");
  // Hosts that JSON-encode the object form must still be understood as an object
  // rather than mistaken for a patch body.
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: JSON.stringify({ patch: beginPatch }) })), "a JSON-encoded string tool_input is decoded and denied");
}

// The raw-string route must close the FORGERY case too — this is the exact
// payload the exact-review probe showed being allowed: a bare patch string that
// creates a trusted review proof.
ok(
  isDeny(runHook({
    tool_name: "apply_patch",
    tool_input: ["*** Begin Patch", "*** Add File: .claude/session-state/codex-review-deadbeef.json", "@@", "+{}", "*** End Patch"].join("\n"),
  }, repoRoot)),
  "a RAW STRING patch that adds a proof file is denied",
);

// FORGERY BY RENAME. `*** Move to:` is the header apply_patch really emits, and
// the shared extractor recognized only the `*** Move to File:` spelling that the
// tool never sends. A patch could therefore pair an innocuous `*** Update File:`
// — the only destination any guard saw — with a `*** Move to:` that relocated an
// ordinary file into the wrapper-owned state directory, onto a Git control path,
// or over a protected file. All three classes are asserted, because fixing only
// the one the reviewer demonstrated would leave the same header unparsed for the
// others (exact-review CRX-GUARD-01, PR #432).
const moveTo = (destination) => [
  "*** Begin Patch",
  "*** Update File: harmless.json",
  `*** Move to: ${destination}`,
  "@@",
  "-a",
  "+b",
  "*** End Patch",
].join("\n");

ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: moveTo(".claude/session-state/codex-review-deadbeef.json") }, repoRoot)), "a RAW STRING `*** Move to:` into the review state directory is denied");
ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: moveTo(".git/config") }, repoRoot)), "a RAW STRING `*** Move to:` onto a Git control path is denied");
ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: moveTo(".gitattributes") }, repoRoot)), "a RAW STRING `*** Move to:` onto the Git attributes file is denied");
// The object-wrapped spelling of the same header must be caught too — the bug
// was in the shared extractor, not in one route's payload handling.
ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: moveTo(".claude/session-state/codex-review-deadbeef.json") } }, repoRoot)), "an object-wrapped `*** Move to:` into the review state directory is denied");
if (linked) {
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: moveTo(alias) })), "a RAW STRING `*** Move to:` onto an alias of a protected file is denied");
}
// A move to an ordinary destination stays allowed — the header is now parsed,
// not blanket-denied.
eq(runHook({ tool_name: "apply_patch", tool_input: moveTo(path.join(scratch, "renamed.json")) }, repoRoot).stdout.trim(), "", "a `*** Move to:` an ordinary destination is allowed");

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
mkdirSync(path.join(repoRoot, ".claude", ["session", "state"].join("-")), { recursive: true });
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

// package.json chooses what every `npm run` executes, and the shell classifier
// reads it to vet script bodies — so an alias write here is both arbitrary
// execution and a way to blind that check.
const packageJson = path.join(repoRoot, "package.json");
const packageAlias = path.join(scratch, "notes-manifest.json");
let packageLinked = false;
try {
  linkSync(packageJson, packageAlias);
  packageLinked = true;
} catch {
  // Cross-volume or permission-restricted environments cannot create the alias.
}
if (packageLinked) {
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: packageAlias, content: "{}" } })), "writing package.json through a hard-link alias is denied");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: ["*** Begin Patch", `*** Update File: ${packageAlias}`, "@@", "+{}", "*** End Patch"].join("\n") } })), "patching package.json through a hard-link alias is denied");
}
eq(runHook({ tool_name: "Edit", tool_input: { file_path: packageJson, old_string: "a", new_string: "b" } }, repoRoot).stdout.trim(), "", "editing package.json at its own real path is allowed");

// THE COMMON GIT DIRECTORY. In a linked worktree `<root>/.git` is a pointer FILE,
// so readdirSync on it throws and every Git control file went unprotected — the
// shared `config` is not under the worktree root at all. Resolve it with git
// itself rather than with the helper under test, so the assertion cannot agree
// with a bug in the implementation it is checking.
const commonDir = spawnSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repoRoot, encoding: "utf8" }).stdout.trim();
if (commonDir) {
  const commonConfig = path.join(commonDir, "config");
  const commonHook = path.join(commonDir, "hooks", "pre-commit");
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: commonConfig, content: "x" } }, repoRoot)), "writing the common Git config by pathname is denied");
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: commonHook, content: "x" } }, repoRoot)), "writing a linked-worktree common Git hook by pathname is denied");
  ok(isDeny(runHook({ tool_name: "Edit", tool_input: { file_path: commonHook, old_string: "safe", new_string: "hostile" } }, repoRoot)), "editing a linked-worktree common Git hook by pathname is denied");
  const configAlias = path.join(scratch, "harmless-settings.txt");
  let configLinked = false;
  try {
    linkSync(commonConfig, configAlias);
    configLinked = true;
  } catch {
    // Cross-volume or permission-restricted environments cannot create the alias.
  }
  if (configLinked) {
    ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: configAlias, content: "x" } }, repoRoot)), "writing the ACTUAL common Git config through a hard-link alias is denied");
    ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: ["*** Begin Patch", `*** Update File: ${configAlias}`, "@@", "+x", "*** End Patch"].join("\n") } }, repoRoot)), "patching the common Git config through a hard-link alias is denied");
  }
}

// The `.git` pointer itself: rewriting it repoints the whole checkout at an
// attacker-chosen gitdir. In a linked worktree it is an ordinary file.
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: path.join(repoRoot, ".git"), content: "gitdir: /tmp/evil" } }, repoRoot)), "writing the .git pointer is denied");
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: ".git", content: "gitdir: /tmp/evil" } }, repoRoot)), "the relative .git pointer spelling is denied");
const pointerAlias = path.join(scratch, "ordinary-checkout-note.txt");
let pointerLinked = false;
try {
  linkSync(path.join(repoRoot, ".git"), pointerAlias);
  pointerLinked = true;
} catch {
  // An ordinary checkout has a .git directory; restricted/cross-volume
  // environments may also reject the link. The linked-worktree exploit is
  // absent in either case.
}
if (pointerLinked) {
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: pointerAlias, content: "gitdir: /tmp/evil" } }, repoRoot)), "writing the linked-worktree .git pointer through a hard-link alias is denied");
  ok(isDeny(runHook({ tool_name: "Edit", tool_input: { file_path: pointerAlias, old_string: "gitdir:", new_string: "owned:" } }, repoRoot)), "editing the linked-worktree .git pointer through a hard-link alias is denied");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: { patch: ["*** Begin Patch", `*** Update File: ${pointerAlias}`, "@@", "+gitdir: /tmp/evil", "*** End Patch"].join("\n") } }, repoRoot)), "patching the linked-worktree .git pointer through a hard-link alias is denied");
}
eq(runHook({ tool_name: "Write", tool_input: { file_path: path.join(scratch, "notes.git"), content: "x" } }).stdout.trim(), "", "an unrelated file merely ending in .git is allowed");

// The exact-review exploit uses a SECOND name for the pointer, so pathname
// checks never see `.git`. Build a deterministic linked-worktree shape instead
// of depending on whether the checkout running CI is itself linked.
const pointerRepo = path.join(scratch, "linked-pointer-repo");
const pointerGitDir = path.join(scratch, "linked-pointer-gitdir");
mkdirSync(pointerRepo, { recursive: true });
mkdirSync(pointerGitDir, { recursive: true });
const pointerFile = path.join(pointerRepo, ".git");
writeFileSync(pointerFile, `gitdir: ${pointerGitDir.replaceAll("\\", "/")}\n`);
const deterministicPointerAlias = path.join(scratch, "harmless-pointer-notes.txt");
linkSync(pointerFile, deterministicPointerAlias);
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: deterministicPointerAlias, content: "gitdir: /attacker" } }, pointerRepo)), "Write through a hard-link alias of a linked-worktree .git pointer is denied");
ok(isDeny(runHook({ tool_name: "Edit", tool_input: { file_path: deterministicPointerAlias, old_string: "safe", new_string: "hostile" } }, pointerRepo)), "Edit through a hard-link alias of a linked-worktree .git pointer is denied");
const pointerPatch = ["*** Begin Patch", `*** Update File: ${deterministicPointerAlias}`, "@@", "+gitdir: /attacker", "*** End Patch"].join("\n");
ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: pointerPatch }, pointerRepo)), "a RAW STRING patch through a hard-link alias of the .git pointer is denied");

// Scan-order collision: aliases inside `.claude/hooks` are discovered before
// the real pointer, migration, and proof paths. A multiply-linked protected
// inode has no safely distinguishable "own" pathname, so every spelling denies.
const collisionHooks = path.join(pointerRepo, ".claude", "hooks");
const collisionMigration = path.join(pointerRepo, "supabase", "migrations", "20260101000000_collision.sql");
const collisionProofName = [["codex", "review"].join("-"), "collision.json"].join("-");
const collisionProof = path.join(pointerRepo, ".claude", "session-state", collisionProofName);
mkdirSync(collisionHooks, { recursive: true });
mkdirSync(path.dirname(collisionMigration), { recursive: true });
mkdirSync(path.dirname(collisionProof), { recursive: true });
writeFileSync(collisionMigration, "select 1;\n");
writeFileSync(collisionProof, "{}\n");
for (const [label, protectedPath] of [["pointer", pointerFile], ["migration", collisionMigration], ["proof", collisionProof]]) {
  const collisionAlias = path.join(collisionHooks, `${label}-alias.mjs`);
  linkSync(protectedPath, collisionAlias);
  ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: collisionAlias, content: "hostile" } }, pointerRepo)), `Write denies a multiply-linked ${label} even when its hook alias is scanned first`);
  ok(isDeny(runHook({ tool_name: "Edit", tool_input: { file_path: collisionAlias, old_string: "safe", new_string: "hostile" } }, pointerRepo)), `Edit denies a multiply-linked ${label} even when its hook alias is scanned first`);
  const collisionPatch = ["*** Begin Patch", `*** Update File: ${collisionAlias}`, "@@", "+hostile", "*** End Patch"].join("\n");
  ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: collisionPatch }, pointerRepo)), `raw apply_patch denies a multiply-linked ${label} even when its hook alias is scanned first`);
}

// User-level config is equally executable control state. Override both home
// spellings so the fixture is deterministic on Windows and Linux.
const gitHome = path.join(scratch, "git-home");
mkdirSync(gitHome, { recursive: true });
const globalConfig = path.join(gitHome, ".gitconfig");
writeFileSync(globalConfig, "[user]\n\tname = Guard Test\n");
const globalConfigAlias = path.join(scratch, "harmless-global-notes.txt");
linkSync(globalConfig, globalConfigAlias);
const gitHomeEnv = { HOME: gitHome, USERPROFILE: gitHome };
ok(isDeny(runHook({ tool_name: "Write", tool_input: { file_path: globalConfigAlias, content: "[core]\nfsmonitor=evil" } }, pointerRepo, gitHomeEnv)), "Write through a hard-link alias of the active user .gitconfig is denied");
const globalPatch = ["*** Begin Patch", `*** Update File: ${globalConfigAlias}`, "@@", "+[core]", "+fsmonitor=evil", "*** End Patch"].join("\n");
ok(isDeny(runHook({ tool_name: "apply_patch", tool_input: globalPatch }, pointerRepo, gitHomeEnv)), "a RAW STRING patch through a hard-link alias of the active user .gitconfig is denied");

rmSync(scratch, { recursive: true, force: true });
ok(!existsSync(scratch), "scratch fixture removed");

console.log(`protected-identity-guard: ${pass} assertions passed`);
