#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { canonicalizeGuardPath, evaluateProductionAction, isClearlyReadOnlySql, mutatingSegmentWithComputedText, pullRequestChecksGreen } from "./production-action-guard.mjs";

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
  assert.equal(evaluatePush(ordinary.repo).blocked, false, "non-risky main push allowed without proof");

  // ── codex-bot-review-lib is guard-critical: it is IMPORTED at startup ──────
  // Codex HIGH on PR #563's own exact-head review: the module was reachable by
  // apply_patch (blocked:false) while the identical patch against
  // production-action-guard.mjs was blocked:true. Because it executes at import
  // time, an allowed edit could keep its exports intact and still terminate or
  // subvert the hook before it reads any input — and silent completion means
  // ALLOW, so that bypasses every production-action restriction, not just the
  // review check. Every write channel must refuse it.
  for (const tool of ["Write", "Edit", "NotebookEdit", "apply_patch"]) {
    assert.equal(
      evaluateProductionAction({ toolName: tool, toolInput: { file_path: ".claude/hooks/codex-bot-review-lib.mjs" } }).blocked,
      true,
      `${tool} against codex-bot-review-lib.mjs must be blocked — the guard imports it at startup`,
    );
  }
  // Path spelling must not be an escape: separators, ./ prefix, and case.
  for (const spelling of [
    ".claude\\hooks\\codex-bot-review-lib.mjs",
    "./.claude/hooks/codex-bot-review-lib.mjs",
    ".CLAUDE/HOOKS/CODEX-BOT-REVIEW-LIB.MJS",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "Write", toolInput: { file_path: spelling } }).blocked,
      true,
      `alternate spelling must still be blocked: ${spelling}`,
    );
  }
  // ...and the shell path, not only the file tools.
  for (const command of [
    'echo x > .claude/hooks/codex-bot-review-lib.mjs',
    'cp /tmp/evil.mjs .claude/hooks/codex-bot-review-lib.mjs',
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `shell write must be blocked: ${command}`,
    );
  }
  // The test file itself is NOT guard-critical — nothing imports it at runtime —
  // so protection must not have been widened into a blanket directory ban.
  assert.equal(
    evaluateProductionAction({ toolName: "Write", toolInput: { file_path: ".claude/hooks/codex-bot-review-lib.test.mjs" } }).blocked,
    false,
    "the test file stays editable; protection is scoped to the imported module, not the whole directory",
  );

  // ── dot-segment detours must not buy a different verdict ──────────────────
  // Codex HIGH, PR #563 round 2: the matcher compared raw strings, so
  // `.claude/hooks/../hooks/<file>` — the same file, confirmed with
  // Resolve-Path — was ALLOWED through Write, apply_patch and PowerShell while
  // the direct spelling was blocked. This was never specific to one module:
  // every protected entry had the hole.
  for (const alias of [
    ".claude/hooks/../hooks/codex-bot-review-lib.mjs",
    ".claude/hooks/./codex-bot-review-lib.mjs",
    ".claude/./hooks/../hooks/codex-bot-review-lib.mjs",
    ".claude\\hooks\\..\\hooks\\codex-bot-review-lib.mjs",
    "./.claude/hooks/../../.claude/hooks/codex-bot-review-lib.mjs",
    ".codex/hooks/../../.claude/hooks/codex-push-lib.mjs",
    "scripts/../scripts/write-codex-push-proof.mjs",
  ]) {
    for (const tool of ["Write", "Edit", "apply_patch"]) {
      assert.equal(
        evaluateProductionAction({ toolName: tool, toolInput: { file_path: alias } }).blocked,
        true,
        `${tool} must resolve the detour and block: ${alias}`,
      );
    }
  }
  // Canonicalization must not over-block: a genuinely different file that merely
  // sits near a protected one stays editable.
  for (const innocent of [
    ".claude/hooks/../hooks/some-other-lib.mjs",
    ".claude/hooks/../../src/components/Label.tsx",
    "docs/../docs/manual/DECISION_LOG.md",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "Write", toolInput: { file_path: innocent } }).blocked,
      false,
      `canonicalization must not over-block an unrelated path: ${innocent}`,
    );
  }
  assert.equal(canonicalizeGuardPath(".claude/hooks/../hooks/x.mjs"), ".claude/hooks/x.mjs", "dot-segments resolve");
  assert.equal(canonicalizeGuardPath(".claude\\hooks\\x.mjs"), ".claude/hooks/x.mjs", "separators unify");
  assert.equal(canonicalizeGuardPath("./a/./b/../c"), "a/c", "leading ./ and interior .. resolve");
  assert.equal(canonicalizeGuardPath("../outside/x.mjs"), "../outside/x.mjs", "a leading .. stays meaningful in a relative path");
  assert.equal(canonicalizeGuardPath("/a/../../b"), "/b", "cannot escape above a rooted path");
  assert.equal(canonicalizeGuardPath(""), "", "empty stays empty");
  // Codex round 3 escapes: an interior `./` and a Windows DRIVE-RELATIVE alias
  // (`C:.claude/...`, no slash after the colon) both wrote to protected files.
  // The drive prefix left `.claude` preceded by `:`, which the protected anchor
  // never matched. These are the exact payloads it demonstrated.
  for (const alias of [
    "C:.claude/hooks/codex-bot-review-lib.mjs",
    "c:.claude/hooks/codex-push-lib.mjs",
    "C:.codex/hooks.json",
    "D:scripts/write-codex-push-proof.mjs",
    "C:/repo/.claude/hooks/codex-push-lib.mjs",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "Write", toolInput: { file_path: alias } }).blocked,
      true,
      `drive-qualified alias must be blocked: ${alias}`,
    );
  }
  assert.equal(canonicalizeGuardPath("C:.claude/hooks/x.mjs"), ".claude/hooks/x.mjs", "a drive-RELATIVE prefix is dropped");
  assert.equal(canonicalizeGuardPath("C:/repo/x.mjs"), "/repo/x.mjs", "a drive-ROOTED prefix keeps its root");

  // ...and the shell channel, which cannot be canonicalized as a single path.
  for (const command of [
    'echo x > .claude/hooks/../hooks/codex-bot-review-lib.mjs',
    'cp /tmp/evil.mjs .claude/hooks/../hooks/codex-push-lib.mjs',
    'Set-Content -Path .codex/hooks/../hooks/production-action-guard.mjs -Value ""',
    // Interior `./` — walked past the first cut's `../`-only sniffing.
    'Set-Content .claude/hooks/./codex-push-lib.mjs -Value ""',
    'Set-Content scripts/./write-codex-push-proof.mjs -Value ""',
    'Set-Content .codex/./hooks.json -Value ""',
    'Set-Content -Path "C:.claude/hooks/codex-bot-review-lib.mjs" -Value ""',
    'rm ./.claude/./hooks/codex-push-lib.mjs',
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `shell dot-segment detour must be refused: ${command}`,
    );
  }
  // A read through a dot-segment is still fine — only MUTATING commands are refused.
  assert.equal(
    evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "cat .claude/hooks/../hooks/codex-bot-review-lib.mjs" } }).blocked,
    false,
    "reading through a detour stays allowed; only mutation is refused",
  );

  // ── round 4: characters the shell DELETES, not ones it splits on ───────────
  // Codex HIGH, PR #563 round 4. Round 3 treated quotes and the backtick as
  // argument SEPARATORS. PowerShell treats them as no-ops inside a word: it
  // removes them and joins what remains. So splicing one into the middle of a
  // protected path split one blocked token into two harmless ones, and the
  // write went through. Codex confirmed with PowerShell's own parser that both
  // of these resolve to `.claude/hooks/codex-push-lib.mjs`, and measured
  // `blocked:false` on each.
  //
  // The backtick is built from a char code so this fixture cannot be broken by
  // an editor or a template-literal escape silently eating it.
  const BACKTICK = String.fromCharCode(96);
  for (const command of [
    `Set-Content .claude/hooks/codex-push-${BACKTICK}lib.mjs -Value ""`,
    'Set-Content .claude/hooks/codex-push-""lib.mjs -Value ""',
    `Set-Content .claude/hooks/codex-bot-review-${BACKTICK}lib.mjs -Value ""`,
    "Set-Content .claude/hooks/codex-bot-review-''lib.mjs -Value \"\"",
    // The splice can land anywhere in the path, including the directory part.
    `Set-Content .claude/${BACKTICK}hooks/codex-push-lib.mjs -Value ""`,
    'rm .codex/""hooks.json',
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `an intra-word quote/escape splice must be refused: ${command}`,
    );
  }
  // Still a read, still allowed — the splice must not turn reads into denials.
  assert.equal(
    evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: `cat .claude/hooks/codex-push-${BACKTICK}lib.mjs` } }).blocked,
    false,
    "a spliced READ stays allowed; only mutation is refused",
  );
  // NEAR-MISS CANARY for the de-quoted view. Quoted fragments separated by real
  // whitespace are two arguments, not concatenation — removing the quotes must
  // not fuse them into a protected path. Without this, "strip all quotes and
  // look for the path anywhere" would pass the tests above while blocking
  // ordinary commands that merely mention the directory and the file apart.
  assert.equal(
    evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: 'Set-Content out.txt -Value ".claude/hooks/" "codex-push-lib.mjs"' },
    }).blocked,
    false,
    "whitespace-separated quoted fragments are NOT concatenation and must stay allowed",
  );

  // ── round 7: Windows ignores trailing periods and spaces in a segment ──────
  // Codex HIGH, PR #563 round 7 (exact-SHA proof of the merged-up head). The
  // Win32 path normalizer strips trailing periods and spaces from a segment
  // before the file system sees it, so `.claude./hooks/x.mjs`,
  // `.claude/hooks./x.mjs` and `.claude/hooks/x.mjs.` all open
  // `.claude/hooks/x.mjs` — probe-confirmed with Get-Item on each spelling.
  // The canonicalizer knew `.`/`..` and drive prefixes and nothing else, so
  // every one of these resolved to a protected file and returned blocked:false.
  // These are the exact payloads Codex demonstrated, plus the trailing-space
  // and multi-period forms Windows treats the same way.
  for (const alias of [
    ".claude./hooks/codex-bot-review-lib.mjs",
    ".claude/hooks./codex-bot-review-lib.mjs",
    ".claude/hooks/codex-bot-review-lib.mjs.",
    ".claude/hooks/codex-bot-review-lib.mjs...",
    ".claude/hooks/codex-bot-review-lib.mjs. .",
    ".codex./hooks/production-action-guard.mjs",
    ".codex/hooks.json.",
    "scripts./write-codex-push-proof.mjs",
    "package.json.",
    ".claude./hooks/../hooks./codex-push-lib.mjs.",
    "C:.claude./hooks/codex-push-lib.mjs.",
  ]) {
    for (const tool of ["Write", "Edit", "apply_patch"]) {
      assert.equal(
        evaluateProductionAction({ toolName: tool, toolInput: { file_path: alias } }).blocked,
        true,
        `${tool} must strip Windows trailing periods/spaces and block: ${alias}`,
      );
    }
  }
  assert.equal(canonicalizeGuardPath(".claude./hooks./x.mjs."), ".claude/hooks/x.mjs", "trailing periods vanish from every segment");
  assert.equal(canonicalizeGuardPath(".claude/hooks/x.mjs. ."), ".claude/hooks/x.mjs", "trailing period/space mixes vanish too");
  assert.equal(canonicalizeGuardPath("a/.../b"), "a/b", "an all-period segment is dropped (over-inclusive by design)");
  // `.. ` is NOT a parent hop: Windows refuses to resolve a segment made only
  // of periods and spaces (probe-confirmed), and POSIX reads it as a literal
  // name. Dropping it shortens the path toward a protected suffix, which is
  // the deny direction, and — the part that matters — the exact `..` above
  // still hops, so the strip never eats a real parent reference.
  assert.equal(canonicalizeGuardPath("a/b/.. /c"), "a/b/c", "a period/space-only segment is dropped, not mistaken for `..`");
  assert.equal(canonicalizeGuardPath("a/b/../c"), "a/c", "the exact `..` still hops to the parent");
  assert.equal(canonicalizeGuardPath("../x.mjs."), "../x.mjs", "a leading `..` survives the strip in a relative path");
  // The shell channel, with the two mutation forms Codex used.
  for (const command of [
    'Set-Content .claude./hooks/codex-bot-review-lib.mjs -Value ""',
    'Set-Content .claude/hooks./codex-bot-review-lib.mjs -Value ""',
    'Set-Content .claude/hooks/codex-bot-review-lib.mjs. -Value ""',
    "echo x > .claude/hooks/codex-bot-review-lib.mjs.",
    'Set-Content -Path ".claude/hooks/codex-push-lib.mjs..." -Value ""',
    "rm .codex./hooks.json",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `a Windows trailing-period alias must be refused: ${command}`,
    );
  }
  // A read through a trailing-period alias is still just a read.
  assert.equal(
    evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "cat .claude/hooks/codex-bot-review-lib.mjs." } }).blocked,
    false,
    "reading through a trailing-period alias stays allowed; only mutation is refused",
  );
  // NEAR-MISS CANARIES. Only TRAILING periods are Windows no-ops: an interior
  // period is part of the name, and a real suffix after the protected name is a
  // different file. A strip that reached into the middle of a segment, or a
  // matcher loosened to "protected name appears somewhere", would pass every
  // positive case above while blocking these.
  for (const innocent of [
    ".claude/hooks/codex-push-lib..mjs",
    ".claude/hooks/codex-push-lib.mjs.bak",
    ".claude/hooks/codex-bot-review-lib.test.mjs.",
    "scripts/write-codex-push-proof.test.mjs.",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "Write", toolInput: { file_path: innocent } }).blocked,
      false,
      `an interior period or a real suffix is a different file and must stay editable: ${innocent}`,
    );
  }

  // ── round 8 (SEC-002): cmd.exe's caret and the POSIX backslash escape ──────
  // Codex HIGH on the exact-SHA proof of fd72af13e. Round 4 stripped the
  // characters a shell DELETES while building a word — but only PowerShell's:
  // quotes and the backtick. cmd.exe deletes `^` the same way, so
  // `cmd /c "echo x > .claude/hooks/codex-push-^lib.mjs"` writes the protected
  // file while the token the guard examined still carried the caret. A POSIX
  // shell (Git Bash here) does the same with an unquoted backslash. The set is
  // now the UNION of every shell's no-ops; the backslash, being also Windows'
  // separator, gets its own deleted view.
  const CARET = String.fromCharCode(94);
  for (const command of [
    `cmd /c "echo x > .claude/hooks/codex-push-${CARET}lib.mjs"`,
    `echo x > .claude/hooks/codex-push-${CARET}lib.mjs`,
    `cmd /c "echo x > .claude/hooks/codex-bot-review-${CARET}lib.mjs"`,
    `Set-Content .codex/${CARET}hooks.json -Value ""`,
    // The caret can land in the directory part too.
    `cmd /c "echo x > .cla${CARET}ude/hooks/codex-push-lib.mjs"`,
    // POSIX: an unquoted backslash before an ordinary character is deleted.
    "echo x > .claude/hooks/codex-push-\\lib.mjs",
    "cp /tmp/evil.mjs .claude/hooks/codex-bot-review-\\lib.mjs",
    // ...and the two escapes combined with a quote splice, all in one word.
    `echo x > .claude/hooks/codex-push-${CARET}l""ib.mjs`,
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `a caret or backslash escape spliced into a protected path must be refused: ${command}`,
    );
  }
  // Still a read, still allowed.
  assert.equal(
    evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: `cmd /c "type .claude/hooks/codex-push-${CARET}lib.mjs"` } }).blocked,
    false,
    "a caret-spliced READ stays allowed; only mutation is refused",
  );
  // NEAR-MISS CANARIES. A backslash-SEPARATED Windows path to an unrelated file
  // must not fuse into a protected one when backslashes are deleted, and
  // whitespace-separated fragments are still two arguments.
  for (const innocent of [
    'Set-Content .claude\\hooks\\some-other-lib.mjs -Value ""',
    'Set-Content out.txt -Value ".claude\\hooks\\" "codex-push-lib.mjs"',
    `Set-Content out.txt -Value ".claude/hooks/" ${CARET} "codex-push-lib.mjs"`,
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: innocent } }).blocked,
      false,
      `deleting escape characters must not fabricate a protected path: ${innocent}`,
    );
  }

  // ── round 9: a COMPUTED destination is refused, not parsed ─────────────────
  // Codex HIGH on the exact-SHA proof of dc965401f. Every token check above
  // reads literals; a path assembled at run time has none to read, and both of
  // Codex's probes returned blocked:false. Rounds 2, 3, 4, 7 and 8 were each one
  // more spelling, so this refuses the SHAPE: a mutating segment carrying a
  // parenthesised expression, a `$` variable, Join-Path or -f/-join is denied
  // outright, like a shell-expanded interpreter argument already is.
  for (const command of [
    'Set-Content (".claude/hooks/codex-bot-review-" + "lib.mjs") -Value ""',
    'Copy-Item evil.mjs (Join-Path ".claude/hooks" "codex-bot-review-lib.mjs")',
    'Set-Content ("{0}/{1}" -f ".claude/hooks", "codex-push-lib.mjs") -Value ""',
    '$d = ".claude/hooks"; Set-Content "$d/codex-push-lib.mjs" -Value ""',
    'Set-Content $dest -Value ""',
    "echo x > $(Get-Content dest.txt)",
    'Set-Content -Path (Get-Content dest.txt) -Value ""',
    'Set-Content ((".claude", "hooks", "codex-push-lib.mjs") -join "/") -Value ""',
    // Codex round 10: cmd.exe builds text with %VAR% and delayed !VAR! expansion,
    // which the first cut of this rule did not count as computed. The fragments
    // never spell the protected file; cmd assembles it.
    'cmd /c "set a=.claude/hooks/codex-bot-review-&& echo x > %a%lib.mjs"',
    'cmd /v:on /c "set a=.claude/hooks/codex-bot-review-&& echo x > !a!lib.mjs"',
    "echo x > %a%lib.mjs",
    "echo x > !a!lib.mjs",
    // Substring expansion has the same shape.
    'cmd /c "set a=.claude/hooks/codex-bot-review-lib.mjs.bak&& echo x > %a:~0,-4%"',
  ]) {
    const verdict = evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } });
    assert.equal(verdict.blocked, true, `a computed destination in a mutating command must be refused: ${command}`);
    assert.match(String(verdict.reason), /computed destination|builds a path/i, `…as a computed destination, not by accident of some other gate: ${command}`);
  }
  assert.equal(
    mutatingSegmentWithComputedText('cmd /c "set a=.claude/hooks/codex-bot-review-&& echo x > %a%lib.mjs"'),
    'echo x > %a%lib.mjs"',
    "the classifier names the MUTATING segment carrying the cmd expansion, not the harmless `set`",
  );
  // cmd.exe's own write verbs were missing from the mutation list entirely, so
  // `copy evil.mjs <protected>` was not even a mutation to the literal gate.
  for (const command of [
    "copy evil.mjs .claude\\hooks\\codex-push-lib.mjs",
    "move evil.mjs .claude/hooks/codex-bot-review-lib.mjs",
    "xcopy evil.mjs .codex\\hooks\\production-action-guard.mjs /Y",
    "mklink .claude\\hooks\\codex-push-lib.mjs evil.mjs",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `a cmd.exe write verb against a protected file must be refused: ${command}`,
    );
  }
  assert.equal(
    evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "copy docs\\a.md docs\\b.md" } }).blocked,
    false,
    "a cmd.exe copy between ordinary files stays allowed",
  );
  // ── round 11: the working directory is part of the path ───────────────────
  // Codex HIGH on the exact-SHA proof of 008f300fc — a hole that predates this
  // PR but lives in this file. Every matcher compared the raw candidate, so a
  // tool told to run IN the protected directory could name the module by its
  // bare basename: `workdir: ".claude/hooks"` + `Set-Content codex-bot-review-lib.mjs`
  // and the equivalent Write/Edit inputs all returned blocked:false.
  for (const [workdir, candidate] of [
    [".claude/hooks", "codex-bot-review-lib.mjs"],
    [".claude\\hooks", "codex-push-lib.mjs"],
    [".codex/hooks", "production-action-guard.mjs"],
    ["scripts", "write-codex-push-proof.mjs"],
    [".claude", "hooks/codex-push-lib.mjs"],
    [".claude/hooks/", "./codex-bot-review-lib.mjs"],
  ]) {
    for (const tool of ["Write", "Edit", "apply_patch"]) {
      assert.equal(
        evaluateProductionAction({ toolName: tool, toolInput: { file_path: candidate, workdir } }).blocked,
        true,
        `${tool} must join the working directory before matching: workdir=${workdir} path=${candidate}`,
      );
    }
    for (const command of [`Set-Content ${candidate} -Value ""`, `echo x > ${candidate}`]) {
      assert.equal(
        evaluateProductionAction({ toolName: "PowerShell", toolInput: { command, workdir } }).blocked,
        true,
        `a shell write must join the working directory before matching: workdir=${workdir} ${command}`,
      );
    }
  }
  // `cwd` is the other spelling the guard already reads for the working directory.
  assert.equal(
    evaluateProductionAction({ toolName: "Write", toolInput: { file_path: "codex-bot-review-lib.mjs", cwd: ".claude/hooks" } }).blocked,
    true,
    "the `cwd` spelling of the working directory is joined too",
  );
  // NEAR-MISS CANARIES: an unrelated file in an unrelated working directory,
  // and a protected-looking basename in a directory that is not the protected
  // one, both stay editable — the join must not turn every basename into a hit.
  for (const [workdir, candidate] of [
    ["docs", "notes.md"],
    ["docs", "codex-push-lib.mjs"],
    [".claude/hooks", "codex-bot-review-lib.test.mjs"],
    [".claude/hooks", "some-other-lib.mjs"],
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "Write", toolInput: { file_path: candidate, workdir } }).blocked,
      false,
      `an unprotected file stays editable whatever the working directory: workdir=${workdir} path=${candidate}`,
    );
  }
  // A directory change INSIDE the command moves the working directory out from
  // under the join; a mutating command that also changes directory is refused.
  for (const command of [
    "Set-Location .claude/hooks; Set-Content codex-bot-review-lib.mjs -Value \"\"",
    "cd .claude/hooks && echo x > codex-push-lib.mjs",
    "pushd .codex\\hooks; Set-Content production-action-guard.mjs -Value \"\"",
    "cd docs; echo x > notes.md",
  ]) {
    const verdict = evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } });
    assert.equal(verdict.blocked, true, `a directory change followed by a write is unbindable and must be refused: ${command}`);
  }
  assert.equal(
    evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "cd .claude/hooks; Get-Content codex-bot-review-lib.mjs" } }).blocked,
    false,
    "a directory change followed by a READ stays allowed",
  );
  // Positional and special shell parameters are computed text too (Codex
  // round 11): `$1$2` assembles a protected name from two harmless arguments.
  for (const command of [
    "sh -c 'cp source \"$1$2\"' _ .claude/hooks/codex-bot-review- lib.mjs",
    "bash -c 'echo x > $1' _ .claude/hooks/codex-push-lib.mjs",
    "cp evil.mjs $@",
    "cp evil.mjs \"$*\"",
  ]) {
    // Some of these also spell a protected literal, or invoke `sh -c`, and an
    // earlier gate may deny first; any denial is the right answer, and the
    // classifier pin below proves the computed-text rule sees them on its own.
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `a positional/special parameter in a mutating segment is computed text: ${command}`,
    );
    assert.notEqual(mutatingSegmentWithComputedText(command), "", `the classifier itself flags the mutating segment: ${command}`);
  }
  assert.equal(mutatingSegmentWithComputedText("echo 100% done > docs/out.txt"), "", "a lone percent sign is not an expansion");
  assert.equal(mutatingSegmentWithComputedText("Write-Output %date% | Out-Null"), "", "an expansion in a NON-mutating segment is not condemned");
  // A computed form that ALSO spells the protected path literally is caught by
  // the earlier literal gate first; either denial is the right answer.
  for (const command of [
    'Set-Content -Path (Join-Path $PWD ".claude/hooks/codex-push-lib.mjs") -Value ""',
    "copy evil.mjs %APPDATA%\\..\\..\\repo\\.claude\\hooks\\codex-push-lib.mjs",
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command } }).blocked,
      true,
      `a computed form that still spells the protected path is denied (by whichever gate sees it first): ${command}`,
    );
  }
  // NEAR-MISS CANARIES: the refusal is scoped to the MUTATING segment. A
  // variable or subexpression in a non-mutating stage, a literal destination
  // with an ordinary value, and a plain redirect all stay allowed — otherwise
  // "deny anything with a `$`" would pass every case above while making the
  // shell unusable.
  for (const innocent of [
    'npm test 2>&1 | Where-Object { $_ -match "fail" }',
    "git log --oneline > docs/out.txt",
    'Set-Content docs/notes.txt -Value "plain"',
    "Get-ChildItem (Join-Path $PWD docs) | Select-Object Name",
    'Write-Output ("a" + "b")',
  ]) {
    assert.equal(
      evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: innocent } }).blocked,
      false,
      `a computed expression outside a mutating segment, or a literal destination, stays allowed: ${innocent}`,
    );
  }

  const botLibPush = makeRepo(".claude/hooks/codex-bot-review-lib.mjs", "export const ordinary = true;\n");
  assert.equal(
    evaluatePush(botLibPush.repo).blocked,
    true,
    "pushing a change to codex-bot-review-lib.mjs requires the Sol proof like any other guard source",
  );

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
    toolInput: { command: "git push origin feature/test" },
    repoDir: risky.repo,
  }).blocked, false, "branch pushes stay allowed");
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
  claudeGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin feature/test`, projectRoot);
  assert.equal(claudeGuard.stdout, "", "Claude guard still allows an ordinary feature-branch push");
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
  assert.equal(missingProof.blocked, true, "risky main push denied without proof");
  assert.match(String(missingProof.reason || ""), /"verdict":"clean"/, "proof guidance requires a clean verdict");
  assert.doesNotMatch(String(missingProof.reason || ""), /blockers-fixed/, "proof guidance omits obsolete verdicts");

  writeProof(risky.repo, valid);
  assert.equal(evaluatePush(risky.repo, now).blocked, false, "risky main push allowed with valid proof");

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
  }).blocked, false, "git -C main push accepts proof from the selected repo");
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
    reviewDecision: "APPROVED",
    mergeStateStatus: "CLEAN",
    statusCheckRollup: greenChecks,
  };
  const mainPrJson = JSON.stringify(mainPr);
  const featurePrJson = JSON.stringify({ baseRefName: "develop", headRefName: "feature/test", headRefOid: risky.sha });
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

  unlinkSync(proofPath(risky.repo));
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "risky gh merge to main is denied without Sol proof");
  writeProof(risky.repo, valid);
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "gh PR merge to main uses the same valid proof gate");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api -X PUT repos/crop/crx/pulls/123/merge -f merge_method=squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "gh API merge route uses the same green-CI and proof gate");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api -X PUT https://api.github.com/repos/crop/crx/pulls/123/merge -f merge_method=squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "full-URL gh API merge route uses the same gate");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api graphql -f query='mutation{mergePullRequest(input:{pullRequestId:\"PR_1\"}){pullRequest{id}}}'" },
    repoDir: risky.repo,
  }).blocked, true, "GraphQL mergePullRequest mutations deny closed");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api -X PUT repos/crop/crx/contents/file.txt -f branch=main" },
    repoDir: risky.repo,
  }).blocked, true, "unrecognized mutating gh API calls are denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
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
    toolInput: { command: '"C:\\Program Files\\GitHub CLI\\gh.exe" pr merge 123 --squash' },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "full Windows GitHub CLI paths are gated too");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    runGh: () => featurePrJson,
  }).blocked, false, "gh PR merge to a non-production base is allowed");

  // ── Mason's manual review override is his alone (2026-09-01) ──────────────
  // "Include administrators" is OFF on main's branch protection so Mason can
  // hand-merge a PR whose review is stuck. The bypass rides on admin rights,
  // which is exactly what Codex's own token carries — so the flag is refused
  // before the PR is even resolved (note: no runGh stub is supplied below).
  const adminMerge = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash --admin" },
    repoDir: risky.repo,
    nowMs: now,
  });
  assert.equal(adminMerge.blocked, true, "--admin merge is denied without resolving the PR");
  assert.match(
    String(adminMerge.reason || adminMerge.message || JSON.stringify(adminMerge)),
    /--admin/,
    "--admin denial names the flag",
  );
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --admin=false --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "--admin=false asks for no bypass and stands down");
  // Mason removed main's required approval on 2026-09-02, so a MISSING approval
  // is no longer a merge blocker. This PR is still risky, so it stays blocked on
  // the Codex proof — the assertion is therefore that it is not blocked ON REVIEW
  // GROUNDS, which is the part that changed.
  const unapproved = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, reviewDecision: "REVIEW_REQUIRED" }),
  });
  assert.doesNotMatch(
    String(unapproved.reason || unapproved.message || JSON.stringify(unapproved)),
    /reviewDecision=REVIEW_REQUIRED|no current approval/,
    "a missing approval is no longer a merge blocker (Mason, 2026-09-02)",
  );
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, reviewDecision: "CHANGES_REQUESTED" }),
  }).blocked, true, "CHANGES_REQUESTED still denies - never merge over an unresolved objection");

  // ── a slow advisory lookup must not be able to starve a HARD denial ────────
  // Codex round 6 (PR #563). The Codex GitHub App lookup is advisory and
  // fail-open, and it costs up to four `gh` calls each capped at 10s against a
  // 15-SECOND hook budget. A PreToolUse hook killed mid-call emits nothing, and a
  // hook that emits nothing does NOT deny (the class PR #502 established). While
  // that lookup ran FIRST, a slow GitHub could kill this hook before the
  // objection, green-pipeline, risky-diff and exact-SHA-proof denials ever ran —
  // and the merge would proceed.
  //
  // This is the behavioural pin, not a source-order one: the graphql call THROWS
  // if it is reached, so any regression that moves the advisory back in front of
  // a hard denial fails here rather than in production.
  // The advisory resolves the PR's owner/name/number from a `--json number,url`
  // call before it can issue the GraphQL read. A stub that omits those fields
  // makes the advisory short-circuit, and then "graphql was never reached" proves
  // nothing about ordering — it would hold even with the advisory running first.
  // So both stubs below answer that lookup properly; only the ORDER decides
  // whether the throw is hit.
  const advisoryMetaJson = JSON.stringify({
    number: 123,
    url: "https://github.com/masonwells1/CRX_Manager_V1.0/pull/123",
  });
  const isAdvisoryMetaCall = (args) => Array.isArray(args) && args.includes("number,url");
  let advisoryAttempts = 0;
  const hangingAdvisoryGh = (args) => {
    if (Array.isArray(args) && args.includes("graphql")) {
      advisoryAttempts += 1;
      throw new Error("advisory lookup reached before a hard denial");
    }
    if (isAdvisoryMetaCall(args)) return advisoryMetaJson;
    return JSON.stringify({ ...mainPr, reviewDecision: "CHANGES_REQUESTED" });
  };
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: hangingAdvisoryGh,
  }).blocked, true, "the objection still denies even though the advisory lookup would fail");
  assert.equal(
    advisoryAttempts,
    0,
    "the advisory lookup is NOT reached before the objection deny — if it were, a slow GitHub could kill the hook and deny nothing",
  );

  // CONTROL — without this the assertion above passes just as happily against a
  // guard that never calls the advisory at all, which is the dead-code failure
  // the ordering pin was originally written to prevent. On a clean, green,
  // proof-backed merge the advisory IS reached.
  writeProof(risky.repo, valid);
  let controlAttempts = 0;
  const controlGh = (args) => {
    if (Array.isArray(args) && args.includes("graphql")) {
      controlAttempts += 1;
      throw new Error("advisory unavailable"); // fail-open: a notice, never a deny
    }
    if (isAdvisoryMetaCall(args)) return advisoryMetaJson;
    return mainPrJson;
  };
  const controlVerdict = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: controlGh,
  });
  assert.equal(controlAttempts > 0, true, "CONTROL: the advisory IS reached once every hard gate has passed");
  assert.equal(controlVerdict.blocked, false, "a failed advisory lookup fails OPEN — it prints a notice and allows");

  // ── round 8 (SEC-001): a CHAINED merge must not run #1's advisory before ──
  // ── #2's hard checks ─────────────────────────────────────────────────────
  // Codex HIGH on the exact-SHA proof of fd72af13e. Running the advisory at
  // the allow point of ONE merge was not enough: `gh pr merge 123 && gh pr merge
  // 456` gates each segment in turn, so #123's (clean, green, proof-backed)
  // advisory ran before #456's objection check. A slow GitHub there could kill
  // the hook before #456 was ever examined, and a killed hook denies nothing —
  // so #456 would merge over CHANGES_REQUESTED. The advisory for #123 must not
  // be reached at all when a later segment is going to be denied.
  let chainedAttempts = 0;
  const chainedGh = (args) => {
    if (Array.isArray(args) && args.includes("graphql")) {
      chainedAttempts += 1;
      throw new Error("advisory lookup for the first merge reached before the second merge's hard denial");
    }
    if (isAdvisoryMetaCall(args)) return advisoryMetaJson;
    // The stub tells the PRs apart by the selector `gh pr view <n>` carries.
    if (Array.isArray(args) && args.includes("456")) {
      return JSON.stringify({ ...mainPr, reviewDecision: "CHANGES_REQUESTED" });
    }
    return mainPrJson;
  };
  const chainedVerdict = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash && gh pr merge 456 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: chainedGh,
  });
  assert.equal(chainedVerdict.blocked, true, "the second merge's objection denies the whole command");
  assert.match(String(chainedVerdict.reason), /CHANGES_REQUESTED/, "the denial is the objection, not an advisory or a fail-open notice");
  assert.equal(
    chainedAttempts,
    0,
    "the FIRST merge's advisory lookup is never reached when a LATER merge fails a hard gate — an in-loop advisory could starve that gate",
  );
  // CONTROL for the chained case: when every merge in the chain is clean, the
  // advisory IS reached for each of them — deferral is not deletion.
  let chainedControlAttempts = 0;
  const chainedControlGh = (args) => {
    if (Array.isArray(args) && args.includes("graphql")) {
      chainedControlAttempts += 1;
      throw new Error("advisory unavailable"); // fail-open
    }
    if (isAdvisoryMetaCall(args)) return advisoryMetaJson;
    return mainPrJson;
  };
  const chainedControlVerdict = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash && gh pr merge 456 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: chainedControlGh,
  });
  assert.equal(chainedControlVerdict.blocked, false, "CONTROL: two clean merges are allowed");
  assert.equal(chainedControlAttempts, 2, "CONTROL: the advisory runs once per merge AFTER both cleared their hard gates — deferred, not dropped");

  // ── round 9: the GitHub-connector merge tool must get the advisory too ─────
  // Codex HIGH on the exact-SHA proof of dc965401f — a regression round 8
  // introduced. Moving the lookup out of gatePullRequestMerge() left the
  // connector route (mcp__github__merge_pull_request, one PR per call) returning
  // the deferred request untouched: a mocked unresolved Codex thread on the
  // exact head produced blocked:false through the connector while the same PR
  // through `gh pr merge` produced blocked:true. Behavioural, on both routes.
  const standingThreadGh = (args) => {
    if (Array.isArray(args) && args.includes("graphql")) {
      return JSON.stringify({ data: { repository: { pullRequest: {
        headRefOid: risky.sha,
        reviewThreads: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            isResolved: false,
            isOutdated: false,
            comments: { nodes: [{ author: { login: "chatgpt-codex-connector" }, originalCommit: { oid: risky.sha } }] },
          }],
        },
      } } } });
    }
    if (isAdvisoryMetaCall(args)) return advisoryMetaJson;
    return mainPrJson;
  };
  const connectorStanding = evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { owner: "crop", repo: "crx", pull_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: standingThreadGh,
  });
  assert.equal(connectorStanding.blocked, true, "an unresolved Codex App thread on the exact head denies a CONNECTOR merge, not only a shell one");
  assert.match(String(connectorStanding.reason), /unresolved comment/, "…with the App-review denial, not some other gate");
  const shellStanding = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: standingThreadGh,
  });
  assert.equal(shellStanding.blocked, true, "PARITY: the same standing thread denies the shell route");
  assert.match(String(shellStanding.reason), /unresolved comment/, "…with the same denial");
  // And the connector route still ALLOWS when the App has nothing standing —
  // the fix must add the check, not turn the route into a deny.
  const connectorClean = evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { owner: "crop", repo: "crx", pull_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: controlGh,
  });
  assert.equal(connectorClean.blocked, false, "CONTROL: a clean, green, proof-backed connector merge with a failed (fail-open) advisory is still allowed");
  // --auto MUST NOT exempt an active objection (Codex High finding, PR #559).
  // Every other gate exempts auto because GitHub holds the merge until its own
  // requirements are met; the requirement that covered this one was the required
  // review, which the same change removed. GitHub will now complete a queued
  // auto-merge over CHANGES_REQUESTED, so the guard has to be the one to refuse.
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash --auto" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, reviewDecision: "CHANGES_REQUESTED" }),
  }).blocked, true, "--auto does NOT exempt an active objection");
  // A missing reviewDecision no longer fails closed HERE. Since 2026-09-02 `null`
  // is the ordinary verdict GitHub returns for an unreviewed PR, so blocking it
  // would rebuild the deadlock the protection change removed. The fail-closed
  // floor lives upstream instead: an unresolvable PR is denied before this point.
  const noVerdict = evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, reviewDecision: undefined }),
  });
  assert.doesNotMatch(
    String(noVerdict.reason || noVerdict.message || JSON.stringify(noVerdict)),
    /CHANGES_REQUESTED|no current approval/,
    "an absent reviewDecision is not treated as an objection",
  );
  // The MCP merge route is gated exactly like the gh route - proven with an ACTIVE
  // objection, which is what still blocks, rather than with a missing approval,
  // which no longer does.
  const mcpObjection = evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { owner: "crop", repo: "crx", pull_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, reviewDecision: "CHANGES_REQUESTED" }),
  });
  assert.equal(mcpObjection.blocked, true, "the MCP merge route enforces the objection too");
  assert.match(
    String(mcpObjection.reason || mcpObjection.message || JSON.stringify(mcpObjection)),
    /CHANGES_REQUESTED/,
    "the MCP-route denial names the objection",
  );

  // ── raw merge transports (Codex proof on PR #541, 2026-09-01) ─────────────
  // The gh-shaped routes above were the whole gate, which was survivable while
  // GitHub itself refused an unapproved merge: a raw REST call simply got a 405.
  // Mason's admin override removed that backstop — an agent holding his admin
  // credential can now merge through any transport — so the endpoint and the
  // mutation are denied by DESTINATION, whatever tool names them. The Claude
  // guard has denied raw REST since 2026-07-16; the Codex guard had not, and
  // GraphQL-over-curl was uncovered on both sides.
  for (const rawMerge of [
    "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/crop/crx/pulls/123/merge",
    "Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/crop/crx/pulls/123/merge",
    "wget --method=PUT https://api.github.com/repos/crop/crx/pulls/123/merge",
    "curl https://api.github.com/graphql -d '{\"query\":\"mutation{mergePullRequest(input:{pullRequestId:\\\"PR_1\\\"}){clientMutationId}}\"}'",
  ]) {
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: rawMerge },
      repoDir: risky.repo,
      nowMs: now,
    }).blocked, true, `raw merge transport denied: ${rawMerge.slice(0, 40)}`);
  }
  // A recognized outer `gh pr merge` must not shield a raw merge hidden in a
  // command substitution: the gh form is gated, hits `continue`, and the
  // embedded curl would never be inspected (Codex bot P1 on PR #541).
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --body \"$(curl -X PUT https://api.github.com/repos/crop/crx/pulls/9/merge)\"" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "raw merge endpoint inside a gh merge's substitution is denied");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --body \"`curl -X PUT https://api.github.com/repos/crop/crx/pulls/9/merge`\"" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "backtick substitution carrying a raw merge is denied");
  // A substitution can equally carry a second gh merge whose flags the parser
  // never sees; the inner one runs FIRST (Codex bot P1 on PR #541).
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --body \"$(gh pr merge 456 --ad\"\"min)\"" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "a nested gh merge inside a substitution is denied");
  // Quote and backslash concatenation build a flag gh honours but a raw-word
  // comparison misses.
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --ad\"\"min --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "quote-concatenated --admin is still the admin bypass");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 \"--admin\" --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, true, "fully quoted --admin is still the admin bypass");
  // A gh-shaped merge still routes through the real gate rather than the raw
  // denial — otherwise the blanket rule would swallow the approved path.
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "an ordinary gh merge is not caught by the raw-transport rule");
  assert.equal(evaluateProductionAction({
    toolName: "mcp__github__merge_pull_request",
    toolInput: { owner: "crop", repo: "crx", pull_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "GitHub MCP PR merge uses the same valid proof gate");
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
    toolInput: { repository_full_name: "crop/crx", pr_number: 123 },
    repoDir: risky.repo,
    nowMs: now,
    runGh: (args) => { sawSelector = args.join(" "); return mainPrJson; },
  }).blocked, false, "Codex-app merge input spelling is recognized and gated");
  assert.match(sawSelector, /\b123\b/, "guard verifies the exact requested PR number");
  assert.match(sawSelector, /crop\/crx/, "guard verifies against the exact requested repo");
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
    toolInput: { command: "gh api -XPUT repos/crop/crx/pulls/123/merge" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => JSON.stringify({ ...mainPr, mergeStateStatus: "UNSTABLE" }),
  }).blocked, true, "attached -XPUT gh api merge is gated (denied on non-green checks)");
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh api --method=POST repos/crop/crx/pulls/123/merge" },
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
    toolInput: { command: "gh api repos/crop/crx/merges -Fbase=main -Fhead=feature" },
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
    "gh -R crop/crx pr merge 123",
    "gh pr -R crop/crx merge 123",
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
    const proofWasValid = evaluatePush(risky.repo, now).blocked === false;
    assert.equal(evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: "git push origin feature/test | git push origin main --force" },
      repoDir: risky.repo,
      nowMs: now,
    }).blocked, true, "piped force main push is inspected and denied");
    assert.ok(proofWasValid, "sanity: proof was valid, so the deny came from the pipe stage");
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
  }).blocked, false, "deleting a feature branch stays allowed");

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
  assert.equal(allowedProcess.stdout, "", "allow path stays silent for Codex hook compatibility");

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
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: greenChecks,
    });
    const mergeWith = (json) => evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: "gh pr merge 123 --squash" },
      repoDir: stale.repo,
      nowMs: now,
      runGh: () => json,
    });

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
      toolInput: { command: "gh pr merge 123 --squash" },
      repoDir: stale.repo,
      nowMs: now,
      runGh: () => JSON.stringify({
        baseRefName: "main",
        baseRefOid: githubBase,
        headRefName: "feature/test",
        headRefOid: updatedHead,
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: greenChecks,
      }),
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
      reviewDecision: "APPROVED",
      mergeStateStatus: "CLEAN",
      statusCheckRollup: greenChecks,
    }));
    assert.equal(noBaseOid.blocked, true, "PR payload without baseRefOid fails closed");

    // The gh query must actually ask for baseRefOid.
    //
    // Collect EVERY invocation rather than keeping only the last one: since
    // 2026-09-02 the merge route makes further gh calls after resolving the PR
    // (the Codex GitHub App review lookup), and a last-write-wins capture then
    // asserts against the wrong call and fails for the wrong reason.
    const ghCalls = [];
    evaluateProductionAction({
      toolName: "PowerShell",
      toolInput: { command: "gh pr merge 123 --squash" },
      repoDir: stale.repo,
      nowMs: now,
      runGh: (args) => { ghCalls.push(args.join(" ")); return prAt(githubBase); },
    });
    assert.ok(
      ghCalls.some((call) => /baseRefOid/.test(call)),
      "gh pr view requests baseRefOid",
    );

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
      toolInput: { command: "gh pr merge 123 --squash" },
      repoDir: stale.repo,
      nowMs: now,
      runGh: () => JSON.stringify({
        baseRefName: "main",
        baseRefOid: githubBase,
        headRefName: "feature/test",
        headRefOid: updatedHead,
        reviewDecision: "APPROVED",
        mergeStateStatus: "CLEAN",
        statusCheckRollup: greenChecks,
      }),
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
  console.log(`TRANSCRIPT ALLOW (valid wrapper-shaped proof): exit=${allowedProcess.status} stdout=${JSON.stringify(allowedProcess.stdout)}`);
  console.log("OK - production action guard checks passed.");
} finally {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
}
