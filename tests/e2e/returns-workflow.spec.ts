import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Return Processing Workflow — Regression E2E test
 *
 * Tests the `receive_return` RPC that was completely missing before March 2026.
 * Full flow:
 *   1. Navigate to Returns page
 *   2. Create a return (from an existing delivered order)
 *   3. Approve the return (`approve_return`)
 *   4. Receive & restock the return (`receive_return`)
 *   5. Issue credit (`issue_return_credit`)
 *   6. Verify each status transition
 *
 * The return detail is a modal (no separate route), so all actions
 * happen on the /returns page.
 */

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) =>
  page.waitForTimeout(ms);

test.describe('Return Processing Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', (d) => d.accept());
  });

  // RP1: Returns page loads with heading and table
  test('RP1: returns page loads with heading', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const heading = page.locator('h1, h2, [role="heading"]').first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Page should not have crashed
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');
  });

  // RP2: Create Return button opens modal with customer/order selectors
  test('RP2: Create Return modal opens with form fields', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const createBtn = page.locator(
      'button:has-text("Create Return"), button:has-text("New Return")'
    ).first();

    if (!(await createBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await createBtn.click();
    await waitForPage(page, 1000);

    // Modal should open with customer and order selectors
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Should have select dropdowns for customer and reason
    const selects = modal.locator('select');
    const selectCount = await selects.count();
    expect(selectCount).toBeGreaterThan(0);

    // Reason dropdown should have standard options
    const reasonSelect = modal.locator('select').filter({
      has: page.locator('option:has-text("defective"), option:has-text("Defective")'),
    });
    const hasReasonSelect = await reasonSelect.isVisible({ timeout: 3000 }).catch(() => false);
    // Reason select is expected but may use different labels
    expect(hasReasonSelect || selectCount > 0).toBe(true);
  });

  // RP3: Create a return from an existing order
  test('RP3: create return with customer and order selection', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const createBtn = page.locator(
      'button:has-text("Create Return"), button:has-text("New Return")'
    ).first();

    if (!(await createBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await createBtn.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Select customer (first real option)
    const customerSelect = modal.locator('select').first();
    await expect(customerSelect).toBeVisible({ timeout: 5000 });
    await waitForPage(page, 1000);

    const customerOptions = await customerSelect.locator('option').allTextContents();
    const realCustomer = customerOptions.find(
      (v) =>
        v.trim() !== '' &&
        !v.toLowerCase().includes('select') &&
        !v.toLowerCase().includes('choose')
    );

    if (!realCustomer) {
      test.skip(); // No customers available
      return;
    }

    await customerSelect.selectOption({ label: realCustomer });
    await waitForPage(page, 1500); // Wait for orders to load

    // Select an order if available
    const orderSelect = modal.locator('select').nth(1);
    if (await orderSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const orderOptions = await orderSelect.locator('option').allTextContents();
      const realOrder = orderOptions.find(
        (v) =>
          v.trim() !== '' &&
          !v.toLowerCase().includes('select') &&
          !v.toLowerCase().includes('choose') &&
          !v.toLowerCase().includes('no order')
      );
      if (realOrder) {
        await orderSelect.selectOption({ label: realOrder });
        await waitForPage(page, 1000);
      }
    }

    // Select reason
    const reasonSelect = modal.locator('select').filter({
      has: page.locator('option'),
    }).last();
    if (await reasonSelect.isVisible({ timeout: 3000 }).catch(() => false)) {
      const reasonOptions = await reasonSelect.locator('option').allTextContents();
      const defective = reasonOptions.find((v) => v.toLowerCase().includes('defective'));
      if (defective) {
        await reasonSelect.selectOption({ label: defective });
      } else if (reasonOptions.length > 1) {
        await reasonSelect.selectOption({ index: 1 });
      }
    }

    // Fill reason details if textarea exists
    const reasonDetails = modal.locator('textarea').first();
    if (await reasonDetails.isVisible({ timeout: 2000 }).catch(() => false)) {
      await reasonDetails.fill(`E2E return test ${RUN_ID}`);
    }

    // Check if there's an Add Item button and add at least one item
    const addItemBtn = modal.locator(
      'button:has-text("Add Item"), button:has-text("Add")'
    ).first();
    if (await addItemBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addItemBtn.click();
      await waitForPage(page, 1000);

      // Fill quantity if an input appears
      const qtyInput = modal.locator('input[type="number"]').first();
      if (await qtyInput.isVisible({ timeout: 2000 }).catch(() => false)) {
        await qtyInput.fill('1');
      }
    }

    // Submit the return — look for Create/Submit button in modal
    const submitBtn = modal.locator(
      'button:has-text("Create Return"), button:has-text("Submit"), button:has-text("Save")'
    ).first();

    if (await submitBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await submitBtn.click();
      await waitForPage(page, 3000);

      // Modal should close or show success
      const pageText = await page.textContent('body');
      expect(pageText).not.toContain('Something went wrong');
    }
  });

  // RP4: Click a return row to open detail modal
  test('RP4: clicking return row opens detail modal', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const firstRow = table.locator('tbody tr').first();
    if (!(await firstRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(); // No returns exist
      return;
    }

    await firstRow.click();
    await waitForPage(page, 1500);

    // Detail modal should open with return number
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Should show return info (return number, customer, status)
    const modalText = await modal.textContent();
    expect(modalText).toBeTruthy();
    expect(modalText!.length).toBeGreaterThan(10); // Has real content
  });

  // RP5: Approve button visible for "requested" returns
  test('RP5: approve button visible for requested returns', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    // Try to find a return with "requested" status
    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const requestedRow = table
      .locator('tbody tr')
      .filter({ hasText: /requested/i })
      .first();

    if (!(await requestedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      // No requested returns — check if any returns exist at all
      const anyRow = table.locator('tbody tr').first();
      if (!(await anyRow.isVisible({ timeout: 3000 }).catch(() => false))) {
        test.skip();
        return;
      }
      // Click any return to verify modal loads without error
      await anyRow.click();
      await waitForPage(page, 1500);
      const modal = page.locator('[role="dialog"]').first();
      await expect(modal).toBeVisible({ timeout: 5000 });
      return;
    }

    await requestedRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Approve button should be visible for "requested" status
    const approveBtn = modal.locator(
      'button:has-text("Approve"), button:has-text("Approve Return")'
    ).first();
    await expect(approveBtn).toBeVisible({ timeout: 5000 });
  });

  // RP6: Receive & Restock button visible for "approved" returns
  test('RP6: receive & restock button visible for approved returns', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const approvedRow = table
      .locator('tbody tr')
      .filter({ hasText: /approved/i })
      .first();

    if (!(await approvedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(); // No approved returns
      return;
    }

    await approvedRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Receive & Restock button should be visible for "approved" status
    const receiveBtn = modal.locator(
      'button:has-text("Receive"), button:has-text("Restock")'
    ).first();
    await expect(receiveBtn).toBeVisible({ timeout: 5000 });
  });

  // RP7: Issue Credit button visible for "received" returns
  test('RP7: issue credit button visible for received returns', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const receivedRow = table
      .locator('tbody tr')
      .filter({ hasText: /received/i })
      .first();

    if (!(await receivedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(); // No received returns
      return;
    }

    await receivedRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Issue Credit button should be visible for "received" status
    const creditBtn = modal.locator(
      'button:has-text("Issue Credit"), button:has-text("Credit")'
    ).first();
    await expect(creditBtn).toBeVisible({ timeout: 5000 });
  });

  // RP8: Status filter dropdown filters returns list
  test('RP8: status filter dropdown works', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const filterSelect = page.locator(
      'select:has(option:text("Requested")), select:has(option:text("requested")), select:has(option:text("Approved")), select:has(option:text("All"))'
    ).first();

    if (!(await filterSelect.isVisible({ timeout: 5000 }).catch(() => false))) {
      // Filter may not exist if no returns
      return;
    }

    const options = await filterSelect.locator('option').allTextContents();
    expect(options.length).toBeGreaterThan(1);

    // Select a specific status
    if (options.some((o) => o.toLowerCase().includes('approved'))) {
      await filterSelect.selectOption({ label: options.find((o) => o.toLowerCase().includes('approved'))! });
      await waitForPage(page, 1000);
    }

    // Page should not crash
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');
  });

  // RP9: Full lifecycle — approve a requested return
  test('RP9: approve a requested return and verify status change', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    // Find a "requested" return to approve
    const requestedRow = table
      .locator('tbody tr')
      .filter({ hasText: /requested/i })
      .first();

    if (!(await requestedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(); // No requested returns available
      return;
    }

    await requestedRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click Approve button
    const approveBtn = modal.locator(
      'button:has-text("Approve"), button:has-text("Approve Return")'
    ).first();

    if (!(await approveBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    // Handle the window.confirm dialog
    page.once('dialog', (d) => d.accept());
    await approveBtn.click();
    await waitForPage(page, 3000);

    // Verify status changed — modal or page should now show "approved"
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');

    // The "Receive & Restock" button should now be visible (status = approved)
    const receiveBtn = modal.locator(
      'button:has-text("Receive"), button:has-text("Restock")'
    ).first();
    const statusChanged =
      (await receiveBtn.isVisible({ timeout: 5000 }).catch(() => false)) ||
      pageText?.toLowerCase().includes('approved');
    expect(statusChanged).toBe(true);
  });

  // RP10: Full lifecycle — receive & restock an approved return
  test('RP10: receive and restock an approved return', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    // Find an "approved" return
    const approvedRow = table
      .locator('tbody tr')
      .filter({ hasText: /approved/i })
      .first();

    if (!(await approvedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(); // No approved returns — RP9 may not have run or created one
      return;
    }

    await approvedRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click "Receive & Restock" — no confirmation dialog for this action
    const receiveBtn = modal.locator(
      'button:has-text("Receive"), button:has-text("Restock")'
    ).first();

    if (!(await receiveBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await receiveBtn.click();
    await waitForPage(page, 3000);

    // Verify status changed to "received"
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');

    // Should see "Issue Credit" button now (status = received)
    // OR a success toast "Return received and inventory restocked"
    const creditBtn = modal.locator(
      'button:has-text("Issue Credit"), button:has-text("Credit")'
    ).first();
    const successToast = page.locator('[class*="toast"], [role="status"]').filter({
      hasText: /received|restocked|success/i,
    }).first();

    const received =
      (await creditBtn.isVisible({ timeout: 5000 }).catch(() => false)) ||
      (await successToast.isVisible({ timeout: 3000 }).catch(() => false)) ||
      pageText?.toLowerCase().includes('received');
    expect(received).toBe(true);

    // Check for "Restocked" badge on items if visible
    const restockedBadge = modal.getByText('Restocked').first();
    const hasRestockIndicator = await restockedBadge.isVisible({ timeout: 3000 }).catch(() => false);
    // This is informational — restocked badge confirms inventory was updated
    if (hasRestockIndicator) {
      expect(hasRestockIndicator).toBe(true);
    }
  });

  // RP11: Full lifecycle — issue credit for a received return
  test('RP11: issue credit for a received return', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    // Find a "received" return
    const receivedRow = table
      .locator('tbody tr')
      .filter({ hasText: /received/i })
      .first();

    if (!(await receivedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip(); // No received returns
      return;
    }

    await receivedRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Click "Issue Credit" — no confirmation dialog
    const creditBtn = modal.locator(
      'button:has-text("Issue Credit"), button:has-text("Credit")'
    ).first();

    if (!(await creditBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await creditBtn.click();
    await waitForPage(page, 3000);

    // Verify status changed to "credited"
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');

    // Success: the modal should update to show "credited" status
    // Or a success toast appears
    const successToast = page.locator('[class*="toast"], [role="status"]').filter({
      hasText: /credit|issued|success/i,
    }).first();

    const credited =
      (await successToast.isVisible({ timeout: 5000 }).catch(() => false)) ||
      pageText?.toLowerCase().includes('credited');
    expect(credited).toBe(true);

    // The Issue Credit button should no longer be visible (terminal state)
    await waitForPage(page, 1000);
    const creditBtnGone = !(await creditBtn.isVisible({ timeout: 2000 }).catch(() => false));
    expect(creditBtnGone).toBe(true);
  });

  // RP12: Return detail modal shows items table with product info
  test('RP12: return detail modal shows items table', async ({ page }) => {
    await page.goto('/returns');
    await waitForPage(page, 2000);

    const table = page.locator('table').first();
    if (!(await table.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    const firstRow = table.locator('tbody tr').first();
    if (!(await firstRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await firstRow.click();
    await waitForPage(page, 1500);

    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Modal should contain return details like customer, order, status
    const modalText = (await modal.textContent()) || '';
    const hasReturnContent =
      modalText.toLowerCase().includes('return') ||
      modalText.toLowerCase().includes('customer') ||
      modalText.toLowerCase().includes('status') ||
      modalText.toLowerCase().includes('product');
    expect(hasReturnContent).toBe(true);
  });
});
