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
const smokeSpecs = JSON.parse(source('scripts', 'smoke', 'smoke-specs.json')) as {
  specs: Record<string, { chain: string; covers: string[] }>;
};

function body(name: string) {
  const start = migration.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start).toBeGreaterThan(-1);
  return migration.slice(start, migration.indexOf('$function$;', start));
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
  });

  it('requires accounting_periods rows to be exactly one calendar month', () => {
    expect(migration).toContain('accounting_periods_whole_calendar_month_check');
    expect(migration).toContain("INTERVAL '1 month - 1 day'");
  });

  it('takes exclusive close lock before invoice scan and upsert', () => {
    const close = body('close_accounting_period(');
    const lock = close.indexOf('_lock_accounting_months(ARRAY[v_period_start], true)');
    expect(lock).toBeGreaterThan(close.indexOf('v_period_start := date_trunc'));
    expect(lock).toBeLessThan(close.indexOf('SELECT count(*) INTO v_unposted_count'));
    expect(lock).toBeLessThan(close.indexOf('INSERT INTO public.accounting_periods'));
  });

  it('keeps the central closed-period reader narrow and tightly pinned', () => {
    const check = body('check_period_open(');
    expect(check).toContain("SET search_path = ''");
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
    expect(proof).toContain("classid=73492010");
    expect(proof).toContain("'--network', 'none'");
    expect(proof).toContain('const BARRIER_SECONDS = 8;');
    expect(proof).toContain("const MIGRATION_SUFFIX = '_vendor_bill_period_close_lock.sql';");
    expect(proof.match(/pg_sleep\(\$\{BARRIER_SECONDS\}\)/g)).toHaveLength(8);
    const section9 = smokeSpecs.specs.section9_po_ap_high_remediation;
    expect(section9.chain).toBe('smoke-section9-po-ap-high-remediation.sql');
    expect(section9.covers).toEqual(expect.arrayContaining([
      'create_vendor_bill',
      'update_vendor_bill',
      'close_accounting_period',
      'check_period_open',
    ]));
  });
});
