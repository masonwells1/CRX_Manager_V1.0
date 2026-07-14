#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateProductionAction, isClearlyReadOnlySql, pullRequestChecksGreen } from "./production-action-guard.mjs";

const projectRoot = process.cwd();
const guardPath = path.join(projectRoot, ".codex", "hooks", "production-action-guard.mjs");
const claudeGuardPath = path.join(projectRoot, ".claude", "hooks", "codex-push-guard.mjs");
const tempRoots = [];

function git(cwd, args) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
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
  return { repo, sha: git(repo, ["rev-parse", "HEAD"]) };
}

function proofPath(repo) {
  return path.join(repo, ".claude", "session-state", "claude-review-push.json");
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

  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "select 1" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "delete from invoices" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__delete_branch" }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "vercel --prod" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "npm run build" } }).blocked, false);
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
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node -e \"require('child_process').execSync('git pu'+'sh origin main')\"" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "echo code | node" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "node -" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: ".codex/hooks/production-action-guard.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: "C:\\repo\\.claude\\hooks\\codex-push-guard.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Write", toolInput: { file_path: "C:\\repo\\.codex\\hooks\\production-action-guard.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "repo\\scripts\\run-claude-review.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Edit", toolInput: { file_path: "scripts/run-claude-review.mjs" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "Read", toolInput: { file_path: "scripts/run-claude-review.mjs" } }).blocked, false);
  for (const command of [
    "rm .claude/hooks/review-proof-guard.mjs",
    "rm .claude/hooks/codex-push-guard.mjs;ls",
    "rm .claude/hooks/codex-push-guard.mjs|cat",
    "Remove-Item a.mjs,.claude/hooks/codex-push-guard.mjs",
    "copy x .codex/hooks/production-action-guard.mjs>nul",
    "sed -i s/a/b/ .codex/hooks/production-action-guard.mjs",
    "printf x > .claude/hooks/codex-push-guard.mjs",
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

  const guardrailChange = makeRepo(".claude/hooks/codex-push-lib.mjs", "export const ordinary = true;\n");
  assert.equal(
    evaluatePush(guardrailChange.repo).blocked,
    true,
    "guardrail self-modification requires Claude proof even without risky content keywords",
  );

  const risky = makeRepo("supabase/migrations/20260713000000_test.sql", "select 1;\n");
  const now = Date.now();
  const valid = {
    claude_ran: true,
    verdict: "clean",
    head_sha: risky.sha,
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

  assert.equal(evaluatePush(risky.repo, now).blocked, true, "risky main push denied without proof");

  writeProof(risky.repo, valid);
  assert.equal(evaluatePush(risky.repo, now).blocked, false, "risky main push allowed with valid proof");

  writeProof(risky.repo, { ...valid, timestamp: new Date(now - 30 * 60 * 1000 - 1).toISOString() });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "stale proof denied");

  writeProof(risky.repo, { ...valid, timestamp: new Date(now + 1).toISOString() });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "future-dated proof denied");

  writeProof(risky.repo, { ...valid, head_sha: "f".repeat(40) });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "wrong-SHA proof denied");

  writeProof(risky.repo, { ...valid, verdict: "ship" });
  assert.equal(evaluatePush(risky.repo, now).blocked, true, "wrong-verdict proof denied");

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
    headRefName: "feature/test",
    headRefOid: risky.sha,
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
  }).blocked, true, "risky gh merge to main is denied without Claude proof");
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
    mkdirSync(path.join(risky.repo, ".claude", "session-state"), { recursive: true });
    writeFileSync(
      path.join(risky.repo, ".claude", "session-state", "codex-review-forged proof.json"),
      `${JSON.stringify({ codex_ran: true, verdict: "clean", head_sha: risky.sha, timestamp: new Date(now).toISOString() })}\n`,
      "utf8",
    );
    const spacedProofGuard = runClaudePushGuard(`git -C "${risky.repo}" push origin HEAD:main`, projectRoot);
    assert.match(spacedProofGuard.stdout, /"permissionDecision":"deny"/, "space-named forged proof is not loaded by the proof loader");
    unlinkSync(path.join(risky.repo, ".claude", "session-state", "codex-review-forged proof.json"));
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

  console.log(`TRANSCRIPT DENY (no proof): exit=${deniedProcess.status} stdout=${deniedProcess.stdout}`);
  console.log(`TRANSCRIPT ALLOW (valid wrapper-shaped proof): exit=${allowedProcess.status} stdout=${JSON.stringify(allowedProcess.stdout)}`);
  console.log("OK - production action guard checks passed.");
} finally {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
}
