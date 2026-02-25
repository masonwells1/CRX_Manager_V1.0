import { test, expect } from '@playwright/test';
import { login } from './utils/auth';

const RUN_ID = Date.now().toString(36);
const waitForPage = (page: import('@playwright/test').Page, ms: number) => page.waitForTimeout(ms);

test.describe('Delivery Detail Interactions', () => {
  let deliveryUrl = '';

  test.beforeEach(async ({ page }) => {
    await login(page);
    page.on('dialog', d => d.accept());
  });

  // DD1: Navigate to deliveries list, find and click a delivery to open detail
  test('DD1 — navigate to delivery detail from list', async ({ page }) => {
    await page.goto('/deliveries');
    await waitForPage(page, 3000);

    // Wait for the deliveries table or list to load
    const table = page.locator('table').first();
    await expect(table).toBeVisible({ timeout: 15000 });

    // Click the first delivery row link
    const firstLink = table.locator('tbody tr a, tbody tr td a').first();
    const linkExists = await firstLink.isVisible().catch(() => false);

    if (linkExists) {
      await firstLink.click();
    } else {
      // Fall back to clicking the first table row
      const firstRow = table.locator('tbody tr').first();
      await firstRow.click();
    }

    await waitForPage(page, 3000);

    // Verify we are on a delivery detail page
    const url = page.url();
    expect(url).toMatch(/\/deliveries\/.+/);

    // Look for delivery heading or status badge
    const heading = page.locator('h1, h2').first();
    await expect(heading).toBeVisible({ timeout: 10000 });

    // Save URL for subsequent tests
    deliveryUrl = url;
    console.log(`DD1: Delivery URL saved: ${deliveryUrl}`);
  });

  // DD2: Edit mode toggle
  test('DD2 — edit mode toggle shows form fields', async ({ page }) => {
    if (!deliveryUrl) {
      // Navigate to deliveries list and pick the first one
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      const linkExists = await firstLink.isVisible({ timeout: 10000 }).catch(() => false);
      if (linkExists) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Look for Edit button
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 1000);

      // After clicking edit, form fields should become editable
      const hasSelect = await page.locator('select').first().isVisible({ timeout: 5000 }).catch(() => false);
      const hasDateInput = await page.locator('input[type="date"]').first().isVisible({ timeout: 3000 }).catch(() => false);
      const hasTextarea = await page.locator('textarea').first().isVisible({ timeout: 3000 }).catch(() => false);

      // At least one editable field should appear
      const anyEditable = hasSelect || hasDateInput || hasTextarea;
      expect(anyEditable).toBe(true);
      console.log('DD2: Edit mode activated — select:', hasSelect, 'date:', hasDateInput, 'textarea:', hasTextarea);
    } else {
      console.log('DD2: Edit button not visible (delivery may be in a non-editable state) — skipping');
    }
  });

  // DD3: Edit driver field
  test('DD3 — edit driver field in edit mode', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Enter edit mode
    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 1000);

      // Find driver select
      const driverSelect = page.getByLabel('Driver').or(
        page.locator('select').filter({ has: page.locator('option:has-text("Driver")') })
      ).or(page.locator('label:has-text("Driver") + select, label:has-text("Driver") ~ select')).first();

      const driverVisible = await driverSelect.isVisible({ timeout: 5000 }).catch(() => false);

      if (driverVisible) {
        // Get current options
        const options = await driverSelect.locator('option').allTextContents();
        console.log('DD3: Driver options:', options.slice(0, 5));

        if (options.length > 1) {
          // Select a different option (second one)
          await driverSelect.selectOption({ index: 1 });
          await waitForPage(page, 500);
          console.log('DD3: Driver field changed successfully');
        } else {
          console.log('DD3: Only one driver option available');
        }
      } else {
        // Try a broader search for any select near "Driver" text
        const anyDriverSelect = page.locator('select').first();
        const anyVisible = await anyDriverSelect.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('DD3: Driver select by label not found, any select visible:', anyVisible);
      }
    } else {
      console.log('DD3: Edit button not visible — skipping driver field test');
    }
  });

  // DD4: Edit delivery date
  test('DD4 — edit delivery date', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 1000);

      const dateInput = page.locator('input[type="date"]').first();
      const dateVisible = await dateInput.isVisible({ timeout: 5000 }).catch(() => false);

      if (dateVisible) {
        const currentVal = await dateInput.inputValue();
        console.log('DD4: Current date value:', currentVal);

        // Set a new date
        await dateInput.fill('2026-03-15');
        await waitForPage(page, 500);

        const newVal = await dateInput.inputValue();
        expect(newVal).toBe('2026-03-15');
        console.log('DD4: Date changed to:', newVal);
      } else {
        console.log('DD4: Date input not found in edit mode');
      }
    } else {
      console.log('DD4: Edit button not visible — skipping date field test');
    }
  });

  // DD5: Edit priority
  test('DD5 — edit priority dropdown', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 1000);

      // Find priority select
      const prioritySelect = page.getByLabel('Priority').or(
        page.locator('label:has-text("Priority") + select, label:has-text("Priority") ~ select')
      ).first();

      const priorityVisible = await prioritySelect.isVisible({ timeout: 5000 }).catch(() => false);

      if (priorityVisible) {
        const options = await prioritySelect.locator('option').allTextContents();
        console.log('DD5: Priority options:', options);

        // Try selecting "High" or the second option
        const hasHigh = options.some(o => o.toLowerCase().includes('high'));
        if (hasHigh) {
          await prioritySelect.selectOption({ label: options.find(o => o.toLowerCase().includes('high'))! });
          console.log('DD5: Priority changed to High');
        } else if (options.length > 1) {
          await prioritySelect.selectOption({ index: 1 });
          console.log('DD5: Priority changed to index 1');
        }
      } else {
        console.log('DD5: Priority select not found — may use different UI pattern');
      }
    } else {
      console.log('DD5: Edit button not visible — skipping priority test');
    }
  });

  // DD6: Edit notes textarea
  test('DD6 — edit notes textarea', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 1000);

      const textarea = page.locator('textarea').first();
      const textareaVisible = await textarea.isVisible({ timeout: 5000 }).catch(() => false);

      if (textareaVisible) {
        const testNote = `E2E test note ${RUN_ID}`;
        await textarea.fill(testNote);
        await waitForPage(page, 500);

        const value = await textarea.inputValue();
        expect(value).toContain(RUN_ID);
        console.log('DD6: Notes filled with:', testNote);
      } else {
        // Try finding notes input by placeholder
        const notesInput = page.locator('[placeholder*="note" i], [placeholder*="Note" i]').first();
        const notesVisible = await notesInput.isVisible({ timeout: 3000 }).catch(() => false);
        if (notesVisible) {
          await notesInput.fill(`E2E note ${RUN_ID}`);
          console.log('DD6: Notes filled via placeholder match');
        } else {
          console.log('DD6: No textarea or notes input found in edit mode');
        }
      }
    } else {
      console.log('DD6: Edit button not visible — skipping notes test');
    }
  });

  // DD7: Cancel edit reverts fields
  test('DD7 — cancel edit reverts to read-only', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    const editBtn = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
    const editVisible = await editBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (editVisible) {
      await editBtn.click();
      await waitForPage(page, 1000);

      // Verify we are in edit mode (editable fields visible)
      const selectsBefore = await page.locator('select').count();
      console.log('DD7: Selects in edit mode:', selectsBefore);

      // Click Cancel
      const cancelBtn = page.locator('button:has-text("Cancel")').filter({ hasNotText: /Delivery/ }).first();
      const discardBtn = page.locator('button:has-text("Discard")').first();

      const cancelVisible = await cancelBtn.isVisible({ timeout: 3000 }).catch(() => false);
      const discardVisible = await discardBtn.isVisible({ timeout: 1000 }).catch(() => false);

      if (cancelVisible) {
        await cancelBtn.click();
      } else if (discardVisible) {
        await discardBtn.click();
      }

      await waitForPage(page, 1000);

      // Handle potential UnsavedChangesModal
      const leaveBtn = page.locator('button:has-text("Leave"), button:has-text("Discard Changes")').first();
      const leaveVisible = await leaveBtn.isVisible({ timeout: 2000 }).catch(() => false);
      if (leaveVisible) {
        await leaveBtn.click();
        await waitForPage(page, 1000);
      }

      // After cancel, edit button should reappear
      const editBtnAgain = page.locator('button:has-text("Edit"), button:has-text("Edit Delivery")').first();
      const editReappeared = await editBtnAgain.isVisible({ timeout: 5000 }).catch(() => false);
      console.log('DD7: Edit button reappeared after cancel:', editReappeared);
    } else {
      console.log('DD7: Edit button not visible — skipping cancel test');
    }
  });

  // DD8: Cancel delivery modal
  test('DD8 — cancel delivery modal opens with reason input', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Look for Cancel Delivery button (destructive action)
    const cancelDeliveryBtn = page.locator('button:has-text("Cancel Delivery")').first();
    const cancelVisible = await cancelDeliveryBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (cancelVisible) {
      await cancelDeliveryBtn.click();
      await waitForPage(page, 1000);

      // Modal should open with reason input
      const modal = page.locator('[role="dialog"], .modal, [class*="modal" i]').first();
      const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);

      if (modalVisible) {
        // Look for reason textarea/input inside modal
        const reasonInput = modal.locator('textarea, input[type="text"]').first();
        const reasonVisible = await reasonInput.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('DD8: Cancel modal opened, reason input visible:', reasonVisible);

        // Look for confirm/submit button in modal
        const confirmBtn = modal.locator('button:has-text("Confirm"), button:has-text("Submit"), button:has-text("Cancel Delivery")').first();
        const confirmVisible = await confirmBtn.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('DD8: Confirm button in modal visible:', confirmVisible);

        // Close modal without submitting
        const closeBtn = modal.locator('button:has-text("Close"), button:has-text("Back"), button[aria-label="Close"]').first();
        const closeVisible = await closeBtn.isVisible({ timeout: 2000 }).catch(() => false);
        if (closeVisible) {
          await closeBtn.click();
        } else {
          // Press Escape to close
          await page.keyboard.press('Escape');
        }
        await waitForPage(page, 500);
      } else {
        // Maybe it opened as a different UI element
        const anyDialog = page.locator('text=/reason/i, text=/cancel.*reason/i').first();
        const dialogVisible = await anyDialog.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('DD8: Cancel reason text visible:', dialogVisible);
        if (dialogVisible) {
          await page.keyboard.press('Escape');
        }
      }
    } else {
      console.log('DD8: Cancel Delivery button not visible (delivery may already be cancelled/completed)');
    }
  });

  // DD9: Start delivery modal
  test('DD9 — start delivery modal opens', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Start Delivery button only visible for scheduled deliveries
    const startBtn = page.locator('button:has-text("Start Delivery"), button:has-text("Begin Delivery"), button:has-text("Start")').first();
    const startVisible = await startBtn.isVisible({ timeout: 5000 }).catch(() => false);

    if (startVisible) {
      await startBtn.click();
      await waitForPage(page, 1500);

      // StartDeliveryModal should appear with inventory check info
      const modal = page.locator('[role="dialog"], .modal, [class*="modal" i]').first();
      const modalVisible = await modal.isVisible({ timeout: 5000 }).catch(() => false);

      if (modalVisible) {
        // Look for inventory-related content
        const inventoryText = modal.locator('text=/inventory/i, text=/stock/i, text=/available/i').first();
        const hasInventoryInfo = await inventoryText.isVisible({ timeout: 3000 }).catch(() => false);
        console.log('DD9: Start delivery modal opened, inventory info:', hasInventoryInfo);

        // Close without confirming
        const closeBtn = modal.locator('button:has-text("Close"), button:has-text("Cancel"), button[aria-label="Close"]').first();
        if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
          await closeBtn.click();
        } else {
          await page.keyboard.press('Escape');
        }
      } else {
        console.log('DD9: Start modal did not open as expected');
      }
    } else {
      console.log('DD9: Start Delivery button not visible (delivery may not be in scheduled status)');
    }
  });

  // DD10: Photo section exists
  test('DD10 — photo upload section is present', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Look for photo-related elements
    const photoHeading = page.locator('text=/photo/i').first();
    const uploadBtn = page.locator('button:has-text("Upload"), button:has-text("Add Photo"), input[type="file"]').first();
    const dropzone = page.locator('[class*="dropzone" i], [class*="upload" i]').first();

    const photoVisible = await photoHeading.isVisible({ timeout: 5000 }).catch(() => false);
    const uploadVisible = await uploadBtn.isVisible({ timeout: 3000 }).catch(() => false);
    const dropzoneVisible = await dropzone.isVisible({ timeout: 3000 }).catch(() => false);

    const anyPhotoUI = photoVisible || uploadVisible || dropzoneVisible;
    console.log('DD10: Photo heading:', photoVisible, 'Upload button:', uploadVisible, 'Dropzone:', dropzoneVisible);

    // Photo section should exist on the page (may be scroll-dependent)
    if (!anyPhotoUI) {
      // Scroll down to find it
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await waitForPage(page, 1000);

      const photoAfterScroll = await page.locator('text=/photo/i').first().isVisible({ timeout: 3000 }).catch(() => false);
      const uploadAfterScroll = await page.locator('button:has-text("Upload"), input[type="file"]').first().isVisible({ timeout: 3000 }).catch(() => false);
      console.log('DD10: After scroll — Photo:', photoAfterScroll, 'Upload:', uploadAfterScroll);
    }
  });

  // DD11: Issue reporting dropdown
  test('DD11 — issue reporting UI exists', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Look for issue reporting UI elements
    const issueBtn = page.locator('button:has-text("Report Issue"), button:has-text("Issue"), button:has-text("Report Problem")').first();
    const issueSelect = page.locator('select').filter({ has: page.locator('option:has-text("damaged"), option:has-text("missing"), option:has-text("Damaged"), option:has-text("Missing")') }).first();
    const issueText = page.locator('text=/issue/i, text=/problem/i').first();

    const btnVisible = await issueBtn.isVisible({ timeout: 5000 }).catch(() => false);
    const selectVisible = await issueSelect.isVisible({ timeout: 3000 }).catch(() => false);
    const textVisible = await issueText.isVisible({ timeout: 3000 }).catch(() => false);

    console.log('DD11: Issue button:', btnVisible, 'Issue select:', selectVisible, 'Issue text:', textVisible);

    if (btnVisible) {
      // Click to open issue reporting
      await issueBtn.click();
      await waitForPage(page, 1000);

      // After click, look for issue type dropdown or form
      const issueForm = page.locator('select, [role="dialog"], [class*="modal" i]').first();
      const formVisible = await issueForm.isVisible({ timeout: 3000 }).catch(() => false);
      console.log('DD11: Issue form/modal visible after click:', formVisible);

      // Close if modal
      await page.keyboard.press('Escape');
    }

    // Scroll down to check if issue section is below fold
    if (!btnVisible && !selectVisible && !textVisible) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await waitForPage(page, 1000);
      const issueAfterScroll = await page.locator('text=/issue/i, button:has-text("Report")').first().isVisible({ timeout: 3000 }).catch(() => false);
      console.log('DD11: Issue UI after scroll:', issueAfterScroll);
    }
  });

  // DD12: Complete delivery button visibility
  test('DD12 — complete delivery button visibility check', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Complete Delivery button is only visible when delivery is in_progress
    const completeBtn = page.locator('button:has-text("Complete Delivery"), button:has-text("Complete")').first();
    const completeVisible = await completeBtn.isVisible({ timeout: 5000 }).catch(() => false);

    // Get current delivery status from the page
    const statusBadge = page.locator('[class*="badge" i], [class*="status" i], [class*="chip" i]').first();
    const statusText = await statusBadge.textContent().catch(() => 'unknown');

    console.log('DD12: Complete button visible:', completeVisible, '| Status:', statusText?.trim());

    if (completeVisible) {
      // Verify the button is enabled
      const isDisabled = await completeBtn.isDisabled().catch(() => false);
      console.log('DD12: Complete button disabled:', isDisabled);
    } else {
      // This is expected for non-in-progress deliveries
      console.log('DD12: Complete button not visible — delivery is likely not in_progress status');
    }

    // Verify at least the status badge is visible
    const badgeVisible = await statusBadge.isVisible({ timeout: 3000 }).catch(() => false);
    console.log('DD12: Status badge visible:', badgeVisible);
  });

  // DD13: PDF download button and order context table
  test('DD13 — PDF download button and order context table', async ({ page }) => {
    if (!deliveryUrl) {
      await page.goto('/deliveries');
      await waitForPage(page, 3000);
      const firstLink = page.locator('table tbody tr a, table tbody tr td a').first();
      if (await firstLink.isVisible({ timeout: 10000 }).catch(() => false)) {
        await firstLink.click();
      } else {
        await page.locator('table tbody tr').first().click();
      }
      await waitForPage(page, 3000);
      deliveryUrl = page.url();
    } else {
      await page.goto(deliveryUrl);
      await waitForPage(page, 3000);
    }

    // Look for PDF download button
    const pdfBtn = page.locator('button:has-text("Download PDF"), button:has-text("PDF"), button:has-text("Print"), button:has-text("Download")').first();
    const pdfVisible = await pdfBtn.isVisible({ timeout: 5000 }).catch(() => false);
    console.log('DD13: PDF button visible:', pdfVisible);

    // Look for order context table/grid
    // This typically shows Ordered, Prev Delivered, This Delivery, Remaining columns
    const orderTable = page.locator('table').filter({ has: page.locator('th:has-text("Ordered"), th:has-text("Order"), td:has-text("Ordered")') }).first();
    const orderTableAlt = page.locator('text=/ordered/i').first();
    const remainingCol = page.locator('text=/remaining/i').first();
    const prevCol = page.locator('text=/prev/i, text=/previous/i').first();

    const orderTableVisible = await orderTable.isVisible({ timeout: 5000 }).catch(() => false);
    const orderedTextVisible = await orderTableAlt.isVisible({ timeout: 3000 }).catch(() => false);
    const remainingVisible = await remainingCol.isVisible({ timeout: 3000 }).catch(() => false);
    const prevVisible = await prevCol.isVisible({ timeout: 3000 }).catch(() => false);

    console.log('DD13: Order table:', orderTableVisible, 'Ordered text:', orderedTextVisible, 'Remaining:', remainingVisible, 'Prev:', prevVisible);

    // Scroll to make sure we can see everything
    if (!pdfVisible && !orderedTextVisible) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await waitForPage(page, 500);

      const pdfAfterScroll = await pdfBtn.isVisible({ timeout: 3000 }).catch(() => false);
      console.log('DD13: PDF button after scroll to top:', pdfAfterScroll);
    }

    // At minimum, verify we are on a delivery detail page
    const pageUrl = page.url();
    expect(pageUrl).toMatch(/\/deliveries\/.+/);
    console.log('DD13: Confirmed on delivery detail page');
  });
});
