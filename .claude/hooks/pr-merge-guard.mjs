#!/usr/bin/env node
// PreToolUse(*) guard: gate PR merges into main the way codex-push-guard gates
// pushes to main. Added 2026-07-16 (scaffolding design review, Theme 1): the
// 2026-07-14 `protect-main` ruleset made direct pushes to main impossible, so
// the landing action moved to `gh pr merge` / the GitHub MCP merge tool — and
// Claude's risky-diff Codex gate never followed. This hook closes that gap:
//
//   * merge into main with a fully green pipeline + non-risky diff → allowed
//     (the standing 2026-06-16 landing authorization stays intact);
//   * merge whose diff touches migrations / edge functions / money-RLS code /
//     guard machinery → requires the same fresh, HEAD- and base-bound Codex
//     proof codex-push-guard requires (minted only by
//     scripts/write-codex-push-proof.mjs — hand-writing is blocked);
//   * merge with a non-green pipeline → denied (for a NON-risky diff, `--auto`
//     is tolerated — GitHub itself defers the merge until required checks pass;
//     for a RISKY diff `--auto` is denied outright, because it would land
//     later-pushed commits with a stale proof — Codex round-4 finding);
//   * GraphQL mergePullRequest / unresolvable PR context → denied, fail closed.
//
// Mirrors .codex/hooks/production-action-guard.mjs's merge route (the Codex
// side has had this gate since 2026-07-14). Shared parsing/validation lives in
// codex-push-lib.mjs — one pattern table, no forked logic.
//
// This is an honest-mistake net, not a security boundary: GitHub branch
// protection (required Vercel check) remains the external hard wall.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  contentIsRisky,
  describeRiskyContent,
  ghApiMergeRequest,
  ghMergeRequest,
  mcpMergeRequest,
  proofSearchDirs,
  proofValid,
  pullRequestApproved,
  pullRequestChecksGreen,
  pullRequestReviewBlocked,
  riskyFiles,
} from "./codex-push-lib.mjs";
import {
  CODEX_THREADS_QUERY,
  CODEX_THREAD_PAGE_SIZE,
  codexBotFindingsDenial,
  collectCodexThreads,
  evaluateCodexBotReview,
} from "./codex-bot-review-lib.mjs";

const GITHUB_MERGE_TOOL = /merge_pull_request$/i;

function passthrough() { process.exit(0); }
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { passthrough(); }

const toolName = String(payload?.tool_name || "");
const toolInput = payload?.tool_input || {};

// ── detect merge intent — EVERY segment, EVERY request ───────────────────────
// The parse loop must not stop at the first hit: `gh pr merge <feature-PR>;
// gh pr merge <main-PR>` would otherwise gate only the harmless first merge and
// let the second run ungated, and a raw REST call after a gh merge would never
// be seen at all (Codex round-6 finding on this guard's own PR). Collect every
// request; deny immediately on any unresolvable form in any segment.
const requests = [];
if (GITHUB_MERGE_TOOL.test(toolName)) {
  requests.push(mcpMergeRequest(toolInput));
} else if (typeof toolInput.command === "string" && toolInput.command) {
  for (const segment of toolInput.command.split(/(?:&&|\|\|?|;|\r?\n)/)) {
    // The mergePullRequest mutation is denied by NAME, whatever transport
    // carries it — `gh api graphql`, curl, Invoke-RestMethod, a fetch in a node
    // one-liner. Until 2026-09-01 only the `gh api graphql` spelling was caught
    // (below), which was survivable because GitHub itself refused an unapproved
    // merge and a raw call just got a 405. Mason's admin override removed that
    // backstop, and Codex's proof on PR #541 found the transport gap on both
    // guards. Naming the destination beats enumerating the tools that reach it.
    if (/\bmergePullRequest\b/i.test(segment)) {
      deny("PR MERGE GATE: GraphQL mergePullRequest mutations are denied — whatever transport carries them — because the guard cannot resolve and verify the PR's base, head, and checks for them. Use `gh pr merge <number>` so the gate can verify the merge.");
    }
    const api = ghApiMergeRequest(segment);
    // Subsumed by the name check above; kept as the backstop if that check is
    // ever narrowed.
    if (api?.unsupportedGraphql) {
      deny("PR MERGE GATE: GraphQL mergePullRequest mutations are denied because the guard cannot safely resolve and verify the PR's head/checks. Use `gh pr merge <number>` instead.");
    }
    const found = api || ghMergeRequest(segment);
    // Raw REST merges outside gh — curl/wget/Invoke-RestMethod/node fetch — name
    // the same endpoint but carry auth/context the guard cannot resolve, so they
    // are denied outright rather than gated (Codex round-2: an authenticated
    // `curl -X PUT .../pulls/N/merge` bypassed the gate entirely).
    //
    // This scan must run even when a gh form ALSO matched this segment. A
    // recognized outer `gh pr merge` used to reach `continue` first, so a raw
    // merge hidden in a command substitution — `gh pr merge 1 --body "$(curl -X
    // PUT .../pulls/9/merge)"` — was never inspected (Codex bot P1 on PR #541).
    // Counting occurrences keeps the ONE endpoint a `gh api ... /merge` request
    // legitimately names from denying its own gated route, while any additional
    // mention is treated as a second, unresolvable merge.
    const endpointMentions = segment.match(/\/pulls\/[^\s/]+\/merge\b/gi) || [];
    if (endpointMentions.length > (api ? 1 : 0)) {
      deny("PR MERGE GATE: raw GitHub REST merge calls (curl/wget/Invoke-RestMethod/fetch against .../pulls/<n>/merge) are denied because the guard cannot resolve and verify the PR's base, head, and checks for them. Use `gh pr merge <number>` so the gate can verify the merge.");
    }
    // A merge segment carrying a command substitution is unresolvable, so it is
    // refused rather than gated. Counting endpoints above closed the RAW-call
    // shape, but the substitution can equally hold a second `gh pr merge` —
    // `gh pr merge 1 --body "$(gh pr merge 2 --admin)"` runs the INNER merge
    // first, while the parser records only the outer request and never sees the
    // inner flag (Codex bot P1 on PR #541). This is the same stance the Codex
    // guard already takes on interpreter arguments: when part of a command is
    // shell-expanded, what it will actually do is not statically knowable.
    if (found && /\$\(|`|\$\{/.test(segment)) {
      deny(
        "PR MERGE GATE: this merge command contains a command substitution, so what it will actually " +
        "run is not statically knowable — a substitution can carry a second merge, or flags the parser " +
        "never sees. Run the merge as its own plain command, with the PR number and flags spelled out."
      );
    }
    if (found) { requests.push(found); continue; }
  }
}
if (requests.length === 0) passthrough();

// ── the administrator override is Mason's, never an agent's ─────────────────
// On 2026-09-01 Mason turned "Include administrators" OFF on main's branch
// protection so he can hand-merge a PR whose review is stuck (CodeRabbit down,
// rate-limited, or wedged). That bypass is granted by admin rights, not by a
// separate credential — so every agent session, running on his token, inherits
// it. Denied here, before the PR is even resolved: there is no base branch and
// no diff for which an agent asking GitHub to skip review is the right move.
if (requests.some((request) => request?.admin)) {
  deny(
    "PR MERGE GATE: `--admin` merges with administrator privileges, overriding branch protection. " +
    "That override exists for Mason to use by hand on the PR page — an agent may never use it, whatever " +
    "the diff or the deadline. Use the ordinary merge instead: an approving review is NOT required " +
    "(removed 2026-09-02), so a green, up-to-date candidate with no `CHANGES_REQUESTED` verdict merges " +
    "without `--admin`. If a review did ask for changes, resolve it first — apply the " +
    "`ready-for-coderabbit` label and let the default-branch workflow post the review command once, " +
    "then fix what it finds. Do not post `@coderabbitai review` by hand — that routes around the label " +
    "gate. If the merge is still blocked, hand the PR to Mason and say why."
  );
}

// ── resolve the PR (fail closed) ─────────────────────────────────────────────
const projectDir = path.resolve(
  payload?.cwd || payload?.tool_input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
);

function gh(args) {
  return execFileSync("gh", args, {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

function listWorktreesFromProjectDir() {
  return execFileSync("git", ["worktree", "list", "--porcelain"], {
    cwd: projectDir,
    encoding: "utf8",
    timeout: 10_000,
    stdio: ["ignore", "pipe", "ignore"],
  });
}
// ── the Codex GitHub App's review — read it instead of ignoring it ───────────
// Added 2026-09-02. The App has reviewed every PR in this repo since it was
// enabled, and until now nothing here read a word of it: a grep for
// `chatgpt-codex-connector` across hooks, skills, commands, scripts and docs
// returned zero hits. With the approval gate downgraded to a notice on the same
// day, an unread automated review is the largest remaining hole.
//
// Deliberately a SEPARATE gh call rather than extra fields on the shared PR
// resolve: `gh pr view` has no reviewThreads field at all (verified — "Unknown
// JSON field"), so thread resolution state only comes from GraphQL. Keeping this
// self-contained also keeps the shared resolve line conflict-free for the other
// in-flight guard work.
//
// @speed-bump — advisory by design; it raises the cost of merging over an unread
// Codex finding, it is not a boundary. The hard gates are CI's required checks
// and the exact-SHA proof below, and neither depends on this lookup.
// Fail-OPEN by design: any failure here leaves codexVerdict null, which prints a
// notice and merges. See the header of codex-bot-review-lib.mjs for why this one
// predicate does not fail closed like its neighbours.
//
// RUNS LAST, AND THAT IS THE POINT (Codex round 6). This hook gets 30 seconds
// (.claude/settings.json). Each gh call is capped at 10s, and this lookup makes
// up to four of them, so it can alone outlive the hook. A PreToolUse hook killed
// mid-call emits nothing, and a hook that emits nothing does NOT deny — so
// @speed-bump — the ORDERING protects the hard gates; this lookup is not one.
// running an advisory, fail-open lookup BEFORE the green-pipeline, risky-diff and
// exact-SHA-proof denials could let a merge through that those gates would have
// refused. Every caller therefore invokes this only after its hard denials have
// had their chance, at a point where the alternative is returning ALLOW anyway.
// Do not move it earlier "so the reader sees it first".
const CODEX_ADVISORY_BUDGET_MS = 12_000;

// DEFERRED PAST EVERY MERGE IN THE COMMAND (Codex round 8, SEC-001). Running
// last within ONE merge was not enough: `gh pr merge 1 && gh pr merge 2` gates
// each request in turn, so an advisory for #1 that ran before #2's hard checks
// could still exhaust the hook budget before those checks — and a killed hook
// denies nothing. gateRequest() therefore only QUEUES a request that cleared
// its hard gates; the queue is drained after the loop, and every lookup shares
// the one `deadlineMs` the caller computed, so N merges spend one budget.
function codexAdvisory(request, deadlineMs = Date.now() + CODEX_ADVISORY_BUDGET_MS) {
  let codexVerdict = null;
  try {
    const metaArgs = ["pr", "view"];
    if (request.selector) metaArgs.push(String(request.selector));
    metaArgs.push("--json", "number,url");
    if (request.repo) metaArgs.push("--repo", request.repo);
    const meta = JSON.parse(gh(metaArgs));
    const slug = String(meta?.url || "").match(/[/]([^/]+)[/]([^/]+)[/]pull[/]/);
    if (slug && Number.isInteger(meta?.number)) {
      const node = collectCodexThreads((cursor) => {
        const args = [
          "api", "graphql",
          "-f", `query=${CODEX_THREADS_QUERY}`,
          "-F", `owner=${slug[1]}`,
          "-F", `name=${slug[2]}`,
          "-F", `number=${meta.number}`,
          "-F", `first=${CODEX_THREAD_PAGE_SIZE}`,
        ];
        // Omit `after` entirely on the first page: -F after= would send the
        // empty string, which GraphQL treats as a cursor rather than as null.
        if (cursor) args.push("-F", `after=${cursor}`);
        return JSON.parse(gh(args))?.data?.repository?.pullRequest;
      }, { deadlineMs });
      if (node.headRefOid) codexVerdict = evaluateCodexBotReview(node);
    }
  } catch {
    codexVerdict = null; // notice below; never a deny
  }

  // The one blocking case: it flagged THIS commit and nobody answered. Not
  // exempted by --auto — queueing a merge does not answer a review comment, and
  // the exit (fix it, or resolve the thread with a reason) is available either
  // way.
  if (codexVerdict?.status === "findings-at-head") {
    deny(codexBotFindingsDenial("PR MERGE GATE", request.selector, codexVerdict.unresolvedAtHead));
  }
  if (!codexVerdict) {
    process.stderr.write(
      // @speed-bump — this notice is the fail-open path itself; it never denies.
      "CODEX REVIEW NOTICE: could not read the Codex GitHub App's review threads for this PR, so its " +
      "findings were NOT checked. Merging anyway (this gate fails open by design). Read them by hand: " +
      `gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  } else if (codexVerdict.status === "stale") {
    process.stderr.write(
      `CODEX REVIEW NOTICE: the Codex GitHub App has ${codexVerdict.codexThreads} comment thread(s) on this ` +
      "PR, none of them unresolved against the exact commit being merged. Nothing blocks, but if you have " +
      "not read them, do: " +
      `gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  } else if (codexVerdict.status === "none") {
    process.stderr.write(
      "CODEX REVIEW NOTICE: the Codex GitHub App has left no review comments on this PR. If it never ran, " +
      "comment `@codex review` and read the result before merging anything non-trivial.\n",
    );
  } else if (codexVerdict.status === "incomplete") {
    process.stderr.write(
      `CODEX REVIEW NOTICE: the Codex GitHub App's review threads could only be PARTLY read (${codexVerdict.codexThreads} ` +
      "seen; a later page failed, the cursor was unusable, or the page cap was reached). Nothing standing was seen " +
      "in what was read, but an unread page could still hold one, so this is NOT a clean reading. Merging anyway " +
      // @speed-bump — a partial read prints this notice and allows; it never denies.
      `(this gate fails open by design). Read them by hand: gh pr view ${request.selector || "<number>"} --comments\n`,
    );
  }
}

// Gate ONE merge request. Either returns (this request is allowed) or calls
// deny() (which exits). The caller loops over every collected request — a
// harmless merge earlier in a chain must never exempt a later one.
function gateRequest(request) {
  let pr;
  try {
    const viewArgs = ["pr", "view"];
    if (request.selector) viewArgs.push(String(request.selector));
    // baseRefOid is GitHub's CURRENT tip of the base branch — the content the
    // merge actually lands on. The proof must be bound to THAT, not to the local
    // origin/main, which can be stale (Codex round-6: a proof reviewed against an
    // old local base validated while GitHub merged onto newer main content).
    viewArgs.push("--json", "baseRefName,baseRefOid,headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest");
    if (request.repo) viewArgs.push("--repo", request.repo);
    pr = JSON.parse(gh(viewArgs));
    if (!pr?.baseRefName || !pr?.headRefOid || !pr?.baseRefOid) {
      throw new Error("GitHub did not return baseRefName, baseRefOid, and headRefOid");
    }
  } catch (error) {
    deny(`PR MERGE GATE: could not resolve this pull request's base branch and exact SHAs, so the merge is denied (fail closed). ${error?.message || error}`);
  }

  const base = String(pr.baseRefName || "").trim().toLowerCase();
  if (base === "master" || base === "production") {
    deny(`PR MERGE GATE: merges into protected branch "${base}" are always blocked.`);
  }
  if (base !== "main") return; // ordinary feature-branch merges are not production landings

  // ── no merging over an unresolved objection ────────────────────────────────
  // Mason removed main's required-approval rule on 2026-09-02, so a MISSING
  // approval is no longer a blocker here. An ACTIVE objection still is: merging
  // over CHANGES_REQUESTED throws away a review that already found something.
  // **This check must NEVER be exempt for `--auto`** (Codex High, 2026-09-02).
  // Every other gate here exempts auto-merge because GitHub holds the merge until
  // its own requirements are met — but the requirement that used to cover this one
  // was main's required review, and THIS CHANGE removed it. With no required
  // review, GitHub will happily complete a queued auto-merge on a PR carrying
  // CHANGES_REQUESTED, so an auto exemption here would be a live hole opened by
  // the very commit that removed the server-side floor. Deny regardless of auto.
  if (pullRequestReviewBlocked(pr)) {
    deny(
      "PR MERGE GATE: GitHub reports reviewDecision=CHANGES_REQUESTED — a reviewer has open objections on " +
      "this pull request. Removing main's required-approval rule did not authorize merging over a review " +
      "that asked for changes. Fix every real finding and push it; a genuine nitpick may be dismissed with " +
      "a one-line reason in the thread. Merge only after that."
    );
  }

  // The Codex GitHub App's review is read at the ALLOW points below, not here.
  // @speed-bump — advisory; deferring it protects the hard gates, it is not one.
  // It is advisory and fail-open, and it costs up to four gh calls against a
  // 30-second hook budget — running it ahead of the hard denials would let a
  // slow GitHub kill this hook before they ran, which does not deny. See
  // codexAdvisory() above.

  // An unreviewed PR may now land, but say so out loud — the standing policy is
  // still that CodeRabbit reviews the frozen candidate and its real findings get
  // fixed. This is a notice, not a gate: write to stderr, then keep going.
  if (!request.auto && !pullRequestApproved(pr)) {
    process.stderr.write(
      `PR MERGE NOTICE: reviewDecision=${String(pr.reviewDecision || "").toUpperCase() || "<none>"} — merging ` +
      "without a current approval, which main no longer requires (Mason, 2026-09-02). If CodeRabbit has " +
      "not reviewed this candidate, apply the `ready-for-coderabbit` label — the default-branch " +
      "workflow revalidates this exact head and posts the review command once. Do not post " +
      "`@coderabbitai review` by hand; that routes around the label gate. Read the review and fix " +
      "what it finds first.\n"
    );
  }

  // ── green-pipeline requirement ─────────────────────────────────────────────
  // `--auto` defers the merge to GitHub, which itself enforces the required
  // checks — so only immediate merges must already be green here.
  if (!request.auto && !pullRequestChecksGreen(pr)) {
    deny(
      "PR MERGE GATE: this pull request is not merge-ready with a fully green GitHub pipeline " +
      "(mergeStateStatus must be CLEAN and every reported check completed successfully). " +
      "Wait for the required Vercel check, or use `gh pr merge --auto` to let GitHub merge when green."
    );
  }

  // ── risky-diff classification (same rules as the push gate) ────────────────
  let files = [];
  try {
    const diffArgs = ["pr", "diff"];
    if (request.selector) diffArgs.push(String(request.selector));
    diffArgs.push("--name-only");
    if (request.repo) diffArgs.push("--repo", request.repo);
    files = gh(diffArgs).split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (error) {
    deny(`PR MERGE GATE: could not inspect this pull request's changed files, so the merge is denied (fail closed). ${error?.message || error}`);
  }

  const risky = riskyFiles(files);
  let contentFlagged = false;
  let contentDiffText = "";
  if (risky.length === 0) {
    try {
      const diffArgs = ["pr", "diff"];
      if (request.selector) diffArgs.push(String(request.selector));
      if (request.repo) diffArgs.push("--repo", request.repo);
      contentDiffText = gh(diffArgs);
      contentFlagged = contentIsRisky(contentDiffText);
    } catch (error) {
      deny(`PR MERGE GATE: could not inspect this pull request's full diff for money/security risk, so the merge is denied (fail closed). ${error?.message || error}`);
    }
  }
  // ALLOW point 1 — nothing risky. Every hard denial above has had its chance
  // for THIS request; the advisory lookup is queued, not run, so a later merge
  // in the same command still reaches its own hard denials first.
  if (risky.length === 0 && !contentFlagged) {
    advisoryQueue.push(request);
    return;
  }

  // ── risky merge: --auto is denied outright ─────────────────────────────────
  // Auto-merge defers the landing until GitHub's checks pass — AFTER this hook
  // has run. Later commits pushed to the branch would then merge with no fresh
  // proof and no re-run of this gate (Codex round-4). Risky diffs must merge
  // immediately, with a fresh proof, while the gate can still see them.
  if (request.auto) {
    deny(
      "PR MERGE GATE: `--auto` is not allowed for a risky diff — auto-merge lands the PR later, " +
      "after this gate has run, so commits pushed in the meantime would merge with a stale (or no) " +
      "Codex proof. Wait for the checks, then merge immediately: mint the proof with " +
      "`node scripts/write-codex-push-proof.mjs` and run `gh pr merge <n> --squash` (no --auto)."
    );
  }

  // ── risky merge → require the fresh, bound Codex proof ─────────────────────
  const headSha = pr.headRefOid;
  const baseSha = String(pr.baseRefOid).trim(); // GitHub's real base tip, not local origin/main
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
    deny("PR MERGE GATE: GitHub returned an unusable baseRefOid, so the proof cannot be bound to the real base (fail closed).");
  }

  let valid = false;
  outer:
  for (const stateDir of proofSearchDirs(projectDir, listWorktreesFromProjectDir)) {
    try {
      if (!existsSync(stateDir)) continue;
      for (const f of readdirSync(stateDir)) {
        if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(f)) continue;
        let data;
        try { data = JSON.parse(readFileSync(path.join(stateDir, f), "utf8")); } catch { continue; }
        if (proofValid(data, headSha, Date.now(), baseSha)) { valid = true; break outer; }
      }
    } catch { /* unreadable directory means no proof HERE — keep looking */ }
  }
  // ALLOW point 2 — risky, but the exact-SHA proof validated. Same reasoning as
  // ALLOW point 1: queued, drained only after every request has been gated.
  if (valid) {
    advisoryQueue.push(request);
    return;
  }

  const riskyDescription = risky.length > 0
    ? `changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
      risky.slice(0, 6).map((f) => "  " + f).join("\n") +
      (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "")
    : describeRiskyContent(contentDiffText);

  deny(
    `PR MERGE GATE: merging this PR lands a diff on main that ${riskyDescription}\n\n` +
    `"Review is queued/scheduled" is NOT reviewed. Before merging:\n` +
    `  1. Check out the PR branch (\`gh pr checkout ${request.selector || "<number>"}\`) if it isn't the current branch.\n` +
    `  2. \`git fetch origin\` so local origin/main equals GitHub's real base (${baseSha.slice(0, 12)}...) — the proof is bound to the base GitHub will merge onto.\n` +
    `  3. Run: node scripts/write-codex-push-proof.mjs — it runs an independent read-only Codex review of origin/main...HEAD and requires a machine verdict.\n` +
    `  4. If Codex flags blockers, fix them, push, and re-run until it reports clean; only a clean verdict on a stable, clean worktree mints the proof.\n` +
    `  5. Retry the merge. (Proof is bound to head ${headSha || "<head>"} and to the base; it expires in 30min, and a moved base or new commits force a fresh review.)\n` +
    `If the Codex CLI is unavailable, PARK the change and tell Mason — do not self-certify.`
  );
}

// Requests that cleared every hard gate. Drained only after the loop below has
// gated EVERY request — see codexAdvisory() for why (Codex round 8, SEC-001).
const advisoryQueue = [];
for (const request of requests) gateRequest(request);
// ALLOW point for the whole command: every merge has cleared its hard denials,
// so the advisory lookups can spend what is left of the hook budget here. One
// deadline is shared across the queue so N merges cannot multiply the budget.
const advisoryDeadlineMs = Date.now() + CODEX_ADVISORY_BUDGET_MS;
for (const request of advisoryQueue) codexAdvisory(request, advisoryDeadlineMs);
passthrough();
