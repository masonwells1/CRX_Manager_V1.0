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
  coderabbitVerdict,
  contentIsRisky,
  ghApiMergeRequest,
  ghMergeRequest,
  mcpMergeRequest,
  proofSearchDirs,
  proofValid,
  pullRequestChecksGreen,
  riskyFiles,
} from "./codex-push-lib.mjs";

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
    const api = ghApiMergeRequest(segment);
    if (api?.unsupportedGraphql) {
      deny("PR MERGE GATE: GraphQL mergePullRequest mutations are denied because the guard cannot safely resolve and verify the PR's head/checks. Use `gh pr merge <number>` instead.");
    }
    const found = api || ghMergeRequest(segment);
    if (found) { requests.push(found); continue; }
    // Raw REST merges outside gh — curl/wget/Invoke-RestMethod/node fetch — name
    // the same endpoint but carry auth/context the guard cannot resolve, so they
    // are denied outright rather than gated (Codex round-2: an authenticated
    // `curl -X PUT .../pulls/N/merge` bypassed the gate entirely).
    if (/\/pulls\/[^\s/]+\/merge\b/i.test(segment)) {
      deny("PR MERGE GATE: raw GitHub REST merge calls (curl/wget/Invoke-RestMethod/fetch against .../pulls/<n>/merge) are denied because the guard cannot resolve and verify the PR's base, head, and checks for them. Use `gh pr merge <number>` so the gate can verify the merge.");
    }
  }
}
if (requests.length === 0) passthrough();

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
    viewArgs.push("--json", "baseRefName,baseRefOid,headRefOid,mergeStateStatus,statusCheckRollup,autoMergeRequest");
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

  // ── ONE SHA, bound from here through the merge itself ──────────────────────
  // Codex, High, PR #441: verifying review evidence for one SHA while a
  // different SHA reaches the merge is a real path to landing unreviewed code,
  // and nothing mechanically prevented it — `--match-head-commit` was documented
  // procedure, and this guard did not look at it. The head is now derived ONCE,
  // here, from GitHub, and every check below plus the merge argument must equal
  // that value. GitHub itself then refuses the merge if the branch moved between
  // this hook and the API call.
  const headSha = String(pr.headRefOid || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(headSha)) {
    deny("PR MERGE GATE: GitHub did not return a usable headRefOid, so the merge cannot be bound to a reviewed commit (fail closed).");
  }

  // `--auto` hands the landing to GitHub for later, AFTER this gate has run, so
  // commits pushed in the meantime would land with review evidence that was
  // checked against an older head. That is precisely the hole this gate exists
  // to close, so it is denied for every merge into main — not only risky ones.
  if (request.auto) {
    deny(
      "PR MERGE GATE: `--auto` is not allowed for merges into main. Auto-merge lands the PR after " +
      "this gate has run, so any commit pushed in the meantime would reach production with review " +
      "evidence bound to an older head. Wait for the checks, then merge immediately with " +
      `\`gh pr merge <n> --squash --match-head-commit ${headSha}\`.`
    );
  }

  // Merge forms that cannot carry a head binding are denied outright: the MCP
  // merge tool and the REST endpoint have no --match-head-commit equivalent, so
  // there is no way to make GitHub enforce the SHA this gate verified.
  if (!request.isGhCli) {
    deny(
      "PR MERGE GATE: merges into main must go through `gh pr merge` so the landing can be pinned " +
      `with \`--match-head-commit ${headSha}\`. The MCP merge tool and the REST endpoint cannot pin ` +
      "the head, so a commit pushed between this check and the merge would land unreviewed."
    );
  }

  const pinned = String(request.matchHeadCommit || "").trim();
  if (!pinned) {
    deny(
      "PR MERGE GATE: merges into main must pass `--match-head-commit` so GitHub refuses the merge " +
      `if the branch moves after this check. Re-run as:\n  gh pr merge ${request.selector || "<number>"} --squash --match-head-commit ${headSha}`
    );
  }
  if (pinned.toLowerCase() !== headSha.toLowerCase()) {
    deny(
      `PR MERGE GATE: \`--match-head-commit ${pinned}\` does not equal this PR's current head ` +
      `(${headSha}). The review evidence this gate checks is bound to the current head, so merging a ` +
      "different SHA would land content that was never verified. Re-read the head and retry:\n" +
      `  gh pr merge ${request.selector || "<number>"} --squash --match-head-commit ${headSha}`
    );
  }

  // ── CodeRabbit must have reviewed THIS EXACT head ──────────────────────────
  // Standing policy (Mason, 2026-07-17) is that every PR's CodeRabbit review is
  // read and its real issues fixed before merging. That was procedure only, and
  // `auto_pause_after_reviewed_commits: 2` means later pushes are NOT
  // auto-reviewed — so a green status check on an unreviewed head was reachable.
  // Codex raised it five rounds running, finally as High. It is enforced here.
  let reviews = [];
  let comments = [];
  let cycleStartIso = "";
  try {
    const api = (endpoint) => {
      const args = ["api", "--paginate", `repos/{owner}/{repo}/${endpoint}`];
      if (request.repo) {
        args[2] = `repos/${request.repo}/${endpoint}`;
      }
      return JSON.parse(gh(args));
    };
    const number = String(request.selector || "").replace(/^#/, "");
    if (!/^\d+$/.test(number)) {
      throw new Error("could not resolve the PR number needed to read its CodeRabbit review");
    }
    reviews = api(`pulls/${number}/reviews`);
    comments = api(`issues/${number}/comments`);
    // The cycle starts at the NEWEST `pending` status on this head: the oldest
    // reaches back into a previous attempt (so one old failure would block a
    // clean retry forever), and the newest status is the COMPLETION of the
    // current cycle (so anchoring there misses a failure posted seconds before
    // it — fail-open). Statuses come back newest-first.
    const statuses = api(`commits/${headSha}/statuses`).filter(
      (s) => s?.context === "CodeRabbit" && s?.state === "pending",
    );
    cycleStartIso = statuses.length > 0 ? String(statuses[0].created_at || "") : "";
  } catch (error) {
    deny(`PR MERGE GATE: could not read this PR's CodeRabbit review from the GitHub API, so the merge is denied (fail closed). ${error?.message || error}`);
  }

  const notReviewed = coderabbitVerdict({ reviews, comments, headSha, cycleStartIso });
  if (notReviewed) {
    deny(
      `PR MERGE GATE: ${notReviewed}.\n\n` +
      "A green `CodeRabbit` status check is NOT proof the head was reviewed — a paused branch emits " +
      "a no-op \"Review completed\" success within seconds of a push, with no review behind it. The " +
      "binding evidence is a submitted review object whose commit_id equals the head, or the " +
      "canonical walkthrough stamp naming it.\n\n" +
      `  1. Confirm the branch is CLEAN (\`gh pr view ${request.selector || "<number>"} --json mergeStateStatus\`); if BEHIND, run \`gh pr update-branch\` FIRST — it moves the head and voids any review you already paid for.\n` +
      `  2. Comment \`@coderabbitai review\` on the PR and WAIT for it to finish.\n` +
      "  3. Read the review and fix every real issue it raises.\n" +
      `  4. Re-read the head and merge with \`--match-head-commit\`.`
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
  if (risky.length === 0) {
    try {
      const diffArgs = ["pr", "diff"];
      if (request.selector) diffArgs.push(String(request.selector));
      if (request.repo) diffArgs.push("--repo", request.repo);
      contentFlagged = contentIsRisky(gh(diffArgs));
    } catch (error) {
      deny(`PR MERGE GATE: could not inspect this pull request's full diff for money/security risk, so the merge is denied (fail closed). ${error?.message || error}`);
    }
  }
  if (risky.length === 0 && !contentFlagged) return;

  // ── risky merge: --auto is denied outright ─────────────────────────────────
  // Subsumed since PR #441 by the blanket `--auto` denial for every merge into
  // main above, and kept deliberately: it carries the risky-diff-specific
  // wording, and it stays correct if the earlier check is ever narrowed.
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
  // `headSha` is the one derived and validated above — the same value the
  // CodeRabbit evidence was checked against and that `--match-head-commit` was
  // required to equal. One SHA, from GitHub, through every check and the merge.
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
  if (valid) return;

  const riskyDescription = risky.length > 0
    ? `changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
      risky.slice(0, 6).map((f) => "  " + f).join("\n") +
      (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "")
    : "changes content that matches a money/financial-audit pattern (_cents, financial_audit_log, allocate_payment, apply_prepay) even though no changed file's PATH looked risky";

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

for (const request of requests) gateRequest(request);
passthrough();
