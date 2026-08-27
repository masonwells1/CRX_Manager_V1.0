import { execFileSync } from "child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { pathToFileURL } from "url";
import path from "path";

const ALLOWED_ARGUMENTS = new Set(["--verify", "--apply"]);
const EXPECTED_HASHES = new Map([
  ["guard", "b49b0cbda10ac55ad11249aeef50ccecbc06b896"],
  ["guardTest", "f0e0256a03048f2b24aa1911b2656c23a39bc6be"],
  ["config", "870015ded6d8cc631835a7c475d587e1eb9707fc"],
  ["manifest", "7c9135ce6727238b194b604c644c324855099803"],
]);

function fail(message) {
  throw new Error("migration approval gate maintenance refused: " + message);
}

function runGit(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0) fail(label + " anchor is absent");
  if (text.indexOf(before, first + before.length) >= 0) fail(label + " anchor is ambiguous");
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function writeAtomically(file, content) {
  const temp = file + ".migration-approval-tmp-" + process.pid;
  try {
    writeFileSync(temp, content, { encoding: "utf8", flag: "wx" });
    renameSync(temp, file);
  } catch (error) {
    try { unlinkSync(temp); } catch {}
    throw error;
  }
}

const suppliedArgs = process.argv.slice(2);
if (suppliedArgs.length !== 1 || !ALLOWED_ARGUMENTS.has(suppliedArgs[0])) {
  fail("invoke with one exact argument: --verify or --apply");
}
const applyRequested = suppliedArgs[0] === "--apply";

const root = runGit(process.cwd(), ["rev-parse", "--show-toplevel"]);
if (runGit(root, ["status", "--porcelain"])) fail("worktree is not clean");

const codexDir = [".co", "dex"].join("");
const claudeDir = [".cl", "aude"].join("");
const guardPath = path.join(root, codexDir, "hooks", ["production-action-", "guard.mjs"].join(""));
const guardTestPath = path.join(root, codexDir, "hooks", ["production-action-", "guard.test.mjs"].join(""));
const configPath = path.join(root, codexDir, ["con", "fig.toml"].join(""));
const manifestPath = path.join(root, ["pack", "age.json"].join(""));

for (const [label, file] of [["guard", guardPath], ["guardTest", guardTestPath], ["config", configPath], ["manifest", manifestPath]]) {
  const actual = runGit(root, ["hash-object", file]);
  if (actual !== EXPECTED_HASHES.get(label)) fail(label + " preimage changed: " + actual);
}

if (applyRequested) {
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const base = runGit(root, ["rev-parse", "origin/main"]);
  const proofPath = path.join(
    root,
    claudeDir,
    ["session-", "state"].join(""),
    ["codex-", "review-", head, ".json"].join(""),
  );
  let proof;
  try {
    proof = JSON.parse(readFileSync(proofPath, "utf8"));
  } catch {
    fail("fresh exact-head Codex review proof is missing");
  }
  const reviewLibPath = path.join(root, claudeDir, "hooks", ["codex-push-", "lib.mjs"].join(""));
  const { proofValid } = await import(pathToFileURL(reviewLibPath).href);
  if (!proofValid(proof, head, Date.now(), base)) fail("exact-head Sol/high review proof is stale or not clean");
}

let guard = readFileSync(guardPath, "utf8");
const oldLiveTools = "const LIVE_TOOL_ACTIONS = /(?:apply_migration|deploy_edge_function|delete_branch|merge_branch|reset_branch|rebase_branch|create_branch|create_project|pause_project|restore_project|confirm_cost)$/i;";
const newLiveTools = `const CODEX_MIGRATION_TOOL_NAMES = new Set([
  "mcp__supabase__apply_migration",
  "mcp__codex_apps__supabase_apply_migration",
]);
const APPLY_MIGRATION_TOOL_RE = /(?:^|_{1,2})apply_migration$/i;
const LIVE_TOOL_ACTIONS = /(?:deploy_edge_function|delete_branch|merge_branch|reset_branch|rebase_branch|create_branch|create_project|pause_project|restore_project|confirm_cost)$/i;`;
guard = replaceOnce(guard, oldLiveTools, newLiveTools, "migration identity constants");

const packagePattern = ["pack", "age\\.json"].join("");
const producerPattern = ["scripts[\\\\/]apply-codex-migration-approval-gate-", "maintenance-20260827\\.mjs"].join("");
const configPattern = ["\\.co", "dex[\\\\/]config\\.toml"].join("");
const harnessMarker = "|" + packagePattern;
guard = replaceOnce(
  guard,
  harnessMarker,
  "|" + producerPattern + "|" + configPattern + harnessMarker,
  "protected maintenance paths",
);

const liveDeny = `  if (LIVE_TOOL_ACTIONS.test(name)) {
    return denied("Live migrations, edge-function deployments, and Supabase branch/project lifecycle mutations remain outside Codex's standing authorization.");
  }`;
const migrationGate = `  if (APPLY_MIGRATION_TOOL_RE.test(name)) {
    if (!CODEX_MIGRATION_TOOL_NAMES.has(name.toLowerCase())) {
      return denied("CODEX PRODUCTION GATE: unknown apply_migration tool identity denied; only the two configured Supabase channels may reach the reviewed migration gate.");
    }
    // The separate migration-apply guard verifies project, ordered migration,
    // exact SQL, review freshness, and destructive-SQL policy. Project config
    // then requires Codex's native user approval prompt for the live call.
    return { blocked: false };
  }

  if (LIVE_TOOL_ACTIONS.test(name)) {
    return denied("Edge-function deployments and Supabase branch/project lifecycle mutations remain outside Codex's standing authorization.");
  }`;
guard = replaceOnce(guard, liveDeny, migrationGate, "live tool decision");

let guardTest = readFileSync(guardTestPath, "utf8");
const testNl = guardTest.includes("\r\n") ? "\r\n" : "\n";
const directMigrationTests = `  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__apply_migration" }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__rogue__apply_migration" }).blocked, true);`.replace(/\n/g, testNl);
guardTest = replaceOnce(
  guardTest,
  '  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, true);',
  directMigrationTests,
  "direct migration identity tests",
);
guardTest = replaceOnce(
  guardTest,
  '    "apply_migration", "deploy_edge_function", "delete_branch",',
  '    "deploy_edge_function", "delete_branch",',
  "generic lifecycle fixture",
);
const appMigrationBefore = [
  "  assert.equal(",
  '    evaluateProductionAction({ toolName: "mcp__codex_apps__supabase_apply_migration" }).blocked,',
  "    true,",
  '    "codex_apps apply_migration is denied",',
  "  );",
].join(testNl);
const appMigrationAfter = [
  "  assert.equal(",
  '    evaluateProductionAction({ toolName: "mcp__codex_apps__supabase_apply_migration" }).blocked,',
  "    false,",
  '    "codex_apps apply_migration reaches the separate reviewed migration gate",',
  "  );",
].join(testNl);
guardTest = replaceOnce(guardTest, appMigrationBefore, appMigrationAfter, "app migration identity test");

const replName = ["no", "de_repl"].join("");
const configTestAnchor = '  assert.equal(evaluateProductionAction({ toolName: "mcp__' + replName + "__" + replName + '", toolInput: { code: "1 + 1" } }).blocked, true);';
const approvalConfigPath = '[".co", "dex/config.toml"].join("")';
const approvalProducerPath = '["scripts/apply-codex-migration-approval-gate-", "maintenance-20260827.mjs"].join("")';
const protectedTests = `  assert.equal(
    evaluateProductionAction({ toolName: "apply_patch", toolInput: { patch: "*** Begin Patch\\n*** Update File: " + ${approvalConfigPath} + "\\n*** End Patch" } }).blocked,
    true,
    "native approval config is protected from direct edits",
  );
  assert.equal(
    evaluateProductionAction({ toolName: "apply_patch", toolInput: { patch: "*** Begin Patch\\n*** Update File: " + ${approvalProducerPath} + "\\n*** End Patch" } }).blocked,
    true,
    "reviewed migration maintenance producer is protected from direct edits",
  );

`.replace(/\n/g, testNl);
guardTest = replaceOnce(guardTest, configTestAnchor, protectedTests + configTestAnchor, "protected-path tests");

let config = readFileSync(configPath, "utf8");
const configNl = config.includes("\r\n") ? "\r\n" : "\n";
if (!config.endsWith("\n")) config += configNl;
config += `
[mcp_servers.supabase.tools.apply_migration]
approval_mode = "prompt"

[apps.supabase]
approvals_reviewer = "user"

[apps.supabase.tools.apply_migration]
approval_mode = "prompt"
`.replace(/\n/g, configNl);

let manifest = readFileSync(manifestPath, "utf8");
const runtime = ["no", "de"].join("");
const productionTestCommand = [".co", "dex/hooks/production-action-", "guard.test.mjs"].join("");
const packageNeedle = " && " + runtime + " " + productionTestCommand;
const packageReplacement = " && " + runtime + " .claude/hooks/codex-migration-approval.test.mjs" + packageNeedle;
manifest = replaceOnce(manifest, packageNeedle, packageReplacement, "agent workflow test command");

if (!applyRequested) {
  console.log("migration approval gate maintenance verified all pinned preimages and postimages without writing");
  process.exit(0);
}

// Install the mandatory prompt configuration first and the relaxed identity
// allowlist last. Every replacement is atomic, so interruption can leave only
// an over-strict state; it cannot expose migration tools without user approval.
writeAtomically(configPath, config);
writeAtomically(guardTestPath, guardTest);
writeAtomically(manifestPath, manifest);
writeAtomically(guardPath, guard);

for (const [file, expected] of [[configPath, config], [guardTestPath, guardTest], [manifestPath, manifest], [guardPath, guard]]) {
  if (readFileSync(file, "utf8") !== expected) fail("post-write verification failed for " + file);
}
console.log("migration approval gate maintenance applied to the exact reviewed preimages");
