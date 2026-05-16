# CRX Manager — TODO (as of 2026-05-16)

Snapshot of what's done, what's outstanding, and what's deferred after the
2026-05-09 audit sprint + 2026-05-13 codex review of PR #59 + 2026-05-16
verification session.

---

## ✅ Done (do not redo)

### Audit fix sprint 2026-05-09 → 2026-05-13
- Phase 1 (4/4 critical), Phase 2 (9/9 money/inventory), Phase 3 (4/4 RLS+deps)
- Decision-B (#9a + #9b RLS → admin/sales_rep/applicator)
- All numbered audit items: #5, #6, #7, #10/#31/#34, #11/#27, #18, #19, #28, #32, #33, #35

### PR #59 codex review (2026-05-13)
- All 9 P1 findings closed (or false-positive documented)
- 11 of 13 P2 findings closed
- 12 follow-up migrations applied to live Supabase via MCP
- 4 Edge Functions deployed to live (`create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`)
- Strict-actor security hotfix on `edit/delete_prepay_credit` applied within minutes of detection
- `parseDollarsToCents` refactored to positive-only default

See `docs/audits/2026-05-13-pr59-codex-review-summary.md` for full table.

### 2026-05-16 verification session
- **`send-email` Edge Function deployed to v10** — `farm_name` fix from PR-03 (commit `31c3db1`, dated 2026-05-09) was on the branch for ~7 days but never deployed. Live v9 was still selecting `customers.name` (column doesn't exist), silently failing for every customer-tied email. Now live at v10 with `select("id, email, farm_name")` verified in the deployed bundle.
- **Frontend idempotency-key reuse verified clean** — all 5 callsites flagged in 2026-05-12 ultra review (`PrepaymentManager.tsx` ×3, `BulkOrderImport.tsx`, `BlendRecipes.tsx`) are already using `useIdempotencyKey()` hooks or stable per-order key generation. No fix needed.
- **Advisory comment posted on PR #60** — flagged that the two migration files in that PR (`20260511120000_security_audit_2026_05_11.sql` drops `profile_public_view`; `20260511120100_drop_public_bucket_select_policies.sql`) conflict with live code that depends on the view. PR #60 needs to be closed or rebased — see Outstanding below.

---

## 🔴 Outstanding — Mason action required

### Phase 4: Backup verification
- Verify Supabase backups in dashboard (point-in-time recovery enabled? scheduled snapshots running?)
- Plan + schedule a future restore drill (target: restore latest snapshot to a preview branch, verify schema + a few sample rows match)
- No code changes; pure operational task.

### #38: Abandoned-package swap
- Needs test fixtures from Mason: `.shp`, `.dbf`, `.prj`, `.kml` sample files for the field-import flow.
- Once fixtures land, the abandoned-package can be swapped out with a maintained alternative.

### PR #60 decision (draft, advisory comment posted 2026-05-16)
PR #60 (`claude/app-review-audit-yseuL`) is still OPEN as draft, last updated 2026-05-11 (before the ultra review existed). Body claims "no code or schema changes — findings document only" but the file list contains 2 migrations totaling ~140 lines of risky SQL. Pick one:
- **Close it** — cherry-pick `AUDIT_REPORT_2026-05-11.md` into `docs/audits/` first if useful as historical context.
- **Rebase + drop the two migration files** — keeps the audit doc, removes the risk.
- **Replace the view drop with a proper migration** — migrate any remaining callers off `profile_public_view`, *then* drop. Probably the most work for the least value at this point.

Advisory comment with full context: https://github.com/masonwells1/CRX_Manager_V1.0/pull/60#issuecomment-4466986788

### GitHub PR UI cleanup
- ~17 codex review threads on PR #59 are now addressed but still showing as "Open" because Codex doesn't auto-resolve after fix-commits.
- Manual "Resolve conversation" click needed on each. Roughly:
  - 9 P1 threads (all addressed)
  - 8 P2 threads (11 closed minus the 2 deferred = some still need clicks; 3 are marked `is_outdated` and will be hidden anyway)

### Codex billing (if you want more reviews on this branch)
- Codex usage limit hit at end of 2026-05-13. Either upgrade plan or add credits in the [Codex usage dashboard](https://chatgpt.com/codex/cloud/settings/usage), or accept the current state as final.

---

## 🟡 Deferred (intentional or follow-up sprint)

### `safe_cents_qty` follow-up (3 instances)
The audit #7 helper was applied to `create_quick_delivery` (most-trafficked path). 3 single-instance call sites still need wrapping in a follow-up sprint:
- `transfer_job_to_invoice`
- `create_invoice_from_blend_ticket`
- `save_field_app_invoice`

Each is a single `(*_cents * qty)::bigint` pattern with smaller blast radius than `create_quick_delivery`. Schema-aware hook `sql-safety.mjs` now blocks new instances.

### Customer RLS upper bound (P2 #3)
**Decision: leave as-is.** Drivers/applicators can see customers for jobs scheduled arbitrarily far in the future. Intentional — farm logistics require future visibility for route/job planning. Lower bound prevents the meaningful historical leak.

### Entity commission recipients (P2 — design call)
`CMCTW LLC` and `Crop Rx Solutions` are in `CommissionSplitEditor.RECIPIENTS` but have no profile row, so `recipient_user_id` stays NULL after my full_name lookup. `create_commission_payment` rejects NULL recipients → those commissions can't be paid via the standard flow.

**Options (need Mason's pick):**
1. Create service profile rows for entity recipients (smallest change, but expands profile semantics)
2. Refactor `CommissionSplitEditor` to source from `profile_public_view` and send profile UUIDs in the JSONB
3. Update `create_commission_payment` to allow grouping by `recipient` text when `recipient_user_id` is NULL
4. Move entity-recipient payments to a separate manual flow

Pre-existing limitation, not a regression from this PR — affected entity-recipient commissions have always been unpayable via this path.

---

## 🚫 Out of scope (separate PR / project)

### PR-23 / Task 4: E2E staging Supabase
Blocked on creating `crx-manager-staging` Supabase project + adding `STAGING_SUPABASE_URL` / `STAGING_SUPABASE_ANON_KEY` GitHub secrets. Will be a separate PR once unblocked. Tracked in original 2026-05-09 audit plan.

---

## 📋 Status snapshot

| Metric | Value |
|---|---|
| Migrations | 333 |
| Pages | 66 |
| Tables | 93 |
| RPCs | ~184 |
| Edge Functions | 7 (all current — `send-email` v10 as of 2026-05-16) |
| Unit tests | 1,913 passing (130 files, 70 skipped) |
| E2E spec files | 94 |
| ESLint errors | 0 |
| TypeScript errors | 0 |
| Supabase perf advisor WARN | 0 (was 97) |
| CI on `fix/audit-2026-05-09` | green |
