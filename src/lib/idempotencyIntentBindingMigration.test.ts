import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  'supabase/migrations/20260802162805_bind_idempotency_to_mutation_intent.sql',
  'utf8',
);

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
    expect(migration).toContain('FROM PUBLIC, anon, authenticated, service_role');
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
});
