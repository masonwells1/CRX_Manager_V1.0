/**
 * Global Teardown — Delete ALL E2E test data after the suite finishes.
 *
 * Runs once after the entire Playwright test suite.
 * Deletes every row where the name column starts with "[E2E]".
 *
 * Deletion order respects foreign key constraints (children first).
 *
 * ── IMPORTANT ────────────────────────────────────────────────────────────
 * This is why ALL test entities MUST use the E2E_PREFIX in their names.
 * If they don't, they won't get cleaned up and will pollute production.
 */

import { E2E_PREFIX } from './e2e-constants';

const SUPABASE_URL = 'https://rhyzpcqhnizqbxphqdkr.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoeXpwY3Fobml6cWJ4cGhxZGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTM2NDAsImV4cCI6MjA4NTk2OTY0MH0.WR0vAi_KeGF0OoJ8_dFH7uW6ael9M5xnm6OUo2IZy7U';

async function getAuthToken(): Promise<string> {
  const email = process.env.E2E_TEST_EMAIL || 'mason@croprxsolutions.com';
  const password = process.env.E2E_TEST_PASSWORD || 'Mwells0413';

  const resp = await fetch(
    `${SUPABASE_URL}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        apikey: ANON_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    },
  );

  const data = await resp.json();
  if (!data.access_token) {
    throw new Error(`Auth failed: ${JSON.stringify(data)}`);
  }
  return data.access_token;
}

/**
 * Delete rows from a table matching a name prefix via REST API.
 * Returns the count of deleted rows.
 */
async function deleteByPrefix(
  token: string,
  table: string,
  nameCol: string,
  prefix: string,
): Promise<number> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${nameCol}=like.${encodeURIComponent(prefix + '*')}`,
    {
      method: 'DELETE',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
    },
  );

  const text = await resp.text();
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Delete rows by a foreign key reference to parent IDs.
 */
async function deleteByFk(
  token: string,
  table: string,
  fkCol: string,
  parentIds: string[],
): Promise<number> {
  if (parentIds.length === 0) return 0;

  // PostgREST uses `in.(val1,val2,...)` syntax
  const inClause = `in.(${parentIds.join(',')})`;

  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${fkCol}=${inClause}`,
    {
      method: 'DELETE',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
    },
  );

  const text = await resp.text();
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows) ? rows.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Get IDs from a table matching a name prefix.
 */
async function getIds(
  token: string,
  table: string,
  nameCol: string,
  prefix: string,
): Promise<string[]> {
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/${table}?${nameCol}=like.${encodeURIComponent(prefix + '*')}&select=id`,
    {
      method: 'GET',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    },
  );

  const text = await resp.text();
  try {
    const rows = JSON.parse(text);
    return Array.isArray(rows)
      ? rows.map((r: { id: string }) => r.id)
      : [];
  } catch {
    return [];
  }
}

/**
 * Main teardown function — called by Playwright globalTeardown.
 *
 * Deletion order (children → parents):
 *   1. Transactional leaf tables (payment items, line items, etc.)
 *   2. Transactional parent tables (payments, invoices, deliveries, orders)
 *   3. Entity tables (customers, products, vendors)
 */
export default async function teardownFixtures(): Promise<void> {
  console.log('\n🧹 E2E Teardown: Cleaning up test data...\n');

  const token = await getAuthToken();

  // ── Collect parent IDs first ──
  const customerIds = await getIds(token, 'customers', 'farm_name', E2E_PREFIX);
  const productIds = await getIds(token, 'products', 'product_name', E2E_PREFIX);
  const vendorIds = await getIds(token, 'vendors', 'name', E2E_PREFIX);

  // Get order/invoice/delivery/PO IDs linked to test customers
  const getLinkedIds = async (table: string, fkCol: string, parentIds: string[]): Promise<string[]> => {
    if (parentIds.length === 0) return [];
    const inClause = `in.(${parentIds.join(',')})`;
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?${fkCol}=${inClause}&select=id`,
      {
        method: 'GET',
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      },
    );
    const text = await resp.text();
    try {
      const rows = JSON.parse(text);
      return Array.isArray(rows) ? rows.map((r: { id: string }) => r.id) : [];
    } catch {
      return [];
    }
  };

  const orderIds = await getLinkedIds('orders', 'customer_id', customerIds);
  const invoiceIds = await getLinkedIds('invoices', 'customer_id', customerIds);
  const deliveryIds = await getLinkedIds('deliveries', 'customer_id', customerIds);
  const quoteIds = await getLinkedIds('quotes', 'customer_id', customerIds);
  const poIds = await getLinkedIds('purchase_orders', 'vendor_id', vendorIds);
  const vendorBillIds = await getLinkedIds('vendor_bills', 'vendor_id', vendorIds);
  const commissionIds = await getLinkedIds('commissions', 'customer_id', customerIds);

  let totalDeleted = 0;
  const del = async (label: string, fn: () => Promise<number>) => {
    const count = await fn();
    if (count > 0) {
      console.log(`  - ${label}: ${count} rows`);
      totalDeleted += count;
    }
  };

  // ── Phase 1: Leaf tables ──
  console.log('Phase 1: Leaf tables...');
  await del('commission_payment_items', () => deleteByFk(token, 'commission_payment_items', 'commission_id', commissionIds));
  await del('write_offs', () => deleteByFk(token, 'write_offs', 'invoice_id', invoiceIds));
  await del('prepay_applications', () => deleteByFk(token, 'prepay_applications', 'invoice_id', invoiceIds));
  await del('invoice_items', () => deleteByFk(token, 'invoice_items', 'invoice_id', invoiceIds));
  await del('invoice_shares', () => deleteByFk(token, 'invoice_shares', 'invoice_id', invoiceIds));
  await del('invoice_line_allocations', () => deleteByFk(token, 'invoice_line_allocations', 'invoice_id', invoiceIds));
  await del('rup_sales_records (invoice)', () => deleteByFk(token, 'rup_sales_records', 'invoice_id', invoiceIds));
  await del('delivery_items', () => deleteByFk(token, 'delivery_items', 'delivery_id', deliveryIds));
  await del('delivery_photos', () => deleteByFk(token, 'delivery_photos', 'delivery_id', deliveryIds));
  await del('delivery_remainders', () => deleteByFk(token, 'delivery_remainders', 'original_delivery_id', deliveryIds));
  await del('order_items', () => deleteByFk(token, 'order_items', 'order_id', orderIds));
  await del('order_shares', () => deleteByFk(token, 'order_shares', 'order_id', orderIds));
  await del('quote_items', () => deleteByFk(token, 'quote_items', 'quote_id', quoteIds));
  await del('quote_sections', () => deleteByFk(token, 'quote_sections', 'quote_id', quoteIds));
  await del('quote_versions', () => deleteByFk(token, 'quote_versions', 'quote_id', quoteIds));
  await del('purchase_order_items', () => deleteByFk(token, 'purchase_order_items', 'purchase_order_id', poIds));
  await del('receiving_records', () => deleteByFk(token, 'receiving_records', 'purchase_order_id', poIds));
  await del('vendor_payments', () => deleteByFk(token, 'vendor_payments', 'vendor_bill_id', vendorBillIds));
  await del('returns', () => deleteByFk(token, 'returns', 'order_id', orderIds));
  await del('rebate_claims', () => deleteByFk(token, 'rebate_claims', 'order_id', orderIds));

  // ── Phase 2: Customer/product child tables ──
  console.log('Phase 2: Customer/product child tables...');
  await del('activity_feed', () => deleteByFk(token, 'activity_feed', 'customer_id', customerIds));
  await del('allocation_sets', () => deleteByFk(token, 'allocation_sets', 'customer_id', customerIds));
  await del('ar_reminder_tracking', () => deleteByFk(token, 'ar_reminder_tracking', 'customer_id', customerIds));
  await del('customer_addresses', () => deleteByFk(token, 'customer_addresses', 'customer_id', customerIds));
  await del('email_log', () => deleteByFk(token, 'email_log', 'customer_id', customerIds));
  await del('fields', () => deleteByFk(token, 'fields', 'customer_id', customerIds));
  await del('prepay_credits', () => deleteByFk(token, 'prepay_credits', 'customer_id', customerIds));
  await del('inventory_holds', () => deleteByFk(token, 'inventory_holds', 'customer_id', customerIds));
  await del('inventory (product)', () => deleteByFk(token, 'inventory', 'product_id', productIds));
  await del('inventory_transactions (product)', () => deleteByFk(token, 'inventory_transactions', 'product_id', productIds));
  await del('cost_history', () => deleteByFk(token, 'cost_history', 'product_id', productIds));
  // idempotency_keys has no entity_id column — keys expire automatically via DB TTL
  // If test cleanup is needed, use: DELETE FROM idempotency_keys WHERE operation LIKE 'test_%'

  // ── Phase 3: Transactional parent tables ──
  console.log('Phase 3: Transactional tables...');
  await del('payments', () => deleteByFk(token, 'payments', 'customer_id', customerIds));
  await del('commissions', () => deleteByFk(token, 'commissions', 'customer_id', customerIds));
  await del('invoices', () => deleteByFk(token, 'invoices', 'customer_id', customerIds));
  await del('deliveries', () => deleteByFk(token, 'deliveries', 'customer_id', customerIds));
  await del('orders', () => deleteByFk(token, 'orders', 'customer_id', customerIds));
  await del('quotes', () => deleteByFk(token, 'quotes', 'customer_id', customerIds));
  await del('vendor_bills', () => deleteByFk(token, 'vendor_bills', 'vendor_id', vendorIds));
  await del('purchase_orders', () => deleteByFk(token, 'purchase_orders', 'vendor_id', vendorIds));

  // ── Phase 4: Entity tables ──
  console.log('Phase 4: Entity tables...');
  await del('products', () => deleteByPrefix(token, 'products', 'product_name', E2E_PREFIX));
  await del('vendors', () => deleteByPrefix(token, 'vendors', 'name', E2E_PREFIX));
  // Customers last (most FK references)
  // Clear self-references first
  if (customerIds.length > 0) {
    const inClause = `in.(${customerIds.join(',')})`;
    await fetch(
      `${SUPABASE_URL}/rest/v1/customers?parent_customer_id=${inClause}`,
      {
        method: 'PATCH',
        headers: {
          apikey: ANON_KEY,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ parent_customer_id: null }),
      },
    );
  }
  await del('customers', () => deleteByPrefix(token, 'customers', 'farm_name', E2E_PREFIX));

  // ── Phase 5: Soft-delete team notes ──
  console.log('Phase 5: Team notes (soft-delete)...');
  // team_notes can't be hard-deleted via RLS, so soft-delete
  const now = new Date().toISOString();
  const notesResp = await fetch(
    `${SUPABASE_URL}/rest/v1/team_notes?title=like.${encodeURIComponent(E2E_PREFIX + '*')}&deleted_at=is.null`,
    {
      method: 'PATCH',
      headers: {
        apikey: ANON_KEY,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'return=representation',
      },
      body: JSON.stringify({ deleted_at: now }),
    },
  );
  try {
    const notes = JSON.parse(await notesResp.text());
    if (Array.isArray(notes) && notes.length > 0) {
      console.log(`  - team_notes (soft-deleted): ${notes.length} rows`);
      totalDeleted += notes.length;
    }
  } catch {
    // ignore
  }

  console.log(`\n✅ E2E Teardown complete — ${totalDeleted} rows removed\n`);
}
