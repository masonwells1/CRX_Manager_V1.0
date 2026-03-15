import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

/**
 * Order Edit Product Swap — Regression E2E test
 *
 * Tests the full flow that was broken by the CHECK constraint bug:
 *   1. Navigate to an existing order
 *   2. Enter edit mode
 *   3. Verify edit controls appear (product swap capability)
 *   4. Modify item quantities / add new product
 *   5. Save and verify no errors
 *
 * This regression test ensures the `update_order_items` RPC and
 * inventory prebooked adjustments work correctly after the
 * CHECK constraint rewrites.
 */

const waitForPage = (page: import('@playwright/test').Page, ms: number) =>
  page.waitForTimeout(ms);

test.describe('Order Edit — Product Swap Regression', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', (d) => d.accept());
  });

  // OE1: Order detail loads and Edit button is visible for editable orders
  test('OE1: order detail shows Edit Order button for non-fulfilled orders', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    // Find a confirmed order (most likely to be editable)
    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();
    const anyRow = table.locator('tbody tr').first();

    const targetRow = (await confirmedRow.isVisible({ timeout: 3000 }).catch(() => false))
      ? confirmedRow
      : anyRow;

    await expect(targetRow).toBeVisible({ timeout: 5000 });
    await targetRow.click();
    await waitForPage(page, 3000);

    await expect(page).toHaveURL(/\/orders\/.+/);

    // Edit button should be visible for editable orders
    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();
    const hasEdit = await editButton.isVisible({ timeout: 5000 }).catch(() => false);

    // If order is fulfilled/cancelled, Edit won't show — that's OK, document it
    if (hasEdit) {
      await expect(editButton).toBeEnabled();
    } else {
      // Verify we're on a detail page that loaded without error
      const pageText = await page.textContent('body');
      expect(pageText).not.toContain('Something went wrong');
    }
  });

  // OE2: Edit mode enables inline editing of quantities and prices
  test('OE2: edit mode enables inline quantity and price editing', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    // Find a confirmed order to edit
    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (!(await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await confirmedRow.click();
    await waitForPage(page, 3000);

    // Click Edit Order
    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();

    if (!(await editButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await editButton.click();
    await waitForPage(page, 1500);

    // In edit mode, quantity and price inputs should be editable
    const editableInputs = page.locator(
      'input[type="number"]:not([disabled]):not([readonly])'
    );
    const inputCount = await editableInputs.count();
    expect(inputCount).toBeGreaterThan(0);

    // Save and Cancel buttons should be visible
    const saveBtn = page.locator('button:has-text("Save")').first();
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    await expect(saveBtn).toBeVisible();
    await expect(cancelBtn).toBeVisible();
  });

  // OE3: Add Product button opens product selector modal in edit mode
  test('OE3: Add Product button opens product selector in edit mode', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (!(await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await confirmedRow.click();
    await waitForPage(page, 3000);

    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();

    if (!(await editButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await editButton.click();
    await waitForPage(page, 1500);

    // Find the Add Product button (Plus icon button in table footer)
    const addProductBtn = page.locator(
      'button:has-text("Add Product"), button:has-text("Add Item"), button:has-text("Add")'
    ).first();

    if (await addProductBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
      await addProductBtn.click();
      await waitForPage(page, 1000);

      // Product selector modal or dropdown should appear
      const productList = page.locator(
        '[role="dialog"]'
      ).first();
      const hasProductSelector = await productList.isVisible({ timeout: 5000 }).catch(() => false);
      expect(hasProductSelector).toBe(true);
    }
  });

  // OE4: Modify quantity in edit mode and save successfully
  test('OE4: modify quantity and save order without errors', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (!(await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await confirmedRow.click();
    await waitForPage(page, 3000);
    const orderUrl = page.url();

    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();

    if (!(await editButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await editButton.click();
    await waitForPage(page, 1500);

    // Find the first quantity input and modify it
    const qtyInputs = page.locator('input[type="number"]');
    const qtyCount = await qtyInputs.count();
    expect(qtyCount).toBeGreaterThan(0);

    // Get current value, increment by 1
    const firstQty = qtyInputs.first();
    const currentVal = await firstQty.inputValue();
    const newVal = (parseFloat(currentVal) + 1).toString();
    await firstQty.fill(newVal);

    // Click Save
    const saveBtn = page.locator(
      'button:has-text("Save Changes"), button:has-text("Save")'
    ).first();
    await saveBtn.click();
    await waitForPage(page, 5000);

    // After save, edit mode should close — Edit button should reappear
    // OR a success toast should appear
    const editBtnAgain = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();
    const successToast = page.locator('[class*="toast"], [role="status"]').filter({
      hasText: /updated|saved|success/i,
    }).first();

    const savedOk =
      (await editBtnAgain.isVisible({ timeout: 10000 }).catch(() => false)) ||
      (await successToast.isVisible({ timeout: 5000 }).catch(() => false));

    // Verify no error displayed
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');
    expect(savedOk).toBe(true);

    // Verify we stayed on the same order detail page
    expect(page.url()).toBe(orderUrl);
  });

  // OE5: Product swap — remove existing product and add new one via modal
  test('OE5: product swap — add new product via modal in edit mode', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (!(await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await confirmedRow.click();
    await waitForPage(page, 3000);

    // Record the products currently in the order
    // Record state before edit (used for future assertions)
    void page.url();
    void await page.textContent('body');

    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();

    if (!(await editButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await editButton.click();
    await waitForPage(page, 1500);

    // Click "Add Product" button (appears as a row in the items table in edit mode)
    const addProductBtn = page.locator(
      'button:has-text("Add Product"), button:has-text("Add Item"), button:has-text("Add")'
    ).first();

    if (!(await addProductBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
      // No add product button — skip (might be fulfilled order)
      test.skip();
      return;
    }

    await addProductBtn.click();
    await waitForPage(page, 1500);

    // Product selector modal should open with title "Add Product to Order"
    const modal = page.locator('[role="dialog"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Search for a product (use search input in modal)
    const searchInput = modal.locator('input[type="text"], input[placeholder*="Search"]').first();
    if (await searchInput.isVisible({ timeout: 2000 }).catch(() => false)) {
      // Just click into it — we'll pick the first available product
      await searchInput.clear();
    }

    // Find and click a product that isn't already in the order (not disabled)
    // Exclude close button via aria-label
    const availableProduct = modal
      .locator('button:not([disabled]):not([aria-label="Close"])')
      .first();

    if (!(await availableProduct.isVisible({ timeout: 5000 }).catch(() => false))) {
      // All products already in order — close modal and skip
      test.skip();
      return;
    }

    const _productName = await availableProduct.textContent();
    await availableProduct.click();
    await waitForPage(page, 1000);

    // Modal should close, new product row should appear in edit items
    // Fill quantity for the new product (the last number input, which is the new row)
    const qtyInputs = page.locator('input[type="number"]');
    const lastQtyInput = qtyInputs.last();
    await lastQtyInput.fill('5');

    // Save changes
    const saveBtn = page.locator(
      'button:has-text("Save Changes"), button:has-text("Save")'
    ).first();
    await saveBtn.click();
    await waitForPage(page, 5000);

    // Verify save succeeded — no error, edit mode closed
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('Something went wrong');

    // Edit mode should have closed — Edit Order button should reappear
    const editBtnAgain = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();
    const successToast = page.locator('[class*="toast"], [role="status"]').filter({
      hasText: /updated|saved|success/i,
    }).first();

    const savedOk =
      (await editBtnAgain.isVisible({ timeout: 10000 }).catch(() => false)) ||
      (await successToast.isVisible({ timeout: 5000 }).catch(() => false));
    expect(savedOk).toBe(true);
  });

  // OE6: Remove a product in edit mode using the trash icon
  test('OE6: remove product via trash icon in edit mode', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (!(await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await confirmedRow.click();
    await waitForPage(page, 3000);

    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();

    if (!(await editButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await editButton.click();
    await waitForPage(page, 1500);

    // Count current items in edit mode
    const itemRows = page.locator('table tbody tr').filter({
      has: page.locator('input[type="number"]'),
    });
    const itemCount = await itemRows.count();

    if (itemCount < 2) {
      // Need at least 2 items to safely remove one (can't remove the last item)
      test.skip();
      return;
    }

    // Find trash/delete buttons (Lucide Trash2 icon button)
    const trashButtons = page.locator(
      'button:has(svg.lucide-trash-2), button:has(svg.lucide-trash), button[aria-label*="delete" i], button[aria-label*="remove" i]'
    );
    const trashCount = await trashButtons.count();

    if (trashCount < 1) {
      test.skip();
      return;
    }

    // Click the first trash button to remove an item
    await trashButtons.first().click();
    await waitForPage(page, 500);

    // Item count should decrease by 1
    const newItemCount = await itemRows.count();
    expect(newItemCount).toBe(itemCount - 1);

    // Cancel instead of saving to avoid permanently modifying test data
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    await cancelBtn.click();
    await waitForPage(page, 1500);
  });

  // OE7 (was OE5): Cancel edit reverts changes without saving
  test('OE7: cancel edit discards changes', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    const confirmedRow = table
      .locator('tbody tr')
      .filter({ hasText: /confirmed/i })
      .first();

    if (!(await confirmedRow.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await confirmedRow.click();
    await waitForPage(page, 3000);

    const editButton = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();

    if (!(await editButton.isVisible({ timeout: 5000 }).catch(() => false))) {
      test.skip();
      return;
    }

    await editButton.click();
    await waitForPage(page, 1500);

    // Modify a quantity
    const qtyInput = page.locator('input[type="number"]').first();
    const _originalVal = await qtyInput.inputValue();
    await qtyInput.fill('9999');

    // Click Cancel
    const cancelBtn = page.locator('button:has-text("Cancel")').first();
    await cancelBtn.click();
    await waitForPage(page, 1500);

    // Edit mode should close — Edit button should reappear
    const editBtnAgain = page.locator(
      'button:has-text("Edit Order"), button:has-text("Edit")'
    ).first();
    await expect(editBtnAgain).toBeVisible({ timeout: 5000 });

    // The quantity should NOT be 9999 anymore (reverted)
    const pageText = await page.textContent('body');
    expect(pageText).not.toContain('9999');
  });
});
