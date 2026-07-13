#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { evaluateProductionAction, isClearlyReadOnlySql } from "./production-action-guard.mjs";

const projectRoot = process.cwd();
const guardPath = path.join(projectRoot, ".codex", "hooks", "production-action-guard.mjs");
const proofWriterPath = path.join(projectRoot, "scripts", "write-claude-push-proof.mjs");
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

try {
  assert.equal(isClearlyReadOnlySql("select count(*) from invoices"), true);
  assert.equal(isClearlyReadOnlySql("with totals as (select 1) select * from totals"), true);
  assert.equal(isClearlyReadOnlySql("update invoices set status = 'paid'"), false);
  assert.equal(isClearlyReadOnlySql("with changed as (delete from invoices returning *) select * from changed"), false);

  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "select 1" } }).blocked, false);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__execute_sql", toolInput: { query: "delete from invoices" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__apply_migration" }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "mcp__supabase__delete_branch" }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "vercel --prod" } }).blocked, true);
  assert.equal(evaluateProductionAction({ toolName: "PowerShell", toolInput: { command: "npm run build" } }).blocked, false);

  const ordinary = makeRepo("src/components/Label.tsx", "export const label = 'ordinary';\n");
  assert.equal(evaluatePush(ordinary.repo).blocked, false, "non-risky main push allowed without proof");

  const risky = makeRepo("supabase/migrations/20260713000000_test.sql", "select 1;\n");
  const now = Date.now();
  const valid = {
    claude_ran: true,
    verdict: "clean",
    head_sha: risky.sha,
    timestamp: new Date(now).toISOString(),
  };

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

  const mainPrJson = JSON.stringify({ baseRefName: "main", headRefName: "feature/test", headRefOid: risky.sha });
  const featurePrJson = JSON.stringify({ baseRefName: "develop", headRefName: "feature/test", headRefOid: risky.sha });
  assert.equal(evaluateProductionAction({
    toolName: "PowerShell",
    toolInput: { command: "gh pr merge 123 --squash" },
    repoDir: risky.repo,
    nowMs: now,
    runGh: () => mainPrJson,
  }).blocked, false, "gh PR merge to main uses the same valid proof gate");
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

  unlinkSync(proofPath(risky.repo));
  const deniedProcess = spawnSync(process.execPath, [guardPath], {
    cwd: risky.repo,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git push origin HEAD:main" } }),
  });
  assert.equal(deniedProcess.status, 0);
  assert.match(deniedProcess.stdout, /"permissionDecision":"deny"/);

  const proofWriter = spawnSync(process.execPath, [proofWriterPath, "--verdict", "clean"], {
    cwd: risky.repo,
    encoding: "utf8",
  });
  assert.equal(proofWriter.status, 0, proofWriter.stderr);
  assert.equal(JSON.parse((await import("node:fs")).readFileSync(proofPath(risky.repo), "utf8")).head_sha, risky.sha);

  const allowedProcess = spawnSync(process.execPath, [guardPath], {
    cwd: risky.repo,
    encoding: "utf8",
    input: JSON.stringify({ tool_name: "PowerShell", tool_input: { command: "git push origin HEAD:main" } }),
  });
  assert.equal(allowedProcess.status, 0);
  assert.equal(allowedProcess.stdout, "", "allow path stays silent for Codex hook compatibility");

  console.log(`TRANSCRIPT DENY (no proof): exit=${deniedProcess.status} stdout=${deniedProcess.stdout}`);
  console.log(`TRANSCRIPT ALLOW (valid helper-written proof): exit=${allowedProcess.status} stdout=${JSON.stringify(allowedProcess.stdout)}`);
  console.log("OK - production action guard checks passed.");
} finally {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
}
