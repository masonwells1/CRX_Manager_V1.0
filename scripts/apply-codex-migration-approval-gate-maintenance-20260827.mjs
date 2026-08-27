#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

const root = process.cwd();
const tick = String.fromCharCode(96);
const guardPath = path.join(root, ".codex", "hooks", ["production-action-", "guard.mjs"].join(""));
const guardTestPath = path.join(root, ".codex", "hooks", ["production-action-", "guard.test.mjs"].join(""));
const hooksPath = path.join(root, ".codex", ["hooks", "json"].join("."));
const packagePath = path.join(root, ["package", "json"].join("."));
const parityPath = path.join(root, "scripts", "agent-manifest-parity.mjs");
const workflowCheckPath = path.join(root, "scripts", "check-agent-workflows.mjs");
const oldProducerName = ["apply-live-testdata-", "maintenance-20260812.mjs"].join("");

const expectedBlobs = new Map([
  [guardPath, "b49b0cbda10ac55ad11249aeef50ccecbc06b896"],
  [hooksPath, "db5e8e64d139c46b184c4037d303e986b55832e9"],
  [packagePath, "2af1594fc22e4143c3b64b8444653b057ca46826"],
  [guardTestPath, "f0e0256a03048f2b24aa1911b2656c23a39bc6be"],
  [parityPath, "c407c5766c12b37339b63153db18b1c647cd3525"],
  [workflowCheckPath, "47ab987fd5559381da7c105f7d540144d8a8fe2f"],
]);

function git(args) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[key];
  return execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
}

function normalizedRead(file) { return readFileSync(file, "utf8").replace(/\r\n/g, "\n"); }

function replaceOnce(text, before, after, label) {
  const first = text.indexOf(before);
  if (first < 0 || text.indexOf(before, first + before.length) >= 0) throw new Error(label + " anchor was missing or not unique");
  return text.slice(0, first) + after + text.slice(first + before.length);
}

function write(file, text) { writeFileSync(file, text.endsWith("\n") ? text : text + "\n", "utf8"); }

async function requireExactHeadReview() {
  const head = git(["rev-parse", "HEAD"]);
  const base = git(["rev-parse", "origin/main"]);
  const proofPath = path.join(root, ".claude", "session-state", "codex-review-" + head + ".json");
  const proof = JSON.parse(readFileSync(proofPath, "utf8"));
  const libPath = path.join(root, ".claude", "hooks", "codex-push-lib.mjs");
  const imported = await import(pathToFileURL(libPath).href);
  if (!imported.proofValid(proof, head, Date.now(), base)) throw new Error("fresh exact-head gpt-5.6-sol/high proof is required");
}

if (process.argv.length !== 3 || process.argv[2] !== "--apply") throw new Error("usage: one exact --apply argument is required");
if (git(["status", "--porcelain", "--untracked-files=all"])) throw new Error("worktree must be clean before protected maintenance runs");
for (const [file, expected] of expectedBlobs) {
  const actual = git(["hash-object", file]);
  if (actual !== expected) throw new Error(path.relative(root, file) + " preimage does not match reviewed current-main source");
}
await requireExactHeadReview();

let guard = normalizedRead(guardPath);
const liveLibPath = ["..", "..", ".claude", "hooks", "live-testdata-lib.mjs"].join("/");
const approvalLibPath = ["..", "..", ".claude", "hooks", "codex-migration-approval-lib.mjs"].join("/");
const liveImport = "import { stripCommentsQuoteAware } from \"" + liveLibPath + "\";";
guard = replaceOnce(guard, liveImport, liveImport + "\nimport { claimMigrationApproval } from \"" + approvalLibPath + "\";", "guard approval import");
guard = replaceOnce(
  guard,
  "codex-push-(?:guard|lib)|review-proof-guard|live-testdata-lib",
  "codex-push-(?:guard|lib)|review-proof-guard|live-testdata-lib|codex-migration-approval-(?:lib|prompt)",
  "protected shared-hook list",
);
const maintenanceNeedle = "export function maintenanceProducerCommandMentioned(command) {\n  const compact = String(command || \"\")\n    .toLowerCase()\n    .replace(/[\\s\\\\/\"'" + tick + "^]/g, \"\");\n  return compact.includes(\"" + oldProducerName + "\");\n}\n";
const approvalDetector = "\nexport function migrationApprovalPromptCommandMentioned(command) {\n  const compact = String(command || \"\")\n    .toLowerCase()\n    .replace(/[\\s\\\\/\"'" + tick + "^]/g, \"\");\n  return compact.includes(\"codex-migration-approval-prompt.mjs\");\n}\n";
guard = replaceOnce(guard, maintenanceNeedle, maintenanceNeedle + approvalDetector, "approval prompt invocation detector");
guard = replaceOnce(
  guard,
  "  runGit = defaultRunGit,\n  runGh = defaultRunGh,\n} = {}) {",
  "  runGit = defaultRunGit,\n  runGh = defaultRunGh,\n  sessionId = \"\",\n  turnId = \"\",\n  toolUseId = \"\",\n} = {}) {",
  "guard identity inputs",
);
guard = replaceOnce(
  guard,
  "  if (LIVE_TOOL_ACTIONS.test(name)) {\n    return denied(\"Live migrations, edge-function deployments, and Supabase branch/project lifecycle mutations remain outside Codex's standing authorization.\");\n  }",
  "  if (/(?:^|_)apply_migration$/i.test(name)) {\n    let headSha;\n    try {\n      headSha = runGit([\"rev-parse\", \"HEAD\"], actionRepoDir);\n    } catch (error) {\n      return denied(\"CODEX LIVE MIGRATION APPROVAL: Git HEAD could not be resolved, so the apply is denied (fail closed). \" + (error?.message || error));\n    }\n    const approval = claimMigrationApproval({\n      repoRoot: actionRepoDir,\n      sessionId,\n      turnId,\n      toolUseId,\n      projectId: toolInput.project_id ?? toolInput.projectId ?? \"\",\n      migrationName: toolInput.name ?? \"\",\n      query: toolInput.query ?? \"\",\n      headSha,\n      nowMs,\n    });\n    if (!approval.allowed) {\n      return denied(\"CODEX LIVE MIGRATION APPROVAL: \" + approval.reason + \". Ask Mason for the exact one-line approval sentence after every other migration gate is ready.\");\n    }\n    return { blocked: false };\n  }\n\n  if (LIVE_TOOL_ACTIONS.test(name)) {\n    return denied(\"Live migrations, edge-function deployments, and Supabase branch/project lifecycle mutations remain outside Codex's standing authorization.\");\n  }",
  "apply-migration approval gate",
);
guard = replaceOnce(
  guard,
  "  if (liveApplyScriptMentioned(command)) {",
  "  if (migrationApprovalPromptCommandMentioned(command)) {\n    return denied(\"CODEX LIVE MIGRATION APPROVAL: the approval minting hook cannot be invoked through a shell command. Only the Codex UserPromptSubmit lifecycle may run it.\");\n  }\n  if (liveApplyScriptMentioned(command)) {",
  "manual approval-hook invocation deny",
);
guard = replaceOnce(
  guard,
  "    repoDir: process.env.CODEX_PROJECT_DIR || process.cwd(),\n  });",
  "    repoDir: process.env.CODEX_PROJECT_DIR || process.cwd(),\n    sessionId: payload.session_id ?? \"\",\n    turnId: payload.turn_id ?? \"\",\n    toolUseId: payload.tool_use_id ?? \"\",\n  });",
  "runtime identity forwarding",
);
write(guardPath, guard);

const hooks = JSON.parse(normalizedRead(hooksPath));
const userPromptGroups = hooks?.hooks?.UserPromptSubmit;
if (!Array.isArray(userPromptGroups) || !Array.isArray(userPromptGroups[0]?.hooks)) throw new Error("Codex UserPromptSubmit manifest shape changed");
const promptHookName = "codex-migration-approval-prompt.mjs";
if (JSON.stringify(userPromptGroups).includes(promptHookName)) throw new Error("approval prompt hook is already registered");
const adapterPath = [".codex", "hooks", "codex-hook-adapter.mjs"].join("/");
const sharedPromptPath = [".claude", "hooks", promptHookName].join("/");
const dollar = String.fromCharCode(36);
userPromptGroups[0].hooks.push({
  type: "command",
  command: "node \"" + dollar + "(git rev-parse --show-toplevel)/" + adapterPath + "\" \"" + sharedPromptPath + "\"",
  commandWindows: "powershell -NoProfile -ExecutionPolicy Bypass -Command \"node (Join-Path (git rev-parse --show-toplevel) '" + adapterPath + "') '" + sharedPromptPath + "'\"",
  timeout: 5,
});
write(hooksPath, JSON.stringify(hooks, null, 2));

const pkg = JSON.parse(normalizedRead(packagePath));
const workflowNeedle = "node .codex/hooks/production-action-guard.test.mjs";
if (!String(pkg?.scripts?.["test:agent-workflows"] || "").includes(workflowNeedle)) throw new Error("test:agent-workflows anchor changed");
pkg.scripts["test:agent-workflows"] = pkg.scripts["test:agent-workflows"].replace(workflowNeedle, "node .claude/hooks/codex-migration-approval.test.mjs && " + workflowNeedle);
write(packagePath, JSON.stringify(pkg, null, 2));

let parity = normalizedRead(parityPath);
parity = replaceOnce(
  parity,
  "export const CODEX_ONLY_HOOKS = new Set([]);",
  "export const CODEX_ONLY_HOOKS = new Set([\n  // Codex's live-action guard consumes this hook's same-turn, single-use\n  // approval token. Claude has a separate migration approval boundary.\n  \"codex-migration-approval-prompt.mjs\",\n]);",
  "Codex-only hook declaration",
);
write(parityPath, parity);

let workflowCheck = normalizedRead(workflowCheckPath);
const manifestPathText = [".codex", "hooks.json"].join("/");
const manifestAnchor = "requireIncludes(\"" + manifestPathText + "\", codexHooksText, \"production-action-guard.mjs\");";
workflowCheck = replaceOnce(
  workflowCheck,
  manifestAnchor,
  manifestAnchor + "\nrequireIncludes(\"" + manifestPathText + "\", codexHooksText, \"codex-migration-approval-prompt.mjs\");",
  "workflow approval-hook registration check",
);
write(workflowCheckPath, workflowCheck);

let guardTest = normalizedRead(guardTestPath);
guardTest = replaceOnce(
  guardTest,
  "import { evaluateProductionAction, isClearlyReadOnlySql, pullRequestChecksGreen } from \"./production-action-guard.mjs\";",
  "import { evaluateProductionAction, isClearlyReadOnlySql, pullRequestChecksGreen } from \"./production-action-guard.mjs\";\nimport { CRX_LIVE_PROJECT_ID, mintMigrationApproval } from \"../../.claude/hooks/codex-migration-approval-lib.mjs\";",
  "guard-test approval import",
);
guardTest = replaceOnce(
  guardTest,
  "const { maintenanceProducerCommandMentioned } = await import(\"./production-action-\" + \"guard.mjs\");",
  "const { maintenanceProducerCommandMentioned, migrationApprovalPromptCommandMentioned } = await import(\"./production-action-\" + \"guard.mjs\");",
  "guard-test detector import",
);
guardTest = replaceOnce(
  guardTest,
  "  assert.equal(evaluateProductionAction({ toolName: \"mcp__supabase__apply_migration\" }).blocked, true);\n  assert.equal(evaluateProductionAction({ toolName: \"mcp__supabase__delete_branch\" }).blocked, true);",
  "  assert.equal(evaluateProductionAction({ toolName: \"mcp__supabase__apply_migration\" }).blocked, true);\n  {\n    const migrationName = \"20260827120000_guard_approval_fixture\";\n    const sql = \"select 1;\\n\";\n    const approved = makeRepo(\"supabase/migrations/\" + migrationName + \".sql\", sql);\n    const nowMs = Date.now();\n    mintMigrationApproval({\n      repoRoot: approved.repo,\n      sessionId: \"session-approved\",\n      turnId: \"turn-approved\",\n      projectId: CRX_LIVE_PROJECT_ID,\n      migrationName,\n      headSha: approved.sha,\n      nowMs,\n    });\n    const request = {\n      toolName: \"mcp__supabase__apply_migration\",\n      toolInput: { project_id: CRX_LIVE_PROJECT_ID, name: migrationName, query: sql },\n      repoDir: approved.repo,\n      sessionId: \"session-approved\",\n      turnId: \"turn-approved\",\n      toolUseId: \"tool-approved\",\n      nowMs: nowMs + 1,\n    };\n    assert.equal(evaluateProductionAction(request).blocked, false, \"exact same-turn Mason approval allows one apply\");\n    assert.equal(evaluateProductionAction({ ...request, toolUseId: \"tool-replay\" }).blocked, true, \"approval replay is denied\");\n  }\n  assert.equal(evaluateProductionAction({ toolName: \"mcp__supabase__delete_branch\" }).blocked, true);",
  "guard approved-apply integration test",
);
const producerDeclaration = "  const producerName = \"apply-live-testdata-\" + \"maintenance-20260812.mjs\";";
guardTest = replaceOnce(
  guardTest,
  producerDeclaration,
  "  const approvalPromptName = \"codex-migration-approval-\" + \"prompt.mjs\";\n  assert.equal(migrationApprovalPromptCommandMentioned(\"node .claude/hooks/\" + approvalPromptName), true);\n  assert.equal(\n    evaluateProductionAction({ toolName: \"PowerShell\", toolInput: { command: \"node .claude/hooks/\" + approvalPromptName } }).blocked,\n    true,\n    \"manual invocation of the approval minting hook is denied\",\n  );\n" + producerDeclaration,
  "manual approval-hook invocation test",
);
write(guardTestPath, guardTest);

console.log("Applied reviewed Codex live-migration approval-gate maintenance. Run the full hook tests, then commit and obtain a new exact-head review of the resulting boundary.");
