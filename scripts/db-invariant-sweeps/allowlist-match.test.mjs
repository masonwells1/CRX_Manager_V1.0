#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSweepQuery, functionContractSql, subtractAllowlist, hasStatementBreak, stripLeadingComments } from './allowlist-match.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const allowlist = JSON.parse(readFileSync(new URL('./allowlist.json', import.meta.url), 'utf8'));
const actorEntries = allowlist.entries.filter((entry) => entry.predicate.startsWith('actor-forgery'));
const scratch = mkdtempSync(path.join(tmpdir(), 'crx-actor-allowlist-'));
let assertions = 0;
function equal(actual, expected, message) { assert.deepEqual(actual, expected, message); assertions += 1; }
function check(condition, message) { assert.ok(condition, message); assertions += 1; }

try {
  equal(actorEntries.length, 21, '20 new exceptions plus bound legacy cancel_delivery; no stale transfer exemption');
  check(!actorEntries.some((entry) => entry.violation_key.startsWith('transfer_job_to_invoice(')), 'remove unused identity-only exemption');
  const cancelPurchaseOrder = actorEntries.find((entry) => entry.violation_key.startsWith('cancel_purchase_order('));
  for (const helper of ['public.is_admin()', 'public.is_sales_rep()']) {
    check(Object.hasOwn(cancelPurchaseOrder.reviewed_contracts, helper), `cancel_purchase_order must pin its ${helper} role gate`);
  }
  for (const entry of actorEntries) {
    const row = { violation_key: entry.violation_key, suspect_param: entry.suspect_param };
    check(typeof entry.suspect_param === 'string' && entry.suspect_param.length > 0, `${entry.violation_key}: exact parameter required`);
    check(entry.reviewed_contracts && Object.hasOwn(entry.reviewed_contracts, `public.${entry.violation_key}`), 'public definition pin required');
    check(Object.hasOwn(entry.reviewed_contracts, 'auth.uid()'), 'identity-source definition pin required');
    const catalog = Object.entries(entry.reviewed_contracts).map(([function_key, contract_md5]) => ({ function_key, contract_md5 }));
    equal(subtractAllowlist(entry.predicate, [row], [entry], catalog), [], 'reviewed row/contract matches');
    equal(subtractAllowlist(entry.predicate, [{ ...row, suspect_param: 'p_unreviewed_actor' }], [entry], catalog).length, 1, 'different parameter remains visible');
    equal(subtractAllowlist(entry.predicate, [row], [entry]).length, 1, 'missing live metadata fails closed');
    equal(subtractAllowlist(entry.predicate, [row], [{ ...entry, reviewed_contracts: {} }], catalog).length, 1, 'empty reviewed metadata fails closed');
    equal(subtractAllowlist(entry.predicate, [row], [{ ...entry, reviewed_contracts: null }], catalog).length, 1, 'null reviewed metadata fails closed');
    equal(subtractAllowlist(entry.predicate, [row], [{ ...entry, reviewed_contracts: [] }], catalog).length, 1, 'malformed reviewed metadata fails closed');
    equal(subtractAllowlist(entry.predicate, [row], [{ predicate: entry.predicate, violation_key: entry.violation_key }], catalog).length, 1, 'actor entry cannot fall back to identity-only matching');
    equal(subtractAllowlist(entry.predicate, [row], [entry], [...catalog, catalog[0]]).length, 1, 'duplicate catalog identity fails closed');
    for (const pin of catalog) {
      check(/^[a-f0-9]{32}$/.test(pin.contract_md5), 'every reviewed contract is a database-side digest');
      equal(subtractAllowlist(entry.predicate, [row], [entry], catalog.filter((item) => item.function_key !== pin.function_key)).length, 1, 'each missing dependency fails closed');
      const changed = catalog.map((item) => item.function_key === pin.function_key ? { ...item, contract_md5: '0'.repeat(32) } : item);
      equal(subtractAllowlist(entry.predicate, [row], [entry], changed).length, 1, 'each changed public/helper contract fails closed');
    }
  }

  const delivery = actorEntries.find((entry) => entry.violation_key.startsWith('complete_delivery('));
  const deliveryCatalog = Object.entries(delivery.reviewed_contracts).map(([function_key, contract_md5]) => ({ function_key, contract_md5 }));
  const signed = { violation_key: delivery.violation_key, suspect_param: 'p_signed_by' };
  const forged = { violation_key: delivery.violation_key, suspect_param: 'p_performed_by' };
  equal(subtractAllowlist(delivery.predicate, [signed, forged], [delivery], deliveryCatalog), [forged], 'PR652 P1: signature-name exception must not clear actual actor parameter');

  const legacy = { predicate: 'fin-prepay-balance', violation_key: 'opaque-existing-baseline' };
  const futureActor = { predicate: 'actor-forgery-inventory', violation_key: delivery.violation_key };
  equal(subtractAllowlist(futureActor.predicate, [signed], [futureActor], deliveryCatalog), [signed],
    'an actor-shaped detector row cannot fall back to identity-only matching under a new predicate name');
  equal(subtractAllowlist(legacy.predicate, [{ violation_key: legacy.violation_key }, { violation_key: 'new' }], [legacy]), [{ violation_key: 'new' }], 'unrelated non-actor baselines unchanged');
  // Callers filter the allowlist by predicate, but the binding must hold inside the matcher: a
  // caller that passes the WHOLE allowlist cannot let one predicate's reviewed exception clear
  // another predicate's row that happens to share the violation_key (CodeRabbit on #774).
  equal(subtractAllowlist('some-other-predicate', [{ violation_key: legacy.violation_key }], [legacy]),
    [{ violation_key: legacy.violation_key }], 'an unbound baseline cannot suppress a row adjudicated under a different predicate');
  equal(subtractAllowlist(delivery.predicate, [signed], [{ ...delivery, predicate: 'actor-forgery-fin-audit' }], deliveryCatalog),
    [signed], 'a fully reviewed actor exception is still bound to its own predicate');
  assert.throws(() => subtractAllowlist('actor-forgery', [{}], []), /violation_key/); assertions += 1;
  assert.throws(() => subtractAllowlist('', [{ violation_key: 'x' }], []), /predicate/); assertions += 1;
  assert.throws(() => subtractAllowlist(undefined, [{ violation_key: 'x' }], []), /predicate/); assertions += 1;
  const query = functionContractSql(["public.untrusted('); DELETE FROM profiles; --)"]);
  check(query.includes("'public.untrusted(''); DELETE FROM profiles; --)'"), 'catalog identities are escaped SQL data, not executable SQL');
  check(query.includes('pg_get_functiondef') && query.includes('has_function_privilege') && query.includes('pg_get_userbyid') && query.includes('aclexplode'), 'definition, owner, direct and effective ACL all participate');
  const wrapped = buildSweepQuery({ name: 'actor-forgery', sql: 'SELECT 1 AS violation_key;' }, [delivery]);
  check(wrapped.includes("'function_contracts'") && wrapped.includes("'rows'") && wrapped.startsWith('SELECT json_build_object('), 'one statement contains detector and required catalog metadata');

  // buildSweepQuery inlines the predicate into FROM (...), which only holds for a SINGLE SELECT.
  // Anything that still terminates a statement must be refused HERE, not pasted in to fail as a
  // syntax error against the live database. The scan has to ignore comments and quoted spans: 27 of
  // the 29 shipped predicates contain a semicolon inside explanatory `--` prose, so a bare
  // includes(';') would reject almost all of them. (CodeRabbit on PR #789.)
  check(hasStatementBreak('SELECT 1; SELECT 2') === true, 'a second statement is a statement break');
  check(hasStatementBreak('SELECT 1 AS a') === false, 'a lone SELECT is not');
  check(hasStatementBreak('-- policy on quote_versions; and more\nSELECT 1') === false,
    'a semicolon inside a line comment is prose, not a statement break');
  check(hasStatementBreak('/* a; b */ SELECT 1') === false, 'a semicolon inside a block comment is prose');
  check(hasStatementBreak("SELECT 'a; b' AS lit") === false, 'a semicolon inside a literal is data');
  check(hasStatementBreak('SELECT $q$a; b$q$ AS lit') === false, 'a semicolon inside a dollar-quote is data');
  check(hasStatementBreak('SELECT "od;d" AS x') === false, 'a semicolon inside a quoted identifier is a name');
  assert.throws(
    () => buildSweepQuery({ name: 'actor-forgery', sql: 'CREATE OR REPLACE FUNCTION pg_temp.f() RETURNS int LANGUAGE sql AS $$SELECT 1$$; SELECT 1 AS violation_key;' }, [delivery]),
    /not a single SELECT/,
  ); assertions += 1;
  assert.throws(
    // The trailing-strip regex cannot reach a `;` followed by a comment, so this would be inlined.
    () => buildSweepQuery({ name: 'actor-forgery', sql: 'SELECT 1 AS violation_key;\n-- trailing note\n' }, [delivery]),
    /not a single SELECT/,
  ); assertions += 1;
  // A single statement is not enough: it must be a SELECT. VALUES (1) has no statement break yet
  // yields rows with no violation_key. (CodeRabbit on PR #790.)
  assert.throws(
    () => buildSweepQuery({ name: 'actor-forgery', sql: 'VALUES (1)' }, [delivery]),
    /must be a SELECT/,
  ); assertions += 1;
  assert.throws(
    () => buildSweepQuery({ name: 'actor-forgery', sql: 'TABLE pg_proc' }, [delivery]),
    /must be a SELECT/,
  ); assertions += 1;
  assert.doesNotThrow(
    () => buildSweepQuery({ name: 'actor-forgery', sql: '-- leading note\n/* and a block */\nWITH x AS (SELECT 1 AS violation_key) SELECT * FROM x' }, [delivery]),
    'a WITH prelude behind comments is accepted',
  ); assertions += 1;
  check(stripLeadingComments('-- a\n/* b */ SELECT 1').startsWith('SELECT'), 'leading comments are skipped when reading the first keyword');

  // Every predicate actually shipped must still build, or this guard is too strict to live with.
  {
    const predicateDir = path.join(root, 'scripts/db-invariant-sweeps/predicates');
    const shipped = readdirSync(predicateDir).filter((f) => f.endsWith('.sql')).sort();
    check(shipped.length >= 29, 'the predicate directory was found');
    for (const file of shipped) {
      const sql = readFileSync(path.join(predicateDir, file), 'utf8');
      assert.doesNotThrow(
        () => buildSweepQuery({ name: file.replace(/\.sql$/, ''), sql }, []),
        `shipped predicate ${file} must still wrap`,
      );
      assertions += 1;
    }
  }

  const capture = path.join(scratch, 'captured.json');
  // Force captured/print modes without reading, printing, or using any connection secret.
  const env = { ...process.env, SUPABASE_DB_URL: '', DB_SWEEPS_REQUIRE_LIVE: '' };
  const runner = path.join(root, 'scripts/db-invariant-sweeps/run-sweeps.mjs');
  const run = (extra = []) => spawnSync(process.execPath, [runner, '--adjudicate', capture, '--only', 'actor-forgery', ...extra], { cwd: root, env, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const packet = { predicate: 'actor-forgery', rows: [signed], function_contracts: deliveryCatalog };
  writeFileSync(capture, JSON.stringify([packet]));
  let result = run();
  equal(result.status, 0, result.stderr);
  equal(JSON.parse(result.stdout).execution, 'captured-results-only', 'capture adjudication is not linked-live certification');
  writeFileSync(capture, JSON.stringify([{ ...packet, rows: [signed, forged] }]));
  result = run();
  equal(result.status, 1, 'real actor-param row fails the actual CLI');
  equal(JSON.parse(result.stdout).summary[0].violations, [forged], 'CLI uses same parameter-bound matcher');
  const largeRows = Array.from({ length: 5000 }, (_, index) => ({ ...forged, fixture_index: index }));
  writeFileSync(capture, JSON.stringify([{ ...packet, rows: largeRows }]));
  result = run();
  equal(result.status, 1, 'large unallowlisted capture retains failure exit code');
  equal(JSON.parse(result.stdout).summary[0].violations, largeRows, 'piped adjudication flushes the complete JSON without falling through into live/print mode');
  writeFileSync(capture, JSON.stringify([{ ...packet, function_contracts: [] }]));
  equal(run().status, 1, 'missing live contracts fail actual CLI');
  // An OMITTED key is a packet from the wrong or an older query, not an empty catalog. With no rows
  // it would otherwise adjudicate PASS on metadata that was never read (CodeRabbit on #774).
  const withoutContracts = { predicate: packet.predicate, rows: packet.rows };
  writeFileSync(capture, JSON.stringify([withoutContracts]));
  equal(run().status, 2, 'a packet omitting function_contracts is an error, never a pass');
  writeFileSync(capture, JSON.stringify([{ ...withoutContracts, rows: [] }]));
  equal(run().status, 2, 'and still an error when it carries no rows at all');
  writeFileSync(capture, JSON.stringify([{ ...packet, rows: [{}] }]));
  equal(run().status, 2, 'invalid row contract is an error, never green');
  writeFileSync(capture, JSON.stringify([]));
  equal(run().status, 2, 'missing selected predicate is not an empty successful sweep');
  writeFileSync(capture, JSON.stringify([packet, packet]));
  equal(run().status, 2, 'duplicate packet is not success');
  writeFileSync(capture, JSON.stringify([{ ...packet, predicate: 'unknown' }]));
  equal(run().status, 2, 'unknown predicate is an error');
  writeFileSync(capture, JSON.stringify([packet]));
  equal(run(['--strict']).status, 2, 'captured JSON cannot satisfy strict linked-live execution');
  const printed = spawnSync(process.execPath, [runner, '--only', 'actor-forgery'], { cwd: root, env, encoding: 'utf8' });
  equal(printed.status, 0, printed.stderr);
  check(printed.stdout.includes('--adjudicate') && printed.stdout.includes('key-only comparison is NOT sufficient') && printed.stdout.includes("'function_contracts'"), 'MCP instructions preserve the exact matcher/metadata contract');
  console.log(`ACTOR_ALLOWLIST_MATCH_PASS ${assertions} assertions; actual CLI mutation refusals observed`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
