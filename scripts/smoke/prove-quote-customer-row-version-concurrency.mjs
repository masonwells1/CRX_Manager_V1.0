#!/usr/bin/env node
/**
 * Network-isolated PostgreSQL 17 concurrency proof. It never reads a database
 * URL or contacts Supabase. The companion rollback smoke executes the real
 * save RPCs after the governed apply; this script proves the locking/token
 * primitive and rejects a migration whose canonical bodies lost known guards.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const migration = path.join(root, 'supabase/migrations/20260730031925_quote_customer_row_version_guard.sql');
const previous = path.join(root, 'supabase/migrations/20260722202622_commission_split_lost_update_guard.sql');
const name = `crx-row-version-proof-${process.pid}-${Date.now().toString(36)}`;

function docker(args, input, allowFailure = false) {
  const result = spawnSync('docker', args, { cwd: root, input, encoding: 'utf8' });
  if (result.error || (!allowFailure && result.status !== 0)) {
    throw new Error(`${result.error?.message ?? result.stderr}\n${result.stdout}`.trim());
  }
  return result;
}
function psql(sql, allowFailure = false) {
  return docker(['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], sql, allowFailure);
}
function scalar(sql) {
  return psql(sql).stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
}
function asyncSql(sql) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { cwd: root });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(sql);
  });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealthyPostgres() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const ready = docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'postgres'], undefined, true);
    if (ready.status === 0) {
      // pg_isready can report success just before psql accepts a connection.
      const query = docker(['exec', name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-Atqc', 'SELECT 1'], undefined, true);
      if (query.status === 0 && query.stdout.trim() === '1') return;
    }
    await wait(250);
  }
  const logs = docker(['logs', name], undefined, true).stdout + docker(['logs', name], undefined, true).stderr;
  throw new Error(`local PostgreSQL did not become healthy within 20 seconds\n${logs}`);
}

function assertCanonicalContract() {
  const current = readFileSync(migration, 'utf8');
  const prior = readFileSync(previous, 'utf8');
  const extract = (source, name, nextName) => {
    const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
    const end = nextName ? source.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start) : source.indexOf('-- Self-contained ACL', start);
    assert.ok(start >= 0 && end > start, `could not extract ${name} body`);
    return source.slice(start, end).replace(/\r\n/g, '\n').trim();
  };
  const priorQuote = extract(prior, 'save_quote', 'save_customer');
  const priorQuoteHeaderUpdate = priorQuote.match(/\n    UPDATE quotes SET[\s\S]*?\n    WHERE id = p_quote_id;\n/)?.[0];
  assert.ok(priorQuoteHeaderUpdate, 'could not extract prior quote header update');
  const restorePriorQuoteUpdateShape = (body) => body
    .replace(
      /\n  -- One logical save must produce exactly one quote UPDATE\.[\s\S]*?\n  UPDATE quotes SET\n    customer_id =[\s\S]*?(?=    total_price =)/,
      '\n  UPDATE quotes SET\n',
    )
    .replace(
      '\n    v_quote_id := p_quote_id;',
      `${priorQuoteHeaderUpdate}\n    v_quote_id := p_quote_id;`,
    );
  const stripQuoteToken = (body) => body
    .replace('  v_old_row_version bigint;\n', '')
    .replace('  v_expected_row_version bigint;\n', '')
    .replace('SELECT status, commission_split, row_version\n      INTO v_old_status, v_old_commission_split, v_old_row_version', 'SELECT status, commission_split\n      INTO v_old_status, v_old_commission_split')
    .replace(/\n    IF NOT \(p_quote_payload \? 'row_version_expected'\)[\s\S]*?\n    END IF;\n(?=\n    UPDATE quotes SET)/, '')
    .replace(",\n    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id)", '');
  const stripCustomerToken = (body) => body
    .replace('  v_old_row_version bigint;\n', '')
    .replace('  v_expected_row_version bigint;\n', '')
    .replace('SELECT default_commission_split, row_version\n      INTO v_old_commission_split, v_old_row_version', 'SELECT default_commission_split\n      INTO v_old_commission_split')
    .replace(/\n    IF NOT \(p_customer_payload \? 'row_version_expected'\)[\s\S]*?\n    END IF;\n(?=\n    UPDATE customers SET)/, '')
    .replace(",\n    'row_version', (SELECT row_version FROM customers WHERE id = v_customer_id)", '');
  const normalizeSqlLayout = (body) => body.replace(/\s+/g, ' ').trim();
  assert.equal(
    normalizeSqlLayout(stripQuoteToken(restorePriorQuoteUpdateShape(extract(current, 'save_quote', 'save_customer')))),
    normalizeSqlLayout(priorQuote),
    'save_quote changed outside the audited row-version delta',
  );
  assert.equal(
    normalizeSqlLayout(stripCustomerToken(extract(current, 'save_customer'))),
    normalizeSqlLayout(extract(prior, 'save_customer')),
    'save_customer changed outside the audited row-version delta',
  );
  const quoteGuard = current.indexOf('COMMISSION_SPLIT_CONFLICT');
  const quoteVersion = current.indexOf('QUOTE_STALE_WRITE');
  const customerGuard = current.lastIndexOf('COMMISSION_SPLIT_CONFLICT');
  const customerVersion = current.indexOf('CUSTOMER_STALE_WRITE');
  assert.ok(quoteGuard >= 0 && quoteGuard < quoteVersion, 'quote split conflict must precede generic stale guard');
  assert.ok(customerGuard >= 0 && customerGuard < customerVersion, 'customer split conflict must precede generic stale guard');

  const currentQuote = extract(current, 'save_quote', 'save_customer');
  assert.equal(
    currentQuote.match(/\bUPDATE quotes SET\b/g)?.length,
    1,
    'save_quote must use one parent UPDATE so one logical save bumps row_version exactly once',
  );
  assert.match(
    currentQuote,
    /UPDATE quotes SET[\s\S]*customer_id =[\s\S]*total_price =[\s\S]*WHERE id = v_quote_id;/,
    'save_quote must consolidate header and calculated totals into its single parent UPDATE',
  );
}

function assertChildOwnershipContract() {
  const current = readFileSync(migration, 'utf8');
  const smoke = readFileSync(path.join(root, 'scripts/smoke/smoke-save-quote-customer-row-version.sql'), 'utf8');
  for (const table of ['quote_sections', 'quote_items', 'customer_addresses']) {
    assert.match(
      current,
      new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${table} FROM PUBLIC, anon, authenticated;`),
      `${table} must revoke normal-app direct DML`,
    );
    assert.doesNotMatch(current, new RegExp(`CREATE TRIGGER[^;]+ON public\\.${table}`, 'i'), `${table} must not use a child-to-parent bump trigger`);
  }
  assert.match(smoke, /SET LOCAL ROLE authenticated;/, 'registered smoke must run direct-child probes as the normal app role');
  assert.match(smoke, /authenticated direct child DML succeeded/, 'registered smoke must reject every direct child DML verb');

  const visit = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? visit(full) : [full];
  });
  const childMutation = /\.from\(['"](quote_sections|quote_items|customer_addresses)['"]\)[\s\S]{0,500}?\.(?:insert|update|upsert|delete)\(/;
  for (const table of ['quote_sections', 'quote_items', 'customer_addresses']) {
    assert.match(
      `supabase.from('${table}').upsert({ id: 'direct-child-write' })`,
      childMutation,
      `${table} frontend upserts must stay RPC-owned`,
    );
  }
  const offenders = visit(path.join(root, 'src'))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => childMutation.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], `frontend child writes must stay RPC-owned: ${offenders.join(', ')}`);
}

async function race(table, fn, reverseLockOrder) {
  psql(`TRUNCATE TABLE public.${table}; INSERT INTO public.${table}(id,value,row_version) VALUES ('one','original',1);`);
  // In the reverse path the first client is deliberately held *before* it
  // calls the locking function, so the later-labelled client owns the row.
  const first = asyncSql(`${reverseLockOrder ? 'SELECT pg_sleep(.25); ' : ''}SELECT public.${fn}('one', 'first', 1, ${reverseLockOrder ? 0 : 1}, 'race-${table}-${reverseLockOrder}-first');`);
  await wait(75);
  const second = asyncSql(`SELECT public.${fn}('one', 'second', 1, ${reverseLockOrder ? 1 : 0}, 'race-${table}-${reverseLockOrder}-second');`);
  const [a, b] = await Promise.all([first, second]);
  const successes = [a, b].filter((result) => result.code === 0);
  const failures = [a, b].filter((result) => result.code !== 0);
  assert.equal(successes.length, 1, `${table} expected exactly one writer to win`);
  assert.equal(failures.length, 1, `${table} expected exactly one stale rejection`);
  assert.match(`${failures[0].err}${failures[0].out}`, new RegExp(`${table === 'quotes' ? 'QUOTE' : 'CUSTOMER'}_STALE_WRITE`));
  assert.equal(scalar(`SELECT value FROM public.${table} WHERE id='one';`), reverseLockOrder ? 'second' : 'first', `${table} did not use the requested lock order`);
}

async function main() {
  assertCanonicalContract();
  assertChildOwnershipContract();
  try {
    docker(['run', '-d', '--rm', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine']);
    await waitForHealthyPostgres();
    psql(`
CREATE TABLE public.quotes(id text PRIMARY KEY, value text NOT NULL, row_version bigint NOT NULL DEFAULT 1);
CREATE TABLE public.customers(id text PRIMARY KEY, value text NOT NULL, row_version bigint NOT NULL DEFAULT 1);
CREATE TABLE public.idempotency_keys(idempotency_key text NOT NULL, operation text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(idempotency_key, operation));
CREATE OR REPLACE FUNCTION public.bump_record_row_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.row_version := OLD.row_version + 1; RETURN NEW; END $$;
CREATE TRIGGER quotes_bump BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.bump_record_row_version();
CREATE TRIGGER customers_bump BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.bump_record_row_version();
CREATE OR REPLACE FUNCTION public.checked_quote(p_id text,p_value text,p_expected bigint,p_pause int,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v bigint; v_cached jsonb; v_result jsonb; BEGIN SELECT result INTO v_cached FROM public.idempotency_keys WHERE idempotency_key=p_key AND operation='save_quote'; IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; SELECT row_version INTO v FROM public.quotes WHERE id=p_id FOR UPDATE; IF p_pause=1 THEN PERFORM pg_sleep(.35); END IF; IF p_expected IS DISTINCT FROM v THEN RAISE EXCEPTION 'QUOTE_STALE_WRITE'; END IF; UPDATE public.quotes SET value=p_value WHERE id=p_id; SELECT jsonb_build_object('id',p_id,'row_version',row_version,'value',value) INTO v_result FROM public.quotes WHERE id=p_id; INSERT INTO public.idempotency_keys VALUES(p_key,'save_quote',v_result); RETURN v_result; END $$;
CREATE OR REPLACE FUNCTION public.checked_customer(p_id text,p_value text,p_expected bigint,p_pause int,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v bigint; v_cached jsonb; v_result jsonb; BEGIN SELECT result INTO v_cached FROM public.idempotency_keys WHERE idempotency_key=p_key AND operation='save_customer'; IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; SELECT row_version INTO v FROM public.customers WHERE id=p_id FOR UPDATE; IF p_pause=1 THEN PERFORM pg_sleep(.35); END IF; IF p_expected IS DISTINCT FROM v THEN RAISE EXCEPTION 'CUSTOMER_STALE_WRITE'; END IF; UPDATE public.customers SET value=p_value WHERE id=p_id; SELECT jsonb_build_object('id',p_id,'row_version',row_version,'value',value) INTO v_result FROM public.customers WHERE id=p_id; INSERT INTO public.idempotency_keys VALUES(p_key,'save_customer',v_result); RETURN v_result; END $$;
INSERT INTO public.quotes VALUES ('one','original',1); INSERT INTO public.customers VALUES ('one','original',1);
`);
    // Exact pre-fix failure: the second whole-record writer wins.
    psql("UPDATE public.quotes SET value='newer' WHERE id='one'; UPDATE public.quotes SET value='stale' WHERE id='one'; UPDATE public.customers SET value='newer' WHERE id='one'; UPDATE public.customers SET value='stale' WHERE id='one';");
    assert.equal(scalar("SELECT value FROM public.quotes WHERE id='one'"), 'stale');
    assert.equal(scalar("SELECT value FROM public.customers WHERE id='one'"), 'stale');
    for (const [table, fn] of [['quotes', 'checked_quote'], ['customers', 'checked_customer']]) {
      await race(table, fn, false);
      await race(table, fn, true);
    }
    const quoteReplayOne = scalar("SELECT public.checked_quote('one','fresh',2,0,'quote-replay')::text");
    const quoteReplayTwo = scalar("SELECT public.checked_quote('one','ignored',999,0,'quote-replay')::text");
    assert.equal(quoteReplayTwo, quoteReplayOne, 'quote idempotent replay must return original result');
    const customerReplayOne = scalar("SELECT public.checked_customer('one','fresh',2,0,'customer-replay')::text");
    const customerReplayTwo = scalar("SELECT public.checked_customer('one','ignored',999,0,'customer-replay')::text");
    assert.equal(customerReplayTwo, customerReplayOne, 'customer idempotent replay must return original result');
    psql("INSERT INTO public.quotes(id,value) VALUES ('new','inserted'); INSERT INTO public.customers(id,value) VALUES ('new','inserted');");
    assert.equal(scalar("SELECT row_version FROM public.quotes WHERE id='new'"), '1');
    assert.equal(scalar("SELECT row_version FROM public.customers WHERE id='new'"), '1');
    console.log('ROW_VERSION_DISPOSABLE_PROOF_PASS pre_fix_overwrite=confirmed canonical_contract=preserved quote_single_bump_shape=verified quote_lock_orders=both customer_lock_orders=both idempotent_replay=real insert_defaults=verified');
  } finally {
    docker(['rm', '-f', name], undefined, true);
  }
}
main().catch((error) => { console.error(`ROW_VERSION_DISPOSABLE_PROOF_FAIL ${error.stack || error.message}`); process.exitCode = 1; });
