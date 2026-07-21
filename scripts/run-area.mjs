#!/usr/bin/env node
/**
 * run-area.mjs - business-area slice runner for the CRX test system.
 *
 * Lets a review target ONE section of the app ("just billing", "just
 * inventory") instead of the whole suite. An area bundles:
 *   1. a vitest slice        (hermetic unit/contract/regression tests)
 *   2. smoke chains          (rolled-back live-DB business-chain proofs,
 *                             selected via `area` tags in smoke-specs.json)
 *   3. DB invariant sweeps   (read-only live-catalog predicates)
 *
 * Areas are defined in scripts/test-areas.json.
 *
 * Usage:
 *   node scripts/run-area.mjs --list             # list areas + what they bundle
 *   node scripts/run-area.mjs billing            # run the vitest slice; PRINT the
 *                                                #   db-layer commands to run next
 *   node scripts/run-area.mjs billing --with-db  # also invoke smoke + sweeps
 *                                                #   (psql mode if SUPABASE_DB_URL is
 *                                                #   set, else Claude-first printing)
 *   node scripts/run-area.mjs billing --vitest-only
 *
 * Contract: every vitest path in test-areas.json MUST exist — a rename that
 * orphans a path fails the run loudly instead of silently shrinking the slice.
 *
 * Exit codes: 0 = all invoked layers passed, 1 = any layer failed,
 *             2 = usage / manifest error.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST_PATH = path.join(ROOT, 'scripts', 'test-areas.json');
const SMOKE_SPECS_PATH = path.join(ROOT, 'scripts', 'smoke', 'smoke-specs.json');

function fail(msg, code = 2) {
  console.error(`run-area: ${msg}`);
  process.exit(code);
}

function loadJson(p, label) {
  if (!existsSync(p)) fail(`${label} not found: ${p}`);
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    fail(`${label} is not valid JSON: ${e.message}`);
  }
}

const manifest = loadJson(MANIFEST_PATH, 'test-areas.json');
const areas = manifest.areas;
if (!areas || typeof areas !== 'object' || Object.keys(areas).length === 0) {
  fail('test-areas.json has no "areas"');
}

const smokeSpecs = loadJson(SMOKE_SPECS_PATH, 'smoke-specs.json').specs || {};

function smokeKeysForArea(name) {
  return Object.entries(smokeSpecs)
    .filter(([, spec]) => Array.isArray(spec.area) && spec.area.includes(name))
    .map(([key]) => key);
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const positional = argv.filter((a) => !a.startsWith('--'));

if (flags.has('--list') || positional.length === 0) {
  console.log('Test areas (scripts/test-areas.json)\n');
  for (const [name, area] of Object.entries(areas)) {
    const smokes = smokeKeysForArea(name);
    console.log(`  ${name}`);
    console.log(`    ${area.description}`);
    console.log(`    vitest: ${area.vitest.length} path(s)   smoke: ${smokes.length} chain(s)   sweeps: ${(area.sweeps || []).length} predicate(s)\n`);
  }
  console.log('Run one: node scripts/run-area.mjs <area> [--with-db|--vitest-only]');
  process.exit(positional.length === 0 && !flags.has('--list') ? 2 : 0);
}

const areaName = positional[0];
const area = areas[areaName];
if (!area) fail(`unknown area "${areaName}". Try --list.`);

// Validate every vitest path exists (loud failure beats a silently shrunk slice).
const missing = area.vitest.filter((p) => !existsSync(path.join(ROOT, p)));
if (missing.length) {
  fail(
    `area "${areaName}" lists vitest path(s) that do not exist:\n  ${missing.join('\n  ')}\n` +
    'A rename/removal must update scripts/test-areas.json in the same change.'
  );
}
// Validate sweep predicate names exist.
const predicateDir = path.join(ROOT, 'scripts', 'db-invariant-sweeps', 'predicates');
const badSweeps = (area.sweeps || []).filter((s) => !existsSync(path.join(predicateDir, `${s}.sql`)));
if (badSweeps.length) fail(`area "${areaName}" lists unknown sweep predicate(s): ${badSweeps.join(', ')}`);

const withDb = flags.has('--with-db');
const vitestOnly = flags.has('--vitest-only');
let failed = false;

// ---- 1. vitest slice ----
console.log(`\n=== [${areaName}] vitest slice (${area.vitest.length} paths) ===\n`);
const vitest = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', ...area.vitest],
  { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' }
);
if (vitest.status !== 0) failed = true;

// ---- 2 & 3. db layers ----
const smokes = smokeKeysForArea(areaName);
const sweeps = area.sweeps || [];
if (!vitestOnly && (smokes.length || sweeps.length)) {
  const smokeCmd = `node scripts/smoke/run-smoke.mjs --area ${areaName}`;
  const sweepCmd = `node scripts/db-invariant-sweeps/run-sweeps.mjs --only ${sweeps.join(',')}`;
  if (withDb) {
    // A printed chain is NOT a passed chain (Codex P1 on PR #191): both child
    // runners fall back to print-only mode and exit 0 when SUPABASE_DB_URL is
    // missing, which would false-green this whole area review. Refuse instead.
    if (!process.env.SUPABASE_DB_URL) {
      fail(
        '--with-db requires SUPABASE_DB_URL (psql mode). Without it the smoke/sweep\n' +
        'runners only PRINT their SQL and exit 0 — a false green. Either set\n' +
        'SUPABASE_DB_URL, or run the printed layers via Supabase MCP execute_sql:\n' +
        `  node scripts/smoke/run-smoke.mjs --area ${areaName}\n` +
        (sweeps.length ? `  node scripts/db-invariant-sweeps/run-sweeps.mjs --only ${sweeps.join(',')}\n` : '')
      );
    }
    if (smokes.length) {
      console.log(`\n=== [${areaName}] smoke chains (${smokes.length}) ===\n`);
      const r = spawnSync('node', ['scripts/smoke/run-smoke.mjs', '--area', areaName], {
        cwd: ROOT, stdio: 'inherit',
      });
      if (r.status !== 0) failed = true;
    }
    if (sweeps.length) {
      console.log(`\n=== [${areaName}] DB invariant sweeps (${sweeps.length}) ===\n`);
      // --strict: never let a print-only fallback pass as a run sweep.
      const r = spawnSync('node', ['scripts/db-invariant-sweeps/run-sweeps.mjs', '--strict', '--only', sweeps.join(',')], {
        cwd: ROOT, stdio: 'inherit',
      });
      if (r.status !== 0) failed = true;
    }
  } else {
    console.log(`\n=== [${areaName}] live-DB layer (not run — pass --with-db to invoke) ===`);
    if (smokes.length) {
      console.log(`  smoke chains (${smokes.length}): ${smokeCmd}`);
      console.log(`    -> ${smokes.join(', ')}`);
    }
    if (sweeps.length) console.log(`  invariant sweeps (${sweeps.length}): ${sweepCmd}`);
    console.log(
      '  NOTE: a printed/skipped DB layer is NOT a passed one. For a full section\n' +
      '  review, the smoke chains and sweeps must actually run against live.'
    );
  }
}

console.log(`\n[${areaName}] ${failed ? 'FAIL — at least one layer failed.' : 'invoked layers passed.'}`);
process.exit(failed ? 1 : 0);
