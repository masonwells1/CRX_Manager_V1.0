# U13 — src/types/index.ts changes

**None required.**

Verified before writing any patch:
- `ActionQueueItem` (src/types/index.ts:2981-2992) already carries an optional
  `scheduled_date?: string` field (added for the existing `unassigned_deliveries`
  category) — the new `unassigned_jobs` category reuses it verbatim, so
  `ActionQueue.tsx`'s new category config needs no type change.
- `LinkedEntityType` already includes `'job'` (used throughout JobDetail.tsx's
  `logActivity` calls) — `ActionQueue.tsx`'s new category's `entityType: 'job'`
  needs no type change.
- The one NEW shape this unit introduces — `DispatchLocation.currentAssignee`
  — lives in `src/lib/dispatchWizard.ts`, not `src/types/index.ts` (that file
  defines its own `DispatchAssignee`/`DispatchLocation` types; they are not
  re-exported through `types/index.ts`). See `patch_dispatchWizard.ts.md` for
  that change.
- `JobRow` (Jobs.tsx, local to the page) and `CockpitData`/`NeedsDispatchJobRow`
  (OfficeCockpit.tsx, local to the page) and `sectionJobs` (QuoteBuilder.tsx,
  local state) are all page-local types, not shared `src/types/index.ts`
  interfaces — each change is captured in that page's own patch file.
- `job_location_dispatches` (the table read by 3 of the 6 patched files) already
  has a generated Supabase type via `src/types/supabase.ts` (confirmed live
  columns: `id, job_field_id, job_id, applicator_id, crew_id, dispatched_at,
  dispatch_status, dispatched_by, created_at, updated_at`) — no
  `generate_typescript_types` run is needed since this unit adds no new
  column/table, only 3 new triggers + a function body re-emit.
