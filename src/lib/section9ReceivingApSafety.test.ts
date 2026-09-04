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
  '20260831160000_harden_receiving_reversal_and_ap_reporting.sql',
);
const cumulativeBillMigration = source(
  'supabase',
  'migrations',
  '20260831161000_require_cumulative_po_bill_confirmation.sql',
);
const commissionBalanceMigration = source(
  'supabase',
  'migrations',
  '20260831162000_fail_closed_historical_commission_balance.sql',
);

describe('Section 9 receiving reversal and AP reporting safety', () => {
  it('binds each reversal receipt to the authenticated actor and exact target', () => {
    expect(migration).toContain('check_idempotency_intent(');
    expect(migration).toContain("'record_id', p_record_id");
    expect(migration).toContain("'reason', v_reason");
    expect(migration).toContain('request_fingerprint = v_fingerprint');
    expect(migration).toContain('request_actor_id = v_actor');

    const panel = source('src', 'components', 'receiving', 'ReceivingLogPanel.tsx');
    expect(panel).toContain('getKeyFor(intentScope)');
    expect(panel).toContain('resetKeyFor(intentScope)');
    expect(panel).toContain('getIdempotencyBindingRejection(error)');
    expect(panel).toContain('JSON.stringify({ recordId: id, reason })');
    expect(panel).toContain('const completedScopes: string[] = []');
    const completedScope = panel.indexOf('completedScopes.push(intentScope)');
    const batchRetirement = panel.indexOf('for (const intentScope of completedScopes)');
    expect(completedScope).toBeGreaterThan(-1);
    expect(batchRetirement).toBeGreaterThan(completedScope);
    expect(panel).not.toContain('const idemKey = reverseRecIdem.getKey();');
  });

  it('fails the entire reversal when inventory or PO item mutation misses', () => {
    expect(migration).toContain('GET DIAGNOSTICS v_inventory_rows = ROW_COUNT');
    expect(migration).toContain('RECEIVING_REVERSAL_INVENTORY_MISMATCH');
    expect(migration).toContain('GET DIAGNOSTICS v_po_item_rows = ROW_COUNT');
    expect(migration).toContain('RECEIVING_REVERSAL_PO_ITEM_MISMATCH');
  });

  it('blocks reversal across closed periods and active vendor bills', () => {
    expect(migration).toContain('check_period_open(');
    expect(migration).toContain('RECEIVING_REVERSAL_BLOCKED_BY_VENDOR_BILL');
    expect(migration).toContain("vb.status <> 'voided'");
  });

  it('preserves receipt and photo evidence before deleting source rows', () => {
    const audit = migration.indexOf('INSERT INTO public.financial_audit_log');
    const deletePhotos = migration.indexOf('DELETE FROM public.receiving_photos');
    const deleteRecord = migration.indexOf('DELETE FROM public.receiving_records');

    expect(audit).toBeGreaterThan(-1);
    expect(deletePhotos).toBeGreaterThan(audit);
    expect(deleteRecord).toBeGreaterThan(deletePhotos);
    expect(migration).toContain("'receiving_record', to_jsonb(v_rec), 'photos', v_photos");
    expect(migration).toContain('REVOKE TRUNCATE ON TABLE public.receiving_photos');
    expect(migration).toContain('FROM PUBLIC, anon, authenticated');
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.receiving_records',
    );
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(migration).toContain(
        `has_table_privilege('authenticated', 'public.receiving_records', '${privilege}')`,
      );
    }
    expect(migration).toContain(')) NOT VALID;');
    expect(migration).toContain('VALIDATE CONSTRAINT financial_audit_log_entity_type_check');
    expect(migration).toContain('VALIDATE CONSTRAINT financial_audit_log_operation_type_check');
  });

  it('ages AP from due date with a separate 1-30 bucket and calendar month', () => {
    expect(migration).toContain('days_1_30 bigint');
    expect(migration).toContain('(p_as_of_date - vb.due_date) BETWEEN 1 AND 30');
    expect(migration).toContain('due_date BETWEEN v_today AND v_month_end');
    expect(migration).toContain('vp.payment_date BETWEEN date_trunc');
    const agingStart = migration.indexOf('CREATE FUNCTION public.get_ap_aging(');
    const agingEnd = migration.indexOf('CREATE OR REPLACE FUNCTION public.get_ap_dashboard_summary', agingStart);
    expect(agingStart).toBeGreaterThan(-1);
    expect(agingEnd).toBeGreaterThan(agingStart);
    expect(migration.slice(agingStart, agingEnd)).not.toContain('clock_timestamp()');

    const page = source('src', 'pages', 'AccountsPayable.tsx');
    expect(page).toContain("key: 'days_1_30'");
    expect(page).toContain("header: '1-30 Days Past Due'");
  });

  it('requires a logged reason above the cumulative PO billing threshold', () => {
    const vendorLock = cumulativeBillMigration.indexOf('FROM public.vendors v');
    const poLock = cumulativeBillMigration.indexOf('FROM public.purchase_orders po');
    expect(vendorLock).toBeGreaterThan(-1);
    expect(poLock).toBeGreaterThan(vendorLock);
    expect(cumulativeBillMigration.slice(vendorLock, poLock)).toContain('FOR UPDATE');
    expect(cumulativeBillMigration).toContain(
      "vb.deleted_at IS NULL\n      AND vb.status <> 'voided'",
    );
    expect(cumulativeBillMigration).toContain(
      'v_cumulative_total * 100 > v_po_total * 105',
    );
    expect(cumulativeBillMigration).toContain(
      'v_po_total <= 0 OR v_cumulative_total * 100 > v_po_total * 105',
    );
    expect(cumulativeBillMigration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.vendor_bills',
    );
    for (const privilege of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
      expect(cumulativeBillMigration).toContain(
        `has_table_privilege('authenticated', 'public.vendor_bills', '${privilege}')`,
      );
    }
    expect(cumulativeBillMigration).toContain(
      'PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED',
    );
    expect(cumulativeBillMigration).toContain(
      'PO_CUMULATIVE_BILLING_REASON_REQUIRED',
    );
    expect(cumulativeBillMigration).toContain(
      'COALESCE(p_confirm_po_overage, false) IS NOT TRUE',
    );
    expect(cumulativeBillMigration).toContain(
      "'po_cumulative_billing_overage_confirmed'",
    );

    const page = source('src', 'pages', 'NewVendorBill.tsx');
    expect(page).toContain('Confirm PO billing overage');
    expect(page).toContain('p_confirm_po_overage: confirmPoOverage');
    expect(page).toContain('p_po_overage_reason: poOverageReason');
  });

  it('fingerprints the exact nullable bill text values passed to the implementation', () => {
    expect(cumulativeBillMigration).toContain("'bill_number', p_bill_number");
    expect(cumulativeBillMigration).toContain("'payment_terms', p_payment_terms");
    expect(cumulativeBillMigration).toContain("'notes', p_notes");
    expect(cumulativeBillMigration).not.toContain(
      "'payment_terms', btrim(COALESCE(p_payment_terms, ''))",
    );
    expect(cumulativeBillMigration).toContain(
      "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')",
    );
    expect(cumulativeBillMigration).toContain(
      "EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')",
    );
  });

  it('blocks cutover while a live legacy reversal or bill-creation receipt exists', () => {
    for (const [candidate, operation] of [
      [migration, 'reverse_receiving_record'],
      [cumulativeBillMigration, 'create_vendor_bill'],
    ] as const) {
      expect(candidate).toContain(
        'LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE',
      );
      expect(candidate).toContain(`operation = '${operation}'`);
      expect(candidate).toContain(
        '(expires_at IS NULL OR expires_at >= transaction_timestamp())',
      );
      expect(candidate).toContain(
        '(request_actor_id IS NULL OR request_fingerprint IS NULL)',
      );
      expect(candidate).toContain('SECTION9_INTENT_CUTOVER_BLOCKED');
      expect(candidate).not.toMatch(/^BEGIN;|\nBEGIN;\s*$/m);
      expect(candidate.trimEnd()).not.toMatch(/COMMIT;$/);
    }
  });

  it('refuses unsupported historical commission balance cutoffs', () => {
    expect(commissionBalanceMigration).toContain(
      'HISTORICAL_COMMISSION_BALANCE_UNAVAILABLE',
    );
    expect(commissionBalanceMigration).toContain(
      "transaction_timestamp() AT TIME ZONE 'America/Chicago'",
    );
    expect(commissionBalanceMigration).toContain(
      "CASE WHEN cm.status <> 'cancelled' THEN cm.commission_amount ELSE 0 END",
    );

    const reports = source('src', 'pages', 'Reports.tsx');
    expect(reports).toContain(
      "get_commission_balance_report', { p_as_of_date: todayInBusinessTz() }",
    );
    expect(reports).toContain('Commission Balance is current-state only.');
    // The banner alone let the date controls stay live while the report ignored
    // them, so the screen showed a historical cutoff it never applied. Pin the
    // disabling itself, not just the wording that describes it.
    expect(reports).toContain(
      "dateFilterBar(handleFinancialCSV, financialTab === 'commission_balance')",
    );
    expect(reports).toContain('const dateFilterBar = (onCSV: () => void, datesDisabled = false) =>');
  });
});
