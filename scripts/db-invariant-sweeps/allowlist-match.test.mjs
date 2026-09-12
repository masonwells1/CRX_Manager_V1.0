#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildSweepQuery, functionContractSql, subtractAllowlist } from './allowlist-match.mjs';

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
  for (const entry of actorEntries) {
    const row = { violation_key: entry.violation_key, suspect_param: entry.suspect_param };
    check(typeof entry.suspect_param === 'string' && entry.suspect_param.length > 0, `${entry.violation_key}: exact parameter required`);
    check(entry.reviewed_contracts && Object.hasOwn(entry.reviewed_contracts, `public.${entry.violation_key}`), 'public definition pin required');
    check(Object.hasOwn(entry.reviewed_contracts, 'auth.uid()'), 'identity-source definition pin required');
    const catalog = Object.entries(entry.reviewed_contracts).map(([function_key, contract_md5]) => ({ function_key, contract_md5 }));
    equal(subtractAllowlist([row], [entry], catalog), [], 'reviewed row/contract matches');
    equal(subtractAllowlist([{ ...row, suspect_param: 'p_unreviewed_actor' }], [entry], catalog).length, 1, 'different parameter remains visible');
    equal(subtractAllowlist([row], [entry]).length, 1, 'missing live metadata fails closed');
    equal(subtractAllowlist([row], [{ ...entry, reviewed_contracts: {} }], catalog).length, 1, 'empty reviewed metadata fails closed');
    equal(subtractAllowlist([row], [{ ...entry, reviewed_contracts: null }], catalog).length, 1, 'null reviewed metadata fails closed');
    equal(subtractAllowlist([row], [{ ...entry, reviewed_contracts: [] }], catalog).length, 1, 'malformed reviewed metadata fails closed');
    equal(subtractAllowlist([row], [{ predicate: entry.predicate, violation_key: entry.violation_key }], catalog).length, 1, 'actor entry cannot fall back to identity-only matching');
    equal(subtractAllowlist([row], [entry], [...catalog, catalog[0]]).length, 1, 'duplicate catalog identity fails closed');
    for (const pin of catalog) {
      check(/^[a-f0-9]{32}$/.test(pin.contract_md5), 'every reviewed contract is a database-side digest');
      equal(subtractAllowlist([row], [entry], catalog.filter((item) => item.function_key !== pin.function_key)).length, 1, 'each missing dependency fails closed');
      const changed = catalog.map((item) => item.function_key === pin.function_key ? { ...item, contract_md5: '0'.repeat(32) } : item);
      equal(subtractAllowlist([row], [entry], changed).length, 1, 'each changed public/helper contract fails closed');
    }
  }

  const delivery = actorEntries.find((entry) => entry.violation_key.startsWith('complete_delivery('));
  const deliveryCatalog = Object.entries(delivery.reviewed_contracts).map(([function_key, contract_md5]) => ({ function_key, contract_md5 }));
  const signed = { violation_key: delivery.violation_key, suspect_param: 'p_signed_by' };
  const forged = { violation_key: delivery.violation_key, suspect_param: 'p_performed_by' };
  equal(subtractAllowlist([signed, forged], [delivery], deliveryCatalog), [forged], 'PR652 P1: signature-name exception must not clear actual actor parameter');

  const legacy = { predicate: 'fin-prepay-balance', violation_key: 'opaque-existing-baseline' };
  equal(subtractAllowlist([{ violation_key: legacy.violation_key }, { violation_key: 'new' }], [legacy]), [{ violation_key: 'new' }], 'unrelated non-actor baselines unchanged');
  assert.throws(() => subtractAllowlist([{}], []), /violation_key/); assertions += 1;
  const query = functionContractSql(["public.untrusted('); DELETE FROM profiles; --)"]);
  check(query.includes("'public.untrusted(''); DELETE FROM profiles; --)'"), 'catalog identities are escaped SQL data, not executable SQL');
  check(query.includes('pg_get_functiondef') && query.includes('has_function_privilege') && query.includes('pg_get_userbyid') && query.includes('aclexplode'), 'definition, owner, direct and effective ACL all participate');
  const wrapped = buildSweepQuery({ name: 'actor-forgery', sql: 'SELECT 1 AS violation_key;' }, [delivery]);
  check(wrapped.includes("'function_contracts'") && wrapped.includes("'rows'") && wrapped.startsWith('SELECT json_build_object('), 'one statement contains detector and required catalog metadata');

  const capture = path.join(scratch, 'captured.json');
  // Force captured/print modes without reading, printing, or using any connection secret.
  const env = { ...process.env, SUPABASE_DB_URL: '', DB_SWEEPS_REQUIRE_LIVE: '' };
  const runner = path.join(root, 'scripts/db-invariant-sweeps/run-sweeps.mjs');
  const run = (extra = []) => spawnSync(process.execPath, [runner, '--adjudicate', capture, '--only', 'actor-forgery', ...extra], { cwd: root, env, encoding: 'utf8' });
  const packet = { predicate: 'actor-forgery', rows: [signed], function_contracts: deliveryCatalog };
  writeFileSync(capture, JSON.stringify([packet]));
  let result = run();
  equal(result.status, 0, result.stderr);
  equal(JSON.parse(result.stdout).execution, 'captured-results-only', 'capture adjudication is not linked-live certification');
  writeFileSync(capture, JSON.stringify([{ ...packet, rows: [signed, forged] }]));
  result = run();
  equal(result.status, 1, 'real actor-param row fails the actual CLI');
  equal(JSON.parse(result.stdout).summary[0].violations, [forged], 'CLI uses same parameter-bound matcher');
  writeFileSync(capture, JSON.stringify([{ ...packet, function_contracts: [] }]));
  equal(run().status, 1, 'missing live contracts fail actual CLI');
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
