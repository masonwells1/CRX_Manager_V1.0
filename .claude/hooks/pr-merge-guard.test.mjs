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
  ghApiMutates,
  ghMergeRequest,
  mcpMergeRequest,
  proofSearchDirs,
  pullRequestApproved,
  pullRequestChecksGreen,
  pullRequestReviewBlocked,
} from "./codex-push-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(v, m) { assert.ok(v, m); pass++; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass++; }

// ── ghMergeRequest ───────────────────────────────────────────────────────────
eq(ghMergeRequest("gh pr merge 42 --squash"), { selector: "42", repo: "", auto: false, admin: false, disableAuto: false }, "plain merge parses");
eq(ghMergeRequest("gh pr merge --squash --auto 7"), { selector: "7", repo: "", auto: true, admin: false, disableAuto: false }, "--auto detected");
eq(ghMergeRequest("gh -R masonwells1/CRX_Manager_V1.0 pr merge 9"), { selector: "9", repo: "masonwells1/CRX_Manager_V1.0", auto: false, admin: false, disableAuto: false }, "global -R between gh and pr");
eq(ghMergeRequest("gh pr merge --repo=o/r"), { selector: "", repo: "o/r", auto: false, admin: false, disableAuto: false }, "repo= form, selectorless (current branch)");
ok(ghMergeRequest("gh pr merge") !== null, "selectorless merge still gated");
// `--disable-auto` gets no special treatment: it parses as an ordinary merge
// request, so every gate runs (Mason, 2026-09-21, after Codex found repeated
// flags, value positions and substitutions each stood the gate down).
eq(ghMergeRequest("gh pr merge 5 --disable-auto"), { selector: "5", repo: "", auto: false, admin: false, disableAuto: true },
  "--disable-auto is an ordinary merge request, not a cancellation that skips the gate");
eq(ghMergeRequest("gh pr merge 123 --disable-auto=true --disable-auto=false --squash")?.selector, "123",
  "repeated --disable-auto flags are an ordinary merge request too");
// The recorded flag is WORDING ONLY — it must never reach a gate. gh keeps the
// LAST value, so the pair above resolves to a real merge, and a value position
// is data, not a flag.
eq(ghMergeRequest("gh pr merge 123 --disable-auto=true --disable-auto=false --squash")?.disableAuto, false,
  "gh keeps the last value: this lands a merge, so it is not described as a cancellation");
eq(ghMergeRequest("gh pr merge 123 --body '--disable-auto' --squash")?.disableAuto, false,
  "--disable-auto in a VALUE position is body text, not a cancellation");
eq(ghMergeRequest("gh pr merge 123 --disable-auto --squash")?.auto, false,
  "a cancellation is never read as an auto-merge, which would exempt it from the green-pipeline check");
// pflag bundles boolean shorts: `-db` is `-d` then `-b`, so the NEXT word is the
// body VALUE — while `--admin` still reaches gh (Codex sol, 2026-09-20 round 3).
eq(ghMergeRequest("gh pr merge 123 -db --disable-auto --admin --squash")?.selector, "123",
  "a bundled value-taking short swallows the next word, and the selector is still read");
eq(ghMergeRequest("gh pr merge 123 -db --disable-auto --admin --squash")?.admin, true,
  "...and the administrator flag is still seen");
// Which shorts take a VALUE decides which PULL REQUEST the gate vets. Reading
// `-r` (--rebase) as value-taking swallowed the selector, reading `-A`
// (--author-email) as a boolean promoted its value to the selector, and a
// bundled `-R` lost the repository — each aims the whole gate at a different PR
// than gh merges (Codex sol, 2026-09-20 round 4; measured against gh's manual).
eq(ghMergeRequest("gh pr merge -dr 789 --squash")?.selector, "789",
  "-r is --rebase, a boolean: it must not swallow the PR selector");
eq(ghMergeRequest("gh pr merge -A someone@example.com 789 --squash")?.selector, "789",
  "-A is --author-email and takes a value: its value is not the PR selector");
// The LONG form of -A was missing from the value list (Codex sol, 2026-09-21).
eq(ghMergeRequest("gh pr merge --author-email --squash 123")?.selector, "123",
  "--author-email takes a value: the word after it is its value, not a flag or the selector");
eq(ghMergeRequest("gh pr merge --author-email someone@example.com 789 --squash")?.selector, "789",
  "...and its value is not the PR selector");
eq(ghMergeRequest("gh pr merge 123 --author-email --admin --squash")?.admin, false,
  "a value position is data in the other direction too");
ok(ghApiMutates("gh api repos/o/r/issues/1/comments -f body=x --TEMPLATE -iX=GET"),
  "gh api long options are matched whatever their case");
eq(ghMergeRequest("gh pr merge -dR other/repo 789 --squash")?.repo, "other/repo",
  "a bundled -R still carries the repository");
eq(ghMergeRequest("gh pr merge -dR other/repo 789 --squash")?.selector, "789",
  "...and the selector after it is still read");
eq(ghMergeRequest("gh pr merge -dRother/repo 789 --squash")?.repo, "other/repo",
  "an attached bundled -R carries the repository");
eq(ghMergeRequest("gh pr merge -R=other/repo 789 --squash")?.repo, "other/repo",
  "-R=value carries the repository");
eq(ghMergeRequest("gh pr view merge-notes"), null, "merge-notes is not the word merge");
ok(ghMergeRequest("gh pr view merge") !== null, "exact-word over-match routes read through gate (fails safe)");
eq(ghMergeRequest("git merge main"), null, "git merge is not a gh merge");
eq(ghMergeRequest("echo gh pr merge docs"), { selector: "docs", repo: "", auto: false, admin: false, disableAuto: false }, "gh token anywhere still matches (fails safe)");
eq(ghMergeRequest("npm run build"), null, "unrelated command ignored");

// ── the gh binary is a SHAPE, not a list of extensions ───────────────────────
// GH_BIN_RE spelled the binary `gh(?:\.exe)?` — a one-item extension list — so
// every command below returned null at 336f92e4d and the merge gate
// (green-pipeline, CHANGES_REQUESTED, risky-diff proof) never ran at all.
// Verified by executing the pre-fix library, not by reading the pattern.
for (const cmd of [
  "gh.cmd pr merge 625 --squash",
  "gh.ps1 pr merge 625 --squash",
  "gh.bat pr merge 625 --squash",
  "gh.COM pr merge 625 --squash",
  "C:\\Tools\\gh.cmd pr merge 625 --squash",
  "/usr/local/bin/gh.cmd pr merge 625 --squash",
  '"C:/Program Files/GitHub CLI/gh.cmd" pr merge 625 --squash',
  "npm test&&gh pr merge 625 --squash",          // separator, not whitespace
  "echo ok;gh.cmd pr merge 625 --squash",
]) {
  ok(ghMergeRequest(cmd) !== null, `any gh binary spelling is still gated: ${cmd}`);
}
ok(
  ghApiMergeRequest("gh.cmd api -X PUT repos/o/r/pulls/625/merge") !== null,
  "the api merge path is gated through any binary extension too",
);
// The other direction. A guard that over-denies gets switched off, so the
// boundary is pinned: `-` is not `.`, and `\b` does not match inside a word.
for (const cmd of [
  "gh-dash pr merge 1",
  "ghq push",
  "ghost pr merge 1",
  "npm run ghpr",
  "echo highlight pr merge",
]) {
  eq(ghMergeRequest(cmd), null, `a neighbouring command is not a gh merge: ${cmd}`);
}

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
eq(ghMergeRequest("gh pr merge 42 --admin"), { selector: "42", repo: "", auto: false, admin: true, disableAuto: false }, "--admin does not eat the selector");

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

// ── pullRequestReviewBlocked (Mason, 2026-09-02) ─────────────────────────────
// main no longer requires an approval, so ONLY an active objection blocks a
// merge. These pin both halves: what still denies, and what deliberately does
// not — a regression that re-blocked REVIEW_REQUIRED or null would restore the
// exact deadlock the protection change removed.
ok(pullRequestReviewBlocked({ reviewDecision: "CHANGES_REQUESTED" }), "CHANGES_REQUESTED blocks the merge");
ok(pullRequestReviewBlocked({ reviewDecision: "changes_requested" }), "case-insensitive");
ok(!pullRequestReviewBlocked({ reviewDecision: "APPROVED" }), "APPROVED does not block");
ok(!pullRequestReviewBlocked({ reviewDecision: "REVIEW_REQUIRED" }), "REVIEW_REQUIRED no longer blocks");
ok(!pullRequestReviewBlocked({ reviewDecision: null }), "null (no review required) does not block");
ok(!pullRequestReviewBlocked({}), "missing field does not block — gateRequest already denied an unfetchable PR");
ok(!pullRequestReviewBlocked(undefined), "undefined PR does not block here");

// ── ghApiMergeRequest ────────────────────────────────────────────────────────
eq(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/12/merge"), { selector: "12", repo: "o/r", auto: false }, "REST merge endpoint parses");
eq(ghApiMergeRequest("gh api --method=PUT https://api.github.com/repos/o/r/pulls/3/merge"), { selector: "3", repo: "o/r", auto: false }, "full-URL + --method= parses");
eq(ghApiMergeRequest("gh api repos/o/r/pulls/12"), null, "non-merge endpoint ignored");
ok(ghApiMergeRequest("gh api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge flagged unresolvable");
ok(ghApiMergeRequest("gh -R o/r api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge with global flags between gh and api still flagged — Codex round-5");
eq(ghApiMergeRequest("gh -R o/r api -X PUT repos/o/r/pulls/7/merge"), { selector: "7", repo: "o/r", auto: false }, "REST merge with global flags between gh and api still parses");
eq(ghApiMergeRequest("curl -X PUT api.github.com/repos/o/r/pulls/12/merge"), null, "curl is not a gh api call (denied by the hook's raw-REST rule instead)");

// ── ghApiMutates (moved here from .codex/hooks/production-action-guard.mjs on
// 2026-09-07, so the gh binary has exactly one definition) ───────────────────
// The copy that lived in the Codex guard carried the one-item extension list
// this file replaced with BIN_TAIL, AND a position-anchored `gh\s+api` that a
// global flag walked straight past. Both directions are pinned.
ok(ghApiMutates("gh api -X POST repos/o/r/issues/1/comments -f body=x"), "explicit POST mutates");
ok(ghApiMutates("gh api -XPUT repos/o/r/contents/f.txt"), "attached -XPUT mutates");
ok(ghApiMutates("gh api --method=DELETE repos/o/r/issues/1"), "--method=DELETE mutates");
ok(ghApiMutates("gh api repos/o/r/issues/1/comments -f body=x"), "field-bearing call defaults to POST");
ok(ghApiMutates("gh api repos/o/r/merges -Fbase=main -Fhead=feature"), "attached -F short value counts as a field");
ok(ghApiMutates("gh api graphql -f query='mutation { addComment(input: {}) }'"), "GraphQL mutation mutates");
ok(ghApiMutates("gh.cmd api -X POST repos/o/r/issues/1/comments"), ".cmd is the same binary");
ok(ghApiMutates("gh.ps1 api graphql -f query='mutation { x }'"), ".ps1 is the same binary");
ok(ghApiMutates("C:\\Tools\\gh.bat api -X PATCH repos/o/r/issues/1"), "a full Windows path with any extension is the same binary");
ok(ghApiMutates("gh -R o/r api -X POST repos/o/r/issues/1/comments"), "a global flag between gh and api no longer hides the call");
ok(!ghApiMutates("gh api repos/o/r/pulls/12"), "a plain read does not mutate");
ok(!ghApiMutates("gh api -X GET repos/o/r/pulls/12"), "explicit GET does not mutate");
ok(!ghApiMutates("gh pr view 12"), "pr view is not an api call");
// Pre-existing and unchanged by the move: a `-f`-bearing GraphQL call is an
// HTTP POST whatever the document says, so a GraphQL READ is treated as
// mutating. That over-blocks in the fail-closed direction; it is pinned here so
// a later change to that behaviour is a deliberate one.
ok(ghApiMutates("gh api graphql -f query='query { repository { id } }'"), "a field-bearing GraphQL read is still an HTTP POST (fail-closed)");
ok(!ghApiMutates("gh api graphql"), "graphql with no fields and no method is not classified as mutating");
// A long option's detached value is its value, never a flag (Codex sol,
// 2026-09-21): gh reads `-iX=GET` below as the template and POSTs the field.
ok(ghApiMutates("gh api repos/o/r/issues/1/comments -f body=test --template -iX=GET"), "a --template value shaped like -X GET does not hide a field POST");
ok(ghApiMutates("gh api -X POST repos/o/r/issues/1/comments --jq -XGET"), "a --jq value shaped like -XGET does not override an explicit POST");
ok(ghApiMutates("gh api repos/o/r/issues/1/comments --header -XGET -f body=x"), "a --header value is skipped too");
ok(ghApiMutates("gh api repos/o/r/issues/1/comments --raw-field -XGET"), "a detached --raw-field still counts as a field, and its value is not a flag");
ok(!ghApiMutates("gh api repos/o/r/issues/1 --template -XPOST"), "and the other way: a --template value shaped like -XPOST is not a POST");
eq(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/9/merge --template -XGET"), { selector: "9", repo: "o/r", auto: false }, "a --template value does not hide a REST merge from the merge gate");
ok(!ghApiMutates("ghost api -X POST repos/o/r/issues/1"), "a neighbouring binary is not gh");
ok(!ghApiMutates("npm run build"), "unrelated command ignored");

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

// ── round 7: the hard gates share one time budget (CodeRabbit, 2026-09-10) ──
// gateRequest() cannot be driven in-process (it needs a real gh), so the wiring
// is pinned here and the behaviour is proven on the Codex side, which injects gh
// and a clock. Every gh call a hard gate makes must spend the shared budget, and
// the advisory lookup must NOT: it fails open by design, and a slow GitHub there
// must not become a denial.
const gateRequestSource = guardSource.slice(
  guardSource.indexOf("function gateRequest("),
  guardSource.indexOf("const advisoryQueue = [];"),
);
ok(gateRequestSource.length > 0, "gateRequest() is present to inspect");
eq(
  (gateRequestSource.match(/\bhardGateGh\(/g) || []).length,
  3,
  "gateRequest()'s three gh calls — PR resolve, changed files, full diff — all spend the shared budget",
);
eq(
  (gateRequestSource.match(/(?<![A-Za-z])gh\(/g) || []).length,
  0,
  "no hard gate calls gh() directly, around the budget",
);
ok(
  /function\s+listWorktreesFromProjectDir\(\)\s*\{\s*if \(!hardGateBudget\.admit\(\)\) deny\(/.test(guardSource),
  "the proof scan's git call spends the shared budget too",
);
const advisorySource = guardSource.slice(
  guardSource.indexOf("function codexAdvisory("),
  guardSource.indexOf("function gateRequest("),
);
eq(
  (advisorySource.match(/\bhardGateGh\(/g) || []).length,
  0,
  "the fail-open advisory stays OFF the hard-gate budget",
);

// ── the objection check must never be exempt for --auto (Codex High, PR #559) ─
// Every other gate in this gateRequest() exempts auto-merge, because GitHub holds
// a queued auto-merge until its own requirements are met. The requirement that
// used to cover THIS one was main's required review — and the 2026-09-02 change
// removed it. With no required review GitHub will complete a queued auto-merge on
// a PR carrying CHANGES_REQUESTED, so re-adding an auto exemption here reopens a
// hole created by the same commit that removed the server-side floor. Pinned at
// the source level because gateRequest() is not exported and the live path needs
// a real `gh`; the behavioural twin is wired on the Codex side, which injects gh.
ok(
  /if\s*\(\s*pullRequestReviewBlocked\(\s*pr\s*\)\s*\)/.test(guardSource),
  "the CHANGES_REQUESTED denial is reached unconditionally",
);
ok(
  !/request\.auto[^\n]*pullRequestReviewBlocked/.test(guardSource),
  "the CHANGES_REQUESTED denial is NOT gated on request.auto - --auto must never merge over an objection",
);
ok(!/const\s+stateDir\s*=\s*path\.join\(/.test(guardSource), "the single-directory proof scan that made PR #252 unmergeable has not returned");

// ── the two 2026-09-08 Codex sol findings, pinned at their call sites ─────────
// Both are wiring, not parsing: the shared helpers are exercised behaviourally in
// codex-push-lib.test.mjs, and the end-to-end path here needs a real `gh`. Name
// the SUBJECT of each call, not just the function — `ghHiddenByShellComposition`
// applied to a single segment inside the loop would type-check, read as the fix,
// and miss every case, because a spliced merge verb is not a merge to the parser
// that produced that segment either.
ok(
  /if\s*\(\s*ghHiddenByShellComposition\(\s*toolInput\.command\s*\)\s*\)/.test(guardSource),
  "the gh composition refusal runs on the WHOLE command, before the segment loop",
);
// A single `&` runs both sides — POSIX in the background, cmd sequentially — so
// it must separate segments. Without it `gh pr merge 1 & gh pr merge 2` resolved
// only PR 1 and the second merge ran ungated.
//
// It must go through the SHARED, quote-aware segmenter rather than a regex: a
// regex splits inside `--body 'note&more'`, which hands the loop a merge whose
// `--admin` has been carried off into a segment containing no `gh` at all
// (Codex sol, 2026-09-08, SEC-001). Asserting the call site, not the helper,
// for the same reason the assertion above does.
ok(
  /for\s*\(\s*const\s+segment\s+of\s+splitCommandSegments\(\s*toolInput\.command\s*\)\s*\)/.test(guardSource),
  "the segment loop uses the shared quote-aware segmenter on the whole command",
);
ok(
  !/toolInput\.command\.split\(/.test(guardSource),
  "no raw regex split of the command survives in this guard",
);

console.log(`pr-merge-guard: ${pass} assertions passed`);
