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

import { readFileSync, existsSync, rmSync } from "node:fs";
import path from "node:path";

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

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
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
