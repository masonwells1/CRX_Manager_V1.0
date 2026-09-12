#!/usr/bin/env node
/**
 * db-invariant-sweeps runner  (C1 control — see docs/audits/2026-06-10-error-prevention-review.md §2+§4)
 *
 * Runs read-only "definitive predicate" SQL files against the LIVE Supabase catalog and asserts
 * each returns ZERO rows after subtracting allowlist.json entries. Every recurring Codex finding
 * class (ungated SECDEF mutators, actor-forgery, incomplete sweeps, missing search_path, overloads)
 * is one catalog query away — this runner makes those queries standing executable gates that run
 * BEFORE the Codex handoff instead of after the rejection.
 *
 * Zero new dependencies. Two execution modes:
 *   1. psql mode   — if env SUPABASE_DB_URL is set AND `psql` is on PATH, each predicate is executed
 *                    directly and the runner exits non-zero on any unallowlisted violation. This is
 *                    the mode CI / a wired npm script uses.
 *   2. Claude mode — the default/practical path. The runner prints each predicate's SQL inside a
 *                    clearly-bannered block for Claude Code to run via the Supabase MCP
 *                    `execute_sql` tool (read-only), then paste the JSON rows back. The contract,
 *                    allowlist key column, and adjudication rules are printed alongside so the
 *                    human-in-the-loop disposition is unambiguous.
 *
 *   --strict (or DB_SWEEPS_REQUIRE_LIVE=1) forbids the print-only fallback: if a real linked-live
 *   run is not possible (no SUPABASE_DB_URL / no psql), the runner exits 2 instead of printing and
 *   exiting 0. An autonomous/scheduled gauntlet MUST use --strict so it can never mistake printed
 *   instructions for a passed sweep.
 *
 * Predicate contract (every predicates/*.sql MUST honor it):
 *   - Read-only. SELECT only. NEVER DDL/DML. The runner refuses to execute a file containing a
 *     write keyword as a defense-in-depth guard (see SQL_WRITE_GUARD below).
 *   - Returns rows = violations. Expected ZERO rows after subtracting allowlist entries.
 *   - MUST output a stable key column named `violation_key` (a function identity like
 *     'fn_name(arg types)' or any stable identifier). Actor exceptions ALSO require the exact
 *     suspect_param and unchanged reviewed function/authorization-dependency contracts.
 *
 * Usage:
 *   node run-sweeps.mjs                 # run all predicates (psql mode if possible, else Claude mode)
 *   node run-sweeps.mjs --list          # list discovered predicates + allowlist counts, then exit
 *   node run-sweeps.mjs --explain <p>   # print one predicate's header + SQL + allowlist entries
 *   node run-sweeps.mjs --json          # (psql mode) emit machine-readable result summary
 *   node run-sweeps.mjs --strict        # require a real linked-live run; exit 2 (not print-only) if live unreachable
 *   node run-sweeps.mjs --adjudicate <captured.json> # apply the SAME matcher to captured MCP sweep_result packets
 *
 * Exit codes: 0 = all clear (or Claude-mode print, which never fails the build on its own),
 *             1 = at least one unallowlisted violation (psql mode),
 *             2 = usage / configuration / predicate-contract error, OR --strict requested
 *                 but a real linked-live run was not possible (live unreachable).
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildSweepQuery, subtractAllowlist } from './allowlist-match.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREDICATE_DIR = join(__dirname, 'predicates');
const ALLOWLIST_PATH = join(__dirname, 'allowlist.json');

// Defense-in-depth: a predicate file must never mutate. Predicates legitimately contain the substrings
// 'insert into'/'delete from' INSIDE quoted regex literals (e.g. prosrc ~* 'delete\\s+from'), so a naive
// keyword scan false-positives. We first strip line/block comments and single-quoted string literals
// (handling the SQL '' escape) so only executable SQL remains, then flag any write/DDL keyword as a word.
const SQL_WRITE_KEYWORDS =
  /\b(insert\s+into|delete\s+from|update\b[\s\S]{0,200}?\bset\b|drop\s+|alter\s+|truncate\b|grant\b|revoke\b|create\s+(?!or\s+replace\s+function\s+pg_temp\b)|merge\s+into)\b/i;

/** Strip --line comments, block comments, and '...' literals (with '' escapes) → executable SQL only. */
function stripCommentsAndStrings(sql) {
  return sql
    .replace(/--[^\n]*/g, ' ') // line comments
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // block comments
    .replace(/'(?:[^']|'')*'/g, "''"); // single-quoted string literals (with '' escapes)
}

function readAllowlist() {
  if (!existsSync(ALLOWLIST_PATH)) return { entries: [] };
  const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, 'utf8'));
  // Normalize: { entries: [ { predicate, violation_key, justification, dated, ... } ] }
  if (!Array.isArray(raw.entries)) {
    console.error(`allowlist.json must have an "entries" array. Got: ${typeof raw.entries}`);
    process.exit(2);
  }
  return raw;
}

function discoverPredicates() {
  if (!existsSync(PREDICATE_DIR)) {
    console.error(`No predicates/ directory at ${PREDICATE_DIR}`);
    process.exit(2);
  }
  return readdirSync(PREDICATE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => {
      const path = join(PREDICATE_DIR, f);
      const sql = readFileSync(path, 'utf8');
      // The predicate name is the filename without extension (matches allowlist `predicate`).
      const name = basename(f, '.sql');
      // Header = the leading run of `--` comment lines.
      const header = sql
        .split('\n')
        .filter((l) => l.trimStart().startsWith('--'))
        .map((l) => l.replace(/^\s*--\s?/, ''))
        .join('\n');
      return { name, file: f, path, sql, header };
    });
}

function allowlistFor(allowlist, predicateName) {
  return allowlist.entries.filter((e) => e.predicate === predicateName);
}

function hasPsql() {
  if (!process.env.SUPABASE_DB_URL) return false;
  const probe = spawnSync('psql', ['--version'], { encoding: 'utf8' });
  return probe.status === 0;
}

/** Execute a predicate via psql, returning {rows: [...], error: string|null}. */
function runViaPsql(predicate, entries) {
  // One snapshot: a changed function/dependency cannot be compared to a separately cached catalog.
  const wrapped = buildSweepQuery(predicate, entries);
  const res = spawnSync(
    'psql',
    [process.env.SUPABASE_DB_URL, '-tAX', '--no-psqlrc', '-v', 'ON_ERROR_STOP=1', '-c', wrapped],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  if (res.status !== 0) {
    return { rows: null, function_contracts: [], error: (res.stderr || res.stdout || 'psql failed').trim() };
  }
  try {
    const packet = JSON.parse(res.stdout.trim());
    if (packet.predicate !== predicate.name || !Array.isArray(packet.rows)) {
      throw new TypeError('Invalid sweep_result packet.');
    }
    return { ...packet, error: null };
  } catch (e) {
    return { rows: null, error: `could not parse psql JSON output: ${e.message}\n${res.stdout}` };
  }
}

function assertReadOnly(predicate) {
  if (SQL_WRITE_KEYWORDS.test(stripCommentsAndStrings(predicate.sql))) {
    console.error(
      `\nREFUSING to run "${predicate.file}": it appears to contain a write/DDL statement.\n` +
        `Predicates MUST be read-only SELECTs. If this is a false match inside a string literal,\n` +
        `restructure the SQL so the write keyword isn't a leading statement token.`,
    );
    process.exit(2);
  }
}

// ---------- CLI ----------

const args = process.argv.slice(2);
const allowlist = readAllowlist();
const predicates = discoverPredicates();

if (args.includes('--list')) {
  console.log(`Discovered ${predicates.length} predicate(s) in ${PREDICATE_DIR}:\n`);
  for (const p of predicates) {
    const n = allowlistFor(allowlist, p.name).length;
    const firstLine = p.header.split('\n').find((l) => l.trim()) || '(no header)';
    console.log(`  ${p.name.padEnd(28)}  allowlisted: ${String(n).padStart(3)}   ${firstLine}`);
  }
  console.log(`\nallowlist.json total entries: ${allowlist.entries.length}`);
  process.exit(0);
}

if (args.includes('--explain')) {
  const target = args[args.indexOf('--explain') + 1];
  const p = predicates.find((x) => x.name === target || x.file === target);
  if (!p) {
    console.error(`No predicate named "${target}". Try --list.`);
    process.exit(2);
  }
  const entries = allowlistFor(allowlist, p.name);
  console.log(`=== ${p.name} (${p.file}) ===\n`);
  console.log(p.header || '(no header comment)');
  console.log(`\n--- SQL ---\n${p.sql}`);
  console.log(`\n--- allowlist entries (${entries.length}) ---`);
  for (const e of entries) {
    console.log(`  • ${e.violation_key}\n      ${e.justification} [${e.dated}]`);
    if (e.reviewed_contracts) console.log(JSON.stringify({ suspect_param: e.suspect_param, reviewed_contracts: e.reviewed_contracts }, null, 2));
  }
  process.exit(0);
}

// Optional --only <name1,name2>: run a subset of predicates (used by
// scripts/run-area.mjs for business-area slices). Unknown names fail loudly.
let selectedPredicates = predicates;
if (args.includes('--only')) {
  const raw = args[args.indexOf('--only') + 1];
  if (!raw) {
    console.error('--only requires a comma-separated predicate list (see --list).');
    process.exit(2);
  }
  const wanted = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !predicates.some((p) => p.name === w));
  if (unknown.length) {
    console.error(`--only names unknown predicate(s): ${unknown.join(', ')}. Try --list.`);
    process.exit(2);
  }
  selectedPredicates = predicates.filter((p) => wanted.includes(p.name));
}

// Default: run all (or --only-selected) predicates.
const jsonMode = args.includes('--json');
const strict = args.includes('--strict') || process.env.DB_SWEEPS_REQUIRE_LIVE === '1';

if (args.includes('--adjudicate')) {
  // This validates captured results; it never claims that this process executed a linked-live sweep.
  if (strict) {
    console.error('--strict requires live execution; it cannot be combined with captured-result adjudication.');
    process.exit(2);
  }
  try {
    const capturePath = args[args.indexOf('--adjudicate') + 1];
    if (!capturePath || capturePath.startsWith('--')) throw new TypeError('--adjudicate requires a captured JSON file.');
    const packets = JSON.parse(readFileSync(capturePath, 'utf8'));
    if (!Array.isArray(packets) || packets.length !== selectedPredicates.length) {
      throw new TypeError('Capture must contain exactly one sweep_result packet for each selected predicate (use --only for a subset).');
    }
    const names = new Set();
    const summary = packets.map((packet) => {
      if (!packet || !selectedPredicates.some((p) => p.name === packet.predicate) || names.has(packet.predicate)) {
        throw new TypeError('Capture contains an unknown or duplicate predicate.');
      }
      names.add(packet.predicate);
      const remaining = subtractAllowlist(packet.rows, allowlistFor(allowlist, packet.predicate), packet.function_contracts);
      return { predicate: packet.predicate, status: remaining.length === 0 ? 'PASS' : 'FAIL',
        total_rows: packet.rows.length, allowlisted: packet.rows.length - remaining.length, violations: remaining };
    });
    const ok = summary.every((item) => item.status === 'PASS');
    console.log(JSON.stringify({ ok, execution: 'captured-results-only', summary }, null, 2));
    process.exit(ok ? 0 : 1);
  } catch (error) {
    console.error(`Invalid captured sweep results: ${error.message}`);
    process.exit(2);
  }
}

const psql = hasPsql();

// --strict / DB_SWEEPS_REQUIRE_LIVE: a printed sweep is NOT a passed sweep. When a real
// linked-live run is required but impossible (no SUPABASE_DB_URL / no psql), fail loudly with
// exit 2 instead of falling through to the print-only path that exits 0. An autonomous/scheduled
// gauntlet MUST invoke this so it can never mistake printed instructions for a passed sweep.
// (Codex June-14 gauntlet HIGH #2.)
if (!psql && strict) {
  console.error(
    [
      '════════════════════════════════════════════════════════════════════════',
      ' db-invariant-sweeps — STRICT MODE FAILURE (no live execution available)',
      '════════════════════════════════════════════════════════════════════════',
      '',
      ' --strict (or DB_SWEEPS_REQUIRE_LIVE=1) requires a real linked-live run, but',
      ' SUPABASE_DB_URL is not set or `psql` is not on PATH, so this runner can only',
      ' PRINT the predicate SQL (Claude mode) — it cannot execute it.',
      '',
      ' A printed sweep is NOT a passed sweep. Set SUPABASE_DB_URL to a read-only',
      ' connection string with psql installed, then re-run. An autonomous gauntlet',
      ' MUST treat this exit code (2) as "sweep did not run" — never as a pass.',
      '════════════════════════════════════════════════════════════════════════',
    ].join('\n'),
  );
  process.exit(2);
}

if (!psql) {
  // ---- Claude-first mode: print SQL with banners for MCP execute_sql ----
  console.log(
    [
      '════════════════════════════════════════════════════════════════════════',
      ' db-invariant-sweeps — CLAUDE MODE (SUPABASE_DB_URL/psql not available)',
      '════════════════════════════════════════════════════════════════════════',
      '',
      ' Run each wrapped predicate below READ-ONLY via Supabase MCP execute_sql',
      ' (project rhyzpcqhnizqbxphqdkr). Each returns one sweep_result packet with',
      ' rows AND reviewed dependency contracts from the same database snapshot.',
      ' Capture the returned packets as a LOCAL/private JSON array; run this',
      ' runner with --adjudicate <captured.json> (and --only for a subset).',
      ' A key-only comparison is NOT sufficient: actor exceptions require the',
      ' exact suspect_param and every unchanged reviewed definition/owner/ACL.',
      ' Missing or changed contracts leave the flag visible. Investigate via',
      ' pg_get_functiondef and either (a) seed a justified allowlist entry citing',
      ' the live definition, or (b) report/fix it. NEVER allowlist a real hole.',
      '',
      ` Predicates: ${selectedPredicates.length}   |   allowlist entries: ${allowlist.entries.length}`,
      '════════════════════════════════════════════════════════════════════════',
      '',
    ].join('\n'),
  );
  for (const p of selectedPredicates) {
    assertReadOnly(p);
    const entries = allowlistFor(allowlist, p.name);
    console.log(`\n┌─ PREDICATE: ${p.name}  (allowlisted: ${entries.length}) ${'─'.repeat(20)}`);
    const firstHeader = p.header.split('\n').find((l) => l.trim());
    if (firstHeader) console.log(`│ ${firstHeader}`);
    console.log(`└${'─'.repeat(60)}`);
    console.log(buildSweepQuery(p, entries));
    if (entries.length) {
      console.log(`-- candidate exception keys for ${p.name} (NOT key-only authorization):`);
      for (const e of entries) console.log(`--   ${e.violation_key}${e.suspect_param ? ` [suspect_param=${e.suspect_param}; reviewed contracts required]` : ''}`);
    }
    console.log('');
  }
  console.log(
    '\nClaude: after running all of the above, report per-predicate counts and any\n' +
      'unallowlisted rows using --adjudicate, NOT key-only subtraction. The local\n' +
      'adjudicator does not certify capture freshness. THIS print-only process exits 0.',
  );
  process.exit(0);
}

// ---- psql mode: execute + assert ----
let failed = false;
const summary = [];
for (const p of selectedPredicates) {
  assertReadOnly(p);
  const entries = allowlistFor(allowlist, p.name);
  const { rows, function_contracts, error } = runViaPsql(p, entries);
  if (error) {
    failed = true;
    summary.push({ predicate: p.name, status: 'ERROR', error });
    if (!jsonMode) console.error(`✗ ${p.name}: ERROR\n  ${error}`);
    continue;
  }
  let remaining;
  try {
    remaining = subtractAllowlist(rows, entries, function_contracts);
  } catch (contractError) {
    console.error(`Invalid predicate contract for ${p.name}: ${contractError.message}`);
    process.exit(2);
  }
  const status = remaining.length === 0 ? 'PASS' : 'FAIL';
  if (status === 'FAIL') failed = true;
  summary.push({
    predicate: p.name,
    status,
    total_rows: rows.length,
    allowlisted: rows.length - remaining.length,
    violations: remaining,
  });
  if (!jsonMode) {
    if (status === 'PASS') {
      console.log(`✓ ${p.name}: PASS (${rows.length} flagged, ${rows.length} allowlisted)`);
    } else {
      console.error(
        `✗ ${p.name}: FAIL — ${remaining.length} unallowlisted violation(s):`,
      );
      for (const r of remaining) console.error(`    ${r.violation_key}  ${JSON.stringify(r)}`);
    }
  }
}

if (jsonMode) console.log(JSON.stringify({ ok: !failed, summary }, null, 2));
else
  console.log(
    `\n${failed ? 'SWEEP FAILED' : 'ALL SWEEPS PASSED'} — ${summary.length} predicate(s) run.`,
  );

process.exit(failed ? 1 : 0);
