// Shared predicates for the Codex GitHub App's automated pull-request review
// (`chatgpt-codex-connector`), so the merge gates can stop treating it as
// invisible. Added 2026-09-02.
//
// WHY THIS EXISTS
// ---------------
// The Codex App has been reviewing every PR in this repo since it was enabled
// in the ChatGPT Codex cloud settings, and NOTHING in this repository read its
// output: a grep for `chatgpt-codex-connector` across hooks, skills, commands,
// scripts and docs returned zero hits before this file. It posts a summary
// comment and, when it has suggestions, a real review — into a void.
//
// That was survivable while main required an approval CodeRabbit had to grant.
// It stopped being survivable on 2026-09-02, when the Claude-side merge gate
// downgraded "no current approval" from a deny to a printed notice. An
// automated review that nobody reads is now worse than no review: it renders a
// green check on the PR page that reads as coverage.
//
// THE TWO SPELLINGS OF THE BOT'S NAME  (both verified live 2026-09-02)
// -------------------------------------------------------------------
//   `gh pr view --json reviews`  -> author.login === "chatgpt-codex-connector"
//   REST .../pulls/<n>/reviews   -> user.login   === "chatgpt-codex-connector[bot]"
// Matching one spelling and not the other is the silent-failure mode for this
// whole file: the predicate finds no bot reviews, reports "nothing to see", and
// every merge sails through looking checked. Both spellings are pinned in the
// tests, and the GraphQL thread path uses the bare spelling.
//
// WHY THIS READS THREADS, NOT REVIEW OBJECTS  (measured, not assumed)
// -------------------------------------------------------------------
// The first cut of this file blocked on "the bot submitted a COMMENTED review
// whose commit oid is the head". Running that against all 10 open PRs on
// 2026-09-02 flagged SIX of them, which sent me to look at why:
//
//   PR #547  13 Codex reviews, one per commit, newest at the head
//   PR #530  19 Codex reviews, newest at the head
//   PR #516  23 Codex reviews, newest at the head
//
// The App's own "About Codex in GitHub" blurb lists its triggers as PR-opened,
// draft-marked-ready, and an `@codex review` comment — it does NOT mention
// pushes. The blurb is not what the App actually does: it re-reviews on
// essentially every push. So a COMMENTED review object sitting on the head is
// the ORDINARY state of an active PR, not a signal that anything is wrong.
//
// Worse, a review object has no exit. You cannot resolve one; the bot simply
// posts another on the next push. A gate keyed to it could never be satisfied —
// exactly the deadlock that got main's required review relaxed the day before.
//
// The signal that carries real information is the REVIEW THREAD, and its
// `isResolved` flag. Same six PRs, counted at thread level:
//
//   PR   codexThreads  codexUnresolved  unresolvedAtHead
//   449      24              1                1
//   530      40             40                1
//   535       7              7                2
//   547      19              1                1
//   556       1              1                1
//   544       5              5                1
//
// PRs #449 and #547 show 24 and 19 Codex threads with ONE unresolved each:
// people really do work these threads, so resolution state distinguishes
// "handled" from "standing". And the gate's unit of work is 1-2 items with a
// clear exit — fix it, or resolve the thread with a reason.
//
// DELIBERATE FAIL-OPEN — READ BEFORE "HARDENING" THIS
// ---------------------------------------------------
// Almost every other predicate in this repo fails closed. This one does not,
// and that is deliberate (Mason chose the narrow-block option on 2026-09-02).
// This layer is an honest-mistake net for an ADVISORY reviewer; the hard gates
// are elsewhere and unchanged — CI's required checks, and the exact-SHA
// `gpt-5.6-sol` proof `pr-merge-guard.mjs` demands for a risky diff. So every
// uncertainty here degrades to a loud notice, never to a locked door:
//
//   findings-at-head : >=1 UNRESOLVED Codex thread anchored to THIS head
//                      -> DENY. It flagged this exact code and nobody
//                         answered. Exit: fix it, or resolve the thread.
//   stale            : it has threads, but none unresolved at this head -> NOTICE
//   none             : no Codex threads / the data could not be fetched -> NOTICE
//   clean-at-head    : it reviewed this head and nothing is outstanding -> silent
//
// Thread reads page up to CODEX_THREAD_MAX_PAGES (see collectCodexThreads).
// Beyond that a PR could hide an unresolved thread, which loses a DENY rather
// than inventing one — the safe direction for a fail-open gate.

// Both API spellings, lowercased. `[bot]` is a suffix GitHub's REST API adds
// and `gh`/GraphQL strip; neither is more canonical than the other.
export const CODEX_BOT_LOGINS = Object.freeze([
  "chatgpt-codex-connector",
  "chatgpt-codex-connector[bot]",
]);

// GraphQL page size for reviewThreads. 100 is GitHub's per-page maximum, so
// covering a longer PR means paging, not a bigger number.
export const CODEX_THREAD_PAGE_SIZE = 100;

// How many pages collectCodexThreads() will walk. Three pages = 300 threads,
// which clears every PR on this board by a wide margin (the largest, #530, has
// 48) while keeping the worst case to three API calls inside a hook that must
// answer quickly. Running out of pages loses a DENY rather than inventing one.
export const CODEX_THREAD_MAX_PAGES = 3;

export function isCodexBotLogin(login) {
  return CODEX_BOT_LOGINS.includes(String(login || "").trim().toLowerCase());
}

// The GraphQL query the guards run to get thread resolution state. `gh pr view`
// has no `reviewThreads` field (verified 2026-09-02: "Unknown JSON field"), so
// this is the only route to `isResolved`.
//
// `originalCommit.oid` is the commit the thread was FIRST left on, which is what
// "flagged this exact code" means. GitHub re-anchors older comments onto newer
// heads for display, so the thread's displayed position is not evidence of when
// it was raised.
export const CODEX_THREADS_QUERY = `
query($owner:String!, $name:String!, $number:Int!, $first:Int!, $after:String) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$number) {
      headRefOid
      reviewThreads(first:$first, after:$after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          comments(first:1) { nodes { author { login } originalCommit { oid } } }
        }
      }
    }
  }
}`;

// Walk up to CODEX_THREAD_MAX_PAGES pages of review threads and return a single
// pullRequest-shaped object for evaluateCodexBotReview().
//
// `runQuery(cursor)` performs one GraphQL request and returns the parsed
// `pullRequest` node (or null/undefined). The caller owns transport, so the
// Claude and Codex guards can each use their own gh runner without forking this
// paging logic.
//
// Added after a Codex review of this file's own PR flagged the unpaginated
// single-page read (CRX-REV-002): on a PR with more than 100 threads the
// unresolved one could sit on a page nobody fetched, and the gate would report
// "nothing standing" while something was.
export function collectCodexThreads(runQuery) {
  let cursor = null;
  let headRefOid = "";
  const nodes = [];
  for (let page = 0; page < CODEX_THREAD_MAX_PAGES; page += 1) {
    const pr = runQuery(cursor);
    if (!pr) break;
    if (!headRefOid) headRefOid = String(pr.headRefOid || "");
    const threads = pr?.reviewThreads;
    if (Array.isArray(threads?.nodes)) nodes.push(...threads.nodes);
    if (threads?.pageInfo?.hasNextPage !== true) break;
    const next = String(threads?.pageInfo?.endCursor || "");
    // No cursor but "hasNextPage" would loop forever on the same page.
    if (!next || next === cursor) break;
    cursor = next;
  }
  return { headRefOid, reviewThreads: { nodes } };
}

// Normalize one GraphQL reviewThread node into { author, oid, resolved }.
// Everything unknown becomes "" / false, which never matches a head.
function normalizeThread(node) {
  const first = node?.comments?.nodes?.[0];
  return {
    author: String(first?.author?.login ?? "").trim().toLowerCase(),
    // The empty string means "unknown" and must never compare equal to a head.
    oid: String(first?.originalCommit?.oid ?? "").trim().toLowerCase(),
    resolved: node?.isResolved === true,
  };
}

// Every still-open review thread the Codex App started on this PR.
export function codexBotThreads(pullRequest) {
  const nodes = pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(nodes)) return [];
  return nodes.map(normalizeThread).filter((thread) => isCodexBotLogin(thread.author));
}

// Does a thread's originating commit identify the head being merged?
//
// The empty string means "unknown" on BOTH sides and must never compare equal.
// This is not belt-and-braces: `gh pr view --json latestReviews` returns
// commit.oid "" on every entry, and a GraphQL node whose first comment cannot be
// read normalizes to "" here too. Without the explicit emptiness test an unknown
// oid and an unknown head would match each other, and a thread bound to nothing
// would be treated as bound to this exact commit.
//
// Split out of evaluateCodexBotReview() so it is reachable on its own: inside
// that function an empty head returns early, which made the emptiness test dead
// code that mutation testing could delete without any test going red.
export function oidMatchesHead(oid, head) {
  const left = String(oid || "").trim().toLowerCase();
  const right = String(head || "").trim().toLowerCase();
  return left !== "" && right !== "" && left === right;
}

// The blocking condition, in one place: an unresolved Codex thread raised
// against the exact commit being merged.
export function isStandingAtHead(thread, head) {
  return thread?.resolved !== true && oidMatchesHead(thread?.oid, head);
}

// Classify the Codex App's position on the head that is about to merge.
//
// Returns { status, unresolvedAtHead, codexThreads, headOid }, where status is
// "findings-at-head" | "clean-at-head" | "stale" | "none". Only
// "findings-at-head" blocks a merge; see the fail-open note above.
export function evaluateCodexBotReview(pullRequest) {
  const head = String(pullRequest?.headRefOid || "").trim().toLowerCase();
  const threads = codexBotThreads(pullRequest);
  const base = { unresolvedAtHead: 0, codexThreads: threads.length, headOid: head };

  if (threads.length === 0) return { status: "none", ...base };
  // An unknown head cannot be matched against anything. Report rather than
  // guess — "stale" prints, it does not block.
  if (!head) return { status: "stale", ...base };

  // Unresolved AND raised against this exact commit.
  const standing = threads.filter((thread) => isStandingAtHead(thread, head));
  if (standing.length > 0) {
    return { status: "findings-at-head", ...base, unresolvedAtHead: standing.length };
  }

  // It has threads here, but nothing unresolved is anchored to this head:
  // either everything was worked, or its findings predate the current commit.
  const anyAtHead = threads.some((thread) => oidMatchesHead(thread.oid, head));
  return { status: anyAtHead ? "clean-at-head" : "stale", ...base };
}

// The deny text for "findings-at-head". Kept here so the Claude and Codex
// guards cannot drift into two different explanations of the same refusal.
export function codexBotFindingsDenial(prefix, selector, count) {
  const which = selector ? String(selector) : "<number>";
  const n = Number(count) > 0 ? Number(count) : 1;
  const noun = n === 1 ? "an unresolved comment" : `${n} unresolved comments`;
  const answered = n === 1 ? "it" : "them";
  return (
    `${prefix}: the Codex GitHub App has ${noun} raised against THIS EXACT commit, and nothing has ` +
    `answered ${answered}. Merging now lands code an automated reviewer flagged and nobody addressed.\n\n` +
    `  1. Read them:  gh pr view ${which} --comments      (author: chatgpt-codex-connector)\n` +
    "  2. Fix each real issue and push.\n" +
    "  3. For a genuine nitpick, reply with a one-line reason and RESOLVE the thread — resolving is\n" +
    "     the intended exit here, not a workaround.\n\n" +
    "Only unresolved comments on the exact head block a merge. Threads already resolved, and findings " +
    "raised against earlier commits, do not."
  );
}
