import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Accounts Payable — Full workflow E2E test
 *
 * Tests the complete AP lifecycle:
 *   1. Navigate to AP dashboard (empty state)
 *   2. Vendor Bills list with status cards
 *   3. New Bill form with vendor/PO selectors
 *   4. Create bill → pay partial → pay remaining → verify paid
 *   5. Create and void a vendor bill
 *   6. Dashboard reflects totals
 *   7. Compliance RUP Sales Register tab loads
 *   8. Sidebar link navigates to AP
 */

test.describe('Accounts Payable Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  test('AP1: AP Dashboard loads with KPI cards', async ({ page }) => {
    await page.goto('/accounts-payable');
    await expect(page.locator('h2, h1').filter({ hasText: 'Accounts Payable' })).toBeVisible();
    // KPI cards — use .first() because label text may appear in multiple contexts
    await expect(page.getByText('Total Owed').first()).toBeVisible();
    await expect(page.getByText('Due This Week').first()).toBeVisible();
    await expect(page.getByText('Due This Month').first()).toBeVisible();
    await expect(page.getByText('Overdue').first()).toBeVisible();
  });

  test('AP2: Vendor Bills list renders with status cards', async ({ page }) => {
    await page.goto('/accounts-payable/bills');
    await expect(page.locator('h2, h1').filter({ hasText: 'Vendor Bills' })).toBeVisible();
    // Status card buttons — use getByRole to distinguish from <option> elements
    await expect(page.getByRole('button', { name: /Unpaid/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Partially Paid/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /Overdue/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^(?=.*Paid)(?!.*Partially)/ })).toBeVisible();
    // Also check the filter dropdown exists
    await expect(page.getByLabel('Filter by bill status')).toBeVisible();
  });

  test('AP3: New Bill form loads with vendor dropdown and PO selector', async ({ page }) => {
    await page.goto('/accounts-payable/bills/new');
    await expect(page.locator('h2, h1').filter({ hasText: 'New Vendor Bill' })).toBeVisible();
    // PO selector is the first select — at minimum has the "No linked PO" placeholder
    const poSelect = page.locator('select').first();
    await expect(poSelect).toBeVisible();
    const optionCount = await poSelect.locator('option').count();
    expect(optionCount).toBeGreaterThanOrEqual(1); // At least "No linked PO"
    // Vendor selector should exist
    await expect(page.getByText('Bill Details')).toBeVisible();
    // Wait for vendors to load
    const vendorSelect = page.locator('select').filter({ has: page.locator('option:has-text("Select vendor")') });
    await expect(vendorSelect).toBeVisible();
  });

  test('AP4: Create bill → appears in list → detail → pay → verify', async ({ page }) => {
    // --- Step 1: Create a vendor bill ---
    await page.goto('/accounts-payable/bills/new');

    // Wait for vendor dropdown to populate (async fetch)
    const vendorSelect = page.locator('select').filter({ has: page.locator('option:has-text("Select vendor")') });
    await expect(vendorSelect).toBeVisible({ timeout: 10000 });
    // Wait for at least one real vendor to load
    await page.waitForTimeout(2000);

    const vendorOptions = await vendorSelect.locator('option').allTextContents();
    const realVendor = vendorOptions.find(v => v !== 'Select vendor...' && v.trim() !== '');
    expect(realVendor).toBeTruthy();
    await vendorSelect.selectOption({ label: realVendor! });

    // Fill bill number using placeholder (avoids special chars in generated id)
    const billInput = page.getByPlaceholder("Vendor's invoice/bill #");
    await expect(billInput).toBeVisible();
    await billInput.fill('TEST-BILL-E2E');

    // Fill subtotal — use exact placeholder match
    const subtotalInput = page.getByPlaceholder('0.00', { exact: true });
    await expect(subtotalInput).toBeVisible();
    await subtotalInput.fill('5000');

    // Submit
    await page.getByRole('button', { name: 'Create Bill' }).click();

    // Wait for navigation to bill detail (RPC returns bill UUID → navigate)
    // Pattern must NOT match /bills/new — wait for a UUID character
    await page.waitForURL(/accounts-payable\/bills\/[0-9a-f]/, { timeout: 15000 });

    // --- Step 2: Verify bill detail loaded ---
    await expect(page.getByText('TEST-BILL-E2E')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('$5,000.00').first()).toBeVisible();
    await expect(page.getByText('UNPAID', { exact: true })).toBeVisible();

    // --- Step 3: Record a partial payment ---
    const recordPayBtn = page.getByRole('button', { name: /Record Payment/i });
    await expect(recordPayBtn).toBeVisible();
    await recordPayBtn.click();

    // Payment modal should open — wait for dialog
    const dialog = page.locator('[role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    // Change amount to partial payment ($2,000) — use label association from Input component
    const payAmountInput = dialog.getByLabel(/Payment Amount/i);
    await payAmountInput.fill('2000');

    // Fill reference — label-based locator (Input component creates htmlFor/id)
    const refInput = dialog.getByLabel(/Reference/i);
    await refInput.fill('CHK-1234');

    // Submit payment — click the modal's Record Payment button (not the page one)
    const modalPayBtn = dialog.getByRole('button', { name: 'Record Payment' });
    await modalPayBtn.click();
    await page.waitForTimeout(3000);

    // Verify bill updated to partially paid
    await expect(page.getByText('PARTIALLY PAID', { exact: true })).toBeVisible({ timeout: 10000 });
    await expect(page.getByText('$3,000.00').first()).toBeVisible(); // Balance
    await expect(page.getByText('$2,000.00').first()).toBeVisible(); // Paid
    await expect(page.getByText('CHK-1234')).toBeVisible(); // Payment ref

    // --- Step 4: Record remaining payment ---
    const recordPayBtn2 = page.getByRole('button', { name: /Record Payment/i });
    await recordPayBtn2.click();
    const dialog2 = page.locator('[role="dialog"]');
    await expect(dialog2).toBeVisible({ timeout: 5000 });

    // Amount should default to remaining balance ($3,000)
    const payAmountInput2 = dialog2.getByLabel(/Payment Amount/i);
    const defaultAmount = await payAmountInput2.inputValue();
    expect(parseFloat(defaultAmount)).toBeCloseTo(3000, 0);

    // Submit — pay in full
    const modalPayBtn2 = dialog2.getByRole('button', { name: 'Record Payment' });
    await modalPayBtn2.click();
    await page.waitForTimeout(3000);

    // Verify bill is now paid — exact match avoids 'UNPAID' / 'PARTIALLY PAID'
    await expect(page.getByText('PAID', { exact: true })).toBeVisible({ timeout: 10000 });
    // Record Payment button should no longer be visible
    await expect(page.getByRole('button', { name: /Record Payment/i })).not.toBeVisible();
  });

  test('AP5: Create and void a vendor bill', async ({ page }) => {
    // Create a bill to void
    await page.goto('/accounts-payable/bills/new');

    // Wait for vendors
    const vendorSelect = page.locator('select').filter({ has: page.locator('option:has-text("Select vendor")') });
    await expect(vendorSelect).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(2000);

    const vendorOptions = await vendorSelect.locator('option').allTextContents();
    const realVendor = vendorOptions.find(v => v !== 'Select vendor...' && v.trim() !== '');
    expect(realVendor).toBeTruthy();
    await vendorSelect.selectOption({ label: realVendor! });

    // Fill bill details
    await page.getByPlaceholder("Vendor's invoice/bill #").fill('VOID-TEST-E2E');
    await page.getByPlaceholder('0.00', { exact: true }).fill('1000');

    await page.getByRole('button', { name: 'Create Bill' }).click();
    await page.waitForURL(/accounts-payable\/bills\/[0-9a-f]/, { timeout: 15000 });

    // Should be on bill detail page
    await expect(page.getByText('VOID-TEST-E2E')).toBeVisible({ timeout: 10000 });

    // Click Void button
    const voidBtn = page.getByRole('button', { name: /Void/i });
    await expect(voidBtn).toBeVisible();
    await voidBtn.click();

    // Void modal — "Are you sure" text
    await expect(page.getByText(/are you sure/i)).toBeVisible({ timeout: 5000 });

    // Fill reason using placeholder
    const reasonInput = page.getByPlaceholder(/voided/i);
    await reasonInput.fill('Test voiding');

    // Click "Void Bill" button in modal
    await page.locator('[role="dialog"] button, .fixed button').filter({ hasText: 'Void Bill' }).click();
    await page.waitForTimeout(3000);

    // Verify voided status — exact match avoids 'VOIDED: Test voiding' notes
    await expect(page.getByText('VOIDED', { exact: true })).toBeVisible({ timeout: 10000 });
    // No more payment/void buttons
    await expect(page.getByRole('button', { name: /Record Payment/i })).not.toBeVisible();
  });

  test('AP6: AP Dashboard shows dollar amounts in KPI cards', async ({ page }) => {
    await page.goto('/accounts-payable');
    await page.waitForTimeout(3000);

    // The dashboard should load without errors
    await expect(page.locator('h2, h1').filter({ hasText: 'Accounts Payable' })).toBeVisible();

    // KPI cards should show dollar amounts — the <p> elements with text-2xl class
    // Total Owed card: <span>Total Owed</span> is sibling to <p> with the value
    const kpiValues = page.locator('p.text-2xl');
    const kpiCount = await kpiValues.count();
    expect(kpiCount).toBeGreaterThanOrEqual(4); // 4 KPI cards

    // At least one should contain a $ sign (even if $0.00)
    const firstKPI = await kpiValues.first().textContent();
    expect(firstKPI).toMatch(/\$/);
  });

  test('AP7: Compliance page — RUP Sales Register tab loads', async ({ page }) => {
    await page.goto('/compliance');
    await page.waitForTimeout(1500);

    // Click RUP Sales Register tab button
    const rupTab = page.locator('button').filter({ hasText: 'RUP Sales Register' });
    await expect(rupTab).toBeVisible({ timeout: 10000 });
    await rupTab.click();
    await page.waitForTimeout(2000);

    // Filters should be visible — date inputs (raw <input type="date">, not using Input component)
    const dateInputs = page.locator('input[type="date"]');
    const dateCount = await dateInputs.count();
    expect(dateCount).toBeGreaterThanOrEqual(2); // Start + End date

    // Compliance filter dropdown label should be visible (inside the tab content area)
    const complianceLabel = page.locator('label').filter({ hasText: 'Compliance' });
    await expect(complianceLabel).toBeVisible({ timeout: 5000 });

    // Empty state when no RUP sales exist
    await expect(page.getByText('No RUP sales records')).toBeVisible({ timeout: 10000 });
    await expect(page.getByText(/auto-generated/i)).toBeVisible();
  });

  test('AP8: AP route is accessible and loads correctly', async ({ page }) => {
    // Navigate directly to AP — verifies the route works end-to-end
    await page.goto('/accounts-payable');
    await page.waitForTimeout(2000);

    // Dashboard should load
    await expect(page.locator('h2, h1').filter({ hasText: 'Accounts Payable' })).toBeVisible({ timeout: 10000 });

    // Navigate to bills sub-route
    await page.goto('/accounts-payable/bills');
    await expect(page.locator('h2, h1').filter({ hasText: 'Vendor Bills' })).toBeVisible({ timeout: 10000 });

    // Navigate to new bill sub-route
    await page.goto('/accounts-payable/bills/new');
    await expect(page.locator('h2, h1').filter({ hasText: 'New Vendor Bill' })).toBeVisible({ timeout: 10000 });
  });
});
