#!/usr/bin/env node
/**
 * Full-chain proof for the parked 20260921180000 soft_delete_customer_document
 * candidate (a sales rep cannot remove a customer document).
 *
 * Builds the checked-in 2026-07-27 production schema baseline in a
 * network-disabled Supabase PostgreSQL 17 container, replays every ordered
 * post-baseline migration that is applied live (the still-parked commission
 * files are skipped), then, using the REAL customer_documents policies,
 * guard trigger and idempotency helpers (no stand-ins), as the `authenticated`
 * role exactly like a browser session through PostgREST:
 *   1. THE BUG, BEFORE: an assigned, active sales rep's direct soft-delete
 *      UPDATE (the old page code) is refused by row-level security, with and
 *      without RETURNING, while an admin's succeeds;
 *   2. the candidate applies;
 *   3. THE FIX: the same rep removes the document through the function; the
 *      row carries deleted_at and deleted_by = the rep, and the receipt is
 *      bound to the rep and the document;
 *   4. the same key replays the same result without touching the row again;
 *      the same key on a different document is IDEMPOTENCY_INTENT_MISMATCH and
 *      another rep holding the key is IDEMPOTENCY_ACTOR_MISMATCH;
 *   5. NOBODY GAINS ACCESS: an unassigned rep, a removed document, and a
 *      missing document are the same CUSTOMER_DOCUMENT_NOT_FOUND; a driver and
 *      a deactivated rep are INSUFFICIENT_ROLE; a blank or 256-character key
 *      is refused; anon and service_role cannot execute the function; the rep
 *      still cannot see the removed row, and the rep's direct soft-delete
 *      UPDATE is still refused (no policy changed);
 *   5b. LOCKS: with another session holding the rep's profile row, or the
 *      customer row, the removal waits (lock timeout) and changes nothing;
 *   6. an admin can remove a document of any customer;
 *   7. the candidate re-applies cleanly, and an extra grantee (metabase_ro)
 *      makes the re-apply fail its exact-ACL postflight;
 *   8. MUTATION: with the assignment test removed from the body, step 5's
 *      unassigned-rep refusal fails — so that assertion really tests the check.
 */
import assert from 'node:assert/strict';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NAME = `crx-customer-doc-delete-${process.pid}-${Date.now().toString(36)}`;
const IMAGE = 'public.ecr.aws/supabase/postgres:17.6.1.143';
const BASELINE = path.join(ROOT, 'supabase', 'baselines');
const CANDIDATE = path.join(ROOT, 'supabase', 'migrations', '20260921180000_soft_delete_customer_document_rpc.sql');
const SIG = 'public.soft_delete_customer_document(uuid,uuid,text)';
const SMOKE_CHAIN = path.join(ROOT, 'scripts', 'smoke', 'smoke-customer-document-rep-soft-delete.sql');

// Written but not applied live on 2026-09-21 (a read-only ledger check by
// name found every other file before the candidate applied, including
// 20260914100500 and 100600); replaying them would build a schema production
// does not have. None of them touches customer_documents (asserted below).
const PARKED = new Set([
  '20260914100800_bind_transfer_invoice_intent.sql',
  '20260914100900_repair_commission_history_label_snapshots.sql',
  '20260914100700_customer_document_bytes_server_only.sql',
]);
// The customer-document bytes candidate (#764, restamped 20260914100700 when
// 20260914100500 applied and stranded its old 20260914100450 stamp) landed on
// main parked. It is skipped while unapplied, like the rest; it does touch
// customer_documents, but only its storage.objects policies and a
// storage_path CHECK, which this function never reads. The check below is
// what holds that to be true, and now runs for real.
const OPTIONAL_PARKED = new Set(['20260914100700_customer_document_bytes_server_only.sql']);

const ADMIN = '5d000000-0000-4000-8000-00000000000a';
const REP = '5d000000-0000-4000-8000-00000000000b';
const REP2 = '5d000000-0000-4000-8000-00000000000c';
const DRIVER = '5d000000-0000-4000-8000-00000000000d';
const INACTIVE_REP = '5d000000-0000-4000-8000-00000000000e';
const CUSTOMER_MINE = '5d000000-0000-4000-8000-0000000000c1';
const CUSTOMER_OTHER = '5d000000-0000-4000-8000-0000000000c2';
const DOC = {
  before: '5d000000-0000-4000-8000-0000000000d1',
  adminBefore: '5d000000-0000-4000-8000-0000000000d2',
  fix: '5d000000-0000-4000-8000-0000000000d3',
  second: '5d000000-0000-4000-8000-0000000000d4',
  other: '5d000000-0000-4000-8000-0000000000d5',
  roleCheck: '5d000000-0000-4000-8000-0000000000d6',
  mutation: '5d000000-0000-4000-8000-0000000000d7',
};
const MISSING_DOC = '5d000000-0000-4000-8000-0000000000ff';
const MUTANT_DOC = '5d000000-0000-4000-8000-0000000000e1';

/**
 * The storage path the customer-document-files Edge Function issues:
 * <customer uuid>/<document uuid>-<safe name>.
 *
 * Every fixture in this prover and in the registered chain must use this shape.
 * The parked prerequisite 20260914100700 adds
 * customer_documents_storage_path_shape_check, which REQUIRES it — so a fixture
 * that invents a path inserts fine today and fails the moment that
 * prerequisite applies, taking the registered chain down with it (CodeRabbit,
 * PR #775). assertFixturePathsSurviveParkedShapeCheck() below holds this to the
 * constraint's own regex, read out of that migration.
 */
function docStoragePath(customerId, documentId, safeName) {
  return `${customerId}/${documentId}-${safeName}`;
}

function docker(args, options = {}) {
  const r = spawnSync('docker', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (r.error || (!options.allowFailure && r.status !== 0)) throw new Error(`${r.error?.message ?? ''}\n${r.stderr || r.stdout}`.trim());
  return r;
}
function psqlArgs(user = 'postgres') {
  return ['exec', '-i', NAME, 'psql', '-U', user, '-d', 'postgres', '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
}
function psql(sql, options = {}) {
  return docker(psqlArgs(options.user), { input: sql, allowFailure: options.allowFailure });
}
function scalar(sql) {
  return docker([...psqlArgs(), '-A', '-t'], { input: sql }).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
}
function stageSql(file, name, transform = (s) => s) {
  const staged = path.join(tmpdir(), `${NAME}-${name}`);
  try {
    writeFileSync(staged, transform(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')), 'utf8');
    docker(['cp', staged, `${NAME}:/tmp/${name}`]);
  } finally {
    try { unlinkSync(staged); } catch (e) { if (e.code !== 'ENOENT') console.error(`could not remove staged file ${staged}: ${e.message}`); }
  }
}
function apply(name, allowFailure = false) {
  const r = docker([...psqlArgs(), '-1', '-f', `/tmp/${name}`], { allowFailure });
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` };
}
function wait(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function ready() {
  for (let i = 0; i < 120; i += 1) {
    if (docker(['exec', NAME, 'pg_isready', '-U', 'postgres'], { allowFailure: true }).status === 0) return;
    wait(500);
  }
  throw new Error('disposable PostgreSQL did not become ready');
}
/**
 * Does this migration change the surface the skip decision depends on — the
 * table's row policies, triggers, ownership, RLS enforcement or grants?
 *
 * Matches the TABLE rather than one spelling of the statement, because a
 * name-matching guard in this repository has been defeated before by an
 * alternate identifier spelling. selfTestSkipSoundness() below proves each
 * spelling trips it: PR #761's file is not on disk in this checkout, so
 * without that self-test this branch would ship unexercised.
 */
function touchesCustomerDocumentSurface(sql) {
  // The SCHEMA qualifier is quotable too: `ON "public"."customer_documents"` must trip this,
  // and an unquoted-schema-only pattern silently misses it.
  const table = String.raw`(?:"?public"?\s*\.\s*)?"?customer_documents"?`;
  return new RegExp(
    [
      String.raw`(?:POLICY|TRIGGER)[^;]*\bON\s+${table}`,
      String.raw`(?:GRANT|REVOKE)[^;]*\bON\s+(?:TABLE\s+)?${table}`,
      String.raw`ALTER\s+TABLE[^;]*\b${table}[^;]*\b(?:FORCE\s+ROW\s+LEVEL\s+SECURITY|OWNER\s+TO|ENABLE\s+ROW\s+LEVEL\s+SECURITY|DISABLE\s+ROW\s+LEVEL\s+SECURITY)`,
      String.raw`guard_customer_document_update`,
      String.raw`soft_delete_customer_document`,
    ].join('|'),
    'is',
  ).test(sql);
}
/**
 * Skipping a parked migration is unsound not only when it changes this table's
 * access surface, but also when it CONSTRAINS a column these fixtures write.
 *
 * 20260914100700 adds customer_documents_storage_path_shape_check. Read its
 * regex out of the migration itself — never a copy — and require every path
 * this prover and the registered chain insert to satisfy it. Without this the
 * fixtures pass here and the chain breaks the day that prerequisite applies,
 * which is BEFORE this candidate is allowed to apply.
 */
function assertFixturePathsSurviveParkedShapeCheck(parkedSql, label) {
  const found = /storage_path\s*~\s*'(\^[^']+\$)'/.exec(parkedSql);
  if (!found) {
    // FAIL CLOSED. Returning here when the file plainly HAS the constraint would
    // make this whole guard vacuous the moment 20260914100700 respells its CHECK
    // (`~*`, `E'...'`, a doubled quote, SIMILAR TO) or a later edit rewrites it -
    // and the prover would pass right up until the prerequisite applies and the
    // registered chain broke (CodeRabbit, PR #777).
    assert.ok(
      !/customer_documents_storage_path_shape_check/i.test(parkedSql),
      `${label} declares customer_documents_storage_path_shape_check but this extractor could not read its regex; fix the extractor rather than skipping the check`,
    );
    return; // genuinely no path-shape constraint in this file
  }
  const shape = new RegExp(found[1]);

  // Derived from the SAME map and the SAME formula seedFixtures() uses, so this
  // covers every fixture rather than a hand-picked sample that can fall behind.
  const samples = Object.entries(DOC).map(([fixtureLabel, id]) =>
    docStoragePath(fixtureLabel === 'other' ? CUSTOMER_OTHER : CUSTOMER_MINE, id, `${fixtureLabel}.pdf`));
  samples.push(docStoragePath(CUSTOMER_OTHER, MUTANT_DOC, 'mutant.pdf'));
  // The chain's own paths, rebuilt from the literals it really inserts.
  const chainSql = readFileSync(SMOKE_CHAIN, 'utf8');
  samples.push(...chainStoragePaths(chainSql));
  for (const p of samples) {
    assert.ok(shape.test(p), `fixture storage_path "${p}" violates ${label}'s path-shape constraint`);
  }
  // The matcher must be able to REJECT, or the loop above proves nothing. These
  // are the two shapes this repository actually got wrong: a path with no
  // document uuid, and a safe name starting with '['.
  const bad = [`${CUSTOMER_MINE}/mine.pdf`, `${CUSTOMER_MINE}/${DOC.before}-[SMOKE]-mine.pdf`];
  for (const p of bad) {
    assert.ok(!shape.test(p), `path-shape check is too loose: it accepted "${p}"`);
  }
  // The constraint is a PostgreSQL ARE; JavaScript's RegExp is not. A JS verdict
  // is only evidence about the DATABASE's verdict if the two dialects agree, so
  // ask PostgreSQL itself rather than banning the syntax that differs: POSIX
  // classes ([[:alnum:]]) and ARE escapes (\m, \Y) would otherwise be read
  // with different meanings and this guard would diverge silently.
  const cases = [...samples.map((v) => [v, true]), ...bad.map((v) => [v, false])];
  const pgVerdicts = scalar(
    `SELECT string_agg(v.verdict, ',' ORDER BY v.n) FROM (SELECT * FROM unnest(array[${
      cases.map((_, i) => i).join(',')
    }], array[${
      cases.map(([v]) => `$re$${v}$re$`).join(',')
    }]) AS t(n, path), lateral (SELECT (t.path ~ $shape$${found[1]}$shape$)::text AS verdict) x) v(n, path, verdict);`,
  ).split(',');
  cases.forEach(([path, expected], i) => {
    assert.equal(
      pgVerdicts[i], String(expected),
      `PostgreSQL and this JavaScript check disagree about "${path}" under ${label}'s regex: PostgreSQL says ${pgVerdicts[i]}, JS says ${expected}. The JS guard is not evidence about the database constraint.`,
    );
  });
  // The extractor must be able to CATCH the regression it exists for: put the
  // [SMOKE] marker back into the chain's first path and it must fail the shape.
  const mutatedChain = chainSql.replace(/(\|\|\s*')-/, '$1-[SMOKE]');
  assert.notEqual(mutatedChain, chainSql, 'could not build the [SMOKE]-in-path mutation of the chain');
  assert.ok(
    chainStoragePaths(mutatedChain).some((p) => !shape.test(p)),
    `a [SMOKE] marker restored into ${path.basename(SMOKE_CHAIN)}'s storage_path would still pass ${label}'s shape check here`,
  );
}
/**
 * The storage paths the registered chain inserts, rebuilt from the chain's own
 * SQL: each `<customer var> || '/' || <document var> || '<literal>'`, with fixed
 * uuids standing in for the ones it generates at run time.
 *
 * Reading the literal itself - never a copy of today's safe name - is the
 * point. A hard-coded sample stays green if someone restores the [SMOKE] marker
 * into the path, right up until 20260914100700 applies and its CHECK rejects
 * the chain (adversarial review MED-3, 2026-09-24).
 */
function chainStoragePaths(chainSql) {
  const inserts = chainSql.match(/INSERT\s+INTO\s+public\.customer_documents\b[^;]*;/gi) ?? [];
  assert.equal(inserts.length, 1, `${path.basename(SMOKE_CHAIN)} must insert its document rows in exactly one statement; this extractor reads that one`);
  const rows = inserts[0].match(/^\s*\(v_\w+,/gm) ?? [];
  const composed = [...inserts[0].matchAll(/\b(v_\w+)\s*\|\|\s*'\/'\s*\|\|\s*(v_\w+)\s*\|\|\s*'((?:[^']|'')*)'/g)];
  assert.equal(
    composed.length, rows.length,
    `${path.basename(SMOKE_CHAIN)} inserts ${rows.length} document row(s) but only ${composed.length} storage_path value(s) are composed as <customer> || '/' || <document> || '<name>'; a path built any other way escapes the shape check`,
  );
  assert.deepEqual(
    composed.map((m) => `${m[1]}/${m[2]}`).sort(),
    ['v_customer/v_doc', 'v_other_customer/v_other_doc'],
    `${path.basename(SMOKE_CHAIN)} no longer composes storage_path from its customer and document variables`,
  );
  return composed.map((m) => {
    const suffix = m[3].replaceAll("''", "'");
    assert.ok(suffix.startsWith('-'), `${path.basename(SMOKE_CHAIN)} storage_path suffix "${suffix}" must start with '-' after the document uuid`);
    return docStoragePath(m[1] === 'v_other_customer' ? CUSTOMER_OTHER : CUSTOMER_MINE, MISSING_DOC, suffix.slice(1));
  });
}
function selfTestSkipSoundness() {
  const mustTrip = [
    'CREATE POLICY customer_documents_rep_select ON public.customer_documents FOR SELECT USING (true);',
    'CREATE POLICY "doc quoted" ON customer_documents FOR SELECT USING (true);',
    'CREATE TRIGGER t BEFORE UPDATE ON customer_documents FOR EACH ROW EXECUTE FUNCTION f();',
    'GRANT UPDATE ON TABLE public.customer_documents TO authenticated;',
    'REVOKE SELECT ON customer_documents FROM anon;',
    'ALTER TABLE public.customer_documents FORCE ROW LEVEL SECURITY;',
    'ALTER TABLE "customer_documents" OWNER TO supabase_admin;',
    'ALTER TABLE public . customer_documents DISABLE ROW LEVEL SECURITY;',
    'CREATE OR REPLACE FUNCTION public.guard_customer_document_update() RETURNS trigger AS $$ BEGIN RETURN NEW; END $$ LANGUAGE plpgsql;',
    'CREATE POLICY "x" ON "public"."customer_documents" FOR SELECT USING (true);',
    'GRANT UPDATE ON TABLE "public"."customer_documents" TO authenticated;',
    'ALTER TABLE "public" . "customer_documents" ENABLE ROW LEVEL SECURITY;',
  ];
  for (const sql of mustTrip) {
    assert.ok(touchesCustomerDocumentSurface(sql), `skip-soundness check missed: ${sql}`);
  }
  const mustPass = [
    "ALTER TABLE storage.objects ADD CONSTRAINT c CHECK (bucket_id <> 'x');",
    'CREATE POLICY p ON public.customer_facts FOR SELECT USING (true);',
    'GRANT SELECT ON TABLE public.customers TO authenticated;',
  ];
  for (const sql of mustPass) {
    assert.ok(!touchesCustomerDocumentSurface(sql), `skip-soundness check is too broad: ${sql}`);
  }
}
/**
 * The OTHER table this function writes: its receipt is a direct INSERT into
 * public.idempotency_keys. A skipped parked file that changes THAT table's
 * triggers, policies, row security, ownership or grants, or redefines the
 * shared intent helper, can change the receipt INSERT as surely as a
 * customer_documents change can change the UPDATE. The customer_documents
 * check alone missed 20260914100800's BEFORE INSERT trigger there
 * (adversarial review MED-2, 2026-09-24).
 *
 * Returns every such change. The caller fails closed on anything it cannot
 * account for; a trigger is accounted for only by installing it here and
 * running the proof through it.
 */
const RECEIPT_TABLE = String.raw`(?:"?public"?\s*\.\s*)?"?idempotency_keys"?`;
function receiptSurfaceChanges(sql) {
  const kinds = [
    ['trigger', String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?(\w+)"?[^;]*?\bON\s+${RECEIPT_TABLE}[^;]*;`],
    ['drop-trigger', String.raw`DROP\s+TRIGGER\s+(?:IF\s+EXISTS\s+)?"?(\w+)"?\s+ON\s+${RECEIPT_TABLE}[^;]*;`],
    ['policy', String.raw`(?:CREATE|ALTER|DROP)\s+POLICY[^;]*\bON\s+${RECEIPT_TABLE}[^;]*;`],
    ['acl', String.raw`(?:GRANT|REVOKE)\b[^;]*\bON\s+(?:TABLE\s+)?${RECEIPT_TABLE}[^;]*;`],
    ['table', String.raw`ALTER\s+TABLE[^;]*\b${RECEIPT_TABLE}[^;]*;`],
    ['helper', String.raw`FUNCTION\s+(?:"?public"?\s*\.\s*)?"?check_idempotency_intent"?\s*\(`],
  ];
  const changes = [];
  for (const [kind, pattern] of kinds) {
    for (const m of sql.matchAll(new RegExp(pattern, 'gis'))) changes.push({ kind, name: m[1] ?? null, text: m[0] });
  }
  return changes;
}
/** Only a REVOKE from browser roles is harmless: the receipt INSERT runs as the owner. */
function isBrowserRoleRevoke(text) {
  const m = /^REVOKE\b[\s\S]*\bFROM\s+([^;]+);$/i.exec(text.trim());
  if (!m) return false;
  return m[1].split(',').map((r) => r.trim().replace(/^"|"$/g, '').toLowerCase())
    .every((r) => ['public', 'anon', 'authenticated'].includes(r));
}
/**
 * Pull a parked receipt trigger and its function out of the parked file,
 * verbatim, so the proof can run THROUGH it. Production installs it before
 * this candidate may apply, so this is the schema the candidate really meets.
 */
function extractReceiptTrigger(parkedSql, change, label) {
  const fn = /EXECUTE\s+(?:FUNCTION|PROCEDURE)\s+((?:"?public"?\s*\.\s*)?"?\w+"?)\s*\(/i.exec(change.text);
  assert.ok(fn, `${label}: could not read the function trigger ${change.name} executes`);
  const fnName = fn[1].replace(/\s+/g, '');
  const escaped = fnName.replace(/[.$"]/g, (c) => `\\${c}`);
  const start = parkedSql.search(new RegExp(String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+${escaped}\s*\(`, 'i'));
  assert.ok(start >= 0, `${label}: trigger ${change.name} executes ${fnName}, which this file does not define; install it or re-think the skip`);
  const tag = /\$([A-Za-z_]*)\$/.exec(parkedSql.slice(start));
  assert.ok(tag, `${label}: ${fnName} has no dollar-quoted body`);
  const bodyEnd = parkedSql.indexOf(tag[0], start + tag.index + tag[0].length);
  assert.ok(bodyEnd > 0, `${label}: ${fnName} body is unterminated`);
  const end = parkedSql.indexOf(';', bodyEnd + tag[0].length);
  assert.ok(end > 0, `${label}: ${fnName} definition is unterminated`);
  return { label, name: change.name, sql: `${parkedSql.slice(start, end + 1)}\n${change.text}` };
}
function selfTestReceiptSurface() {
  const cases = [
    ['CREATE TRIGGER t BEFORE INSERT ON public.idempotency_keys FOR EACH ROW EXECUTE FUNCTION public.f();', 'trigger'],
    ['CREATE TRIGGER "t" BEFORE INSERT ON "public"."idempotency_keys" FOR EACH ROW EXECUTE FUNCTION f();', 'trigger'],
    ['DROP TRIGGER IF EXISTS t ON idempotency_keys;', 'drop-trigger'],
    ['CREATE POLICY p ON public.idempotency_keys FOR INSERT WITH CHECK (false);', 'policy'],
    ['REVOKE INSERT ON TABLE public.idempotency_keys FROM postgres;', 'acl'],
    ['ALTER TABLE public.idempotency_keys FORCE ROW LEVEL SECURITY;', 'table'],
    ['CREATE OR REPLACE FUNCTION public.check_idempotency_intent(p text) RETURNS jsonb AS $$ SELECT NULL $$ LANGUAGE sql;', 'helper'],
  ];
  for (const [sql, kind] of cases) {
    assert.ok(receiptSurfaceChanges(sql).some((c) => c.kind === kind), `receipt-surface check missed (${kind}): ${sql}`);
  }
  const mustPass = [
    'CREATE TRIGGER t BEFORE INSERT ON public.customer_facts FOR EACH ROW EXECUTE FUNCTION f();',
    "SELECT has_table_privilege('anon', 'public.idempotency_keys', 'INSERT');",
    'LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;',
  ];
  for (const sql of mustPass) {
    assert.deepEqual(receiptSurfaceChanges(sql), [], `receipt-surface check is too broad: ${sql}`);
  }
  assert.ok(isBrowserRoleRevoke('REVOKE INSERT, UPDATE ON TABLE public.idempotency_keys FROM PUBLIC, anon, authenticated;'));
  assert.ok(!isBrowserRoleRevoke('REVOKE INSERT ON TABLE public.idempotency_keys FROM PUBLIC, postgres;'));
  assert.ok(!isBrowserRoleRevoke('GRANT INSERT ON TABLE public.idempotency_keys TO anon;'));
}
// Filled by selected(): parked receipt triggers the proof must run through.
const PARKED_RECEIPT_TRIGGERS = [];
function selected() {
  selfTestSkipSoundness();
  selfTestReceiptSurface();
  const r = spawnSync(process.execPath, ['scripts/list-post-baseline-migrations.mjs'], { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  const all = r.stdout.split(/\r?\n/).filter((x) => x.startsWith('supabase/migrations/')).map((x) => path.join(ROOT, x));
  const candidate = all.indexOf(CANDIDATE);
  assert.ok(candidate >= 0, 'soft_delete_customer_document candidate must be selected for post-baseline replay');
  const before = all.slice(0, candidate);
  const skipped = before.filter((f) => PARKED.has(path.basename(f)));
  for (const name of PARKED) {
    if (!OPTIONAL_PARKED.has(name)) assert.ok(skipped.some((f) => path.basename(f) === name), `${name} must be in the replay plan (re-check the PARKED list against the live ledger)`);
  }
  for (const file of skipped) {
    const label = path.basename(file);
    const fileSql = readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
    const receipt = receiptSurfaceChanges(fileSql);
    const created = new Set(receipt.filter((c) => c.kind === 'trigger').map((c) => c.name));
    for (const change of receipt) {
      if (change.kind === 'trigger') { PARKED_RECEIPT_TRIGGERS.push(extractReceiptTrigger(fileSql, change, label)); continue; }
      if (change.kind === 'drop-trigger' && created.has(change.name)) continue; // DROP IF EXISTS + CREATE idiom
      if (change.kind === 'acl' && isBrowserRoleRevoke(change.text)) continue;
      assert.fail(`${label} changes the receipt table this function writes (${change.kind}): ${change.text.slice(0, 200)} Replay it or re-think the skip.`);
    }
    if (OPTIONAL_PARKED.has(path.basename(file))) {
      // Skipping it is only sound while it leaves this table's row policies,
      // triggers, ownership, forced-RLS setting and grants alone. Match the
      // TABLE, not one spelling of the statement that touches it: an
      // unqualified `ON customer_documents`, a quoted policy name, FORCE ROW
      // LEVEL SECURITY (which would break the definer-bypasses-RLS premise
      // outright) and OWNER TO all have to trip this.
      const parkedSql = readFileSync(file, 'utf8');
      assert.ok(
        !touchesCustomerDocumentSurface(parkedSql),
        `${path.basename(file)} now changes customer_documents policies, triggers, ownership, RLS enforcement or grants; replay it or re-think the skip`,
      );
      assertFixturePathsSurviveParkedShapeCheck(parkedSql, path.basename(file));
      continue;
    }
    assert.ok(!/customer_documents|soft_delete_customer_document/i.test(readFileSync(file, 'utf8')), `${path.basename(file)} touches customer documents; skipping it would change the proof`);
  }
  return before.filter((f) => !PARKED.has(path.basename(f)));
}
// Same replay repair the other real-schema provers use: live stores this one
// body with CRLF line endings, and a later migration pins that exact body.
function restoreLiveCrLfCloseRemainder() {
  const definingPath = path.join(ROOT, 'supabase', 'migrations', '20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql');
  const source = readFileSync(definingPath, 'utf8').replace(/\r\n/g, '\n');
  const needle = 'CREATE FUNCTION public._close_undelivered_order_remainder_20260718(';
  assert.equal(source.split(needle).length - 1, 1, 'close-remainder definition is ambiguous');
  const start = source.indexOf(needle);
  const tag = /\$([A-Za-z_]*)\$/.exec(source.slice(start));
  assert.ok(tag, 'close-remainder body has no dollar quote');
  const bodyStart = start + tag.index + tag[0].length;
  const bodyEnd = source.indexOf(tag[0], bodyStart);
  assert.ok(bodyEnd > bodyStart, 'close-remainder body is unterminated');
  const body = source.slice(bodyStart, bodyEnd).replace(/\n/g, '\r\n');
  assert.equal(body.length, 15910, 'close-remainder live CRLF body length drifted');
  psql(`CREATE OR REPLACE FUNCTION public._close_undelivered_order_remainder_20260718(p_order_id uuid, p_actor uuid)
    RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
    AS $live_crlf_close$${body}$live_crlf_close$;`);
}

// The image's auth.uid() may read request.jwt.claim.sub before request.jwt.claims; set both.
function asUser(uid, role = 'authenticated') {
  return `SELECT set_config('request.jwt.claims', '{"sub":"${uid}","role":"${role}"}', true);\nSELECT set_config('request.jwt.claim.sub', '${uid}', true);\nSET LOCAL ROLE ${role};`;
}
/** One committed statement as `uid`; returns the last output line or the error text. */
function runAs(uid, sql, role = 'authenticated') {
  const r = docker([...psqlArgs(), '-A', '-t'], {
    input: `BEGIN;\n${asUser(uid, role)}\n${sql}\nCOMMIT;\n`,
    allowFailure: true,
  });
  const last = r.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '';
  return { ok: r.status === 0, last, error: r.stderr.trim() };
}
function removeAs(uid, documentId, key, role = 'authenticated', customerId = undefined) {
  const keySql = key === null ? 'NULL' : `'${key}'`;
  // Default to the document's own customer, the way the page knows it from its
  // route. Resolved HERE as the owner, not inside the call: a rep cannot SELECT
  // a soft-deleted row, so an inline sub-select would resolve to NULL on every
  // replay and test the wrong thing.
  // A document that does not exist has no customer to resolve; the page would
  // still send the customer whose tab it is on, so fall back to that and let
  // the function answer CUSTOMER_DOCUMENT_NOT_FOUND.
  const owner = customerId === undefined
    ? scalar(`SELECT customer_id FROM public.customer_documents WHERE id = '${documentId}'::uuid;`) || CUSTOMER_MINE
    : customerId;
  const customer = owner === null ? 'NULL' : `'${owner}'::uuid`;
  const r = runAs(uid, `SELECT public.soft_delete_customer_document('${documentId}'::uuid, ${customer}, ${keySql})::text;`, role);
  return { ...r, result: r.ok ? JSON.parse(r.last) : null };
}
function expectRefusal(call, pattern, label) {
  assert.equal(call.ok, false, `${label}: expected a refusal, got ${call.last}`);
  assert.match(call.error, pattern, `${label}: wrong refusal:\n${call.error}`);
}
/** Open a session that takes a row lock and keeps it until releaseLock(). */
function holdLock(lockSql) {
  const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`lock holder never reported LOCK_HELD:\n${err}`)); }, 15_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.stdout.on('data', (chunk) => {
      out += chunk;
      if (out.includes('LOCK_HELD')) { clearTimeout(timer); resolve(child); }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stdin.write(`BEGIN;\n${lockSql}\nSELECT 'LOCK_HELD';\n`);
  });
}
function finishLock(child, verb) {
  return new Promise((resolve) => {
    child.on('close', resolve);
    child.stdin.end(`${verb};\n`);
  });
}
function releaseLock(child) {
  return finishLock(child, 'ROLLBACK');
}
/** runAs, but without blocking the event loop, so another session can act meanwhile. */
function runAsAsync(uid, sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...psqlArgs(), '-A', '-t'], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (status) => {
      resolve({ ok: status === 0, last: out.trim().split(/\r?\n/).filter(Boolean).at(-1) ?? '', error: err.trim() });
    });
    child.stdin.end(`BEGIN;\n${asUser(uid)}\n${sql}\nCOMMIT;\n`);
  });
}
/** Resolve once the named session is waiting on a row lock. */
async function waitForLockWait(appName) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const waiting = scalar(`SELECT count(*) FROM pg_stat_activity WHERE application_name = '${appName}' AND wait_event_type = 'Lock';`);
    if (waiting === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${appName} never waited on a lock`);
}
function docState(id) {
  return scalar(`SELECT coalesce(deleted_by::text, 'live') || '|' || updated_at::text FROM public.customer_documents WHERE id = '${id}';`);
}
function directSoftDelete(uid, id, returning) {
  return runAs(uid, `UPDATE public.customer_documents SET deleted_at = now(), deleted_by = '${uid}' WHERE id = '${id}' AND deleted_at IS NULL${returning ? ' RETURNING id' : ''};`);
}

// Only an admin may change is_active (_guard_profile_role_lock), so this runs
// with the admin's claims.
function setActive(uid, active) {
  psql(`BEGIN;
    SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);
    SELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);
    UPDATE public.profiles SET is_active = ${active} WHERE id = '${uid}';
    COMMIT;`);
}

function seed() {
  // The baseline auth.users is a stub; deactivating a profile fires
  // _sync_auth_access_on_profile_active, which writes the real column set.
  psql(`
    ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS banned_until timestamptz;
    CREATE TABLE IF NOT EXISTS auth.sessions (user_id uuid);
    CREATE TABLE IF NOT EXISTS auth.refresh_tokens (user_id varchar);
    GRANT DELETE ON auth.sessions, auth.refresh_tokens TO postgres;
  `, { user: 'supabase_admin' });
  psql(`
    INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
      ('${ADMIN}','doc-prover-admin@example.invalid','{"full_name":"[PROVER] Doc Admin","role":"admin"}'::jsonb),
      ('${REP}','doc-prover-rep@example.invalid','{"full_name":"[PROVER] Doc Rep","role":"sales_rep"}'::jsonb),
      ('${REP2}','doc-prover-rep2@example.invalid','{"full_name":"[PROVER] Doc Rep Two","role":"sales_rep"}'::jsonb),
      ('${DRIVER}','doc-prover-driver@example.invalid','{"full_name":"[PROVER] Doc Driver","role":"driver"}'::jsonb),
      ('${INACTIVE_REP}','doc-prover-inactive@example.invalid','{"full_name":"[PROVER] Doc Inactive Rep","role":"sales_rep"}'::jsonb)
    ON CONFLICT DO NOTHING;
    INSERT INTO public.profiles (id,email,full_name,role,is_active) VALUES
      ('${ADMIN}','doc-prover-admin@example.invalid','[PROVER] Doc Admin','admin',true),
      ('${REP}','doc-prover-rep@example.invalid','[PROVER] Doc Rep','sales_rep',true),
      ('${REP2}','doc-prover-rep2@example.invalid','[PROVER] Doc Rep Two','sales_rep',true),
      ('${DRIVER}','doc-prover-driver@example.invalid','[PROVER] Doc Driver','driver',true),
      ('${INACTIVE_REP}','doc-prover-inactive@example.invalid','[PROVER] Doc Inactive Rep','sales_rep',true)
    ON CONFLICT (id) DO UPDATE SET email=EXCLUDED.email, full_name=EXCLUDED.full_name, role=EXCLUDED.role, is_active=EXCLUDED.is_active;
    INSERT INTO public.customers (id,farm_name,assigned_sales_rep,is_active) VALUES
      ('${CUSTOMER_MINE}','[PROVER] Rep Farm','${REP}',true),
      ('${CUSTOMER_OTHER}','[PROVER] Other Farm','${REP2}',true);
  `);
  const docs = Object.entries(DOC).map(([label, id]) => {
    const customer = label === 'other' ? CUSTOMER_OTHER : CUSTOMER_MINE;
    return `('${id}','${customer}','other','${docStoragePath(customer, id, `${label}.pdf`)}','${label}.pdf','application/pdf',100,'${ADMIN}','rep')`;
  });
  psql(`INSERT INTO public.customer_documents (id,customer_id,document_type,storage_path,filename,mime_type,size_bytes,uploaded_by,source) VALUES ${docs.join(',')};`);
}

async function main() {
  docker(['run', '-d', '--name', NAME, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data:rw,noexec,nosuid,size=1024m', '-e', 'POSTGRES_PASSWORD=postgres', IMAGE]);
  ready();
  for (const name of ['20260727174805_extensions.sql', '20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) docker(['cp', path.join(BASELINE, name), `${NAME}:/tmp/${name}`]);
  const schema = spawnSync(process.execPath, ['scripts/decompress-schema-baseline.mjs'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  if (schema.status !== 0) throw new Error(schema.stderr.toString());
  psql('\\i /tmp/20260727174805_extensions.sql'); psql(schema.stdout.toString());
  psql(`CREATE SCHEMA IF NOT EXISTS storage;
    CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean NOT NULL DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
    CREATE TABLE IF NOT EXISTS storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text NOT NULL, name text NOT NULL, owner_id text);
    CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql IMMUTABLE AS $$ SELECT string_to_array(name, '/') $$;
    CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text LANGUAGE sql IMMUTABLE AS $$ SELECT split_part(name, '/', array_length(string_to_array(name, '/'), 1)) $$;`, { user: 'supabase_admin' });
  psql('CREATE SCHEMA IF NOT EXISTS supabase_migrations; CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations (version text PRIMARY KEY, name text NOT NULL, statements text[]);');
  for (const name of ['20260727174805_acl_lockdown.sql', '20260727174805_platform_overlay.sql', '20260727174805_cron_jobs.sql', '20260727174805_migration_history.sql']) psql(`\\i /tmp/${name}`, { user: name.includes('overlay') ? 'supabase_admin' : 'postgres' });

  const migrations = selected();
  for (const [i, file] of migrations.entries()) {
    if (path.basename(file) === '20260817120000_carry_allocated_line_cents_through_lifecycle.sql') restoreLiveCrLfCloseRemainder();
    const name = `m-${i}.sql`; stageSql(file, name); const r = apply(name, true);
    if (r.status !== 0) throw new Error(`source replay failed at ${path.basename(file)}:\n${r.output}`);
  }
  console.log(`[prover] replayed ${migrations.length} applied post-baseline migrations (parked files skipped)`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'soft_delete_customer_document';`), '0', 'function must not exist before the candidate');

  seed();

  // 1. THE BUG, BEFORE.
  const repPlain = directSoftDelete(REP, DOC.before, false);
  expectRefusal(repPlain, /new row violates row-level security policy for table "customer_documents"/, 'rep direct UPDATE (no RETURNING)');
  const repReturning = directSoftDelete(REP, DOC.before, true);
  expectRefusal(repReturning, /new row violates row-level security policy for table "customer_documents"/, 'rep direct UPDATE (RETURNING)');
  assert.match(docState(DOC.before), /^live\|/, 'refused rep UPDATE changed the row');
  const adminDirect = directSoftDelete(ADMIN, DOC.adminBefore, true);
  assert.ok(adminDirect.ok && adminDirect.last === DOC.adminBefore, `admin direct UPDATE should work before the fix:\n${adminDirect.error}`);
  console.log('[prover] BEFORE: assigned rep soft-delete refused by RLS (with and without RETURNING); admin succeeds');

  // 1b. The parked receipt triggers production will have installed first.
  for (const trigger of PARKED_RECEIPT_TRIGGERS) psql(trigger.sql);
  console.log(`[prover] installed ${PARKED_RECEIPT_TRIGGERS.length} parked receipt trigger(s) verbatim: ${PARKED_RECEIPT_TRIGGERS.map((t) => `${t.name} (${t.label})`).join(', ') || 'none'}`);

  // 2. Apply.
  stageSql(CANDIDATE, 'candidate.sql');
  const applied = apply('candidate.sql', true);
  assert.equal(applied.status, 0, `candidate failed to apply:\n${applied.output}`);

  // 3. THE FIX.
  const fixed = removeAs(REP, DOC.fix, 'prover-rep-key-1');
  assert.ok(fixed.ok, `assigned rep removal failed:\n${fixed.error}`);
  assert.equal(fixed.result.success, true);
  assert.equal(fixed.result.document_id, DOC.fix);
  assert.equal(fixed.result.customer_id, CUSTOMER_MINE);
  const afterFix = docState(DOC.fix);
  assert.match(afterFix, new RegExp(`^${REP}\\|`), `row not stamped deleted_by = rep: ${afterFix}`);
  assert.equal(
    scalar(`SELECT request_actor_id::text || '|' || (request_fingerprint <> '')::text FROM public.idempotency_keys WHERE idempotency_key = 'prover-rep-key-1' AND operation = 'soft_delete_customer_document';`),
    `${REP}|true`,
    'receipt is not bound to the rep',
  );
  // The receipt above went through every parked receipt trigger: prove each is
  // really installed and enabled, or that pass proves nothing about them.
  for (const trigger of PARKED_RECEIPT_TRIGGERS) {
    assert.equal(
      scalar(`SELECT count(*) FROM pg_trigger WHERE tgrelid = 'public.idempotency_keys'::regclass AND tgname = '${trigger.name}' AND tgenabled <> 'D';`),
      '1',
      `parked receipt trigger ${trigger.name} is not installed and enabled, so the FIX step did not run through it`,
    );
  }
  console.log('[prover] FIX: assigned rep removed the document; deleted_by = rep; receipt bound to the rep');

  // 4. Replay semantics.
  const replay = removeAs(REP, DOC.fix, 'prover-rep-key-1');
  assert.ok(replay.ok, `same-key replay failed:\n${replay.error}`);
  assert.deepEqual(replay.result, fixed.result, 'replay returned a different result');
  assert.equal(docState(DOC.fix), afterFix, 'replay touched the row again');
  const mismatch = removeAs(REP, DOC.second, 'prover-rep-key-1');
  expectRefusal(mismatch, /IDEMPOTENCY_INTENT_MISMATCH/, 'same key, different document');
  // The refusal must not carry the earlier receipt (it names DOC.fix and its customer).
  assert.ok(!mismatch.error.includes(DOC.fix) && !mismatch.error.includes(CUSTOMER_MINE) && !/DETAIL/.test(mismatch.error),
    `intent-mismatch refusal leaks the earlier receipt:\n${mismatch.error}`);
  assert.match(docState(DOC.second), /^live\|/, 'intent mismatch removed the second document');
  expectRefusal(removeAs(REP2, DOC.fix, 'prover-rep-key-1'), /IDEMPOTENCY_ACTOR_MISMATCH/, 'another rep holding the key');
  // A replay is re-authorised: once the customer is reassigned, the rep's own
  // key no longer returns the receipt.
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP2}' WHERE id = '${CUSTOMER_MINE}';`);
  expectRefusal(removeAs(REP, DOC.fix, 'prover-rep-key-1'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'replay after the customer was reassigned');
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP}' WHERE id = '${CUSTOMER_MINE}';`);
  const replayBack = removeAs(REP, DOC.fix, 'prover-rep-key-1');
  assert.ok(replayBack.ok && replayBack.result.document_id === DOC.fix, `replay after re-assignment back failed:\n${replayBack.error}`);
  // The role gate runs BEFORE the receipt lookup: a deactivated rep replaying
  // their own valid key is refused, not handed the receipt.
  setActive(REP, false);
  expectRefusal(removeAs(REP, DOC.fix, 'prover-rep-key-1'), /INSUFFICIENT_ROLE/, 'deactivated rep replaying their own key');
  setActive(REP, true);
  // 4b. THE FAULT BRANCH. The installed helper's only 22023 raises are its two
  // IDEMPOTENCY_INTENT_MISMATCH branches, so the function's non-mismatch 22023
  // path is unreachable against the real helper — and a security branch that no
  // test can reach is one whose first execution is its first test
  // (rls-security-reviewer M2). Drive it with a SHADOW helper that raises a
  // DIFFERENT 22023 carrying a receipt-shaped DETAIL, then restore the real one.
  // Rename the real helper aside rather than capturing its body: a multi-line
  // pg_get_functiondef() does not survive scalar(), and a rename cannot lose
  // bytes the way a capture-and-re-emit can.
  psql('ALTER FUNCTION public.check_idempotency_intent(text,text,uuid,text) RENAME TO check_idempotency_intent_prover_real;');
  psql(`CREATE OR REPLACE FUNCTION public.check_idempotency_intent(p_key text, p_operation text, p_actor uuid, p_fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $shadow$
BEGIN
  RAISE EXCEPTION 'RECEIPT_INTENT_MISMATCH: key % is bound to a different request', p_key
    USING ERRCODE = '22023',
          DETAIL = jsonb_build_object('document_id', '${DOC.fix}', 'customer_id', '${CUSTOMER_MINE}')::text;
END
$shadow$;`);
  const fault = removeAs(REP, DOC.roleCheck, 'prover-fault-key-1');
  // The distinct token, NOT the intent-mismatch token: a fault must not read as
  // "we cannot tell whether your removal happened".
  expectRefusal(fault, /IDEMPOTENCY_HELPER_FAULT/, 'a non-mismatch 22023 from the helper');
  assert.doesNotMatch(fault.error, /IDEMPOTENCY_INTENT_MISMATCH/, 'a helper fault was mislabelled as an intent mismatch');
  // And the scrub is structural: the shadow DETAIL names a document and customer
  // and must not reach the caller even though the message is unrecognised.
  assert.ok(
    !fault.error.includes(DOC.fix) && !fault.error.includes(CUSTOMER_MINE) && !/DETAIL/.test(fault.error)
      && !fault.error.includes('RECEIPT_INTENT_MISMATCH'),
    `the fault branch leaked the helper's DETAIL or message:\n${fault.error}`,
  );
  assert.match(docState(DOC.roleCheck), /^live\|/, 'a helper fault removed the document anyway');
  // Restore, then PROVE the restore: every assertion after this point is
  // meaningless if the shadow is still installed.
  psql('DROP FUNCTION public.check_idempotency_intent(text,text,uuid,text);');
  psql('ALTER FUNCTION public.check_idempotency_intent_prover_real(text,text,uuid,text) RENAME TO check_idempotency_intent;');
  assert.equal(
    scalar(`SELECT (position('IDEMPOTENCY_INTENT_MISMATCH' in prosrc) > 0)::text FROM pg_proc
            WHERE oid = to_regprocedure('public.check_idempotency_intent(text,text,uuid,text)');`),
    'true',
    'the real idempotency helper was not restored after the shadow test',
  );
  assert.equal(
    scalar("SELECT (to_regprocedure('public.check_idempotency_intent_prover_real(text,text,uuid,text)') IS NULL)::text;"),
    'true',
    'the renamed-aside helper was left behind after the shadow test',
  );
  // The real helper answers its own token again, so the shadow is truly gone.
  expectRefusal(removeAs(REP, DOC.second, 'prover-rep-key-1'), /IDEMPOTENCY_INTENT_MISMATCH/, 'the real helper after the shadow test');
  console.log('[prover] replay: same key replays; different document -> INTENT_MISMATCH; other rep -> ACTOR_MISMATCH; a non-mismatch 22023 -> HELPER_FAULT with no DETAIL');

  // 5. Nobody gains access.
  expectRefusal(removeAs(REP, DOC.other, 'prover-rep-key-2'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'unassigned customer');
  assert.match(docState(DOC.other), /^live\|/, 'unassigned rep removed another customer\'s document');
  expectRefusal(removeAs(REP, DOC.fix, 'prover-rep-key-3'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'already removed');
  expectRefusal(removeAs(REP, MISSING_DOC, 'prover-rep-key-4'), /CUSTOMER_DOCUMENT_NOT_FOUND/, 'missing document');
  expectRefusal(removeAs(DRIVER, DOC.roleCheck, 'prover-driver-key'), /INSUFFICIENT_ROLE/, 'driver');
  psql(`UPDATE public.customers SET assigned_sales_rep = '${INACTIVE_REP}' WHERE id = '${CUSTOMER_OTHER}';`);
  setActive(INACTIVE_REP, false);
  expectRefusal(removeAs(INACTIVE_REP, DOC.other, 'prover-inactive-key'), /INSUFFICIENT_ROLE/, 'deactivated assigned rep');
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP2}' WHERE id = '${CUSTOMER_OTHER}';`);
  // CUSTOMER SCOPE: the page's old direct UPDATE scoped on customer_id, and the
  // function keeps that scope. A stale page holding a document of a customer it
  // no longer shows must not remove it — for an ADMIN either, who has no
  // assignment test to fall back on.
  expectRefusal(
    removeAs(REP, DOC.roleCheck, 'prover-wrong-customer', 'authenticated', CUSTOMER_OTHER),
    /CUSTOMER_DOCUMENT_NOT_FOUND/,
    'rep naming the wrong customer for a document they may otherwise remove',
  );
  expectRefusal(
    removeAs(ADMIN, DOC.roleCheck, 'prover-admin-wrong-customer', 'authenticated', CUSTOMER_OTHER),
    /CUSTOMER_DOCUMENT_NOT_FOUND/,
    'admin naming the wrong customer (no assignment test applies to an admin)',
  );
  expectRefusal(
    removeAs(REP, DOC.roleCheck, 'prover-null-customer', 'authenticated', null),
    /CUSTOMER_DOCUMENT_NOT_FOUND/,
    'null customer',
  );
  assert.match(docState(DOC.roleCheck), /^live\|/, 'a wrong-customer call changed the document');
  expectRefusal(removeAs(REP, DOC.roleCheck, null), /IDEMPOTENCY_KEY_REQUIRED/, 'missing key');
  expectRefusal(removeAs(REP, DOC.roleCheck, '   '), /IDEMPOTENCY_KEY_REQUIRED/, 'blank key');
  expectRefusal(removeAs(REP, DOC.roleCheck, 'k'.repeat(256)), /IDEMPOTENCY_KEY_REQUIRED/, '256-character key');
  expectRefusal(removeAs(REP, DOC.roleCheck, 'prover-anon-key', 'anon'), /permission denied for function soft_delete_customer_document/, 'anon');
  expectRefusal(removeAs(REP, DOC.roleCheck, 'prover-service-key', 'service_role'), /permission denied for function soft_delete_customer_document/, 'service_role');
  assert.match(docState(DOC.roleCheck), /^live\|/, 'a refused caller changed the role-check document');
  const repSeesRemoved = runAs(REP, `SELECT count(*) FROM public.customer_documents WHERE id = '${DOC.fix}';`);
  assert.ok(repSeesRemoved.ok && repSeesRemoved.last === '0', `rep can see the removed document: ${repSeesRemoved.last}`);
  expectRefusal(directSoftDelete(REP, DOC.second, false), /new row violates row-level security policy/, 'rep direct UPDATE after the fix (policy unchanged)');
  const repNotes = runAs(REP, `UPDATE public.customer_documents SET notes = 'prover note' WHERE id = '${DOC.second}' RETURNING id;`);
  assert.ok(repNotes.ok && repNotes.last === DOC.second, `rep can no longer edit notes (existing access lost):\n${repNotes.error}`);
  console.log('[prover] no new access: unassigned/removed/missing -> NOT_FOUND; driver/inactive -> INSUFFICIENT_ROLE; blank key refused; anon/service_role denied; removed row still hidden; policies unchanged');

  // 5b. LOCKS: while another session holds the rep's profile row (a
  // deactivation in progress) or the customer row (a reassignment in
  // progress), the removal must WAIT, not run on the pre-change state. A short
  // lock_timeout turns "waited" into an observable 55P03, and nothing commits.
  for (const [label, holder] of [
    ['profile (deactivation in progress)', `SELECT 1 FROM public.profiles WHERE id = '${REP}' FOR UPDATE;`],
    ['customer (reassignment in progress)', `SELECT 1 FROM public.customers WHERE id = '${CUSTOMER_MINE}' FOR UPDATE;`],
  ]) {
    const held = await holdLock(holder);
    try {
      const blocked = runAs(REP, `SET LOCAL lock_timeout = '750ms';\nSELECT public.soft_delete_customer_document('${DOC.roleCheck}'::uuid, '${CUSTOMER_MINE}'::uuid, 'prover-lock-${label.split(' ')[0]}')::text;`);
      expectRefusal(blocked, /canceling statement due to lock timeout/, `removal while the ${label} is locked`);
    } finally {
      await releaseLock(held);
    }
    assert.match(docState(DOC.roleCheck), /^live\|/, `removal ran past a held ${label} lock`);
  }
  // 5c. COMMITTED RACES: the change COMMITS while the removal is waiting on
  // it. PostgreSQL re-checks the locked row, so the removal must be refused —
  // not decided on the pre-change state.
  for (const [label, change, refusal] of [
    ['reassignment', `UPDATE public.customers SET assigned_sales_rep = '${REP2}' WHERE id = '${CUSTOMER_MINE}';`, /CUSTOMER_DOCUMENT_NOT_FOUND/],
    ['deactivation', `SELECT set_config('request.jwt.claims', '{"sub":"${ADMIN}","role":"authenticated"}', true);\nSELECT set_config('request.jwt.claim.sub', '${ADMIN}', true);\nUPDATE public.profiles SET is_active = false WHERE id = '${REP}';`, /INSUFFICIENT_ROLE/],
  ]) {
    const held = await holdLock(change);
    const removal = runAsAsync(REP, `SET LOCAL application_name = 'doc-race-${label}';\nSELECT public.soft_delete_customer_document('${DOC.roleCheck}'::uuid, '${CUSTOMER_MINE}'::uuid, 'prover-race-${label}')::text;`);
    await waitForLockWait(`doc-race-${label}`);
    await finishLock(held, 'COMMIT');
    expectRefusal(await removal, refusal, `removal that waited on a committed ${label}`);
    assert.match(docState(DOC.roleCheck), /^live\|/, `removal went through after a committed ${label}`);
  }
  psql(`UPDATE public.customers SET assigned_sales_rep = '${REP}' WHERE id = '${CUSTOMER_MINE}';`);
  setActive(REP, true);
  console.log('[prover] locks: removal waits on a held profile row and a held customer row, and is refused when the reassignment or deactivation commits');

  // 6. Admin path.
  const adminRemove = removeAs(ADMIN, DOC.other, 'prover-admin-key');
  assert.ok(adminRemove.ok, `admin removal failed:\n${adminRemove.error}`);
  assert.match(docState(DOC.other), new RegExp(`^${ADMIN}\\|`), 'admin removal not stamped');
  console.log('[prover] admin removed a document of a customer not assigned to them');

  // 7. Re-apply, and the exact-ACL postflight.
  const reapplied = apply('candidate.sql', true);
  assert.equal(reapplied.status, 0, `candidate failed to re-apply:\n${reapplied.output}`);
  assert.equal(scalar(`SELECT count(*) FROM pg_proc WHERE proname = 'soft_delete_customer_document';`), '1');
  psql(`GRANT EXECUTE ON FUNCTION ${SIG} TO metabase_ro;`);
  const drifted = apply('candidate.sql', true);
  assert.notEqual(drifted.status, 0, 'candidate re-applied over a drifted metabase_ro grant');
  assert.match(drifted.output, /POSTFLIGHT_ACL: .* non-owner grantees are authenticated,metabase_ro/, drifted.output);
  psql(`REVOKE EXECUTE ON FUNCTION ${SIG} FROM metabase_ro;`);
  const clean = apply('candidate.sql', true);
  assert.equal(clean.status, 0, `candidate failed to re-apply after the drift was removed:\n${clean.output}`);
  console.log('[prover] candidate re-applies cleanly; one overload; a drifted extra grantee fails the apply');

  // 8. MUTATION: drop the assignment test; the unassigned refusal must now fail.
  const guard = /AND \(v_is_admin OR c\.assigned_sales_rep = v_actor\)/;
  stageSql(CANDIDATE, 'mutant.sql', (sql) => {
    assert.ok(guard.test(sql), 'mutation anchor (assignment test) not found in the candidate');
    return sql.replace(guard, 'AND (v_is_admin OR true)');
  });
  const mutant = apply('mutant.sql', true);
  assert.equal(mutant.status, 0, `mutant failed to apply:\n${mutant.output}`);
  const mutantCall = removeAs(REP, DOC.mutation, 'prover-mutant-key');
  assert.ok(mutantCall.ok, 'sanity: mutant still removes an assigned document');
  psql(`INSERT INTO public.customer_documents (id,customer_id,document_type,storage_path,filename,mime_type,size_bytes,uploaded_by,source) VALUES ('${MUTANT_DOC}','${CUSTOMER_OTHER}','other','${docStoragePath(CUSTOMER_OTHER, MUTANT_DOC, 'mutant.pdf')}','mutant.pdf','application/pdf',100,'${ADMIN}','rep');`);
  const leaked = removeAs(REP, MUTANT_DOC, 'prover-mutant-key-2');
  assert.ok(leaked.ok, 'MUTATION NOT DETECTED: without the assignment check the unassigned rep was still refused, so step 5 does not test that check');
  const restored = apply('candidate.sql', true);
  assert.equal(restored.status, 0, `candidate failed to restore after the mutation:\n${restored.output}`);
  console.log('[prover] MUTATION: removing the assignment check lets an unassigned rep remove a document — step 5 detects it');

  // 9. The REGISTERED chain: scripts/smoke/smoke-specs.json points at this
  // prover, and run-smoke.mjs only loads work from that registry. Running the
  // chain here is what makes the registration real rather than declared — a
  // later edit to the guard trigger, the rep SELECT policy or the intent
  // helper breaks it. SMOKE_PASS_ROLLBACK is the only passing outcome, and it
  // guarantees the chain's own rows never persist.
  stageSql(SMOKE_CHAIN, 'smoke-chain.sql');
  const chain = docker([...psqlArgs(), '-f', '/tmp/smoke-chain.sql'], { allowFailure: true });
  const chainOutput = `${chain.stdout}\n${chain.stderr}`;
  assert.notEqual(chain.status, 0, `the registered chain must end by rolling back, not succeed:\n${chainOutput}`);
  assert.match(chainOutput, /SMOKE_PASS_ROLLBACK/, `registered chain failed:\n${chainOutput}`);
  assert.doesNotMatch(chainOutput, /SMOKE_FAIL|SMOKE_SETUP/, `registered chain reported a failure:\n${chainOutput}`);
  // starts_with(), not LIKE: in PostgreSQL LIKE only `%` and `_` are wildcards, so the
  // bracket-class idiom '[[]SMOKE]%' is a LITERAL prefix `[[]SMOKE]` that the chain's
  // `[SMOKE]-mine.pdf` rows can never match. That made this assertion unfailable.
  // The self-check below proves the matcher recognizes the exact names the chain inserts,
  // so a future rewrite cannot silently return to a pattern that matches nothing.
  assert.equal(
    scalar(
      "SELECT (starts_with('[SMOKE]-mine.pdf', '[SMOKE]') AND starts_with('[SMOKE]-other.pdf', '[SMOKE]')" +
      " AND NOT starts_with('invoice.pdf', '[SMOKE]'))::text;",
    ),
    'true',
    'leftover-row matcher is broken: it does not match the filenames the chain inserts',
  );
  assert.equal(
    scalar("SELECT count(*) FROM public.customer_documents WHERE starts_with(filename, '[SMOKE]');"),
    '0',
    'the registered chain left rows behind, so it did not roll back',
  );
  // 8b. MUTATION, second axis: drop the customer scope; the wrong-customer
  // refusal in step 5 must then fail, so that assertion really tests it.
  const customerGuard = /AND d\.customer_id = p_customer_id\n/;
  stageSql(CANDIDATE, 'mutant-customer.sql', (sql) => {
    assert.ok(customerGuard.test(sql), 'mutation anchor (customer scope) not found in the candidate');
    return sql.replace(customerGuard, '');
  });
  const customerMutant = apply('mutant-customer.sql', true);
  assert.equal(customerMutant.status, 0, `customer-scope mutant failed to apply:\n${customerMutant.output}`);
  const crossed = removeAs(ADMIN, DOC.roleCheck, 'prover-customer-mutant', 'authenticated', CUSTOMER_OTHER);
  assert.ok(
    crossed.ok,
    'MUTATION NOT DETECTED: without the customer scope the wrong-customer call was still refused, so step 5 does not test that scope',
  );
  const restoredCustomer = apply('candidate.sql', true);
  assert.equal(restoredCustomer.status, 0, `candidate failed to restore after the customer-scope mutation:\n${restoredCustomer.output}`);
  console.log('[prover] MUTATION: removing the customer scope lets a wrong-customer call through — step 5 detects it');

  // A chain that cannot fail proves nothing, and this one is the entry point a
  // later session will trust. Re-apply the mutant (assignment test removed) and
  // require the chain to REPORT it, then restore.
  const mutantForChain = apply('mutant.sql', true);
  assert.equal(mutantForChain.status, 0, `mutant failed to apply for the chain self-check:\n${mutantForChain.output}`);
  const mutantChain = docker([...psqlArgs(), '-f', '/tmp/smoke-chain.sql'], { allowFailure: true });
  const mutantChainOutput = `${mutantChain.stdout}\n${mutantChain.stderr}`;
  assert.doesNotMatch(
    mutantChainOutput,
    /SMOKE_PASS_ROLLBACK/,
    `CHAIN MUTATION NOT DETECTED: the chain passed against a function with no assignment check:\n${mutantChainOutput}`,
  );
  assert.match(mutantChainOutput, /SMOKE_FAIL: a rep removed a document of a customer assigned to someone else/, mutantChainOutput);
  const restoredForChain = apply('candidate.sql', true);
  assert.equal(restoredForChain.status, 0, `candidate failed to restore after the chain self-check:\n${restoredForChain.output}`);
  console.log('[prover] registered chain scripts/smoke/smoke-customer-document-rep-soft-delete.sql passed, rolled back, and FAILS against the mutant');

  console.log('CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS before=rls_refused fix=rep_removes replay=bound no_new_access=true admin=ok reapply=ok mutation=detected');
}

try { await main(); }
finally { docker(['rm', '-f', NAME], { allowFailure: true }); }
