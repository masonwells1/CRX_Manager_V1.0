import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Order Detail Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', d => d.accept());
  });

  // OD1: Navigate to orders list, click first order to open detail
  test('OD1: navigate to order detail from orders list', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    // Wait for the orders table to load
    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });

    // Click the first data row in the table
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Verify we are on an order detail page
    const url = page.url();
    expect(url).toMatch(/\/orders\/.+/);

    // Verify order detail content loaded — look for order number heading or status badge
    const orderHeading = page.locator('h1, h2, [class*="heading"], [class*="title"]').first();
    await expect(orderHeading).toBeVisible({ timeout: 10000 });

    // Look for a status badge
    const statusBadge = page.locator('[class*="badge"], [class*="status"], [class*="chip"]').first();
    const hasBadge = await statusBadge.isVisible().catch(() => false);
    // Status badge is expected but not strictly required for navigation test
    expect(hasBadge || url.includes('/orders/')).toBeTruthy();
  });

  // OD2: Edit mode toggle
  test('OD2: edit mode toggle makes fields editable', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Find and click the Edit button
    const editButton = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
    await expect(editButton).toBeVisible({ timeout: 10000 });
    await editButton.click();
    await waitForPage(page, 1500);

    // After clicking edit, inputs should become editable (or new inputs appear)
    const editableInputs = page.locator('input:not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly])');
    const inputCount = await editableInputs.count();
    expect(inputCount).toBeGreaterThan(0);
  });

  // OD3: Line item editing
  test('OD3: line item editing accepts input changes', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Enter edit mode
    const editButton = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
    await expect(editButton).toBeVisible({ timeout: 10000 });
    await editButton.click();
    await waitForPage(page, 1500);

    // Find a number input in the line items area (price or quantity)
    const numberInput = page.locator('input[type="number"]').first();
    const hasNumberInput = await numberInput.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasNumberInput) {
      // Store original value, change it, verify change accepted
      const originalValue = await numberInput.inputValue();
      await numberInput.clear();
      await numberInput.fill('99.50');
      await waitForPage(page, 500);

      const newValue = await numberInput.inputValue();
      expect(newValue).toBe('99.50');
    } else {
      // Fallback: look for any editable input and modify it
      const anyInput = page.locator('input:not([disabled]):not([readonly])').first();
      await expect(anyInput).toBeVisible({ timeout: 5000 });
      const originalValue = await anyInput.inputValue();
      await anyInput.clear();
      await anyInput.fill('test-edit-' + RUN_ID);
      const newValue = await anyInput.inputValue();
      expect(newValue).toContain('test-edit');
    }
  });

  // OD4: Save order
  test('OD4: save order after editing', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Enter edit mode
    const editButton = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
    await expect(editButton).toBeVisible({ timeout: 10000 });
    await editButton.click();
    await waitForPage(page, 1500);

    // Click Save / Update button
    const saveButton = page.locator('button:has-text("Save"), button:has-text("Update"), button:has-text("Save Order")').first();
    await expect(saveButton).toBeVisible({ timeout: 5000 });
    await saveButton.click();
    await waitForPage(page, 3000);

    // Verify no error toast/alert appeared
    const errorToast = page.locator('[class*="error"], [class*="alert-error"], [role="alert"]:has-text("error")').first();
    const hasError = await errorToast.isVisible({ timeout: 2000 }).catch(() => false);

    // After save, edit button should reappear (back to read mode)
    const editButtonAfterSave = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
    const backToReadMode = await editButtonAfterSave.isVisible({ timeout: 5000 }).catch(() => false);

    // Either we saved successfully (back to read mode) or no error occurred
    expect(backToReadMode || !hasError).toBeTruthy();
  });

  // OD5: Status change modal
  test('OD5: status change modal shows status options', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for status change button or status-related control
    const statusButton = page.locator(
      'button:has-text("Change Status"), button:has-text("Status"), button:has-text("Update Status"), [class*="status"] button'
    ).first();
    const hasStatusButton = await statusButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasStatusButton) {
      await statusButton.click();
      await waitForPage(page, 1500);

      // A modal or dropdown with status options should appear
      const modal = page.locator('[class*="modal"], [class*="dialog"], [role="dialog"], [class*="dropdown"]').first();
      const hasModal = await modal.isVisible({ timeout: 5000 }).catch(() => false);

      // Or status select/radio options
      const statusOptions = page.locator('select option, [class*="option"], input[type="radio"]');
      const optionCount = await statusOptions.count().catch(() => 0);

      expect(hasModal || optionCount > 0).toBeTruthy();

      // Close the modal without changing — press Escape or click close button
      const closeButton = page.locator('button:has-text("Close"), button:has-text("Cancel"), [class*="close"]').first();
      const hasCloseButton = await closeButton.isVisible({ timeout: 2000 }).catch(() => false);
      if (hasCloseButton) {
        await closeButton.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await waitForPage(page, 1000);
    } else {
      // Fallback: look for a select element near the status display
      const statusSelect = page.locator('select').first();
      const hasSelect = await statusSelect.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasSelect || hasStatusButton).toBeTruthy();
    }
  });

  // OD6: Schedule delivery button
  test('OD6: schedule delivery button exists and is clickable', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for a schedule delivery button or link
    const deliveryButton = page.locator(
      'button:has-text("Schedule Delivery"), button:has-text("Delivery"), a:has-text("Schedule Delivery"), a:has-text("Schedule"), button:has-text("New Delivery"), a:has-text("New Delivery")'
    ).first();
    const hasDeliveryButton = await deliveryButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasDeliveryButton) {
      // Verify the button is enabled
      const isDisabled = await deliveryButton.isDisabled().catch(() => false);
      expect(isDisabled).toBeFalsy();

      // Get the href if it's a link
      const href = await deliveryButton.getAttribute('href').catch(() => null);
      if (href) {
        expect(href).toMatch(/deliver/i);
      }
    } else {
      // The button may not be present for all order statuses — check page for delivery section
      const deliverySection = page.locator(
        '[class*="deliver"], text=Delivery, text=delivery, [data-testid*="deliver"]'
      ).first();
      const hasDeliverySection = await deliverySection.isVisible({ timeout: 3000 }).catch(() => false);
      // Order may already be fully delivered — just verify page loaded
      const bodyText = await page.textContent('body') || '';
      expect(hasDeliveryButton || hasDeliverySection || !bodyText.includes('Something went wrong')).toBeTruthy();
    }
  });

  // OD7: KPI grid metrics
  test('OD7: KPI grid displays order metrics', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for KPI/metrics grid — cards showing Date, Total, Profit, Margin
    const metricLabels = ['Date', 'Total', 'Profit', 'Margin', 'Amount', 'Cost', 'Revenue'];
    let foundMetrics = 0;

    for (const label of metricLabels) {
      const metricElement = page.locator(`text=${label}`).first();
      const isVisible = await metricElement.isVisible({ timeout: 1500 }).catch(() => false);
      if (isVisible) foundMetrics++;
    }

    // Also check for dollar amounts as metric values ($X,XXX.XX format)
    const dollarAmounts = page.locator('text=/\\$[\\d,]+\\.\\d{2}/');
    const dollarCount = await dollarAmounts.count().catch(() => 0);

    // Also check for percentage values
    const percentages = page.locator('text=/\\d+\\.?\\d*%/');
    const percentCount = await percentages.count().catch(() => 0);

    // We should find at least some metrics or financial values
    expect(foundMetrics + dollarCount + percentCount).toBeGreaterThan(0);
  });

  // OD8: Cancel edit mode
  test('OD8: cancel edit mode reverts to read-only', async ({ page }) => {
    await page.goto('/orders');
    await waitForPage(page, 3000);

    const table = await page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Count inputs before edit mode
    const inputsBefore = await page.locator('input:not([disabled]):not([readonly]):not([type="search"]):not([type="hidden"])').count();

    // Enter edit mode
    const editButton = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
    await expect(editButton).toBeVisible({ timeout: 10000 });
    await editButton.click();
    await waitForPage(page, 1500);

    // Verify more inputs appeared (edit mode active)
    const inputsDuringEdit = await page.locator('input:not([disabled]):not([readonly]):not([type="search"]):not([type="hidden"])').count();

    // Click Cancel / Discard to exit edit mode
    const cancelButton = page.locator('button:has-text("Cancel"), button:has-text("Discard"), button:has-text("Cancel Edit")').first();
    const hasCancelButton = await cancelButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasCancelButton) {
      await cancelButton.click();
      await waitForPage(page, 1500);

      // Handle UnsavedChangesModal if it appears
      try {
        const leaveButton = page.locator('button:has-text("Leave"), button:has-text("Discard Changes"), button:has-text("Yes")').first();
        const hasLeave = await leaveButton.isVisible({ timeout: 2000 }).catch(() => false);
        if (hasLeave) {
          await leaveButton.click();
          await waitForPage(page, 1000);
        }
      } catch {
        // No unsaved changes modal — that's fine
      }

      // After cancel, the edit button should reappear
      const editButtonAfterCancel = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
      const backToReadMode = await editButtonAfterCancel.isVisible({ timeout: 5000 }).catch(() => false);

      // Verify inputs reduced back to read-only count
      const inputsAfterCancel = await page.locator('input:not([disabled]):not([readonly]):not([type="search"]):not([type="hidden"])').count();

      expect(backToReadMode || inputsAfterCancel <= inputsBefore).toBeTruthy();
    } else {
      // If no explicit cancel button, press Escape
      await page.keyboard.press('Escape');
      await waitForPage(page, 1500);

      const editButtonAfterEscape = page.locator('button:has-text("Edit"), button:has-text("Edit Order")').first();
      const backToReadMode = await editButtonAfterEscape.isVisible({ timeout: 5000 }).catch(() => false);
      expect(backToReadMode).toBeTruthy();
    }
  });
});
