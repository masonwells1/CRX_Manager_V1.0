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
  '20260831233000_bind_section9_replays_to_intent.sql',
);

describe('Section 9 actor-and-intent replay binding', () => {
  const rpcs = [
    {
      name: 'receive_po_items',
      signature: 'jsonb, uuid, text, boolean',
      impl: '_section9_receive_po_items_intent_impl_20260831',
      fields: ["'items', p_items", "'allow_over_receive', COALESCE(p_allow_over_receive, false)"],
    },
    {
      name: 'update_vendor_bill',
      signature: 'uuid, bigint, bigint, date, date, text, text',
      impl: '_section9_update_vendor_bill_intent_impl_20260831',
      fields: ["'bill_id', p_bill_id", "'subtotal_cents', p_subtotal_cents", "'notes', p_notes", "'confirm_po_overage', COALESCE(p_confirm_po_overage, false)", "'po_overage_reason', v_overage_reason"],
    },
    {
      name: 'record_vendor_payment',
      signature: 'uuid, bigint, date, text, text, text, text',
      impl: '_section9_record_vendor_payment_intent_impl_20260831',
      fields: ["'vendor_bill_id', p_vendor_bill_id", "'amount_cents', p_amount_cents", "'reference_number', p_reference_number"],
    },
    {
      name: 'void_vendor_bill',
      signature: 'uuid, text, text',
      impl: '_section9_void_vendor_bill_intent_impl_20260831',
      fields: ["'vendor_bill_id', p_vendor_bill_id", "'reason', v_reason"],
    },
  ];

  it('fails the former key-only replay shape and passes only actor-bound exact request wrappers', () => {
    for (const rpc of rpcs) {
      const start = migration.indexOf(`CREATE FUNCTION public.${rpc.name}(`);
      expect(start, `${rpc.name} wrapper missing`).toBeGreaterThan(-1);
      const body = migration.slice(start, migration.indexOf('$function$;', start));

      expect(migration).toContain(`ALTER FUNCTION public.${rpc.name}(${rpc.signature})`);
      expect(migration).toContain(`RENAME TO ${rpc.impl}`);
      expect(body).toContain("'actor_id', v_actor");
      for (const field of rpc.fields) expect(body).toContain(field);
      expect(body).toContain(`public.check_idempotency_intent(p_idempotency_key, '${rpc.name}', v_actor, v_fingerprint)`);
      expect(body).toContain('request_fingerprint = v_fingerprint, request_actor_id = v_actor');
      expect(body).toContain('IDEMPOTENCY_RECEIPT_MISSING');
      expect(body).toContain('IDEMPOTENCY_RESULT_INVALID');
      expect(body).toContain(`${rpc.impl}(`);
      expect(body).not.toContain(`check_idempotency(p_idempotency_key, '${rpc.name}')`);
    }
  });

  it('keeps wrappers private-by-default and exposes only the deliberate browser grants', () => {
    for (const rpc of rpcs) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc.impl}(`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc.impl}(`);
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${rpc.name}(`);
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${rpc.name}(`);
    }
    expect(migration).toContain('SET search_path = public, pg_temp');
    expect(migration).toContain("to_regprocedure('public.update_vendor_bill(uuid,bigint,bigint,date,date,text,text,boolean,text)')");
    for (const rpc of rpcs) {
      expect(migration).toContain(`proname = '${rpc.name}') <> 1`);
    }
  });

  it('fails the migration before replacing RPCs when any live legacy receipt exists', () => {
    expect(migration).toContain(
      'LOCK TABLE public.idempotency_keys IN SHARE ROW EXCLUSIVE MODE',
    );
    for (const operation of [
      'receive_po_items',
      'update_vendor_bill',
      'record_vendor_payment',
      'void_vendor_bill',
      'notify_damaged_receiving',
    ]) expect(migration).toContain(`'${operation}'`);
    expect(migration).toContain(
      '(expires_at IS NULL OR expires_at >= transaction_timestamp())',
    );
    expect(migration).toContain(
      '(request_actor_id IS NULL OR request_fingerprint IS NULL)',
    );
    expect(migration).toContain(
      'SECTION9_INTENT_CUTOVER_BLOCKED: unexpired unbound PO/AP receipt exists',
    );
    expect(migration).not.toMatch(/^BEGIN;|\nBEGIN;\s*$/m);
    expect(migration.trimEnd()).not.toMatch(/COMMIT;$/);
  });

  it('keeps every RPC rename block valid PL/pgSQL', () => {
    for (const tag of [
      'rename_section9_receiving',
      'rename_section9_update_bill',
      'rename_section9_payment',
      'rename_section9_void_bill',
    ]) {
      expect(migration).toContain(`END;\n$${tag}$;`);
      expect(migration).not.toContain(`END\n$${tag}$;`);
    }
  });

  it('enforces and audits cumulative PO billing on bill edits', () => {
    expect(migration).toContain('vb.id <> p_bill_id');
    expect(migration).toContain('v_cumulative_total_cents * 100 > v_po_total_cents * 105');
    expect(migration).toContain('COALESCE(p_confirm_po_overage, false) IS NOT TRUE');
    expect(migration).toContain('PO_CUMULATIVE_BILLING_REASON_REQUIRED');
    expect(migration).toContain("'po_cumulative_billing_overage_confirmed'");

    const page = source('src', 'pages', 'VendorBillDetail.tsx');
    expect(page).toContain('p_confirm_po_overage: confirmPoOverage');
    expect(page).toContain('p_po_overage_reason: poOverageReason');
    expect(page).toContain('RpcErrorCodes.PO_CUMULATIVE_BILLING_CONFIRMATION_REQUIRED');
    expect(page).toContain('Confirm PO billing overage');
  });

  it('retires a proven-stale client key so the current request can be retried safely', () => {
    const newVendorBill = source('src', 'pages', 'NewVendorBill.tsx');
    const vendorBill = source('src', 'pages', 'VendorBillDetail.tsx');
    const purchaseOrder = source('src', 'pages', 'PurchaseOrderDetail.tsx');
    const quickReceive = source('src', 'components', 'receiving', 'QuickReceivePanel.tsx');
    const receivingHub = source('src', 'components', 'receiving', 'ReceivingHubPanel.tsx');
    const inventoryPage = source('src', 'pages', 'InventoryPage.tsx');

    for (const page of [vendorBill, purchaseOrder, quickReceive, receivingHub, inventoryPage]) {
      expect(page).toContain('getIdempotencyBindingRejection');
    }
    expect(purchaseOrder).toContain('receiveIdem.resetKey()');
    expect(purchaseOrder).toContain('reverseIdem.resetKey()');
    expect(quickReceive).toContain('receiveIdem.resetKey()');
    expect(receivingHub).toContain('receiveIdem.resetKey()');
    expect(inventoryPage).toContain(
      'if (getIdempotencyBindingRejection(error)) receivePoIdem.resetKey();',
    );
    expect(vendorBill).toContain('paymentIdem.resetKey();');
    expect(vendorBill).toContain('editIdem.resetKey();');
    expect(vendorBill).toContain('voidIdem.resetKey();');
    expect(newVendorBill).toContain('getIdempotencyBindingRejection(err)');
    expect(newVendorBill).toContain('createBillIdem.resetKey();');
    expect(newVendorBill).toContain('this bill was not submitted');
    const assertedCreate = newVendorBill.indexOf("assertRpcResult(data, 'create_vendor_bill')");
    const retiredCreate = newVendorBill.indexOf('createBillIdem.resetKey();', assertedCreate);
    expect(assertedCreate).toBeGreaterThan(-1);
    expect(retiredCreate).toBeGreaterThan(assertedCreate);
  });

  it('binds damaged-receipt notification replay to actor and exact message intent', () => {
    const start = migration.indexOf(
      'CREATE OR REPLACE FUNCTION public.notify_damaged_receiving(',
    );
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, migration.indexOf('$function$;', start));
    for (const field of [
      "'actor_id', v_actor",
      "'po_number', p_po_number",
      "'items_summary', p_items_summary",
      "'po_id', p_po_id",
    ]) expect(body).toContain(field);
    expect(body).toContain(
      "p_idempotency_key, 'notify_damaged_receiving', v_actor, v_fingerprint",
    );
    expect(body).toContain('request_fingerprint = v_fingerprint');
    expect(body).toContain('request_actor_id = v_actor');
    expect(body).not.toContain(
      "check_idempotency(p_idempotency_key, 'notify_damaged_receiving')",
    );
  });

  it('extends the rollback-only Section 9 smoke with changed-batch and changed-edit proofs', () => {
    const smoke = source('scripts', 'smoke', 'smoke-section9-po-ap-high-remediation.sql');
    expect(smoke).toContain('changed receive batch replayed a prior success');
    expect(smoke).toContain('changed vendor-bill edit replayed a prior success');
    expect(smoke).toContain('NULL and empty payment terms shared an intent fingerprint');
    expect(smoke).toContain('changed damaged notification replayed a prior success');
    expect(smoke).toContain('exact damaged notification replay duplicated alerts');
    expect(smoke.match(/IDEMPOTENCY_INTENT_MISMATCH/g)?.length).toBeGreaterThanOrEqual(2);
    expect(smoke).toContain('SMOKE_PASS_ROLLBACK');
  });

  it('keeps the overlapping AP medium guards at the same governed boundary', () => {
    expect(migration).toContain("'Vendor bill amount differs from PO'");
    expect(migration).toContain('WHERE id = p_vendor_bill_id AND deleted_at IS NULL FOR UPDATE;');

    const smoke = source('scripts', 'smoke', 'smoke-section9-po-ap-high-remediation.sql');
    for (const marker of [
      'update accepted due date before bill date',
      'paid a soft-deleted vendor bill',
      'voided a soft-deleted vendor bill',
    ]) expect(smoke).toContain(marker);
  });
});
