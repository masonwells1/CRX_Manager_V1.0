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
function asyncSql(sql, applicationName) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', '-e', `PGAPPNAME=${applicationName}`, name, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t', '-v', 'ON_ERROR_STOP=1'], { cwd: root });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.end(sql);
  });
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForPgSleep(applicationName) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const sleepers = scalar(`
      SELECT count(*)
      FROM pg_stat_activity
      WHERE application_name = '${applicationName}'
        AND wait_event = 'PgSleep'
        AND pid <> pg_backend_pid();
    `);
    if (sleepers === '1') return;
    await wait(25);
  }
  throw new Error(`timed out waiting for ${applicationName} to reach its controlled sleep`);
}

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

function extractFunction(source, functionName, nextName) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION public.${functionName}`);
  const end = nextName ? source.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start) : source.indexOf('-- Self-contained ACL', start);
  assert.ok(start >= 0 && end > start, `could not extract ${functionName} body`);
  return source.slice(start, end).replace(/\r\n/g, '\n').trim();
}

function extractQuoteUpdate(body, whereId) {
  const matches = [...body.matchAll(/\n\s+UPDATE quotes SET[\s\S]*?\n\s+WHERE id = ([^;]+);/g)]
    .filter((match) => match[1].trim() === whereId)
    .map((match) => match[0]);
  assert.equal(matches.length, 1, `expected one quote UPDATE ending WHERE id = ${whereId}`);
  return matches[0];
}

function parseUpdateAssignments(update) {
  const setStart = update.indexOf('UPDATE quotes SET') + 'UPDATE quotes SET'.length;
  const whereStart = update.lastIndexOf('\n');
  assert.ok(setStart >= 'UPDATE quotes SET'.length && whereStart > setStart, 'could not isolate quote UPDATE assignments');
  const assignmentsSource = update.slice(setStart, whereStart);
  const starts = [...assignmentsSource.matchAll(/^\s+([a-z_][a-z0-9_]*)\s*=\s*/gm)];
  assert.ok(starts.length > 0, 'quote UPDATE has no assignments');
  return starts.map((match, index) => {
    const expressionStart = match.index + match[0].length;
    const expressionEnd = index + 1 < starts.length ? starts[index + 1].index : assignmentsSource.length;
    return {
      field: match[1],
      expression: assignmentsSource.slice(expressionStart, expressionEnd).replace(/,\s*$/, '').replace(/\s+/g, ' ').trim(),
    };
  });
}

function extractQuoteValidationBlock(body) {
  const match = body.match(/\n    IF v_status IS DISTINCT FROM v_old_status THEN[\s\S]*?\n    -- >>>LAYER2\n/);
  assert.ok(match, 'could not extract canonical quote lifecycle/unplanning validation block');
  return match[0];
}

function extractQuoteRowVersionBlock(body) {
  const match = body.match(/\n    IF NOT \(p_quote_payload \? 'row_version_expected'\)[\s\S]*?\n    v_expected_row_version := \(p_quote_payload->>'row_version_expected'\)::bigint;\n    IF v_expected_row_version IS DISTINCT FROM v_old_row_version THEN[\s\S]*?\n    END IF;\n/);
  assert.ok(match, 'could not extract quote row-version conflict block');
  return match[0];
}

function assertQuoteValidationOrder(source) {
  const body = extractFunction(source, 'save_quote', 'save_customer');
  const anchors = {
    split: body.indexOf("RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT:"),
    stale: body.indexOf("RAISE EXCEPTION 'QUOTE_STALE_WRITE:"),
    lifecycle: body.indexOf("RAISE EXCEPTION 'Invalid status transition:"),
    unplan: body.indexOf("RAISE EXCEPTION 'BOOKING_HAS_JOB_RESERVATION:"),
    write: body.indexOf('\n  UPDATE quotes SET'),
  };
  for (const [anchorName, position] of Object.entries(anchors)) {
    assert.ok(position >= 0, `save_quote ${anchorName} validation/write anchor is missing`);
  }
  assert.ok(anchors.split < anchors.stale, 'quote split conflict must precede generic stale guard');
  assert.ok(anchors.stale < anchors.lifecycle, 'quote stale guard must precede lifecycle validation');
  assert.ok(anchors.stale < anchors.unplan, 'quote stale guard must precede unplanning validation');
  assert.ok(anchors.lifecycle < anchors.write, 'quote lifecycle validation must precede the parent write');
  assert.ok(anchors.unplan < anchors.write, 'quote unplanning validation must precede the parent write');
}

function assertCanonicalQuoteUpdate(currentSource, priorSource) {
  const currentQuote = extractFunction(currentSource, 'save_quote', 'save_customer');
  const priorQuote = extractFunction(priorSource, 'save_quote', 'save_customer');
  const currentUpdate = extractQuoteUpdate(currentQuote, 'v_quote_id');
  const priorHeaderUpdate = extractQuoteUpdate(priorQuote, 'p_quote_id');
  const priorTotalsUpdate = extractQuoteUpdate(priorQuote, 'v_quote_id');
  const currentAssignments = parseUpdateAssignments(currentUpdate);
  const priorHeaderAssignments = parseUpdateAssignments(priorHeaderUpdate);
  const priorTotalsAssignments = parseUpdateAssignments(priorTotalsUpdate);

  const expectedAssignments = [
    ...priorHeaderAssignments.filter(({ field }) => field !== 'updated_at'),
    ...priorTotalsAssignments,
  ];
  assert.deepEqual(
    currentAssignments.map(({ field }) => field),
    expectedAssignments.map(({ field }) => field),
    'consolidated quote UPDATE field order differs from the two prior canonical UPDATEs',
  );
  const authoritativeTotalExpressions = new Map([
    ['total_price', 'v_server_totals.total_price'],
    ['total_cost', 'v_server_totals.total_cost'],
    ['total_profit', 'v_server_totals.total_profit'],
    ['total_margin_pct', 'CASE WHEN v_server_totals.total_price > 0 THEN ROUND(v_server_totals.total_profit / v_server_totals.total_price * 100, 2) ELSE 0 END'],
  ]);
  for (const expected of expectedAssignments) {
    const actual = currentAssignments.find(({ field }) => field === expected.field);
    assert.equal(
      actual?.expression,
      authoritativeTotalExpressions.get(expected.field) ?? expected.expression,
      `consolidated quote UPDATE assignment mismatch for ${expected.field}`,
    );
  }
  assert.match(
    currentQuote,
    /SELECT\s+COALESCE\(SUM\(total_price\), 0\) AS total_price,\s+COALESCE\(SUM\(current_cost \* total_units_needed\), 0\) AS total_cost,\s+COALESCE\(SUM\(profit\), 0\) AS total_profit\s+INTO v_server_totals\s+FROM quote_items\s+WHERE quote_id = v_quote_id;/,
    'v_server_totals must come from the canonical quote-item aggregates',
  );
  assert.equal(
    currentQuote.match(/\bUPDATE quotes SET\b/g)?.length,
    1,
    'save_quote must use one parent UPDATE so one logical save bumps row_version exactly once',
  );

  return {
    currentQuote,
    priorQuote,
    currentUpdate,
    priorHeaderUpdate,
    priorTotalsUpdate,
  };
}

function assertCanonicalContract() {
  const current = readFileSync(migration, 'utf8');
  const prior = readFileSync(previous, 'utf8');
  const {
    currentQuote,
    priorQuote,
    currentUpdate,
    priorHeaderUpdate,
    priorTotalsUpdate,
  } = assertCanonicalQuoteUpdate(current, prior);
  const priorValidationBlock = extractQuoteValidationBlock(priorQuote);
  assert.equal(
    extractQuoteValidationBlock(currentQuote),
    priorValidationBlock,
    'relocated quote lifecycle/unplanning validation contents changed',
  );
  const restoreVerifiedQuoteUpdateShape = (body) => body
    .replace(
      /\n  -- One logical save must produce exactly one quote UPDATE\.[\s\S]*?\n  -- that lock order while ensuring the row-version trigger advances once\./,
      '',
    )
    .replace(currentUpdate, priorTotalsUpdate)
    .replace(
      '\n    v_quote_id := p_quote_id;',
      `${priorHeaderUpdate}\n\n    v_quote_id := p_quote_id;`,
    );
  const restoreVerifiedValidationOrder = (body) => {
    const withoutValidation = body.replace(priorValidationBlock, '');
    assert.notEqual(withoutValidation, body, 'could not remove exact canonical lifecycle/unplanning block');
    const marker = '\n    -- Lost-update guard (2026-07-22):';
    assert.ok(withoutValidation.includes(marker), 'could not find canonical split-guard insertion point');
    return withoutValidation.replace(marker, `${priorValidationBlock}${marker}`);
  };
  const stripQuoteToken = (body) => body
    .replace('  v_old_row_version bigint;\n', '')
    .replace('  v_expected_row_version bigint;\n', '')
    .replace('SELECT status, commission_split, row_version\n      INTO v_old_status, v_old_commission_split, v_old_row_version', 'SELECT status, commission_split\n      INTO v_old_status, v_old_commission_split')
    .replace(extractQuoteRowVersionBlock(body), '')
    .replace(",\n    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id)", '');
  const stripQuoteOwnership = (body) => body
    .replace('  v_cached_quote_id uuid;\n', '')
    .replace(
      /\n  -- Quote ownership gates run BEFORE the idempotency early-return\.[\s\S]*?\n  END IF;\n(?=\n  IF p_idempotency_key IS NOT NULL THEN)/,
      '',
    )
    .replace(
      /\n  IF p_idempotency_key IS NOT NULL THEN\n    v_existing := check_idempotency\(p_idempotency_key, 'save_quote'\);\n    IF v_existing IS NOT NULL THEN[\s\S]*?\n    END IF;\n  END IF;\n(?=\n  v_status :=)/,
      "\n  IF p_idempotency_key IS NOT NULL THEN\n    v_existing := check_idempotency(p_idempotency_key, 'save_quote');\n    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;\n  END IF;\n",
    );
  const stripCustomerToken = (body) => body
    .replace('  v_old_row_version bigint;\n', '')
    .replace('  v_expected_row_version bigint;\n', '')
    .replace('SELECT default_commission_split, row_version\n      INTO v_old_commission_split, v_old_row_version', 'SELECT default_commission_split\n      INTO v_old_commission_split')
    .replace(/\n    IF NOT \(p_customer_payload \? 'row_version_expected'\)[\s\S]*?\n    END IF;\n(?=\n    UPDATE customers SET)/, '')
    .replace(",\n    'row_version', (SELECT row_version FROM customers WHERE id = v_customer_id)", '');
  const normalizeSqlLayout = (body) => body.replace(/\s+/g, ' ').trim();
  assert.equal(
    normalizeSqlLayout(restoreVerifiedQuoteUpdateShape(restoreVerifiedValidationOrder(stripQuoteOwnership(stripQuoteToken(currentQuote))))),
    normalizeSqlLayout(priorQuote),
    'save_quote changed outside the audited row-version delta',
  );
  assert.equal(
    normalizeSqlLayout(stripCustomerToken(extractFunction(current, 'save_customer'))),
    normalizeSqlLayout(extractFunction(prior, 'save_customer')),
    'save_customer changed outside the audited row-version delta',
  );
  const customerGuard = current.lastIndexOf('COMMISSION_SPLIT_CONFLICT');
  const customerVersion = current.indexOf('CUSTOMER_STALE_WRITE');
  assertQuoteValidationOrder(current);
  assert.ok(customerGuard >= 0 && customerGuard < customerVersion, 'customer split conflict must precede generic stale guard');

  assertQuoteOwnershipContract(current);

  assert.match(
    currentQuote,
    /UPDATE quotes SET[\s\S]*customer_id =[\s\S]*total_price =[\s\S]*WHERE id = v_quote_id;/,
    'save_quote must consolidate header and calculated totals into its single parent UPDATE',
  );

  const corruptStatus = current.replace('    status = v_status,', "    status = 'draft',");
  assert.throws(
    () => assertCanonicalQuoteUpdate(corruptStatus, prior),
    /assignment mismatch for status/,
    'canonical proof must reject a corrupted status assignment',
  );
  const corruptFirstSentAt = current.replace(
    "      WHEN v_status = 'sent' AND sent_at IS NULL THEN now()",
    "      WHEN v_status = 'sent' AND sent_at IS NULL THEN NULL",
  );
  assert.throws(
    () => assertCanonicalQuoteUpdate(corruptFirstSentAt, prior),
    /assignment mismatch for sent_at/,
    'canonical proof must reject a corrupted first-send sent_at branch',
  );

  const validationBlock = extractQuoteValidationBlock(currentQuote);
  const lifecycleBeforeStale = current.replace(validationBlock, '').replace(
    '\n    -- Lost-update guard (2026-07-22):',
    `${validationBlock}\n    -- Lost-update guard (2026-07-22):`,
  );
  assert.throws(
    () => assertQuoteValidationOrder(lifecycleBeforeStale),
    /stale guard must precede lifecycle validation/,
    'validation-order proof must reject lifecycle validation moved ahead of the stale guard',
  );

  const splitException = "RAISE EXCEPTION 'COMMISSION_SPLIT_CONFLICT: this quote''s commission split was changed elsewhere after you opened it — reload the quote and re-apply your change';";
  const staleException = "RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened — reload to review the current quote before saving';";
  const staleBeforeSplit = current
    .replace(splitException, '-- split exception deliberately moved by mutation self-test')
    .replace(staleException, `${staleException}\n      ${splitException}`);
  assert.notEqual(staleBeforeSplit, current, 'failed to construct split/stale precedence mutation');
  assert.throws(
    () => assertQuoteValidationOrder(staleBeforeSplit),
    /split conflict must precede generic stale guard/,
    'validation-order proof must reject a generic stale guard moved ahead of split conflict',
  );
}

function assertQuoteOwnershipContract(source) {
  const body = extractFunction(source, 'save_quote', 'save_customer');
  const idempotencyLookup = body.indexOf("v_existing := check_idempotency(p_idempotency_key, 'save_quote');");
  const directOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';");
  const replayOwnerReject = body.lastIndexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';");
  const replayReturn = body.indexOf('RETURN v_existing;', idempotencyLookup);
  assert.ok(idempotencyLookup >= 0, 'save_quote idempotency lookup is missing');
  assert.ok(directOwnerReject >= 0 && directOwnerReject < idempotencyLookup, 'quote target ownership must reject before idempotency lookup');
  assert.ok(replayOwnerReject > idempotencyLookup && replayOwnerReject < replayReturn, 'cached quote ownership must reject before replay return');
  assert.notEqual(directOwnerReject, replayOwnerReject, 'save_quote needs distinct direct-target and replay ownership gates');
  assert.match(
    body,
    /p_quote_id IS NOT NULL[\s\S]*?WHERE id = p_quote_id\s+AND created_by = v_actor\s+FOR UPDATE[\s\S]*?RAISE EXCEPTION 'NOT_QUOTE_OWNER';/,
    'sales-rep direct saves must lock and authorize quotes.created_by',
  );
  assert.match(
    body,
    /v_cached_quote_id := NULLIF\(v_existing->>'quote_id', ''\)::uuid;[\s\S]*?p_quote_id IS DISTINCT FROM v_cached_quote_id[\s\S]*?WHERE id = v_cached_quote_id\s+AND created_by = v_actor[\s\S]*?RAISE EXCEPTION 'NOT_QUOTE_OWNER';[\s\S]*?RETURN v_existing;/,
    'idempotent replays must bind the cached quote target and re-check ownership',
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
  assert.match(smoke, /non-owner sales rep quote save succeeded/, 'registered smoke must prove direct quote ownership');
  assert.match(smoke, /non-owner sales rep received another actor''s quote replay/, 'registered smoke must prove replay ownership');

  const ownershipBypass = current.replace('         AND created_by = v_actor\n       FOR UPDATE', '       FOR UPDATE');
  assert.notEqual(ownershipBypass, current, 'failed to construct quote-ownership mutation');
  assert.throws(
    () => assertQuoteOwnershipContract(ownershipBypass),
    /direct saves must lock and authorize quotes\.created_by/,
    'ownership proof must reject a direct-target gate that omits created_by',
  );

  const visit = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? visit(full) : [full];
  });
  const childMutation = /\.from\(['"](quote_sections|quote_items|customer_addresses)['"]\)(?:(?!;|\.from\().){0,500}?\.(?:insert|update|upsert|delete)\(/s;
  for (const table of ['quote_sections', 'quote_items', 'customer_addresses']) {
    assert.match(
      `supabase.from('${table}').upsert({ id: 'direct-child-write' })`,
      childMutation,
      `${table} frontend upserts must stay RPC-owned`,
    );
  }
  assert.doesNotMatch(
    "supabase.from('quote_items').select('*'); supabase.from('quotes').update({ status: 'sent' })",
    childMutation,
    'a later unrelated mutation must not be attributed to a child-table read',
  );
  const offenders = visit(path.join(root, 'src'))
    .filter((file) => /\.tsx?$/.test(file))
    .filter((file) => childMutation.test(readFileSync(file, 'utf8')));
  assert.deepEqual(offenders, [], `frontend child writes must stay RPC-owned: ${offenders.join(', ')}`);
}

async function race(table, fn, reverseLockOrder) {
  psql(`TRUNCATE TABLE public.${table}; INSERT INTO public.${table}(id,value,row_version) VALUES ('one','original',1);`);
  // In the reverse path the first client is deliberately held *before* it
  // calls the locking function, so the later-labelled client owns the row.
  const firstApplicationName = `race-${table}-${reverseLockOrder}-first`;
  const secondApplicationName = `race-${table}-${reverseLockOrder}-second`;
  const first = asyncSql(`${reverseLockOrder ? 'SELECT pg_sleep(5); ' : ''}SELECT public.${fn}('one', 'first', 1, ${reverseLockOrder ? 0 : 1}, 'race-${table}-${reverseLockOrder}-first');`, firstApplicationName);
  await waitForPgSleep(firstApplicationName);
  const second = asyncSql(`SELECT public.${fn}('one', 'second', 1, ${reverseLockOrder ? 1 : 0}, 'race-${table}-${reverseLockOrder}-second');`, secondApplicationName);
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
CREATE OR REPLACE FUNCTION public.checked_quote(p_id text,p_value text,p_expected bigint,p_pause int,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v bigint; v_cached jsonb; v_result jsonb; BEGIN SELECT result INTO v_cached FROM public.idempotency_keys WHERE idempotency_key=p_key AND operation='save_quote'; IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; SELECT row_version INTO v FROM public.quotes WHERE id=p_id FOR UPDATE; IF p_pause=1 THEN PERFORM pg_sleep(5); END IF; IF p_expected IS DISTINCT FROM v THEN RAISE EXCEPTION 'QUOTE_STALE_WRITE'; END IF; UPDATE public.quotes SET value=p_value WHERE id=p_id; SELECT jsonb_build_object('id',p_id,'row_version',row_version,'value',value) INTO v_result FROM public.quotes WHERE id=p_id; INSERT INTO public.idempotency_keys VALUES(p_key,'save_quote',v_result); RETURN v_result; END $$;
CREATE OR REPLACE FUNCTION public.checked_customer(p_id text,p_value text,p_expected bigint,p_pause int,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v bigint; v_cached jsonb; v_result jsonb; BEGIN SELECT result INTO v_cached FROM public.idempotency_keys WHERE idempotency_key=p_key AND operation='save_customer'; IF v_cached IS NOT NULL THEN RETURN v_cached; END IF; SELECT row_version INTO v FROM public.customers WHERE id=p_id FOR UPDATE; IF p_pause=1 THEN PERFORM pg_sleep(5); END IF; IF p_expected IS DISTINCT FROM v THEN RAISE EXCEPTION 'CUSTOMER_STALE_WRITE'; END IF; UPDATE public.customers SET value=p_value WHERE id=p_id; SELECT jsonb_build_object('id',p_id,'row_version',row_version,'value',value) INTO v_result FROM public.customers WHERE id=p_id; INSERT INTO public.idempotency_keys VALUES(p_key,'save_customer',v_result); RETURN v_result; END $$;
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
    console.log('ROW_VERSION_DISPOSABLE_PROOF_PASS pre_fix_overwrite=confirmed canonical_contract=preserved validation_order=split-stale-lifecycle-unplan-write canonical_mutation_self_tests=status,sent_at,validation_order,quote_ownership quote_ownership=direct,replay quote_single_bump_shape=verified quote_lock_orders=both customer_lock_orders=both idempotent_replay=real insert_defaults=verified');
  } finally {
    docker(['rm', '-f', name], undefined, true);
  }
}
main().catch((error) => { console.error(`ROW_VERSION_DISPOSABLE_PROOF_FAIL ${error.stack || error.message}`); process.exitCode = 1; });
