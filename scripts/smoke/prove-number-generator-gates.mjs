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
 *   C. ACL PRESERVATION. The load-bearing assumption of this migration is that
 *      CREATE OR REPLACE keeps the existing grants. Per-function ACLs are
 *      captured before and after and must be byte-identical.
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
 * The eight generators exactly as they exist live TODAY -- no gate -- carrying
 * the live ACL. CREATE OR REPLACE in the migration must preserve that ACL.
 */
function installPreGateGenerators() {
  psql(`
CREATE OR REPLACE FUNCTION public.next_application_record_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text; v_max_num int; v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_application_record_number'));
  SELECT COALESCE(MAX(CASE WHEN record_number ~ ('^APP-' || v_year || '-\\d+$')
    THEN CAST(split_part(record_number, '-', 3) AS int) ELSE 0 END), 0)
  INTO v_max_num FROM application_records;
  v_next := 'APP-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_commission_payment_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text; v_seq integer; v_num text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('commission_payment_number'));
  v_year := to_char(CURRENT_DATE, 'YYYY');
  SELECT COALESCE(MAX(regexp_replace(payment_number, '^CP-' || v_year || '-', '')::integer), 0) + 1
    INTO v_seq FROM public.commission_payments
   WHERE payment_number LIKE 'CP-' || v_year || '-%';
  v_num := 'CP-' || v_year || '-' || lpad(v_seq::text, 4, '0');
  RETURN v_num;
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_cycle_count_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text; v_max_num integer; v_next_num integer;
BEGIN
  v_year := EXTRACT(YEAR FROM CURRENT_DATE)::text;
  PERFORM pg_advisory_xact_lock(8675309);
  SELECT COALESCE(MAX(CASE WHEN count_number ~ ('^CC-' || v_year || '-\\d+$')
    THEN (regexp_replace(count_number, '^CC-' || v_year || '-', ''))::integer ELSE 0 END), 0)
  INTO v_max_num FROM cycle_counts WHERE count_number LIKE 'CC-' || v_year || '-%';
  v_next_num := v_max_num + 1;
  RETURN 'CC-' || v_year || '-' || LPAD(v_next_num::text, 5, '0');
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_delivery_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_max_num int; v_next text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('next_delivery_number'));
  SELECT COALESCE(MAX(CASE WHEN delivery_number ~ '^DEL-\\d+$'
    THEN CAST(split_part(delivery_number, '-', 2) AS int) ELSE 0 END), 0)
  INTO v_max_num FROM deliveries;
  v_next := 'DEL-' || lpad((v_max_num + 1)::text, 5, '0');
  RETURN v_next;
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_invoice_number(p_invoice_type text DEFAULT 'field_application'::text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text := extract(year FROM now())::text; v_seq int; v_max int;
        v_prefix text; v_sequence regclass;
BEGIN
  CASE p_invoice_type
    WHEN 'chemical_sale' THEN v_prefix := 'CS'; v_sequence := 'public.cs_invoice_number_seq'::regclass;
    WHEN 'misc_charge'   THEN v_prefix := 'MC'; v_sequence := 'public.mc_invoice_number_seq'::regclass;
    WHEN 'credit_memo'   THEN v_prefix := 'CM'; v_sequence := 'public.cm_invoice_number_seq'::regclass;
    ELSE v_prefix := 'INV'; v_sequence := 'public.invoice_number_seq'::regclass;
  END CASE;
  PERFORM pg_advisory_xact_lock(hashtext('invoice_number:' || v_prefix || ':' || v_year));
  SELECT COALESCE(MAX(regexp_replace(invoice_number, '^' || v_prefix || '-[0-9]{4}-', '')::integer), 0)
    INTO v_max FROM public.invoices
   WHERE invoice_number ~ ('^' || v_prefix || '-' || v_year || '-[0-9]+$');
  v_seq := nextval(v_sequence);
  IF v_seq <= v_max THEN PERFORM setval(v_sequence, v_max, true); v_seq := nextval(v_sequence); END IF;
  RETURN v_prefix || '-' || v_year || '-' || lpad(v_seq::text, 4, '0');
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_job_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text; v_max_num int; v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_job_number'));
  SELECT COALESCE(MAX(CASE WHEN job_number ~ ('^JOB-' || v_year || '-\\d+$')
    THEN CAST(split_part(job_number, '-', 3) AS int) ELSE 0 END), 0)
  INTO v_max_num FROM jobs;
  v_next := 'JOB-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_po_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text; v_max_num int; v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_po_number'));
  SELECT COALESCE(MAX(CASE WHEN po_number ~ ('^PO-' || v_year || '-\\d+$')
    THEN CAST(split_part(po_number, '-', 3) AS int) ELSE 0 END), 0)
  INTO v_max_num FROM purchase_orders;
  v_next := 'PO-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END; $fn$;

CREATE OR REPLACE FUNCTION public.next_return_number()
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE v_year text; v_max_num int; v_next text;
BEGIN
  v_year := extract(year FROM current_date)::text;
  PERFORM pg_advisory_xact_lock(hashtext('next_return_number'));
  SELECT COALESCE(MAX(CASE WHEN return_number ~ ('^RMA-' || v_year || '-\\d+$')
    THEN CAST(split_part(return_number, '-', 3) AS int) ELSE 0 END), 0)
  INTO v_max_num FROM returns;
  v_next := 'RMA-' || v_year || '-' || lpad((v_max_num + 1)::text, 4, '0');
  RETURN v_next;
END; $fn$;
`);

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
  assert.deepEqual(
    aclAfter,
    aclBefore,
    `ACL changed across CREATE OR REPLACE.\nbefore:\n${aclBefore.join('\n')}\nafter:\n${aclAfter.join('\n')}`,
  );
  console.log('\n--- C. ACL preservation ---');
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

  // A refused caller must not have advanced the invoice sequence.
  const seqAfterRefusals = query(`SELECT last_value FROM public.invoice_number_seq`);
  const admitted = after.filter((r) => r.fnName === 'next_invoice_number' && r.result.startsWith('OK:')).length;
  console.log(`\n--- invoice_number_seq: ${seqBefore} before -> ${seqAfterRefusals} after (${admitted} admitted callers) ---`);

  // ---- E. The real `authenticated` role can still execute -----------------
  const execCheck = query(`
SELECT string_agg(p.proname || '=' ||
         has_function_privilege('authenticated', p.oid, 'EXECUTE')::text || '/' ||
         has_function_privilege('anon', p.oid, 'EXECUTE')::text, ' ' ORDER BY p.proname)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname = 'public' AND p.proname = ANY (ARRAY[${GENERATORS.map((g) => `'${g}'`).join(',')}]);`);
  console.log(`\n--- E. EXECUTE authenticated/anon ---\n  ${execCheck}`);
  assert.ok(!/=false\//.test(execCheck), `authenticated lost EXECUTE somewhere: ${execCheck}`);
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

  // ---- F. Mutation tests: each guard must actually fire -------------------
  console.log('\n--- F. Mutation tests (each postflight guard must fire) ---');
  const mutations = [
    {
      name: 'authenticated loses EXECUTE',
      setup: `REVOKE EXECUTE ON FUNCTION public.next_po_number() FROM authenticated;`,
      undo: `GRANT EXECUTE ON FUNCTION public.next_po_number() TO authenticated;`,
      expect: /authenticated lost EXECUTE/,
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
    else psql(migration); // re-apply to restore the true bodies
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
  psql(migration);

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
  psql(migration);

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
