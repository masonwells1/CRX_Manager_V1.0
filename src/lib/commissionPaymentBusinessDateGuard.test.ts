import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260905020300_enforce_commission_payment_business_date.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const reports = readFileSync('src/pages/Reports.tsx', 'utf8').replace(/\r\n/g, '\n');
const payments = readFileSync('src/pages/CommissionPayments.tsx', 'utf8').replace(/\r\n/g, '\n');
const attributes = readFileSync('.gitattributes', 'utf8').replace(/\r\n/g, '\n');

describe('commission payment Chicago business-date guard', () => {
  it('generates quick-pay and payment-dialog defaults on the report business calendar', () => {
    const markPaidStart = reports.indexOf('const handleMarkPaid = async');
    const markPaidEnd = reports.indexOf('\n  const ', markPaidStart + 30);
    const markPaid = reports.slice(markPaidStart, markPaidEnd);

    expect(markPaidStart).toBeGreaterThan(-1);
    expect(markPaid).toContain('const today = todayInBusinessTz();');
    expect(markPaid).not.toContain('const today = localToday();');

    expect(payments).toContain("import { todayInBusinessTz } from '../lib/dateUtils';");
    expect(payments).toContain('useState(todayInBusinessTz())');
    expect(payments).toContain('setPayDate(todayInBusinessTz())');
    expect(payments).not.toContain('setPayDate(localToday())');
  });

  it('serializes the preflight and refuses an existing future-dated payment', () => {
    const lock = migration.indexOf(
      'LOCK TABLE public.commission_payments IN SHARE ROW EXCLUSIVE MODE;',
    );
    const preflight = migration.indexOf('DO $preflight$');
    const futureScan = migration.indexOf(
      "p.payment_date > timezone('America/Chicago', statement_timestamp())::date",
    );

    expect(lock).toBeGreaterThan(-1);
    expect(lock).toBeLessThan(preflight);
    expect(futureScan).toBeGreaterThan(preflight);
    expect(migration).toContain(
      'COMMISSION_PAYMENT_DATE_AFTER_BUSINESS_TODAY: existing future-dated commission payment requires review',
    );
    expect(migration).toContain('OR v_force_rls');
    expect(migration).toContain("AND a.atttypid = 'date'::regtype");
    expect(migration).toContain('AND a.attnotnull');
    expect(migration).toContain(
      'COMMISSION_PAYMENT_BUSINESS_DATE_PREFLIGHT: existing function or trigger drift',
    );
    expect(attributes).toContain(
      'supabase/migrations/20260905020300_enforce_commission_payment_business_date.sql text eol=lf',
    );
  });

  it('attaches an unconditional insert/update trigger and pins its catalog shape', () => {
    expect(migration).toContain(
      'BEFORE INSERT OR UPDATE OF payment_date ON public.commission_payments',
    );
    expect(migration).toContain(
      "v_business_today date := timezone('America/Chicago', statement_timestamp())::date;",
    );
    expect(migration).toContain('IF NEW.payment_date > v_business_today THEN');
    expect(migration).toContain("ERRCODE = '22007'");
    expect(migration).toContain('AND NOT p.prosecdef');
    expect(migration).toContain("AND p.proconfig = ARRAY['search_path=public, pg_temp']");
    expect(migration).toContain("AND p.proacl::text = '{postgres=X/postgres}'");
    expect(migration).toContain("AND md5(p.prosrc) = '6d7942b3ae76f627f1d7870c8755f82f'");
    expect(migration).toContain('AND t.tgtype = 23');
    expect(migration).toContain('AND t.tgqual IS NULL');
    expect(migration).toContain('AND t.tgnargs = 0');
    expect(migration).toContain('AND octet_length(t.tgargs) = 0');
  });
});
