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
  APPLIED_MIGRATIONS_SQL,
  CRX_SUPABASE_PROJECT_ID,
  LINKED_READ_QUERY_IDS,
  runLinkedRead,
} from './supabase-linked-read.mjs';

export { APPLIED_MIGRATIONS_SQL };

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
    // Preserve the authored name whenever it carries its own timestamp. The
    // ordering parser deliberately treats that stamp as authoritative even when
    // it is not the leading token; prefixing the apply-time version would make
    // non-leading authored stamps resolve differently from leading ones.
    // Timestamp-less legacy names still need the ledger version reattached so
    // they continue to constrain ordering.
    if (TS.test(name)) return name;
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
  projectDir = process.cwd(),
  linkedRoot,
  run,
} = {}) {
  const capture = runLinkedRead({
    projectRoot: projectDir,
    linkedRoot,
    queryId: LINKED_READ_QUERY_IDS.APPLIED_MIGRATIONS,
    ...(run ? { run } : {}),
  });
  if (capture.rows.length !== 1) fail('linked query did not return exactly one row');
  const row = capture.rows[0];
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      JSON.stringify(Object.keys(row)) !== JSON.stringify(['migration_ledger'])) {
    fail('linked query returned an unexpected row shape');
  }
  const snapshot = buildAppliedSnapshot(row.migration_ledger, capture.projectId);
  // Evidence belongs to the checkout that requested it. process.cwd() is
  // deliberate: Claude can keep CLAUDE_PROJECT_DIR pinned to the primary while
  // the command runs in a linked worktree. The guard verifies the hook cwd
  // through `git worktree list` and reads this same active-checkout path. The
  // linked primary remains the trusted query cwd; it is not the evidence owner.
  const outPath = path.join(path.resolve(projectDir), '.claude', 'session-state', 'applied-migrations.json');
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
