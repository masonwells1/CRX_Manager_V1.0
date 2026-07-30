#!/usr/bin/env node
// Tests for the worktree-awareness porcelain parser.
// Run: node .claude/hooks/worktree-awareness-lib.test.mjs

import assert from "node:assert/strict";
import {
  parseWorktreePorcelain, siblingsOf, normPath,
  mergedLabelFromStatus, isLedgerDoc, isParkedMigrationFile, isDraftSqlName,
  lastNonEmptyLine, firstCommentLine, fleetSummaryLine,
  isParkedDraftPath, parkedDraftPathsFrom, draftPathspec, normRepoPath,
  hasExplicitParkedMigrationHeader, isParkedFallbackFile, originMainDraftPathSet,
  excludeInheritedFallbackPaths, parkedMainlinePathsFrom,
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
ok(isParkedDraftPath(DISPATCH), "a staged .sql draft is a parked draft");
ok(isParkedDraftPath("docs/audits/new-hunt/PARKED-brand-new.sql"), "an audits PARKED-*.sql is a parked draft");
ok(isParkedDraftPath("docs/audits/2026-07-01-per-acre-draft.sql"), "an audits *draft*.sql is a parked draft");
ok(!isParkedDraftPath("docs/audits/2026-07-01-review-final.sql"), "an audits .sql that is not a draft does not count");
ok(!isParkedDraftPath("scripts/.staging-migrations/SUPERSEDED-old.sql"), "a SUPERSEDED draft is retired, not pending");
ok(hasExplicitParkedMigrationHeader(PARKED_FORWARD_HEADER), "explicit parked header is recognized");
ok(!hasExplicitParkedMigrationHeader("-- normal feature migration\nCREATE TABLE public.example();"), "ordinary leading comments do not park a migration");
ok(!hasExplicitParkedMigrationHeader("-- This was previously parked for review\nSELECT 1;"), "historical parked prose is not a current status line");
ok(!hasExplicitParkedMigrationHeader("-- PARKED migration notes appear later\nSELECT 1;"), "bare parked prose is not a current status line");
ok(isParkedDraftPath(PARKED_FORWARD, PARKED_FORWARD_HEADER), "explicitly parked forward migration is surfaced");
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

// The pathspec both readers hand to git — it must cover exactly the two draft folders.
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
eq(excludeInheritedFallbackPaths([INHERITED_HISTORY, PARKED_FORWARD, ORDINARY_FORWARD], inherited), [PARKED_FORWARD], "degraded fallback excludes inherited history and ordinary main paths before header matching");
eq(excludeInheritedFallbackPaths([INHERITED_HISTORY, PARKED_FORWARD], null), [INHERITED_HISTORY, PARKED_FORWARD], "without origin/main the conservative all-disk fallback is retained");
const fallbackHeaders = new Map([
  [INHERITED_HISTORY, PARKED_FORWARD_HEADER],
  [PARKED_FORWARD, PARKED_FORWARD_HEADER],
  [LOCAL_ORDINARY_FORWARD, "-- ordinary feature migration\nSELECT 1;"],
]);
const degradedFallback = excludeInheritedFallbackPaths(
  [INHERITED_HISTORY, PARKED_FORWARD, LOCAL_ORDINARY_FORWARD], inherited,
).filter((p) => isParkedFallbackFile(p, p.slice(p.lastIndexOf("/") + 1), () => fallbackHeaders.get(p)));
eq(degradedFallback, [PARKED_FORWARD], "degraded fallback finds only the branch-owned explicitly parked candidate");
eq(parkedMainlinePathsFrom([DISPATCH, "docs/audits/PARKED-direct.sql", PARKED_FORWARD]), [DISPATCH, "docs/audits/PARKED-direct.sql"], "mainline classification is name-only and never re-lists forward migrations");

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

// The caches are the reason the hook stayed fast across ~42 checkouts sharing a few shas.
{
  const { reader, calls } = fakeReader({ "merge-base": ["base1"], diff: [DRAFT_A] });
  reader(CLEAN_ENTRY);
  reader({ ...CLEAN_ENTRY, path: "C:/wt-other-same-sha" });
  eq(calls.filter((c) => c.cmd === "merge-base").length, 1, "branch point is resolved once per sha");
  eq(calls.filter((c) => c.cmd === "diff").length, 1, "clean diff is computed once per sha");
}

console.log(`worktree-awareness-lib: ${pass} assertions passed`);
