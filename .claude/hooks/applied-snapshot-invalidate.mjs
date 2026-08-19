#!/usr/bin/env node
// PostToolUse: invalidate the applied-migration snapshot after every apply.
//
// WHY (Codex P1, PR #348)
//   migration-apply-guard.mjs accepts an applied-migration snapshot as ordering
//   evidence if it is under 24 hours old. Elapsed time cannot establish that no
//   migration ran in the meantime, and inside that window the failure is exactly
//   the one the guard exists to prevent:
//
//     1. snapshot captured                      (high-water = 20260807...)
//     2. 20260808150400 applied                 (snapshot now silently behind)
//     3. 20260808150100 attempted, same session
//        -> snapshot still omits 150400, still "fresh" by the clock
//        -> the older migration is permitted, though the real ledger rejects it
//
//   So the clock is not the invalidator — an apply is. After any apply_migration
//   call the snapshot is stale by definition, and this hook removes it. The next
//   apply then blocks on missing evidence and demands a fresh capture, which is
//   the correct fail-closed behaviour.
//
// This deliberately runs on EVERY apply_migration call, not only successful
// ones: the PostToolUse payload does not reliably distinguish a partial apply,
// and wrongly keeping a snapshot is far more dangerous than wrongly discarding
// one. Re-capturing is a cheap read-only query.
//
// FAIL-LOUD-ISH: errors are reported in additionalContext but never throw, so
// this hook cannot break a session. It only ever DELETES a regenerable cache
// file — it never touches migrations, data, or source.

import { readFileSync, existsSync, rmSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

import { withFileLock, normalizedSqlHash } from "./ledger-lock-lib.mjs";

// Resolve a candidate directory to its git worktree root. The recorder
// (PostToolUse) and stop-wrap (Stop) must agree on WHERE the ledger lives; if a
// future harness fires the two hooks from different subdirectories of the same
// worktree, name-based precedence alone would split them — the recorder writes
// under one subdir and the checker reads under another, silently disarming the
// guard (Opus review 2026-08-19, round 3). Normalizing both to the worktree
// root makes them agree regardless of which subdir each fired from. Fail-safe:
// if the candidate is not inside a git repo (or git is unavailable), keep the
// candidate verbatim — so a non-git path is still honored exactly as given.
function gitToplevelOr(candidate) {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: candidate, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top ? top : candidate;
  } catch {
    return candidate;
  }
}

function emit(text) {
  if (!text) process.exit(0);
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text },
  }));
  process.exit(0);
}

try {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }

  const toolName = (payload?.tool_name || "").toString();
  if (!/apply_migration/i.test(toolName)) process.exit(0);

  // Prefer the hook payload's cwd (the session's checkout) over
  // CLAUDE_PROJECT_DIR: if a future harness pins the env var to the PRIMARY
  // checkout while the session runs in a worktree, the ledger would otherwise
  // land in a directory stop-wrap (same precedence) and worktree-cleanup
  // (reads per-worktree) never look at (Opus review 2026-08-19). In the
  // current harness both resolve to the same directory.
  const candidateDir = String(payload?.cwd || "").trim() || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const projectDir = gitToplevelOr(candidateDir);

  // ── Source-containment ledger (2026-08-18, mistake class C3) ──────────────
  // Record WHAT was just applied so stop-wrap.mjs can refuse to end the session
  // while a live-applied migration has no committed source file. Three times in
  // 30 days a migration ran on production with no file on main; the only
  // defence was that someone noticed. Entries are pruned by stop-wrap once a
  // matching tracked file exists. Recording is fail-open: it must never break
  // an apply, and it happens BEFORE the snapshot early-exit below so an apply
  // is recorded even when no snapshot file exists.
  const toolInput = payload?.tool_input || payload?.toolInput || {};
  const appliedName = String(toolInput?.name || "").trim();
  // A failed apply IS recorded, flagged `failed: true`. An earlier revision
  // skipped isError results entirely, but an error response cannot prove
  // nothing landed: CREATE INDEX CONCURRENTLY and other non-transactional or
  // multi-statement SQL can change live state before the call errors (Opus
  // review 2026-08-19, round 2). Retry-loop pollution is already handled by
  // the dedup below — a retried name REPLACES its row, it never stacks — and
  // a genuinely stale failed entry is cleared through the sanctioned path
  // (scripts/remove-applied-ledger-entry.mjs) after verifying the live ledger.
  const toolResponse = payload?.tool_response ?? payload?.toolResponse;
  const applyFailed = !!toolResponse && typeof toolResponse === "object" &&
    (toolResponse.isError === true || toolResponse.is_error === true);
  // Fingerprint the applied SQL so stop-wrap can demand a committed file whose
  // CONTENT matches, not merely one with a matching filename (Opus review
  // 2026-08-19, round 2: an empty or unrelated committed file with the right
  // name both satisfied AND pruned the guard).
  const appliedSql = String(toolInput?.query ?? toolInput?.sql ?? "");
  const sqlHash = appliedSql.trim() ? normalizedSqlHash(appliedSql) : "";
  if (appliedName) {
    try {
      const ledgerPath = path.join(projectDir, ".claude", "session-state", "applied-source-ledger.json");
      mkdirSync(path.dirname(ledgerPath), { recursive: true });
      // Locked read-modify-write: two overlapping recorder hooks must not lose
      // an entry (a lost entry silently disarms the guard for that migration).
      withFileLock(ledgerPath + ".lock", () => {
        let entries = [];
        try { entries = JSON.parse(readFileSync(ledgerPath, "utf8")); } catch { /* new or corrupt → start fresh */ }
        if (!Array.isArray(entries)) entries = [];
        // Dedup by (name, sqlHash), NOT by name alone. A genuine retry of the
        // SAME content refreshes its one row. But a re-apply of the same name
        // with DIFFERENT content (or hashless SQL) must NOT overwrite the
        // earlier content-bound row: dedup-by-name-only let an attacker apply
        // real SQL, then re-"apply" the same name with empty/unrelated SQL to
        // erase the hash binding stop-wrap enforces (Opus review 2026-08-19,
        // round 3 — "hash downgrade" / v1→v2 erase). Keeping both rows means
        // stop-wrap demands committed source for each distinct content.
        entries = entries.filter((e) => !(e && e.name === appliedName && String(e.sqlHash || "") === sqlHash));
        entries.push({
          name: appliedName,
          ts: new Date().toISOString(),
          session: String(payload?.session_id || ""),
          ...(sqlHash ? { sqlHash } : {}),
          ...(applyFailed ? { failed: true } : {}),
        });
        // Write-then-rename so a reader (or a crash mid-write) never sees a
        // truncated JSON file, which stop-wrap's corrupt-ledger path would
        // fail-open on — silently disarming the guard.
        const tmpPath = ledgerPath + "." + process.pid + ".tmp";
        writeFileSync(tmpPath, JSON.stringify(entries, null, 2) + "\n");
        renameSync(tmpPath, ledgerPath);
      });
    } catch { /* fail-open */ }
  }

  const snapPath = path.join(projectDir, ".claude", "session-state", "applied-migrations.json");

  if (!existsSync(snapPath)) process.exit(0);

  try {
    rmSync(snapPath, { force: true });
  } catch (err) {
    emit(
      `APPLIED-SNAPSHOT INVALIDATION FAILED: could not remove ${snapPath} (${err?.message || err}). ` +
      `That snapshot is now STALE — it does not include the migration just applied — and the ordering ` +
      `guard would accept it for up to 24 hours. Delete it by hand before the next apply.`
    );
  }

  emit(
    `Applied-migration snapshot invalidated (a migration was just applied, so the previous capture is ` +
    `now behind the live ledger). Before the next apply, re-capture it:\n` +
    `  select version, name from supabase_migrations.schema_migrations order by version;\n` +
    `  ... | node scripts/refresh-applied-migrations.mjs`
  );
} catch {
  process.exit(0);
}
