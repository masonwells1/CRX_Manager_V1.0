#!/usr/bin/env node
// PreToolUse(*) guard: gate PR merges into main the way codex-push-guard gates
// pushes to main. Added 2026-07-16 (scaffolding design review, Theme 1): the
// 2026-07-14 `protect-main` ruleset made direct pushes to main impossible, so
// the landing action moved to `gh pr merge` / the GitHub MCP merge tool — and
// Claude's risky-diff Codex gate never followed. This hook closes that gap:
//
//   * merge into main → allowed only under Mason's autonomous-landing rule
//     (2026-09-26): CodeRabbit APPROVED the exact head, the newest run of every
//     check is green with mergeStateStatus CLEAN, and a fresh gpt-6-sol/high
//     Codex proof is bound to that head and GitHub's real base (minted only by
//     scripts/write-codex-push-proof.mjs — hand-writing is blocked). Every diff
//     needs the proof now, not only risky ones;
//   * `--auto` into main → denied, because it lands later-pushed commits after
//     this gate has run (Codex round-4 finding);
//   * `--admin`, CHANGES_REQUESTED, GraphQL mergePullRequest, raw REST merges and
//     unresolvable PR context → denied, fail closed.
//
// Mirrors .codex/hooks/production-action-guard.mjs's merge route (the Codex
// side has had this gate since 2026-07-14). Shared parsing/validation lives in
// codex-push-lib.mjs — one pattern table, no forked logic.
//
// This is an honest-mistake net, not a security boundary: GitHub branch
// protection (required Vercel check) remains the external hard wall.

import { readFileSync, existsSync, readdirSync, writeSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  coderabbitApprovedHead,
  headContainsBaseOnGitHub,
  createHardGateBudget,
  expandNestedCommands,
  ghApiMergeRequest,
  commandFedToInterpreter,
  commandFedToInterpreterDenial,
  ghCommandUnreadableDenial,
  ghCommandUnreadableIn,
  ghHiddenByShellComposition,
  mentionsMergePullRequest,
  nestedComputedDenial,
  rawMergeEndpointCount,
  nestedTooDeepDenial,
  hardGateBudgetDenial,
  hookDeadlineMs,
  splitCommandSegments,
  ghMergeRequest,
  mcpMergeRequest,
  mergeRequestKey,
  proofSearchDirs,
  proofValid,
  pullRequestChecksGreen,
  pullRequestReviewBlocked,
} from "./codex-push-lib.mjs";
import {
  CODEX_THREADS_QUERY,
  CODEX_THREAD_PAGE_SIZE,
  codexBotFindingsDenial,
  collectCodexThreads,
  evaluateCodexBotReview,
} from "./codex-bot-review-lib.mjs";

const GITHUB_MERGE_TOOL = /merge_pull_request$/i;

// Under merge-guard-launcher.mjs, silence counts as an allow only when this
// guard also reports the launcher's per-run token: an emptied or truncated guard
// file exits 0 silently too, and must not read as an allow (Luna, 2026-09-28).
// writeSync, because process.exit() would not wait for a stream write.
function passthrough() {
  if (process.env.CRX_MERGE_GUARD_TOKEN) writeSync(2, `merge-guard finished ${process.env.CRX_MERGE_GUARD_TOKEN}\n`);
  process.exit(0);
}
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

// A tool call this guard cannot read was not checked, so it must not report the
// launcher's token: exiting without it sends merge-guard-launcher.mjs down its
// fail-closed path, which denies anything that could merge and lets other work
// run. passthrough() here once signed a truncated `gh pr merge` payload as a
// checked allow (Codex App P1, PR #841).
function unreadable() { process.exit(0); }
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { unreadable(); }
if (!isPlainObject(payload) || (payload.tool_input !== undefined && !isPlainObject(payload.tool_input))) unreadable();

const toolName = String(payload.tool_name || "");
const toolInput = payload.tool_input || {};

// ── detect merge intent — EVERY segment, EVERY request ───────────────────────
// The parse loop must not stop at the first hit: `gh pr merge <feature-PR>;
// gh pr merge <main-PR>` would otherwise gate only the harmless first merge and
// let the second run ungated, and a raw REST call after a gh merge would never
// be seen at all (Codex round-6 finding on this guard's own PR). Collect every
// request; deny immediately on any unresolvable form in any segment.
//
// Command segments are collected through addRequest, which drops a request
// already collected. The connector path below pushes directly: it resolves ONE
// request from structured tool input, so it has no second reading to collapse.
// splitCommandSegments returns a UNION of readings, so a command carrying a
// quote or an escape resolves to the same merge twice; gating it twice spends a
// `gh pr view` and an advisory lookup on a verdict already known. This hook is
// bounded (30s) and each gh call is capped at 10s — and a PreToolUse hook killed
// mid-call emits nothing, which ALLOWS. Duplicated lookups therefore spend the
// budget protecting the hard gates, so this is a fail-OPEN risk, not merely slow
// (CodeRabbit, 2026-09-09). De-duplicating HERE rather than at the gate loop
// keeps that loop the single, pinned call site codex-bot-review-lib.test.mjs
// measures the advisory ordering against.
const requests = [];
const collectedRequestKeys = new Set();
function addRequest(request) {
  if (!request) return;
  // Keyed on the COMPLETE parse, never selector+repository: the two readings of
  // `gh pr merge 1 --body 'note&more' --admin --squash` match in selector AND
  // repository and differ ONLY in `admin`, so a narrower key could keep the
  // admin:false reading and erase the offence. See mergeRequestKey.
  const key = mergeRequestKey(request);
  if (collectedRequestKeys.has(key)) return;
  collectedRequestKeys.add(key);
  requests.push(request);
}
if (GITHUB_MERGE_TOOL.test(toolName)) {
  requests.push(mcpMergeRequest(toolInput));
} else if (typeof toolInput.command === "string" && toolInput.command) {
  // A command handed to another program as one argument — `bash -c "…"`,
  // `cmd /c "…"`, `pwsh -Command "…"`, `pwsh -EncodedCommand …`, `eval`,
  // `Invoke-Expression`, `Start-Process`, a `&{ … }` block — is one word to the
  // parsers below, so an administrator merge inside it passed this guard
  // (measured on PR #630's head, 2026-09-24). Every such inner command is
  // scanned exactly like the command itself.
  // A hook that throws emits no decision, and that ALLOWS — so an unexpected
  // failure here denies instead of skipping the merge scan.
  let nested;
  try {
    nested = expandNestedCommands(toolInput.command);
  } catch (error) {
    deny(`PR MERGE GATE: could not unwrap the commands nested in this one, so it is denied (fail closed). ${error?.message || error}`);
  }
  if (nested.tooDeep) deny(nestedTooDeepDenial("PR MERGE GATE"));
  if (nested.computed) deny(nestedComputedDenial("PR MERGE GATE"));
  const scannedCommands = [toolInput.command, ...nested.commands];
  if (scannedCommands.some((text) => commandFedToInterpreter(text))) {
    deny(commandFedToInterpreterDenial("PR MERGE GATE"));
  }
  for (const scanned of scannedCommands) collectMergeRequests(scanned);
}
if (requests.length === 0) passthrough();

// Collects every merge request one command's text carries, denying on any
// unresolvable form. Called for the command itself and for each nested command.
function collectMergeRequests(scanned) {
  // Refused before the segment scan, not analysed: a PowerShell backtick or a
  // cmd.exe caret is consumed before gh sees the word, so ``gh pr me`rge 1
  // --admin`` is an ordinary administrator merge that ghMergeRequest reads as an
  // unknown word and this whole loop skips (Codex sol, 2026-09-08, finding 3).
  // Same helper and same reasoning as the push side's composition refusal.
  // A gh alias or extension expands into a command this scan never sees.
  const unreadableGh = ghCommandUnreadableIn(scanned);
  if (unreadableGh) deny(ghCommandUnreadableDenial("PR MERGE GATE", unreadableGh));
  if (ghHiddenByShellComposition(scanned)) {
    deny("PR MERGE GATE: a PowerShell backtick or cmd.exe caret escape changes which gh command this runs (for example ``gh pr me`rge 1`` or `gh api --met^hod=PUT …/merge`). The gate reads command text, so analysing a spelling the shell rewrites would not prove the subcommand or the HTTP method. Write the gh command plainly: `gh pr merge <number> …`.");
  }
  // A single `&` separates commands too — POSIX backgrounds the left side, cmd
  // runs it first, and either way BOTH run. Without it `gh pr merge 1 & gh pr
  // merge 2` was one segment and only the first merge was resolved
  // (Codex sol, 2026-09-08, finding 4). The split is QUOTE-AWARE: a bare regex
  // splits inside `--body 'note&more'`, which would hand this loop a merge whose
  // `--admin` had been carried off into a segment containing no `gh` at all
  // (Codex sol, 2026-09-08, SEC-001).
  for (const segment of splitCommandSegments(scanned)) {
    // The mergePullRequest mutation is denied by NAME, whatever transport
    // carries it — `gh api graphql`, curl, Invoke-RestMethod, a fetch in a node
    // one-liner. Until 2026-09-01 only the `gh api graphql` spelling was caught
    // (below), which was survivable because GitHub itself refused an unapproved
    // merge and a raw call just got a 405. Mason's admin override removed that
    // backstop, and Codex's proof on PR #541 found the transport gap on both
    // guards. Naming the destination beats enumerating the tools that reach it.
    if (mentionsMergePullRequest(segment)) {
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
    // Counted with the segment's shell quoting consumed too, so `mer\ge` or
    // `mer^ge` inside a nested shell still counts.
    if (rawMergeEndpointCount(segment) > (api ? 1 : 0)) {
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
    // `--disable-auto` is gated like any merge; see ghMergeRequest for why.
    if (found) { addRequest(found); continue; }
  }
}

// ── the administrator override is Mason's, never an agent's ─────────────────
// On 2026-09-01 Mason turned "Include administrators" OFF on main's branch
// protection so he can hand-merge a PR whose review is stuck (CodeRabbit down,
// rate-limited, or wedged). That bypass is granted by admin rights, not by a
// separate credential — so every agent session, running on his token, inherits
// it. Since 2026-09-27 the protect-main ruleset requires an approval of the
// latest push and has no bypass actors, so that classic setting no longer lets
// an admin skip the review; the denial stands either way. Denied here, before
// the PR is even resolved: there is no base branch and no diff for which an
// agent asking GitHub to skip review is the right move.
if (requests.some((request) => request?.admin)) {
  deny(
    "PR MERGE GATE: `--admin` asks GitHub to override branch protection. An agent may never use it, " +
    "whatever the diff or the deadline. Merge the ordinary way: the `protect-main` ruleset requires one " +
    "approving review of the latest push (stale approvals are dismissed, no bypass actors), and CodeRabbit " +
    "is the reviewer that gives it, so a green, up-to-date candidate whose latest push CodeRabbit APPROVED " +
    "merges without `--admin`. If a review asked for changes, resolve it first — fix what it found and " +
    "push; CodeRabbit re-reviews every push automatically (if it skipped the latest head, post " +
    "`@coderabbitai review` once). If the merge is still blocked, hand the PR to Mason and say why."
  );
}

// ── resolve the PR (fail closed) ─────────────────────────────────────────────
const projectDir = path.resolve(
  payload?.cwd || payload?.tool_input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
);

// The hard gates spend ONE budget between them (see createHardGateBudget). This
// guard runs under merge-guard-launcher.mjs, which denies a possible merge if the
// guard is still running at 36s; the hook entry in .claude/settings.json allows
// 45s so the launcher can still answer. The reserve covers what process.uptime()
// cannot see plus writing the verdict. The advisory lookup
// is NOT on this budget: it keeps its own deadline and fails open by design, so a
// slow GitHub there must not turn into a denial.
const HOOK_TIMEOUT_MS = 30_000;
const HOOK_RESERVE_MS = 3_000;
const GH_CALL_TIMEOUT_MS = 10_000;
const hardGateBudget = createHardGateBudget({
  deadlineMs: hookDeadlineMs(HOOK_TIMEOUT_MS, HOOK_RESERVE_MS),
  callTimeoutMs: GH_CALL_TIMEOUT_MS,
});

function gh(args) {
  return execFileSync("gh", args, {
    cwd: projectDir,
    encoding: "utf8",
    timeout: GH_CALL_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 16 * 1024 * 1024,
  });
}

// Every gh call a HARD gate makes goes through here. deny() exits, so a refused
// call can never be caught and reinterpreted by the gate that made it.
function hardGateGh(args) {
  if (!hardGateBudget.admit()) deny(hardGateBudgetDenial("PR MERGE GATE"));
  return gh(args);
}

function listWorktreesFromProjectDir() {
  if (!hardGateBudget.admit()) deny(hardGateBudgetDenial("PR MERGE GATE"));
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
    viewArgs.push("--json", "baseRefName,baseRefOid,headRefOid,mergeStateStatus,reviewDecision,reviews,statusCheckRollup,autoMergeRequest");
    if (request.repo) viewArgs.push("--repo", request.repo);
    pr = JSON.parse(hardGateGh(viewArgs));
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

  // The Codex GitHub App's review is read at the ALLOW point below, not here.
  // @speed-bump — advisory; deferring it protects the hard gates, it is not one.
  // It is advisory and fail-open, and it costs up to four gh calls against a
  // 30-second hook budget — running it ahead of the hard denials would let a
  // slow GitHub kill this hook before they ran, which does not deny. See
  // codexAdvisory() above.

  // ── AUTONOMOUS LANDING RULE (Mason, 2026-09-26) ────────────────────────────
  // An agent merges into main by itself only when ALL of these hold for the exact
  // head GitHub will merge: CodeRabbit approved that head, every check's newest
  // run is green with mergeStateStatus CLEAN, and a fresh gpt-6-sol/high Codex
  // proof is bound to that head and to GitHub's real base. Every change needs the
  // Sol proof now, not only the risky ones — that is the rule Mason confirmed,
  // accepting the extra Codex spend. Anything short of it is denied here and
  // stays with Mason.

  // `--auto` hands the landing to GitHub AFTER this gate has run, so a commit
  // pushed in the meantime would merge with no exact-head proof and no CodeRabbit
  // review of it (Codex round-4). With the proof now required for every merge,
  // auto-merge is never allowed into main.
  //
  // The same race exists for an IMMEDIATE merge: everything below is checked
  // against the head this gate read, and a push landing before GitHub executes
  // the merge would be merged unreviewed. `--match-head-commit <that head>` makes
  // GitHub itself refuse a moved head, so every agent merge must carry it, equal
  // to the head checked here (Sol HIGH, 2026-09-26). Merge routes that cannot
  // carry it — the REST endpoint and connector tools — are therefore denied.
  if (String(request.matchHeadCommit || "").toLowerCase() !== String(pr.headRefOid || "").toLowerCase()) {
    deny(
      `PR MERGE GATE: an agent merge into main must pin the exact head this gate checked — add ` +
      `\`--match-head-commit ${pr.headRefOid}\` to \`gh pr merge\` (got ${request.matchHeadCommit ? `\`${String(request.matchHeadCommit).slice(0, 12)}\`` : "none"}). ` +
      "Without it, a commit pushed between this check and GitHub's merge would land unreviewed. The REST " +
      "merge endpoint and connector merge tools cannot carry the pin; use `gh pr merge`."
    );
  }
  if (request.auto) {
    deny(
      "PR MERGE GATE: `--auto` is not allowed into main — auto-merge lands the PR later, after this gate " +
      "has run, so commits pushed in the meantime would merge without an exact-head Sol proof or a " +
      "CodeRabbit review of them. Wait for the checks, then merge immediately with `gh pr merge <n> --squash`."
    );
  }

  if (!coderabbitApprovedHead(pr)) {
    deny(
      `PR MERGE GATE: CodeRabbit has not APPROVED this exact head (${String(pr.headRefOid || "<head>").slice(0, 12)}). ` +
      "Agents merge only after CodeRabbit's final review of the frozen head is clean. CodeRabbit reviews " +
      "every non-draft push automatically (since 2026-09-26): wait for its review of this head, fix every " +
      "real finding (each fix on this same PR is re-reviewed), then retry. If CodeRabbit skipped or was " +
      "rate limited on this exact head, post `@coderabbitai review` on the PR once (Mason, 2026-09-27)."
    );
  }

  // ── green-pipeline requirement ─────────────────────────────────────────────
  if (!pullRequestChecksGreen(pr)) {
    deny(
      "PR MERGE GATE: this pull request is not merge-ready with a fully green GitHub pipeline " +
      "(mergeStateStatus must be CLEAN and the newest run of every reported check must have completed " +
      "successfully). Wait for the checks to finish, fix any that failed, and retry."
    );
  }

  // ── every main merge → require the fresh, bound Sol proof ──────────────────
  const headSha = pr.headRefOid;
  const baseSha = String(pr.baseRefOid).trim(); // GitHub's real base tip, not local origin/main
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) {
    deny("PR MERGE GATE: GitHub returned an unusable baseRefOid, so the proof cannot be bound to the real base (fail closed).");
  }

  // The head must already contain that base (Sol HIGH, round 7 — the Codex merge
  // guard already required it). A head behind main merges base-only commits the
  // Sol proof never reviewed alongside this change, and GitHub does not always
  // refuse a behind branch, so check it here rather than assume it.
  let headContainsBase = false;
  try {
    headContainsBase = headContainsBaseOnGitHub({ baseSha, headSha, repo: request.repo, gh: hardGateGh });
  } catch {
    headContainsBase = false;
  }
  if (!headContainsBase) {
    deny(
      `PR MERGE GATE: this pull request's head ${String(headSha).slice(0, 12)} does not contain the base it will ` +
      `merge onto (${baseSha.slice(0, 12)}), or GitHub could not confirm it (fail closed). The reviewed diff cannot ` +
      "cover everything the merge lands. Update the branch — merge origin/main into it and push — then re-run the " +
      "checks and the exact-SHA Sol review of the new head."
    );
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
  // The ALLOW point for THIS request. Every hard denial above has had its
  // chance; the advisory lookup is queued, not run, so a later merge in the same
  // command still reaches its own hard denials first.
  if (valid) {
    advisoryQueue.push(request);
    return;
  }

  deny(
    `PR MERGE GATE: every merge into main needs a fresh gpt-6-sol/high Codex proof bound to this exact ` +
    `head and GitHub's real base (Mason's autonomous-landing rule, 2026-09-26). None was found.\n\n` +
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
