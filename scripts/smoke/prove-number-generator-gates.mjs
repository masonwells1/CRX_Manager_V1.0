#!/usr/bin/env node
/**
 * Disposable proof for 20260903160000_gate_number_generators_active_profile_role.sql.
 *
 * Never reads a DB URL and never connects to Supabase: a unique PostgreSQL 17
 * container runs with no network and tmpfs storage, and the migration file is
 * loaded verbatim.
 *
 * What it proves, in order:
 *   A. BEFORE state. The eight generators are installed in their current live
 *      (ungated) form, with the live ACL: EXECUTE to authenticated and
 *      service_role, revoked from PUBLIC and anon. A deactivated profile and an
 *      entity_recipient can call all eight and get a number back.
 *   B. The migration applies, and its own postflight block passes.
 *   C. ACL SHAPE. CREATE OR REPLACE keeps the existing grants, and the migration
 *      then deliberately REVOKES direct `authenticated` EXECUTE from the six
 *      generators the browser never calls. Per-function ACLs are captured before
 *      and after and checked for that exact shape in both directions: the two
 *      browser callers unchanged, the other six having lost authenticated,
 *      none holding anon, all keeping service_role. ("Byte-identical" was the
 *      right check until the revoke existed and is now the wrong one -- it would
 *      have passed while the revoke silently did nothing.)
 *   D. AFTER state. Full 7-principal x 8-generator matrix against the expected
 *      allow/deny table, plus the unauthenticated case.
 *   E. EXECUTE still works for the real `authenticated` role, which is what the
 *      two browser call sites use.
 *   F. MUTATION TESTS. Each postflight assertion is shown to actually fire when
 *      its invariant is violated. A guard that cannot fail is not a guard.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PREFIX = 'crx-number-generator-gate-proof-';
const CONTAINER = `${PREFIX}${process.pid}-${Date.now().toString(36)}`.toLowerCase();
const MIGRATION = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260903160000_gate_number_generators_active_profile_role.sql',
);

const GENERATORS = [
  'next_application_record_number',
  'next_commission_payment_number',
  'next_cycle_count_number',
  'next_delivery_number',
  'next_invoice_number',
  'next_job_number',
  'next_po_number',
  'next_return_number',
];

/** The allow matrix this migration is supposed to produce. */
const ALLOWED = {
  next_application_record_number: ['admin', 'sales_rep', 'applicator'],
  next_commission_payment_number: ['admin'],
  next_cycle_count_number: ['admin'],
  next_delivery_number: ['admin', 'sales_rep', 'driver'],
  next_invoice_number: ['admin', 'sales_rep', 'driver'],
  next_job_number: ['admin', 'sales_rep', 'applicator'],
  next_po_number: ['admin', 'sales_rep'],
  next_return_number: ['admin', 'sales_rep'],
};

/**
 * md5 of the LIVE pg_proc.prosrc for the eight generators, read read-only from
 * project rhyzpcqhnizqbxphqdkr on 2026-09-03, after
 * 20260831235900_serialize_gauntlet_write_boundaries applied.
 *
 * These pins are what makes the migration's fidelity claim falsifiable. Six
 * migrations applied on 2026-08-31 have no file on `main` (they are carried by
 * PR #535's branch codex/gauntlet-s9-safety-20260831 and land when it merges),
 * so `main` alone cannot show the state the bodies were re-emitted from. The
 * proof strips the added gate back out of each applied body and requires the
 * remainder to hash to these values. Any real drift -- a dropped comment, a
 * changed regex, a reverted upstream fix -- fails here, not in production.
 *
 * Hashed over TRAILING-WHITESPACE-NORMALIZED text, i.e.
 *   md5(regexp_replace(prosrc, '[ \t]+$', '', 'gn'))
 * Seven of the eight live bodies are unaffected by that normalization -- their
 * raw and normalized hashes are identical. Only next_cycle_count_number differs:
 * live carries 9 characters of trailing whitespace (two spaces on each of four
 * blank lines, and one after a `CASE`) that a checked-in .sql file cannot
 * reliably preserve, since editors and hooks strip it. Normalizing is therefore
 * the honest comparison; it still fails on any token, comment, or structural
 * change, which is what this pin exists to catch.
 */
const LIVE_BODY_MD5 = {
  next_application_record_number: 'f5ebf20dc5f4982097e4dfb226156ea8',
  next_commission_payment_number: 'd614a9489826c8b4837a466f884b022b',
  next_cycle_count_number: 'b8d37b2ba9ef790eaa8fca8bacdb9f5f',
  next_delivery_number: 'd13c37ceaea3c2f00293bfb2b1a2a215',
  next_invoice_number: '871a39420353d23f3064261231c95531',
  next_job_number: 'a8249edef5733015f6d8e8c669caf55e',
  next_po_number: 'c077318f1748f1d42c56c49439bfe985',
  next_return_number: 'b02f5a71f91148152c0cb67ab5ba5d0a',
};

/** id -> { role, active } for the principals the matrix exercises. */
const PRINCIPALS = {
  '00000000-0000-0000-0000-000000000001': { label: 'admin (active)', role: 'admin', active: true },
  '00000000-0000-0000-0000-000000000002': { label: 'sales_rep (active)', role: 'sales_rep', active: true },
  '00000000-0000-0000-0000-000000000003': { label: 'sales_rep (DEACTIVATED)', role: 'sales_rep', active: false },
  '00000000-0000-0000-0000-000000000004': { label: 'driver (active)', role: 'driver', active: true },
  '00000000-0000-0000-0000-000000000005': { label: 'applicator (active)', role: 'applicator', active: true },
  '00000000-0000-0000-0000-000000000006': { label: 'entity_recipient (active)', role: 'entity_recipient', active: true },
  '00000000-0000-0000-0000-000000000007': { label: 'admin (DEACTIVATED)', role: 'admin', active: false },
};

function docker(args, { input, allowFailure = false } = {}) {
  const result = spawnSync('docker', args, {
    cwd: ROOT,
    encoding: 'utf8',
    input,
    maxBuffer: 10 * 1024 * 1024,
    timeout: 180_000,
    killSignal: 'SIGTERM',
  });
  if (result.error) throw result.error;
  if (!allowFailure && result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result;
}

function psql(sql, { allowFailure = false, tuplesOnly = false } = {}) {
  const args = ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  if (tuplesOnly) args.push('-At');
  return docker(args, { input: sql, allowFailure });
}

function query(sql) {
  return psql(sql, { tuplesOnly: true }).stdout.trim();
}

function assertInputs() {
  assert.ok(existsSync(MIGRATION), `missing migration under proof: ${MIGRATION}`);
  const migration = readFileSync(MIGRATION, 'utf8');
  for (const name of GENERATORS) {
    assert.ok(
      migration.includes(`CREATE OR REPLACE FUNCTION public.${name}(`),
      `migration does not re-emit ${name}`,
    );
  }
  for (const marker of [
    "RAISE EXCEPTION 'AUTH_REQUIRED'",
    "RAISE EXCEPTION 'INSUFFICIENT_ROLE'",
    'is_active = true',
    'DO $postflight$',
  ]) {
    assert.ok(migration.includes(marker), `migration marker missing: ${marker}`);
  }
  // Grants must NOT be re-emitted -- the whole design rests on the existing ACL
  // surviving CREATE OR REPLACE, and a stray GRANT would mask a real regression.
  assert.ok(
    !/^\s*GRANT\s+EXECUTE/im.test(migration),
    'migration re-emits a GRANT EXECUTE; the ACL-preservation proof would be vacuous',
  );
  assert.equal(
    (migration.match(/CREATE OR REPLACE FUNCTION/g) || []).length,
    8,
    'expected exactly 8 CREATE OR REPLACE FUNCTION statements',
  );
  return migration;
}

/** The migration's postflight block, extracted so mutation tests can re-run it. */
function extractPostflight(migration) {
  const start = migration.indexOf('DO $postflight$');
  assert.ok(start > 0, 'could not locate the postflight block');
  const end = migration.indexOf('$postflight$;', start + 'DO $postflight$'.length);
  assert.ok(end > start, 'could not locate the end of the postflight block');
  return migration.slice(start, end + '$postflight$;'.length);
}

function startContainer() {
  assert.match(CONTAINER, /^[a-z0-9][a-z0-9_.-]+$/);
  docker([
    'run', '--detach', '--name', CONTAINER, '--network', 'none',
    '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=192m',
    '--env', 'POSTGRES_PASSWORD=disposable-only', 'postgres:17-alpine',
  ]);
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], { allowFailure: true }).status === 0) {
      return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new Error('disposable PostgreSQL container did not become ready');
}

/**
 * Minimum schema: the tables and sequences the eight bodies read, plus the
 * Supabase-shaped auth.uid() and the three API roles.
 */
function installMinimumSchema() {
  psql(`
CREATE EXTENSION pgcrypto;
CREATE SCHEMA auth;
CREATE ROLE anon;
CREATE ROLE authenticated;
CREATE ROLE service_role;

CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $fn$
  SELECT NULLIF(
    NULLIF(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
    ''
  )::uuid
$fn$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  role text NOT NULL CHECK (role IN ('admin','sales_rep','driver','applicator','entity_recipient')),
  is_active boolean NOT NULL
);

CREATE TABLE public.application_records (record_number text);
CREATE TABLE public.commission_payments (payment_number text);
CREATE TABLE public.cycle_counts (count_number text);
CREATE TABLE public.deliveries (delivery_number text);
CREATE TABLE public.invoices (invoice_number text);
CREATE TABLE public.jobs (job_number text);
CREATE TABLE public.purchase_orders (po_number text);
CREATE TABLE public.returns (return_number text);

CREATE SEQUENCE public.invoice_number_seq;
CREATE SEQUENCE public.cs_invoice_number_seq;
CREATE SEQUENCE public.mc_invoice_number_seq;
CREATE SEQUENCE public.cm_invoice_number_seq;

INSERT INTO public.profiles (id, role, is_active) VALUES
${Object.entries(PRINCIPALS)
  .map(([id, p]) => `  ('${id}', '${p.role}', ${p.active})`)
  .join(',\n')};
`);
}

/**
 * The eight generators exactly as they exist live TODAY -- no gate.
 *
 * These bodies are DERIVED from the migration under test, not hand-written:
 * each of its gated bodies has the gate stripped back out, and the remainder
 * must hash to the pinned live prosrc md5 BEFORE it is installed.
 *
 * An earlier revision hand-wrote them in a compressed style
 * (`DECLARE v_year text; v_max_num int;` collapsed onto one line). That was
 * semantically equivalent to live but NOT byte-identical, so this phase never
 * installed the live prosrc it claimed to -- the header above said "exactly as
 * they exist live TODAY" and the fixture said otherwise. Nothing caught it,
 * because the only md5 comparison ran on the POST-migration body (phase C2),
 * never on the fixture. It surfaced when the migration grew a preflight that
 * hashes the live body and the proof failed against its own fixture:
 * next_po_number found dccf50db155954f09f2c8b50851c2638, expected
 * c077318f1748f1d42c56c49439bfe985. Deriving removes the transcription, and
 * the assertion below is what makes the "identical to live" claim checkable
 * rather than merely stated.
 */
function preGateStatements() {
  const migration = readFileSync(MIGRATION, 'utf8');
  const statements = [];
  const failures = [];

  for (const name of GENERATORS) {
    const matches = migration.match(
      new RegExp(`CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]*?\\$function\\$;`, 'g'),
    );
    if (!matches || matches.length !== 1) {
      failures.push(
        `${name}: expected exactly 1 CREATE OR REPLACE in the migration, found ${matches ? matches.length : 0}`,
      );
      continue;
    }

    const ungated = matches[0].replace(GATE_RE, '').replace('  v_actor uuid;\n', '');
    if (ungated === matches[0]) {
      failures.push(`${name}: gate block not found, so the pre-gate body would still carry the gate`);
      continue;
    }

    const body = ungated.match(/AS \$function\$([\s\S]*)\$function\$;$/);
    if (!body) {
      failures.push(`${name}: could not extract the body from its CREATE statement`);
      continue;
    }

    // psql stores this text as prosrc verbatim, so trailing whitespace here
    // would put the installed body out of step with the normalized pin.
    const normalized = body[1].replace(/[ \t]+$/gm, '');
    if (normalized !== body[1]) {
      failures.push(`${name}: the migration's body carries trailing whitespace`);
      continue;
    }

    const md5 = createHash('md5').update(normalized, 'utf8').digest('hex');
    if (md5 !== LIVE_BODY_MD5[name]) {
      failures.push(`${name}: gate-stripped migration body md5 ${md5} != live ${LIVE_BODY_MD5[name]}`);
      continue;
    }

    statements.push(ungated);
  }

  assert.equal(
    failures.length,
    0,
    `could not derive the pre-gate bodies from the migration:\n${failures.join('\n')}`,
  );
  assert.equal(
    statements.length,
    GENERATORS.length,
    `derived ${statements.length} pre-gate bodies, expected ${GENERATORS.length}`,
  );
  return statements.join('\n\n');
}

/**
 * Installs those bodies with the live ACL. CREATE OR REPLACE in the migration
 * must preserve that ACL.
 */
function installPreGateGenerators() {
  psql(preGateStatements());

  // Reproduce the live ACL: EXECUTE to authenticated + service_role only.
  // `anon` is named explicitly -- REVOKE FROM PUBLIC alone does not clear an
  // explicit anon grant on the real project (see migration-history row 828).
  const revokes = GENERATORS.map((name) => {
    const sig = name === 'next_invoice_number' ? `${name}(text)` : `${name}()`;
    return `REVOKE ALL ON FUNCTION public.${sig} FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.${sig} TO authenticated, service_role;`;
  }).join('\n');
  psql(revokes);
}

/**
 * Put the database back into the true post-migration state after a mutation.
 *
 * Re-applying the migration alone no longer suffices. Its preflight refuses to
 * overwrite a body that is neither the reviewed pre-image nor already gated,
 * and several mutations leave exactly such a body behind -- one with the
 * `is_active` check dropped, one with a deliberately drifted regex. That
 * refusal is the preflight working, not a defect, so the restore resets each
 * generator to the verified pre-image FIRST and then applies the migration for
 * real, rather than routing around the check being proved.
 */
function restoreMigratedState() {
  psql(preGateStatements());
  psql(readFileSync(MIGRATION, 'utf8'));
}

function captureAcls() {
  const raw = query(`
SELECT p.proname || '|' || COALESCE(array_to_string(p.proacl, ','), '<null>')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[${GENERATORS.map((g) => `'${g}'`).join(',')}])
 ORDER BY p.proname;`);
  return raw.split('\n').filter(Boolean);
}

/** Calls one generator as one principal. Returns 'OK:<value>' or 'ERR:<code>'. */
function callAs(fnName, principalId) {
  const claims = principalId === null ? `''` : `'{"sub":"${principalId}"}'`;
  // Exactly ONE execution per probe: next_invoice_number has a real side effect
  // (nextval on an invoice sequence), so probing twice would double-count it and
  // could hide a sequence bug. NOTICEs arrive on stderr, so both streams are read.
  const res = psql(`
SET client_min_messages TO NOTICE;
DO $probe$
DECLARE v_result text;
BEGIN
  PERFORM set_config('request.jwt.claims', ${claims}, true);
  BEGIN
    EXECUTE 'SELECT public.${fnName}()' INTO v_result;
    RAISE NOTICE 'PROBE OK:%', v_result;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'PROBE ERR:%', SQLERRM;
  END;
END
$probe$;`, { allowFailure: true });
  const text = `${res.stdout || ''}\n${res.stderr || ''}`;
  const match = text.match(/PROBE (OK:[^\n\r]*|ERR:[^\n\r]*)/);
  assert.ok(match, `no probe result for ${fnName} as ${principalId}:\n${text}`);
  return match[1].trim();
}

const GATE_RE =
  /^ {2}v_actor := auth\.uid\(\);\n {2}IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;\n {2}IF NOT EXISTS \(\n {4}SELECT 1 FROM public\.profiles\n {5}WHERE id = v_actor\n {7}AND is_active = true\n {7}AND role IN \([^)]*\)\n {2}\) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;\n\n/m;

/**
 * Reads each applied body back out of the database, removes the gate this
 * migration added, and compares the remainder against the pinned live hash.
 * Returns a list of mismatch descriptions (empty when every body is faithful).
 */
function checkFidelity({ verbose = false } = {}) {
  const failures = [];
  for (const name of GENERATORS) {
    const b64 = query(`
SELECT replace(encode(convert_to(p.prosrc, 'UTF8'), 'base64'), E'\\n', '')
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = '${name}';`);
    const applied = Buffer.from(b64, 'base64').toString('utf8');

    if (!GATE_RE.test(applied)) {
      failures.push(`${name}: gate block not found in the applied body`);
      continue;
    }
    const stripped = applied
      .replace(GATE_RE, '')
      .replace('  v_actor uuid;\n', '')
      .replace(/[ \t]+$/gm, ''); // see LIVE_BODY_MD5 -- pins are normalized the same way
    const md5 = createHash('md5').update(stripped, 'utf8').digest('hex');

    if (md5 === LIVE_BODY_MD5[name]) {
      if (verbose) console.log(`  ${name.padEnd(32)} matches live (${md5})`);
    } else {
      failures.push(
        `${name}: stripped body md5 ${md5} != live ${LIVE_BODY_MD5[name]} (len ${stripped.length})`,
      );
    }
  }
  return failures;
}

function runMatrix(phase) {
  const rows = [];
  for (const fnName of GENERATORS) {
    for (const [id, p] of Object.entries(PRINCIPALS)) {
      rows.push({ fnName, id, label: p.label, role: p.role, active: p.active, result: callAs(fnName, id) });
    }
    rows.push({ fnName, id: null, label: 'no JWT (anonymous)', role: null, active: false, result: callAs(fnName, null) });
  }
  console.log(`\n--- ${phase} ---`);
  for (const r of rows) {
    console.log(`  ${r.fnName.padEnd(32)} ${r.label.padEnd(26)} ${r.result}`);
  }
  return rows;
}

try {
  const migration = assertInputs();
  const postflight = extractPostflight(migration);

  startContainer();
  installMinimumSchema();
  installPreGateGenerators();

  // ---- A. BEFORE: the hole is real and reproducible -----------------------
  const before = runMatrix('A. BEFORE the migration (current live behaviour)');
  for (const r of before) {
    if (r.id === null) continue;
    assert.ok(
      r.result.startsWith('OK:'),
      `BEFORE: expected ${r.label} to be able to call ${r.fnName} (that is the bug), got ${r.result}`,
    );
  }
  const deactivatedBefore = before.filter((r) => r.active === false && r.id !== null);
  assert.ok(deactivatedBefore.length > 0 && deactivatedBefore.every((r) => r.result.startsWith('OK:')));
  const recipientBefore = before.filter((r) => r.role === 'entity_recipient');
  assert.ok(recipientBefore.length === 8 && recipientBefore.every((r) => r.result.startsWith('OK:')));

  // The money-adjacent half: an unauthorized caller advances a real sequence.
  const seqBefore = query(`SELECT last_value FROM public.invoice_number_seq`);

  // ---- B + C. Apply, and prove the ACL survived ---------------------------
  const aclBefore = captureAcls();
  psql(migration); // includes the migration's own postflight assertions
  const aclAfter = captureAcls();

  // The migration now deliberately narrows six of the eight, so "byte-identical
  // ACLs" is the WRONG assertion -- it would fail on the intended change and,
  // worse, an earlier version of it would have passed while the revoke silently
  // did nothing. Assert the intended SHAPE per generator instead, in both
  // directions: the two the browser calls keep authenticated, the other six must
  // have lost it, none may hold anon, and all keep service_role.
  const aclFailures = [];
  for (const name of GENERATORS) {
    const before = aclBefore.find((l) => l.startsWith(`${name}|`));
    const after = aclAfter.find((l) => l.startsWith(`${name}|`));
    assert.ok(before && after, `no ACL captured for ${name}`);

    const keepsAuthenticated = name === 'next_cycle_count_number' || name === 'next_job_number';
    const hasAuth = /\bauthenticated=[^,]*X/.test(after);
    const hasAnon = /\banon=[^,]*X/.test(after);
    const hasService = /\bservice_role=[^,]*X/.test(after);

    if (keepsAuthenticated) {
      if (!hasAuth) aclFailures.push(`${name}: browser caller lost authenticated EXECUTE -- its screen would break\n  ${after}`);
      if (after !== before) aclFailures.push(`${name}: ACL changed but this generator must be untouched\n  before: ${before}\n  after:  ${after}`);
    } else {
      if (hasAuth) aclFailures.push(`${name}: authenticated still holds EXECUTE -- the revoke did not take\n  ${after}`);
      if (!/\bauthenticated=[^,]*X/.test(before)) {
        aclFailures.push(`${name}: authenticated did NOT hold EXECUTE before, so the revoke proves nothing here\n  before: ${before}`);
      }
    }
    if (hasAnon) aclFailures.push(`${name}: anon holds EXECUTE\n  ${after}`);
    if (!hasService) aclFailures.push(`${name}: service_role lost EXECUTE -- revoke was too broad\n  ${after}`);
  }
  assert.equal(aclFailures.length, 0, `ACL shape wrong after the migration:\n${aclFailures.join('\n')}`);

  console.log('\n--- C. ACL: kept for the 2 browser callers, revoked from the other 6 ---');
  for (const line of aclAfter) console.log(`  ${line}`);

  // ---- C2. FIDELITY: strip the gate back out, must equal the live body ----
  // Closes the "byte-for-byte from live" provenance gap. The repository cannot
  // show the state these were read from (five 2026-08-31 migrations are applied
  // live with no file here), so the live md5s are pinned above instead.
  console.log('\n--- C2. Fidelity vs live prosrc (gate stripped) ---');
  const fidelityFailures = checkFidelity({ verbose: true });
  assert.equal(
    fidelityFailures.length,
    0,
    `re-emitted bodies drift from live beyond the added gate:\n${fidelityFailures.join('\n')}`,
  );

  // ---- D. AFTER: the matrix matches the intended allow table --------------
  const after = runMatrix('D. AFTER the migration');
  const failures = [];
  for (const r of after) {
    const shouldAllow = r.id !== null && r.active === true && ALLOWED[r.fnName].includes(r.role);
    if (shouldAllow && !r.result.startsWith('OK:')) {
      failures.push(`${r.fnName} should ALLOW ${r.label} but got ${r.result}`);
    }
    if (!shouldAllow && !r.result.startsWith('ERR:')) {
      failures.push(`${r.fnName} should REFUSE ${r.label} but got ${r.result}`);
    }
    if (!shouldAllow && r.id === null && !/AUTH_REQUIRED/.test(r.result)) {
      failures.push(`${r.fnName} unauthenticated refusal should be AUTH_REQUIRED, got ${r.result}`);
    }
    if (!shouldAllow && r.id !== null && !/INSUFFICIENT_ROLE/.test(r.result)) {
      failures.push(`${r.fnName} refusal for ${r.label} should be INSUFFICIENT_ROLE, got ${r.result}`);
    }
  }
  assert.equal(failures.length, 0, `allow-matrix mismatches:\n${failures.join('\n')}`);

  // A refused caller must not have advanced the invoice sequence. ASSERT it.
  // An earlier revision only console.log'd these numbers, so the claim "the
  // sequence advanced for exactly the admitted callers" rested on a human
  // reading a log line rather than on an enforced check -- the documentation
  // outclaimed the test. Caught by adversarial review 2026-09-03.
  const seqAfterRefusals = query(`SELECT last_value FROM public.invoice_number_seq`);
  const admitted = after.filter((r) => r.fnName === 'next_invoice_number' && r.result.startsWith('OK:')).length;
  const seqDelta = Number(seqAfterRefusals) - Number(seqBefore);
  console.log(`\n--- invoice_number_seq: ${seqBefore} before -> ${seqAfterRefusals} after (${admitted} admitted callers) ---`);
  assert.ok(
    Number.isFinite(seqDelta),
    `invoice_number_seq did not read as a number: ${seqBefore} -> ${seqAfterRefusals}`,
  );
  // Guards against a vacuous pass: 0 admitted and 0 delta would otherwise agree.
  assert.ok(
    admitted > 0,
    'no caller was admitted to next_invoice_number, so the sequence assertion would prove nothing',
  );
  assert.equal(
    seqDelta,
    admitted,
    `invoice_number_seq advanced by ${seqDelta} but exactly ${admitted} callers were admitted — a refused caller advanced live invoice numbering`,
  );

  // ---- E. The real `authenticated` role can still execute -----------------
  const execCheck = query(`
SELECT string_agg(p.proname || '=' ||
         has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('anon', p.oid, 'EXECUTE')::text, ' ' ORDER BY p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[${GENERATORS.map((g) => `'${g}'`).join(',')}]);`);
  console.log(`\n--- E. EXECUTE authenticated/anon ---\n  ${execCheck}`);
  // Expect the NARROWED shape, not "all eight true". Written as an exact
  // expected string so a generator silently moving between the two groups fails
  // here rather than being absorbed by a looser predicate.
  const expectedExec = GENERATORS.map((g) => {
    const keeps = g === 'next_cycle_count_number' || g === 'next_job_number';
    return `${g}=${keeps ? 'true' : 'false'}/false`;
  }).join(' ');
  assert.equal(
    execCheck,
    expectedExec,
    `EXECUTE shape wrong (authenticated/anon per generator).\nexpected: ${expectedExec}\nactual:   ${execCheck}`,
  );
  assert.ok(!/\/true/.test(execCheck), `anon gained EXECUTE somewhere: ${execCheck}`);

  // A live browser call goes through the authenticated role, not superuser.
  const asAuthenticated = psql(`
SET client_min_messages TO NOTICE;
DO $probe$
DECLARE v_result text;
BEGIN
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001"}', true);
  SET LOCAL ROLE authenticated;
  EXECUTE 'SELECT public.next_cycle_count_number()' INTO v_result;
  RAISE NOTICE 'AS_AUTHENTICATED:%', v_result;
END
$probe$;`, { allowFailure: true });
  const authText = `${asAuthenticated.stdout || ''}\n${asAuthenticated.stderr || ''}`;
  assert.match(authText, /AS_AUTHENTICATED:CC-\d{4}-\d{5}/, `browser-shaped call failed:\n${authText}`);
  console.log(`  ${authText.match(/AS_AUTHENTICATED:[^\n\r]*/)[0]} (role=authenticated, as CycleCounts.tsx does)`);

  // The driver hole, proven closed at the grant layer rather than argued. An
  // active driver passes the in-body role gate on next_invoice_number -- that is
  // deliberate, because auto-invoice on their assigned delivery needs it -- so
  // the ONLY thing stopping a driver advancing invoice sequences by direct RPC
  // is that `authenticated` can no longer execute it at all. Assert the refusal
  // is a privilege error, not the gate: the gate would have let this through.
  const deniedDirect = psql(`
SET client_min_messages TO NOTICE;
DO $probe$
DECLARE v_result text;
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claims', '{"sub":"${PRINCIPALS.driver}"}', true);
  BEGIN
    EXECUTE 'SELECT public.next_invoice_number(''chemical_sale'')' INTO v_result;
    RAISE NOTICE 'DIRECT_CALL OK:%', v_result;
  EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'DIRECT_CALL ERR:%', SQLERRM;
  END;
END
$probe$;`, { allowFailure: true });
  const deniedText = `${deniedDirect.stdout || ''}\n${deniedDirect.stderr || ''}`;
  assert.match(
    deniedText,
    /DIRECT_CALL ERR:[^\n\r]*permission denied/i,
    `an active driver could still call next_invoice_number directly as authenticated -- the revoke is not holding:\n${deniedText}`,
  );
  console.log(`  ${deniedText.match(/DIRECT_CALL [^\n\r]*/)[0]} (active driver, direct call — refused by privilege)`);

  // ---- F. Mutation tests: each guard must actually fire -------------------
  console.log('\n--- F. Mutation tests (each postflight guard must fire) ---');
  const mutations = [
    {
      // Targets a BROWSER caller. It used to target next_po_number, but that
      // generator now legitimately has authenticated revoked, so the old form
      // asserted a state the migration itself creates and would never fire.
      name: 'a browser caller loses EXECUTE',
      setup: `REVOKE EXECUTE ON FUNCTION public.next_cycle_count_number() FROM authenticated;`,
      undo: `GRANT EXECUTE ON FUNCTION public.next_cycle_count_number() TO authenticated;`,
      expect: /authenticated lost EXECUTE on next_cycle_count_number/,
    },
    {
      // The other direction, and the one that matters for the driver hole: if
      // the revoke silently fails to take, the postflight must say so instead of
      // reporting success over a still-callable generator.
      name: 'a non-browser generator keeps direct EXECUTE',
      setup: `GRANT EXECUTE ON FUNCTION public.next_invoice_number(text) TO authenticated;`,
      undo: `REVOKE EXECUTE ON FUNCTION public.next_invoice_number(text) FROM authenticated;`,
      expect: /authenticated still holds EXECUTE on next_invoice_number/,
    },
    {
      name: 'service_role loses EXECUTE',
      setup: `REVOKE EXECUTE ON FUNCTION public.next_po_number() FROM service_role;`,
      undo: `GRANT EXECUTE ON FUNCTION public.next_po_number() TO service_role;`,
      expect: /service_role lost EXECUTE/,
    },
    {
      name: 'anon gains EXECUTE',
      setup: `GRANT EXECUTE ON FUNCTION public.next_return_number() TO anon;`,
      undo: `REVOKE EXECUTE ON FUNCTION public.next_return_number() FROM anon;`,
      expect: /anon must not hold EXECUTE/,
    },
    {
      name: 'a second overload appears',
      setup: `CREATE FUNCTION public.next_po_number(p_x int) RETURNS text
              LANGUAGE sql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$ SELECT 'x' $m$;`,
      undo: `DROP FUNCTION public.next_po_number(int);`,
      expect: /expected exactly 1 public.next_po_number, found 2/,
    },
    {
      name: 'search_path is dropped',
      setup: `ALTER FUNCTION public.next_job_number() RESET search_path;`,
      undo: `ALTER FUNCTION public.next_job_number() SET search_path TO 'public', 'pg_temp';`,
      expect: /must SET search_path/,
    },
    {
      name: 'SECURITY DEFINER is dropped',
      setup: `ALTER FUNCTION public.next_delivery_number() SECURITY INVOKER;`,
      undo: `ALTER FUNCTION public.next_delivery_number() SECURITY DEFINER;`,
      expect: /must remain SECURITY DEFINER/,
    },
    {
      name: 'the role gate is removed from a body',
      setup: `CREATE OR REPLACE FUNCTION public.next_return_number() RETURNS text
              LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
              BEGIN PERFORM pg_advisory_xact_lock(1); RETURN 'RMA-0000-0001'; END $m$;`,
      undo: null, // restored by re-applying the migration below
      expect: /missing the AUTH_REQUIRED gate/,
    },
    {
      name: 'the gate is placed after the advisory lock',
      setup: `CREATE OR REPLACE FUNCTION public.next_po_number() RETURNS text
              LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
              DECLARE v_actor uuid;
              BEGIN
                PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));
                v_actor := auth.uid();
                IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
                IF NOT EXISTS (SELECT 1 FROM public.profiles
                   WHERE id = v_actor AND is_active = true AND role IN ('admin')) THEN
                  RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
                RETURN 'PO-0000-0001';
              END $m$;`,
      undo: null,
      expect: /gates after its advisory lock/,
    },
    {
      name: 'entity_recipient is admitted',
      setup: `CREATE OR REPLACE FUNCTION public.next_job_number() RETURNS text
              LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
              DECLARE v_actor uuid;
              BEGIN
                v_actor := auth.uid();
                IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
                IF NOT EXISTS (SELECT 1 FROM public.profiles
                   WHERE id = v_actor AND is_active = true
                     AND role IN ('admin','entity_recipient')) THEN
                  RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
                PERFORM pg_advisory_xact_lock(hashtext('next_job_number'));
                RETURN 'JOB-0000-0001';
              END $m$;`,
      undo: null,
      expect: /must not admit entity_recipient/,
    },
    {
      name: 'the active-profile check is dropped',
      setup: `CREATE OR REPLACE FUNCTION public.next_cycle_count_number() RETURNS text
              LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
              DECLARE v_actor uuid;
              BEGIN
                v_actor := auth.uid();
                IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
                IF NOT EXISTS (SELECT 1 FROM public.profiles
                   WHERE id = v_actor AND role IN ('admin')) THEN
                  RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
                PERFORM pg_advisory_xact_lock(8675309);
                RETURN 'CC-0000-00001';
              END $m$;`,
      undo: null,
      expect: /missing the active-profile check/,
    },
  ];

  for (const m of mutations) {
    psql(m.setup);
    const res = psql(postflight, { allowFailure: true });
    const text = `${res.stdout || ''}\n${res.stderr || ''}`;
    assert.notEqual(res.status, 0, `MUTATION NOT CAUGHT: "${m.name}" -- postflight passed anyway`);
    assert.match(text, m.expect, `MUTATION "${m.name}" caught, but by the wrong assertion:\n${text}`);
    console.log(`  caught: ${m.name}`);
    if (m.undo) psql(m.undo);
    else restoreMigratedState();
  }

  // The advisory lock disappearing entirely must be caught by its own check,
  // not silently absorbed by the ordering comparison's position()=0 degradation.
  psql(`CREATE OR REPLACE FUNCTION public.next_delivery_number() RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
        DECLARE v_actor uuid;
        BEGIN
          v_actor := auth.uid();
          IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
          IF NOT EXISTS (SELECT 1 FROM public.profiles
             WHERE id = v_actor AND is_active = true AND role IN ('admin')) THEN
            RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
          RETURN 'DEL-00001';
        END $m$;`);
  const lockGone = psql(postflight, { allowFailure: true });
  assert.notEqual(lockGone.status, 0, 'MUTATION NOT CAUGHT: advisory lock removed entirely');
  assert.match(
    `${lockGone.stdout || ''}\n${lockGone.stderr || ''}`,
    /lost its advisory lock/,
    'lock-removal was caught by the wrong assertion',
  );
  console.log('  caught: the advisory lock is removed entirely');
  restoreMigratedState();

  // The fidelity pin must be able to fail. Change one regex inside a body and
  // require checkFidelity() to name that function -- otherwise the pin is
  // decorative and would not catch a silently reverted upstream fix.
  psql(`CREATE OR REPLACE FUNCTION public.next_po_number() RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
        DECLARE
  v_actor uuid;
  v_year text;
  v_max_num int;
  v_next text;
BEGIN
  v_actor := auth.uid();
  IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
     WHERE id = v_actor
       AND is_active = true
       AND role IN ('admin', 'sales_rep')
  ) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;

  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));
  SELECT COALESCE(MAX(CASE WHEN po_number ~ ('^PO-' || v_year || '-[0-9]+$')
    THEN CAST(split_part(po_number, '-', 3) AS int) ELSE 0 END), 0)
  INTO v_max_num FROM purchase_orders;
  v_next := 'PO-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END $m$;`);
  const drifted = checkFidelity();
  assert.ok(
    drifted.some((f) => f.startsWith('next_po_number:')),
    `MUTATION NOT CAUGHT: a changed body passed the fidelity pin. Reported: ${JSON.stringify(drifted)}`,
  );
  console.log('  caught: a body silently drifting from the live definition');
  restoreMigratedState();

  // The PREFLIGHT must be able to REFUSE. Drift a body away from its pin and
  // require the migration itself to abort. Without this the preflight is
  // decorative -- it would report "all eight match" forever and nobody would
  // know, which is precisely the failure it was added to prevent. The mutated
  // body deliberately carries none of AUTH_REQUIRED / INSUFFICIENT_ROLE /
  // is_active, so it cannot slip through the already-gated branch instead.
  psql(`CREATE OR REPLACE FUNCTION public.next_return_number() RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
        DECLARE v_year text; v_max_num int; v_next text;
        BEGIN
          v_year := extract(year FROM current_date)::text;
          PERFORM pg_advisory_xact_lock(hashtext('next_return_number'));
          SELECT 0 INTO v_max_num;
          v_next := 'RMA-' || v_year || '-' || lpad((v_max_num + 7)::text, 4, '0');
          RETURN v_next;
        END $m$;`);
  const refused = psql(readFileSync(MIGRATION, 'utf8'), { allowFailure: true });
  assert.notEqual(
    refused.status,
    0,
    'MUTATION NOT CAUGHT: the migration overwrote a body that had drifted from its pin',
  );
  assert.match(
    `${refused.stdout || ''}\n${refused.stderr || ''}`,
    /PREFLIGHT: public\.next_return_number matches none of the three accepted bodies/,
    'the drifted body was refused, but not by the preflight',
  );
  console.log('  caught: the preflight refuses to overwrite a drifted body');
  restoreMigratedState();

  // The preflight's re-apply branch must NOT be satisfiable by a body that
  // merely LOOKS gated. This body carries AUTH_REQUIRED, INSUFFICIENT_ROLE and
  // `is_active = true` -- it would have passed the original token test -- but it
  // is a DIFFERENT gate (admits applicator on next_po_number). If the preflight
  // accepted it, re-running this migration would silently revert a later
  // deliberate widening, which is the exact regression the exact-hash branch
  // was introduced to prevent.
  psql(`CREATE OR REPLACE FUNCTION public.next_po_number() RETURNS text
        LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $m$
        DECLARE v_actor uuid; v_year text; v_next text;
        BEGIN
          v_actor := auth.uid();
          IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
          IF NOT EXISTS (SELECT 1 FROM public.profiles
             WHERE id = v_actor AND is_active = true
               AND role IN ('admin','sales_rep','applicator')) THEN
            RAISE EXCEPTION 'INSUFFICIENT_ROLE'; END IF;
          PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));
          v_year := extract(year FROM current_date)::text;
          v_next := 'PO-' || v_year || '-9999';
          RETURN v_next;
        END $m$;`);
  const lookalike = psql(readFileSync(MIGRATION, 'utf8'), { allowFailure: true });
  assert.notEqual(
    lookalike.status,
    0,
    'MUTATION NOT CAUGHT: the preflight accepted a different gate as "already gated" and would have reverted it',
  );
  assert.match(
    `${lookalike.stdout || ''}\n${lookalike.stderr || ''}`,
    /PREFLIGHT: public\.next_po_number matches none of the three accepted bodies/,
    'the look-alike gated body was refused, but not by the preflight',
  );
  console.log('  caught: a DIFFERENT gate is not accepted as "already applied"');
  restoreMigratedState();

  // The re-apply branch must actually ACCEPT the body this migration installs.
  // Without this the post-image pins could be wrong in the safe direction and
  // nothing would say so: every apply would abort with "neither the reviewed
  // pre-image nor the body this migration installs", and the failure would only
  // ever be discovered by an operator mid-apply. Bodies are post-image here
  // because restoreMigratedState() just applied the migration.
  const reapply = psql(readFileSync(MIGRATION, 'utf8'), { allowFailure: true });
  assert.equal(
    reapply.status,
    0,
    `re-applying the migration over its own output failed -- the post-image pins are wrong:\n${reapply.stdout || ''}\n${reapply.stderr || ''}`,
  );
  assert.match(
    `${reapply.stdout || ''}\n${reapply.stderr || ''}`,
    /already carries exactly this migration body/,
    'the re-apply succeeded but not through the exact-post-image branch',
  );
  console.log('  verified: re-applying over this migration own output is a no-op');
  assert.deepEqual(checkFidelity(), [], 'fidelity must still be clean after a re-apply');

  // Clean state must still pass, so the mutations above are not a false green.
  psql(postflight);
  assert.deepEqual(checkFidelity(), [], 'fidelity must be clean again after restoring the migration');
  console.log('  clean postflight and fidelity still pass after all mutations');

  console.log('\nNUMBER_GENERATOR_GATE_PROOF_PASS');
} finally {
  if (CONTAINER.startsWith(PREFIX)) {
    docker(['rm', '--force', CONTAINER], { allowFailure: true });
  }
}
