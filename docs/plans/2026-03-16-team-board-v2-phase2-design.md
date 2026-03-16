# Team Board V2 Phase 2 — Escalation, Workload, Customer Context

**Date:** 2026-03-16
**Status:** In progress

---

## Scope (3 Features)

### F5: Escalation Engine (Stale Task Alerts)

**Problem:** Overdue tasks sit silently. A delivery remainder lingers for 8 days and nobody notices.

**Design:** Lightweight, frontend-driven escalation on Team Board load:

1. **Visual escalation tiers** based on days past `due_date`:
   - 1-3 days overdue → amber badge "1d overdue"
   - 3-7 days overdue → red badge "5d overdue" + auto-bump to high priority display
   - 7+ days overdue → red pulsing badge + pinned to top of Stale Tasks section

2. **New "Stale Tasks" alert section** on Board tab (above All Notes):
   - Shows all overdue, incomplete, non-deleted tasks
   - Sorted: most overdue first
   - Collapsible, visible by default for admins
   - Shows assignee, days overdue, linked entity

3. **Escalation notifications** (run once per day on first Team Board load):
   - Check: any tasks overdue 3+ days that haven't been escalated
   - Create notification for assigned user: "Task X is 5 days overdue"
   - Create notification for admins: "3 team tasks are overdue 7+ days"
   - Dedup: only fire once per task per escalation tier
   - Track via `team_notes.last_escalated_at` column (new)

**DB changes:**
- Add column: `team_notes.last_escalated_at timestamptz` (nullable)
- No new tables, no new RPCs (all frontend logic)

---

### F7: Workload Visibility

**Problem:** Admins can't see who's overloaded when assigning deliveries or tasks.

**Design:** New "Workload" tab on Team Board:

| Team Member | Role | Today's Deliveries | Open Tasks | Overdue |
|---|---|---|---|---|
| Sam W. | Driver | 4 | 2 | 0 |
| Jake R. | Driver | 1 | 0 | 0 |
| Sarah M. | Sales Rep | — | 5 | 1 |

**Data source:** New RPC `get_team_workload()` that returns:
```sql
-- For each active profile:
-- - open_tasks: count of assigned, incomplete, non-deleted team_notes
-- - overdue_tasks: count where due_date < today
-- - today_deliveries: count of assigned deliveries for today (drivers only)
-- - total_deliveries_week: count for current week
```

**Frontend:**
- New tab "Workload" between "Completed" and "Activity"
- Color-coded load: green (0-2 tasks), amber (3-5), red (6+)
- Click row → expand to show their actual task list (inline)
- Mobile: card layout per team member

---

### F9: Customer Context Cards

**Problem:** A note says "Follow up with Smith Farms" but you have to leave the Board to check their AR balance and open orders.

**Design:** When a note is linked to a customer (`linked_entity_type = 'customer'`), show a compact context card below the entity badge:

```
┌─────────────────────────────────────┐
│ Smith Farms — Tier 1                │
│ AR: $12,400 (45d overdue)           │
│ 3 open orders · Last delivery: Mar 2│
└─────────────────────────────────────┘
```

**Data source:** Inline Supabase queries on note render (batched):
1. `customers` table → `assigned_tier`, `credit_limit_cents`
2. `get_ar_aging()` → filter to specific customer_id → `total_outstanding`
3. `orders` count where status in ('confirmed', 'partially_fulfilled')
4. `deliveries` → most recent completed delivery date

**Frontend:**
- New `CustomerContextCard.tsx` component
- Displayed in `NoteCard.tsx` when `linked_entity_type === 'customer'`
- Lazy-loaded (only fetches when card is visible/expanded)
- Cached per customer_id for the session (avoid re-fetching on every render)

---

## Implementation Order

1. F9 (Customer Context Cards) — smallest, no DB changes
2. F5 (Escalation Engine) — 1 column migration + frontend
3. F7 (Workload Visibility) — 1 new RPC + new tab
