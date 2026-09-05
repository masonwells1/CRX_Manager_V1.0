import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260905200300_enforce_commission_payment_business_date.sql',
  'utf8',
).replace(/\r\n/g, '\n');
const reports = readFileSync('src/pages/Reports.tsx', 'utf8').replace(/\r\n/g, '\n');
const payments = readFileSync('src/pages/CommissionPayments.tsx', 'utf8').replace(/\r\n/g, '\n');
const attributes = readFileSync('.gitattributes', 'utf8').replace(/\r\n/g, '\n');
const historyProver = readFileSync('scripts/smoke/prove-commission-history-as-of.mjs', 'utf8');
const labelRepairProver = readFileSync('scripts/smoke/prove-commission-history-label-repair.mjs', 'utf8');
const snapshotProver = readFileSync('scripts/smoke/prove-commission-report-snapshot-contract.mjs', 'utf8');
const smokeSpecs = JSON.parse(readFileSync('scripts/smoke/smoke-specs.json', 'utf8')) as {
  specs: Record<string, { container_only?: boolean; container_prover?: string }>;
};

describe('commission payment Chicago business-date guard', () => {
  it('remains compatible with the guarded migration wrapper', () => {
    expect(migration).not.toMatch(/^\s*(BEGIN|START\s+TRANSACTION)\s*;/im);
    expect(migration).not.toMatch(/^\s*(COMMIT|ROLLBACK)\s*;/im);
  });

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
    const timeout = migration.indexOf("SET LOCAL lock_timeout = '10s';");
    const lock = migration.indexOf(
      'LOCK TABLE public.commission_payments IN SHARE ROW EXCLUSIVE MODE;',
    );
    const preflight = migration.indexOf('DO $preflight$');
    const futureScan = migration.indexOf(
      "p.payment_date > timezone('America/Chicago', statement_timestamp())::date",
    );

    expect(timeout).toBeGreaterThan(-1);
    expect(timeout).toBeLessThan(lock);
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
      'supabase/migrations/20260905200300_enforce_commission_payment_business_date.sql text eol=lf',
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

  it('keeps the commission-history chain container-only and its lock probes stable', () => {
    expect(smokeSpecs.specs.commission_history_as_of).toMatchObject({
      container_only: true,
      container_prover: 'prove-commission-history-as-of.mjs',
    });
    expect(historyProver).toContain('SELECT pg_sleep(5);');
    expect(historyProver).toContain('const attempts = expectedToBlock ? 30 : 1;');
    expect(historyProver).toContain("'--label', `${PROOF_LABEL_KEY}=${NAME}`");
  });

  it('isolates timeout cleanup for both generated commission proof wrappers', () => {
    for (const prover of [labelRepairProver, snapshotProver]) {
      expect(prover).toContain('CRX_COMMISSION_PROOF_NAME: NAME');
      expect(prover).toContain("['ps', '-aq', '--filter', `label=${PROOF_LABEL_KEY}=${NAME}`]");
      expect(prover).toContain("spawnSync('docker', ['rm', '-f', ...containerIds]");
      expect(prover).toContain("result?.error?.code === 'ETIMEDOUT'");
      expect(prover).not.toMatch(/docker[^\n]*(prune|rm', '-f', NAME)/);
    }
  });

  it('emits a real newline regex in the generated snapshot proof', () => {
    expect(snapshotProver).toContain('split(/\\\\r?\\\\n/).pop()');
    expect(snapshotProver).not.toContain('split(/\\\\\\\\r?\\\\\\\\n/).pop()');
  });
});
