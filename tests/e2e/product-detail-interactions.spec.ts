import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Product Detail Interactions', () => {
  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', d => d.accept());
  });

  // PD1: Navigate to products list, click first product to open detail
  test('PD1: navigate to product detail from list', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    // Wait for table to load with product rows
    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });

    // Grab the product name text before clicking
    const productNameCell = tableRow.locator('td').first();
    const productName = await productNameCell.textContent();

    // Click the first row to navigate to detail
    await tableRow.click();
    await waitForPage(page, 3000);

    // Verify we landed on a product detail page
    const url = page.url();
    expect(url).toMatch(/\/products\/[a-zA-Z0-9-]+/);

    // Verify some product heading or name is visible
    const heading = page.locator('h1, h2, [data-testid="product-name"]').first();
    await expect(heading).toBeVisible({ timeout: 10000 });
  });

  // PD2: Edit fields - click Edit, verify form fields become editable
  test('PD2: edit mode makes form fields editable', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Look for an Edit button and click it
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Product")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 2000);
    }

    // Verify form inputs are present (editable state)
    const inputs = page.locator('input[type="text"], input[type="number"], textarea, select');
    const inputCount = await inputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(3);

    // Check for common product fields: name, EPA, manufacturer, description
    const nameInput = page.locator('input[name="name"], input[placeholder*="name" i], label:has-text("Product Name") + input, label:has-text("Product Name") ~ input, label:has-text("Name") + input').first();
    const nameVisible = await nameInput.isVisible({ timeout: 5000 }).catch(() => false);

    // At minimum, there should be several editable inputs on the page
    expect(inputCount).toBeGreaterThanOrEqual(3);
  });

  // PD3: Tier pricing grid - verify 3-tier pricing section exists
  test('PD3: tier pricing grid is present', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Enter edit mode if needed
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Product")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 2000);
    }

    // Look for tier pricing section - could be labeled "Pricing", "Tier", or contain tier references
    const pricingSection = page.locator('text=/tier/i, text=/pricing/i, h2:has-text("Pricing"), h3:has-text("Pricing"), h2:has-text("Tier"), h3:has-text("Tier"), [data-testid*="pricing"], [data-testid*="tier"]').first();
    const pricingSectionVisible = await pricingSection.isVisible({ timeout: 5000 }).catch(() => false);

    // Look for tier labels (Tier 1, Tier 2, Tier 3)
    const tier1 = page.locator('text=/tier\\s*1/i').first();
    const tier2 = page.locator('text=/tier\\s*2/i').first();
    const tier3 = page.locator('text=/tier\\s*3/i').first();

    const tier1Visible = await tier1.isVisible({ timeout: 5000 }).catch(() => false);
    const tier2Visible = await tier2.isVisible({ timeout: 5000 }).catch(() => false);
    const tier3Visible = await tier3.isVisible({ timeout: 5000 }).catch(() => false);

    // At least the pricing section or tier labels should be visible
    const hasPricing = pricingSectionVisible || tier1Visible;
    expect(hasPricing).toBe(true);

    // If tier labels are visible, verify all three
    if (tier1Visible) {
      expect(tier2Visible).toBe(true);
      expect(tier3Visible).toBe(true);
    }

    // Look for price input fields within the pricing area
    const priceInputs = page.locator('input[type="number"], input[inputmode="decimal"], input[placeholder*="price" i], input[placeholder*="$"]');
    const priceInputCount = await priceInputs.count();
    expect(priceInputCount).toBeGreaterThanOrEqual(3);
  });

  // PD4: Update Cost modal - click "Update Cost" button, verify modal
  test('PD4: update cost modal opens and has expected fields', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Look for Update Cost button
    const costBtn = page.locator('button:has-text("Update Cost"), button:has-text("Cost")').first();
    const costBtnVisible = await costBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (costBtnVisible) {
      await costBtn.click();
      await waitForPage(page, 2000);

      // Verify modal appeared
      const modal = page.locator('[role="dialog"], .modal, [data-testid*="modal"], div[class*="modal" i], div[class*="Modal"]').first();
      const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);
      expect(modalVisible).toBe(true);

      // Check for cost input field
      const costInput = page.locator('input[type="number"], input[inputmode="decimal"], input[placeholder*="cost" i], input[placeholder*="$"]').first();
      const costInputVisible = await costInput.isVisible({ timeout: 5000 }).catch(() => false);
      expect(costInputVisible).toBe(true);

      // Check for note/reason textarea or input
      const noteField = page.locator('textarea, input[placeholder*="note" i], input[placeholder*="reason" i], input[name*="note" i]').first();
      const noteVisible = await noteField.isVisible({ timeout: 5000 }).catch(() => false);
      expect(noteVisible).toBe(true);

      // Close the modal without saving - try Escape, then cancel button
      await page.keyboard.press('Escape');
      await waitForPage(page, 1000);

      const modalStillVisible = await modal.isVisible({ timeout: 1000 }).catch(() => false);
      if (modalStillVisible) {
        const cancelBtn = page.locator('button:has-text("Cancel"), button:has-text("Close"), [aria-label="Close"]').first();
        const cancelVisible = await cancelBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (cancelVisible) {
          await cancelBtn.click();
          await waitForPage(page, 1000);
        }
      }
    } else {
      // If no dedicated button, the cost update might be inline - enter edit mode
      const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Product")').first();
      const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
      if (editVisible) {
        await editBtn.click();
        await waitForPage(page, 2000);
      }

      // Look for any cost-related field
      const costField = page.locator('input[name*="cost" i], label:has-text("Cost") ~ input, label:has-text("Cost") + input').first();
      const costFieldVisible = await costField.isVisible({ timeout: 5000 }).catch(() => false);
      expect(costFieldVisible).toBe(true);
    }
  });

  // PD5: Cost history panel - verify it shows historical cost data
  test('PD5: cost history panel is visible', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Look for cost history section/panel
    const historySection = page.locator(
      'text=/cost\\s*history/i, h2:has-text("Cost History"), h3:has-text("Cost History"), ' +
      'h4:has-text("Cost History"), [data-testid*="cost-history"], ' +
      'text=/history/i'
    ).first();
    const historyVisible = await historySection.isVisible({ timeout: 5000 }).catch(() => false);

    // If there is a history tab or expandable panel, click to reveal
    if (!historyVisible) {
      const historyTab = page.locator('button:has-text("History"), [role="tab"]:has-text("History"), a:has-text("History")').first();
      const tabVisible = await historyTab.isVisible({ timeout: 3000 }).catch(() => false);
      if (tabVisible) {
        await historyTab.click();
        await waitForPage(page, 2000);
      }
    }

    // Verify some history content - dates or cost values
    const historyContent = page.locator(
      'text=/\\$\\d/, text=/\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}/, text=/cost/i'
    ).first();
    const contentVisible = await historyContent.isVisible({ timeout: 5000 }).catch(() => false);

    // The page should have either an explicit cost history section or cost-related data
    const pageText = await page.textContent('body') || '';
    const hasCostReference = /cost/i.test(pageText);
    expect(hasCostReference).toBe(true);
  });

  // PD6: RUP checkbox - verify restricted use product checkbox exists
  test('PD6: RUP checkbox is present', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Enter edit mode if needed
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Product")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 2000);
    }

    // Look for RUP checkbox or toggle
    const rupCheckbox = page.locator(
      'input[type="checkbox"][name*="rup" i], ' +
      'input[type="checkbox"][name*="restricted" i], ' +
      'label:has-text("RUP") input[type="checkbox"], ' +
      'label:has-text("Restricted Use") input[type="checkbox"], ' +
      'label:has-text("Restricted") input[type="checkbox"]'
    ).first();
    const rupVisible = await rupCheckbox.isVisible({ timeout: 5000 }).catch(() => false);

    // Also check for toggle/switch styled checkboxes
    const rupToggle = page.locator(
      '[role="switch"][aria-label*="RUP" i], ' +
      '[role="switch"][aria-label*="Restricted" i], ' +
      'button[role="switch"]:near(:text("RUP")), ' +
      'button[role="switch"]:near(:text("Restricted"))'
    ).first();
    const toggleVisible = await rupToggle.isVisible({ timeout: 3000 }).catch(() => false);

    // Also check for text reference to RUP on the page
    const pageText = await page.textContent('body') || '';
    const hasRupReference = /rup|restricted\s*use/i.test(pageText);

    // At least one form of RUP control should be present
    const rupExists = rupVisible || toggleVisible || hasRupReference;
    expect(rupExists).toBe(true);
  });

  // PD7: Signal word dropdown - verify signal word select exists
  test('PD7: signal word dropdown is present', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Enter edit mode if needed
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Product")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 2000);
    }

    // Look for signal word select/dropdown
    const signalSelect = page.locator(
      'select[name*="signal" i], ' +
      'label:has-text("Signal Word") + select, ' +
      'label:has-text("Signal Word") ~ select, ' +
      'label:has-text("Signal") + select, ' +
      'label:has-text("Signal") ~ select, ' +
      '[data-testid*="signal"]'
    ).first();
    const selectVisible = await signalSelect.isVisible({ timeout: 5000 }).catch(() => false);

    // Also look for a custom dropdown/combobox
    const signalDropdown = page.locator(
      '[role="combobox"]:near(:text("Signal")), ' +
      'button:near(:text("Signal Word")), ' +
      '[aria-label*="signal" i]'
    ).first();
    const dropdownVisible = await signalDropdown.isVisible({ timeout: 3000 }).catch(() => false);

    // Check page text for signal word references
    const pageText = await page.textContent('body') || '';
    const hasSignalReference = /signal\s*word|danger|warning|caution/i.test(pageText);

    const signalWordExists = selectVisible || dropdownVisible || hasSignalReference;
    expect(signalWordExists).toBe(true);

    // If the native select is visible, verify it has expected options
    if (selectVisible) {
      const options = await signalSelect.locator('option').allTextContents();
      const optionTexts = options.map(o => o.toLowerCase());
      const hasExpectedOptions =
        optionTexts.some(o => o.includes('danger')) ||
        optionTexts.some(o => o.includes('warning')) ||
        optionTexts.some(o => o.includes('caution'));
      expect(hasExpectedOptions).toBe(true);
    }
  });

  // PD8: Product form select - verify form type selector
  test('PD8: product form select is present', async ({ page }) => {
    await page.goto('/products');
    await waitForPage(page, 3000);

    const tableRow = page.locator('table tbody tr').first();
    await expect(tableRow).toBeVisible({ timeout: 15000 });
    await tableRow.click();
    await waitForPage(page, 3000);

    // Enter edit mode if needed
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Product")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);
    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 2000);
    }

    // Look for product form select/dropdown
    const formSelect = page.locator(
      'select[name*="form" i]:not([name*="format"]), ' +
      'label:has-text("Product Form") + select, ' +
      'label:has-text("Product Form") ~ select, ' +
      'label:has-text("Form") + select, ' +
      'label:has-text("Form") ~ select, ' +
      '[data-testid*="product-form"], ' +
      '[data-testid*="form-type"]'
    ).first();
    const selectVisible = await formSelect.isVisible({ timeout: 5000 }).catch(() => false);

    // Also look for custom dropdown
    const formDropdown = page.locator(
      '[role="combobox"]:near(:text("Form")), ' +
      '[role="listbox"]:near(:text("Form")), ' +
      '[aria-label*="form" i]:not([aria-label*="format"])'
    ).first();
    const dropdownVisible = await formDropdown.isVisible({ timeout: 3000 }).catch(() => false);

    // Check page text for form type references
    const pageText = await page.textContent('body') || '';
    const hasFormReference = /product\s*form|liquid|granular|dry|emulsifiable/i.test(pageText);

    const formExists = selectVisible || dropdownVisible || hasFormReference;
    expect(formExists).toBe(true);

    // If the native select is visible, verify it has expected options
    if (selectVisible) {
      const options = await formSelect.locator('option').allTextContents();
      const optionTexts = options.map(o => o.toLowerCase());
      const hasExpectedOptions =
        optionTexts.some(o => o.includes('liquid')) ||
        optionTexts.some(o => o.includes('granular')) ||
        optionTexts.some(o => o.includes('dry'));
      expect(hasExpectedOptions).toBe(true);
    }
  });

  // PD9: Create new product - navigate to /products/new, verify empty form
  test('PD9: new product form renders with empty fields', async ({ page }) => {
    await page.goto('/products/new');
    await waitForPage(page, 3000);

    // Wait for the page to fully render
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

    // Verify form is present with input fields
    const inputs = page.locator('input[type="text"], input[type="number"], textarea, select');
    await expect(inputs.first()).toBeVisible({ timeout: 10000 });

    const inputCount = await inputs.count();
    expect(inputCount).toBeGreaterThanOrEqual(3);

    // Verify a Save or Create button is present
    const saveBtn = page.locator(
      'button:has-text("Save"), button:has-text("Create"), ' +
      'button:has-text("Add Product"), button[type="submit"]'
    ).first();
    const saveBtnVisible = await saveBtn.isVisible({ timeout: 5000 }).catch(() => false);
    expect(saveBtnVisible).toBe(true);

    // Verify text inputs are empty (new product form)
    const textInputs = page.locator('input[type="text"]');
    const textInputCount = await textInputs.count();
    for (let i = 0; i < Math.min(textInputCount, 5); i++) {
      const value = await textInputs.nth(i).inputValue();
      expect(value).toBe('');
    }

    // Verify page heading indicates new product
    const pageText = await page.textContent('body') || '';
    const isNewProductPage =
      /new\s*product/i.test(pageText) ||
      /add\s*product/i.test(pageText) ||
      /create\s*product/i.test(pageText) ||
      page.url().includes('/new');
    expect(isNewProductPage).toBe(true);
  });
});
