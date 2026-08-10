# Team Board / To-Do List Functionality Audit — 2026-08-08

Read-only audit of the employee to-do / delegation / shared-notes feature (the **Team Board**),
requested by Mason: "map what works and what we can improve."
Evidence: current source on `main`, applied migrations, and read-only live-database queries
(policies, row counts, cron jobs). No data was changed.

## Verdict

**The feature is well-built but effectively dead in production — and the single most
important reason is that delegation is broken at the database level: an employee who is
assigned a task cannot mark it complete.** The board saw one burst of use in March 2026
(53 notes) and nothing since 2026-03-20. Every note ever created *and* every assignment
ever made was admin-to-admin; drivers, the applicator, and the sales rep have never
touched it.

Recommended next step (one thing): fix the completion-permission gap (Finding 1) and add
assignment notifications (Finding 2) in one small migration + frontend PR, then re-launch
the board with the team. Everything else below is secondary.

## What the feature is (the map)

| Layer | What exists |
|---|---|
| Database | `team_notes` (types: `note`, `todo`, `announcement`; priorities low→urgent; `assigned_to`, `due_date`, `is_pinned`, completion fields, soft delete) plus `team_note_comments` (threading, @mentions), `note_tags` + `team_note_tags`, `team_note_attachments` (+ storage bucket), `note_activity_log` (full audit trail via triggers) |
| RPCs | `get_team_workload`, `get_notes_for_entity`, `get_team_board_deliveries`, `get_yesterday_delivery_recap` — all SECURITY DEFINER with pinned search_path |
| Team Board page (`/team-board`) | 5 tabs: Board (3 columns Notes / To-Do / Announcements + Today's Deliveries + overdue "Stale Tasks" banner + Your Tasks + Pinned & Announcements + Yesterday's Recap), My Tasks, Completed history (with time-to-complete), Workload (per-person open/overdue/deliveries), Activity (filterable audit log) |
| Cross-app integration | `RelatedNotes` + `QuickTaskModal` on Customer, Order, Delivery, Job, and Purchase Order detail pages; Dashboard shows top-10 "team action items" (pinned/urgent/overdue/mine); dashboard Action Queue rows have a "Create task" shortcut |
| Real-time | Board and comments auto-refresh via Supabase realtime subscriptions |
| Notifications | Comment @mentions create an in-app notification (bell panel deep-links to the note) |

## What works well

- **Solid data model and audit trail.** Every create/update/complete/assign/delete and every
  comment action is logged to `note_activity_log` by triggers; deletes are soft (recoverable),
  and the UI exposes the full history with filters. 150 activity rows confirm the triggers work.
- **Good delegation *surfaces*.** Assignee picker excludes service profiles, "My Tasks" sorts
  overdue → priority → due date, Workload view gives a fair per-person load picture (verified
  the RPC math), and overdue tasks escalate visually (amber 1d+ / red 3d+ / pulsing 7d+).
- **Entity linking is the standout idea.** A task created from an order/delivery/customer page
  is linked both ways — the note shows an entity badge, and the record's detail page shows the
  note. This is exactly the "share information across employees" glue Mason asked about.
- **Security fundamentals are right.** RLS is enabled everywhere, reads require an active
  profile (deactivated users see nothing), only admins can delete, and the RPCs follow the
  house SECURITY DEFINER rules. No security blockers found.

## Live usage reality (read-only queries, 2026-08-08)

- 53 notes total, **all created in March 2026; latest 2026-03-20**. Last comment 2026-03-15.
- Live today: **1 real open to-do** ("PARTS ORDER HAGIE", unassigned, due 2026-03-24 —
  ~4.5 months overdue) and 4 completed items that look like test artifacts
  ("TBV2 Test Note…", "Final Review 0704…"). The other 48 notes were soft-deleted.
- All 53 notes were created by admins; all 22 assignments went to admins.
  **Zero tasks were ever completed by someone other than the creator.**
- Tags: 0. Attachments: 0. Mentions used: 0. Mention notifications sent: 0.
- 8 pg_cron jobs run nightly; **none touch team_notes** (no reminders, no escalation).

## Findings — what to improve

### 1. BLOCKER — An assignee can't complete (or edit) a task they didn't create
`tnotes_update` RLS (verified live in `pg_policies`): update allowed only for the note's
**creator or an admin**. But the UI shows the completion checkbox to everyone
(`NoteCard.tsx:89-96` — only edit/pin/delete are gated by `canEdit`). A driver assigned a
task by an admin clicks the checkbox, the update matches 0 rows, and they get an error
toast. Same for a non-admin trying to update anything on a task delegated to them.
Live evidence is consistent: 21 notes were delegated, yet no task was ever completed by a
non-creator, and non-admin employees never participated at all.
**Fix direction:** allow the assignee to update completion fields — cleanest as a small
`complete_team_note` RPC (with `p_idempotency_key`) or a policy extension scoped to
`assigned_to = auth.uid()`. Requires a migration (approval-gated).

### 2. HIGH — Assigning a task notifies no one
Delivery and job assignment both send "assigned to you" notifications; team-board task
assignment sends nothing (the only team-note notification is a comment @mention). The
activity trigger records the reassignment but no notification is created, so delegation is
silent unless the employee happens to open the board. **Fix direction:** trigger on
`assigned_to` change → insert a `notifications` row, mirroring `delivery_assigned`.

### 3. HIGH — Notification deep-links to notes are broken in both paths
- `TeamBoard.tsx:328-334`: the `?note=<id>` effect only fires on `searchParams` change and
  is guarded by `notes.length > 0`. On a cold page load notes haven't loaded yet, the effect
  runs once against an empty list, never re-runs — the note modal never opens. (Code-level
  finding; not reproduced in a browser.)
- `Notifications.tsx:60-75`: the full notifications page's route map has no `team_note`
  entry, so clicking a mention notification there navigates nowhere.

### 4. MEDIUM — Reminders/escalation were designed but never built
`team_notes.last_escalated_at` was added ("F5 escalation engine dedup") but nothing writes
or reads it — no cron job, no edge function. Overdue tasks only surface if someone opens
the board or dashboard. The nightly `run_morning_notification_checks` cron is a natural
home for "due today / overdue" pings to assignees.

### 5. MEDIUM — The "Overdue" stat card doesn't show overdue items
`TeamBoard.tsx:718-732`: clicking the Overdue card sets a **priority** filter
(`urgent`+`high`) instead of filtering to overdue-by-due-date items. A low-priority overdue
task won't appear; a high-priority not-yet-due task will. `FilterState` has no overdue flag.

### 6. LOW — Linking friction and inconsistent entity coverage
- On the board's own create/edit modal, linking requires **pasting a raw UUID**
  (`TeamBoard.tsx:1321-1332`) — unusable in practice; the QuickTaskModal path from a detail
  page is the only realistic way to link.
- `invoice`/`product` are supported by `EntityBadge` and the type system but missing from
  the board's link dropdown, from `StaleTasksAlert`'s route map, and `RelatedNotes` isn't
  placed on invoice/product pages.

### 7. LOW — Unused/fragile extras
- Tags, attachments, and @mentions have literally never been used (live counts all 0).
  Not harmful, but they add UI weight; fine to leave, not worth investing in until the core
  delegation loop works.
- Mention matching (`CommentsSection.tsx:111-125`) resolves `@word` by case-insensitive
  substring match on concatenated full names — `@ma` could match the wrong person on a
  bigger team. Acceptable at current team size.
- Announcements have no expiry; all 22 were manually soft-deleted after going stale. A
  simple "expires on" date would keep the board clean.
- Completed-history date filter compares local date strings against UTC ISO timestamps
  (`TeamBoard.tsx:669-670`) — edge-of-day items can land on the wrong side of the filter.

## Suggested sequence (if Mason wants fixes)

1. **One PR: Findings 1 + 2 + 3** — assignee-completion RPC/policy (migration,
   approval-gated), assignment-notification trigger (same migration), and the two
   deep-link frontend fixes. This makes delegation actually work end to end.
2. **Second PR: Findings 4 + 5** — hook due-today/overdue reminders into the existing
   morning cron; add a real overdue filter behind the Overdue card.
3. **Then re-introduce the board to the team.** The tool's failure mode was adoption, and
   the adoption blockers were real bugs, not missing features. Skip building anything new
   (recurring tasks, checklists, etc.) until the team is actually using it.

## Not verified / remaining risk

- Frontend findings (3a, 5, 6, 7) are from code inspection; the app was not rendered in a
  browser during this audit.
- The claim "employees stopped using it because of Finding 1" is an inference — the RLS
  block and silent assignment are confirmed, but there may also have been a simple
  workflow-preference reason usage stopped in March.
