#!/usr/bin/env node
// Capture the live applied-migration ledger for migration-apply-guard.mjs.
//
// This command deliberately accepts NO rows, project labels, or SQL from the
// caller. It verifies the repository's linked Supabase project, runs one fixed
// read-only query against that exact link, and writes the project identity and
// returned ledger as one snapshot. That makes it impossible to accidentally
// relabel an old/staging payload as production evidence.

import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CRX_SUPABASE_PROJECT_ID,
  runLinkedRead,
} from './supabase-linked-read.mjs';

export const APPLIED_MIGRATIONS_SQL = `
WITH ledger AS (
  SELECT version::text AS version, name::text AS name
  FROM supabase_migrations.schema_migrations
  ORDER BY version
)
SELECT jsonb_build_object(
  'captured_at', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'applied', COALESCE(jsonb_agg(to_jsonb(ledger) ORDER BY version), '[]'::jsonb)
) AS migration_ledger
FROM ledger;
`.trim();

const TS = /\d{14}/;

function fail(message) {
  throw new Error(`refresh-applied-migrations: ${message}`);
}

export function buildAppliedSnapshot(payload, projectId = CRX_SUPABASE_PROJECT_ID) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
      JSON.stringify(Object.keys(payload).sort()) !== JSON.stringify(['applied', 'captured_at'])) {
    fail('linked query returned an invalid migration_ledger envelope');
  }
  if (typeof payload.captured_at !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(payload.captured_at) ||
      !Number.isFinite(Date.parse(payload.captured_at))) {
    fail('linked query returned an invalid database capture timestamp');
  }
  if (!Array.isArray(payload.applied) || payload.applied.length === 0) {
    fail('linked query returned an empty applied-migration ledger');
  }

  const applied = payload.applied.map((row) => {
    if (!row || typeof row !== 'object' || Array.isArray(row) ||
        !Object.hasOwn(row, 'version') || !Object.hasOwn(row, 'name')) {
      fail('linked query returned a row that is not a migration ledger row');
    }
    const version = String(row.version ?? '').trim();
    const name = String(row.name ?? '').trim();
    if (!/^\d{14}$/.test(version)) fail(`ledger version ${JSON.stringify(version)} is invalid`);
    // The ledger version is authoritative. A name can legally carry an older
    // authored timestamp (or simply contain an unrelated 14-digit number), so
    // only omit the prefix when the name already begins with this exact version.
    if (name.startsWith(version)) return name;
    return name ? `${version}_${name}` : version;
  });

  if (!applied.every((name) => TS.test(name))) {
    fail('not every applied migration carries a 14-digit timestamp');
  }
  return {
    captured_at: payload.captured_at,
    project_id: projectId,
    count: applied.length,
    applied,
  };
}

export function writeAppliedSnapshotAtomically(snapshot, outPath, {
  write = writeFileSync,
  rename = renameSync,
  remove = rmSync,
} = {}) {
  const tempPath = `${outPath}.tmp-${process.pid}`;
  mkdirSync(path.dirname(outPath), { recursive: true });
  try {
    write(tempPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
    rename(tempPath, outPath);
  } catch (error) {
    try { remove(tempPath, { force: true }); } catch { /* best-effort temp cleanup */ }
    throw error;
  }
}

export function captureAppliedMigrations({
  projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd(),
  linkedRoot,
  run,
} = {}) {
  const capture = runLinkedRead({
    projectRoot: projectDir,
    linkedRoot,
    sql: APPLIED_MIGRATIONS_SQL,
    ...(run ? { run } : {}),
  });
  if (capture.rows.length !== 1) fail('linked query did not return exactly one row');
  const row = capture.rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      JSON.stringify(Object.keys(row)) !== JSON.stringify(['migration_ledger'])) {
    fail('linked query returned an unexpected row shape');
  }
  const snapshot = buildAppliedSnapshot(row.migration_ledger, capture.projectId);
  // The Supabase link is owned by the primary checkout. The apply hook and its
  // invalidator are pinned there by CLAUDE_PROJECT_DIR even when the operator is
  // working in a linked worktree, so the capture must land beside the verified
  // link instead of in an ignored worktree-local location the guard never reads.
  const outPath = path.join(capture.linkedRoot, '.claude', 'session-state', 'applied-migrations.json');
  writeAppliedSnapshotAtomically(snapshot, outPath);
  return { outPath, snapshot };
}

function main() {
  if (process.argv.slice(2).length) {
    fail('usage: node scripts/refresh-applied-migrations.mjs (no arguments or stdin)');
  }
  const { outPath, snapshot } = captureAppliedMigrations();
  process.stdout.write(
    `refresh-applied-migrations: captured ${snapshot.count} applied migrations from linked project ` +
    `${snapshot.project_id} and wrote ${outPath}\n`,
  );
}

if (process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error?.message || error}\n`);
    process.exitCode = 1;
  }
}
