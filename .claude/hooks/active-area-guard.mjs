#!/usr/bin/env node
// PreToolUse(Bash) guard: block destructive ops against a folder or branch Mason
// has marked ACTIVE, so "clear out the junk folders" can never sweep the worktree
// he told Claude not to touch.
//
// Mason (or Claude on his explicit say-so) maintains:
//   .claude/active-areas.json = { "folders": ["C:/CRX_Hardening"], "branches": ["feat/x"] }
// When that file is absent or empty, the guard is INERT (allow-all).
//
// FAIL-OPEN: any error → allow.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

function allow() { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })); process.exit(0); }
function passthrough() { process.exit(0); } // emit nothing → other hooks + normal flow
function deny(reason) { process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } })); process.exit(0); }

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { passthrough(); }

const cmd = String(payload?.tool_input?.command || "");
if (!cmd) passthrough();

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const cfgPath = path.join(projectDir, ".claude", "active-areas.json");
if (!existsSync(cfgPath)) passthrough();

let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, "utf8")); } catch { passthrough(); }
const folders = Array.isArray(cfg?.folders) ? cfg.folders : [];
const branches = Array.isArray(cfg?.branches) ? cfg.branches : [];
if (folders.length === 0 && branches.length === 0) passthrough();

const norm = (s) => String(s || "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

// Only inspect destructive command shapes.
const DESTRUCTIVE = /\b(rm\s+-[a-z]*[rf]|rmdir|del\s+\/|git\s+worktree\s+remove|git\s+branch\s+(?:-D|--delete)|git\s+clean\s+-[a-z]*[fdx]|git\s+push\s+(?:--force|-f))\b/i;
if (!DESTRUCTIVE.test(cmd)) passthrough();

const cmdNorm = norm(cmd);
for (const f of folders) {
  const fn = norm(f);
  if (fn && cmdNorm.includes(fn)) {
    deny(`ACTIVE-AREA GUARD: "${f}" is marked ACTIVE work in .claude/active-areas.json — do NOT delete/modify it without Mason's explicit OK. Remove it from active-areas.json first if he confirms it's safe.`);
  }
}
for (const b of branches) {
  const bn = norm(b);
  // match the branch name as a whole-ish token in the command
  if (bn && new RegExp(`(^|[\\s'"/])${bn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([\\s'"]|$)`).test(cmdNorm)) {
    deny(`ACTIVE-AREA GUARD: branch "${b}" is marked ACTIVE in .claude/active-areas.json — do not force-delete/reset it without Mason's OK.`);
  }
}

passthrough();
