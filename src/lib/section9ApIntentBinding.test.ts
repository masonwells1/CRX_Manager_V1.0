import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = (...parts: string[]) =>
  readFileSync(join(root, ...parts), 'utf8').replace(/\r\n/g, '\n');

const quoteTrustMigrationName = '20260826220000_quote_version_restore_trust_boundary.sql';
const section9IntentMigrationName = '20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard.sql';
const section9AgingMigrationName = '20260826222000_correct_ap_aging_due_date_buckets.sql';
const migration = source(
  'supabase',
  'migrations',
  section9IntentMigrationName,
);
const agingMigration = source(
  'supabase',
  'migrations',
  section9AgingMigrationName,
);
const accountsPayable = source('src', 'pages', 'AccountsPayable.tsx');
const vendorBillDetail = source('src', 'pages', 'VendorBillDetail.tsx');
const purchaseOrderDetail = source('src', 'pages', 'PurchaseOrderDetail.tsx');
const newVendorBill = source('src', 'pages', 'NewVendorBill.tsx');
const inventoryPage = source('src', 'pages', 'InventoryPage.tsx');
const receivingHub = source('src', 'components', 'receiving', 'ReceivingHubPanel.tsx');
const quickReceive = source('src', 'components', 'receiving', 'QuickReceivePanel.tsx');
const idempotency = source('src', 'lib', 'idempotency.ts');
const uncertainMutationIntent = source('src', 'hooks', 'useUncertainMutationIntent.ts');
const section9Smoke = source('scripts', 'smoke', 'smoke-section9-po-ap-high-remediation.sql');
const periodCloseProof = source('scripts', 'smoke', 'prove-vendor-bill-period-close-concurrency.mjs');
const supplierPhase3Proof = source('scripts', 'smoke', 'prove-supplier-pricing-phase3-return-policy-concurrency.mjs');

function sliceBetween(text: string, startMarker: string, endMarker: string) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

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
    && (sql.match(/FROM PUBLIC, anon, authenticated, service_role;/g) ?? []).length === 7
    && (sql.match(/public\.check_idempotency_intent\(/g) ?? []).length === 7
    && (sql.match(/request_actor_id = v_actor/g) ?? []).length >= 7
    && (sql.match(/request_fingerprint = v_fingerprint/g) ?? []).length >= 7
    && (sql.match(/extensions\.digest\(/g) ?? []).length === 8
    && sql.includes("SET LOCAL lock_timeout = '10s';")
    && sql.indexOf("SET LOCAL lock_timeout = '10s';")
      < sql.indexOf('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;')
    && sql.includes('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;')
    && sql.includes('SECTION9_UNEXPECTED_PUBLIC_OVERLOADS')
    && sql.includes('SECTION9_REVIEWED_BODY_DRIFT')
    && sql.includes('SECTION9_POSTFLIGHT_PUBLIC_OVERLOAD_DRIFT')
    && sql.includes("encode(extensions.digest(convert_to(p.prosrc, 'UTF8'), 'sha256'), 'hex')")
    && sql.includes('CREATE TRIGGER section9_bind_idempotency_receipt_20260826')
    && sql.includes("RAISE EXCEPTION 'SECTION9_UNBOUND_IDEMPOTENCY_RECEIPT'")
    && sql.includes("RAISE EXCEPTION 'ACTOR_MISMATCH'")
    && (sql.match(/PERFORM set_config\('crx\.section9_idempotency_intent'/g) ?? []).length === 6
    && sql.includes('SECTION9_ACTIVE_LEGACY_IDEMPOTENCY_RECEIPTS');
}

describe('Section 9 AP and receiving intent binding', () => {
  it('keeps both unapplied Section 9 candidates after the pending quote-trust migration in release order', () => {
    const orderedMigrations = readdirSync(join(root, 'supabase', 'migrations'))
      .filter((name) => /^\d{14}_.+\.sql$/.test(name))
      .sort();
    const quoteTrustIndex = orderedMigrations.indexOf(quoteTrustMigrationName);

    expect(quoteTrustIndex).toBeGreaterThanOrEqual(0);
    expect(orderedMigrations.slice(quoteTrustIndex, quoteTrustIndex + 3)).toEqual([
      quoteTrustMigrationName,
      section9IntentMigrationName,
      section9AgingMigrationName,
    ]);
  });

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
    expect(hasIntentBindingContract(
      migration.replace('LOCK TABLE public.idempotency_keys IN ACCESS EXCLUSIVE MODE;', ''),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace("SET LOCAL lock_timeout = '10s';", ''),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace("PERFORM set_config('crx.section9_idempotency_intent'", 'PERFORM set_config(\'crx.unbound_intent\''),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace("RAISE EXCEPTION 'ACTOR_MISMATCH'", "RAISE EXCEPTION 'actor mismatch'"),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.split('SECTION9_UNEXPECTED_PUBLIC_OVERLOADS').join('SECTION9_OVERLOAD_CHECK_REMOVED'),
    )).toBe(false);
    expect(hasIntentBindingContract(
      migration.replace('SECTION9_REVIEWED_BODY_DRIFT', 'SECTION9_BODY_CHECK_REMOVED'),
    )).toBe(false);
  });

  it('uses the Chicago calendar month boundary for the dashboard tile', () => {
    expect(migration).toContain("clock_timestamp() AT TIME ZONE 'America/Chicago'");
    expect(migration).toContain('due_date BETWEEN v_today AND v_month_end');
    expect(migration).toContain('vp.payment_date < (v_month_end + 1)');
    expect(migration).not.toContain('due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30');
    expect(section9Smoke).toContain("p_bill_number := 'SMK-S9-DASHBOARD-IN-' || v_suffix");
    expect(section9Smoke).toContain("RAISE EXCEPTION 'SMOKE_FAIL: month-end bill missing from Due This Month'");
  });

  it('ages AP by due date across all five approved boundary buckets', () => {
    const hasDueDateAgingContract = (sql: string) => {
      const functionSql = sql.split('DO $verify$')[0];
      return functionSql.includes('days_1_30 bigint')
        && functionSql.includes('vb.due_date >= p_as_of_date')
        && functionSql.includes('(p_as_of_date - vb.due_date) BETWEEN 1 AND 30')
        && functionSql.includes('(p_as_of_date - vb.due_date) BETWEEN 31 AND 60')
        && functionSql.includes('(p_as_of_date - vb.due_date) BETWEEN 61 AND 90')
        && functionSql.includes('(p_as_of_date - vb.due_date) > 90')
        && functionSql.includes("v_today date := (clock_timestamp() AT TIME ZONE 'America/Chicago')::date")
        && functionSql.includes('p_as_of_date IS DISTINCT FROM v_today')
        && functionSql.includes('AP_AGING_UNEXPECTED_PUBLIC_OVERLOADS')
        && sql.includes('AP_AGING_POSTFLIGHT_PUBLIC_OVERLOAD_DRIFT')
        && functionSql.includes('AP_AGING_REVIEWED_CONTRACT_DRIFT')
        && !functionSql.includes('p_as_of_date - vb.bill_date');
    };

    expect(hasDueDateAgingContract(agingMigration)).toBe(true);
    expect(hasDueDateAgingContract(
      agingMigration.replace('vb.due_date >= p_as_of_date', '(p_as_of_date - vb.bill_date) <= 30'),
    )).toBe(false);
    expect(hasDueDateAgingContract(
      agingMigration.replace('BETWEEN 1 AND 30', 'BETWEEN 0 AND 30'),
    )).toBe(false);
    expect(hasDueDateAgingContract(
      agingMigration.split('AP_AGING_UNEXPECTED_PUBLIC_OVERLOADS').join('AP_AGING_OVERLOAD_CHECK_REMOVED'),
    )).toBe(false);
    expect(accountsPayable).toContain("header: 'Current (Not Due)'");
    expect(accountsPayable).toContain("key: 'days_1_30'");
    expect(accountsPayable).toContain("header: '1-30 Days Past Due'");
    expect(accountsPayable).toContain("header: '31-60 Days Past Due'");
    expect(accountsPayable).toContain("header: '61-90 Days Past Due'");
    expect(accountsPayable).toContain("header: '90+ Days Past Due'");
    expect(supplierPhase3Proof).toContain('current_amount bigint, days_1_30 bigint, days_31_60 bigint');
    expect(supplierPhase3Proof).toContain('CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations');
    expect(supplierPhase3Proof).toContain('\\i /tmp/migrationHistory.sql');
  });

  it('locks the two highest-risk lost-response forms to their first exact payload', () => {
    expect(vendorBillDetail).toContain('paymentIntent.beginIntent({');
    expect(vendorBillDetail).toContain("getIdempotencyMismatchResult(err, 'record_vendor_payment')");
    expect(vendorBillDetail).toContain("typeof receipt?.payment_id === 'string'");
    expect(vendorBillDetail).toContain('const disposition = await paymentIntent.classifyFailure(err)');
    expect(vendorBillDetail).toContain("disposition === 'definitive'");
    expect(vendorBillDetail).toContain('Retry Exact Payment');
    expect(vendorBillDetail).toContain('disabled={paymentIntent.isIntentLocked}');

    expect(purchaseOrderDetail).toContain('receiveIntent.beginIntent({');
    expect(purchaseOrderDetail).toContain("getIdempotencyMismatchResult(error, 'receive_po_items')");
    expect(purchaseOrderDetail).toContain('Array.isArray(committedRecordIds)');
    expect(purchaseOrderDetail).toContain('const disposition = await receiveIntent.classifyFailure(error)');
    expect(purchaseOrderDetail).toContain("disposition === 'definitive'");
    expect(purchaseOrderDetail).toContain('Retry Exact Receiving');
    expect(purchaseOrderDetail).toContain('disabled={receiveIntent.isIntentLocked}');
    expect(idempotency).toContain("candidate.message === 'IDEMPOTENCY_INTENT_MISMATCH'");

    expect(newVendorBill).toContain("getIdempotencyMismatchResult(error, 'create_vendor_bill')");
    expect(newVendorBill).toContain('disabled={createBillIntent.isIntentLocked}');
    expect(newVendorBill).toContain('Retry Exact Bill');

    expect(inventoryPage).toContain("getIdempotencyMismatchResult(error, 'receive_po_items')");
    expect(inventoryPage).toContain('disabled={receivePoIntent.isIntentLocked}');
    expect(inventoryPage).toContain('Retry Exact Receiving');
    expect(inventoryPage).toContain('if (receivePoIntent.isIntentLocked) {');

    expect(receivingHub).toContain("getIdempotencyMismatchResult(error, 'receive_po_items')");
    expect(receivingHub).toContain('disabled={receiveIntent.isIntentLocked}');
    expect(receivingHub).toContain('Retry Exact Receiving');
    expect(newVendorBill).toContain('The last response was uncertain. These fields are locked so a second bill cannot be created.');
    expect(receivingHub).toContain('This receiving request is locked so stock cannot be received twice.');

    expect(quickReceive).toContain("getIdempotencyMismatchResult(error, 'receive_po_items')");
    expect(quickReceive).toContain('Retry Exact Receiving');
    expect(quickReceive).toContain('disabled={receiveIntent.isIntentLocked}');
    expect(quickReceive).toContain('The last response was uncertain. This exact receiving request is locked so inventory cannot be received twice.');
    for (const caller of [
      newVendorBill,
      vendorBillDetail,
      inventoryPage,
      purchaseOrderDetail,
      receivingHub,
      quickReceive,
    ]) {
      expect(caller).toContain('UNCERTAIN_MUTATION_RECONCILIATION_MESSAGE');
      expect(caller).toContain('.isRetryExpired');
      expect(caller).toContain("disposition === 'resolved'");
    }

    expect(purchaseOrderDetail).toContain("operation: 'receive_po_items'");
    expect(purchaseOrderDetail).toContain("surface: 'purchase-order-detail'");
    expect(purchaseOrderDetail).toContain("scope: id || ''");
    expect(purchaseOrderDetail).toContain('receiveIntent.getIdempotencyKey()');
    const purchaseOrderReceive = sliceBetween(
      purchaseOrderDetail,
      'const handleReceive = async () => {',
      'const handleDownloadHistoryPdf = async',
    );
    expect(purchaseOrderReceive.indexOf('const lockedRequest = receiveIntent.unresolvedIntent;'))
      .toBeLessThan(purchaseOrderReceive.indexOf('const itemsPayload = items'));
    expect(purchaseOrderReceive).toContain('request = await receiveIntent.beginIntent(lockedRequest);');
    expect(vendorBillDetail).toContain('voidPaymentIdem.getKeyFor(voidPaymentScope)');
    expect(vendorBillDetail).toContain('voidPaymentIdem.resetKeyFor(voidPaymentScope)');
    expect(vendorBillDetail).toContain('voidIdem.getKeyFor(voidBillScope)');
    expect(vendorBillDetail).toContain('voidIdem.resetKeyFor(voidBillScope)');
  });

  it('persists each critical payload and matching key across reopen, unmount, and reload', () => {
    expect(uncertainMutationIntent).toContain("const DURABLE_INTENT_PREFIX = 'crx:uncertain-mutation:v4:'");
    expect(uncertainMutationIntent).toContain('const SAFE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;');
    expect(uncertainMutationIntent).toContain("throw new Error(UNCERTAIN_MUTATION_RETRY_EXPIRED)");
    expect(uncertainMutationIntent).toContain('retryNotAfterMs: number;');
    expect(uncertainMutationIntent).toContain('candidate.version !== 1 && candidate.version !== 2');
    expect(uncertainMutationIntent).toContain('window.localStorage.setItem(storageKey, JSON.stringify(record))');
    expect(uncertainMutationIntent).toContain('intentIdentity: fingerprintIntent(intent, getIntentIdentityRef.current)');
    expect(uncertainMutationIntent).toContain("throw new Error('DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE')");
    expect(uncertainMutationIntent).toContain("JSON.stringify([options.operation, options.userId])");
    expect(uncertainMutationIntent).toContain("window.addEventListener('storage', handleStorage)");
    expect(uncertainMutationIntent).toContain("db.transaction(DURABLE_INTENT_STORE, 'readwrite')");
    expect(uncertainMutationIntent).toContain('requestVersion: crypto.randomUUID()');
    expect(uncertainMutationIntent).toContain('resolveCoordinatedRecord(');
    expect(uncertainMutationIntent).toContain('existing.intentIdentity === candidateIdentity');
    expect(uncertainMutationIntent).toContain('throw new Error(UNCERTAIN_MUTATION_INTENT_CONFLICT)');

    expect(newVendorBill).toContain("operation: 'create_vendor_bill'");
    expect(newVendorBill).toContain("surface: 'new-vendor-bill'");
    expect(newVendorBill).toContain('getIntentIdentity: (intent) => intent.args');
    expect(newVendorBill).toContain('createBillIntent.isForeignIntentLocked');
    expect(newVendorBill).toContain('createBillIntent.beginIntent({');
    expect(newVendorBill).toContain('createBillIntent.getIdempotencyKey()');
    expect(newVendorBill).toContain('const recovered = createBillIntent.unresolvedIntent?.args');
    expect(newVendorBill).not.toContain("useIdempotencyKey('create_vendor_bill'");

    expect(inventoryPage).toContain("operation: 'receive_po_items'");
    expect(inventoryPage).toContain("surface: 'inventory-page'");
    expect(inventoryPage).toContain('p_items: intent.items');
    expect(inventoryPage).toContain('receivePoIntent.isForeignIntentLocked');
    expect(inventoryPage).toContain('receivePoIntent.beginIntent({');
    expect(inventoryPage).toContain('receivePoIntent.getIdempotencyKey()');
    expect(inventoryPage).toContain('const recovered = receivePoIntent.unresolvedIntent');
    const inventoryOpen = sliceBetween(inventoryPage, 'const openReceiveModal', 'const handleReceive');
    expect(inventoryOpen).toContain('if (receivePoIntent.isIntentLocked) {');
    expect(inventoryPage).not.toContain("useIdempotencyKey('receive_po_items'");

    expect(receivingHub).toContain("operation: 'receive_po_items'");
    expect(receivingHub).toContain("surface: 'receiving-hub'");
    expect(receivingHub).toContain('p_items: intent.items');
    expect(receivingHub).toContain('receiveIntent.isForeignIntentLocked');
    expect(receivingHub).toContain('receiveIntent.beginIntent({');
    expect(receivingHub).toContain('receiveIntent.getIdempotencyKey()');
    expect(receivingHub).toContain('const recovered = receiveIntent.unresolvedIntent');
    expect(receivingHub).not.toContain("useIdempotencyKey('receive_po_items'");

    expect(quickReceive).toContain("operation: 'receive_po_items'");
    expect(quickReceive).toContain("surface: 'quick-receive'");
    expect(quickReceive).toContain('p_items: intent.itemsPayload');
    expect(quickReceive).toContain('receiveIntent.isForeignIntentLocked');
    expect(quickReceive).toContain('receiveIntent.beginIntent({');
    expect(quickReceive).toContain('receiveIntent.getIdempotencyKey()');
    expect(quickReceive).toContain('const recovered = receiveIntent.unresolvedIntent');
    expect(quickReceive).toContain('let request = receiveIntent.unresolvedIntent;');
    expect(quickReceive).not.toContain("useIdempotencyKey('quick_receive'");

    expect(vendorBillDetail).toContain("operation: 'record_vendor_payment'");
    expect(vendorBillDetail).toContain("surface: 'vendor-bill-detail'");
    expect(vendorBillDetail).toContain("scope: id || ''");
    expect(vendorBillDetail).toContain('getIntentIdentity: (intent) => intent.args');
    expect(vendorBillDetail).toContain('paymentIntent.isForeignIntentLocked');
    expect(vendorBillDetail).toContain('paymentIntent.getIdempotencyKey()');
    expect(vendorBillDetail).toContain('const recovered = paymentIntent.unresolvedIntent');
    expect(vendorBillDetail).not.toContain("useIdempotencyKey('record_vendor_payment'");

    const vendorRouteReset = sliceBetween(
      vendorBillDetail,
      '// Route changes must retire every visible bill-specific form',
      'const today = localToday();',
    );
    expect(vendorRouteReset).toContain('setPayModalOpen(false)');
    expect(vendorRouteReset).toContain('setPayModalBillId(null)');
    expect(vendorRouteReset).toContain('setVoidModalOpen(false)');
    expect(vendorRouteReset).toContain('setVoidPaymentTarget(null)');
    expect(vendorRouteReset).toContain('setEditModalOpen(false)');
    expect(vendorRouteReset).not.toContain('paymentIntent.resolveIntent()');
    expect(vendorBillDetail).toContain('recovered.args.p_vendor_bill_id !== id');
    expect(vendorBillDetail).toContain('setPayModalBillId(recovered.args.p_vendor_bill_id)');
    expect(vendorBillDetail).toContain('if (!id || payModalBillId !== id) {');
    expect(vendorBillDetail).toContain('if (activeBillIdRef.current !== requestedBillId) return;');

    expect(purchaseOrderDetail).toContain('const recovered = receiveIntent.unresolvedIntent');
    expect(purchaseOrderDetail).toContain('p_items: intent.finalPayload');
    expect(purchaseOrderDetail).toContain('receiveIntent.isForeignIntentLocked');
    expect(purchaseOrderDetail).not.toContain("useIdempotencyKey('receive_po_items'");
  });

  it('fails closed when AP and receiving reconciliation evidence is incomplete', () => {
    expect(quickReceive).toContain('committedRecordIds.length > 0');
    expect(purchaseOrderDetail).toContain('committedRecordIds.length > 0');
    expect(inventoryPage).toContain('recordIds.length > 0');
    expect(receivingHub).toContain('recordIds.length > 0');

    expect(uncertainMutationIntent).toContain('Failure classification runs inside mutation catch paths.');
    expect(uncertainMutationIntent).toContain('function currentPageClaimId(): string');
    expect(uncertainMutationIntent).toContain("return `${currentTabId()}:${crypto.randomUUID()}`;");
    expect(uncertainMutationIntent).toContain("if (candidate.status === 'resolved') {");
    expect(vendorBillDetail).toContain('Payment could not be safely prepared. Nothing was recorded');
    expect(purchaseOrderDetail).toContain('Receiving could not be safely prepared. Nothing was received');
    expect(receivingHub).toContain('Receiving could not be safely prepared. Nothing was received');

    expect(newVendorBill).toContain('setPaymentTermsDays(Math.round((due - bill) / 86_400_000));');
    expect(newVendorBill).not.toContain('setPaymentTermsDays(Math.max(0');
    expect(vendorBillDetail).toContain('setEditSubtotal(centsToDollarInput(bill.subtotal_cents));');
    expect(vendorBillDetail).toContain('setEditAdjustment(centsToDollarInput(bill.adjustment_cents || 0));');
    expect(vendorBillDetail).toContain('useLayoutEffect(() => {');
    expect(vendorBillDetail).not.toContain('activeBillIdRef.current = id;\n  const paymentIntent');
  });

  it('keeps the disposable cutover proof deterministic after assertion failures', () => {
    expect(periodCloseProof).toContain('const SECTION9_LEGACY_RECEIPT_PREDICATE = `');
    expect(periodCloseProof.match(/SECTION9_LEGACY_RECEIPT_PREDICATE/g)).toHaveLength(4);
    const intentDecoy = sliceBetween(
      periodCloseProof,
      "expectValidationFailure(local, 'section9-intent-decoy-overload'",
      "console.log('CANDIDATE_SECTION9_INTENT_DECOY_OVERLOAD_REJECTED_PASS')",
    );
    const agingDecoy = sliceBetween(
      periodCloseProof,
      "expectValidationFailure(local, 'section9-aging-decoy-overload'",
      "console.log('CANDIDATE_SECTION9_AGING_DECOY_OVERLOAD_REJECTED_PASS')",
    );
    expect(intentDecoy).toContain('finally {');
    expect(intentDecoy).toContain('DROP FUNCTION IF EXISTS public.create_vendor_bill(text)');
    expect(agingDecoy).toContain('finally {');
    expect(agingDecoy).toContain('DROP FUNCTION IF EXISTS public.get_ap_aging(text)');
    expect(periodCloseProof).toContain('CANDIDATE_SECTION9_BOUNDED_CUTOVER_LOCK_TIMEOUT_PASS');
    expect(periodCloseProof).toContain("'canceling statement due to lock timeout'");
  });
});
