# Team Board V2 — Operational Hub Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform the Team Board from a standalone collaboration island into a role-aware operational hub with entity linking, delivery visibility, photo attachments, and mobile optimization.

**Architecture:** Component Library approach — decompose the 1394-line TeamBoard.tsx monolith into reusable components in `src/components/team/`. A single migration adds entity linking columns, attachments table, storage bucket, and 3 RPCs. New components slot into the existing Board tab layout as sections.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Supabase (PostgreSQL + Storage + Realtime), Lucide React icons

---

## Task 1: Migration — Entity Linking, Attachments Table, Storage Bucket, RPCs

**Files:**
- Create: `supabase/migrations/20260315200000_team_board_v2.sql`
- Modify: `src/types/index.ts` (add new fields to TeamNote interface + new interfaces)

**Step 1: Write the migration**

Create `supabase/migrations/20260315200000_team_board_v2.sql`:

```sql
-- ============================================================
-- Team Board V2: Entity Linking, Attachments, Delivery RPCs
-- ============================================================

-- 1. Add entity linking columns to team_notes
ALTER TABLE team_notes
  ADD COLUMN IF NOT EXISTS linked_entity_type text,
  ADD COLUMN IF NOT EXISTS linked_entity_id uuid;

CREATE INDEX IF NOT EXISTS idx_team_notes_entity
  ON team_notes (linked_entity_type, linked_entity_id)
  WHERE linked_entity_type IS NOT NULL;

-- 2. Create team_note_attachments table
CREATE TABLE IF NOT EXISTS team_note_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES team_notes(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size_bytes bigint NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_team_note_attachments_note
  ON team_note_attachments(note_id);

-- RLS for team_note_attachments
ALTER TABLE team_note_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can view all attachments"
  ON team_note_attachments FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert own attachments"
  ON team_note_attachments FOR INSERT
  TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

CREATE POLICY "Users can delete own attachments or admin can delete any"
  ON team_note_attachments FOR DELETE
  TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
  );

-- 3. Storage bucket for team note attachments
INSERT INTO storage.buckets (id, name, public)
VALUES ('team-note-attachments', 'team-note-attachments', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies
CREATE POLICY "Authenticated users can upload team note attachments"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'team-note-attachments');

CREATE POLICY "Anyone can view team note attachments"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (bucket_id = 'team-note-attachments');

CREATE POLICY "Users can delete own team note attachments"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (
    bucket_id = 'team-note-attachments'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin')
    )
  );

-- 4. RPC: get_team_board_deliveries()
-- Returns today's + tomorrow's deliveries, role-aware
CREATE OR REPLACE FUNCTION get_team_board_deliveries()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_today date := CURRENT_DATE;
  v_tomorrow date := CURRENT_DATE + 1;
  v_result jsonb;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id;

  SELECT jsonb_build_object(
    'today', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          del.delivery_address,
          del.delivery_notes,
          c.name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver,
          (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id) AS item_count
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_today
          AND del.status IN ('scheduled', 'in_progress')
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'tomorrow', COALESCE((
      SELECT jsonb_agg(row_to_json(d.*)::jsonb ORDER BY d.scheduled_time NULLS LAST, d.priority_sort)
      FROM (
        SELECT
          del.id,
          del.delivery_number,
          del.status,
          del.priority,
          CASE del.priority
            WHEN 'urgent' THEN 0
            WHEN 'high' THEN 1
            WHEN 'medium' THEN 2
            WHEN 'low' THEN 3
            ELSE 4
          END AS priority_sort,
          del.scheduled_date,
          del.scheduled_time,
          del.delivery_address,
          c.name AS customer_name,
          p.full_name AS driver_name,
          del.assigned_driver
        FROM deliveries del
        JOIN customers c ON c.id = del.customer_id
        LEFT JOIN profiles p ON p.id = del.assigned_driver
        WHERE del.scheduled_date = v_tomorrow
          AND del.status = 'scheduled'
          AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
      ) d
    ), '[]'::jsonb),
    'unassigned_count', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status = 'scheduled'
        AND assigned_driver IS NULL
    ),
    'today_total', (
      SELECT count(*)
      FROM deliveries
      WHERE scheduled_date = v_today
        AND status IN ('scheduled', 'in_progress')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 5. RPC: get_yesterday_delivery_recap()
CREATE OR REPLACE FUNCTION get_yesterday_delivery_recap()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_role text;
  v_yesterday date := CURRENT_DATE - 1;
  v_result jsonb;
BEGIN
  SELECT role INTO v_role FROM profiles WHERE id = v_user_id;

  SELECT jsonb_build_object(
    'completed', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.name,
        'driver_name', p.full_name,
        'completed_at', del.updated_at,
        'item_count', (SELECT count(*) FROM delivery_items di WHERE di.delivery_id = del.id),
        'has_issues', (del.issue_type IS NOT NULL)
      ) ORDER BY del.updated_at)
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'issues', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', del.id,
        'delivery_number', del.delivery_number,
        'customer_name', c.name,
        'driver_name', p.full_name,
        'issue_type', del.issue_type,
        'issue_description', del.issue_description
      ))
      FROM deliveries del
      JOIN customers c ON c.id = del.customer_id
      LEFT JOIN profiles p ON p.id = del.assigned_driver
      WHERE del.scheduled_date = v_yesterday
        AND del.issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR del.assigned_driver = v_user_id)
    ), '[]'::jsonb),
    'summary', jsonb_build_object(
      'total_completed', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status = 'completed'
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_with_issues', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND issue_type IS NOT NULL
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      ),
      'total_cancelled', (
        SELECT count(*) FROM deliveries
        WHERE scheduled_date = v_yesterday AND status IN ('cancelled', 'voided')
        AND (v_role IN ('admin', 'sales_rep') OR assigned_driver = v_user_id)
      )
    )
  ) INTO v_result;

  RETURN v_result;
END;
$$;

-- 6. RPC: get_notes_for_entity(p_entity_type, p_entity_id)
CREATE OR REPLACE FUNCTION get_notes_for_entity(
  p_entity_type text,
  p_entity_id uuid
)
RETURNS SETOF team_notes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN QUERY
    SELECT tn.*
    FROM team_notes tn
    WHERE tn.linked_entity_type = p_entity_type
      AND tn.linked_entity_id = p_entity_id
      AND tn.deleted_at IS NULL
    ORDER BY tn.is_pinned DESC, tn.created_at DESC;
END;
$$;
```

**Step 2: Update TypeScript types**

In `src/types/index.ts`, update the `TeamNote` interface and add new interfaces:

Add to `TeamNote`:
```typescript
  linked_entity_type: string | null;
  linked_entity_id: string | null;
```

Add new interfaces:
```typescript
export type LinkedEntityType = 'delivery' | 'order' | 'customer' | 'job' | 'purchase_order' | 'quote';

export interface TeamNoteAttachment {
  id: string;
  note_id: string;
  file_url: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  uploaded_by: string;
  created_at: string;
}

export interface TeamBoardDelivery {
  id: string;
  delivery_number: string;
  status: string;
  priority: string;
  scheduled_date: string;
  scheduled_time: string | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  customer_name: string;
  driver_name: string | null;
  assigned_driver: string | null;
  item_count: number;
}

export interface TeamBoardDeliveryData {
  today: TeamBoardDelivery[];
  tomorrow: TeamBoardDelivery[];
  unassigned_count: number;
  today_total: number;
}

export interface YesterdayRecapData {
  completed: Array<{
    id: string;
    delivery_number: string;
    customer_name: string;
    driver_name: string | null;
    completed_at: string;
    item_count: number;
    has_issues: boolean;
  }>;
  issues: Array<{
    id: string;
    delivery_number: string;
    customer_name: string;
    driver_name: string | null;
    issue_type: string;
    issue_description: string | null;
  }>;
  summary: {
    total_completed: number;
    total_with_issues: number;
    total_cancelled: number;
  };
}
```

**Step 3: Apply migration to Supabase**

Run: `cd C:/Users/mason/CRX_Manager_V1.0 && npx supabase db push`

**Step 4: Verify build**

Run: `cd C:/Users/mason/CRX_Manager_V1.0 && npm run build`
Expected: 0 errors

**Step 5: Commit**

```bash
git add supabase/migrations/20260315200000_team_board_v2.sql src/types/index.ts
git commit -m "feat: add Team Board V2 migration — entity linking, attachments, delivery RPCs"
```

---

## Task 2: Extract NoteCard Component

Extract the `renderCard` inline function (lines 530-657 of TeamBoard.tsx) into a standalone component.

**Files:**
- Create: `src/components/team/NoteCard.tsx`
- Modify: `src/pages/TeamBoard.tsx` (replace `renderCard` with `<NoteCard />`)

**Step 1: Create NoteCard.tsx**

Extract the card rendering logic into `src/components/team/NoteCard.tsx`. The component should accept:
```typescript
interface NoteCardProps {
  note: ExtendedTeamNote;
  showCheckbox: boolean;
  showCompletionDetails?: boolean;
  canEdit: boolean;
  onToggleComplete: (note: TeamNote) => void;
  onTogglePin: (note: TeamNote) => void;
  onEdit: (note: TeamNote) => void;
  onDelete: (noteId: string) => void;
  onClick: (note: ExtendedTeamNote) => void;
}
```

Move the full card JSX from `renderCard` (TeamBoard.tsx lines 530-657) into this component. Include the helper functions it uses: `isOverdue`, `getDaysUntilDue`, `getName`, `formatDate`, `formatDateTime`, `getTimeToComplete`, `priorityVariant`.

Also move the `ExtendedTeamNote` interface into `src/types/index.ts` so it can be shared.

**Step 2: Update TeamBoard.tsx**

Replace all `renderCard(n, ...)` calls with `<NoteCard note={n} ... />`. Remove the inline `renderCard` function. Import `NoteCard` from the new file.

**Step 3: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 4: Verify tests**

Run: `npm run test`
Expected: All passing

**Step 5: Commit**

```bash
git add src/components/team/NoteCard.tsx src/pages/TeamBoard.tsx src/types/index.ts
git commit -m "refactor: extract NoteCard component from TeamBoard monolith"
```

---

## Task 3: EntityBadge Component

**Files:**
- Create: `src/components/team/EntityBadge.tsx`

**Step 1: Create EntityBadge.tsx**

A small clickable badge that shows entity type + number and links to the detail page:

```typescript
import { Link } from 'react-router-dom';
import { Truck, ShoppingCart, Users, Briefcase, Package, FileText } from 'lucide-react';
import type { LinkedEntityType } from '../../types';

interface EntityBadgeProps {
  entityType: LinkedEntityType;
  entityId: string;
  label?: string; // e.g. "DEL-2026-0142"
}
```

Route mapping:
- `delivery` → `/deliveries/{id}`
- `order` → `/orders/{id}`
- `customer` → `/customers/{id}`
- `job` → `/jobs/{id}`
- `purchase_order` → `/purchase-orders/{id}`
- `quote` → `/quotes/{id}`

Icon + color per type. Renders as a compact pill/badge that's clickable.

**Step 2: Integrate into NoteCard**

In `NoteCard.tsx`, if `note.linked_entity_type && note.linked_entity_id`, render `<EntityBadge>` next to the priority badge in the card header.

**Step 3: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/components/team/EntityBadge.tsx src/components/team/NoteCard.tsx
git commit -m "feat: add EntityBadge component for linked entity display on note cards"
```

---

## Task 4: TodaysDeliveries Component

**Files:**
- Create: `src/components/team/TodaysDeliveries.tsx`

**Step 1: Create TodaysDeliveries.tsx**

Component that:
1. Calls `get_team_board_deliveries()` RPC on mount
2. Shows an unassigned alert bar at top (red/amber) if `unassigned_count > 0`
3. Renders today's deliveries as compact cards in a responsive grid
4. Each card shows: delivery_number, customer_name, driver_name (or "Unassigned" in red), status badge, scheduled_time, item count
5. Cards are clickable → navigate to `/deliveries/{id}`
6. Collapsible "Tomorrow" preview section (shows count + compact list)
7. Empty state: "No deliveries scheduled today" with a Truck icon

Role-aware display is handled by the RPC (drivers only get their own).

**Mobile optimization:**
- Cards are full-width stacked on mobile (`grid-cols-1`), 2-col on tablet (`sm:grid-cols-2`), 3-col on desktop (`lg:grid-cols-3`)
- Touch targets minimum 44px height
- Priority border-left color coding (urgent=red, high=amber, etc.)

**Step 2: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 3: Commit**

```bash
git add src/components/team/TodaysDeliveries.tsx
git commit -m "feat: add TodaysDeliveries component for Team Board delivery bulletin"
```

---

## Task 5: YesterdayRecap Component

**Files:**
- Create: `src/components/team/YesterdayRecap.tsx`

**Step 1: Create YesterdayRecap.tsx**

Component that:
1. Calls `get_yesterday_delivery_recap()` RPC on mount
2. Shows summary row: "Yesterday: 8 completed, 1 issue, 0 cancelled"
3. If issues > 0, shows issue cards with red accent (delivery_number, customer, issue_type, description)
4. Collapsible — default collapsed if 0 issues, expanded if issues exist
5. Each delivery row is clickable → navigate to `/deliveries/{id}`
6. Empty state: "No deliveries yesterday" — component hides entirely

**Step 2: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 3: Commit**

```bash
git add src/components/team/YesterdayRecap.tsx
git commit -m "feat: add YesterdayRecap component for Team Board delivery summary"
```

---

## Task 6: NotePhotoUpload + NoteAttachments Components

**Files:**
- Create: `src/components/team/NotePhotoUpload.tsx`
- Create: `src/components/team/NoteAttachments.tsx`

**Step 1: Create NotePhotoUpload.tsx**

Photo upload component following the existing `delivery-photos` pattern in DeliveryDetail.tsx (lines 469-506):
- File input with `accept="image/*" capture="environment"` (camera on mobile)
- Multi-file support
- Upload to `team-note-attachments/{user_id}/{timestamp}_{index}.{ext}` in Supabase storage
- Insert record into `team_note_attachments` table
- Show upload progress/loading state
- Max file size: 10MB per image
- Props: `noteId: string`, `onUploadComplete: () => void`

**Step 2: Create NoteAttachments.tsx**

Display component for existing attachments:
- Grid of thumbnail images (clickable to view full-size)
- Shows file_name and upload date
- Delete button (own uploads or admin)
- Props: `noteId: string`, `canDelete: boolean`
- Fetches from `team_note_attachments` table filtered by `note_id`

**Step 3: Integrate into TeamBoard detail modal**

In TeamBoard.tsx, inside the note detail modal (after TagsManager, before comments tabs), add:
- `<NoteAttachments noteId={selectedNote.id} canDelete={canEdit(selectedNote)} />`
- `<NotePhotoUpload noteId={selectedNote.id} onUploadComplete={...} />` (only if not completed)

**Step 4: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 5: Commit**

```bash
git add src/components/team/NotePhotoUpload.tsx src/components/team/NoteAttachments.tsx src/pages/TeamBoard.tsx
git commit -m "feat: add photo attachment support for team notes"
```

---

## Task 7: QuickTaskModal Component

**Files:**
- Create: `src/components/team/QuickTaskModal.tsx`

**Step 1: Create QuickTaskModal.tsx**

Reusable modal for creating a team note pre-filled with entity context:

```typescript
interface QuickTaskModalProps {
  open: boolean;
  onClose: () => void;
  entityType: LinkedEntityType;
  entityId: string;
  prefillTitle?: string;    // e.g. "Follow up: DEL-2026-0142"
  prefillContent?: string;  // e.g. "Customer: Smith Farms\nDriver: Sam W."
  prefillAssignee?: string; // pre-select assigned_to
}
```

The modal contains:
- Title input (pre-filled)
- Content textarea (pre-filled with entity context)
- Note type selector (default: 'todo')
- Priority selector (default: 'medium')
- Assign to dropdown (loads profiles)
- Due date picker
- Entity badge showing the linked entity (read-only)
- Save button — inserts into `team_notes` with `linked_entity_type` and `linked_entity_id`

Full-screen on mobile (`fixed inset-0` on `sm:` breakpoint, centered modal on desktop).

**Step 2: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 3: Commit**

```bash
git add src/components/team/QuickTaskModal.tsx
git commit -m "feat: add QuickTaskModal for contextual task creation from operational pages"
```

---

## Task 8: RelatedNotes Component

**Files:**
- Create: `src/components/team/RelatedNotes.tsx`

**Step 1: Create RelatedNotes.tsx**

Shows team notes linked to a specific entity on detail pages:

```typescript
interface RelatedNotesProps {
  entityType: LinkedEntityType;
  entityId: string;
  onCreateTask: () => void; // opens QuickTaskModal
}
```

The component:
1. Calls `get_notes_for_entity()` RPC
2. Shows compact list of linked notes (title, priority badge, assignee, status)
3. Each note clickable → navigates to `/team-board?note={id}`
4. "Create Task" button at top right
5. Empty state: "No related notes" with subtle "Create Task" CTA
6. Collapsible card with header "Team Notes (3)"

**Step 2: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 3: Commit**

```bash
git add src/components/team/RelatedNotes.tsx
git commit -m "feat: add RelatedNotes component for entity detail pages"
```

---

## Task 9: Add Create Task + Related Notes to 5 Detail Pages

**Files:**
- Modify: `src/pages/DeliveryDetail.tsx`
- Modify: `src/pages/OrderDetail.tsx`
- Modify: `src/pages/JobDetail.tsx`
- Modify: `src/pages/CustomerDetail.tsx`
- Modify: `src/pages/PurchaseOrderDetail.tsx`

**Step 1: Add to DeliveryDetail.tsx**

Import `QuickTaskModal` and `RelatedNotes`. Add state: `const [quickTaskOpen, setQuickTaskOpen] = useState(false)`.

Add "Create Task" button in the action bar (near existing buttons like Print, Email).

Add `<RelatedNotes entityType="delivery" entityId={id} onCreateTask={() => setQuickTaskOpen(true)} />` section (after delivery items, before photos).

Add `<QuickTaskModal>` with pre-fill:
- title: `"Follow up: ${delivery.delivery_number}"`
- content: `"Customer: ${customerName}\nDriver: ${driverName}\nDate: ${delivery.scheduled_date}"`
- assignee: `delivery.assigned_driver`

**Step 2: Add to OrderDetail.tsx**

Same pattern. Pre-fill:
- title: `"Follow up: ${order.order_number}"`
- content: `"Customer: ${customerName}\nSales Rep: ${salesRepName}"`

**Step 3: Add to JobDetail.tsx**

Same pattern. Pre-fill:
- title: `"Issue: Job ${job.id.slice(0,8)}"`
- content: `"Customer: ${customerName}\nApplicator: ${applicatorName}"`

**Step 4: Add to CustomerDetail.tsx**

Same pattern. Pre-fill:
- title: `"Note: ${customer.name}"`
- content: `"Customer: ${customer.name}\nTier: ${customer.tier}"`

**Step 5: Add to PurchaseOrderDetail.tsx**

Same pattern. Pre-fill:
- title: `"Follow up: ${po.po_number}"`
- content: `"Supplier: ${supplierName}"`

**Step 6: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 7: Commit**

```bash
git add src/pages/DeliveryDetail.tsx src/pages/OrderDetail.tsx src/pages/JobDetail.tsx src/pages/CustomerDetail.tsx src/pages/PurchaseOrderDetail.tsx
git commit -m "feat: add Create Task buttons and Related Notes to 5 operational detail pages"
```

---

## Task 10: Update Create/Edit Note Modal with Entity Linking

**Files:**
- Modify: `src/pages/TeamBoard.tsx`

**Step 1: Add entity linking fields to create/edit modal**

Add state variables:
```typescript
const [linkedEntityType, setLinkedEntityType] = useState<string>('');
const [linkedEntityId, setLinkedEntityId] = useState<string>('');
```

In the modal form (TeamBoard.tsx ~line 1193), add after the Assign To / Due Date row:

- Entity Type dropdown: `delivery | order | customer | job | purchase_order | quote | (none)`
- Entity ID text input (UUID) — with a search/autocomplete for the selected type:
  - If `delivery` selected, fetch recent deliveries and show as dropdown with delivery_number + customer_name
  - If `customer` selected, fetch customers and show as searchable dropdown
  - etc.

Update `handleSave`:
- On insert: include `linked_entity_type` and `linked_entity_id` in the insert payload
- On update: include in the update payload
- Pass `null` if empty

Update `openEditModal` to populate the entity linking fields from existing note data.

**Step 2: Update fetchNotes to include entity data**

The `fetchNotes` function should now select the `linked_entity_type` and `linked_entity_id` columns (they'll come automatically since we use `select('*')`, but the ExtendedTeamNote type needs to include them).

**Step 3: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/pages/TeamBoard.tsx
git commit -m "feat: add entity linking fields to Team Board create/edit modal"
```

---

## Task 11: Restructure Board Tab with Sectioned Layout

**Files:**
- Modify: `src/pages/TeamBoard.tsx`

**Step 1: Add new sections to Board tab**

The Board tab (currently lines 844-893) currently shows a 3-column grid of Notes / To-Do / Announcements.

Restructure to:

```
{viewTab === 'board' && (
  <>
    {/* Unassigned delivery alert */}
    <UnassignedAlert />

    {/* Today's Deliveries section */}
    <TodaysDeliveries />

    {/* Your Tasks & Mentions (role-aware personal section) */}
    <YourTasksSection />

    {/* Pinned & Announcements */}
    <PinnedSection />

    {/* Yesterday's Recap */}
    <YesterdayRecap />

    {/* Filters + Add Note button */}
    <div className="flex justify-between items-start gap-4">
      <TeamBoardFilters ... />
      <Button onClick={openAddModal}>Add Note</Button>
    </div>

    {/* All Notes — existing 3-column grid */}
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      ... Notes / To-Do / Announcements columns ...
    </div>
  </>
)}
```

**"Your Tasks & Mentions" section:**
- Shows tasks assigned to current user (same data as My Tasks tab but inline, max 5)
- Shows recent @mentions (notes where current user is mentioned in comments)
- "View All" link → switches to My Tasks tab
- Collapsible if 0 items

**"Pinned & Announcements" section:**
- Shows pinned notes + announcement-type notes
- Compact card layout
- Already exists in the Notes/Announcements columns — just elevate pinned items to their own section above the grid

**Step 2: Import new components**

Import `TodaysDeliveries`, `YesterdayRecap` at the top of TeamBoard.tsx.

**Step 3: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 4: Commit**

```bash
git add src/pages/TeamBoard.tsx
git commit -m "feat: restructure Board tab with sectioned layout — deliveries, tasks, recap"
```

---

## Task 12: Mobile Optimization Pass

**Files:**
- Modify: `src/pages/TeamBoard.tsx`
- Modify: `src/components/team/NoteCard.tsx`
- Modify: `src/components/team/TodaysDeliveries.tsx`
- Modify: `src/components/team/QuickTaskModal.tsx`

**Step 1: TeamBoard.tsx mobile fixes**

- Stats bar: `grid-cols-3` on mobile (currently `grid-cols-2` then jumps to 6), consolidate into 2 rows of 3
- Tab navigation: horizontal scroll on mobile (`overflow-x-auto whitespace-nowrap`)
- Filters panel: full-width accordion on mobile
- 3-column note grid: single column on mobile (`grid-cols-1`), 2 on tablet, 3 on desktop
- Add Note button: `fixed bottom-4 right-4 z-40` FAB (floating action button) on mobile, inline on desktop

**Step 2: NoteCard.tsx mobile fixes**

- Action buttons (pin/edit/delete): always visible on mobile (no hover state on touch)
  - Use `sm:opacity-0 sm:group-hover:opacity-100` instead of just `opacity-0 group-hover:opacity-100`
- Increase touch target: `min-h-[44px]` on action buttons
- Content truncation: `line-clamp-2` on mobile, `line-clamp-3` on desktop

**Step 3: TodaysDeliveries.tsx mobile fixes**

- Full-width card stack on mobile
- Delivery time + driver prominent (larger text)
- "Call driver" phone icon if driver has phone number

**Step 4: QuickTaskModal.tsx mobile fixes**

- Full-screen on mobile: `fixed inset-0 sm:relative sm:inset-auto sm:max-w-lg sm:mx-auto sm:mt-20`
- Bottom-anchored save button on mobile

**Step 5: Verify build**

Run: `npm run build`
Expected: 0 errors

**Step 6: Commit**

```bash
git add src/pages/TeamBoard.tsx src/components/team/NoteCard.tsx src/components/team/TodaysDeliveries.tsx src/components/team/QuickTaskModal.tsx
git commit -m "feat: mobile optimization for Team Board — responsive layout, touch targets, FAB"
```

---

## Task 13: Update Reference Docs

**Files:**
- Modify: `docs/reference/database-schema.md` — add `team_note_attachments` table, `linked_entity_type`/`linked_entity_id` columns
- Modify: `docs/reference/rpc-functions.md` — add 3 new RPCs
- Modify: `docs/reference/migration-history.md` — add migration entry
- Modify: `docs/reference/pages-routes.md` — update Team Board description

**Step 1: Update all 4 reference docs**

Add the new table, columns, RPCs, and migration entry to the reference docs.

**Step 2: Commit**

```bash
git add docs/reference/
git commit -m "docs: update reference docs for Team Board V2"
```

---

## Task 14: Final Verification

**Step 1: Full build check**

Run: `npm run build`
Expected: 0 errors, 0 warnings

**Step 2: Run all tests**

Run: `npm run test`
Expected: All passing

**Step 3: Manual smoke test checklist**

- [ ] Team Board loads with new sectioned layout
- [ ] Today's Deliveries section shows (or empty state)
- [ ] Yesterday Recap shows (or hides if empty)
- [ ] Create a note with entity link — badge appears on card
- [ ] Click entity badge — navigates to detail page
- [ ] Open DeliveryDetail — "Create Task" button works, pre-fills correctly
- [ ] Open note detail — photo upload works
- [ ] View on mobile viewport — responsive layout, FAB button, full-width cards

**Step 4: Final commit if any fixes needed**

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Migration + types | 1 SQL + types/index.ts |
| 2 | Extract NoteCard | New component + TeamBoard refactor |
| 3 | EntityBadge | New component |
| 4 | TodaysDeliveries | New component |
| 5 | YesterdayRecap | New component |
| 6 | Photo Upload/Display | 2 new components + TeamBoard integration |
| 7 | QuickTaskModal | New component |
| 8 | RelatedNotes | New component |
| 9 | Create Task on 5 pages | 5 page modifications |
| 10 | Entity linking in modal | TeamBoard modification |
| 11 | Sectioned Board layout | TeamBoard restructure |
| 12 | Mobile optimization | 4 file modifications |
| 13 | Reference docs | 4 doc updates |
| 14 | Final verification | Build + test + smoke test |
