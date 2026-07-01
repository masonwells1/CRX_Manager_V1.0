#!/usr/bin/env node
// PreToolUse guard: keep live-DB analysis on FAKE data, and keep cancel/void of real
// financial records owner-only. Fires only on execute_sql that INSERTs into a business
// table (without [E2E]) or DELETE/void of a financial table. Everything else passes.
//
// Override: if .claude/session-state/REAL-DATA-OK exists (Claude writes it only when Mason
// explicitly authorizes a real write), the guard stands down.
//
// FAIL-OPEN: any error → emit nothing (normal flow).

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { classifySql } from "./live-testdata-lib.mjs";

function nothing() { process.exit(0); }

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch { nothing(); }

const toolName = String(payload?.tool_name || "");
if (!/execute_sql/i.test(toolName)) nothing();

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
if (existsSync(path.join(projectDir, ".claude", "session-state", "REAL-DATA-OK"))) nothing();

const verdict = classifySql(payload?.tool_input?.query);
if (!verdict.block) nothing();

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `LIVE-DATA GUARD: ${verdict.reason}`,
  },
}));
process.exit(0);
