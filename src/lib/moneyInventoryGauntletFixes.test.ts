import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8').replace(/\r\n/g, '\n');
}

function sourceFiles(path: string): string[] {
  const absolute = join(ROOT, path);
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const relative = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.(?:ts|tsx)$/.test(entry.name) && !/\.test\.(?:ts|tsx)$/.test(entry.name)
      ? [relative]
      : [];
  });
}

const access = source('supabase/migrations/20260716120104_gauntlet_access_boundaries.sql');
const money = source('supabase/migrations/20260716120112_gauntlet_money_workflows.sql');
const inventory = source('supabase/migrations/20260716120120_gauntlet_inventory_accuracy.sql');
const poInitialStatus = source('supabase/migrations/20260716144353_lock_purchase_order_initial_status.sql');
const deliveryPeriodGuard = source('supabase/migrations/20260716152906_guard_delivery_closed_periods.sql');
const committedReplayGuard = source(
  'supabase/migrations/20260716160000_fix_idempotency_committed_replay_guard.sql',
);
const deliveryPeriodRewriteGuard = source(
  'supabase/migrations/20260716172956_guard_delivery_period_rewrites.sql',
);
const deliveryScheduledDateRewriteGuard = source(
  'supabase/migrations/20260716183442_guard_delivery_scheduled_date_rewrites.sql',
);
const purchaseOrderCents = source('supabase/migrations/20260716183501_purchase_order_integer_cents.sql');
const purchaseOrderOmittedCost = source(
  'supabase/migrations/20260716213000_preserve_purchase_order_omitted_cost.sql',
);
const financialScope = source('supabase/migrations/20260716190000_harden_sales_financial_scope.sql');
const invoiceExistingCustomerScope = source(
  'supabase/migrations/20260716210000_harden_invoice_existing_customer_scope.sql',
);
const deliveryAggregate = source(
  'supabase/migrations/20260716191000_aggregate_delivery_stock_preflight.sql',
);
const deliveryPeriodPreflight = source(
  'supabase/migrations/20260716202000_preflight_delivery_accounting_period.sql',
);
const adversarialCloseout = source(
  'supabase/migrations/20260716224000_close_adversarial_money_inventory_gaps.sql',
);
const globalBulkPOIntent = source(
  'supabase/migrations/20260716233000_globalize_bulk_po_import_intents.sql',
);
const finalPurchaseOrderRelease = source(
  'supabase/migrations/20260717010000_close_final_purchase_order_release_gaps.sql',
);
const deletedBulkPORetryState = source(
  'supabase/migrations/20260717015439_invalidate_deleted_bulk_po_retry_state.sql',
);
const exactBulkPOReplay = source(
  'supabase/migrations/20260717032000_replay_bulk_po_same_request_result.sql',
);
const bulkPOVendorBinding = source(
  'supabase/migrations/20260717045420_bind_bulk_po_claim_to_vendor.sql',
);
const bulkPOReplayContent = source(
  'supabase/migrations/20260717063445_bind_bulk_po_replay_content.sql',
);
const bulkPOAsciiIdentity = source(
  'supabase/migrations/20260717070900_bind_bulk_po_identity_ascii_fold.sql',
);
const blankBulkPOIdentity = source(
  'supabase/migrations/20260717081856_reject_blank_bulk_po_identity.sql',
);
const canonicalBulkPOIdentity = source(
  'supabase/migrations/20260717085512_canonicalize_bulk_po_identity_whitespace.sql',
);
const secureBulkPOFingerprintTrigger = source(
  'supabase/migrations/20260717092749_secure_bulk_po_fingerprint_trigger.sql',
);
const unicodeBulkPOIdentity = source(
  'supabase/migrations/20260717101619_canonicalize_bulk_po_unicode_identity.sql',
);
const serverAuthoritativeBulkPOIdentity = source(
  'supabase/migrations/20260717110016_make_bulk_po_identity_server_authoritative.sql',
);
const serverDerivedBulkPOClaimPayload = source(
  'supabase/migrations/20260717112906_restore_server_derived_bulk_po_claim_payload.sql',
);
const quoteBuilder = source('src/pages/QuoteBuilder.tsx');
const completeDelivery = access.slice(0, access.indexOf('CREATE OR REPLACE FUNCTION public.void_delivery'));

describe('money and inventory gauntlet fixes', () => {
  it('bounds quote-reopen reasons before generating the reason-bearing retry key', () => {
    expect(quoteBuilder).toContain('const MAX_REVERT_REASON_LENGTH = 500;');
    expect(quoteBuilder).toContain('maxLength={MAX_REVERT_REASON_LENGTH}');
    expect(quoteBuilder).toContain('if (normalizedReason.length > MAX_REVERT_REASON_LENGTH)');
    expect(quoteBuilder.indexOf('if (normalizedReason.length > MAX_REVERT_REASON_LENGTH)')).toBeLessThan(
      quoteBuilder.indexOf('const idemKey = revertStatusIdem.getKey();'),
    );
    expect(quoteBuilder).toContain('p_reason: normalizedReason');
  });

  it('deduplicates QuoteBuilder conversion side effects by stable order ID', () => {
    expect(quoteBuilder).toContain(
      'const firedConvertSideEffects = useRef<Set<string>>(new Set());',
    );
    expect(quoteBuilder).toContain(
      '&& !firedConvertSideEffects.current.has(result.order_id);',
    );
    expect(quoteBuilder).toContain(
      'firedConvertSideEffects.current.add(result.order_id);',
    );
    expect(quoteBuilder).toContain('if (shouldFireConversionSideEffects) {');
    expect(quoteBuilder.indexOf('firedConvertSideEffects.current.add(result.order_id);')).toBeLessThan(
      quoteBuilder.indexOf("trackBusinessEvent('quote_converted_to_order'"),
    );
  });

  it('requires an active delivery actor and uses the effective completion business date', () => {
    expect(access).toContain('WHERE id = v_actor AND is_active = true');
    expect(access).toContain('IF v_actor_role IS NULL OR NOT (');
    expect(access).toContain("v_effective_completion_date := COALESCE(");
    expect(completeDelivery).not.toContain('v_delivery.scheduled_date BETWEEN period_start AND period_end');
    expect(access).toContain("IF NOT is_admin() THEN\n    RAISE EXCEPTION 'Admin access required to void a completed delivery'");
    const voidDelivery = access.slice(
      access.indexOf('CREATE OR REPLACE FUNCTION public.void_delivery'),
      access.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order'),
    );
    expect(voidDelivery).toContain("(v_delivery.completed_at AT TIME ZONE 'America/Chicago')::date");
    expect(voidDelivery).toContain('v_effective_completion_date BETWEEN period_start AND period_end');
    expect(voidDelivery).not.toContain('v_delivery.scheduled_date BETWEEN period_start AND period_end');
  });

  it('hard-blocks completed and voided delivery transitions in closed accounting periods', () => {
    expect(deliveryPeriodGuard).toContain('CREATE OR REPLACE FUNCTION public.enforce_delivery_accounting_period()');
    expect(deliveryPeriodGuard).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
    expect(deliveryPeriodGuard).toContain("NEW.status = 'completed'");
    expect(deliveryPeriodGuard).toContain("NEW.status = 'voided'");
    expect(deliveryPeriodGuard.match(/PERFORM public\.check_period_open\(v_effective_date\)/g)?.length).toBe(4);
    expect(deliveryPeriodGuard).toContain(
      'BEFORE INSERT OR UPDATE OF status, completed_at ON public.deliveries',
    );
    expect(deliveryPeriodGuard).not.toContain('app.admin_override');
    expect(deliveryPeriodGuard).toContain(
      'REVOKE EXECUTE ON FUNCTION public.enforce_delivery_accounting_period()\n  FROM anon, authenticated',
    );
  });

  it('checks both sides of terminal delivery date rewrites', () => {
    expect(deliveryPeriodRewriteGuard).toContain("OLD.status IN ('completed', 'voided')");
    expect(deliveryPeriodRewriteGuard).toContain('OLD.status IS DISTINCT FROM NEW.status');
    expect(deliveryPeriodRewriteGuard).toContain(
      'OLD.completed_at IS DISTINCT FROM NEW.completed_at',
    );
    expect(deliveryPeriodRewriteGuard).toContain('v_old_effective_date');
    expect(deliveryPeriodRewriteGuard).toContain('v_new_effective_date');
    expect(deliveryPeriodRewriteGuard).toContain(
      'PERFORM public.check_period_open(v_old_effective_date)',
    );
    expect(deliveryPeriodRewriteGuard).toContain(
      'PERFORM public.check_period_open(v_new_effective_date)',
    );
    expect(deliveryPeriodRewriteGuard).toContain('SECURITY DEFINER\nSET search_path = public, pg_temp');
    expect(deliveryPeriodRewriteGuard).not.toContain('app.admin_override');
    expect(deliveryPeriodRewriteGuard).toContain(
      'REVOKE EXECUTE ON FUNCTION public.enforce_delivery_accounting_period()\n  FROM anon, authenticated',
    );
  });

  it('watches scheduled-date-only rewrites of terminal delivery history', () => {
    const triggerFunctionBody = deliveryScheduledDateRewriteGuard.slice(
      0,
      deliveryScheduledDateRewriteGuard.indexOf('$function$;'),
    );

    expect(deliveryScheduledDateRewriteGuard).toContain(
      'BEFORE INSERT OR UPDATE OF status, completed_at, scheduled_date ON public.deliveries',
    );
    expect(
      triggerFunctionBody.match(
        /OLD\.scheduled_date IS DISTINCT FROM NEW\.scheduled_date/g,
      )?.length,
    ).toBe(3);
    expect(deliveryScheduledDateRewriteGuard).toContain(
      "v_trigger_definition NOT LIKE '%UPDATE OF status, completed_at, scheduled_date%'",
    );
    expect(deliveryScheduledDateRewriteGuard).toContain(
      'PERFORM public.check_period_open(v_old_effective_date)',
    );
    expect(deliveryScheduledDateRewriteGuard).toContain(
      'PERFORM public.check_period_open(v_new_effective_date)',
    );
    expect(deliveryScheduledDateRewriteGuard).toContain(
      'REVOKE EXECUTE ON FUNCTION public.enforce_delivery_accounting_period()\n  FROM anon, authenticated',
    );
  });

  it('makes money and inventory tables RPC-only for authenticated clients', () => {
    expect(access).toContain('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE');
    for (const table of [
      'purchase_orders',
      'purchase_order_items',
      'receiving_records',
      'vendor_bills',
      'vendor_payments',
      'prepay_credits',
      'prepay_applications',
    ]) {
      expect(access).toContain(`public.${table}`);
    }
    expect(access).toContain("has_table_privilege('authenticated', v_table, 'INSERT')");
  });

  it('locks received PO evidence and submits without resaving a stale PO snapshot', () => {
    const savePoFunction = access.slice(
      access.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      access.indexOf('CREATE OR REPLACE FUNCTION public.submit_purchase_order('),
    );
    const submitPoFunction = access.slice(
      access.indexOf('CREATE OR REPLACE FUNCTION public.submit_purchase_order('),
      access.indexOf('CREATE OR REPLACE FUNCTION public.cancel_purchase_order('),
    );
    const cancelPoFunction = access.slice(
      access.indexOf('CREATE OR REPLACE FUNCTION public.cancel_purchase_order('),
      access.indexOf('-- RLS still controls reads.'),
    );
    expect(access).toContain('RECEIVED_PO_LINE_IMMUTABLE');
    expect(access).toContain('existing.quantity_received > 0');
    expect(access).toContain("v_existing_status = 'draft' AND v_new_status = 'submitted'");
    expect(access).toContain('CREATE OR REPLACE FUNCTION public.submit_purchase_order(');
    expect(access).toContain("check_idempotency(p_idempotency_key, 'submit_purchase_order')");
    expect(access).toContain("SET status = 'submitted',");
    expect(savePoFunction).toContain('v_is_new boolean := (p_po_id IS NULL)');
    expect(savePoFunction).toContain("WHEN v_is_new THEN 'po_created'");
    expect(submitPoFunction).toContain("'po_submitted'");
    expect(savePoFunction).toContain("IF NOT (is_admin() OR is_sales_rep()) THEN");
    expect(savePoFunction).toContain("Only admins or sales reps can manage purchase orders");
    expect(submitPoFunction).toContain("IF NOT (is_admin() OR is_sales_rep()) THEN RAISE EXCEPTION 'INSUFFICIENT_ROLE'");
    expect(cancelPoFunction).toContain('IF NOT (is_admin() OR is_sales_rep()) THEN');
    expect(cancelPoFunction).toContain('only admins or sales reps can cancel purchase orders');
    expect(cancelPoFunction.indexOf('IF NOT (is_admin() OR is_sales_rep()) THEN')).toBeLessThan(
      cancelPoFunction.indexOf("check_idempotency(p_idempotency_key, 'cancel_purchase_order')"),
    );

    const bulkImport = source('src/components/purchase-orders/BulkPOImport.tsx');
    const detail = source('src/pages/PurchaseOrderDetail.tsx');
    const idempotency = source('src/lib/idempotency.ts');
    const idempotencyHook = source('src/hooks/useIdempotencyKey.ts');
    const submitHandler = detail.slice(detail.indexOf('const handleSubmitPO'), detail.indexOf('const handleCancel'));
    expect(bulkImport).toContain("supabase.rpc('save_purchase_order'");
    expect(bulkImport).toContain('buildParsedPOIntentKey(po)');
    expect(bulkImport).not.toContain('source_index: po.source_index');
    expect(bulkImport).toContain('ensurePendingBulkPOIntent(');
    expect(bulkImport).toContain('po_number: null');
    expect(bulkImport).not.toContain("supabase.rpc('next_po_number'");
    expect(bulkImport).toContain('p_idempotency_key: pendingIntent.idempotencyKey');
    expect(bulkImport).toContain("const alreadyImported = importedIntent?.status === 'imported'");
    expect(bulkImport).toContain("savedPO.status === 'already_imported'");
    expect(bulkImport).not.toContain(
      'if (isImportedBulkPOIntent(pendingIntentsRef.current, intentKey))',
    );
    expect(bulkImport).toContain("bulk_import_intent_key: 'server-derived'");
    expect(bulkImport).not.toContain('buildBulkPODocumentClaimKey');
    expect(bulkImport).toContain(
      'bulk_import_vendor_reference: trimBulkPOIdentityBoundary(po.invoice_number)',
    );
    expect(bulkImport).toContain('vendor: trimBulkPOIdentityBoundary(po.vendor_name)');
    expect(bulkImport).toContain('bulk_import_invoice_date: normalizeBulkPOInvoiceDate(po.invoice_date)');
    expect(bulkImport).toContain('getPendingBulkPOIntent(pendingIntentsRef.current, intentKey)');
    expect(bulkImport).toContain('savedPO.po_number');
    expect(bulkImport).toContain('refreshNeededRef.current = true');
    expect(bulkImport).toContain('refreshNeededRef.current = false;\n        onSuccess()');
    expect(bulkImport).toContain('if (refreshNeededRef.current)');
    expect(bulkImport).toContain('imported: newSuccessCount, skipped: skippedCount');
    expect(bulkImport).not.toContain('successCount++');
    expect(bulkImport).toContain('savePendingBulkPOIntents(localStorage, profile.id');
    expect(bulkImport).toContain('setUploadResults(failedCount === 0');
    expect(idempotency).toContain('const uuid = crypto.randomUUID()');
    // The hook used to hold ONE key in one slot and compare its scope. That
    // reissued correctly when the scope changed but could not replay a key on
    // the way BACK to a row already acted on, so the retry the key exists to
    // make safe became a brand-new request. Keys are now keyed by scope in a
    // Map; the property this line has always guarded — a different scope never
    // reuses another scope's key — is what the Map lookup asserts.
    expect(idempotencyHook).toContain('let key = keysRef.current.get(scope)');
    expect(idempotencyHook).toContain('keysRef.current.set(scope, key)');
    expect(bulkImport).not.toMatch(/\.from\(['"]purchase_orders['"]\)[\s\S]{0,250}\.(?:insert|update|delete|upsert)\(/);
    expect(detail).not.toMatch(/\.from\(['"]purchase_orders['"]\)[\s\S]{0,250}\.(?:insert|update|delete|upsert)\(/);
    expect(detail).toContain('Received line locked');
    expect(detail).toContain(
      "useIdempotencyKey('submit_purchase_order', `${profile?.id || ''}:${id || ''}`)",
    );
    expect(detail).toContain(
      'resetSubmitPOKey();\n    resolveReceiveIntent();\n  }, [id, resetSubmitPOKey, resolveReceiveIntent]);',
    );
    expect(submitHandler).toContain("supabase.rpc('submit_purchase_order'");
    expect(submitHandler).toContain('const submitKey = getSubmitPOKey()');
    expect(submitHandler).toContain('resetSubmitPOKey()');
    expect(submitHandler).not.toContain('p_po_payload');
    expect(submitHandler).not.toContain('p_items');
    expect(submitHandler).not.toContain("supabase.rpc('save_purchase_order'");
    expect(detail).toContain("{canManagePO && po.status === 'draft' && (");
    expect(detail).toContain("{canManagePO && (po.status === 'draft' || po.status === 'submitted') && (");
    const purchaseOrders = source('src/pages/PurchaseOrders.tsx');
    expect(purchaseOrders).toContain("const canManagePO = role === 'admin' || role === 'sales_rep'");
    expect(purchaseOrders).toContain("{canManagePO && activeTab === 'all' && (");
    expect(detail).not.toMatch(/handleSubmitPO[\s\S]*?savePOIdem\.resetKey\(\)[\s\S]*?setSaving\(true\)/);
  });

  it('requires every new purchase order to start as a draft', () => {
    const statusGuard = "IF v_is_new AND COALESCE(p_po_payload->>'status', 'draft') <> 'draft' THEN";
    expect(poInitialStatus).toContain(statusGuard);
    expect(poInitialStatus).toContain('INVALID_INITIAL_PO_STATUS');
    expect(poInitialStatus.indexOf(statusGuard)).toBeLessThan(
      poInitialStatus.indexOf("check_idempotency(p_idempotency_key, 'save_purchase_order')"),
    );
    expect(poInitialStatus).not.toContain("IF v_new_status <> 'draft' THEN");
    expect(poInitialStatus).toContain("v_new_status := 'draft';");
    expect(poInitialStatus).toContain("v_new_status IS NOT NULL AND v_new_status <> v_existing_status");
    expect(poInitialStatus).toContain('PO_STATUS_RPC_REQUIRED');
    expect(poInitialStatus).not.toContain("v_new_status IN ('partially_received', 'fully_received', 'cancelled')");

    const newPurchaseOrder = source('src/pages/NewPurchaseOrder.tsx');
    const saveHandler = newPurchaseOrder.slice(
      newPurchaseOrder.indexOf("const handleSave = async"),
      newPurchaseOrder.indexOf('const filteredProducts'),
    );
    expect(saveHandler).toContain("status: 'draft'");
    expect(saveHandler).not.toContain('status: submitStatus');
    expect(saveHandler).toContain("supabase.rpc('submit_purchase_order'");
    expect(saveHandler).toContain('p_po_id: poId');
    expect(saveHandler).toContain("const shouldSaveDraft = submitStatus === 'draft' || !poId || isDirty");
    expect(saveHandler).toContain('po_number: poNumber');
    expect(saveHandler).toContain('poNumber = result.po_number');
    expect(saveHandler).not.toContain("supabase.rpc('next_po_number'");
    expect(newPurchaseOrder).toContain("useIdempotencyKey('submit_purchase_order', profile?.id || '')");
    expect(saveHandler).toContain("assertRpcResult<{ po_id: string; status: string }>(submitData, 'submit_purchase_order')");
    expect(saveHandler.indexOf("supabase.rpc('save_purchase_order'")).toBeLessThan(
      saveHandler.indexOf("supabase.rpc('submit_purchase_order'"),
    );
  });

  it('calculates purchase-order costs in integer cents', () => {
    const centsSaveFunction = purchaseOrderCents.slice(
      purchaseOrderCents.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      purchaseOrderCents.indexOf('REVOKE EXECUTE ON FUNCTION public.save_purchase_order('),
    );
    expect(purchaseOrderCents).toContain('unit_cost_cents bigint');
    expect(purchaseOrderCents).toContain('total_cost_cents bigint');
    expect(centsSaveFunction).toContain('v_total_cost_cents bigint := 0');
    expect(centsSaveFunction).toContain('round(\n      COALESCE((v_item->>\'quantity_ordered\')::numeric, 0)');
    expect(purchaseOrderCents).toContain('PO_UNIT_COST_FRACTIONAL_CENT');
    expect(centsSaveFunction).not.toContain('v_total_cost numeric');

    for (const path of [
      'src/pages/NewPurchaseOrder.tsx',
      'src/components/purchase-orders/BulkPOImport.tsx',
    ]) {
      const writer = source(path);
      expect(writer).toContain('const unitCostCents = purchaseOrderUnitCostCents(');
      expect(writer).toContain('unit_cost: purchaseOrderCentsToDollars(unitCostCents)');
      expect(writer).toContain('unit_cost_cents: unitCostCents');
    }

    const purchaseOrderDetail = source('src/pages/PurchaseOrderDetail.tsx');
    const purchaseOrderEditPayload = source('src/lib/purchaseOrderEditPayload.ts');
    expect(purchaseOrderDetail).toContain(
      'const itemsPayload = buildPurchaseOrderEditItemsPayload(editItems)',
    );
    expect(purchaseOrderEditPayload).toContain(
      'const unitCostCents = purchaseOrderUnitCostCents(',
    );
    expect(purchaseOrderEditPayload).toContain(
      'unit_cost: purchaseOrderCentsToDollars(unitCostCents)',
    );
    expect(purchaseOrderEditPayload).toContain('unit_cost_cents: unitCostCents');
  });

  it('preserves an existing PO line cost when an edit omits cost fields', () => {
    expect(purchaseOrderOmittedCost).toContain(
      'RENAME TO _save_purchase_order_cost_input_impl',
    );
    expect(purchaseOrderOmittedCost).toContain("NOT (item.value ? 'unit_cost')");
    expect(purchaseOrderOmittedCost).toContain("NOT (item.value ? 'unit_cost_cents')");
    expect(purchaseOrderOmittedCost).toContain(
      "jsonb_build_object('unit_cost_cents', poi.unit_cost_cents)",
    );
    expect(purchaseOrderOmittedCost).toContain('poi.purchase_order_id = p_po_id');
    expect(purchaseOrderOmittedCost).toContain(
      'REVOKE ALL ON FUNCTION public._save_purchase_order_cost_input_impl',
    );
  });

  it('serializes PO hydration, validates line identity, and persists one bulk-import claim', () => {
    const saveWrapper = adversarialCloseout.slice(
      adversarialCloseout.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      adversarialCloseout.indexOf('CREATE OR REPLACE FUNCTION public.save_invoice('),
    );
    const lockPosition = saveWrapper.indexOf(
      'FROM public.purchase_orders\n     WHERE id = p_po_id\n     FOR UPDATE',
    );
    const hydratePosition = saveWrapper.indexOf(
      "jsonb_build_object(\n              'unit_cost_cents'",
    );

    expect(adversarialCloseout).toContain('CREATE TABLE public.purchase_order_import_intents');
    expect(adversarialCloseout).toContain(
      'ALTER TABLE public.purchase_order_import_intents ENABLE ROW LEVEL SECURITY',
    );
    expect(adversarialCloseout).toContain('purchase_order_import_intents_no_direct_access');
    expect(adversarialCloseout).toContain(
      'REVOKE ALL ON TABLE public.purchase_order_import_intents',
    );
    expect(saveWrapper).toContain("p_po_payload->>'bulk_import_intent_key'");
    expect(saveWrapper).toContain(
      "hashtextextended('bulk_po:' || v_actor::text || ':' || v_bulk_intent_key, 0)",
    );
    expect(saveWrapper).toContain("'status', 'already_imported'");
    expect(saveWrapper).toContain('PO_ITEM_ID_DUPLICATE');
    expect(saveWrapper).toContain('PO_ITEM_ID_NOT_IN_PURCHASE_ORDER');
    expect(saveWrapper).toContain(
      'SUM(round(poi.quantity_ordered * poi.unit_cost_cents)::bigint)',
    );
    expect(lockPosition).toBeGreaterThan(-1);
    expect(hydratePosition).toBeGreaterThan(lockPosition);
  });

  it('claims a bulk-imported vendor document globally and returns the original PO number', () => {
    const saveWrapper = globalBulkPOIntent.slice(
      globalBulkPOIntent.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      globalBulkPOIntent.indexOf('REVOKE ALL ON FUNCTION public.save_purchase_order('),
    );

    expect(globalBulkPOIntent).toContain(
      'CONSTRAINT purchase_order_import_intents_intent_key\n  UNIQUE (intent_key)',
    );
    expect(saveWrapper).toContain(
      "hashtextextended('bulk_po:' || v_bulk_intent_key, 0)",
    );
    expect(saveWrapper).not.toContain("'bulk_po:' || v_actor::text");
    expect(saveWrapper).toContain('WHERE claim.intent_key = v_bulk_intent_key');
    expect(saveWrapper).not.toContain('WHERE actor_id = v_actor');
    expect(saveWrapper).toContain("'po_number', v_result_po_number");
  });

  it('allocates PO numbers atomically, cascades import claims, and reuses the rounded header for bills', () => {
    const saveWrapper = finalPurchaseOrderRelease.slice(
      finalPurchaseOrderRelease.indexOf('CREATE FUNCTION public.save_purchase_order('),
      finalPurchaseOrderRelease.indexOf('-- A bulk-import claim'),
    );
    const billWriter = finalPurchaseOrderRelease.slice(
      finalPurchaseOrderRelease.indexOf('CREATE OR REPLACE FUNCTION public.create_vendor_bill('),
      finalPurchaseOrderRelease.indexOf('REVOKE ALL ON FUNCTION public.create_vendor_bill('),
    );

    expect(finalPurchaseOrderRelease).toContain(
      'RENAME TO _save_purchase_order_atomic_number_impl',
    );
    expect(saveWrapper).toContain('v_po_number := public.next_po_number()');
    expect(saveWrapper).toContain('jsonb_set(');
    expect(saveWrapper).toContain("jsonb_build_object('po_number', v_po_number)");
    expect(saveWrapper.indexOf('public.next_po_number()')).toBeLessThan(
      saveWrapper.indexOf('public._save_purchase_order_atomic_number_impl('),
    );
    expect(finalPurchaseOrderRelease).toContain('ON DELETE CASCADE');
    expect(finalPurchaseOrderRelease).toContain('SELECT vendor, total_cost_cents');
    expect(billWriter).not.toContain(
      'SUM(quantity_ordered * unit_cost * 100)',
    );
  });

  it('rechecks imported documents server-side and clears stale save replays after PO deletion', () => {
    const saveWrapper = deletedBulkPORetryState.slice(
      deletedBulkPORetryState.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      deletedBulkPORetryState.indexOf('REVOKE ALL ON FUNCTION public.save_purchase_order('),
    );

    expect(deletedBulkPORetryState).toContain(
      'CREATE OR REPLACE FUNCTION public._invalidate_deleted_purchase_order_retry_state()',
    );
    expect(deletedBulkPORetryState).toContain(
      "DELETE FROM public.idempotency_keys\n   WHERE operation = 'save_purchase_order'",
    );
    expect(deletedBulkPORetryState).toContain(
      'AFTER DELETE ON public.purchase_orders',
    );
    expect(saveWrapper).toContain('WHERE claim.intent_key = v_bulk_intent_key');
    expect(saveWrapper).toContain("'status', 'already_imported'");
    expect(saveWrapper.indexOf('WHERE claim.intent_key = v_bulk_intent_key')).toBeLessThan(
      saveWrapper.indexOf('public.next_po_number()'),
    );
  });

  it('replays the exact bulk PO result before duplicate classification or number allocation', () => {
    const saveWrapper = exactBulkPOReplay.slice(
      exactBulkPOReplay.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      exactBulkPOReplay.indexOf('REVOKE ALL ON FUNCTION public.save_purchase_order('),
    );
    const replayPosition = saveWrapper.indexOf('public.check_idempotency(');
    const documentClaimPosition = saveWrapper.indexOf(
      'WHERE claim.intent_key = v_bulk_intent_key',
    );
    const numberAllocationPosition = saveWrapper.indexOf('public.next_po_number()');

    expect(saveWrapper).toContain('IF NOT (public.is_admin() OR public.is_sales_rep()) THEN');
    expect(saveWrapper).toContain(
      "RETURN v_cached || jsonb_build_object('po_number', v_po_number)",
    );
    expect(replayPosition).toBeGreaterThan(-1);
    expect(documentClaimPosition).toBeGreaterThan(replayPosition);
    expect(numberAllocationPosition).toBeGreaterThan(documentClaimPosition);
    expect(exactBulkPOReplay).toContain(
      'FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.save_purchase_order(',
    );
    expect(exactBulkPOReplay).toContain('TO authenticated, service_role;');
  });

  it('requires and binds vendor identity at the database bulk-import boundary', () => {
    const saveWrapper = bulkPOVendorBinding.slice(
      bulkPOVendorBinding.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      bulkPOVendorBinding.indexOf('REVOKE ALL ON FUNCTION public.save_purchase_order('),
    );

    expect(saveWrapper).toContain('BULK_PO_VENDOR_REQUIRED');
    expect(saveWrapper).toContain('BULK_PO_INTENT_VENDOR_CONFLICT');
    expect(saveWrapper).toContain('SELECT claim.purchase_order_id, po.po_number, po.vendor');
    expect(saveWrapper).toContain(
      'lower(btrim(v_existing_vendor)) IS DISTINCT FROM lower(v_requested_vendor)',
    );
    expect(saveWrapper.indexOf('BULK_PO_VENDOR_REQUIRED')).toBeLessThan(
      saveWrapper.indexOf('public.check_idempotency('),
    );
    expect(saveWrapper.indexOf('WHERE claim.intent_key = v_bulk_intent_key')).toBeLessThan(
      saveWrapper.indexOf('public.next_po_number()'),
    );
  });

  it('binds exact replays to one vendor document and its reviewed content', () => {
    const saveWrapper = bulkPOReplayContent.slice(
      bulkPOReplayContent.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      bulkPOReplayContent.indexOf('REVOKE ALL ON FUNCTION public.save_purchase_order('),
    );
    const cachedReplay = saveWrapper.slice(
      saveWrapper.indexOf('IF p_idempotency_key IS NOT NULL THEN'),
      saveWrapper.indexOf('IF v_bulk_intent_key IS NOT NULL THEN\n    PERFORM pg_advisory_xact_lock'),
    );

    expect(bulkPOReplayContent).toContain('ADD COLUMN content_fingerprint text');
    expect(bulkPOReplayContent).toContain(
      'CREATE CONSTRAINT TRIGGER require_bulk_po_content_fingerprint',
    );
    expect(bulkPOReplayContent).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(saveWrapper).toContain('BULK_PO_INTENT_IDENTITY_MISMATCH');
    expect(saveWrapper).toContain('BULK_PO_DOCUMENT_CONTENT_CONFLICT');
    expect(saveWrapper).toContain(
      'v_existing_intent_key IS DISTINCT FROM v_bulk_intent_key',
    );
    expect(cachedReplay.indexOf('v_existing_intent_key IS DISTINCT FROM v_bulk_intent_key'))
      .toBeLessThan(cachedReplay.indexOf("RETURN v_cached || jsonb_build_object('po_number', v_po_number)"));
    expect(cachedReplay.indexOf('v_existing_content_fingerprint IS DISTINCT FROM v_content_fingerprint'))
      .toBeLessThan(cachedReplay.indexOf("RETURN v_cached || jsonb_build_object('po_number', v_po_number)"));
    expect(saveWrapper.indexOf('WHERE claim.intent_key = v_bulk_intent_key')).toBeLessThan(
      saveWrapper.indexOf('public.next_po_number()'),
    );
    expect(saveWrapper).toContain('SET content_fingerprint = v_content_fingerprint');
    expect(saveWrapper).toContain('IF NOT (public.is_admin() OR public.is_sales_rep()) THEN');
    expect(saveWrapper).not.toContain('lower(btrim(v_existing_vendor))');
    expect(bulkPOReplayContent).toContain('FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.save_purchase_order(');
    expect(bulkPOReplayContent).toContain('TO authenticated, service_role;');
  });

  it('moves vendor-invoice identity from the reviewed ASCII transition to shared Unicode canonicalization', () => {
    const saveWrapper = bulkPOAsciiIdentity.slice(
      bulkPOAsciiIdentity.indexOf('CREATE OR REPLACE FUNCTION public.save_purchase_order('),
      bulkPOAsciiIdentity.indexOf('REVOKE ALL ON FUNCTION public.save_purchase_order('),
    );
    const browserRetry = source('src/lib/bulkPOImportRetry.ts');

    expect(saveWrapper).toContain("'ABCDEFGHIJKLMNOPQRSTUVWXYZ'");
    expect(saveWrapper).toContain("'abcdefghijklmnopqrstuvwxyz'");
    expect(saveWrapper).toContain('translate(\n            v_requested_vendor,');
    expect(saveWrapper).toContain('translate(\n            v_vendor_reference,');
    expect(saveWrapper).not.toContain('lower(v_requested_vendor)');
    expect(saveWrapper).not.toContain('lower(v_vendor_reference)');
    expect(unicodeBulkPOIdentity).toContain(
      'LOCK TABLE public.purchase_order_import_intents IN SHARE ROW EXCLUSIVE MODE;',
    );
    expect(unicodeBulkPOIdentity).toContain(
      'BULK_PO_UNICODE_IDENTITY_TRANSITION_BLOCKED',
    );
    expect(unicodeBulkPOIdentity).toContain(
      'normalize(\n      lower(normalize(v_requested_vendor, NFKC)),\n      NFKC\n    )',
    );
    expect(unicodeBulkPOIdentity).toContain(
      'normalize(\n      lower(normalize(v_vendor_reference, NFKC)),\n      NFKC\n    )',
    );
    expect(unicodeBulkPOIdentity).toContain(
      "v_vector_hash <> '2fe4b753fbc589fbadd75339ef9af9d8f5d218449439f86254deef769546270c'",
    );
    expect(unicodeBulkPOIdentity).toContain(
      'IF NOT (public.is_admin() OR public.is_sales_rep()) THEN',
    );
    expect(unicodeBulkPOIdentity).toContain(
      'FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(browserRetry).toContain(
      ".normalize('NFKC')\n    .toLowerCase()\n    .normalize('NFKC')",
    );
    expect(browserRetry).toContain('const HASHED_PENDING_KEY_PATTERN = /^h1:[a-f0-9]{16}$/;');
    expect(browserRetry).toContain('return value.trim();');
    expect(browserRetry).toContain('BULK_PO_DOCUMENT_CONTENT_CONFLICT');
    expect(browserRetry).toContain(
      'In Supplier POs, search this vendor and invoice number, then edit it instead.',
    );
  });

  it('makes PostgreSQL the sole durable bulk-PO identity authority', () => {
    const adversarialSmoke = source(
      'scripts/smoke/smoke-adversarial-money-inventory-closeout.sql',
    );
    expect(serverAuthoritativeBulkPOIdentity).toContain(
      "v_payload->>'bulk_import_document' = 'true'",
    );
    expect(serverAuthoritativeBulkPOIdentity).toContain(
      'v_bulk_intent_key := v_expected_intent_key;',
    );
    expect(serverAuthoritativeBulkPOIdentity).not.toContain(
      "RAISE EXCEPTION 'BULK_PO_INTENT_IDENTITY_MISMATCH'",
    );
    expect(serverAuthoritativeBulkPOIdentity).toContain(
      "v_payload - 'bulk_import_intent_key' - 'bulk_import_document'",
    );
    expect(serverAuthoritativeBulkPOIdentity).toContain(
      'IF NOT (public.is_admin() OR public.is_sales_rep()) THEN',
    );
    expect(serverAuthoritativeBulkPOIdentity).toContain(
      'FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(adversarialSmoke).not.toContain("'bulk_import_document', true");
    expect(adversarialSmoke).toContain(
      "'bulk_import_intent_key', 'browser-value-is-not-authoritative'",
    );
    expect(serverDerivedBulkPOClaimPayload).toContain(
      "v_payload - 'bulk_import_document'",
    );
    expect(serverDerivedBulkPOClaimPayload).not.toContain(
      "v_payload->>'bulk_import_document' = 'true'",
    );
    expect(serverDerivedBulkPOClaimPayload).toContain(
      "'{bulk_import_intent_key}',\n          to_jsonb(v_bulk_intent_key)",
    );
    expect(serverDerivedBulkPOClaimPayload).not.toContain(
      "v_payload - 'bulk_import_intent_key' - 'bulk_import_document'",
    );
    expect(serverDerivedBulkPOClaimPayload.indexOf("'{bulk_import_intent_key}'"))
      .toBeLessThan(
        serverDerivedBulkPOClaimPayload.indexOf('_save_purchase_order_atomic_number_impl'),
      );
  });

  it('rejects invisible-only bulk PO identity at the public RPC boundary', () => {
    expect(blankBulkPOIdentity).toContain(
      'RENAME TO _save_purchase_order_ascii_identity_impl',
    );
    expect(blankBulkPOIdentity).toContain('chr(160)');
    expect(blankBulkPOIdentity).toContain('chr(65279)');
    expect(blankBulkPOIdentity).toContain("RAISE EXCEPTION 'BULK_PO_VENDOR_REQUIRED'");
    expect(blankBulkPOIdentity).toContain(
      "RAISE EXCEPTION 'BULK_PO_VENDOR_REFERENCE_REQUIRED'",
    );
    expect(blankBulkPOIdentity).toContain(
      'IF NOT (public.is_admin() OR public.is_sales_rep()) THEN',
    );
    expect(blankBulkPOIdentity).toContain(
      'RETURN public._save_purchase_order_ascii_identity_impl(',
    );
    expect(blankBulkPOIdentity).toContain(
      'FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(blankBulkPOIdentity).toContain('TO authenticated, service_role;');
  });

  it('canonicalizes the complete ECMAScript boundary-whitespace set before bulk PO identity use', () => {
    const expectedCodepoints = [
      9, 10, 11, 12, 13, 32, 160, 5760,
      8192, 8193, 8194, 8195, 8196, 8197, 8198, 8199, 8200, 8201, 8202,
      8232, 8233, 8239, 8287, 12288, 65279,
    ];

    expect(canonicalBulkPOIdentity).toContain(
      'CREATE OR REPLACE FUNCTION public.save_purchase_order(',
    );
    expectedCodepoints.forEach((codepoint) => {
      expect(canonicalBulkPOIdentity).toContain(`chr(${codepoint})`);
    });
    expect(canonicalBulkPOIdentity).toContain(
      'v_vendor := btrim(v_vendor, v_identity_boundary_chars);',
    );
    expect(canonicalBulkPOIdentity).toContain(
      'v_vendor_reference := btrim(v_vendor_reference, v_identity_boundary_chars);',
    );
    expect(canonicalBulkPOIdentity).toContain(
      "jsonb_set(v_payload, '{vendor}', to_jsonb(v_vendor), true)",
    );
    expect(canonicalBulkPOIdentity).toContain("'{bulk_import_vendor_reference}'");
    expect(canonicalBulkPOIdentity).toContain(
      'IF NOT (public.is_admin() OR public.is_sales_rep()) THEN',
    );
    expect(canonicalBulkPOIdentity).toContain(
      'RETURN public._save_purchase_order_ascii_identity_impl(',
    );
    expect(canonicalBulkPOIdentity).toContain(
      'FROM PUBLIC, anon;\nGRANT EXECUTE ON FUNCTION public.save_purchase_order(',
    );
    expect(canonicalBulkPOIdentity).toContain('TO authenticated, service_role;');
  });

  it('runs the deferred bulk PO fingerprint guard with its own locked-down privileges', () => {
    expect(secureBulkPOFingerprintTrigger).toContain(
      'CREATE OR REPLACE FUNCTION public._require_bulk_po_content_fingerprint()',
    );
    expect(secureBulkPOFingerprintTrigger).toContain(
      'LANGUAGE plpgsql\nSECURITY DEFINER\nSET search_path = public, pg_temp',
    );
    expect(secureBulkPOFingerprintTrigger).toContain(
      'FROM PUBLIC, anon, authenticated, service_role;',
    );
    expect(secureBulkPOFingerprintTrigger).toContain(
      't.tgdeferrable AND t.tginitdeferred',
    );
    expect(secureBulkPOFingerprintTrigger).toContain(
      "has_function_privilege('authenticated', 'public._require_bulk_po_content_fingerprint()', 'EXECUTE')",
    );
    const smoke = source('scripts/smoke/smoke-adversarial-money-inventory-closeout.sql');
    expect(smoke).toContain('SET LOCAL ROLE authenticated;');
    expect(smoke).toContain(
      'SET CONSTRAINTS require_bulk_po_content_fingerprint IMMEDIATE;',
    );
    expect(smoke).toContain("normalize('[SMOKE] Élan Bulk Intent Vendor', NFKC)");
  });

  it('authorizes invoice saves and statements against active customer assignment before replay', () => {
    const saveWrapper = invoiceExistingCustomerScope.slice(
      invoiceExistingCustomerScope.indexOf('CREATE OR REPLACE FUNCTION public.save_invoice('),
      invoiceExistingCustomerScope.indexOf('REVOKE ALL ON FUNCTION public.save_invoice('),
    );
    const statementWrapper = financialScope.slice(
      financialScope.indexOf('CREATE FUNCTION public.get_customer_statement('),
      financialScope.indexOf('DO $verify$'),
    );

    expect(financialScope).toContain('RENAME TO _save_invoice_scoped_impl');
    expect(financialScope).toContain('RENAME TO _get_customer_statement_scoped_impl');
    expect(financialScope).toContain(
      'REVOKE ALL ON FUNCTION public._save_invoice_scoped_impl(jsonb, jsonb, text)',
    );
    expect(financialScope).toContain(
      'REVOKE ALL ON FUNCTION public._get_customer_statement_scoped_impl(uuid, date, date)',
    );
    expect(saveWrapper).toContain('WHERE id = v_actor\n     AND is_active = true');
    expect(saveWrapper).toContain('WHERE id = v_invoice_id\n     FOR UPDATE');
    expect(saveWrapper).toContain('WHERE id = v_existing_customer_id');
    expect(saveWrapper).toContain('WHERE id = v_target_customer_id');
    expect(saveWrapper).toContain('AND assigned_sales_rep = v_actor');
    expect(saveWrapper).toContain("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'");
    expect(saveWrapper.indexOf('WHERE id = v_existing_customer_id')).toBeLessThan(
      saveWrapper.indexOf('RETURN public._save_invoice_scoped_impl('),
    );
    expect(statementWrapper).toContain('AND assigned_sales_rep = v_actor');
    expect(statementWrapper).toContain("ELSIF v_actor_role IS DISTINCT FROM 'admin' THEN");
    expect(statementWrapper.indexOf('AND assigned_sales_rep = v_actor')).toBeLessThan(
      statementWrapper.indexOf('RETURN QUERY'),
    );
  });

  it('binds invoice save and post replays to the actual customer before delegation', () => {
    const saveWrapper = adversarialCloseout.slice(
      adversarialCloseout.indexOf('CREATE OR REPLACE FUNCTION public.save_invoice('),
      adversarialCloseout.indexOf('ALTER FUNCTION public.post_invoice(uuid, text)'),
    );
    const postWrapper = adversarialCloseout.slice(
      adversarialCloseout.indexOf('CREATE FUNCTION public.post_invoice('),
      adversarialCloseout.indexOf('ALTER FUNCTION public.post_invoice_group('),
    );
    const groupWrapper = adversarialCloseout.slice(
      adversarialCloseout.indexOf('CREATE FUNCTION public.post_invoice_group('),
      adversarialCloseout.indexOf('DO $verify$'),
    );

    expect(saveWrapper).toContain('v_invoice_id IS DISTINCT FROM v_cached_invoice_id');
    expect(saveWrapper).toContain(
      'v_requested_customer_id IS DISTINCT FROM v_cached_customer_id',
    );
    expect(saveWrapper).toContain('AND assigned_sales_rep = v_actor');
    expect(saveWrapper.indexOf("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'")).toBeLessThan(
      saveWrapper.indexOf('RETURN v_cached_invoice_id'),
    );
    expect(adversarialCloseout).toContain('RENAME TO _post_invoice_customer_scope_impl');
    expect(adversarialCloseout).toContain(
      'RENAME TO _post_invoice_group_customer_scope_impl',
    );
    expect(postWrapper).toContain('v_cached_invoice_id IS DISTINCT FROM p_invoice_id');
    expect(postWrapper).toContain('AND assigned_sales_rep = v_actor');
    expect(postWrapper.indexOf("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'")).toBeLessThan(
      postWrapper.indexOf('PERFORM public._post_invoice_customer_scope_impl('),
    );
    expect(groupWrapper).toContain(
      'customer_row.assigned_sales_rep IS DISTINCT FROM v_actor',
    );
    expect(groupWrapper.indexOf("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'")).toBeLessThan(
      groupWrapper.indexOf('RETURN public._post_invoice_group_customer_scope_impl('),
    );
  });

  it('aggregates repeated delivery products before completion and marks immutable ledger rows at insert', () => {
    const wrapper = deliveryAggregate.slice(
      deliveryAggregate.indexOf('CREATE FUNCTION public.complete_delivery('),
      deliveryAggregate.indexOf('REVOKE ALL ON FUNCTION public.complete_delivery('),
    );

    expect(deliveryAggregate).toContain('RENAME TO _complete_delivery_aggregate_impl');
    expect(deliveryAggregate).toContain(
      'CREATE OR REPLACE FUNCTION public._mark_delivery_aggregate_short_stock()',
    );
    expect(deliveryAggregate).toContain('BEFORE INSERT ON public.inventory_transactions');
    expect(deliveryAggregate).toContain('NEW.requires_review := true');
    expect(deliveryAggregate).not.toContain('UPDATE public.inventory_transactions');
    expect(wrapper).toContain('COUNT(*) FILTER (WHERE el.effective_quantity > 0) > 1');
    expect(wrapper).toContain(
      'SUM(el.effective_quantity) > COALESCE(inv.quantity_available, 0)',
    );
    expect(wrapper).toContain(
      'MAX(el.effective_quantity) <= COALESCE(inv.quantity_available, 0)',
    );
    expect(wrapper).toContain("'app.delivery_aggregate_short_product_ids'");
    expect(wrapper).toContain("'delivery_short_stock'");
    expect(wrapper).toContain("'stock_warning', true");
    expect(wrapper).toContain('UPDATE public.idempotency_keys');
    expect(wrapper.indexOf("RAISE EXCEPTION 'Not authorized to complete this delivery'")).toBeLessThan(
      wrapper.indexOf('public.check_idempotency('),
    );
    expect(wrapper.indexOf("'app.delivery_aggregate_short_product_ids'")).toBeLessThan(
      wrapper.indexOf('public._complete_delivery_aggregate_impl('),
    );
  });

  it('rejects a closed delivery period before legacy completion side effects', () => {
    const wrapper = deliveryPeriodPreflight.slice(
      deliveryPeriodPreflight.indexOf('CREATE FUNCTION public.complete_delivery('),
      deliveryPeriodPreflight.indexOf('REVOKE ALL ON FUNCTION public.complete_delivery('),
    );

    expect(deliveryPeriodPreflight).toContain(
      'RENAME TO _complete_delivery_period_preflight_impl',
    );
    expect(deliveryPeriodPreflight).toContain(
      'REVOKE ALL ON FUNCTION public._complete_delivery_period_preflight_impl(',
    );
    expect(wrapper.indexOf("RAISE EXCEPTION 'Not authorized to complete this delivery'")).toBeLessThan(
      wrapper.indexOf('public.check_idempotency('),
    );
    expect(wrapper.indexOf('public.check_idempotency(')).toBeLessThan(
      wrapper.indexOf('PERFORM public.check_period_open(v_effective_completion_date)'),
    );
    expect(wrapper.indexOf('PERFORM public.check_period_open(v_effective_completion_date)')).toBeLessThan(
      wrapper.indexOf('RETURN public._complete_delivery_period_preflight_impl('),
    );
  });

  it('keeps every revoked money and inventory table mutation behind an RPC', () => {
    const rpcOnlyTables = new Set([
      'purchase_orders',
      'purchase_order_items',
      'receiving_records',
      'vendor_bills',
      'vendor_payments',
      'prepay_credits',
      'prepay_applications',
    ]);
    const directMutations: string[] = [];
    // The AST check below only ever fires when a call receiver's SOURCE TEXT
    // contains `.from('<table>')` (or the double-quoted form). A receiver's text
    // is always a substring of its file's text, so a file without that literal
    // cannot produce a finding — skipping its TypeScript parse is exactly
    // equivalent, not a narrowing of what this test asserts. It matters because
    // parsing every file under src/ took ~1.5s alone and >22s under the full
    // parallel suite, blowing this test's timeout on a machine-load flake.
    const mutationLiterals = [...rpcOnlyTables].flatMap((table) => [
      `.from('${table}')`,
      `.from("${table}")`,
    ]);

    for (const path of sourceFiles('src')) {
      const contents = source(path);
      if (!mutationLiterals.some((literal) => contents.includes(literal))) continue;
      const ast = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node) => {
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          ['insert', 'update', 'delete', 'upsert'].includes(node.expression.name.text)
        ) {
          const receiver = node.expression.expression.getText(ast);
          for (const table of rpcOnlyTables) {
            if (
              receiver.includes(`.from('${table}')`) ||
              receiver.includes(`.from("${table}")`)
            ) {
              directMutations.push(`${path}: ${node.getText(ast).slice(0, 160)}`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
    }

    expect(directMutations).toEqual([]);
    // 60s: this test still reads every file under src/, and the suite runs 150
    // files in parallel against one disk. 20s was not enough headroom under load.
  }, 60_000);

  it('allows allocate_payment to replay a committed atomic claim without weakening legacy loser rollback', () => {
    expect(committedReplayGuard).toContain("NEW.operation = 'allocate_payment'");
    expect(committedReplayGuard).toContain("NEW.result->>'_contract' = 'allocate_payment_v1'");
    expect(committedReplayGuard).toContain("NEW.result->'response' = 'null'::jsonb");
    expect(committedReplayGuard).toContain('RETURN NULL;');
    expect(committedReplayGuard).toContain('IDEMPOTENCY_CROSS_OP_KEY_REUSE:');
    expect(committedReplayGuard).toContain('IDEMPOTENCY_CONCURRENT_REPLAY_RETRY:');
    expect(committedReplayGuard.indexOf("NEW.operation = 'allocate_payment'")).toBeLessThan(
      committedReplayGuard.indexOf('IDEMPOTENCY_CONCURRENT_REPLAY_RETRY:'),
    );
  });

  it('allows only explicit draft misc charges to bypass the order or blend source rule', () => {
    expect(money).toContain("<> 'misc_charge'");
    expect(money).toContain('MISC_CHARGE_MUST_START_DRAFT');
    expect(money).toContain('ORDERLESS_INVOICE_TYPE_LOCKED');
    expect(money).toMatch(
      /WHERE id = v_invoice_id\s+AND invoice_type = 'misc_charge'\s+AND order_id IS NULL\s+AND blend_ticket_id IS NULL/,
    );
    expect(money).toContain('Invoices must link to an order or blend ticket');

    const invoiceDetail = source('src/pages/InvoiceDetail.tsx');
    expect(invoiceDetail).toContain('isOrderlessMiscCharge');
    expect(invoiceDetail).toContain('disabled={isInvoiceTypeLocked}');
  });

  it('includes write-offs, excludes voided AP payments, and rejects future finance-charge dates', () => {
    expect(money).toContain("'write_off' AS txn_type");
    expect(money).toContain('wo.reversed_at IS NULL');
    expect(money.match(/wo\.created_at AT TIME ZONE 'America\/Chicago'/g)?.length).toBe(2);
    expect(money).toContain('vp.voided_at IS NULL');
    expect(money.match(/FUTURE_FINANCE_CHARGE_DATE/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('requires penny-exact prepay splits without disabling the vetted manual allocation workspace', () => {
    expect(money).toContain('PREPAY_SPLIT_TOTAL_MISMATCH');
    expect(money).toContain('p_idempotency_key text DEFAULT NULL::text, p_expected_total_cents bigint DEFAULT NULL::bigint');
    expect(money).toContain('v_expected_total_cents := COALESCE(p_expected_total_cents, v_declared_split_total)');
    expect(money).toContain('create_prepay_check_splits(uuid, text, jsonb, uuid, text, bigint)');
    expect(money).not.toContain('p_splits jsonb, p_expected_total_cents bigint, p_performed_by uuid');
    expect(money).not.toContain('CREATE OR REPLACE FUNCTION public.batch_apply_prepayments');

    const prepayUi = source('src/components/prepay/PrepaymentManagerPanel.tsx');
    const workspace = source('src/components/prepay/PrepayWorkspacePanel.tsx');
    expect(prepayUi).toContain('if (splitTotal !== totalCents)');
    expect(prepayUi).toContain('p_expected_total_cents: totalCents');
    expect(prepayUi).not.toContain('Math.abs(splitTotal - totalCents) > 1');
    expect(workspace).toContain("supabase.rpc('batch_apply_prepayments'");
  });

  it('clamps on-order quantities and nets delivery reversals', () => {
    expect(inventory).toContain('ORDER_VOID_REVERSAL_CONTRACT_DRIFT');
    expect(inventory).toContain("p.proname = '_void_order_impl_20260714'");
    expect(inventory).toContain("v_void_body LIKE '%delivery_id%'");
    expect(inventory).toContain('SUM(GREATEST(poi.quantity_ordered - COALESCE(poi.quantity_received, 0), 0))');
    expect(inventory).toContain("WHEN it.transaction_type IN ('cancelled_delivery_reversal', 'void_delivery_reversal')");
    expect(inventory).toContain('THEN -ABS(it.quantity)');
    expect(inventory).toContain('JOIN deliveries d ON d.id = it.delivery_id');
    expect(inventory).toContain("COALESCE(d.completed_at, it.created_at) AT TIME ZONE 'America/Chicago'");
    expect(inventory).toContain('order_voided_products AS (');
    expect(inventory).toContain("it.transaction_type = 'void_delivery_reversal'");
    expect(inventory).toContain('AND it.delivery_id IS NULL');
    expect(inventory).toContain('ON ovp.order_id = it.order_id');
    expect(inventory).toContain('AND ovp.product_id = it.product_id');
    expect(inventory).toContain('AND ovp.order_id IS NULL');
    expect(inventory).not.toContain('AND it.created_at >= v_season_start');
  });

  it('shows authoritative stock and review flags instead of a ledger-derived current balance', () => {
    const ledger = source('src/components/inventory/TransactionLedgerModal.tsx');
    expect(ledger).toContain("supabase.rpc('get_inventory_position')");
    expect(ledger).toContain('Review required');
    expect(ledger).toContain('On floor:');
    expect(ledger).not.toContain('Current balance:');
    expect(ledger).not.toContain('computeRunningBalance');
  });
});
