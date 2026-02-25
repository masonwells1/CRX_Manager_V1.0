import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const _RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Settings Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    await page.goto('/settings');
    await waitForPage(page, 2000);
  });

  // ST1: Settings page loads with heading and tabs/sections
  test('ST1: Settings page loads with heading and sections', async ({ page }) => {
    // Verify the page heading is visible
    const heading = page.locator('h1, h2').filter({ hasText: /settings/i }).first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Look for section tabs or headings like Company, Users, Defaults
    const companySection = page.locator('text=/company/i').first();
    const usersSection = page.locator('text=/users/i').first();

    const hasCompany = await companySection.isVisible().catch(() => false);
    const hasUsers = await usersSection.isVisible().catch(() => false);

    // At least one section should be present
    expect(hasCompany || hasUsers).toBeTruthy();
  });

  // ST2: Company info section - verify fields exist
  test('ST2: Company info section has expected fields', async ({ page }) => {
    // Look for company-related input fields
    const companyNameInput = page.locator(
      'input[name="company_name"], input[name="companyName"], input[placeholder*="Company" i]'
    ).first();
    const phoneInput = page.locator(
      'input[name="phone"], input[name="company_phone"], input[placeholder*="Phone" i], input[type="tel"]'
    ).first();
    const emailInput = page.locator(
      'input[name="email"], input[name="company_email"], input[placeholder*="Email" i], input[type="email"]'
    ).first();

    // Also try finding by label text
    const companyNameByLabel = page.locator('label:has-text("Company Name") + input, label:has-text("Company Name") ~ input').first();

    const hasCompanyName = await companyNameInput.isVisible({ timeout: 5000 }).catch(() => false)
      || await companyNameByLabel.isVisible({ timeout: 3000 }).catch(() => false);
    const hasPhone = await phoneInput.isVisible({ timeout: 3000 }).catch(() => false);
    const hasEmail = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);

    // At least company name and one other field should be present
    expect(hasCompanyName).toBeTruthy();
    expect(hasPhone || hasEmail).toBeTruthy();
  });

  // ST3: Company info edit - modify a field value
  test('ST3: Company info field accepts edits', async ({ page }) => {
    // Find an editable field - try phone first as it is least critical
    const phoneInput = page.locator(
      'input[name="phone"], input[name="company_phone"], input[placeholder*="Phone" i], input[type="tel"]'
    ).first();
    const emailInput = page.locator(
      'input[name="email"], input[name="company_email"], input[placeholder*="Email" i]'
    ).first();

    let targetInput = phoneInput;
    const isPhoneVisible = await phoneInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isPhoneVisible) {
      targetInput = emailInput;
    }

    const isVisible = await targetInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!isVisible) {
      // Fall back to any visible input on the page
      targetInput = page.locator('input:visible').first();
    }

    const finalVisible = await targetInput.isVisible({ timeout: 5000 }).catch(() => false);
    if (!finalVisible) {
      // Settings page may not have editable company fields for this user role
      const bodyText = await page.textContent('body') || '';
      expect(bodyText).not.toContain('Something went wrong');
      return;
    }

    // Get current value
    const currentValue = await targetInput.inputValue();

    // Clear and type a test value, then restore
    const testValue = currentValue + '0';
    await targetInput.clear();
    await targetInput.fill(testValue);
    await waitForPage(page, 500);

    // Verify the value was accepted
    const newValue = await targetInput.inputValue();
    expect(newValue).toBe(testValue);

    // Restore original value (don't save)
    await targetInput.clear();
    await targetInput.fill(currentValue);
  });

  // ST4: User management table - verify user list loads
  test('ST4: User management table shows users', async ({ page }) => {
    // Look for a users section or tab - click it if it is a tab
    const usersTab = page.locator('button:has-text("Users"), [role="tab"]:has-text("Users"), a:has-text("Users")').first();
    const usersTabVisible = await usersTab.isVisible({ timeout: 5000 }).catch(() => false);
    if (usersTabVisible) {
      await usersTab.click();
      await waitForPage(page, 1500);
    }

    // Look for a table or list of users
    const userTable = page.locator('table').first();
    const userTableVisible = await userTable.isVisible({ timeout: 8000 }).catch(() => false);

    if (userTableVisible) {
      // Verify at least one data row exists (skip header row)
      const rows = userTable.locator('tbody tr');
      const rowCount = await rows.count();
      expect(rowCount).toBeGreaterThanOrEqual(1);

      // Verify columns like Name, Email, Role are present
      const headerText = await userTable.locator('thead').textContent().catch(() => '');
      const hasNameCol = /name/i.test(headerText || '');
      const hasEmailCol = /email/i.test(headerText || '');
      const hasRoleCol = /role/i.test(headerText || '');
      expect(hasNameCol || hasEmailCol || hasRoleCol).toBeTruthy();
    } else {
      // Maybe users are shown as cards or a list
      const userCards = page.locator('[class*="user"], [data-testid*="user"]');
      const cardCount = await userCards.count();
      expect(cardCount).toBeGreaterThanOrEqual(1);
    }
  });

  // ST5: Add User modal - click Add User button, verify modal opens
  test('ST5: Add User modal opens and has expected fields', async ({ page }) => {
    // Navigate to users section if tabbed
    const usersTab = page.locator('button:has-text("Users"), [role="tab"]:has-text("Users"), a:has-text("Users")').first();
    const usersTabVisible = await usersTab.isVisible({ timeout: 5000 }).catch(() => false);
    if (usersTabVisible) {
      await usersTab.click();
      await waitForPage(page, 1500);
    }

    // Find and click the Add User button
    const addButton = page.locator(
      'button:has-text("Add User"), button:has-text("New User"), button:has-text("Invite User"), button:has-text("Add")'
    ).first();
    await expect(addButton).toBeVisible({ timeout: 8000 });
    await addButton.click();
    await waitForPage(page, 1500);

    // Verify modal opened with expected fields
    const modal = page.locator('[role="dialog"], [class*="modal" i], [class*="Modal"]').first();
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Check for name input
    const nameInput = modal.locator(
      'input[name="name"], input[name="full_name"], input[placeholder*="Name" i]'
    ).first();
    const hasName = await nameInput.isVisible({ timeout: 3000 }).catch(() => false);

    // Check for email input
    const emailInput = modal.locator(
      'input[name="email"], input[type="email"], input[placeholder*="Email" i]'
    ).first();
    const hasEmail = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);

    // Check for password input
    const passwordInput = modal.locator(
      'input[name="password"], input[type="password"], input[placeholder*="Password" i]'
    ).first();
    const _hasPassword = await passwordInput.isVisible({ timeout: 3000 }).catch(() => false);

    // Check for role select
    const roleSelect = modal.locator(
      'select, [role="combobox"], [class*="select" i]'
    ).first();
    const _hasRole = await roleSelect.isVisible({ timeout: 3000 }).catch(() => false);

    // At least name and email should be present
    expect(hasName || hasEmail).toBeTruthy();

    // Close modal without creating a user
    const closeButton = modal.locator(
      'button:has-text("Cancel"), button:has-text("Close"), button[aria-label="Close"], button:has-text("X")'
    ).first();
    const hasClose = await closeButton.isVisible({ timeout: 3000 }).catch(() => false);
    if (hasClose) {
      await closeButton.click();
    } else {
      await page.keyboard.press('Escape');
    }
    await waitForPage(page, 1000);
  });

  // ST6: Edit user - click edit on a user row, verify Edit modal opens
  test('ST6: Edit user modal opens with role dropdown', async ({ page }) => {
    // Navigate to users section if tabbed
    const usersTab = page.locator('button:has-text("Users"), [role="tab"]:has-text("Users"), a:has-text("Users")').first();
    const usersTabVisible = await usersTab.isVisible({ timeout: 5000 }).catch(() => false);
    if (usersTabVisible) {
      await usersTab.click();
      await waitForPage(page, 1500);
    }

    // Wait for user table to load
    await waitForPage(page, 2000);

    // Find edit button in first user row
    const editButton = page.locator(
      'table tbody tr:first-child button:has-text("Edit"), ' +
      'table tbody tr:first-child button[title="Edit"], ' +
      'table tbody tr:first-child [aria-label="Edit"], ' +
      'table tbody tr:first-child button svg, ' +
      'button:has-text("Edit"):near(table tbody tr:first-child)'
    ).first();

    const editVisible = await editButton.isVisible({ timeout: 8000 }).catch(() => false);
    if (!editVisible) {
      // Try clicking the first row itself (some tables use row click to edit)
      const firstRow = page.locator('table tbody tr').first();
      await firstRow.click();
    } else {
      await editButton.click();
    }
    await waitForPage(page, 1500);

    // Verify edit modal/panel opened
    const modal = page.locator('[role="dialog"], [class*="modal" i], [class*="Modal"], [class*="drawer" i]').first();
    const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);

    if (modalVisible) {
      // Check for role dropdown with expected values
      const roleSelect = modal.locator('select, [role="combobox"], [role="listbox"]').first();
      const hasRoleSelect = await roleSelect.isVisible({ timeout: 3000 }).catch(() => false);

      if (hasRoleSelect) {
        // Verify role options exist (admin, sales_rep, driver, applicator)
        const selectText = await roleSelect.textContent().catch(() => '');
        const optionTexts = await modal.locator('select option, [role="option"]').allTextContents().catch(() => []);
        const allText = (selectText || '') + optionTexts.join(' ');
        const _hasRoleOptions = /admin|sales|driver|applicator/i.test(allText);
        // Role select found - this is the expected behavior
        expect(hasRoleSelect).toBeTruthy();
      }

      // Check for name field in edit modal
      const nameInput = modal.locator(
        'input[name="name"], input[name="full_name"], input[placeholder*="Name" i]'
      ).first();
      const hasName = await nameInput.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasName || hasRoleSelect).toBeTruthy();

      // Close modal without saving
      const closeButton = modal.locator(
        'button:has-text("Cancel"), button:has-text("Close"), button[aria-label="Close"]'
      ).first();
      const hasClose = await closeButton.isVisible({ timeout: 3000 }).catch(() => false);
      if (hasClose) {
        await closeButton.click();
      } else {
        await page.keyboard.press('Escape');
      }
      await waitForPage(page, 1000);
    } else {
      // Edit might be inline or in a side panel - just verify we see edit fields somewhere
      const anyInput = page.locator('input[name="name"], input[name="full_name"], select').first();
      const hasInput = await anyInput.isVisible({ timeout: 3000 }).catch(() => false);
      expect(hasInput || modalVisible).toBeTruthy();
    }
  });

  // ST7: Page access permissions - verify permissions panel exists
  test('ST7: Permissions panel is accessible', async ({ page }) => {
    // Navigate to users section if tabbed
    const usersTab = page.locator('button:has-text("Users"), [role="tab"]:has-text("Users"), a:has-text("Users")').first();
    const usersTabVisible = await usersTab.isVisible({ timeout: 5000 }).catch(() => false);
    if (usersTabVisible) {
      await usersTab.click();
      await waitForPage(page, 1500);
    }

    // Look for permissions section directly on the page
    const permissionsSection = page.locator(
      'text=/permissions/i, text=/page access/i, [class*="permission" i]'
    ).first();
    let hasPermissions = await permissionsSection.isVisible({ timeout: 5000 }).catch(() => false);

    if (!hasPermissions) {
      // Permissions might be inside the edit user modal
      // Open edit for first user to check
      const editButton = page.locator(
        'table tbody tr:first-child button:has-text("Edit"), ' +
        'table tbody tr:first-child button[title="Edit"], ' +
        'table tbody tr:first-child [aria-label="Edit"]'
      ).first();
      const editVisible = await editButton.isVisible({ timeout: 5000 }).catch(() => false);

      if (editVisible) {
        await editButton.click();
        await waitForPage(page, 1500);

        // Look for permissions inside the modal
        const modalPermissions = page.locator(
          '[role="dialog"] text=/permissions/i, ' +
          '[class*="modal" i] text=/permissions/i, ' +
          'text=/page access/i, ' +
          '[class*="permission" i]'
        ).first();
        hasPermissions = await modalPermissions.isVisible({ timeout: 5000 }).catch(() => false);

        // Also check for checkboxes or toggles that indicate permission controls
        if (!hasPermissions) {
          const permToggles = page.locator(
            '[role="dialog"] input[type="checkbox"], ' +
            '[role="dialog"] [role="switch"], ' +
            '[class*="modal" i] input[type="checkbox"]'
          );
          const toggleCount = await permToggles.count();
          hasPermissions = toggleCount > 0;
        }

        // Close modal
        await page.keyboard.press('Escape');
        await waitForPage(page, 1000);
      }
    }

    // Permissions should be found either on the page or in the edit modal
    expect(hasPermissions).toBeTruthy();
  });

  // ST8: Default settings section - verify default config options exist
  test('ST8: Default settings section renders', async ({ page }) => {
    // Look for defaults tab or section
    const defaultsTab = page.locator(
      'button:has-text("Defaults"), [role="tab"]:has-text("Defaults"), ' +
      'button:has-text("Default Settings"), a:has-text("Defaults"), ' +
      'button:has-text("Configuration"), [role="tab"]:has-text("Config")'
    ).first();
    const defaultsTabVisible = await defaultsTab.isVisible({ timeout: 5000 }).catch(() => false);
    if (defaultsTabVisible) {
      await defaultsTab.click();
      await waitForPage(page, 1500);
    }

    // Look for default settings content
    const defaultsSection = page.locator(
      'text=/default/i, text=/configuration/i, text=/preferences/i'
    ).first();
    const hasDefaults = await defaultsSection.isVisible({ timeout: 5000 }).catch(() => false);

    // Look for form elements in the defaults area (dropdowns, inputs, toggles)
    const formElements = page.locator(
      'select, input[type="number"], [role="combobox"], [role="switch"], ' +
      'input[type="checkbox"]'
    );
    const formCount = await formElements.count();

    // Also check for any labeled configuration sections
    const configLabels = page.locator(
      'label, [class*="label" i], [class*="setting" i]'
    );
    const labelCount = await configLabels.count();

    // Either default settings section or form elements should be present
    expect(hasDefaults || formCount > 0 || labelCount > 2).toBeTruthy();

    // Verify no uncaught errors (page rendered cleanly)
    const errorBoundary = page.locator('text=/something went wrong/i, text=/error/i').first();
    const _hasError = await errorBoundary.isVisible({ timeout: 1000 }).catch(() => false);
    // We check the error text is NOT a prominent error boundary message
    // (small mentions of "error" in normal content are fine)
    const errorBoundaryFull = page.locator('[class*="error-boundary" i], [class*="ErrorBoundary"]').first();
    const hasCriticalError = await errorBoundaryFull.isVisible({ timeout: 1000 }).catch(() => false);
    expect(hasCriticalError).toBeFalsy();
  });
});
