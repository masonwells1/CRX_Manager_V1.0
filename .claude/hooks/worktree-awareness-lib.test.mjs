#!/usr/bin/env node
// Tests for the worktree-awareness porcelain parser.
// Run: node .claude/hooks/worktree-awareness-lib.test.mjs

import assert from "node:assert/strict";
import {
  parseWorktreePorcelain, siblingsOf, normPath,
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName,
  lastNonEmptyLine, firstCommentLine, fleetSummaryLine,
} from "./worktree-awareness-lib.mjs";

let pass = 0;
function ok(cond, msg) { assert.ok(cond, msg); pass++; }
function eq(a, b, msg) { assert.deepEqual(a, b, msg); pass++; }

const sample = [
  "worktree C:/CRX_Manager",
  "HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "branch refs/heads/main",
  "",
  "worktree C:/CRX_Hardening",
  "HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "branch refs/heads/claude/overnight-bug-hunt",
  "",
  "worktree C:/CRX_Detached",
  "HEAD cccccccccccccccccccccccccccccccccccccccc",
  "detached",
  "",
].join("\n");

const entries = parseWorktreePorcelain(sample);
eq(entries.length, 3, "three worktrees parsed");
eq(entries[0].branch, "main", "branch strips refs/heads/");
eq(entries[1].branch, "claude/overnight-bug-hunt", "nested branch name");
ok(entries[2].detached === true && entries[2].branch === null, "detached entry");
eq(entries[0].head, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "head sha captured");

// trailing entry with no blank line still parses
const noTrailingBlank = "worktree C:/A\nHEAD deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\nbranch refs/heads/feat/x";
const e2 = parseWorktreePorcelain(noTrailingBlank);
eq(e2.length, 1, "single entry without trailing blank");
eq(e2[0].branch, "feat/x", "branch parsed without trailing blank");

// empty input
eq(parseWorktreePorcelain("").length, 0, "empty input → no entries");
eq(parseWorktreePorcelain(null).length, 0, "null input → no entries");

// siblingsOf drops the current worktree (case/slash-insensitive)
const sibs = siblingsOf(entries, "c:\\CRX_Manager");
eq(sibs.length, 2, "current worktree excluded regardless of slash/case");
ok(!sibs.some((s) => normPath(s.path) === "c:/crx_manager"), "current not in siblings");

// no siblings when only the current worktree exists
eq(siblingsOf([entries[0]], "C:/CRX_Manager").length, 0, "solo → no siblings");

// ── fleet helpers (shared with scripts/fleet-status.mjs) ──

// merged-label classification from merge-base exit status
eq(mergedLabelFromStatus(0), "MERGED into origin/main", "status 0 → merged");
eq(mergedLabelFromStatus(1), "UNMERGED (not in origin/main)", "status 1 → unmerged");
eq(mergedLabelFromStatus(128), "merge-state unknown", "git error → unknown");
eq(mergedLabelFromStatus(0, false), "merge-state unknown", "no origin/main → unknown");

// ledger vs mission-doc classification
ok(isLedgerDoc("structure-wave-2-ledger.md"), "ledger doc matched");
ok(isLedgerDoc("Inventory-Layer2-Loop-LEDGER-2026-07-02.md"), "ledger match is case-insensitive");
ok(!isLedgerDoc("structure-wave-2-loop-2026-07-02.md"), "mission doc is not a ledger");
ok(!isLedgerDoc("some-ledger.txt"), "non-md file ignored");

// parked-migration classification
ok(isParkedMigrationFile("20260707120000_add_thing.sql"), "staged .sql counts as parked");
ok(!isParkedMigrationFile("SUPERSEDED-20260611080937_sweep.sql"), "SUPERSEDED drafts are not awaiting apply");
ok(!isParkedMigrationFile("notes.md"), "non-sql file ignored");
ok(isDraftSqlName("2026-07-01-per-acre-draft.sql"), "audits *draft*.sql counts as parked");
ok(!isDraftSqlName("2026-07-01-review-final.sql"), "audits sql without 'draft' ignored");

// last non-empty line (ledger tail) + truncation
eq(lastNonEmptyLine("first\nsecond\n\n   \n"), "second", "skips trailing blank lines");
eq(lastNonEmptyLine(""), "", "empty text → empty string");
const longTail = lastNonEmptyLine("x".repeat(200));
eq(longTail.length, 120, "long line truncated to 120 chars");
ok(longTail.endsWith("…"), "truncated line ends with ellipsis");

// first comment line of a SQL draft
eq(firstCommentLine("-- fix per-acre units\nCREATE TABLE x ();"), "fix per-acre units", "leading -- comment extracted");
eq(firstCommentLine("\nCREATE TABLE x ();"), "CREATE TABLE x ();", "no comment → first non-empty line");
eq(firstCommentLine(""), "", "empty sql → empty string");

// fleet summary line (singular/plural)
eq(
  fleetSummaryLine(1, 1),
  "Fleet: 1 loop ledger active · 1 parked migration awaiting apply — run /fleet for the full picture",
  "fleet line singular"
);
eq(
  fleetSummaryLine(3, 0),
  "Fleet: 3 loop ledgers active · 0 parked migrations awaiting apply — run /fleet for the full picture",
  "fleet line plural + zero"
);

console.log(`worktree-awareness-lib: ${pass} assertions passed`);
