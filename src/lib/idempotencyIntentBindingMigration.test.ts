import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260803010917_bind_idempotency_to_mutation_intent.sql',
  'utf8',
);
const invoiceDetail = readFileSync('src/pages/InvoiceDetail.tsx', 'utf8').replace(/\r\n/g, '\n');
const quickDeliveryModal = readFileSync('src/components/deliveries/QuickDeliveryModal.tsx', 'utf8').replace(/\r\n/g, '\n');

describe('payload-bound idempotency migration', () => {
  it('persists server-derived request fingerprints', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS request_fingerprint text');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS request_actor_id uuid');
    expect(migration).toContain('extensions.digest(');
    expect(migration).toContain("'actor_id', v_actor");
    expect(migration).toContain('request_actor_id IS DISTINCT FROM v_actor');
    expect(migration).toContain('request_actor_id = v_actor');
  });

  it.each(['save_invoice', 'create_quick_delivery'])('%s rejects a changed intent', (operation) => {
    const start = migration.indexOf(`CREATE FUNCTION public.${operation}(`);
    expect(start).toBeGreaterThan(-1);
    const body = migration.slice(start, migration.indexOf('$function$;', start) + 11);
    expect(body).toContain('pg_advisory_xact_lock');
    expect(body).toContain('request_fingerprint IS DISTINCT FROM v_fingerprint');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(body).toContain("'result', v_existing.result");
  });

  it('keeps implementation functions private and public wrappers anonymous-safe', () => {
    for (const impl of ['_save_invoice_intent_impl_20260802', '_create_quick_delivery_intent_impl_20260802']) {
      expect(migration).toContain(`REVOKE ALL ON FUNCTION public.${impl}(`);
    }
    for (const fn of ['save_invoice', 'create_quick_delivery']) {
      expect(migration).toContain(`GRANT EXECUTE ON FUNCTION public.${fn}(`);
    }
    expect(migration).toContain('FROM PUBLIC, anon;');
    expect(migration).toContain('TO authenticated, service_role;');
  });

  it('runs authentication and actor gates before releasing cached receipts', () => {
    const quickStart = migration.indexOf('CREATE FUNCTION public.create_quick_delivery(');
    const quickBody = migration.slice(quickStart, migration.indexOf('$function$;', quickStart));
    expect(quickBody.indexOf("RAISE EXCEPTION 'AUTH_REQUIRED'")).toBeLessThan(
      quickBody.indexOf('SELECT * INTO v_existing'),
    );
    expect(quickBody.indexOf("RAISE EXCEPTION 'ACTOR_MISMATCH'")).toBeLessThan(
      quickBody.indexOf('SELECT * INTO v_existing'),
    );

    const invoiceStart = migration.indexOf('CREATE FUNCTION public.save_invoice(');
    const invoiceBody = migration.slice(invoiceStart, migration.indexOf('$function$;', invoiceStart));
    expect(invoiceBody.indexOf("RAISE EXCEPTION 'AUTH_REQUIRED'")).toBeLessThan(
      invoiceBody.indexOf('SELECT * INTO v_existing'),
    );
    expect(invoiceBody).toContain("AND assigned_sales_rep = v_actor");
  });

  it.each(['save_invoice', 'create_quick_delivery'])('%s fails closed on fully legacy receipts during rollout', (operation) => {
    const start = migration.indexOf(`CREATE FUNCTION public.${operation}(`);
    const body = migration.slice(start, migration.indexOf('$function$;', start));
    const legacyBridge = body.indexOf('v_existing.request_actor_id IS NULL');
    const actorGate = body.indexOf('v_existing.request_actor_id IS DISTINCT FROM v_actor');
    const legacyBlock = body.slice(legacyBridge, actorGate);
    expect(legacyBridge).toBeGreaterThan(-1);
    expect(legacyBlock).toContain('AND v_existing.request_fingerprint IS NULL');
    expect(legacyBlock).toContain("RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(legacyBlock).toContain("'result', v_existing.result");
    expect(legacyBlock).not.toContain(`RETURN public._${operation}_intent_impl_20260802`);
    expect(legacyBridge).toBeLessThan(actorGate);
  });

  it('checks entity scope before exposing either legacy receipt', () => {
    expect(migration).toContain("RAISE EXCEPTION 'CUSTOMER_SCOPE_DENIED'");
    expect(migration).toContain("RAISE EXCEPTION 'DELIVERY_SCOPE_DENIED'");
    expect(migration).toContain("v_actor_role = 'driver' AND v_cached_driver_id IS DISTINCT FROM v_actor");
  });

  it('validates every save_invoice result before reporting success', () => {
    // STRENGTHENED 2026-09-03 (Codex HIGH, F1). This previously pinned the literal
    // "if (isNew) {\n  const savedId = assertRpcResult<string>(data, 'save_invoice');",
    // which only proved the CREATE arm was validated. save_invoice RETURNS the invoice
    // id for edits as well, so an EDIT with a null reply fell through the unvalidated
    // else arm, retired its idempotency key and reported "saved" — exactly the F1
    // failure mode this file exists to prevent. The old pin was satisfied by the buggy
    // shape, so it is replaced by the stronger property rather than relaxed:
    // the reply must be validated UNCONDITIONALLY, and before the key is retired.
    expect(invoiceDetail).toContain("const savedId = assertRpcResult<string>(data, 'save_invoice');");
    expect(invoiceDetail).not.toContain('if (isNew && data)');
    // The assert must not be nested inside an isNew-only branch.
    expect(invoiceDetail).not.toMatch(/if \(isNew\)\s*\{\s*\n\s*const savedId = assertRpcResult/);

    const assertAt = invoiceDetail.indexOf("const savedId = assertRpcResult<string>(data, 'save_invoice');");
    expect(assertAt).toBeGreaterThan(-1);
    // The save-path reset must follow the assert (the earlier reset at the
    // committed-receipt recovery branch is intentionally before it and is not this one).
    const resetAfter = invoiceDetail.indexOf('saveIdem.resetKey();', assertAt);
    expect(resetAfter).toBeGreaterThan(assertAt);
  });

  it('resets quick-delivery form state on both success and reconciliation', () => {
    const mismatchStart = quickDeliveryModal.indexOf("getIdempotencyMismatchResult(error, 'create_quick_delivery')");
    const mismatchEnd = quickDeliveryModal.indexOf('throw error;', mismatchStart);
    expect(quickDeliveryModal.slice(mismatchStart, mismatchEnd)).toContain('resetForm();');
    expect((quickDeliveryModal.match(/resetForm\(\);/g) ?? [])).toHaveLength(2);
  });
});
