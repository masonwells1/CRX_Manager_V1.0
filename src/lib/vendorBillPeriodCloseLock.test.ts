import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const migrationDir = join(root, 'supabase', 'migrations');
const migrationSuffix = '_vendor_bill_period_close_lock.sql';
const migrationMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(migrationSuffix));
if (migrationMatches.length !== 1) {
  throw new Error(`expected exactly one ${migrationSuffix} migration, found ${migrationMatches.join(', ') || 'none'}`);
}
const migration = readFileSync(join(migrationDir, migrationMatches[0]), 'utf8').replace(/\r\n/g, '\n');
const source = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')
  .replace(/\r\n/g, '\n');
const idempotencyRecheckSuffix = '_close_accounting_period_idempotency_recheck.sql';
const idempotencyRecheckMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(idempotencyRecheckSuffix));
if (idempotencyRecheckMatches.length !== 1) {
  throw new Error(`expected exactly one ${idempotencyRecheckSuffix} migration, found ${idempotencyRecheckMatches.join(', ') || 'none'}`);
}
const idempotencyRecheckMigration = readFileSync(join(migrationDir, idempotencyRecheckMatches[0]), 'utf8')
  .replace(/\r\n/g, '\n');
const immutableDateMathSuffix = '_accounting_period_immutable_date_math.sql';
const immutableDateMathMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(immutableDateMathSuffix));
if (immutableDateMathMatches.length !== 1) {
  throw new Error(`expected exactly one ${immutableDateMathSuffix} migration, found ${immutableDateMathMatches.join(', ') || 'none'}`);
}
const immutableDateMathMigration = readFileSync(join(migrationDir, immutableDateMathMatches[0]), 'utf8')
  .replace(/\r\n/g, '\n');
const apBoundaryHardeningSuffix = '_ap_period_close_boundary_hardening.sql';
const apBoundaryHardeningMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(apBoundaryHardeningSuffix));
if (apBoundaryHardeningMatches.length !== 1) {
  throw new Error(`expected exactly one ${apBoundaryHardeningSuffix} migration, found ${apBoundaryHardeningMatches.join(', ') || 'none'}`);
}
const apBoundaryHardeningMigration = readFileSync(
  join(migrationDir, apBoundaryHardeningMatches[0]),
  'utf8',
).replace(/\r\n/g, '\n');
const helperAclPostflightSuffix = '_vendor_bill_month_lock_helper_acl_postflight.sql';
const helperAclPostflightMatches = readdirSync(migrationDir)
  .filter((name) => /^\d{14}_/.test(name) && name.endsWith(helperAclPostflightSuffix));
if (helperAclPostflightMatches.length !== 1) {
  throw new Error(`expected exactly one ${helperAclPostflightSuffix} migration, found ${helperAclPostflightMatches.join(', ') || 'none'}`);
}
const helperAclPostflightMigration = readFileSync(
  join(migrationDir, helperAclPostflightMatches[0]),
  'utf8',
).replace(/\r\n/g, '\n');
const smokeSpecs = JSON.parse(source('scripts', 'smoke', 'smoke-specs.json')) as {
  specs: Record<string, { chain: string; covers: string[] }>;
};

function body(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start).toBeGreaterThan(-1);
  return migration.slice(start, migration.indexOf('$function$;', start));
}

function recheckBody() {
  const start = idempotencyRecheckMigration.indexOf('CREATE OR REPLACE FUNCTION public.close_accounting_period');
  expect(start).toBeGreaterThan(-1);
  return idempotencyRecheckMigration.slice(start, idempotencyRecheckMigration.indexOf('$function$;', start));
}

function apBoundaryBody(name: string) {
  const start = apBoundaryHardeningMigration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start).toBeGreaterThan(-1);
  return apBoundaryHardeningMigration.slice(start, apBoundaryHardeningMigration.indexOf('$function$;', start));
}

describe('vendor-bill accounting-period close serialization', () => {
  it('uses a separate sorted two-integer transaction lock namespace', () => {
    const helper = body('_lock_accounting_months(');
    expect(helper).toContain('SECURITY INVOKER');
    expect(helper).toContain('pg_advisory_xact_lock_shared(73492010, v_month_key)');
    expect(helper).toContain('pg_advisory_xact_lock(73492010, v_month_key)');
    expect(helper).toContain('SELECT DISTINCT');
    expect(helper).toContain('ORDER BY 1');
    expect(migration).toContain('REVOKE ALL ON FUNCTION public._lock_accounting_months(date[], boolean)');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role;');
    expect(migration).toContain('PERIOD_CLOSE_POSTFLIGHT_FUNCTION_COUNT');
    expect(migration).toContain('PERIOD_CLOSE_POSTFLIGHT_SECURITY_MODE');
    expect(migration).toContain('PERIOD_CLOSE_POSTFLIGHT_HELPER_EXECUTE');
    expect(migration).toContain("has_function_privilege(v_owner_oid, v_helper_oid, 'EXECUTE')");
  });

  it('requires accounting_periods rows to be exactly one calendar month', () => {
    expect(migration).toContain('accounting_periods_whole_calendar_month_check');
    expect(migration).toContain("INTERVAL '1 month - 1 day'");
    expect(immutableDateMathMigration).toContain(
      'period_start::timestamp without time zone',
    );
    expect(immutableDateMathMigration).toContain(
      'p_period_end::timestamp without time zone',
    );
    expect(immutableDateMathMigration).toContain(
      'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_CONSTRAINT_DRIFT',
    );
    expect(immutableDateMathMigration).toContain(
      'ACCOUNTING_PERIOD_IMMUTABLE_DATE_MATH_FUNCTION_DRIFT',
    );
    const immutableCloseStart = immutableDateMathMigration.indexOf(
      'CREATE OR REPLACE FUNCTION public.close_accounting_period',
    );
    const immutableConstraintStart = immutableDateMathMigration.indexOf(
      'ADD CONSTRAINT accounting_periods_whole_calendar_month_check',
    );
    expect(
      immutableDateMathMigration
        .slice(immutableConstraintStart, immutableCloseStart)
        .match(/period_start::timestamp without time zone/g),
    ).toHaveLength(2);
    const immutableCloseEnd = immutableDateMathMigration.indexOf(
      '$function$;',
      immutableCloseStart,
    );
    expect(
      immutableDateMathMigration
        .slice(immutableCloseStart, immutableCloseEnd)
        .match(/p_period_end::timestamp without time zone/g),
    ).toHaveLength(2);
  });

  it('takes exclusive close lock before invoice scan and upsert', () => {
    const close = body('close_accounting_period(');
    const lock = close.indexOf('_lock_accounting_months(ARRAY[v_period_start], true)');
    expect(lock).toBeGreaterThan(close.indexOf('v_period_start := date_trunc'));
    expect(lock).toBeLessThan(close.indexOf('SELECT count(*) INTO v_unposted_count'));
    expect(lock).toBeLessThan(close.indexOf('INSERT INTO public.accounting_periods'));
  });

  it('retains the structural same-key defense-in-depth check after the exclusive month lock', () => {
    expect(idempotencyRecheckMigration).toContain('APPLIED LIVE 2026-07-30 as Supabase ledger version 20260730124308');
    const close = recheckBody();
    const firstCheck = close.indexOf("check_idempotency(p_idempotency_key, 'close_accounting_period')");
    const lock = close.indexOf('_lock_accounting_months(ARRAY[v_period_start], true)');
    const secondCheck = close.indexOf("check_idempotency(p_idempotency_key, 'close_accounting_period')", firstCheck + 1);
    const alreadyClosed = close.indexOf('Period % to % is already closed');
    expect(firstCheck).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(firstCheck);
    expect(secondCheck).toBeGreaterThan(lock);
    expect(secondCheck).toBeLessThan(alreadyClosed);
    expect(idempotencyRecheckMigration).toContain('PERIOD_CLOSE_IDEMPOTENCY_RECHECK_SIGNATURE_OR_OWNER_DRIFT');
    expect(idempotencyRecheckMigration).toContain('PERIOD_CLOSE_IDEMPOTENCY_RECHECK_ACL_DRIFT');
  });

  it('keeps the central closed-period reader narrow and tightly pinned', () => {
    const check = body('check_period_open(');
    expect(check).toContain("SET search_path = ''");
    expect(check).toContain('FROM public.accounting_periods');
    const nonCatalogRelations = [...check.matchAll(/\bFROM\s+([a-z_][a-z0-9_.]*)/gi)]
      .map((match) => match[1])
      .filter((relation) => !relation.startsWith('pg_catalog.'));
    expect(nonCatalogRelations).toEqual(['public.accounting_periods']);
    expect(check).not.toContain('_lock_accounting_months');
  });

  it('holds writer shared locks across the actual period checks in safe order', () => {
    const create = body('create_vendor_bill(');
    expect(create.indexOf('FROM public.vendors')).toBeLessThan(create.indexOf('check_period_open(p_bill_date)'));
    expect(create.indexOf('FROM public.purchase_orders')).toBeLessThan(create.indexOf('check_period_open(p_bill_date)'));
    const createLock = create.indexOf('_lock_accounting_months(ARRAY[p_bill_date], false)');
    const createCheck = create.indexOf('check_period_open(p_bill_date)');
    expect(createLock).toBeGreaterThan(create.indexOf('FROM public.purchase_orders'));
    expect(createLock).toBeLessThan(createCheck);
    expect(createCheck).toBeLessThan(create.indexOf('INSERT INTO public.vendor_bills'));

    const update = body('update_vendor_bill(');
    const row = update.indexOf('FOR UPDATE;');
    const locks = update.indexOf('_lock_accounting_months(ARRAY[v_bill.bill_date, p_bill_date], false)');
    const oldCheck = update.indexOf('check_period_open(v_bill.bill_date)');
    const newCheck = update.indexOf('check_period_open(p_bill_date)');
    expect(locks).toBeGreaterThan(row);
    expect(locks).toBeLessThan(oldCheck);
    expect(oldCheck).toBeLessThan(newCheck);
  });

  it('extends the same atomic boundary to AP payment and void writers and removes authenticated direct period writes', () => {
    const recordPayment = apBoundaryBody('record_vendor_payment(');
    const recordLock = recordPayment.indexOf('_lock_accounting_months(ARRAY[p_payment_date], false)');
    const recordCheck = recordPayment.indexOf('check_period_open(p_payment_date)');
    for (const position of [
      recordPayment.indexOf('FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE'),
      recordLock,
      recordCheck,
      recordPayment.indexOf('INSERT INTO vendor_payments'),
    ]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(recordPayment.indexOf('FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE')).toBeLessThan(recordLock);
    expect(recordLock).toBeLessThan(recordCheck);
    expect(recordCheck).toBeLessThan(recordPayment.indexOf('INSERT INTO vendor_payments'));

    const voidPayment = apBoundaryBody('void_vendor_payment(');
    const voidPaymentLock = voidPayment.indexOf('_lock_accounting_months(ARRAY[v_payment.payment_date], false)');
    const voidPaymentCheck = voidPayment.indexOf('check_period_open(v_payment.payment_date)');
    for (const position of [
      voidPayment.indexOf('FROM vendor_payments WHERE id = p_payment_id FOR UPDATE'),
      voidPayment.indexOf('FROM vendor_bills WHERE id = v_payment.vendor_bill_id FOR UPDATE'),
      voidPayment.indexOf('deleted_at IS NULL FOR UPDATE'),
      voidPaymentLock,
      voidPaymentCheck,
      voidPayment.indexOf('UPDATE vendor_bills SET'),
    ]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(voidPayment.indexOf('FROM vendor_payments WHERE id = p_payment_id FOR UPDATE')).toBeLessThan(voidPaymentLock);
    expect(voidPayment.indexOf('FROM vendor_bills WHERE id = v_payment.vendor_bill_id FOR UPDATE')).toBeLessThan(voidPaymentLock);
    expect(voidPayment.indexOf('deleted_at IS NULL FOR UPDATE')).toBeLessThan(voidPaymentLock);
    expect(voidPaymentLock).toBeLessThan(voidPaymentCheck);
    expect(voidPaymentCheck).toBeLessThan(voidPayment.indexOf('UPDATE vendor_bills SET'));

    const voidBill = apBoundaryBody('void_vendor_bill(');
    const voidBillLock = voidBill.indexOf('_lock_accounting_months(ARRAY[v_bill.bill_date], false)');
    const voidBillCheck = voidBill.indexOf('check_period_open(v_bill.bill_date)');
    for (const position of [
      voidBill.indexOf('FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE'),
      voidBill.indexOf('IF v_active_payments > 0 THEN'),
      voidBillLock,
      voidBillCheck,
      voidBill.indexOf('UPDATE vendor_bills SET'),
    ]) {
      expect(position).toBeGreaterThan(-1);
    }
    expect(voidBill.indexOf('FROM vendor_bills WHERE id = p_vendor_bill_id FOR UPDATE')).toBeLessThan(voidBillLock);
    expect(voidBill.indexOf('IF v_active_payments > 0 THEN')).toBeLessThan(voidBillLock);
    expect(voidBillLock).toBeLessThan(voidBillCheck);
    expect(voidBillCheck).toBeLessThan(voidBill.indexOf('UPDATE vendor_bills SET'));

    for (const rpc of ['record_vendor_payment', 'void_vendor_payment', 'void_vendor_bill']) {
      expect(apBoundaryHardeningMigration).toContain(`REVOKE ALL ON FUNCTION public.${rpc}`);
      expect(apBoundaryHardeningMigration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc}`);
    }
    expect(apBoundaryHardeningMigration).toContain(
      'REVOKE ALL PRIVILEGES ON TABLE public.accounting_periods FROM PUBLIC, anon, authenticated;',
    );
    expect(apBoundaryHardeningMigration).toContain(
      'GRANT SELECT ON TABLE public.accounting_periods TO authenticated;',
    );
    expect(apBoundaryHardeningMigration).toContain(
      'AP boundary verification: browser role retains direct period mutation privilege',
    );
  });

  it('keeps the restored-schema concurrency proof and registered business chain', () => {
    const proof = source(
      'scripts', 'smoke', 'prove-vendor-bill-period-close-concurrency.mjs',
    );
    expect(proof).toMatch(/console\.log\('BASELINE_CREATE_CLOSE_RACE_REPRODUCED'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_UPDATE_WRITER_FIRST_CLOSE_WAITS_PASS'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_UPDATE_CLOSE_FIRST_FAIL_CLOSED_PASS'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_UPDATE_SHARED_REVERSE_MONTH_COMPLETION_PASS'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_UPDATE_CANONICAL_JAN_FIRST_PASS'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_UPDATE_CANONICAL_FORWARD_ORDER_PASS'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_POSTFLIGHT_OWNER_AND_ACL_PASS'\)/);
    expect(proof).toMatch(/console\.log\('CANDIDATE_CLOSE_SAME_KEY_SERIALIZATION_PASS'\)/);
    expect(proof).toContain("acl.grantee = 0");
    expect(proof).toContain("has_function_privilege('anon', p.oid, 'EXECUTE')");
    expect(proof).toContain("has_function_privilege('service_role', p.oid, 'EXECUTE')");
    expect(proof).toContain("classid=73492010");
    expect(proof).toContain("'--network', 'none'");
    expect(proof).toContain('const BARRIER_SECONDS = 8;');
    expect(proof).toContain("const MIGRATION_SUFFIX = '_vendor_bill_period_close_lock.sql';");
    expect(proof).toContain("const IDEMPOTENCY_RECHECK_SUFFIX = '_close_accounting_period_idempotency_recheck.sql';");
    expect(proof).toContain("const IMMUTABLE_DATE_MATH_SUFFIX = '_accounting_period_immutable_date_math.sql';");
    expect(proof).toContain("const AP_BOUNDARY_HARDENING_SUFFIX = '_ap_period_close_boundary_hardening.sql';");
    expect(proof).toContain('waitForDatabaseReadiness');
    expect(proof).toContain("waitForBarrierWaiters(1, 'baseline writer trigger barrier')");
    expect(proof).toContain("waitForSessionLock('same-key-second-close'");
    expect(proof).not.toContain('await waiting(');
    expect(proof).not.toContain('pause(500)');
    expect(proof.match(/pg_sleep\(\$\{BARRIER_SECONDS\}\)/g)).toHaveLength(16);
    expect(proof).toContain('CANDIDATE_SECTION9_CUTOVER_DRAINS_LEGACY_WRITER_PASS');
    expect(proof).toContain('CANDIDATE_SECTION9_LATE_OLD_BODY_ROLLBACK_PASS');
    expect(proof).toContain("waitForSessionLock('section9-cutover-migration'");
    expect(proof).toContain('SECTION9_UNBOUND_IDEMPOTENCY_RECEIPT');
    for (const marker of [
      'CANDIDATE_AP_RECORD_PAYMENT_WRITER_FIRST_CLOSE_WAITS_PASS',
      'CANDIDATE_AP_RECORD_PAYMENT_CLOSE_FIRST_FAIL_CLOSED_PASS',
      'CANDIDATE_AP_VOID_PAYMENT_WRITER_FIRST_CLOSE_WAITS_PASS',
      'CANDIDATE_AP_VOID_PAYMENT_CLOSE_FIRST_FAIL_CLOSED_PASS',
      'CANDIDATE_AP_VOID_BILL_WRITER_FIRST_CLOSE_WAITS_PASS',
      'CANDIDATE_AP_VOID_BILL_CLOSE_FIRST_FAIL_CLOSED_PASS',
      'CANDIDATE_ACCOUNTING_PERIODS_DIRECT_WRITE_DENIED_PASS',
    ]) expect(proof).toContain(marker);
    expect(proof).toContain("SET LOCAL ROLE authenticated; INSERT INTO public.accounting_periods");
    const deliverySmoke = source('scripts', 'smoke', 'smoke-delivery-accounting-period-guard.sql');
    expect(deliverySmoke).toContain("v_closed_date := DATE '1990-01-15';");
    expect(deliverySmoke).toContain("v_open_date := DATE '1990-02-15';");
    expect(deliverySmoke).toContain("v_second_open_date := DATE '1990-03-15';");
    expect(deliverySmoke).toContain('enforce_delivery_accounting_period');
    expect(deliverySmoke).not.toContain('CURRENT_DATE');
    const section9 = smokeSpecs.specs.section9_po_ap_high_remediation;
    expect(section9.chain).toBe('smoke-section9-po-ap-high-remediation.sql');
    expect(section9.covers).toEqual(expect.arrayContaining([
      'create_vendor_bill',
      'update_vendor_bill',
      'close_accounting_period',
      'check_period_open',
    ]));
    const section9Smoke = source(
      'scripts',
      'smoke',
      'smoke-section9-po-ap-high-remediation.sql',
    );
    expect(section9Smoke).toContain("'request.jwt.claims'");
    expect(section9Smoke).toContain("'request.jwt.claim.sub'");
  });

  it('fails apply if the helper or its SECURITY DEFINER callers lose trusted ownership or least privilege', () => {
    expect(helperAclPostflightMigration).toContain(
      'VENDOR_BILL_MONTH_LOCK_HELPER_ACL_DRIFT',
    );
    expect(helperAclPostflightMigration).toContain(
      'acl.grantee <> v_owner_oid',
    );
    expect(helperAclPostflightMigration).toContain(
      "v_owner_name IS DISTINCT FROM 'postgres'",
    );
    expect(helperAclPostflightMigration).toContain(
      'VENDOR_BILL_MONTH_LOCK_CALLER_TRUSTED_OWNER_DRIFT',
    );
    for (const caller of ['create_vendor_bill', 'update_vendor_bill', 'close_accounting_period']) {
      expect(helperAclPostflightMigration).toContain(`'${caller}'`);
    }
    expect(helperAclPostflightMigration).toContain(
      'VENDOR_BILL_MONTH_LOCK_HELPER_SECURITY_DRIFT',
    );
    expect(helperAclPostflightMigration).toContain(
      "ARRAY['search_path=public, pg_temp']::text[]",
    );
    const proof = source(
      'scripts', 'smoke', 'prove-vendor-bill-period-close-concurrency.mjs',
    );
    expect(proof).toContain('proof_untrusted_helper_owner');
    expect(proof).toContain('proof_helper_exec_grantee');
    expect(proof).toContain('CANDIDATE_VALIDATION_MUTATION_REJECTED');
  });
});
