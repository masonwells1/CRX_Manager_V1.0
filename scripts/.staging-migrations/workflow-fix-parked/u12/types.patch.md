# src/types/index.ts — no changes needed

Checked before writing this: U12 adds no new table/column, so `src/types/index.ts`
needs no edit.

- `job_date` (added to `get_dispatched_list`'s jsonb payload) is carried on
  `DispatchedListRow` / `FieldViewJobCard` in `src/lib/dispatchDisplay.ts` (see
  `dispatchDisplay.patch.md`) — those are page-local display interfaces, not
  `src/types/index.ts` shared types (mirrors how the OTHER dispatch-row fields
  — `job_status`, `location_acres`, etc. — already live there, not in
  `types/index.ts`).
- `products.rei_hours` / `products.phi_days` already exist on the shared
  `Product` interface in `src/types/index.ts` (lines 45/47, 89/90, 2271/2272 —
  verified live via grep before writing FieldView) — U12 just reads them
  through a NEW embed (`product:products(product_name, rei_hours, phi_days)`
  in `FieldView.tsx`'s `job_chemicals` query), no type change required.
- `complete_job`'s new `p_applied_info->'field_acres'` key is an internal
  shape inside an already-untyped `jsonb` RPC argument — not a typed
  interface anywhere in the frontend (JobDetail's own `p_applied_info` is a
  plain object with no shared type either), so there's nothing to add here.
- `notifications.notification_type` is untyped `text` with no CHECK
  constraint (verified live) — the three new values (`job_dispatched`,
  `job_rescheduled`, `job_undispatched`) don't need a type/enum update either.

If `npm run typecheck` surfaces anything unexpected when these patches are
applied for real, the most likely culprit is the `Database['public']['Functions']`
generated type for `get_dispatched_list`/`start_job`/`complete_job` in
`src/types/supabase.ts` (Supabase-generated, not hand-maintained) — regenerate
it with `mcp__supabase__generate_typescript_types` (or
`node scripts/regenerate-schema-registry.mjs` per CLAUDE.md's "Keeping Docs In
Sync") AFTER the migration is actually applied live, since none of these three
functions changed their argument list or return type (verified: `get_dispatched_list`
stays `RETURNS SETOF jsonb`, `complete_job`/`start_job` keep their exact
signatures) — so no regen should even be strictly required, but it's a cheap
sanity check post-apply.
