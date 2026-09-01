#!/usr/bin/env node
// Tests for the PR-merge gate (2026-07-16): the shared merge-request parsers in
// codex-push-lib.mjs and the hook's no-gh-needed decision paths via stdin spawn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ghApiMergeRequest,
  ghMergeRequest,
  mcpMergeRequest,
  proofSearchDirs,
  pullRequestApproved,
  pullRequestChecksGreen,
} from "./codex-push-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(v, m) { assert.ok(v, m); pass++; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass++; }

// ── ghMergeRequest ───────────────────────────────────────────────────────────
eq(ghMergeRequest("gh pr merge 42 --squash"), { selector: "42", repo: "", auto: false, admin: false }, "plain merge parses");
eq(ghMergeRequest("gh pr merge --squash --auto 7"), { selector: "7", repo: "", auto: true, admin: false }, "--auto detected");
eq(ghMergeRequest("gh -R masonwells1/CRX_Manager_V1.0 pr merge 9"), { selector: "9", repo: "masonwells1/CRX_Manager_V1.0", auto: false, admin: false }, "global -R between gh and pr");
eq(ghMergeRequest("gh pr merge --repo=o/r"), { selector: "", repo: "o/r", auto: false, admin: false }, "repo= form, selectorless (current branch)");
ok(ghMergeRequest("gh pr merge") !== null, "selectorless merge still gated");
eq(ghMergeRequest("gh pr merge 5 --disable-auto"), null, "--disable-auto stands down (cancels, does not land)");
eq(ghMergeRequest("gh pr view merge-notes"), null, "merge-notes is not the word merge");
ok(ghMergeRequest("gh pr view merge") !== null, "exact-word over-match routes read through gate (fails safe)");
eq(ghMergeRequest("git merge main"), null, "git merge is not a gh merge");
eq(ghMergeRequest("echo gh pr merge docs"), { selector: "docs", repo: "", auto: false, admin: false }, "gh token anywhere still matches (fails safe)");
eq(ghMergeRequest("npm run build"), null, "unrelated command ignored");

// ── --admin (Mason's manual review override, 2026-09-01) ─────────────────────
// "Include administrators" is OFF on main so Mason can hand-merge a stuck PR.
// The bypass rides on admin rights, so every agent session inherits it; the
// gate refuses the flag in every spelling gh accepts.
ok(ghMergeRequest("gh pr merge 42 --admin")?.admin === true, "--admin detected");
ok(ghMergeRequest("gh pr merge 42 --admin --squash")?.admin === true, "--admin before other flags detected");
ok(ghMergeRequest("gh pr merge --squash 42 --admin")?.admin === true, "--admin after the selector detected");
ok(ghMergeRequest("gh pr merge 42 --ADMIN")?.admin === true, "--ADMIN is the same flag");
ok(ghMergeRequest("gh pr merge 42 --admin=true")?.admin === true, "--admin=true detected");
ok(ghMergeRequest("gh pr merge 42 --admin=false")?.admin === false, "--admin=false asks for no bypass and stands down");
ok(ghMergeRequest("gh pr merge 42 --squash")?.admin === false, "an ordinary merge is not an admin merge");
eq(ghMergeRequest("gh pr merge 42 --admin"), { selector: "42", repo: "", auto: false, admin: true }, "--admin does not eat the selector");

// ── --auto=false is an IMMEDIATE merge (Codex bot P1 on PR #541) ─────────────
// gh accepts `--auto=false` as "do not auto-merge", so that command lands the PR
// right now. Treating every `--auto=` spelling as auto exempted it from BOTH the
// approval check and the green-pipeline check — the exemption exists only
// because GitHub itself holds a real auto-merge until requirements are met.
ok(ghMergeRequest("gh pr merge 42 --auto=false")?.auto === false, "--auto=false is an immediate merge, not an auto-merge");
ok(ghMergeRequest("gh pr merge 42 --auto=0")?.auto === false, "--auto=0 is an immediate merge");
ok(ghMergeRequest("gh pr merge 42 --auto=true")?.auto === true, "--auto=true is still an auto-merge");
ok(ghMergeRequest("gh pr merge 42 --auto")?.auto === true, "bare --auto is still an auto-merge");
// Go's ParseBool — which gh uses — accepts `f`/`F` as false and `t`/`T` as true.
// Listing the FALSE spellings missed `--auto=f` entirely, so only the TRUE
// spellings count as auto and everything else takes the full checks.
ok(ghMergeRequest("gh pr merge 42 --auto=f")?.auto === false, "--auto=f is ParseBool false, not an auto-merge");
ok(ghMergeRequest("gh pr merge 42 --auto=F")?.auto === false, "--auto=F is ParseBool false");
ok(ghMergeRequest("gh pr merge 42 --auto=t")?.auto === true, "--auto=t is ParseBool true");
ok(ghMergeRequest("gh pr merge 42 --auto=T")?.auto === true, "--auto=T is ParseBool true");
ok(ghMergeRequest("gh pr merge 42 --auto=1")?.auto === true, "--auto=1 is ParseBool true");
ok(ghMergeRequest("gh pr merge 42 --auto=banana")?.auto === false, "a value gh rejects takes the full checks");

// Shell quote/backslash concatenation builds a flag gh honours but a raw-word
// comparison misses: `--ad""min` reaches gh as `--admin`.
ok(ghMergeRequest('gh pr merge 42 --ad""min')?.admin === true, "quote-concatenated --admin detected");
ok(ghMergeRequest("gh pr merge 42 --ad''min")?.admin === true, "single-quote-concatenated --admin detected");
ok(ghMergeRequest('gh pr merge 42 "--admin"')?.admin === true, "fully quoted --admin detected");
ok(ghMergeRequest("gh pr merge 42 --ad\\min")?.admin === true, "backslash-escaped --admin detected");
ok(ghMergeRequest('gh pr merge 42 --au""to')?.auto === true, "quote-concatenated --auto still parses as auto");

// ── pullRequestApproved ──────────────────────────────────────────────────────
ok(pullRequestApproved({ reviewDecision: "APPROVED" }), "APPROVED passes");
ok(pullRequestApproved({ reviewDecision: "approved" }), "case-insensitive");
ok(!pullRequestApproved({ reviewDecision: "REVIEW_REQUIRED" }), "REVIEW_REQUIRED fails");
ok(!pullRequestApproved({ reviewDecision: "CHANGES_REQUESTED" }), "CHANGES_REQUESTED fails");
ok(!pullRequestApproved({ reviewDecision: null }), "null verdict fails closed");
ok(!pullRequestApproved({}), "missing field fails closed — a PR view that never asked for it is not an approval");
ok(!pullRequestApproved(undefined), "undefined PR fails closed");

// ── ghApiMergeRequest ────────────────────────────────────────────────────────
eq(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/12/merge"), { selector: "12", repo: "o/r", auto: false }, "REST merge endpoint parses");
eq(ghApiMergeRequest("gh api --method=PUT https://api.github.com/repos/o/r/pulls/3/merge"), { selector: "3", repo: "o/r", auto: false }, "full-URL + --method= parses");
eq(ghApiMergeRequest("gh api repos/o/r/pulls/12"), null, "non-merge endpoint ignored");
ok(ghApiMergeRequest("gh api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge flagged unresolvable");
ok(ghApiMergeRequest("gh -R o/r api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge with global flags between gh and api still flagged — Codex round-5");
eq(ghApiMergeRequest("gh -R o/r api -X PUT repos/o/r/pulls/7/merge"), { selector: "7", repo: "o/r", auto: false }, "REST merge with global flags between gh and api still parses");
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

// The GraphQL deny above only fired for `gh api graphql`. The mutation is now
// denied by NAME, whatever transport carries it — Codex's proof on PR #541
// found the Codex guard missing raw REST entirely, and neither guard covered
// GraphQL over curl. Denying the destination beats enumerating the tools that
// can reach it.
r = runHook({ tool_name: "Bash", tool_input: { command: "curl https://api.github.com/graphql -d '{\"query\":\"mutation{mergePullRequest(input:{pullRequestId:\\\"PR_1\\\"}){clientMutationId}}\"}'" } });
ok(r.decision?.permissionDecision === "deny", "GraphQL merge mutation over curl denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "Invoke-RestMethod -Uri https://api.github.com/graphql -Body '{\"query\":\"mutation{mergePullRequest(input:{}){id}}\"}'" } });
ok(r.decision?.permissionDecision === "deny", "GraphQL merge mutation over Invoke-RestMethod denied");

// A recognized outer `gh pr merge` must not shield a raw merge hidden in a
// command substitution — the gh form is gated, reaches `continue`, and the
// embedded curl would never be inspected (Codex bot P1 on PR #541).
r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 1 --repo crop/dev --body \"$(curl -X PUT https://api.github.com/repos/crop/crx/pulls/9/merge)\"" } });
ok(r.decision?.permissionDecision === "deny", "raw merge endpoint inside a gh merge's substitution is denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 1 --body \"`curl -X PUT https://api.github.com/repos/crop/crx/pulls/9/merge`\"" } });
ok(r.decision?.permissionDecision === "deny", "backtick substitution carrying a raw merge is denied");

// A substitution can equally carry a second gh merge, whose flags the parser
// never sees — the inner one runs FIRST (Codex bot P1 on PR #541).
r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 1 --repo crop/dev --body \"$(gh pr merge 2 --ad\"\"min)\"" } });
ok(r.decision?.permissionDecision === "deny", "a nested gh merge inside a substitution is denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 1 --body \"${SNEAKY}\"" } });
ok(r.decision?.permissionDecision === "deny", "a merge carrying ${...} expansion is unresolvable and denied");

// The substitution rule must stand down for an ordinary merge: this one still
// denies (the fixture PR cannot be resolved, which fails closed by design), but
// it must reach the RESOLUTION failure rather than being refused as unresolvable
// command text.
r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 1 --repo crop/dev --body plain-text" } });
ok(!/command substitution/.test(r.decision?.permissionDecisionReason || ""), "a merge with no substitution is not refused by the substitution rule");

r = runHook({ tool_name: "Bash", tool_input: { command: "echo docs about /pulls/12/merges endpoint" } });
ok(r.status === 0 && r.decision === null, "merge-suffixed word boundary respected (merges != merge)");

// Codex round-6: a gh merge earlier in the chain must not exempt later segments.
r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 5 --squash; curl -X PUT https://api.github.com/repos/o/r/pulls/9/merge" } });
ok(r.decision?.permissionDecision === "deny", "raw REST merge after a gh merge in the same chain still denied");
ok(/raw GitHub REST merge/.test(r.decision?.permissionDecisionReason || "") || /fail closed/.test(r.decision?.permissionDecisionReason || ""), "chain deny cites the REST rule or fails closed on PR resolution");

// The --admin deny lands BEFORE the PR is resolved, so it needs no gh and no
// network — that is deliberate: an agent must never reach GitHub with a request
// to skip the review, whatever the PR turns out to be.
r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --squash --admin" } });
ok(r.decision?.permissionDecision === "deny", "--admin merge denied without resolving the PR");
ok(/--admin/.test(r.decision?.permissionDecisionReason || ""), "--admin deny names the flag");
ok(/Mason/.test(r.decision?.permissionDecisionReason || ""), "--admin deny says whose override it is");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 5 --squash; gh pr merge 9 --admin" } });
ok(r.decision?.permissionDecision === "deny", "--admin later in a chain is still denied");

r = runHook({ tool_name: "mcp__Desktop_Commander__read_file", tool_input: { path: "x" } });
ok(r.status === 0 && r.decision === null, "unrelated MCP tool passes through");

r = runHook({});
ok(r.status === 0 && r.decision === null, "empty payload passes through (never crashes the session)");

// ── proofSearchDirs ──────────────────────────────────────────────────────────
// Regression cover for the 2026-07-27 defect that made PR #252 unmergeable: the
// guard searched ONLY the session's primary checkout, while the proof-minting
// script writes into whichever worktree it ran in. A clean, correctly-bound
// proof was therefore invisible and every merge attempt was denied.
const PORCELAIN = [
  "worktree C:/CRX_Manager",
  "HEAD 26a5f88b960fe477b334ae4101c67dc0b21fca3c",
  "branch refs/heads/main",
  "",
  "worktree C:/Users/mason/.claude/worktrees/gauntlet-runner/CRX_Manager",
  "HEAD 79efc903b199f73b20ee0494fc40b4ed15e11e99",
  "branch refs/heads/claude/gauntlet-section-runner-20260727",
  "",
].join("\n");

let dirs = proofSearchDirs("C:/CRX_Manager", () => PORCELAIN);
ok(
  dirs.includes(path.resolve("C:/Users/mason/.claude/worktrees/gauntlet-runner/CRX_Manager/.claude/session-state")),
  "a linked worktree's session-state is searched — this is the PR #252 bug",
);
ok(dirs.includes(path.resolve("C:/CRX_Manager/.claude/session-state")), "the primary checkout is still searched");
eq(dirs.length, new Set(dirs).size, "the primary checkout, listed twice by git, is not scanned twice");

// Enumeration failure must fall back to the primary directory, never throw and
// never return nothing: an empty list would silently make EVERY risky merge
// deniable-but-unprovable, and a throw would crash the hook mid-gate.
dirs = proofSearchDirs("C:/CRX_Manager", () => { throw new Error("git unavailable"); });
eq(dirs, [path.resolve("C:/CRX_Manager/.claude/session-state")], "git failure falls back to the primary dir (stricter, not laxer)");

// Degenerate porcelain must not manufacture bogus search paths.
eq(proofSearchDirs("C:/repo", () => "").length, 1, "empty porcelain yields only the primary dir");
eq(proofSearchDirs("C:/repo", () => "worktree   \nHEAD abc").length, 1, "a blank worktree path is ignored, not resolved to cwd");
eq(proofSearchDirs("C:/repo", () => undefined).length, 1, "undefined porcelain does not throw");

// WIRING check, deliberately source-level. Everything above proves proofSearchDirs
// behaves; none of it proves pr-merge-guard actually CALLS it. The behavioural path
// cannot be reached in-process: the hook resolves the PR through `gh` before it ever
// looks for a proof, and a fake `gh` on PATH is unspawnable on Windows (Node refuses
// to exec a .cmd without a shell). So assert the call site exists and that the old
// single-directory scan has not come back.
// Name the ENUMERATOR, not just the function: `proofSearchDirs(projectDir, () => "")`
// type-checks, passes a name-free regex, and silently restores primary-only discovery
// -- the exact bug, wearing the fix's clothes.
const guardSource = readFileSync(path.join(__dirname, "pr-merge-guard.mjs"), "utf8");
ok(
  /for\s*\(\s*const\s+stateDir\s+of\s+proofSearchDirs\(\s*projectDir\s*,\s*listWorktreesFromProjectDir\s*\)/.test(guardSource),
  "the proof scan iterates proofSearchDirs over the real worktree enumerator, not one hard-coded directory",
);
// ...and the enumerator must really enumerate. A stub named listWorktreesFromProjectDir
// would satisfy the call-site check above while returning nothing.
ok(
  /function\s+listWorktreesFromProjectDir\b[\s\S]{0,600}?["'`]worktree["'`][\s\S]{0,200}?--porcelain/.test(guardSource),
  "listWorktreesFromProjectDir actually shells out to `git worktree list --porcelain`",
);
ok(!/const\s+stateDir\s*=\s*path\.join\(/.test(guardSource), "the single-directory proof scan that made PR #252 unmergeable has not returned");

console.log(`pr-merge-guard: ${pass} assertions passed`);
