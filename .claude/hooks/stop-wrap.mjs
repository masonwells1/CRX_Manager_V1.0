#!/usr/bin/env node
// Stop hook — session wrap-up.
// Complements stop-verify.mjs (which forces build+test after code changes).
// This hook surfaces "loose ends" Mason should resolve before closing:
//   - Uncommitted files (so work doesn't get lost)
//   - Migrations written but not applied to live
//   - Edge Functions edited but not redeployed
//   - Prompt to capture learnings to memory if the session was substantive
//
// Returns "block" with the loose-ends list, so Claude is forced to surface it
// before declaring the session done.

import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";

let payload = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8"));
} catch { /* fine */ }

const sessionId = payload?.session_id || "unknown";
const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

function runGit(args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
      cwd: projectDir,
    });
  } catch {
    return "";
  }
}

const issues = [];

// ─── Uncommitted files (filtered to meaningful paths) ────────────────────
const porcelain = runGit(["status", "--porcelain"]);
const lines = porcelain.split("\n").filter(l => l.trim());
const meaningful = lines.filter(l => {
  const p = l.slice(3);
  return !p.startsWith(".claude/worktrees/")
    && !p.startsWith(".playwright-mcp/")
    && !p.endsWith(".log")
    && !p.startsWith("node_modules/");
});

if (meaningful.length > 0) {
  issues.push(
    `📝 ${meaningful.length} uncommitted file(s):\n` +
    meaningful.slice(0, 8).map(l => "     " + l).join("\n") +
    (meaningful.length > 8 ? `\n     ... and ${meaningful.length - 8} more` : "")
  );
}

// ─── Migrations written but not yet applied to live ──────────────────────
// Heuristic: any *.sql file in supabase/migrations/ that appears in
// `git status` as untracked or modified AND is newer than the last
// successful Supabase apply (we can't see Supabase MCP state from here,
// so we just flag any uncommitted migration as "needs attention").
const migrationLines = lines.filter(l => /supabase\/migrations\/.+\.sql$/.test(l));
if (migrationLines.length > 0) {
  issues.push(
    `🗄️  ${migrationLines.length} migration file(s) uncommitted — confirm each is APPLIED to live (via Supabase MCP apply_migration) before committing:\n` +
    migrationLines.map(l => "     " + l).join("\n")
  );
}

// ─── Edge Functions edited but possibly not redeployed ───────────────────
const edgeFnLines = lines.filter(l => /supabase\/functions\/.+\.ts$/.test(l));
if (edgeFnLines.length > 0) {
  issues.push(
    `⚡ ${edgeFnLines.length} Edge Function file(s) modified — confirm each was redeployed via /deploy-edge-function:\n` +
    edgeFnLines.map(l => "     " + l).join("\n")
  );
}

// ─── Learnings capture prompt (only on substantive sessions) ─────────────
// Heuristic: if 5+ files changed this session, prompt to capture a learning.
let priorPorcelain = "";
const snapPath = path.join(os.tmpdir(), "crx-claude-hooks", `session-${sessionId}.snapshot`);
if (existsSync(snapPath)) {
  try { priorPorcelain = readFileSync(snapPath, "utf8"); } catch { /* ignore */ }
}
const priorSet = new Set(priorPorcelain.split("\n").map(l => l.trim()).filter(Boolean));
const newOrChanged = lines.filter(l => !priorSet.has(l.trim()));
if (newOrChanged.length >= 5) {
  issues.push(
    `🧠 Substantive session (${newOrChanged.length} new/changed files).\n` +
    `     Did Mason learn or decide something non-obvious that should outlive this session?\n` +
    `     If yes — save a memory file under C:\\Users\\mason\\.claude\\projects\\C--Users-mason-CRX-Manager-V1-0\\memory\\\n` +
    `     (feedback memory, project memory, or reference memory — whichever fits).\n` +
    `     Don't save what's already derivable from code/docs/git history.`
  );
}

if (issues.length === 0) {
  process.exit(0);
}

const reason =
  `═══ SESSION WRAP — LOOSE ENDS ═══\n\n` +
  issues.join("\n\n") +
  `\n\nBefore declaring the session done, surface these to Mason. He may want to:\n` +
  `  • Run /preflight, then commit (catches subagent-review gaps too)\n` +
  `  • Apply any pending migration via Supabase MCP\n` +
  `  • Run /deploy-edge-function on each modified function\n` +
  `  • Capture a learning to memory\n` +
  `\nIf Mason confirms each item is intentional or already done, you can stop.`;

process.stdout.write(JSON.stringify({ decision: "block", reason }));
