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
const migration = path.join(root, 'supabase/migrations/20260730235031_quote_customer_row_version_guard.sql');
const previous = path.join(root, 'supabase/migrations/20260722202622_commission_split_lost_update_guard.sql');
const name = `crx-row-version-proof-${process.pid}-${Date.now().toString(36)}`;
const createVersionSmokeFiles = [
  'smoke-restore-version-drawn-guard.sql',
  'smoke-planned-holds-drawn-sync.sql',
];
const convertQuoteSmokeFiles = [
  'smoke-backfill-refuse-split-billing.sql',
  'smoke-draw-ledger-reversal.sql',
  'smoke-forbid-restore-cancelled-order.sql',
  'smoke-order-draw-lock.sql',
  'smoke-revert-quote-escape-hatch.sql',
];

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

function extractTempHelper(source, functionName) {
  const start = source.indexOf(`CREATE OR REPLACE FUNCTION pg_temp.${functionName}(`);
  const endMarker = '\n$helper$;';
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract pg_temp.${functionName}`);
  return source.slice(start, end + endMarker.length).replace(/\r\n/g, '\n');
}

function assertSmokeRolloutCompatibility() {
  const smokeRoot = path.join(root, 'scripts/smoke');
  const verifyGroup = (fileNames, helperName, exactSignature, dynamicCall, directCallPattern) => {
    let canonicalHelper;
    for (const fileName of fileNames) {
      const source = readFileSync(path.join(smokeRoot, fileName), 'utf8').replace(/\r\n/g, '\n');
      const helper = extractTempHelper(source, helperName);
      canonicalHelper ??= helper;
      assert.equal(
        helper.replace(/\s+/g, ' ').trim(),
        canonicalHelper.replace(/\s+/g, ' ').trim(),
        `${fileName} must use the canonical ${helperName} rollout helper`,
      );
      assert.ok(helper.includes(`to_regprocedure('${exactSignature}')`), `${fileName} must inspect the exact new catalog signature`);
      assert.ok(helper.includes(dynamicCall), `${fileName} must dynamically dispatch to the new signature`);
      const callSites = source.replace(helper, '');
      assert.match(callSites, new RegExp(`pg_temp\\.${helperName}\\(`), `${fileName} must call the rollout helper`);
      assert.doesNotMatch(callSites, directCallPattern, `${fileName} must not call a rollout-sensitive RPC directly`);
      assert.doesNotMatch(
        callSites,
        /\bSELECT\s+(?:[a-z_][a-z0-9_]*\.)?row_version\b/i,
        `${fileName} must not resolve the pending row_version column on the legacy catalog`,
      );
    }
    return canonicalHelper;
  };

  return {
    createHelper: verifyGroup(
      createVersionSmokeFiles,
      'create_quote_version_smoke',
      'public.create_quote_version(uuid,uuid,text,text,bigint)',
      "'SELECT public.create_quote_version($1, $2, $3, $4, $5)'",
      /(?:^|[^\w.])(?:public\.)?create_quote_version\(/m,
    ),
    convertHelper: verifyGroup(
      convertQuoteSmokeFiles,
      'convert_quote_to_order_smoke',
      // Pin the WIDEST live signature, not the historical one. Pinning the
      // narrower (uuid,uuid,text,bigint) form kept asserting a probe that
      // matches nothing on the current catalog, so every one of these chains
      // silently fell through to a three-argument call that defaults
      // p_expected_row_version to NULL. A stale pin here is what let that rot
      // stay green.
      'public.convert_quote_to_order(uuid,uuid,text,bigint,text)',
      "'SELECT public.convert_quote_to_order($1, $2, $3, $4, NULL::text)'",
      /(?:^|[^\w.])(?:public\.)?convert_quote_to_order\(/m,
    ),
  };
}

function proveSmokeCatalogCompatibility(createHelper, convertHelper) {
  const quoteId = '00000000-0000-0000-0000-000000000001';
  const actorId = '00000000-0000-0000-0000-000000000002';
  const legacyCreate = scalar(`
BEGIN;
CREATE OR REPLACE FUNCTION public.create_quote_version(uuid,uuid,text,text)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"shape":"legacy"}'::jsonb $$;
CREATE TEMP TABLE legacy_quotes(id uuid PRIMARY KEY);
INSERT INTO legacy_quotes VALUES ('${quoteId}');
${createHelper}
SELECT pg_temp.create_quote_version_smoke(
  '${quoteId}',
  '${actorId}',
  'presented',
  NULL,
  (SELECT (to_jsonb(q)->>'row_version')::bigint FROM legacy_quotes q WHERE q.id = '${quoteId}')
)->>'shape';
ROLLBACK;
`);
  assert.equal(legacyCreate, 'legacy', 'create_quote_version smoke helper must work against the legacy catalog');

  const newCreate = scalar(`
BEGIN;
CREATE OR REPLACE FUNCTION public.create_quote_version(
  p_quote_id uuid,
  p_performed_by uuid,
  p_method text,
  p_idempotency_key text,
  p_expected_row_version bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql
AS $$ SELECT jsonb_build_object('shape', 'new', 'expected', p_expected_row_version) $$;
CREATE TEMP TABLE new_quotes(id uuid PRIMARY KEY, row_version bigint NOT NULL);
INSERT INTO new_quotes VALUES ('${quoteId}', 17);
${createHelper}
SELECT concat(
  pg_temp.create_quote_version_smoke(
    '${quoteId}',
    '${actorId}',
    'presented',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM new_quotes q WHERE q.id = '${quoteId}')
  )->>'shape',
  ':',
  pg_temp.create_quote_version_smoke(
    '${quoteId}',
    '${actorId}',
    'presented',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM new_quotes q WHERE q.id = '${quoteId}')
  )->>'expected'
);
ROLLBACK;
`);
  assert.equal(newCreate, 'new:17', 'create_quote_version smoke helper must pass the token to the new catalog');

  const legacyConvert = scalar(`
BEGIN;
CREATE OR REPLACE FUNCTION public.convert_quote_to_order(uuid,uuid,text)
RETURNS jsonb LANGUAGE sql AS $$ SELECT '{"shape":"legacy"}'::jsonb $$;
CREATE TEMP TABLE legacy_quotes(id uuid PRIMARY KEY);
INSERT INTO legacy_quotes VALUES ('${quoteId}');
${convertHelper}
SELECT pg_temp.convert_quote_to_order_smoke(
  '${quoteId}',
  '${actorId}',
  NULL,
  (SELECT (to_jsonb(q)->>'row_version')::bigint FROM legacy_quotes q WHERE q.id = '${quoteId}')
)->>'shape';
ROLLBACK;
`);
  assert.equal(legacyConvert, 'legacy', 'convert_quote_to_order smoke helper must work against the legacy catalog');

  const newConvert = scalar(`
BEGIN;
CREATE OR REPLACE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql
AS $$ SELECT jsonb_build_object('shape', 'new', 'expected', p_expected_row_version) $$;
CREATE TEMP TABLE new_quotes(id uuid PRIMARY KEY, row_version bigint NOT NULL);
INSERT INTO new_quotes VALUES ('${quoteId}', 23);
${convertHelper}
SELECT concat(
  pg_temp.convert_quote_to_order_smoke(
    '${quoteId}',
    '${actorId}',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM new_quotes q WHERE q.id = '${quoteId}')
  )->>'shape',
  ':',
  pg_temp.convert_quote_to_order_smoke(
    '${quoteId}',
    '${actorId}',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM new_quotes q WHERE q.id = '${quoteId}')
  )->>'expected'
);
ROLLBACK;
`);
  assert.equal(newConvert, 'new:23', 'convert_quote_to_order smoke helper must pass the token to the new catalog');

  // The WIDENED catalog — the shape actually deployed since 20260812115237.
  // Without this case the two above still pass while the helper falls through
  // to a three-argument call, because p_below_cost_reason's DEFAULT lets a
  // short call resolve against the wide function with a NULL row version. That
  // is precisely the rot this proof failed to catch, so it is pinned here: the
  // stub RAISES rather than returning if the token does not arrive.
  const widenedConvert = scalar(`
BEGIN;
CREATE OR REPLACE FUNCTION public.convert_quote_to_order(
  p_quote_id uuid,
  p_performed_by uuid,
  p_idempotency_key text,
  p_expected_row_version bigint DEFAULT NULL,
  p_below_cost_reason text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql
AS $stub$
BEGIN
  IF p_expected_row_version IS NULL THEN
    RAISE EXCEPTION 'WIDENED_CATALOG_LOST_ROW_VERSION';
  END IF;
  RETURN jsonb_build_object('shape', 'widened', 'expected', p_expected_row_version);
END;
$stub$;
CREATE TEMP TABLE new_quotes(id uuid PRIMARY KEY, row_version bigint NOT NULL);
INSERT INTO new_quotes VALUES ('${quoteId}', 29);
${convertHelper}
SELECT concat(
  pg_temp.convert_quote_to_order_smoke(
    '${quoteId}',
    '${actorId}',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM new_quotes q WHERE q.id = '${quoteId}')
  )->>'shape',
  ':',
  pg_temp.convert_quote_to_order_smoke(
    '${quoteId}',
    '${actorId}',
    NULL,
    (SELECT (to_jsonb(q)->>'row_version')::bigint FROM new_quotes q WHERE q.id = '${quoteId}')
  )->>'expected'
);
ROLLBACK;
`);
  assert.equal(widenedConvert, 'widened:29', 'convert_quote_to_order smoke helper must pass the token to the WIDENED live catalog');
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
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
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
  const customerEndMarker = source.indexOf('-- The existing quote-version and conversion RPCs', start);
  const end = nextName
    ? source.indexOf(`CREATE OR REPLACE FUNCTION public.${nextName}`, start)
    : customerEndMarker > start
      ? customerEndMarker
      : source.indexOf('-- Self-contained ACL', start);
  assert.ok(start >= 0 && end > start, `could not extract ${functionName} body`);
  return source.slice(start, end).replace(/\r\n/g, '\n').trim();
}

function extractActionWrapper(source, functionName, endMarker) {
  const start = source.indexOf(`CREATE FUNCTION public.${functionName}`);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `could not extract ${functionName} wrapper`);
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
    stale: body.indexOf("RAISE EXCEPTION 'QUOTE_STALE_WRITE: quote changed after this page opened"),
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
    .replace('  v_cached_row_version bigint;\n', '')
    .replace('  v_request_fingerprint text;\n', '')
    .replace(
      /\n  v_request_fingerprint := md5\(jsonb_build_object\([\s\S]*?\n  \)::text\);\n/,
      '',
    )
    .replace('SELECT created_by, status, commission_split, row_version\n      INTO v_quote_owner, v_old_status, v_old_commission_split, v_old_row_version', 'SELECT created_by, status, commission_split\n      INTO v_quote_owner, v_old_status, v_old_commission_split')
    .replace(extractQuoteRowVersionBlock(body), '')
    .replace(",\n    '_request_fingerprint', v_request_fingerprint", '')
    .replace(",\n    'row_version', (SELECT row_version FROM quotes WHERE id = v_quote_id)", '');
  const stripQuoteOwnership = (body) => body
    .replace('  v_cached_quote_id uuid;\n', '')
    .replace('  v_quote_owner uuid;\n', '')
    .replace(
      /\n  -- Quote ownership is checked before the idempotency lookup[\s\S]*?\n  END IF;\n(?=\n  IF p_idempotency_key IS NOT NULL THEN)/,
      '',
    )
    .replace(
      /\n  IF p_idempotency_key IS NOT NULL THEN\n    v_existing := check_idempotency\(p_idempotency_key, 'save_quote'\);\n    IF v_existing IS NOT NULL THEN[\s\S]*?\n    END IF;\n  END IF;\n(?=\n  v_status :=)/,
      "\n  IF p_idempotency_key IS NOT NULL THEN\n    v_existing := check_idempotency(p_idempotency_key, 'save_quote');\n    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;\n  END IF;\n",
    )
    .replace(
      'SELECT created_by, status, commission_split\n      INTO v_quote_owner, v_old_status, v_old_commission_split',
      'SELECT status, commission_split\n      INTO v_old_status, v_old_commission_split',
    )
    .replace(
      "\n    IF NOT public.is_admin() AND v_quote_owner IS DISTINCT FROM v_actor THEN\n      RAISE EXCEPTION 'NOT_QUOTE_OWNER';\n    END IF;",
      '',
    );
  const stripCustomerToken = (body) => body
    .replace('  v_old_row_version bigint;\n', '')
    .replace('  v_expected_row_version bigint;\n', '')
    .replace('  v_cached_row_version bigint;\n', '')
    .replace('  v_request_fingerprint text;\n', '')
    .replace(
      /\n  v_request_fingerprint := md5\(jsonb_build_object\([\s\S]*?\n  \)::text\);\n/,
      '',
    )
    .replace(
      /\n      IF v_existing->>'_request_fingerprint' IS DISTINCT FROM v_request_fingerprint THEN[\s\S]*?\n      END IF;\n(?=      RETURN v_existing;)/,
      '',
    )
    .replace('SELECT default_commission_split, row_version\n      INTO v_old_commission_split, v_old_row_version', 'SELECT default_commission_split\n      INTO v_old_commission_split')
    .replace(/\n    IF NOT \(p_customer_payload \? 'row_version_expected'\)[\s\S]*?\n    END IF;\n(?=\n    UPDATE customers SET)/, '')
    .replace(",\n    '_request_fingerprint', v_request_fingerprint", '')
    .replace(",\n    'row_version', (SELECT row_version FROM customers WHERE id = v_customer_id)", '');
  const normalizeSqlLayout = (body) => body.replace(/\s+/g, ' ').trim();
  const assertNormalizedEqual = (actualBody, expectedBody, message) => {
    const actual = normalizeSqlLayout(actualBody);
    const expected = normalizeSqlLayout(expectedBody);
    if (actual !== expected) {
      let offset = 0;
      while (offset < actual.length && offset < expected.length && actual[offset] === expected[offset]) offset += 1;
      assert.fail(`${message}; first difference at ${offset}: actual=${JSON.stringify(actual.slice(offset, offset + 180))} expected=${JSON.stringify(expected.slice(offset, offset + 180))}`);
    }
  };
  assertNormalizedEqual(
    restoreVerifiedQuoteUpdateShape(restoreVerifiedValidationOrder(stripQuoteOwnership(stripQuoteToken(currentQuote)))),
    priorQuote,
    'save_quote changed outside the audited row-version delta',
  );
  assertNormalizedEqual(
    stripCustomerToken(extractFunction(current, 'save_customer')),
    extractFunction(prior, 'save_customer'),
    'save_customer changed outside the audited row-version delta',
  );
  const customerGuard = current.lastIndexOf('COMMISSION_SPLIT_CONFLICT');
  const customerVersion = current.indexOf('CUSTOMER_STALE_WRITE: customer changed after this page opened');
  assertQuoteValidationOrder(current);
  assert.ok(customerGuard >= 0 && customerGuard < customerVersion, 'customer split conflict must precede generic stale guard');

  assertQuoteOwnershipContract(current);
  assertQuoteActionLockOrder(current);
  for (const functionName of ['create_quote_version', 'convert_quote_to_order', 'restore_quote_version']) {
    assert.match(
      current,
      new RegExp(`p\\.proname = '${functionName}';\\s+IF v_count <> 1 THEN RAISE EXCEPTION 'ROW_VERSION_[A-Z_]+_OVERLOAD_POSTFLIGHT_FAILED'; END IF;`),
      `${functionName} must fail migration postflight unless exactly one public overload exists`,
    );
  }

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
  const precheckOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';");
  const replayPrecheckOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';", idempotencyLookup);
  const replayLockedOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';", replayPrecheckOwnerReject + 1);
  const replayFingerprint = body.indexOf("v_existing->>'_request_fingerprint' IS DISTINCT FROM v_request_fingerprint", idempotencyLookup);
  const replayVersionGuard = body.indexOf('v_old_row_version IS DISTINCT FROM v_cached_row_version', idempotencyLookup);
  const replayReturn = body.indexOf('RETURN v_existing;', idempotencyLookup);
  const directLockedOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';", replayReturn);
  assert.ok(idempotencyLookup >= 0, 'save_quote idempotency lookup is missing');
  assert.ok(precheckOwnerReject >= 0 && precheckOwnerReject < idempotencyLookup, 'quote target ownership must reject before idempotency lookup');
  assert.ok(replayPrecheckOwnerReject > idempotencyLookup && replayPrecheckOwnerReject < replayFingerprint, 'cached quote ownership must reject before replay details are inspected');
  assert.ok(replayLockedOwnerReject > replayFingerprint && replayLockedOwnerReject < replayVersionGuard, 'cached quote ownership must be rechecked under the row lock');
  assert.ok(replayVersionGuard > replayLockedOwnerReject && replayVersionGuard < replayReturn, 'cached quote replay must reject a token advanced after the original save');
  assert.ok(directLockedOwnerReject > replayReturn, 'direct quote ownership must be rechecked under the mutation row lock');
  assert.match(
    body,
    /p_quote_id IS NOT NULL[\s\S]*?WHERE id = p_quote_id\s+AND created_by = v_actor\s+\) THEN\s+RAISE EXCEPTION 'NOT_QUOTE_OWNER';[\s\S]*?check_idempotency/,
    'sales-rep direct saves must authorize quotes.created_by before idempotency without a row lock',
  );
  assert.match(
    body,
    /v_cached_quote_id := NULLIF\(v_existing->>'quote_id', ''\)::uuid;[\s\S]*?p_quote_id IS DISTINCT FROM v_cached_quote_id[\s\S]*?WHERE id = v_cached_quote_id\s+AND created_by = v_actor[\s\S]*?_request_fingerprint[\s\S]*?SELECT created_by, row_version[\s\S]*?WHERE id = v_cached_quote_id\s+FOR UPDATE;[\s\S]*?v_quote_owner IS DISTINCT FROM v_actor[\s\S]*?RETURN v_existing;/,
    'idempotent replays must bind, lock, and re-authorize the cached quote target',
  );
  assert.match(
    body,
    /SELECT created_by, status, commission_split, row_version[\s\S]*?FROM quotes WHERE id = p_quote_id FOR UPDATE;[\s\S]*?v_quote_owner IS DISTINCT FROM v_actor[\s\S]*?UPDATE quotes SET/,
    'direct saves must re-authorize the target under the mutation row lock',
  );
}

function assertQuoteActionLockOrder(source) {
  const saveQuoteBody = extractFunction(source, 'save_quote', 'save_customer');
  const saveQuoteIdempotency = saveQuoteBody.indexOf("v_existing := check_idempotency(p_idempotency_key, 'save_quote');");
  const saveQuoteFirstRowLock = saveQuoteBody.indexOf('FOR UPDATE');
  assert.ok(
    saveQuoteIdempotency >= 0 && saveQuoteFirstRowLock > saveQuoteIdempotency,
    'save_quote must take the idempotency advisory lock before every quote row lock',
  );

  const specs = [
    ['create_quote_version', 'ALTER FUNCTION public.convert_quote_to_order', 'create_quote_version'],
    ['convert_quote_to_order', 'ALTER FUNCTION public.restore_quote_version', 'convert_quote_to_order'],
    ['restore_quote_version', '-- Self-contained ACL', 'restore_quote_version'],
  ];
  for (const [functionName, endMarker, operation] of specs) {
    const body = extractActionWrapper(source, functionName, endMarker);
    const firstOwnerRead = body.indexOf('SELECT created_by INTO v_quote_owner');
    const firstOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';");
    const idempotencyLookup = body.indexOf(`v_existing := public.check_idempotency(p_idempotency_key, '${operation}');`);
    const firstRowLock = body.indexOf('FOR UPDATE;');
    const lockedOwnerRead = body.indexOf('SELECT created_by, row_version', firstOwnerRead + 1);
    const lockedOwnerReject = body.indexOf("RAISE EXCEPTION 'NOT_QUOTE_OWNER';", firstOwnerReject + 1);
    const replayExpectedBinding = body.indexOf("(v_existing->>'_expected_row_version')::bigint IS DISTINCT FROM p_expected_row_version");
    const replayPostVersionBinding = body.indexOf("(v_existing->>'_post_row_version')::bigint IS DISTINCT FROM v_current_row_version");
    const replayReturn = body.indexOf('RETURN ', replayPostVersionBinding);
    const freshVersionGuard = body.indexOf('v_current_row_version IS DISTINCT FROM p_expected_row_version', replayReturn);
    const innerMutation = body.indexOf(`public._${functionName}_owner_impl(`, freshVersionGuard);
    assert.ok(body.indexOf('p_expected_row_version bigint DEFAULT NULL') >= 0, `${functionName} must expose one trailing expected row-version argument`);
    assert.ok(firstOwnerRead >= 0 && firstOwnerReject > firstOwnerRead && firstOwnerReject < idempotencyLookup, `${functionName} must reject a non-owner before idempotency`);
    assert.ok(idempotencyLookup >= 0 && firstRowLock > idempotencyLookup, `${functionName} must take the idempotency advisory lock before the quote row lock`);
    assert.ok(lockedOwnerRead > idempotencyLookup && lockedOwnerRead < firstRowLock, `${functionName} must re-read the target before locking it`);
    assert.ok(lockedOwnerReject > firstRowLock && lockedOwnerReject < replayReturn, `${functionName} must recheck ownership under lock before replay`);
    assert.ok(replayExpectedBinding > lockedOwnerReject && replayPostVersionBinding > replayExpectedBinding && replayReturn > replayPostVersionBinding, `${functionName} replay must bind the request token and current post-mutation token`);
    assert.ok(freshVersionGuard > replayReturn && innerMutation > freshVersionGuard, `${functionName} must compare the locked current token before its inner mutation`);
    assert.match(body, /SET result = v_result \|\| jsonb_build_object\([\s\S]*?'_quote_id'[\s\S]*?'_expected_row_version'[\s\S]*?'_post_row_version'/, `${functionName} must persist lifecycle replay bindings`);
    if (functionName === 'create_quote_version') {
      assert.match(
        body,
        /v_result := v_result \|\| jsonb_build_object\(\s*'row_version', v_post_row_version\s*\);[\s\S]*?SET result = v_result \|\|/,
        'create_quote_version must return and cache the authoritative post-mutation row version',
      );
      assert.match(
        body,
        /v_existing->>'_actor_id' IS DISTINCT FROM v_actor::text[\s\S]*?v_existing->>'_method' IS DISTINCT FROM p_method[\s\S]*?SET result = v_result \|\| jsonb_build_object\([\s\S]*?'_actor_id', v_actor,[\s\S]*?'_method', p_method,/,
        'create_quote_version replay must bind the authenticated actor and requested version method',
      );
    }
  }

  const reversed = source.replace(
    /  WHERE id = p_quote_id\r?\n    AND deleted_at IS NULL;\r?\n  IF NOT FOUND THEN/,
    '  WHERE id = p_quote_id\n    AND deleted_at IS NULL\n  FOR UPDATE;\n  IF NOT FOUND THEN',
  );
  assert.notEqual(reversed, source, 'failed to construct quote-action lock-order mutation');
  assert.throws(
    () => assertQuoteActionLockOrder(reversed),
    /advisory lock before the quote row lock/,
    'quote-action proof must reject row-lock-before-advisory order',
  );

  const missingFreshVersionGuard = source.replace(
    /\n  IF v_current_row_version IS DISTINCT FROM p_expected_row_version THEN\r?\n    RAISE EXCEPTION 'QUOTE_STALE_WRITE';\r?\n  END IF;\r?\n(?=\r?\n  v_result := public\._create_quote_version_owner_impl)/,
    '',
  );
  assert.notEqual(missingFreshVersionGuard, source, 'failed to construct lifecycle-token mutation');
  assert.throws(
    () => assertQuoteActionLockOrder(missingFreshVersionGuard),
    /compare the locked current token before its inner mutation/,
    'quote-action proof must reject a lifecycle wrapper without its fresh token guard',
  );
}

function assertChildOwnershipContract() {
  const current = readFileSync(migration, 'utf8');
  const smoke = readFileSync(path.join(root, 'scripts/smoke/smoke-save-quote-customer-row-version.sql'), 'utf8');
  const quoteBuilder = readFileSync(path.join(root, 'src/pages/QuoteBuilder.tsx'), 'utf8');
  const lifecycleBridge = readFileSync(path.join(root, 'src/lib/quoteLifecycleRpc.ts'), 'utf8');
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
  assert.match(smoke, /non-owner sales rep created another rep''s quote version/, 'registered smoke must prove quote-version ownership');
  assert.match(smoke, /non-owner sales rep converted another rep''s quote/, 'registered smoke must prove quote-conversion ownership');
  assert.match(smoke, /non-owner sales rep restored another rep''s quote/, 'registered smoke must prove quote-restore ownership');
  assert.match(smoke, /non-owner sales rep received another actor''s restore replay/, 'registered smoke must prove quote-restore replay ownership');
  assert.match(smoke, /cached token after later writes/, 'registered smoke must reject stale cached save tokens');
  assert.match(smoke, /stale quote token created a quote version/, 'registered smoke must reject a quote-version action after another writer advances the token');
  assert.match(smoke, /stale quote token converted a quote/, 'registered smoke must reject a conversion after another writer advances the token');
  assert.match(smoke, /stale quote token restored a quote version/, 'registered smoke must reject a restore after another writer advances the token');
  assert.match(smoke, /quote-restore replay was not bound to the original versioned request/, 'registered smoke must prove exact restore replay binding');
  assert.match(
    quoteBuilder,
    // The argument object may be wrapped by withBelowCostReason(), which
    // 20260812115237's approval flow added between the call and its literal.
    // Only that exact wrapper is tolerated — the four fields it must carry are
    // still pinned in order, so an argument object that quietly drops the
    // idempotency key or the loaded row-version token still fails.
    /restoreQuoteVersionWithRowVersion\(\s*(?:withBelowCostReason\(\s*'restore_quote_version',\s*)?\{[\s\S]*?p_version_id: versionId,[\s\S]*?p_idempotency_key: restoreAttempt\.key,[\s\S]*?p_expected_row_version: restoreAttempt\.expectedRowVersion/,
    'QuoteBuilder restore must preserve one idempotency key and loaded row-version token',
  );
  assert.match(
    lifecycleBridge,
    /supabaseUntyped\.rpc\('restore_quote_version', args\)[\s\S]*?isMissingLifecycleSignature\(error, 'restore_quote_version'\)[\s\S]*?supabaseUntyped\.rpc\(\s*'restore_quote_version',\s*legacyArgs/,
    'restore rollout may fall back only after the exact new PostgREST signature is missing',
  );

  const ownershipBypass = current.replace(
    /(       WHERE id = p_quote_id\r?\n)         AND created_by = v_actor/,
    '$1',
  );
  assert.notEqual(ownershipBypass, current, 'failed to construct quote-ownership mutation');
  assert.throws(
    () => assertQuoteOwnershipContract(ownershipBypass),
    /authorize quotes\.created_by before idempotency/,
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
  const { createHelper, convertHelper } = assertSmokeRolloutCompatibility();
  try {
    docker(['run', '-d', '--rm', '--name', name, '--network', 'none', '--tmpfs', '/var/lib/postgresql/data', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine']);
    await waitForHealthyPostgres();
    psql(`
CREATE TABLE public.quotes(id text PRIMARY KEY, value text NOT NULL, row_version bigint NOT NULL DEFAULT 1);
CREATE TABLE public.customers(id text PRIMARY KEY, value text NOT NULL, row_version bigint NOT NULL DEFAULT 1);
CREATE TABLE public.idempotency_keys(idempotency_key text NOT NULL, operation text NOT NULL, result jsonb NOT NULL, PRIMARY KEY(idempotency_key, operation));
CREATE TABLE public.action_quotes(id text PRIMARY KEY);
CREATE OR REPLACE FUNCTION public.bump_record_row_version() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.row_version := OLD.row_version + 1; RETURN NEW; END $$;
CREATE TRIGGER quotes_bump BEFORE UPDATE ON public.quotes FOR EACH ROW EXECUTE FUNCTION public.bump_record_row_version();
CREATE TRIGGER customers_bump BEFORE UPDATE ON public.customers FOR EACH ROW EXECUTE FUNCTION public.bump_record_row_version();
CREATE OR REPLACE FUNCTION public.checked_quote(p_id text,p_value text,p_expected bigint,p_pause int,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v bigint; v_cached jsonb; v_result jsonb; v_fingerprint text := md5(jsonb_build_object('id',p_id,'value',p_value,'expected',p_expected)::text); BEGIN SELECT result INTO v_cached FROM public.idempotency_keys WHERE idempotency_key=p_key AND operation='save_quote'; IF v_cached IS NOT NULL THEN IF v_cached->>'_request_fingerprint' IS DISTINCT FROM v_fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT'; END IF; SELECT row_version INTO v FROM public.quotes WHERE id=p_id FOR UPDATE; IF v IS DISTINCT FROM (v_cached->>'row_version')::bigint THEN RAISE EXCEPTION 'QUOTE_STALE_WRITE'; END IF; RETURN v_cached; END IF; SELECT row_version INTO v FROM public.quotes WHERE id=p_id FOR UPDATE; IF p_pause=1 THEN PERFORM pg_sleep(10); END IF; IF p_expected IS DISTINCT FROM v THEN RAISE EXCEPTION 'QUOTE_STALE_WRITE'; END IF; UPDATE public.quotes SET value=p_value WHERE id=p_id; SELECT jsonb_build_object('id',p_id,'row_version',row_version,'value',value,'_request_fingerprint',v_fingerprint) INTO v_result FROM public.quotes WHERE id=p_id; INSERT INTO public.idempotency_keys VALUES(p_key,'save_quote',v_result); RETURN v_result; END $$;
CREATE OR REPLACE FUNCTION public.checked_customer(p_id text,p_value text,p_expected bigint,p_pause int,p_key text) RETURNS jsonb LANGUAGE plpgsql AS $$ DECLARE v bigint; v_cached jsonb; v_result jsonb; v_fingerprint text := md5(jsonb_build_object('id',p_id,'value',p_value,'expected',p_expected)::text); BEGIN SELECT result INTO v_cached FROM public.idempotency_keys WHERE idempotency_key=p_key AND operation='save_customer'; IF v_cached IS NOT NULL THEN IF v_cached->>'_request_fingerprint' IS DISTINCT FROM v_fingerprint THEN RAISE EXCEPTION 'IDEMPOTENCY_PAYLOAD_CONFLICT'; END IF; SELECT row_version INTO v FROM public.customers WHERE id=p_id FOR UPDATE; IF v IS DISTINCT FROM (v_cached->>'row_version')::bigint THEN RAISE EXCEPTION 'CUSTOMER_STALE_WRITE'; END IF; RETURN v_cached; END IF; SELECT row_version INTO v FROM public.customers WHERE id=p_id FOR UPDATE; IF p_pause=1 THEN PERFORM pg_sleep(10); END IF; IF p_expected IS DISTINCT FROM v THEN RAISE EXCEPTION 'CUSTOMER_STALE_WRITE'; END IF; UPDATE public.customers SET value=p_value WHERE id=p_id; SELECT jsonb_build_object('id',p_id,'row_version',row_version,'value',value,'_request_fingerprint',v_fingerprint) INTO v_result FROM public.customers WHERE id=p_id; INSERT INTO public.idempotency_keys VALUES(p_key,'save_customer',v_result); RETURN v_result; END $$;
CREATE OR REPLACE FUNCTION public.guarded_quote_action(p_id text,p_expected bigint) RETURNS void LANGUAGE plpgsql AS $$ DECLARE v bigint; BEGIN SELECT row_version INTO v FROM public.quotes WHERE id=p_id FOR UPDATE; IF v IS DISTINCT FROM p_expected THEN RAISE EXCEPTION 'QUOTE_STALE_WRITE'; END IF; END $$;
CREATE OR REPLACE FUNCTION public.action_wrapper(p_key text,p_pause boolean) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM public.action_quotes WHERE id='one'; PERFORM pg_advisory_xact_lock(hashtextextended(p_key,0)); IF p_pause THEN PERFORM pg_sleep(2); END IF; PERFORM 1 FROM public.action_quotes WHERE id='one' FOR UPDATE; END $$;
CREATE OR REPLACE FUNCTION public.action_peer(p_key text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(hashtextextended(p_key,0)); PERFORM 1 FROM public.action_quotes WHERE id='one' FOR UPDATE; END $$;
CREATE OR REPLACE FUNCTION public.action_reverse_peer(p_key text) RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1 FROM public.action_quotes WHERE id='one' FOR UPDATE; PERFORM pg_advisory_xact_lock(hashtextextended(p_key,0)); END $$;
INSERT INTO public.quotes VALUES ('one','original',1); INSERT INTO public.customers VALUES ('one','original',1); INSERT INTO public.action_quotes VALUES ('one');
`);
    proveSmokeCatalogCompatibility(createHelper, convertHelper);
    // Exact pre-fix failure: the second whole-record writer wins.
    psql("UPDATE public.quotes SET value='newer' WHERE id='one'; UPDATE public.quotes SET value='stale' WHERE id='one'; UPDATE public.customers SET value='newer' WHERE id='one'; UPDATE public.customers SET value='stale' WHERE id='one';");
    assert.equal(scalar("SELECT value FROM public.quotes WHERE id='one'"), 'stale');
    assert.equal(scalar("SELECT value FROM public.customers WHERE id='one'"), 'stale');
    for (const [table, fn] of [['quotes', 'checked_quote'], ['customers', 'checked_customer']]) {
      await race(table, fn, false);
      await race(table, fn, true);
    }
    const quoteReplayOne = scalar("SELECT public.checked_quote('one','fresh',2,0,'quote-replay')::text");
    const quoteReplayTwo = scalar("SELECT public.checked_quote('one','fresh',2,0,'quote-replay')::text");
    assert.equal(quoteReplayTwo, quoteReplayOne, 'quote idempotent replay must return original result');
    const quotePayloadConflict = psql("SELECT public.checked_quote('one','changed',2,0,'quote-replay')::text", true);
    assert.notEqual(quotePayloadConflict.status, 0, 'quote idempotent replay must reject a changed request');
    assert.match(`${quotePayloadConflict.stderr}${quotePayloadConflict.stdout}`, /IDEMPOTENCY_PAYLOAD_CONFLICT/);
    psql("UPDATE public.quotes SET value='newer-after-replay' WHERE id='one';");
    const quoteAdvancedReplay = psql("SELECT public.checked_quote('one','fresh',2,0,'quote-replay')::text", true);
    assert.notEqual(quoteAdvancedReplay.status, 0, 'quote replay must reject after a later writer advanced the token');
    assert.match(`${quoteAdvancedReplay.stderr}${quoteAdvancedReplay.stdout}`, /QUOTE_STALE_WRITE/);
    const customerReplayOne = scalar("SELECT public.checked_customer('one','fresh',2,0,'customer-replay')::text");
    const customerReplayTwo = scalar("SELECT public.checked_customer('one','fresh',2,0,'customer-replay')::text");
    assert.equal(customerReplayTwo, customerReplayOne, 'customer idempotent replay must return original result');
    const customerPayloadConflict = psql("SELECT public.checked_customer('one','changed',2,0,'customer-replay')::text", true);
    assert.notEqual(customerPayloadConflict.status, 0, 'customer idempotent replay must reject a changed request');
    assert.match(`${customerPayloadConflict.stderr}${customerPayloadConflict.stdout}`, /IDEMPOTENCY_PAYLOAD_CONFLICT/);
    psql("UPDATE public.customers SET value='newer-after-replay' WHERE id='one';");
    const customerAdvancedReplay = psql("SELECT public.checked_customer('one','fresh',2,0,'customer-replay')::text", true);
    assert.notEqual(customerAdvancedReplay.status, 0, 'customer replay must reject after a later writer advanced the token');
    assert.match(`${customerAdvancedReplay.stderr}${customerAdvancedReplay.stdout}`, /CUSTOMER_STALE_WRITE/);
    const lifecycleExpected = scalar("SELECT row_version FROM public.quotes WHERE id='one'");
    const lifecycleApp = 'quote-lifecycle-stale-action';
    const lifecycleAction = asyncSql(`BEGIN; SELECT pg_sleep(2); SELECT public.guarded_quote_action('one',${lifecycleExpected}); COMMIT;`, lifecycleApp);
    await waitForPgSleep(lifecycleApp);
    psql("UPDATE public.quotes SET value='writer-between-load-and-action' WHERE id='one';");
    const lifecycleResult = await lifecycleAction;
    assert.notEqual(lifecycleResult.code, 0, 'lifecycle action must reject after another writer advances the loaded quote token');
    assert.match(`${lifecycleResult.err}${lifecycleResult.out}`, /QUOTE_STALE_WRITE/);
    const actionWrapperApp = 'quote-action-wrapper';
    const actionWrapper = asyncSql("BEGIN; SET LOCAL statement_timeout='20s'; SELECT public.action_wrapper('shared-key',true); COMMIT;", actionWrapperApp);
    await waitForPgSleep(actionWrapperApp);
    const actionPeer = asyncSql("BEGIN; SET LOCAL statement_timeout='20s'; SELECT public.action_peer('shared-key'); COMMIT;", 'quote-action-peer');
    const [wrapperResult, peerResult] = await Promise.all([actionWrapper, actionPeer]);
    assert.equal(wrapperResult.code, 0, `quote action wrapper failed: ${wrapperResult.err}${wrapperResult.out}`);
    assert.equal(peerResult.code, 0, `advisory-first peer failed: ${peerResult.err}${peerResult.out}`);
    const reverseWrapperApp = 'quote-action-reverse-sensitivity';
    const reverseWrapper = asyncSql("BEGIN; SET LOCAL deadlock_timeout='100ms'; SET LOCAL statement_timeout='10s'; SELECT public.action_wrapper('reverse-key',true); COMMIT;", reverseWrapperApp);
    await waitForPgSleep(reverseWrapperApp);
    const reversePeer = asyncSql("BEGIN; SET LOCAL deadlock_timeout='100ms'; SET LOCAL statement_timeout='10s'; SELECT public.action_reverse_peer('reverse-key'); COMMIT;", 'quote-action-reverse-peer');
    const reverseResults = await Promise.all([reverseWrapper, reversePeer]);
    const reverseFailures = reverseResults.filter((result) => result.code !== 0);
    assert.equal(reverseFailures.length, 1, 'reverse-order sensitivity test must produce exactly one deadlock victim');
    assert.match(`${reverseFailures[0].err}${reverseFailures[0].out}`, /deadlock detected/i);
    psql("INSERT INTO public.quotes(id,value) VALUES ('new','inserted'); INSERT INTO public.customers(id,value) VALUES ('new','inserted');");
    assert.equal(scalar("SELECT row_version FROM public.quotes WHERE id='new'"), '1');
    assert.equal(scalar("SELECT row_version FROM public.customers WHERE id='new'"), '1');
    console.log('ROW_VERSION_DISPOSABLE_PROOF_PASS pre_fix_overwrite=confirmed canonical_contract=preserved validation_order=split-stale-lifecycle-unplan-write canonical_mutation_self_tests=status,sent_at,validation_order,quote_ownership,quote_action_lock_order,lifecycle_token quote_ownership=direct,replay,version,convert,restore quote_action_lock_order=advisory-before-row lifecycle_action=writer-between-load-and-action-rejected restore_replay=payload-owner-current-token-bound smoke_signature_compat=create-legacy,new;convert-legacy,new,widened reverse_order_deadlock=detected quote_single_bump_shape=verified quote_lock_orders=both customer_lock_orders=both idempotent_replay=payload-bound,current-token-verified insert_defaults=verified');
  } finally {
    docker(['rm', '-f', name], undefined, true);
  }
}
main().catch((error) => { console.error(`ROW_VERSION_DISPOSABLE_PROOF_FAIL ${error.stack || error.message}`); process.exitCode = 1; });
