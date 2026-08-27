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
//   * merge with a non-green pipeline → denied; `--auto` is denied for every
//     main-bound PR because a PR that is non-risky now can receive a later risky
//     commit after this hook has run and then land without exact-head review;
//   * GraphQL mergePullRequest / enablePullRequestAutoMerge / unresolvable PR
//     context → denied, fail closed.
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
  githubCliCommandIsDynamic,
  githubRepositoryContextOverrideMentioned,
  ghMergeRequest,
  mcpMergeRequest,
  mergeRequestHasExplicitContext,
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
  if (githubCliCommandIsDynamic(toolInput.command)) {
    deny("PR MERGE GATE: GitHub CLI commands containing shell-expanded variables, substitutions, splats, or backticks are denied because a merge or auto-merge action could be hidden from the exact-head parser. Spell the complete `gh` command literally.");
  }
  if (githubRepositoryContextOverrideMentioned(toolInput.command)) {
    deny("PR MERGE GATE: GH_REPO/GH_HOST/GH_CONFIG_DIR/GITHUB_API_URL overrides are denied for merges because they can make the hook inspect a different repository or host than the command executes. Use an explicit `--repo owner/repo`.");
  }
  for (const segment of toolInput.command.split(/(?:&&|\|\|?|;|\r?\n)/)) {
    const api = ghApiMergeRequest(segment);
    if (api?.unsupportedGraphql) {
      deny("PR MERGE GATE: GraphQL merge/auto-merge mutations are denied because the guard cannot safely resolve and verify the PR's exact head/checks. Use one standalone `gh pr merge <number> --repo <owner/repo> --match-head-commit <head-sha>` command instead.");
    }
    const found = api || ghMergeRequest(segment);
    if (found) { requests.push(found); continue; }
    // Raw REST merges outside gh — curl/wget/Invoke-RestMethod/node fetch — name
    // the same endpoint but carry auth/context the guard cannot resolve, so they
    // are denied outright rather than gated (Codex round-2: an authenticated
    // `curl -X PUT .../pulls/N/merge` bypassed the gate entirely).
    if (/\/pulls\/[^\s/]+\/merge\b/i.test(segment)) {
      deny("PR MERGE GATE: raw GitHub REST merge calls (curl/wget/Invoke-RestMethod/fetch against .../pulls/<n>/merge) are denied because the guard cannot resolve and verify the PR's base, head, and checks for them. Use one standalone `gh pr merge <number> --repo <owner/repo> --match-head-commit <head-sha>` command so the gate can verify the merge.");
    }
  }
}
if (requests.length === 0) passthrough();
if (typeof toolInput.command === "string") {
  const commandSegments = toolInput.command.split(/(?:&&|\|\|?|;|\r?\n)/).map((segment) => segment.trim()).filter(Boolean);
  if (commandSegments.length !== 1 || requests.length !== 1) {
    deny("PR MERGE GATE: a merge must be one standalone command so directory, branch, repository, and PR context cannot change after inspection. Run one literal `gh pr merge <number> --repo <owner/repo> --match-head-commit <head-sha>` command.");
  }
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
  if (!mergeRequestHasExplicitContext(request)) {
    deny("PR MERGE GATE: every merge must explicitly name one numeric PR, `--repo owner/repo`, and the exact 40-character `--match-head-commit` SHA in one standalone command. Selectorless/current-branch context is denied.");
  }
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

  // Auto-merge records a future landing decision. The PR can receive more
  // commits after this hook returns, so today's non-risky classification cannot
  // prove the eventual merge head is non-risky. Wait for checks and perform one
  // immediate guarded merge on the exact head instead.
  if (request.auto) {
    deny(
      "PR MERGE GATE: `--auto` is not allowed for any PR targeting main because later commits " +
      "could land after this exact-head gate has run. Wait for every check to finish, then run " +
      "one standalone `gh pr merge <n> --repo <owner/repo> --squash --match-head-commit <head-sha>` command without `--auto`; no extra Mason approval is required."
    );
  }

  const requestedHead = String(request.matchHead || "").trim();
  const actualHead = String(pr.headRefOid || "").trim();
  if (request.atomicHeadMatch === false) {
    deny("PR MERGE GATE: this merge tool cannot atomically require GitHub to merge the inspected head SHA. Use one standalone `gh pr merge <n> --repo <owner/repo> --squash --match-head-commit <head-sha>` command instead; no extra Mason approval is required.");
  }
  if (!/^[0-9a-f]{40}$/i.test(requestedHead) || requestedHead.toLowerCase() !== actualHead.toLowerCase()) {
    deny(
      `PR MERGE GATE: the merge must include --match-head-commit ${actualHead} so GitHub cannot land a different commit after inspection. ` +
      "Refresh the PR, then retry the immediate merge with that exact SHA; no extra Mason approval is required."
    );
  }

  // ── green-pipeline requirement ─────────────────────────────────────────────
  if (!pullRequestChecksGreen(pr)) {
    deny(
      "PR MERGE GATE: this pull request is not merge-ready with a fully green GitHub pipeline " +
      "(mergeStateStatus must be CLEAN and every reported check completed successfully). " +
      "Wait for the required checks, then retry the immediate merge."
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
