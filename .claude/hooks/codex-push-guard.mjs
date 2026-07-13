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
// FAIL-OPEN: not a push, not on main, no origin/main, or any error → allow.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { isGitPush, mainPushIsForced, mainPushSource, riskyFiles, contentIsRisky, proofValid } from "./codex-push-lib.mjs";

function passthrough() { process.exit(0); }               // emit nothing → normal flow (git push is allow-listed)
function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
  process.exit(0);
}

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { passthrough(); }

const cmd = String(payload?.tool_input?.command || "");
if (!isGitPush(cmd)) passthrough();

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
function git(args) {
  return execFileSync("git", args, { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"], cwd: projectDir }).trim();
}

// Only gate pushes that LAND ON main (prod) — including HEAD:main / feature:main
// refspecs from any branch. The diff AND the proof bind to the ref actually being
// pushed (Codex 2026-07-05: `git push origin release:main` used to be checked
// against HEAD — the wrong content). Pushes to other branches are fine.
let branch = "";
try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"]); } catch { passthrough(); }
const srcRef = mainPushSource(cmd, branch);
if (!srcRef) passthrough();
if (srcRef === "DELETE") {
  deny("CODEX GATE: `git push origin :main` DELETES the production main branch. Never do this. If a bad commit landed, use the /rollback runbook (compensating commit / Vercel promote-previous) instead.");
}
if (mainPushIsForced(cmd, branch)) {
  deny("CODEX GATE: force-pushing production main rewrites shared history and is always blocked. Use a normal reviewed push, a compensating commit, or the /rollback runbook.");
}

// Need origin/main to diff against; if absent, fail open.
try { git(["rev-parse", "--verify", "--quiet", "origin/main"]); } catch { passthrough(); }

// Resolve the PUSHED ref; if git can't resolve it, the push itself will fail —
// let git report that (fail-open).
let srcSha = "";
try { srcSha = git(["rev-parse", "--verify", srcRef === "HEAD" ? "HEAD" : srcRef]); } catch { passthrough(); }

let files = [];
try { files = git(["diff", "--name-only", `origin/main...${srcSha}`]).split("\n").map((s) => s.trim()).filter(Boolean); } catch { passthrough(); }

const risky = riskyFiles(files);

// FIX 4 (2026-07-13): even when no file's PATH matches the risky patterns, the
// diff's CONTENT might still touch money/financial-audit-log/prepay logic in a
// file outside the usual risky paths. Only bother computing the full diff text
// when the cheaper path check found nothing — this stays a no-op for the
// common case (ordinary non-money pushes never pay this cost).
let contentFlagged = false;
if (risky.length === 0) {
  try {
    const diffText = git(["diff", `origin/main...${srcSha}`]);
    if (contentIsRisky(diffText)) contentFlagged = true;
  } catch { /* fail open on this EXTRA check only — path-based risk already cleared */ }
}
if (risky.length === 0 && !contentFlagged) passthrough(); // ordinary code push — auto-push authorized, allow

const headSha = srcSha; // proof binds to the pushed ref's sha

// Look for a valid, HEAD-bound, recent Codex proof.
const stateDir = path.join(projectDir, ".claude", "session-state");
let valid = false;
try {
  if (existsSync(stateDir)) {
    for (const f of readdirSync(stateDir)) {
      if (!/^codex-review-.*\.json$/.test(f)) continue;
      let data;
      try { data = JSON.parse(readFileSync(path.join(stateDir, f), "utf8")); } catch { continue; }
      if (proofValid(data, headSha, Date.now())) { valid = true; break; }
    }
  }
} catch { /* unreadable → treat as no proof */ }

if (valid) passthrough();

const riskyDescription = risky.length > 0
  ? `changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
    risky.slice(0, 6).map((f) => "  " + f).join("\n") +
    (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "")
  : "changes content that matches a money/financial-audit pattern (_cents, balance_cents, financial_audit_log, allocate_payment, apply_prepay) even though no changed file's PATH looked risky";

deny(
  `CODEX GATE: this push to main ${riskyDescription}\n\n"Review is queued/scheduled" is NOT reviewed. Before pushing:\n` +
  `  1. Run /codex-review (the headless codex CLI) on this diff.\n` +
  `  2. Fix any blockers and re-review until clean.\n` +
  `  3. It writes .claude/session-state/codex-review-<sha>.json {codex_ran:true, verdict:"clean", head_sha:"${headSha || "<HEAD>"}", timestamp:"<ISO>"}.\n` +
  `  4. Retry the push.\n` +
  `If the Codex CLI is unavailable, PARK the change and tell Mason — do not self-certify. (Proof is HEAD-bound + expires in 30min.)`
);
