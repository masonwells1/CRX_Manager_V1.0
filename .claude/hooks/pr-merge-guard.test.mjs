#!/usr/bin/env node
// Tests for the PR-merge gate (2026-07-16): the shared merge-request parsers in
// codex-push-lib.mjs and the hook's no-gh-needed decision paths via stdin spawn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ghApiMergeRequest,
  ghMergeRequest,
  mcpMergeRequest,
  pullRequestChecksGreen,
} from "./codex-push-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(v, m) { assert.ok(v, m); pass++; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass++; }

// ── ghMergeRequest ───────────────────────────────────────────────────────────
eq(ghMergeRequest("gh pr merge 42 --squash"), { selector: "42", repo: "", auto: false }, "plain merge parses");
eq(ghMergeRequest("gh pr merge --squash --auto 7"), { selector: "7", repo: "", auto: true }, "--auto detected");
eq(ghMergeRequest("gh -R masonwells1/CRX_Manager_V1.0 pr merge 9"), { selector: "9", repo: "masonwells1/CRX_Manager_V1.0", auto: false }, "global -R between gh and pr");
eq(ghMergeRequest("gh pr merge --repo=o/r"), { selector: "", repo: "o/r", auto: false }, "repo= form, selectorless (current branch)");
ok(ghMergeRequest("gh pr merge") !== null, "selectorless merge still gated");
eq(ghMergeRequest("gh pr merge 5 --disable-auto"), null, "--disable-auto stands down (cancels, does not land)");
eq(ghMergeRequest("gh pr view merge-notes"), null, "merge-notes is not the word merge");
ok(ghMergeRequest("gh pr view merge") !== null, "exact-word over-match routes read through gate (fails safe)");
eq(ghMergeRequest("git merge main"), null, "git merge is not a gh merge");
eq(ghMergeRequest("echo gh pr merge docs"), { selector: "docs", repo: "", auto: false }, "gh token anywhere still matches (fails safe)");
eq(ghMergeRequest("npm run build"), null, "unrelated command ignored");

// ── ghApiMergeRequest ────────────────────────────────────────────────────────
eq(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/12/merge"), { selector: "12", repo: "o/r", auto: false }, "REST merge endpoint parses");
eq(ghApiMergeRequest("gh api --method=PUT https://api.github.com/repos/o/r/pulls/3/merge"), { selector: "3", repo: "o/r", auto: false }, "full-URL + --method= parses");
eq(ghApiMergeRequest("gh api repos/o/r/pulls/12"), null, "non-merge endpoint ignored");
ok(ghApiMergeRequest("gh api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge flagged unresolvable");
eq(ghApiMergeRequest("curl -X PUT api.github.com/repos/o/r/pulls/12/merge"), null, "curl is not a gh api call (denied by the hook's raw-REST rule instead)");

// ── mcpMergeRequest ──────────────────────────────────────────────────────────
eq(mcpMergeRequest({ owner: "o", repo: "r", pull_number: 8 }), { selector: "8", repo: "o/r", auto: false }, "GitHub MCP spelling");
eq(mcpMergeRequest({ repository_full_name: "o/r", pr_number: 4 }), { selector: "4", repo: "o/r", auto: false }, "app-style spelling");

// ── pullRequestChecksGreen ───────────────────────────────────────────────────
const greenCheck = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
ok(pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [greenCheck] }), "clean + green passes");
ok(!pullRequestChecksGreen({ mergeStateStatus: "BLOCKED", statusCheckRollup: [greenCheck] }), "non-CLEAN fails");
ok(!pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }), "zero checks fails closed");
ok(!pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }] }), "running check fails");
ok(pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [greenCheck, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }] }), "skipped check tolerated");
ok(!pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] }), "pending status context fails");

// ── hook decision paths that need no gh (stdin spawn) ────────────────────────
const HOOK = path.join(__dirname, "pr-merge-guard.mjs");
function runHook(payload) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 15000,
  });
  let decision = null;
  try { decision = JSON.parse(res.stdout).hookSpecificOutput; } catch { decision = null; }
  return { status: res.status, decision };
}

let r = runHook({ tool_name: "Bash", tool_input: { command: "npm run build" } });
ok(r.status === 0 && r.decision === null, "non-merge command passes through silently");

r = runHook({ tool_name: "Bash", tool_input: { command: "git push origin feature/x" } });
ok(r.status === 0 && r.decision === null, "ordinary push not this hook's business");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh api graphql -f query='mutation { mergePullRequest(input: {}) }'" } });
ok(r.decision?.permissionDecision === "deny", "GraphQL merge denied");
ok(/mergePullRequest/.test(r.decision?.permissionDecisionReason || ""), "GraphQL deny explains itself");

r = runHook({ tool_name: "Bash", tool_input: { command: "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/12/merge" } });
ok(r.decision?.permissionDecision === "deny", "raw curl REST merge denied (Codex finding 2026-07-16)");

r = runHook({ tool_name: "Bash", tool_input: { command: "Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/o/r/pulls/12/merge" } });
ok(r.decision?.permissionDecision === "deny", "PowerShell REST merge denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "echo docs about /pulls/12/merges endpoint" } });
ok(r.status === 0 && r.decision === null, "merge-suffixed word boundary respected (merges != merge)");

r = runHook({ tool_name: "mcp__Desktop_Commander__read_file", tool_input: { path: "x" } });
ok(r.status === 0 && r.decision === null, "unrelated MCP tool passes through");

r = runHook({});
ok(r.status === 0 && r.decision === null, "empty payload passes through (never crashes the session)");

console.log(`pr-merge-guard: ${pass} assertions passed`);
