# Team Board V2 — Operational Hub Design

**Date:** 2026-03-15
**Status:** ✅ Implemented + E2E tested (26 tests, 23 passing, 3 skip when no deliveries)
**Approach:** Component Library (Approach C) — break monolith into reusable components

---

## Scope (8 Features)

1. **Entity Linking** — Notes can reference deliveries, orders, customers, jobs, POs, quotes
2. **Create Task buttons** — 5 operational detail pages get "Create Task" quick-action
3. **Today's Deliveries section** — Bulletin board on Team Board showing scheduled deliveries
4. **Role-aware default view** — Drivers see their deliveries/tasks first, admin sees everything
5. **Yesterday's recap** — Completed deliveries + issues from previous day
6. **Unassigned delivery alert** — Prominent alert when deliveries have no driver
7. **Photo attachments** — Notes support image uploads via Supabase storage
8. **Mobile optimization** — Responsive layout, larger touch targets, mobile-friendly cards

---

## Database Changes

### Migration: `20260315200000_team_board_v2.sql`

#### 1. Add entity linking columns to `team_notes`

```sql
ALTER TABLE team_notes
  ADD COLUMN linked_entity_type text,
  ADD COLUMN linked_entity_id uuid;

CREATE INDEX idx_team_notes_entity
  ON team_notes (linked_entity_type, linked_entity_id)
  WHERE linked_entity_type IS NOT NULL;
```

Allowed entity types: `delivery`, `order`, `customer`, `job`, `purchase_order`, `quote`

#### 2. New table: `team_note_attachments`

```sql
CREATE TABLE team_note_attachments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id uuid NOT NULL REFERENCES team_notes(id) ON DELETE CASCADE,
  file_url text NOT NULL,
  file_name text NOT NULL,
  file_type text NOT NULL,
  file_size_bytes bigint NOT NULL,
  uploaded_by uuid NOT NULL REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_team_note_attachments_note ON team_note_attachments(note_id);
```

RLS: authenticated read all, insert own, delete own or admin.

#### 3. Storage bucket: `team-note-attachments`

Follows existing `delivery-photos` pattern. Public read, authenticated upload.

#### 4. New RPC: `get_team_board_deliveries()`

Returns today's + tomorrow's deliveries with:
- delivery id, delivery_number, status, priority
- customer name, delivery address
- driver name (or NULL if unassigned)
- scheduled_date, scheduled_time
- item count (from delivery_items)
- Role-aware: drivers see only their assigned, admin/sales see all

#### 5. New RPC: `get_yesterday_delivery_recap()`

Returns:
- Yesterday's completed deliveries (customer, driver, item count)
- Any deliveries with issues (issue_type, issue_description)
- Summary counts: total_completed, total_cancelled, total_with_issues

#### 6. New RPC: `get_notes_for_entity(p_entity_type text, p_entity_id uuid)`

Returns all non-deleted team notes linked to a specific entity, with creator/assignee joins.

---

## Frontend Components

### New components in `src/components/team/`:

| Component | Purpose |
|-----------|---------|
| `TodaysDeliveries.tsx` | Role-aware delivery bulletin board section |
| `YesterdayRecap.tsx` | Yesterday's completion summary |
| `QuickTaskModal.tsx` | Reusable "Create Task" modal with entity pre-fill |
| `EntityBadge.tsx` | Clickable entity link badge (e.g., `DEL-2026-0142`) |
| `NotePhotoUpload.tsx` | Photo upload component for notes |
| `NoteAttachments.tsx` | Display attached photos in note detail |
| `NoteCard.tsx` | Extracted note card component (from TeamBoard monolith) |
| `RelatedNotes.tsx` | "Related Notes" section for operational detail pages |

### TeamBoard.tsx refactor

Current structure (tabs):
```
Board | My Tasks | Completed | Activity
```

New Board tab layout (sectioned):
```
┌─────────────────────────────────────┐
│ ⚠️ 2 Unassigned Deliveries         │  ← Alert bar (if any unassigned)
├─────────────────────────────────────┤
│ 📋 Today's Deliveries              │  ← TodaysDeliveries component
│  Driver sees: "Your 3 deliveries"  │
│  Admin sees: "All 8 deliveries"    │
├─────────────────────────────────────┤
│ ⭐ Your Tasks & Mentions           │  ← Filtered to current user
├─────────────────────────────────────┤
│ 📌 Pinned & Announcements          │  ← Team-wide pinned notes
├─────────────────────────────────────┤
│ 📊 Yesterday's Recap               │  ← YesterdayRecap component
├─────────────────────────────────────┤
│ All Notes [filters]                 │  ← Existing board with filters
└─────────────────────────────────────┘
```

My Tasks, Completed, Activity tabs remain unchanged.

### Operational page changes (Create Task buttons)

5 pages get a "Create Task" button in their action bar:
- **DeliveryDetail.tsx** — pre-fills: delivery number, customer, assigned driver
- **OrderDetail.tsx** — pre-fills: order number, customer, sales rep
- **JobDetail.tsx** — pre-fills: job number, customer, applicator
- **CustomerDetail.tsx** — pre-fills: customer name
- **PurchaseOrderDetail.tsx** — pre-fills: PO number, supplier

Each also gets a `<RelatedNotes />` section showing linked team notes.

### Mobile Optimization

- All new components use responsive Tailwind (`sm:`, `md:`, `lg:` breakpoints)
- Touch targets minimum 44px height on mobile
- TodaysDeliveries: horizontal scroll cards on mobile, grid on desktop
- NoteCard: full-width stacked layout on mobile
- QuickTaskModal: full-screen on mobile (`sm:max-w-lg`)
- Photo upload: camera capture support via `accept="image/*" capture="environment"`

---

## Deferred (Future Phases)

- Delivery communication threads (entity_comments table)
- Escalation engine (progressive alerts)
- Quick field status updates (simplified driver UI)
- Workload visibility (team capacity view)
- Recurring tasks / templates
- Customer context cards on linked notes
- Handoff notes
- Dispatch priority queue
- Read receipts / acknowledgments
- Saved view presets
- Alert → Task auto-conversion
- Weather context
