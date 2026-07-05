#!/usr/bin/env node
// PostToolUse registry-freshness watchdog (A8, 2026-07-04).
// Fires after a Supabase MCP `apply_migration` call. If the applied SQL contains
// DDL that changes what .claude/schema-registry.json describes (tables, columns,
// CHECK constraints, enums, generated columns), the registry is now STALE — and
// the 4 PreToolUse guards that read it (sql-safety, status-enum-check,
// generated-column-check, rls-on-new-tables) all FAIL OPEN on stale data, so
// they could wave through the exact bug class they exist to catch.
//
// On match:
//   1. Writes .claude/session-state/REGISTRY-STALE.flag  ({ created, migration_hint })
//   2. Emits a PostToolUse additionalContext block telling Claude to run the
//      /regen-schema-registry skill's LIVE-INTROSPECTION refresh (the script's
//      default mode only re-stamps the timestamp — that does NOT count) and to
//      delete the flag ONLY after verifying the registry content actually changed.
//
// sql-safety.mjs reads the flag and BLOCKS new migration-file writes until the
// registry is refreshed and the flag is deleted.
// FAIL-OPEN: any error here exits 0 silently — this hook never breaks a session.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

try {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }

  const toolName = (payload?.tool_name || "").toString();
  if (!/apply_migration/i.test(toolName)) process.exit(0);

  // Supabase MCP apply_migration shape is { project_id, name, query } —
  // same payload migration-apply-guard.mjs reads on the PreToolUse side.
  const input = payload?.tool_input || {};
  const migName = (input.name || "").toString().trim();
  const sqlRaw = (input.query || input.sql || "").toString();
  if (!sqlRaw) process.exit(0);

  // Strip SQL line comments so doc comments mentioning DDL don't false-positive
  // (same trick sql-safety.mjs uses for its rules).
  const sql = sqlRaw.replace(/--[^\n]*/g, "");

  // DDL that changes what the schema registry describes.
  const ddlPatterns = [
    [/\bCREATE\s+TABLE\b/i, "CREATE TABLE"],
    [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
    [/\bDROP\s+COLUMN\b/i, "DROP COLUMN"],
    [/\bADD\s+CONSTRAINT\b/i, "ADD CONSTRAINT"],
    [/\bCHECK\s*\(/i, "CHECK (...)"],
    [/\bALTER\s+COLUMN\b/i, "ALTER COLUMN"],
    [/\bGENERATED\s+ALWAYS\b/i, "GENERATED ALWAYS"],
    [/\bCREATE\s+TYPE\b[\s\S]{0,300}?\bAS\s+ENUM\b/i, "CREATE TYPE ... AS ENUM"],
  ];
  const matched = ddlPatterns.filter(([re]) => re.test(sql)).map(([, label]) => label);
  if (matched.length === 0) process.exit(0);

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const stateDir = path.join(projectDir, ".claude", "session-state");
  const flagPath = path.join(stateDir, "REGISTRY-STALE.flag");
  const created = new Date().toISOString();
  const migrationHint = migName || matched[0];

  let flagWritten = false;
  try {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(flagPath, JSON.stringify({ created, migration_hint: migrationHint }, null, 2) + "\n");
    flagWritten = true;
  } catch { /* fail-open — the additionalContext below still tells Claude what to do */ }

  const context =
    `REGISTRY FRESHNESS — the migration just applied to LIVE ("${migrationHint}") contains ` +
    `schema-registry-relevant DDL (${matched.join(", ")}). The schema snapshot at ` +
    `.claude/schema-registry.json that powers 4 PreToolUse safety hooks is now STALE, and those ` +
    `hooks FAIL OPEN on stale data — they could miss the very bug class they exist to catch.\n\n` +
    `Do this NOW, before writing any more migrations:\n` +
    `1. Run the /regen-schema-registry skill's LIVE-INTROSPECTION refresh: run queries Q1-Q5 ` +
    `(documented in the header of scripts/regenerate-schema-registry.mjs) via Supabase MCP ` +
    `execute_sql, assemble the JSON, then run ` +
    `\`node scripts/regenerate-schema-registry.mjs --from-introspection <file.json>\`. ` +
    `The script's DEFAULT mode (no args) only re-stamps the timestamp — that does NOT count as a refresh.\n` +
    `2. Verify the registry content ACTUALLY changed before clearing the flag: ` +
    `_meta.generated_at must be newer than the flag's "created" (${created}) AND the file's ` +
    `content hash must differ from before the refresh (a timestamp-only diff is NOT a refresh).\n` +
    `3. ONLY THEN delete .claude/session-state/REGISTRY-STALE.flag.\n\n` +
    (flagWritten
      ? `Until the flag is deleted, sql-safety.mjs BLOCKS any new migration-file write. `
      : `NOTE: writing the flag file failed, so sql-safety.mjs will NOT block — follow the steps above anyway. `) +
    `If Mason asks, explain in plain English: "the safety net's map of the database is out of date ` +
    `after that live change — I'm refreshing it before touching anything else."`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: context,
    },
  }));
  process.exit(0);
} catch {
  // FAIL-OPEN: never let this watchdog break a tool call.
  process.exit(0);
}
