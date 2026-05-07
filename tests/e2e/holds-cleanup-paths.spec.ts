/**
 * holds-cleanup-paths.spec.ts — Phase 4 P4-9 verification test
 *
 * Verifies that two different quote-cancellation paths leave
 * `inventory.quantity_available` in the same end-state — i.e. that the
 * trigger `release_holds_on_quote_status_change` and the RPC `cancel_order`
 * don't double-count or under-count when releasing planned-quote holds.
 *
 * ── Path A: planned quote → accepted → order cancelled ────────────────────
 *   1. save_quote(is_planned=true) creates a draft quote
 *   2. create_planned_holds inserts inventory_holds rows linked via source_id
 *   3. quote.status flipped draft→sent (allowed by state machine)
 *   4. convert_quote_to_order flips sent→accepted (trigger deactivates holds
 *      WITHOUT restoring inventory; convert applies prebook instead)
 *   5. cancel_order releases prebook AND scans for active holds (none left)
 *   END STATE: inventory.quantity_available should equal the starting value
 *
 * ── Path B: planned quote → declined (no convert) ─────────────────────────
 *   1. save_quote(is_planned=true) creates a draft quote
 *   2. create_planned_holds inserts inventory_holds rows
 *   3. quote.status flipped draft→sent→declined
 *   4. Trigger fires: deactivates holds AND restores inventory
 *   END STATE: inventory.quantity_available should equal the starting value
 *
 * Both paths MUST end at the same number — because neither path actually
 * moved any physical stock. If the two paths disagree, the audit's P4-9
 * concern is real and there's a code drift between cancel_order and the
 * trigger that needs reconciling.
 *
 * Audit reference: docs/audits/2026-05-04-phase-4-inventory-purchasing-audit.md (P4-9)
 */
import { test, expect, Page } from '@playwright/test';
import { login } from './utils/auth';
import { supabaseRest, supabaseRpc, asArray } from './golive/utils/supabase-helpers';
import { E2E_PREFIX, TEST_CUSTOMER_A, TEST_PRODUCT_ALPHA, runId } from './fixtures/e2e-constants';

const RUN = runId();
const HOLD_QTY = 7;

async function getUserId(page: Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sb-rhyzpcqhnizqbxphqdkr-auth-token');
    if (!raw) return '00000000-0000-0000-0000-000000000000';
    try {
      return JSON.parse(raw)?.user?.id || '00000000-0000-0000-0000-000000000000';
    } catch {
      return '00000000-0000-0000-0000-000000000000';
    }
  });
}

async function fetchOne<T extends Record<string, unknown>>(
  page: Page,
  path: string,
  context: string,
): Promise<T> {
  const result = await supabaseRest(page, 'GET', path);
  const arr = asArray<T>(result, context);
  if (arr.length === 0) {
    throw new Error(`Expected at least one row from ${context}`);
  }
  return arr[0];
}

async function getInventoryAvailable(page: Page, productId: string): Promise<number> {
  const inv = await fetchOne<{ quantity_available: number }>(
    page,
    `inventory?select=quantity_available&product_id=eq.${productId}&location=eq.${encodeURIComponent('Main Warehouse')}`,
    `inventory for product ${productId}`,
  );
  return inv.quantity_available;
}

async function setupPlannedQuote(
  page: Page,
  customerId: string,
  productId: string,
  userId: string,
  label: string,
): Promise<{ quoteId: string }> {
  // Insert quote (draft, is_planned=true)
  const quoteRows = await supabaseRest(page, 'POST', 'quotes', {
    quote_number: `${E2E_PREFIX} HOLD-${label}-${RUN}`,
    customer_id: customerId,
    created_by: userId,
    tier: 1,
    status: 'draft',
    is_planned: true,
    total_price: 0,
    total_cost: 0,
    total_profit: 0,
    total_margin_pct: 0,
    valid_days: 30,
  });
  const quoteId = (asArray(quoteRows, 'new quote')[0] as Record<string, unknown>).id as string;

  // Section + item so create_planned_holds has something to iterate
  const sectionRows = await supabaseRest(page, 'POST', 'quote_sections', {
    quote_id: quoteId,
    section_name: `${E2E_PREFIX} HoldTest-${label}`,
    sort_order: 0,
    needed_by_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
  });
  const sectionId = (asArray(sectionRows, 'new section')[0] as Record<string, unknown>).id as string;

  await supabaseRest(page, 'POST', 'quote_items', {
    quote_id: quoteId,
    section_id: sectionId,
    product_id: productId,
    sort_order: 0,
    price_per_unit: 65,
    current_cost: 50,
    actual_rate: 1,
    rate_unit: 'oz',
    acres: HOLD_QTY,
    total_units_needed: HOLD_QTY,
    unit_size: 'gal',
    profit: HOLD_QTY * 15,
    total_price: HOLD_QTY * 65,
    net_margin: 23.07,
    calc_mode: 'units_direct',
    price_unit: 'unit',
  });

  // Create the planned hold via the production RPC
  await supabaseRpc(page, 'create_planned_holds', {
    p_quote_id: quoteId,
    p_performed_by: userId,
  });

  return { quoteId };
}

async function getActiveHoldCount(page: Page, quoteId: string): Promise<number> {
  const holds = await supabaseRest(
    page,
    'GET',
    `inventory_holds?select=id&source_id=eq.${quoteId}&is_active=eq.true`,
  );
  return asArray(holds, 'active holds').length;
}

test.describe.serial('P4-9: holds-cleanup paths', () => {
  let customerId: string;
  let productId: string;
  let userId: string;

  test.beforeAll(async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await login(page);

    userId = await getUserId(page);

    const customer = await fetchOne<{ id: string }>(
      page,
      `customers?select=id&farm_name=eq.${encodeURIComponent(TEST_CUSTOMER_A.farm_name)}&limit=1`,
      'TEST_CUSTOMER_A lookup',
    );
    customerId = customer.id;

    const product = await fetchOne<{ id: string }>(
      page,
      `products?select=id&product_name=eq.${encodeURIComponent(TEST_PRODUCT_ALPHA.product_name)}&limit=1`,
      'TEST_PRODUCT_ALPHA lookup',
    );
    productId = product.id;

    await ctx.close();
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('Path A: planned quote → accept → cancel order ends at start qty', async ({ page }) => {
    const startQty = await getInventoryAvailable(page, productId);

    const { quoteId } = await setupPlannedQuote(page, customerId, productId, userId, `A-${RUN}`);
    expect(await getActiveHoldCount(page, quoteId)).toBe(1);

    // draft → sent (allowed by state machine without admin override)
    await supabaseRest(page, 'PATCH', `quotes?id=eq.${quoteId}`, { status: 'sent' });

    // Convert flips sent → accepted: trigger deactivates the hold without restoring
    // inventory; convert applies prebook in its place.
    const convertResult = await supabaseRpc(page, 'convert_quote_to_order', {
      p_quote_id: quoteId,
      p_performed_by: userId,
    });
    const convert = convertResult as Record<string, unknown>;
    expect(convert.status).toBe('created');
    const orderId = convert.order_id as string;
    expect(orderId).toBeTruthy();

    // Hold should be inactive after the accepted-status trigger fired
    expect(await getActiveHoldCount(page, quoteId)).toBe(0);

    // Cancel the order — releases prebook, scans for active holds (none left)
    const cancelResult = await supabaseRpc(page, 'cancel_order', {
      p_order_id: orderId,
      p_performed_by: userId,
    });
    expect((cancelResult as Record<string, unknown>).status).toBe('cancelled');

    const endQty = await getInventoryAvailable(page, productId);
    expect(endQty).toBe(startQty);
  });

  test('Path B: planned quote → decline (no convert) ends at start qty', async ({ page }) => {
    const startQty = await getInventoryAvailable(page, productId);

    const { quoteId } = await setupPlannedQuote(page, customerId, productId, userId, `B-${RUN}`);
    expect(await getActiveHoldCount(page, quoteId)).toBe(1);

    // draft → sent → declined. The sent→declined transition fires
    // release_holds_on_quote_status_change which deactivates holds AND
    // restores inventory.quantity_available.
    await supabaseRest(page, 'PATCH', `quotes?id=eq.${quoteId}`, { status: 'sent' });
    await supabaseRest(page, 'PATCH', `quotes?id=eq.${quoteId}`, { status: 'declined' });

    expect(await getActiveHoldCount(page, quoteId)).toBe(0);

    const endQty = await getInventoryAvailable(page, productId);
    expect(endQty).toBe(startQty);
  });
});
