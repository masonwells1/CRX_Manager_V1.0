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
import { isGitPush, riskyFiles, proofValid } from "./codex-push-lib.mjs";

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

// Only gate pushes FROM main (prod). Feature-branch pushes are fine.
let branch = "";
try { branch = git(["rev-parse", "--abbrev-ref", "HEAD"]); } catch { passthrough(); }
if (branch !== "main") passthrough();

// Need origin/main to diff against; if absent, fail open.
try { git(["rev-parse", "--verify", "--quiet", "origin/main"]); } catch { passthrough(); }

let files = [];
try { files = git(["diff", "--name-only", "origin/main...HEAD"]).split("\n").map((s) => s.trim()).filter(Boolean); } catch { passthrough(); }

const risky = riskyFiles(files);
if (risky.length === 0) passthrough(); // ordinary code push — auto-push authorized, allow

let headSha = "";
try { headSha = git(["rev-parse", "HEAD"]); } catch { headSha = ""; }

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

deny(
  `CODEX GATE: this push to main changes ${risky.length} risky file(s) that need an independent Codex verdict FIRST:\n` +
  risky.slice(0, 6).map((f) => "  " + f).join("\n") +
  (risky.length > 6 ? `\n  ... and ${risky.length - 6} more` : "") +
  `\n\n"Review is queued/scheduled" is NOT reviewed. Before pushing:\n` +
  `  1. Run /codex-review (the headless codex CLI) on this diff.\n` +
  `  2. Fix any blockers and re-review until clean.\n` +
  `  3. It writes .claude/session-state/codex-review-<sha>.json {codex_ran:true, verdict:"clean", head_sha:"${headSha || "<HEAD>"}", timestamp:"<ISO>"}.\n` +
  `  4. Retry the push.\n` +
  `If the Codex CLI is unavailable, PARK the change and tell Mason — do not self-certify. (Proof is HEAD-bound + expires in 30min.)`
);
