import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const migration = source(
  'supabase',
  'migrations',
  '20260826125456_bind_section9_ap_receiving_intent_and_month_dashboard.sql',
);
const agingMigration = source(
  'supabase',
  'migrations',
  '20260826140333_correct_ap_aging_due_date_buckets.sql',
);
const accountsPayable = source('src', 'pages', 'AccountsPayable.tsx');
const vendorBillDetail = source('src', 'pages', 'VendorBillDetail.tsx');
const purchaseOrderDetail = source('src', 'pages', 'PurchaseOrderDetail.tsx');
const newVendorBill = source('src', 'pages', 'NewVendorBill.tsx');
const inventoryPage = source('src', 'pages', 'InventoryPage.tsx');
const receivingHub = source('src', 'components', 'receiving', 'ReceivingHubPanel.tsx');

const publicSignatures = [
  'create_vendor_bill(uuid, uuid, text, date, date, text, bigint, bigint, text, text)',
  'update_vendor_bill(uuid, bigint, bigint, date, date, text, text)',
  'record_vendor_payment(uuid, bigint, date, text, text, text, text)',
  'void_vendor_payment(uuid, text, text)',
  'void_vendor_bill(uuid, text, text)',
  'receive_po_items(jsonb, uuid, text, boolean)',
];

const privateNames = [
  '_section9_create_vendor_bill_intent_impl_20260826',
  '_section9_update_vendor_bill_intent_impl_20260826',
  '_section9_record_vendor_payment_intent_impl_20260826',
  '_section9_void_vendor_payment_intent_impl_20260826',
  '_section9_void_vendor_bill_intent_impl_20260826',
  '_section9_receive_po_items_intent_impl_20260826',
];

function hasIntentBindingContract(sql: string) {
  return publicSignatures.every((signature) =>
    sql.includes(`ALTER FUNCTION public.${signature} OWNER TO postgres;`)
    && sql.includes(`REVOKE ALL ON FUNCTION public.${signature} FROM PUBLIC, anon;`)
    && sql.includes(`GRANT EXECUTE ON FUNCTION public.${signature} TO authenticated, service_role;`),
  )
    && privateNames.every((name) =>
      sql.includes(`REVOKE ALL ON FUNCTION public.${name}(`)
      && sql.includes('FROM PUBLIC, anon, authenticated, service_role;'),
    )
    && (sql.match(/FROM PUBLIC, anon, authenticated, service_role;/g) ?? []).length === 6
    && (sql.match(/public\.check_idempotency_intent\(/g) ?? []).length === 7
    && (sql.match(/request_actor_id = v_actor/g) ?? []).length >= 7
    && (sql.match(/request_fingerprint = v_fingerprint/g) ?? []).length >= 7
    && (sql.match(/extensions\.digest\(/g) ?? []).length === 6
    && sql.includes('SECTION9_ACTIVE_LEGACY_IDEMPOTENCY_RECEIPTS');
}

describe('Section 9 AP and receiving intent binding', () => {
  it('binds all six public mutation receipts and keeps their implementations private', () => {
    expect(hasIntentBindingContract(migration)).toBe(true);
    expect(migration).toContain('p_purchase_order_id uuid DEFAULT NULL::uuid');
    expect(migration).toContain("p_bill_number text DEFAULT ''::text");
    expect(migration).toContain('p_payment_date date DEFAULT CURRENT_DATE');
    expect(migration).toContain('p_reason text DEFAULT NULL::text');
  });

  it('fails its executable contract when any load-bearing guard is removed', () => {
    expect(hasIntentBindingContract(
      migration.replace('public.check_idempotency_intent(', 'public.check_idempotency('),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace('request_actor_id = v_actor', 'request_actor_id = NULL'),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace('extensions.digest(', 'public.digest('),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace('FROM PUBLIC, anon, authenticated, service_role;', 'FROM PUBLIC, anon;'),
    )).toBe(false);
  });

  it('uses the Chicago calendar month boundary for the dashboard tile', () => {
    expect(migration).toContain("clock_timestamp() AT TIME ZONE 'America/Chicago'");
    expect(migration).toContain('due_date BETWEEN v_today AND v_month_end');
    expect(migration).not.toContain('due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30');
  });

  it('ages AP by due date across all five approved boundary buckets', () => {
    const hasDueDateAgingContract = (sql: string) =>
      sql.includes('days_1_30 bigint')
      && sql.includes('vb.due_date >= p_as_of_date')
      && sql.includes('(p_as_of_date - vb.due_date) BETWEEN 1 AND 30')
      && sql.includes('(p_as_of_date - vb.due_date) BETWEEN 31 AND 60')
      && sql.includes('(p_as_of_date - vb.due_date) BETWEEN 61 AND 90')
      && sql.includes('(p_as_of_date - vb.due_date) > 90')
      && !sql.includes('p_as_of_date - vb.bill_date');

    expect(hasDueDateAgingContract(agingMigration)).toBe(true);
    expect(hasDueDateAgingContract(
      agingMigration.replace('vb.due_date >= p_as_of_date', '(p_as_of_date - vb.bill_date) <= 30'),
    )).toBe(false);
    expect(hasDueDateAgingContract(
      agingMigration.replace('BETWEEN 1 AND 30', 'BETWEEN 0 AND 30'),
    )).toBe(false);
    expect(accountsPayable).toContain("header: 'Current (Not Due)'");
    expect(accountsPayable).toContain("key: 'days_1_30'");
    expect(accountsPayable).toContain("header: '1-30 Days Past Due'");
  });

  it('locks the two highest-risk lost-response forms to their first exact payload', () => {
    expect(vendorBillDetail).toContain('paymentIntent.beginIntent({');
    expect(vendorBillDetail).toContain("paymentIntent.classifyFailure(err) === 'definitive'");
    expect(vendorBillDetail).toContain('Retry Exact Payment');
    expect(vendorBillDetail).toContain('disabled={paymentIntent.isIntentLocked}');

    expect(purchaseOrderDetail).toContain('receiveIntent.beginIntent({');
    expect(purchaseOrderDetail).toContain("receiveIntent.classifyFailure(error) === 'definitive'");
    expect(purchaseOrderDetail).toContain('Retry Exact Receiving');
    expect(purchaseOrderDetail).toContain('disabled={receiveIntent.isIntentLocked}');
  });

  it('does not mint a fresh key merely because an uncertain AP/receiving form reopened or changed', () => {
    expect(newVendorBill).not.toMatch(/useEffect\(\(\) => \{\s*resetIdempotencyKey\(\)/);
    expect(inventoryPage).not.toMatch(/setReceivePo\(po\);\s*resetReceiveKey\(\)/);
    expect(receivingHub).not.toMatch(/setReceiveTarget\(po\);\s*resetReceiveKey\(\)/);
    expect(vendorBillDetail).not.toMatch(/setShowPaymentModal\(true\);\s*resetPaymentKey\(\)/);
  });
});
