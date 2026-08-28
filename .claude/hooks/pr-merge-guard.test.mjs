#!/usr/bin/env node
// Tests for the PR-merge gate (2026-07-16): the shared merge-request parsers in
// codex-push-lib.mjs and the hook's no-gh-needed decision paths via stdin spawn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessLandPrUpdate } from "../../scripts/land-pr-lib.mjs";
import {
  branchNameIsProtected,
  CLAUDE_MERGE_EVIDENCE_BUDGET_MS,
  coderabbitReviewGate,
  createEvidenceBudget,
  directGitHubApiWriter,
  ghApiMergeRequest,
  ghApiMutates,
  ghCliCommandIsUnknownOrAlias,
  ghPrBaseRetargets,
  ghMergeRequest,
  ghUpdateBranchRequest,
  githubCliCommandIsDynamic,
  githubMutationEnvironmentOverrideNames,
  githubMutationUnsafeAmbientEnvironmentNames,
  githubRepositoryIsGuarded,
  mcpMergeRequest,
  mergeRequestHasExplicitContext,
  proofSearchDirs,
  pullRequestChecksGreen,
  updateBranchRequestHasExplicitContext,
} from "./codex-push-lib.mjs";

// GitHub Actions injects canonical GitHub context variables. Remove all ambient
// mutation-context inputs so each process-level regression controls its own
// environment and cannot pass or fail according to the runner provider.
for (const name of ["BASH_ENV", "ENV", "ZDOTDIR", "GH_CONFIG_DIR", "GH_HOST", "GITHUB_HOST", "GH_REPO", "GITHUB_API_URL"]) {
  delete process.env[name];
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(v, m) { assert.ok(v, m); pass++; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass++; }

const collectObjects = (value, found = []) => {
  if (!value || typeof value !== "object") return found;
  found.push(value);
  for (const child of Object.values(value)) collectObjects(child, found);
  return found;
};
const claudeSettings = JSON.parse(readFileSync(path.resolve(__dirname, "..", "settings.json"), "utf8"));
const claudeMergeHook = collectObjects(claudeSettings).find((entry) => String(entry.command || "").includes("pr-merge-guard.mjs"));
ok(Number(claudeMergeHook?.timeout) * 1000 - CLAUDE_MERGE_EVIDENCE_BUDGET_MS >= 5_000, "Claude evidence budget leaves at least five seconds for an explicit decision before the outer timeout");
let budgetClock = 0;
const budget = createEvidenceBudget(CLAUDE_MERGE_EVIDENCE_BUDGET_MS, () => budgetClock);
assert.throws(() => budget.run(() => { budgetClock = CLAUDE_MERGE_EVIDENCE_BUDGET_MS; return "late"; }), /budget expired/, "evidence budget rejects a request that consumes the remaining total deadline");
pass++;
ok(githubRepositoryIsGuarded("masonwells1/CRX_Manager_V1.0"), "canonical CRX repository identity is guarded");
ok(githubRepositoryIsGuarded("MASONWELLS1/crx_manager_v1.0"), "CRX repository identity is case-insensitive");
ok(!githubRepositoryIsGuarded("other/repository"), "foreign repository identity is rejected");
ok(ghApiMutates("gh api --method PUT repos/o/r/pulls/42/update-branch"), "unrecognized REST branch mutation is classified as a write");
ok(ghApiMutates("gh -R o/r api --method PUT repos/o/r/pulls/42/update-branch"), "global gh flags cannot hide a REST branch mutation");
ok(ghApiMutates("gh -R o/r api --method PATCH repos/o/r/git/refs/heads/main -f force=true"), "global gh flags cannot hide a forced ref update");
ok(ghApiMutates("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) }'"), "unrecognized GraphQL mutation is classified as a write");
ok(ghApiMutates('"/usr/bin/gh" api --method PATCH repos/o/r/git/refs/heads/main -f force=true'), "quoted Unix gh paths cannot hide API mutations");
ok(!ghApiMutates("gh api repos/o/r/pulls/42"), "plain gh API GET remains read-only");
ok(directGitHubApiWriter("curl -X POST https://api.github.com/graphql -d mutation"), "direct GraphQL writer is classified");
ok(directGitHubApiWriter("Invoke-RestMethod -Method Put https://api.github.com/repos/o/r/pulls/42/update-branch"), "direct REST writer is classified");
ok(!directGitHubApiWriter("echo https://api.github.com/graphql"), "documentation text is not mistaken for a direct API writer");
ok(directGitHubApiWriter("C:\\Windows\\System32\\curl.exe -X POST https://api.github.com/graphql"), "absolute Windows curl is classified");
ok(directGitHubApiWriter("/usr/bin/curl -X POST https://api.github.com/graphql"), "absolute POSIX curl is classified");
ok(directGitHubApiWriter("curl -X POST https://api.github.com:443/graphql"), "explicit GitHub API ports are classified");
ok(directGitHubApiWriter("irm https://api.github.com/graphql -Method Post -Body enablePullRequestAutoMerge"), "PowerShell Invoke-RestMethod alias is classified");
ok(directGitHubApiWriter("& iwr https://api.github.com/graphql -Method Post -Body enablePullRequestAutoMerge"), "PowerShell call-operator Invoke-WebRequest alias is classified");
ok(directGitHubApiWriter("pwsh -Command irm https://api.github.com/graphql -Method Post"), "wrapped PowerShell API invocation is classified");
ok(directGitHubApiWriter("cmd /c curl -X POST https://api.github.com/graphql -d mutation"), "cmd-wrapped GitHub API writer is classified");
ok(directGitHubApiWriter("env -i curl -X POST https://api.github.com./graphql -d mutation"), "env-wrapped trailing-dot GitHub API host is classified");
ok(directGitHubApiWriter("cmd /c \"curl -X POST https://user:token@api.github.com/graphql -d mutation\""), "wrapped userinfo GitHub API URL is classified");
ok(directGitHubApiWriter('curl -X POST https://api.""github.com/graphql -d mutation'), "quote-spliced GitHub API hostname is classified");
ok(directGitHubApiWriter("curl -X POST https://api.'git'hub.com/graphql -d mutation"), "embedded-quote GitHub API hostname is classified");
ok(!directGitHubApiWriter("curl https://api.github.com.evil.example/graphql"), "lookalike GitHub API host is not classified");
ok(!directGitHubApiWriter("curl https://api.github.com@evil.example/graphql"), "userinfo cannot disguise a non-GitHub host");
ok(ghCliCommandIsUnknownOrAlias("gh alias set ship 'api graphql'"), "GitHub CLI alias management is denied");
ok(ghCliCommandIsUnknownOrAlias("gh extension exec unsafe"), "GitHub CLI extensions are denied");
ok(ghCliCommandIsUnknownOrAlias("gh ship"), "unknown top-level gh command is treated as an alias");
ok(!ghCliCommandIsUnknownOrAlias("gh -R o/r pr view 42"), "known gh command after global flags remains classified");
const canonicalMutation = "gh pr merge 42 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789";
eq(githubMutationEnvironmentOverrideNames(canonicalMutation, { TRACE_LABEL: "fixture" }), ["TRACE_LABEL"], "every structured environment override on a GitHub mutation is classified");
eq(githubMutationUnsafeAmbientEnvironmentNames(canonicalMutation, { BASH_ENV: "fixture", GH_HOST: "attacker.example", GH_TOKEN: "expected-auth" }), ["BASH_ENV", "GH_HOST"], "unsafe ambient shell and GitHub context variables are classified without rejecting normal inherited authentication");
eq(githubMutationEnvironmentOverrideNames("gh pr view 42 --repo o/r", { TRACE_LABEL: "fixture" }), [], "read-only GitHub commands do not acquire the mutation environment rule");
ok(ghPrBaseRetargets("gh pr edit 42 --repo o/r --base main"), "literal PR base retarget is classified");
ok(ghPrBaseRetargets("gh -R o/r pr edit 42 --base=production"), "global flags and attached base values cannot hide retargeting");
ok(ghPrBaseRetargets("gh pr edit 42 --repo o/r -B main"), "short PR base retarget is classified");
ok(ghPrBaseRetargets("gh pr edit 42 --repo o/r -B=main"), "equals-attached short base values are classified");
ok(ghPrBaseRetargets("gh pr edit 42 --repo o/r -Bmain"), "directly attached short base values are classified");
ok(ghPrBaseRetargets("& 'C:\\Program Files\\GitHub CLI\\gh.exe' pr edit 42 --repo o/r --base main"), "PowerShell call-operator plus a quoted Windows gh path cannot hide a base retarget");
ok(!ghPrBaseRetargets("gh pr edit 42 --add-label ready"), "ordinary PR metadata edits are not base retargets");
ok(githubCliCommandIsDynamic("(gh pr edit 42 --base main)"), "grouped PR base retarget is dynamic");

// ── ghMergeRequest ───────────────────────────────────────────────────────────
eq(ghMergeRequest("gh pr merge 42 --squash"), { selector: "42", repo: "", auto: false, matchHead: "", squash: true, atomicHeadMatch: true }, "plain squash merge parses");
eq(ghMergeRequest("gh pr merge --squash --auto 7"), { selector: "7", repo: "", auto: true, matchHead: "", squash: true, atomicHeadMatch: true }, "--auto detected");
ok(ghMergeRequest("gh -R masonwells1/CRX_Manager_V1.0 pr merge 9")?.unsupportedSyntax, "global flags are outside the canonical grammar");
ok(ghMergeRequest("gh pr merge --repo=o/r")?.unsupportedSyntax, "attached repo values are outside the canonical grammar");
eq(ghMergeRequest("gh pr merge 42 --match-head-commit 0123456789012345678901234567890123456789"), { selector: "42", repo: "", auto: false, matchHead: "0123456789012345678901234567890123456789", squash: false, atomicHeadMatch: true }, "separate exact-head flag parses");
eq(ghMergeRequest("&gh pr merge 42 --auto"), { selector: "42", repo: "", auto: true, matchHead: "", squash: false, atomicHeadMatch: true }, "PowerShell call operator is normalized into the canonical grammar");
eq(ghMergeRequest("& 'C:\\Program Files\\GitHub CLI\\gh.exe' pr merge 42 --squash"), { selector: "42", repo: "", auto: false, matchHead: "", squash: true, atomicHeadMatch: true }, "quoted Windows gh paths enter the merge parser");
eq(ghMergeRequest('"/usr/bin/gh" pr merge 42 --squash'), { selector: "42", repo: "", auto: false, matchHead: "", squash: true, atomicHeadMatch: true }, "quoted Unix gh paths enter the merge parser");
ok(ghMergeRequest("gh pr merge 42 --match-head-commit=abcdefabcdefabcdefabcdefabcdefabcdefabcd")?.unsupportedSyntax, "attached exact-head values are outside the canonical grammar");
ok(ghMergeRequest("gh pr merge") !== null, "selectorless merge still gated");
eq(ghMergeRequest("gh pr merge 5 --disable-auto"), null, "--disable-auto stands down (cancels, does not land)");
ok(ghMergeRequest("gh pr merge 5 --auto --disable-auto")?.unsupportedAutoFlags, "mixed auto flags deny closed");
ok(ghMergeRequest("gh pr merge 5 --auto --body --disable-auto")?.unsupportedSyntax, "body options are outside the canonical grammar");
ok(ghMergeRequest("gh pr merge --body-file 123 456 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789")?.unsupportedSyntax, "unknown value-taking options cannot shift the inspected selector");
ok(ghMergeRequest("gh pr merge 123 456 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789")?.unsupportedSyntax, "multiple positional selectors fail closed");
ok(githubCliCommandIsDynamic("gh pr m''erge 5 --auto"), "empty-quote composed merge token is dynamic");
ok(githubCliCommandIsDynamic("PATH=/tmp/attacker gh pr merge 513 --squash"), "POSIX inline environments cannot replace the inspected gh executable");
ok(githubCliCommandIsDynamic("env -i PATH=/tmp/attacker gh api --method PATCH repos/o/r/git/refs/heads/main"), "env-wrapped GitHub mutations are dynamic");
ok(githubCliCommandIsDynamic("set PATH=C:\\attacker && gh pr merge 513 --squash"), "cmd environment setters cannot precede a GitHub mutation");
ok(githubCliCommandIsDynamic("$env:PATH='C:\\attacker'; gh pr merge 513 --squash"), "PowerShell environment setters cannot precede a GitHub mutation");
ok(githubCliCommandIsDynamic("g''h pr merge 5 --auto"), "empty-quote composed gh executable is dynamic");
ok(githubCliCommandIsDynamic("g'h' pr merge 5 --auto"), "quote-spliced gh executable is dynamic");
ok(githubCliCommandIsDynamic("(gh pr merge 5 --auto)"), "parenthesized gh merge is dynamic");
ok(githubCliCommandIsDynamic("echo <(gh api graphql --input payload.json)"), "process-substituted GitHub API is dynamic");
ok(githubCliCommandIsDynamic("g`h pr merge 5 --auto"), "PowerShell-composed gh executable is dynamic");
ok(githubCliCommandIsDynamic("g${EMPTY}h pr merge 5 --auto"), "POSIX-composed gh executable is dynamic");
ok(githubCliCommandIsDynamic("gh p\\r merge 5 --auto"), "POSIX-escaped pr token is dynamic");
ok(githubCliCommandIsDynamic("gh pr m\\erge 5 --auto"), "POSIX-escaped merge token is dynamic");
ok(githubCliCommandIsDynamic("gh a\\pi graphql --input payload.json"), "POSIX-escaped api token is dynamic");
ok(githubCliCommandIsDynamic("gh p^r merge 5 --auto"), "cmd-caret-composed pr token is dynamic");
ok(githubCliCommandIsDynamic("gh pr m^erge 5 --auto"), "cmd-caret-composed merge token is dynamic");
ok(githubCliCommandIsDynamic("gh a^pi graphql --input payload.json"), "cmd-caret-composed api token is dynamic");
ok(githubCliCommandIsDynamic('powershell -Command "gh pr merge 5 --admin"'), "nested PowerShell merge is dynamic");
ok(githubCliCommandIsDynamic('cmd /c "gh pr merge 5 --admin"'), "nested cmd merge is dynamic");
ok(githubCliCommandIsDynamic("bash -c 'gh api graphql --input payload.json'"), "nested Bash API call is dynamic");
ok(githubCliCommandIsDynamic("node -e \"require('child_process').execSync('gh pr merge 5 --admin')\""), "nested interpreter merge is dynamic");
eq(ghMergeRequest("gh pr view merge-notes"), null, "merge-notes is not the word merge");
ok(ghMergeRequest("gh pr view merge")?.unsupportedSyntax, "ambiguous exact merge words fail closed outside the canonical grammar");
eq(ghMergeRequest("git merge main"), null, "git merge is not a gh merge");
ok(ghMergeRequest("echo gh pr merge docs")?.unsupportedSyntax, "wrapped merge commands fail closed");
eq(ghMergeRequest("npm run build"), null, "unrelated command ignored");
ok(mergeRequestHasExplicitContext(ghMergeRequest("gh pr merge 42 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789")), "literal PR, repo, squash, and head form is explicit");
ok(!mergeRequestHasExplicitContext(ghMergeRequest("gh pr merge --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789")), "selectorless current-branch merges are not explicit");
ok(!mergeRequestHasExplicitContext(ghMergeRequest("gh pr merge 42 --squash --match-head-commit 0123456789012345678901234567890123456789")), "current-repository merges are not explicit");
ok(!mergeRequestHasExplicitContext(ghMergeRequest("gh pr merge 42 --repo o/r --match-head-commit 0123456789012345678901234567890123456789")), "merge method must be explicitly squash");

// ── ghUpdateBranchRequest ───────────────────────────────────────────────────
eq(ghUpdateBranchRequest("gh pr update-branch 42 --repo o/r"), { selector: "42", repo: "o/r", rebase: false, updateBranch: true }, "canonical update-branch parses");
eq(ghUpdateBranchRequest("gh pr update-branch --rebase 42 --repo o/r"), { selector: "42", repo: "o/r", rebase: true, updateBranch: true }, "canonical rebase update parses");
ok(updateBranchRequestHasExplicitContext(ghUpdateBranchRequest("gh pr update-branch 42 --repo o/r")), "explicit update-branch context is accepted");
for (const branch of ["main", "master", "production", "MAIN"]) {
  ok(branchNameIsProtected(branch), `protected update-branch head is classified: ${branch}`);
}
ok(!branchNameIsProtected("feature/test"), "ordinary feature head is not protected");
ok(!updateBranchRequestHasExplicitContext(ghUpdateBranchRequest("gh pr update-branch --repo o/r")), "selectorless update-branch context is rejected");
ok(ghUpdateBranchRequest("gh pr update-branch 42 --repo=o/r")?.unsupportedSyntax, "attached update-branch repo is outside the canonical grammar");
ok(githubCliCommandIsDynamic("(gh pr update-branch 42 --repo o/r)"), "grouped update-branch is dynamic");

// ── ghApiMergeRequest ────────────────────────────────────────────────────────
ok(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/12/merge")?.unsupportedRest, "REST merge endpoint is unsupported");
ok(ghApiMergeRequest("gh api --method=PUT https://api.github.com/repos/o/r/pulls/3/merge")?.unsupportedRest, "full-URL REST merge is unsupported");
ok(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/12/merge -f sha=0123456789012345678901234567890123456789")?.unsupportedRest, "REST merge with visible SHA remains unsupported");
ok(ghApiMergeRequest("gh api -X PUT repos/o/r/pulls/12/merge --input payload.json -f sha=0123456789012345678901234567890123456789")?.unsupportedRest, "file-backed REST body cannot override a visible SHA");
eq(ghApiMergeRequest("gh api repos/o/r/pulls/12"), null, "non-merge endpoint ignored");
ok(ghApiMergeRequest("gh api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge flagged unresolvable");
ok(ghApiMergeRequest("gh -R o/r api graphql -f query='mutation { mergePullRequest(input: {}) }'")?.unsupportedGraphql, "GraphQL merge with global flags between gh and api still flagged — Codex round-5");
ok(ghApiMergeRequest("gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) }'")?.unsupportedGraphql, "GraphQL auto-merge enable flagged unresolvable");
ok(ghApiMergeRequest("gh api graphql --input payload.json")?.fileBackedBody, "file-backed GraphQL input denies as uninspectable");
ok(ghApiMergeRequest("gh api graphql -F query=@mutation.graphql")?.fileBackedBody, "file-backed GraphQL query field denies as uninspectable");
ok(ghApiMergeRequest("gh api graphql --field=query=@mutation.graphql")?.fileBackedBody, "equals-form file-backed GraphQL query denies as uninspectable");
ok(ghApiMergeRequest("gh -R o/r api -X PUT repos/o/r/pulls/7/merge")?.unsupportedRest, "REST merge with global flags remains unsupported");
eq(ghApiMergeRequest("curl -X PUT api.github.com/repos/o/r/pulls/12/merge"), null, "curl is not a gh api call (denied by the hook's raw-REST rule instead)");

// ── mcpMergeRequest ──────────────────────────────────────────────────────────
eq(mcpMergeRequest({ owner: "o", repo: "r", pull_number: 8 }), { selector: "8", repo: "o/r", auto: false, matchHead: "", atomicHeadMatch: false }, "GitHub MCP spelling is marked non-atomic");
eq(mcpMergeRequest({ repository_full_name: "o/r", pr_number: 4 }), { selector: "4", repo: "o/r", auto: false, matchHead: "", atomicHeadMatch: false }, "app-style spelling is marked non-atomic");

// ── pullRequestChecksGreen ───────────────────────────────────────────────────
const greenCheck = { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" };
ok(pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [greenCheck] }), "clean + green passes");
ok(!pullRequestChecksGreen({ mergeStateStatus: "BLOCKED", statusCheckRollup: [greenCheck] }), "non-CLEAN fails");
ok(!pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [] }), "zero checks fails closed");
ok(!pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [{ __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" }] }), "running check fails");
ok(pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [greenCheck, { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" }] }), "skipped check tolerated");
ok(!pullRequestChecksGreen({ mergeStateStatus: "CLEAN", statusCheckRollup: [{ __typename: "StatusContext", state: "PENDING" }] }), "pending status context fails");

const reviewHead = "a".repeat(40);
const crStatus = (state = "success", description = "Review completed", creatorId = 136622811) => ({
  context: "CodeRabbit", state, description, creator: { id: creatorId }, updated_at: "2026-08-28T02:00:00Z",
});
const crReview = (state = "APPROVED", commitId = reviewHead) => ({
  state, commit_id: commitId, submitted_at: "2026-08-28T02:01:00Z", user: { login: "coderabbitai[bot]" },
});
const completeCr = { statuses: [crStatus()], reviews: [crReview()], comments: [], headSha: reviewHead };
ok(coderabbitReviewGate(completeCr).ok, "verified status plus APPROVED exact-head CodeRabbit review passes");
ok(!coderabbitReviewGate({ ...completeCr, statuses: [crStatus("success", "Review completed", 1)] }).ok, "lookalike status creator fails closed");
ok(!coderabbitReviewGate({ ...completeCr, statuses: [crStatus("pending", "Review in progress")] }).ok, "pending CodeRabbit status fails closed");
ok(!coderabbitReviewGate({ ...completeCr, statuses: [crStatus("success", "Review rate limited")] }).ok, "false-green rate-limited status fails closed");
ok(!coderabbitReviewGate({ ...completeCr, reviews: [crReview("APPROVED", "b".repeat(40))] }).ok, "review of an older head fails closed");
ok(!coderabbitReviewGate({ ...completeCr, reviews: [crReview("CHANGES_REQUESTED")] }).ok, "unresolved CodeRabbit changes-requested review fails closed");
ok(!coderabbitReviewGate({ ...completeCr, comments: [{ body: "Review failed", updated_at: "2026-08-28T02:02:00Z", user: { login: "coderabbitai[bot]" } }] }).ok, "false-green walkthrough failure fails closed");

// ── hook decision paths that need no gh (stdin spawn) ────────────────────────
const HOOK = path.join(__dirname, "pr-merge-guard.mjs");
const mergeGuardSource = readFileSync(HOOK, "utf8");
ok(!/execFileSync\(\s*["']git["']/.test(mergeGuardSource), "merge guard never launches PATH-resolved bare git before making a security decision");
ok(/execFileSync\(fixedGitExecutable\(\)/.test(mergeGuardSource), "merge guard worktree discovery uses the fixed Git executable");
function runHook(payload, extraEnv = {}) {
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 15000,
    env: { ...process.env, ...extraEnv },
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
ok(/GraphQL merge/.test(r.decision?.permissionDecisionReason || ""), "GraphQL deny explains itself");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {}) }'" } });
ok(r.decision?.permissionDecision === "deny", "GraphQL auto-merge enable denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh api graphql --input payload.json" } });
ok(r.decision?.permissionDecision === "deny", "file-backed GraphQL body denied before it can hide auto-merge");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh api graphql -F query=@mutation.graphql" } });
ok(r.decision?.permissionDecision === "deny", "file-backed GraphQL query field denied before it can hide auto-merge");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh api --method PUT repos/masonwells1/CRX_Manager_V1.0/pulls/123/update-branch" } });
ok(r.decision?.permissionDecision === "deny", "unrecognized gh REST update-branch mutation is denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh -R masonwells1/CRX_Manager_V1.0 api --method PATCH repos/masonwells1/CRX_Manager_V1.0/git/refs/heads/main -f force=true" } });
ok(r.decision?.permissionDecision === "deny", "global gh flags cannot hide a forced ref update");

r = runHook({ tool_name: "Bash", tool_input: { command: "curl -X POST https://api.github.com/graphql -d '{\"query\":\"mutation { enablePullRequestAutoMerge(input: {}) }\"}'" } });
ok(r.decision?.permissionDecision === "deny", "direct curl GraphQL auto-merge mutation is denied");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "Invoke-RestMethod -Method Put https://api.github.com/repos/masonwells1/CRX_Manager_V1.0/pulls/123/update-branch" } });
ok(r.decision?.permissionDecision === "deny", "direct PowerShell REST branch mutation is denied");

for (const command of [
  "C:\\Windows\\System32\\curl.exe -X POST https://api.github.com/graphql -d mutation",
  "/usr/bin/curl -X POST https://api.github.com/graphql -d mutation",
  "curl -X POST https://api.github.com:443/graphql -d mutation",
  "irm https://api.github.com/graphql -Method Post -Body enablePullRequestAutoMerge",
  "& iwr https://api.github.com/graphql -Method Post -Body enablePullRequestAutoMerge",
  "pwsh -Command irm https://api.github.com/graphql -Method Post",
  "cmd /c curl -X POST https://api.github.com/graphql -d mutation",
  "env -i curl -X POST https://api.github.com./graphql -d mutation",
  "cmd /c \"curl -X POST https://user:token@api.github.com/graphql -d mutation\"",
  'curl -X POST https://api.""github.com/graphql -d mutation',
  "curl -X POST https://api.'git'hub.com/graphql -d mutation",
  "gh alias set ship 'api graphql'",
  "gh extension exec unsafe",
  "gh ship",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  ok(r.decision?.permissionDecision === "deny", `normalized GitHub writer or alias is denied: ${command}`);
}

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr view 123 --repo masonwells1/CRX_Manager_V1.0" } });
ok(r.status === 0 && r.decision === null, "known read-only gh command remains available");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr edit 123 --repo masonwells1/CRX_Manager_V1.0 --base main" } });
ok(r.decision?.permissionDecision === "deny", "CLI PR base retarget is denied");

for (const command of [
  "gh pr edit 123 --repo masonwells1/CRX_Manager_V1.0 -B main",
  "gh pr edit 123 --repo masonwells1/CRX_Manager_V1.0 -B=main",
  "gh pr edit 123 --repo masonwells1/CRX_Manager_V1.0 -Bmain",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  ok(r.decision?.permissionDecision === "deny", `short CLI PR base retarget is denied: ${command}`);
}

r = runHook({ tool_name: "mcp__github__update_pull_request", tool_input: { owner: "masonwells1", repo: "CRX_Manager_V1.0", pull_number: 123, base: "main" } });
ok(r.decision?.permissionDecision === "deny", "GitHub tool PR base retarget is denied");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "&gh pr merge 42 --auto" } });
ok(r.decision?.permissionDecision === "deny", "PowerShell call-operator auto-merge is denied");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "& 'C:\\Program Files\\GitHub CLI\\gh.exe' pr merge 42 --auto" } });
ok(r.decision?.permissionDecision === "deny", "quoted Windows gh path cannot bypass the merge guard");

r = runHook({ tool_name: "Bash", tool_input: { command: '"/usr/bin/gh" api --method PATCH repos/o/r/git/refs/heads/main -f force=true' } });
ok(r.decision?.permissionDecision === "deny", "quoted Unix gh path cannot bypass the API mutation guard");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "gh pr merge 42 --auto --body --disable-auto" } });
ok(r.decision?.permissionDecision === "deny", "disable-auto used as body text cannot bypass real auto flag");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789", env: { GH_HOST: "attacker.example" } } });
ok(r.decision?.permissionDecision === "deny", "structured GH_HOST override denies before merge inspection");
ok(/structured GitHub context overrides/.test(r.decision?.permissionDecisionReason || ""), "structured environment denial explains the execution-context mismatch");

for (const name of ["BASH_ENV", "ENV", "HTTP_PROXY", "SSL_CERT_FILE", "HOME", "PATH", "TRACE_LABEL"]) {
  r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 42 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789", env: { [name]: "fixture" } } });
  ok(r.decision?.permissionDecision === "deny", `structured GitHub mutation environment is denied: ${name}`);
}

for (const [name, value] of [
  ["BASH_ENV", "C:/fixture/startup.sh"],
  ["ENV", "C:/fixture/startup.sh"],
  ["ZDOTDIR", "C:/fixture/zdot"],
  ["GH_CONFIG_DIR", "C:/fixture/gh-config"],
  ["GH_HOST", "attacker.example"],
  ["GITHUB_HOST", "attacker.example"],
  ["GH_REPO", "attacker/repo"],
  ["GITHUB_API_URL", "https://attacker.example/api"],
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command: canonicalMutation } }, { [name]: value });
  ok(r.decision?.permissionDecision === "deny", `ambient ${name} denies a GitHub mutation before merge inspection`);
}

r = runHook({ tool_name: "PowerShell", tool_input: { command: "gh pr m''erge 42 --auto" } });
ok(r.decision?.permissionDecision === "deny", "empty-quote composed merge token denies before parsing");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "g`h pr merge 42 --auto" } });
ok(r.decision?.permissionDecision === "deny", "PowerShell-composed gh executable denies before parsing");

r = runHook({ tool_name: "Bash", tool_input: { command: "g'h' pr merge 42 --auto" } });
ok(r.decision?.permissionDecision === "deny", "quote-spliced gh executable denies before parsing");

r = runHook({ tool_name: "Bash", tool_input: { command: "(gh pr merge 42 --auto)" } });
ok(r.decision?.permissionDecision === "deny", "parenthesized gh merge denies before parsing");

r = runHook({ tool_name: "Bash", tool_input: { command: "(gh pr update-branch 42 --repo o/r)" } });
ok(r.decision?.permissionDecision === "deny", "parenthesized update-branch denies before parsing");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr update-branch 42 --repo masonwells1/CRX_Manager_V1.0 --rebase" } });
ok(r.decision?.permissionDecision === "deny", "unattended update-branch rebase is denied as a history rewrite");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "C:/attacker/gh.exe pr merge 42 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789" } });
ok(r.decision?.permissionDecision === "deny", "arbitrary GitHub CLI path denies before PR inspection");
ok(/trusted GitHub CLI/.test(r.decision?.permissionDecisionReason || ""), "untrusted executable denial explains the fixed binary boundary");

r = runHook({ tool_name: "Bash", tool_input: { command: "g${EMPTY}h pr merge 42 --auto" } });
ok(r.decision?.permissionDecision === "deny", "POSIX-composed gh executable denies before parsing");

for (const command of [
  "gh p\\r merge 42 --auto",
  "gh pr m\\erge 42 --auto",
  "gh a\\pi graphql --input payload.json",
  "gh p^r merge 42 --auto",
  "gh pr m^erge 42 --auto",
  "gh a^pi graphql --input payload.json",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  ok(r.decision?.permissionDecision === "deny", `escaped GitHub CLI command denies before parsing: ${command}`);
}

for (const command of [
  'powershell -Command "gh pr merge 42 --admin"',
  'cmd /c "gh pr merge 42 --admin"',
  "bash -c 'gh api graphql --input payload.json'",
  "node -e \"require('child_process').execSync('gh pr merge 42 --admin')\"",
]) {
  r = runHook({ tool_name: "Bash", tool_input: { command } });
  ok(r.decision?.permissionDecision === "deny", `nested GitHub CLI activity denies before parsing: ${command}`);
}

r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge --body-file 123 456 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789" } });
ok(r.decision?.permissionDecision === "deny", "unknown body-file option cannot shift the inspected PR selector");
ok(/noncanonical/.test(r.decision?.permissionDecisionReason || ""), "unknown merge option denial names the canonical grammar");

r = runHook({ tool_name: "PowerShell", tool_input: { command: "gh pr merge 42 --squash # --repo attacker/safe --match-head-commit 0123456789012345678901234567890123456789" } });
ok(r.decision?.permissionDecision === "deny", "PowerShell comment cannot forge repository and head context");

r = runHook({ tool_name: "Bash", tool_input: { command: "gh api -X PUT repos/o/r/pulls/12/merge --input payload.json -f sha=0123456789012345678901234567890123456789" } });
ok(r.decision?.permissionDecision === "deny", "file-backed REST merge denied before it can override the visible SHA");

r = runHook({ tool_name: "Bash", tool_input: { command: "$verb='merge'; gh pr $verb 12 --squash --auto" } });
ok(r.decision?.permissionDecision === "deny", "shell-expanded gh merge verb is denied before literal parsing");
ok(/shell-expanded/.test(r.decision?.permissionDecisionReason || ""), "dynamic GitHub CLI denial explains the parser boundary");

r = runHook({ tool_name: "Bash", tool_input: { command: "PATH=/tmp/attacker gh pr merge 12 --repo o/r --squash --match-head-commit 0123456789012345678901234567890123456789" } });
ok(r.decision?.permissionDecision === "deny", "command-local PATH cannot replace the gh executable after inspection");

r = runHook({ tool_name: "Bash", tool_input: { command: "git switch other-branch && gh pr merge --squash" } });
ok(r.decision?.permissionDecision === "deny", "compound selectorless merge cannot inspect the pre-switch branch");
ok(/standalone/.test(r.decision?.permissionDecisionReason || ""), "compound merge denial requires one stable command context");

r = runHook({ tool_name: "Bash", tool_input: { command: "GH_REPO=other/repo gh pr merge 12 --match-head-commit 0123456789012345678901234567890123456789" } });
ok(r.decision?.permissionDecision === "deny", "GitHub repository environment override is denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "curl -X PUT -H 'Authorization: token x' https://api.github.com/repos/o/r/pulls/12/merge" } });
ok(r.decision?.permissionDecision === "deny", "raw curl REST merge denied (Codex finding 2026-07-16)");

r = runHook({ tool_name: "Bash", tool_input: { command: "Invoke-RestMethod -Method Put -Uri https://api.github.com/repos/o/r/pulls/12/merge" } });
ok(r.decision?.permissionDecision === "deny", "PowerShell REST merge denied");

r = runHook({ tool_name: "Bash", tool_input: { command: "echo docs about /pulls/12/merges endpoint" } });
ok(r.status === 0 && r.decision === null, "merge-suffixed word boundary respected (merges != merge)");

// Codex round-6: a gh merge earlier in the chain must not exempt later segments.
r = runHook({ tool_name: "Bash", tool_input: { command: "gh pr merge 5 --squash; curl -X PUT https://api.github.com/repos/o/r/pulls/9/merge" } });
ok(r.decision?.permissionDecision === "deny", "raw REST merge after a gh merge in the same chain still denied");
ok(/(?:raw|direct) GitHub REST/.test(r.decision?.permissionDecisionReason || "") || /fail closed/.test(r.decision?.permissionDecisionReason || ""), "chain deny cites the REST rule or fails closed on PR resolution");

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
  /coderabbitReviewGate\([\s\S]{0,500}?statuses:[\s\S]{0,500}?reviews:[\s\S]{0,500}?comments:[\s\S]{0,500}?headSha:/.test(guardSource),
  "the Claude merge guard binds CodeRabbit status, review, comment, and exact-head evidence before merging",
);
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
ok(
  /if\s*\(\s*request\.auto\s*\)[\s\S]{0,500}?denied for every PR regardless of its current base/.test(guardSource),
  "every --auto request is denied regardless of base before risk classification",
);
const autoGateIndex = guardSource.indexOf("if (request.auto)");
const nonRiskyReturnIndex = guardSource.indexOf("if (risky.length === 0 && !contentFlagged) return;");
ok(autoGateIndex !== -1 && nonRiskyReturnIndex !== -1 && autoGateIndex < nonRiskyReturnIndex,
  "the universal auto-merge deny executes before the non-risky early return");
ok(/--match-head-commit <head-sha>/.test(guardSource), "auto-merge guidance requires an exact-head immediate merge");
ok(/request\.atomicHeadMatch\s*===\s*false/.test(guardSource), "main-bound merge tools without atomic expected-head support deny");
ok(/requestedHead\.toLowerCase\(\)\s*!==\s*actualHead\.toLowerCase\(\)/.test(guardSource), "the supplied expected head must equal GitHub's inspected head");
ok(/request\.updateBranch\s*&&\s*branchNameIsProtected\(destinationBranch\)/.test(guardSource), "the Claude guard denies update-branch when the PR head is protected");
ok(/request\.updateBranch\s*&&\s*pr\.autoMergeRequest\s*!==\s*null/.test(guardSource), "the Claude guard denies update-branch when the target PR already has auto-merge armed");
ok(/request\.updateBranch\s*&&\s*!pullRequestHeadMatchesRepository\(pr, request\.repo\)/.test(guardSource), "the Claude guard fails closed on fork-owned update-branch heads");

const landPrSource = readFileSync(path.resolve(__dirname, "../../scripts/land-pr.mjs"), "utf8");
ok(/--match-head-commit \$\{pr\.headRefOid\}/.test(landPrSource), "land-pr pins both printed merge commands to the inspected head SHA");
ok(/trustedGitHubCliInvocation/.test(landPrSource), "land-pr child GitHub calls use the fixed executable and sanitized context");
ok(/exhaustiveHeadPullRequestsLookupArgs\(REPO, headRefName\)/.test(landPrSource), "land-pr exhaustively paginates every open PR fed by the destination head branch");
const sameRepoUpdate = {
  headRepositoryOwner: { login: "masonwells1" },
  autoMergeRequest: null,
  repository: "masonwells1/CRX_Manager_V1.0",
};
eq(assessLandPrUpdate({ ...sameRepoUpdate, headRefName: "feature/safe", openPullRequests: [] }).allowed, true, "land-pr permits an ordinary head with no armed protected-base PR");
eq(assessLandPrUpdate({ ...sameRepoUpdate, headRefName: "main", openPullRequests: [] }).allowed, false, "land-pr refuses a protected destination head");
eq(assessLandPrUpdate({
  ...sameRepoUpdate,
  headRefName: "contributor-topic",
  headRepositoryOwner: { login: "outside-contributor" },
  autoMergeRequest: { enabledAt: "2026-08-28T00:00:00Z" },
  openPullRequests: [],
}).allowed, false, "land-pr refuses an armed fork PR before attempting update-branch");
const stackedUpdate = assessLandPrUpdate({
  ...sameRepoUpdate,
  headRefName: "feature/shared",
  openPullRequests: [
    { number: 513, baseRefName: "develop", autoMergeRequest: null },
    { number: 514, baseRefName: "main", autoMergeRequest: { enabledAt: "2026-08-28T00:00:00Z" } },
  ],
});
eq(stackedUpdate.allowed, false, "land-pr refuses a shared head that feeds another armed main PR");
eq(stackedUpdate.armed, [514], "land-pr reports the exact armed stacked PR");
const laterPageUpdate = assessLandPrUpdate({
  ...sameRepoUpdate,
  headRefName: "feature/shared",
  openPullRequests: [
    Array.from({ length: 30 }, (_, index) => ({ number: 600 + index, auto_merge: null, base: { ref: "main" } })),
    [{ number: 999, auto_merge: { merge_method: "squash" }, base: { ref: "production" } }],
  ],
});
eq(laterPageUpdate.allowed, false, "land-pr catches an armed protected PR after the old 30-result boundary");
eq(laterPageUpdate.armed, [999], "land-pr reports the exact later-page armed PR");

console.log(`pr-merge-guard: ${pass} assertions passed`);
