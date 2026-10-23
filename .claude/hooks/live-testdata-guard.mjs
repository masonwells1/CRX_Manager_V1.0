#!/usr/bin/env node
// PreToolUse guard for live execute_sql. Keeps analysis on FAKE [E2E] data and
// refuses raw writes that belong to Mason or to the migration path: audit-log
// writes, TRUNCATE, DDL/GRANT/REVOKE, sequence changes, RPC calls, real
// inserts/updates/deletes, money-column updates and cancels/voids. The rule
// list lives in classifySql (live-testdata-lib.mjs).
//
// Override: a REAL-DATA-OK marker in .claude/session-state/ (Claude writes it
// only when Mason explicitly authorizes a real write) relaxes ONLY ordinary
// writes — real inserts/updates and money-column updates, not RPC calls — and only
// while it is fresh: its FIRST LINE must be the UTC time it was written, e.g.
// `2026-10-23T21:00:00Z Mason OK: <what he approved>`, no older than
// REAL_DATA_OK_MAX_AGE_MS. The time is read from the content, not the file's
// mtime, because new worktrees receive a copy of the main checkout's
// session-state with a fresh mtime: one 2026-10-19 marker had been copied into
// 13 worktrees and switched every rule off, TRUNCATE and DDL included (2026-10-23).
//
// FAIL-CLOSED (2026-10-23): an unreadable event or a classifier error denies the
// call, and the settings registration sets onFailure "block", so a crash or
// timeout of this process refuses it too.
// @proven-by guards.test.mjs ("unreadable execute_sql event is denied")

import { readFileSync } from "node:fs";
import path from "node:path";
import { classifySql } from "./live-testdata-lib.mjs";

const REAL_DATA_OK_MAX_AGE_MS = 2 * 60 * 60 * 1000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;
// The time must open the FIRST line (an optional BOM or spaces aside, no blank
// line before it). CLOCK_SKEW_MS lets a time a few minutes ahead of this clock count.
const LEADING_UTC_TIME_RE = /^﻿?[ \t]*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/;

function markerIsFresh(markerPath) {
  let body;
  try { body = readFileSync(markerPath, "utf8"); } catch { return false; }
  const m = LEADING_UTC_TIME_RE.exec(body);
  if (!m) return false;
  const age = Date.now() - Date.parse(m[1]);
  return age >= -CLOCK_SKEW_MS && age < REAL_DATA_OK_MAX_AGE_MS;
}

function nothing() { process.exit(0); }

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `LIVE-DATA GUARD: ${reason}`,
    },
  }));
  process.exit(0);
}

// The registration matches execute_sql only, so an event this process cannot
// read, or a classifier crash, is refused: onFailure "block" never sees a clean exit.
let payload;
try { payload = JSON.parse(readFileSync(0, "utf8")); } catch {
  deny("the tool call could not be read, so it is refused rather than assumed harmless.");
}

const toolName = String(payload?.tool_name || "");
if (!/execute_sql/i.test(toolName)) nothing();

const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const markerPath = path.join(projectDir, ".claude", "session-state", "REAL-DATA-OK");
let verdict;
try {
  verdict = classifySql(payload?.tool_input?.query, { realDataOk: markerIsFresh(markerPath) });
} catch {
  deny("the SQL could not be checked, so it is refused rather than assumed harmless.");
}
if (!verdict.block) nothing();
deny(verdict.reason);
