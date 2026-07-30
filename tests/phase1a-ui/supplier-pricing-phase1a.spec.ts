import { expect, test } from '@playwright/test';
import ExcelJS from 'exceljs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const API = 'http://127.0.0.1:54321';
const ACTOR_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUTPUT_DIR = resolve('output/playwright');
const SUPPLIER_PRICE_OBSERVATION_ID = '44444444-4444-4444-8444-444444444444';
const SUPPLIER_ID = '55555555-5555-4555-8555-555555555555';

const products = [
  {
    id: '11111111-1111-4111-8111-111111111111', product_name: 'Margin Product', sku: '000-MARGIN',
    category: 'Herbicide', vendor: 'Supplier A', manufacturer: 'Maker A', container_size: 2.5,
    unit_size: 'gal', inventory_unit: 'gal', container_unit: 'jug', container_type: 'Jug',
    current_cost: 80, tier1_margin: 0.2, tier2_margin: 0.25, tier3_margin: 0.3,
    tier1_price: 100, tier2_price: 106.67, tier3_price: 114.29,
    tier1_gross_margin: 0.25, tier2_gross_margin: 0.3333, tier3_gross_margin: 0.4286,
    tier1_price_per_acre: 50, tier2_price_per_acre: 53.34, tier3_price_per_acre: 57.15,
    pricing_version: 7, is_active: true, product_form: 'liquid', rate_per_acre: 16, rate_unit: 'oz',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '22222222-2222-4222-8222-222222222222', product_name: 'Price Product', sku: 'PRICE-002',
    category: 'Fungicide', vendor: 'Supplier B', manufacturer: 'Maker B', container_size: 1,
    unit_size: 'gal', inventory_unit: 'gal', container_unit: 'jug', container_type: 'Jug',
    current_cost: 50, tier1_margin: 0.1, tier2_margin: 0.2, tier3_margin: 0.3,
    tier1_price: 55.56, tier2_price: 62.5, tier3_price: 71.43,
    tier1_gross_margin: 0.1111, tier2_gross_margin: 0.25, tier3_gross_margin: 0.4286,
    tier1_price_per_acre: 27.78, tier2_price_per_acre: 31.25, tier3_price_per_acre: 35.72,
    pricing_version: 4, is_active: true, product_form: 'liquid', rate_per_acre: 8, rate_unit: 'oz',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
  {
    id: '33333333-3333-4333-8333-333333333333', product_name: 'Third Product', sku: 'THIRD-003',
    category: 'Insecticide', vendor: 'Supplier C', manufacturer: 'Maker C', container_size: 1,
    unit_size: 'lb', inventory_unit: 'lb', container_unit: 'bag', container_type: 'Bag',
    current_cost: 40, tier1_margin: 0.2, tier2_margin: 0.25, tier3_margin: 0.3,
    tier1_price: 50, tier2_price: 53.33, tier3_price: 57.14,
    tier1_gross_margin: 0.25, tier2_gross_margin: 0.3333, tier3_gross_margin: 0.4286,
    tier1_price_per_acre: null, tier2_price_per_acre: null, tier3_price_per_acre: null,
    pricing_version: 2, is_active: true, product_form: 'dry', rate_per_acre: null, rate_unit: null,
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
  },
];

const supplierMarketEvidence = [
  {
    bestSupplier: 'Supplier A', replacementCostCents: '3640',
    suppliers: [
      {
        vendorId: SUPPLIER_ID, vendor: 'Supplier A', productSupplierLinkId: '66666666-6666-4666-8666-666666666666',
        quotedPackageCostCents: '9100', normalizedCostCents: '3640', comparisonStatus: 'comparable', isBestComparable: true,
      },
      {
        vendorId: '56565656-5656-4556-8556-565656565656', vendor: 'Supplier A Alternate', productSupplierLinkId: '67676767-6767-4676-8676-676767676767',
        quotedPackageCostCents: '9500', normalizedCostCents: '3800', comparisonStatus: 'comparable', isBestComparable: false,
      },
    ],
  },
  {
    bestSupplier: 'Supplier B', replacementCostCents: '6075',
    suppliers: [
      {
        vendorId: '77777777-7777-4777-8777-777777777777', vendor: 'Supplier B', productSupplierLinkId: '88888888-8888-4888-8888-888888888888',
        quotedPackageCostCents: '6075', normalizedCostCents: '6075', comparisonStatus: 'comparable', isBestComparable: true,
      },
      {
        vendorId: '78787878-7878-4787-8787-787878787878', vendor: 'Supplier B Alternate', productSupplierLinkId: '89898989-8989-4989-8989-898989898989',
        quotedPackageCostCents: '6500', normalizedCostCents: '6500', comparisonStatus: 'comparable', isBestComparable: false,
      },
    ],
  },
  {
    bestSupplier: 'Supplier C', replacementCostCents: '4500',
    suppliers: [
      {
        vendorId: '99999999-9999-4999-8999-999999999999', vendor: 'Supplier C', productSupplierLinkId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab',
        quotedPackageCostCents: '4500', normalizedCostCents: '4500', comparisonStatus: 'comparable', isBestComparable: true,
      },
      {
        vendorId: '98989898-9898-4989-8989-989898989898', vendor: 'Supplier C Alternate', productSupplierLinkId: 'abababab-abab-4bab-8bab-abababababab',
        quotedPackageCostCents: '4700', normalizedCostCents: '4700', comparisonStatus: 'comparable', isBestComparable: false,
      },
    ],
  },
] as const;

function base64Url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function sessionResponse() {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = `${base64Url({ alg: 'HS256', typ: 'JWT' })}.${base64Url({
    sub: ACTOR_ID, role: 'authenticated', aud: 'authenticated', exp: now + 3600,
  })}.phase1a-proof`;
  const user = {
    id: ACTOR_ID, aud: 'authenticated', role: 'authenticated', email: 'phase1a@example.invalid',
    email_confirmed_at: '2026-07-16T00:00:00Z', phone: '', confirmation_sent_at: null,
    confirmed_at: '2026-07-16T00:00:00Z', recovery_sent_at: null,
    last_sign_in_at: '2026-07-16T00:00:00Z', app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {}, identities: [], created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-16T00:00:00Z',
  };
  return { access_token: accessToken, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: 'phase1a-refresh', user };
}

function exportResponse() {
  return {
    export_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    manifest_fingerprint: 'phase1a-manifest-fingerprint',
    expires_at: '2026-07-23T22:00:00Z',
    rows: products.map((product) => ({
      product_id: product.id,
      sku: product.sku,
      product_name: product.product_name,
      category: product.category,
      container_size: String(product.container_size),
      unit_size: product.unit_size,
      inventory_unit: product.inventory_unit,
      identity_fingerprint: `identity-${product.id}`,
      row_token: `token-${product.id}`,
      row_version: product.pricing_version,
      current_cost: product.current_cost.toFixed(2),
      current_tier1_margin_percent: String(product.tier1_margin * 100),
      current_tier1_price: product.tier1_price.toFixed(2),
      current_tier2_margin_percent: String(product.tier2_margin * 100),
      current_tier2_price: product.tier2_price.toFixed(2),
      current_tier3_margin_percent: String(product.tier3_margin * 100),
      current_tier3_price: product.tier3_price.toFixed(2),
    })),
  };
}

function snapshot(product: typeof products[number]) {
  return {
    cost: product.current_cost.toFixed(2), cost_cents: product.current_cost * 100,
    tier1_margin_percent: String(product.tier1_margin * 100), tier1_margin: product.tier1_margin,
    tier1_price: product.tier1_price.toFixed(2), tier1_price_cents: Math.round(product.tier1_price * 100),
    tier2_margin_percent: String(product.tier2_margin * 100), tier2_margin: product.tier2_margin,
    tier2_price: product.tier2_price.toFixed(2), tier2_price_cents: Math.round(product.tier2_price * 100),
    tier3_margin_percent: String(product.tier3_margin * 100), tier3_margin: product.tier3_margin,
    tier3_price: product.tier3_price.toFixed(2), tier3_price_cents: Math.round(product.tier3_price * 100),
    tier1_price_per_acre_cents: product.tier1_price_per_acre == null ? null : Math.round(product.tier1_price_per_acre * 100),
    tier2_price_per_acre_cents: product.tier2_price_per_acre == null ? null : Math.round(product.tier2_price_per_acre * 100),
    tier3_price_per_acre_cents: product.tier3_price_per_acre == null ? null : Math.round(product.tier3_price_per_acre * 100),
  };
}

function effect(product: typeof products[number], overrides: { cost: number; prices: number[]; margins: number[] }) {
  return {
    product_id: product.id, product_name: product.product_name, sku: product.sku,
    pricing_mode: 'margin_driven', before: snapshot(product),
    cost: overrides.cost.toFixed(2), cost_cents: overrides.cost * 100,
    tier1_margin_percent: String(overrides.margins[0] * 100), tier1_margin: overrides.margins[0],
    tier1_price: overrides.prices[0].toFixed(2), tier1_price_cents: Math.round(overrides.prices[0] * 100),
    tier2_margin_percent: String(overrides.margins[1] * 100), tier2_margin: overrides.margins[1],
    tier2_price: overrides.prices[1].toFixed(2), tier2_price_cents: Math.round(overrides.prices[1] * 100),
    tier3_margin_percent: String(overrides.margins[2] * 100), tier3_margin: overrides.margins[2],
    tier3_price: overrides.prices[2].toFixed(2), tier3_price_cents: Math.round(overrides.prices[2] * 100),
    tier1_gross_margin: Math.round((overrides.margins[0] / (1 - overrides.margins[0])) * 10_000) / 10_000,
    tier2_gross_margin: Math.round((overrides.margins[1] / (1 - overrides.margins[1])) * 10_000) / 10_000,
    tier3_gross_margin: Math.round((overrides.margins[2] / (1 - overrides.margins[2])) * 10_000) / 10_000,
    tier1_price_per_acre_cents: null, tier2_price_per_acre_cents: null, tier3_price_per_acre_cents: null,
  };
}

function costBasisWorkspaceResponse() {
  return {
    enabled: false,
    product: {
      id: products[0].id,
      product_name: products[0].product_name,
      sku: products[0].sku,
      pricing_version: products[0].pricing_version,
      current_cost_cents: '8000',
      tier1_margin_percent: '20',
      tier2_margin_percent: '25',
      tier3_margin_percent: '30',
    },
    current_basis: null,
    supplier_candidates: [{
      supplier_price_observation_id: SUPPLIER_PRICE_OBSERVATION_ID,
      vendor_id: SUPPLIER_ID,
      vendor_name: 'Supplier A',
      quoted_package_cost_cents: '9100',
      normalized_cost_cents: '3640',
      effective_from: '2026-07-20',
      price_kind: 'quote',
    }],
    purchase_candidates: [],
  };
}

function productPriceHistoryResponse() {
  return {
    product_id: products[0].id,
    summary: {
      product_id: products[0].id,
      supplier_quote_count: 1,
      comparable_quote_count: 1,
      replacement_cost_cents: '3640',
      replacement_cost_as_of: '2026-07-20',
      best_supplier: 'Supplier A',
      last_paid_cents: null,
      last_paid_as_of: null,
      recent_po_weighted_average_cents: null,
      recent_po_window: 'trailing_12_months',
      comparison_status: 'comparable',
      suppliers: [{
        vendor_id: SUPPLIER_ID,
        vendor_name: 'Supplier A',
        product_supplier_link_id: '66666666-6666-4666-8666-666666666666',
        quoted_package_cost_cents: '9100',
        normalized_cost_cents: '3640',
        effective_from: '2026-07-20',
        comparison_status: 'comparable',
        is_best_comparable: true,
      }],
    },
    suppliers: [{ id: SUPPLIER_ID, name: 'Supplier A' }],
    points: [{
      stream: 'supplier_observation',
      source_id: SUPPLIER_PRICE_OBSERVATION_ID,
      vendor_id: SUPPLIER_ID,
      supplier_name: 'Supplier A',
      cost_cents: '9100',
      normalized_cost_cents: '3640',
      occurred_at: '2026-07-20T00:00:00Z',
      detail: 'supplier_quote',
      provenance: { price_kind: 'quote' },
    }],
  };
}

function supplierMarketEvidenceResponse() {
  return products.map((product, index) => {
    const evidence = supplierMarketEvidence[index]!;
    return {
      product_id: product.id,
      supplier_quote_count: evidence.suppliers.length,
      comparable_quote_count: evidence.suppliers.filter((supplier) => supplier.comparisonStatus === 'comparable').length,
      replacement_cost_cents: evidence.replacementCostCents,
      replacement_cost_as_of: '2026-07-20',
      best_supplier: evidence.bestSupplier,
      last_paid_cents: null,
      last_paid_as_of: null,
      recent_po_weighted_average_cents: null,
      recent_po_window: 'trailing_12_months',
      comparison_status: 'comparable',
      suppliers: evidence.suppliers.map((supplier) => ({
        vendor_id: supplier.vendorId,
        vendor_name: supplier.vendor,
        product_supplier_link_id: supplier.productSupplierLinkId,
        quoted_package_cost_cents: supplier.quotedPackageCostCents,
        normalized_cost_cents: supplier.normalizedCostCents,
        effective_from: '2026-07-20',
        comparison_status: supplier.comparisonStatus,
        is_best_comparable: supplier.isBestComparable,
      })),
    };
  }).reverse();
}

test('real .xlsx round-trip plus ProductDetail quick pricing review', async ({ page }) => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? 'unknown failure';
    // Route transitions intentionally abort in-flight notification polling.
    if (errorText !== 'net::ERR_ABORTED') {
      failedRequests.push(`${request.method()} ${request.url()} — ${errorText}`);
    }
  });
  let worksheetPreviewCount = 0;
  const previewRequests: unknown[] = [];
  const applyRequests: unknown[] = [];

  await page.routeWebSocket('ws://127.0.0.1:54321/realtime/v1/websocket**', (socket) => {
    // Accept the isolated Supabase realtime socket so the UI proof has no
    // expected network-console noise. Realtime behavior is outside this flow.
    socket.onMessage(() => undefined);
  });

  await page.route(`${API}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const json = (body: unknown, status = 200) => route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*', 'content-range': '0-2/3' },
      body: JSON.stringify(body),
    });

    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
    if (url.pathname === '/auth/v1/token') return json(sessionResponse());
    if (url.pathname === '/rest/v1/profiles') {
      return json({
        id: ACTOR_ID, email: 'phase1a@example.invalid', full_name: 'Phase 1a Admin', role: 'admin',
        phone: null, is_active: true, denied_pages: [], applicator_license_number: null,
        faa_certificate_number: null, created_at: '2026-07-16T00:00:00Z', updated_at: '2026-07-16T00:00:00Z',
      });
    }
    if (url.pathname === '/rest/v1/products') {
      const wantsObject = request.headers()['accept']?.includes('application/vnd.pgrst.object+json');
      const requestedId = url.searchParams.get('id')?.replace('eq.', '');
      return json(wantsObject || requestedId
        ? (products.find((product) => product.id === requestedId) ?? products[0])
        : products);
    }
    if (url.pathname === '/rest/v1/cost_history' || url.pathname === '/rest/v1/unit_conversions') return json([]);
    if (url.pathname === '/rest/v1/activity_feed') return json([]);
    if (url.pathname.endsWith('/rpc/create_pricing_workbook_export')) return json(exportResponse());
    if (url.pathname.endsWith('/rpc/get_supplier_market_evidence')) {
      expect(request.postDataJSON()).toEqual({ p_product_ids: products.map((product) => product.id) });
      return json(supplierMarketEvidenceResponse());
    }
    if (url.pathname.endsWith('/rpc/get_product_cost_basis_workspace')) {
      expect(request.postDataJSON().p_product_id).toBe(products[0].id);
      return json(costBasisWorkspaceResponse());
    }
    if (url.pathname.endsWith('/rpc/get_product_price_history')) {
      expect(request.postDataJSON().p_product_id).toBe(products[0].id);
      return json(productPriceHistoryResponse());
    }
    if (url.pathname.endsWith('/rpc/preview_product_cost_basis_changes')) {
      const body = request.postDataJSON();
      previewRequests.push(body);
      const source = body.p_source as string;
      const submitted = body.p_rows as Array<Record<string, unknown>>;
      if (source === 'pricing_worksheet') worksheetPreviewCount += 1;

      if (source === 'product_page') {
        expect(submitted).toHaveLength(1);
        expect(submitted[0].product_id).toBe(products[0].id);
        return json({
          change_set_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', request_fingerprint: 'quick-fingerprint',
          source, status: 'previewed', expires_at: '2026-07-16T23:00:00Z', submitted_row_count: 1,
          ready_count: 1, unchanged_count: 0, conflict_count: 0, invalid_count: 0, apply_allowed: true,
          rows: [{ sequence: 1, product_id: products[0].id, submitted_row: submitted[0], row_status: 'ready', error_code: null,
            effect: effect(products[0], { cost: 91, prices: [113.75, 121.33, 130], margins: [0.2, 0.25, 0.3] }) }],
        });
      }

      expect(source).toBe('pricing_worksheet');
      expect(submitted.map((row) => row.product_id)).toEqual(products.map((product) => product.id));
      const effects = [
        effect(products[0], { cost: 90, prices: [112.5, 120, 128.57], margins: [0.2, 0.25, 0.3] }),
        effect(products[1], { cost: 60, prices: [70, 80, 90], margins: [0.14285714, 0.25, 0.33333333] }),
        effect(products[2], { cost: 45, prices: [56.25, 60, 64.29], margins: [0.2, 0.25, 0.3] }),
      ];
      const effectsByProductId = new Map(effects.map((item) => [item.product_id, item]));
      const conflict = worksheetPreviewCount === 1;
      return json({
        change_set_id: conflict ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        request_fingerprint: conflict ? 'conflict-fingerprint' : 'worksheet-fingerprint', source,
        status: conflict ? 'invalid' : 'previewed', expires_at: '2026-07-16T23:00:00Z', submitted_row_count: 3,
        ready_count: conflict ? 2 : 3, unchanged_count: 0, conflict_count: conflict ? 1 : 0, invalid_count: 0,
        apply_allowed: !conflict,
        rows: submitted.map((row, index) => ({
          sequence: index + 1, product_id: row.product_id, submitted_row: row,
          row_status: conflict && row.product_id === products[1].id ? 'conflict' : 'ready',
          error_code: conflict && row.product_id === products[1].id ? 'PRICING_ROW_CONFLICT' : null,
          effect: conflict && row.product_id === products[1].id ? null : effectsByProductId.get(String(row.product_id)),
        })),
      });
    }
    if (url.pathname.endsWith('/rpc/apply_product_cost_basis_change_set')) {
      const body = request.postDataJSON();
      applyRequests.push(body);
      const quick = body.p_change_set_id === 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
      return json({ change_set_id: body.p_change_set_id, status: 'applied', applied_count: quick ? 1 : 3, rows: [] });
    }
    return json([]);
  });

  await page.goto('/');
  await page.getByLabel('Email').fill('phase1a@example.invalid');
  await page.getByLabel('Password').fill('phase1a-proof-password');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await page.goto('/products');
  await expect(page.getByRole('button', { name: 'Pricing .xlsx' })).toBeVisible();

  const exportPath = resolve(OUTPUT_DIR, 'phase1a-export.xlsx');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Pricing .xlsx' }).click(),
  ]);
  await download.saveAs(exportPath);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(exportPath);
  const worksheet = workbook.getWorksheet('Pricing Update');
  expect(worksheet).toBeTruthy();
  const headers = new Map<string, number>();
  worksheet!.getRow(1).eachCell((cell, column) => headers.set(String(cell.value), column));
  expect(products.map((_, index) => worksheet!.getCell(index + 2, headers.get('product_id')!).value))
    .toEqual(products.map((product) => product.id));
  const pricingRowsByProductId = new Map(products.map((_, index) => [
    String(worksheet!.getCell(index + 2, headers.get('product_id')!).value), index + 2,
  ]));
  expect(pricingRowsByProductId.size).toBe(products.length);
  for (const [index, product] of products.entries()) {
    const row = pricingRowsByProductId.get(product.id);
    const evidence = supplierMarketEvidence[index]!;
    expect(row, `Missing Pricing Update summary for ${product.id}`).toBeTruthy();
    expect(worksheet!.getCell(row!, headers.get('best_supplier')!).value).toBe(evidence.bestSupplier);
    expect(worksheet!.getCell(row!, headers.get('replacement_cost')!).value)
      .toBe(`$${(Number(evidence.replacementCostCents) / 100).toFixed(2)}`);
    expect(worksheet!.getCell(row!, headers.get('supplier_quote_count')!).value).toBe(evidence.suppliers.length);
    expect(worksheet!.getCell(row!, headers.get('supplier_comparison_status')!).value).toBe('comparable');
  }

  const supplierEvidenceSheet = workbook.getWorksheet('Supplier Evidence');
  expect(supplierEvidenceSheet).toBeTruthy();
  const supplierEvidenceHeaders = new Map<string, number>();
  supplierEvidenceSheet!.getRow(1).eachCell((cell, column) => supplierEvidenceHeaders.set(String(cell.value), column));
  const evidenceRowsByProductAndSupplier = new Map<string, number>();
  for (let row = 2; row <= supplierEvidenceSheet!.actualRowCount; row += 1) {
    const productId = String(supplierEvidenceSheet!.getCell(row, supplierEvidenceHeaders.get('product_id')!).value);
    const supplier = String(supplierEvidenceSheet!.getCell(row, supplierEvidenceHeaders.get('supplier')!).value);
    const key = `${productId}\\u0000${supplier}`;
    expect(evidenceRowsByProductAndSupplier.has(key), `Duplicate Supplier Evidence row for ${productId} / ${supplier}`).toBe(false);
    evidenceRowsByProductAndSupplier.set(key, row);
  }
  const expectedEvidenceRows = products.flatMap((product, index) => supplierMarketEvidence[index]!.suppliers.map((supplier) => ({
    productId: product.id,
    ...supplier,
  })));
  const expectedEvidenceKeys = expectedEvidenceRows.map((row) => `${row.productId}\\u0000${row.vendor}`);
  expect(supplierEvidenceSheet!.actualRowCount - 1).toBe(expectedEvidenceRows.length);
  expect([...evidenceRowsByProductAndSupplier.keys()].sort()).toEqual([...expectedEvidenceKeys].sort());
  for (const evidence of expectedEvidenceRows) {
    const key = `${evidence.productId}\\u0000${evidence.vendor}`;
    const row = evidenceRowsByProductAndSupplier.get(key);
    expect(row, `Missing Supplier Evidence detail for ${evidence.productId} / ${evidence.vendor}`).toBeTruthy();
    expect(supplierEvidenceSheet!.getCell(row!, supplierEvidenceHeaders.get('product_id')!).value).toBe(evidence.productId);
    expect(supplierEvidenceSheet!.getCell(row!, supplierEvidenceHeaders.get('supplier')!).value).toBe(evidence.vendor);
    expect(supplierEvidenceSheet!.getCell(row!, supplierEvidenceHeaders.get('quoted_package_cost')!).value)
      .toBe(`$${(Number(evidence.quotedPackageCostCents) / 100).toFixed(2)}`);
    expect(supplierEvidenceSheet!.getCell(row!, supplierEvidenceHeaders.get('normalized_inventory_unit_cost')!).value)
      .toBe(`$${(Number(evidence.normalizedCostCents) / 100).toFixed(2)}`);
    expect(supplierEvidenceSheet!.getCell(row!, supplierEvidenceHeaders.get('comparison_status')!).value).toBe(evidence.comparisonStatus);
  }
  const set = (row: number, header: string, value: string | number) => worksheet!.getCell(row, headers.get(header)!).value = value;
  set(2, 'pricing_mode', 'margin_driven'); set(2, 'new_cost', 0); set(2, 'tier1_margin_percent', 20); set(2, 'tier2_margin_percent', 25); set(2, 'tier3_margin_percent', 30); set(2, 'change_reason', 'Monthly margin update');
  set(3, 'pricing_mode', 'price_driven'); set(3, 'new_cost', 60); set(3, 'tier1_price', 70); set(3, 'tier2_price', 80); set(3, 'tier3_price', 90); set(3, 'change_reason', 'Monthly price update');
  set(4, 'pricing_mode', 'margin_driven'); set(4, 'new_cost', 45); set(4, 'tier1_margin_percent', 20); set(4, 'tier2_margin_percent', 25); set(4, 'tier3_margin_percent', 30); set(4, 'change_reason', 'Third Product monthly update');
  const zeroCostPath = resolve(OUTPUT_DIR, 'phase1a-zero-cost-blocked.xlsx');
  await workbook.xlsx.writeFile(zeroCostPath);
  const fileInput = page.locator('input[type="file"][accept*="xlsx"]');
  const previewCountBeforeZeroWorkbook = previewRequests.length;
  await fileInput.setInputFiles(zeroCostPath);
  await expect(page.getByText(/cost greater than \$0 for Margin Product/)).toBeVisible();
  expect(previewRequests).toHaveLength(previewCountBeforeZeroWorkbook);

  set(2, 'new_cost', 90);
  const editedPath = resolve(OUTPUT_DIR, 'phase1a-edited-3-products.xlsx');
  await workbook.xlsx.writeFile(editedPath);

  await fileInput.setInputFiles(editedPath);
  await expect(page.getByText('Some rows need attention')).toBeVisible();
  await expect(page.getByText('Conflict', { exact: true }).last()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Apply approved changes' })).toHaveCount(0);
  await page.screenshot({ path: resolve(OUTPUT_DIR, 'phase1a-workbook-conflict.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close' }).last().click();

  await fileInput.setInputFiles(editedPath);
  await expect(page.getByText('Ready for approval')).toBeVisible();
  const workbookPreviewRows = page.getByLabel('Pricing preview rows');
  await expect(workbookPreviewRows.getByText('Margin Product')).toBeVisible();
  await expect(workbookPreviewRows.getByText('Price Product')).toBeVisible();
  await expect(workbookPreviewRows.getByText('Third Product')).toBeVisible();
  await expect(workbookPreviewRows.getByText('$80.00').first()).toBeVisible();
  await expect(workbookPreviewRows.getByText('$90.00').first()).toBeVisible();
  await page.screenshot({ path: resolve(OUTPUT_DIR, 'phase1a-workbook-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByText('Applied pricing to 3 Product(s).')).toBeVisible();

  await page.goto(`/products/${products[0].id}`);
  await expect(page.getByText('Grower Description')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Select as cost basis' })).toBeDisabled();
  await page.getByLabel('Pricing mode').selectOption('margin_driven');
  await page.getByRole('button', { name: 'Update' }).click();
  const previewCountBeforeZeroProduct = previewRequests.length;
  await page.getByLabel('New Cost').fill('0.00');
  await page.getByRole('button', { name: 'Review Cost Change' }).click();
  await expect(page.getByText('Margin-driven pricing requires a cost greater than $0. No prices were changed.')).toBeVisible();
  expect(previewRequests).toHaveLength(previewCountBeforeZeroProduct);

  await page.getByLabel('New Cost').fill('91.00');
  await page.getByLabel('Change Note (optional)').fill('Minor mid-month supplier increase');
  await page.getByRole('button', { name: 'Review Cost Change' }).click();
  await expect(page.getByText('Ready for approval')).toBeVisible();
  const productPreviewRows = page.getByLabel('Pricing preview rows');
  await expect(productPreviewRows.getByText('Margin Product')).toBeVisible();
  await expect(productPreviewRows.getByText('$91.00')).toBeVisible();
  await page.screenshot({ path: resolve(OUTPUT_DIR, 'phase1a-product-page-ready.png'), fullPage: true });
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByText('Applied pricing to 1 Product.')).toBeVisible();

  // Exercise the full Product form with a value that JavaScript Number cannot
  // represent to the cent. The captured RPC request must retain the exact text.
  await page.getByLabel('Pricing mode').selectOption('price_driven');
  await page.getByLabel('Current Cost').fill('90071992547409.93');
  await page.getByLabel('Tier 1 price').fill('90071992547410.01');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Ready for approval')).toBeVisible();
  const exactProductRequest = previewRequests.at(-1) as {
    p_rows: Array<{ new_cost: string; tier1_price: string }>;
  };
  expect(exactProductRequest.p_rows[0]).toMatchObject({
    new_cost: '90071992547409.93',
    tier1_price: '90071992547410.01',
  });
  await page.getByRole('button', { name: 'Apply approved changes' }).click();
  await expect(page.getByLabel('Pricing preview rows')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to products' }).click();
  await expect(page).toHaveURL(/\/products$/);
  await expect(page.getByText(/unsaved changes/i)).toHaveCount(0);

  expect(worksheetPreviewCount).toBe(2);
  expect(previewRequests).toHaveLength(4);
  expect(applyRequests).toHaveLength(3);
  const workbookRows = (previewRequests[0] as { p_rows: Array<{ pricing_mode: string }> }).p_rows;
  expect(workbookRows.map((row) => row.pricing_mode)).toEqual(['margin_driven', 'price_driven', 'margin_driven']);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  writeFileSync(resolve(OUTPUT_DIR, 'phase1a-browser-proof.json'), JSON.stringify({ previewRequests, applyRequests }, null, 2));
});
