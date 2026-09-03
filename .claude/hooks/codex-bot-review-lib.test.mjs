#!/usr/bin/env node
// Tests for the Codex GitHub App review predicates (2026-09-02).
//
// The failure mode this suite exists to prevent is SILENT: if the login match,
// the oid binding, or the resolution check is wrong, every predicate returns
// "nothing to see here" and every merge sails through looking checked. A green
// run of this file must therefore mean the checks actually fired, so the
// canaries below assert the DENY direction, not only the allow direction.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CODEX_BOT_LOGINS,
  CODEX_THREADS_QUERY,
  CODEX_THREAD_MAX_PAGES,
  codexBotFindingsDenial,
  codexBotThreads,
  collectCodexThreads,
  evaluateCodexBotReview,
  isCodexBotLogin,
  isStandingAtHead,
  oidMatchesHead,
} from "./codex-bot-review-lib.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let pass = 0;
function ok(v, m) { assert.ok(v, m); pass++; }
function eq(a, b, m) { assert.deepEqual(a, b, m); pass++; }

const HEAD = "53e9c07142a4428848a3cebc0c31d2c1b83334c9";
const OLD = "306d1e263e0000000000000000000000000000aa";

// Build a GraphQL-shaped reviewThread node.
const thread = ({ login = "chatgpt-codex-connector", oid = HEAD, resolved = false } = {}) => ({
  isResolved: resolved,
  isOutdated: false,
  comments: { nodes: [{ author: { login }, originalCommit: { oid } }] },
});
const pr = (threads, headRefOid = HEAD) => ({ headRefOid, reviewThreads: { nodes: threads } });

// ── the two spellings of the bot's name ──────────────────────────────────────
// Verified live 2026-09-02 on PR #556: `gh pr view --json reviews` reports
// author.login "chatgpt-codex-connector"; REST .../pulls/556/reviews reports
// user.login "chatgpt-codex-connector[bot]". Matching one and not the other is
// the silent no-op this whole file guards against.
ok(isCodexBotLogin("chatgpt-codex-connector"), "gh/GraphQL spelling (no [bot] suffix) matches");
ok(isCodexBotLogin("chatgpt-codex-connector[bot]"), "REST spelling (with [bot] suffix) matches");
ok(isCodexBotLogin("  Chatgpt-Codex-Connector[BOT]  "), "match is case- and whitespace-insensitive");
ok(!isCodexBotLogin("coderabbitai[bot]"), "a different review bot does not match");
ok(!isCodexBotLogin("masonwells1"), "a human does not match");
ok(!isCodexBotLogin(""), "empty login does not match");
ok(!isCodexBotLogin(undefined), "missing login does not match");
// Substring matching would let an impostor account pass; the list is exact.
ok(!isCodexBotLogin("not-chatgpt-codex-connector"), "MUST NOT MATCH: compared exactly, not by substring");
ok(!isCodexBotLogin("chatgpt-codex-connector-evil"), "MUST NOT MATCH: suffixed impostor login");
eq(CODEX_BOT_LOGINS.length, 2, "both API spellings are pinned");

// ── thread extraction ────────────────────────────────────────────────────────
eq(codexBotThreads(pr([thread()])).length, 1, "a Codex thread is found");
eq(codexBotThreads(pr([thread({ login: "coderabbitai" })])).length, 0, "CodeRabbit's threads are not Codex's");
eq(codexBotThreads(pr([])).length, 0, "no threads yields none");
eq(codexBotThreads({ headRefOid: HEAD }).length, 0, "absent reviewThreads yields none rather than throwing");
eq(codexBotThreads({ headRefOid: HEAD, reviewThreads: { nodes: "x" } }).length, 0, "non-array nodes yields none");
eq(codexBotThreads(pr([{ isResolved: false, comments: { nodes: [] } }])).length, 0, "a thread with no comments has no author and is skipped");

// ── THE BLOCKING CASE: an unresolved thread on the exact head ────────────────
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: HEAD })])).status,
  "findings-at-head",
  "MUST BLOCK: an unresolved Codex thread raised against the head is standing findings",
);
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: HEAD })])).unresolvedAtHead,
  1,
  "the count of standing items is reported so the denial can name it",
);
eq(
  evaluateCodexBotReview(pr([
    thread({ resolved: false, oid: HEAD }),
    thread({ resolved: false, oid: HEAD }),
    thread({ resolved: true, oid: HEAD }),
  ])).unresolvedAtHead,
  2,
  "only UNRESOLVED at-head threads are counted",
);
// Oid comparison must be case-insensitive: GitHub renders oids lowercase, but a
// caller could pass an uppercased head.
eq(
  evaluateCodexBotReview({
    headRefOid: HEAD.toUpperCase(),
    reviewThreads: { nodes: [thread({ resolved: false, oid: HEAD })] },
  }).status,
  "findings-at-head",
  "MUST BLOCK: head/oid match is case-insensitive",
);

// ── the non-blocking cases (deliberate fail-open — see the lib header) ───────
eq(
  evaluateCodexBotReview(pr([thread({ resolved: true, oid: HEAD })])).status,
  "clean-at-head",
  "a RESOLVED thread on the head is handled, not standing — resolving is the intended exit",
);
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: OLD })])).status,
  "stale",
  "an unresolved thread raised against an OLDER commit is a notice, never a block",
);
eq(
  evaluateCodexBotReview(pr([])).status,
  "none",
  "no Codex threads at all is a notice, never a block",
);
eq(
  evaluateCodexBotReview({ headRefOid: HEAD }).status,
  "none",
  "threads never fetched is a notice, never a block — a failed GraphQL call must not deny",
);
// This asymmetry is load-bearing. Measured on the live board 2026-09-02, the
// Codex App re-reviews on essentially every push (#547 had 13 review objects,
// #530 19, #516 23), so a gate keyed to review OBJECTS would have flagged 6 of
// 10 open PRs with no way to ever satisfy it. These assertions are the ones
// that should fail if someone widens the block back out.
ok(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: OLD })])).status !== "findings-at-head",
  "MUST NOT BLOCK: an older-commit finding must never be reported as standing at the head",
);
ok(
  evaluateCodexBotReview(pr([thread({ resolved: true, oid: HEAD })])).status !== "findings-at-head",
  "MUST NOT BLOCK: a resolved thread must never be reported as standing findings",
);
ok(
  evaluateCodexBotReview(pr([])).status !== "findings-at-head",
  "MUST NOT BLOCK: absent findings must never be reported as standing findings",
);

// ── the empty-oid trap, tested at the primitive ──────────────────────────────
// These MUST be asserted against oidMatchesHead/isStandingAtHead directly.
// Inside evaluateCodexBotReview an empty head returns early, so an emptiness
// test buried in the filter is unreachable — mutation testing on 2026-09-02
// deleted exactly that check and the whole suite stayed green.
ok(!oidMatchesHead("", ""), "MUST NOT MATCH: unknown oid vs unknown head");
ok(!oidMatchesHead("", HEAD), "MUST NOT MATCH: unknown oid vs a real head");
ok(!oidMatchesHead(HEAD, ""), "MUST NOT MATCH: a real oid vs an unknown head");
ok(!oidMatchesHead(undefined, undefined), "MUST NOT MATCH: both sides missing");
ok(!oidMatchesHead("   ", "   "), "MUST NOT MATCH: whitespace-only is still unknown");
ok(oidMatchesHead(HEAD, HEAD), "a real oid matches an identical head");
ok(oidMatchesHead(HEAD.toUpperCase(), HEAD), "oid match is case-insensitive");
ok(oidMatchesHead(` ${HEAD} `, HEAD), "oid match tolerates surrounding whitespace");
ok(!isStandingAtHead({ resolved: false, oid: "" }, ""), "MUST NOT BLOCK: unknown-vs-unknown is not a standing finding");
ok(isStandingAtHead({ resolved: false, oid: HEAD }, HEAD), "unresolved at the head IS a standing finding");
ok(!isStandingAtHead({ resolved: true, oid: HEAD }, HEAD), "MUST NOT BLOCK: resolved at the head is not standing");

// An unknown oid must never compare equal to a head, in either direction.
eq(
  evaluateCodexBotReview(pr([thread({ resolved: false, oid: "" })])).status,
  "stale",
  "an empty thread oid is unknown, not a match for the head",
);
eq(
  evaluateCodexBotReview({ headRefOid: "", reviewThreads: { nodes: [thread({ oid: "" })] } }).status,
  "stale",
  "MUST NOT MATCH: empty head vs empty oid is not a head-bound finding",
);
eq(
  evaluateCodexBotReview({ headRefOid: "", reviewThreads: { nodes: [thread()] } }).status,
  "stale",
  "an unknown head cannot bind any thread",
);

// ── measured real-board shapes (2026-09-02) ──────────────────────────────────
// PR #449: 24 Codex threads, exactly 1 unresolved, at the head. The point of
// this case is that a PR can carry a long history of worked threads and still
// be correctly reduced to one outstanding item.
const pr449 = [
  ...Array.from({ length: 23 }, () => thread({ resolved: true, oid: OLD })),
  thread({ resolved: false, oid: HEAD }),
];
eq(evaluateCodexBotReview(pr(pr449)).status, "findings-at-head", "PR #449 shape: 23 worked threads + 1 standing at head still blocks");
eq(evaluateCodexBotReview(pr(pr449)).unresolvedAtHead, 1, "PR #449 shape: exactly one item to act on");
eq(evaluateCodexBotReview(pr(pr449)).codexThreads, 24, "PR #449 shape: total Codex threads reported for context");
// PR #530: 40 Codex threads, 40 unresolved, but only 1 anchored to the head.
// Restricting to the head is what keeps the ask actionable instead of a wall.
const pr530 = [
  ...Array.from({ length: 39 }, () => thread({ resolved: false, oid: OLD })),
  thread({ resolved: false, oid: HEAD }),
];
eq(evaluateCodexBotReview(pr(pr530)).unresolvedAtHead, 1, "PR #530 shape: 40 unresolved overall reduces to 1 at the head");

// ── paging (CRX-REV-002 from this PR's own Codex review) ─────────────────────
// A single 100-thread page can hide the one unresolved thread that matters.
{
  const page = (nodes, hasNextPage, endCursor) => ({
    headRefOid: HEAD,
    reviewThreads: { pageInfo: { hasNextPage, endCursor }, nodes },
  });

  // Two pages: the standing finding is on page 2 and MUST be found.
  const calls = [];
  const two = collectCodexThreads((cursor) => {
    calls.push(cursor);
    return cursor === null
      ? page([thread({ resolved: true, oid: HEAD })], true, "c1")
      : page([thread({ resolved: false, oid: HEAD })], false, null);
  });
  eq(calls, [null, "c1"], "the first page is fetched with no cursor, the second with the returned cursor");
  eq(two.reviewThreads.nodes.length, 2, "nodes from both pages are merged");
  eq(
    evaluateCodexBotReview(two).status,
    "findings-at-head",
    "MUST BLOCK: an unresolved thread on the SECOND page is still found",
  );

  // hasNextPage:false stops immediately.
  let n = 0;
  collectCodexThreads(() => { n += 1; return page([], false, null); });
  eq(n, 1, "paging stops when hasNextPage is false");

  // A server that claims hasNextPage forever must not spin: bounded by
  // CODEX_THREAD_MAX_PAGES.
  let runaway = 0;
  collectCodexThreads(() => { runaway += 1; return page([thread()], true, `c${runaway}`); });
  eq(runaway, CODEX_THREAD_MAX_PAGES, "paging is bounded by CODEX_THREAD_MAX_PAGES");

  // hasNextPage true but no usable cursor would otherwise refetch page 1 forever.
  let stuck = 0;
  collectCodexThreads(() => { stuck += 1; return page([thread()], true, ""); });
  eq(stuck, 1, "an empty endCursor stops paging instead of refetching the same page");
  let repeat = 0;
  collectCodexThreads(() => { repeat += 1; return page([thread()], true, "same"); });
  eq(repeat, 2, "a repeated endCursor stops paging rather than looping");

  // A failed request mid-walk keeps what was already read.
  const partial = collectCodexThreads((cursor) =>
    cursor === null ? page([thread({ resolved: false, oid: HEAD })], true, "c1") : null);
  eq(partial.reviewThreads.nodes.length, 1, "a null page ends the walk without discarding earlier nodes");
  eq(evaluateCodexBotReview(partial).status, "findings-at-head", "partial results still block when they carry a standing finding");
  eq(collectCodexThreads(() => null).headRefOid, "", "an immediately failed fetch yields an empty head, which reads as 'none'");
  eq(evaluateCodexBotReview(collectCodexThreads(() => null)).status, "none", "a total fetch failure is 'none', never a block");
}
// The query must accept a cursor, or paging silently refetches page one.
ok(/\$after\s*:\s*String/.test(CODEX_THREADS_QUERY), "query declares an $after cursor variable");
ok(/after\s*:\s*\$after/.test(CODEX_THREADS_QUERY), "query passes $after to reviewThreads");
ok(/pageInfo\s*{[^}]*hasNextPage/.test(CODEX_THREADS_QUERY), "query selects pageInfo.hasNextPage");
ok(/pageInfo\s*{[^}]*endCursor/.test(CODEX_THREADS_QUERY), "query selects pageInfo.endCursor");

// ── the denial text names the count and the exit ─────────────────────────────
const denial = codexBotFindingsDenial("PR MERGE GATE", "561", 2);
ok(/chatgpt-codex-connector/.test(denial), "denial names the bot so the reader can find the thread");
ok(/gh pr view 561 --comments/.test(denial), "denial carries the exact command to read the findings");
ok(/2 unresolved comments/.test(denial), "denial states how many items are standing");
ok(/RESOLVE the thread/i.test(denial), "denial states the exit, so the gate is satisfiable");
ok(/an unresolved comment\b/.test(codexBotFindingsDenial("X", "1", 1)), "denial is singular for one item");

// ── the query asks for the fields the predicate reads ────────────────────────
// `gh pr view` has no reviewThreads field, so GraphQL is the only route to
// isResolved. If the query stops selecting one of these, the predicate silently
// sees undefined and reports "none" for every PR.
ok(/reviewThreads/.test(CODEX_THREADS_QUERY), "query selects reviewThreads");
ok(/isResolved/.test(CODEX_THREADS_QUERY), "query selects isResolved — the whole point of the thread route");
ok(/originalCommit/.test(CODEX_THREADS_QUERY), "query selects originalCommit, the commit a finding was raised against");
ok(/author/.test(CODEX_THREADS_QUERY), "query selects the comment author, used to tell Codex from CodeRabbit");
ok(/headRefOid/.test(CODEX_THREADS_QUERY), "query selects headRefOid to bind against");

// ── the guard actually calls this, and only findings-at-head denies ──────────
// A predicate nobody wires in is worth nothing; assert the call site exists.
const guardSource = readFileSync(path.join(__dirname, "pr-merge-guard.mjs"), "utf8");
ok(/codex-bot-review-lib\.mjs/.test(guardSource), "pr-merge-guard.mjs imports from codex-bot-review-lib.mjs");
// Assert the CALL SITE, not the name: the import statement alone satisfies a
// bare /evaluateCodexBotReview/ match, so mutation testing was able to replace
// the call with `null` while this assertion stayed green (2026-09-02).
ok(
  /codexVerdict\s*=\s*evaluateCodexBotReview\s*\(/.test(guardSource),
  "pr-merge-guard.mjs assigns the result of an actual evaluateCodexBotReview(...) call — importing the name is not wiring it in",
);
ok(/findings-at-head/.test(guardSource), "pr-merge-guard.mjs branches on the findings-at-head status");
ok(/CODEX_THREADS_QUERY/.test(guardSource), "pr-merge-guard.mjs runs the shared GraphQL query rather than a private copy");
// The notice path must exist too, or the stale/none cases vanish silently and
// the whole "stop ignoring this reviewer" purpose is lost.
// All THREE non-blocking paths must announce themselves. A bare
// /CODEX REVIEW NOTICE/ test is satisfied by any one of them, so mutation
// testing was able to silence the fetch-failure branch — the most important one,
// because that is the case where the reviewer was never consulted at all — with
// the suite still green (2026-09-02).
eq(
  (guardSource.match(/CODEX REVIEW NOTICE/g) || []).length,
  3,
  "pr-merge-guard.mjs prints a notice on all three non-blocking paths (fetch-failed, stale, none)",
);
ok(
  /CODEX REVIEW NOTICE: could not read/.test(guardSource),
  "the fetch-failure path says the findings were NOT checked — silence there would look like a clean pass",
);
ok(
  /fails open by design/.test(guardSource),
  "the fetch-failure notice states that this gate fails open, so the reader knows what the silence means",
);
ok(/collectCodexThreads/.test(guardSource), "pr-merge-guard.mjs pages the thread read rather than taking one page");

// ── the Codex-side guard must not be the silent twin (CRX-REV-003) ───────────
// A one-sided guard is the drift AGENTS.md forbids, and a SILENT fail-open there
// is indistinguishable from "the reviewer had nothing to say".
const codexGuardSource = readFileSync(
  path.join(__dirname, "..", "..", ".codex", "hooks", "production-action-guard.mjs"),
  "utf8",
);
ok(/codex-bot-review-lib\.mjs/.test(codexGuardSource), "the Codex guard imports the same shared predicates, not a copy");
ok(
  /codexVerdict\s*=\s*evaluateCodexBotReview\s*\(/.test(codexGuardSource),
  "the Codex guard actually calls evaluateCodexBotReview(...)",
);
ok(/findings-at-head/.test(codexGuardSource), "the Codex guard branches on findings-at-head");
ok(/collectCodexThreads/.test(codexGuardSource), "the Codex guard pages the thread read too");
eq(
  (codexGuardSource.match(/CODEX REVIEW NOTICE/g) || []).length,
  3,
  "the Codex guard prints all three non-blocking notices, matching the Claude guard",
);

// ── gate ORDERING, pinned on both guards ─────────────────────────────────────
// This pin was INVERTED on 2026-09-03 by Codex round 6, and the reason matters
// more than the direction.
//
// It originally required the App-review check to run FIRST, so an unanswered
// review comment would be the message the reader got rather than "wait for CI".
// That reasoning was about message quality. The cost was a security hole: this
// lookup is advisory, fail-open, and costs up to four `gh` calls each capped at
// 10s, against hook budgets of 15s (Codex) and 30s (Claude). A PreToolUse hook
// killed mid-call emits nothing, and a hook that emits nothing does NOT deny —
// the class PR #502 established. So a slow GitHub could starve every HARD
// denial that came after it: CHANGES_REQUESTED, the green pipeline, the
// risky-diff classification, and the exact-SHA Sol proof.
//
// The advisory therefore runs LAST, at the points where the alternative is
// returning ALLOW anyway. Both properties are pinned below, because each one
// alone is satisfiable by a broken guard:
//   * ordering — every hard denial precedes the advisory, so none can be starved;
//   * REACHABILITY — the advisory is still actually invoked, or this is the dead
//     code the original pin existed to prevent (it sat behind the Codex guard's
//     approval deny and never ran for any PR without a formal approval).
const codexAdvisoryCallAt = codexGuardSource.indexOf("codexAppAdvisory({ request");
const codexVerdictMatch = codexGuardSource.match(
  /if \((?:!pullRequestApproved\(pullRequest\)|pullRequestReviewBlocked\(pullRequest\))\)/,
);
ok(codexVerdictMatch, "the Codex guard still has a review-verdict deny to order against");
const codexApprovalAt = codexVerdictMatch.index;
const codexGreenAt = codexGuardSource.indexOf("if (!pullRequestChecksGreen(pullRequest))");
const codexProofAt = codexGuardSource.indexOf("gateMainChange({");
ok(
  codexAdvisoryCallAt > 0 && codexApprovalAt > 0 && codexGreenAt > 0 && codexProofAt > 0,
  "all four Codex-guard gates are present to order",
);
ok(
  codexAdvisoryCallAt > codexApprovalAt,
  "MUST RUN LAST: the Codex guard's advisory lookup follows its review-verdict deny, or a slow GitHub can starve that deny and the hook denies nothing",
);
ok(
  codexAdvisoryCallAt > codexGreenAt,
  "MUST RUN LAST: the Codex guard's advisory lookup follows its green-pipeline deny",
);
ok(
  codexAdvisoryCallAt > codexProofAt,
  "MUST RUN LAST: the Codex guard's advisory lookup follows the exact-SHA proof gate",
);
// REACHABILITY — the advisory must be invoked on the allow path, not merely defined.
ok(
  /if \(mainVerdict\.blocked\) return mainVerdict;/.test(codexGuardSource),
  "the Codex guard returns a hard denial before reaching the advisory",
);
ok(
  /const advisory = codexAppAdvisory\(/.test(codexGuardSource)
  && /if \(advisory\) return advisory;/.test(codexGuardSource),
  "the Codex guard still ACTS on the advisory verdict — defining it without returning it is the dead code this pin exists to catch",
);

// The Claude guard now defines codexAdvisory() above gateRequest, so ordering
// must be measured at the CALL SITES. Measuring the definition would compare the
// wrong thing and pass no matter where the call lands.
const claudeAdvisoryCalls = [...guardSource.matchAll(/codexAdvisory\(request\);/g)].map((m) => m.index);
const claudeGreenAt = guardSource.indexOf("green-pipeline requirement");
const claudeProofAt = guardSource.indexOf("require the fresh, bound Codex proof");
eq(
  claudeAdvisoryCalls.length,
  2,
  "the Claude guard invokes the advisory at BOTH allow points (non-risky, and risky-with-valid-proof) — one call site means the other path silently skips the check",
);
ok(claudeGreenAt > 0 && claudeProofAt > 0, "both Claude-guard hard gates are present to order");
ok(
  claudeAdvisoryCalls.every((at) => at > claudeGreenAt),
  "MUST RUN LAST: every Claude-guard advisory call follows the green-pipeline deny",
);
// The proof gate is reachable only on the RISKY path, so only the second call
// site sits after it — the first returns ALLOW before the proof section exists
// to run. Asserting "every call follows the proof gate" would be wrong, not
// stricter: it would demand the non-risky path wait on a gate that never applies.
const claudeRiskyClassifyAt = guardSource.indexOf("risky-diff classification");
ok(claudeRiskyClassifyAt > 0, "the Claude guard's risky-diff classification is present to order");
ok(
  claudeAdvisoryCalls[0] > claudeRiskyClassifyAt,
  "MUST RUN LAST: the non-risky allow point follows the risky-diff classification, which denies (fail closed) when the diff cannot be read",
);
ok(
  claudeAdvisoryCalls[1] > claudeProofAt,
  "MUST RUN LAST: the risky allow point follows the exact-SHA proof gate",
);

// ── the lookup is BOUNDED, on both guards ────────────────────────────────────
// Ordering alone stops the advisory from starving a hard denial. The deadline is
// what stops it from burning the whole hook budget and killing the process
// before it can print its own notices.
for (const [label, source] of [["Claude", guardSource], ["Codex", codexGuardSource]]) {
  const budgetMatch = source.match(/const CODEX_ADVISORY_BUDGET_MS = ([\d_]+);/);
  ok(budgetMatch, `the ${label} guard declares an advisory time budget`);
  const budgetMs = Number(budgetMatch[1].replace(/_/g, ""));
  // Hook budgets: 15s for the Codex guard (.codex/hooks.json), 30s for the
  // Claude guard (.claude/settings.json). Half is the ceiling, so the hard gates
  // and the notices always have room left.
  const hookBudgetMs = label === "Codex" ? 15_000 : 30_000;
  ok(
    budgetMs > 0 && budgetMs <= hookBudgetMs / 2,
    `the ${label} guard's advisory budget (${budgetMs}ms) must stay at or under half its ${hookBudgetMs}ms hook timeout`,
  );
  ok(
    /collectCodexThreads\([\s\S]{0,2000}?\{ deadlineMs \}\)/.test(source),
    `the ${label} guard actually PASSES the deadline to collectCodexThreads — declaring a budget it never applies is decoration`,
  );
}

// The deadline must THROW, never return a partial read: a truncated walk that
// reports "nothing standing" is indistinguishable from a clean one.
let deadlineThrew = false;
try {
  collectCodexThreads(() => ({ headRefOid: "a".repeat(40), reviewThreads: { nodes: [], pageInfo: {} } }), {
    deadlineMs: 1_000,
    now: () => 2_000,
  });
} catch {
  deadlineThrew = true;
}
ok(deadlineThrew, "an exceeded deadline THROWS (callers turn that into their fail-open notice) rather than returning a partial read as clean");

// …and a deadline in the future does not interfere with an ordinary walk.
eq(
  collectCodexThreads(() => ({ headRefOid: "b".repeat(40), reviewThreads: { nodes: [], pageInfo: {} } }), {
    deadlineMs: 10_000,
    now: () => 1_000,
  }).headRefOid,
  "b".repeat(40),
  "a deadline that has not passed leaves the walk untouched",
);

console.log(`codex-bot-review-lib: ${pass} assertions passed`);
