#!/usr/bin/env node
// The merge gate's CodeRabbit enforcement, tested as BEHAVIOUR.
//
// Why this file exists. For five review rounds the exact-head CodeRabbit check
// lived only in `.claude/skills/deploy-check/SKILL.md` — a procedure an operator
// was asked to follow. Codex raised that as a finding every round and finally as
// High: `auto_pause_after_reviewed_commits: 2` means later pushes are NOT
// auto-reviewed, so a green status check sitting on an unreviewed head was
// reachable, and nothing mechanical stopped a merge there. A second High: the
// operator substituted `<HEAD>` separately into each verification command and
// into `--match-head-commit`, so evidence could be checked for one SHA while
// another was merged.
//
// Both are now enforced in `.claude/hooks/pr-merge-guard.mjs`. This file tests
// the decision logic by CALLING it, not by matching substrings of the command
// text — the lesson PR #441 kept relearning is that a substring assertion over a
// documented command describes intent and passes just as happily for the broken
// version.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODERABBIT_FAILURE_MARKERS,
  coderabbitVerdict,
  cycleHasFailureMarker,
  ghMergeRequest,
  isCanonicalWalkthrough,
  reviewObjectBindsHead,
  stampLineBindsHead,
} from "../.claude/hooks/codex-push-lib.mjs";

const ROOT = path.resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; };

const HEAD = "0adbe71f5b12fc0b3b1fbea99c67ef3d17ad5f42";
const OTHER = "91ca13ad4a63a5ee712c6079fdd566e5466f822d";
const BASE = "56321c0d083e958d445854c3310878b916aa971a";
const CYCLE = "2026-08-24T15:00:00Z";
const SUMMARIZE = "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->";

// ── --match-head-commit is captured, not discarded ───────────────────────────
// It was previously parsed only to skip its value, so the guard could not
// compare it to anything. (Codex, High, PR #441.)
for (const [label, cmd] of [
  ["space-separated", `gh pr merge 441 --squash --match-head-commit ${HEAD}`],
  ["equals form", `gh pr merge 441 --squash --match-head-commit=${HEAD}`],
]) {
  const parsed = ghMergeRequest(cmd);
  ok(parsed?.matchHeadCommit === HEAD, `--match-head-commit value is captured (${label})`);
  ok(parsed?.isGhCli === true, `a gh CLI merge is marked as pinnable (${label})`);
  ok(parsed?.selector === "441", `the PR selector still parses alongside the pin (${label})`);
}
ok(
  ghMergeRequest("gh pr merge 441 --squash")?.matchHeadCommit === "",
  "an unpinned merge reports no --match-head-commit rather than undefined",
);
// The repo flag must not be swallowed by the new branch, and vice versa.
const bothFlags = ghMergeRequest(`gh pr merge 441 --repo a/b --match-head-commit ${HEAD}`);
ok(bothFlags?.repo === "a/b" && bothFlags?.matchHeadCommit === HEAD, "--repo and --match-head-commit both parse together");

// ── the stamp matcher ────────────────────────────────────────────────────────
// CodeRabbit renders the range line blockquoted while reviewing and bare inside
// the collapsed <details> block once done. Both are real; anchoring on one form
// silently blocks every finished review.
ok(
  stampLineBindsHead(`> Reviewing files that changed from the base of the PR and between ${BASE} and ${HEAD}.`, HEAD),
  "the blockquoted in-progress stamp binds",
);
ok(
  stampLineBindsHead(`Reviewing files that changed from the base of the PR and between ${BASE} and ${HEAD}.`, HEAD),
  "the bare completed-review stamp binds",
);
// Each of these CONTAINS the head SHA and would satisfy an unanchored `and <sha>`.
for (const [label, body] of [
  ["prose that merely mentions the SHA", `This PR rebases onto and ${HEAD} per the notes.`],
  ["a summarised diff line", `+ // pinned to and ${HEAD}`],
  ["a stamp indented into a code block", `    Reviewing files that changed from the base of the PR and between ${BASE} and ${HEAD}.`],
  ["a stamp with text appended", `Reviewing files that changed from the base of the PR and between ${BASE} and ${HEAD}. (cached)`],
  ["a stamp naming a different head", `Reviewing files that changed from the base of the PR and between ${BASE} and ${OTHER}.`],
  ["a non-hex base", `Reviewing files that changed from the base of the PR and between zzz and ${HEAD}.`],
]) {
  ok(!stampLineBindsHead(body, HEAD), `stamp matcher REJECTS ${label}`);
}
ok(!stampLineBindsHead(`... and ${HEAD}.`, "not-a-sha"), "stamp matcher rejects a malformed head argument");

// ── canonical walkthrough vs solicitable chat reply ──────────────────────────
// chat.auto_reply is on and the repo is public: anyone can ask the bot to echo a
// SHA, so an unfiltered bot comment is forgeable evidence.
ok(
  isCanonicalWalkthrough({ user: { login: "coderabbitai[bot]" }, body: `${SUMMARIZE}\nwalkthrough` }),
  "the canonical walkthrough comment is accepted",
);
for (const [label, comment] of [
  ["a chat auto-reply carrying the summarize marker", { user: { login: "coderabbitai[bot]" }, body: `${SUMMARIZE}\nauto-generated reply by CodeRabbit` }],
  ["a bot comment with no summarize marker", { user: { login: "coderabbitai[bot]" }, body: "looks good to me" }],
  ["a human comment quoting the marker", { user: { login: "mason" }, body: SUMMARIZE }],
]) {
  ok(!isCanonicalWalkthrough(comment), `walkthrough filter REJECTS ${label}`);
}

// ── review objects bind through structured commit_id ─────────────────────────
const submitted = { user: { login: "coderabbitai[bot]" }, submitted_at: "2026-08-24T15:10:00Z", state: "COMMENTED", commit_id: HEAD };
ok(reviewObjectBindsHead(submitted, HEAD), "a submitted bot review whose commit_id is the head binds");
for (const [label, review] of [
  ["a review submitted against an older commit", { ...submitted, commit_id: OTHER }],
  ["an unsubmitted (PENDING) review", { ...submitted, submitted_at: null }],
  ["a dismissed review", { ...submitted, state: "DISMISSED" }],
  ["a review by a non-bot account", { ...submitted, user: { login: "mason" } }],
  ["a review with no commit_id", { ...submitted, commit_id: undefined }],
  ["a review whose BODY names the head but whose commit_id does not", { ...submitted, commit_id: OTHER, body: `...and ${HEAD}.` }],
]) {
  ok(!reviewObjectBindsHead(review, HEAD), `review binding REJECTS ${label}`);
}

// ── failure markers scoped to this head's own cycle ──────────────────────────
// A stamp proves the review STARTED, never that it finished.
for (const marker of CODERABBIT_FAILURE_MARKERS) {
  ok(
    cycleHasFailureMarker([{ user: { login: "coderabbitai[bot]" }, created_at: "2026-08-24T15:05:00Z", body: marker }], CYCLE),
    `a "${marker}" comment in this cycle is detected`,
  );
}
ok(
  !cycleHasFailureMarker([{ user: { login: "coderabbitai[bot]" }, created_at: "2026-08-24T14:00:00Z", body: "Review failed" }], CYCLE),
  "a failure from a PREVIOUS cycle does not block a clean retry forever",
);
ok(
  cycleHasFailureMarker([], ""),
  "an undeterminable cycle start FAILS CLOSED rather than reporting no failures",
);
ok(
  !cycleHasFailureMarker([{ user: { login: "mason" }, created_at: "2026-08-24T15:05:00Z", body: "Review failed" }], CYCLE),
  "a human quoting a failure marker does not block the merge",
);

// ── the whole verdict ────────────────────────────────────────────────────────
const cleanComments = [{ user: { login: "coderabbitai[bot]" }, created_at: "2026-08-24T15:05:00Z", body: `${SUMMARIZE}\nReviewing files that changed from the base of the PR and between ${BASE} and ${HEAD}.` }];
// The walkthrough stamp is written when a review STARTS, so on its own it is
// consistent with one still running — and with auto-review paused, "still
// running" is indistinguishable from "never going to report". The stamp path
// therefore also needs a completed CodeRabbit status for this cycle.
// (Codex, High, PR #441.)
const DONE = [{ context: "CodeRabbit", state: "success", created_at: "2026-08-24T15:20:00Z" }];
const STILL_RUNNING = [{ context: "CodeRabbit", state: "pending", created_at: CYCLE }];
ok(
  coderabbitVerdict({ reviews: [], comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE, statuses: DONE }) === null,
  "a CLEAN review (stamp + completed status, no review object) is accepted",
);
ok(
  coderabbitVerdict({ reviews: [submitted], comments: [], headSha: HEAD, cycleStartIso: CYCLE, statuses: STILL_RUNNING }) === null,
  "a submitted review object is terminal on its own and needs no completed status",
);
// Every failure path must return a reason (truthy) — never silently pass.
for (const [label, args] of [
  ["no evidence at all", { reviews: [], comments: [], headSha: HEAD, cycleStartIso: CYCLE, statuses: DONE }],
  ["evidence bound to a different head", { reviews: [{ ...submitted, commit_id: OTHER }], comments: [], headSha: HEAD, cycleStartIso: CYCLE, statuses: DONE }],
  ["a malformed head", { reviews: [submitted], comments: cleanComments, headSha: "nope", cycleStartIso: CYCLE, statuses: DONE }],
  ["reviews unreadable", { reviews: null, comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE, statuses: DONE }],
  ["comments unreadable", { reviews: [submitted], comments: null, headSha: HEAD, cycleStartIso: CYCLE, statuses: DONE }],
  ["a stamped head whose review then failed", {
    reviews: [], headSha: HEAD, cycleStartIso: CYCLE, statuses: DONE,
    comments: [...cleanComments, { user: { login: "coderabbitai[bot]" }, created_at: "2026-08-24T15:06:00Z", body: "Review failed" }],
  }],
  ["an undeterminable cycle start", { reviews: [submitted], comments: cleanComments, headSha: HEAD, cycleStartIso: "", statuses: DONE }],
  ["a stamp whose review is STILL RUNNING", { reviews: [], comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE, statuses: STILL_RUNNING }],
  ["a stamp with no status data at all", { reviews: [], comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE, statuses: [] }],
  ["a stamp whose statuses are unreadable", { reviews: [], comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE, statuses: null }],
  ["a stamp whose only success predates this cycle", {
    reviews: [], comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE,
    statuses: [{ context: "CodeRabbit", state: "success", created_at: "2026-08-24T14:00:00Z" }],
  }],
  ["a stamp with a success from a DIFFERENT check context", {
    reviews: [], comments: cleanComments, headSha: HEAD, cycleStartIso: CYCLE,
    statuses: [{ context: "Vercel", state: "success", created_at: "2026-08-24T15:20:00Z" }],
  }],
]) {
  const verdict = coderabbitVerdict(args);
  ok(typeof verdict === "string" && verdict.length > 0, `verdict BLOCKS ${label}`);
}

// ── the hook itself still runs and still fails closed ────────────────────────
// Two cases that need no network, driven through the real hook process.
function runHook(payload) {
  return execFileSync("node", [path.join(ROOT, ".claude", "hooks", "pr-merge-guard.mjs")], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
}
ok(
  runHook({ tool_name: "Bash", tool_input: { command: "git status" }, cwd: ROOT }).trim() === "",
  "the hook passes through a command that is not a merge",
);
const graphql = runHook({
  tool_name: "Bash",
  tool_input: { command: 'gh api graphql -f query=\'mutation { mergePullRequest(input: {pullRequestId: "x"}) { clientMutationId } }\'' },
  cwd: ROOT,
});
ok(
  /"permissionDecision":"deny"/.test(graphql),
  "the hook still denies GraphQL mergePullRequest, which it cannot verify",
);

console.log(`pr-merge-guard-coderabbit: ${pass} assertions passed`);
