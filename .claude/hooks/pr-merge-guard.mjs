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
    "PR MERGE GATE: `--admin` merges with administrator privileges, skipping main's required review. " +
    "That override exists for Mason to use by hand on the PR page — an agent may never use it, whatever " +
    "the diff or the deadline. Get a real approval instead (post `@coderabbitai review`, fix what it " +
    "finds, and merge once it approves this head), or hand the PR to Mason and say why it is stuck."
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

  // ── a real, current approval ───────────────────────────────────────────────
  // Until 2026-09-01 this was implicit: GitHub itself refused an unapproved
  // merge, so reaching the code below meant an approval existed. Mason's manual
  // override (branch protection's "Include administrators" turned OFF) removed
  // that floor for anyone holding admin rights, which is every agent session on
  // his token. So the approval is now read from GitHub's own verdict.
  // `--auto` is exempt because GitHub holds an auto-merge until every
  // requirement is satisfied and auto-merge never uses the admin bypass.
  if (!request.auto && !pullRequestApproved(pr)) {
    deny(
      `PR MERGE GATE: GitHub reports reviewDecision=${String(pr.reviewDecision || "").toUpperCase() || "<none>"} ` +
      "— this pull request has no current approval, and main requires one. The administrator override that " +
      "could skip it is Mason's to use by hand, not an agent's. Post `@coderabbitai review`, fix every real " +
      "finding, and merge only after it approves; if the review is stuck, hand the PR to Mason and say so."
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
  if (risky.length === 0 && !contentFlagged) return;

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
  if (valid) return;

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

for (const request of requests) gateRequest(request);
passthrough();
