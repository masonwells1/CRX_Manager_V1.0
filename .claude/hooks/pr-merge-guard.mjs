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
  ghApiMergeRequest,
  ghMergeRequest,
  mcpMergeRequest,
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

// ── detect merge intent ──────────────────────────────────────────────────────
let request = null;
if (GITHUB_MERGE_TOOL.test(toolName)) {
  request = mcpMergeRequest(toolInput);
} else if (typeof toolInput.command === "string" && toolInput.command) {
  // Inspect every segment of a chained command — a harmless first segment must
  // not hide a later merge (same splitting rule as codex-push-guard).
  for (const segment of toolInput.command.split(/(?:&&|\|\|?|;|\r?\n)/)) {
    const api = ghApiMergeRequest(segment);
    if (api?.unsupportedGraphql) {
      deny("PR MERGE GATE: GraphQL mergePullRequest mutations are denied because the guard cannot safely resolve and verify the PR's head/checks. Use `gh pr merge <number>` instead.");
    }
    request = api || ghMergeRequest(segment);
    if (request) break;
    // Raw REST merges outside gh — curl/wget/Invoke-RestMethod/node fetch — name
    // the same endpoint but carry auth/context the guard cannot resolve, so they
    // are denied outright rather than gated (Codex review of this very PR,
    // 2026-07-16: an authenticated `curl -X PUT .../pulls/N/merge` bypassed the
    // gate entirely; fail closed and route through gh instead).
    if (/\/pulls\/[^\s/]+\/merge\b/i.test(segment)) {
      deny("PR MERGE GATE: raw GitHub REST merge calls (curl/wget/Invoke-RestMethod/fetch against .../pulls/<n>/merge) are denied because the guard cannot resolve and verify the PR's base, head, and checks for them. Use `gh pr merge <number>` so the gate can verify the merge.");
    }
  }
}
if (!request) passthrough();

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
function git(args) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, {
    cwd: projectDir, env, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

let pr;
try {
  const viewArgs = ["pr", "view"];
  if (request.selector) viewArgs.push(String(request.selector));
  viewArgs.push("--json", "baseRefName,headRefOid,mergeStateStatus,statusCheckRollup");
  if (request.repo) viewArgs.push("--repo", request.repo);
  pr = JSON.parse(gh(viewArgs));
  if (!pr?.baseRefName || !pr?.headRefOid) throw new Error("GitHub did not return baseRefName and headRefOid");
} catch (error) {
  deny(`PR MERGE GATE: could not resolve this pull request's base branch and exact head SHA, so the merge is denied (fail closed). ${error?.message || error}`);
}

const base = String(pr.baseRefName || "").trim().toLowerCase();
if (base === "master" || base === "production") {
  deny(`PR MERGE GATE: merges into protected branch "${base}" are always blocked.`);
}
if (base !== "main") passthrough(); // feature-branch merges are not production landings

// ── green-pipeline requirement ───────────────────────────────────────────────
// `--auto` defers the merge to GitHub, which itself enforces the required
// checks — so only immediate merges must already be green here.
if (!request.auto && !pullRequestChecksGreen(pr)) {
  deny(
    "PR MERGE GATE: this pull request is not merge-ready with a fully green GitHub pipeline " +
    "(mergeStateStatus must be CLEAN and every reported check completed successfully). " +
    "Wait for the required Vercel check, or use `gh pr merge --auto` to let GitHub merge when green."
  );
}

// ── risky-diff classification (same rules as the push gate) ──────────────────
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
if (risky.length === 0 && !contentFlagged) passthrough();

// ── risky merge: --auto is denied outright ───────────────────────────────────
// Auto-merge defers the landing until GitHub's checks pass — AFTER this hook has
// run. Later commits pushed to the branch would then merge with no fresh proof
// and no re-run of this gate (Codex round-4 review of PR #142). Risky diffs must
// merge immediately, with a fresh proof, while the gate can still see them.
if (request.auto) {
  deny(
    "PR MERGE GATE: `--auto` is not allowed for a risky diff — auto-merge lands the PR later, " +
    "after this gate has run, so commits pushed in the meantime would merge with a stale (or no) " +
    "Codex proof. Wait for the checks, then merge immediately: mint the proof with " +
    "`node scripts/write-codex-push-proof.mjs` and run `gh pr merge <n> --squash` (no --auto)."
  );
}

// ── risky merge → require the fresh, bound Codex proof ──────────────────────
const headSha = pr.headRefOid;
let baseSha = "";
try {
  baseSha = git(["rev-parse", "--verify", "--quiet", "origin/main"]);
} catch (error) {
  deny(`PR MERGE GATE: could not resolve origin/main to bind the Codex proof against, so the merge is denied. ${error?.message || error}`);
}

const stateDir = path.join(projectDir, ".claude", "session-state");
let valid = false;
try {
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir)) {
      if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(f)) continue;
      let data;
      try { data = JSON.parse(readFileSync(path.join(stateDir, f), "utf8")); } catch { continue; }
      if (proofValid(data, headSha, Date.now(), baseSha)) { valid = true; break; }
    }
  }
} catch { /* unreadable means no proof */ }
if (valid) passthrough();

const riskyDescription = risky.length > 0
  ? `changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
    risky.slice(0, 6).map((f) => "  " + f).join("\n") +
    (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "")
  : "changes content that matches a money/financial-audit pattern (_cents, financial_audit_log, allocate_payment, apply_prepay) even though no changed file's PATH looked risky";

deny(
  `PR MERGE GATE: merging this PR lands a diff on main that ${riskyDescription}\n\n` +
  `"Review is queued/scheduled" is NOT reviewed. Before merging:\n` +
  `  1. Check out the PR branch (\`gh pr checkout ${request.selector || "<number>"}\`) if it isn't the current branch.\n` +
  `  2. Run: node scripts/write-codex-push-proof.mjs — it runs an independent read-only Codex review of origin/main...HEAD and requires a machine verdict.\n` +
  `  3. If Codex flags blockers, fix them, push, and re-run until it reports clean; only a clean verdict on a stable, clean worktree mints the proof.\n` +
  `  4. Retry the merge. (Proof is bound to head ${headSha || "<head>"} and to origin/main; it expires in 30min, and a moved base or new commits force a fresh review.)\n` +
  `If the Codex CLI is unavailable, PARK the change and tell Mason — do not self-certify.`
);
