import { expect, test, type Page } from '@playwright/test';

const API = 'http://127.0.0.1:54321';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function encoded(value: unknown) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function session() {
  const now = Math.floor(Date.now() / 1000);
  const access_token = `${encoded({ alg: 'HS256', typ: 'JWT' })}.${encoded({ sub: ACTOR_ID, role: 'authenticated', aud: 'authenticated', exp: now + 3600 })}.isolated`;
  return { access_token, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'isolated-refresh', user: { id: ACTOR_ID, aud: 'authenticated', role: 'authenticated', email: 'row-version@example.invalid', email_confirmed_at: '2026-07-30T00:00:00Z', confirmed_at: '2026-07-30T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, identities: [], created_at: '2026-07-30T00:00:00Z', updated_at: '2026-07-30T00:00:00Z' } };
}

const profile = { id: ACTOR_ID, email: 'row-version@example.invalid', full_name: 'Row Version Admin', role: 'admin', is_active: true, denied_pages: [] };
const quote = { id: '11111111-1111-4111-8111-111111111111', quote_number: 'RV-QUOTE-1', customer_id: '22222222-2222-4222-8222-222222222222', tier: 1, valid_days: 30, header_notes: 'Original quote note', footer_notes: '', status: 'draft', is_planned: false, commission_split: { splits: [] }, row_version: 7, created_at: '2026-07-30T00:00:00Z' };
const customer = { id: '22222222-2222-4222-8222-222222222222', farm_name: 'Original Farm', contact_name: 'Original Contact', assigned_tier: 1, assigned_sales_rep: ACTOR_ID, is_active: true, default_commission_split: { splits: [] }, crops: [], row_version: 4 };
const product = { id: '33333333-3333-4333-8333-333333333333', product_name: 'Proof Product', is_active: true, is_rup: false, current_cost: 6, tier1_price: 10, unit_size: 'gal', inventory_unit: 'gal' };
const section = { id: '44444444-4444-4444-8444-444444444444', quote_id: quote.id, section_name: 'Proof section', sort_order: 0, section_notes: null, section_header_notes: null, needed_by_date: null, field_id: null };
const item = { id: '55555555-5555-4555-8555-555555555555', quote_id: quote.id, section_id: section.id, product_id: product.id, sort_order: 0, product, calc_mode: 'units_direct', total_units_needed: 2, price_per_unit: 10, price_override: null, current_cost: 6, suggested_rate: null, actual_rate: null, rate_unit: null, oz_per_acre: null, price_per_acre: null, acres: null, unit_size: 'gal', profit: 8, total_price: 20, net_margin: 40, notes: null, price_unit: null };

async function isolate(page: Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => { if (request.failure()?.errorText !== 'net::ERR_ABORTED') failedRequests.push(`${request.method()} ${request.url()}`); });
  let quoteReads = 0;
  let customerReads = 0;
  await page.routeWebSocket(`${API.replace('http', 'ws')}/realtime/v1/websocket**`, (socket) => socket.onMessage(() => undefined));
  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'content-range': '0-0/1' }, body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname === '/auth/v1/token') return json(session());
    if (url.pathname === '/rest/v1/profiles') return json(profile);
    if (url.pathname === '/rest/v1/quotes') {
      // QuoteBuilder performs a guarded detail re-read during its initial
      // hydration; the explicit conflict reload is the third detail request.
      if (url.searchParams.get('id')?.includes(quote.id)) return json(++quoteReads <= 2 ? quote : { ...quote, header_notes: 'Reloaded quote note', row_version: 8 });
      return json([]);
    }
    if (url.pathname === '/rest/v1/customers') {
      // QuoteBuilder looks up the customer by id too, but only CustomerDetail
      // requests the complete row. Count only that endpoint's explicit reload.
      if (url.searchParams.get('id')?.includes(customer.id) && url.searchParams.get('select') === '*') return json(++customerReads <= 2 ? customer : { ...customer, farm_name: 'Reloaded Farm', row_version: 5 });
      return json([{ id: customer.id, farm_name: customer.farm_name, assigned_tier: 1, is_active: true }]);
    }
    if (url.pathname.endsWith('/rpc/save_quote')) return json({ message: 'QUOTE_STALE_WRITE', code: 'P0001' }, 400);
    if (url.pathname.endsWith('/rpc/save_customer')) return json({ message: 'CUSTOMER_STALE_WRITE', code: 'P0001' }, 400);
    if (url.pathname.endsWith('/rpc/get_customer_prep_card')) return json({ farm_name: customer.farm_name, contacts: [], balance_credit: { credit_limit_cents: 0, prepay_balance_cents: 0, open_ar_cents: 0 }, last_invoice: null, last_interaction: null, open_follow_ups_count: 0, open_workflow_counts: { quotes: 0, orders: 0, deliveries: 0 }, top_verified_facts: [], acres_tier: { total_acres: null, corn_acres: null, soybean_acres: null, other_acres: null, assigned_tier: 1 } });
    if (url.pathname.endsWith('/rpc/get_customer_purchase_summary')) return json({ top_products: [] });
    if (url.pathname === '/rest/v1/quote_sections') return json([section]);
    if (url.pathname === '/rest/v1/quote_items') return json([item]);
    if (url.pathname === '/rest/v1/products') return json([product]);
    if (url.pathname === '/rest/v1/customer_addresses') return json([]);
    if (url.pathname.startsWith('/rest/v1/')) return json([]);
    return json([]);
  });
  return { consoleErrors, pageErrors, failedRequests };
}

async function signIn(page: Page) {
  await page.goto('/');
  await page.getByLabel('Email').fill('row-version@example.invalid');
  await page.getByLabel('Password').fill('isolated-proof-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
}

for (const viewport of [{ name: 'desktop', width: 1280, height: 900 }, { name: 'phone', width: 375, height: 812 }]) {
  test(`network-isolated Quote and Customer stale-save UX (${viewport.name})`, async ({ page }) => {
    await page.setViewportSize({ width: viewport.width, height: viewport.height });
    const observed = await isolate(page);
    await signIn(page);

    await page.goto(`/quotes/${quote.id}`);
    const quoteNotes = page.locator('textarea[placeholder="Notes visible at the top of the quote..."]');
    await expect(quoteNotes).toHaveValue('Original quote note');
    await quoteNotes.fill('Unsaved quote browser edit');
    await page.getByRole('button', { name: 'Save Draft' }).click();
    await expect(page.getByRole('button', { name: 'Reload Quote' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep editing' })).toBeVisible();
    await expect(quoteNotes).toHaveValue('Unsaved quote browser edit');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(quoteNotes).toHaveValue('Unsaved quote browser edit');
    await page.getByRole('button', { name: 'Save Draft' }).click();
    await page.getByRole('button', { name: 'Reload Quote' }).click();
    await expect(quoteNotes).toHaveValue('Reloaded quote note');

    await page.goto(`/customers/${customer.id}`);
    const farmInput = page.getByRole('textbox', { name: 'Farm Name*', exact: true });
    await expect(farmInput).toHaveValue('Original Farm');
    await farmInput.fill('Unsaved customer browser edit');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByRole('button', { name: 'Reload Customer' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Keep editing' })).toBeVisible();
    await expect(farmInput).toHaveValue('Unsaved customer browser edit');
    await page.getByRole('button', { name: 'Keep editing' }).click();
    await expect(farmInput).toHaveValue('Unsaved customer browser edit');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await page.getByRole('button', { name: 'Reload Customer' }).click();
    await expect(farmInput).toHaveValue('Reloaded Farm');

    await expect(page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).resolves.toBe(true);
    // The four deliberately stale RPC responses are HTTP 400s, which Chromium
    // reports as resource errors. Require exactly those expected transport
    // errors and no runtime or failed-request errors from the rendered flow.
    expect(observed.consoleErrors).toEqual(Array(4).fill('Failed to load resource: the server responded with a status of 400 (Bad Request)'));
    expect(observed.pageErrors).toEqual([]);
    expect(observed.failedRequests).toEqual([]);
  });
}
