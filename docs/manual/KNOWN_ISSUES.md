# Known Issues — Consolidated

**Last verified: 2026-07-27** (live high-water re-read this date via the Supabase connector: **914 ledger rows, max version `20260727174805`** — three migrations applied live this date. `inline_role_checks_require_active_profile` (`20260727145843`) **RESOLVES section 0a**: the 38 RLS policies that inlined a role check now also require an active profile, residual gaps 38 → 0. Its two out-of-scope follow-ups are now **also RESOLVED and applied live**: `broad_reads_require_active_profile` (`20260727174657`) took wide-open PERMISSIVE read policies **31 → 0**, and `deactivation_revokes_auth_access` (`20260727174805`) made deactivation actually revoke auth access. Section 0a is retained because **one** item remains open under it — a disaster-recovery defect in the schema baseline, blocked on a credential; production is unaffected. Every other dated claim below stands unchanged. Prior stamp, still accurate: 2026-07-26, live high-water `20260726190515` — Section 9 PO/AP HIGH remediation applied live 2026-07-26 with Mason's in-chat approval: all five Section 9 sweep findings cleared (the `section9-po-ap-controls` predicate returns zero rows live). Supplier Pricing Phase 3 Stage A remains dormant: 604 Products unchanged, zero classifications/family rows, and `supplier_cost_basis_enabled=false`; supplier-pricing governed edit/batch paths and `process-document` v19 OCR retirement remain live and proven. Older open/deferred claims retain their dated evidence below; owner-facing combined list: root `TODO.md`)
**Update triggers:** when a finding is parked/resolved, a migration is parked/applied, or an owner decision lands. Agents must update THIS file, not create new issue lists. Do not re-discover or re-fix something listed here as already known — read the pointer first.

This file consolidates (does not replace) the source documents it points to. If this file and a source disagree, trust the source and fix this file.

---

## 0a. RESOLVED 2026-07-27 — deactivated users kept access through 38 RLS policies (follow-up items 1 and 2 also resolved; item 3 open and BLOCKED)

**Status 2026-07-27: FIXED LIVE** by migration `20260727145843_inline_role_checks_require_active_profile`
(applied under Mason's conditional approval once the clean-rebuild check passed). Residual inline-role
gaps went **38 → 0**; 48 policies now require an active profile. Live role simulation, fully rolled
back: the deactivated `sales_rep` now sees **0** vendors and **0** vendor_bills, while an active admin
still sees 13 and 4. **Of the three numbered items at the end of this section, items 1 and 2 were
themselves RESOLVED and APPLIED LIVE later the same day** (ledger `20260727174657` and
`20260727174805`) — they are kept below with their proofs rather than deleted, and each carries its
own residual-risk note. **Item 3 remains OPEN and is BLOCKED** on a credential; it is an unrelated
disaster-recovery defect in the schema baseline, logged here because this migration's clean-rebuild
check is what surfaced it.

The original finding, for context:

**As found 2026-07-27:** 38 RLS policies — across 17 `public` tables plus
`storage.objects` — gate on `profiles.role` **inline** without also requiring
`profiles.is_active = true`. Deactivation is not enforced anywhere else: `auth.users.banned_until`
is NULL for the deactivated account and sessions are not revoked, so RLS is the only gate. A user
who has been deactivated but still holds a valid JWT therefore keeps access through every one of
them. One such account exists live (a deactivated `sales_rep`, 216 session rows, last sign-in
2026-03-15) and 7 of the 38 policies include `sales_rep`, so it is exploitable today.

Policies that call `is_admin()` / `is_sales_rep()` / `is_driver()` / `is_applicator()` are **not**
affected — all four helpers were confirmed live to check `is_active`. This is the systemic gap that
migration `20260726223520` (migration-history row 826) explicitly deferred.

Fix, now applied live as ledger version `20260727145843`:
`supabase/migrations/20260727145843_inline_role_checks_require_active_profile.sql`, branch
`claude/rls-inline-role-require-active`, commit `4fcf2c90`, migration-history row 827. Proven by a
full-file dry run on live inside `BEGIN … ROLLBACK` (all 38 ALTERs applied, verification block
passed, residual gaps 38 → 0, rolled back, live state re-read unchanged) and adversarially reviewed
by Codex `gpt-5.6-sol` at high effort — verdict SHIP-WITH-FOLLOWUPS, no blockers. **Do not
re-discover or re-audit this — the enumeration and the migration already exist.**

**2026-07-27 — both preconditions were met, and the migration is now APPLIED LIVE.** The clean-rebuild replay was run on a
disposable PostgreSQL 17.6 stack built from `supabase/baselines/`: all 38 policy names present
(38/38, 0 missing), the file applies cleanly, and its verification block reports `38 policies now
require an active profile` with 0 residual gaps. The replay stalls at 16 of 50 on a **pre-existing
baseline defect unrelated to this migration** — the July 19 baseline's schema is ahead of its own
recorded ledger high-water, so it carries function bodies later than migration 16's md5 precondition
expects. That does not weaken the proof: the remaining 35 migrations were checked statically and none
creates, drops, or alters any of the 38 targets. **Refreshing the baseline so a from-zero replay
completes is a separate open item.** The `write-apply-proofs.mjs` gate now returns CLEAN from both
`rls-security-reviewer` and `migration-drift-reviewer` — its first run correctly blocked on a CHECK 9
comment reference, since fixed (comment-only).

Of the three items listed below, **items 1 and 2 were RESOLVED and APPLIED LIVE on 2026-07-27**
(ledger versions `20260727174657` and `20260727174805`) under Mason's explicit approval; they are kept
here with their proofs rather than deleted. **Item 3 remains OPEN and is BLOCKED** on a credential —
it is an unrelated pre-existing defect that the clean-rebuild check surfaced, and it affects
disaster-recovery rebuilds only, not production.

1. **RESOLVED — APPLIED LIVE 2026-07-27 (`20260727174657`).** **Wide-open PERMISSIVE read policies —
   the count here was wrong; it is 31, not six.**
   **Corrected 2026-07-27** after a live re-enumeration: **31** PERMISSIVE SELECT policies across 31
   tables gate on nothing but "you are logged in" — 30 with `USING (true)` on role `authenticated`,
   plus `application_record_fields.arf_select` on PUBLIC with `uid IS NOT NULL`. The six tables named
   previously (`application_services`, `application_record_fields`, `customer_application_rates`,
   `quote_pdf_templates`, `quote_templates`, `team_note_attachments`) were only the *overlap* with the
   tables migration `20260727145843` tightened; the other 25 (`products`, `customer_addresses`,
   `team_notes`, `quote_items`, `applicator_licenses`, …) expose independent business data and were
   simply missed. PERMISSIVE policies OR together, so any logged-in user reads all 31 regardless of
   role or active status. Each of the six named tables has exactly ONE SELECT policy — the wide-open
   one — so there is no role-based policy to fall back on.
   **Fix APPLIED LIVE 2026-07-27 (ledger `20260727174657`):**
   `supabase/migrations/20260727174657_broad_reads_require_active_profile.sql` adds a role-agnostic
   `public.is_active_profile()` helper and rewrites all 31 predicates to require an active profile.
   It deliberately does **not** narrow read access by role — every active user reads exactly what
   they read today; only deactivated accounts lose read. Choosing which roles *should* see each
   table remains a separate product decision and is **still open**.
   **Live proof:** wide-open read policies **31 → 0**; 30 helper-based read policies plus `arf_select`
   on the inline form; helper acl `{postgres=X,authenticated=X,service_role=X}` with
   `has_function_privilege('anon', …) = false`. Behavioral, rolled back: an active admin sees
   `products=604 team_notes=53`, the deactivated user sees `products=0 team_notes=0`.
   **Gotcha worth remembering:** the first apply attempt was **rejected by the migration's own
   postflight check and rolled back atomically** — this project carries `ALTER DEFAULT PRIVILEGES`
   granting EXECUTE on every new `public` function to `anon`, so `REVOKE … FROM PUBLIC` is **not**
   sufficient; `anon` must be named explicitly. Any future SECURITY DEFINER helper here must do the
   same. See `docs/reference/gotchas.md`.
2. **RESOLVED — APPLIED LIVE 2026-07-27 (`20260727174805`).** **Deactivation does not revoke sessions
   or block re-login.** `profiles.is_active = false` is a
   pure application-layer flag; the Supabase auth user remains unbanned and existing refresh tokens
   stay valid. The durable fix is to ban/​sign-out the auth user on deactivate. Until then, every
   deactivation depends on RLS alone.
   **Owner decision 2026-07-27 (Mason):** deactivating a user must immediately end their sessions and
   block re-login; reactivating restores access; the rule applies to **new deactivations only** — the
   one already-deactivated account is deliberately not backfilled.
   **Fix APPLIED LIVE 2026-07-27 (ledger `20260727174805`):**
   `supabase/migrations/20260727174805_deactivation_revokes_auth_access.sql` adds an AFTER-UPDATE
   trigger on `profiles` that, on true→false, sets `auth.users.banned_until` to a finite far-future
   timestamp (**not** `'infinity'` — GoTrue decodes that column into a Go `time.Time` and an infinity
   can 500 the auth endpoint) and deletes the user's `auth.sessions` / `auth.refresh_tokens` rows; on
   false→true it clears the ban. It also adds `trg_guard_last_active_admin`, which refuses to
   deactivate the last active admin — now that deactivation bans the auth user, that mis-click would
   need Supabase dashboard recovery.
   **Residual window, unavoidable:** an access token already issued stays valid until it expires
   (~1 hour). Deleting the session and refresh tokens means it cannot be renewed, so access ends
   within that window at the latest. Instant revocation would require JWT revocation, which GoTrue
   does not offer.
   **Live proof (behavioral, against production, fully rolled back):** target
   `e2195c35-9eee-46aa-8b19-2734219e6a8c` — `BEFORE active=t ban=NULL sessions=924 tokens=924` →
   `DEACTIVATED ban=9999-12-31 23:59:59+00 sessions=0 tokens=0` → `REACTIVATED ban=NULL` →
   `LAST-ADMIN LAST_ACTIVE_ADMIN: cannot deactivate the only active admin`. Live state re-read after
   rollback unchanged (0 banned, 2595 sessions, 10 active profiles, 4 active admins). Note the proof
   must simulate an admin's `request.jwt.claims`: the pre-existing `_guard_profile_role_lock`
   correctly refuses an `is_active` change from a non-admin caller.
   **NOT verified:** the two `src/pages/SettingsPage.tsx` strings (the corrected deactivate-confirm
   text and the `LAST_ACTIVE_ADMIN` toast) are not visually confirmed — reaching Settings needs an
   admin login. Residual risk is cosmetic only: the database refuses a last-active-admin deactivation
   whether or not the friendly toast renders.
3. **NEW 2026-07-27 — the schema baseline is ahead of its own recorded ledger high-water, so a
   from-zero rebuild cannot complete.** `supabase/baselines/` records high-water `20260719092832`
   (861 ledger rows), but its public-schema artifact already contains
   `split_invoice_creation_claims` — a table introduced by `20260720213000`. It therefore also
   carries function bodies newer than the post-baseline migrations expect, and a replay fails at
   migration 16 of 50 with `PRECONDITION: reviewed public RPC drifted:
   public.create_invoice_from_order(...)`. This is a **disaster-recovery** concern, not a production
   one: live production is unaffected, but the documented "restore a new project" path in
   `supabase/baselines/README.md` does not currently run to completion. Fix is to refresh the
   baseline per that README's "Refreshing the baseline" section (regenerate dump + overlay + ledger
   together, update manifest hashes/counts, prove a disposable restore, re-run
   `npm run test:schema-baseline`). **Never edit an applied migration to make the rebuild pass** —
   the README forbids it and the historical files are the audit trail. Two further README
   deviations that a rebuild currently requires are documented in migration-history row 827: the CLI
   `db push` step needs replacing with an equivalent psql replay, and the replay must read git blobs
   because `core.autocrlf=true` breaks byte-exact function-body md5 preconditions on Windows.
   **BLOCKED 2026-07-27 — proven, not assumed.** The refresh needs a dump in the exact shape of the
   existing artifacts (`CREATE SCHEMA IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`, quote-all-identifiers
   — i.e. `supabase db dump`, not raw `pg_dump`; the stored artifact's own header confirms pg_dump 17.6
   via the Supabase CLI). That command was rehearsed read-only against live and **fails**:
   `pg_dump: error: query failed: ERROR: permission denied to set role "postgres"` — the CLI issues
   `SET ROLE "postgres"` for full catalog visibility. The only CRX database credential on this machine
   is the read-only `crx_backup_ro` role used by the nightly `pg_dump` job
   (`C:\Users\mason\Scripts\crx_database_backup.ps1`, password in `C:\selfhosted\CREDENTIALS.txt`),
   which cannot assume `postgres`; `CREDENTIALS.txt` holds no `postgres`-role password. **The one
   concrete unblocking step is Mason supplying the project's `postgres` database password** (Supabase
   dashboard → Project Settings → Database), or running the dump himself. Do **not** work around this
   by hand-rolling the Supabase CLI's post-processing on top of a `crx_backup_ro` `pg_dump`: the
   baseline *is* the disaster-recovery path, and reproducing it through an undocumented pipeline makes
   DR less trustworthy, not more. The README's own precondition — refresh only **after the migration
   ledger has settled** — **is now satisfied:** items 1 and 2 above were applied live on 2026-07-27
   and the ledger high-water is `20260727174805`. The credential is the only thing still blocking.

---

## 0. Per-line split-billing — pricing rule SETTLED = Option B (Mason, 2026-07-18)

Resolved. The prior open question (how to price a chemical split line when co-owners are on different tiers)
is decided: **Option B — each co-owner is billed at their OWN assigned_tier**, mirroring today's non-split
field-app billing (no customer's price changes). A manual price or field quote applies to everyone (tier-
independent); only the tier fallback varies per grower. Pricing proof: 20/80 tier1/tier3 field →
A@$10/gal, B@$8/gal, each own tier; plus a penny guard so a uniform price totals round-once.

**STATUS — SHIPPED AND LIVE, NOT PARKED** (re-verified against the live DB 2026-07-27; this entry previously
claimed "flag OFF, migration NOT applied, NOT merged", which was wrong on all three counts):

- **Merged** via PR #164 on 2026-07-21.
- **Applied live**: `20260720213000_per_line_split_billing_schema`, `20260720214000_..._calculator`, and
  `20260720233000_..._save_rpc` are all in the live migration ledger.
- **Flag is ON.** `app_settings.per_line_split_billing_enabled = 'true'`, set 2026-07-21 01:29 UTC — seven
  minutes after the merge. Note the shipped code default is OFF; the live value was deliberately flipped on.
  **What the flag actually gates (verified 2026-07-27):** only the two readers of
  `SPLIT_BILLING_SETTING_KEY` — the Sidebar nav entry (`src/components/layout/Sidebar.tsx`) and the split
  editor page (`src/pages/FieldAppSplitInvoiceEditor.tsx`). The safeguards are **data-driven and persistent,
  not flag-driven**: `isInvoiceEmailSuppressed()` checks `send_disposition === 'suppressed_zero_total'`
  unconditionally, and `InvoiceDetail` locks a line whenever `billing_line_id` is present. So turning the flag
  back OFF stops new split sets from being created — it does **not** strip protections from split invoices that
  already exist. (The header comment in `src/lib/splitBillingSetting.ts` overstates the flag's reach.)
- **Never exercised.** The field-app path (`save_field_app_split_invoice`) writes `field_app_billing_sets`,
  `field_app_billing_lines`, and `invoice_line_shares` — all three were empty as of 2026-07-27. The separate
  order-side path (`create_split_invoices_from_order` → `split_invoice_provenance`,
  `split_invoice_creation_claims`, `split_invoice_mutation_claims`) is also empty. Six tables, zero rows across
  both paths — **no recorded split-billing usage as of 2026-07-27.**
- **Spec + supersession.** Build spec: `docs/plans/per-line-item-split-billing-spec-2026-07-17.md`; direction
  settled in `DECISION_LOG.md` (2026-07-17). This supersedes the old "four parallel split mechanisms need a
  decision" flag — decided: the field-app path is the surface, the order-side engine is retired later.

⚠️ **Do not resurrect the stacked branches.** `codex/per-line-split-billing-phase3-rpc` (closed PR #181) and
`codex/per-line-split-billing-phase4-ui` (closed PR #182, tip `e2418796`) are a **superseded** variant built
on an incompatible schema/timestamp sequence — five `20260720230000`–`20260720234000` migrations that clash
with the live chain above. Mason's closing note on #182: they "must not be applied." Nothing is lost: both
are preserved on GitHub as `refs/pull/181/head` and `refs/pull/182/head`, and both still exist locally.

**Codex gate RAN 2026-07-18 → 8 P1 + 2 P2 findings, ALL FIXED + re-proven (21/21 live-rollback).** The Codex
money/RLS review blocked the first go-live attempt: service lines priced $0 / not per-customer (#1,#2);
chemical COGS written as 0 (#3); cross-rep RLS bypass in the SECDEF writer (#4); Post commits a stale draft
after edits (#5); a split child opened in the generic invoice page could cascade-delete its line shares (#6);
children got no field_app_locations → blank fields/acres (#7); duplicate `invoice_created` audit rows on
re-save (#8); mis-derived compat acres (#9); `send_disposition` never hydrated so the $0-email gate never
fired (#10). Mason chose **full v1 scope** (chemical + service + flat). All fixed in
`20260718030000_..._save_rpc.sql` + `FieldAppSplitInvoiceEditor.tsx` / `InvoiceDetail.tsx` /
`FieldApplicationInvoice.tsx` / `fieldInvoiceList.ts`; typecheck clean. Two non-blocking notes: a
chemical *return/credit* (negative qty) can't go through the split screen yet (fail-closed); the per-person
price override in the draft UI still works for one-off adjustments.

**Codex ROUND 2 RAN 2026-07-18 → 13 more findings (8 P1 + 5 P2), ALL 13 NOW RESOLVED + re-proven.** A deeper
pass found: flag not enforced server-side (#B); deploy-order coupling in InvoiceDetail preflight (#A); negative
flat credit posted as a charge (#C); malformed override → $0 (#D); source job billable via split AND normal
flow = double-bill (#E); fee cost per-acre vs extended mismatch (#F); per-child COGS rounding overstates group
total (#G); no route to reopen a saved draft (#H); local-date default (#J); micro-pct residual on custom
splits (#K); service name lost on item (#N); Option-B pricing audited as an "override" not a base (#M);
custom-split/override reasons never captured (#L). First 7 (#B/#C/#D/#F/#J/#K/#N) landed in `eb942f86`; the
final 6 (#A/#E/#G/#H/#L/#M) this session. **#H = save-now/post-later:** a new `split-billing/:id` route reopens
a saved set READ-ONLY for review + Post (editable reopen deferred — a re-save re-prices, so rebuilding money
fields is a future, separately-proven enhancement). **#E** consumes the source job (status→invoiced) so it
can't be double-billed. Re-proven in live PG: **PROOFOK 29/29** (adds cogs_group_lr_exact, audited_base_is_own,
reasons_captured, double_bill_second_set_rejected, resave_same_job_allowed). rls-security-reviewer 0/0,
migration-drift 0 blockers; typecheck + lint clean. *(State at the time of this round, since superseded: the
work was then parked with the flag OFF, migrations NOT applied, and PR #164 NOT merged. See the STATUS block
above — it shipped on 2026-07-21 and is live with the flag ON.)*

**Codex ROUND 3 RAN 2026-07-18 → 2 P1 + 4 P2, ALL fixed + PROOFOK 32/32.** A third pass (on the job-consumption
+ reopen work round-2 added) found: source job changeable on re-save → two jobs consumed (P1, now frozen);
service priced/stamped with `current_season()` instead of the job/invoice season (P1, now season-correct);
child invoices lacked `job_id`/`application_date` (P2); unposted group mislabeled "Posted" (P2); negative
micro-pct residual on `33.334×3` (P2); the live-RPC snapshot test inflated to hide the 2 parked RPCs (P2, now
uses the verified queued-bridge at true 438). The live proof ALSO caught 2 runtime bugs the reviews missed:
`v_job.season` on an unassigned record (55000) and a stale `scheduled_date` (live `jobs` uses `job_date`) —
both fixed. New harness note: seeding synthetic products now needs `ALTER TABLE products DISABLE TRIGGER USER`
inside the rolled-back txn (a parallel supplier-pricing project applied live pricing-governance triggers).
*(Round-3 exit criteria, now overtaken by events: "Remaining before flag-on: a CLEAN full re-run of the Codex
gate, then Mason's review + baseline field-app billing cycle." PR #164 merged 2026-07-21 and the flag was
turned on seven minutes later — see the STATUS block above. **The baseline field-app billing cycle still has
not happened** — checked directly rather than inferred from the empty split tables, since an ordinary cycle
would not touch those: live as of 2026-07-27, `field_app_locations` = 0 rows, `field_app_location_shares` = 0,
and of 4 total `jobs` none is `invoiced` and no `invoices` row carries a `job_id`. So no field-application
invoice of any kind has been produced yet, split or not.)*
Owner-facing detail: `docs/plans/per-line-split-billing-BUILD-HANDOFF-2026-07-18.md`.

**Resolved 2026-07-21 — Supplier Pricing Phase 1a rollout gap.** The governed
Product-page and XLSX pricing paths are live, the final lifecycle migration is
applied at `20260721014858`, and production `process-document` v19 is ACTIVE
with JWT enforcement and rejects supplier price/product lists before OCR.

## 1. Open HIGH findings (dormant on live data)

### Whole-record lost-update class on quote/customer saves (surfaced by the 2026-07-22 Codex push-proof review of the commission UUID-routing work)

`save_quote`/`save_customer` saves resend the entire record, so a stale tab silently overwrites newer values on EVERY field (classic last-write-wins). The **money-bearing half — `quotes.commission_split` / `customers.default_commission_split` — is fixed and LIVE** as of 2026-07-22: clients omit the split when unedited, and migration `20260722190000_commission_split_lost_update_guard` (APPLIED LIVE, server version `20260722202622`) adds a server-verified `*_expected` optimistic-concurrency check plus a stored-split echo in the RPC result (routing triggers enrich splits with `recipient_user_id`, so the client must snapshot the STORED value or the second edit false-conflicts). **Still open:** the same lost-update applies to all other fields (notes, pricing terms, acres, …). A general fix means whole-record version checking with real UX trade-offs — deliberately deferred as a follow-up owner decision, not bundled into the split fix.

**Rollout ordering note (Codex P2, dispositioned 2026-07-22):** the client's no-echo fallback (`nextLoadedSplitSnapshot`, `src/lib/commissionSplitConcurrency.ts`) records the client-sent value as the next baseline when the RPC returns no split echo — which only happens against the PRE-migration function body. If the frontend deployed before the migration AND a tab did a split-edit save in that window AND then stayed open across the apply, the next split edit would fail-closed-conflict falsely (a benign "reload and re-apply" prompt, never an overwrite). **Mitigation: apply the migration BEFORE merging/deploying the frontend** — then production frontend only ever talks to the post-migration RPC (which always echoes), so the fallback never runs in prod. Only revisit (re-fetch-on-missing-echo) if a future change re-emits these RPCs and would ship frontend-first.

### July 14 full-gauntlet remediation — LIVE, frontend rolled out (PR #133 merged 2026-07-15)

The three reviewed migrations were applied live on 2026-07-15 and `process-blend-ticket` is v25 ACTIVE with JWT enforcement. The live schema registry, TypeScript types, and 393-name RPC snapshot were regenerated; the queued-RPC exceptions are gone. The post-apply business chain reached `SMOKE_PASS_ROLLBACK`, and all 17 database invariant sweeps have zero unallowlisted violations. **The frontend rollout landed via PR #133 ("Harden gauntlet money and blend workflows", merged 2026-07-15, commit `c4f7b4c5`) — the release path is complete.** What remains under this heading is owner-side data-cleanup decisions (the bullets below), not code.

- Migration `20260714230100` removed the legacy direct-insert path. Tabs still running the old bundle must refresh before another blend upload; tell office users to use the existing “A new version of the app is ready” prompt (or reload).
- **Owner decision — live-data cleanup:** eight empty unposted `SEED` commission batches ($1,500 headers), PO-2026-0008's stale fully-received status/open lines, PO-2026-0015's legacy receipt gap, one explicit E2E zero-item invoice, and five historical completed deliveries without items.
- Reconcile 18 negative inventory rows only from physical counts. Negative stock is intentional discrepancy evidence, not a value to zero-clamp.

The frontend/live-RPC fixture is regenerated and green; both `create_blend_ticket` and `commit_blend_ticket_ocr_result` are present live. Evidence: `docs/audits/gauntlet/2026-07-14-full-gauntlet-codex-only-remediation.md`.

Reload recovery for an uncertain manual/bulk blend-ticket create stores the exact user-scoped customer/header/product snapshot in per-tab `sessionStorage` for at most two hours. It contains ordinary business data, not credentials or service keys; known success/definite failure and closing the tab clear it. On a shared Windows/browser profile, close the CRX tab after use. This bounded retention is the deliberate tradeoff that prevents a network-uncertain retry from creating duplicate operational work.

**Correction to the working assumption going into this pass:** the 5 HIGH findings usually cited from the overnight bug hunt (commission-resurrection on cancel/void, prepay double-spend, blend-ticket over-reset, cross-customer prepay misapplication, field-app save desync) are **NOT open**. All 5 have applied-live fix migrations, confirmed both in `docs/audits/overnight-bug-hunt/LEDGER.json`'s own `appliedLive_2026_06_21` note and independently against live `schema_migrations` in this session. See §6 for the specific migrations. `docs/reference/gotchas.md`'s "Money-Integrity Invariants" section was re-verified against live function bodies and marked RESOLVED on 2026-07-13.

Genuinely still-open items from that same hunt (checked against `LEDGER.json`, none HIGH):

| Item | Severity | Status | Pointer |
|---|---|---|---|
| `forgeable-actor:transfer_job_to_invoice:unbound-performed_by` — `p_performed_by` not bound to `auth.uid()` on job→invoice transfer | MEDIUM (Codex split HIGH/MED, settled MEDIUM) | **RESOLVED** — strict-actor guard verified in the live function body 2026-07-21 (landed via `20260619140000_transfer_job_invoice_machine_fee_strict_actor.sql`, merged from feat/as-applied-invoices) | LEDGER.json line ~357 |
| `concurrency:save_field_app_invoice:no-row-lock` — group-edit branch read status without `FOR UPDATE` | MEDIUM | **RESOLVED** — `20260714224000_field_app_save_post_lock.sql` wraps `save_field_app_invoice` in `FOR UPDATE` row locks; applied live 2026-07-14, verified in the live function body 2026-07-16 | LEDGER.json line ~498 |
| `prepay:apply_remaining_prepayments:status-not-paid` | MEDIUM | moot while bulk-apply is hard-blocked (see §6) | LEDGER.json line ~566 |
| `commissions:commission_pay_picker:blank-order-customer` | MEDIUM | **RESOLVED** — verified on `origin/main` 2026-07-21: `fetchUnpaid` selects FK ids and resolves order #/job #/farm name via lookups (CommissionPayments.tsx) | LEDGER.json line ~833 |
| ~10 further LOW items (doc-count drift, dead-RPC retire candidates, audit-log completeness gaps) | LOW | parked | LEDGER.json `findings` array |

Two items the ledger flagged as **"top build priority" and Codex-rated HIGH-on-severity** turned out to already be fixed by later sessions — confirmed via migration files on disk: `reverse_blend_ticket_approval:billed-ticket-reopen-and-edit` → `20260622080000_blend_ticket_reopen_and_content_lock.sql`; `void_commission_payment:resurrect-cancelled-order` → `20260622070000_void_commission_payment_dead_order_guard.sql`. Both **confirmed applied live** (present by name in `supabase_migrations.schema_migrations`, checked 2026-07-13).

---

## 1b. RESOLVED 2026-07-22 — commission-recipient close-out: PR #213 MERGED (after PR #216), all migrations live

Branch `claude/nervous-dubinsky-39a725` (worktree `.claude/worktrees/stoic-heyrovsky-ebaaf6`, PR #213 open): **six migrations ALL APPLIED LIVE and individually proven** (ledger rows 812–817; row 817 = `20260722172533_reuse_guard_covers_revivable_quotes`, closing the round-8 terminal-quote finding) plus the CommissionSplitEditor dropdown frontend. Pipeline green. The Codex push-proof gate (rounds 9–10) still refuses the branch on three design-level residuals of NAME-based split identity: (1) invoiced jobs are revivable via `void_invoice` (job returns to completed, reinvoicing re-resolves names) but the reuse guard's jobs branch covers only scheduled/in_progress/completed; (2) recipient ROLE eligibility is dropdown-only, not enforced in the DB validator/creation path; (3) the save-split vs profile-rename concurrency race. The gate is static-diff-only — it explicitly will not accept live-state supersession evidence for gaps in the reviewed diff.

**Decision (Mason, in-chat 2026-07-22): yield to the parallel id-redesign session** (branch `claude/commission-split-recipient-ids`), which already applied live migration `20260722174029` (recipient ids stamped into splits at save; creation helpers consume ids — finding 3 closed in substance) and has role-eligibility in its charter (finding 2). One DB-writing session at a time: this branch stopped writing migrations on discovering the overlap. **To land:** after the id-redesign branch merges (its diff carries the id-binding + role migrations the gate wants), merge/rebase this branch on main, re-run `node scripts/write-codex-push-proof.mjs`, push, merge PR #213. Hand the id-redesign session finding (1) — invoiced-jobs revival — so its guard/redesign covers it. Until merged, rows 812–817's migration files exist only in this worktree (disk-vs-live drift for other checkouts); registry/fixture on this branch intentionally stop at high-water `20260722172533`.

**LANDED 2026-07-22 (same evening):** PR #216 merged first, then PR #213 merged to main (squash 4d686ece, Codex push-proof round 11 CLEAN on the post-merge HEAD, all checks + CodeRabbit green, prod Vercel deploy success). The section below is retained as history; the only open remainder is the follow-up guard-widening chip described in the residual note.

**Update 2026-07-22 (cross-session, id-redesign session):** finding (1) invoiced-jobs revival is **covered by routing** — the `20260722174029` backfill stamped `recipient_user_id` into every job split with no status filter (postflight: 0 id-less elements), and re-invoicing after `void_invoice` routes through `_insert_commissions_for_job` with id-precedence, so a re-acquired name cannot redirect a revived job's commissions while the original profile is active. **One narrow RESIDUAL remains (guard-scope, this branch's function):** if the recipient profile is *deactivated* and the name re-acquired while the job sits `invoiced` (outside `_guard_recipient_name_reuse()`'s jobs branch), then the invoice is voided and re-invoiced, the id-inactive fallback re-resolves the stored name to the new holder. Fix = extend the guard's jobs branch to include `'invoiced'` (mirroring the `20260722172533` revivable-quotes pattern). Requires deactivation + name reacquisition + void + re-invoice in sequence — accepted as a follow-up migration (task chip spawned 2026-07-22), not a #213 blocker.

## 2. Parked migrations (written, not applied)

| File | Purpose | Why parked | What unblocks it |
|---|---|---|---|
| ~~`supabase/migrations/20260726201208_void_vendor_payment_vendor_liveness.sql`~~ (submitted `20260726210000_...`, B7-renamed to the live version) | **APPLIED LIVE 2026-07-26** (server version `20260726201208`) — no longer parked. Section 9 follow-up MEDIUM-1: `void_vendor_payment` now locks the vendor row (`deleted_at IS NULL … FOR UPDATE`) so it serializes with `delete_vendor`; a void against a soft-deleted vendor raises `VENDOR_DELETED`. Gate passed (both charters CLEAN) + Mason's in-chat approval; post-apply live body md5 matches disk exactly. | — | Done. Residual RESOLVED 2026-07-26: Mason approved the Deactivate/Reactivate reframe — `reactivate_vendor` RPC **APPLIED LIVE** (gate CLEAN, submitted `20260726213000`, server version `20260726212043`) + Vendors-page Show Inactive view and Reactivate button, giving `VENDOR_DELETED` a one-click remedy; the PR #236 review then caught (and 2026-07-26 same-day fix `20260726215154_vendors_inactive_admin_select` resolved, gate CLEAN + applied live) an RLS gap that hid inactive vendors from the new view. |
| ~~`supabase/migrations/20260722202622_commission_split_lost_update_guard.sql`~~ (submitted `20260722190000_...`, B7-renamed to the live version) | **APPLIED LIVE 2026-07-22** (server version `20260722202622`) — no longer parked. `save_quote`/`save_customer` reject a split overwrite when the client's `*_expected` snapshot no longer matches the stored value, echo the stored (trigger-enriched) split back, and canonicalize `save_quote`'s actor exception to `ACTOR_MISMATCH`. Proven live on both RPCs (conflict/rejection/matching-expected/omitted-key/actor-mismatch). | — | Done. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-03-cancel-delivery-scheduled-quick-prebook-leak.md` | Release prebooked inventory when a scheduled quick-delivery is cancelled | — | **RESOLVED, applied live 2026-06-16** (`20260616151122_cancel_delivery_release_prebook_on_quick_cancel`). File header already says so — stale-looking filename, not a stale fix. |
| `docs/audits/nightly-debug/parked-migrations/PARKED-07-seed-admin-security-OWNER-ACTION.md` | Flagged `seed-admin` edge function as an unauthenticated admin-mint endpoint | — | **RESOLVED** — `seed-admin` no longer exists in `supabase/functions/` (confirmed on disk this pass; `docs/reference/gotchas.md` line ~118 notes it was deleted 2026-06-16 as a security cleanup). |
| `scripts/.staging-migrations/SUPERSEDED-20260611080937_idempotency_lookup_operation_scope_sweep.sql` | Idempotency lookup operation-scoping sweep | Filename says SUPERSEDED | Nothing — already replaced, safe to ignore/delete |
| `scripts/.staging-migrations/workflow-fix-parked/u12/*`, `.../u13/*` | Draft patches for Applicator "My Day" (U12) and dispatch-assignment unification (U13) | **Verified superseded and removed locally in this ticket.** `docs/loops/business-workflow-fix-ledger.md` confirms both U12 and U13 **SHIPPED LIVE 2026-07-06/07** under different migration names (`20260707010000`/`20260707011000` for U12, `20260707020000` for U13) — not the deleted draft filenames (`20260706060000`, `20260706100000`). | Do not re-apply the removed drafts. |
| `scripts/.staging-migrations/workflow-waves-parked/PARKED-dispatch-backfill.sql` | One-time backfill of `job_location_dispatches` for legacy-assigned open jobs | Business-data write, needs Mason's OK; also a **no-op today** (0 jobs match, verified live 2026-07-10) | Mason's explicit go-ahead; re-run the embedded count query first since it's a live-data-dependent no-op |
| `scripts/.staging-migrations/20260717121000_supplier_pricing_phase1a_cutover.sql` | Historical pre-promotion source for the supplier-pricing enforcement cutover | **RESOLVED, applied live 2026-07-18** as `supabase/migrations/20260718190000_supplier_pricing_phase1a_cutover.sql` after the governed RPC frontend was proven | Do not apply the staging artifact; Product-page and worksheet edits remain live through the governed preview/apply RPCs |
| `docs/roadmap/shelved-earmark-engine/*.sql` (3 files: `20260613240000`, `20260613250000`, `20260613280000`) | Booking-prepay "earmark" engine (reserve prepay credits for a specific future booking) | **SHELVED for a full redesign** (Mason's call, 2026-06-14) — the earmark engine assumes a single ledger-based spend path, but the legacy aggregate-spend path (`apply_remaining_prepayments`) bypasses it, causing double-spend + fund-diversion defects (Codex rounds 5-6). See README.md in that folder for the reserved-pool redesign sketch. | **DO NOT APPLY without a fresh architectural pass** — reserved-vs-spendable balance model, not a patch. |
| Per `.claude/commands/parked.md`: also check `node scripts/fleet-status.mjs` output and any `*draft*.sql` under `docs/audits/` for parked drafts in other worktrees | — | — | Not re-run in this pass (read-only doc consolidation, single worktree) — a future agent asked "what's parked" should run it fresh |

---

## 3. Pending owner decisions

From `docs/loops/owner-decisions-2026-07.md` (6 packets, live counts pulled 2026-07-02). **2026-07-16 in-chat outcomes:** packet 3 (junk deletes) — Mason keeps test entities for E2E/Playwright use, un-commingled: the two untagged test customers were renamed with the `[E2E]` prefix (live UPDATE, verified); true-junk deletes (8 gibberish `RTJ Recipe…` blend recipes, zero-link customer rows, vendor `we`, bad emails) remain PENDING explicit line-item approval. Packet 4 (due dates) — **DECIDED: Net 30 default + Net 15 / due-on-receipt / custom-date override**; approved build spec: `docs/plans/invoice-due-dates-net30-spec-2026-07-16.md`. Packet 5 / finding #40 wire-vs-retire — **SETTLED: KEEP** (planned features; do not retire the orphaned RPC, CropPrograms pages, or per-acre tier columns). Packet 6 ("wire" payment method) — **RESOLVED, was stale**: migration `20260702152000_payment_method_wire.sql` is applied live; all four payment_method CHECK constraints already allow `'wire'` (verified live 2026-07-16). Remaining genuinely-open packets: 1 (vendor-name merges) and 2 (category remap).

1. **Vendor/manufacturer name merges** (e.g. "Van Diest" vs "Van Deist") — re-buckets AP spend/rebate history; needs Mason's call on which spelling is canonical.
2. **Category remap** of the 19 live `products.category` values into functional-class + use-timing — re-buckets historical sales reports on rename.
3. **Junk-data deletes** (8 fake blend recipes, 3 "Test Mfg" products, 3 "Test Vendor" products, 1 junk PO vendor, ~5 invalid customer emails) — recommendation is delete-all; needs Mason's approval since it's real-row deletion.
4. **Due-date/aging policy** — chemical-sale invoices get no `due_date` today, so the whole late-AR machine (overdue cron, finance charges, cockpit tile) protects nothing. Unblocks parked migration "A8". Recommendation: Net 30 default, age from `due_date`.
5. **Wire vs. retire** calls on 5 dead/half-wired structures (`ingredient_map` page, CropPrograms/ProgramTracker, per-acre tier price columns, several dead tables incl. a booby-trap legacy `payments` table, and the orphaned `get_customer_delivery_remainders` RPC).
6. **Confirm "wire" as an allowed payment method** — two UIs offer it but no live table's CHECK constraint allows it.

Plus, from the 121-finding business-workflow review (`docs/audits/business-workflow-review-2026-07/`):
- **#40** — `get_customer_delivery_remainders` RPC is orphaned (defined, secured, zero callers). Decision: retire or wire into a per-customer remainders card; see Packet 5 in `docs/loops/owner-decisions-2026-07.md`. No retirement migration is authorized by this cleanup.
- **#107** — Auto-draft-invoice-on-job-completion silently does nothing when an *applicator* (the normal completer) finishes a job — only admin/sales-rep completions trigger it, and unlike a failed draft it logs nothing. Must be decided **before** the (currently off) auto-draft switch is ever flipped on.
- Related open item from the same review (not owner-decision-gated, just unbuilt): **#117** (`auto_draft_skipped` activity-feed row) — **BUILT 2026-07-21** as migration `20260722012359_auto_draft_skipped_activity_row.sql` (submitted 20260721230000; B7-renamed) (complete_job now logs both silent skip cases: non-office completer — the #107 gap — and already-invoiced job); **APPLIED LIVE 2026-07-21**, ledger version `20260722012359`. The #107 POLICY decision itself remains open and unchanged. **Correction 2026-07-16:** #106 and #109, previously listed here as open, actually SHIPPED LIVE 2026-07-06 via `20260707050000_application_record_integrity` (live v20260706175157) — see `docs/loops/business-workflow-fix-ledger.md` Night-2 entry (N2-7) and `docs/reference/migration-history.md` row #639; moved to §6.

~~Migration-apply approval policy is written two ways~~ — **SETTLED by Mason 2026-07-13** as option (b) with a destructive carve-out: armed autopilot + the apply-guard proof gate suffices in a pre-authorized hands-free run; interactive sessions still ask in chat; data-deleting/dropping migrations are never autonomous. Canonical text: `docs/manual/DECISION_LOG.md` (2026-07-13 entry).

Also open: **Sprint D leftovers** (`docs/loops/workflow-waves-ledger.md`) — D1/D2 shipped live 2026-07-10, but D3 is parked in two owner-decision halves: (a) blend-ticket-path commission minting, deliberately dormant until blend billing is actually used; (b) `jobs.commission_split` visibility to assigned applicators — Mason needs to decide between an admin-only side table or RPC-gating.

---

## 4. Deferred/parked feature work

- ~~**Per-line-item custom split billing (field-app)**~~ — **no longer deferred. SHIPPED 2026-07-21 (PR #164)
  and live with the flag ON; see §0 for the current status and the one remaining gap (it has never been
  used).**
- **EPA label backfill** — ~105 of 204 distinct stored EPA registration numbers point at the wrong product (confirmed, `docs/CHANGELOG.md` 2026-07-10 entry). The in-app `/label-data-quality` tool to fix them shipped 2026-07-10; the actual backfill (doing the data-entry) is still pending — it's a data-entry job, not a code task.
- **OCR REI/PHI auto-fill** — deliberately deferred as a safety trap (label OCR for re-entry-interval/pre-harvest-interval data needs human verification before it can be trusted for compliance).
- **Grower portal §7-§10** — deferred, internal-only direction for now. `docs/ROADMAP.md` line ~57 (A2, "Grower portal v1") and line ~112 (G9, portal MVP) both still say TODO/VISION.
- **Sprint D** — see §3 above (largely resolved; only the 2 D3 owner-decision halves remain).
- **U12/U13 "drafts parked outside repo"** — per session memory this phrase referred to scratchpad copies; the actual repo-tracked drafts in `scripts/.staging-migrations/workflow-fix-parked/` were verified as stale leftovers from an already-shipped feature and removed locally in this ticket (see §2). No live U12/U13 work remains open.
- **Credit-memo "Feature B" / residual-ledger design blocker** — **correction:** this is not part of the credit-memo-apply project (that one shipped, see §6). The residual-ledger design blocker belongs to the **billing-day-money-loop's Feature B** (per-delivery split invoicing for partially-delivered field/acre-allocated orders) — parked at a Codex design-review BLOCKER because naive per-delivery mirroring loses money via independent rounding. Handoff doc: `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`. Until redesigned, partial allocated deliveries keep today's flag-and-manual-split behavior.
- **Sprint E dispatch backfill** — see §2 (parked, currently a no-op).
- **Blend-ticket commission mint** and **`jobs.commission_split` RLS visibility** — see §3, Sprint D D3.

---

## 4b. Guard-system hardening backlog (from the 2026-07-13 retirement audit; recommendations, not built)

The 2026-07-13 audit implemented the cheap hard-guard fixes (see CHANGELOG). These remaining items were adjudicated PARK — each needs either allowlist design or accepted-residual sign-off, not just code:

- **Supplier Pricing Phase 3C PR containment remains PARKED.** The trusted `pull_request_target` workflow is a future-PR guard and cannot retroactively protect PR #246 because its base predates the workflow. After the introducing PR merges, its exact check must be enforced by `protect-main` or equivalent immutable required-workflow control, followed by live proof. Until then, local pre-commit/pre-push hooks are the active guard against accidental private-packet commits, while candidate-controlled PR CI remains advisory. Its unauthenticated `refs/pull/<n>/head` fetch depends on this repository remaining public; private-repository use requires read-only authentication.
- **Proof-file self-attestation** — the migration-apply and Codex-push proof JSONs can be written by the same agent that should be gated by them; nothing binds the proof to an actual reviewer run. Partial raise-the-bar option: have the reviewer subagents write the proof themselves. Full closure impractical (accepted residual for a malicious agent; the fix targets honest confusion). The 2026-07-13 hands-free additions (content-bound `codex-review-mig-<name>.json` Codex proof, exact `queryHash` binding on both proofs, required `reviewers` array naming both reviewer subagents, and timestamp freshness bounded to [0, 30 min] so future-dated stamps fail) raise the honest-mistake bar further but remain self-attestable by a deliberately dishonest agent — same accepted residual. Likewise the destructive-SQL classifier is a lexical scanner, not a SQL parser: it is quote-aware and default-keep (five adversarial Codex rounds closed the comment/literal/dollar-quote hiding tricks), but a genuinely novel obfuscation could still slip it — the classifier's job is stopping honest mistakes, and its false positives merely park a migration for the morning.
- **New live-sweep predicates worth writing** (scripts/db-invariant-sweeps/): a `concurrency-hotspot` predicate asserting the named race-prone functions (inventory reservations, prebook, number sequences, balances) contain `FOR UPDATE`/advisory locks; an `audit-log-completeness` predicate asserting each allowlisted money-mutator RPC writes `financial_audit_log`; more `fin-*` arithmetic identities per derived-value family (order/quote `total_profit`, `net_margin_pct`, per-line commissions).
- **Write-time forgeable-actor hook** — a regex hook flagging new SECDEF functions with `p_performed_by`-style params lacking `ACTOR_MISMATCH` binding (today caught only post-write by live sweeps/reviewers).
- **Edge Functions are exempt from the assert/check ESLint rules** (Deno) and the coverage ratchet's scope leaves ~130 legacy Supabase reads unchecked — known accepted gaps.
- **Invoice-type leaks and direct-URL edit-lock bypasses** (lifecycle class) have no static guard — stays reviewer-checklist territory (`compliance-reviewer`).
- **Shell string-reconstruction bypasses** of the Bash regex guards (quote-splitting, variable substitution) — accepted residual under the honest-mistake threat model; keep widening regexes as concrete shapes appear.
- **worktree-awareness is a session-start snapshot** — no mid-session warning when a sibling merges or applies; accepted perf tradeoff, re-run `git worktree list`/`/fleet` before done-claims.
- **stop-verify PROOF matching is text-based**, not tool-call provenance — a fabricated PROOF line passes; hardening would require binding to transcript tool_use records.
- **npm `--prefix`/`--workspace` forms escape the script-body guard** (Codex round-5 P2, 2026-07-13) — `npm --prefix client run x` yields no script name to the bash-safety-lib extractor, so the resolved-body check silently skips. Correct handling needs value-taking-option parsing AND resolving the *other* package.json the option points at. Accepted residual: CRX is a single-package repo (these forms never occur here), and the guard's threat model is honest mistakes; revisit if the repo ever becomes a workspace/monorepo.
- **Commission name-reuse guard retirement is PARKED (2026-07-22)** — the durable UUID-routing migration (`20260722170000_commission_split_recipient_ids.sql`) deliberately KEEPS `trg_guard_recipient_name_reuse`. Codex push-proof BLOCKER: while any deployed bundle can still send a name-only split (all pre-change bundles; new bundles via the CommissionSplitEditor RPC-failure fallback list), a re-acquired name would be stamped with the NEW holder's UUID at write time — the guard is what makes name-only writes unambiguous. Retirement unblocks when name-only split writes are impossible: id-carrying frontend fully propagated (PWA needs two reloads) AND the DB rejects id-less elements (small follow-up migration flipping the stamp/validator to require `recipient_user_id`, plus removing/id-ing the editor fallback list). Until then the guard's name-reservation friction on profile renames is accepted, as is the related fail-closed friction Codex round 2/3 examined: after an admin renames a profile, commission ROUTING for stored splits is unaffected (the active id wins at creation time), but a SAVE that resends a split still carrying the old display name is REFUSED until the operator re-picks the person — the resend is a name-vs-id mismatch whose name no longer resolves, indistinguishable at write time from a failed reassignment (a silent id-fallback was tried and reverted — Codex round 3 showed it could misroute a genuinely failed reassignment; deactivating a referenced profile fail-closes both paths as intended).
- **Gauntlet V2 Phase 2 remains intentionally open** — Phase 1 makes missing evidence loud but does not manufacture unavailable evidence. The page-render gate still has 44 reasoned, count-ratcheted skips; five E2E files still contain direct production endpoint literals (Playwright now blocks before setup) and additional auth-token storage keys are production-project-specific; staging Supabase/secrets do not exist yet, so E2E stays `if: false`; `db-sweeps:strict` still needs an authenticated execution path in CI; the live-schema suite remains trusted-run-only via `npm run test:schema-live` because ordinary GitHub Actions has no least-privilege credential (the production service-role key must not be added merely to make CI green); Sentry's 30-day collector remains `BLOCKED` by Unauthorized. None of these may be reported as clean until executed evidence exists.

---

## 5. Known technical debt / accepted quirks

- **Offline work recovery database foundation and browser rollout are live; phone/device E2E remains pending** — all four receipt migrations, including the corrective target-row lock, were applied and verified on 2026-07-14, and PR #124's browser rollout landed on `main` before the 2026-07-15 offline verification pass. Browser retention until proven success, distinct cap/backlog handling, a safe device review panel, audited office `already_completed` / `abandoned` resolution, and cross-tab replay protection are now in code. A saved action that lacks an original queue-time target snapshot is intentionally sent to office review rather than deriving a new baseline after reconnect; therefore snapshot conflict coverage is complete only for actions that captured the snapshot when queued. Still deferred: signature/photo persistence, idempotent email/notification replay, operation-specific conflict preconditions, automatic device discovery of an office resolution, and a general duplicate-action policy. Browser storage remains device-local until the phone reconnects and stages its permanent server receipt, so destroying or clearing that storage before reconnection can still lose work. Source: `docs/audits/2026-07-15-offline-stage1b-rollout-verification.md`, `docs/audits/2026-07-14-offline-receipt-browser-office-resolution-proof.md`, and `docs/roadmap/offline-work-stage1b-receipt-design-2026-07-13.md`.
- **Live `schema_migrations` having more entries than files on disk is OLD, pre-existing drift** — do not treat it as a new problem. Only reconcile migrations newer than the point where the current branch diverged from `origin/main`. (Session memory: `project_migration-disk-vs-live-drift`.)
- **Page-render tests pass in isolation but flake in the full `vitest` suite** — fix with `waitFor`/`findAllBy`, not synchronous `getBy`. See `docs/reference/gotchas.md` and session memory `project_page-test-fullsuite-flake`.
- **PWA (installed app) needs two reloads after a production deploy** to pick up a new service-worker chunk — expected behavior, not a bug to chase.
- **Prepay bulk-apply (`apply_remaining_prepayments` / `batch_apply_all_prepayments`) is hard-disabled in production** (`RAISE 'PREPAY_BULK_APPLY_DISABLED'`, migration `20260620200000`) rather than properly fixed — the real fix needs the shelved reserved-pool redesign (§2/§4). Per-invoice `apply_prepay_to_invoice` is unaffected.
- **`commission_payments.total_amount` is a legacy numeric-dollar column** — current posting compares the header and item totals directly in the same numeric-dollar unit; only `financial_audit_log.total_impact_cents` converts the posted total to cents. Converting historical payment headers/items safely is a dedicated money-schema migration, not part of the gauntlet cutover; do not casually retype it while re-emitting posting guards.
- **Renaming or deactivating a profile still referenced by an unfinished quote/job commission split now fails closed at the next validator touch** (quote edit/conversion, job invoicing) with `COMMISSION_SPLIT_INVALID: recipient … does not match exactly one active user` — since migration `20260722134252` (gauntlet §7). This is deliberate (Mason chose reject-at-creation over silent unpayable commissions, 2026-07-22): the fix is to update the affected split to a current active user (or restore the profile), not to weaken the validator. Codex proposed an automatic profile→split reconciliation build; declined as scope creep for a zero-affected-rows preventive guard. Since migrations `20260722144121`/`20260722150432` (same day): profile names are admin-only to change, two active users cannot share a name, and NO profile — admin actions included — may acquire a name still referenced by a split with future money (`COMMISSION_RECIPIENT_NAME_RESERVED`); update the splits first. Durable follow-up (parked task): store profile ids inside splits instead of names, which retires this whole name-identity guard family.
- See `docs/reference/gotchas.md` for the full list of non-obvious schema/RPC quirks (idempotency column names, generated columns, tables without `updated_at`, etc.) — this file does not duplicate that content.

---

## 6. Recently resolved (last ~30 days)

- **2026-07-22** — Gauntlet §7 HIGH (CommissionSplitEditor "Other" free-text recipient → commissions with NULL `recipient_user_id` that no payout batch can ever select) closed with the reject-at-creation option Mason chose. Live migration `20260722134252_reject_unresolvable_commission_recipients` (submitted `20260722124500`): validator now requires every split recipient to resolve to exactly one active profile (SECDEF boolean helper works under admin-or-self profiles RLS), a `BEFORE INSERT OR UPDATE OF recipient_user_id` backstop trigger on `commissions` refuses NULL-recipient rows on every code path, and the new `list_commission_recipients()` RPC feeds the editor dropdown (commission-eligible roles; picked up Clayton Wells, whom the old hardcoded list omitted). Free-text "Other" removed from the UI. Zero live rows were affected; the single legacy NULL row (cancelled, $0, 2026-03-16) is grandfathered. See §5 for the accepted rename/deactivate fail-closed trade-off. Ranked-queue row 14 in `docs/audits/gauntlet/live-foundation-gauntlet-summary.md` is closed by this.
- **2026-07-17** — Money/inventory gauntlet sections 8-15 database remediation is live through `replay_bulk_po_same_request_result` (ledger `20260717032437`). PO numbering is atomic with insertion; active sales reps retain PO create/import/edit authority; vendor bills compare the authoritative line-rounded PO header; an admin-deleted imported PO clears its claim plus cached save results so the unchanged document can be imported again; and a same-key lost-response retry now replays the original `saved` result before different-request document deduplication. Both trusted migration reviewers returned CLEAN; stacked pre/post-apply rollback chains reached `SMOKE_PASS_ROLLBACK`; permanent checks found zero claims, stale save replays, fractional source costs, and PO header mismatches, with public/internal grants correct.
- **2026-07-15** — The 2026-07-14 workflow-review HIGH (deactivated admins retained commission-payout policy access) is closed: all 3 fix migrations applied live — names `20260714185129_fix_commission_admin_policies` / `20260714185130_gate_batch_prepay_admin` / `20260714185631_harden_is_admin_search_path`, re-stamped live versions `20260715134551` / `20260715134618` / `20260715134629`. Verified in live `schema_migrations` 2026-07-16 (match on name, not version — the standard drift gotcha). `migration-history.md` rows 690–692 corrected the same day.
- **2026-07-15/17** — Schema registry and generated TypeScript database types were regenerated from live introspection through high-water `20260717045420` (`bind_bulk_po_claim_to_vendor`). Roadmap tickets T1/N2 remain done.
- **2026-07-06** — Business-workflow findings **#106 + #109** (application-record date/license snapshots; invoice-side season stamping) shipped live via `20260707050000_application_record_integrity` (live v20260706175157). Recorded here 2026-07-16 after this file wrongly carried them as open.
- **2026-07-13** — Automated weekly in-database backup live (`20260713050000_weekly_db_backup.sql`, pg_cron) — snapshots all tables to `backup_snapshots` + a run log.
- **2026-07-12** — Money+Inventory night-hunt batch A-D applied live: `void_invoice` is_active + period guards (`20260712160000`), unbilled-delivery guard now ignores soft-deleted invoices (`20260712170000` + dashboard companion `20260712180000`), `create_order_from_blend_ticket` row-lock race fix (`20260712190000`), `void_payment` overpayment-credit full unwind (`20260712220000`).
- **2026-07-12** — Edge Functions CORS outage (all 7 functions unreachable) fixed and deployed (`66b91855`, later centralized in `1170c2dc`).
- **2026-07-11/12** — Credit-memo apply shipped (5 migrations + frontend, `20260711020000`-`20260711060000`).
- **2026-07-10/11** — ChemMan-parity loop: 10+ build units incl. CSB click-to-adopt USDA field boundaries, print-options dialog, map-based location picker, loader worksheets, field obstacles — all shipped live.
- **2026-07-10** — Business-workflow review finding **#105** (spray-job credit-exposure blind spot) fixed and applied live (`20260712130000` + frontend).
- **2026-07-10** — Label Data Quality screen (`/label-data-quality`) shipped — in-app EPA registration-number check + inline fix.
- **2026-06-21/22** — Overnight bug-hunt Run 1 + Run 2: all 5 originally-HIGH money-correctness findings (commission resurrection, prepay double-spend, blend over-reset, cross-customer prepay misapplication, field-app type-flip) fixed and applied live — see §1 correction above for citations.

---

## Sources this file consolidates (read these for detail, don't recreate their content here)

- `docs/audits/overnight-bug-hunt/LEDGER.json` — full finding-by-finding history
- `docs/reference/gotchas.md` — quirks and invariants (Money-Integrity table marked RESOLVED 2026-07-13)
- `docs/loops/owner-decisions-2026-07.md`, `docs/loops/workflow-waves-ledger.md`, `docs/loops/business-workflow-fix-ledger.md`
- `docs/audits/business-workflow-review-2026-07/findings.json` + `report.md`
- `docs/roadmap/shelved-earmark-engine/README.md`
- `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`
- `docs/CHANGELOG.md`
- `.claude/commands/parked.md`
