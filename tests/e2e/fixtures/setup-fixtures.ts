/**
 * Global Setup — Create shared E2E test fixtures if they don't exist.
 *
 * Runs once before the entire Playwright test suite.
 * Idempotent: checks for existing fixtures before inserting.
 *
 * Uses the Supabase REST API directly (no browser context needed).
 */

import {
  TEST_CUSTOMER_A,
  TEST_CUSTOMER_B,
  TEST_PRODUCT_ALPHA,
  TEST_PRODUCT_BETA,
  TEST_PRODUCT_GAMMA,
  TEST_VENDOR,
} from './e2e-constants';

const SUPABASE_URL = 'https://rhyzpcqhnizqbxphqdkr.supabase.co';
const ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJoeXpwY3Fobml6cWJ4cGhxZGtyIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzAzOTM2NDAsImV4cCI6MjA4NTk2OTY0MH0.WR0vAi_KeGF0OoJ8_dFH7uW6ael9M5xnm6OUo2IZy7U';

/**
 * Get a JWT token by signing in with the E2E test account.
 */
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
 * Supabase REST helper (runs outside browser context).
 */
async function rest(
  token: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: ANON_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await resp.text();
  if (!resp.ok) {
    throw new Error(`REST ${method} ${path} failed (${resp.status}): ${text}`);
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error(`REST ${method} ${path} failed to parse: ${text}`);
  }
}

/**
 * Create fixture if it doesn't exist. Returns the row.
 */
async function ensureFixture(
  token: string,
  table: string,
  nameCol: string,
  data: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const nameValue = data[nameCol] as string;
  const existing = await rest(
    token,
    'GET',
    `${table}?${nameCol}=eq.${encodeURIComponent(nameValue)}&select=*&limit=1`,
  );

  if (existing.length > 0) {
    console.log(`  ✓ ${nameValue} already exists`);
    return existing[0] as Record<string, unknown>;
  }

  const created = await rest(token, 'POST', table, data);
  console.log(`  + Created ${nameValue}`);
  return created[0] as Record<string, unknown>;
}

/**
 * Main setup function — called by Playwright globalSetup.
 */
export default async function setupFixtures(): Promise<void> {
  console.log('\n🔧 E2E Setup: Creating shared test fixtures...\n');

  const token = await getAuthToken();

  // ── Customers ──
  console.log('Customers:');
  await ensureFixture(token, 'customers', 'farm_name', TEST_CUSTOMER_A);
  await ensureFixture(token, 'customers', 'farm_name', TEST_CUSTOMER_B);

  // ── Products ──
  console.log('Products:');
  await ensureFixture(token, 'products', 'product_name', TEST_PRODUCT_ALPHA);
  await ensureFixture(token, 'products', 'product_name', TEST_PRODUCT_BETA);
  await ensureFixture(token, 'products', 'product_name', TEST_PRODUCT_GAMMA);

  // ── Vendor ──
  console.log('Vendor:');
  await ensureFixture(token, 'vendors', 'name', TEST_VENDOR);

  // ── Inventory (seed stock for test products) ──
  console.log('Inventory:');
  // Fetch each E2E product individually to avoid bracket encoding issues
  const productNames = [
    TEST_PRODUCT_ALPHA.product_name,
    TEST_PRODUCT_BETA.product_name,
    TEST_PRODUCT_GAMMA.product_name,
  ];
  const products: Array<{ id: string; product_name: string }> = [];
  for (const pName of productNames) {
    const rows = await rest(
      token,
      'GET',
      `products?product_name=eq.${encodeURIComponent(pName)}&select=id,product_name`,
    );
    if (rows.length > 0) {
      products.push(rows[0] as { id: string; product_name: string });
    }
  }
  for (const prod of products as Array<{ id: string; product_name: string }>) {
    const inv = await rest(
      token,
      'GET',
      `inventory?product_id=eq.${prod.id}&select=id&limit=1`,
    );
    if (inv.length === 0) {
      await rest(token, 'POST', 'inventory', {
        product_id: prod.id,
        location: 'Main Warehouse',
        quantity_available: 500,
        quantity_prebooked: 0,
        quantity_on_order: 0,
      });
      console.log(`  + Stocked ${prod.product_name} (500 units)`);
    } else {
      console.log(`  ✓ ${prod.product_name} already has inventory`);
    }
  }

  console.log('\n✅ E2E Setup complete\n');
}
