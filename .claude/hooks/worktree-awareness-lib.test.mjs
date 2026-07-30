#!/usr/bin/env node
// Tests for the worktree-awareness porcelain parser.
// Run: node .claude/hooks/worktree-awareness-lib.test.mjs

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWorktreePorcelain, siblingsOf, normPath,
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName,
  lastNonEmptyLine, firstCommentLine, fleetSummaryLine,
  isParkedDraftPath, parkedDraftPathsFrom, draftPathspec, normRepoPath,
  hasExplicitParkedMigrationHeader, isParkedFallbackFile, originMainDraftPathSet,
  fallbackPathsAgainstOrigin, parkedMainlinePathsFrom, parkedMainlineDiscoveryFrom,
  localCandidateMigrationPathsFromHistory, validateParkedMigrationCrossReferences,
  ORIGIN_MAIN_PARKED_MIGRATION_GREP_ARGS, originMainParkedMigrationPrefilter,
  ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, originMainSqlBlobMap, originMainForwardBlobPaths,
  createOwnDraftPathsReader,
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

// Which repo-relative paths are parked drafts at all (2026-07-29). Frozen snapshots kept
// reporting long-retired drafts forever, so retiring one on main could never clear the
// banner — it sat at 2 with nothing actually pending. The count is now fed from what a
// worktree CHANGED since its branch point, so this decides which of those paths qualify.
const DISPATCH = "scripts/.staging-migrations/workflow-waves-parked/PARKED-dispatch-backfill.sql";
const PARKED_FORWARD = "supabase/migrations/20260729231031_vendor_bill_period_close_lock.sql";
const PARKED_FORWARD_HEADER = "-- Accounting-period close/write serialization.\n-- PARKED / DO NOT APPLY without Mason approval\n";
const BOM_PARKED_FORWARD_HEADER = `\uFEFF${PARKED_FORWARD_HEADER}`;
const PARKED_DRAFT_HEADER = "-- Purpose comment stays first.\n-- PARKED DRAFT — NOT APPLIED until review\n";
const PARKED_COLON_HEADER = "-- PARKED: owner-gated. Do NOT apply without Mason's explicit OK.\n";
const NOT_APPLIED_HEADER = "-- NOT APPLIED\n";
const DO_NOT_APPLY_HEADER = "-- DO NOT APPLY\n";
const NOT_SPACED_APPLIED_HEADER = "-- NOT    APPLIED\n";
const DO_TABBED_NOT_APPLY_HEADER = "-- DO\tNOT\tAPPLY: owner gate\n";
const STATUS_TABBED_NOT_APPLIED_HEADER = "-- STATUS: NOT\tAPPLIED\n";
const INDENTED_TABBED_NOT_APPLIED_HEADER = " \t--   NOT\tAPPLIED\n";
const NBSP_NOT_APPLIED_HEADER = "-- NOT\u00a0APPLIED\n";
const NBSP_AFTER_COMMENT_HEADER = "--\u00a0NOT APPLIED\n";
const FALSE_PROSE_HEADER = "-- Historical note: NOT APPLIED after a prior review\n";
const HISTORICAL_PARKED_COLON_PROSE = "-- PARKED: historical migration applied after a prior review\n";
const LATER_STATUS_HEADER = "SELECT 1;\n-- NOT APPLIED\n";
ok(isParkedDraftPath(DISPATCH), "a staged .sql draft is a parked draft");
ok(isParkedDraftPath("docs/audits/new-hunt/PARKED-brand-new.sql"), "an audits PARKED-*.sql is a parked draft");
ok(isParkedDraftPath("docs/audits/2026-07-01-per-acre-draft.sql"), "an audits *draft*.sql is a parked draft");
ok(!isParkedDraftPath("docs/audits/2026-07-01-review-final.sql"), "an audits .sql that is not a draft does not count");
ok(!isParkedDraftPath("scripts/.staging-migrations/SUPERSEDED-old.sql"), "a SUPERSEDED draft is retired, not pending");
ok(hasExplicitParkedMigrationHeader(PARKED_FORWARD_HEADER), "explicit parked header is recognized");
ok(hasExplicitParkedMigrationHeader(BOM_PARKED_FORWARD_HEADER), "a UTF-8 BOM cannot hide an explicit parked header");
ok(hasExplicitParkedMigrationHeader(PARKED_DRAFT_HEADER), "PARKED DRAFT / NOT APPLIED status line is recognized");
ok(hasExplicitParkedMigrationHeader(PARKED_COLON_HEADER), "PARKED colon header with an owner-gated DO NOT APPLY directive is recognized");
ok(hasExplicitParkedMigrationHeader(NOT_APPLIED_HEADER), "standalone NOT APPLIED status line is recognized");
ok(hasExplicitParkedMigrationHeader(DO_NOT_APPLY_HEADER), "standalone DO NOT APPLY status line is recognized");
ok(hasExplicitParkedMigrationHeader(NOT_SPACED_APPLIED_HEADER), "repeated-space NOT APPLIED status line is recognized");
ok(hasExplicitParkedMigrationHeader(DO_TABBED_NOT_APPLY_HEADER), "tabbed DO NOT APPLY status line with owner-gate colon is recognized");
ok(hasExplicitParkedMigrationHeader(STATUS_TABBED_NOT_APPLIED_HEADER), "STATUS-prefixed tabbed NOT APPLIED status line is recognized");
ok(hasExplicitParkedMigrationHeader(INDENTED_TABBED_NOT_APPLIED_HEADER), "leading indentation plus multiple comment-padding spaces/tabs is recognized");
ok(!hasExplicitParkedMigrationHeader(NBSP_NOT_APPLIED_HEADER), "NBSP between multiword status tokens is rejected by portable parser grammar");
ok(!hasExplicitParkedMigrationHeader(NBSP_AFTER_COMMENT_HEADER), "NBSP after SQL comment marker is rejected by portable parser grammar");
ok(!hasExplicitParkedMigrationHeader(FALSE_PROSE_HEADER), "status-looking prose after another leading comment word is rejected");
ok(!hasExplicitParkedMigrationHeader(HISTORICAL_PARKED_COLON_PROSE), "historical PARKED colon prose without a current directive is rejected");
ok(!hasExplicitParkedMigrationHeader(LATER_STATUS_HEADER), "status-looking later comment after SQL is outside the leading header window");
ok(!hasExplicitParkedMigrationHeader("-- normal feature migration\nCREATE TABLE public.example();"), "ordinary leading comments do not park a migration");
ok(!hasExplicitParkedMigrationHeader("-- This was previously parked for review\nSELECT 1;"), "historical parked prose is not a current status line");
ok(!hasExplicitParkedMigrationHeader("-- PARKED migration notes appear later\nSELECT 1;"), "bare parked prose is not a current status line");
ok(isParkedDraftPath(PARKED_FORWARD, PARKED_FORWARD_HEADER), "explicitly parked forward migration is surfaced");
ok(!isParkedDraftPath("supabase/migrations/SUPERSEDED-20260729231031_vendor_bill_period_close_lock.sql", PARKED_FORWARD_HEADER), "SUPERSEDED forward migration is never surfaced");
ok(!isParkedDraftPath("supabase/migrations/20260101000000_real.sql", "-- normal feature migration\nSELECT 1;"), "ordinary applied migration is not a parked draft");
ok(isParkedFallbackFile(PARKED_FORWARD, "20260729231031_vendor_bill_period_close_lock.sql", () => PARKED_FORWARD_HEADER), "fallback finds an explicitly parked forward migration");
ok(!isParkedFallbackFile("supabase/migrations/20260101000000_real.sql", "20260101000000_real.sql", () => "-- normal feature migration\nSELECT 1;"), "fallback excludes an ordinary forward migration");
let fallbackNonSqlReads = 0;
ok(!isParkedFallbackFile("supabase/migrations/notes.md", "notes.md", () => { fallbackNonSqlReads++; return PARKED_FORWARD_HEADER; }), "fallback excludes non-SQL before reading content");
eq(fallbackNonSqlReads, 0, "fallback preserves the cheap filename rejection before a read");
ok(!isParkedDraftPath("docs/audits/notes.md"), "a non-sql audit file is not a draft");
ok(!isParkedDraftPath(""), "an empty path is not a draft");
ok(!isParkedDraftPath(null), "a missing path is not a draft, and does not throw");
ok(isParkedDraftPath(DISPATCH.replace(/\//g, "\\")), "Windows backslashes still classify");

// Turning git's changed-path list into the set the count is keyed by. Identity is the
// repo-relative PATH, never the basename (CodeRabbit P2 + Codex MED on #279): draft names
// repeat across hunts, so a filename key would merge two distinct pending drafts into one.
const changed = parkedDraftPathsFrom([
  DISPATCH,
  "docs/audits/new-hunt/PARKED-dispatch-backfill.sql", // same filename, different folder
  "docs/audits/new-hunt/notes.md",
  "src/pages/Invoices.tsx",
  "",
]);
eq(changed.size, 2, "two same-named drafts in different folders stay two entries");
ok(changed.has(normRepoPath(DISPATCH)), "the staged draft is keyed by its full path");
ok(changed.has("docs/audits/new-hunt/parked-dispatch-backfill.sql"), "the audits draft is keyed separately");
// Keyed lower-case for dedupe, but /fleet must show Mason the real filename.
eq(changed.get(normRepoPath(DISPATCH)), DISPATCH, "the path is reported as git spelled it, not lower-cased");
// The same draft checked out in 42 worktrees sits at the same relative path in each.
eq(parkedDraftPathsFrom([DISPATCH, DISPATCH.toUpperCase()]).size, 1, "the same draft in many checkouts collapses to one");
eq(parkedDraftPathsFrom([]).size, 0, "a worktree that changed nothing contributes nothing");
eq(parkedDraftPathsFrom(null).size, 0, "a missing change list contributes nothing rather than throwing");
// Retiring a draft shows up in the diff as a change to the OLD path — counting that would
// re-report the very file the SUPERSEDED- rename retired.
eq(parkedDraftPathsFrom([DISPATCH], () => false).size, 0, "a draft the branch deleted is not pending work");
eq(parkedDraftPathsFrom([DISPATCH], (p) => p === DISPATCH).size, 1, "the existence check sees the raw path, not the lower-cased key");
eq(parkedDraftPathsFrom([PARKED_FORWARD], () => true, () => PARKED_FORWARD_HEADER).size, 1, "an explicitly parked forward migration is retained");
eq(parkedDraftPathsFrom([PARKED_FORWARD], () => true, () => "-- ordinary migration\nSELECT 1;").size, 0, "a forward migration without the header is excluded");

// The pathspec covers the two draft folders plus explicitly marked forward migrations.
eq(draftPathspec(), ["scripts/.staging-migrations", "docs/audits", "supabase/migrations"], "git includes only draft folders plus explicitly marked forward migrations");

// Merge-base failure uses the exact origin/main tree before fallback header reads.
// This is an injected runtime fixture shared by both /fleet and SessionStart.
const INHERITED_HISTORY = "supabase/migrations/20260510999999_old_historical_marker.sql";
const ORDINARY_FORWARD = "supabase/migrations/20260730101010_ordinary_feature.sql";
const LOCAL_ORDINARY_FORWARD = "supabase/migrations/20260730101011_local_ordinary_feature.sql";
let originTreeCalls = 0;
const inherited = originMainDraftPathSet((args) => {
  originTreeCalls++;
  ok(args[0] === "ls-tree" && args.includes("origin/main"), "fallback asks git for the exact origin/main tree");
  return [INHERITED_HISTORY, ORDINARY_FORWARD];
});
eq(originTreeCalls, 1, "origin/main fallback tree is read once");
const identicalFallback = fallbackPathsAgainstOrigin([INHERITED_HISTORY, PARKED_FORWARD, ORDINARY_FORWARD], inherited, []);
eq(identicalFallback.state, "known", "exact origin/main comparison succeeds");
eq(identicalFallback.paths, [PARKED_FORWARD], "degraded fallback excludes only byte-identical inherited paths before header matching");
const modifiedInheritedFallback = fallbackPathsAgainstOrigin([INHERITED_HISTORY, PARKED_FORWARD], inherited, [INHERITED_HISTORY]);
eq(modifiedInheritedFallback.paths, [INHERITED_HISTORY, PARKED_FORWARD], "locally modified inherited draft remains visible to both consumers");
const unreadableFallback = fallbackPathsAgainstOrigin([INHERITED_HISTORY, PARKED_FORWARD], inherited, null);
eq(unreadableFallback.state, "unknown", "unreadable origin/main comparison is PARKED STATE UNKNOWN, not a confident zero");
eq(unreadableFallback.paths, [INHERITED_HISTORY, PARKED_FORWARD], "unreadable comparison retains paths conservatively instead of undercounting");
eq(fallbackPathsAgainstOrigin([INHERITED_HISTORY, PARKED_FORWARD], null, []).state, "unknown", "missing origin/main keeps the fallback state unknown");
const fallbackHeaders = new Map([
  [INHERITED_HISTORY, PARKED_FORWARD_HEADER],
  [PARKED_FORWARD, PARKED_FORWARD_HEADER],
  [LOCAL_ORDINARY_FORWARD, "-- ordinary feature migration\nSELECT 1;"],
]);
const modifiedInheritedParked = fallbackPathsAgainstOrigin(
  [INHERITED_HISTORY], inherited, [INHERITED_HISTORY],
).paths.filter((p) => isParkedFallbackFile(p, p.slice(p.lastIndexOf("/") + 1), () => fallbackHeaders.get(p)));
eq(modifiedInheritedParked, [INHERITED_HISTORY], "a locally modified inherited parked draft remains discoverable after header matching");
const degradedFallback = fallbackPathsAgainstOrigin(
  [INHERITED_HISTORY, PARKED_FORWARD, LOCAL_ORDINARY_FORWARD], inherited, [PARKED_FORWARD, LOCAL_ORDINARY_FORWARD],
).paths.filter((p) => isParkedFallbackFile(p, p.slice(p.lastIndexOf("/") + 1), () => fallbackHeaders.get(p)));
eq(degradedFallback, [PARKED_FORWARD], "degraded fallback finds only the branch-owned explicitly parked candidate");
eq(parkedMainlinePathsFrom([DISPATCH, "docs/audits/PARKED-direct.sql", PARKED_FORWARD]), [DISPATCH, "docs/audits/PARKED-direct.sql"], "mainline classification is name-only and never re-lists forward migrations");

// ── origin/main forward migrations: history + explicit header, or fail loud ──
//
// Runtime reads history once, then opens exact LOCAL CANDIDATE blobs plus only the
// complete origin/main PARKED-content prefilter. This catches orphaned explicit headers
// without reading ordinary forward migrations, while an applied header still self-clears.
const CANDIDATE_NO_HEADER = "supabase/migrations/20260730235959_candidate_without_header.sql";
const APPLIED_HEADER = "supabase/migrations/20260729010101_applied_old_header.sql";
const COLLIDING_TIMESTAMP_HEADER = "supabase/migrations/20260729010101_other_same_timestamp.sql";
const SUPERSEDED_FORWARD = "supabase/migrations/SUPERSEDED-20260730235958_replaced.sql";
const MAINLINE_ORDINARY_FORWARD = "supabase/migrations/20260730235960_ordinary_feature.sql";
const ORPHAN_HEADER = "supabase/migrations/20260730235961_orphaned_parked_header.sql";
const ORPHAN_NOT_APPLIED = "supabase/migrations/20260730235962_orphaned_not_applied.sql";
const ORPHAN_DO_NOT_APPLY = "supabase/migrations/20260730235963_orphaned_do_not_apply.sql";
const ORPHAN_SPACED_NOT_APPLIED = "supabase/migrations/20260730235964_orphaned_spaced_not_applied.sql";
const ORPHAN_TABBED_DO_NOT_APPLY = "supabase/migrations/20260730235965_orphaned_tabbed_do_not_apply.sql";
const ORPHAN_STATUS_TABBED_NOT_APPLIED = "supabase/migrations/20260730235966_orphaned_status_tabbed_not_applied.sql";
const ORPHAN_INDENTED_TABBED_NOT_APPLIED = "supabase/migrations/20260730235967_orphaned_indented_tabbed_not_applied.sql";
const STALE_HEADERS = Array.from({ length: 76 }, (_unused, i) => `supabase/migrations/2025${String(i).padStart(10, "0")}_historical_${i}.sql`);
const STALE_APPLIED_HISTORY = STALE_HEADERS.map((p, i) => {
  const filename = p.slice(p.lastIndexOf("/") + 1);
  return `| ${700 + i} | ${filename.slice(0, 14)} | **APPLIED LIVE.** File: \`${filename}\`. |`;
});
const mainlineHistory = [
  "| # | Migration timestamp | Purpose |",
  "|---:|---|---|",
  "| 842 | 20260729231031 | **LOCAL CANDIDATE — NOT APPLIED.** File: `20260729231031_vendor_bill_period_close_lock.sql`. |",
  "| 843 | 20260730235959 | **LOCAL CANDIDATE — NOT APPLIED.** File: `20260730235959_candidate_without_header.sql`. |",
  "| 841 | 20260729010101 | **APPLIED LIVE.** File: `20260729010101_applied_old_header.sql`. |",
  ...STALE_APPLIED_HISTORY,
].join("\n");
const mainlineTexts = new Map([
  [PARKED_FORWARD, PARKED_FORWARD_HEADER],
  [CANDIDATE_NO_HEADER, "-- purpose only\nSELECT 1;\n"],
  [APPLIED_HEADER, PARKED_FORWARD_HEADER],
  [SUPERSEDED_FORWARD, PARKED_FORWARD_HEADER],
  [MAINLINE_ORDINARY_FORWARD, "-- ordinary feature migration\nSELECT 1;\n"],
  [ORPHAN_HEADER, PARKED_FORWARD_HEADER],
  [ORPHAN_NOT_APPLIED, NOT_APPLIED_HEADER],
  [ORPHAN_DO_NOT_APPLY, DO_NOT_APPLY_HEADER],
  [ORPHAN_SPACED_NOT_APPLIED, NOT_SPACED_APPLIED_HEADER],
  [ORPHAN_TABBED_DO_NOT_APPLY, DO_TABBED_NOT_APPLY_HEADER],
  [ORPHAN_STATUS_TABBED_NOT_APPLIED, STATUS_TABBED_NOT_APPLIED_HEADER],
  [ORPHAN_INDENTED_TABBED_NOT_APPLIED, INDENTED_TABBED_NOT_APPLIED_HEADER],
  ...STALE_HEADERS.map((p) => [p, PARKED_FORWARD_HEADER]),
]);
const mainlinePaths = [DISPATCH, "docs/audits/PARKED-mainline.sql", PARKED_FORWARD, CANDIDATE_NO_HEADER, APPLIED_HEADER, SUPERSEDED_FORWARD, MAINLINE_ORDINARY_FORWARD, ...STALE_HEADERS];
const possibleParkedMigrationPaths = [PARKED_FORWARD, APPLIED_HEADER, ...STALE_HEADERS];
const candidateReads = [];
const mergedWithBrokenCandidate = parkedMainlineDiscoveryFrom(mainlinePaths, mainlineHistory, (p) => {
  candidateReads.push(p);
  return mainlineTexts.get(p);
});
eq(mergedWithBrokenCandidate.state, "unknown", "history candidate without explicit header is PARKED STATE UNKNOWN");
eq(candidateReads, [PARKED_FORWARD, CANDIDATE_NO_HEADER], "runtime reads only history-candidate SQL blobs, never 76 stale headers");
const localCandidatePaths = localCandidateMigrationPathsFromHistory(mainlineHistory).paths;
const exactCandidateBatchPaths = originMainForwardBlobPaths(mainlinePaths, possibleParkedMigrationPaths, localCandidatePaths);
ok(exactCandidateBatchPaths.includes(CANDIDATE_NO_HEADER), "origin/main batch content read includes a LOCAL CANDIDATE even when the parked-header prefilter misses it");
const exactCandidateBatch = new Map(exactCandidateBatchPaths.map((p) => [normRepoPath(p), mainlineTexts.get(p)]));
const exactCandidateFailure = parkedMainlineDiscoveryFrom(
  mainlinePaths,
  mainlineHistory,
  (p) => exactCandidateBatch.get(normRepoPath(p)) ?? null,
  possibleParkedMigrationPaths,
);
eq(exactCandidateFailure.reason, "LOCAL CANDIDATE SQL lacks an explicit parked status header", "a batched readable candidate without its header reports the explicit status failure, not an unreadable blob");

const mergedHistory = mainlineHistory.replace("**LOCAL CANDIDATE — NOT APPLIED.** File: `20260730235959_candidate_without_header.sql`.", "**APPLIED LIVE.** File: `20260730235959_candidate_without_header.sql`.");
const mergedReads = [];
const mergedCandidate = parkedMainlineDiscoveryFrom(mainlinePaths, mergedHistory, (p) => {
  mergedReads.push(p);
  return mainlineTexts.get(p);
}, possibleParkedMigrationPaths);
eq(mergedCandidate.state, "known", "merged candidate has a coherent origin/main cross-reference");
eq([...mergedCandidate.paths].sort(), [DISPATCH, "docs/audits/PARKED-mainline.sql", PARKED_FORWARD].sort(), "76 applied-like headers plus one merged candidate report exactly one forward migration");
eq(mergedReads, [PARKED_FORWARD, APPLIED_HEADER, ...STALE_HEADERS], "coherent mainline state reads candidates and the complete PARKED prefilter, not ordinary forward SQL");
ok(!mergedReads.includes(MAINLINE_ORDINARY_FORWARD), "PARKED prefilter preserves runtime performance by skipping ordinary forward migrations");

const b7Applied = parkedMainlineDiscoveryFrom([PARKED_FORWARD], mergedHistory.replace("**LOCAL CANDIDATE — NOT APPLIED.** File: `20260729231031_vendor_bill_period_close_lock.sql`.", "**APPLIED LIVE.** File: `20260729231031_vendor_bill_period_close_lock.sql`."), () => PARKED_FORWARD_HEADER);
eq(b7Applied.state, "known", "B7 applied history is a known state");
eq([...b7Applied.paths], [], "B7 applied history self-clears even if an old header survives");

const collidingTimestampHistory = "| 841 | 20260729010101 | **APPLIED LIVE.** File: `20260729010101_applied_old_header.sql`. |";
const collidingTimestampDiscovery = parkedMainlineDiscoveryFrom(
  [COLLIDING_TIMESTAMP_HEADER],
  collidingTimestampHistory,
  () => PARKED_FORWARD_HEADER,
  [COLLIDING_TIMESTAMP_HEADER],
);
eq(collidingTimestampDiscovery.state, "unknown", "an applied row for a colliding timestamp cannot resolve a different migration basename");

const mismatchedFilenameHistory = "| 841 | 20260729010101 | **APPLIED LIVE.** File: `20260729010102_mismatched_timestamp.sql`. |";
const mismatchedFilenameDiscovery = parkedMainlineDiscoveryFrom(
  [APPLIED_HEADER],
  mismatchedFilenameHistory,
  () => PARKED_FORWARD_HEADER,
  [APPLIED_HEADER],
);
eq(mismatchedFilenameDiscovery.state, "unknown", "a resolved row cannot index a filename whose timestamp differs from its row");

const ambiguousBasenameHistory = "| 841 | 20260729010101 | **APPLIED LIVE.** Files: `20260729010101_applied_old_header.sql`, `20260729010101_other_same_timestamp.sql`. |";
const ambiguousBasenameDiscovery = parkedMainlineDiscoveryFrom(
  [APPLIED_HEADER],
  ambiguousBasenameHistory,
  () => PARKED_FORWARD_HEADER,
  [APPLIED_HEADER],
);
eq(ambiguousBasenameDiscovery.state, "unknown", "a resolved row with two same-timestamp basenames resolves neither file");

const orphanHeaderDiscovery = parkedMainlineDiscoveryFrom(
  [DISPATCH, "docs/audits/PARKED-mainline.sql", PARKED_FORWARD, ORPHAN_HEADER],
  mergedHistory,
  (p) => mainlineTexts.get(p),
  [PARKED_FORWARD, ORPHAN_HEADER],
);
eq(orphanHeaderDiscovery.state, "unknown", "an explicit forward parked header with no history row is PARKED STATE UNKNOWN, never a known zero");
eq([...orphanHeaderDiscovery.paths].sort(), [DISPATCH, "docs/audits/PARKED-mainline.sql", PARKED_FORWARD].sort(), "orphaned header failure retains independently discoverable drafts and valid candidates");
const ambiguousHeaderHistory = `${mergedHistory}\n| 844 | 20260730235961 | Ordinary migration note. File: \`20260730235961_orphaned_parked_header.sql\`. |`;
const ambiguousHeaderDiscovery = parkedMainlineDiscoveryFrom(
  [PARKED_FORWARD, ORPHAN_HEADER],
  ambiguousHeaderHistory,
  (p) => mainlineTexts.get(p),
  [PARKED_FORWARD, ORPHAN_HEADER],
);
eq(ambiguousHeaderDiscovery.state, "unknown", "a non-candidate, non-applied history row cannot silently clear an explicit parked header");

for (const [path, header, label] of [
  [ORPHAN_NOT_APPLIED, NOT_APPLIED_HEADER, "standalone NOT APPLIED"],
  [ORPHAN_DO_NOT_APPLY, DO_NOT_APPLY_HEADER, "standalone DO NOT APPLY"],
  [ORPHAN_SPACED_NOT_APPLIED, NOT_SPACED_APPLIED_HEADER, "repeated-space NOT APPLIED"],
  [ORPHAN_TABBED_DO_NOT_APPLY, DO_TABBED_NOT_APPLY_HEADER, "tabbed DO NOT APPLY"],
  [ORPHAN_STATUS_TABBED_NOT_APPLIED, STATUS_TABBED_NOT_APPLIED_HEADER, "STATUS-prefixed tabbed NOT APPLIED"],
  [ORPHAN_INDENTED_TABBED_NOT_APPLIED, INDENTED_TABBED_NOT_APPLIED_HEADER, "indented tabbed NOT APPLIED"],
]) {
  const standaloneOrphan = parkedMainlineDiscoveryFrom(
    [PARKED_FORWARD, path],
    mergedHistory,
    (p) => p === path ? header : mainlineTexts.get(p),
    [PARKED_FORWARD, path],
  );
  eq(standaloneOrphan.state, "unknown", `${label} orphan is PARKED STATE UNKNOWN, never a known zero`);
}

eq(
  ORIGIN_MAIN_PARKED_MIGRATION_GREP_ARGS,
  ["grep", "-l", "-i", "-E", "-e", "^(\uFEFF)?[[:blank:]]*--[[:blank:]]*(STATUS:[[:blank:]]*)?(PARKED|NOT[[:blank:]]+APPLIED|DO[[:blank:]]+NOT[[:blank:]]+APPLY)", "origin/main", "--", "supabase/migrations"],
  "shared origin/main prefilter anchors to portable SQL comment status lines",
);
const grepFixtureDir = mkdtempSync(path.join(tmpdir(), "crx-parked-prefilter-"));
try {
  const grepFixtures = [
    ["bom.sql", BOM_PARKED_FORWARD_HEADER],
    ["spaced.sql", NOT_SPACED_APPLIED_HEADER],
    ["tabbed.sql", DO_TABBED_NOT_APPLY_HEADER],
    ["status-tabbed.sql", STATUS_TABBED_NOT_APPLIED_HEADER],
    ["indented.sql", INDENTED_TABBED_NOT_APPLIED_HEADER],
    ["nbsp-between.sql", NBSP_NOT_APPLIED_HEADER],
    ["nbsp-after-comment.sql", NBSP_AFTER_COMMENT_HEADER],
    ["prose.sql", FALSE_PROSE_HEADER],
    ["later.sql", LATER_STATUS_HEADER],
    ["ordinary.sql", "-- ordinary feature migration\nSELECT 1;\n"],
  ];
  for (const [name, text] of grepFixtures) writeFileSync(path.join(grepFixtureDir, name), text, "utf8");
  const isolatedGitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const isolatedGitOptions = { cwd: grepFixtureDir, env: isolatedGitEnv };
  execFileSync("git", ["init", "-q"], isolatedGitOptions);
  execFileSync("git", ["add", "--", "."], isolatedGitOptions);
  const prefilterOptions = ORIGIN_MAIN_PARKED_MIGRATION_GREP_ARGS.slice(1, -3);
  const matches = execFileSync("git", ["grep", ...prefilterOptions, "--", "."], { ...isolatedGitOptions, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((p) => path.basename(p));
  eq(matches.sort(), ["bom.sql", "indented.sql", "later.sql", "spaced.sql", "status-tabbed.sql", "tabbed.sql"], "anchored Git prefilter finds portable comment status lines and a leading UTF-8 BOM, including the safe later-header superset only");
} finally {
  rmSync(grepFixtureDir, { recursive: true, force: true });
}
const zeroMatchPrefilter = originMainParkedMigrationPrefilter(() => {
  const error = new Error("no matches");
  error.status = 1;
  throw error;
});
eq(zeroMatchPrefilter.state, "known", "git grep exit 1 is a healthy known empty prefilter");
eq(zeroMatchPrefilter.paths, [], "git grep exit 1 supplies a complete empty set, not a degraded scan");
const zeroMatchReads = [];
const zeroMatchDiscovery = parkedMainlineDiscoveryFrom(
  [MAINLINE_ORDINARY_FORWARD],
  "| # | Migration timestamp | Purpose |\n|---:|---|---|",
  (p) => { zeroMatchReads.push(p); return mainlineTexts.get(p); },
  zeroMatchPrefilter.paths,
);
eq(zeroMatchDiscovery.state, "known", "healthy zero-match prefilter preserves a known empty mainline state");
eq(zeroMatchReads, [], "healthy zero-match prefilter opens no ordinary forward migration");
const failedPrefilter = originMainParkedMigrationPrefilter(() => {
  const error = new Error("git timeout");
  error.status = 124;
  throw error;
});
eq(failedPrefilter.paths, null, "real git failure leaves the conservative full-forward fallback enabled");

// A real prefilter failure must scan every forward SQL blob without depending on
// spawnSync's tiny default output buffer. The production reader uses this same
// injected batch framing helper with a 32 MiB finite ceiling.
function catFileBatchRecord(repoPath, text) {
  const body = Buffer.from(text, "utf8");
  return Buffer.concat([
    Buffer.from(`${"a".repeat(40)} blob ${body.length} ${repoPath}\n`, "utf8"),
    body,
    Buffer.from("\n", "utf8"),
  ]);
}
function catFileBatch(paths, textForPath) {
  return Buffer.concat(paths.map((p) => catFileBatchRecord(p, textForPath(p))));
}
const fullFallbackPaths = Array.from({ length: 840 }, (_unused, i) =>
  `supabase/migrations/20260730${String(i).padStart(6, "0")}_full_fallback_${i}.sql`,
);
eq(originMainForwardBlobPaths(fullFallbackPaths, null).length, 840, "failed prefilter selects every forward SQL path for the conservative full scan");
const fullFallbackText = (p) => `-- ordinary migration ${p}\n${"x".repeat(13000)}\n`;
const fullFallbackBatch = catFileBatch(fullFallbackPaths, fullFallbackText);
ok(fullFallbackBatch.length > 10 * 1024 * 1024, "forced full fallback fixture exceeds the observed 10 MiB-scale full-scan payload");
let receivedBatchInput = "";
const fullFallbackBlobs = originMainSqlBlobMap(fullFallbackPaths, (input, expectedPaths) => {
  receivedBatchInput = input.toString("utf8");
  eq(expectedPaths.length, 840, "batch reader receives every forced-fallback path");
  return fullFallbackBatch;
});
eq(fullFallbackBlobs.size, 840, "bounded batch reader retains every forced-fallback blob");
ok(receivedBatchInput.includes(`origin/main:${fullFallbackPaths[0]}\t${fullFallbackPaths[0]}`), "batch input binds each object request to its echoed path token");
let fullFallbackReads = 0;
const fullFallbackDiscovery = parkedMainlineDiscoveryFrom(
  fullFallbackPaths,
  "| # | Migration timestamp | Purpose |\n|---:|---|---|",
  (p) => { fullFallbackReads++; return fullFallbackBlobs.get(normRepoPath(p)); },
  null,
);
eq(fullFallbackDiscovery.state, "known", "complete forced fallback with ordinary SQL remains a known empty parked state");
eq(fullFallbackReads, 840, "complete forced fallback scans every returned forward blob");
eq(originMainSqlBlobMap(fullFallbackPaths, () => fullFallbackBatch, fullFallbackBatch.length - 1), null, "over-limit batch output fails conservatively");
eq(originMainSqlBlobMap([fullFallbackPaths[0]], () => catFileBatch([fullFallbackPaths[1]], fullFallbackText)), null, "echoed path/order mismatch fails conservatively");
eq(originMainSqlBlobMap([fullFallbackPaths[0]], () => catFileBatch([fullFallbackPaths[0]], fullFallbackText).subarray(0, -1)), null, "truncated batch delimiter fails conservatively");
eq(originMainSqlBlobMap([fullFallbackPaths[0]], () => Buffer.concat([catFileBatch([fullFallbackPaths[0]], fullFallbackText), Buffer.from("trailer")])), null, "trailing unframed batch bytes fail conservatively");
eq(ORIGIN_MAIN_CAT_FILE_MAX_BUFFER, 32 * 1024 * 1024, "production batch ceiling is a deliberate 32 MiB");

const headerWithoutRow = validateParkedMigrationCrossReferences([PARKED_FORWARD], "| # | Migration timestamp | Purpose |\n|---:|---|---|", () => PARKED_FORWARD_HEADER);
eq(headerWithoutRow.state, "unknown", "correction guard fails loud for a parked header without a candidate history row");
const collidingTimestampCrossReference = validateParkedMigrationCrossReferences(
  [COLLIDING_TIMESTAMP_HEADER],
  collidingTimestampHistory,
  () => PARKED_FORWARD_HEADER,
);
eq(collidingTimestampCrossReference.state, "unknown", "correction guard also requires an exact applied migration basename");
const oneCandidateHistory = [
  "| # | Migration timestamp | Purpose |",
  "|---:|---|---|",
  "| 842 | 20260729231031 | **LOCAL CANDIDATE — NOT APPLIED.** File: `20260729231031_vendor_bill_period_close_lock.sql`. |",
].join("\n");
const candidateWithoutHeader = validateParkedMigrationCrossReferences([PARKED_FORWARD], oneCandidateHistory, () => "-- ordinary migration\nSELECT 1;");
eq(candidateWithoutHeader.state, "unknown", "correction guard fails loud for a candidate history row without its status header");
const duplicateHistory = localCandidateMigrationPathsFromHistory(`${mergedHistory}\n| 999 | 20260729231031 | **LOCAL CANDIDATE — NOT APPLIED.** File: \`20260729231031_vendor_bill_period_close_lock.sql\`. |`);
eq(duplicateHistory.state, "unknown", "duplicate candidate history rows are not silently deduped");
eq(localCandidateMigrationPathsFromHistory(null).state, "unknown", "unreadable history is PARKED STATE UNKNOWN");
const unreadableBlob = parkedMainlineDiscoveryFrom([PARKED_FORWARD], mergedHistory, () => null);
eq(unreadableBlob.state, "unknown", "unreadable candidate SQL blob is PARKED STATE UNKNOWN");
const proseTimestamp = localCandidateMigrationPathsFromHistory("| 842 | 20260729231031 | **LOCAL CANDIDATE — NOT APPLIED.** Apply 20260729231031_vendor_bill_period_close_lock.sql after review. |");
eq(proseTimestamp.state, "unknown", "prose filename/timestamp is not accepted as the exact Markdown migration reference");
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const migrationDir = path.join(repoRoot, "supabase", "migrations");
const repoMigrationPaths = readdirSync(migrationDir).filter((name) => name.endsWith(".sql")).map((name) => `supabase/migrations/${name}`);
const currentCrossReference = validateParkedMigrationCrossReferences(
  repoMigrationPaths,
  readFileSync(path.join(repoRoot, "docs", "reference", "migration-history.md"), "utf8"),
  (p) => readFileSync(path.join(repoRoot, ...p.split("/")), "utf8"),
);
eq(currentCrossReference.state, "known", "repository correction guard proves every current parked header is either this exact candidate or an exact applied/retired history row");
const periodCloseMatches = repoMigrationPaths.filter((p) => p.endsWith("_vendor_bill_period_close_lock.sql"));
eq(periodCloseMatches.length, 1, "period-close migration has one stable-suffix match");
const periodCloseCandidate = readFileSync(path.join(repoRoot, ...periodCloseMatches[0].split("/")), "utf8");
ok(/check_period_open[\s\S]*?SET search_path = ''[\s\S]*?FROM public\.accounting_periods/.test(periodCloseCandidate), "period-close candidate deliberately hardens check_period_open to an empty search path while retaining schema-qualified body references");

// Path normalization the count key depends on.
eq(normRepoPath("Docs\\Audits\\A.SQL"), "docs/audits/a.sql", "backslashes, case and separators normalize");
eq(normRepoPath("./docs/audits/a.sql"), "docs/audits/a.sql", "leading './' is stripped");
eq(normRepoPath("/docs/audits/a.sql"), "docs/audits/a.sql", "leading slashes are stripped");
eq(normRepoPath(null), "", "a missing path normalizes to empty, not a crash");

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

// ── createOwnDraftPathsReader: the decision tree both readers now share ──
//
// This factory IS the parked count. Everything above tests how a path is classified;
// these test which paths git is even asked for — the clean/dirty split, the caching that
// keeps the hook fast, and the four ways it must answer "I don't know" (null) so the
// caller falls back to a full scan instead of silently reporting nothing.
// Fully injected: no real git, no filesystem (Codex low on #279).

const DRAFT_A = "scripts/.staging-migrations/PARKED-a.sql";
const DRAFT_B = "docs/audits/hunt/PARKED-b.sql";
const SUPERSEDED_A = "scripts/.staging-migrations/SUPERSEDED-a.sql";

// Builds a reader over a fake git. `responses` maps a git subcommand to its output lines;
// a value of null means that git call failed. Records every call for assertions.
function fakeReader(responses, opts = {}) {
  const calls = [];
  const reader = createOwnDraftPathsReader({
    repoRoot: "C:/main",
    hasOriginMain: opts.hasOriginMain !== false,
    dirtyCount: opts.dirtyCount || (() => 0),
    exists: opts.exists || (() => true),
    readText: opts.readText || (() => ""),
    run: (args, cwd) => {
      calls.push({ cmd: args[0], args, cwd });
      const hit = responses[args[0]];
      return hit === undefined ? [] : hit;
    },
  });
  return { reader, calls };
}

const CLEAN_ENTRY = { path: "C:/wt-clean", head: "a".repeat(40) };
const DIRTY_ENTRY = { path: "C:/wt-dirty", head: "b".repeat(40) };

// A clean checkout: its pending set is base..HEAD, and that diff must run in the MAIN
// repo — spawning git inside 42 checkouts is what made the hook 10s instead of 3s.
{
  const { reader, calls } = fakeReader({ "merge-base": ["base1"], diff: [DRAFT_A] });
  const got = reader(CLEAN_ENTRY);
  eq([...got.values()], [DRAFT_A], "clean checkout reports the draft its branch added");
  const diffCall = calls.find((c) => c.cmd === "diff");
  eq(diffCall.cwd, "C:/main", "a clean checkout's diff is computed in the main repo, not in it");
  ok(diffCall.args.includes(CLEAN_ENTRY.head), "clean diff is base..HEAD, not base..worktree");
  ok(!calls.some((c) => c.cmd === "ls-files"), "clean checkout skips the untracked scan");
}

// A clean branch-owned forward migration is counted only with the explicit header;
// this is the shared guard used by both /fleet and SessionStart.
{
  const { reader } = fakeReader(
    { "merge-base": ["base1"], diff: [PARKED_FORWARD] },
    { readText: () => PARKED_FORWARD_HEADER },
  );
  eq([...reader(CLEAN_ENTRY).values()], [PARKED_FORWARD], "clean branch surfaces explicitly parked forward migration");
}

// A dirty checkout must be asked in place, and its untracked files count too — that is
// how a draft someone is writing right now shows up before it is ever committed.
{
  const { reader, calls } = fakeReader(
    { "merge-base": ["base1"], diff: [DRAFT_A], "ls-files": [DRAFT_B] },
    { dirtyCount: () => 3 }
  );
  const got = reader(DIRTY_ENTRY);
  eq([...got.values()].sort(), [DRAFT_B, DRAFT_A].sort(), "dirty checkout reports committed + untracked drafts");
  eq(calls.find((c) => c.cmd === "diff").cwd, DIRTY_ENTRY.path, "a dirty checkout is diffed in place");
  eq(calls.find((c) => c.cmd === "ls-files").cwd, DIRTY_ENTRY.path, "untracked scan runs in the checkout");
}

// Every "I don't know" path returns null. null makes the caller scan the whole checkout;
// returning an empty Map instead would hide real pending work — the defect this fixes.
{
  const noBase = fakeReader({ "merge-base": [""] });
  eq(noBase.reader(CLEAN_ENTRY), null, "unreadable branch point → null (caller falls back)");

  const gitDown = fakeReader({ "merge-base": null });
  eq(gitDown.reader(CLEAN_ENTRY), null, "merge-base failure → null");

  const noMain = fakeReader({ "merge-base": ["base1"] }, { hasOriginMain: false });
  eq(noMain.reader(CLEAN_ENTRY), null, "no origin/main → null, never a confident zero");
  eq(noMain.calls.length, 0, "without origin/main it does not even shell out");

  const diffFailed = fakeReader({ "merge-base": ["base1"], diff: null });
  eq(diffFailed.reader(CLEAN_ENTRY), null, "clean-path diff failure → null");

  const lsFailed = fakeReader(
    { "merge-base": ["base1"], diff: [DRAFT_A], "ls-files": null },
    { dirtyCount: () => 2 }
  );
  eq(lsFailed.reader(DIRTY_ENTRY), null, "dirty-path untracked-scan failure → null");

  const headless = fakeReader({ "merge-base": ["base1"] });
  eq(headless.reader({ path: "C:/wt", head: "" }), null, "worktree with no HEAD sha → null");
}

// A retired draft (the SUPERSEDED- rename) shows in the diff under its OLD path. Counting
// that would re-report the very file the rename retired, so gone-from-disk means gone.
{
  const { reader } = fakeReader(
    { "merge-base": ["base1"], diff: [DRAFT_A, DRAFT_B] },
    { exists: (_wtPath, rel) => rel !== DRAFT_A }
  );
  eq([...reader(CLEAN_ENTRY).values()], [DRAFT_B], "a draft no longer on disk is not pending work");
}

// Healthy branch-owned scans must preserve the ignored SUPERSEDED count; this
// is not only a degraded full-disk fallback diagnostic.
{
  const { reader } = fakeReader({ "merge-base": ["base1"], diff: [DRAFT_A, SUPERSEDED_A] });
  const healthy = reader(CLEAN_ENTRY);
  eq([...healthy.values()], [DRAFT_A], "healthy branch-owned scan retains only the pending draft");
  eq([...healthy.supersededPaths.values()], [SUPERSEDED_A], "healthy branch-owned scan reports its ignored SUPERSEDED draft once");
}

// The caches are the reason the hook stayed fast across ~42 checkouts sharing a few shas.
{
  const { reader, calls } = fakeReader({ "merge-base": ["base1"], diff: [DRAFT_A] });
  reader(CLEAN_ENTRY);
  reader({ ...CLEAN_ENTRY, path: "C:/wt-other-same-sha" });
  eq(calls.filter((c) => c.cmd === "merge-base").length, 1, "branch point is resolved once per sha");
  eq(calls.filter((c) => c.cmd === "diff").length, 1, "clean diff is computed once per sha");
}

console.log(`worktree-awareness-lib: ${pass} assertions passed`);
