import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const migration = source(
  'supabase',
  'migrations',
  '20260805151605_fix_historical_ar_report_cutoffs.sql',
);

describe('historical AR report migration', () => {
  it('shares the statement reconstruction boundary instead of trusting current status', () => {
    expect(migration).toContain(
      'public.assert_customer_balance_reconstructable_as_of',
    );
    expect(migration).toContain('public.statement_invoice_was_posted_as_of');
    expect(migration).toContain(
      'public.statement_customer_has_later_balance_activity',
    );
    expect(migration).toContain('i.invoice_date <= p_as_of_date');
    expect(migration).not.toContain("i.status IN ('posted', 'unposted')");
    expect(migration).not.toContain("i.status IN ('posted', 'overdue')");
  });

  it('replays credit applications at the cutoff for invoices and credit memos', () => {
    expect(migration).toContain(
      'i.balance_cents\n        + i.credit_applied_cents\n        - credit_at_cutoff.applied_cents',
    );
    expect(migration).toContain('-ci.total_amount_cents - COALESCE');
    expect(migration).toContain(
      "(cma.applied_at AT TIME ZONE 'America/Chicago')::date <= p_as_of_date",
    );
    expect(migration).toContain(
      "(cma.reversed_at AT TIME ZONE 'America/Chicago')::date > p_as_of_date",
    );
  });

  it('keeps sales-rep current access scoped like RLS and refuses unsupported history', () => {
    expect(migration).toContain(
      "v_role NOT IN ('admin', 'sales_rep')",
    );
    expect(migration).toContain('c.assigned_sales_rep = v_actor');
    expect(migration).toContain(
      'i.created_by = v_actor OR i.salesman_id = v_actor',
    );
    expect(migration).toContain(
      'Admin access required for historical customer balance report',
    );
  });

  it('pins SECURITY DEFINER paths and denies anonymous/private-helper execution', () => {
    expect(migration.match(/^SECURITY DEFINER$/gm)?.length).toBe(3);
    expect(
      migration.match(/^SET search_path TO 'public', 'pg_temp'$/gm)?.length,
    ).toBe(3);
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.get_customer_balance_listing(date) FROM PUBLIC, anon;',
    );
    expect(migration).toContain(
      'FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(migration).toContain(
      "has_function_privilege('anon', 'public.get_ar_aging(date)', 'EXECUTE')",
    );
  });

  it('registers a rollback-only business-chain proof for both RPCs', () => {
    const smoke = source(
      'scripts',
      'smoke',
      'smoke-historical-ar-report-cutoffs.sql',
    );
    const registry = source('scripts', 'smoke', 'smoke-specs.json');
    const areas = source('scripts', 'test-areas.json');

    expect(smoke).toContain('public.get_ar_aging(v_cutoff)');
    expect(smoke).toContain('public.get_customer_balance_listing(v_cutoff)');
    expect(smoke).toContain('HISTORICAL_BALANCE_RECONSTRUCTION_UNAVAILABLE');
    expect(smoke).toContain("RAISE EXCEPTION 'SMOKE_PASS_ROLLBACK'");
    expect(registry).toContain('smoke-historical-ar-report-cutoffs.sql');
    expect(areas).toContain('src/lib/historicalArReportMigration.test.ts');
  });
});
