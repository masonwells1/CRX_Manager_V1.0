#!/usr/bin/env node
// Behavioural proof for the GENERIC_FIELD_CUTOVER_ACTIVE_RECEIPTS gate in
// supabase/migrations/20260914101300_finish_generic_field_invoice_cutover.sql (phase 2).
//
// WHY THIS EXISTS. The gate originally refused phase 2 while ANY unexpired `save_invoice` receipt
// existed. Only the field-application branch of `save_invoice` changes in that migration, receipts
// live 24h (`idempotency_keys.expires_at` DEFAULT `now() + interval '24 hours'`), and the generic
// invoice editor saves chemical-sale and miscellaneous-charge invoices continuously on a working
// system -- so that form required a 24-hour freeze on ALL invoice saving and in practice left
// phase 2 unappliable. Row 934 of docs/reference/migration-history.md records the same stranding
// hazard. It was narrowed on 2026-09-23 (CodeRabbit Major on PR #786) to receipts that could
// replay a field-application save.
//
// This is NOT the quiet-window scan. Row 933 forbids narrowing THAT gate (`pg_stat_activity`,
// which proves in-flight old-body REQUESTS have drained and still counts every backend type).
// This one is about COMMITTED retries. The two must not be conflated.
//
// WHAT IT PROVES. The gate predicate is EXTRACTED VERBATIM from the migration file rather than
// retyped here, so the proof cannot drift away from what would actually apply. It is run beside
// the previous form against the same fixtures, in a disposable networkless postgres:17-alpine:
//   * behaviour differs on EXACTLY the cases whose only still-valid receipts resolve to a live
//     invoice of another type, and
//   * every fail-closed case still refuses -- a receipt whose invoice_id is absent, malformed or
//     no longer resolvable, and a NULL-expiry FIELD receipt.
// A narrowing that let an unidentifiable receipt past, or that stopped refusing for field
// receipts, fails this prover.
//
// Run: node scripts/smoke/prove-generic-field-cutover-receipt-gate.mjs
// Ends in RECEIPT_GATE_NARROWING_PROOF_PASS.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = path.join(
  ROOT, 'supabase', 'migrations', '20260914101300_finish_generic_field_invoice_cutover.sql',
);
const CONTAINER = 'crx-generic-field-cutover-receipt-gate';
const IMAGE = 'postgres:17-alpine';

const docker = (args, opts = {}) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts });

const psql = (sql) => docker(
  ['exec', '-i', CONTAINER, 'psql', '-U', 'postgres', '-d', 'postgres',
    '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-f', '-'],
  { input: sql },
);

// ---- The gate predicate, read out of the migration itself --------------------------------------
const sqlText = readFileSync(MIGRATION, 'utf8');
const extracted = sqlText.match(
  /IF v_body = '82c68c993dcff32eabd7b70c70f11527' AND EXISTS \(\r?\n([\s\S]*?)\r?\n {2}\) THEN\r?\n\s*RAISE EXCEPTION 'GENERIC_FIELD_CUTOVER_ACTIVE_RECEIPTS/,
);
assert(extracted, 'could not extract the receipt gate from the migration; did its shape change?');
const NEW_PREDICATE = extracted[1].replace(/\r/g, '');
assert(NEW_PREDICATE.includes('LEFT JOIN public.invoices'),
  'extracted gate does not resolve receipts against invoices');
assert(NEW_PREDICATE.includes("i.invoice_type = 'field_application'"),
  'extracted gate lost its invoice_type test');
assert(NEW_PREDICATE.includes('i.id IS NULL'),
  'extracted gate lost its fail-closed unresolved-receipt branch');
assert(NEW_PREDICATE.includes('k.expires_at IS NULL'),
  'extracted gate lost its NULL-expiry branch');

// The form this replaced, retained as the differential baseline.
const OLD_PREDICATE = `    SELECT 1 FROM public.idempotency_keys WHERE operation = 'save_invoice'
      AND (expires_at IS NULL OR expires_at >= transaction_timestamp())`;

const FIELD_ID = '11111111-1111-4111-8111-111111111111';
const CHEM_ID = '22222222-2222-4222-8222-222222222222';
const GONE_ID = '33333333-3333-4333-8333-333333333333';

const receipt = (key, invoiceId, expiry) => 'INSERT INTO public.idempotency_keys '
  + `(idempotency_key, operation, result, expires_at) VALUES ('${key}', 'save_invoice', `
  + `${invoiceId === null ? 'NULL' : `'{"invoice_id": "${invoiceId}", "is_new": true}'::jsonb`}, `
  + `${expiry});`;

// label, fixture, expected OLD verdict, expected NEW verdict, differs?
const CASES = [
  ['unexpired FIELD receipt', receipt('a', FIELD_ID, "now() + interval '1 hour'"), 'BLOCK', 'BLOCK'],
  ['unexpired CHEMICAL receipt', receipt('b', CHEM_ID, "now() + interval '1 hour'"), 'BLOCK', 'ALLOW'],
  ['NULL-expiry FIELD receipt', receipt('c', FIELD_ID, 'NULL'), 'BLOCK', 'BLOCK'],
  ['NULL-expiry CHEMICAL receipt', receipt('d', CHEM_ID, 'NULL'), 'BLOCK', 'ALLOW'],
  ['EXPIRED field receipt', receipt('e', FIELD_ID, "now() - interval '1 hour'"), 'ALLOW', 'ALLOW'],
  ['unexpired receipt, DANGLING invoice_id', receipt('f', GONE_ID, "now() + interval '1 hour'"), 'BLOCK', 'BLOCK'],
  ['unexpired receipt, NULL result', receipt('g', null, "now() + interval '1 hour'"), 'BLOCK', 'BLOCK'],
  ['unexpired receipt, MALFORMED invoice_id',
    "INSERT INTO public.idempotency_keys (idempotency_key, operation, result, expires_at) VALUES "
    + "('h', 'save_invoice', '{\"invoice_id\": \"not-a-uuid\"}'::jsonb, now() + interval '1 hour');",
    'BLOCK', 'BLOCK'],
  ['no receipts at all', 'SELECT 1;', 'ALLOW', 'ALLOW'],
  ['CHEMICAL unexpired + FIELD expired',
    receipt('i', CHEM_ID, "now() + interval '1 hour'") + receipt('j', FIELD_ID, "now() - interval '1 hour'"),
    'BLOCK', 'ALLOW'],
  ['CHEMICAL unexpired + FIELD unexpired',
    receipt('k', CHEM_ID, "now() + interval '1 hour'") + receipt('l', FIELD_ID, "now() + interval '1 hour'"),
    'BLOCK', 'BLOCK'],
];

// Exactly the fixtures whose only still-valid receipts resolve to a live NON-field invoice.
const EXPECTED_DIFFERENCES = 3;

try { docker(['rm', '-f', CONTAINER]); } catch { /* not running */ }
docker(['run', '--detach', '--name', CONTAINER, '--network', 'none',
  '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=128m',
  '--env', 'POSTGRES_PASSWORD=disposable-only', IMAGE]);

try {
  // Readiness: the init log line, then pg_isready, then a real SELECT that returns a row.
  let ready = false;
  for (let i = 0; i < 180; i += 1) {
    try {
      if (docker(['logs', CONTAINER]).includes('database system is ready to accept connections')) {
        docker(['exec', CONTAINER, 'pg_isready', '-h', '127.0.0.1']);
        if (psql('SELECT 1;').trim() === '1') { ready = true; break; }
      }
    } catch { /* keep waiting */ }
    execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 500)']);
  }
  assert(ready, `${CONTAINER} never became ready`);
  console.log(`container ready on ${IMAGE} (server_version ${psql('SHOW server_version;').trim()})`);
  console.log(`gate predicate extracted from ${path.basename(MIGRATION)}:`);
  console.log(NEW_PREDICATE);

  // Minimal real shape: only the two tables the gate touches, with the real expiry default.
  psql(`
    CREATE TABLE public.invoices (id uuid PRIMARY KEY, invoice_type text NOT NULL);
    CREATE TABLE public.idempotency_keys (
      idempotency_key text PRIMARY KEY,
      operation text NOT NULL,
      result jsonb,
      expires_at timestamptz DEFAULT now() + interval '24 hours'
    );
    INSERT INTO public.invoices (id, invoice_type)
      VALUES ('${FIELD_ID}', 'field_application'), ('${CHEM_ID}', 'chemical_sale');
  `);

  // The gate RAISEs when its EXISTS(...) is true, so EXISTS is the verdict.
  const blocks = (predicate, setupSql) => {
    psql('TRUNCATE public.idempotency_keys;');
    psql(setupSql);
    const verdict = psql(`SELECT EXISTS (\n${predicate}\n);`).trim();
    assert(verdict === 't' || verdict === 'f', `no verdict from probe: ${JSON.stringify(verdict)}`);
    return verdict === 't';
  };

  console.log(`\n${'case'.padEnd(42)} ${'OLD'.padEnd(7)} ${'NEW'.padEnd(7)} result`);
  let differences = 0;
  let failures = 0;
  for (const [label, fixture, expectOld, expectNew] of CASES) {
    const gotOld = blocks(OLD_PREDICATE, fixture) ? 'BLOCK' : 'ALLOW';
    const gotNew = blocks(NEW_PREDICATE, fixture) ? 'BLOCK' : 'ALLOW';
    const ok = gotOld === expectOld && gotNew === expectNew;
    if (!ok) failures += 1;
    if (gotOld !== gotNew) differences += 1;
    console.log(`${label.padEnd(42)} ${gotOld.padEnd(7)} ${gotNew.padEnd(7)} `
      + `${ok ? 'as expected' : `MISMATCH expected ${expectOld}/${expectNew}`}`);
  }

  assert.strictEqual(failures, 0, `${failures} case(s) did not match the expected behaviour`);
  assert.strictEqual(differences, EXPECTED_DIFFERENCES,
    `expected exactly ${EXPECTED_DIFFERENCES} behaviour changes, saw ${differences}`);

  // Independent restatement of the safety property, asserted rather than narrated.
  for (const [label, fixture, , expectNew] of CASES) {
    if (/DANGLING|NULL result|MALFORMED|NULL-expiry FIELD|unexpired FIELD/.test(label)) {
      assert.strictEqual(expectNew, 'BLOCK', `${label} must still refuse`);
    }
  }

  console.log(`\nBehaviour changed on exactly the ${EXPECTED_DIFFERENCES} cases whose only still-valid`);
  console.log('receipts resolve to a live non-field invoice. Unidentifiable receipts (dangling,');
  console.log('NULL result, malformed id) and every field receipt still refuse.');
  console.log('\nRECEIPT_GATE_NARROWING_PROOF_PASS');
} finally {
  try { docker(['rm', '-f', CONTAINER]); } catch { /* already gone */ }
}
