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
  '20260726190515_section9_po_ap_high_remediation.sql',
);

describe('Section 9 PO/AP HIGH remediation contracts', () => {
  it('recomputes Main Warehouse on-order truth after line and status changes', () => {
    expect(migration).toContain(
      "po.status IN ('submitted', 'partially_received')",
    );
    expect(migration).toContain('pg_advisory_xact_lock(73492009)');
    expect(migration).toContain('FULL JOIN (');
    expect(migration).toContain(
      'poi.quantity_ordered - COALESCE(poi.quantity_received, 0)',
    );
    expect(migration).toContain("location = 'Main Warehouse'");
    expect(migration).toContain('AFTER INSERT OR DELETE OR UPDATE OF');
    expect(migration).toContain('AFTER UPDATE OF status ON public.purchase_orders');
    expect(migration).toContain(
      'DROP TRIGGER IF EXISTS trg_po_submitted_on_order',
    );
  });

  it('removes every browser vendor-write path while retaining RPC grants', () => {
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER\n' +
        'ON TABLE public.vendors\nFROM anon, authenticated;',
    );
    expect(migration).toContain('DROP POLICY IF EXISTS vendors_insert');
    expect(migration).toContain('DROP POLICY IF EXISTS vendors_update');
    expect(migration).toContain('DROP POLICY IF EXISTS vendors_admin_delete');
    expect(migration).toContain('SECTION9_VENDOR_GRANT_CHECK_FAILED');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.save_purchase_order(uuid, jsonb, jsonb, uuid, text) FROM PUBLIC, anon;',
    );
  });

  it('locks and revalidates the vendor and PO before inserting an active bill', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.create_vendor_bill(',
    );
    const end = migration.indexOf(
      '-- ---------------------------------------------------------------------------\n' +
        '-- 4.',
      start,
    );
    const body = migration.slice(start, end);
    const vendorLock = body.indexOf(
      'FROM public.vendors\n' +
        '  WHERE id = p_vendor_id\n' +
        '    AND deleted_at IS NULL\n' +
        '  FOR UPDATE;',
    );
    const poLock = body.indexOf('FROM public.purchase_orders\n    WHERE id = p_purchase_order_id\n    FOR UPDATE;');
    const statusGate = body.indexOf('PO_NOT_BILLABLE');
    const insert = body.indexOf('INSERT INTO public.vendor_bills');

    expect(vendorLock).toBeGreaterThan(-1);
    expect(poLock).toBeGreaterThan(vendorLock);
    expect(statusGate).toBeGreaterThan(poLock);
    expect(insert).toBeGreaterThan(statusGate);
    expect(insert).toBeGreaterThan(vendorLock);
    expect(body).toContain("'submitted',\n      'partially_received',\n      'fully_received'");
    expect(body).toContain(
      'p_subtotal_cents IS NULL OR p_subtotal_cents <= 0',
    );
  });

  it('fails closed instead of claiming unsupported historical AP', () => {
    expect(migration).toContain(
      "clock_timestamp() AT TIME ZONE 'America/Chicago'",
    );
    expect(migration).toContain('HISTORICAL_AP_UNAVAILABLE');
    expect(migration).toContain('vb.bill_date <= p_as_of_date');

    const page = source('src', 'pages', 'AccountsPayable.tsx');
    expect(page).toContain('Current AP only.');
    expect(page).toContain('Exact historical AP is unavailable');
    expect(page).toContain("supabase.rpc('get_ap_aging')");
    expect(page).not.toContain('requestAsOfDate');
    expect(page).not.toContain('chicagoBusinessToday');
    expect(page).toContain('Server-determined Chicago business date');
    expect(migration).toContain(
      "DEFAULT ((clock_timestamp() AT TIME ZONE 'America/Chicago')::date)",
    );
    expect(page).not.toContain('type="date"');
  });

  it('locks the stored bill before checking both accounting periods', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.update_vendor_bill(',
    );
    const body = migration.slice(start);
    const lock = body.indexOf('FOR UPDATE;');
    const oldPeriod = body.indexOf('check_period_open(v_bill.bill_date)');
    const newPeriod = body.indexOf('check_period_open(p_bill_date)');

    expect(lock).toBeGreaterThan(-1);
    expect(oldPeriod).toBeGreaterThan(lock);
    expect(newPeriod).toBeGreaterThan(lock);
  });

  it('keeps permanent rollback and two-session prevention proofs registered', () => {
    const registry = source('scripts', 'smoke', 'smoke-specs.json');
    const sweep = source(
      'scripts',
      'db-invariant-sweeps',
      'predicates',
      'section9-po-ap-controls.sql',
    );
    const concurrency = source(
      'scripts',
      'smoke',
      'prove-section9-po-ap-concurrency.mjs',
    );

    expect(registry).toContain('smoke-section9-po-ap-high-remediation.sql');
    expect(sweep).toContain('vendors:browser-mutation-privilege');
    expect(sweep).toContain('vendor_bills:browser-mutation-privilege');
    expect(sweep).toContain('vendor_bills:deleted-vendor:');
    expect(sweep).toContain('vendor_bills:invalid-po:');
    expect(sweep).toContain(
      'public.create_vendor_bill(uuid,uuid,text,date,date,text,bigint,bigint,text,text,boolean,text)',
    );
    expect(sweep).toContain(
      'public._section9_create_vendor_bill_cumulative_impl(uuid,uuid,text,date,date,text,bigint,bigint,text,text)',
    );
    expect(sweep).toContain(
      'public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)',
    );
    expect(sweep).toContain(
      'public._section9_update_vendor_bill_intent_impl_20260831(uuid,bigint,bigint,date,date,text,text)',
    );
    expect(sweep).toContain(
      'public._section9_create_vendor_bill_intent_impl_20260826(uuid,uuid,text,date,date,text,bigint,bigint,text,text)',
    );
    expect(sweep).toContain(
      'public._section9_update_vendor_bill_intent_impl_20260826(uuid,bigint,bigint,date,date,text,text)',
    );
    expect(sweep).toContain(
      "transaction_timestamp() AT TIME ZONE ''America/Chicago''",
    );
    expect(sweep).toMatch(
      /FULL JOIN \(\s*SELECT product_id, quantity_on_order\s*FROM public\.inventory\s*WHERE location = 'Main Warehouse'\s*\) i/,
    );
    expect(concurrency).toContain('SECTION9_PO_AP_CONCURRENCY_PASS');
    expect(concurrency).toContain('VENDOR_HAS_UNPAID_BILLS');
    expect(concurrency).toContain('VENDOR_NOT_FOUND');
    expect(concurrency).toContain(
      '20260510120000_vendor_master_data_rpcs.sql',
    );
    expect(concurrency).toContain("'--network', 'none'");
    expect(concurrency).toContain('SQL exited before marker');

    const cycleCountSmoke = source(
      'scripts',
      'smoke',
      'smoke-cycle-count-concurrency-guards.sql',
    );
    expect(cycleCountSmoke).toContain(
      "'public.complete_cycle_count(uuid,uuid,text,bigint)'::regprocedure",
    );
    expect(cycleCountSmoke).toContain('v_item_revision');

    const areas = source('scripts', 'test-areas.json');
    const lifecycle = areas.slice(
      areas.indexOf('"lifecycle"'),
      areas.indexOf('"pricing"'),
    );
    expect(lifecycle).toContain('src/lib/section9PoApRemediation.test.ts');
    expect(lifecycle).toContain('section9-po-ap-controls');
  });
});
