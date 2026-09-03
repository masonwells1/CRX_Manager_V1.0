#!/usr/bin/env node
// Deterministic CI check for two CRX Hard Rules (AGENTS.md) that until now were
// enforced only by an AI reviewer (CodeRabbit) and by local Claude hooks that
// fire only when Claude is the writer:
//
//   1. "Add database changes only as new files under supabase/migrations/;
//      never edit an applied migration."
//   2. "New tables must enable Row Level Security (RLS) and include policies
//      in the same migration."
//
// WHAT COUNTS AS APPLIED
//   CI has no database access, so "applied" is approximated as: the migration
//   already exists at the comparison base (the merge-base of the PR base and
//   head) AND its 14-digit version is not newer than the applied-migration
//   high-water mark recorded in the BASE tree's .claude/schema-registry.json.
//   A migration newer than that high-water mark is in the pending band — it
//   has landed on main but nothing newer has been applied — and may still be
//   revised. The registry is read from the BASE tree on purpose: a PR cannot
//   widen the band by editing the registry in the same change. If the registry
//   cannot be read or parsed, every base migration is treated as applied
//   (fail closed).
//
//   The registry's applied_migration_names list is NOT used: measured on
//   2026-09-03 it matched only 252 of 900 files on disk by name, so membership
//   proves nothing either way.
//
// WHAT COUNTS AS A NEW TABLE
//   Every CREATE TABLE in an ADDED migration file, except TEMP/TEMPORARY
//   tables. Comments are stripped before matching. The table must appear in an
//   `ALTER TABLE <name> ... ENABLE ROW LEVEL SECURITY` and in at least one
//   `CREATE POLICY ... ON <name>` in the SAME file. Names are compared
//   lowercase, unquoted, schema-qualified (unqualified names mean `public`).
//   The one documented exemption is the same marker the local
//   .claude/hooks/rls-on-new-tables.mjs hook honors: a `-- rls-check: exempt`
//   comment in the file (used once in 900 migrations, for a SECURITY DEFINER
//   only counter table). An exempt file is reported loudly, never silently.
//
// USAGE
//   node scripts/check-migration-hard-rules.mjs --base <sha> --head <sha> [--repo-root <dir>]
//   node scripts/check-migration-hard-rules.mjs --audit-all [--repo-root <dir>]
//       (scans every migration on disk for the RLS rule; informational)
//
// EXIT CODES
//   0 = clean, 1 = violation, 2 = the check itself could not run

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = 'supabase/migrations';
export const REGISTRY_PATH = '.claude/schema-registry.json';
const ZERO_SHA = '0000000000000000000000000000000000000000';

// ---------------------------------------------------------------------------
// SQL analysis (pure)
// ---------------------------------------------------------------------------

export function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ');
}

export function normalizeRelationName(raw) {
  const parts = String(raw)
    .split('.')
    .map((part) => part.replace(/"/g, '').trim().toLowerCase())
    .filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return `public.${parts[0]}`;
  return parts.slice(-2).join('.');
}

// The local hook's marker test with a word boundary added: the hook's
// `/rls-check:\s*exempt/` also matches "exemption requested", which the DENY
// canary in the test file caught. The marker lives in a comment, so it is
// checked on the raw text before comments are stripped.
export const RLS_EXEMPT_MARKER_RE = /--\s*rls-check:\s*exempt\b/i;

const IDENT = String.raw`[A-Za-z0-9_".]+`;
const CREATE_TABLE_RE = new RegExp(
  String.raw`\bcreate\s+(?:(?:global|local)\s+)?(?:(temp|temporary|unlogged)\s+)?table\s+(?:if\s+not\s+exists\s+)?(${IDENT})`,
  'gi',
);
const ENABLE_RLS_RE = new RegExp(
  String.raw`\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?(${IDENT})([^;]*?)\benable\s+row\s+level\s+security\b`,
  'gi',
);
const CREATE_POLICY_RE = new RegExp(
  String.raw`\bcreate\s+policy\s+(?:"[^"]*"|\S+)\s+on\s+(?:only\s+)?(${IDENT})`,
  'gi',
);

/**
 * Returns { tables: [...], violations: [...], exempt: boolean } for one
 * migration's SQL text. A violation is a table created without RLS enabled or
 * without any policy in the same file. When the file carries the documented
 * `-- rls-check: exempt` marker, violations are still computed but returned
 * under `exemptViolations` so the caller can report them without failing.
 */
export function analyzeMigrationSql(sql) {
  const exempt = RLS_EXEMPT_MARKER_RE.test(String(sql));
  const text = stripSqlComments(sql);
  const created = new Map();
  for (const match of text.matchAll(CREATE_TABLE_RE)) {
    const modifier = (match[1] || '').toLowerCase();
    if (modifier === 'temp' || modifier === 'temporary') continue;
    const name = normalizeRelationName(match[2]);
    if (name) created.set(name, match[2]);
  }
  const rlsEnabled = new Set();
  for (const match of text.matchAll(ENABLE_RLS_RE)) {
    rlsEnabled.add(normalizeRelationName(match[1]));
  }
  const policyOn = new Set();
  for (const match of text.matchAll(CREATE_POLICY_RE)) {
    policyOn.add(normalizeRelationName(match[1]));
  }
  const violations = [];
  for (const [name, spelled] of created) {
    const missing = [];
    if (!rlsEnabled.has(name)) missing.push('ALTER TABLE ... ENABLE ROW LEVEL SECURITY');
    if (!policyOn.has(name)) missing.push('CREATE POLICY ... ON <table>');
    if (missing.length > 0) violations.push({ table: name, spelled, missing });
  }
  if (exempt) {
    return { tables: [...created.keys()], violations: [], exemptViolations: violations, exempt: true };
  }
  return { tables: [...created.keys()], violations, exemptViolations: [], exempt: false };
}

// ---------------------------------------------------------------------------
// Change classification (pure)
// ---------------------------------------------------------------------------

export function migrationVersion(relPath) {
  const base = path.posix.basename(String(relPath).replace(/\\/g, '/'));
  const match = base.match(/^(\d{14})_/);
  return match ? match[1] : null;
}

export function isMigrationSqlPath(relPath) {
  const normalized = String(relPath).replace(/\\/g, '/');
  return normalized.startsWith(`${MIGRATIONS_DIR}/`) && /\.sql$/i.test(normalized);
}

/**
 * entries: [{ status: 'A'|'M'|'D'|'T', path }] from `git diff --name-status --no-renames`.
 * highWater: 14-digit string or null (null = registry unreadable → fail closed).
 * Returns { protectedChanges, pendingChanges, added, ignored }.
 */
export function classifyMigrationChanges(entries, highWater) {
  const protectedChanges = [];
  const pendingChanges = [];
  const added = [];
  const ignored = [];
  const bandOpen = typeof highWater === 'string' && /^\d{14}$/.test(highWater);
  for (const entry of entries) {
    if (!isMigrationSqlPath(entry.path)) {
      ignored.push(entry);
      continue;
    }
    if (entry.status === 'A') {
      added.push(entry.path);
      continue;
    }
    const version = migrationVersion(entry.path);
    if (bandOpen && version && version > highWater) {
      pendingChanges.push({ ...entry, version, highWater });
    } else {
      protectedChanges.push({ ...entry, version, highWater: bandOpen ? highWater : null });
    }
  }
  return { protectedChanges, pendingChanges, added, ignored };
}

export function readHighWater(registryJsonText) {
  try {
    const parsed = JSON.parse(registryJsonText);
    const value = parsed?._meta?.migrations_high_water;
    return typeof value === 'string' && /^\d{14}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function parseNameStatus(raw) {
  // -z output: STATUS\0PATH\0STATUS\0PATH\0...
  const fields = String(raw).split('\0').filter((field) => field.length > 0);
  const entries = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    entries.push({ status: fields[index][0], path: fields[index + 1] });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Git plumbing
// ---------------------------------------------------------------------------

function git(repoRoot, args, options = {}) {
  return execFileSync('git', ['-C', repoRoot, ...args], {
    encoding: options.buffer ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function commitExists(repoRoot, sha) {
  try {
    git(repoRoot, ['cat-file', '-e', `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function showFile(repoRoot, sha, relPath) {
  try {
    return git(repoRoot, ['show', `${sha}:${relPath}`]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export function runDiffCheck({ repoRoot, base, head, log = console.log }) {
  const isSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
  if (!isSha(head) || !commitExists(repoRoot, head)) {
    throw new Error(`head is not a reachable commit: ${head}`);
  }
  if (!isSha(base) || base.toLowerCase() === ZERO_SHA || !commitExists(repoRoot, base)) {
    log(`MIGRATION HARD RULES: no comparison base available (base=${base}); nothing to compare.`);
    log('  This happens on a brand-new branch push. The pull request run performs the real check.');
    return { ok: true, skipped: true };
  }

  const mergeBase = git(repoRoot, ['merge-base', base, head]).trim();
  const registryText = showFile(repoRoot, mergeBase, REGISTRY_PATH);
  const highWater = registryText === null ? null : readHighWater(registryText);
  const rawStatus = git(repoRoot, [
    'diff', '--name-status', '--no-renames', '-z', mergeBase, head, '--', MIGRATIONS_DIR,
  ]);
  const entries = parseNameStatus(rawStatus);
  const { protectedChanges, pendingChanges, added } = classifyMigrationChanges(entries, highWater);

  log(`MIGRATION HARD RULES: comparing ${mergeBase.slice(0, 12)} (merge-base) -> ${head.slice(0, 12)}`);
  log(`  applied high-water mark (from base registry): ${highWater ?? 'UNREADABLE — treating every base migration as applied'}`);
  log(`  migrations added: ${added.length}, revised in pending band: ${pendingChanges.length}, applied-and-changed: ${protectedChanges.length}`);

  let ok = true;
  for (const change of protectedChanges) {
    ok = false;
    const verb = change.status === 'D' ? 'DELETES' : 'MODIFIES';
    log(`  ✗ ${verb} an applied migration: ${change.path}`);
    log(`      Migrations that already ran on the live database are never edited, renamed, or removed.`);
    log(`      Ship the correction as a NEW file under ${MIGRATIONS_DIR}/ instead.`);
  }
  for (const change of pendingChanges) {
    log(`  ⚠ revises a pending migration (version ${change.version} is newer than applied high-water ${change.highWater}): ${change.path}`);
  }
  for (const relPath of added) {
    const sql = showFile(repoRoot, head, relPath);
    if (sql === null) {
      ok = false;
      log(`  ✗ could not read added migration at head: ${relPath}`);
      continue;
    }
    const { tables, violations, exemptViolations, exempt } = analyzeMigrationSql(sql);
    if (exempt && exemptViolations.length > 0) {
      for (const violation of exemptViolations) {
        log(`  ⚠ ${relPath}: new table ${violation.spelled} is missing ${violation.missing.join(' and ')} but the file carries "-- rls-check: exempt" — reviewers must confirm the written reason`);
      }
      continue;
    }
    if (violations.length === 0) {
      if (tables.length > 0) log(`  ✓ ${relPath}: ${tables.length} new table(s) carry RLS + policy`);
      continue;
    }
    ok = false;
    for (const violation of violations) {
      log(`  ✗ ${relPath}: new table ${violation.spelled} is missing ${violation.missing.join(' and ')}`);
    }
    log('      AGENTS.md: new tables must enable Row Level Security and include policies in the SAME migration.');
  }
  log(ok ? 'MIGRATION HARD RULES: PASS' : 'MIGRATION HARD RULES: FAIL');
  return { ok, skipped: false, protectedChanges, pendingChanges, added };
}

export function runAuditAll({ repoRoot, log = console.log }) {
  const dir = path.join(repoRoot, MIGRATIONS_DIR);
  const files = readdirSync(dir).filter((name) => /\.sql$/i.test(name)).sort();
  let failing = 0;
  let tablesSeen = 0;
  let exemptFiles = 0;
  for (const name of files) {
    const { tables, violations, exempt } = analyzeMigrationSql(readFileSync(path.join(dir, name), 'utf8'));
    tablesSeen += tables.length;
    if (exempt) exemptFiles += 1;
    if (violations.length === 0) continue;
    failing += 1;
    for (const violation of violations) {
      log(`  ${name}: ${violation.spelled} missing ${violation.missing.join(' and ')}`);
    }
  }
  log(`MIGRATION HARD RULES AUDIT: ${files.length} files, ${tablesSeen} CREATE TABLE statements, ${failing} file(s) would fail the RLS rule, ${exemptFiles} carry the rls-check: exempt marker`);
  return { files: files.length, tablesSeen, failing, exemptFiles };
}

function parseArgs(argv) {
  const options = { repoRoot: process.cwd(), auditAll: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      index += 1;
      if (index >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[index];
    };
    if (arg === '--base') options.base = next();
    else if (arg === '--head') options.head = next();
    else if (arg === '--repo-root') options.repoRoot = path.resolve(next());
    else if (arg === '--audit-all') options.auditAll = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.auditAll) {
    runAuditAll({ repoRoot: options.repoRoot });
    return;
  }
  if (!options.base || !options.head) {
    throw new Error('usage: --base <sha> --head <sha> [--repo-root <dir>] | --audit-all');
  }
  const result = runDiffCheck({ repoRoot: options.repoRoot, base: options.base, head: options.head });
  process.exitCode = result.ok ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`MIGRATION HARD RULES: check could not run: ${error.message}`);
    process.exitCode = 2;
  }
}
