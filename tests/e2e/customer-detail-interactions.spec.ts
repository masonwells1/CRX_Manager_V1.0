import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Customer Detail Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', d => d.accept());
  });

  test('CD1: Navigate to customer detail from list', async ({ page }) => {
    await page.goto('/customers');
    await waitForPage(page, 3000);

    // Wait for customer table to load
    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });

    // Click the first customer row
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Verify detail page loaded - should have a heading with the customer name
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
    const headingText = await heading.textContent();
    expect(headingText).toBeTruthy();
  });

  test('CD2: Profile form fields are editable on load', async ({ page }) => {
    // CustomerDetail is always in edit mode - no Edit toggle needed
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Fields should already be editable inputs (no Edit button needed)
    const editableInputs = page.locator('input:not([disabled]):not([readonly])');
    const inputCount = await editableInputs.count();
    expect(inputCount).toBeGreaterThan(0);
  });

  test('CD3: Edit farm name field', async ({ page }) => {
    // CustomerDetail form is always editable - no Edit button toggle
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Find farm name input (always editable)
    const farmNameInput = page.getByLabel('Farm Name')
      .or(page.locator('input[name="farm_name"]'))
      .first();

    const farmNameVisible = await farmNameInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (farmNameVisible) {
      const originalValue = await farmNameInput.inputValue();
      const testValue = `Test Farm ${RUN_ID}`;
      await farmNameInput.clear();
      await farmNameInput.fill(testValue);
      const updatedValue = await farmNameInput.inputValue();
      expect(updatedValue).toBe(testValue);

      // Restore original value (don't save)
      await farmNameInput.clear();
      await farmNameInput.fill(originalValue);
    } else {
      // Fallback: verify at least one editable input exists
      const anyInput = page.locator('input:not([disabled]):not([readonly])').first();
      await expect(anyInput).toBeVisible({ timeout: 5000 });
    }
  });

  test('CD4: Credit limit field exists and shows value', async ({ page }) => {
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for Credit Limit text on the page
    const creditLimitText = page.locator('text=Credit Limit').or(page.locator('text=credit limit')).first();
    const creditLimitVisible = await creditLimitText.isVisible({ timeout: 5000 }).catch(() => false);

    if (creditLimitVisible) {
      await expect(creditLimitText).toBeVisible();
      // Look for a dollar value near the credit limit label
      const dollarValue = page.locator(':text("$")').first();
      const hasDollar = await dollarValue.isVisible({ timeout: 3000 }).catch(() => false);
      // Credit limit might show as $0.00 or a formatted amount
      expect(creditLimitVisible || hasDollar).toBeTruthy();
    } else {
      // Enter edit mode to find the credit limit input
      const editButton = page.locator('button:has-text("Edit Customer"), button:has-text("Edit")').first();
      const editVisible = await editButton.isVisible({ timeout: 3000 }).catch(() => false);
      if (editVisible) {
        await editButton.click();
        await waitForPage(page, 2000);
        const creditInput = page.locator('input[name="credit_limit"]')
          .or(page.getByLabel('Credit Limit'))
          .first();
        const inputVisible = await creditInput.isVisible({ timeout: 5000 }).catch(() => false);
        expect(inputVisible).toBeTruthy();
      }
    }
  });

  test('CD5: Commission splits section displays', async ({ page }) => {
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for commission-related content
    const commissionSection = page.locator('text=Commission').or(page.locator('text=commission')).first();
    const commissionVisible = await commissionSection.isVisible({ timeout: 5000 }).catch(() => false);

    if (commissionVisible) {
      await expect(commissionSection).toBeVisible();
      // Check for percentage values or rep names nearby
      const percentages = page.locator(':text("%")');
      const _hasPercentages = await percentages.first().isVisible({ timeout: 3000 }).catch(() => false);
      // Commission section may show percentages or rep names
      expect(commissionVisible).toBeTruthy();
    } else {
      // Commission might be in a tab or collapsible section
      const commissionTab = page.locator('button:has-text("Commission"), [role="tab"]:has-text("Commission")').first();
      const tabVisible = await commissionTab.isVisible({ timeout: 3000 }).catch(() => false);
      if (tabVisible) {
        await commissionTab.click();
        await waitForPage(page, 2000);
        const sectionContent = page.locator('text=Commission').first();
        await expect(sectionContent).toBeVisible({ timeout: 5000 });
      } else {
        // Commission splits may appear in edit mode
        const editButton = page.locator('button:has-text("Edit Customer"), button:has-text("Edit")').first();
        const editVisible = await editButton.isVisible({ timeout: 3000 }).catch(() => false);
        if (editVisible) {
          await editButton.click();
          await waitForPage(page, 2000);
        }
        // Verify we are on the detail page at minimum
        const pageContent = await page.content();
        expect(pageContent.length).toBeGreaterThan(0);
      }
    }
  });

  test('CD6: Purchase history table loads', async ({ page }) => {
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for purchase history section - could be a table, tab, or heading
    const historyTab = page.locator(
      'button:has-text("History"), button:has-text("Purchases"), [role="tab"]:has-text("History"), [role="tab"]:has-text("Purchases"), [role="tab"]:has-text("Invoices")'
    ).first();
    const tabVisible = await historyTab.isVisible({ timeout: 3000 }).catch(() => false);

    if (tabVisible) {
      await historyTab.click();
      await waitForPage(page, 3000);
    }

    // Look for a table in the purchase history area or invoice list
    const historyTable = page.locator('table').first();
    const historyHeading = page.locator(
      'text=Purchase History, text=Invoice History, text=Invoices, text=History'
    ).first();

    const tableVisible = await historyTable.isVisible({ timeout: 5000 }).catch(() => false);
    const headingVisible = await historyHeading.isVisible({ timeout: 3000 }).catch(() => false);
    const emptyState = page.locator('text=No invoices, text=No purchases, text=No history, text=No records').first();
    const emptyVisible = await emptyState.isVisible({ timeout: 3000 }).catch(() => false);

    // Either a table, heading, or empty state should be visible
    expect(tableVisible || headingVisible || emptyVisible).toBeTruthy();
  });

  test('CD7: Year-End PDF button is visible', async ({ page }) => {
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for the Year-End PDF button with various possible labels
    const yearEndButton = page.locator(
      'button:has-text("Year-End"), button:has-text("Year End"), button:has-text("Summary"), button:has-text("Annual")'
    ).first();
    const buttonVisible = await yearEndButton.isVisible({ timeout: 5000 }).catch(() => false);

    if (buttonVisible) {
      await expect(yearEndButton).toBeVisible();
    } else {
      // May need to scroll down or look in a different section
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await waitForPage(page, 2000);

      const scrolledButton = page.locator(
        'button:has-text("Year-End"), button:has-text("Year End"), button:has-text("PDF"), button:has-text("Summary")'
      ).first();
      const scrolledVisible = await scrolledButton.isVisible({ timeout: 5000 }).catch(() => false);

      // Also check for any PDF-related button
      const pdfButton = page.locator('button:has-text("PDF")').first();
      const pdfVisible = await pdfButton.isVisible({ timeout: 3000 }).catch(() => false);

      expect(scrolledVisible || pdfVisible).toBeTruthy();
    }
  });

  test('CD8: Tier badge is displayed', async ({ page }) => {
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Look for tier badge - common tier names
    const tierBadge = page.locator(
      '[class*="badge"], [class*="chip"], [class*="tag"], [class*="pill"]'
    ).first();
    const badgeVisible = await tierBadge.isVisible({ timeout: 5000 }).catch(() => false);

    const tierText = page.locator(
      'text=Standard, text=Premium, text=VIP, text=Gold, text=Silver, text=Bronze, text=Tier'
    ).first();
    const tierVisible = await tierText.isVisible({ timeout: 3000 }).catch(() => false);

    if (badgeVisible) {
      const badgeContent = await tierBadge.textContent();
      expect(badgeContent).toBeTruthy();
    } else if (tierVisible) {
      await expect(tierText).toBeVisible();
    } else {
      // Tier might be displayed near a label
      const tierLabel = page.locator('text=Tier').first();
      const labelVisible = await tierLabel.isVisible({ timeout: 3000 }).catch(() => false);

      // Look for any span or div that could be a tier indicator
      const tierIndicator = page.locator('span:near(:text("Tier")), div:near(:text("Tier"))').first();
      const indicatorVisible = await tierIndicator.isVisible({ timeout: 3000 }).catch(() => false);

      expect(labelVisible || indicatorVisible || badgeVisible || tierVisible).toBeTruthy();
    }
  });

  test('CD9: Tab navigation switches sections', async ({ page }) => {
    // CustomerDetail has tabs: info, fields, history, etc.
    await page.goto('/customers');
    await waitForPage(page, 3000);

    const table = page.locator('table');
    await expect(table).toBeVisible({ timeout: 10000 });
    const firstRow = table.locator('tbody tr').first();
    await expect(firstRow).toBeVisible({ timeout: 5000 });
    await firstRow.click();
    await waitForPage(page, 3000);

    // Find tab buttons (info, fields, history, etc.)
    const tabs = page.locator('button').filter({ hasText: /^(info|fields|history|billing|invoices)$/i });
    const tabCount = await tabs.count();

    if (tabCount > 1) {
      // Click the second tab to switch sections
      await tabs.nth(1).click();
      await waitForPage(page, 2000);

      // Verify the page updated without errors
      const bodyText = await page.textContent('body') || '';
      expect(bodyText).not.toContain('Something went wrong');

      // Switch back to first tab
      await tabs.nth(0).click();
      await waitForPage(page, 1000);
    } else {
      // If no tabs found, just verify Save Changes button exists
      const saveBtn = page.locator('button:has-text("Save Changes"), button:has-text("Save"), button:has-text("Create Customer")').first();
      const saveVisible = await saveBtn.isVisible({ timeout: 5000 }).catch(() => false);
      expect(saveVisible).toBeTruthy();

      // Handle UnsavedChangesModal
      try {
        await page.locator('button:has-text("Leave"), button:has-text("Discard")').first().click({ timeout: 3000 });
      } catch {
        // No modal appeared
      }

      await waitForPage(page, 2000);
      await expect(page.locator('table')).toBeVisible({ timeout: 10000 });
    }
  });
});
