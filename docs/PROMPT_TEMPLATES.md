# Prompt Templates for Claude Desktop App

Copy-paste these prompts into the Claude desktop app for common tasks. Each prompt is inside a code block so you can easily select and copy it.

---

## 1. Start of Session Prompt

**Use this:** At the beginning of every new Claude desktop session.

```
I'm working on CRX Manager, an agricultural product distribution management app. Before we do anything:

1. Read the file CLAUDE.md in the project root
2. Read the file docs/workflows/SAFE_DEVELOPMENT_RULES.md

After reading both, tell me in one sentence that you've loaded the context and are ready. Don't summarize the files — just confirm you've read them.

The project is at: C:\Users\pc\CRX_Manager_V1.0
```

---

## 2. New Feature Prompt

**Use this:** When you want Claude to build something new.

```
I want to add a new feature to CRX Manager. Here's what I need:

[DESCRIBE THE FEATURE HERE]

Before writing any code:
1. Read CLAUDE.md and docs/workflows/SAFE_DEVELOPMENT_RULES.md
2. Search the codebase to see if something similar already exists
3. Read the relevant workflow docs in docs/workflows/ for this area
4. Read the source files that would be affected

Then show me a plan that includes:
- What files you'll create or modify (exact paths)
- What database changes are needed (if any)
- What the user will see when it's done
- Any risks or things that could break

Wait for my approval before making any changes. Do NOT start coding until I say "go ahead" or "approved".
```

---

## 3. Fix Bug Prompt

**Use this:** When something isn't working right.

```
There's a bug in CRX Manager. Here's what's happening:

[DESCRIBE THE BUG — what you expected vs what actually happened]

Please fix this systematically:
1. First, read the relevant source files to understand the current code
2. Identify the root cause (don't just guess — trace the logic)
3. Show me what you think the problem is and your proposed fix
4. Make the minimum change needed to fix it — don't refactor surrounding code
5. After fixing, run npm run typecheck and npm run build to verify nothing broke

The project is at: C:\Users\pc\CRX_Manager_V1.0
```

---

## 4. Add Database Column Prompt

**Use this:** When you need to add a new field to a database table.

```
I need to add a new column to a database table in CRX Manager.

Table: [TABLE NAME]
Column name: [COLUMN NAME]
Type: [e.g., TEXT, BIGINT, BOOLEAN, TIMESTAMPTZ, UUID]
Default value: [e.g., NULL, 'draft', NOW(), false]
Nullable: [yes/no]

Please follow the complete checklist in docs/workflows/DATABASE_CHANGE_CHECKLIST.md:
1. Create a new migration file in supabase/migrations/
2. Write idempotent SQL (using IF NOT EXISTS)
3. Update the TypeScript interface in src/types/index.ts
4. Show me the migration SQL before applying it
5. Tell me which components need to be updated to use this new column
6. Run npm run typecheck after making changes

Wait for my approval before applying the migration.
```

---

## 5. Add New Page Prompt

**Use this:** When you need a new page in the app.

```
I need a new page in CRX Manager.

Page name: [NAME]
Route: [e.g., /my-new-page]
What it should do: [DESCRIBE THE PAGE]

Please follow the 4-step checklist in docs/workflows/UI_PATTERNS.md:
1. Create the page component in src/pages/
2. Add the lazy import in src/App.tsx
3. Add the Route in the protected route block
4. Add the sidebar navigation link in AppLayout.tsx

Before building, first:
- Check that this page doesn't already exist (there are 49 pages)
- Read docs/workflows/UI_PATTERNS.md for the patterns to follow
- Show me a plan of what you'll build

Use the established patterns: useState + useEffect for data fetching, checkMutationResult for writes, Tailwind for styling, Lucide React for icons.
```

---

## 6. Pre-Deploy Check Prompt

**Use this:** Before pushing code to production.

```
Please run a pre-deploy check on CRX Manager:

1. Run npm run typecheck — are there any TypeScript errors?
2. Run npm run build — does the app build successfully?
3. Check for any console.log statements that shouldn't be in production code
4. Check for any @ts-ignore or 'any' types that were added
5. Check that no .env files are staged for commit
6. Look at the recent changes and verify:
   - All new database tables have RLS policies
   - All write operations use checkMutationResult()
   - All new user actions have logActivity() calls
   - Types in src/types/index.ts match any database changes

Report what you find. If everything passes, tell me it's safe to deploy.
```

---

## 7. Code Review Prompt

**Use this:** After making changes, to catch mistakes.

```
Please review the recent changes in CRX Manager for safety issues.

Look at the files that were recently modified and check for:

Security:
- [ ] New tables have RLS enabled and policies created
- [ ] No service_role key exposed in frontend code
- [ ] RLS policies use (select auth.uid()) not bare auth.uid()
- [ ] No sensitive data logged to console

Data integrity:
- [ ] All .update() and .delete() calls use checkMutationResult()
- [ ] All RPC calls use assertRpcResult() where appropriate
- [ ] Money stored as bigint cents (not float)
- [ ] Status transitions follow the defined lifecycles

Code quality:
- [ ] TypeScript types updated in src/types/index.ts for any schema changes
- [ ] No @ts-ignore or 'any' types added
- [ ] Activity logging added for important user actions
- [ ] Idempotency keys used for critical writes

Tell me what you found — both issues and things that look good.
```

---

## 8. Deep Analysis — Bug Hunt, Workflow Logic & Missing UI Audit

**Use this:** When you want a thorough audit of the entire app for bugs, broken business logic, and missing UI. This is a multi-phase task — expect it to take a while.

```
I need you to perform a deep, systematic audit of CRX Manager to find bugs, flawed business workflow logic, and missing UI. This is a thorough investigation, not a quick scan.

Before starting, read these files:
1. CLAUDE.md (project root)
2. docs/workflows/SAFE_DEVELOPMENT_RULES.md
3. docs/workflows/QUOTE_TO_DELIVERY.md
4. docs/workflows/INVENTORY_RULES.md
5. docs/reference/database-schema.md
6. docs/reference/rpc-functions.md
7. docs/reference/pages-routes.md

DO NOT fix anything yet. Only investigate and report. Work through each phase below and give me a numbered findings list at the end of each phase before moving to the next.

---

### PHASE 1: Business Workflow Logic Audit
Trace each lifecycle end-to-end through the actual code (not just what CLAUDE.md says). For each workflow, read the relevant pages, RPCs, and triggers and check:

**Quotes (draft -> sent -> revised -> accepted -> declined -> expired)**
- Can a user skip statuses (e.g., go from draft straight to accepted)?
- When a quote is accepted, does convert_quote_to_order() actually release inventory holds?
- When a quote is declined or expired, does quantity_available actually get restored?
- Can a user edit a quote after it's been sent or accepted?
- Does the is_planned flag properly create/release inventory holds in all cases?
- Are tier prices (tier 1/2/3) correctly inherited from customer and overridable?

**Orders (confirmed -> partially_fulfilled -> fulfilled -> cancelled)**
- Can an order be cancelled after partial fulfillment? What happens to delivered items?
- Is AR (accounts receivable) correctly derived from linked invoices, not the deprecated total_paid field?
- Are commission records actually created for every order? Check the commission_split JSONB validation.
- Does cancelling an order restore inventory?

**Deliveries (scheduled -> in_progress -> completed -> cancelled)**
- Is the two-step confirm -> complete flow enforced in the UI? Can a user skip confirm?
- Are delivery item quantities truly locked and uneditable?
- Does Quick Delivery (create_quick_delivery) actually do the FOR UPDATE inventory lock?
- What happens if two users try to complete the same delivery simultaneously?
- Can a delivery be cancelled after completion?

**Invoices (draft -> posted -> void)**
- Does post_invoice() actually call check_period_open()? What error does the user see if the period is closed?
- Can a user edit a posted invoice? (They shouldn't be able to)
- Is balance_cents correctly updated after payments and credits?
- Are all invoice changes logged to financial_audit_log?
- Can a void invoice be un-voided? (It shouldn't)

**Jobs (scheduled -> in_progress -> completed -> cancelled -> invoiced)**
- Does job completion actually deduct inventory and create application_record?
- Does transfer_job_to_invoice() work correctly?
- Can a cancelled job be reactivated?

**Purchase Orders (draft -> submitted -> partially_received -> fully_received -> cancelled)**
- Does receiving update product cost when PO unit_cost differs?
- Can a fully_received PO receive more items?
- Are receiving_records created with proper lot/condition/notes?

**Returns/RMA (requested -> approved -> received -> credited -> rejected)**
- Is inventory restored when a return is received?
- Is a credit actually issued? Does it reduce invoice balance_cents?

**Month-End Close**
- Does check_period_open() actually prevent ALL backdated transactions (invoices, payments, credits)?
- Can a non-admin trigger month-end close?
- Does closing generate statements?

---

### PHASE 2: Data Integrity & Race Conditions
Read the actual RPC functions and triggers in the migrations. Check:

- Are there any RPCs that modify inventory without using FOR UPDATE locks?
- Can two simultaneous Quick Deliveries oversell the same product?
- Are there any places where quantity_available could go negative?
- Do all money fields use bigint cents? Search for any float/decimal money handling.
- Are there any .update() or .delete() calls missing checkMutationResult()?
- Are there any tables missing RLS policies? Cross-reference the actual DB schema.
- Are there foreign key cascades that could accidentally delete important data?
- Check for any N+1 query patterns (looping single queries instead of batch).

---

### PHASE 3: UI Completeness Audit
Read each page component in src/pages/ and check:

- **Missing CRUD operations:** Can the user Create, Read, Update, and Delete for every entity that should support it? Are any buttons missing or non-functional?
- **Missing error states:** What happens when a Supabase query fails? Does the user see a helpful error or a blank screen?
- **Missing loading states:** Are there pages that show no spinner/skeleton while data loads?
- **Missing empty states:** What does the user see when a table has zero rows? Is it helpful or just blank?
- **Missing confirmation dialogs:** Are destructive actions (delete, cancel, void) protected by a confirm dialog?
- **Missing form validation:** Can the user submit forms with invalid data? Are required fields enforced?
- **Missing permission checks:** Can non-admin users see or access pages they shouldn't (month-end close, commissions, settings)?
- **Dead links or broken navigation:** Are there sidebar links that go nowhere or routes with no component?
- **Missing pagination:** Are there list pages that load ALL records without pagination? (This will break with real data volumes)
- **Mobile responsiveness:** Are there pages that are unusable on small screens?

---

### PHASE 4: Security Quick Scan
- Are there any places where user input is inserted into raw SQL (injection risk)?
- Are there any RLS policies using bare auth.uid() instead of (select auth.uid())?
- Is the service_role key referenced anywhere in frontend code?
- Are there any API calls that don't validate the user's role before performing admin actions?
- Are there file uploads without size/type validation?

---

### PHASE 5: Cross-Entity Consistency
- Read src/lib/reconciliation.ts — are the 5 integrity checks comprehensive? What's missing?
- Are there orphaned records possible (e.g., invoice line items pointing to deleted orders)?
- Can the season boundary (Oct 1 - Sep 30) cause YTD calculation bugs near the rollover?
- Are there any places where "quantity" means different things in different contexts?

---

## OUTPUT FORMAT

After completing all 5 phases, give me a single consolidated report:

### Critical (data loss, money errors, security holes)
[numbered list]

### High (broken workflows, wrong calculations, missing enforcement)
[numbered list]

### Medium (missing UI, bad UX, missing validation)
[numbered list]

### Low (cosmetic, minor improvements, edge cases)
[numbered list]

For each finding, include:
- **What:** One-line description of the issue
- **Where:** Exact file path and line number (or RPC/table name)
- **Why it matters:** What could go wrong for a real user
- **Suggested fix:** Brief description (don't write the code yet)

After the report, wait for me to tell you which items to fix. Do NOT start fixing anything until I approve.
```

---

## Tips for Using These Templates

1. **Always start with Template 1** (Session Start) — this ensures Claude has the project context loaded
2. **Copy the template, then add your description** — replace the `[BRACKETS]` with your specific details
3. **Wait for the plan** — Templates 2, 4, and 5 tell Claude to show a plan and wait for approval
4. **One task at a time** — don't paste multiple templates in one message. Finish one task before starting the next.
5. **If Claude seems confused** — paste Template 1 again to reload the context
