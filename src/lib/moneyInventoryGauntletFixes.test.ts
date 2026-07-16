import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

function source(path: string): string {
  return readFileSync(join(ROOT, path), 'utf8');
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
const completeDelivery = access.slice(0, access.indexOf('CREATE OR REPLACE FUNCTION public.void_delivery'));

describe('money and inventory gauntlet fixes', () => {
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
    expect(bulkImport).toContain('poSaveKeysRef.current[intentKey]');
    expect(bulkImport).toContain('poNumbersRef.current[intentKey]');
    expect(bulkImport).toContain('delete poNumbersRef.current[intentKey]');
    expect(idempotency).toContain('const uuid = crypto.randomUUID()');
    expect(idempotencyHook).toContain('keyRef.current.scope !== scope');
    expect(bulkImport).not.toMatch(/\.from\(['"]purchase_orders['"]\)[\s\S]{0,250}\.(?:insert|update|delete|upsert)\(/);
    expect(detail).not.toMatch(/\.from\(['"]purchase_orders['"]\)[\s\S]{0,250}\.(?:insert|update|delete|upsert)\(/);
    expect(detail).toContain('Received line locked');
    expect(detail).toContain(
      "useIdempotencyKey('submit_purchase_order', `${profile?.id || ''}:${id || ''}`)",
    );
    expect(detail).toContain('resetSubmitPOKey();\n  }, [id, resetSubmitPOKey]);');
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

    for (const path of sourceFiles('src')) {
      const contents = source(path);
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
