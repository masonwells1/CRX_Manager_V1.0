#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateProductionAction, isClearlyReadOnlySql, pullRequestChecksGreen } from "./production-action-guard.mjs";
import { CODEX_MERGE_EVIDENCE_BUDGET_MS } from "../../.claude/hooks/codex-push-lib.mjs";

const projectRoot = process.cwd();
// Git exports repository selectors while running hooks. This test creates
// independent temporary repositories, so inherited selectors would make the
// production guard inspect the parent checkout instead of each fixture.
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) {
  delete process.env[key];
}
const guardPath = path.join(projectRoot, ".codex", "hooks", "production-action-guard.mjs");
const claudeGuardPath = path.join(projectRoot, ".claude", "hooks", "codex-push-guard.mjs");
const tempRoots = [];
const { maintenanceProducerCommandMentioned } = await import("./production-action-" + "guard.mjs");

const collectObjects = (value, found = []) => {
  if (!value || typeof value !== "object") return found;
  found.push(value);
  for (const child of Object.values(value)) collectObjects(child, found);
  return found;
};
const codexHooks = JSON.parse(readFileSync(path.join(projectRoot, ".codex", "hooks.json"), "utf8"));
const codexProductionHook = collectObjects(codexHooks).find((entry) => String(entry.command || "").includes("production-action-guard.mjs"));
assert.ok(Number(codexProductionHook?.timeout) * 1000 - CODEX_MERGE_EVIDENCE_BUDGET_MS >= 5_000, "Codex evidence budget leaves at least five seconds for an explicit decision before the outer timeout");

function git(cwd, args) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX", "GIT_COMMON_DIR"]) delete env[key];
  return execFileSync("git", args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function makeRepo(changePath, changeContent) {
  const repo = mkdtempSync(path.join(tmpdir(), "crx-push-guard-"));
  tempRoots.push(repo);
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "guard-test@example.com"]);
  git(repo, ["config", "user.name", "Guard Test"]);
  git(repo, ["remote", "add", "origin", "https://github.com/masonwells1/CRX_Manager_V1.0.git"]);
  writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  git(repo, ["add", "README.md"]);
  git(repo, ["commit", "-m", "base"]);
  git(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(repo, ["switch", "-c", "feature/test"]);
  const target = path.join(repo, ...changePath.split("/"));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, changeContent, "utf8");
  git(repo, ["add", changePath]);
  git(repo, ["commit", "-m", "test change"]);
  return {
    repo,
    sha: git(repo, ["rev-parse", "HEAD"]),
    // origin/main tip the guard resolves + binds the proof's base_sha to.
    base: git(repo, ["rev-parse", "origin/main"]),
  };
}

function proofPath(repo) {
  return path.join(repo, ".claude", "session-state", `codex-review-${git(repo, ["rev-parse", "HEAD"])}.json`);
}

function writeProof(repo, proof) {
  mkdirSync(path.dirname(proofPath(repo)), { recursive: true });
  writeFileSync(proofPath(repo), `${JSON.stringify(proof)}\n`, "utf8");
}

function evaluatePush(repo, nowMs = Date.now(), command = "git push origin HEAD:main") {
  return evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command },
    repoDir: repo,
    nowMs,
    runGh: () => "[]",
  });
}

function runClaudePushGuard(command, projectDir, payloadCwd = "") {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return spawnSync(process.execPath, [claudeGuardPath], {
    cwd: projectRoot,
    env,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "Bash", cwd: payloadCwd || undefined, tool_input: { command } }),
  });
}

try {
  assert.equal(isClearlyReadOnlySql("select count(*) from invoices"), true);
  assert.equal(isClearlyReadOnlySql("select pg_get_functiondef('public.safe()'::regprocedure)"), true);
  assert.equal(isClearlyReadOnlySql("with totals as (select 1) select * from totals"), true);
  assert.equal(isClearlyReadOnlySql("select * from invoices where (status = 'open') and not (balance_cents = 0) order by (created_at)"), true);
  assert.equal(isClearlyReadOnlySql("select i.id from invoices i join customers c on (c.id = i.customer_id) group by (i.id)"), true);
  assert.equal(isClearlyReadOnlySql("update invoices set status = 'paid'"), false);
  assert.equal(isClearlyReadOnlySql("with changed as (delete from invoices returning *) select * from changed"), false);
  assert.equal(isClearlyReadOnlySql("select allocate_payment('x', 100)"), false);
  assert.equal(isClearlyReadOnlySql("select public.\"allocate_payment\"('x', 100)"), false);
  assert.equal(isClearlyReadOnlySql("select set_config('role', 'service_role', true)"), false);
  assert.equal(isClearlyReadOnlySql("select 1; select 2"), false);
  // Codex P1 (2026-08-14): SELECT ... INTO creates and populates a table while
  // beginning with SELECT — it must fail the read-only gate.
  assert.equal(isClearlyReadOnlySql("select * into public.new_table from public.customers"), false);
  assert.equal(isClearlyReadOnlySql("SELECT id INTO TEMP t FROM invoices"), false);
  assert.equal(isClearlyReadOnlySql("select 'into the void'"), true, "the word into inside a string literal stays readable");

  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "select 1" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "delete from invoices" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__delete_branch" }).blocked, true);

  // Sol HIGH (2026-08-14, write-scope review): with the connector write-enabled,
  // every mutating Supabase branch/project lifecycle tool must fail closed —
  // merge_branch/reset_branch/rebase_branch previously returned blocked=false,
  // a route to production schema changes around the migration gates.
  for (const leaf of [
    "merge_branch", "reset_branch", "rebase_branch", "create_branch",
    "create_project", "pause_project", "restore_project", "confirm_cost",
    "apply_migration", "deploy_edge_function", "delete_branch",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: `mcp__supabase__${leaf}` }).blocked,
      true,
      `mutating Supabase tool denied: ${leaf}`,
    );
    // Suffix defense-in-depth: UUID-named app connectors are blocked too.
    assert.equal(
      evaluateProductionAction({ toolName: `mcp__50e15046-cf2c-49da-b8df-ceef27768f63__${leaf}` }).blocked,
      true,
      `mutating Supabase tool denied under app-connector prefix: ${leaf}`,
    );
  }
  // A Supabase tool the guard has never heard of fails CLOSED, not open.
  const unknownSupabase = evaluateProductionAction({ toolName: "mcp__supabase__future_write_tool" });
  assert.equal(unknownSupabase.blocked, true, "unrecognized Supabase tool fails closed");
  assert.match(unknownSupabase.reason, /read-only allowlist/i, "unknown-tool denial names the allowlist");
  // CodeRabbit follow-up: the app connector's UUID prefix must hit the SAME
  // fail-closed allowlist — before this, an unknown tool under the UUID prefix
  // bypassed it and only the suffix blocklist applied.
  const unknownUuidSupabase = evaluateProductionAction({
    toolName: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__future_write_tool",
  });
  assert.equal(unknownUuidSupabase.blocked, true, "unrecognized UUID-connector Supabase tool fails closed");
  assert.match(unknownUuidSupabase.reason, /read-only allowlist/i, "UUID unknown-tool denial names the allowlist");
  // Codex-review follow-up: the built-in codex_apps/supabase channel uses
  // app-style single-underscore names (mcp__codex_apps__supabase_<leaf>) —
  // the channel actually serving Codex traffic per KNOWN_ISSUES. An unknown
  // leaf there must hit the SAME fail-closed allowlist.
  const unknownAppSupabase = evaluateProductionAction({
    toolName: "mcp__codex_apps__supabase_future_write_tool",
  });
  assert.equal(unknownAppSupabase.blocked, true, "unrecognized codex_apps Supabase tool fails closed");
  assert.match(unknownAppSupabase.reason, /read-only allowlist/i, "codex_apps unknown-tool denial names the allowlist");
  // The exact read-only allowlist stays usable under both prefixes.
  for (const leaf of [
    "list_tables", "list_migrations", "list_branches", "list_extensions",
    "list_edge_functions", "get_advisors", "get_project", "get_edge_function",
    "query_logs", "search_docs", "generate_typescript_types",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: `mcp__supabase__${leaf}` }).blocked,
      false,
      `read-only Supabase tool stays allowed: ${leaf}`,
    );
    assert.equal(
      evaluateProductionAction({ toolName: `mcp__50e15046-cf2c-49da-b8df-ceef27768f63__${leaf}` }).blocked,
      false,
      `read-only Supabase tool stays allowed under app-connector prefix: ${leaf}`,
    );
    assert.equal(
      evaluateProductionAction({ toolName: `mcp__codex_apps__supabase_${leaf}` }).blocked,
      false,
      `read-only Supabase tool stays allowed under codex_apps prefix: ${leaf}`,
    );
  }
  // Mutating lifecycle leaves stay blocked under the app-style name too.
  assert.equal(
    evaluateProductionAction({ toolName: "mcp__codex_apps__supabase_apply_migration" }).blocked,
    true,
    "codex_apps apply_migration is denied",
  );
  // codex_apps execute_sql routes to the SQL content gate like the other prefixes.
  assert.equal(
    evaluateProductionAction({
      toolName: "mcp__codex_apps__supabase_execute_sql",
      toolInput: { query: "select count(*) from public.orders" },
    }).blocked,
    false,
    "codex_apps execute_sql with read-only SQL passes the content gate",
  );
  assert.equal(
    evaluateProductionAction({
      toolName: "mcp__codex_apps__supabase_execute_sql",
      toolInput: { query: "delete from public.orders" },
    }).blocked,
    true,
    "codex_apps execute_sql with mutating SQL is denied",
  );
  // execute_sql under the UUID prefix still routes to the SQL content gate:
  // read-only SQL passes, mutating SQL is denied.
  assert.equal(
    evaluateProductionAction({
      toolName: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql",
      toolInput: { query: "select count(*) from public.orders" },
    }).blocked,
    false,
    "UUID-connector execute_sql with read-only SQL passes the content gate",
  );
  assert.equal(
    evaluateProductionAction({
      toolName: "mcp__50e15046-cf2c-49da-b8df-ceef27768f63__execute_sql",
      toolInput: { query: "delete from public.orders" },
    }).blocked,
    true,
    "UUID-connector execute_sql with mutating SQL is denied",
  );
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "vercel --prod" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "npm run build" } }).blocked, false);
  const producerName = "apply-live-testdata-" + "maintenance-20260812.mjs";
  for (const command of [
    `node scripts/${producerName} --verify`,
    `node "scripts/${producerName}" --protect-producer`,
    `node 'scripts/${producerName}' --protect-producer`,
    `node scripts\\${producerName} --verify`,
    `env FLAG=1 node scripts/${producerName} --verify`,
    `cmd /c node scripts\\${producerName} --verify`,
    `node "C:\\repo\\scripts\\${producerName}" --verify`,
    "node --no-warnings scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
    "node --require fs scripts/$(printf apply-live-testdata-maintenance-20260812.mjs) --approved-by-$(printf mason)=2026-08-12",
  ]) {
    assert.equal(maintenanceProducerCommandMentioned(command), true, `producer spelling recognized: ${command}`);
  }
  assert.equal(maintenanceProducerCommandMentioned("node scripts/ordinary-check.mjs"), false);

  const producerWithoutProof = makeRepo(`scripts/${producerName}`, "#!/usr/bin/env node\n");
  const deniedProducerRun = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `node scripts/${producerName} --verify` },
    repoDir: producerWithoutProof.repo,
  });
  assert.equal(deniedProducerRun.blocked, true, "producer execution without exact-head proof is denied");
  assert.match(deniedProducerRun.reason, /exact-SHA adversarial gate/i, "producer denial identifies the required proof");

  const focusedProducerOutput = execFileSync(
    process.execPath,
    [path.join(projectRoot, "scripts", producerName.replace(/\.mjs$/, ".test.mjs"))],
    { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.match(
    focusedProducerOutput,
    /87 classifier assertions \+ 308 producer assertions passed/,
    "the standard guard suite executes the focused producer regression harness",
  );
  assert.equal(evaluateProductionAction({ toolName: "mcp__node_repl__node_repl", toolInput: { code: "1 + 1" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__github__push_files", toolInput: { branch: "main" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__github__create_or_update_file", toolInput: { branch: "main" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__github__delete_file", toolInput: { branch: "main" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__github__get_file_contents", toolInput: { path: "README.md" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: ".claude/session-state/claude-review-push.json" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: ".claude/session-state/codex-review-abc.json" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "echo {} > .claude/session-state/claude-review-push.json" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "cd .claude/session-state" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "printf {} > codex-review-forged.json" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "printf {} > harmless.json", cwd: ".claude/session-state" } }).blocked, true);
  // scripts/apply-migration-file.mjs applies to the LIVE database. Codex's own
  // review of PR #460 found the new script reached production while every other
  // migration path was blocked here (P1). Blocked outright — dry run included —
  // and across the quote/backslash views the shell would run identically.
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node scripts/apply-migration-file.mjs supabase/migrations/x.sql --confirm" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node scripts/apply-migration-file.mjs supabase/migrations/x.sql" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node scripts/apply\"-\"migration-file.mjs x.sql --confirm" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node scripts/apply\\-migration-file.mjs x.sql --confirm" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node ./scripts/apply-migration-file.mjs x.sql" } }).blocked, true);
  // A computed argument never spells the script name, so the literal matcher
  // alone loses to it (CodeRabbit, PR #460 round 2). An interpreter invoked with
  // ANY shell expansion is statically unresolvable and refused.
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "S=scripts/apply-migration-file.mjs; node $S --confirm" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node ${SCRIPT} --confirm" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node $(echo scripts/apply-migration-file.mjs)" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node `echo x.mjs`" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node $env:SCRIPT" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node %SCRIPT%" } }).blocked, true);
  // A literal, statically-readable interpreter command is still fine.
  assert.equal(evaluateProductionAction({ toolName: "Bash", toolInput: { command: "node scripts/check-doc-drift.mjs" } }).blocked, false);
  // Reading or discussing the file is not applying it.
  assert.equal(evaluateProductionAction({ toolName: "Read", toolInput: { file_path: "scripts/apply-migration-file.mjs" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node -e \"require('child_process').execSync('git pu'+'sh origin main')\"" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "echo code | node" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node -" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: ".codex/hooks/production-action-guard.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: "C:\\repo\\.claude\\hooks\\codex-push-guard.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: "C:\\repo\\.codex\\hooks\\production-action-guard.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "repo\\scripts\\run-claude-review.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "scripts/run-claude-review.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Read", toolInput: { file_path: "scripts/run-claude-review.mjs" } }).blocked, false);
  // The Codex-proof producer is protected exactly like the Claude-proof wrapper.
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "scripts/write-codex-push-proof.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: "repo\\scripts\\write-codex-push-proof.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Read", toolInput: { file_path: "scripts/write-codex-push-proof.mjs" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "package.json" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Read", toolInput: { file_path: "package.json" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "scripts/write-apply-proofs.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "scripts/overnight-codex-gate.mjs" } }).blocked, true);
  for (const command of [
    "rm .claude/hooks/review-proof-guard.mjs",
    "rm .claude/hooks/codex-push-guard.mjs;ls",
    "rm .claude/hooks/codex-push-guard.mjs|cat",
    "Remove-Item a.mjs,.claude/hooks/codex-push-guard.mjs",
    "copy x .codex/hooks/production-action-guard.mjs>nul",
    "sed -i s/a/b/ .codex/hooks/production-action-guard.mjs",
    "printf x > .claude/hooks/codex-push-guard.mjs",
    "Set-Item -Path .codex/hooks/production-action-guard.mjs -Value forged",
    "si -Path .codex/hooks/production-action-guard.mjs -Value forged",
    "Get-Content package.json\nSet-Item -Path .claude/hooks/codex-push-guard.mjs -Value forged",
  ]) {
    assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked, true, `natural harness mutation denied: ${command}`);
  }
  assert.equal(evaluateProductionAction({
    toolName: "apply_patch",
    toolInput: { patch: "*** Update File: .codex/hooks/production-action-guard.mjs\n@@\n-old\n+new" },
  }).blocked, true, "structured apply_patch cannot rewrite the production harness");
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: ".claude/hooks/live-testdata-lib.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: ".codex/hooks/codex-hook-adapter.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node scripts/run-claude-review.mjs --scope base-main" } }).blocked, false);

  const ordinary = makeRepo("src/components/Label.tsx", "export const label = 'ordinary';\n");
  assert.equal(evaluatePush(ordinary.repo).blocked, true, "non-risky direct main push is denied in favor of the reviewed PR path");
  const ordinaryClaudeMain = runClaudePushGuard(`git -C "${ordinary.repo}" push origin HEAD:main`, projectRoot);
  assert.match(ordinaryClaudeMain.stdout, /"permissionDecision":"deny"/, "Claude also denies a non-risky direct main push unconditionally");

  const guardrailChange = makeRepo(".claude/hooks/codex-push-lib.mjs", "export const ordinary = true;\n");
  assert.equal(
    evaluatePush(guardrailChange.repo).blocked,
    true,
    "guardrail self-modification requires Sol proof even without risky content keywords",
  );

  const risky = makeRepo("supabase/migrations/20260713000000_test.sql", "select 1;\n");
  const now = Date.now();
  const valid = {
    codex_ran: true,
    verdict: "clean",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    head_sha: risky.sha,
    base_sha: risky.base,
    timestamp: new Date(now).toISOString(),
  };
  const movedShellGuard = runClaudePushGuard("git push origin HEAD:main", ordinary.repo, risky.repo);
  assert.match(movedShellGuard.stdout, /"permissionDecision":"deny"/, "Claude guard inspects the hook payload cwd after a prior shell cd");

  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => JSON.stringify([{ number: 513, autoMergeRequest: null, baseRefName: "main" }]),
  }).blocked, false, "branch pushes stay allowed");
  const inlinePushUrlOverride = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git -c remote.scratch.pushurl=https://github.com/masonwells1/CRX_Manager_V1.0.git push scratch HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    branch: "feature/test",
    runGit: (args) => {
      if (args.join(" ") === "remote get-url --push --all scratch") return "../local-bare.git";
      throw new Error(`inline-config denial must happen before Git lookup: ${args.join(" ")}`);
    },
    runGh: () => { throw new Error("inline-config denial must happen before GitHub lookup"); },
  });
  assert.equal(inlinePushUrlOverride.blocked, true, "inline remote.pushurl cannot turn a local exception into an unattended network push");
  assert.match(inlinePushUrlOverride.reason, /inline Git configuration/i);
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git --config-env=remote.scratch.pushurl=PUSH_URL push scratch HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    branch: "feature/test",
    runGh: () => { throw new Error("--config-env denial must happen before GitHub lookup"); },
  }).blocked, true, "--config-env cannot redirect an unattended feature push");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: {
      command: "git push scratch HEAD:refs/heads/feature/test",
      env: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "remote.scratch.pushurl",
        GIT_CONFIG_VALUE_0: "https://github.com/masonwells1/CRX_Manager_V1.0.git",
      },
    },
    repoDir: risky.repo,
    branch: "feature/test",
    runGh: () => { throw new Error("GIT_CONFIG tool environment denial must happen before GitHub lookup"); },
  }).blocked, true, "GIT_CONFIG tool environments cannot redirect an unattended feature push");
  git(risky.repo, ["config", "url.https://github.com/masonwells1/CRX_Manager_V1.0.git.insteadOf", "C:/review-local"]);
  try {
    const rewrittenLocalPush = evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: "git push C:/review-local HEAD:refs/heads/feature/test" },
      repoDir: risky.repo,
      branch: "feature/test",
      runGh: () => { throw new Error("local-looking destination must deny before GitHub lookup"); },
    });
    assert.equal(rewrittenLocalPush.blocked, true, "a local-looking path cannot bypass the feature-push review gate through insteadOf");
    assert.match(rewrittenLocalPush.reason, /local-looking paths/i, "local-path denial explains the rewrite risk");
  } finally {
    git(risky.repo, ["config", "--unset-all", "url.https://github.com/masonwells1/CRX_Manager_V1.0.git.insteadOf"]);
  }
  const shadowBin = mkdtempSync(path.join(tmpdir(), "crx-delivery-shadow-"));
  tempRoots.push(shadowBin);
  writeFileSync(path.join(shadowBin, "git.exe"), "shadow", "utf8");
  writeFileSync(path.join(shadowBin, "gh.exe"), "shadow", "utf8");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin HEAD:refs/heads/feature/test", env: { PATH: shadowBin, PATHEXT: ".EXE" } },
    repoDir: risky.repo,
    runGh: () => { throw new Error("PATH-shadowed git must deny before GitHub lookup"); },
  }).blocked, true, "PATH-shadowed git cannot perform an unattended feature push");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "C:/attacker/git.exe push origin HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => { throw new Error("arbitrary git path must deny before GitHub lookup"); },
  }).blocked, true, "arbitrary git executable paths cannot perform an unattended feature push");
  git(risky.repo, ["remote", "add", "other", "https://github.com/other/repository.git"]);
  const alternateRemotePush = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push other HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => { throw new Error("alternate repository denial must happen before any PR lookup"); },
  });
  assert.equal(alternateRemotePush.blocked, true, "alternate network repositories are denied so fork PR auto-merge cannot be missed");
  assert.match(alternateRemotePush.reason, /outside the protected CRX upstream repository/);
  const rawAlternateRemotePush = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push https://github.com/other/repository.git HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => { throw new Error("raw alternate repository denial must happen before any PR lookup"); },
  });
  assert.equal(rawAlternateRemotePush.blocked, true, "raw fork or alternate repository URLs are denied");
  assert.match(rawAlternateRemotePush.reason, /outside the protected CRX upstream repository/);
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push other HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => JSON.stringify([{ number: 999, autoMergeRequest: { mergeMethod: "SQUASH" }, baseRefName: "main" }]),
  }).blocked, true, "alternate repository pushes remain denied regardless of its reported PR state");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push https://github.com/masonwells1/CRX_Manager_V1.0.git HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => "[]",
  }).blocked, false, "raw CRX repository URL remains unattended");
  let featurePushLookupArgs = [];
  const preArmedAutoMergePush = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: (args) => {
      featurePushLookupArgs = args;
      return JSON.stringify([{ number: 513, autoMergeRequest: { mergeMethod: "SQUASH" }, baseRefName: "production" }]);
    },
  });
  assert.equal(preArmedAutoMergePush.blocked, true, "an already-armed auto-merge blocks a later feature push");
  assert.match(preArmedAutoMergePush.reason, /gh pr merge 513 --disable-auto/, "denial gives an agent-runnable recovery command");
  assert.deepEqual(
    featurePushLookupArgs,
    ["pr", "list", "--repo", "github.com/masonwells1/crx_manager_v1.0", "--state", "open", "--head", "feature/test", "--json", "number,autoMergeRequest,baseRefName"],
    "feature push lookup binds the open PR query to github.com and the exact destination branch, returning every base for protected-alias filtering",
  );
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin HEAD:refs/heads/feature/test" },
    repoDir: risky.repo,
    runGh: () => { throw new Error("GitHub unavailable"); },
  }).blocked, true, "feature pushes fail closed when auto-merge state cannot be proven");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin refs/heads/*:refs/heads/*" },
    repoDir: risky.repo,
    runGh: () => "[]",
  }).blocked, true, "wildcard branch pushes cannot query GitHub with a fake literal wildcard branch");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin HEAD:refs/heads/feature/test; $verb='merge'; gh pr $verb 513 --auto" },
    repoDir: risky.repo,
    runGh: () => "[]",
  }).blocked, true, "a push chained with an indirect auto-merge action is denied before execution");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "$verb='merge'; gh pr $verb 513 --auto" },
    repoDir: risky.repo,
    runGh: () => "[]",
  }).blocked, true, "a standalone dynamically constructed GitHub merge is denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 513 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789", env: { GH_CONFIG_DIR: "C:/attacker-config" } },
    repoDir: risky.repo,
    runGh: () => { throw new Error("structured GitHub context override must deny before lookup"); },
  }).blocked, true, "a structured GH_CONFIG_DIR override is denied before merge inspection");
  for (const command of [
    "(gh pr merge 513 --auto)",
    "echo <(gh api graphql --input payload.json)",
    "g'h' pr merge 513 --auto",
    "gh p\\r merge 513 --auto",
    "gh pr m\\erge 513 --auto",
    "gh a\\pi graphql --input payload.json",
    "gh p^r merge 513 --auto",
    "gh pr m^erge 513 --auto",
    "gh a^pi graphql --input payload.json",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
      runGh: () => { throw new Error(`escaped command must deny before GitHub lookup: ${command}`); },
    }).blocked, true, `escaped GitHub CLI command denies before parsing: ${command}`);
  }
  for (const command of [
    'powershell -Command "gh pr merge 513 --admin"',
    'cmd /c "gh pr merge 513 --admin"',
    "bash -c 'gh api graphql --input payload.json'",
    "node -e \"require('child_process').execSync('gh pr merge 513 --admin')\"",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
      runGh: () => { throw new Error(`nested command must deny before GitHub lookup: ${command}`); },
    }).blocked, true, `nested GitHub CLI activity denies before parsing: ${command}`);
  }
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `git switch feature/test; gh pr merge --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    runGh: () => mainPrJson,
  }).blocked, true, "a compound selectorless merge cannot inspect pre-switch branch context");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `GH_REPO=other/repo gh pr merge 513 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    runGh: () => mainPrJson,
  }).blocked, true, "GitHub repository environment overrides are denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin :main" },
    repoDir: risky.repo,
  }).blocked, true, "deleting main stays denied");
  for (const command of [
    "git push origin main --force",
    "git push origin main -f",
    "git push origin +HEAD:main",
    "git push origin \"+HEAD:main\"",
    "git -C . push --force origin main",
    "git push origin main --force-with-lease",
    "git push -uf origin main",
    "git push origin feature/test --force",
    "git push --all origin --force",
    "git push origin --all --force",
    "git.exe push origin main --force",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
    }).blocked, true, `force-style main push denied: ${command}`);
  }

  assert.equal(evaluatePush(risky.repo, now, "git.exe push origin HEAD:main").blocked, true, "git.exe main push is gated");
  assert.equal(evaluatePush(risky.repo, now, '"C:\\Program Files\\Git\\cmd\\git.exe" push origin HEAD:main').blocked, true, "quoted full-path git.exe main push is gated");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `cd "${risky.repo}" && git push origin HEAD:main` },
    repoDir: projectRoot,
  }).blocked, true, "directory-changing push chains deny closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "$env:GIT_DIR='C:/other/.git'; git push origin main" },
    repoDir: projectRoot,
  }).blocked, true, "GIT_DIR-prefixed pushes deny closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin main", env: { GIT_WORK_TREE: "C:/other" } },
    repoDir: projectRoot,
  }).blocked, true, "tool environment git context overrides deny closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin HEAD:main", workdir: risky.repo },
    repoDir: projectRoot,
    nowMs: now,
  }).blocked, true, "tool workdir is the repository inspected for a main push");
  for (const command of [
    "git push --all origin",
    "git push origin --branches",
    "git push origin --mirror",
    "git push origin --prune",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
    }).blocked, true, `bulk push denied: ${command}`);
  }

  let claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin HEAD:main`, projectRoot);
  assert.equal(claudeGuard.status, 0);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard inspects the git -C selected worktree");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin feature\/test --force`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard denies force pushes to non-main branches");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push --all origin`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard denies implicit bulk pushes");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin feature/test && git -C "${risky.repo}" push origin HEAD:main`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard inspects every push in a command chain");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin HEAD:refs/heads/feature/test`, projectRoot);
  assert.equal(claudeGuard.stdout, "", "Claude guard still allows an ordinary feature-branch push");
  claudeGuard = runClaudePushGuard(`C:/attacker/git.exe -C "${risky.repo}" push origin HEAD:refs/heads/feature/test`, projectRoot);
  assert.match(claudeGuard.stdout, /trusted Git executable/, "Claude guard denies arbitrary Git executable paths");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push other HEAD:refs/heads/feature/test`, projectRoot);
  assert.match(claudeGuard.stdout, /outside the protected CRX upstream repository/, "Claude guard denies fork and alternate network pushes before PR lookup");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin refs/heads/*:refs/heads/*`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard denies wildcard feature destinations");
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin HEAD:refs/heads/feature/test; $verb='merge'; gh pr $verb 513 --auto`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard requires a feature push to be a standalone command");
  claudeGuard = runClaudePushGuard(`git.exe -C "${risky.repo}" push origin HEAD:main`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard gates git.exe pushes");
  claudeGuard = runClaudePushGuard(`cd "${risky.repo}" && git push origin HEAD:main`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard denies directory-changing push chains");
  claudeGuard = runClaudePushGuard(`$env:GIT_DIR='${risky.repo}\\.git'; git push origin main`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard denies GIT_DIR-prefixed pushes");

  const noOrigin = makeRepo("supabase/migrations/20260713000001_no_origin.sql", "select 1;\n");
  git(noOrigin.repo, ["update-ref", "-d", "refs/remotes/origin/main"]);
  claudeGuard = runClaudePushGuard(`git -C "${noOrigin.repo}" push origin HEAD:main`, projectRoot);
  assert.match(claudeGuard.stdout, /"permissionDecision":"deny"/, "Claude guard fails closed when origin/main is unavailable");

  const missingProof = evaluatePush(risky.repo, now);
  assert.equal(missingProof.blocked, true, "risky direct main push is denied unconditionally");
  assert.match(String(missingProof.reason || ""), /reviewed, green pull-request path/, "direct-main denial routes delivery through the protected PR path");

  writeProof(risky.repo, valid);
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "risky direct main push remains denied even with a valid proof");

  writeProof(risky.repo, { ...valid, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "stale proof denied");

  writeProof(risky.repo, { ...valid, timestamp: new Date(now + 1).toISOString() });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "future-dated proof denied");

  writeProof(risky.repo, { ...valid, head_sha: "f".repeat(40) });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "wrong-SHA proof denied");

  // Base-SHA binding: a proof reviewed against a DIFFERENT origin/main (the base
  // moved after review) is denied even though HEAD, verdict, and freshness are
  // all fine.
  writeProof(risky.repo, { ...valid, base_sha: "e".repeat(40) });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "proof bound to a moved origin/main base is denied");
  // A proof with no base_sha at all fails closed once the guard resolves a base.
  writeProof(risky.repo, {
    codex_ran: true,
    verdict: "clean",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    head_sha: risky.sha,
    timestamp: new Date(now).toISOString(),
  });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "base-less proof fails closed under base binding");

  writeProof(risky.repo, { ...valid, verdict: "ship" });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "wrong-verdict proof denied");
  writeProof(risky.repo, { ...valid, verdict: "blockers-fixed" });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "obsolete blockers-fixed proof denied");

  writeFileSync(proofPath(risky.repo), `\ufeff${JSON.stringify(valid)}`, "utf8");
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "BOM-corrupted proof denied");

  writeFileSync(proofPath(risky.repo), "{not-json", "utf8");
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "malformed proof denied");

  unlinkSync(proofPath(risky.repo));
  const gitCCommand = `git -C "${risky.repo}" push origin HEAD:main`;
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: gitCCommand },
    repoDir: projectRoot,
    nowMs: now,
  }).blocked, true, "git -C main push is caught in the selected repo");

  writeProof(risky.repo, valid);
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: gitCCommand },
    repoDir: projectRoot,
    nowMs: now,
  }).blocked, true, "git -C direct main push remains denied even with proof from the selected repo");
  writeFileSync(proofPath(risky.repo), "{not-json", "utf8");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin feature/test && git push origin HEAD:main" },
    repoDir: risky.repo,
    nowMs: now,
  }).blocked, true, "every push in a chained command is inspected");
  writeProof(risky.repo, valid);
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git --git-dir=.git push origin HEAD:main" },
    repoDir: risky.repo,
  }).blocked, true, "ambiguous explicit git-dir contexts deny closed");

  const greenChecks = [
    { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
    { __typename: "StatusContext", state: "SUCCESS", context: "Vercel" },
  ];
  const mainPr = {
    baseRefName: "main",
    // GitHub's CURRENT base tip. Here it equals local origin/main, the ordinary case.
    baseRefOid: risky.base,
    headRefName: "feature/test",
    headRefOid: risky.sha,
    mergeStateStatus: "CLEAN",
    statusCheckRollup: greenChecks,
  };
  const mainPrJson = JSON.stringify(mainPr);
  const featurePrJson = JSON.stringify({ baseRefName: "develop", headRefName: "feature/test", headRefOid: risky.sha });
  const armedProtectedPrsJson = JSON.stringify([{ number: 513, autoMergeRequest: { mergeMethod: "SQUASH" }, baseRefName: "main" }]);
  const approvedCodeRabbitResponse = (args, headSha) => {
    const joined = args.join(" ");
    if (joined.includes(`/commits/${headSha}/statuses`)) return JSON.stringify([[
      { context: "CodeRabbit", state: "success", description: "Review completed", creator: { id: 136622811 }, updated_at: new Date(now).toISOString() },
    ]]);
    if (joined.includes("/pulls/123/reviews")) return JSON.stringify([[
      { state: "APPROVED", commit_id: headSha, submitted_at: new Date(now).toISOString(), user: { login: "coderabbitai[bot]" } },
    ]]);
    if (joined.includes("/issues/123/comments")) return JSON.stringify([[]]);
    throw new Error(`unexpected GitHub lookup: ${joined}`);
  };
  const runGhWithApprovedCodeRabbit = (args) => args.join(" ").startsWith("pr view ")
    ? mainPrJson
    : approvedCodeRabbitResponse(args, risky.sha);
  let slowEvidenceClock = 0;
  const slowEvidence = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    wallClock: () => slowEvidenceClock,
    runGh: (args) => {
      slowEvidenceClock += 3_000;
      return args.join(" ").startsWith("pr view ") ? mainPrJson : approvedCodeRabbitResponse(args, risky.sha);
    },
  });
  assert.equal(slowEvidence.blocked, true, "cumulative slow GitHub evidence fails closed before the outer Codex hook timeout");
  assert.match(slowEvidence.reason, /budget expired/, "cumulative evidence denial names the exhausted total budget");
  assert.equal(pullRequestChecksGreen(mainPr), true, "clean PR with completed passing checks is green");
  assert.equal(pullRequestChecksGreen({ ...mainPr, mergeStateStatus: "BLOCKED" }), false, "blocked merge state is not green");
  assert.equal(pullRequestChecksGreen({ ...mainPr, statusCheckRollup: [] }), false, "missing checks are not green");
  assert.equal(pullRequestChecksGreen({
    ...mainPr,
    statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }],
  }), false, "pending checks are not green");
  assert.equal(pullRequestChecksGreen({
    ...mainPr,
    statusCheckRollup: [{ __typename: "StatusContext", state: "FAILURE" }],
  }), false, "failed status contexts are not green");

  const stackedMerge = `gh pr merge 456 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}`;
  let stackedLookupArgs = "";
  const stackedMergeBlocked = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: stackedMerge },
    repoDir: risky.repo,
    runGh: (args) => {
      if (args.join(" ").startsWith("pr view ")) return featurePrJson;
      stackedLookupArgs = args.join(" ");
      return armedProtectedPrsJson;
    },
  });
  assert.equal(stackedMergeBlocked.blocked, true, "a stacked PR merge cannot mutate the head of an armed main PR");
  assert.match(stackedMergeBlocked.reason, /disable-auto/, "stacked merge denial gives the automatic recovery action");
  assert.match(stackedLookupArgs, /--head develop/, "stacked merge checks the destination branch before GitHub mutates it");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: stackedMerge },
    repoDir: risky.repo,
    runGh: (args) => args.join(" ").startsWith("pr view ") ? featurePrJson : "[]",
  }).blocked, false, "a stacked PR merge remains unattended when its destination does not feed armed protected auto-merge");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: stackedMerge },
    repoDir: risky.repo,
    runGh: (args) => {
      if (args.join(" ").startsWith("pr view ")) return featurePrJson;
      throw new Error("GitHub unavailable");
    },
  }).blocked, true, "a stacked PR merge fails closed when destination auto-merge state cannot be read");

  const updateBranch = "gh pr update-branch 123 --repo masonwells1/CRX_Manager_V1.0";
  let updateLookupArgs = "";
  const armedUpdate = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: updateBranch },
    repoDir: risky.repo,
    runGh: (args) => {
      if (args.join(" ").startsWith("pr view ")) return mainPrJson;
      updateLookupArgs = args.join(" ");
      return armedProtectedPrsJson;
    },
  });
  assert.equal(armedUpdate.blocked, true, "update-branch cannot mutate the head of an armed main PR");
  assert.match(updateLookupArgs, /--head feature\/test/, "update-branch checks the PR head destination before mutation");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: updateBranch },
    repoDir: risky.repo,
    runGh: (args) => args.join(" ").startsWith("pr view ") ? mainPrJson : "[]",
  }).blocked, false, "update-branch remains unattended when protected auto-merge is disabled");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: updateBranch },
    repoDir: risky.repo,
    runGh: (args) => {
      if (args.join(" ").startsWith("pr view ")) return mainPrJson;
      throw new Error("GitHub unavailable");
    },
  }).blocked, true, "update-branch fails closed when destination auto-merge state cannot be read");
  const rebaseUpdate = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr update-branch 123 --repo masonwells1/CRX_Manager_V1.0 --rebase" },
    repoDir: risky.repo,
    runGh: () => { throw new Error("rebase must deny before GitHub lookup"); },
  });
  assert.equal(rebaseUpdate.blocked, true, "update-branch rebase is denied as an unattended history rewrite");
  assert.match(rebaseUpdate.reason, /rewrites shared remote history/, "rebase denial names the hard history-rewrite boundary");

  for (const foreignPr of [
    { ...mainPr, baseRefName: "main" },
    { ...mainPr, baseRefName: "release" },
  ]) {
    const foreignMerge = evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: `gh pr merge 123 --repo other/repository --squash --match-head-commit ${risky.sha}` },
      repoDir: risky.repo,
      runGh: () => JSON.stringify(foreignPr),
    });
    assert.equal(foreignMerge.blocked, true, `foreign repository merge is denied for ${foreignPr.baseRefName} base`);
    assert.match(foreignMerge.reason, /restricted to masonwells1\/CRX_Manager_V1\.0/, "foreign merge denial names the authorized repository boundary");
  }
  const foreignUpdate = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr update-branch 123 --repo other/repository" },
    repoDir: risky.repo,
    runGh: () => mainPrJson,
  });
  assert.equal(foreignUpdate.blocked, true, "foreign repository update-branch is denied");
  assert.match(foreignUpdate.reason, /restricted to masonwells1\/CRX_Manager_V1\.0/, "foreign update denial names the authorized repository boundary");

  unlinkSync(proofPath(risky.repo));
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: runGhWithApprovedCodeRabbit,
  }).blocked, true, "risky gh merge to main is denied without Sol proof");
  writeProof(risky.repo, valid);
  const missingCodeRabbit = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: (args) => args[0] === "pr" ? mainPrJson : JSON.stringify([[]]),
  });
  assert.equal(missingCodeRabbit.blocked, true, "a green PR without exact-head CodeRabbit evidence is denied");
  assert.match(missingCodeRabbit.reason, /CodeRabbit/, "missing-review denial names the mandatory reviewer");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: runGhWithApprovedCodeRabbit,
  }).blocked, false, "gh PR merge to main uses the same valid proof gate");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `C:/attacker/gh.exe pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => { throw new Error("arbitrary gh path must deny before PR inspection"); },
  }).blocked, true, "arbitrary GitHub CLI paths cannot perform an unattended merge");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}`, env: { PATH: shadowBin, PATHEXT: ".EXE" } },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => { throw new Error("PATH-shadowed gh must deny before PR inspection"); },
  }).blocked, true, "PATH-shadowed GitHub CLI cannot perform an unattended merge");
  const autoMergeDecision = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --auto --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: runGhWithApprovedCodeRabbit,
  });
  assert.equal(autoMergeDecision.blocked, true, "all main-bound auto-merges are denied even with green checks and valid proof");
  assert.match(autoMergeDecision.reason, /later commits could land/, "auto-merge deny names the exact-head race");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `&gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --auto --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: runGhWithApprovedCodeRabbit,
  }).blocked, true, "PowerShell call-operator auto-merge is denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --auto --match-head-commit ${risky.sha} --body --disable-auto` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "disable-auto consumed as body text cannot bypass real auto flag");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr m''erge 123 --repo masonwells1/CRX_Manager_V1.0 --auto --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "empty-quote composed merge token is denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "g`h pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --auto" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => { throw new Error("PowerShell-composed gh must deny before GitHub lookup"); },
  }).blocked, true, "PowerShell-composed gh executable is denied");
  assert.equal(evaluateProductionAction({
    toolName: "Bash",
    toolInput: { command: "g${EMPTY}h pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --auto" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => { throw new Error("POSIX-composed gh must deny before GitHub lookup"); },
  }).blocked, true, "POSIX-composed gh executable is denied");
  const shiftedSelectorDecision = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge --body-file 123 456 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => { throw new Error("noncanonical body-file merge must deny before GitHub lookup"); },
  });
  assert.equal(shiftedSelectorDecision.blocked, true, "body-file option cannot shift the inspected PR selector");
  assert.match(shiftedSelectorDecision.reason, /noncanonical/, "unknown merge option denial names the strict grammar");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --squash # --repo attacker/safe --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => { throw new Error("comment-forged command must deny before GitHub lookup"); },
  }).blocked, true, "PowerShell comment cannot forge repository and head context");
  const missingHeadDecision = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  });
  assert.equal(missingHeadDecision.blocked, true, "main-bound CLI merge without exact-head pin denies");
  assert.match(missingHeadDecision.reason, /--match-head-commit/, "missing exact-head denial gives the pinned retry");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${"f".repeat(40)}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "main-bound CLI merge with mismatched exact-head pin denies");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh api -X PUT repos/masonwells1/CRX_Manager_V1.0/pulls/123/merge -f merge_method=squash -f sha=${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "REST merge route is unsupported even with a visible exact-head sha");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh api -X PUT https://api.github.com/repos/masonwells1/CRX_Manager_V1.0/pulls/123/merge -f merge_method=squash -f sha=${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "full-URL REST merge route is unsupported");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api -X PUT repos/masonwells1/CRX_Manager_V1.0/pulls/123/merge -f merge_method=squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "REST merge without atomic sha denies");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh api -X PUT repos/masonwells1/CRX_Manager_V1.0/pulls/123/merge --input payload.json -f sha=${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "file-backed REST merge cannot override a visible exact-head sha");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"PR_1\"}){pullRequest{id}}}'" },
    repoDir: risky.repo,
  }).blocked, true, "GraphQL mergePullRequest mutations deny closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"PR_1\"}){pullRequest{id}}}'" },
    repoDir: risky.repo,
  }).blocked, true, "GraphQL enablePullRequestAutoMerge mutations deny closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh -R masonwells1/CRX_Manager_V1.0 api graphql -f query='mutation{enablePullRequestAutoMerge(input:{pullRequestId:\"PR_1\"}){pullRequest{id}}}'" },
    repoDir: risky.repo,
  }).blocked, true, "GraphQL auto-merge with global gh flags also denies closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api graphql --input payload.json" },
    repoDir: risky.repo,
  }).blocked, true, "file-backed GraphQL input denies closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api graphql -F query=@mutation.graphql" },
    repoDir: risky.repo,
  }).blocked, true, "file-backed GraphQL query field denies closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api -X PUT repos/masonwells1/CRX_Manager_V1.0/contents/file.txt -f branch=main" },
    repoDir: risky.repo,
  }).blocked, true, "unrecognized mutating gh API calls are denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh -R masonwells1/CRX_Manager_V1.0 api --method PUT repos/masonwells1/CRX_Manager_V1.0/pulls/123/update-branch" },
    repoDir: risky.repo,
  }).blocked, true, "global gh flags cannot hide a REST update-branch mutation");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh -R masonwells1/CRX_Manager_V1.0 api --method PATCH repos/masonwells1/CRX_Manager_V1.0/git/refs/heads/main -f force=true" },
    repoDir: risky.repo,
  }).blocked, true, "global gh flags cannot hide a forced ref update");
  assert.equal(evaluateProductionAction({
    toolName: "Bash",
    toolInput: { command: "curl -X POST https://api.github.com/graphql -d '{\"query\":\"mutation { enablePullRequestAutoMerge(input: {}) }\"}'" },
    repoDir: risky.repo,
  }).blocked, true, "direct GraphQL writers are denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "Invoke-RestMethod -Method Put https://api.github.com/repos/masonwells1/CRX_Manager_V1.0/pulls/123/update-branch" },
    repoDir: risky.repo,
  }).blocked, true, "direct REST branch writers are denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({
      ...mainPr,
      mergeStateStatus: "UNSTABLE",
      statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }],
    }),
  }).blocked, true, "gh PR merge denies when GitHub checks are not green");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    nowMs: now,
    runGh: runGhWithApprovedCodeRabbit,
  }).blocked, false, "full Windows GitHub CLI paths are gated too");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${risky.sha}` },
    repoDir: risky.repo,
    runGh: (args) => args.join(" ").startsWith("pr view ") ? featurePrJson : "[]",
  }).blocked, false, "gh PR merge to a non-production base is allowed");
  assert.equal(evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { owner: "crop", repo: "crx", pull_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "GitHub MCP PR merge denies because its schema cannot atomically pin the inspected head");
  assert.equal(evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { owner: "crop", repo: "crx", pull_number: 123 },
    repoDir: risky.repo,
    runGh: () => { throw new Error("unavailable"); },
  }).blocked, true, "merge target lookup failures deny closed");

  // ── Codex round-2 regressions (2026-07-13 review of this harness) ─────────
  // R2-1: the Codex GitHub app's input spelling is recognized AND the guard
  // verifies the SAME PR number the tool will merge.
  let sawSelector = "";
  assert.equal(evaluateProductionAction({
    toolName: "mcp__codex_apps__github_merge_pull_request",
    toolInput: { repository_full_name: "masonwells1/CRX_Manager_V1.0", pr_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: (args) => { sawSelector = args.join(" "); return mainPrJson; },
  }).blocked, true, "Codex-app merge input spelling is recognized and denied without atomic head support");
  assert.equal(sawSelector, "", "MCP merge is refused before lookup because its schema cannot carry an atomic head SHA");
  assert.equal(evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { unexpected_key: true },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "merge tool without a parseable PR number denies closed");

  // R2-2: attached/alternate gh api method spellings and GraphQL mutations.
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api -XPUT repos/masonwells1/CRX_Manager_V1.0/pulls/123/merge" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, mergeStateStatus: "UNSTABLE" }),
  }).blocked, true, "attached -XPUT gh api merge is gated (denied on non-green checks)");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api --method=POST repos/masonwells1/CRX_Manager_V1.0/pulls/123/merge" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, mergeStateStatus: "UNSTABLE" }),
  }).blocked, true, "non-PUT mutating methods on the merge endpoint are gated too");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: 'gh api graphql -f query="mutation { mergePullRequest(input: {pullRequestId: \\"x\\"}) { clientMutationId } }"' },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "GraphQL merge mutations are denied outright even with a valid proof present");

  // ── Codex round-5 regressions (2026-07-13) ────────────────────────────────
  // R5-1: app-style GitHub tool names (single __github_ prefix) are classified.
  assert.equal(evaluateProductionAction({
    toolName: "mcp__codex_apps__github_create_file",
    toolInput: { path: "src/x.ts", branch: "main" },
  }).blocked, true, "app-style GitHub write tool is denied");
  assert.equal(evaluateProductionAction({
    toolName: "mcp__codex_apps__github_get_file_contents",
    toolInput: { path: "README.md" },
  }).blocked, false, "app-style GitHub read tool stays allowed");
  // R5-2: attached gh field flags imply a mutating (default-POST) API call.
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api graphql -fquery='mutation { mergePullRequest(input: {}) }'" },
    repoDir: risky.repo,
    nowMs: now,
  }).blocked, true, "attached -fquery graphql mutation is denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api repos/masonwells1/CRX_Manager_V1.0/merges -Fbase=main -Fhead=feature" },
    repoDir: risky.repo,
    nowMs: now,
  }).blocked, true, "attached -F field flags make the API call mutating");
  // R5-3: a forged proof whose FILENAME falls outside the path-matcher charset
  // (contains a space) must not be loaded by Claude's push gate either.
  {
    unlinkSync(proofPath(risky.repo));
    mkdirSync(path.join(risky.repo, ".claude", "session-state"), { recursive: true });
    writeFileSync(
      path.join(risky.repo, ".claude", "session-state", "codex-review-forged proof.json"),
      `${JSON.stringify({ codex_ran: true, verdict: "clean", head_sha: risky.sha, timestamp: new Date(now).toISOString() })}\n`,
      "utf8",
    );
    const spacedProofGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin HEAD:main`, projectRoot);
    assert.match(spacedProofGuard.stdout, /"permissionDecision":"deny"/, "space-named forged proof is not loaded by the proof loader");
    unlinkSync(path.join(risky.repo, ".claude", "session-state", "codex-review-forged proof.json"));
    writeProof(risky.repo, valid);
  }
  // R5-4: doc patches that merely MENTION guard/proof paths are allowed;
  // patches whose DESTINATION is a proof or guard file stay denied.
  assert.equal(evaluateProductionAction({
    toolName: "apply_patch",
    toolInput: { patch: "*** Update File: docs/reference/agent-guardrails.md\n+the guard is .codex/hooks/production-action-guard.mjs and writes .claude/session-state/claude-review-push.json" },
  }).blocked, false, "doc patch mentioning protected paths in prose is allowed");
  assert.equal(evaluateProductionAction({
    toolName: "apply_patch",
    toolInput: { patch: "*** Add File: .claude/session-state/claude-review-push.json\n+{}" },
  }).blocked, true, "patch whose destination is a proof file is denied");
  assert.equal(evaluateProductionAction({
    toolName: "apply_patch",
    toolInput: { patch: "*** Update File: .codex/hooks/production-action-guard.mjs\n+weaken()" },
  }).blocked, true, "patch whose destination is the guard itself is denied");

  // ── Codex round-4 regressions (2026-07-13) ────────────────────────────────
  // R4-1: comment markers inside string literals cannot hide a mutation.
  assert.equal(isClearlyReadOnlySql("SELECT '--'; DELETE FROM invoices"), false, "comment-in-string cannot hide DELETE");
  assert.equal(isClearlyReadOnlySql("SELECT '/*'; DROP TABLE invoices"), false, "block-comment-in-string cannot hide DROP");
  assert.equal(isClearlyReadOnlySql("select 'it''s -- fine'"), true, "escaped quote with comment text stays readable");
  // R4-2: gh global/repo flags between gh, pr, and merge are still gated.
  for (const command of [
    "gh -R masonwells1/CRX_Manager_V1.0 pr merge 123",
    "gh pr -R masonwells1/CRX_Manager_V1.0 merge 123",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
      nowMs: now,
      runGh: () => JSON.stringify({ ...mainPr, mergeStateStatus: "UNSTABLE" }),
    }).blocked, true, `flag-separated gh merge is gated: ${command}`);
  }
  // R4-3: single-pipe pipelines run every stage — the later main push is seen.
  {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: "git push origin feature/test | git push origin main --force" },
      repoDir: risky.repo,
      nowMs: now,
    }).blocked, true, "piped force main push is inspected and denied");
    assert.equal(evaluatePush(risky.repo, now).blocked, true, "direct main stays denied independently of the piped force regression");
  }
  // R4-4: abbreviated bulk options are still bulk.
  for (const command of [
    "git push origin --mirr",
    "git push origin --al",
    "git push origin --pru",
    "git push origin --bran",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
      nowMs: now,
    }).blocked, true, `abbreviated bulk push denied: ${command}`);
  }

  // R2-3: option-based deletion of main is DELETE, denied regardless of proof.
  for (const command of [
    "git push origin --delete main",
    "git push origin -d main",
    "git push origin --del main",
    "git push --delete origin main",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
      nowMs: now,
    }).blocked, true, `option-based main deletion denied: ${command}`);
  }
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin --delete feature/test" },
    repoDir: risky.repo,
    nowMs: now,
  }).blocked, true, "deleting a remote feature branch is not unattended delivery");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "git push origin :feature/test" },
    repoDir: risky.repo,
    nowMs: now,
  }).blocked, true, "empty-source remote branch deletion is denied");

  // R2-4: abbreviated force options are force intent, denied despite valid proof.
  for (const command of [
    "git push origin main --force-w",
    "git push origin main --force-with",
    "git push origin main --force-if",
    "git push origin main --force-with-lease=main",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command },
      repoDir: risky.repo,
      nowMs: now,
    }).blocked, true, `abbreviated force main push denied: ${command}`);
  }

  unlinkSync(proofPath(risky.repo));
  const deniedProcess = spawnSync(process.execPath, [guardPath], {
    cwd: risky.repo,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git push origin HEAD:main" } }),
  });
  assert.equal(deniedProcess.status, 0);
  assert.match(deniedProcess.stdout, /"permissionDecision":"deny"/);

  writeProof(risky.repo, valid);
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(proofPath(risky.repo), "utf8")).head_sha, risky.sha);

  const allowedProcess = spawnSync(process.execPath, [guardPath], {
    cwd: risky.repo,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git push origin HEAD:main" } }),
  });
  assert.equal(allowedProcess.status, 0);
  assert.match(allowedProcess.stdout, /"permissionDecision":"deny"/, "direct main stays denied even with a valid proof");

  // --- Codex P1 (2026-07-25): PR merges must bind to GitHub's CURRENT base ---
  // Before this fix resolvePullRequest() never requested baseRefOid and
  // gateMainChange() resolved the base from LOCAL origin/main without fetching, so
  // a stale checkout could clear a risky merge on a proof — and a risk diff —
  // computed against a base the change would never land on.
  // See docs/research/2026-07-25-opus5-harness-review.md §1.1a.
  {
    const stale = makeRepo("supabase/migrations/20260725000000_baseoid.sql", "select 2;\n");
    // GitHub's main has moved ahead; local origin/main still points at the old tip.
    git(stale.repo, ["switch", "-c", "github-main", "origin/main"]);
    writeFileSync(path.join(stale.repo, "README.md"), "github main moved\n", "utf8");
    git(stale.repo, ["add", "README.md"]);
    git(stale.repo, ["commit", "-m", "main moved on github"]);
    const githubBase = git(stale.repo, ["rev-parse", "HEAD"]);
    git(stale.repo, ["switch", "feature/test"]);
    assert.notEqual(githubBase, stale.base, "fixture must model a genuinely moved base");

    const prAt = (baseRefOid) => JSON.stringify({
      baseRefName: "main",
      baseRefOid,
      headRefName: "feature/test",
      headRefOid: stale.sha,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: greenChecks,
    });
    const mergeWith = (json) => {
      const inspected = JSON.parse(json);
      return evaluateProductionAction({
        toolName: "PowerShell",
        toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${inspected.headRefOid}` },
        repoDir: stale.repo,
        nowMs: now,
        runGh: (args) => args[0] === "pr" ? json : approvedCodeRabbitResponse(args, inspected.headRefOid),
      });
    };

    // A proof bound to the STALE local origin/main must no longer pass.
    writeProof(stale.repo, { ...valid, head_sha: stale.sha, base_sha: stale.base });
    const staleAttempt = mergeWith(prAt(githubBase));
    assert.equal(
      staleAttempt.blocked,
      true,
      "proof bound to stale local origin/main is denied when GitHub's base has moved"
    );
    console.log(
      `TRANSCRIPT BASEOID: local origin/main=${stale.base.slice(0, 12)} ` +
      `githubBase=${githubBase.slice(0, 12)} -> stale-bound proof blocked=${staleAttempt.blocked}`
    );

    // Rebinding the proof to GitHub's base is NOT sufficient on its own: this head
    // is still BEHIND that base, so `baseSha...headSha` (three-dot = merge-base..head)
    // silently omits every base-only commit and the review cannot have covered the
    // real merge result. Risky merges must fail closed until the branch is updated.
    // (Codex P1 #2, 2026-07-25 — the earlier revision of this test wrongly expected
    // this case to pass.)
    writeProof(stale.repo, { ...valid, head_sha: stale.sha, base_sha: githubBase });
    const behindBase = mergeWith(prAt(githubBase));
    assert.equal(
      behindBase.blocked,
      true,
      "risky head that does not contain GitHub's base is denied even with a base-bound proof"
    );
    assert.match(
      String(behindBase.reason || behindBase.message || JSON.stringify(behindBase)),
      /does not contain the base/,
      "behind-base denial explains that the branch must be updated"
    );
    console.log(`TRANSCRIPT BASEOID: risky head behind GitHub base -> blocked=${behindBase.blocked}`);

    // Once the branch actually contains the base, the base-bound proof clears it.
    git(stale.repo, ["merge", "--no-edit", "-q", githubBase]);
    const updatedHead = git(stale.repo, ["rev-parse", "HEAD"]);
    writeProof(stale.repo, { ...valid, head_sha: updatedHead, base_sha: githubBase });
    const upToDate = evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${updatedHead}` },
      repoDir: stale.repo,
      nowMs: now,
      runGh: (args) => args[0] === "pr" ? JSON.stringify({
          baseRefName: "main",
          baseRefOid: githubBase,
          headRefName: "feature/test",
          headRefOid: updatedHead,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: greenChecks,
        }) : approvedCodeRabbitResponse(args, updatedHead),
    });
    assert.equal(
      upToDate.blocked,
      false,
      "base-bound proof on a head that contains the base clears the merge gate"
    );
    console.log(`TRANSCRIPT BASEOID: head updated to contain base -> blocked=${upToDate.blocked}`);

    // A base GitHub reports but the checkout does not have must fail closed with
    // actionable guidance, not an opaque git error or a silent pass.
    const absent = "0".repeat(40);
    const missing = mergeWith(prAt(absent));
    assert.equal(missing.blocked, true, "unfetched GitHub base fails closed");
    assert.match(
      String(missing.reason || missing.message || JSON.stringify(missing)),
      /git fetch origin main/,
      "unfetched-base denial tells the caller to fetch"
    );
    console.log(`TRANSCRIPT BASEOID: unfetched GitHub base -> blocked=${missing.blocked} (fetch guidance present)`);

    // Missing baseRefOid entirely (old gh, changed API shape) must fail closed.
    const noBaseOid = mergeWith(JSON.stringify({
      baseRefName: "main",
      headRefName: "feature/test",
      headRefOid: stale.sha,
      mergeStateStatus: "CLEAN",
      statusCheckRollup: greenChecks,
    }));
    assert.equal(noBaseOid.blocked, true, "PR payload without baseRefOid fails closed");

    // The gh query must actually ask for baseRefOid.
    let askedFor = "";
    evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${stale.sha}` },
      repoDir: stale.repo,
      nowMs: now,
      runGh: (args) => {
        if (args[0] === "pr") { askedFor = args.join(" "); return prAt(githubBase); }
        return approvedCodeRabbitResponse(args, stale.sha);
      },
    });
    assert.match(askedFor, /baseRefOid/, "gh pr view requests baseRefOid");

    // A base that is not a full commit id must fail closed: `rev-parse --verify`
    // resolves ref names too, so an abbreviated/symbolic value would otherwise
    // silently bind to a local ref.
    const notASha = mergeWith(prAt("main"));
    assert.equal(notASha.blocked, true, "non-SHA baseRefOid fails closed");
    assert.match(
      String(notASha.reason || notASha.message || JSON.stringify(notASha)),
      /unusable base commit/,
      "non-SHA base denial says the base is unusable"
    );

    // The proof guidance must name the EXACT expected base, not a generic
    // origin/main placeholder, or the operator loops producing rejected proofs.
    // Use the up-to-date head so this reaches the proof requirement rather than
    // stopping at the ancestry gate.
    unlinkSync(proofPath(stale.repo));
    const guidance = String(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: `gh pr merge 123 --repo masonwells1/CRX_Manager_V1.0 --squash --match-head-commit ${updatedHead}` },
      repoDir: stale.repo,
      nowMs: now,
      runGh: (args) => args[0] === "pr" ? JSON.stringify({
          baseRefName: "main",
          baseRefOid: githubBase,
          headRefName: "feature/test",
          headRefOid: updatedHead,
          mergeStateStatus: "CLEAN",
          statusCheckRollup: greenChecks,
        }) : approvedCodeRabbitResponse(args, updatedHead),
    }).reason || "");
    assert.match(guidance, new RegExp(githubBase), "proof guidance states the exact expected base SHA");
    // run-claude-review.mjs reads its base from LOCAL origin/main and never
    // fetches, so without this step the operator loops: the wrapper mints a proof
    // bound to the stale base and the gate rejects it every time.
    assert.match(
      guidance,
      /git fetch origin main/,
      "proof guidance requires fetching origin/main before running the review wrapper"
    );
    assert.doesNotMatch(
      guidance,
      /<origin\/main at review time>/,
      "proof guidance no longer shows the generic origin/main placeholder on a PR merge"
    );
    console.log(`TRANSCRIPT BASEOID: non-SHA base blocked=${notASha.blocked}; guidance names exact base=true`);
  }

  console.log(`TRANSCRIPT DENY (no proof): exit=${deniedProcess.status} stdout=${deniedProcess.stdout}`);
  console.log(`TRANSCRIPT DIRECT-MAIN DENY (even with valid proof): exit=${allowedProcess.status} stdout=${JSON.stringify(allowedProcess.stdout)}`);
  console.log("OK - production action guard checks passed.");
} finally {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
}
