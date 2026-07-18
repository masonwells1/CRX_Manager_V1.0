/**
 * Disposable, network-isolated proof for per-line split billing Phase 2.
 *
 * Safety:
 * - creates a unique container whose name must begin crx-per-line-p2-proof-;
 * - uses --network none and a tmpfs PostgreSQL data directory;
 * - uses the fixed database name crx_per_line_p2_disposable, which the SQL
 *   proof also checks before creating fixtures;
 * - loads Phase 2 verbatim; Phase 1 is loaded verbatim once PR #166's invalid
 *   COMMENT concatenation is fixed, while the current blocked form is normalized
 *   in memory for calculator diagnostics only (the repo file is never edited); and
 * - removes the exact container in finally on PASS or FAIL.
 */

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-per-line-p2-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const IMAGE = 'postgres:17-alpine';
const DATABASE = 'crx_per_line_p2_disposable';
const PASSWORD = 'per-line-p2-disposable-only';

const files = {
  setup: path.join(ROOT, 'scripts', 'smoke', 'setup-per-line-split-billing-phase2.sql'),
  phase1: path.join(ROOT, 'supabase', 'migrations', '20260718120000_per_line_split_billing_phase1_schema.sql'),
  phase2: path.join(ROOT, 'supabase', 'migrations', '20260718153736_per_line_split_billing_phase2_calculator.sql'),
  smoke: path.join(ROOT, 'scripts', 'smoke', 'smoke-per-line-split-billing-phase2.sql'),
};

function fail(message, detail = '') {
  throw new Error(`${message}${detail ? `\n${detail}` : ''}`);
}

function assertSafeContainerName() {
  if (!CONTAINER.startsWith(PREFIX) || !/^[a-z0-9][a-z0-9_.-]+$/.test(CONTAINER)) {
    fail(`refusing unsafe disposable container name: ${CONTAINER}`);
  }
}

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) fail(`docker could not start: ${result.error.message}`);
  if (!allowFailure && result.status !== 0) {
    fail(
      `docker ${args.join(' ')} failed with exit ${result.status}`,
      `${result.stdout || ''}${result.stderr || ''}`.trim(),
    );
  }
  return result;
}

function psql(sql, { allowFailure = false } = {}) {
  return docker([
    'exec', '-i', CONTAINER,
    'psql', '-U', 'postgres', '-d', DATABASE,
    '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
  ], { input: sql, allowFailure });
}

function read(name) {
  return readFileSync(files[name], 'utf8');
}

function phase1ForDisposableDiagnostic() {
  const sql = read('phase1');
  const start = sql.indexOf('COMMENT ON COLUMN public.invoices.send_disposition IS');
  if (start < 0) return sql;
  const end = sql.indexOf(';', start);
  if (end < 0) fail('Phase 1 send_disposition COMMENT has no terminator');
  const commentBlock = sql.slice(start, end + 1);
  if (!commentBlock.includes('||')) return sql;

  console.warn('[phase2-proof] BLOCKER: PR #166 Phase 1 has invalid COMMENT concatenation; normalizing that comment in memory for Phase 2 diagnostics only.');
  return sql.replace(
    commentBlock,
    `COMMENT ON COLUMN public.invoices.send_disposition IS
  'Server-controlled email gate. suppressed_zero_total = $0 not-to-send invoice: recorded and visible in the account, contributes zero to AR/aging/finance charge, NOT marked paid, and every email path must refuse it. Default sendable. Never written by the browser.';`,
  );
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function startContainer() {
  assertSafeContainerName();
  const existing = docker(['container', 'inspect', CONTAINER], { allowFailure: true });
  if (existing.status === 0) fail(`refusing to reuse container ${CONTAINER}`);

  docker([
    'run', '--detach', '--name', CONTAINER,
    '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=256m',
    '--env', `POSTGRES_PASSWORD=${PASSWORD}`,
    '--env', `POSTGRES_DB=${DATABASE}`,
    IMAGE,
  ]);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const ready = docker(
      ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', DATABASE],
      { allowFailure: true },
    );
    if (ready.status === 0) {
      sleep(1500);
      const stable = docker(
        ['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', DATABASE],
        { allowFailure: true },
      );
      if (stable.status === 0) return;
    }
    sleep(250);
  }
  fail('disposable PostgreSQL container did not become ready within 30 seconds');
}

function run() {
  startContainer();
  console.log(`[phase2-proof] container=${CONTAINER} network=none database=${DATABASE}`);
  console.log('[phase2-proof] loading minimal schema + Phase 1 migration');
  psql(read('setup'));
  psql(phase1ForDisposableDiagnostic());

  console.log('[phase2-proof] loading Phase 2 migration verbatim');
  psql(read('phase2'));

  const featureState = psql(`
    SELECT setting_value
    FROM public.app_settings
    WHERE setting_key = 'feature_per_line_split_billing';
  `).stdout.trim();
  if (featureState !== 'false') {
    fail(`Phase 2 migration changed the feature flag: ${featureState || '<missing>'}`);
  }

  console.log('[phase2-proof] running rollback-only hard proofs');
  const proof = psql(read('smoke'), { allowFailure: true });
  const output = `${proof.stdout || ''}${proof.stderr || ''}`;
  if (proof.status === 0 || !output.includes('SMOKE_PASS_ROLLBACK')) {
    fail('Phase 2 rollback proof did not reach its PASS marker', output.trim());
  }

  console.log('PROOF — Ran: network-isolated PostgreSQL 17 container; loaded checked-in Phase 1 + Phase 2 migrations; executed rollback-only Phase 2 SQL proof.');
  console.log('PROOF — Saw: feature OFF delegated unchanged; 50/50; exact 3-way; 1-cent; one final money rounding after full-precision conversion; signed half-cent -13 => -7/-6; quote/tier/manual/service price precedence; per-person override; 100/0 zero row; flat fee; job snapshot/default/fallback; hashes; Mode A/vector/role rejection; one public preview overload; private calculator not browser-executable.');
}

try {
  run();
} finally {
  assertSafeContainerName();
  const removed = docker(['rm', '--force', CONTAINER], { allowFailure: true });
  if (removed.status === 0) {
    console.log(`[phase2-proof] removed disposable container ${CONTAINER}`);
  } else {
    console.error(`[phase2-proof] WARNING: could not remove ${CONTAINER}: ${removed.stderr || removed.stdout}`);
  }
}
