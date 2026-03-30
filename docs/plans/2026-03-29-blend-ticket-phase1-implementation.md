# Blend Ticket Phase 1 — OCR Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Align the existing blend ticket schema with the full lifecycle data model, add multi-field/multi-customer support, upgrade the OCR review UX, and make confidence thresholds configurable — so the system is ready for real-world adoption while paper tickets are still in use.

**Architecture:** The existing blend ticket system (8 tables, 10 RPCs, 4 pages, 1 Edge Function) is 80% complete. Phase 1 is a refinement pass: add `blend_ticket_fields` for per-field tracking with customer billing, add FK columns for applicator/vehicle, create an `app_settings` table for configurable thresholds, and improve the OCR review UX with batch approve, duplicate detection, and math validation.

**Tech Stack:** React 18, TypeScript, Vite, Tailwind CSS, Supabase (Postgres + Edge Functions), Vitest

---

## Important Context for the Implementing Engineer

### Existing Status System (DO NOT CHANGE)
The blend ticket uses **two status columns** that work together:
- `status`: OCR processing state — `pending | processing | completed | failed | needs_review`
- `review_status`: approval state — `unreviewed | approved | rejected`

This is well-integrated across 4 pages, 10 RPCs, the Edge Function, and TypeScript types. **Do not collapse into a single status column.** The plan's proposed single-status lifecycle maps to these two columns like this:
- Plan's `draft` → `status='completed', review_status='unreviewed'` (manual/digital entry)
- Plan's `pending_review` → `status='completed', review_status='unreviewed'` (after OCR)
- Plan's `approved` → `review_status='approved'`
- Plan's `applied` → application_record created (already exists)
- Plan's `voided` → `review_status='rejected'`

### Key Files
- `src/pages/BlendTickets.tsx` — List page with filters
- `src/pages/BlendTicketDetail.tsx` — Detail/review page
- `src/pages/BlendRecipes.tsx` — Recipe management
- `src/pages/ApplicationRecords.tsx` — Records from approved tickets
- `src/types/index.ts` — All TypeScript interfaces (lines ~735-850)
- `supabase/functions/process-blend-ticket/index.ts` — OCR Edge Function
- `src/lib/db.ts` — Supabase client + `checkMutationResult()`
- `src/lib/activityLogger.ts` — `logActivity()` for audit trail

### Mandatory Patterns (from CLAUDE.md)
- Every migration: `SECURITY DEFINER SET search_path = public, pg_temp`
- Every new table: RLS policies required
- Every mutating RPC: accept `p_idempotency_key text DEFAULT NULL`
- Every `.update()` / `.delete()`: wrap with `checkMutationResult()`
- Every confirmation dialog: use `ConfirmModal` (never `confirm()`)
- Money: `bigint` cents, never float
- Icons: Lucide React only
- Activity logging: `logActivity({ event, description, performedBy: profile.id, ... })`
- Sentry: `import { Sentry } from '../lib/sentry'`

### Pre-Commit Hook
Runs automatically: ESLint + TypeScript check + build + Vitest. Code that fails any of these cannot be committed. The hook also runs `scripts/validate-sql.sh` and `scripts/validate-frontend.sh`.

---

## Task Overview

| # | Task | Type | Est. |
|---|------|------|------|
| 1 | Create `app_settings` table | Migration | 5 min |
| 2 | Create `blend_ticket_fields` table | Migration | 10 min |
| 3 | Add `applicator_id`, `vehicle_id`, `source` columns to blend_tickets | Migration | 5 min |
| 4 | Update TypeScript types | Types | 5 min |
| 5 | Configurable OCR threshold (backend + UI) | Feature | 15 min |
| 6 | Duplicate ticket detection RPC | Migration + UI | 15 min |
| 7 | Blend math validation | Frontend | 10 min |
| 8 | Batch approve from list page | Frontend + RPC | 15 min |
| 9 | Per-field confidence display on detail page | Frontend | 10 min |
| 10 | Raw OCR text viewer on detail page | Frontend | 5 min |
| 11 | Re-process OCR button | Frontend | 5 min |
| 12 | Multi-field entry on detail page (blend_ticket_fields UI) | Frontend + RPC | 20 min |
| 13 | Auto-suggest order match after OCR | Frontend | 10 min |
| 14 | Tests | Tests | 20 min |
| 15 | Documentation updates | Docs | 5 min |

---

## Task 1: Create `app_settings` Table

**Purpose:** Store configurable settings like OCR confidence threshold. Key-value store with typed values.

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_app_settings_table.sql`

**Step 1: Write migration**

```sql
-- App settings table for system-wide configuration
CREATE TABLE IF NOT EXISTS app_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key text UNIQUE NOT NULL,
  setting_value jsonb NOT NULL DEFAULT '{}',
  description text,
  updated_by uuid REFERENCES profiles(id),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- Enable RLS
ALTER TABLE app_settings ENABLE ROW LEVEL SECURITY;

-- Read: all authenticated users
CREATE POLICY "app_settings_select" ON app_settings
  FOR SELECT TO authenticated USING (true);

-- Write: admin only
CREATE POLICY "app_settings_update" ON app_settings
  FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

CREATE POLICY "app_settings_insert" ON app_settings
  FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- Seed default OCR threshold
INSERT INTO app_settings (setting_key, setting_value, description)
VALUES (
  'ocr_confidence_threshold',
  '{"auto_approve": 85, "needs_review": 50}'::jsonb,
  'OCR confidence thresholds. auto_approve: tickets above this skip review. needs_review: below this get flagged.'
);

-- Updated_at trigger
CREATE TRIGGER set_app_settings_updated_at
  BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

**Step 2: Verify migration applies**

Run: `npx supabase db push` (or via Supabase dashboard)

**Step 3: Commit**

```bash
git add supabase/migrations/*_app_settings_table.sql
git commit -m "feat: add app_settings table for configurable OCR thresholds"
```

---

## Task 2: Create `blend_ticket_fields` Table

**Purpose:** Per-field tracking for blend tickets. Supports multi-field loads with per-field customer assignment (for split-customer billing per decision Q6-B) and planned vs actual acres tracking (for Phase 3 applicator flow).

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_blend_ticket_fields_table.sql`

**Step 1: Write migration**

```sql
-- Per-field application tracking for blend tickets
-- Supports: multi-field loads, multi-customer billing, planned vs actual acres
CREATE TABLE IF NOT EXISTS blend_ticket_fields (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  blend_ticket_id uuid NOT NULL REFERENCES blend_tickets(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES fields(id),
  customer_id uuid REFERENCES customers(id),
  planned_acres numeric(10,2),
  actual_acres numeric(10,2),
  applied_at timestamptz,
  applied_by uuid REFERENCES profiles(id),
  notes text,
  sort_order integer DEFAULT 0,
  created_at timestamptz DEFAULT now(),

  UNIQUE(blend_ticket_id, field_id)
);

-- Indexes
CREATE INDEX idx_btf_ticket ON blend_ticket_fields(blend_ticket_id);
CREATE INDEX idx_btf_field ON blend_ticket_fields(field_id);
CREATE INDEX idx_btf_customer ON blend_ticket_fields(customer_id);

-- Enable RLS
ALTER TABLE blend_ticket_fields ENABLE ROW LEVEL SECURITY;

CREATE POLICY "blend_ticket_fields_select" ON blend_ticket_fields
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "blend_ticket_fields_insert" ON blend_ticket_fields
  FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "blend_ticket_fields_update" ON blend_ticket_fields
  FOR UPDATE TO authenticated USING (true);

CREATE POLICY "blend_ticket_fields_delete" ON blend_ticket_fields
  FOR DELETE TO authenticated USING (true);
```

**Step 2: Commit**

```bash
git add supabase/migrations/*_blend_ticket_fields_table.sql
git commit -m "feat: add blend_ticket_fields table for multi-field/multi-customer tracking"
```

---

## Task 3: Add Columns to `blend_tickets`

**Purpose:** Add `applicator_id` (FK), `vehicle_id` (FK), and `source` to blend_tickets. These link text fields to real entities and track how tickets are created.

**Files:**
- Create: `supabase/migrations/YYYYMMDDHHMMSS_blend_tickets_phase1_columns.sql`

**Step 1: Check existing constraints**

Run against Supabase:
```sql
SELECT conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'blend_tickets'::regclass AND contype = 'c';
```

**Step 2: Write migration**

```sql
-- Add FK columns for applicator and vehicle (alongside existing text fields)
-- Text fields (applicator_name, vehicle_info) kept for OCR backwards compat
ALTER TABLE blend_tickets
  ADD COLUMN IF NOT EXISTS applicator_id uuid REFERENCES profiles(id),
  ADD COLUMN IF NOT EXISTS vehicle_id uuid REFERENCES vehicles(id),
  ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'ocr'
    CHECK (source IN ('ocr', 'manual', 'digital'));

-- Indexes for FK lookups
CREATE INDEX IF NOT EXISTS idx_bt_applicator ON blend_tickets(applicator_id);
CREATE INDEX IF NOT EXISTS idx_bt_vehicle ON blend_tickets(vehicle_id);
CREATE INDEX IF NOT EXISTS idx_bt_source ON blend_tickets(source);

-- Backfill existing tickets as 'ocr' source (already the default, but explicit)
-- No-op since DEFAULT handles it, but documents intent
COMMENT ON COLUMN blend_tickets.source IS 'How the ticket was created: ocr (photo upload), manual (office entry), digital (mixer/Phase 2)';
COMMENT ON COLUMN blend_tickets.applicator_id IS 'FK to profiles. Nullable — text applicator_name kept for OCR compat.';
COMMENT ON COLUMN blend_tickets.vehicle_id IS 'FK to vehicles. Nullable — text vehicle_info kept for OCR compat.';
```

**Step 3: Commit**

```bash
git add supabase/migrations/*_blend_tickets_phase1_columns.sql
git commit -m "feat: add applicator_id, vehicle_id, source columns to blend_tickets"
```

---

## Task 4: Update TypeScript Types

**Files:**
- Modify: `src/types/index.ts`

**Step 1: Add new types and update interfaces**

Add to the blend ticket type section:

```typescript
// New types
export type BlendTicketSource = 'ocr' | 'manual' | 'digital';

// New interface
export interface BlendTicketField {
  id: string;
  blend_ticket_id: string;
  field_id: string;
  customer_id: string | null;
  planned_acres: number | null;
  actual_acres: number | null;
  applied_at: string | null;
  applied_by: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  // Joined
  field?: { field_name: string; customer_id: string; total_acres: number | null };
  customer?: { id: string; name: string };
}

export interface AppSetting {
  id: string;
  setting_key: string;
  setting_value: Record<string, unknown>;
  description: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}
```

Add to `BlendTicket` interface:

```typescript
  applicator_id: string | null;
  vehicle_id: string | null;
  source: BlendTicketSource;
  // Joined
  applicator?: { id: string; full_name: string };
  vehicle?: { id: string; vehicle_name: string };
  blend_ticket_fields?: BlendTicketField[];
```

**Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: 0 errors

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat: add BlendTicketField, AppSetting types and new blend_tickets columns"
```

---

## Task 5: Configurable OCR Threshold (Backend + Settings UI)

**Purpose:** Replace hardcoded 70/50 thresholds with values from `app_settings`. Admin can tune via Settings page.

**Files:**
- Modify: `src/pages/BlendTickets.tsx` — read threshold from settings
- Modify: `src/pages/BlendTicketDetail.tsx` — read threshold from settings
- Modify: Settings page (find existing settings page) — add OCR threshold section

**Step 1: Create a hook to read app settings**

Create: `src/hooks/useAppSettings.ts`

```typescript
import { useState, useEffect } from 'react';
import { supabase } from '../lib/db';

interface OCRThresholds {
  auto_approve: number;
  needs_review: number;
}

const DEFAULT_THRESHOLDS: OCRThresholds = { auto_approve: 85, needs_review: 50 };

export function useOCRThresholds(): OCRThresholds {
  const [thresholds, setThresholds] = useState<OCRThresholds>(DEFAULT_THRESHOLDS);

  useEffect(() => {
    supabase
      .from('app_settings')
      .select('setting_value')
      .eq('setting_key', 'ocr_confidence_threshold')
      .single()
      .then(({ data }) => {
        if (data?.setting_value) {
          setThresholds(data.setting_value as OCRThresholds);
        }
      });
  }, []);

  return thresholds;
}
```

**Step 2: Replace hardcoded thresholds in BlendTickets.tsx**

Find the confidence badge logic (around line 306) and replace hardcoded 70/50 with `thresholds.auto_approve` / `thresholds.needs_review` from the hook.

**Step 3: Same replacement in BlendTicketDetail.tsx** (around line 597)

**Step 4: Add threshold config to Settings page**

Add an "OCR Settings" card to the existing admin Settings page with:
- "Auto-approve threshold" — number input (0-100)
- "Needs review threshold" — number input (0-100)
- Save button that updates `app_settings` via `.update()`

**Step 5: Tests**

Write: `src/hooks/__tests__/useAppSettings.test.ts`
- Test default values returned when no setting exists
- Test values returned from mock Supabase response

**Step 6: Commit**

```bash
git add src/hooks/useAppSettings.ts src/hooks/__tests__/useAppSettings.test.ts
git add src/pages/BlendTickets.tsx src/pages/BlendTicketDetail.tsx
git commit -m "feat: configurable OCR confidence thresholds via app_settings"
```

---

## Task 6: Duplicate Ticket Detection

**Purpose:** Before creating a ticket, check if one already exists with the same `ticket_number` + `ticket_date`. Prevents duplicate uploads.

**Files:**
- Create: RPC in migration
- Modify: `supabase/functions/process-blend-ticket/index.ts` — call duplicate check
- Modify: `src/pages/BlendTicketDetail.tsx` — show duplicate warning

**Step 1: Write RPC migration**

```sql
CREATE OR REPLACE FUNCTION check_duplicate_blend_ticket(
  p_ticket_number text,
  p_ticket_date date
)
RETURNS TABLE(id uuid, ticket_number text, ticket_date date, status text, review_status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  RETURN QUERY
    SELECT bt.id, bt.ticket_number, bt.ticket_date, bt.status, bt.review_status
    FROM blend_tickets bt
    WHERE bt.ticket_number = p_ticket_number
      AND bt.ticket_date = p_ticket_date
      AND bt.deleted_at IS NULL;
END;
$$;

GRANT EXECUTE ON FUNCTION check_duplicate_blend_ticket(text, date) TO authenticated;
```

**Step 2: Call in Edge Function**

After OCR extraction, before inserting the ticket, call the RPC. If a duplicate exists, return it in the response so the frontend can warn.

**Step 3: Show warning on detail page**

If the API response includes `duplicate_of`, show a yellow banner: "A ticket with this number and date already exists (BT-XXXXXXXX). This may be a duplicate."

**Step 4: Commit**

```bash
git add supabase/migrations/*_duplicate_detection.sql supabase/functions/process-blend-ticket/index.ts
git add src/pages/BlendTicketDetail.tsx
git commit -m "feat: duplicate blend ticket detection on upload"
```

---

## Task 7: Blend Math Validation

**Purpose:** On the detail/review page, validate that product totals make mathematical sense. Flag when total volume doesn't match sum of individual product totals.

**Files:**
- Modify: `src/pages/BlendTicketDetail.tsx`

**Step 1: Add validation logic**

After products are loaded, compute: `sum(product.quantity)` and compare to `total_volume`. If they differ by more than 5%, show a yellow warning banner below the product table:

"Math check: Product totals sum to X gal but ticket total volume is Y gal (Z% difference)"

This is a **warning only**, not a blocker — OCR can misread quantities.

**Step 2: Test**

Write unit test for the math comparison utility function.

**Step 3: Commit**

```bash
git add src/pages/BlendTicketDetail.tsx
git commit -m "feat: blend math validation warning on ticket detail page"
```

---

## Task 8: Batch Approve from List Page

**Purpose:** Select multiple high-confidence tickets and approve them in one action instead of opening each individually.

**Files:**
- Create: RPC in migration — `batch_approve_blend_tickets(p_ticket_ids uuid[], p_approved_by uuid, p_idempotency_key text DEFAULT NULL)`
- Modify: `src/pages/BlendTickets.tsx` — add checkbox column + "Batch Approve" button

**Step 1: Write RPC migration**

```sql
CREATE OR REPLACE FUNCTION batch_approve_blend_tickets(
  p_ticket_ids uuid[],
  p_approved_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_count integer := 0;
  v_existing text;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  -- Only approve tickets that are completed + unreviewed
  UPDATE blend_tickets
  SET review_status = 'approved',
      reviewed_by = p_approved_by,
      reviewed_at = now()
  WHERE id = ANY(p_ticket_ids)
    AND status = 'completed'
    AND review_status = 'unreviewed'
    AND deleted_at IS NULL;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Idempotency record
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'batch_approve_blend_tickets', jsonb_build_object('approved_count', v_count)::text);
  END IF;

  RETURN jsonb_build_object('approved_count', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION batch_approve_blend_tickets(uuid[], uuid, text) TO authenticated;
```

**Step 2: Add checkbox + button to BlendTickets.tsx**

- Add checkbox column to the table (leftmost)
- "Select all visible" checkbox in header
- "Batch Approve (N)" button appears when 1+ tickets selected
- Button calls RPC, shows toast with count, refreshes list
- Only selectable when `status='completed'` and `review_status='unreviewed'`

**Step 3: Tests**

- Unit test for the RPC (via Supabase test helpers or integration test)
- Frontend test for checkbox selection behavior

**Step 4: Commit**

```bash
git add supabase/migrations/*_batch_approve.sql src/pages/BlendTickets.tsx
git commit -m "feat: batch approve blend tickets from list page"
```

---

## Task 9: Per-Field Confidence Display

**Purpose:** Show green/yellow/red confidence indicators next to each extracted field on the detail page, not just the overall score.

**Files:**
- Modify: `src/pages/BlendTicketDetail.tsx`

**Step 1: Implement confidence badges**

The Edge Function already returns per-product `confidence_score` (0-100). For each product row, render a small colored dot:
- Green (>=auto_approve threshold)
- Yellow (>=needs_review and <auto_approve)
- Red (<needs_review)

Use the configurable thresholds from `useOCRThresholds()` (Task 5).

For header fields (customer, date, applicator), the overall `ocr_confidence_score` already exists — add a small badge next to the "Overall Confidence" display showing the breakdown.

**Step 2: Commit**

```bash
git add src/pages/BlendTicketDetail.tsx
git commit -m "feat: per-field confidence badges on blend ticket detail"
```

---

## Task 10: Raw OCR Text Viewer

**Purpose:** Expandable section on detail page showing what Google Vision actually read, so the reviewer can compare extracted values against raw text.

**Files:**
- Modify: `src/pages/BlendTicketDetail.tsx`

**Step 1: Add collapsible section**

Below the ticket header, add a `<details>` / disclosure panel labeled "Raw OCR Text". When expanded, shows `raw_ocr_text` in a monospace `<pre>` block with word-wrap. Only visible when `raw_ocr_text` is not null (i.e., OCR tickets only).

**Step 2: Commit**

```bash
git add src/pages/BlendTicketDetail.tsx
git commit -m "feat: raw OCR text viewer on blend ticket detail"
```

---

## Task 11: Re-Process OCR Button

**Purpose:** If OCR results are bad, allow re-processing the ticket image through the OCR pipeline again.

**Files:**
- Modify: `src/pages/BlendTicketDetail.tsx`

**Step 1: Add "Re-process OCR" button**

Visible only on OCR-sourced tickets (`source='ocr'`). Button calls the `process-blend-ticket` Edge Function with the existing image URL(s) from `blend_ticket_images`. Shows loading spinner during processing, then reloads the ticket data.

Use `ConfirmModal` before re-processing: "This will re-run OCR and may overwrite current values. Continue?"

**Step 2: Commit**

```bash
git add src/pages/BlendTicketDetail.tsx
git commit -m "feat: re-process OCR button on blend ticket detail"
```

---

## Task 12: Multi-Field Entry UI (blend_ticket_fields)

**Purpose:** Allow adding/removing field assignments on a blend ticket. Each field row has: field selector (filtered by ticket's customer), customer override (for multi-customer loads), and planned acres.

**Files:**
- Modify: `src/pages/BlendTicketDetail.tsx` — add fields section
- Create: RPC `save_blend_ticket_fields(p_blend_ticket_id, p_fields jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)`

**Step 1: Write RPC migration**

```sql
CREATE OR REPLACE FUNCTION save_blend_ticket_fields(
  p_blend_ticket_id uuid,
  p_fields jsonb,
  p_performed_by uuid,
  p_idempotency_key text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_field jsonb;
  v_count integer := 0;
  v_existing text;
BEGIN
  -- Idempotency check
  IF p_idempotency_key IS NOT NULL THEN
    SELECT result INTO v_existing
      FROM idempotency_keys
      WHERE idempotency_key = p_idempotency_key;
    IF v_existing IS NOT NULL THEN RETURN v_existing::jsonb; END IF;
  END IF;

  -- Delete existing field assignments
  DELETE FROM blend_ticket_fields WHERE blend_ticket_id = p_blend_ticket_id;

  -- Insert new assignments
  FOR v_field IN SELECT * FROM jsonb_array_elements(p_fields)
  LOOP
    INSERT INTO blend_ticket_fields (blend_ticket_id, field_id, customer_id, planned_acres, sort_order)
    VALUES (
      p_blend_ticket_id,
      (v_field->>'field_id')::uuid,
      (v_field->>'customer_id')::uuid,
      (v_field->>'planned_acres')::numeric,
      v_count
    );
    v_count := v_count + 1;
  END LOOP;

  -- Idempotency record
  IF p_idempotency_key IS NOT NULL THEN
    INSERT INTO idempotency_keys (idempotency_key, operation, result)
    VALUES (p_idempotency_key, 'save_blend_ticket_fields', jsonb_build_object('fields_saved', v_count)::text);
  END IF;

  RETURN jsonb_build_object('fields_saved', v_count);
END;
$$;

GRANT EXECUTE ON FUNCTION save_blend_ticket_fields(uuid, jsonb, uuid, text) TO authenticated;
```

**Step 2: Build UI section**

On BlendTicketDetail.tsx, add a "Fields" section below products:
- "Add Field" button → opens a row with:
  - Field dropdown (filtered by `customer_id` on the ticket, or all fields if multi-customer)
  - Customer dropdown (pre-filled from field's customer, editable for split loads)
  - Planned acres input
  - Remove button (X)
- Shows total planned acres vs ticket `total_acres` — warn if mismatch
- Save calls `save_blend_ticket_fields` RPC
- Load existing fields on page mount via `.from('blend_ticket_fields').select('*, field:fields(*), customer:customers(id, name)')`

**Step 3: Commit**

```bash
git add supabase/migrations/*_save_blend_ticket_fields.sql src/pages/BlendTicketDetail.tsx
git commit -m "feat: multi-field entry UI with per-customer assignment"
```

---

## Task 13: Auto-Suggest Order Match

**Purpose:** After OCR, search for the ticket's customer's open orders that have matching products and suggest linking.

**Files:**
- Modify: `src/pages/BlendTicketDetail.tsx`

**Step 1: Add suggestion logic**

When the detail page loads an unlinked ticket (`order_link_status='unlinked'`):
1. Query `orders` where `customer_id` matches and `status='confirmed'`
2. For each order, check if any `order_items.product_id` matches the ticket's product IDs
3. If matches found, show a blue info banner: "This ticket may match Order #XXXX (N matching products). [Link to Order →]"
4. Clicking the link navigates to the existing order-linking flow

This is a **suggestion only** — the existing `link_blend_ticket_to_order` RPC handles the actual linking.

**Step 2: Commit**

```bash
git add src/pages/BlendTicketDetail.tsx
git commit -m "feat: auto-suggest order match for unlinked blend tickets"
```

---

## Task 14: Tests

**Files:**
- Create: `src/hooks/__tests__/useAppSettings.test.ts`
- Create: `src/pages/__tests__/BlendTicketMathValidation.test.ts`
- Modify: existing blend ticket test files to cover new columns

**Step 1: Write tests for each new feature**

- `useOCRThresholds` hook — default values, Supabase response parsing
- Math validation utility — sum vs total comparison, percentage calculation, edge cases (null values, zero total)
- Batch approve — checkbox selection state, button visibility logic
- Duplicate detection — warning banner visibility

**Step 2: Run full test suite**

Run: `npm run test`
Expected: All tests pass (existing + new)

**Step 3: Commit**

```bash
git add src/hooks/__tests__/ src/pages/__tests__/
git commit -m "test: add tests for Phase 1 blend ticket features"
```

---

## Task 15: Documentation Updates

**Files:**
- Modify: `CLAUDE.md` — update migration count, table count, RPC count
- Modify: `docs/reference/migration-history.md` — add new migration entries
- Modify: `docs/reference/database-schema.md` — add `app_settings`, `blend_ticket_fields` tables
- Modify: `docs/reference/rpc-functions.md` — add new RPCs
- Modify: `docs/CHANGELOG.md` — add Phase 1 entry
- Modify: `docs/plans/2026-03-23-blend-ticket-system-full-plan.md` — update "Where We Left Off" and mark open questions as answered

**Step 1: Update all docs**

Follow the Documentation Maintenance Rules from CLAUDE.md. Verify counts match:
```bash
grep -c "lazy(" src/App.tsx                    # page count
ls supabase/migrations/*.sql | wc -l          # migration count
```

**Step 2: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: update references for Phase 1 blend ticket changes"
```

---

## Execution Dependencies

```
Task 1 (app_settings) ──────────────────────┐
Task 2 (blend_ticket_fields) ───────────────┤
Task 3 (blend_tickets columns) ─────────────┤
                                            ├──→ Task 4 (types) ──→ All frontend tasks
                                            │
Tasks 5-13 depend on Task 4                 │
Task 14 (tests) depends on Tasks 5-13       │
Task 15 (docs) is last                      │
                                            │
Parallelizable: Tasks 1, 2, 3 (all migrations, no deps on each other)
Parallelizable: Tasks 6, 7, 9, 10, 11, 13 (independent UI features)
Sequential: Task 5 before Task 9 (thresholds needed for confidence colors)
Sequential: Task 12 depends on Task 2 (needs blend_ticket_fields table)
```

---

## Post-Implementation Verification

After all tasks complete:

1. `npm run lint` — 0 errors
2. `npm run build` — clean build
3. `npm run test` — all tests pass
4. Manual smoke test:
   - Upload a blend ticket photo → verify OCR extracts data
   - Review confidence badges (green/yellow/red per product)
   - Expand raw OCR text viewer
   - Add field assignments with customer
   - Batch approve 2+ tickets from list
   - Change OCR threshold in Settings → verify badge colors update
   - Check duplicate warning by uploading same ticket number
5. Doc counts match reality
