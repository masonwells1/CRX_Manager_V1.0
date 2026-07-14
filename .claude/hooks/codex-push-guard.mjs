#!/usr/bin/env node
// PreToolUse(Bash) guard: block a push to main whose diff touches migrations /
// edge-functions / money-RLS code unless a fresh independent Codex verdict was
// recorded THIS session. This turns Mason's recurring "has codex reviewed all of
// these?" into a gate, not a hope. Non-risky pushes pass (auto-push stays intact).
//
// Proof: .claude/session-state/codex-review-<sha>.json with
//   { "codex_ran": true, "verdict": "clean"|"blockers-fixed", "head_sha": "<HEAD>", "timestamp": "<ISO>" }
// written by the /codex-review skill after the headless codex CLI returns.
//
// Non-pushes and ordinary non-production pushes pass. Ambiguous push context,
// force intent, and broad multi-ref modes fail closed.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  contentIsRisky,
  gitPushCwd,
  isGitPush,
  mainPushSource,
  proofValid,
  pushContextIsAmbiguous,
  pushIsForced,
  pushUsesBulkMode,
  riskyFiles,
} from "./codex-push-lib.mjs";

function passthrough() { process.exit(0); }               // emit nothing → normal flow (git push is allow-listed)
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { passthrough(); }

const cmd = String(payload?.tool_input?.command || "");
if (!isGitPush(cmd)) passthrough();
if (pushContextIsAmbiguous(cmd)) {
  deny("CODEX GATE: directory-changing or GIT_DIR/GIT_WORK_TREE-prefixed pushes cannot be bound safely to the inspected worktree. Use `git -C <repo> push`.");
}

// Claude's shell cwd can persist across tool calls. The hook payload's cwd is
// therefore the authoritative repository context for this specific push; the
// session-wide CLAUDE_PROJECT_DIR is only a fallback.
const projectDir = path.resolve(
  payload?.cwd || payload?.tool_input?.cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd(),
);
function git(args, cwd) {
  const env = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"]) delete env[key];
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

// Inspect every push in a chained/multiline command. A harmless first push must
// not hide a later main-bound push. Single `|` splits too (Codex round-4):
// both sides of a pipeline execute.
const pushCommands = cmd
  .split(/(?:&&|\|\|?|;|\r?\n)/)
  .map((segment) => segment.trim())
  .filter((segment) => isGitPush(segment));

for (const pushCmd of pushCommands) {
  if (/--git-dir|--work-tree/i.test(pushCmd)) {
    deny("CODEX GATE: pushes using explicit --git-dir/--work-tree contexts are denied because the guard cannot safely bind them to the inspected worktree. Use `git -C <repo> push` instead.");
  }
  if (pushUsesBulkMode(pushCmd)) {
    deny("CODEX GATE: bulk push modes (`--all`/`--branches`/`--mirror`/`--prune`) can alter multiple remote refs and are always blocked. Push one explicit branch/refspec instead.");
  }
  if (pushIsForced(pushCmd)) {
    deny("CODEX GATE: force-pushing any branch rewrites shared history and requires Mason's explicit approval. Use a normal push or a compensating commit.");
  }

  const pushRepoDir = gitPushCwd(pushCmd, projectDir);
  let branch = "";
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"], pushRepoDir);
  } catch (error) {
    deny(`CODEX GATE: could not determine the repository/branch selected by this push, so it is denied. ${error?.message || error}`);
  }

  const srcRef = mainPushSource(pushCmd, branch);
  if (!srcRef) continue;
  if (srcRef === "DELETE") {
    deny("CODEX GATE: `git push origin :main` DELETES the production main branch. Never do this. If a bad commit landed, use the /rollback runbook (compensating commit / Vercel promote-previous) instead.");
  }

  try {
    git(["rev-parse", "--verify", "--quiet", "origin/main"], pushRepoDir);
  } catch (error) {
    deny(`CODEX GATE: could not resolve origin/main for the selected push repository, so the push is denied. ${error?.message || error}`);
  }

  let srcSha = "";
  try {
    srcSha = git(["rev-parse", "--verify", srcRef === "HEAD" ? "HEAD" : srcRef], pushRepoDir);
  } catch (error) {
    deny(`CODEX GATE: could not resolve the exact ref being pushed to main, so the push is denied. ${error?.message || error}`);
  }

  let files = [];
  try {
    files = git(["diff", "--name-only", `origin/main...${srcSha}`], pushRepoDir)
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
  } catch (error) {
    deny(`CODEX GATE: could not inspect the main-bound diff, so the push is denied. ${error?.message || error}`);
  }

  const risky = riskyFiles(files);
  let contentFlagged = false;
  if (risky.length === 0) {
    try {
      contentFlagged = contentIsRisky(git(["diff", `origin/main...${srcSha}`], pushRepoDir));
    } catch (error) {
      deny(`CODEX GATE: could not inspect the full main-bound diff for money/security risk, so the push is denied. ${error?.message || error}`);
    }
  }
  if (risky.length === 0 && !contentFlagged) continue;

  const headSha = srcSha;
  const stateDir = path.join(pushRepoDir, ".claude", "session-state");
  let valid = false;
  try {
    if (existsSync(stateDir)) {
      for (const f of readdirSync(stateDir)) {
        // Charset must be no wider than review-proof-guard's path matcher, or a
        // forged proof named outside the matcher (e.g. with a space) could be
        // written unguarded yet still load here (Codex round-5).
        if (!/^codex-review-[A-Za-z0-9_.-]+\.json$/.test(f)) continue;
        let data;
        try { data = JSON.parse(readFileSync(path.join(stateDir, f), "utf8")); } catch { continue; }
        if (proofValid(data, headSha, Date.now())) { valid = true; break; }
      }
    }
  } catch { /* unreadable means no proof */ }
  if (valid) continue;

  const riskyDescription = risky.length > 0
    ? `changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
      risky.slice(0, 6).map((f) => "  " + f).join("\n") +
      (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "")
    : "changes content that matches a money/financial-audit pattern (_cents, balance_cents, financial_audit_log, allocate_payment, apply_prepay) even though no changed file's PATH looked risky";

  deny(
    `CODEX GATE: this push to main ${riskyDescription}\n\n"Review is queued/scheduled" is NOT reviewed. Before pushing:\n` +
    `  1. Run: node scripts/write-codex-push-proof.mjs — it runs an independent read-only Codex review of this exact HEAD (origin/main...HEAD) and requires a machine verdict.\n` +
    `  2. If Codex flags blockers, fix them and re-run until it reports clean; only a clean verdict on a stable, clean worktree mints the proof.\n` +
    `  3. On success it writes the HEAD-bound proof {codex_ran:true, verdict:"clean", head_sha:"${headSha || "<HEAD>"}", timestamp:"<ISO>"} for you — never hand-write it (review-proof-guard blocks that).\n` +
    `  4. Retry the push.\n` +
    `If the Codex CLI is unavailable, PARK the change and tell Mason — do not self-certify. (Proof is HEAD-bound + expires in 30min.)`
  );
}

passthrough();
