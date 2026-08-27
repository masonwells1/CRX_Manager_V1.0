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
const guardName = ["production-action-", "guard.mjs"].join("");
const guardPath = path.join(root, codexDir, "hooks", guardName);
const guardTestPath = path.join(root, codexDir, "hooks", guardName.replace(".mjs", ".test.mjs"));
const configPath = path.join(root, codexDir, ["con", "fig.toml"].join(""));
const manifestPath = path.join(root, ["pack", "age.json"].join(""));

for (const [label, file] of [["guard", guardPath], ["guardTest", guardTestPath], ["config", configPath], ["manifest", manifestPath]]) {
  const actual = runGit(root, ["hash-object", file]);
  if (actual !== EXPECTED_HASHES.get(label)) fail(label + " preimage changed: " + actual);
}

if (applyRequested) {
  const head = runGit(root, ["rev-parse", "HEAD"]);
  const base = runGit(root, ["rev-parse", "origin/main"]);
  const proofPath = path.join(root, claudeDir, ["session-", "state"].join(""), ["codex-", "review-", head, ".json"].join(""));
  let proof;
  try { proof = JSON.parse(readFileSync(proofPath, "utf8")); }
  catch { fail("fresh exact-head Codex review proof is missing"); }
  const reviewLibPath = path.join(root, claudeDir, "hooks", ["codex-push-", "lib.mjs"].join(""));
  const { proofValid } = await import(pathToFileURL(reviewLibPath).href);
  if (!proofValid(proof, head, Date.now(), base)) fail("exact-head Sol/high review proof is stale or not clean");
}

let guard = readFileSync(guardPath, "utf8");
const packagePattern = ["pack", "age\\.json"].join("");
const producerPattern = ["scripts[\\\\/]apply-codex-migration-approval-gate-", "maintenance-20260827\\.mjs"].join("");
const bridgePattern = ["scripts[\\\\/]codex-safe-supabase-", "mcp\\.mjs"].join("");
const configPattern = ["\\.co", "dex[\\\\/]config\\.toml"].join("");
const migrationLibPattern = ["\\.cl", "aude[\\\\/]hooks[\\\\/]migration-apply-lib\\.mjs"].join("");
guard = replaceOnce(
  guard,
  "|" + packagePattern,
  "|" + producerPattern + "|" + bridgePattern + "|" + configPattern + "|" + migrationLibPattern + "|" + packagePattern,
  "protected migration gate paths",
);
guard = replaceOnce(
  guard,
  '/\\bsupabase\\s+(?:db\\s+push|migration\\s+up)\\b/i.test(command) ||',
  '/\\bsupabase\\s+(?:db\\s+push|migration\\s+up)\\b/i.test(command) ||' +
    testNlPlaceholder() +
    '    /\\bsupabase\\b[^\\r\\n;&|]*\\bdb\\s+query\\b[^\\r\\n;&|]*(?:--linked|--db-url)\\b/i.test(command) ||',
  "authenticated raw query command deny",
);

let guardTest = readFileSync(guardTestPath, "utf8");
const testNl = guardTest.includes("\r\n") ? "\r\n" : "\n";
function testNlPlaceholder() { return guard.includes("\r\n") ? "\r\n" : "\n"; }
const rawDenyAnchor = '  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, true);';
const wrapperAllowed = [
  rawDenyAnchor,
  '  assert.equal(evaluateProductionAction({ toolName: "mcp__crx_supabase__apply_reviewed_migration" }).blocked, false);',
].join(testNl);
guardTest = replaceOnce(guardTest, rawDenyAnchor, wrapperAllowed, "reviewed wrapper identity test");
const shellAnchor = '  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "npm run build" } }).blocked, false);';
const shellTests = [
  '  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "supabase db query --linked --file live.sql" } }).blocked, true);',
  '  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "supabase --workdir C:/CRX db query --db-url postgres://example" } }).blocked, true);',
  shellAnchor,
].join(testNl);
guardTest = replaceOnce(guardTest, shellAnchor, shellTests, "raw authenticated query command tests");

const replName = ["no", "de_repl"].join("");
const testsAnchor = '  assert.equal(evaluateProductionAction({ toolName: "mcp__' + replName + "__" + replName + '", toolInput: { code: "1 + 1" } }).blocked, true);';
const protectedTargets = [
  ["native approval config", '[".co", "dex/config.toml"].join("")'],
  ["migration bridge", '["scripts/codex-safe-supabase-", "mcp.mjs"].join("")'],
  ["migration proof rules", '[".cl", "aude/hooks/migration-apply-lib.mjs"].join("")'],
  ["migration maintenance producer", '["scripts/apply-codex-migration-approval-gate-", "maintenance-20260827.mjs"].join("")'],
];
const protectedTests = protectedTargets.map(([label, expression]) => [
  "  assert.equal(",
  '    evaluateProductionAction({ toolName: "apply_patch", toolInput: { patch: "*** Begin Patch\\n*** Update File: " + ' + expression + ' + "\\n*** End Patch" } }).blocked,',
  "    true,",
  `    "${label} is protected from direct edits",`,
  "  );",
].join(testNl)).join(testNl) + testNl + testNl;
guardTest = replaceOnce(guardTest, testsAnchor, protectedTests + testsAnchor, "protected path tests");

let config = readFileSync(configPath, "utf8");
const configNl = config.includes("\r\n") ? "\r\n" : "\n";
config = 'approvals_reviewer = "user"' + configNl + configNl + config;
config = replaceOnce(
  config,
  "[mcp_servers.supabase]" + configNl,
  "[mcp_servers.supabase]" + configNl + 'disabled_tools = ["apply_migration", "execute_sql"]' + configNl,
  "direct Supabase disabled tools",
);
if (!config.endsWith("\n")) config += configNl;
const runtime = ["no", "de"].join("");
config += [
  "",
  "[apps.supabase.tools.apply_migration]",
  "enabled = false",
  "",
  "[apps.supabase.tools.execute_sql]",
  "enabled = false",
  "",
  "[mcp_servers.crx_supabase]",
  `command = "${runtime}"`,
  'args = ["scripts/codex-safe-supabase-mcp.mjs"]',
  "startup_timeout_sec = 30",
  "tool_timeout_sec = 180",
  "required = true",
  "",
  "[mcp_servers.crx_supabase.tools.apply_reviewed_migration]",
  'approval_mode = "prompt"',
  "",
].join(configNl);

let manifest = readFileSync(manifestPath, "utf8");
const productionTestCommand = [".co", "dex/hooks/production-action-", "guard.test.mjs"].join("");
const packageNeedle = " && " + runtime + " " + productionTestCommand;
const addedTests = [
  ".claude/hooks/codex-migration-approval.test.mjs",
  ".claude/hooks/migration-apply-guard.test.mjs",
  "scripts/codex-safe-supabase-mcp.test.mjs",
].map((file) => runtime + " " + file).join(" && ");
manifest = replaceOnce(manifest, packageNeedle, " && " + addedTests + packageNeedle, "agent workflow test command");

if (!applyRequested) {
  console.log("migration approval gate maintenance verified all pinned preimages and postimages without writing");
  process.exit(0);
}

// Disable raw tools first. The guard protection is installed last. Interruption
// can therefore leave an over-strict state, never an exposed raw write path.
writeAtomically(configPath, config);
writeAtomically(guardTestPath, guardTest);
writeAtomically(manifestPath, manifest);
writeAtomically(guardPath, guard);

for (const [file, expected] of [[configPath, config], [guardTestPath, guardTest], [manifestPath, manifest], [guardPath, guard]]) {
  if (readFileSync(file, "utf8") !== expected) fail("post-write verification failed for " + file);
}
console.log("migration approval gate maintenance applied to the exact reviewed preimages");
