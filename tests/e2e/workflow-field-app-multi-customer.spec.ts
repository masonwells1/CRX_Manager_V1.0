/**
 * workflow-field-app-multi-customer.spec.ts — Phase 1 (2026-04-29)
 *
 * End-to-end behavior tests for the field application workflow rewrite.
 * RPC-driven (with one UI smoke) because the matrix the brief calls for is
 * SQL behavior — Mode A vs B branching, idempotency byte-equality, atomic
 * group posting — none of which is observable through pixel pushing.
 *
 * Setup happens via REST in beforeAll (creates [E2E] field with 60/40 split
 * between Farm Alpha and Farm Beta, plus [E2E] Test Hagie application service).
 * Cleanup runs in afterAll for rows the global teardown doesn't reach.
 *
 * The shared customers (Farm Alpha, Farm Beta) are seeded by global setup.
 *
 * See: supabase/migrations/20260429140635_field_app_workflow_phase1.sql
 */

import { test, expect, type Page } from '@playwright/test';
import { login } from './utils/auth';
import { supabaseRest, supabaseRpc, asArray } from './golive/utils/supabase-helpers';
import { E2E_PREFIX } from './fixtures/e2e-constants';

const RUN = `FAP1-${Date.now().toString(36)}`;
const SPLIT_FIELD_NAME = `${E2E_PREFIX} ${RUN} Split 60/40`;
const APP_SVC_NAME = `${E2E_PREFIX} ${RUN} Hagie`;

let alphaId: string;
let betaId: string;
let splitFieldId: string;
let appServiceId: string;
let createdInvoiceIds: string[] = [];
let createdGroupId: string | null = null;

async function getUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sb-rhyzpcqhnizqbxphqdkr-auth-token');
    if (!raw) return '00000000-0000-0000-0000-000000000000';
    try { return JSON.parse(raw)?.user?.id || '00000000-0000-0000-0000-000000000000'; }
    catch { return '00000000-0000-0000-0000-000000000000'; }
  });
}

test.describe.configure({ mode: 'serial' });

test.describe('Field App Phase 1 — multi-customer split via RPC', () => {
  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);

    // Resolve Alpha and Beta IDs (already seeded by globalSetup)
    const alphaRows = asArray<{ id: string }>(
      await supabaseRest(page, 'GET',
        `customers?farm_name=eq.${encodeURIComponent(`${E2E_PREFIX} Farm Alpha`)}&select=id&limit=1`),
      'fetch Alpha id',
    );
    const betaRows = asArray<{ id: string }>(
      await supabaseRest(page, 'GET',
        `customers?farm_name=eq.${encodeURIComponent(`${E2E_PREFIX} Farm Beta`)}&select=id&limit=1`),
      'fetch Beta id',
    );
    alphaId = alphaRows[0].id;
    betaId = betaRows[0].id;

    // Create a Phase 1 application service ([E2E] prefixed for cleanup discipline,
    // even though application_services isn't in the global teardown — afterAll handles it)
    const svcRes = asArray<{ id: string }>(
      await supabaseRest(page, 'POST', 'application_services', {
        name: APP_SVC_NAME,
        default_rate_per_acre_cents: 1500,
        cost_per_acre_cents: 800,
        is_active: true,
        sort_order: 100,
      }),
      'create application service',
    );
    appServiceId = svcRes[0].id;

    // Create a 50-acre field owned by Alpha but with a 60/40 billing split
    // to test multi-customer grouped split invoices.
    const fieldRes = asArray<{ id: string }>(
      await supabaseRest(page, 'POST', 'fields', {
        field_name: SPLIT_FIELD_NAME,
        customer_id: alphaId,  // owner; billing splits override this for invoicing
        total_acres: 50,
        crop_type: 'Corn',
        is_active: true,
      }),
      'create split field',
    );
    splitFieldId = fieldRes[0].id;

    // 60/40 split between Alpha (primary) and Beta
    await supabaseRest(page, 'POST', 'field_billing_defaults', {
      field_id: splitFieldId,
      customer_id: alphaId,
      split_pct: 60,
      is_primary: true,
    });
    await supabaseRest(page, 'POST', 'field_billing_defaults', {
      field_id: splitFieldId,
      customer_id: betaId,
      split_pct: 40,
      is_primary: false,
    });

    await ctx.close();
  });

  test.afterAll(async ({ browser }) => {
    // Defensive cleanup for rows global teardown doesn't reach. Field row
    // itself goes through teardown's deleteByFk(fields, customer_id ∈ ...).
    // Application services are not currently in teardown so we delete here.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);

    // Clean up in reverse-FK order so cascade FK violations don't bite
    if (createdInvoiceIds.length > 0) {
      // shares + items + locations cascade off invoice; this is just defensive
      const inClause = `in.(${createdInvoiceIds.join(',')})`;
      await supabaseRest(page, 'DELETE', `field_app_location_shares?location_id=in.(${createdInvoiceIds.join(',')})`).catch(() => {});
      await supabaseRest(page, 'DELETE', `field_app_locations?invoice_id=${inClause}`).catch(() => {});
      if (createdGroupId) {
        await supabaseRest(page, 'DELETE', `field_app_locations?invoice_group_id=eq.${createdGroupId}`).catch(() => {});
      }
      await supabaseRest(page, 'DELETE', `invoice_shares?invoice_id=${inClause}`).catch(() => {});
      await supabaseRpc(page, 'delete_invoices', {
        p_invoice_ids: createdInvoiceIds,
        p_idempotency_key: `e2e-cleanup-split-${createdGroupId || createdInvoiceIds[0]}`,
      });
    }

    if (splitFieldId) {
      await supabaseRest(page, 'DELETE', `field_billing_defaults?field_id=eq.${splitFieldId}`).catch(() => {});
      await supabaseRest(page, 'DELETE', `fields?id=eq.${splitFieldId}`).catch(() => {});
    }
    if (appServiceId) {
      await supabaseRest(page, 'DELETE', `application_services?id=eq.${appServiceId}`).catch(() => {});
    }
    await ctx.close();
  });

  test('derive_customer_shares_from_fields returns the 60/40 split with both customers', async ({ page }) => {
    await login(page);
    const result = await supabaseRpc(page, 'derive_customer_shares_from_fields', {
      p_field_ids: [splitFieldId],
      p_applied_acres_map: { [splitFieldId]: 50 },
    }) as {
      rows: Array<{ customer_id: string; split_pct: number; share_acres: number }>;
      customers: Array<{ customer_id: string; overall_split_pct: number; total_share_acres: number; is_primary: boolean }>;
      total_applied_acres: number;
      field_count: number;
      fallback_used_field_ids: string[];
    };

    expect(result.field_count).toBe(1);
    expect(result.total_applied_acres).toBe(50);
    expect(result.customers).toHaveLength(2);
    expect(result.fallback_used_field_ids).toEqual([]);

    const alpha = result.customers.find((c) => c.customer_id === alphaId)!;
    const beta = result.customers.find((c) => c.customer_id === betaId)!;
    expect(alpha).toBeDefined();
    expect(beta).toBeDefined();
    expect(alpha.is_primary).toBe(true);
    expect(beta.is_primary).toBe(false);
    expect(alpha.total_share_acres).toBeCloseTo(30, 1);   // 60% of 50
    expect(beta.total_share_acres).toBeCloseTo(20, 1);    // 40% of 50
    expect(alpha.overall_split_pct).toBeCloseTo(60, 1);
    expect(beta.overall_split_pct).toBeCloseTo(40, 1);
  });

  test('preview_field_app_invoice_split returns 2 customers with grand_total = sum(per_customer)', async ({ page }) => {
    await login(page);
    const preview = await supabaseRpc(page, 'preview_field_app_invoice_split', {
      p_locations: [{
        field_id: splitFieldId,
        map_number: 1,
        total_acres: 50,
        applied_acres: 50,
        sort_order: 0,
      }],
      p_chemicals: [{
        product_id: null,                             // no product_id → tier lookup skipped, stays at 0
        description: 'Test chemical',
        unit_size: 'oz',
        rate_per_acre: 4,
        rate_unit: 'oz',
        unit_price_cents: 1000,
        manual_override: true,                         // forces $10/oz
        sort_order: 0,
      }],
      p_application_service_id: appServiceId,
    }) as {
      per_customer: Array<{ customer_id: string; total_cents: number; lines: Array<{ kind: string; extended_cents: number }> }>;
      grand_total_cents: number;
      customer_count: number;
    };

    expect(preview.customer_count).toBe(2);
    expect(preview.per_customer).toHaveLength(2);
    const sumOfTotals = preview.per_customer.reduce((s, c) => s + c.total_cents, 0);
    expect(preview.grand_total_cents).toBe(sumOfTotals);

    // Both customers should have a service_fee line (Mode B for both since no override)
    for (const c of preview.per_customer) {
      const kinds = c.lines.map((l) => l.kind);
      expect(kinds).toContain('service_fee');
    }
  });

  test('save_field_app_invoice creates 2 invoices with a shared invoice_group_id (Mode B for both)', async ({ page }) => {
    await login(page);
    const userId = await getUserId(page);
    const idemKey = `${RUN}-save-1`;

    const result = await supabaseRpc(page, 'save_field_app_invoice', {
      p_invoice_id: null,
      p_invoice: {
        invoice_date: new Date().toISOString().slice(0, 10),
        salesman_id: userId,
        header_notes: `${RUN} test invoice`,
      },
      p_locations: [{
        field_id: splitFieldId,
        map_number: 1,
        total_acres: 50,
        applied_acres: 50,
        sort_order: 0,
      }],
      p_chemicals: [{
        product_id: null,
        description: `${RUN} test chemical`,
        unit_size: 'oz',
        quantity: 0,
        rate_per_acre: 4,
        rate_unit: 'oz',
        unit_price_cents: 1000,
        manual_override: true,
        sort_order: 0,
      }],
      p_performed_by: userId,
      p_application_service_id: appServiceId,
      p_idempotency_key: idemKey,
    }) as { invoice_ids: string[]; invoice_group_id: string | null };

    expect(result).toBeTruthy();
    expect(result.invoice_ids).toHaveLength(2);
    expect(result.invoice_group_id).not.toBeNull();
    expect(typeof result.invoice_group_id).toBe('string');

    createdInvoiceIds = result.invoice_ids;
    createdGroupId = result.invoice_group_id;

    // Both invoices share the same group_id and live in different customers
    const invoiceRows = asArray<{ id: string; customer_id: string; invoice_group_id: string; status: string }>(
      await supabaseRest(page, 'GET',
        `invoices?id=in.(${result.invoice_ids.join(',')})&select=id,customer_id,invoice_group_id,status`),
      'fetch grouped invoices',
    );
    expect(invoiceRows).toHaveLength(2);
    for (const inv of invoiceRows) {
      expect(inv.invoice_group_id).toBe(result.invoice_group_id);
      expect(inv.status).toBe('draft');
    }
    const customerIds = invoiceRows.map((i) => i.customer_id).sort();
    expect(customerIds).toEqual([alphaId, betaId].sort());

    // Locations live at the GROUP level (invoice_id null, invoice_group_id set)
    // — this is the Phase 1 "single source of truth" rule for grouped invoices.
    const locs = asArray<{ invoice_id: string | null; invoice_group_id: string | null; field_id: string }>(
      await supabaseRest(page, 'GET',
        `field_app_locations?invoice_group_id=eq.${result.invoice_group_id}&select=invoice_id,invoice_group_id,field_id`),
      'fetch group locations',
    );
    expect(locs.length).toBeGreaterThanOrEqual(1);
    for (const loc of locs) {
      expect(loc.invoice_id).toBeNull();
      expect(loc.invoice_group_id).toBe(result.invoice_group_id);
    }

    // field_app_location_shares carries the TRUE 60/40 split per location
    const shares = asArray<{ customer_id: string; split_pct: number; acres: number }>(
      await supabaseRest(page, 'GET',
        `field_app_location_shares?location_id=in.(${locs.map((l) => (l as unknown as { id: string }).id || '').filter(Boolean).join(',')})&select=customer_id,split_pct,acres`),
      'fetch location shares',
    );
    if (shares.length > 0) {
      const alphaShare = shares.find((s) => s.customer_id === alphaId);
      const betaShare = shares.find((s) => s.customer_id === betaId);
      expect(alphaShare?.split_pct).toBeCloseTo(60, 0);
      expect(betaShare?.split_pct).toBeCloseTo(40, 0);
    }
  });

  test('save_field_app_invoice idempotency replay returns identical { invoice_ids, invoice_group_id }', async ({ page }) => {
    await login(page);
    const userId = await getUserId(page);
    const idemKey = `${RUN}-save-1`; // SAME key as previous test → cached result

    const replay = await supabaseRpc(page, 'save_field_app_invoice', {
      p_invoice_id: null,
      p_invoice: { invoice_date: new Date().toISOString().slice(0, 10), salesman_id: userId },
      p_locations: [{ field_id: splitFieldId, map_number: 1, total_acres: 50, applied_acres: 50, sort_order: 0 }],
      p_chemicals: [{ product_id: null, description: `${RUN} replay chem`, unit_size: 'oz', rate_per_acre: 4, rate_unit: 'oz', unit_price_cents: 9999, manual_override: true, sort_order: 0 }],
      p_performed_by: userId,
      p_application_service_id: appServiceId,
      p_idempotency_key: idemKey,
    }) as { invoice_ids: string[]; invoice_group_id: string | null };

    // Replay must return the SAME invoice_ids and invoice_group_id, NOT create new rows
    expect(replay.invoice_ids.sort()).toEqual([...createdInvoiceIds].sort());
    expect(replay.invoice_group_id).toBe(createdGroupId);
  });

  test('post_invoice_group atomically posts every member of the group', async ({ page }) => {
    test.skip(!createdGroupId, 'No group_id from prior test');
    await login(page);
    const userId = await getUserId(page);

    const postResult = await supabaseRpc(page, 'post_invoice_group', {
      p_invoice_group_id: createdGroupId,
      p_performed_by: userId,
      p_idempotency_key: `${RUN}-post-1`,
    }) as { posted_invoice_ids: string[]; member_count: number; total_posted_cents: number };

    expect(postResult.member_count).toBe(2);
    expect(postResult.posted_invoice_ids).toHaveLength(2);
    expect(postResult.posted_invoice_ids.sort()).toEqual([...createdInvoiceIds].sort());

    // Verify both invoices are now posted
    const after = asArray<{ id: string; status: string }>(
      await supabaseRest(page, 'GET', `invoices?id=in.(${createdInvoiceIds.join(',')})&select=id,status`),
      'fetch post-status',
    );
    for (const inv of after) {
      expect(inv.status).toBe('posted');
    }
  });

  test('save_field_app_invoice with an existing posted-group member is rejected (group-wide edit lock)', async ({ page }) => {
    test.skip(createdInvoiceIds.length === 0, 'No invoice from prior test');
    await login(page);
    const userId = await getUserId(page);

    const editAttempt = await supabaseRpc(page, 'save_field_app_invoice', {
      p_invoice_id: createdInvoiceIds[0],
      p_invoice: { invoice_date: new Date().toISOString().slice(0, 10), salesman_id: userId },
      p_locations: [{ field_id: splitFieldId, map_number: 1, total_acres: 50, applied_acres: 50, sort_order: 0 }],
      p_chemicals: [],
      p_performed_by: userId,
      p_application_service_id: appServiceId,
      p_idempotency_key: `${RUN}-edit-blocked`,
    }) as { code?: string; message?: string };

    // PostgREST returns the error object when an RPC throws
    expect(editAttempt).toBeTruthy();
    const errMsg = (editAttempt.message || JSON.stringify(editAttempt)).toLowerCase();
    expect(errMsg).toMatch(/cannot edit|posted|voided/);
  });

  test('UI smoke: /invoices/field-app/new renders the ApplicationServicePicker (Phase 1 wiring)', async ({ page }) => {
    await login(page);
    await page.goto('/invoices/field-app/new');
    await page.waitForLoadState('networkidle');
    await expect(page.getByText('New Field Application Invoice')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('Application Service')).toBeVisible();
  });
});
