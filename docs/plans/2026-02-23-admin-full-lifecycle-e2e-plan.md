# Admin Full-Lifecycle E2E Test — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Create a comprehensive Playwright E2E test that exercises the complete admin workflow: quote → order → partial delivery → full delivery → invoice → return, plus inventory verification and team board communication.

**Architecture:** Single spec file with `test.describe.serial()` blocks sharing state across sequential tests. Hybrid data approach: existing customers/products, fresh quotes/orders/deliveries.

**Tech Stack:** Playwright, TypeScript, Supabase (live dev DB via localhost:5173)

---

### Task 1: Create the spec file with shared state and auth

**Files:**
- Create: `tests/e2e/workflow-admin-full-lifecycle.spec.ts`

**Step 1: Write the file scaffold with shared state variables**

The test file needs shared state between serial tests to track IDs created in earlier steps.

**Step 2: Run test to verify scaffold loads**

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx playwright test workflow-admin-full-lifecycle --headed 2>&1 | head -20`

**Step 3: Commit scaffold**

```bash
git add tests/e2e/workflow-admin-full-lifecycle.spec.ts
git commit -m "test: scaffold admin full-lifecycle E2E spec"
```

---

### Task 2: Implement Suite 1 — Quote to Return lifecycle (T1–T15)

**Files:**
- Modify: `tests/e2e/workflow-admin-full-lifecycle.spec.ts`

All 15 tests in `test.describe.serial('Admin Full Lifecycle')`.

Key selectors verified from source code:
- Customer select: `select` with option "Select a customer..."
- Add Item button: `button:has-text("Add Item")`
- Product picker: `button:has-text("Select Product")` → modal with `input[placeholder="Search by name, SKU, category, or vendor..."]`
- Save Draft: `button:has-text("Save Draft")`
- Send Quote: `button:has-text("Send Quote")` → confirm `button:has-text("Confirm Send")`
- Convert to Order: `button:has-text("Convert to Order")` → confirm `button:has-text("Create Order")`
- Schedule Delivery: `button:has-text("Schedule Delivery")`
- NewDelivery order select: `select` with option "Select an order..."
- Start Delivery: `button:has-text("Start Delivery")`
- Complete Delivery: `button:has-text("Complete Delivery")`
- Signed By input: `input[placeholder="Customer name"]` (label "Signed By")
- Post Invoice: `button:has-text("Post")`
- New Return: `button:has-text("New Return")`
- Return customer select: option "Select Customer"
- Return reason select: options Defective/Damaged/Wrong Product/Overstock/Expired/Other
- Return product select: option "Select Product"
- Create Return: `button:has-text("Create Return")`
- Approve return: `button:has-text("Approve")`
- Receive return: `button:has-text("Receive")`

---

### Task 3: Implement Suite 2 — Inventory Operations (I1–I5)

**Files:**
- Modify: `tests/e2e/workflow-admin-full-lifecycle.spec.ts`

Key selectors from InventoryPage.tsx:
- Add Inventory button: `button:has-text("Add Inventory")`
- Modal product select: option "Select Product"
- Modal quantity input: `input[type="number"]`
- Modal location: default "Main Warehouse"
- Adjust button: per-row, opens modal
- Hold button: creates inventory hold
- Release Hold button in holds section

---

### Task 4: Implement Suite 3 — Team Board Communication (B1–B5)

**Files:**
- Modify: `tests/e2e/workflow-admin-full-lifecycle.spec.ts`

Key selectors from TeamBoard.tsx:
- New Note button: button with Plus icon text
- Modal title input: `Input` with label "Title"
- Modal content: `textarea`
- Modal type select: options "Note"/"To-Do"/"Announcement"
- Modal priority select: options "Low"/"Medium"/"High"/"Urgent"
- Modal assign select: option "Unassigned" + profile names
- Modal due date: `Input` type="date" label "Due Date"
- Save button: `button:has-text("Add Note")` (create) or `button:has-text("Save Changes")` (edit)
- View tabs: buttons with text "Board"/"My Tasks"/"Completed"/"Activity"
- Card click opens detail modal
- CommentsSection component inside detail modal

---

### Task 5: Run full test suite and fix issues

Run: `cd /c/Users/mason/CRX_Manager_V1.0 && npx playwright test workflow-admin-full-lifecycle --headed`

Fix any selector or timing issues found during the run.

---

### Task 6: Final commit

```bash
git add tests/e2e/workflow-admin-full-lifecycle.spec.ts
git commit -m "test: admin full-lifecycle E2E — quote to return, inventory ops, team board"
```
