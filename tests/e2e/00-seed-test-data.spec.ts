/**
 * 00-seed-test-data.spec.ts
 *
 * One-time seeder that creates the fixture data math-* and golive E2E tests
 * need to find in the database (otherwise they skip with "no data").
 *
 * ── How to run ──────────────────────────────────────────────────────────────
 *   npx playwright test tests/e2e/00-seed-test-data.spec.ts
 *
 * Safe to re-run: Step S0 checks whether SEED-2026 customers already exist
 * and calls test.skip() if they do, so subsequent steps never run twice.
 *
 * ── What gets created ────────────────────────────────────────────────────────
 *   Customers  SEED-2026 Customer A (tier 1), SEED-2026 Customer B (tier 3)
 *   Products   Alpha ($50 cost, 30% margin), Beta ($80, 25%), Gamma ($30, 40%)
 *   Inventory  300 units each at "Main Warehouse"
 *   Order A → Invoice A (CS-, 1 line) → Post → partial payment  → IV5
 *   Order B → Invoice B (CS-, 1 line) → Post → full payment     → IV6
 *   Order C → Invoice C (CS-, 3 lines) → Post                   → IV1-IV4, IV12
 *   Order D → Invoice D (CS-, 1 line) → Post → Void             → IV7
 *   Order E → Invoice E (MC-/misc_charge, 1 line) → Post        → IV11
 *   Commission record + commission_payment (unposted)            → CM1-CM8
 *   Quote Q  (1 section, 2 priced items)                        → QP1-QP12
 *
 * ── Which skipped tests this unblocks ────────────────────────────────────────
 *   IV5  partially paid invoice
 *   IV6  fully paid invoice
 *   IV7  voided invoice
 *   IV8  CS- invoice
 *   IV11 MC- invoice
 *   IV12 multi-line invoice (3+ items)
 *   CM1–CM8  commission payments page data
 *   QP tests  quote pricing math tests
 */

import { test } from '@playwright/test';
import { login } from './utils/auth';
import { supabaseRest, supabaseRpc, asArray } from './golive/utils/supabase-helpers';

/* ─── Constants ────────────────────────────────────────────────────────────── */

const TAG   = 'SEED-2026';
const TODAY = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

/* ─── Shared state — filled in by each serial step ────────────────────────── */

const S: {
  userId: string;
  custAId: string; custBId: string;
  prodAlphaId: string; prodBetaId: string; prodGammaId: string;
  orderAId: string;
  invAId: string; invBId: string; invCId: string; invDId: string; invEId: string;
  commId: string;
} = {
  userId: '',
  custAId: '', custBId: '',
  prodAlphaId: '', prodBetaId: '', prodGammaId: '',
  orderAId: '',
  invAId: '', invBId: '', invCId: '', invDId: '', invEId: '',
  commId: '',
};

/* ─── Low-level helpers ────────────────────────────────────────────────────── */

/** Extract the Supabase auth user UUID from localStorage */
async function getUid(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(() => {
    const raw = localStorage.getItem('sb-rhyzpcqhnizqbxphqdkr-auth-token');
    if (!raw) return '';
    try {
      return (JSON.parse(raw) as { user?: { id?: string } })?.user?.id ?? '';
    } catch {
      return '';
    }
  });
}

/** POST to a REST table and return the first inserted row */
async function insert<T extends Record<string, unknown>>(
  page: import('@playwright/test').Page,
  table: string,
  body: Record<string, unknown>,
): Promise<T> {
  const res = await supabaseRest(page, 'POST', table, body);
  const arr = asArray<T>(res, `INSERT ${table}`);
  return arr[0];
}

/** Call an RPC, throw with context if it returns an error shape */
async function rpc(
  page: import('@playwright/test').Page,
  fn: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  const result = await supabaseRpc(page, fn, params);
  // PostgREST error objects have { message, code }
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const r = result as Record<string, unknown>;
    if (r.code || r.message) {
      throw new Error(`RPC ${fn} error: ${r.message ?? JSON.stringify(r)}`);
    }
  }
  return result;
}

/** Fetch total_amount_cents from an invoice row */
async function getInvTotal(
  page: import('@playwright/test').Page,
  invId: string,
): Promise<number> {
  const res = await supabaseRest(
    page, 'GET',
    `invoices?id=eq.${invId}&select=total_amount_cents`,
  );
  const arr = Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
  return Number(arr[0]?.total_amount_cents ?? 0);
}

/* ─── Serial test suite ────────────────────────────────────────────────────── */

test.describe.serial('Seed Test Data', () => {
  test.setTimeout(180_000); // 3 min total; each step can be slow on cold start

  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/');
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
    // Capture user ID once per step (each step gets a fresh page)
    if (!S.userId) {
      S.userId = await getUid(page);
    }
  });

  /* ── S0: Idempotency guard ─────────────────────────────────────────────── */
  test('S0: Skip if seed data already present', async ({ page }) => {
    const res = await supabaseRest(
      page, 'GET',
      `customers?farm_name=like.${TAG}*&select=id,farm_name&limit=1`,
    );
    const arr = Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
    if (arr.length > 0) {
      console.log(`[Seeder] Already seeded — found "${arr[0].farm_name}". Skipping.`);
      test.skip(true, 'Seed data already exists — re-run only after deleting SEED-2026 records');
    }
    console.log('[Seeder] No existing seed data found. Starting seed...');
  });

  /* ── S1: Customers ─────────────────────────────────────────────────────── */
  test('S1: Create seed customers', async ({ page }) => {
    const a = await insert<Record<string, unknown>>(page, 'customers', {
      farm_name: `${TAG} Customer A`,
      assigned_tier: 1,
      is_active: true,
    });
    S.custAId = a.id as string;

    const b = await insert<Record<string, unknown>>(page, 'customers', {
      farm_name: `${TAG} Customer B`,
      assigned_tier: 3,
      is_active: true,
    });
    S.custBId = b.id as string;

    console.log(`[Seeder] Customers: A=${S.custAId}  B=${S.custBId}`);
  });

  /* ── S2: Products + Inventory ──────────────────────────────────────────── */
  test('S2: Create seed products and inventory', async ({ page }) => {
    if (!S.custAId) test.skip(true, 'S1 did not run');

    const makeProduct = async (name: string, cost: number, margin: number): Promise<string> => {
      const tier1 = +(cost / (1 - margin)).toFixed(2);
      const tier2 = +(cost / (1 - margin * 0.90)).toFixed(2);
      const tier3 = +(cost / (1 - margin * 0.80)).toFixed(2);

      const row = await insert<Record<string, unknown>>(page, 'products', {
        product_name: name,
        sku: name.replace(/[^A-Za-z0-9]/g, '').slice(0, 20),
        current_cost: cost,
        tier1_price:  tier1,
        tier2_price:  tier2,
        tier3_price:  tier3,
        tier1_margin: +margin.toFixed(4),
        tier2_margin: +(margin * 0.90).toFixed(4),
        tier3_margin: +(margin * 0.80).toFixed(4),
        is_active: true,
      });
      const prodId = row.id as string;

      // Seed inventory
      await insert(page, 'inventory', {
        product_id: prodId,
        location: 'Main Warehouse',
        quantity_available: 300,
        quantity_prebooked: 0,
      });

      return prodId;
    };

    S.prodAlphaId = await makeProduct(`${TAG} Alpha`, 50.00, 0.30);
    S.prodBetaId  = await makeProduct(`${TAG} Beta`,  80.00, 0.25);
    S.prodGammaId = await makeProduct(`${TAG} Gamma`, 30.00, 0.40);

    console.log(
      `[Seeder] Products: Alpha=${S.prodAlphaId}  Beta=${S.prodBetaId}  Gamma=${S.prodGammaId}`,
    );
  });

  /* ── S3: Create 5 orders and their invoices ────────────────────────────── */
  test('S3: Create orders and invoices', async ({ page }) => {
    if (!S.prodAlphaId) test.skip(true, 'S2 did not run');

    // Helper: create_direct_order → create_invoice_from_order
    const makeOrderAndInvoice = async (
      custId: string,
      orderName: string,
      items: Array<{ product_id: string; product_name: string; quantity: number; price_per_unit: number }>,
      invoiceType = 'chemical_sale',
    ): Promise<{ orderId: string; invId: string }> => {
      const orderRes = await rpc(page, 'create_direct_order', {
        p_customer_id: custId,
        p_order_date:  TODAY,
        p_order_name:  orderName,
        p_items:       items,
      }) as Record<string, unknown>;

      const orderId = orderRes.order_id as string;
      if (!orderId) throw new Error(`No order_id in: ${JSON.stringify(orderRes)}`);

      const invResult = await rpc(page, 'create_invoice_from_order', {
        p_order_id:    orderId,
        p_invoice_type: invoiceType,
      });

      // Returns a raw UUID string
      const invId = typeof invResult === 'string' ? invResult : String(invResult);
      if (!invId || invId.length < 10) {
        throw new Error(`create_invoice_from_order returned: ${JSON.stringify(invResult)}`);
      }

      return { orderId, invId };
    };

    // Order A: 1 item — will get partial payment (feeds IV5)
    const a = await makeOrderAndInvoice(S.custAId, `${TAG} Order A`, [
      { product_id: S.prodAlphaId, product_name: `${TAG} Alpha`, quantity: 5, price_per_unit: 75 },
    ]);
    S.orderAId = a.orderId;
    S.invAId   = a.invId;

    // Order B: 1 item — will get full payment (feeds IV6)
    const b = await makeOrderAndInvoice(S.custBId, `${TAG} Order B`, [
      { product_id: S.prodBetaId, product_name: `${TAG} Beta`, quantity: 3, price_per_unit: 110 },
    ]);
    S.invBId = b.invId;

    // Order C: 3 items — multi-line invoice (feeds IV1-IV4, IV12)
    const c = await makeOrderAndInvoice(S.custAId, `${TAG} Order C`, [
      { product_id: S.prodAlphaId, product_name: `${TAG} Alpha`, quantity: 10, price_per_unit: 75 },
      { product_id: S.prodBetaId,  product_name: `${TAG} Beta`,  quantity: 4,  price_per_unit: 110 },
      { product_id: S.prodGammaId, product_name: `${TAG} Gamma`, quantity: 20, price_per_unit: 50 },
    ]);
    S.invCId = c.invId;

    // Order D: 1 item — will be voided (feeds IV7)
    const d = await makeOrderAndInvoice(S.custBId, `${TAG} Order D`, [
      { product_id: S.prodGammaId, product_name: `${TAG} Gamma`, quantity: 2, price_per_unit: 50 },
    ]);
    S.invDId = d.invId;

    // Order E: misc_charge invoice type → MC- prefix (feeds IV11)
    const e = await makeOrderAndInvoice(S.custAId, `${TAG} Order E`, [
      { product_id: S.prodAlphaId, product_name: `${TAG} Alpha`, quantity: 2, price_per_unit: 75 },
    ], 'misc_charge');
    S.invEId = e.invId;

    console.log(
      `[Seeder] Orders/Invoices:`,
      `A=${S.invAId}  B=${S.invBId}  C=${S.invCId}  D=${S.invDId}  E=${S.invEId}`,
    );
  });

  /* ── S4: Post all invoices ─────────────────────────────────────────────── */
  test('S4: Post all invoices', async ({ page }) => {
    if (!S.invAId) test.skip(true, 'S3 did not run');

    const invoices: Array<[string, string]> = [
      ['A', S.invAId], ['B', S.invBId], ['C', S.invCId], ['D', S.invDId], ['E', S.invEId],
    ];

    for (const [label, invId] of invoices) {
      await rpc(page, 'post_invoice', { p_invoice_id: invId });
      console.log(`[Seeder] Posted invoice ${label} (${invId})`);
    }
  });

  /* ── S5: Payments and void ─────────────────────────────────────────────── */
  test('S5: Record payments and void invoice D', async ({ page }) => {
    if (!S.invAId) test.skip(true, 'S4 did not run');

    // Invoice A — partial payment (≈60% of total)
    const totalA = await getInvTotal(page, S.invAId);
    if (totalA > 0) {
      const partialCents = Math.max(1, Math.floor(totalA * 0.6));
      await rpc(page, 'allocate_payment', {
        p_customer_id:      S.custAId,
        p_total_cents:      partialCents,
        p_payment_method:   'check',
        p_reference_number: `${TAG}-PARTIAL`,
        p_payment_date:     TODAY,
        p_allocations:      [{ invoice_id: S.invAId, amount_cents: partialCents }],
        p_performed_by:     S.userId,
        p_idempotency_key:  `${TAG}-PARTIAL-${S.invAId}`,
      });
      console.log(
        `[Seeder] Partial payment $${(partialCents / 100).toFixed(2)}` +
        ` on Invoice A (total $${(totalA / 100).toFixed(2)})`,
      );
    } else {
      console.warn('[Seeder] Invoice A total_amount_cents = 0 — check order/invoice creation');
    }

    // Invoice B — full payment
    const totalB = await getInvTotal(page, S.invBId);
    if (totalB > 0) {
      await rpc(page, 'allocate_payment', {
        p_customer_id:      S.custBId,
        p_total_cents:      totalB,
        p_payment_method:   'check',
        p_reference_number: `${TAG}-FULL`,
        p_payment_date:     TODAY,
        p_allocations:      [{ invoice_id: S.invBId, amount_cents: totalB }],
        p_performed_by:     S.userId,
        p_idempotency_key:  `${TAG}-FULL-${S.invBId}`,
      });
      console.log(`[Seeder] Full payment $${(totalB / 100).toFixed(2)} on Invoice B`);
    } else {
      console.warn('[Seeder] Invoice B total_amount_cents = 0');
    }

    // Invoice D — void
    // Pass p_idempotency_key explicitly to disambiguate the two overloads of
    // void_invoice that exist in the DB (PostgREST needs a unique match).
    await rpc(page, 'void_invoice', {
      p_invoice_id:       S.invDId,
      p_void_reason:      `${TAG} seeder: created for automated testing`,
      p_idempotency_key:  null,
    });
    console.log('[Seeder] Voided Invoice D');
  });

  /* ── S6: Commission record and payment ─────────────────────────────────── */
  test('S6: Create commission record and payment', async ({ page }) => {
    if (!S.orderAId || !S.custAId) test.skip(true, 'S3 did not run');
    if (!S.userId) { S.userId = await getUid(page); }

    // Insert a commissions row tied to Order A
    const commRow = await insert<Record<string, unknown>>(page, 'commissions', {
      order_id:          S.orderAId,
      customer_id:       S.custAId,
      recipient:         `${TAG} Sales Rep`,
      split_percentage:  10,
      commission_amount: 187.50,   // 10% of ~$1875 order A total
      order_profit:      562.50,
      order_date:        TODAY,
      status:            'pending',
    });
    S.commId = commRow.id as string;
    console.log(`[Seeder] Commission record: ${S.commId}`);

    // Generate a unique payment number (seeder run timestamp suffix)
    const payNum = `${TAG}-CP-${Date.now().toString(36).toUpperCase()}`;

    // Insert commission_payments row (direct insert — bypasses period check)
    const cpRow = await insert<Record<string, unknown>>(page, 'commission_payments', {
      payment_number:   payNum,
      recipient_id:     S.userId,   // admin user (mason@croprxsolutions.com)
      total_amount:     187.50,
      status:           'unposted',
      payment_method:   'check',
      reference_number: `${TAG}-REF`,
      payment_date:     TODAY,
      notes:            `${TAG} seeder commission payment`,
      created_by:       S.userId,
    });
    const cpId = cpRow.id as string;
    console.log(`[Seeder] Commission payment: ${cpId}  (number: ${payNum})`);

    // Link commission_payment_items
    await insert(page, 'commission_payment_items', {
      commission_payment_id: cpId,
      commission_id:         S.commId,
      amount:                187.50,
    });
    console.log('[Seeder] Commission payment items linked');
  });

  /* ── S7: Quote with priced line items ──────────────────────────────────── */
  test('S7: Create seed quote with priced sections', async ({ page }) => {
    if (!S.prodAlphaId || !S.custAId) test.skip(true, 'S2 did not run');
    if (!S.userId) { S.userId = await getUid(page); }

    const sections = [
      {
        section_name: `${TAG} Field A`,
        sort_order: 0,
        section_notes: 'Seeder test section',
        items: [
          {
            // save_quote recalculates price_per_unit = cost / (1 - margin) = 50 / 0.70 = 71.43
            // calc_mode must be 'units_direct' so total_units_needed is taken from the payload
            // (not re-derived from actual_rate × acres, which would be 0 with no actual_rate).
            product_id:        S.prodAlphaId,
            sort_order:        0,
            calc_mode:         'units_direct',
            price_per_unit:    71.43,
            current_cost:      50.00,
            acres:             100,
            total_units_needed: 100,
            total_price:       7143.00,
            profit:            2143.00,
            net_margin:        0.30,
            suggested_rate:    '1 qt/acre',
            rate_unit:         'qt',
          },
          {
            // save_quote recalculates price_per_unit = 80 / (1 - 0.25) = 80 / 0.75 = 106.67
            product_id:        S.prodBetaId,
            sort_order:        1,
            calc_mode:         'units_direct',
            price_per_unit:    106.67,
            current_cost:      80.00,
            acres:             50,
            total_units_needed: 50,
            total_price:       5333.50,
            profit:            1333.50,
            net_margin:        0.25,
            suggested_rate:    '1 pt/acre',
            rate_unit:         'pt',
          },
        ],
      },
    ];

    // generate_quote_number() mints the next Q-YYYY-NNNN from the DB sequence
    const quoteNum = await rpc(page, 'generate_quote_number', {}) as string;
    if (!quoteNum || !String(quoteNum).startsWith('Q-')) {
      throw new Error(`generate_quote_number returned unexpected: ${JSON.stringify(quoteNum)}`);
    }

    const quotePayload = {
      quote_number: quoteNum,
      customer_id:  S.custAId,
      tier:         1,
      status:       'draft',
      valid_days:   30,
      header_notes: `${TAG} seeder quote`,
    };

    const result = await rpc(page, 'save_quote', {
      p_quote_id:      null,
      p_quote_payload: quotePayload,
      p_sections:      sections,
      p_performed_by:  S.userId,
    });

    console.log(`[Seeder] Quote created: ${JSON.stringify(result)}`);
  });

  /* ── Summary ───────────────────────────────────────────────────────────── */
  test('S8: Seed complete — summary', async () => {
    console.log('\n[Seeder] ✅ Seed complete. The following data now exists:');
    console.log(`  Customers : ${S.custAId}  ${S.custBId}`);
    console.log(`  Products  : Alpha=${S.prodAlphaId}  Beta=${S.prodBetaId}  Gamma=${S.prodGammaId}`);
    console.log(`  Invoices  : A=${S.invAId} (partial)  B=${S.invBId} (paid)  C=${S.invCId} (multi-line)`);
    console.log(`              D=${S.invDId} (voided)   E=${S.invEId} (MC-)`);
    console.log(`  Commission: record=${S.commId}`);
    console.log('\n  Re-run the full suite:');
    console.log('    npx playwright test');
  });
});
