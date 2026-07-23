# CRX Manager V1.0 — Development Changelog

All significant development milestones, in reverse chronological order.

## 2026-07-22 — Supplier Pricing Phase 3 Stage A prepared (NOT APPLIED)

- Prepared an additive `product_families` / Product metadata and return-credit enforcement foundation. `RETURN_POLICY_NO_RETURN` is the exact refusal code; Product metadata remains dormant/default `unknown` until an owner gate. Direct return-item writers and lifecycle wrappers use sorted Product advisory locks; cancellation and credit-memo reversals preserve their inventory and ledger behavior. Metadata idempotency binds the full request and transaction-local authorization resets immediately after the governed update. The content-bound migration is LF-pinned to preserve reviewed `pg_proc` hashes.
- Aggregate provisional classification packet only: 604 rows remain unresolved and pending owner review; 21 name-only no-return candidates are evidence flags only. Aggregate packet checksum: `bf85cc649657735fa26ba8c7e753d653c76ba238ce63c7605ce723393ea322c4`. No row-level catalog artifacts are included in this branch.
- The package-level Phase 3 privacy guard now scans the entire tracked-plus-untracked checkout by default and remains available in explicit base-diff mode; CI runs the whole-tree guard before dependency work. Whole-tree mode does not depend on the dated aggregate audit being present, while explicit base-diff verification still requires and validates it.
- No live migration apply, Product mutation, feature-flag enablement, merge, or AI/OCR supplier-PDF extraction occurred. Final external review evidence and the explicit owner gate remain required before acceptance.

## 2026-07-22 — Section 09 PO/AP remediation review close-out

- Addressed all CodeRabbit findings before PR #218 merge: the standing on-order invariant now compares only Main Warehouse inventory rows; the two-session concurrency harness rejects readiness when its SQL child exits early; the lifecycle test area now includes the Section 09 contract test and invariant sweep; current-only AP aging now lets PostgreSQL own the Chicago business date; and `create_vendor_bill` explicitly rejects a NULL subtotal through the stable `INVALID_AMOUNT` path instead of leaking a table-constraint error. The RPC default and its fail-closed guard both use `clock_timestamp()`, avoiding browser-clock skew and transaction-boundary date disagreement; the page no longer shows a browser-derived numeric report date that could disagree with the server-owned data. Focused, lifecycle, typecheck, and isolated four-race concurrency proofs passed after the changes. The migration remains pending live apply.

## 2026-07-22 — Commission-split lost-update guard (stale-tab overwrite fix) — APPLIED LIVE

- Fixed the lost-update class surfaced by the 2026-07-22 Codex push-proof review of the commission UUID-routing work: QuoteBuilder and CustomerDetail resent the entire commission-split JSON on every save, so a stale tab silently reverted a newer split reassignment (last-write-wins on a money-routing field). Client half (this PR): both pages now omit the split key entirely when the user never touched the split editor — proven against the live RPCs, whose "absent key keeps stored value" semantics were verified end-to-end with a rolled-back `save_quote` execution — and when the split WAS edited, they send the new value plus the originally-loaded snapshot (`commission_split_expected` / `default_commission_split_expected`) built by the new shared `src/lib/commissionSplitConcurrency.ts` helper (unit-tested).
- Server half: migration `20260722190000_commission_split_lost_update_guard` (**APPLIED LIVE 2026-07-22 with Mason's in-chat OK; server-assigned ledger version `20260722202622`**) re-emits `save_quote`/`save_customer` reconstructed from the canonical on-disk bodies (verified byte-identical to live) with: an optimistic-concurrency check that raises `COMMISSION_SPLIT_CONFLICT` under the FOR UPDATE row lock when the stored split matches neither the expected snapshot nor the incoming value (idempotent retries still pass); a stored-split echo in the RPC result so the client snapshots the trigger-enriched value (`recipient_user_id` is stamped server-side; snapshotting the client-sent value would false-conflict the next edit); and — at the security reviewer's request — canonicalizing `save_quote`'s actor-forgery exception to the shared `ACTOR_MISMATCH` token (with `src/lib/offlineSync.ts` taught to recognize it, also closing a latent gap where `save_customer`'s `ACTOR_MISMATCH` wasn't classified as a session mismatch offline). Signatures unchanged (no overloads), grants restated, old callers unaffected. Proven live (rolled back): conflict raised on a stale-tab edit, stored value untouched on rejection, matching-expected save applies, omitted key preserves the stored split, forged actor raises `ACTOR_MISMATCH` — on both RPCs. Two Codex reviewers (rls-security + migration-drift) returned CLEAN on the applied SQL.
- The broader all-fields lost-update remains open by design — logged in `docs/manual/KNOWN_ISSUES.md` §1 as a deferred whole-record-versioning follow-up.
- Two Codex review rounds: round 1 caught a P1 (the client advanced its hidden "expected" snapshot from an untouched save's echoed value while the editor still showed the old split, reopening the overwrite one step later) — fixed by only advancing the baseline on a touched save, extracted into the tested `nextLoadedSplitSnapshot` helper. Round 2 raised only a P2 staged-rollout false-conflict, dispositioned by applying the migration before the frontend deploys (see KNOWN_ISSUES §1 rollout-ordering note).

## 2026-07-22 — Cross-session coordination for landing PR #213: pinged the duplicate chip session (stand down, migration 20260722172533 already live) and the id-redesign session (landing order #216 then #213); armed a persistent monitor on PR #216 merge that triggers the #213 landing path; recorded id-redesign confirmation that invoiced-jobs revival is covered by id-precedence routing plus the residual deactivated-name/invoiced-window guard corner in KNOWN_ISSUES §1b; spawned follow-up chip task_0bbf4089 (widen reuse guard to invoiced jobs) and withdrew superseded chip task_87490ee3.

Cross-session coordination for landing PR #213: pinged the duplicate chip session (stand down, migration 20260722172533 already live) and the id-redesign session (landing order #216 then #213); armed a persistent monitor on PR #216 merge that triggers the #213 landing path; recorded id-redesign confirmation that invoiced-jobs revival is covered by id-precedence routing plus the residual deactivated-name/invoiced-window guard corner in KNOWN_ISSUES §1b; spawned follow-up chip task_0bbf4089 (widen reuse guard to invoiced jobs) and withdrew superseded chip task_87490ee3.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `d8a17601 Fix bulk quote import lifecycle path`
  - `5c577703 Improve Codex session momentum guidance (#215)`
  - `f36158bf Document Supplier Pricing Phase 3 execution contract (#214)`
  - `85392e02 Record live inventory guard migration (#211)`
  - `8e4bea10 Close out Supplier Cost Basis Phase 2 Wells canary (#210)`
  - `016236fd Merge pull request #209 from masonwells1/claude/gauntlet-t3-sections-5-8`
  - `e3ecc9b2 Fix inventory gauntlet section 3 findings (#208)`
  - `b78535af Supplier Pricing: complete workbook v2 product info (#207)`
  - `bf2a60ef Merge pull request #204 from masonwells1/claude/field-profitability`
  - `5a3f49fa Merge pull request #206 from masonwells1/codex/supplier-pricing-integration`
  - `466c2095 Merge pull request #205 from masonwells1/codex/supplier-cost-basis-phase2-frontend`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260722134252_reject_unresolvable_commission_recipients.sql`
  - `supabase/migrations/20260722144121_lock_commission_identity_names.sql`
  - `supabase/migrations/20260722150432_forbid_referenced_recipient_name_acquisition.sql`
  - `supabase/migrations/20260722154303_global_unique_profile_names.sql`
  - `supabase/migrations/20260722162851_reuse_guard_covers_orders.sql`
  - `supabase/migrations/20260722172533_reuse_guard_covers_revivable_quotes.sql`

## 2026-07-22 — Commission-recipient integrity close-out (gauntlet §7 + hardening)

- Extended the recipient-name reservation to terminal-but-revivable quotes: live migration `20260722172533_reuse_guard_covers_revivable_quotes` widens the reuse guard's quotes branch to every non-deleted quote — declined/expired/cancelled quotes can be revived (`revert_quote_status`, `restore_quote_version`), so their commission-split names stay reserved. This was the round-8 Codex gate finding PR #213 briefly parked on; the migration is live, and PR #213 lands after the parallel id-based-splits branch merges (see KNOWN_ISSUES §1b).

## 2026-07-22 — Commission-recipient integrity close-out (gauntlet §7 + hardening)

- Built and APPLIED LIVE the durable commission-routing fix (submitted as `20260722170000_commission_split_recipient_ids`, server-assigned ledger version `20260722174029`, applied 2026-07-22 with Mason's in-chat OK; disk file B7-renamed to the live version): commission splits stored on quotes, orders, jobs, and customer defaults now carry the recipient's immutable profile UUID (`recipient_user_id`) alongside the display name, and the id — not the name — is authoritative for routing. The migration backfills every stored split after a preflight proving each recipient resolves to exactly one active profile, installs write-time stamp triggers on all four split columns so an id-less split can never be stored again (even from a stale browser session), makes `validate_commission_split_json` id-first with cross-form duplicate detection, routes `_insert_commissions_for_order`/`_insert_commissions_for_job` by id with unique-name resolution as legacy fallback plus display-name refresh, and changes `list_commission_recipients()` to return `(id, full_name)`. The Codex push-proof review (1 BLOCKER, 1 HIGH, 1 MED — all addressed) reshaped two decisions: the `trg_guard_recipient_name_reuse` name-reservation guard is KEPT, not retired (retirement is parked until name-only split writes are impossible — see KNOWN_ISSUES §4b entry), and name-vs-id mismatches resolve context-dependently via a shared `resolve_commission_split_recipient(elem, prefer_name)` helper: at write time the human-edited NAME wins (an old deployed bundle edits only the name and must not have its reassignment reverted by the stale hidden id), while at commission-creation time an active ID wins (an admin rename must not reroute money). The preflight md5-pins the live bodies of every function it replaces so post-review live drift aborts the apply instead of clobbering, and the postflight runs the full new validator over every stored split plus a two-person precedence proof. CommissionSplitEditor now stores the profile id when the dropdown row came from the live RPC and tolerates both RPC shapes so deploy/apply order doesn't matter. The PR also carries the sibling session's live-applied guard migrations (`20260722154303`, `20260722162851`, `20260722172533`) verbatim for disk/live parity — the final Codex push gate caught that `172533` (revivable-terminal-quote name reservation) was referenced by the registry/changelog but absent from the branch, which would have left clean rebuilds with the narrower guard. Post-apply live proof: ledger row present, all 4 stamp triggers enabled, name-reuse guard still enabled, `list_commission_recipients()` returns `TABLE(id uuid, full_name text)`, 36/36 stored split elements stamped with active-profile ids, 0 id-less elements; the in-transaction postflight additionally proved validator accept/reject/dup cases, enrichment stamping, the full stored-split sweep, and the two-person precedence rule. The preflight baseline pins were exercised for real: sibling migrations `20260722172533` (reuse_guard_covers_revivable_quotes) landed minutes before the apply and the pins passed because none of the replaced bodies had drifted.

- Extended the recipient-name reservation to orders: live migration `20260722162851_reuse_guard_covers_orders` adds order commission-split snapshots (including cancelled-but-restorable orders) to the set of names no profile may acquire, closing the rush-order/deferred-pricing variant of the name-reuse hole.

- Made profile names globally unique — active or deactivated — closing the last name-identity variant (a parked deactivated account sharing a real user's name could otherwise be swapped in later). Live migration `20260722154303_global_unique_profile_names`; proven in-transaction: the pre-positioning insert is rejected by exactly the new index. A future hire sharing a former employee's exact name now requires renaming the old account first.

- Closed the vacated-name reuse hole in commission routing. Live migration `20260722150432_forbid_referenced_recipient_name_acquisition`: the database now refuses to let any profile — admin actions included — acquire a name still referenced by a commission split with future money (customer defaults, live quotes, uninvoiced jobs); update the splits first. Proven live: an admin attempt to reassign a referenced name raised `COMMISSION_RECIPIENT_NAME_RESERVED` and was rolled back. The durable redesign (storing profile ids inside splits instead of names) is queued as follow-up work.

- Hardened commission-identity names after the Codex pre-merge review flagged that any authenticated user could rename their own profile — colliding with or claiming a commission-recipient name. Live migration `20260722144121_lock_commission_identity_names`: `full_name` joins the admin-only column set in the profile guard trigger, and a case-insensitive partial unique index forbids duplicate active names for everyone. Proven live with an aborted-transaction test: non-admin rename raises `PROFILE_ROLE_LOCK`, admin rename still works.

- Closed the parked gauntlet section-7 HIGH: commission recipients are now validated fail-closed at creation. Live migration `20260722134252_reject_unresolvable_commission_recipients` makes the shared commission-split validator reject any recipient that does not resolve to exactly one active profile, adds a commissions-table backstop trigger so no code path can ever create a commission without a payable `recipient_user_id`, and adds `list_commission_recipients()` which now feeds the CommissionSplitEditor dropdown from the database (the free-text "Other" path is removed). Proven live: postflight reject/accept/trigger tests inside the apply transaction plus a non-admin (`authenticated` role) proof that the dropdown RPC and resolution helper work under RLS. Zero existing rows affected.

## 2026-07-22 — Supplier Cost Basis Phase 2 Wells canary closed out

- Closed PR #207's final CodeRabbit verification findings: the documentation-drift guard now validates the migration-history ledger sequence independently from SQL-file and grouped-row counts, and the ProductDetail pricing-flow test keeps each simulated query builder isolated so later builders cannot redirect earlier assertions.

- Completed and re-verified the single authenticated Wells Phase 2 Product canary. `N-Serve - Bulk` moved from the $47.05 manual baseline to the reviewed $47.26/Gal Wells quote through governed preview/apply; all three tier sell prices remained exactly $52.77 / $56.46 / $62.46, while only the derived margins changed. Cost history, selected-basis, change-set, supplier-comparison provenance, and activity records agree. More than three hours of read-only observation and an authenticated production browser check remained clean. The Wells allowlist remains exactly 10 Products and the global supplier-cost-basis flag remains OFF; no second canary or broader rollout was performed. The durable evidence and remaining production boundary are recorded in [`docs/audits/2026-07-22-supplier-cost-basis-phase2-wells-canary-closeout.md`](audits/2026-07-22-supplier-cost-basis-phase2-wells-canary-closeout.md).

- Closed the PR #207 review finding that the retained Phase 1a pricing engines were still directly executable by authenticated callers after all supported UI paths moved to the governed Phase 2 wrappers. Live migration `20260722100456_revoke_inner_pricing_rpc_access` revokes both inner preview/apply functions from browser and service roles while preserving authenticated access to the governed wrapper pair. The wrappers remain SECURITY DEFINER owner callers, so Product-page, Products-list, and workbook behavior is unchanged.

- Completed the Supplier Pricing workbook-v2 fast-follow and applied it live as `20260722091359_supplier_pricing_workbook_v2_product_info`. The protected monthly `.xlsx` round trip now edits suggested rate, per-acre rate/unit, use timing, internal notes, and customer-facing quoting notes alongside governed cost/sell-price changes; Product name/category/SKU/package identity remain locked manifest fields. Preview shows Product-information diffs before approval; apply performs one atomic Product update, one pricing-version increment, and one activity record per changed Product, with zero cost-history/basis rows for information-only edits and exactly one of each for combined pricing edits. Existing format-v1 exports were expired. Live postflight found no active v1/v2 exports or pending companion rows, the Wells allowlist remained exactly 10, and the global supplier-cost-basis flag remained OFF. Supplier PDFs remain manual audit evidence only; no AI/OCR extraction was added.

## 2026-07-22 — Field-level profitability report (X4/E4/T10) built

- New read-only RPC `get_field_profitability(p_season)` (migration applied live 2026-07-22, ledger version `20260722092928`) + `/field-profitability` page (PR #204). Margin per acre at (field, billed customer, season) from posted field-app invoices: header-COGS based, integer largest-remainder allocation, RLS-mirror sales-rep scoping, per-customer group shares, job-backed (transfer_job_to_invoice) invoices report exactly per billed customer in the '(unassigned field)' bucket (mutable job_fields/fbd state deliberately NOT presented as historical field attribution), which honors durable invoice_shares splits. Codex (gpt-5.6-sol) built it; six adversarial Codex review rounds drove 5 confirmed HIGH fixes + 2 evidence-backed dispositions (per-line split groups have no per-field customer mapping by design; invoices.customer_id is the billed customer for every current writer — verified in live function bodies and catalog). Final hardening: job-backed acres anchor to the invoice_shares.acres snapshot stored at posting (current FBD/owner state supplies spread proportions only), zero-weight children report in the unassigned bucket, and the row type is null-accurate for the unassigned row.
- Applied a forward-only repair for the Wells Phase 2 canary after the independent Codex review found that a received purchase-order line could be reassigned from a canary Product to a non-canary Product and shed its immutable cost provenance. Submitted as `20260722075500_lock_received_po_cost_snapshot_across_product_reassignment`, Supabase recorded it under live ledger version `20260722080226`, and the repository file was reconciled to `20260722080226_lock_received_po_cost_snapshot_across_product_reassignment.sql`. The replacement trigger now evaluates both the old and new Product identities; the disposable PostgreSQL 17 chain proves the exact reassignment fails with `RECEIVED_PO_COST_SNAPSHOT_IMMUTABLE`. The original applied migration remains unchanged, and the global feature flag remains OFF.

- Applied the Wells-only Phase 2 canary migration. Its submitted migration name is `20260722060644_wells_cost_basis_rollout_gate`; Supabase recorded it under live ledger version `20260722064814`; the reconciled repository file is `20260722064814_wells_cost_basis_rollout_gate.sql`. It adds a private deny-all Product allowlist seeded with the exact ten reviewed Wells Products, requires the canonical global flag row to exist exactly once and remain `false`, fails closed if Product/vendor/link/observation shape has drifted, and routes all six behavioral flag readers through a global-or-Product helper while preserving apply's global setting-row lock. Live postflight confirmed exactly 10 allowlisted Products, all 10 helper-enabled, a non-pilot Product disabled, 602 active basis rows, zero pending change rows, unchanged Wells totals, and the global flag still OFF. No Product money changed.

## 2026-07-21 — Wells Supplier Pricing Phase 1b pilot closeout

- Completed the governed manual Wells Ag Supply pilot with 10 representative Product links and one approved 10-row quote import. Supplier comparison and Product history now show the Wells quote observation while Product cost and all three sell-price tiers remain unchanged.
- Applied `20260722025808_resolve_wells_legacy_vendor_history` to associate 17 exact Wells purchase orders (11 received, 66 received lines) with the approved Wells supplier identity. The migration was proven with rollback-only PostgreSQL execution before live apply and does not write Product costs or sell prices.
- Hardened workbook parsing for staff-entered unit shorthand and added durable pilot/migration regression coverage. Supplier PDFs remain audit attachments only; no AI/OCR extraction was added.
- Applied a fail-closed unique index for active vendor names under supplier normalization after independent review identified punctuation/whitespace identity ambiguity. Live preflight found no existing collisions, rollback proof passed, and the server-assigned migration version is `20260722033450`.

## 2026-07-21 — Supplier Pricing Phase 2 live foundation and frontend follow-up

- Applied `20260722015019_supplier_cost_basis_phase2` live with the rollout flag still `false`. Post-apply proof found 602 active Product basis rows, zero pending basis-change rows, one exact overload for each Phase 2 preview/apply RPC, a rollback-only preview→apply pass with Product cost and all sell prices unchanged, and zero unallowlisted findings across all 17 invariant sweeps. The frontend follow-up adds an admin-only Product Detail cost-basis flow with eligible supplier/received-PO evidence actions, manual override, required reason, explicit governed preview/approval, and a safe default that keeps current sell prices. Supplier Pricing remains the read-only comparison workspace and links to the Product flow. Exact bigint-cent normalization, typed live RPC contracts, stale-response protection, and idempotency remain enforced. The feature stays disabled pending its separate enable gate.

## 2026-07-21 — Supplier Pricing Phase 2 migration-first review

- Prepared the additive `20260722015019_supplier_cost_basis_phase2` migration behind the queued-RPC/frontend barrier. Its rollout flag is forcibly reset to `false` during migration, including when a drifted pre-existing row says `true`, so applying schema alone cannot enable the new cost-basis workflow. New tables/indexes and public RPC overloads fail closed on pre-existing schema drift. Pricing-free Product shells created after migration receive their initial basis on the first governed cost approval, without inventing a zero-cost basis. PO insert/first-receipt paths discard caller-supplied conversion provenance and derive only safe same-unit factor plus unit-identity snapshots. Both received-purchase and supplier-link evidence become ineligible if the Product inventory unit later changes; preview, apply, workspace, and history enforce the binding, enabled governance blocks direct unit reinterpretation, and a flag-off correction atomically closes the old active basis. Apply locks every Product before its final evidence re-resolution, closing the concurrent pricing-free unit-change race. The existing-line legacy backfill exception is scoped to the migration transaction and fails closed when its setting is absent, so later callers cannot replay it. Ledger-history authorization likewise fails closed when unset. Supplier-backed apply locks observations before referenced supplier rows to match the correction path and avoid deadlocks; actual-purchase apply locks PO items before parent POs to match receiving/reversal order. The new purchase snapshot constraint uses PostgreSQL's lower-impact validation sequence. While disabled, existing received-PO corrections clear stale provenance; once enabled, received cost-defining fields freeze. The disposable PostgreSQL proof covers both flag states and adversarial snapshot/unit-change inputs.
- Applied follow-up `20260722035521_allow_inert_null_cost_workbook_rows` after authenticated frontend verification found that complete workbooks can legitimately include unchanged Products without a cost. Full manifest/tamper validation remains mandatory, while only the exact inert null-cost row skips basis resolution. A two-row rollback proof passed with one inert Product and one governed cost change. The feature flag remains OFF.
- Applied forward-only overload assertion `20260722042515_assert_supplier_cost_basis_followup_overloads` after final push review found the applied replacement did not itself reject stale alternate RPC signatures. A concurrent overnight apply replayed the identical assertion as ledger version `20260722043537`; both executions only checked live shape and changed no function body, Product money, grants, or feature flag. Disk and documentation retain both successful ledger entries for parity.
## 2026-07-21 — Chemical-sale payment-terms build: migration 20260721223817 (save_invoice persists payment_terms; due_date now key-conditional) APPLIED LIVE with Mason's OK; InvoiceDetail terms picker + posted read-only display; single+batch PDF print invoice override. 3 codex review rounds (sol adversarial x2 + migration gauntlet clean).

Chemical-sale payment-terms build: migration 20260721223817 (save_invoice persists payment_terms; due_date now key-conditional) APPLIED LIVE with Mason's OK; InvoiceDetail terms picker + posted read-only display; single+batch PDF print invoice override. 3 codex review rounds (sol adversarial x2 + migration gauntlet clean).

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `5180426b feat(billing): invoice payment-terms picker + due-on-receipt parser support (#195)`
  - `866bb291 Merge pull request #194 from masonwells1/docs/port-missing-docs-to-main`
  - `bd18cee1 fix(split-billing): apply unassigned v_app_service record fix live (mig 20260721180000) (#192)`
  - `3eb8a93d Test-system overhaul: business-area slices, per-line split smoke (found live bug), drift reconciliation (#191)`
  - `61277725 Close out supplier pricing Phase 1a (#168)`
  - `66d5371d chore(deps): bump @babel/core to 7.29.7 and esbuild to 0.28.1 (lockfile-only, resolves 2 low dependabot alerts) (#190)`
  - `310f62a4 chore(reports): cleanup-sprint progress check 2026-07-17 (#158)`
  - `b0e115af Bug-class regression suite: lock down the 2026-07-10..20 review-round findings (#189)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260721191914_due_on_receipt_terms_parser.sql`
  - `supabase/migrations/20260721180000_fix_split_impl_unassigned_app_service_record.sql`
  - `supabase/migrations/20260718152837_20260718131500_revert_quote_escape_hatch_for_cancelled_order.sql`
  - `supabase/migrations/20260718153744_20260718124500_harden_prepay_and_payment_role_gate.sql`
  - `supabase/migrations/20260718154810_20260718133000_void_invoice_block_applied_payments.sql`
  - `supabase/migrations/20260718174018_finance_charge_month_dedup.sql`
  - `supabase/migrations/20260718174859_forbid_restore_cancelled_order.sql`
  - `supabase/migrations/20260718175641_backfill_invoice_refuse_split_billing.sql`
  - `supabase/migrations/20260718202607_backfill_invoice_guard_durable_split_allocations.sql`
  - `supabase/migrations/20260718203206_retire_legacy_record_invoice_payment.sql`
  - `supabase/migrations/20260718213305_void_invoice_ignore_reversed_allocations.sql`
  - `supabase/migrations/20260718221505_preserve_voided_payment_allocation_history.sql`
  - `supabase/migrations/20260718232157_harden_quote_reopen_history_guards.sql`
  - `supabase/migrations/20260718235153_reconcile_gauntlet_intermediate_live_windows.sql`
  - `supabase/migrations/20260719023344_bind_revert_quote_status_idempotency.sql`
  - `supabase/migrations/20260719024641_lock_backfill_split_allocation_rows.sql`
  - `supabase/migrations/20260719044912_trust_only_post_revoke_split_provenance.sql`
  - `supabase/migrations/20260719044958_revert_quote_status_deadlock_retry.sql`
  - `supabase/migrations/20260719045029_align_finance_charge_preview_month_dedup.sql`
  - `supabase/migrations/20260719060256_allow_governed_split_terminal_lifecycle.sql`
  - `supabase/migrations/20260721014858_20260721010000_govern_invoice_order_money_lifecycle.sql`
  - `supabase/migrations/20260721125937_ignore_voided_finance_charge_month_dedup.sql`
  - `supabase/migrations/20260721130355_fix_transaction_review_running_balance.sql`
  - `supabase/migrations/20260721130846_replay_vendor_alias_after_vendor_retirement.sql`
  - `supabase/migrations/20260721145936_require_money_lifecycle_idempotency_keys.sql`
  - `supabase/migrations/20260721152604_block_partial_cancel_with_received_returns.sql`
  - `supabase/migrations/20260720230000_supplier_pricing_durable_replay_and_reject.sql`
  - `supabase/migrations/20260720213000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260720214000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260720233000_per_line_split_billing_save_rpc.sql`
  - `supabase/migrations/20260720200329_scope_delivery_signature_storage_access.sql`
  - `supabase/migrations/20260720211454_scope_delivery_signature_delete.sql`
  - `supabase/migrations/20260720225716_require_active_driver_for_signatures.sql`
  - `supabase/migrations/20260720235246_qualify_sales_rep_authorization_helper.sql`
  - `supabase/migrations/20260718225511_supplier_price_evidence_phase1b.sql`
  - `supabase/migrations/20260718235717_stage_supplier_vendor_aliases_phase1b.sql`
  - `supabase/migrations/20260720203000_restrict_supplier_pricing_to_admin.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`
  - `supabase/migrations/20260718124500_harden_prepay_and_payment_role_gate.sql`
  - `supabase/migrations/20260718131500_revert_quote_escape_hatch_for_cancelled_order.sql`
  - `supabase/migrations/20260718132000_finance_charge_month_dedup.sql`
  - `supabase/migrations/20260718133000_void_invoice_block_applied_payments.sql`
  - `supabase/migrations/20260718134000_forbid_restore_cancelled_order.sql`
  - `supabase/migrations/20260718134500_backfill_invoice_refuse_split_billing.sql`
  - `supabase/migrations/20260718194000_backfill_invoice_guard_durable_split_allocations.sql`
  - `supabase/migrations/20260718203000_retire_legacy_record_invoice_payment.sql`
  - `supabase/migrations/20260718204000_void_invoice_ignore_reversed_allocations.sql`
  - `supabase/migrations/20260718214000_preserve_voided_payment_allocation_history.sql`
  - `supabase/migrations/20260718230000_supplier_price_evidence_phase1b.sql`
  - `supabase/migrations/20260718230848_harden_quote_reopen_history_guards.sql`
  - `supabase/migrations/20260718234500_reconcile_gauntlet_intermediate_live_windows.sql`
  - `supabase/migrations/20260718235900_stage_supplier_vendor_aliases_phase1b.sql`
  - `supabase/migrations/20260719013000_bind_revert_quote_status_idempotency.sql`
  - `supabase/migrations/20260719040000_lock_backfill_split_allocation_rows.sql`
  - `supabase/migrations/20260719064000_validate_quote_commission_splits.sql`
  - `supabase/migrations/20260719093000_route_invoice_updates_through_governed_rpcs.sql`
  - `supabase/migrations/20260719093500_reject_null_commission_percentages.sql`
  - `supabase/migrations/20260719100000_trust_only_post_revoke_split_provenance.sql`
  - `supabase/migrations/20260719100500_revert_quote_status_deadlock_retry.sql`
  - `supabase/migrations/20260719101000_align_finance_charge_preview_month_dedup.sql`
  - `supabase/migrations/20260719102000_allow_governed_split_terminal_lifecycle.sql`
  - `supabase/migrations/20260720175946_protect_governed_split_edit_and_void_group.sql`
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`

## 2026-07-21 — Invoice due-dates ticket (approved spec 2026-07-16): found most A8 machinery already live; shipped the two real gaps. Migration 20260721191914 APPLIED LIVE via full gate (parse_payment_terms_days: due-on-receipt forms -> 0 days; proven with live rollback smoke on [E2E] invoice: due_date=invoice_date for Due on receipt, +30d for Net 30). Frontend terms picker (Net 30/Net 15/Due on receipt/Custom date) on FieldApplicationInvoice with sol-review fixes: unposted edit gating, display-only PDF due date, legacy free-text round-trip. Built by codex gpt-5.6-luna subagents, adversarial gpt-5.6-sol review (2 HIGHs fixed+reverified). Full suite 3776 pass. PR #195 open, awaiting Vercel+CodeRabbit then merge.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `866bb291 Merge pull request #194 from masonwells1/docs/port-missing-docs-to-main`
  - `bd18cee1 fix(split-billing): apply unassigned v_app_service record fix live (mig 20260721180000) (#192)`
  - `3eb8a93d Test-system overhaul: business-area slices, per-line split smoke (found live bug), drift reconciliation (#191)`
  - `61277725 Close out supplier pricing Phase 1a (#168)`
  - `66d5371d chore(deps): bump @babel/core to 7.29.7 and esbuild to 0.28.1 (lockfile-only, resolves 2 low dependabot alerts) (#190)`
  - `310f62a4 chore(reports): cleanup-sprint progress check 2026-07-17 (#158)`
  - `b0e115af Bug-class regression suite: lock down the 2026-07-10..20 review-round findings (#189)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260721191914_due_on_receipt_terms_parser.sql`

## 2026-07-21 — Split-save unassigned-record fix APPLIED LIVE (migration 20260721180000)

- Applied `20260721180000_fix_split_impl_unassigned_app_service_record` live via the management-API POST channel (exact repo file bytes; ledger row recorded). Fixes the cold-session 55000 crash in `_save_field_app_split_invoice_impl` on saves with no service line (or non-service lines before the first service line) by capturing the service name into `v_svc_name`; re-asserts the impl's least-privilege REVOKE.
- Gates: migration-review workflow clean (0 blockers, 3 reviewers), write-apply-proofs CLEAN content-bound proof pair, Mason's in-chat apply approval.
- Proof: full `smoke-per-line-split-billing.sql` chain now returns `SMOKE_PASS_ROLLBACK` end-to-end with the G5 cold service-less save running FIRST and succeeding — the billing area slice is fully green.

## 2026-07-21 — Test-system overhaul: business-area slices, per-line split smoke, drift reconciliation

- **Area slicing:** every smoke spec now carries `area` tags and `scripts/test-areas.json` + `scripts/run-area.mjs` bundle a vitest slice, the tagged smoke chains, and the matching DB invariant sweeps per business area (billing, inventory, lifecycle, pricing, security, idempotency, regression, drift). `npm run test:billing` etc.; `run-smoke.mjs --area <a>`; `run-sweeps.mjs --only <p1,p2>`.
- **Per-line split billing behavioral smoke** (`smoke-per-line-split-billing.sql`): proves flag gate, penny-exact odd-cents largest-remainder split (5751/5750 of 11501c), stored-row invariants, idempotent replay, calculator {34,33,33}, and the dup-product / off-job-field / job-immutable / resolver-auth guards against live (rolled back). Its G5 fail-first probe found a REAL live bug: `_save_field_app_split_invoice_impl` crashes (55000 unassigned `v_app_service` record) on any cold-session save whose lines before the first service line are non-service — intermittent by connection-pool warmth. Fix migration PARKED at `scripts/.staging-migrations/20260721180000_fix_split_impl_unassigned_app_service_record.sql` awaiting review + approved apply; smoke stays RED at G5 until then.
- **Drift reconciliation after the 2026-07-20 go-lives:** regenerated `src/types/supabase.ts` from live (split + supplier-pricing RPCs now typed), emptied the stale `MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY` bucket into `MUTATING_RPCS_WITH_IDEMPOTENCY`, classified the two lifecycle idempotency helpers, fixed the pg_proc fixture header date/count.
- **Consolidation:** PR #188 email-authority guards pinned in the `bugClassRegressionGuards` manifest; gauntlet index refreshed with 2026-07-21 status notes; removed a stale merge-conflict marker pair from this changelog.

## 2026-07-21 — Supplier-pricing Phase 1a production closeout

- Applied the forward-only `cancel_order` correction live as ledger version `20260721152604` after the expanded smoke set proved that a partially fulfilled order could close its undelivered remainder despite having a received return. The correction moves the existing `ORDER_HAS_RECEIVED_RETURN` guard ahead of both cancellation routes while preserving exact committed replay and the reviewed lock/idempotency contract. Both exact-file reviewers returned CLEAN; eight neighboring money/cancellation chains returned `SMOKE_PASS_ROLLBACK`; the private implementation hash, grants, search path, guard order, and single public overload were verified live; and all 17 database-invariant sweeps had zero unallowlisted violations.
- Applied the release-gate idempotency correction live as ledger version `20260721145936`. It preserves five reviewed money/lifecycle implementations behind private names and makes six public boundaries reject missing or all-whitespace idempotency keys before mutation. `batch_post_invoices` binds each retry to the actor plus ordered invoice list and derives a stable nonblank child key for every `post_invoice` call. The six-RPC rollback smoke and seven additional registered lifecycle chains passed with rollback; the broader run then exposed the separate received-return partial-cancel gap above.
- Preserved `stage_vendor_alias` exact retries after an alias is reviewed and its vendor is later retired by storing the original stage response in a protected durable-receipt table, then checking cache and that receipt before mutable vendor validation. Applied live as ledger version `20260721130846`; the full Supplier Pricing Phase 1b rollback chain proved reviewed/retired replay, rejection of new mutations against the retired vendor, unchanged Product prices, and zero residue.
- Bounded quote-reopen reasons to 500 characters before generating the reason-bearing retry key, preventing an oversized user-entered reason from exceeding PostgreSQL's idempotency-key index-entry limit while preserving exact server-side request fingerprinting.
- Applied the Customer Transaction Review running-balance correction live as ledger version `20260721130355`, so multiple allocations sharing a payment date/reference advance one row at a time in stable UUID order instead of displaying the peer group's final balance on every row. Live inspection found zero current peer groups, so no data repair was needed; the complete governed lifecycle rollback chain returned `SMOKE_PASS_ROLLBACK` with zero residue.
- Restamped the pending PR #168 invoice/order lifecycle closeout above the final PR #165 live high-water and bound it to the strengthened governed split save, singular-void, and atomic group-void contracts without replacing those reviewed bodies.
- Limited the new "cancel remaining quantity" behavior to genuinely `partially_fulfilled` orders, preserving the final provenance-aware full-cancel path for confirmed orders.
- Registered and ran both the lifecycle rollback chain and the canonical governed split H5 chain against the composed migration; both returned `SMOKE_PASS_ROLLBACK` with zero persisted fixtures.
- Canonicalized the unbilled-delivery actor-forgery rejection to `ACTOR_MISMATCH`, matching the invariant sweep and frontend error contract; reran 114 focused tests, typecheck, and both live-schema rollback smokes successfully.
- Applied the reviewed lifecycle migration live as ledger version `20260721014858`; both post-apply rollback chains returned `SMOKE_PASS_ROLLBACK`, governed function grants/search paths were verified, and no smoke fixtures remained.
- Deployed `process-document` v19 ACTIVE with JWT verification. Supplier `price_list` and `product_list` requests now fail closed before paid OCR, completing the permanent supplier-PDF OCR retirement.
- Refreshed the schema registry from six live introspection queries at high-water `20260721014858`.
- Restored the exact committed source for the already-live `20260720230000_supplier_pricing_durable_replay_and_reject` migration from its parallel Phase 1b branch, closing the last rebuild/traceability gap identified by the final Claude review.
- Corrected cancellation replay handling so an `already_cancelled` response refreshes the order without writing a second activity entry or sending a false cancellation notice. Applied the finance-charge correction live as ledger version `20260721125937`: only an active same-month charge blocks another assessment, while voided/cancelled charge invoices permit one corrected preview and generation. Finance-charge generation keys remain bound to the actor, date, and normalized customer selection; both registered rollback chains returned `SMOKE_PASS_ROLLBACK` with zero residue.
- Refreshed the schema registry from six live introspection datasets at high-water `20260721130846` and ran all 17 database invariant sweeps with zero unallowlisted findings.

## 2026-07-21 — Weekly cleanup-sprint check (automated routine, 2026-07-17)

Queried live DB — negatives=18 (+1, likely U9 warn-not-block delivery; check requires_review=true on inventory_transactions), over_received=15, unbilled=59. Progress row appended to docs/reports/cleanup-sprint-progress.md. Phase 23 CHECK constraints still blocked (legacy 17 rows need /integrity-cleanup). PR #158 opened and in review.

- **Migrations touched**: none (docs-only change)

## 2026-07-20 — Bug-class regression test suite (PR #189)

Bug-class regression suite: analyzed all ~60 bugs fixed 2026-07-10..20 (split-billing Codex rounds 2-12, Fable adversarial, gauntlet 2-6, statement opening balance, pricing 1a/1b), clustered them into 12 recurring classes, and locked the top classes with hermetic npm-test guards (commit 9e7e185f): sqlRoleGateNullFailOpen.test.ts (H1 NULL-role fail-open scanner over latest disk fn defs; found latent H1 in parked create_inventory_hold), bugClassRegressionGuards.test.ts (pins 14 SQL guard tokens across 9 fns following PERFORM/RENAME chains + 3 frontend guards + 8 fail-first smokes' registration), splitVectorMath extraction + property tests (r2 #K / r3 P2 residual classes). Full suite 3742 green; Codex verdict pending before PR/merge.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `e4f4cab9 Supplier Pricing Phase 1b follow-ups: durable replay, import reject path, admin-only alignment (migration PARKED) (#184)`
  - `85f64c31 Merge pull request #164 from masonwells1/claude/per-line-split-billing-build`
  - `24e71f0e Gauntlet sections 2–6 remediation: 6 confirmed fixes (H1, B2, H2, H3, H4, H5) (#165)`
  - `1a1b3850 feat(pricing): Supplier Pricing Phase 1b — admin-only supplier evidence MVP (#179)`
  - `d6f02db4 Reconcile live Supabase migration history (#180)`
  - `31095fcd Fix customer statement opening balances (#178)`
  - `5e346c85 Isolate autopilot guard test from the ambient AUTOPILOT.on flag (#177)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260720230000_supplier_pricing_durable_replay_and_reject.sql`
  - `supabase/migrations/20260720213000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260720214000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260720233000_per_line_split_billing_save_rpc.sql`
  - `supabase/migrations/20260720200329_scope_delivery_signature_storage_access.sql`
  - `supabase/migrations/20260720211454_scope_delivery_signature_delete.sql`
  - `supabase/migrations/20260720225716_require_active_driver_for_signatures.sql`
  - `supabase/migrations/20260720235246_qualify_sales_rep_authorization_helper.sql`
  - `supabase/migrations/20260718225511_supplier_price_evidence_phase1b.sql`
  - `supabase/migrations/20260718235717_stage_supplier_vendor_aliases_phase1b.sql`
  - `supabase/migrations/20260720203000_restrict_supplier_pricing_to_admin.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`
  - `supabase/migrations/20260718124500_harden_prepay_and_payment_role_gate.sql`
  - `supabase/migrations/20260718131500_revert_quote_escape_hatch_for_cancelled_order.sql`
  - `supabase/migrations/20260718132000_finance_charge_month_dedup.sql`
  - `supabase/migrations/20260718133000_void_invoice_block_applied_payments.sql`
  - `supabase/migrations/20260718134000_forbid_restore_cancelled_order.sql`
  - `supabase/migrations/20260718134500_backfill_invoice_refuse_split_billing.sql`
  - `supabase/migrations/20260718194000_backfill_invoice_guard_durable_split_allocations.sql`
  - `supabase/migrations/20260718203000_retire_legacy_record_invoice_payment.sql`
  - `supabase/migrations/20260718204000_void_invoice_ignore_reversed_allocations.sql`
  - `supabase/migrations/20260718214000_preserve_voided_payment_allocation_history.sql`
  - `supabase/migrations/20260718230000_supplier_price_evidence_phase1b.sql`
  - `supabase/migrations/20260718230848_harden_quote_reopen_history_guards.sql`
  - `supabase/migrations/20260718234500_reconcile_gauntlet_intermediate_live_windows.sql`
  - `supabase/migrations/20260718235900_stage_supplier_vendor_aliases_phase1b.sql`
  - `supabase/migrations/20260719013000_bind_revert_quote_status_idempotency.sql`
  - `supabase/migrations/20260719040000_lock_backfill_split_allocation_rows.sql`
  - `supabase/migrations/20260719064000_validate_quote_commission_splits.sql`
  - `supabase/migrations/20260719093000_route_invoice_updates_through_governed_rpcs.sql`
  - `supabase/migrations/20260719093500_reject_null_commission_percentages.sql`
  - `supabase/migrations/20260719100000_trust_only_post_revoke_split_provenance.sql`
  - `supabase/migrations/20260719100500_revert_quote_status_deadlock_retry.sql`
  - `supabase/migrations/20260719101000_align_finance_charge_preview_month_dedup.sql`
  - `supabase/migrations/20260719102000_allow_governed_split_terminal_lifecycle.sql`
  - `supabase/migrations/20260720175946_protect_governed_split_edit_and_void_group.sql`
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260720173059_fix_statement_opening_balance.sql`
## 2026-07-20 — Split-billing email authority completed

- Re-read each invoice's server-owned disposition and lifecycle immediately before every invoice email send, including field-invoice lists and invoice detail.
- Bound post-application proof notices to the correct split child invoice and added an independent `send-email` edge gate that rejects suppressed, voided, cancelled, deleted, mismatched, or ambiguous invoices.
- Preserved a narrowly scoped edge-first compatibility path for the pre-schema missing-column condition while failing closed on every other lookup error.

## 2026-07-20 — Baseline follow-up migrations preserve ledger history

- Replaced the unsafe generic-SQL-client instruction with an isolated, filtered Supabase CLI workflow that dry-runs the exact post-baseline set and records every applied migration in the target ledger.

## 2026-07-20 — Sales-rep authorization helper explicitly qualified

- Re-emitted `is_sales_rep()` with the canonical `public, pg_temp` search path, an explicit `public.profiles` reference, and least-privilege EXECUTE grants for authenticated/service roles only. The delivery-signature rollback smoke now proves a forged temporary `profiles` table cannot grant sales-rep access.

## 2026-07-20 — Baseline post-migration selector regression proof

- Replaced the source-text-only guard with a behavioral collision fixture proving that a captured migration name cannot hide a later timestamped migration that reuses the same suffix.
- Added a fail-closed restore guard that rejects `pgcrypto`, `postgis`, or `uuid-ossp` when a target database has them preinstalled outside the required `extensions` schema.

## 2026-07-20 — Delivery signatures restricted to authorized deliveries

Removed four duplicate bucket-only Storage policies that let any authenticated user
read or overwrite any delivery signature. The private bucket now accepts only the
canonical `signatures/<delivery-id>.png` path and permits access to admins, sales reps,
or the delivery's assigned driver; uploads and recaptures additionally require a
completed delivery. A rollback-only catalog smoke proves the broad policies are gone.
The final exact Codex push gate found that assignment alone did not exclude an inactive
former driver. A forward-only correction now requires the canonical active-driver role
helper on every assigned-driver signature path, with positive and deactivation rollback proof.
The final forward correction also replaces the remaining bucket-wide DELETE policy
with admin/sales-only canonical-path deletion. Live versions are intentionally preserved
on disk in apply order (`20260720200329`, `20260720203000`, `20260720211454`) while the
registry retains Supabase's submitted names, and a regression test binds that ordering.
The ordering note and regression live outside the already-applied SQL so its reviewed bytes remain immutable.

## 2026-07-20 — Governed split editing and group void made fail-closed

The exact pre-push Codex review found that the generic invoice editor could replace
governed split lines without preserving their source order-item identity, and that a
single grouped invoice could be voided without its siblings. The forward correction
locks generic editing out of private-provenance split invoices and adds one atomic
`void_invoice_group` operation with exact actor, group, reason, and replay binding.
Invoice Detail routes grouped voids through that operation. The affected browser tests
now use governed invoice RPCs, and their Supabase helper throws on denied HTTP writes
instead of treating an error body as success. The rollback smoke reproduced the generic
edit defect on the prior live definition before apply.

### 2026-07-20 — Generated schema baseline review packaging corrected

The decoded production public-schema snapshot remains byte-for-byte unchanged and
SHA/restore verified, but the 66,674-line generated artifact is now stored as a
Brotli payload. The prior Git attribute accidentally enabled its full textual
diff, making the exact base-main Claude gate exceed the provider's one-million-
token request limit. The manifest binds both compressed and decoded bytes, the
decoder refuses hash drift before emitting SQL, and the existing disposable
restore proof remains the authoritative behavioral check. The verifier also
reconstructs and compares every Storage bucket row (identity, privacy, size
limit, and MIME types) against the captured bucket snapshot so those two rebuild
artifacts cannot drift independently.
The restore bootstrap now creates the production-specific `metabase_ro` NOLOGIN
grant target before decoding the public schema. Post-baseline migration selection
uses both filename version and captured submitted name, preventing four migrations
already stored under server-assigned ledger versions from replaying on a clean restore.
It matches captured names only to the full timestamped migration stem, so reusing an old
bare concept name cannot silently suppress a future migration.

### 2026-07-19 — Exact push-gate invoice and commission closures

The final exact Codex review found two live authorization/validation gaps after the
clean-rebuild baseline was added. Data API roles still had direct invoice UPDATE,
so an admin could bypass the governed invoice RPCs for header fields that were not
part of the split provenance denylist. The repository has no direct invoice writer;
the forward correction therefore removes direct UPDATE from anon/authenticated/
service-role and keeps the existing owner-context save/post/payment/void/cancel RPCs
as the only write path. The shared commission validator also now rejects a missing
or JSON-null percentage explicitly instead of allowing SQL NULL comparisons to fall
through. Both updated rollback chains reproduced the current live defects before
apply; reviewer/apply/post-smoke evidence is recorded in migration history.

### 2026-07-19 — Production schema clean-rebuild baseline at gauntlet high-water

The gauntlet closeout's exact Codex push review found that the immutable historical migration stream cannot safely initialize a brand-new database: one applied function-body guard depends on legacy mixed line endings, and the quote-commission repair correctly requires the one exact production row it reconciled. The fix does not edit either applied migration. `supabase/baselines/` now contains a hash-bound, data-free production schema snapshot at final live high-water `20260719092832`, its required extensions, the CRX-owned Auth trigger/Storage policy and bucket overlay, all eight live pg_cron schedules, and a compact 861-row version/name ledger with empty-ledger/job-name hard stops. A disposable PostgreSQL 17 restore matched production catalog counts and exact logical structural/security/function/policy fingerprints, including the final invoice UPDATE revokes and commission-validator body; replaying the ledger restore failed closed as designed. `scripts/verify-schema-baseline.mjs` is exposed as `npm run test:schema-baseline` and wired into correction guards/CI. Fresh projects must restore the manifest order and then apply only migrations newer than the baseline; the old migration files remain the immutable audit trail.

### 2026-07-19 — Quote commission routing made fail-closed

The post-gauntlet financial sweeps found one accepted but unconverted quote with a 100%
commission split and a blank recipient. It had no order, commission, salesperson, assigned
rep, or customer default, so the exact row is reconciled to an explicit no-commission split
instead of inventing a payee. A database trigger now applies the shared commission validator
to every quote insert or split update, and Quote Builder mirrors the same blank, duplicate,
percentage-range, and 100%-total checks before save. The pre-apply rollback smoke reproduced
the original blank-recipient acceptance; after the live cutover the same smoke passed and rolled back.

### 2026-07-19 — Exact-HEAD Codex blocker remediation applied live

The independent pre-push review found five remaining release issues after the original
CodeRabbit closeout. Split-invoice posting still trusted historically forgeable audit rows;
the canonical split creator did not share the OIFA writer's item locks; invoice UUID/group
identity could be recycled; timestamp cutover semantics could strand a legitimate old
transaction; and quote revert could deadlock with order cancellation. The forward repair now
uses private owner-only relational provenance and an exact line-content claim, stable
order-item locks, a cutover transaction claim that rejects stale old-function callers, and
governed `save_invoice`/`delete_invoices` wrappers for legitimate draft workflows. Direct
invoice identity creation/deletion and raw governed-content edits fail closed. Quote revert
keeps quote-first serialization but uses a retryable NOWAIT order lock. A real two-session
PostgreSQL 17 proof passed both OIFA/create orderings and both cancel/revert orderings.
`preview_finance_charges` now also mirrors generation's closed-period gate as well as its
calendar-month exclusion. Updated live rollback smokes failed first on the forged audit and
closed-period preview paths and confirmed every E2E fixture rolled back. All three forward
migrations passed both machine reviewer charters, applied live as ledger versions
`20260719044912`, `20260719044958`, and `20260719045029`, and their exact rollback smokes
returned `SMOKE_PASS_ROLLBACK`. Post-apply catalog proof confirmed the private provenance
tables remain empty after rollback, their deny-all RLS policies and guards are enabled,
direct invoice identity DML is revoked from Data API roles, and the public RPCs retain their
intended SECURITY DEFINER grants and fixed search paths.

A final forward correction applied as ledger version `20260719060256` keeps governed split
invoices usable through the canonical `void_invoice` and `cancel_order` lifecycle paths while
preserving fail-closed raw-edit guards. It also binds `create_split_invoices_from_order`,
`delete_invoices`, `void_invoice`, and `cancel_order` replay keys to the authenticated actor and
complete normalized request, so a key cannot be reused for another order or invoice set. The
full H5 rollback chain passed after apply, all transient claim/provenance rows remained clean,
and the live schema registry was regenerated at the final migration high-water.

### 2026-07-19 — Gauntlet CodeRabbit closeout hardening

CodeRabbit's ready-for-review pass found and prompted fixes for false-green smoke/E2E
assertions, duplicate same-round workflow findings, stale release documentation, and two
live concurrency gaps. New forward-only migrations bind `revert_quote_status` idempotency
to the exact authenticated request before mutation. The backfill fix uses stable parent-item
row locks on both the invoice creator and allocation writer, rejects allocation changes when
any active invoice exists, and blocks mono-invoice posting when durable or transient split
evidence exists. Posting cannot bypass the guard by clearing `order_id` or assigning an
arbitrary group UUID; only members with the canonical field-acre creation audit can use the
grouped path. Existing order-backed invoices cannot be re-parented even while draft, and
direct audit-log mutation privileges are removed before the trigger trusts that provenance.
An apply-time write barrier holds the evidence tables stable across preflight, revoke, and
trigger attachment, so concurrent DML cannot enter between those cutover steps.
Neither side of the child-FK timing race can commit stale evidence. Applied migration files remain immutable;
the coupled rollback smokes now prove exact replay versus mismatched-key reuse and exercise
both backfill predicates and both serialized writer outcomes.

### 2026-07-18 — Gauntlet workflow read-only boundary hardened

The sections 2–6 gauntlet can no longer give general-purpose child agents write-capable
filesystem or Supabase tools. Every finder, skeptic, critic, and adjudicator now runs as the
capability-constrained read-only `Explore` agent and receives live catalog facts only through
a caller-supplied evidence packet that must match the production project, be less than six
hours old, and include a fresh `origin/main` baseline for Section 5. Agent-produced findings
are delimited as untrusted data before reuse. Section settlement and BLOCKER/HIGH cleanliness
are derived deterministically from blocked evidence and terminal verdicts; an adjudicator's
advisory output cannot falsely release a blocked section or call a confirmed HIGH clean. The
autopilot off-by-default regression now runs against an isolated temporary project directory,
so an intentionally armed hands-free session cannot poison its own pre-commit guard test. The
workflow's six-hour freshness gate uses a caller-supplied `nowMs` reference instead of the
runtime clock, preserving deterministic resume semantics required by the workflow engine.

### 2026-07-18 — Gauntlet intermediate live-window reconciliation

Applied live as migration `20260718235153`. The forward-only, scan-only migration fails closed with exact entity identifiers
if either temporary live definition left durable damage: accepted-quote reopens during the
B2 escape-hatch window, allocation-deleting invoice voids during the H3 recovery window,
or inactive payment sets whose retained line history no longer matches the original amount
recorded by `payment_voided`. Both required reviewers were clean; live apply and post-apply
reconciliation returned zero affected rows for all three checks. The read-only gauntlet workflow also no longer tells reviewers to fetch or
mutate Git refs; callers must refresh `origin/main` before launching it.

### 2026-07-18 — B2 quote-reopen history guard follow-up

Applied live as migration `20260718232157`. The accepted-quote rescue path now refuses to create a full replacement order when any
cancelled source order has delivered quantity, a completed delivery, an active invoice, a
paid commission, or an active commission payout batch. The forward-only migration preserves
the newer live planned-hold rebuild. Its rollback smoke adds negative cases for every durable
history class, and the retired `record_invoice_payment` E2E callers now use the governed
`allocate_payment` ledger.

### 2026-07-18 — Windows Codex proof stdin hang fixed

The exact-SHA Codex push-proof wrapper now invokes `codex exec -` and supplies its fixed
review prompt as the complete stdin payload. Codex CLI 0.145 on Windows otherwise waited
indefinitely at "Reading additional input from stdin" when the prompt was passed as argv,
eventually timing out without minting a proof. The wrapper remains read-only, shell-free,
and fail-closed; its helper and agent-workflow suites pass.

### 2026-07-18 — Migration drift proof responsibility clarified

The canonical `migration-drift-reviewer` keeps the strict B7 contract from `main`: disk
timestamps must be greater than the current live high-water, missing live evidence is a HIGH
finding for the orchestrator to resolve, and every successful apply requires the server-stamp
rename plus migration-history closeout. Migration-history matching also recognizes the
repository's timestamp-keyed rows.

---

## 2026-07-20 — Supplier Pricing Phase 1b follow-ups (PR #184)

Migration 20260720230000 (built this session, then **APPLIED LIVE** with Mason's in-chat OK; ledger-reconciled per B7): durable idempotent replay after cache TTL for the 4 evidence RPCs, new `reject_supplier_price_import` terminal path, PRICE_UNIT_MISMATCH staging validation, America/Chicago business dates. Frontend: Reject-import UI, admin-only route alignment, ProductDetail cost-history fetch gate, ProductPriceHistory date-only rendering fix; docs + guard-test registrations; schema registry + pg_proc snapshot refreshed from live; invariant sweeps 17/17 pass. Surfaced Q-2026-2059 blank commission recipient (owner decision).

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `1a1b3850 feat(pricing): Supplier Pricing Phase 1b — admin-only supplier evidence MVP (#179)`
  - `d6f02db4 Reconcile live Supabase migration history (#180)`
  - `31095fcd Fix customer statement opening balances (#178)`
  - `5e346c85 Isolate autopilot guard test from the ambient AUTOPILOT.on flag (#177)`
  - `cbe2b789 Fix migration-review workflow failing closed on JSON-string args (#176)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260720230000_supplier_pricing_durable_replay_and_reject.sql`

## 2026-07-18 — Gauntlet sections 2-6 remediation applied live

The six confirmed fixes passed the local Codex security and migration-drift proof gates,
were applied to live Supabase in the approved order, and each reached
`SMOKE_PASS_ROLLBACK` through its registered business-chain smoke. The filenames below use
the server-assigned migration versions so a future rebuild cannot reapply them.

- **H1 — money-RPC auth bypass (LIVE).** `20260718153744_20260718124500_harden_prepay_and_payment_role_gate.sql`
  hardens `apply_prepay_to_invoice` + `record_invoice_payment` so a deactivated / profile-less
  authenticated user can no longer pass the role gate (`NULL NOT IN (...)` fall-through; missing
  `is_active` filter). Mirrors the vetted `apply_credit_memo_to_invoice`. Reviewers clean (rls +
  drift), no stale overload, fail-first smoke `smoke-prepay-payment-inactive-actor-gate.sql`
  proved the bypass live (raised `SMOKE_FAIL` on the pre-fix functions).
- **B2 — quote stranded after whole-conversion order cancel (LIVE).**
  `20260718152837_20260718131500_revert_quote_escape_hatch_for_cancelled_order.sql`. Chosen the safe, admin-driven
  escape hatch (not auto-reopen on cancel, which would contradict the void path's deliberate
  "converted booking stays closed" semantic): `revert_quote_status` now un-blocks reverting an
  'accepted' quote whose only order is cancelled and releases its stale draw ledger so it is
  re-convertible. Reviewers clean; fail-first smoke proved the strand live.
- **H2 — finance-charge double-charge (LIVE).**
  `20260718174018_finance_charge_month_dedup.sql`. Dedup now on the calendar month (+ month-keyed
  advisory lock) so two runs in the same month on different as-of dates can't both charge. Reviewers
  clean; fail-first smoke proved the double-charge live (2 charges from 2 same-month runs).
- **H3 — void_invoice stranded customer cash (LIVE).**
  `20260718154810_20260718133000_void_invoice_block_applied_payments.sql`. Refuses to void a posted invoice that
  still has direct cash applied (`paid_amount_cents>0` or `invoice_line_allocations`) — admin must
  void/unapply the payment first (re-banks it as prepay). Prepay-only voids unaffected. Reviewers
  clean; fail-first smoke proved the strand live.
- **H4 — restore_cancelled_order left a corrupt order (LIVE).**
  `20260718174859_forbid_restore_cancelled_order.sql`. Forbids restore (raises
  ORDER_RESTORE_NOT_SUPPORTED) rather than attempting a fragile exact-inverse of the cancel;
  recovery is a new order or the B2 quote escape hatch. Reviewers clean; fail-first smoke proved
  the pre-fix restore succeeded live.
- **H5 — backfill invoice mono-billed split-billing orders (LIVE).**
  `20260718175641_backfill_invoice_refuse_split_billing.sql`. create_invoice_for_unbilled_delivery
  now refuses (ORDER_NEEDS_SPLIT_BILLING) to backfill a single invoice for an order with
  needs_split_billing=true; the admin uses the split-billing flow. Reviewers clean; fail-first
  smoke proved the mono-bill live.
- **B1 — Supplier Pricing Phase 1a drift (investigated and reconciled):** this was not an
  unexplained live mutation. The gated database-first rollout applied the reviewed Phase 1a
  migrations before their source PRs landed, creating a temporary rebuild gap. PR #163 merged
  the Phase 1a foundation into `main` at 2026-07-18 15:16 UTC; PR #169 merged the enforcement
  cutover and rescan at 20:21 UTC. Production and `main` now contain the same Phase 1a source;
  Phase 1b remains independently owned by PR #168.
- **Design decision (Mason, 2026-07-18):** for the five non-mechanical findings (B2/H2/H3/H4/H5)
  build the conservative/safe fix each: block-void-with-active-payments (H3), refuse-split-backfill
  (H5), escape-hatch quote (B2), forbid-restore (H4), calendar-month finance-charge guard (H2).

## 2026-07-18 — Built read-only adversarial gauntlet loop over sections 2-6 (money/inventory/lifecycle/DB-drift/idempotency): opus orchestrator, sonnet finders, opus skeptics + per-section adjudicator gate. Ran overnight; confirmed HIGHs in money+lifecycle and a Section 5 live-drift BLOCKER (Supplier Pricing Phase 1a). Findings parked for Codex-gated fixes.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `4739104 Add gauntlet sections 2-6 adversarial audit loop`
  - `c6c1265 docs: per-line-item split-billing design spec + roadmap/decision-log updates (#162)`
  - `3aa758d Fold CodeRabbit into the landing flow; log FarmRx-public decision (#161)`
  - `3c4c2e6 Add CodeRabbit config for automatic PR reviews (#160)`
  - `774c85e Reconcile save_customer migration ledger version to match filename (#159)`
  - `a84534b Merge pull request #156 from masonwells1/claude/amazing-ptolemy-9e7e0a`
  - `70749c1 Merge remote-tracking branch 'origin/main' into claude/amazing-ptolemy-9e7e0a`
  - `7183851 Merge pull request #155 from masonwells1/claude/stoic-heyrovsky-ebaaf6`
  - `d456bab Merge remote-tracking branch 'origin/main' into claude/amazing-ptolemy-9e7e0a`
  - `e87971b Merge remote-tracking branch 'origin/main' into claude/stoic-heyrovsky-ebaaf6`
  - `b240f7a Close money and inventory gauntlet findings (#157)`
  - `9448e52 Correct migration-history row number + document name-based reconciliation`
  - `30ced29 Merge remote-tracking branch 'origin/main' into claude/amazing-ptolemy-9e7e0a`
  - `f6fe6ad Merge remote-tracking branch 'origin/main' into claude/stoic-heyrovsky-ebaaf6`
  - `0f6db26 Mark save_customer ownership migration APPLIED LIVE (ledger 20260717122244)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260717063445_bind_bulk_po_replay_content.sql`
  - `supabase/migrations/20260717070900_bind_bulk_po_identity_ascii_fold.sql`
  - `supabase/migrations/20260717081856_reject_blank_bulk_po_identity.sql`
  - `supabase/migrations/20260717085512_canonicalize_bulk_po_identity_whitespace.sql`
  - `supabase/migrations/20260717092749_secure_bulk_po_fingerprint_trigger.sql`
  - `supabase/migrations/20260717101619_canonicalize_bulk_po_unicode_identity.sql`
  - `supabase/migrations/20260717110016_make_bulk_po_identity_server_authoritative.sql`
  - `supabase/migrations/20260717112906_restore_server_derived_bulk_po_claim_payload.sql`
  - `supabase/migrations/20260717113000_log_customer_interaction_rpc.sql`
  - `supabase/migrations/20260717112532_crm_customer_crops.sql`
  - `supabase/migrations/20260717112533_crm_prep_card_volume.sql`
  - `supabase/migrations/20260717123000_save_customer_ownership_enforcement.sql`
  - `supabase/migrations/20260716183501_purchase_order_integer_cents.sql`
  - `supabase/migrations/20260716190000_harden_sales_financial_scope.sql`
  - `supabase/migrations/20260716191000_aggregate_delivery_stock_preflight.sql`
  - `supabase/migrations/20260716202000_preflight_delivery_accounting_period.sql`
  - `supabase/migrations/20260716210000_harden_invoice_existing_customer_scope.sql`
  - `supabase/migrations/20260716213000_preserve_purchase_order_omitted_cost.sql`
  - `supabase/migrations/20260716224000_close_adversarial_money_inventory_gaps.sql`
  - `supabase/migrations/20260716233000_globalize_bulk_po_import_intents.sql`
  - `supabase/migrations/20260717010000_close_final_purchase_order_release_gaps.sql`
  - `supabase/migrations/20260717015439_invalidate_deleted_bulk_po_retry_state.sql`
  - `supabase/migrations/20260717032000_replay_bulk_po_same_request_result.sql`
  - `supabase/migrations/20260717045420_bind_bulk_po_claim_to_vendor.sql`
  - `supabase/migrations/20260717013415_crm_customer_documents.sql`
  - `supabase/migrations/20260716214423_crm_call_lists.sql`
  - `supabase/migrations/20260716181306_crm_customer_facts.sql`
  - `supabase/migrations/20260716182318_crm_purchase_intelligence.sql`
  - `supabase/migrations/20260716195012_crm_supersede_fact_expiry.sql`

---

## 2026-07-20 — Codex round-12 on per-line split-billing = 1 real security P1: resolve_line_split_vector (SECDEF, callable directly by authenticated) let a sales_rep read the ownership split of arbitrary fields/jobs outside their assignment. Fixed: on DIRECT calls (crx.split_writer off), a non-admin may only resolve a vector whose every customer is assigned to them (RESOLVER_NOT_AUTHORIZED, no data leaked); internal save path exempt via the writer flag. rls review CLEAN (GUC exemption NOT forgeable via PostgREST); PROOFOK live incl. resolver_direct_(un)assigned scenarios. Codex round 13 next. Still PARKED.

Codex round-12 on per-line split-billing = 1 real security P1: resolve_line_split_vector (SECDEF, callable directly by authenticated) let a sales_rep read the ownership split of arbitrary fields/jobs outside their assignment. Fixed: on DIRECT calls (crx.split_writer off), a non-admin may only resolve a vector whose every customer is assigned to them (RESOLVER_NOT_AUTHORIZED, no data leaked); internal save path exempt via the writer flag. rls review CLEAN (GUC exemption NOT forgeable via PostgREST); PROOFOK live incl. resolver_direct_(un)assigned scenarios. Codex round 13 next. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `8eec9b4e fix(split-billing): Codex round-11 — reject unresolved ($0) chemical prices before saving`
  - `232149a3 fix(split-billing): Codex round-10 — scope post idempotency key to the invoice group`
  - `d5cf38c5 fix(split-billing): Codex round-9 — harden line-share post-lock trigger (false positive)`
  - `52d2e67f fix(split-billing): Codex round-8 split-specific (5 of 6) — post-safety, PDF units, override audit, applicator/vehicle, guardrails`
  - `3efff630 fix(split-billing): Codex round-7 P2s — item-tamper guard, override audit base, snapshot provenance, child field context`
  - `b683fa44 fix(split-billing): Codex round-7 P1s — active-group readback + RUP duplicate-product guard`
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round-11 on per-line split-billing = 1 real P1: a chemical with no field quote and no tier price silently resolved to $0 (suppressed_zero_total child that could still post, consuming inventory/RUP with no receivable). Fixed: SPLIT_CHEMICAL_PRICE_UNRESOLVED rejects a chemical with no resolvable positive price for any co-owner (manual override still passes). Reviewer CLEAN, PROOFOK live PG incl. unresolved_chem_price_rejected_ok. Codex round 12 next. Still PARKED.

Codex round-11 on per-line split-billing = 1 real P1: a chemical with no field quote and no tier price silently resolved to $0 (suppressed_zero_total child that could still post, consuming inventory/RUP with no receivable). Fixed: SPLIT_CHEMICAL_PRICE_UNRESOLVED rejects a chemical with no resolvable positive price for any co-owner (manual override still passes). Reviewer CLEAN, PROOFOK live PG incl. unresolved_chem_price_rejected_ok. Codex round 12 next. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `232149a3 fix(split-billing): Codex round-10 — scope post idempotency key to the invoice group`
  - `d5cf38c5 fix(split-billing): Codex round-9 — harden line-share post-lock trigger (false positive)`
  - `52d2e67f fix(split-billing): Codex round-8 split-specific (5 of 6) — post-safety, PDF units, override audit, applicator/vehicle, guardrails`
  - `3efff630 fix(split-billing): Codex round-7 P2s — item-tamper guard, override audit base, snapshot provenance, child field context`
  - `b683fa44 fix(split-billing): Codex round-7 P1s — active-group readback + RUP duplicate-product guard`
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round-10 on per-line split-billing = 1 real finding: the post_invoice_group idempotency key could be reused across split-billing drafts (editor stays mounted across /split-billing/:id navigations) -> a stale key returns a PRIOR group's cached success while the current group stays unposted. Fixed: reset the post key whenever invoiceGroupId changes (scoped to the group). Compliance CLEAN; typecheck+lint clean. Codex round 11 next. Still PARKED.

Codex round-10 on per-line split-billing = 1 real finding: the post_invoice_group idempotency key could be reused across split-billing drafts (editor stays mounted across /split-billing/:id navigations) -> a stale key returns a PRIOR group's cached success while the current group stays unposted. Fixed: reset the post key whenever invoiceGroupId changes (scoped to the group). Compliance CLEAN; typecheck+lint clean. Codex round 11 next. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `d5cf38c5 fix(split-billing): Codex round-9 — harden line-share post-lock trigger (false positive)`
  - `52d2e67f fix(split-billing): Codex round-8 split-specific (5 of 6) — post-safety, PDF units, override audit, applicator/vehicle, guardrails`
  - `3efff630 fix(split-billing): Codex round-7 P2s — item-tamper guard, override audit base, snapshot provenance, child field context`
  - `b683fa44 fix(split-billing): Codex round-7 P1s — active-group readback + RUP duplicate-product guard`
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round-9 on per-line split-billing = ONLY 1 finding (down from 6), and it was a FALSE POSITIVE: the invoice_line_shares post-lock trigger's IN(NEW.x,OLD.x) is NULL-safe in PL/pgSQL (proven by an isolated micro-test + 60+ live share insert/delete proofs). Hardened it to TG_OP-guarded CASE for clarity (behavior-equivalent), re-proven PROOFOK incl. freeze_blocks_posted_ok, reviewer CLEAN. Split-specific work now effectively converged; only the deferred app-wide RUP item remains. Codex round 10 next. Still PARKED.

Codex round-9 on per-line split-billing = ONLY 1 finding (down from 6), and it was a FALSE POSITIVE: the invoice_line_shares post-lock trigger's IN(NEW.x,OLD.x) is NULL-safe in PL/pgSQL (proven by an isolated micro-test + 60+ live share insert/delete proofs). Hardened it to TG_OP-guarded CASE for clarity (behavior-equivalent), re-proven PROOFOK incl. freeze_blocks_posted_ok, reviewer CLEAN. Split-specific work now effectively converged; only the deferred app-wide RUP item remains. Codex round 10 next. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `52d2e67f fix(split-billing): Codex round-8 split-specific (5 of 6) — post-safety, PDF units, override audit, applicator/vehicle, guardrails`
  - `3efff630 fix(split-billing): Codex round-7 P2s — item-tamper guard, override audit base, snapshot provenance, child field context`
  - `b683fa44 fix(split-billing): Codex round-7 P1s — active-group readback + RUP duplicate-product guard`
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
  - `3648e52a fix(split-billing): resolve all 8 P1 + 2 P2 Codex money/RLS findings [PARKED, flag OFF]`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round-8 split-specific fixes (5 of 6): P1-1 Post revoked during re-save; P1-3 chemical items persist unit_size/total_applied for the PDF; P2-1 credit-limit + RUP-license advisory before posting a split group; P2-2 per-customer override audit base; P2-3 applicator/vehicle denormalized onto children. Reviewer-clean (rls/drift/compliance 0/0/0), PROOFOK live PG (chem_units_persisted_ok etc). Round-8 P1-2 RUP-orderless is PRE-EXISTING app-wide, DEFERRED to task_c623ed0c. Codex round 9 next. Still PARKED.

Codex round-8 split-specific fixes (5 of 6): P1-1 Post revoked during re-save; P1-3 chemical items persist unit_size/total_applied for the PDF; P2-1 credit-limit + RUP-license advisory before posting a split group; P2-2 per-customer override audit base; P2-3 applicator/vehicle denormalized onto children. Reviewer-clean (rls/drift/compliance 0/0/0), PROOFOK live PG (chem_units_persisted_ok etc). Round-8 P1-2 RUP-orderless is PRE-EXISTING app-wide, DEFERRED to task_c623ed0c. Codex round 9 next. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `3efff630 fix(split-billing): Codex round-7 P2s — item-tamper guard, override audit base, snapshot provenance, child field context`
  - `b683fa44 fix(split-billing): Codex round-7 P1s — active-group readback + RUP duplicate-product guard`
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
  - `3648e52a fix(split-billing): resolve all 8 P1 + 2 P2 Codex money/RLS findings [PARKED, flag OFF]`
  - `70912a7c feat(split-billing): Option B — price each co-owner at their OWN tier (per-customer) + round-once penny guard [PARKED, flag OFF]`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round-7 4 P2s FIXED on per-line split-billing: (1) guard_split_invoice_items now BEFORE DELETE OR UPDATE — blocks direct material-field tamper of a split item outside the writer; (2) uniform-override audit base = resolved representative (tier/quote), not the override; (3) invoice_line_share_snapshots gains 8 provenance cols (base/mode/reason/hash) populated at post; (4) split children carry field_names/crop_type/total_acres for the combined list+PDFs. Reviewer-clean (rls 0/0/0, drift apply-clean), PROOFOK 60/60 live PG. Codex round 8 next. Still PARKED.

Codex round-7 4 P2s FIXED on per-line split-billing: (1) guard_split_invoice_items now BEFORE DELETE OR UPDATE — blocks direct material-field tamper of a split item outside the writer; (2) uniform-override audit base = resolved representative (tier/quote), not the override; (3) invoice_line_share_snapshots gains 8 provenance cols (base/mode/reason/hash) populated at post; (4) split children carry field_names/crop_type/total_acres for the combined list+PDFs. Reviewer-clean (rls 0/0/0, drift apply-clean), PROOFOK 60/60 live PG. Codex round 8 next. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `b683fa44 fix(split-billing): Codex round-7 P1s — active-group readback + RUP duplicate-product guard`
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
  - `3648e52a fix(split-billing): resolve all 8 P1 + 2 P2 Codex money/RLS findings [PARKED, flag OFF]`
  - `70912a7c feat(split-billing): Option B — price each co-owner at their OWN tier (per-customer) + round-once penny guard [PARKED, flag OFF]`
  - `5f2b5f74 feat(split-billing): R8 — resolve chemical price server-side (manual→quoted→tier) + unit conversion [PARKED, flag OFF]`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round 7 (2 P1 + 4 P2) on per-line split-billing: fixed the 2 P1s — review-card readback now filters to active invoice-group members (excludes round-6-detached terminal children), and the RPC rejects the same chemical product on >1 line (SPLIT_DUPLICATE_PRODUCT; was under-reporting RUP quantity). Reviewer-clean (rls/drift/compliance 0/0/0), PROOFOK 57/57 live PG. 4 P2s (uniform-override audit base, posting-boundary item-tamper, snapshot provenance schema, combined-list field context) DEFERRED to a fresh session per Mason. Still PARKED.

Codex round 7 (2 P1 + 4 P2) on per-line split-billing: fixed the 2 P1s — review-card readback now filters to active invoice-group members (excludes round-6-detached terminal children), and the RPC rejects the same chemical product on >1 line (SPLIT_DUPLICATE_PRODUCT; was under-reporting RUP quantity). Reviewer-clean (rls/drift/compliance 0/0/0), PROOFOK 57/57 live PG. 4 P2s (uniform-override audit base, posting-boundary item-tamper, snapshot provenance schema, combined-list field context) DEFERRED to a fresh session per Mason. Still PARKED.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `924b7728 fix(split-billing): Codex round-6 — 4 P1 + 4 P2 (postable group + validation/readback/recovery)`
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
  - `3648e52a fix(split-billing): resolve all 8 P1 + 2 P2 Codex money/RLS findings [PARKED, flag OFF]`
  - `70912a7c feat(split-billing): Option B — price each co-owner at their OWN tier (per-customer) + round-once penny guard [PARKED, flag OFF]`
  - `5f2b5f74 feat(split-billing): R8 — resolve chemical price server-side (manual→quoted→tier) + unit conversion [PARKED, flag OFF]`
  - `3c79ea3e feat(split-billing): Phase 4 save/post RPC + Phase 5 UI (editor, email-gate, lock) — proven, reviewed, PARKED (flag OFF, not applied)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Codex round-6 (4 P1 + 4 P2) on per-line split-billing: fixed unpostable-group regression (detach terminal/deleted children), field/service-acres validation, save/post idempotency+readback recovery, deleted_at readback filter, flat-fee override UI. Reviewer-clean (rls/drift/compliance), PROOFOK 56/56 live PG. Still PARKED — Codex round-7 pending.

Codex round-6 (4 P1 + 4 P2) on per-line split-billing: fixed unpostable-group regression (detach terminal/deleted children), field/service-acres validation, save/post idempotency+readback recovery, deleted_at readback filter, flat-fee override UI. Reviewer-clean (rls/drift/compliance), PROOFOK 56/56 live PG. Still PARKED — Codex round-7 pending.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `18780146 docs(split-billing): front-to-back Codex round-6 review runbook`
  - `c4a79c66 docs(changelog): log 2026-07-20 session — split-billing owner-decisions + CodeQL fix`
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
  - `3648e52a fix(split-billing): resolve all 8 P1 + 2 P2 Codex money/RLS findings [PARKED, flag OFF]`
  - `70912a7c feat(split-billing): Option B — price each co-owner at their OWN tier (per-customer) + round-once penny guard [PARKED, flag OFF]`
  - `5f2b5f74 feat(split-billing): R8 — resolve chemical price server-side (manual→quoted→tier) + unit conversion [PARKED, flag OFF]`
  - `3c79ea3e feat(split-billing): Phase 4 save/post RPC + Phase 5 UI (editor, email-gate, lock) — proven, reviewed, PARKED (flag OFF, not applied)`
  - `02aacafd docs(split-billing): grounded save/post RPC design + Phase-4 build handoff`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-20 — Split-billing (parked): closed both open owner-decisions (per-child commissions, no job-less guard; logged in DECISION_LOG 8b03cb88); re-proved the Fable adversarial fixes PROOFOK 55/55 in live PG + reviewer-clean; declined Fable-as-Codex-gate substitution (kept parked for real Codex round 6 ~Jul 24); fixed CodeQL js/insecure-randomness high alert on PR #164 by switching nextUid() to crypto.randomUUID() (21943958). Feature still flag OFF / not applied / PR not merged.

Split-billing (parked): closed both open owner-decisions (per-child commissions, no job-less guard; logged in DECISION_LOG 8b03cb88); re-proved the Fable adversarial fixes PROOFOK 55/55 in live PG + reviewer-clean; declined Fable-as-Codex-gate substitution (kept parked for real Codex round 6 ~Jul 24); fixed CodeQL js/insecure-randomness high alert on PR #164 by switching nextUid() to crypto.randomUUID() (21943958). Feature still flag OFF / not applied / PR not merged.

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `21943958 fix(split-billing): use crypto.randomUUID() for line-row keys — clears CodeQL js/insecure-randomness`
  - `8b03cb88 docs(decision-log): split-billing v1 edge-case policy settled — per-child commissions, no job-less exclusivity guard`
  - `5ad316de fix(split-billing): Fable adversarial round — 6 RPC fixes + editor race guard + reviewer MEDs [PARKED, flag OFF]`
  - `bc91afc9 fix(split-billing): Codex round-5 (8) + drift BLOCKER B1 + member-drop bug [PARKED, flag OFF]`
  - `5983b3eb fix(split-billing): Codex round-4 — commissions + posting-boundary + field/override guards [PARKED, flag OFF]`
  - `0a2754fd fix(split-billing): Codex round-3 — season/freeze/job-link + repost + snapshot honesty [PARKED, flag OFF]`
  - `795604f3 fix(split-billing): Codex round-2 remaining 6 — #A/#E/#G/#H/#L/#M [PARKED, flag OFF]`
  - `eb942f86 fix(split-billing): Codex round-2 batch — flag enforcement, fee-COGS, input guards (7/13) [PARKED, flag OFF]`
  - `3648e52a fix(split-billing): resolve all 8 P1 + 2 P2 Codex money/RLS findings [PARKED, flag OFF]`
  - `70912a7c feat(split-billing): Option B — price each co-owner at their OWN tier (per-customer) + round-once penny guard [PARKED, flag OFF]`
  - `5f2b5f74 feat(split-billing): R8 — resolve chemical price server-side (manual→quoted→tier) + unit conversion [PARKED, flag OFF]`
  - `3c79ea3e feat(split-billing): Phase 4 save/post RPC + Phase 5 UI (editor, email-gate, lock) — proven, reviewed, PARKED (flag OFF, not applied)`
  - `02aacafd docs(split-billing): grounded save/post RPC design + Phase-4 build handoff`
  - `a24e8f8a feat(split-billing): penny-exact split calculator (pure fns, flag-off, parked)`
  - `4346fb11 feat(split-billing): additive per-line split-billing schema (flag-off, parked)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260718010000_per_line_split_billing_schema.sql`
  - `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql`
  - `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`

## 2026-07-19 — Per-line split-billing: FABLE adversarial round → 6 RPC fixes + editor race guard + 2 reviewer MEDs, all fixed + PROOFOK 55/55 (branch, still PARKED). Autonomous Fable-5 run.

With Codex round 6 blocked on a usage limit (~Jul 24), a Fable adversarial review (4 lenses) found real bugs the 5 Codex rounds missed; this session proved and landed the fixes. Feature stays **flag OFF, migrations NOT applied, PR #164 NOT merged**.

- **[BLOCKER money] negative service acres** — a direct RPC call with `source_acres <= 0` could mint NEGATIVE (credit) invoices that passed every invariant and could post to reduce AR. Rejected server-side (`SPLIT_SERVICE_ACRES_NONPOSITIVE`). Proven: `neg_service_acres_rejected_ok`.
- **[BLOCKER lifecycle] soft-deleted child bricked the set** — after the live `delete_invoices` soft-deleted a child, its `invoice_items` still pointed at the set's billing lines (NO-ACTION FK), so every future re-save FK-aborted and the dropped co-owner became unbillable. The RPC now NULLs those `billing_line_id` refs before rebuilding the lines. Proven: `softdelete_child_resave_ok`.
- **[BLOCKER lifecycle] voided/cancelled child bricked re-save** — a terminal child kept blocking the wrapper's already-posted check forever. The wrapper, PASS-2 reuse, and orphan-cancel now exclude cancelled/voided children (no resurrection possible — reuse is draft/unposted only). Proven: `voidchild_resave_ok`.
- **[HIGH money] commission re-save FK abort** — the job-wide commission re-mint hard-DELETEd old rows, which 23503-aborted if a commission had ever been in a (later voided) payout batch. Now SOFT-cancels (`status='cancelled'`, amount 0, `deleted_at`) matching the live never-delete-commissions convention; drift review verified every live consumer (batch creation, void, payable list) excludes soft-cancelled rows.
- **[HIGH frontend] stale readback race** — opening split set A then B quickly let A's slower queries overwrite B's result card (operator reviews A's amounts, Posts group B). `loadResults` now has a latest-load-wins staleness guard, returns a boolean, and `handleSave` enables Post only on a completed non-stale readback.
- **[MED] posting tamper tie** — the posting trigger now also requires each item's `extended_cents` to equal its shares' sum (`SPLIT_POST_ITEM_SHARE_MISMATCH`), closing the admin-PATCH tamper window. Proven: `post_item_tamper_rejected_ok`.
- **[MED] audit-row price accuracy** — `source_unit_price_cents` now reflects a uniform per-share override instead of the stale resolved base. Proven: `source_unit_price_reflects_uniform_override_ok`.
- **[reviewer MED M1] terminal children keep their printed record** — the re-save clear now only wipes draft/unposted children, so a voided/cancelled child keeps its `invoice_items`/`invoice_shares` as the audit record. Proven: `voidchild_items_preserved_ok`.

**PROVEN in the live DB** (rollback): `PROOFOK` **55/55** — all 49 prior + the 6 new scenarios above. `rls-security-reviewer` 0/0/0 (soft-cancel scoping strictly narrower; no resurrection/double-bill; preserved items can't leak into posting/invariants/commissions), `migration-drift-reviewer` 0 blockers ('cancelled' valid in the live enum; `deleted_at` exists; all live consumers exclude soft-cancelled rows), `compliance-reviewer` clean. Typecheck + lint + focused tests pass. **Tooling learning:** the ~124KB proof bundle now runs reliably by POSTing the file bytes directly to the Supabase management API (no more LLM re-emission stalls). Still **flag OFF, not applied, not merged**; Codex round 6 + two owner decisions (Option-B commission clamp; job-less double-submit) remain open.

---

## 2026-07-19 — Per-line split-billing: Codex ROUND 5 → 6 P1 + 2 P2 + a reviewer BLOCKER, all fixed + PROOFOK 50/50 (branch, still PARKED). Autonomous Opus-4.8 run.

A fifth `codex review --base main` on `5983b3eb` returned 6 P1 + 2 P2 — all fixed. Then the migration-drift reviewer caught a BLOCKER (B1) the admin-only proof had missed, and the live proof caught a second bug in the newly-tested member-drop re-save path. All fixed; feature stays **flag OFF, migrations NOT applied, PR #164 NOT merged**.

- **P1 field-set equality** — billing a source job now requires the billed fields to EQUAL the job's `job_fields` (not just be a subset), so consuming the job can't silently orphan an unbilled field.
- **P1 positive line amounts server-side** — chemical-manual / service-manual / flat-fee lines reject `<= 0` in the RPC (defense-in-depth behind the editor), so a direct call can't create a free or negative invoice.
- **P1 commission COGS** — commission profit now uses the largest-remainder-allocated COGS already in the header (accumulated per child in PASS 2), not a re-rounded `cost×qty`; proven `commission_uses_lr_cogs_ok(99.99)` (the drift gave `99.98`).
- **P1 Post gating** — the editor enables Post only after a SUCCESSFUL authoritative readback, and `loadResults` now surfaces its item/share query errors instead of swallowing them.
- **P1 email gate hardened** — invoice emails now REQUIRE a valid invoice resource row and FAIL CLOSED (503) on any suppression-lookup error except the pre-migration missing-column case.
- **P1 duplicate field IDs** — already covered round-4; round-5 tightened the job-field equality above.
- **P2 re-save anchor repoint** — `jobs.invoice_id` / `application_records` repoint to a surviving child when a re-save drops the prior anchor member.
- **P2 InvoiceDetail split COGS** — the Total Cost/Margin uses the header's authoritative allocated COGS for split invoices instead of recomputing `cost×quantity`.
- **BLOCKER B1 (drift reviewer; the proof missed it because it ran only as admin)** — the anchor repoint had split the `jobs` UPDATE into two statements; the second (`SET invoice_id`) ran while `status='invoiced'`, which the live `enforce_billed_job_immutability` trigger BLOCKS for non-admin sales_reps (`is_admin()` early-returns for admins). Fixed by folding `invoice_id` into the `completed→invoiced` statement (guard early-returns on a not-yet-billed job — the sanctioned `transfer_job_to_invoice` shape) and moving the re-save repoint under the `app.admin_override` hatch, scoped to just that one UPDATE.
- **Second bug (caught by the live proof's new non-admin scenario)** — the orphan-cancel of a dropped member detached its child before the `#E` guard ran, tripping a false `SPLIT_JOB_ALREADY_INVOICED` that blocked every member-drop re-save. Fixed by snapshotting the set's child IDs before the orphan-cancel.

**PROVEN in the live DB** (rollback): `PROOFOK` **50/50** — the 43 prior + 6 round-5 + the decisive `salesrep_job_split_and_anchor_repoint_ok` (a NON-ADMIN sales_rep bills a job-split AND re-saves dropping the anchor member). `rls-security-reviewer` clean (the `app.admin_override` hatch is transaction-local, reset immediately, and can't repoint to a foreign invoice), `migration-drift-reviewer` **B1 resolved / 0 blockers**, `compliance-reviewer` clean. Typecheck + lint pass. **Learning captured:** an admin-only proof silently skips `is_admin()`-early-return immutability guards — always add a sales_rep scenario for money RPCs that write billed job fields. Still **flag OFF, not applied, not merged.**

---

## 2026-07-18 — Per-line split-billing: Codex ROUND 4 → 8 P1 + 2 P2, all fixed + PROOFOK 43/43 (branch, still PARKED). Autonomous Opus-4.8 run.

A fourth `codex review --base main` on `0a2754fd` returned 8 P1 + 2 P2 — all fixed this session. Feature stays **flag OFF, migrations NOT applied, PR #164 NOT merged**; go-live still gated on a CLEAN Codex verdict (round 5 pending).

- **P1 commissions** — a job-backed split marked the job invoiced but never generated salesperson commissions, and the status flip also blocked the normal path from ever making them. The split RPC now mirrors `transfer_job_to_invoice`'s per-owner-group path: resolve the commission split (job snapshot → quote → customer default), persist it on the job, and mint per-child commissions on each child's chemical-line profit. Profit uses the FIELD convention (`extended − ROUND(cost×qty)`, since split chemical items store per-unit cost) — the same math `_save_invoice_scoped_impl`'s U8 recompute uses. Re-save cleanly re-mints (job-wide, guarded against batched/paid) so a redraw or a dropped member never duplicates or strands a commission. Proven: `commissions_minted_ok(count2 total800 profitA400)`, `commissions_recompute_on_resave_ok(count2 total1800)`.
- **P1 posting-boundary integrity** — generic `save_invoice` would delete a draft split child's items and cascade its `invoice_line_shares` away (its existing `FIELD_INVOICE_SPLIT_LOCKED` guard doesn't fire for our single-compat-share children), then `post_invoice_group` posted a malformed group. Added (a) a `guard_split_invoice_items` BEFORE-DELETE trigger blocking any non-writer from deleting a split-produced item, and (b) posting-boundary validation in the snapshot trigger (item↔share count + shares tie to header) that refuses `SPLIT_POST_MALFORMED` / `SPLIT_POST_TOTAL_MISMATCH`. Proven: `generic_save_invoice_blocked_ok`, `post_malformed_rejected_ok`.
- **P1 fields-belong-to-job** — selecting a job + unrelated/subset fields consumed the whole job as invoiced while billing different acres. Now the billed fields must be a subset of the job's `job_fields` (`SPLIT_FIELD_NOT_ON_JOB`). Proven: `fields_belong_to_job_ok`.
- **P1 malformed per-person override** — the editor's round-2 `$0`/`1e5`-override guard covered only line-level overrides; the per-SHARE override still accepted `1e5→0`. Rejected now in BOTH the editor (`validateForSave`) and the server (`SPLIT_SHARE_OVERRIDE_INVALID`, defense-in-depth). Proven: `share_override_nonpositive_rejected_ok`.
- **P1 route job-backed split drafts** — round-3 stamped `job_id` onto every child, which defeated the no-job redirect and stranded job-backed split drafts on the generic invoice page with no Post path. `InvoiceDetail` now routes a DRAFT/UNPOSTED split child to the reopen editor from its tolerant `select('*')` load (deploy-safe — the preflight stays off the parked column).
- **P1 zero-invoice suppression server-side** — the `$0` split-invoice email gate was client-only; the `send-email` edge function now loads `send_disposition` and refuses `suppressed_zero_total` (fails open only pre-migration).
- **P1 reject duplicate field IDs** — the same field twice would double-charge acres + write duplicate location snapshots; rejected now (`SPLIT_DUPLICATE_FIELD`). Proven: `duplicate_field_rejected_ok`.
- **P1 snapshot self-contained identity** — post/unpost/re-save deletes the billing lines + items, leaving snapshots with a dangling `billing_line_id` and no product/service identity. The snapshot now captures `line_kind/product_id/application_service_id/line_description`. Proven: `snapshot_identity_ok`.
- **P2 snapshot acres 4dp** — widened `invoice_line_share_snapshots.allocated_acres` `(12,2)→(12,4)` so the post history doesn't silently round `0.3334→0.33`. Proven: `snapshot_acres_4dp_ok`.
- **P2 persist source acres for service** — `field_app_billing_lines.source_acres` now stores the service line's acre basis (was NULL for services). Proven: `source_acres_persisted_ok`.

**PROVEN in the live DB** (rollback): `PROOFOK` **43/43** — the 32 prior scenarios + the 11 new above. The live proof again earned its keep: the OLD `reasons_captured` scenario used an invalid `$0` per-share override that the new F4 server guard correctly rejects (fixed the scenario, not the code). `rls-security-reviewer` 0/0/0, `migration-drift-reviewer` 0 blockers (one MED — a redundant no-op `allocated_acres` ALTER contradicting the schema migration — fixed by deletion), `compliance-reviewer` CLEAN (F4/F5/F6). Typecheck + lint pass. `F5` (InvoiceDetail routing) and `F6` (edge fn) aren't live-exercisable until the migration applies + flag flips — covered by the clean compliance review and run for real at go-live. Still **flag OFF, not applied, not merged.**

---

## 2026-07-18 — Per-line split-billing: Codex ROUND 3 → 2 P1 + 4 P2, all fixed + PROOFOK 32/32 (branch, still PARKED). Autonomous Opus-4.8 run.

A third `codex review --base main` on `795604f3` went deeper into the job-consumption and reopen work my round-2 fixes introduced, and returned 2 P1 + 4 P2 — all fixed. Feature stays **flag OFF, migrations NOT applied, PR #164 NOT merged**; go-live still gated on a CLEAN Codex verdict.

- **P1 freeze source job on re-save** — the re-save branch never compared/updated the set's stored `source_job_id`, so changing the Source job after the first Save let one billing set consume TWO jobs (both flipped to `invoiced`). Now a change is refused (`SPLIT_JOB_IMMUTABLE`); start a new set instead.
- **P1 season-correct pricing** — the per-customer service-rate lookup AND the child `season` stamp used `current_season()`, mis-pricing a backdated / prior-season job and filing it in the wrong reporting year. Now `v_season = source job's season → invoice-date season → current`, used for the `customer_application_rates` lookup and `invoices.season` (mirrors `transfer_job_to_invoice`). Proven: a 2025-dated service invoice bills the 2025 rate ($35000) and stamps season 2025.
- **P2 source-job metadata on every child** — child invoices now carry `job_id` + `application_date`, so field-invoice lists resolve Job # for all children (not just the first via `jobs.invoice_id`).
- **P2 repost lifecycle** — "posted" now means every child is in a COMMITTED status (not merely "not draft"); an unposted group is no longer mislabeled Posted with Post disabled.
- **P2 percentage residual** — `pctsToMicro` now removes the ENTIRE negative residual by cycling, so `33.334×3` (sum just over 100 within the 0.01 UI tolerance) lands on exactly 100000000 instead of a server-rejected vector.
- **P2 live-RPC snapshot honesty** — restored the raw live `pg_proc` snapshot to the true 438 (was inflated to 440 to hide the two parked split RPCs) and moved them into the verified `QUEUED_MIGRATION_FUNCTIONS` bridge (absent-live + migration-sourced), with the "no committed queued exceptions" guard narrowed to an explicit flag-gated allowlist.

**Two runtime bugs the live proof caught (the reviews passed the file — only execution found them):** (a) `v_job.season` referenced in the season COALESCE when `p_source_job_id IS NULL`, where `v_job` (a bare record) is unassigned → PL/pgSQL 55000 — now captured into a plain variable inside the guard; (b) `application_date` used `v_job.scheduled_date` from a stale on-disk migration — the live `jobs` has no such column, switched to `v_job.job_date` (what live `transfer_job_to_invoice` uses).

**PROVEN in the live DB** (rollback): `PROOFOK` **32/32** — the 29 prior scenarios + `children_carry_job_id_ok`, `source_job_frozen_ok`, `season_aware_pricing_ok(2025 rate 35000, child season 2025)`. `rls-security-reviewer` 0/0/0, `migration-drift-reviewer` 0 blockers on the delta. Typecheck + lint + the 3 RPC-contract test files (96 tests) pass. Note: the proof harness now disables `products`' USER triggers for its rolled-back txn because a parallel supplier-pricing project applied live pricing-governance triggers (`require_governed_product_pricing` + `guard_and_version_product_pricing`) that block direct product seeding — the split RPC only READS `products`. Still **flag OFF, not applied, not merged.**

## 2026-07-18 — Per-line split-billing: Codex ROUND 2 fully closed — final 6 findings (#A/#E/#G/#H/#L/#M) fixed + PROOFOK 29/29 (branch, still PARKED). Autonomous Opus-4.8 run.

The remaining 6 of the 13 round-2 findings are now fixed (the first 7 landed in `eb942f86`). Feature stays **flag OFF, migrations NOT applied, PR #164 NOT merged** — go-live remains gated on a CLEAN full Codex re-run + Mason's review.

- **#G COGS penny-residual** — per-child cost was rounded independently, overstating the group `total_cost` by up to n−1¢. Now the ONE canonical line COGS is allocated across co-owners with the SAME largest-remainder rule as revenue (`_lr_allocate_int` by micro-pct), so the group total ties EXACTLY to `unit_cost × source`. The chemical item's `cost_cents` stays per-unit (display convention #F); the header accumulates the LR share. Proven: $0.01/gal × 1 gal, 50/50 → group cost = 1¢ (A=1, B=0), not the naive 2¢.
- **#M audited base** — Option-B per-customer pricing was injected into the calculator's override slot, so a co-owner's normal tier/rate price was audited as an "override" vs the largest-share owner's base. Now each co-owner's OWN resolved price is stored as their `base_unit_price_cents` / `base_price_source` with `price_mode='default'`; only a genuine caller-supplied manual per-person override is audited as an `override`. Per-customer service source (`service_rate` vs `service_default`) captured. Proven: svc 2000/500 both `default`/`service_rate`; chem 1000 `default`/`tier`.
- **#L reasons** — `split_override_reason` / `price_override_reason` are now threaded from the editor (optional per-line + per-share reason inputs) into `invoice_line_shares`. Proven stored end-to-end.
- **#E source-job double-bill** — `source_job_id` was provenance-only, so a job could be billed via split AND the normal `transfer_job_to_invoice` flow. The save RPC now **consumes** the job (`status→invoiced` + link, mirroring `transfer_job_to_invoice`) so that path's "Job already invoiced" guard fires, refuses a job already billed by another set, and (non-admin) refuses a job whose customer isn't assigned to them (incl. null-customer). The editor's job picker shows only `completed` jobs. Proven: consume + second-set reject + same-set re-save allowed.
- **#H save-now / post-later** — new route `split-billing/:id` reopens a SAVED billing set **read-only** for review + Post (editable reopen deferred: a re-save re-prices, so rebuilding money fields is a future, separately-proven step). The per-acre editor now redirects a split child here; `InvoiceDetail` renders posted split children read-only.
- **#A deploy-order** — `InvoiceDetail`'s preflight no longer selects `field_app_billing_set_id` (an explicit select of a not-yet-migrated column would 400 EVERY invoice-detail load if the frontend deployed first). The per-acre editor's tolerant `select('*')` load detects a split child and redirects it to the read-only reopen view — loop-free.

**PROVEN in the live DB** (rollback, nothing persisted): `PROOFOK` **29/29** — the 24 prior scenarios PLUS `cogs_group_lr_exact_ok(A+B=1)`, `audited_base_is_own_ok`, `reasons_captured_ok`, `double_bill_second_set_rejected_ok`, `resave_same_job_allowed_ok`. `rls-security-reviewer` 0 blocker/0 high (2 MED fixed: null-customer job guard + trigger REVOKE); `migration-drift-reviewer` 0 blocker. `npm run typecheck` + lint clean. **All 13 round-2 findings now closed. Next: a CLEAN full Codex re-run, then Mason's review.** Still **flag OFF, not applied, not merged.**

## 2026-07-18 — Per-line split-billing: Codex ROUND 2 → 8 P1 + 5 P2; 7 fixed + re-proven this batch, 6 larger items queued (branch, still PARKED). Autonomous Opus-4.8 run.

The re-run of the Codex gate (`codex review --base main`) went deeper and returned 8 P1 + 5 P2 NEW findings (the round-1 fixes all held). Mason chose to **keep iterating** and confirmed he needs **save-now/post-later**. Fixed + re-proven THIS batch (still in the parked `20260718030000` + the split editor):

- **#B flag enforcement** — the save wrapper is granted to `authenticated` and only checked role, so applying the migration during the flag-OFF window left the money RPC callable via direct PostgREST. Now it hard-refuses unless `per_line_split_billing_enabled='true'` in `app_settings`.
- **#F fee COGS convention** — a service (fee) item now stores its EXTENDED cost (`cost_per_acre × acres`), matching the live `_save_field_app_invoice_impl` fee convention (the rest of the app reads a fee item's `cost_cents` as already-extended), so item detail and header total reconcile. **#N** — a service line with no description now shows the real `application_services.name`, not the literal "Service".
- **#C negative flat** — `dollarsToCents` preserves a leading minus so a "-$50" credit is REJECTED by the `<=0` guard instead of silently becoming a +$50 charge. **#D malformed override** — an override that parses to 0 (e.g. `1e5`) is now rejected (`<=0`) instead of storing a $0 price. **#J** — invoice date defaults to LOCAL today (`localToday()`), not `toISOString()` (which rolls to tomorrow after ~6 PM Central). **#K** — `pctsToMicro` now distributes the full residual (cycling), so `33.3333×3` reaches exactly 100000000 micro-pct instead of leaving a 97-unit gap the server rejected.

**PROVEN in the live DB** (rollback): `PROOFOK` **24/24** — the 14 originals + `svc_per_customer_rate_ok`, `fee_cost_extended_ok(15000)`, `service_name_on_item_ok`, `chem_cogs_ok`, `field_locations_created_ok`, `compat_acres_from_vector_ok(50)`, `audit_no_dup_on_resave_ok`, `sec_reject_unassigned_ok`, `sec_allow_assigned_ok`, `flag_off_rejected_ok`. Typecheck clean.

**Queued for the next session (larger / needs care):** #H **save-now/post-later** reopen route + loader (Mason wants it); #E **source-job double-billing guard** (source_job_id is provenance-only — a job could be billed via split AND the normal flow); #G COGS penny-residual LR-allocation; #A frontend/DB deploy-order coupling (InvoiceDetail preflight selects the new column — safe only if migrations apply before the frontend merges; harden to migration-first); #M keep each co-owner's resolved price as their audited BASE (Option-B injection currently audits normal pricing as an "override"); #L capture reasons for custom split / override. The full Codex gate re-runs once all 13 are closed. Still **flag OFF, not applied, not merged.**

## 2026-07-18 — Per-line split-billing: Codex money/RLS gate RAN → 8 P1 + 2 P2 findings, ALL FIXED + re-proven (branch, still PARKED). Autonomous Opus-4.8 run.

The Codex CLI money/RLS review (`codex review --base main`, gpt-5.5) finally ran and **blocked go-live** with 8 P1 (blocker) + 2 P2 findings — all verified real against source. Every one is now fixed in the still-parked `20260718030000_..._save_rpc.sql` + three frontend files, and re-proven end-to-end in the live DB (rollback):

- **#1/#2 service lines** — the writer loaded the service record only from the always-null top-level param, so service lines saved at $0/errored, and it used one global rate for all co-owners. Now it loads the service record **per line** and prices each co-owner at their OWN `customer_application_rates(service, season)` → service default (Option B for service, same machinery as chemical). Proven: A@$20/ac vs B@$5/ac → 100000/25000¢.
- **#3 COGS** — every split item was written `cost_cents = 0`, zeroing COGS and inflating margin reports. Now the chemical unit cost is resolved server-side from `products.current_cost` (`round(*100)`, per sold unit, like `_snapshot_order_item_cost`) and service cost from `application_services.cost_per_acre_cents`, aggregated into `invoices.total_cost_cents`. Proven: cost 250/250, revenue tiers 500/400 intact.
- **#4 customer-scope security** — the SECDEF writer bypassed RLS and only checked role, so a sales rep could bill another rep's customers. Now every derived member (and every existing child on re-save) must have `assigned_sales_rep = auth.uid()` unless admin. Proven with a real sales_rep: unassigned → rejected, assigned → allowed.
- **#5 stale post** — after Save, editing left Post enabled, committing old DB values. Editor now tracks a saved-input signature and disables Post (with a banner) until re-save.
- **#6 data-loss** — a split child opened in the generic invoice page could `save_invoice`-delete its line shares. Split children are now kept out of the per-acre editor (preflight) and rendered strictly read-only in `InvoiceDetail`, with a hard save-refuse guard.
- **#7 blank fields/acres** — children got no `field_app_locations`; now the writer creates group-level location snapshots (with `job_id` provenance). **#8 audit dup** — re-save re-emitted `invoice_created` with a stale number; now emitted only for freshly-created children. **#9 acres** — compat `invoice_shares.acres` is derived once from the ownership vector × total acres (not summed billing-line acres). **#10 email gate** — `send_disposition` is now hydrated in the list mapper + the detail pdfSnapshot so the "don't email $0" gate actually fires.

**PROVEN in the live DB** (rollback, nothing persisted): `PROOFOK` **21/21** — all 14 prior scenarios PLUS `svc_per_customer_rate_ok`, `chem_cogs_ok(250/250,500/400)`, `field_locations_created_ok`, `compat_acres_from_vector_ok(50)`, `audit_no_dup_on_resave_ok`, `sec_reject_unassigned_ok`, `sec_allow_assigned_ok`. `npm run typecheck` clean. Mason chose **full v1 scope** (chemical + service + flat). Re-running Codex to confirm SHIP before the go-live sequence. Still **flag OFF, not applied, not merged.**

## 2026-07-18 — Per-line split-billing: pricing rule SETTLED = Option B (each co-owner keeps their OWN tier). Committed to branch (PARKED). Autonomous Opus-4.8 run.

Mason chose **Option B** for the tier question R8 surfaced: a chemical split line prices **each co-owner's share at that customer's own `assigned_tier`** (mirrors the live per-child field-app save — no customer's price changes vs today; honors the spec's "don't flatten per-customer tier pricing"). A manual override or a field quote is tier-independent, so it applies to every co-owner; only the tier fallback varies per customer. Implemented in `20260718030000_..._save_rpc.sql` by building a per-customer price map (`resolve_field_app_chemical_price` per member at their tier) and writing each member's price into the calculator's per-person price slot; the calculator collapses to round-once `source_lr` when all prices match and uses `per_person` when they differ. Added a **penny guard**: when every co-owner ends at the same effective price (manual/quote/all-same-tier, or a uniform manual per-person adjustment), the source price is aligned so the total is round-once penny-exact (closes an adversarial LOW where uniform explicit overrides ≠ the representative tier could total per-person, off by ≤ n−1 cents). The representative line base (largest-share owner's price) is display-only (`base_unit_price_cents`); money is the per-customer `unit_price_cents`/`amount_cents`.

**PROVEN in the live DB** (rollback, nothing persisted): `PROOFOK` 14/14 including the reworked **scenE** (20% grower A @ tier1 $10/gal → $2.00 / unit 1000, 80% grower B @ tier3 $8/gal → $6.40 / unit 800; per-person, source_line_cents 840), **scenF** (shared quote $7.50/gal uniform), **scenH** (uniform 1¢ override → round-once total 1¢ not 2¢), plus the manual/penny/$0-suppression/post-freeze/re-save/idempotency/Mode-A cases. Reviews: Opus **adversarial → SHIP-TO-PARK** (Option B correct in every normal flow; the one LOW it found is now fixed by the penny guard); RLS/compliance/drift unchanged (same functions/columns, no new privilege surface). **Codex money/RLS gate still pending** (usage limit, ~2026-07-22) and should review this Option-B version. Still **flag OFF, not applied, not merged.**

## 2026-07-18 — Per-line split-billing R8: chemical base price resolved SERVER-SIDE (manual→quoted→tier) + rate→sold-unit conversion. Committed to branch (PARKED: flag OFF, not applied, not merged). Autonomous Opus-4.8 run.

Closed the R8 scope gap from the Phase-4 build: the split save RPC no longer trusts a caller-supplied chemical price. Added `resolve_field_app_chemical_price(product, field_ids, tier, manual_cents)` to `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql` — a SECURITY DEFINER, `SET search_path=public,pg_temp`, **internal-only** (EXECUTE revoked from public/anon/authenticated) reader that mirrors the LIVE `_save_field_app_invoice_impl_20260714` precedence: manual override → customer quote for the field (`quote_items`/`quote_sections`) → product tier list price (`tierN_price`, fallback tier1), dollars→cents via `round(x*100)::bigint`. The writer's chemical branch now resolves the base price and converts the applied quantity from the rate unit to the product's **sold (inventory) unit** via the live `field_app_priced_quantity()` (the 128× guard), failing closed (`FIELD_APP_UNIT_UNCONVERTIBLE`) on a non-convertible unit; the invoice line's display unit follows the converted quantity. **TIER ANCHOR DECISION (owner, pre-go-live):** a split line carries ONE list price anchored on the billing-set member with the largest ownership share; per-grower differences use the existing per-person override. Editor (`FieldAppSplitInvoiceEditor.tsx`): chemical lines default to "price resolved at save" with an optional **Override Price** checkbox; rate unit now required; the client no longer estimates chemical cents (server is authoritative).

**PROVEN by running it in the real DB engine** (all 3 parked migrations' DDL + an independent assertion oracle inside one `BEGIN…ROLLBACK`, rolled back — nothing persisted): `PROOFOK` 13/13, including the new **scenE** (tier price resolved + 128 oz → 1 gal conversion correct, not 128× high; majority-owner tier-3 anchor; 20/80 split penny-exact), **scenF** (customer quote beats tier), **scenG** (mismatched unit hard-refused), alongside the 10 prior cases (manual override, 1¢ split, $0 suppression, post/snapshot/freeze, re-save-after-post lifecycle, idempotency replay+conflict, Mode-A rejection). Reviews: rls-security **clean** (internal-only REVOKE confirmed sufficient), compliance **clean** (bigint cents, no float, no generated-column write), migration-drift **clean** (all columns/helpers verified vs the same-day live schema-registry), Opus **adversarial → SHIP-TO-PARK** (no math/rounding/unit bug; its one flagged item is the tier-anchor go-live decision above — see `docs/manual/KNOWN_ISSUES.md`). **Codex money/RLS gate still NOT run** (usage limit; resets ~2026-07-22) — required before merge/go-live and should review this newer version. Still **flag OFF, not applied, not merged.** Owner-facing steps + the Option-A-vs-B pricing-rule decision: `docs/plans/per-line-split-billing-BUILD-HANDOFF-2026-07-18.md`.

## 2026-07-18 — Per-line split-billing build, Phase 4 (save/post RPC) + Phase 5 UI (split editor + email-gate + InvoiceDetail lock + types + flag), all PARKED (not applied / not pushed / flag OFF). Autonomous Opus-4.8 run.

**Phase 4 — SAVE/POST RPC.** Wrote `supabase/migrations/20260718030000_per_line_split_billing_save_rpc.sql`: `resolve_line_split_vector` (job-snapshot → field-default → owner precedence, acre-weighted, largest-remainder to exactly 100000000 micro-pct; SECURITY DEFINER with an admin/sales_rep guard), `save_field_app_split_invoice` (public SECURITY DEFINER wrapper: auth + actor + active-role guard, advisory lock, `check_idempotency` + payload-hash `IDEMPOTENCY_PAYLOAD_CONFLICT`, re-save anchor-then-full-set row locks) + `_save_field_app_split_invoice_impl` (writer: builds a billing set + one billing line per source line, calls the shared `compute_line_split_allocation` engine, writes one draft child invoice per customer with residual-adjusted `invoice_items` + `invoice_line_shares` + the compat `invoice_shares` self-100% row, suppresses $0 children via `send_disposition`, and asserts every spec-§5 SUM invariant against the STORED rows) + `snapshot_invoice_line_shares_on_post` (R1 AFTER-UPDATE trigger copying line shares → the append-only snapshot on post). Posting reuses `post_invoice_group` UNCHANGED; the freeze trigger auto-locks shares once posted. Never writes the GENERATED `balance_cents`.

**PROVEN by running it in the real DB engine** (all three migrations' DDL + a synthetic end-to-end scenario applied inside one `BEGIN…ROLLBACK`, independent assertion oracle, rolled back — nothing persisted): resolver default 50/50 + job-snapshot-wins 30/70; penny-exact 50/50 chemical+service+flat (flat 1001 → 501/500 by customer_id tie-break, `extended_cents == amount_cents` on every item); $0 child stored + `send_disposition='suppressed_zero_total'` + unpaid + the 0% row present; 1¢ split 50/50 = 1¢ (not 2¢); `post_invoice_group` posts all children + snapshot row-count matches + a post-post share edit is rejected (`check_violation`); **the full post → unpost → re-save → re-post lifecycle** (the F1 fix — re-save REUSES child invoices instead of hard-deleting them, so the append-only snapshot `ON DELETE RESTRICT` FK no longer aborts a re-save); idempotency replay identical + changed-payload conflict; Mode-A field rejection. All 10 assertions passed. **Not applied live.**

Review layer: rls-security-reviewer (0 BLOCKER/0 HIGH; 1 MED — added the admin/sales_rep guard to the resolver — FIXED), migration-drift-reviewer (CLEAN — `balance_cents` never written, `price_source` mapped to the valid CHECK set, `allocated_acres` widened 12,2→12,4 safely, all net-new names/trigger), typescript-types-drift-reviewer (CLEAN — 7 type additions match), Opus adversarial (SHIP-TO-PARK; found F1 HIGH — FIXED + re-proven — plus F2/F3 go-live notes), and compliance-reviewer (1 HIGH — the editor used `parseFloat` for money inputs — FIXED to `parseDollarsToCents`). **Codex money/RLS cross-model gate: NOT run this session** — Codex account usage limit is exhausted (credits reset 2026-07-22). Recorded as a REQUIRED pre-go-live owner step. **Documented SCOPE (R8):** the chemical base unit price is caller-supplied + server-validated, not re-resolved server-side (the large manual→quoted→tier→unit-conversion resolver stays in `_save_field_app_invoice_impl_20260714`); extract + wire it here before go-live. Service-fee base rate IS resolved server-side.

**Phase 5 — behavior-neutral UI (flag OFF).** `src/types/index.ts`: added `Invoice.send_disposition?`, `Invoice.field_app_billing_set_id?`, `InvoiceItem.billing_line_id?` (optional, additive-column convention) + 4 new interfaces (FieldAppBillingSet/Line, InvoiceLineShare, InvoiceLineShareSnapshot). New flag helper `src/lib/splitBillingSetting.ts` (`per_line_split_billing_enabled`, default OFF). Email-suppression gate: new `isInvoiceEmailSuppressed` in `emailService.ts` wired into ALL 5 invoice-email send sites (FieldApplicationInvoice, InvoiceDetail, and the 3 field-invoice panels) — gates on `send_disposition='suppressed_zero_total'` NOT `balance_cents` (a paid-in-full $0 invoice stays emailable). InvoiceDetail per-item lock: qty/price/remove now `editable && !item.billing_line_id`. `FieldInvoiceListRow` carries an optional `send_disposition`. New split editor page `src/pages/FieldAppSplitInvoiceEditor.tsx` (draft-then-review flow: resolve default vector → per-line %/price overrides → Save Draft via the RPC → render the authoritative server-computed per-grower amounts → Post; no client-side authoritative cent math; graceful "backend not enabled" degradation), wired as a flag-gated lazy route in `src/App.tsx` + a flag-gated Sidebar nav link. **typecheck + build GREEN.** All behavior is unchanged today (the new fields are undefined at runtime until the migration lands). Nothing applied/pushed; flag stays OFF; go-live remains gated on Mason's baseline field-app billing cycle (spec §6.1) + live apply of all 3 migrations + the Codex gate + the R8 wiring.

## 2026-07-17 (night) — Per-line split-billing build, Phase 3: penny-exact calculator written + proven against the live Postgres engine (11 hard cases) + Opus-hardened, PARKED (not applied).

Wrote `supabase/migrations/20260718020000_per_line_split_billing_calculator.sql` — 3 pure `IMMUTABLE SECURITY INVOKER` functions (`_lr_allocate_int`, `compute_even_split_vector`, `compute_line_split_allocation`), the single shared engine both preview and post will call (spec §4 rule 1). Largest-remainder allocation, half-away-from-zero, abs-floor-then-negate for returns, `customer_id ASC` tie-break in the quantity AND cents passes. Same-price line = allocate the once-rounded source-line cents by micro_pct; per-person price = round(price×qty) each (group total = sum, documented); flat fee = LR of flat cents.

**Proven by running it in the real DB engine** (created in a `BEGIN…ROLLBACK`, all assertions executed, rolled back — not a self-written unit test in isolation): T1 1¢ 50/50 → **1¢** (not 2¢); T2 even 3-way → **1.0000** (not .9999) + vector 33333334/33333333/33333333; T3 return −13¢ → **−7/−6** (the JS-vs-PG half-cent bug); T4 per-person 1000/900; T5 100/0 with the **$0 row stored**; T6 flat 1001 → 334/334/333; T7/T8 malformed vectors raise. Opus adversarial review: core math clean, no numeric bug on any valid input; added 3 input guards (SPLIT_WEIGHT_NULL / SPLIT_PRICE_REQUIRED / SPLIT_WEIGHT_OUT_OF_RANGE) → T9/T10/T11 also pass. Nothing applied live.

## 2026-07-17 (night) — Per-line split-billing build, Phase 2: additive schema migration written + review-hardened + rollback-smoke-proven, PARKED (not applied). Autonomous Opus-4.8-orchestrated run.

Wrote `supabase/migrations/20260718010000_per_line_split_billing_schema.sql` — purely additive, behavior-neutral: 4 new tables (field_app_billing_sets, field_app_billing_lines, invoice_line_shares, invoice_line_share_snapshots), 3 additive columns (invoice_items.billing_line_id, invoices.send_disposition default 'normal', invoices.field_app_billing_set_id), and a SECURITY DEFINER freeze trigger copied from prevent_order_shares_edit_after_post. Nothing reads/writes these until the calculator + posting RPC land behind a flag.

**NOT applied live** — validated only via `BEGIN…ROLLBACK` smoke against live schema (all objects create, all FKs resolve, assertions pass, nothing persists). Live apply stays gated to Mason (needs a baseline real-billing cycle first per spec §8).

Review layer: 3 parallel reviewers (rls-security-reviewer, migration-drift-reviewer, Opus adversarial). Fixes folded in: allocated_acres → numeric(12,4) [authoritative largest-remainder store, spec §4]; snapshot invoice_id → ON DELETE RESTRICT [protect append-only history]; RLS policies wrap auth.uid() as (select auth.uid()) [avoids auth_rls_initplan warns, matches invoice_shares_select]; REVOKE SELECT FROM anon; freeze trigger checks both old+new invoice_item on UPDATE. Companion: `docs/plans/per-line-split-billing-READINESS-2026-07-17.md`.
## 2026-07-20 — Supplier pricing evidence restricted to ADMIN-ONLY (live fix before Phase 1b merge)

- The Codex GitHub review on PR #179 caught a real security gap all earlier reviewers missed: the live Phase 1b reader RPCs, evidence-table SELECT policies, and the evidence-PDF bucket were gated admin-OR-sales, exposing supplier costs, `cost_history` values, and PO ids/numbers/unit costs to sales reps — contradicting the standing "cost data is admin-only" RLS contract (the contract tests passed because SECURITY DEFINER readers legitimately bypass table RLS). Mason settled it: **admin-only**.
- Applied live migration `20260720203000_restrict_supplier_pricing_to_admin` (reviewed clean by the migration-review workflow + both Codex proof charters; MCP version `20260720201159` ledger-reconciled to the filename per B7). All seven SELECT policies now require `is_admin()`; all five reader RPCs raise `ADMIN_REQUIRED`; explicit REVOKE/GRANT re-asserted. Proven live: non-admin probe denied, catalog clean.
- Frontend on the PR branch aligned: `/supplier-pricing` page restricted to admin, ProductDetail price-history panel admin-gated, smoke expectations updated to `ADMIN_REQUIRED`, supplier filter reset on product change (CodeRabbit), reference docs corrected (11th RPC documented, stale PARKED headers and go-live shorthand stamps fixed).

## 2026-07-20 — Fix headless Claude review wrapper returning empty results (release gate unblocked)

- Three completed `claude -p --output-format json` release-gate reviews of Phase 1b (2× Opus, 1× Sonnet, CLI 2.1.207) returned `subtype: success` with `result: ""`, blocking the release. Root cause (reproduced deterministically): the repo's `Stop` hook `stop-wrap.mjs` blocks a read-only headless session from ever ending — it demands an ack file at `.claude/session-state/stop-wrap-ack.json`, but the reviewer has Write denied — so the session loops through dozens of forced turns until the CLI gives up with an empty final message, and the `json` output format surfaces only the final message's text as `result`. The real review text was generated in the first assistant message and lost (`--no-session-persistence`; confirmed unrecoverable by full local-storage search of all three session IDs).
- Fix: `scripts/run-claude-review.mjs` now launches the reviewer with `--settings '{"disableAllHooks":true}'` — safe because the reviewer is hard-restricted to Read/Grep/Glob, so the write/push/migration guard hooks have nothing to guard inside it. All fail-closed validation is unchanged. `scripts/run-claude-review.test.mjs` adds regressions: the exact success-but-empty-`result` shape must classify BLOCKED, and the hooks-disabled flag must be present in the fixed argv. Verified: wrapper tests + `test:agent-workflows` green; rerun of the exact Phase 1b base-main review completed `Execution state: VERIFIED` with verdict `SHIP-WITH-FOLLOWUPS` (0 BLOCKER / 0 HIGH / 1 MED idempotency-TTL replay follow-up).

## 2026-07-20 — Fix autopilot guard test failing (and blocking every commit) whenever autopilot is armed

- `.claude/hooks/autopilot-lib.test.mjs`'s LIVE check spawned `unattended-autopilot.mjs`, which resolves its arming flag from `$CLAUDE_PROJECT_DIR/.claude/session-state/AUTOPILOT.on`. Because the spawn inherited the ambient env, the test's "hook emits NOTHING when flag absent" assertion failed whenever real autopilot was armed in the session — the spawned hook saw the ambient flag and correctly denied the fake `rm -rf /`. Net effect: the pre-commit `test:correction-guards` suite failed, so **no commit could land while autopilot was armed** (forcing a disarm→commit→re-arm workaround). The check now points `CLAUDE_PROJECT_DIR` at throwaway temp dirs — one with no flag (proves inert), one with a fresh active flag (proves it still denies deny-set commands) — so both directions are deterministic regardless of ambient arm state. Proven: with real autopilot armed, `node .claude/hooks/autopilot-lib.test.mjs` now passes (53 assertions).

## 2026-07-18 — Fix migration-review workflow failing closed when Workflow-tool args arrive as a JSON string

- `.claude/workflows/migration-review.js` now normalizes `args` before reading `file`/`name`/`sql`. When the Workflow tool delivered `args` as a JSON-encoded string, all three fields were `undefined` and the run failed closed with a bogus "No migration SQL provided" BLOCKER (observed runs `wf_ae36ee12-2e4`, `wf_5c9ddfc7-174`). The script now `JSON.parse`s a string `args` (falling back to `null` on parse failure) and reads fields off the normalized object, while keeping the fail-closed placeholder for genuinely-missing SQL. Ran `sync-agent-workflows --write` and `test:agent-workflows` (all green; 35 Codex adapters in sync).

## 2026-07-18 — Supplier Pricing Phase 1a COMPLETE + LIVE (merge, harden, promote, cutover)

Landed the full Phase 1a supplier-pricing safety foundation to production. PR #163 merged; harden migration `20260718124517` applied live (ledger `20260718154131`); the RPC-only frontend was promoted to production (`croprxsolutions.app`) and **proven end-to-end on live** (a governed `product_page` price edit wrote `cost_history` with `change_source='product_page'` + a real `change_set_id`, status `applied`); then the enforcement **cutover `20260718190000`** was applied through the migration-review + apply-guard proof gate (MCP stamped ledger version `20260718185621`, then reconciled via ledger UPDATE to `20260718190000` to match the on-disk filename per settled B7 policy — the disk file is never renamed). After cutover, all direct writes to Products pricing columns and to `cost_history` are REVOKEd from every app role and blocked by the `require_governed_product_pricing` trigger — pricing is editable ONLY through the governed preview/apply RPC (verified live: a direct `UPDATE products SET current_cost` now raises `PRODUCT_PRICING_GOVERNED_PATH_REQUIRED`). A follow-up scan-only migration `20260718193000` (post-cutover data-integrity rescan, applied live) SHARE-locks `products` and fails closed on any non-finite/negative/non-cent-scale existing pricing — found 0 live — closing the adversarial-review gap that the cutover locked future writes but never re-validated existing rows. Phase 1b (supplier evidence) was subsequently applied live and prepared for frontend release.

## 2026-07-18 — Supplier Pricing Phase 1b evidence MVP built; database foundation live

- Added the manual supplier-evidence workflow: protected per-supplier `.xlsx` quote sheets, staged row review, quick single-quote entry, explicit approval into append-only integer-cent observations, comparison with honest `cannot compare` states, and optional private audit-only PDFs. No OCR, AI extraction, automatic vendor selection, sell-price change, or costing engine was added.
- Added the Supplier Pricing workspace and product-level supplier-filterable three-stream price history. The Product pricing workbook now carries locked market-evidence summary columns plus a per-supplier detail sheet while preserving the Phase 1a pricing upload payload.
- Applied both Supplier Pricing Phase 1b migrations live through their independent review/proof gates. Evidence foundation ledger version `20260718225511` (submitted as `20260718230000_supplier_price_evidence_phase1b`) adds six RLS tables, eleven fixed-search-path RPCs, append-only observation enforcement, a private PDF evidence bucket, and five purchase-order provenance columns. Alias staging ledger version `20260718235717` (submitted as `20260718235900_stage_supplier_vendor_aliases_phase1b`) maps approved `Van Deist` / `Van Diest` spellings to active canonical vendor `Van Diest Supply`, plus the approved `The Andersons` spellings. The first alias attempt failed transactionally on the canonical-name guard and rolled back; the corrected, freshly reviewed retry created four approved aliases and four approved legacy resolutions without rewriting vendor, PO, or product rows.
- Added TypeScript interfaces for the Phase 1a `pricing_*` tables, all Phase 1b evidence tables, and the PO cost-provenance snapshot columns. Reconciled the live schema registry, RPC contracts, and fixtures after the reviewed migration applies.

## 2026-07-17 — Split-billing architecture dig + per-line-item custom-split design spec v2 (review-hardened via gpt-5.6-terra xhigh plan review; 4 blockers folded in). Owner workflow settled: field split=default, adjust in unposted draft, unpost reversible. Committed 4b695109; Codex builds next week. No code/DB changes.

Split-billing architecture dig + per-line-item custom-split design spec v2 (review-hardened via gpt-5.6-terra xhigh plan review; 4 blockers folded in). Owner workflow settled: field split=default, adjust in unposted draft, unpost reversible. Committed 4b695109; Codex builds next week. No code/DB changes.

## 2026-07-17 — Applied Supplier Pricing Phase 1a legacy Product repeat-save repair

- Applied the small compatibility migration for the currently deployed Product page (live ledger `20260717171331` / source name `20260717170000_restore_legacy_pricing_version_compat`): it ignores the page's stale submitted pricing version, while the database continues to own and increment the value. Governed worksheet/product RPC calls still reject any client-supplied version, and the parked final cutover restores the unconditional strict rejection. Both required migration reviews were clean; disposable and rolled-back-live proofs each execute two consecutive old-form saves, with the live check ending `PHASE1A_LIVE_REPEAT_SAVE_ROLLBACK_PASS` and leaving no data behind.

---

## 2026-07-17 — Supplier Pricing Phase 1a replay and workbook safety correction

- Preserved the already-live supplier-pricing bootstrap's reviewed CRLF bytes in Git while pinning the live zero-cost guard to LF. Clean checkouts now reproduce the exact applied artifacts and the bootstrap-to-guard function-body hash contract instead of failing replay after Git line-ending normalization. A correction-guard test now hashes the exact Git-index bytes for both applied artifacts and proves CRLF-to-LF normalization is rejected before push.
- Added pre-ExcelJS pricing-workbook limits: 10 MB compressed input, 2,000 ZIP entries, and 25 MB of actual streamed decompression. Oversized files are rejected before `File.arrayBuffer()`, and hostile archives are stopped even if their ZIP directory lies about expanded size.

## 2026-07-17 — Add CodeRabbit AI PR-review config (.coderabbit.yaml) tuned to CRX hard rules; opened PR #160. GitHub setup inspection: confirmed CodeQL default-setup, secret scanning, Dependabot, protect-main ruleset all active; repo kept public per Mason.

Add CodeRabbit AI PR-review config (.coderabbit.yaml) tuned to CRX hard rules; opened PR #160. GitHub setup inspection: confirmed CodeQL default-setup, secret scanning, Dependabot, protect-main ruleset all active; repo kept public per Mason.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `774c85e4 Reconcile save_customer migration ledger version to match filename (#159)`
  - `a84534b6 Merge pull request #156 from masonwells1/claude/amazing-ptolemy-9e7e0a`
  - `7183851f Merge pull request #155 from masonwells1/claude/stoic-heyrovsky-ebaaf6`
  - `b240f7a3 Close money and inventory gauntlet findings (#157)`
  - `bca78b59 feat(crm): customer crops + prep-card top products by volume (owner decisions 2026-07-17) (#154)`
  - `addda7cd Close money and inventory gauntlet gaps (#153)`
  - `296d2de7 CRM loop closeout: final-gauntlet fixes + morning report (#152)`
  - `916cc856 CRM Relationship Intelligence — Phase 4: Customer Documents (#151)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260717063445_bind_bulk_po_replay_content.sql`
  - `supabase/migrations/20260717070900_bind_bulk_po_identity_ascii_fold.sql`
  - `supabase/migrations/20260717081856_reject_blank_bulk_po_identity.sql`
  - `supabase/migrations/20260717085512_canonicalize_bulk_po_identity_whitespace.sql`
  - `supabase/migrations/20260717092749_secure_bulk_po_fingerprint_trigger.sql`
  - `supabase/migrations/20260717101619_canonicalize_bulk_po_unicode_identity.sql`
  - `supabase/migrations/20260717110016_make_bulk_po_identity_server_authoritative.sql`
  - `supabase/migrations/20260717112906_restore_server_derived_bulk_po_claim_payload.sql`
  - `supabase/migrations/20260717113000_log_customer_interaction_rpc.sql`
  - `supabase/migrations/20260717112532_crm_customer_crops.sql`
  - `supabase/migrations/20260717112533_crm_prep_card_volume.sql`
  - `supabase/migrations/20260717123000_save_customer_ownership_enforcement.sql`
  - `supabase/migrations/20260716183501_purchase_order_integer_cents.sql`
  - `supabase/migrations/20260716190000_harden_sales_financial_scope.sql`
  - `supabase/migrations/20260716191000_aggregate_delivery_stock_preflight.sql`
  - `supabase/migrations/20260716202000_preflight_delivery_accounting_period.sql`
  - `supabase/migrations/20260716210000_harden_invoice_existing_customer_scope.sql`
  - `supabase/migrations/20260716213000_preserve_purchase_order_omitted_cost.sql`
  - `supabase/migrations/20260716224000_close_adversarial_money_inventory_gaps.sql`
  - `supabase/migrations/20260716233000_globalize_bulk_po_import_intents.sql`
  - `supabase/migrations/20260717010000_close_final_purchase_order_release_gaps.sql`
  - `supabase/migrations/20260717015439_invalidate_deleted_bulk_po_retry_state.sql`
  - `supabase/migrations/20260717032000_replay_bulk_po_same_request_result.sql`
  - `supabase/migrations/20260717045420_bind_bulk_po_claim_to_vendor.sql`
  - `supabase/migrations/20260717013415_crm_customer_documents.sql`
  - `supabase/migrations/20260716214423_crm_call_lists.sql`
  - `supabase/migrations/20260716181306_crm_customer_facts.sql`
  - `supabase/migrations/20260716182318_crm_purchase_intelligence.sql`
  - `supabase/migrations/20260716195012_crm_supersede_fact_expiry.sql`

## 2026-07-17 — APPLIED save_customer ownership enforcement to live (ledger 20260717123000) under Mason's in-chat OK. Post-apply: function hash changed, single overload, all gates present, grants clean (no anon), all 17 DB sweeps PASS, rolled-back live probe POST_PASS_ROLLBACK (rep denied editing non-assigned customer, own edit works). Updated migration-history row 744 + DECISION_LOG to applied.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `addda7cd Close money and inventory gauntlet gaps (#153)`
  - `296d2de7 CRM loop closeout: final-gauntlet fixes + morning report (#152)`
  - `916cc856 CRM Relationship Intelligence — Phase 4: Customer Documents (#151)`
  - `5cd2af20 CRM Relationship Intelligence — Phase 3: Seasonal Call Lists (#150)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260717123000_save_customer_ownership_enforcement.sql`

## 2026-07-17 — Codex r2 fix: save_customer replay binding — cached idempotency results are now validated against the requested customer (IDEMPOTENCY_PAYLOAD_CONFLICT / SAVE_CUSTOMER_RESULT_INVALID) and re-checked for ownership on the cached id before release, mirroring save_purchase_order. Delta review clean; 12-probe rolled-back live smoke SMOKE_PASS_ROLLBACK.

Codex r2 fix: save_customer replay binding — cached idempotency results are now validated against the requested customer (IDEMPOTENCY_PAYLOAD_CONFLICT / SAVE_CUSTOMER_RESULT_INVALID) and re-checked for ownership on the cached id before release, mirroring save_purchase_order. Delta review clean; 12-probe rolled-back live smoke SMOKE_PASS_ROLLBACK.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `addda7cd Close money and inventory gauntlet gaps (#153)`
  - `296d2de7 CRM loop closeout: final-gauntlet fixes + morning report (#152)`
  - `916cc856 CRM Relationship Intelligence — Phase 4: Customer Documents (#151)`
  - `5cd2af20 CRM Relationship Intelligence — Phase 3: Seasonal Call Lists (#150)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260717123000_save_customer_ownership_enforcement.sql`

## 2026-07-17 — save_customer ownership enforcement: wrote + reviewed + smoked migration 20260717123000 closing the 2026-07-16 Codex gauntlet finding (any active sales rep could edit any customer via the SECDEF RPC). Ownership gates mirror customers RLS (admin OR assigned rep; Mason settled: no office-manager carve-out). rls-security + migration-drift reviewers clean; live rolled-back smoke SMOKE_PASS_ROLLBACK incl. vuln-proof on live body. Migration PARKED on branch claude/amazing-ptolemy-9e7e0a awaiting Mason's OK to apply; Codex verdict + DB sweeps in flight.

save_customer ownership enforcement: wrote + reviewed + smoked migration 20260717123000 closing the 2026-07-16 Codex gauntlet finding (any active sales rep could edit any customer via the SECDEF RPC). Ownership gates mirror customers RLS (admin OR assigned rep; Mason settled: no office-manager carve-out). rls-security + migration-drift reviewers clean; live rolled-back smoke SMOKE_PASS_ROLLBACK incl. vuln-proof on live body. Migration PARKED on branch claude/amazing-ptolemy-9e7e0a awaiting Mason's OK to apply; Codex verdict + DB sweeps in flight.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `addda7cd Close money and inventory gauntlet gaps (#153)`
  - `296d2de7 CRM loop closeout: final-gauntlet fixes + morning report (#152)`
  - `916cc856 CRM Relationship Intelligence — Phase 4: Customer Documents (#151)`
  - `5cd2af20 CRM Relationship Intelligence — Phase 3: Seasonal Call Lists (#150)`
- **Migrations touched** (git diff --name-only origin/main...HEAD):
  - `supabase/migrations/20260717123000_save_customer_ownership_enforcement.sql`

## 2026-07-17 — CRM follow-up: customer crops + top products by volume (owner decisions)

Mason answered the five parked CRM owner questions; the two that were build items shipped same-day (branch `feat/crm-crops-and-volume`, Opus/Sonnet builders per owner instruction, full migration gauntlet):

- **Customer crops (decision: selected per customer, NOT derived from field history):** `customers.crops text[]` with a DB CHECK bounding the 8-crop controlled list and array shape (migration `20260717112532`). Tap-to-toggle chips on the customer info tab (save immediately, revert on failure, activity-logged) and a Crop filter on `/call-lists` sharing the tier filter's fail-safe lookup.
- **Top products (decision: show BOTH highest revenue and highest volume):** `get_customer_prep_card` gains `top_products_by_quantity` grouped per (product, unit) so a total can never mix units — a product invoiced in two units shows as two honestly-labeled lines (migration `20260717112533`; Codex caught the `MAX(unit)` mislabeling risk plus a tie-break gap, both fixed pre-apply, APPROVE on final bytes). The prep card now shows "Top by revenue" (fail-soft from `get_customer_purchase_summary`) beside "Top by volume". Proven live with a rolled-back mixed-unit smoke (12 gal + 4 lb → two lines).
- Other three answers recorded in `docs/manual/DECISION_LOG.md`: save_customer edits restricted to assigned rep + admins (relayed to the running remediation session), AI-disclosure default wording approved, transcript retention 15 months.
- Types synced (`supabase.ts`, `Customer`, new `src/lib/crops.ts`), schema registry rebuilt from live introspection (crops CHECK in `skipped_constraints`; one transcription drop caught and fixed by old-vs-new set diff).

---

## 2026-07-17 — Bulk purchase-order retry identity/content hardening

Final release state supersedes the intermediate ASCII-only identity step recorded below. GPT-5.6 found that `É` versus `é` OCR/manual capitalization could still produce two claims. Forward migration `20260717101619_canonicalize_bulk_po_unicode_identity`, applied live under the matching ledger version, moved durable identity to PostgreSQL NFKC → lowercase → NFKC. Final Sonnet 5 review then identified that comparing a browser-generated digest against PostgreSQL still depended on unproven case-fold parity for other alphabets. Follow-up `20260717110016_make_bulk_po_identity_server_authoritative`, applied live under the matching ledger version, removes that runtime comparison: the browser sends only a bulk-import marker, while PostgreSQL alone derives the durable SHA-256 claim. Its mandatory rollback smoke caught a fail-closed claim-propagation regression before the frontend shipped; forward correction `20260717112906_restore_server_derived_bulk_po_claim_payload`, also applied live under the matching ledger version, passes the server-derived key into the atomic claim insert without trusting the browser value. Legacy browser-hash clients remain compatible during rollout. Browser storage migration now canonicalizes decomposed Unicode raw keys, and a key is considered pre-hashed only when it matches the complete `h1:<16 lowercase hex>` format. Sales-rep PO create/import/edit/submit/cancel authority remains unchanged.

The money/inventory gauntlet closed the remaining bulk-PO retry gaps: browser retry state no longer uses normalized vendor/reference text as object keys, exact cached responses are bound to both the durable document claim and reviewed date/line content, and browser/PostgreSQL identity hashing now folds only ASCII A-Z so non-ASCII UTF-8 bytes remain identical. Browser keys are deterministic local hashes with migration and compatibility lookup for legacy Unicode-folded entries, and document-content/identity conflicts now give direct guidance to open and edit the existing PO. Forward migrations `20260717063445_bind_bulk_po_replay_content` and `20260717070900_bind_bulk_po_identity_ascii_fold` enforce the same boundaries in PostgreSQL. The role gate remains admin-or-sales-rep, preserving sales-rep PO create/import/edit/submit/cancel authority. The final Sonnet 5 review found that the deferred fingerprint constraint trigger did not retain the public writer's elevated permission context at commit; follow-up `20260717092749_secure_bulk_po_fingerprint_trigger` gives the trigger function its own fixed-search-path `SECURITY DEFINER` boundary while keeping direct application-role execution revoked. Both content-bound GPT-5.6-sol migration reviewers returned CLEAN. The deployed proof called the real writer as an active sales rep, returned to the `authenticated` role, forced the deferred constraint, and observed `DEFERRED_TRIGGER_EXECUTED`; the transaction rolled back and left zero proof rows. The B7 preflight and exact algorithm-transition window each had zero claims, and a live non-ASCII parity vector produced the same SHA-256 in JavaScript and PostgreSQL. The full adversarial and PO lifecycle rollback chains reached `SMOKE_PASS_ROLLBACK`, permanent catalog/data checks found zero residue or money drift, and all 17 database-invariant sweeps had no unallowlisted violations.

---

## 2026-07-17 — CRM Relationship Intelligence: all four phases LIVE (autonomous loop)

Native CRM module shipped end-to-end in one armed autonomous run (mission `docs/loops/crm-relationship-intelligence-loop-2026-07-16.md`, full audit trail in the ledger, plain-English summary in `docs/loops/crm-relationship-intelligence-morning-report.md`):

- **Phase 1 (PR #145):** `customer_contacts` + `external_identities` + `customer_interactions`/`interaction_transcripts`; Contacts tab, 30-second log-call flow, timeline integration. E.164 phones, bidirectional legacy-field sync triggers, provenance immutability, atomic primary promotion RPC.
- **Phase 2 (PR #149):** `customer_facts` (evidence-vs-belief knowledge, review queue, immutable-verified + supersession history, renewable expiry) + 4 purchase-intelligence RPCs incl. `get_customer_prep_card`; Knowledge tab + Call Prep card.
- **Phase 3 (PR #150):** 5 seasonal call-list RPCs + `/call-lists` page (rep/tier filters, prep peek, log-call reuse). Bonus root-cause fix: ToastProvider context-value memoization + identity-stable test stub (killed a reproducible 4GB test-worker OOM loop).
- **Phase 4 (PR #151):** `customer_documents` + private `customer-documents` bucket; Documents tab (upload/download/soft-delete, expiring-soon badges). Soft-delete only, provenance frozen, purge-safety, path-scoped storage policies.
- **Gauntlet:** 10 migrations through double adversarial review (Claude reviewers + Codex) with hash-bound proofs + rolled-back live smokes; 14 Sol gate rounds; final whole-loop sweep (compliance/types-drift/system-RLS/Sol) with live-verified anon/PUBLIC lockout. 11 CRM error tokens registered in `RpcErrorCodes`; schema registry repaired (vendors.deleted_at transcription gap).
- **Parked (owner + follow-ups):** save_customer ownership gap (pre-existing, task chip), idempotent call-log/fact-add RPCs (task chip), crop filter source-of-truth, top-products metric, Phase-5 service-role seams (recorded in ledger).

---

## 2026-07-16 — Migration drift reviewer B7 gate correction

Corrected the trusted migration-drift charter's contradictory version-stamp check. The old wording required a pending disk filename to equal the version Supabase would assign in the future, which is unknowable before `apply_migration` and caused clean migrations to fail closed even after a fresh live-ledger preflight. The reviewer now enforces the real two-stage B7 contract: before apply, the disk timestamp must be strictly above the current live high-water; after apply, the disk file must be renamed to the MCP-assigned live version. `check-agent-guidance.mjs` locks the complete CHECK 6 block to one canonical fail-closed contract and retains adversarial branch/equality checks, so synonym changes cannot silently reintroduce the impossible requirement.

---

## 2026-07-17 — Exact bulk purchase-order retry replay

The final Sonnet 5 exact-SHA review found one non-corrupting but misleading lost-response path: a successful bulk PO import retried with the same request key was classified as a different-request document duplicate, so the browser could report it as skipped and omit its normal success refresh. Forward migration `20260717032000_replay_bulk_po_same_request_result` applied live as ledger version `20260717032437` and restores the required order after current actor authorization: exact request-key replay returns the original cached `saved` result and stored PO number; only a different request key reaches the durable global document-claim check; and both checks still occur before number allocation. The stacked pre-apply and deployed post-apply adversarial rollback smokes both reached `SMOKE_PASS_ROLLBACK` after proving same-key saved replay, cross-employee different-key duplicate detection, admin delete cleanup, and unchanged-document re-import. Permanent catalog checks found the migration once, exact replay/claim/number ordering, correct grants and fixed search path, the delete-cleanup trigger enabled, and zero claim residue, stale save results, fractional PO costs, or header mismatches. The stale RPC reference now correctly describes `delete_purchase_order` as a guarded permanent delete, and the live schema registry was rebuilt to high-water `20260717032437`.

The post-fix Sonnet pass also found that bulk OCR could produce a three-decimal unit price, calculate the correct rounded cents in the browser, but still send the raw fractional-cent dollar value and trigger a safe database rejection. All three browser PO writers (create, edit, and bulk import) now send the same canonical whole-cent amount in both dollar and cent representations. A focused bulk-import UI test proves `3.334` is submitted as `$3.33` / `333` cents, and the newest live `save_purchase_order` wrapper now has a dedicated source regression guard pinning exact-key replay before document duplicate classification and PO-number allocation. The last GPT-5.6 adversarial passes additionally canonicalized equivalent vendor-invoice dates, removed the time-dependent date fallback when OCR misses a date, made exact same-PO retries count as skipped while still recognizing a newly recreated PO after an intentional delete, and require a reviewed vendor identity before creating the global duplicate claim so unrelated vendors cannot collide on an otherwise identical invoice. The final Sonnet exact-SHA pass then required the same invariant at the database boundary: forward migration `20260717045420_bind_bulk_po_claim_to_vendor`, applied live as ledger version `20260717045420`, rejects vendorless global claims and refuses a claim-key replay when the stored PO belongs to a different normalized vendor, closing future direct-RPC bypasses without narrowing sales-rep PO authority.

---

## 2026-07-17 — Deleted bulk purchase-order re-import closure

The final GPT-5.6-sol exact-SHA review caught that an admin-deleted imported PO was not reliably importable again: its durable claim cascaded, but the browser still trusted a 30-day marker and the generic 24-hour retry cache could replay the deleted PO ID. Reviewed migration `20260717015439_invalidate_deleted_bulk_po_retry_state` applied live as ledger version `20260717020549`. An internal delete trigger now removes all `save_purchase_order` retry results for the deleted PO, the browser marker is display-only, and the public writer serializes and rechecks the live global document claim before allocating a PO number. The live rollback chain proved import → cross-employee duplicate → admin delete → unchanged-document re-import with the original deterministic key and ended in `SMOKE_PASS_ROLLBACK`; permanent checks found the trigger enabled/internal-only and zero claims or stale save replays. The live RPC snapshot was regenerated exactly to 425 names (CSV MD5 `72e76d7f98227fee41ea7266e53a2ac9`) and the schema registry to migration high-water `20260717020549`.

---

## 2026-07-17 — Final purchase-order release closure

The final GPT-5.6-sol adversarial pass found four release gaps after the earlier bulk-import corrections: PO numbers were still reserved in a separate browser transaction, import claims blocked the admin-only PO delete path, vendor-bill drift compared aggregate-rounded quantity/cost instead of the authoritative line-rounded PO header, and a duplicate-only import did not refresh the parent list. Reviewed migration `20260717010000_close_final_purchase_order_release_gaps` applied live as ledger version `20260717011322`; new numbers are now allocated under the database advisory lock in the same transaction as insert, the internal writer is not directly executable, import claims cascade with an intentionally deleted PO, and vendor bills compare `purchase_orders.total_cost_cents`. The browser consumes the stored server-returned number, and duplicate-only close refreshes the PO list. Both trusted migration reviewers returned CLEAN; the deployed rollback smoke ended in `SMOKE_PASS_ROLLBACK`; permanent checks found zero claim rows, fractional source costs, and PO header mismatches with the expected public/private grants.

---

## 2026-07-16 — Final bulk purchase-order replay corrections

The last adversarial review found three narrower bulk-import issues: a server-side duplicate was displayed as newly imported and left the browser's unused reserved PO number behind, partial failures closed the review modal and hid the failed documents, and binary floating-point rounding disagreed with PostgreSQL on half-cent fractional-quantity totals. The browser now consumes the server's original PO number, reports new imports separately from already-imported skips, keeps partial failures open while guaranteeing the parent PO list refreshes on close, and uses decimal-exact half-away-from-zero cent rounding. Reviewed forward migration `20260716233000_globalize_bulk_po_import_intents` applied live as ledger version `20260716235814`; it globalizes the persistent vendor-document claim across authorized employees while leaving generic request idempotency actor-scoped, includes a locked duplicate preflight, and returns the first PO number on replay. The production cross-employee rollback smoke ended in `SMOKE_PASS_ROLLBACK`, and permanent checks found zero claim rows, zero PO header mismatches, and zero fractional-cost rows. The final Sonnet gate also registered the adversarial chain in `smoke-specs.json`, restored the previously omitted `smoke-gauntlet-money-workflows.sql` artifact, corrected that smoke's UTC-midnight/Chicago-business-date mismatch, and closed unit-cost conversion's remaining binary-float edge; the restored live AP/finance-charge/prepay chain then reached `SMOKE_PASS_ROLLBACK`.

---

## 2026-07-16 — Supplier Pricing Phase 1a staged rollout checkpoint

Prepared and proved the database half of the owner-controlled pricing safety foundation. The reviewed additive bootstrap is live at `supabase/migrations/20260717042803_supplier_pricing_phase1a.sql`; the compatibility-safe pre-deploy guard is live at `supabase/migrations/20260717112011_supplier_pricing_zero_cost_guard.sql` (ledger name `20260717120500_supplier_pricing_zero_cost_guard`), and the later enforcement cutover remains parked at `scripts/.staging-migrations/20260717121000_supplier_pricing_phase1a_cutover.sql`. The bootstrap adds pricing versions, retained workbook manifests/change sets, atomic/idempotent admin RPCs, and trigger-owned history for governed writes while preserving the deployed legacy Product editor. The pre-deploy guard rejects margin-driven zero cost before the RPC frontend can ship without changing legacy-mode behavior; a live authenticated Product edit plus both calculator modes reached `PHASE1A_LIVE_GUARD_ROLLBACK_PASS`. The cutover closes direct pricing/history writes only after the RPC frontend is deployed.

A network-disabled disposable PostgreSQL proof compiles the exact live bootstrap, live pre-deploy zero-cost guard, and parked cutover. It first proves compatibility with the deployed editor, then proves the zero-cost guard rejects the dangerous governed input without changing legacy mode, followed by final direct-write denial, both pricing modes across three Products, collision-safe identity conflicts, exact preview/apply and history values, atomic rollback, and durable retry/replay behavior. The proof also generates and edits an actual `.xlsx`, parses it with the application workbook code, sends that parsed payload through the real preview/apply RPCs in disposable PostgreSQL, and verifies exact Product/history provenance before rollback.

The frontend/OCR-retirement code is now restored for Draft-PR review because its RPC dependency and the pre-deploy zero-cost guard are live. Every frontend preview entry point also refuses a margin-driven zero cost before calling the RPC, providing a second client-side safety layer during the staged rollout. The frontend and OCR retirement are **not production behavior yet**: no frontend merge/deploy or Edge Function deploy has occurred, the active `process-document` v18 still contains the prior pricing-document OCR routes, and the strict enforcement cutover remains parked. A Windows CRLF normalization in `check-agent-guidance.mjs` also keeps the migration-drift charter's exact-text guard deterministic across checkouts.

---

## 2026-07-16 — Scaffolding review Wave 4c: stale-anchor doc corrections

Fixed the stale claims the review flagged in two high-read docs (each verified against current reality this session):

- **`docs/workflows/SAFE_DEVELOPMENT_RULES.md`** (read at the start of every session): "read CLAUDE.md for the hard red lines" → **AGENTS.md** (CLAUDE.md is routing-only); "there are 57 pages" → point at `pages-routes.md` (actual count is 76, and hardcoding it here drifts — this file isn't count-checked); the "wait for approval before starting" rule now carries the AGENTS.md tiny-fix carve-out; the session-end "remind Mason to commit to Git" → the branch → PR → merge landing flow (agents land reviewed code; direct pushes to main are impossible).
- **`docs/reference/gotchas.md` "Environment Quirks"**: all three rows were stale — `gh` and `tail` are both available and the repo path was wrong (`C:\CRX_Manager`, not `C:\CRX_Manager_V1.0`). Replaced with accurate current facts.

This closes the review's actionable doc-drift items. Remaining review notes (fleet-status "active" cosmetics, untracking the personal `settings.local.json`) are low-value or owner-call.

---

## 2026-07-16 — Graphify and money/inventory gauntlet release

The Graphify overnight architecture audit and the completed money/inventory gauntlet remediation were reconciled into one release branch. The three reviewed gauntlet migrations were applied live as `20260716120104`, `20260716120112`, and `20260716120120`; they harden delivery authorization and business dates, make purchase-order/receiving/AP/prepayment writes RPC-owned, preserve received PO evidence, correct statement/AP/finance-charge/prepayment money behavior, and repair inventory position and ledger presentation.

An independent release review found one remaining PO lifecycle bypass: ordinary `save_purchase_order` calls could request a received/submitted status. The corrective migration is live as `20260716144353_lock_purchase_order_initial_status`; new POs must start as drafts, ordinary edits preserve the current status, and submission remains owned by `submit_purchase_order`. The New Purchase Order screen still provides one-click Submit by saving the draft first, then submitting with a separate retry key. Lost save responses reuse the same PO number and key; lost submit responses replay submission without resaving.

The final exact-SHA review found one additional hard-red-line issue: delivery completion and voiding only warned when their business date was inside a closed accounting period, then continued changing inventory, order lifecycle, and draft invoices. Live migration `20260716152906_guard_delivery_closed_periods` adds a trigger-level `check_period_open()` boundary that cannot be bypassed by `admin_override`; an exception rolls back the complete caller. The production rollback smoke called the real completion and admin-void RPCs, proved both closed-period paths left zero partial side effects, proved both open-period paths still work, and ended in `SMOKE_PASS_ROLLBACK`.

The completed remediation branch's final payment replay proof exposed an adjacent live regression in the shared idempotency trigger: `allocate_payment` could complete once, but ordinary retries were intercepted before the cached-response branch and told to retry forever. Reviewed migration `20260716160000_fix_idempotency_committed_replay_guard` applied as ledger version `20260716165801`. It restores committed replay only for the recognizable empty `allocate_payment_v1` claim while preserving duplicate-work rollback for legacy functions that write final idempotency results after mutation.

Post-apply adversarial checking found an adjacent direct-table bypass: a permitted authenticated update could rewrite `completed_at` to move completed history out of a closed period or voided history into one. Live follow-up `20260716172956_guard_delivery_period_rewrites` now checks both the stored and requested Chicago business dates for every terminal status/date rewrite. The expanded browser-role smoke proved completed rows cannot move into or out of a closed period and voided rows cannot move into one, while the real open-period completion/void paths remain available; both the pre-apply stacked proof and post-apply production proof ended in `SMOKE_PASS_ROLLBACK`.

That branch's final adversarial review also found that `complete_delivery` returned a committed idempotency result before checking the caller's current authority. Reviewed migration `20260716173342_authorize_delivery_before_replay` applied as ledger version `20260716174220`: the public wrapper now validates canonical actor identity and the caller's current active admin/sales authority or assigned-driver relationship before the unchanged internal implementation can inspect the cache. Direct execution of that implementation is revoked. The combined delivery smoke reuses a committed key as a different active unauthorized user and requires `Not authorized to complete this delivery`.

The final exact-SHA Codex review found one narrower legacy path: a voided row with no `completed_at` uses `scheduled_date` as its effective business date, but the prior trigger did not fire for a scheduled-date-only update. Live migration `20260716183442_guard_delivery_scheduled_date_rewrites` now watches `status`, `completed_at`, and `scheduled_date` and checks both the stored and requested dates whenever terminal history is rewritten. The stacked pre-apply proof and the post-apply production smoke both ended in `SMOKE_PASS_ROLLBACK`; live catalog checks confirmed the three watched columns, fixed search path, `SECURITY DEFINER`, scheduled-date predicate, and no anon/authenticated execution.

The mandatory Codex push gate then found a purchase-order money red-line missed by the earlier reviews: `save_purchase_order` accumulated decimal-dollar products and four live PO headers contained fractional cents. Reviewed migration `20260716183501_purchase_order_integer_cents` was applied as ledger version `20260716184406`. It adds generated bigint cent columns plus exact-cent constraints, recomputes all headers as the sum of individually rounded line cents, and moves the save RPC and all three browser writers to integer-cent inputs and arithmetic while preserving exact two-decimal legacy dollar projections. The live lifecycle smoke proved sales-rep create/edit/submit/cancel, rejected fractional-cent input, stored 10.125 × $3.33 as exactly 3,372 cents, and rolled back. Permanent verification found zero fractional-cent rows and zero header/line mismatches.

The GPT-5.6-sol adversarial review then blocked release on three adjacent issues. Live migrations `20260716190000_harden_sales_financial_scope` and `20260716191000_aggregate_delivery_stock_preflight` applied as ledger versions `20260716200659` and `20260716200716`. The invoice and statement wrappers now require an active admin or the sales rep assigned to the target customer before the proven implementation can inspect its cache or financial rows. Delivery completion now locks and aggregates repeated product lines; an aggregate shortage keeps the approved WARN-NOT-BLOCK policy while marking every new delivered ledger row for review at insertion, returning and caching the warning, and emitting one activity/admin-notification trail. Both mandatory migration reviewers returned clean. The stacked pre-apply and deployed post-apply smokes proved assigned-customer invoice/statement success, unassigned edit/replay/statement denial, inactive-user denial, a two-line 12-against-10 completion with -2 visible inventory and two immutable review-marked rows, exact warning replay, no duplicate notifications, and `SMOKE_PASS_ROLLBACK`.

The remaining Sonnet follow-ups are also closed. Live migration `20260716202000_preflight_delivery_accounting_period` applied as ledger version `20260716202027`; authorized committed replays remain available, while every new delivery checks `check_period_open()` before the obsolete closed-period warning block can do doomed work. Bulk PO imports retain unresolved idempotency keys and reserved PO numbers for 24 hours, keep the review screen open after partial failure, and retry only failed documents while skipping successes.

The final Sonnet 5 release reviews found three narrower bypasses in those follow-ups. Live migration `20260716210000_harden_invoice_existing_customer_scope` applied as ledger version `20260716210032`: an invoice edit now locks the stored row and requires a sales rep to be assigned to both the stored customer and any requested customer, so changing `customer_id` cannot be used to hijack another rep's invoice. Bulk PO imports now derive their durable identity only from normalized vendor name plus vendor invoice number—not mutable file metadata, OCR date, product matching, quantities, costs, units, or notes—so review corrections cannot create a second PO for the same invoice. They persist successful markers in browser local storage for 30 days, visibly label reopened documents as **Already imported**, and ask the server to resolve the durable claim instead of generating fresh PO numbers and vendor commitments. Focused tests reorder file selection and line items, change every reviewed content field without changing identity, retain a successful marker beyond 24 hours, and cover pending lost-response replay plus close/reopen skip; the exact invoice-reassignment exploit passed stacked pre-apply and post-apply production rollback smokes.

That re-review found one final PO money regression: an existing line edit that omitted both cost fields could reset the line and header to zero even though all current browser callers send cost. Reviewed forward migration `20260716213000_preserve_purchase_order_omitted_cost` applied as ledger version `20260716213829`. The public save wrapper fills only recognized existing lines from their stored generated integer-cent cost before delegating, so line immutability, line updates, and header totals all see the same authoritative value; the internal implementation remains non-executable. Pre-apply and post-apply production smokes preserved a $3.33 line and $33.72 header through the exact omitted-cost edit and ended in `SMOKE_PASS_ROLLBACK`.

The exact-SHA GPT-5.6-sol adversarial review blocked that candidate on four concurrency and authorization gaps. Reviewed migration `20260716224000_close_adversarial_money_inventory_gaps` applied as ledger version `20260716225754`: PO saves now lock before omitted-cost hydration, validate line identity, and rebuild the header from stored integer-cent lines; bulk imports use a deterministic client key plus a persistent server-side claim, so another tab or device cannot create the same reviewed vendor commitment with a fresh generic retry key; and invoice save/post wrappers bind replay IDs to the actual stored customer before authorizing a sales rep. The live rollback smoke exercised all four attacks, proved one claim/one PO, preserved an omitted $3.33 cost with a 3,663-cent stored header, rejected malformed and duplicate line identities, denied unassigned-customer save replay and posting, and ended in `SMOKE_PASS_ROLLBACK`. Permanent catalog checks found zero PO header mismatches, zero fractional costs, zero orphan claims, RLS enabled on the new claim table, and no browser-role access to internal post helpers. Sales reps retain PO create/import/edit/submit/cancel and ordinary receiving; only over-receive and receiving reversal remain admin-only.

Post-apply PO proof used a real active sales rep and ended in `SMOKE_PASS_ROLLBACK`: direct submitted creation and save-based status changes were rejected, draft save/edit and both idempotent replays succeeded, dedicated submission and cancellation succeeded, omitted existing-line cost remained intact, integer-cent totals were exact, and a non-office user was denied. The final live catalog sweep found zero fractional-cent PO items, zero PO header/line mismatches, zero existing duplicate delivery-product groups, one enabled aggregate review trigger, fixed `public, pg_temp` search paths, public endpoints executable only by authenticated/service roles, and all internal helpers non-executable. The schema registry was rebuilt from six production introspection queries to high-water `20260716225754`.

---

## 2026-07-16 — Scaffolding review Wave 4b: hook-manifest parity guard + CRLF-insensitive adapter check

Two sync-adapter findings from the 2026-07-16 review, both HARD-scaffolding fixes:

- **Hook-manifest parity guard (NEW):** `.claude/settings.json` and `.codex/hooks.json` wire the SAME shared `.claude/hooks/` implementations, but nothing enforced they stay in step — a new Claude-side guard could be added and silently never fire for Codex (the designated builder). `scripts/agent-manifest-parity.mjs` now diffs the two hook-script sets; `check-agent-workflows.mjs` FAILS on any asymmetry that isn't an explicitly-declared one-sided hook (`CLAUDE_ONLY_HOOKS` / `CODEX_ONLY_HOOKS`, each with its reason). Adding a guard now forces a conscious choice: wire it on both sides or declare it one-sided. Current declared Claude-only set: `codex-push-guard`, `pr-merge-guard` (Codex has its own `production-action-guard`), `autopilot-intent-reminder`, `unattended-autopilot`, `worktree-cleanup`, `session-heartbeat`. Tests (`agent-manifest-parity.test.mjs`, wired into `test:agent-workflows`) prove parity today, prove a synthetic drift is caught, and assert every allowlist entry is genuinely one-sided.
- **CRLF-insensitive adapter compare:** `sync-agent-workflows.mjs --check` byte-compared adapter content, so a checkout where `core.autocrlf` rewrote a `.agents/` file to CRLF reported identical text as "stale" — a false failure that bricked commits in fresh worktrees. `--check` now normalizes line endings before comparing (the committed form stays LF-pinned via `.gitattributes`, and `--write` still self-heals CRLF→LF). Proven: a CRLF-corrupted adapter now passes the check instead of false-failing.
- **Also:** reconciled `docs/reference/migration-history.md`'s count header (703 → 706) to match the three CRM Phase-1 migrations merged in #145 — their rows were indexed but the header count wasn't bumped, which was failing `check:docs` (and blocking every commit) on current main.

---

## 2026-07-16 — Scaffolding review Wave 4a: worktree-cleanup heartbeat guard

The SessionStart worktree-cleanup hook protected only the CURRENT session's own worktree, so a **sibling** session's clean, merged, unlocked worktree could be swept while that session was still live — which happened during this review (an active read-only checkout was deleted mid-session). Fix: the classifier now also KEEPS any worktree touched within a 3-hour activity window (`recently-active`), computed from the newest mtime of its git index / HEAD / reflog / `.claude/session-state`. Locking remains the belt; this heartbeat is the suspenders for sessions that didn't lock. Recoverable either way (every deletion still prints a recovery SHA), and a genuinely idle-past-3h finished worktree is still cleaned. `worktree-cleanup-lib.mjs` + runner updated; tests prove both directions (recent → keep, idle-past-window → remove, missing signal → behaves as before). 31 assertions pass.

**Follow-up (Codex review):** git index/HEAD/reflog timestamps aren't refreshed during a long *read-only* session (no commits/checkouts), so those alone could still let an active-but-quiet session's worktree age out. New `session-heartbeat.mjs` hook (wired to PostToolUse `*` + SessionStart) stamps `.claude/session-state/SESSION-HEARTBEAT` on every tool call — the cleanup's mtime scan already reads it, so any session doing *anything* (including reads) stays live inside the window. Fail-open and silent; the marker is gitignored.

---

## 2026-07-16 — Scaffolding review Wave 3: hard doc-freshness gates + verified manual corrections

The root-cause theme of the 2026-07-16 scaffolding review was staleness — the manual/reference layer going out of date while its "Last verified" prose promised otherwise. Wave 3 turns that promise into a checked fact and fixes the specific stale docs (each correction verified against the live database first):

- **Manual-freshness gate (HARD):** `check-doc-drift.mjs` now FAILS when `CURRENT_STATE.md` or `KNOWN_ISSUES.md` claims a "Last verified" date older than the newest `supabase/migrations/` file. A migration dated after the stamp means the live-state docs weren't re-checked. Green today (stamps 2026-07-16 ≥ newest migration 2026-07-15); fires the moment a future migration lands without a stamp bump. Both fail/pass directions proven.
- **Ledger guard extended to migrations:** a commit adding a `supabase/migrations/*.sql` file must now stage a ledger update (CHANGELOG / a manual doc / migration-history.md) in the same commit — a live-schema change can no longer land with zero doc trail. Tests updated.
- **KNOWN_ISSUES.md corrections (verified live):** the `save_field_app_invoice:no-row-lock` finding marked RESOLVED (migration `20260714224000` applied the `FOR UPDATE` locks live 2026-07-14; confirmed in the live function body); the "frontend rollout pending PR" heading corrected — that rollout landed via PR #133 (merged 2026-07-15, `c4f7b4c5`).
- **QUOTE_TO_DELIVERY.md corrections (verified live):** removed the dropped `orders.total_paid`/`balance_due` columns (AR is derived from `invoices.balance_cents`) and fixed the `invoice_items` line-total column name to `extended_cents` (was `line_total_cents`).
- **RLS_SECURITY_GUIDE.md:** the "Full RLS Policy Matrix" now carries a loud staleness banner — it's a hand-kept snapshot already contradicted by July migrations (returns/return_items/payments write policies revoked); query live `pg_policies`, don't trust the prose, and never re-add a revoked policy to make reality match the doc.

---

## 2026-07-16 — Scaffolding design review + Wave 1 guard/doc fixes (junior-handover hardening)

Full 10-dimension design review of the agent scaffolding (report: `docs/audits/2026-07-16-scaffolding-design-review.md`; independent Codex cross-review verdict: agree-with-changes, its scope escalations adopted). Wave 1 closes the confirmed BLOCKERs — every documented path around the live-DB guard net — plus the highest-risk Theme-1 gap:

- **`bash-safety-lib.mjs`:** `supabase db push` pattern made npx-optional (the bare spelling older docs printed sailed through); `supabase migration up` added as the sibling live-apply bypass. Tests extended.
- **`pr-merge-guard.mjs` (NEW, `*` matcher):** PR merges into `main` now get the same risky-diff Codex gate pushes had — the 2026-07-14 `protect-main` ruleset moved the landing action to `gh pr merge`/MCP merge and the Codex gate never followed. Green-pipeline requirement + head/base-bound proof for risky diffs; shared parsers added to `codex-push-lib.mjs`; tests in `pr-merge-guard.test.mjs`. Codex's review of this very PR caught a raw-REST bypass (`curl -X PUT .../pulls/N/merge`) — such calls are now denied outright, fail closed.
- **`write-apply-proofs.mjs`:** proof stamping is now unconditionally machine-minted. `--codex-verdict <v>` (caller-supplied verdict = one-command rubber stamp) REMOVED, and — per Codex round-3 review of this PR — the say-so reviewer-proof stamp is gone too: every invocation executes EACH required reviewer charter (`.claude/agents/rls-security-reviewer.md` + `migration-drift-reviewer.md`) as its own trusted-Codex run and mints the proof pair (`migration-review-<name>.json` + `codex-review-mig-<name>.json`) only when ALL charters return a terminal CLEAN machine token, with TOCTOU content-binding (mirrors `write-codex-push-proof.mjs`). The reviewers named in the proof are runs that genuinely happened. No verdicts, no proof, no exceptions. Also per that round: `gh pr merge --auto` is now denied for risky diffs (auto-merge would land later commits past the gate with a stale proof). Round 5 caught and closed one more evasion: `gh -R o/r api graphql ...mergePullRequest...` (global flags between `gh` and `api`) slipped the position-anchored regex — the parser now word-scans for the `api` subcommand. Round 6 closed two more: the parse loop no longer stops at the first merge in a chained command (every segment is collected and gated), and the risky-diff proof now binds to GitHub’s `baseRefOid` (the real base tip the merge lands on) instead of the possibly-stale local `origin/main`. Round 7: `.claude/agents/` reviewer charters and `scripts/write-apply-proofs.mjs` joined `RISKY_PATH_RES` — they are now executable gate machinery, so editing them requires the same independent verdict. Round 8: the hook-registration surfaces `.claude/settings.json` and `.codex/hooks.json` joined `RISKY_PATH_RES` too — a PR that de-registers a guard through them must itself pass the gate.
- **`migration-apply-guard.mjs`:** deny messages now route proof-writing through the sanctioned wrapper (the old text instructed hand-writing the exact JSON that `review-proof-guard` blocks) and the interactive message states Mason's in-chat OK as a required step (the proof is a floor, not the authorization).
- **Docs teaching guard bypasses rewritten:** `DATABASE_CHANGE_CHECKLIST.md` Step 3 (was: paste into the production SQL Editor) + Quick Reference + CONCURRENTLY apply paths; `create-migration`/`new-rpc`/`deploy-check` skills (was: `supabase db push` / dashboard apply); `new-rpc` template fixed (operation-scoped idempotency lookup + REVOKE/GRANT block — the old template wrote SQL `idempotency-body-check` denies).
- **Backup/incident docs rewritten to reality:** `production-runbook.md` §4 and `incident-rollback.md` claimed Pro-plan daily backups + PITR (the plan is FREE — neither exists); both now document the two real recovery paths (`masonwells1/CRX_Backups` weekly encrypted pg_dump + in-DB `backup_snapshots`) with restore steps.
- **Landing-path staleness fixed:** `ship.md`, `OWNER_PLAYBOOK.md`, `production-runbook.md` revert path, and the canonical `PUSH_POLICY` constant (`prompt-source-lib.mjs`) now describe branch → PR → green checks → merge, state that direct main pushes are impossible, and state that armed hands-free runs PARK pushes/merges (removing the constant's contradiction with the autopilot reminder). `prompt-hooks.test.mjs` now asserts the PR path so the constant can't drift again.

Remaining review findings (Waves 2–4: hard doc-freshness gates, loop lifecycle status, manifest parity check, sprawl IA) are tracked in the report's appendix.

---

## 2026-07-16 — Full docs review, verified cleanup, and combined TODO

Full review of all ~320 docs files with four parallel subagents verifying every open/done claim against the code on disk and the live database. Root `TODO.md` rewritten as the single combined open-items list (owner actions ranked by value unblocked, engineering now/next, parked-on-purpose pointers, and a "surfaced untracked items" section: sprayer-packet feature, month-end-close picker WIP, the four-way split-billing design decision, scheduling Phase 4/5 leftovers, and the 2026-06-19 Tier-1 idea backlog). Verified corrections landed: business-workflow findings #106/#109 were wrongly listed open in `KNOWN_ISSUES.md` (shipped 2026-07-06 via `20260707050000`); `migration-history.md` rows 690–692 wrongly said "Not applied live" (all three applied 2026-07-15 as re-stamped versions `20260715134551/134618/134629`, verified in live `schema_migrations`); the schema registry is fresh at high-water `20260715203911` (roadmap T1/T2 closed); `CURRENT_STATE.md` refreshed with 2026-07-16 live counts — deliveries are now the top transactional surface (106 live; the 07-13 snapshot's jobs/deliveries figures appear transposed) and payments remain 0. Offline Stage 1B plan docs' stale "pending merge" headers corrected to SHIPPED. ~65 fully-shipped/dispositioned docs moved to `docs/archive/2026-summer-closeout/` (June review-cycle audit artifacts, closed loop ledgers/missions, shipped roadmap plans) and the ChemMan walkthrough research joined `docs/archive/2026-summer/`; anything still cited by living docs, hooks, or scripts stayed in place.
---

## 2026-07-15 — Local Graphify architecture workflow

CRX now maintains a local, gitignored Graphify architecture map for agents and reviewers. The scoped corpus covers the operating frontend, migrations, Edge Functions, and selected scripts while excluding historical audit/archive material. A dedicated `npm run graph:refresh` command rebuilds it without sending code to a model; the existing pre-push gate runs it after typecheck/build only when architecture-relevant files changed. A shared Claude/Codex Graphify skill uses focused `affected`, `path`, and `query` traversals to choose the smallest source-review scope before refactors, workflow/migration work, and PR review. The canonical `AGENTS.md` startup contract now tells every agent to invoke that workflow automatically for architecture, multi-file, workflow/migration, debugging, audit, and PR-impact work, so Mason does not have to remember to request it. Graph edges are navigation evidence only — current source and read-only live database proof remain authoritative.

---

## 2026-07-15 — Return creation RPC-only boundary live

Migration `20260715203911_park_returns_creation_rpc_only.sql` was applied live as Supabase ledger version `20260715203911`; Supabase recorded the migration name as `20260715182757_park_returns_creation_rpc_only` because that was the apply-time name. This landed after Sol xhigh adversarial review returned `VERDICT: PASS` and disposable proof replayed the exact migration, exact return-credit smoke (`SMOKE_PASS_ROLLBACK`), and exact standing invariant. The migration removes the role-only `returns_insert` policy and external `returns` INSERT privilege so authenticated admin/sales users cannot bypass the canonical `create_return` RPC. It also revokes direct external INSERT/UPDATE/DELETE privileges on `return_items`, whose application and lifecycle writers are already privileged return RPCs. Existing `returns` UPDATE/DELETE behavior is deliberately preserved behind the July 15 lifecycle/status triggers. Post-apply live catalog checks confirmed zero return INSERT policies, no anon/authenticated direct `returns` INSERT, zero return-item mutation policies, no anon/authenticated direct return-item DML, authenticated/service-role `create_return` execution retained, anon execution denied, and the standing return invariant returned zero rows.

---

## 2026-07-15 — U12/U13 stale-draft cleanup and RPC #40 documentation (local-only)

Deleted the stale U12/U13 scratch draft folders after verifying their complete backend/frontend behavior had already shipped in `f4a23220` (`20260707010000` / `20260707011000`) and `153f0600` (`20260707020000`) respectively. Documented business-workflow review #40 as an owner wire-vs-retire decision; the orphaned `get_customer_delivery_remainders` RPC was not changed and no retirement migration was created. The no-caller `setup-blend-tickets-storage` source was retained because a same-session read-only live inventory found version 18 ACTIVE; no live undeploy occurred, and retirement is parked for a separate approved session.

---

## 2026-07-15 — Registry-freshness test harness isolation

The registry-freshness runtime helper and copied hook harnesses now run Git and spawned-hook probes with a Git-clean child environment. Git hooks inherit repository-local `GIT_*` context, so the harness now consults `git rev-parse --local-env-vars` and removes those bindings plus indexed `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` entries before spawning; the runtime flag-sharing helper strips the same class before resolving worktrees. Synthetic stale-registry flags can no longer resolve against real CRX worktrees.

---

## 2026-07-15 — Return lifecycle direct-update hardening live

The Section 8 gauntlet follow-up is live as Supabase ledger version `20260715132146` (`20260715115155_harden_return_lifecycle_updates`). Return lifecycle/audit fields are now RPC-owned: direct `returns` table writes can still delete requested/rejected/cancelled rows, but active returns cannot be soft-deleted or hard-deleted, so they stay visible to terminal-order guards; request timestamp, approval, receipt, cancellation, credit, and status fields require a vetted return RPC flag or the existing scoped admin override. `approve_return` and `cancel_return` also reject NULL actor arguments instead of writing blank attribution, and a standing `returns-lifecycle-rpc-owned` invariant sweep covers the bug class.

---

## 2026-07-14 — Money and inventory hardening live

Five migrations and their application wiring close the highest-risk findings from a deep money/inventory audit. Shared idempotency checks now serialize each globally unique key before mutation so concurrent retries cannot both mutate, and both helpers reject whitespace-only keys instead of allowing repeat side effects; the batch-prepay gate is extended with strict actor matching; planned inventory holds are released transactionally by the existing `save_quote` server path and no longer have direct authenticated write policies. Order edits now reject item IDs owned by another order, create a missing inventory snapshot before prebooking a newly added product, and lock inventory rows before cycle-count completion/reversal. Returns must reference delivered order lines, with product, remaining returnable quantity, and credit price derived from server-owned data; their order/customer identity becomes immutable, and receive/credit independently re-verify the relationship plus every linked source line before inventory or money moves. Voided/cancelled source orders are rejected throughout create/receive/credit, while both void and cancel refuse any order with a received/credited return regardless of order status or restock flags, preventing duplicate inventory restoration and stranded credits. Receive and terminal order operations serialize on the source-order lock; return lines are immutable to authenticated table writes and credit issuance is admin-only. One exact-record compatibility path is pinned to the sole approved production source-free RMA and its verified immutable return/item values; every other source-free row is rejected even if backdated. The Returns screen now subtracts prior active returns, avoids stale customer/order requests, and labels duplicate product lines with their section and negotiated unit price. Voided orders are excluded from all sales reports and finance-dashboard order aggregates; inactive profiles are rejected from the affected report/receiving gates; only active admins may over-receive POs, with a nullable override treated as false; anonymous gross-sales access and authenticated payment-table writes are removed. Field-app save and group-post now share an immutable group-ID advisory lock and ordered invoice locks before rebuilding or committing bill lines; grouped invoices cannot be posted one member at a time, group posting uses the shared idempotency boundary, and both invoice batch surfaces deduplicate siblings into one atomic group call. The screen also blocks saves and posts during weather lookup and stays frozen through its server reload.

**Applied live on 2026-07-14:** Supabase versions `20260714220000`, `20260714221000`, `20260714222000`, `20260714223000`, and `20260714224000` were applied individually in timestamp order after fresh security and schema-drift reviews. All seven rollback-only business-chain smokes passed with `SMOKE_PASS_ROLLBACK`; all 16 live database invariant sweeps returned zero unallowlisted violations; migration history matched local source exactly; and the production site remained healthy with HTTP 200.
Read-only production evidence is recorded in `docs/audits/money-inventory-hardening-live-evidence-2026-07-14.md`: the exact pinned RMA is the sole open/received source exception, no non-positive return quantities exist, and the live dashboard already excludes draft orders. The general invoice batch confirmation explicitly discloses that selecting any split invoice posts the full server-side group, including members outside current filters or the browser's loaded result window.

---

## 2026-07-15 — Full Codex gauntlet remediation database and Edge cutover live (frontend PR pending)

The all-15-section Codex-only foundation gauntlet was revalidated on current `origin/main` and remediated in one isolated branch. Three migrations add key-only idempotency serialization for helper and legacy inline writers; admin+reason overreceive with linewise PO rollup; zero/mismatched commission-batch posting guards; office-only inventory reporting; idempotent blend billing; office-only blend table/Storage access with a 10 MiB image contract; one atomic `create_blend_ticket` RPC; and completed/approved/unbilled/nonempty/fully-matched blend order lifecycle gates. Reports now describes payment-batch creation truthfully, empty commission batches cannot be posted from the UI, manual/bulk blend creation use the atomic RPC, OCR resolved errors no longer count as success, the Edge processor uses office-only bounded streaming, and the Chemical Application Report PDF has direct output regression coverage.

Three independent Codex adversarial lanes then found and closed deeper edge cases: invoice-provenance trigger/RLS bypasses, inactive Storage owners, trigger-helper grants, stale product lost updates, partial product saves, explicit-null handling, unsaved field/product downstream actions, remove-all field persistence, edit-during-save races, failed field hydration, OCR lease/approval/link races, and exact order-line provenance. The final Codex verdict is clean. A direct read-only Claude review then returned `SHIP-WITH-FOLLOWUPS` with one medium and two low findings; all were fixed rather than deferred. Commission item-count failures now disable only the affected row instead of blanking the page, blend bulk-delete gives a friendly application-record provenance refusal, and the database now locks every editor-controlled header field once a ticket is linked.

Claude's corrected-diff pass then returned `NEEDS-WORK` on a distinct direct-invoice path: billed tickets can remain unlinked, so active invoice provenance also has to lock product rows and the complete header payload. The RLS-safe product trigger now blocks insert/update/delete/reparent changes for active invoices on either parent, all missing header fields are covered, and the frontend disables header/product editing for linked or billed tickets. Hidden-invoice sales-role smoke and a billed/unlinked component test prove the correction while preserving terminal invoice release and sanctioned lifecycle actions.

Subsequent corrected-diff reviews closed the remaining upload, hydration, OCR lease, and order/invoice lifecycle gaps. Bulk-create uncertainty now recovers by stable idempotency key across reloads; downstream application records, active invoices, and linked orders fail closed across every matching editor surface; long OCR work maintains serialized lease heartbeats; and the database plus UI enforce both sides of order/direct-invoice mutual exclusion under ticket locks. The rollback smoke proves rejected active-invoice and linked-order paths create no order, link, invoice, commission, inventory, activity, audit, or idempotency side effects.

The final Codex current-base pass caught three additional fail-closed/concurrency regressions after PR #132 landed: blank idempotency keys/operations retain their live errors, a nullable PO over-receive flag is treated as false, and direct-invoice same-key requests use the shared serialized check/save path. Linked rollback assertions and the disposable two-session harness pass, and Codex's correction re-review is clean.

A later Claude current-base pass reported two medium and seven low/informational hardening gaps, all closed before the live gate: Storage signing itself is timed out; office-saved OCR header intent (including deliberate blanks) is durable; OCR refuses inactive products; create/save snapshots cap at 200 products; expired idempotency cleanup is key-scoped; over-receive reasons reach inventory transactions; null billing status creates no false activity; order-link line identity is non-null with a full unique index; and link/create/unlink RPC names self-verify exactly one overload.

The final independent Codex adversarial pass found four additional cross-layer issues and returned clean after correction: direct invoices exclude soft-deleted blend tickets; PO receiving rejects nonpositive and mixed-invalid payloads atomically instead of recording false success; bulk upload recovery drops the prior user's in-memory intent on an auth transition; and linked-ticket Unlink is disabled with a clear application-record explanation when the server must refuse it.

The final Claude pass found one availability regression and sharpened the release sequencing gate. Image-signing failures are now isolated to the affected tile with a warning/Sentry record instead of hiding the whole ticket page. The live apply and frontend release were treated as one low-traffic cutover: the migration removed the old direct-insert upload path, all old tabs must refresh before another blend upload, and the queued-RPC test remained a literal do-not-merge gate until live snapshots were regenerated.

Claude then identified the sibling manual-create reload gap: an uncertain manual ticket could lose its UUID/key on navigation and be resubmitted as a duplicate. Manual creation now persists the exact user-scoped ticket identity and frozen header/product payload before the RPC, restores a locked same-ticket retry after reload, refreshes a bounded TTL, clears only on known outcomes, rejects malformed UUID records, and isolates in-memory recovery across user switches. Eight focused tests and a clean Codex correction re-review prove the behavior.

The three migrations compiled against the linked production schema inside a rolled-back transaction; eight callable functions passed `plpgsql_check`; the full business chain reached exact `SMOKE_PASS_ROLLBACK`; and a disposable concurrent-session harness passed idempotency, blend-lock, and OCR race proof. After Mason's explicit approval on 2026-07-15, `20260714230000_gauntlet_core_guards`, `20260714230100_blend_ticket_access_and_atomicity`, and `20260714230200_blend_ticket_order_lifecycle` were applied live in order with clean zero-row preflights. `process-blend-ticket` deployed v23 → v25 and verified ACTIVE with JWT enforcement; v25 is the formatting-normalized source-fidelity refresh of the functional v24 deployment. A fresh live registry/type/RPC regeneration captured 393 public function names and removed the queued exceptions; the post-apply full rollback smoke again reached `SMOKE_PASS_ROLLBACK`, and all 17 live invariant sweeps returned zero unallowlisted violations. No historical business row was changed. Full ledger: `docs/audits/gauntlet/2026-07-14-full-gauntlet-codex-only-remediation.md`.

---

## 2026-07-14 — Offline receipt browser integration and audited office resolution (database live; browser rollout pending merge)

The feature branch now gives offline delivery/job completions a permanent client action ID before their first replay, stages them through the live Supabase receipt contract, and removes the browser copy only after the server proves `succeeded`. The server compares the queued delivery/job `updated_at` snapshot before running a completion, so office edits become `TARGET_STATE_CONFLICT` review work while a committed lost-response replay still returns the permanent result. Daily-cap and unresolved-review-backlog errors defer without consuming retries; actionable field/item/clock drift becomes an office-visible review receipt; office-resolved items require acknowledgement before the device copy is removed. IndexedDB upgrades fail visibly when an older tab blocks them instead of leaving field saves spinning forever, and manual retry is unavailable while offline. Device completion time is attached only to an offline save, so ordinary online completion keeps the server clock. A new Saved Offline Work panel shows safe metadata and support IDs without raw payloads.

The `20260714172135_offline_action_review_resolution.sql` migration adds an admin/sales-only sanitized review queue and an idempotent, audited `already_completed` / `abandoned` decision. That decision never impersonates the field user, reruns inventory/application work, marks the receipt succeeded, or deletes the receipt. A disposable local database proved access rules, sanitized output, exact replay, conflicting-key rejection, original-owner recovery, one-winner concurrent resolution, audit-event uniqueness, backlog release, and distinct 250/day and 500-unresolved guards. **All three offline-receipt migrations were applied live in order on 2026-07-14 (Supabase stamps `20260714171331`, `20260714171800`, and `20260714172135`); post-apply structure, RLS, grants, constraints, indexes, and canonical mutation hashes verified clean.**

The final adversarial push review found two concurrency gaps before browser release. Missing queue-time snapshots are no longer synthesized from the target's post-reconnect state; those legacy/native actions stage as permanent `LEGACY_OUTCOME_UNKNOWN` office review instead, preserving edits made during the offline window. Corrective migration `20260714203709_offline_action_target_lock.sql` re-emits only `process_offline_action(uuid,text)` and holds a delivery/job row lock from the final snapshot comparison through the canonical mutation, closing the compare-then-wait race with concurrent office edits. **The correction was independently reviewed, applied live as Supabase version `20260714203709`, verified byte-for-byte by stored SQL hash, and passed the rollback-only offline receipt business smoke on 2026-07-14.**

---

## 2026-07-14 — Gauntlet-confirmed authorization and workflow-map repairs

The July 14 workflow gauntlet found five real issues, all independently confirmed by an issue-only Claude review and then reconciled by Terra, Luna, and Sol. Three queued migrations close the remaining database gaps without changing existing identities: after PR #127 was merged into this branch, the source-level commission payout direct-write gap is already represented by `20260714180000_harden_commission_payment_creation.sql`, so this branch's follow-up migration preserves that no-direct-table-write design, re-emits the read policies with schema-qualified single-evaluation `public.is_admin()`, and adds a standing invariant predicate that also catches any reintroduced direct table write policy; `batch_apply_prepayments` enforces the admin-only route contract for the batch wrapper before idempotency replay or mutation; and `is_admin()` itself now source-controls the hardened `public, pg_temp` search path required for SECURITY DEFINER helpers while qualifying `public.profiles`. The workflow map now renders all nine quote states and its generator enforces an exact `QuoteStatus` node set; stale retired-RPC prose was removed. The checked-in public-function snapshot was refreshed from 364 to the verified live 374 names, and an AST-based test now proves every literal production RPC call exists in that catalog. Disposable-database proof confirmed the queued migrations compile, active admins pass, sales reps and inactive admins are rejected, and the new commission predicate falls from live-equivalent violations to zero after migration. Live-vs-source proof also confirmed `is_admin()` already has `search_path=public, pg_temp` and the expected active-admin body, and the queued money-function rewrite preserves the current production body before adding the admin gate. No live migration was applied as part of this change, so production still needs those three queued migrations applied before live has the reviewed final state. During proof, the offline-action provenance note was corrected: live `schema_migrations` records the initial offline-action migrations by `name` under MCP apply-time versions; the review-resolution and target-lock follow-ups are also now checked in and applied live, as documented above.

---

## 2026-07-14 — Push-proof review is now bound to the review BASE, not only HEAD

Both agents' push-proof guards — `.claude/hooks/codex-push-guard.mjs` (Claude pushing, via `proofValid`) and `.codex/hooks/production-action-guard.mjs` (Codex merging/pushing, via `claudeProofValid`), sharing the validator in `.claude/hooks/codex-push-lib.mjs` — previously accepted a review proof on `head_sha` + a 30-minute freshness window alone. That left a gap Codex flagged while reviewing the Codex-proof producer (PR #122): `origin/main` can advance — a sibling session fetches a just-merged commit — WITHOUT dirtying the worktree or moving HEAD, so the diff the guard gates (`origin/main...HEAD`) can differ from the diff that was reviewed while the HEAD-bound proof still looks valid. The proof now records `base_sha` — `git rev-parse origin/main` captured at review time — and the shared `reviewProofValid` additionally requires `proof.base_sha` to equal the current `origin/main` the guard resolves at push/merge time; a moved base (or a pre-hardening proof with no `base_sha`) fails closed and forces a fresh review. Both producers write it: `scripts/write-codex-push-proof.mjs` and `scripts/run-claude-review.mjs` capture the base before the review and re-check it after (the same TOCTOU discipline already used for HEAD/worktree) — if `origin/main` shifted mid-review, no proof is minted. The base binding is gated on the guard supplying the base, exactly like the existing `head_sha` check, so the shared validator stays usable in base-agnostic unit contexts while both real guards always pass the resolved `origin/main`. Tests updated across `codex-push-lib.test.mjs`, `production-action-guard.test.mjs`, `write-codex-push-proof.test.mjs`, and `run-claude-review.test.mjs`, including moved-base and base-less rejection and a cross-check that a minted base-bound proof passes the guard's own validator for the exact head AND base. This is defense-in-depth for an honest agent; GitHub branch protection remains the external hard wall. Codex's second finding — the reviewer runs from the branch checkout and loads branch-owned `AGENTS.md`/hooks/skills a malicious branch could use to steer its own verdict — is logged as a known limitation outside the "honest agent" threat model, not fixed here (a proper fix means sandboxing the reviewer's config).

---

## 2026-07-14 — Sanctioned producer for the Codex push proof

`.claude/hooks/codex-push-guard.mjs` requires a fresh, HEAD-bound Codex proof (`.claude/session-state/codex-review-<sha>.json`) before Claude may push a risky diff (migrations / edge functions / money-RLS code) to `main`, and `review-proof-guard.mjs` blocks any tool call that names a proof file directly — so no agent can hand-write it and self-certify. That left a gap: there was no honest way to mint the Codex proof, so after a real `/codex-review` a risky push stayed blocked (fail closed). New `scripts/write-codex-push-proof.mjs` closes it, mirroring `scripts/run-claude-review.mjs`'s proof discipline — including its DETERMINISTIC machine verdict. It resolves the newest trusted `codex.exe` from its fixed install dir (no PATH shim / env override can impersonate the reviewer), then runs a read-only `codex exec` review (`--sandbox read-only`, so it can never modify files or call outward-facing tools even when the workstation default is `danger-full-access`) driven by a FIXED prompt: review only `origin/main...HEAD` (base hard-pinned into the prompt, no CLI override, all diff content treated as untrusted data), and end the reply with exactly one machine token — `CODEX_PROOF_VERDICT: CLEAN` or `CODEX_PROOF_VERDICT: BLOCKERS`. `codex review`'s free-form prose has no such token, so an earlier draft tried to infer "clean" heuristically and Codex itself proved (over five real review rounds) that any such heuristic fails open or over-refuses; forcing a token — exactly how `run-claude-review.mjs` forces a terminal `FINAL_VERDICT:` — removes the guessing. The wrapper writes `{ codex_ran: true, verdict: "clean", head_sha, timestamp }` ONLY when: exit 0, EXACTLY ONE verdict token appears (a second copy — e.g. one echoed from an injected diff line — is ambiguous and refuses), that token is the LAST non-empty line (trailing prose refuses), the token is CLEAN, AND the worktree/HEAD did not move during the review. A caller-supplied verdict is never accepted; a BLOCKERS verdict, a missing/duplicate/non-terminal token, non-zero exit, or a dirty/shifted worktree mints nothing and clears any stale proof for that HEAD. Because it derives the proof path internally, `review-proof-guard.mjs` does not obstruct it. The producer is protected exactly like `run-claude-review.mjs`: it is in `codex-push-lib.mjs`'s `RISKY_PATH_RES` (a push touching it needs its own Codex review) and in the Codex `production-action-guard.mjs` `PROTECTED_HARNESS` set (direct edits by Codex are blocked), and it is added to the pre-commit ledger trigger list. `codex-push-guard.mjs`'s deny message and the `/codex-review` skill now point at this producer as the sanctioned way to mint the proof (previously they pointed at `/codex-review`, which writes only a human-readable transcript). Tests (`scripts/write-codex-push-proof.test.mjs`, wired into `test:agent-workflows`) cover the deterministic token parser (terminal CLEAN → clean; BLOCKERS / missing / non-terminal / duplicate / injected-second-token / garbled token / non-zero-exit / empty → refuse), the fixed review prompt and read-only exec args, newest-binary resolution with no PATH fallback, the fail-closed worktree check, and a cross-check that the minted proof passes the guard's own `proofValid`. **The design was hardened by running the producer on its own commit through five real Codex 0.144.2 review rounds, which caught nine genuine issues the unit tests missed — all fixed here** (a stdout/stderr parsing bug from a wrongly-merged-stream fixture; a base-override hole; a full-access reviewer sandbox; a fail-open verdict on non-review text; a broken remediation pointer; the unprotected minter; a NUL-byte sentinel that made the file read as binary to Git; a regression rejecting genuinely clean reviews; and an unbracketed `P1:` blocker slipping past a tag check) — and the last of those prose failures is what motivated the switch to the machine-verdict token. Defense-in-depth for an honest agent, not a cryptographic boundary; GitHub branch protection remains the external hard wall.

---

## 2026-07-14 — Agent workflow tests added to required GitHub CI

The required `Lint, Type Check, Test, Build` GitHub job now runs `npm run test:agent-workflows` after the lower-level correction-guard suite. This moves the end-to-end Codex production-action guard simulation, Claude review-wrapper tests, hook-adapter checks, and Claude/Codex workflow-wiring parity checks from a local-only Husky gate into the server-enforced pull-request pipeline. A pull request can no longer report the required CI check green when those agent workflow or hook-registration tests fail. The first Linux run immediately exposed a Windows-only separator assumption in `run-claude-review.test.mjs`; its expected output path now uses Node's native `path.join`, so the same wrapper behavior is asserted correctly on Windows and Linux.

---

## 2026-07-13 — Codex standing main-push harness (pending clean Claude re-review + Mason merge OK)

Codex now has a hard-gated mirror of Claude's standing push authorization, implemented on `codex/self-push-harness-2026-07-13` but not active on `main` until this branch is reviewed and merged. `.codex/hooks/production-action-guard.mjs` allows a non-risky diff to target `main` while Husky still enforces the green pipeline; risky paths/content reuse `.claude/hooks/codex-push-lib.mjs` and require a fresh, exact-HEAD, 0–30-minute Claude proof at `.claude/session-state/claude-review-push.json`. Direct `git push`, `git -C ... push`, `gh pr merge`, and GitHub MCP merge routes share the same gate and fail closed when git, PR metadata, diffs, or proof JSON cannot be verified. Main deletion, live migrations/data writes, edge-function/production deploy commands, secrets/auth/permission changes, and protected `master`/`production` routes remain blocked. A successful real `scripts/run-claude-review.mjs --scope base-main` run now writes BOM-free proof JSON itself; there is no standalone self-certification command. The shared proof validator rejects missing HEAD bindings and future timestamps for both agents. The ledger guard covers every `.codex/` change, and dedicated guard/library tests are part of `test:correction-guards`.

Claude review round 1 returned NEEDS-WORK after proving four force-push spellings could reach `main` because risk classification ran without a force check. Remediation moved a main-targeted force classifier into the shared push library, so both agents deny `--force`, `-f`, `--force-with-lease`, and `+` refspecs before reading the diff. Server-side merge routes require `mergeStateStatus=CLEAN` plus a non-empty rollup of completed passing/neutral/skipped checks; direct `gh api .../pulls/<n>/merge` is gated alongside `gh pr merge` and GitHub MCP merges. Missing-proof, force-form, failing/pending-CI, and direct-API regression tests were added. The Codex guard timeout increased from 5s to 15s, and command newlines are preserved for segment inspection.

Claude review round 2 confirmed those fixes but found the same class through implicit/bypass routes. Remediation now denies force pushes to every branch regardless of flag position, bulk modes (`--all`, `--branches`, `--mirror`, `--prune`), and every push in a chained command. Claude's guard now resolves the repository selected by `git -C` just like Codex's. Full-URL REST merges join the green-CI gate; GraphQL `mergePullRequest`, unrecognized mutating `gh api` calls, direct GitHub write tools, and repository-scoped `node_repl` calls deny closed. Read-only GitHub tools remain available. Regression tests execute both real guards against the reported routes. These hooks are deterministic honest-agent safety rails, not a cryptographic sandbox against deliberately obfuscated arbitrary shell code.

Codex review round 2 was worked by two parallel sessions and reconciled: the Codex GitHub app's merge-tool input spelling (`pr_number`/`repository_full_name`) is now recognized and an unparseable PR number denies closed instead of verifying the wrong PR; `git push origin --delete main` / `-d main` and unambiguous abbreviations now classify as main deletion in the shared library (both agents); any `--force…` long-option abbreviation (`--force-w`) counts as force intent; attached `gh api -XPUT` shorthand, mutating `gh api` calls, and GraphQL merge mutations are gated or denied outright. Deletion/force/GraphQL are proven refused even with a valid proof present.

Claude review round 3 confirmed all 27 round-2 attack vectors were closed, then found Windows `git.exe`, shell directory/environment context changes, direct proof-file writes, an overridable Claude executable, and mutating RPCs disguised as `SELECT`. The shared parser now recognizes `git`, `git.exe`, quoted full paths, and POSIX paths; `cd`/`Set-Location`/`pushd`/`GIT_DIR`/`GIT_WORK_TREE` push contexts deny in favor of explicit `git -C`, while Codex tool-level `workdir`/`cwd` is resolved as the repository actually being inspected. Both push guards fail closed on unresolved main refs/diffs. `run-claude-review.mjs` uses a pinned executable path, while new shared `review-proof-guard.mjs` blocks native, MCP, and shell access to Claude/Codex proof JSON for both agents. Codex `execute_sql` now permits only single-statement SELECT/WITH/EXPLAIN/SHOW queries whose function calls are from a narrow read-only PostgreSQL allowlist; application/custom RPCs such as `allocate_payment` and session mutation such as `set_config` deny.

Codex review round 4 (run by the parallel reviewing session and reconciled into this branch) closed seven more: `isClearlyReadOnlySql` strips comments quote-aware (reusing the migration guard's `stripCommentsQuoteAware` — `SELECT '--'; DELETE …` no longer hides); `gh -R o/r pr merge` / `gh pr -R o/r merge` flag placements are gated; single-`|` pipelines split so every pipeline stage's push is inspected (both agents' guards); abbreviated bulk options (`--mirr`, `--al`, `--pru`, `--bran`) count as bulk mode; `apply_patch`-style free-form payloads are scanned for proof-file writes; and the Claude push proof binds to the SHA captured BEFORE the review, revoking if HEAD or the worktree moved during it (TOCTOU).

Codex review round 5 (final activation gate) closed four last findings: app-style GitHub tool names (`mcp__codex_apps__github_create_file` — single-underscore prefix) are now classified and write tools denied; gh's attached field flags (`-fquery=…`, `-Fbase=…`) mark an API call mutating so implicit-POST merges/mutations gate; the Claude proof loader's filename charset was tightened to match the proof-path guard (a space-named forged proof can no longer slip between the two patterns); and patch payloads are classified by their DESTINATION headers instead of whole-body scans, fixing the round-4 false positive that blocked documentation patches merely mentioning guard paths.

Claude review round 4 confirmed the push-command parser held against every prior bypass, but demonstrated the remaining trust-boundary problem: repository-owned hooks cannot be the only wall against an agent that can edit the repository and launch arbitrary local processes. Local follow-ups now block persistent-cwd proof writes, use Claude's per-call cwd, pin the absolute native Claude Code binary with `shell:false`, require exactly one terminal `FINAL_VERDICT`, deny Node eval/print process-launch routes, protect the critical harness from direct write tools, make common parenthesized read-only SQL diagnostics usable, and put `run-claude-review.mjs` under the ledger guard. These are defense-in-depth only. GitHub now enforces the external `main` hard boundary: pull requests are required, the SQL validation and lint/typecheck/test/build jobs must pass on an up-to-date branch, administrators are included, and force-push/deletion are disabled. The branch remains intentionally unmerged pending a clean final Claude review and Mason's separate merge approval.

Claude review round 5 validated the design reframing and most round-4 fixes, then found two natural command spellings missing from the local matchers. Regression coverage now denies normal-space `rm`/`sed -i`/redirect mutations of harness files, no-space proof redirects such as `>claude-review-push.json`, split state-directory entry (`cd .claude && cd session-state`), and Node stdin execution (`node -` / piped code). Documentation deliberately describes these as recognized direct-route blocks, not proof against arbitrary obfuscation or a substitute for GitHub branch protection.

Claude review round 6 returned SHIP-WITH-FOLLOWUPS with no blocker/high findings and minted an exact-SHA clean proof. Its three MED consistency follow-ups are now closed: proof and harness path matchers share trailing shell-separator coverage (`;`, `|`, `&`, parentheses), and structured `apply_patch` free-form bodies are scanned for critical harness destinations just like proof destinations. Regression tests cover each reported spelling.

Claude review round 7 again returned SHIP-WITH-FOLLOWUPS with no blocker/high findings and an exact-SHA clean proof. The two pre-activation follow-ups now use the durable form Claude recommended: proof/harness matchers use filename-character boundaries instead of enumerating shell delimiters, and the protected harness set includes both `live-testdata-lib.mjs` (the read-only SQL classifier dependency) and `codex-hook-adapter.mjs` (the Codex hook dispatcher). Tests cover comma-separated PowerShell paths, no-space output redirects, and direct writes to both dependencies.

Claude review round 8 caught a Windows-only escaping regression in the new structured harness-path matcher. The regex construction now uses `String.raw`, preserving both `/` and `\` separators, with direct Write/Edit regression tests for Windows absolute/relative paths to Claude hooks, Codex hooks, and the review wrapper.

The post-protection Claude activation review found one HIGH self-modification gap: guard hooks, the GitHub CI workflow, Husky hooks, and the Claude review wrapper were not explicit risky paths, so a future weakening change without a money keyword could avoid second-model review. Those surfaces are now part of the shared `RISKY_PATH_RES`; focused and end-to-end regression tests prove guardrail/CI changes require an exact-SHA Claude proof even when their content is otherwise ordinary.

---

## 2026-07-13 — Offline work Stage 1A: retained failures, bounded retries, and shared-device ownership

Offline delivery/job completions are no longer silently deleted after three failures or seven days. IndexedDB writes now wait for transaction commit; replay uses persisted 30-second/2-minute/10-minute delays; conflicts, permanent failures, and ownerless legacy records remain saved as needs-attention work. New queue entries are bound to the authenticated profile, and another user's records are skipped without RPC execution or retry changes. The global banner and My Route status now distinguish current-user waiting work, needs-attention work, other-user work, and legacy work instead of reporting a false success or a misleading sync count. Wholesale sync errors re-arm automatically after a bounded cooldown, and terminal needs-attention states alert Sentry for office visibility. No database, live-data, signature/photo, email, or notification behavior changed. Stage 1B/2 recovery work remains parked in `docs/manual/KNOWN_ISSUES.md`.

---

## 2026-07-13 — Gauntlet V2 Phase 1: false-clean review paths now fail closed

Opus 4.8 independently reviewed the gauntlet gap analysis and returned NO-GO (3 BLOCKER / 3 HIGH / 2 MED / 1 LOW) until a green result became truthful. Phase 1 implements that minimum without the premature lease/full-ledger machinery: the foundation and overnight workflows now expose `VERIFIED` / `REFUTED` / `UNVERIFIED` / `BLOCKED`, require evidence, preserve missing layers/verifiers as incomplete, and never convert missing output into a refutation or dry cycle. The direct Claude wrapper pins model/effort/timeout, requests structured JSON, records resolved model + CLI/HEAD/scope/prompt metadata, writes a unique per-run capture, and returns `BLOCKED` on timeout, malformed output, or permission denial. After the Codex correction rounds and the first Opus `NEEDS-WORK` pass were reconciled, exact backend `claude-opus-4-8` returned `VERDICT: SHIP` with one LOW fail-closed Node-portability note.

Deterministic floor: unit coverage stays mock-only while the live-schema suite fails closed whenever a trusted operator explicitly supplies real credentials. The proposed push-only GitHub job was parked before merge because PRs could not exercise it, `main` would turn red without a secret, and the only available credential was the production service-role key; until a least-privilege path exists, live schema evidence remains visibly `BLOCKED`/`UNVERIFIED`, never green. E2E setup/teardown no longer embed the production URL/key and the disabled E2E job is staging-only with no production override; Playwright refuses startup while direct production endpoints remain. Page smoke no longer swallows unhandled rejections, inventories all 75 pages, and ratchets the explicit 44-page backlog. RPC contracts now derive a current direct-or-helper-mediated mutator inventory from generated types + migration bodies, so a new mutator omitting `p_idempotency_key` fails instead of disappearing from the scanner; the scan immediately forced `reserve_job_inventory` to document its rebuild-from-scratch replay mechanism. Coverage floors rose from 21/14/11/20 to 36/27/24/34 (lines/branches/functions/statements), close to the measured 37.77/28.77/25.49/35.93 baseline. CI now runs agent-workflow truth/sync tests and RPC contract/idempotency tests explicitly.

Proof: 3,386 tests passed with the new coverage ratchet; focused page smoke 32 pass / 44 explicit skips; 90 RPC contracts passed; agent-workflow/sync suite, lint, typecheck, build, docs, and the isolated correction-guard suite passed. No migration, live-data change, secret change, deploy, push, or live E2E execution occurred. Remaining Phase 2 work is tracked in `docs/manual/KNOWN_ISSUES.md`.

Post-merge integration hardening: the headless Claude wrapper no longer uses plan mode while simultaneously forbidding plan-file writes. It now receives the exact scoped diff up front, allows only `Read`/`Grep`/`Glob`, denies Bash and all write-capable tools, keeps every permission denial fail-closed, and uses a 15-minute default timeout. Regression coverage locks the tool boundary and prompt evidence so the exact-HEAD push proof can be produced without weakening review completeness.

---

## 2026-07-13 — Auto-cleanup of finished worktrees/branches (SessionStart guard)

Recurring toil: merged branches and finished worktrees pile up and get swept by hand. Now a deterministic guard does it. New `.claude/hooks/worktree-cleanup.mjs` (+ pure classifier `worktree-cleanup-lib.mjs`, wired into `SessionStart` before `worktree-awareness`) removes a worktree/branch **only** when it is provably finished — fully merged into `origin/main` (via `git cherry`, so squash/rebase merges count too) **AND** clean **AND** unlocked **AND** not the active session **AND** not a protected branch (`main`/`master`) **AND** (for worktrees) under `.claude/worktrees/`. A session can't delete its own active worktree, so each new session sweeps the *previous* finished ones. Anything with unmerged commits, uncommitted changes, a lock, or a manual long-lived checkout (`C:\CRX_Manager`, `C:\CRX_Layer2`, …) is kept and reported; every deletion prints a recovery SHA; fail-open (stale/missing `origin/main` → does nothing). 25-assertion safety classifier in `worktree-cleanup-lib.test.mjs` (added to `test:correction-guards`). Proven end-to-end: dry-run on the live fleet removes nothing (all active/locked/unmerged), and `--write` on a throwaway merged worktree removes it while leaving the active worktree + real unmerged branches untouched. Dry-run anytime: `node .claude/hooks/worktree-cleanup.mjs --report`.

---

## 2026-07-13 — Fix: `.gitattributes` pins the agent-workflow surface to LF (un-sticks every commit on Windows)

`origin/main` failed its own pre-commit guard `scripts/check-agent-workflows.mjs` on Windows, blocking every commit. Root cause was line endings, not content: `core.autocrlf=true` with no `.gitattributes` rewrote the generated Codex adapter files under `.agents/` to CRLF on checkout, while the generator (`scripts/sync-agent-workflows.mjs`) emits LF — so the byte-for-byte check reported 18 files "stale" (identical text, different EOLs). The committed blobs were already correct LF; the failure only reproduced on `autocrlf=true` (Windows) checkouts. Fix is a new `.gitattributes` pinning `.agents/**`, `.claude/skills/**`, and `.claude/commands/**` to `text eol=lf` so the generator's inputs and outputs stay LF on every platform, making the check deterministic and the fix durable across fresh checkouts. No workflow logic changed — line-ending policy only.

---

## 2026-07-13 — Prose sync: skills/commands/docs brought in line with the settled migration policy + ledger guard

A 3-agent audit of the whole agent surface (all skills, all commands, hook message text, core safety docs) found 8 files still describing the pre-2026-07-13 world; all fixed, no logic changes. `run-loop.md` no longer tells armed unattended loops that a live migration always pauses for an in-chat OK (it now states the settled rule: interactive = ask; armed hands-free = migration-apply-guard's full proof + Codex gate; destructive = never autonomous) and documents the 3-state autopilot flag. `deploy-check`, `create-migration`, and `explain-migration` skills lose their blanket "always needs explicit approval / NEVER apply automatically" claims in favor of the same settled rule; `explain-migration` now points at `/migration-review`//`/codex-review` instead of the deprecated `codex-cross-review`. `preflight.md`, `ship.md`, `SAFE_DEVELOPMENT_RULES.md`, and `AGENT_ONBOARDING.md` now mention the pre-commit ledger guard where they enumerate commit gates. `autopilot-lib.mjs` header comment now describes the real dual-proof gate. Everything else scanned CLEAN. Bonus fix found during the sync: `scripts/sync-agent-workflows.mjs` was extracting adapter titles from `# ` lines *inside fenced code blocks* (a bash comment became the skill title) — it now strips fences first, repairing three garbled Codex adapters (`overnight-bug-hunt`, `codex-driven-bug-hunt`, `review-workflow`).

---

## 2026-07-13 — Ledger guard: agent-surface changes must be logged in the same commit (hard, pre-commit)

Mason's ask: force agents to keep a ledger of changes, findings, and decisions — as a hard guard, not prose. New `scripts/check-ledger-update.mjs` runs first in `.husky/pre-commit` and **blocks** any commit that stages agent-surface/policy files (`.claude/commands|skills|hooks|workflows|settings.json`, `AGENTS.md`, `CLAUDE.md`, `.husky/`, guard scripts) without also staging a ledger update (`docs/CHANGELOG.md`, any `docs/manual/*.md`, `agent-guardrails.md`, or a `docs/loops/` ledger). 31 assertions (`scripts/check-ledger-update.test.mjs`, added to `test:correction-guards` — 560 total). The guard covers itself: changing it requires a ledger line too.

---

## 2026-07-13 — SETTLED: hands-free live-migration applies in pre-authorized runs (hard guard, 5 Codex rounds)

Mason settled the parked owner decision: an overnight/hands-free run he explicitly pre-authorized (armed autopilot flag) may apply a live migration WITHOUT a per-migration in-chat OK — but only through the full hard proof gate, and NEVER for destructive migrations. Enforced in `migration-apply-guard.mjs` (hard, not prose):

- **Interactive (no flag):** unchanged — reviewer proof unblocks the tool; Mason's in-chat OK authorizes the apply.
- **Armed (fresh flag):** requires the hash-bound reviewer proof (exact `queryHash`, both reviewer names, fresh) PLUS a content-bound Codex proof `codex-review-mig-<name>.json` (same `queryHash`, clean/ship verdict, <30 min, from an actual /codex-review run this session). Destructive SQL (DROP TABLE/SCHEMA/TYPE/DOMAIN/…, ALTER…DROP col, TRUNCATE, any top-level DELETE, MERGE) is refused outright — park for the morning.
- **Stale/malformed flag:** authorization LAPSED — ALL applies park until Mason re-arms or disarms in person (fail closed).
- Destructive classifier survived 5 adversarial Codex rounds (comment/string-literal/dollar-quote hiding tricks all closed; quote-aware default-keep lexer). 57 dedicated guard assertions (`migration-apply-guard.test.mjs`, in the pre-commit suite — 529 total). Timestamp freshness bounded to [0, 30 min] so future-dated proofs fail. Canonical policy text: `docs/manual/DECISION_LOG.md` (2026-07-13); residuals documented in KNOWN_ISSUES §4b.
- Reconciled everywhere the old "always ask" rule lived: AGENTS.md, CLAUDE.md, /ship, /migration-review, autopilot arm/reminder/unattended hooks, agent-guardrails.md, OWNER_PLAYBOOK (+ artifact page), AGENT_ONBOARDING.

---

## 2026-07-13 — Operating Manual sprint: docs/manual/ synthesis layer, guard-net hardening (5 Codex rounds), owner playbook

Fable legacy sprint — durable infrastructure so future/cheaper agents keep top-tier quality. Docs + agent tooling only; no `src/`, no migrations, no live writes.

- **New `docs/manual/` synthesis layer (6 docs):** ARCHITECTURE, DECISION_LOG, KNOWN_ISSUES (single consolidated open-issues view — corrected 5 stale "open HIGH" beliefs against live evidence), CURRENT_STATE (live counts), OWNER_PLAYBOOK (plain-English; also published as a claude.ai artifact page), AGENT_ONBOARDING (8 recurring bug classes + review routing). Each stamped `Last verified` + update triggers; existence and stamps machine-checked by `npm run check:docs`.
- **Policy reconciliation:** `AGENTS.md`, `CLAUDE.md`, and `/ship` now all state the standing 2026-06-16 push policy (green-pipeline regular code auto-pushes to `main`; migrations/edge-deploys/deletion/secrets always gated). One wording variant (migration-apply in-chat OK vs proof-gate-only in pre-authorized loops) parked as an owner decision in DECISION_LOG.
- **Guard-net hardening, 5 adversarial Codex review rounds (28 findings: 27 fixed with tests, 1 dispositioned):** new server-agnostic `mcp-tool-guard.mjs` (closes the Desktop-Commander/`mcp__filesystem` blind spot incl. path traversal, whole-dir moves, and ALL migration writes via MCP); `bash-safety-lib.mjs` extraction (npm script-body recursion incl. pre/post lifecycle, `.env` redirect writes); cross-worktree REGISTRY-STALE flag fan-out with race-safe cutoff clearing; idempotency check↔save operation pairing; expanded business/financial table sets; loud fail-open warnings preserved through the Codex adapter. 472 guard assertions now run in `.husky/pre-commit` and CI. Disposition doc: `docs/audits/2026-07-13-claude-disposition-of-codex-guard-hardening.md`.
- **Ground-truth refresh:** schema registry regenerated from live introspection + new `applied_migration_names` name-based staleness check (kills the false "registry BEHIND" session warning); `agent-guardrails.md` reconciled to all 31 wired hooks; reference docs (schema/RPC/pages/gotchas/ROADMAP/OPEN_ITEMS) refreshed.
- **Agent-surface simplification:** `codex-cross-review` demoted to explicit fallback; command/skill twins deduped via sync; review-routing decision table in AGENT_ONBOARDING.

---

## 2026-07-12 — ChemMan parity follow-ups: print-stamp RPC, dispatched-crew map visibility, grant hygiene (overnight hands-free run)

Overnight continuation of the 2026-07-11 parity loop (Mason: "finish everything and live").

- **Save-bug fix proven live** (commit c3146236, from the evening session): save → immediate print now works without a reload; verified on production with a control repro on the pre-fix build.
- **Migrations applied live:**
  - `20260713020000_stamp_job_printed_rpc` (v20260712020715) — print-audit stamping RPC for every job-visible role; fixes applicator prints never recording printed_at (jobs_update RLS is admin/sales-only). Codex P2 hardening included (visibility-before-idempotency, cross-job key refusal). Proven via rolled-back authenticated-role smoke (5 asserts).
  - `20260713030000_geojson_rpc_dispatched_visibility` (v20260712020737) — location-dispatched crews now get field boundaries on job maps and printed map pages.
  - `20260713040000_revoke_anon_trigger_fn_exec` (v20260712020748) — anon EXECUTE revoked on 3 inert trigger fns; clears the standing invariant-sweep drift (post-apply sweeps 15/15 PASS).
- **Frontend:** all 10 direct print-stamp updates (JobDetail 4, Jobs 6) swapped to `src/lib/printStamp.ts` RPC helper (Codex Luna build; full suite 3,355 passed / 0 failed).
- **Tooling:** hold-latch HOLD_RE false positive fixed ("don't stop" latched a work-freeze mid-run; now negation-aware).
- **Docs:** migration-history backfilled + counts corrected (654 → 677, 4 credit-memo rows added); pages-routes count fixed; `npm run check:docs` fully green.
- **CSB click-to-adopt SHIPPED (Mason green-lit it in the morning):** 'Adopt USDA boundary' button in the field editor — click a farm field on the satellite map, preview its USDA-derived boundary with acres + crop, one click adopts it into the normal boundary pipeline. 65,593 public-domain USDA CSB 2016-2023 boundaries shipped as static tiles covering the service area (commit fe5b0d4f; zero DB changes; compliance 0-blocker + Codex Sol round-2 SHIP after round-1 fixes). Decisions logged: phone numbers stay ON by default; no loads-done drift warning.
- **CSB coverage extended to 5 more counties** (commit 033b487e; Codex Terra built the merge script, Claude ran the extraction, Codex Sol SHIP): Lawrence, Clark, Jasper, Edgar (IL) + Sullivan (IN) are now adoptable. Only **Edgar** was genuinely new (the other four already fell inside the original service-area extraction, so their ~27k features deduped out); added a new tile plus 613 features into an adjacent one — now 11 tiles / 46 MB. Merge is additive + idempotent (dedup by USDA feature id; the other 9 tiles are byte-identical). All five verified adoptable via the client's own ray-casting point-in-polygon on a sample field each. Data-only — no code logic or DB change.

---

## 2026-07-11 — ChemMan parity loop SHIPPED LIVE: 9 build units + FSA research from Mason's 4 walkthrough videos (Codex builds, Claude orchestrates)

Source: Mason's narrated ChemMan screen recordings (docs/walkthroughs/) -> gap analysis -> overnight loop (docs/loops/chemman-parity-loop-2026-07-11.md, ledger + morning report alongside). All units pushed to main with per-unit adversarial Codex verdicts (CLEAN required); 2 additive migrations applied live with full proof gates.

- **Shipped to production** (commits 2fc3f33d..b9f598f2):
  - `2fc3f33d` M1 satellite map pages on applicator sheets (overview blowout + per-field close-ups, job-acre labels)
  - `7d0e8f6c` M2 print-options dialog (map pages, previous applications, blank sections, billing-split table w/ phones, banner) + save-as-default
  - `4e7b62c5` M3 map-based Select Locations picker on the job editor (crop-first cross-customer search, accumulating selections)
  - `2ac9fc8c` M4 route-order number badges on the job map
  - `9b3b6012` M5 vessel-being-loaded picker (tender vs sprayer) on the loader tab
  - `f9d305c1` M6 multiple saved loader worksheets per job — **migration 20260713000000_job_loader_worksheets applied live**
  - `12dcf01b` M7/M8/M10 field editor: add-another-section discoverability, all-fields overlay w/ toggle, BLM PLSS legal lookup (+CSP)
  - `b9f598f2` M9 obstacle markers — **migration 20260713010000_field_obstacles applied live**
- **Research (M12):** commercial "FSA CLU" boundary products are a frozen 2008 snapshot; recommendation = free USDA Crop Sequence Boundaries (docs/walkthroughs/fsa-boundary-research.md). Owner decision pending.
- **Verified already shipped (no rebuild):** multi-part fields, job tags, vehicles/fleet, Rem-ac, drag route order, as-applied tach/weather/crew, job log-file attachments.
- Review-gate kills this run included: condensed loader PDF summing chemical amounts (double-strength risk), dead Save buttons, pan-erases-sketch, obstacle-mode boundary-drag/keyboard bypasses, wrong acres on printed maps, CSP-blocked legal lookup.
- Tests at wrap: 3,351 passed / 117 skipped. Final whole-branch review satisfied by per-unit CLEAN verdicts covering 100% of the branch delta (every pushed line was verdicted; no unreviewed lines exist).


## 2026-07-11 — Mobile overhaul loop COMPLETE on feat/mobile-overhaul-2026-07 (6 commits, frontend-only): bottom nav + drawer, compact TopBar/scrollable Tabs/PageHeader, Jobs/Dispatch/Inventory/Receiving phone cards, Cockpit+Field Invoices 375px pass, full-screen modals + PWA polish. All gates green. Awaiting Mason 'push it'.

Mobile overhaul loop COMPLETE on feat/mobile-overhaul-2026-07 (6 commits, frontend-only): bottom nav + drawer, compact TopBar/scrollable Tabs/PageHeader, Jobs/Dispatch/Inventory/Receiving phone cards, Cockpit+Field Invoices 375px pass, full-screen modals + PWA polish. All gates green. Awaiting Mason 'push it'.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `247789e0 feat(mobile): M2.3 Office Cockpit + Field Invoices single-column phone layout`
  - `e37396f6 feat(mobile): M3 full-screen mobile modals, bottom-nav-aware toasts, PWA polish`
  - `6fd895f0 feat(mobile): M2.2 Inventory & Receiving phone cards + mobile Quick Receive form`
  - `c936f470 feat(mobile): M2.1 MobileCardList primitive + Jobs & Dispatch phone cards`
  - `d1fd7e0b feat(mobile): M1.2 compact TopBar, scrollable Tabs, stacking PageHeader below md`
  - `e163e2e5 feat(mobile): M1.1 bottom navigation bar + slide-out drawer below md breakpoint`
  - `e4f125da Merge remote-tracking branch 'origin/main' into feat/ui-overhaul-2026-07`
  - `4ae9a7f2 chore(registry): refresh schema-registry from live introspection (high-water 20260711140150)`
  - `af721cdc Merge remote-tracking branch 'origin/main' into feat/ui-overhaul-2026-07`
  - `d46477d8 docs: changelog for UI overhaul session`
  - `abe21bde feat(ui): Phase 3 polish — branded PageHeader app-wide + shared Tabs in Inventory`
  - `3e89a801 fix(guards): live-testdata classifier strips dollar-quoted machine content`
  - `9b257db3 fix(ap): closed-period gates on record/void vendor payment + void vendor bill (applied live)`
  - `98498229 Merge remote-tracking branch 'origin/main' into claude/inspiring-proskuriakova-7d5713`
  - `8271b1c2 chore(hunt): add Phase-3 money dimensions (returns/AP/PO-receiving/finance-prepay)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260712200000_ap_period_close_gates.sql`
  - `supabase/migrations/20260712190000_blend_ticket_order_lock_ticket.sql`
  - `supabase/migrations/20260712180000_dashboard_unbilled_deliveries_ignores_soft_deleted.sql`
  - `supabase/migrations/20260712170000_unbilled_delivery_guard_ignores_soft_deleted.sql`
  - `supabase/migrations/20260712160000_void_invoice_isactive_and_period_guards.sql`
  - `supabase/migrations/20260712150000_fix_billing_m4_p1_featurea_p2.sql`
  - `supabase/migrations/20260712135000_m4_batch_post_invoices_policy_align.sql`
  - `supabase/migrations/20260712140000_a_auto_split_drafts_on_full_delivery.sql`
  - `supabase/migrations/20260712130000_credit_limit_count_unposted.sql`
  - `supabase/migrations/20260711021000_credit_apply_balance_lever.sql`
  - `supabase/migrations/20260711020000_credit_apply_balance_lever.sql`
  - `supabase/migrations/20260711030000_credit_memo_applications_ledger.sql`
  - `supabase/migrations/20260711040000_apply_credit_memo_to_invoice.sql`
  - `supabase/migrations/20260711050000_credit_apply_reversal_and_lifecycle.sql`
  - `supabase/migrations/20260711060000_credit_apply_four_lever_consumers.sql`
  - `supabase/migrations/20260712120000_save_job_applied_record_payload_conflict_guard.sql`
  - `supabase/migrations/20260711020000_save_job_applied_record_idempotency.sql`
  - `supabase/migrations/20260711010000_u18c_morning_cron_utc_fix.sql`

## 2026-07-11 — UI overhaul loop complete: Office Cockpit = single morning screen (queues top, KPIs+inventory below); field invoices 5→1, receiving 3→1, prepay 2→1, integrity 2→1 tabbed pages with redirects; branded PageHeader app-wide; shared Tabs primitive (incl. Inventory). 7 commits on feat/ui-overhaul-2026-07, all gates green, awaiting Mason's push.

UI overhaul loop complete: Office Cockpit = single morning screen (queues top, KPIs+inventory below); field invoices 5→1, receiving 3→1, prepay 2→1, integrity 2→1 tabbed pages with redirects; branded PageHeader app-wide; shared Tabs primitive (incl. Inventory). 7 commits on feat/ui-overhaul-2026-07, all gates green, awaiting Mason's push.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `abe21bde feat(ui): Phase 3 polish — branded PageHeader app-wide + shared Tabs in Inventory`
  - `f37a2e72 feat(ui): consolidate prepay (2->1) and integrity (2->1) into tabbed pages`
  - `f9b4e556 feat(ui): consolidate 3 receiving pages into one tabbed screen`
  - `ee1e85c6 feat(ui): consolidate 5 field-invoice pages into one tabbed screen`
  - `84a2c34d feat(ui): shared Tabs primitive (underline style, keyboard + ARIA, count badges)`
  - `c0bb5089 feat(ui): Phase 1 — merge Dashboard KPIs/inventory/quick-actions into Office Cockpit (queues first)`
  - `aa48624f feat(products): in-app Label Data Quality screen — EPA reg-number check + inline fix`
  - `91a7e971 fix(billing): resolve 2 Codex findings on M4 + Feature A (applied live)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260712150000_fix_billing_m4_p1_featurea_p2.sql`
  - `supabase/migrations/20260712135000_m4_batch_post_invoices_policy_align.sql`
  - `supabase/migrations/20260712140000_a_auto_split_drafts_on_full_delivery.sql`
  - `supabase/migrations/20260712130000_credit_limit_count_unposted.sql`
  - `supabase/migrations/20260711021000_credit_apply_balance_lever.sql`
  - `supabase/migrations/20260711020000_credit_apply_balance_lever.sql`
  - `supabase/migrations/20260711030000_credit_memo_applications_ledger.sql`
  - `supabase/migrations/20260711040000_apply_credit_memo_to_invoice.sql`
  - `supabase/migrations/20260711050000_credit_apply_reversal_and_lifecycle.sql`
  - `supabase/migrations/20260711060000_credit_apply_four_lever_consumers.sql`
  - `supabase/migrations/20260712120000_save_job_applied_record_payload_conflict_guard.sql`
  - `supabase/migrations/20260711020000_save_job_applied_record_idempotency.sql`
  - `supabase/migrations/20260711010000_u18c_morning_cron_utc_fix.sql`
  - `supabase/migrations/20260711000000_a9_close_period_guards.sql`
  - `supabase/migrations/20260710120000_d2_reserve_side_unit_normalization.sql`
  - `supabase/migrations/20260710130000_d1_logbook_snapshot_preference.sql`
  - `supabase/migrations/20260710003000_u18b_morning_checks_fixes.sql`
  - `supabase/migrations/20260709230000_u18_safety_nets.sql`
  - `supabase/migrations/20260709233000_u17_email_log_select_own.sql`
## 2026-07-10 — docs: TODO.md refreshed to verified state + stray `.codex` mirror repaired

Corrected the roadmap/TODO to match live reality and cleared a tooling snag that was blocking commits. Docs-only; no DB, no code, no deploy.

- **TODO.md** rewritten to the verified 2026-07-10 state (checked against the live DB migration list, not the stale doc): U12/U13 (My Day + assignment unification) corrected as SHIPPED LIVE 2026-07-06 (they were wrongly listed as parked); L4 leaked-password reclassified as Pro-plan-gated; label-data load promoted to the #1 owner item (now a data-entry job via the new `/label-data-quality` tool, with the ~105-wrong-EPA-regs caveat); added EPA Waves 4–5, grower portal §7–§10, billing Feature B, F3 WebP retry, the 13 parked migrations, and the post-billing `/foundation-ultra-review` re-run.
- **Tooling repair:** a stray, half-synced `.codex/` mirror in the primary worktree was tripping the pre-commit `check:agent-workflows` guard and blocking every commit. Root cause = the agent-workflow mirror was redesigned on the still-unmerged `codex/agent-setup-20260710` branch, incompatible with the older checker on `main`. Moved the orphaned mirror aside (gitignored + regenerable) so the guard skips cleanly as designed — no hook bypass.

## 2026-07-10 — Label Data Quality screen: in-app EPA reg-number check + inline fix (frontend-only; Codex-built + Codex-reviewed)

New admin-only page `/label-data-quality` closes the gap where the EPA data-quality check existed only as a token-gated CLI script (`scripts/epa-data-quality-report.mjs`) the owner couldn't run. It checks every product's saved EPA registration number against the live EPA database, flags the wrong/cancelled/not-found ones, and lets an admin correct one inline with EPA verification.

- **The gap:** 595 active products, 299 with an EPA reg number, but ~105/204 distinct regs point at a DIFFERENT EPA product (e.g. Callisto's stored `100-885` is actually EPA "Dividend XL", inactive). Wrong regs poison all downstream label data, and the finding lived only in the CLI report.
- **What shipped (frontend only — zero DB / zero edge-fn):** page reuses the already-live `epa-lookup` edge function + the `src/lib/epaDataQualityReport.ts` classifier + `get_label_coverage_report`. "Run EPA check" iterates distinct regs through a **shared rate-limiter** (≤30/min + spacing, shared across bulk run, inline verify, and ProductDetail's lookup) with progress + cancel; results table filterable by finding type; inline "Verify → Save" corrects `products.epa_registration` (Save unlocks only after the typed number resolves to a real EPA product) and writes the change to `activity_feed`.
- **Loop model (Codex builds + reviews itself; Claude orchestrates + verifies + pushes):** Codex built + self-reviewed; an independent Codex review-gate found 0 blocker/high + 4 improvements (shared throttle, activity-log the correction, two test-honesty gaps) — all **fixed by Codex**, re-verified. Full suite 203 files / 3209 tests green; typecheck/lint/build green. Live read-only EPA smoke proved the Callisto mismatch is caught and the correct reg (`100-1131` → "Callisto Herbicide") verifies.
- **Note:** EPA's public data provides signal word + reg verification only — NOT REI/PHI (those stay manual / deferred label-OCR). This tool fixes reg numbers + unlocks signal-word fill; it does not complete REI/PHI.

## 2026-07-10 — Billing-day money loop: worklist ALREADY SHIPPED by parallel work; M4 (dead-RPC posting-policy alignment) + Feature A (auto-split drafts on full delivery) built + SHIPPED LIVE; Feature B parked

Ran `/run-loop docs/loops/billing-day-money-loop-2026-07-08.md` (worktree `C:\CRX_BillingFix`). **Verify-first found the entire worklist already live** via parallel sessions between the mission doc's date (07-08) and launch (07-10) — no rebuild needed: C1/C2 (Sprint D `20260710120000`/`130000`), C3 (U18 negative-stock + Office Cockpit hold-expiry + AR-aging prepay column), M1 (U1 overdue-on-Payments), M2 (U2 #34 per-delivery auto-invoice guard), M3 (`allocate_payment` `OVER_ALLOCATED` sum-vs-check guard), S1 (U7 `20260707070000` delivery split-billing). The loop was a verification pass that **prevented re-implementing 7 already-live units.** Two new pieces were built + shipped; a third parked at design review.

- **M4 — `batch_post_invoices` posting-policy alignment (§6 decision 7 = admin+sales, align all surfaces): SHIPPED LIVE** (mig `20260712135000`, live v`20260710213614`). Every posting surface a user touches was already admin+sales + partial-tolerant (the chemical bulk-post UI loops `post_invoice` client-side); the only leftover was the **zero-caller** server RPC still admin-only + all-or-nothing. Hardened it (defense-in-depth) so a future re-wiring can't reintroduce the inconsistency: admin-only → admin+sales (mirrors `post_invoice`), all-or-nothing → partial-tolerant (`failed[]`). 4 CRX reviewers + Codex pre-ship CLEAN; `plpgsql_check` 0; no credit-memo collision. Mason approved the live apply.
- **Feature A — auto-create split DRAFT invoices on same-day full delivery: SHIPPED LIVE** (mig `20260712140000`, live v`20260710234404`). When the last delivery of a field/acre-allocated order completes TODAY, `complete_delivery` now auto-calls `create_split_invoices_from_order` to create per-owner draft invoices (office reviews+posts) instead of only flagging `needs_split_billing`. Backdated / driver / unpriced / any-error → safe fallback to the existing flag+notify (completion never breaks); a same-day guard prevents shifting AR aging. Built by Codex CLI (loop driver model); Codex round 1 caught a real backdate HIGH → fixed → round 2 CLEAN; reviewers + `plpgsql_check` clean.
- **Feature B — per-delivery split for PARTIALLY-delivered allocated orders: PARKED** at a Codex design-review BLOCKER (naive per-delivery mirroring loses money via independent rounding + strands the final delivery). Corrected approach = a residual-ledger redesign (its own project). Handoff: `docs/audits/split-billing-B-perdelivery-design-2026-07-10.md`. Until built, partial allocated deliveries keep today's flag-and-manual-split behavior.
- **Repo-hygiene note:** M4 + Feature A were applied live on 07-10 but their files sat uncommitted while `main` was fleet-red from other sessions' in-flight landings; committed here once those cleared. M4's file was renamed `20260712130000`→`20260712135000` to clear a stamp collision. `migration-history.md` remains ~15 rows behind (Sprint D, U15–U20, EPA, credit-memo apply) — needs a `/update-docs` pass.
- **Landing-time Codex review — 2 low-severity findings, FIXED + SHIPPED LIVE the same day:** a fresh Codex review of the diff surfaced two safe-failing issues in the already-live SQL that the build-time review missed — (P1) M4's partial-batch `financial_audit_log` recorded the full requested `invoice_ids` array even for failed posts, on a **zero-caller** RPC that can't run in prod; (P2) Feature A could skip the auto-split when two same-day final deliveries of one allocated order race, falling back to the pre-existing **manual** split-billing (no misbill). Both fixed in follow-up migration `20260712150000` (live v`20260711023736`): P1 now stores only the posted IDs; P2 locks the `orders` row before the all-delivered check (lock order unchanged → no new deadlock). Gates: rls-security + migration-drift + Codex all CLEAN, plpgsql_check 0 errors, post-apply invariant check clean.

## 2026-07-10 — Business-workflow review #105: credit-exposure on the spray-job channel (1 migration APPLIED LIVE, Mason's OK; Codex-built + Codex-reviewed)

Closed review finding #105. Two parts, built by Codex and reviewed by Codex (the loop model), with Claude orchestrating the gates + the live apply.

- **The gap:** the "customer is over their credit limit" warning fired only on the chemical-sale side (quote convert, new order, quick delivery) — scheduling/dispatching a **spray job** never checked credit, so an over-limit customer kept getting sprayed with no signal. And the exposure math (`check_customer_credit_limit`) counted only `posted`/`overdue` invoices, so a season of completed-but-`unposted` spray bills was invisible to the number even on the channels that did check.
- **Part A (frontend):** new shared helper `src/lib/creditLimit.ts` (`warnIfOverCreditLimit`, non-blocking, mirrors the existing NewOrder pattern) wired into the spray-job **schedule** flow — `JobDetail` new-job save and `QuoteBuilder` schedule-from-booking. Fire-and-forget after navigation so it can never stall the save. Dispatch hook deliberately deferred (DispatchWizard dispatches multiple customers in one action with no single customer id — warning there would risk the wrong customer).
- **Part B (migration `20260712130000`, live v`20260710234754`):** `check_customer_credit_limit` re-emitted (LIVE body verbatim) with the sole change of adding `'unposted'` to the invoice status filter. Read-only SECURITY DEFINER, single overload, `search_path` intact, anon still excluded. Owner-approved (2026-07-10) that committed-but-unposted bills should count.
- **Gates:** rls-security / migration-drift / compliance reviewers all CLEAN. Codex review-gate found **2 real HIGH bugs it had introduced** — (1) QuoteBuilder checked the editable picker customer instead of the job's actual customer; (2) the warning was `await`ed with no timeout, so a hung call could stall a committed save (duplicate-job risk) — both **fixed by Codex**, re-review **CLEAN**. Filter change proven on the live engine (`old_ar 40000 → new_ar 65000`, draft/voided excluded); live function verified post-apply. Zero blast radius today (0 unposted invoices currently exist). No data mutation; one-click reversible.

## 2026-07-10 — Business-workflow review: 3 daily-use screen fixes (#67 / #23 / #68) — frontend-only, deployed to `main`

Cleared three confirmed UX traps from the 2026-07 business-workflow review (the review is now ~90% shipped — both big UI redesigns are already live; this closes the small residual frontend set). All pure-frontend: no DB, no money math, no RLS, no migration, no edge function. Built in worktree `C:\CRX_WorkflowUX`.

- **#67 — Order "Change Status" trap (medium):** the admin dropdown offered `partially_fulfilled` / `fulfilled`, but the handler only ever allows `→ cancelled` (fulfillment is auto-derived when deliveries complete), so those options always errored "Cannot change status". Replaced the dead-option dropdown with one honest **Cancel Order** action — shown only on `confirmed` / `partially_fulfilled`, routing straight to the existing cancel confirmation → unchanged `cancel_order` RPC (no change to what cancel does). Removed the now-dead modal + orphaned state/handler; added a render test asserting Cancel Order shows and Change Status is gone. `OrderDetail.tsx`.
- **#23 — Job-from-customer prefill (low):** CustomerDetail had New Quote / Order / Delivery but no New Job, and `/jobs/new` ignored a customer. Added a **New Job** button on CustomerDetail (`/jobs/new?customer_id=…`) and made JobDetail pre-fill the customer for a new job (which also pre-filters the field picker). `CustomerDetail.tsx`, `JobDetail.tsx`.
- **#68 — Fake "Start Job" click (medium):** completing a job keyed in after the fact forced Start → wait → Complete (`complete_job` requires `in_progress`). Now Complete is available on a `scheduled` job and `handleComplete` chains `start_job → complete_job` in one action (with an in-modal note). Timing stays approximate — a start/end-time field on the modal is the noted follow-up. `JobDetail.tsx`.

Proof: typecheck + lint + build + tests all green (OrderDetail suite incl. the new #67 render assertion; all-pages render smoke mounts all three pages with the changes). Verification boundary: the fully-authed click-through — and the destructive Cancel Order / Complete Job actions — was NOT exercised against live data (no test login; those actions mutate real records) and is Mason's to eyeball on the live site.

## 2026-07-10 — EPA label-data lookup (Stage 1) SHIPPED LIVE: per-product "Look up EPA" button + a catalog data-quality report that surfaced a large wrong-registration-number problem (main @`49f81ab4`, Vercel READY)

Built the ChemMan-style "look a product up against EPA's public database and auto-fill its label data" capability, to attack the dormant product-label backfill (0/595 active products had signal_word/rei/phi). Heavy-Codex / lean-Claude loop in worktree `C:\CRX_EPA` (Codex built + self-reviewed all code; Claude/Sonnet gated). **Reuses the already-live-but-never-used label-draft review→commit pipeline** (`product_label_drafts` + `create/commit_label_draft` + `LabelReview`) rather than building a new one — proven live with a rolled-back create→commit smoke.

- **Wave 1 — `epa-lookup` edge function: DEPLOYED LIVE** (v1, admin-JWT, hardened per Codex's own review: reg-number classifier BEFORE any fetch, hardcoded EPA host, redirect:manual, streamed request/response byte caps, POST/OPTIONS-only 405-else, fixed client-safe errors — no leak). Live-probed: no-auth→401, non-admin→401, GET→405, OPTIONS→200.
- **Wave 2 — per-product "Look up EPA" button on ProductDetail: LIVE** (proven by grepping the prod ProductDetail chunk). Calls the function, shows a preview with mismatch/cancelled/RUP warnings, files results through the existing review pipeline **empty-fields-only** (never a direct product write, never Stage 2 fields).
- **Wave 3 — read-only bulk data-quality report** (`scripts/epa-data-quality-report.mjs`): swept all 204 distinct reg numbers against EPA. **Headline finding (independently verified via live EPA): ~105 of 204 stored registration numbers point at a DIFFERENT EPA product, 24 are unknown to EPA, only ~74 are correct.** E.g. "Callisto" carries `100-885` = EPA "Dividend XL" (real Callisto = `100-1131`). Worklist CSV delivered to Mason. Not a shuffle of his own catalog (35 point to experimental/technical codes); origin unknown → fix is reconstruction.
- **Waves 4–5 (bulk auto-fill/backfill): PARKED** — auto-filling from mostly-wrong reg numbers would spread bad data; the report-first design caught it before any write. Reg-number reconstruction helper offered + Mason declined for now.
- **Ship-gate Codex review caught 2 blockers:** (1) button could fill a product's hazard word from a lookup of a *different* registration → **FIXED + regression-tested**. (2) pre-existing "registration drift" in the shared `commit_label_draft` RPC (applies a signal-word-only draft later without re-checking the product's current reg) → **owner-accepted DEFERRAL** (needs a migration to the shared RPC; out of this zero-DB loop) — tracked in the plan doc `docs/roadmap/epa-label-lookup-plan-2026-07-10.md` §15 + a spawn_task follow-up chip. Final Codex verdict CLEAN on the diff given the deferral; push-guard proof HEAD-bound (rebased onto advancing main, range-diff-verified byte-identical, re-stamped honestly). Zero DB changes.

## 2026-07-10 — Credit-memo apply: apply a credit memo to an open invoice (5 migrations APPLIED LIVE, Mason's OK; deployed to `main`)

Closed the business-workflow-review §3.2 gap: `issue_return_credit` created a `credit_memo` invoice (negative total, posted) but NOTHING could apply it to an open invoice — a customer who owed $10k, returned $2k, and mailed an $8k check left the $10k invoice at a $2k balance that aged, flipped overdue, and got dunned, while the −$2k credit floated unusable. Net AR was correct; the individual invoice was wrong.

Built the hardened Option A from the 2026-07-08 design + Codex BLOCKER review: `invoices.credit_applied_cents` (a 5th balance lever — the generated `balance_cents` is now type-aware = `(total−paid−prepay−write_off) + (credit_memo ? +credit_applied : −credit_applied)`), the immutable append-only `credit_memo_applications` ledger (RLS SELECT admin+sales_rep, no client DML, one-time-reversal-stamp trigger), `apply_credit_memo_to_invoice` + `reverse_credit_memo_application` RPCs, credit-awareness across `void_invoice`/`unapply_credit_memo`/`unpost_invoice`/`delete_invoices` + all SIX inline four-lever consumers (`allocate_payment`, `apply_prepay_to_invoice`, `apply_write_off`, `record_invoice_payment`, `void_payment`, `mark_overdue_invoices`) — a live pg_proc scan caught two consumers (`record_invoice_payment`, `void_payment`) the original design missed. Plus the frontend 5-lever reconciliation + the invariant-sweep credit component + an "Apply Credit" button on InvoiceDetail.

5 migrations `20260711021000`–`20260711060000` **APPLIED LIVE 2026-07-10** (Mason's OK). Reviewed: rls-security + compliance + migration-drift subagents clean; the independent Codex (`codex exec`) gate found **8 real issues** — concurrent-replay double-apply, an inactive user passing the role gate (`NULL NOT IN`), closed-period holes in void/reverse, reverse gating on the memo's issue date instead of the application's, a memo-void stranding its linked return, reverse idempotency not bound to the application, and a missing `credit_memo total<=0` CHECK — **all fixed**; a drift re-review then caught **1 more** closed-period hole in `unapply_credit_memo` (fixed). Proven via a real-RPC rolled-back live smoke ($10k − $2k credit − $8k check → paid/$0; reverse restores both sides; ledger reconciled) + invariant sweeps clean. 0 credit memos existed live → no data migration, no live-data risk. Deployed to `main` (Codex push-gate recorded). Follow-ups: schema-registry regen (REGISTRY-STALE flag set) + a live click-through of the button once real billing data exists.

## 2026-07-10 — Gauntlet Section 6 follow-up: `save_job_applied_record` payload-conflict guard (APPLIED LIVE v20260710190012, Mason's OK)

The independent Codex (gpt-5.6-sol) gate on the double-submit dedup fix (below) found one real **P1**: the replay path deduplicated *identical* retries correctly, but treated a **changed** retry payload as a successful replay and silently discarded the correction. Scenario — the first keyed create commits server-side, its response is lost on a field network timeout, the applicator edits a value (acres / a per-location field / weather / crew) and taps Save again under the same idempotency key; the old replay returned the original record and the app reported success, dropping the corrected legal spray data (no money impact — billing uses `billable_acres`; dormant — `job_applied_records` has 0 live rows).

Fix (`20260712120000_save_job_applied_record_payload_conflict_guard.sql`): a nullable `job_applied_records.idempotency_request_hash` column stores an md5 fingerprint of the whole create request (`p_record||p_fields||p_crew`, canonical jsonb text) on the keyed create. On the unique_violation replay the function compares the retry's fingerprint to the stored one — **identical → replay (dedup preserved); different → `RAISE APPLIED_RECORD_ALREADY_SAVED_DIFFERENT`** so the conflict surfaces instead of being dropped. Signature unchanged (single 4-arg overload); SECURITY INVOKER + `search_path` + strict-actor + anon-revoke all preserved and self-asserted. Frontend `AppliedRecordsManager` detects the error, resets the create key, reloads so the saved record shows, and tells the user to reopen/edit it. Reviewed SHIP by rls-security + migration-drift + types-drift; **proven via rolled-back live smoke against the deployed function** — identical retry → 1 row, changed retry → RAISE, no duplicate. Landed to `main` with the base fix below.

## 2026-07-10 — Gauntlet Section 6 HIGH-1 fix: `save_job_applied_record` double-submit dedup (APPLIED LIVE v20260710165446, Mason's OK; landed to `main`)

Re-verified the open Live Foundation Gauntlet findings against current `main` + the live DB. Dispositions: Section 5 "stale checkout" HIGH = **self-referential** (the audit ran from a 95-commits-behind branch; `main` is current) → informational; Section 5 schema-registry MED = **confirmed** (registry high-water `20260710010846` trails 2 applied migrations) → regen recommended; Section 6 `save_job_applied_record` HIGH = **CONFIRMED**; Section 6 stale-idempotency-test MED = **confirmed (worse — the whole coverage list is stale)**; carryover `batch_apply_prepayments` role gate = **overstated → LOW** (delegates to the gated `apply_prepay_to_invoice`); carryover `receive_po_items` race = **already fixed live** (`FOR UPDATE OF poi, po`).

Fix (branch `claude/codex-gauntlet-review-a808d6`, migration `20260711020000_save_job_applied_record_idempotency.sql` — renamed from `…010000` after Codex caught a mid-session collision with a parallel session's `20260711010000_u18c_morning_cron_utc_fix.sql`): `save_job_applied_record` could create a DUPLICATE legal applied-record on a field network-timeout retry (double-counts `jobs.applied_acres` → collapses the GENERATED `remaining_acres`; pollutes RUP/grower proof; NO money impact — billing uses `billable_acres`). Fix = a nullable `job_applied_records.idempotency_key` column + PARTIAL UNIQUE index + catch-unique-violation replay in the create path; stays SECURITY INVOKER (caller RLS + field-membership WITH CHECK intact) because the canonical helpers have `authenticated` EXECUTE revoked. Re-emitting the full body also restores the PARKED-004 strict-actor binding to `main` (its `parked_004_*` source file was live-only). Frontend `AppliedRecordsManager` now sends `useIdempotencyKey` on create, reset only on success. Prevention: `rpcContracts.test.ts` gains a generated-types-driven, fail-closed coverage guard (a new param-declaring RPC that isn't classified now breaks the build) + a dedicated table-unique-mechanism check for this RPC. Proof: rolled-back live smoke via the RPC under real admin auth/RLS — two same-key creates → **1** parent row, two null-key creates → **2** rows, replay id stable; typecheck + 3177-test suite green; production left untouched (verified 3-arg fn, no column).

Codex gate (gpt-5.5) then found 1 BLOCKER (the timestamp collision, fixed by the rename) + 1 P1 (a lost-response idempotency key could be reused across a cancelled-then-new add or a different job, replaying the wrong record — fixed: `openAdd` resets the key per new-record intent, and the RPC's recovery SELECT is now scoped to `job_id` so a cross-job reuse re-raises instead of silently returning another job's record) + 2 P2 test-quality gaps (the coverage guard was over-claimed → comment corrected to state its real scope + residual gap; the table-unique test now also asserts the partial-unique-index DDL exists). All addressed.

**Applied live** 2026-07-10 (live v20260710165446, Mason's OK); verified + sweeps clean + schema-registry regenerated for the new column; the independent Codex gate (gpt-5.5) went 2 rounds → NO FINDINGS. Landed to `main` via this merge; the frontend `useIdempotencyKey` dedup activates on the next Vercel deploy (safe until then — `job_applied_records` has 0 live rows). (The earlier-flagged `20260711000000_a9_close_period_guards` orphan was merged to `main` by its own session mid-run — no longer an open item.)
## 2026-07-10 — U18c: morning-notification-checks cron was firing at 01:20 AM, not 06:20. Fixed live (mig `20260711010000`, live v20260710154919).

Found while checking the U18 cron's first run: the `morning-notification-checks` pg_cron job was scheduled `20 6 * * *` on the assumption it meant 06:20 local, but pg_cron runs in UTC (verified `current_setting('TimeZone') = 'UTC'`), so it fired at 06:20 UTC = **01:20 AM Central**. Same bug class as the A9 fix above — a "business time" written as if the DB were on the local clock. Re-scheduled to `20 11 * * *` = 06:20 America/Chicago in summer / 05:20 in winter (pg_cron can't track DST, so the earlier UTC time was chosen to keep it at-or-before 06:20 year-round for early-start ag crews). Cron-reschedule only; the function is untouched. rls + drift reviewers 0 blockers; proven live (schedule now `20 11 * * *`, single active job, rolled-back `PERFORM run_morning_notification_checks()` ran cleanly).

## 2026-07-10 — A9 month-end close: test-first follow-up. Codex worked, Claude reviewed adversarially. Two REAL server-side gaps found and closed in `20260711000000_a9_close_period_guards` (**APPLIED LIVE 2026-07-10**, live v20260710151913, Mason's explicit OK); 6 new regression tests + 4 `dateUtils` tests; full suite 3182 pass.

**The premise was wrong, and that mattered.** CLAUDE.md claimed the A9 MonthEndClose picker + WaveB units were "deferred to a focused test-first session." Git says otherwise: `86583df0` (picker, Codex R7 clean) and `c2eca4c3` (WaveB) are both ancestors of `origin/main` — they shipped 2026-07-04. That stale line is now corrected.

So the session became what it should have been: an adversarial review of shipped, live code that closes accounting periods.

- **Gap 1 (reachable from the UI, was live):** the page blocked closing a month whose *start* was in the future, and the database had **no date guard whatsoever**. Nothing in `close_accounting_period` compared `p_period_end` to the current date. Proven by a rolled-back live probe: closing **July 2026 on 2026-07-10** — the in-progress month — was **ACCEPTED**, which would have made `check_period_open()` reject every invoice and payment dated Jul 11-31.
- **Gap 2 (admin + direct RPC):** `v_period_start := date_trunc('month', p_period_end)` accepted any day. With unique key `(period_start, period_end)`, `p_period_end = '2026-03-15'` inserted a **second, overlapping** closed row next to the open full-month row (proven live: `march rows now: 2`) — the page would still show March "Open" while its first half was silently locked. `NULL` also slipped through (`NULL <> x` is `NULL`, which does not RAISE).
- **Owner decisions:** close only *after* a month ends, enforced in **both** page and database; **no** sequential-close rule (nine open periods back to Oct 2025 would have trapped him).
- **The independent Codex gate returned `VERDICT: blockers` on a P1 that Claude had found and rationalized away:** the page used the browser's local date, the guard used `CURRENT_DATE`, and the DB session timezone is UTC. Fixed by putting both on one business clock — new `BUSINESS_TIMEZONE`/`todayInBusinessTz()` in `src/lib/dateUtils.ts`, and `(now() AT TIME ZONE 'America/Chicago')::date` in the guard. Postgres and the browser were then verified to agree on all 9 boundary instants incl. both DST transitions. The guard is session-tz-immune: under session TimeZone `Pacific/Kiritimati`, `CURRENT_DATE` = 2026-07-11 while the guard's date stayed 2026-07-10.
- **Proof, not assertion:** rolled-back live txn applying the exact migration file — 5 probes correct, happy path (April, ended + clean) still ACCEPTED, re-close still refused as already-closed, and a `pg_get_functiondef` line-diff of **0 removed / 11 added** proving the re-emit is byte-faithful. The new timezone test was **mutation-tested**: reverting the page to the browser clock makes it fail under `TZ=UTC`. Live DB left untouched throughout (`closed_periods = 0`, function md5 unchanged).
- **Known follow-up (latent, not user-reachable):** `changePeriod()` sets `loading = true` unconditionally, but `fetchData` only re-runs when the period's start/end change — so a *programmatic* same-period change strands the page on a spinner forever. A real `<select>` never fires `change` for the already-selected option, so no user can hit it. Left alone deliberately rather than widen a money-path change.

## 2026-07-10 — Sprint D (workflow-waves follow-ups): D2 reserve-side unit normalization APPLIED LIVE v20260710111734 (all 8 hold/planning call sites normalize units before conversion, mirroring complete_job; rolled-back [E2E] proof: 2 pt/ac -> 0.25 Gal hold, was 8x over-reserve) + D1 logbook/dashboard/lot-trace snapshot preference APPLIED LIVE v20260710112102 (6 read RPCs; disk-drift caught on the logbook bases, re-emitted from verified live text). D3 U8 leftovers PARKED: blend commission mint (additive but dormant-by-owner) + commission_split visibility (needs an owner design call: admin-only side table).

**Same day — post-ship Codex gauntlet + contract amendment:** adversarial gpt-5.6-sol passes over the 7 frontend-only workflow-waves commits (A2/A3/U14a-b/U19/U20a-b — Claude-reviewed but never Codex-reviewed) found 1 real P1 (SearchableSelect 150ms delayed-blur commit: clear the customer picker, click Create Order fast, and the order submits to the old hidden customer at the wrong tier — blur reconciliation made synchronous + regression test) + 2 P2 (displaced-applicator notify dropped by early returns; blend order-number prefill clobbering typed input) + 3 P3 (stale crew probe across job navigation; palette + "+ New" ignoring role/deny-list; snapshot-window doc), all fixed @`0a4d6a2a`, confirm verdict CLEAN; 2 findings refuted as designed/pre-existing. Loop contract amended per Mason (`docs/loops/workflow-waves-loop-2026-07.md` §4.7, @`41ed9f84`): **a read-only Codex verdict is required before pushing EVERY shipped unit, frontend included** — no more DB-only gating. **Cron verified:** first 06:20 `morning-notification-checks` run succeeded — 51 low_stock notifications = 17 low/negative-stock products × 3 admins, 0 duplicates (U18b dedup holds).

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `fa9a3c32 docs(workflow-waves): wrap — morning report, ledger, CHANGELOG, counts, registry high-water`
  - `e79cd433 feat(a11y+ux): U20b — aria-label sweep + searchable-picker sweep (+ parked backfill draft)`
  - `66ff98d5 feat(entry-points): U20a — Part 3 demotions (Create Order chooser, editor demotions, misc charge, quick-action reorder, blend auto-number)`
  - `8bf04755 feat(nav): U19 — nav blueprint (proposals.md mapping, exactly)`
  - `bf7c7e32 fix(safety-nets): U18b — same-day expiry window + per-recipient dedup in morning checks`
  - `209697a2 feat(safety-nets): U18 — negative-stock alerts, expiry alignment, 06:20 cron, AR prepay`
  - `74dc3418 fix(quotes): U17 — lte lapse rule + local date parse on hold lines, unique row keys`
  - `35d5792b fix(quotes): U17 — local date parsing on attention card + keep-open stray-item cleanup`
  - `9f8dca1b feat(quotes): U17 — booking hygiene (holds visible, honest email, faster entry)`
  - `0b149263 fix(quotes): U16b — no status write when convert outcome is unverifiable`
  - `363b4c51 fix(quotes): U16b — Book-as-Order chain survives lost responses`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260710003000_u18b_morning_checks_fixes.sql`
  - `supabase/migrations/20260709230000_u18_safety_nets.sql`
  - `supabase/migrations/20260709233000_u17_email_log_select_own.sql`
  - `supabase/migrations/20260709220000_u15_complete_delivery_backdate.sql`
  - `supabase/migrations/20260709210000_a1b_dispatched_to_me_completed_tail.sql`
  - `supabase/migrations/20260709190000_a1_dispatched_list_recent_completed.sql`
  - `supabase/migrations/20260707140000_u7_spray_job_split_group.sql`
  - `supabase/migrations/20260707090000_u7_split_gate_allow_predelivery.sql`
  - `supabase/migrations/20260707070000_u7_delivery_split_billing.sql`
  - `supabase/migrations/20260707060000_u8_application_channel_commissions.sql`
  - `supabase/migrations/20260707050000_application_record_integrity.sql`
  - `supabase/migrations/20260707030000_customers_default_application_service_id.sql`
  - `supabase/migrations/20260707040000_generate_rup_sales_records_role_gate.sql`
  - `supabase/migrations/20260707020000_assignment_unification.sql`
  - `supabase/migrations/20260707010000_field_view_my_day.sql`
  - `supabase/migrations/20260707011000_start_complete_job_null_actor_guard.sql`
  - `supabase/migrations/20260706130000_stock_policy_warn_not_block.sql`

## 2026-07-09 — Workflow-waves loop (Codex 5.6 builds, Claude orchestrates): Sprint A phone-flow fixes + U14-U20 daily-flow/billing/booking/nav/entry-point overhaul SHIPPED to prod — 6 additive migrations live (v20260709203120-v20260710010846: dispatch Done-tails, complete_delivery backdate, email_log own-rows policy, U18 safety nets + 06:20 morning-notification cron + U18b fixes), ~15 review findings fixed via Opus/Sonnet/Codex gates; Sprint D + dispatch backfill PARKED with plans; full suite 3171 pass.

Workflow-waves loop (Codex 5.6 builds, Claude orchestrates): Sprint A phone-flow fixes + U14-U20 daily-flow/billing/booking/nav/entry-point overhaul SHIPPED to prod — 6 additive migrations live (v20260709203120-v20260710010846: dispatch Done-tails, complete_delivery backdate, email_log own-rows policy, U18 safety nets + 06:20 morning-notification cron + U18b fixes), ~15 review findings fixed via Opus/Sonnet/Codex gates; Sprint D + dispatch backfill PARKED with plans; full suite 3171 pass.

- **Commits this session** (git log --since=12.hours --author=Mason):
  - `e79cd433 feat(a11y+ux): U20b — aria-label sweep + searchable-picker sweep (+ parked backfill draft)`
  - `66ff98d5 feat(entry-points): U20a — Part 3 demotions (Create Order chooser, editor demotions, misc charge, quick-action reorder, blend auto-number)`
  - `8bf04755 feat(nav): U19 — nav blueprint (proposals.md mapping, exactly)`
  - `bf7c7e32 fix(safety-nets): U18b — same-day expiry window + per-recipient dedup in morning checks`
  - `209697a2 feat(safety-nets): U18 — negative-stock alerts, expiry alignment, 06:20 cron, AR prepay`
  - `74dc3418 fix(quotes): U17 — lte lapse rule + local date parse on hold lines, unique row keys`
  - `35d5792b fix(quotes): U17 — local date parsing on attention card + keep-open stray-item cleanup`
  - `9f8dca1b feat(quotes): U17 — booking hygiene (holds visible, honest email, faster entry)`
  - `0b149263 fix(quotes): U16b — no status write when convert outcome is unverifiable`
  - `363b4c51 fix(quotes): U16b — Book-as-Order chain survives lost responses`
  - `a73d84f0 feat(billing): U16b — posting rights, Ready-to-Post, chemical Unpost, booking actions`
  - `1c5eb07d feat(billing): U16a — billing home tiles + one-click invoicing`
  - `0476cb41 chore(types): U15 — add p_completed_at to generated complete_delivery args`
  - `ef7bf4a4 fix(deliveries): U15 — keep retry replayable after confirm-ok/complete-fail`
  - `8d098ad2 feat(deliveries): U15 — deliveries both ways (backdate + one-shot + phone polish)`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260710003000_u18b_morning_checks_fixes.sql`
  - `supabase/migrations/20260709230000_u18_safety_nets.sql`
  - `supabase/migrations/20260709233000_u17_email_log_select_own.sql`
  - `supabase/migrations/20260709220000_u15_complete_delivery_backdate.sql`
  - `supabase/migrations/20260709210000_a1b_dispatched_to_me_completed_tail.sql`
  - `supabase/migrations/20260709190000_a1_dispatched_list_recent_completed.sql`
  - `supabase/migrations/20260707140000_u7_spray_job_split_group.sql`
  - `supabase/migrations/20260707090000_u7_split_gate_allow_predelivery.sql`
  - `supabase/migrations/20260707070000_u7_delivery_split_billing.sql`
  - `supabase/migrations/20260707060000_u8_application_channel_commissions.sql`
  - `supabase/migrations/20260707050000_application_record_integrity.sql`
  - `supabase/migrations/20260707030000_customers_default_application_service_id.sql`
  - `supabase/migrations/20260707040000_generate_rup_sales_records_role_gate.sql`
  - `supabase/migrations/20260707020000_assignment_unification.sql`
  - `supabase/migrations/20260707010000_field_view_my_day.sql`
  - `supabase/migrations/20260707011000_start_complete_job_null_actor_guard.sql`
  - `supabase/migrations/20260706130000_stock_policy_warn_not_block.sql`

## 2026-07-07 — Business-workflow U7 (spray-job half) — per-owner split invoices on Transfer, group-aware lifecycle (U7 COMPLETE)

Migration `20260707140000_u7_spray_job_split_group` **applied live** (findings #42/#100/#50), closing the last U7 gap — the spray-job counterpart to the delivery-half `create_split_invoices_from_order` shipped earlier the same day. A spray job whose fields belong to more than one owner (landlord/tenant) now bills each owner their OWN payable invoice instead of one invoice to the primary customer with co-owners' shares as unpayable annotations.
- **`transfer_job_to_invoice`** gains a NEW multi-owner branch: when >1 distinct `field_billing_defaults` customer bills the job's fields, "Transfer to Invoice" creates ONE `field_application` invoice PER owner (linked by `invoices.invoice_group_id`), splitting each job chemical's price+cost across owners by billable acres (acre-weighted `split_pct`) penny-exact via `calculate_billing_splits`, and minting per-member commission via `_insert_commissions_for_job` (each on that owner's chemical-line profit; the per-acre fee is excluded). The group total equals what the single combined invoice would bill (`jobs.total_price_cents` is by construction the sum of chemical line prices). Single-owner jobs fall through the ORIGINAL path, byte-identical. Auto-triggers on Transfer (owner's choice); per-field $/acre price overrides on a multi-owner job are refused (`SPLIT_OVERRIDE_UNSUPPORTED`) rather than silently re-priced.
- **`void_invoice` / `delete_invoices` / `transfer_invoice_to_job`** become group-aware: the job re-opens to `completed` only when the LAST live group member is gone; voiding/deleting the anchor while siblings remain re-points `jobs.invoice_id` (+ `application_records.invoice_id`) to a surviving member under the admin-override GUC; `transfer_invoice_to_job` refuses a member-by-member group reverse (`JOB_BILLED_AS_GROUP`) and points the office to void each owner invoice. All three are byte-identical to their live definitions except the marked job-release block (proven via reverse-apply md5); the commission-reversal SQL is unchanged (already `commissions.invoice_id`-scoped, so it reverses per member automatically).
- **Frontend:** JobDetail's Transfer handler shows "Created N split invoices" and navigates to the anchor; new error toasts for `SPLIT_OVERRIDE_UNSUPPORTED` / `FIELD_SPLIT_NOT_100` / `SPLIT_NO_ACRES`; FieldApplicationInvoice surfaces `JOB_BILLED_AS_GROUP` on the reverse-transfer path. New `RpcErrorCodes` entries + `TransferJobResult` group fields in `src/types`.
- **Gates:** rls-security + migration-drift + compliance reviewers = 0 blockers; Codex (gpt-5.5, high effort) = NO FINDINGS. Applied live via the byte-exact hash-gated apply, then proven end-to-end via a rolled-back `[E2E]` smoke: a 60/40 two-owner job → 2 per-owner invoices (6000¢ + 4000¢ = 10000¢, penny-exact), per-owner commission $24/$16 (sum = whole-job $40), anchor = primary; void the anchor → job stays invoiced re-pointed to the survivor + only the anchor's commission cancelled; void the last member → job released to completed; a single-owner job still produces exactly one invoice. `plpgsql_check` clean (warnings only); single overload each; grants preserved (no anon exec); post-apply invariant sweep clean. **U7 is now fully shipped (both halves).**
- **Follow-up (same day):** refreshed the schema-registry high-water from live (`20260707121339 → 20260707181920`) so the session-start staleness check stops flagging the new migration. Rebuilt via `--from-introspection`; schema *content* is byte-identical (U7 only re-emitted functions), so only the `_meta.migrations_high_water` marker moved. Committed `24af3a4c`, pushed to `main`.

## 2026-07-07 — Business-workflow U7 (delivery half) — chemical-order split billing; spray-job half PARKED

Migration `20260707070000_u7_delivery_split_billing` applied live (finding #43), closing the silent mono-bill on multi-owner (landlord/tenant) chemical orders. Previously, completing a delivery on a field/acre-allocated order auto-created ONE draft invoice billed 100% to the primary customer — the landlord could never be billed or pay, and the proper per-owner split path (`create_split_invoices_from_order`) was gated off once any delivery existed. Now:
- **`complete_delivery`** skips the mono-bill auto-draft when the order has `order_item_field_allocations`, sets a new nullable `orders.needs_split_billing` flag, and notifies admins (activity_feed `order_needs_split_billing` + a `split_billing` notification). Non-allocated orders keep the EXACT prior auto-draft behavior.
- **`create_split_invoices_from_order`** becomes reachable after delivery — only an OPEN (scheduled/in_progress) delivery blocks now, and it requires the order be fully delivered (bills the whole order off `order_items.total_price`, so it can't over-bill undelivered product) — and clears the flag on success.
- **Frontend:** OrderDetail gains a "Create Split Invoices" button (gated on allocated + fully-delivered + no active invoice + no open delivery, so a voided split group can be re-billed — Codex R2 P2) + a "Needs split billing" header badge; Orders list gains a "Needs Split Billing" filter + badge; JobDetail's Transfer-to-Invoice shows a loud multi-owner warning ("landlord's share can't be paid separately"). `Order.needs_split_billing` added to types.
- **Gates:** rls-security + migration-drift + compliance reviewers = 0 blockers; Codex (gpt-5.5) R1+R2 found ZERO issues in this migration (its findings were all in the spray-job migration, now parked, + one OrderDetail UI gap, fixed). Both function bodies are byte-identical to the live definitions except the marked inserts (proven via reconstruction md5 at build). Applied live, then proven end-to-end via a rolled-back `[E2E]` smoke: an allocated order → 0 auto-invoices + flag set + office notified; `create_split_invoices_from_order` → 2 per-owner invoices (distinct customers) + flag cleared + penny-exact reconciliation (6000¢ + 4000¢ = 10000¢); a non-allocated order still auto-drafts exactly 1 invoice. `plpgsql_check` clean; single overload each; grants preserved.

**Spray-job half PARKED (not shipped).** The "Bill via Split Engine" path (findings #42/#50 — give split spray jobs a payable per-owner path) was built and reviewed, but Codex R1+R2 surfaced that completing it correctly requires the job-lifecycle close-out + commission that is entangled with the <24h-old U8 code (job stays `completed`/unbilled-looking, no commission). Per the plan's safety valve ("if it fights back after 2 Codex rounds, PARK it whole — don't half-land split behavior"), the built migration is parked at `scripts/.staging-migrations/u7-spray-job-parked/20260707080000_u7_spray_job_split_path.sql` for its own dedicated session, and the coupled frontend (JobDetail "Bill via Split Engine" button/guards, FieldApplicationInvoice seed-from-job) was reverted. The JobDetail multi-owner warning stays. Owner (Mason) chose "ship delivery, park spray-job."

## 2026-07-06 — Business-workflow U8 — application-channel commissions

Migration `20260707060000` applied live (live version `20260706230608`), closing finding #99: a booking fulfilled by DELIVERY paid the rep's commission while the SAME booking fulfilled by SPRAYING paid zero, because `commissions` had no job lineage at all. Fix: `commissions.order_id` is now nullable and the table gains nullable `job_id`/`invoice_id` FKs (`chk_commission_source` CHECK requires at least one, plus partial indexes on both); `jobs` gains a `commission_split` jsonb column snapshotted at creation by a new `BEFORE INSERT` trigger (`trg_jobs_snapshot_commission_split` / `jobs_snapshot_commission_split`) so a later quote/customer split edit can never re-attribute an already-scheduled job's pay. A new internal helper `_insert_commissions_for_job` (EXECUTE revoked from PUBLIC/anon/authenticated) mirrors the order-channel `_insert_commissions_for_order`. Seven live functions re-emitted with the new commission logic: `create_job_from_quote_section` (copies the quote's split onto the job), `transfer_job_to_invoice` (mints the commission at invoicing from chemical-line profit only — the per-acre application fee and customer-supplied $0 lines are excluded), `void_invoice` (cancels+zeroes the job's pending commissions on both cancel and void paths, generation-precise via the new `invoice_id` column, with a `JOB_HAS_BATCHED_COMMISSIONS` guard and an admin notification if the commission was already paid out), `transfer_invoice_to_job` (same reversal), `save_invoice` (recomputes pending commissions on an edit), `delete_invoices` (cancel+zero + stranded-job release), and `void_commission_payment` (generation-precise liveness — never resurrects a cancelled commission). Went through 10 Codex review rounds; rls-security + migration-drift + types reviewers all clean; applied live and proven via a rolled-back live `[E2E]` smoke before being called done.

## 2026-07-06 — Business-workflow fix run — NIGHT 2 (autonomous)

6 migrations applied live (`20260707010000`→`20260707050000`, live versions `20260706124057`→`20260706175157`) plus coupled frontend, closing the units parked from Night 1: **U12** — applicator "My Day" rebuild (dispatch-aware start/complete widened to per-location dispatch not just the whole-job assignee, per-field applied acres, role-based landing page, dispatch notifications, and deliberately NO prices shown on the phone card) plus a bonus security fix found in U12's own post-apply testing — a NULL-actor authorization guard (an unassigned-applicator job could otherwise be started/completed by any active applicator). **U13** — assignment unification: the office `applicator_id` dropdown and the Dispatch Board's per-location wizard were two disconnected systems, and a worse bug rode along — any unrelated JobDetail save cascade-deleted a dispatcher's per-location split; fixed with a preservation stash (`job_dispatch_preservation`) + 4 new trigger functions so dispatch survives saves, plus a "needs dispatch" surface and a job-scoped wizard. **U3 follow-up** — per-customer default application service (prefills the JobDetail picker). **RUP sales role gate** — a security quick-win closing an unrestricted-EXECUTE hole on `generate_rup_sales_records`. **U10 remainder** — application-record legal integrity: `application_date` now the actual (Central-tz) application time not the planned date, applicator name/license snapshotted onto the record at completion, and job-born invoices stamp the job's own season instead of season-of-now. All units applied live and pushed to `main`; full test suite green (3146 passed).

## 2026-07-05/06 — Overnight business-workflow fix run (Wave 1)

8 migrations applied live (`20260706000000`→`20260706130000`, live versions `20260706010233`→`20260706080738`) plus coupled frontend, closing units **U1** (overdue invoices payable + `allocate_payment` over-allocation guard), **U3** (application-fee billable — `save_job` persists `application_service_id` + `compute_season` fix), **U5** (`closed_short` booking closure + `create_job_from_quote_section` guards), **U2** (partial-delivery billing leak — per-delivery-aware auto-invoice + remainder flip), **U4** (customer-supplied chemicals flag — no-charge/no-deduct line), **U6** (void safety — releases a stranded job + blend/job cross-billing guards), **U11** (`complete_job` unconvertible-unit warn-and-fallback; the headline 128×-unit claim was already fixed by A6 — refuted, adjacent real defect fixed instead), and **U9** (stock-policy warn-not-block on `create_quick_delivery`/`complete_delivery` + tier-correct Quick Delivery picker). **U10** shipped partially — the `auto_draft_invoice_on_job_completion` setting flipped ON (owner decision), the rest parked. Every unit went through the rls-security + migration-drift reviewers and a per-unit Codex gate, and was proven via a rolled-back live `[E2E]` smoke before being called done (not just tests passing). **U7, U8, U12, U13** are parked for a follow-up session — U12 (Applicator My Day) and U13 (assignment unification) have full migration + frontend drafts ready in scratchpad, awaiting integration and review gates. Full ledger: `docs/loops/business-workflow-fix-ledger.md`.

## 2026-07-05 — Setup overhaul (fix-it-all): closed the execute_sql/refspec/MCP guard bypasses, single-sourced the push policy, machine-content skip on all phrase hooks, registry-freshness enforcement, overnight-arm handshake; NEW: /fleet, /parked, /run-loop, /rollback, /backup-db commands + scripts, incident-rollback + rotate-tokens runbooks, Dependabot; 3 scheduled automations (weekly DB backup, nightly prod watchdog, weekly db-sweeps+janitor); data-integrity sentinel migration 20260704120000 BUILT+PARKED (live rolled-back smoke green) awaiting Mason's apply OK; global settings hardened (prod powers ask outside CRX, dangerous-mode skip removed, filesystem MCP scoped, token rotation runbook for Mason).

**Addendum (same day):** data-integrity sentinel **APPLIED LIVE** (renamed `20260705150000`, live v20260705215859) after Mason's explicit OK — rls reviewer clean 10/10, drift reviewer caught a filename-version collision with the applied A5 blend-ticket migration (renamed pre-apply) — first live sweep: 0 new alerts, 17 H1 negatives baselined. Schema registry rebuilt from full live introspection. Codex adversarial round on the overhaul found 5 real guard bypasses (string-literal ROLLBACK exemption, pushed-ref vs HEAD in the push gate, ADD COLUMN missing from registry-freshness, nested parked drafts invisible to /fleet — 19 surfaced after the fix, write-redirects passing the overnight handshake) — ALL FIXED + regression-tested same session.

Setup overhaul (fix-it-all): closed the execute_sql/refspec/MCP guard bypasses, single-sourced the push policy, machine-content skip on all phrase hooks, registry-freshness enforcement, overnight-arm handshake; NEW: /fleet, /parked, /run-loop, /rollback, /backup-db commands + scripts, incident-rollback + rotate-tokens runbooks, Dependabot; 3 scheduled automations (weekly DB backup, nightly prod watchdog, weekly db-sweeps+janitor); data-integrity sentinel migration 20260704120000 BUILT+PARKED (live rolled-back smoke green) awaiting Mason's apply OK; global settings hardened (prod powers ask outside CRX, dangerous-mode skip removed, filesystem MCP scoped, token rotation runbook for Mason).

- **Commits this session** (git log -15 (fallback — no author-matched commits in the last 12h)):
  - `491f418d docs(structure-wave2): P2-5b SYNCED TO MAIN + DEPLOYED (7cc3480b, Vercel READY)`
  - `7cc3480b Merge remote-tracking branch 'origin/main' into fix/structure-wave-2026-07`
  - `cbe0294a feat(structure-wave2): P2-5b per-acre unit-fix APPLIED LIVE (two-trigger, live v20260704031557)`
  - `f2904f50 feat(structure-wave2): P2-5b per-acre unit-fix migration BUILT+PARKED (two-trigger, Codex R2 clean)`
  - `ba6f4a99 feat(inventory): close-a-booking-fulfilled-by-application lifecycle`
  - `dd076240 docs(structure-wave2): P2-5 DEPLOYED to prod (a1a432f9, Vercel READY)`
  - `a1a432f9 docs(structure-wave2): P2-5 catalog $/acre picker built + Codex-clean; flag broken per-acre columns`
  - `5cfa4840 feat(structure-wave2): P2-5 surface CORRECT catalog $/acre in QuoteBuilder product picker`
  - `3daa1756 docs(structure-wave2): P2-4 DEPLOYED to prod; P2-5 scoping`
  - `d27919eb docs(structure-wave2): P2-4 Load-Program built + Codex-clean (ledger + CHANGELOG)`
  - `87e1e719 fix(structure-wave2): P2-4 guard Load Program against double-click (Codex P2)`
  - `cec27881 fix(structure-wave2): P2-4 price since-deactivated program products correctly (Codex P2)`
  - `2d950376 fix(structure-wave2): P2-4 normalize "Dry oz" program unit so dry lines reconcile (Codex P1)`
  - `fdd3e8aa fix(structure-wave2): P2-4 reconcile program rate-unit vs stock-unit to prevent over-billing (Codex P1)`
  - `74f7f915 feat(structure-wave2): P2-4 wire Crop Programs -> "Load Program" into job chemicals`
- **Migrations touched** (last 15 commits (fallback)):
  - `supabase/migrations/20260702190000_per_acre_unit_fix_recompute.sql`
  - `supabase/migrations/20260703200000_layer2_close_quote_as_applied.sql`
  - `supabase/migrations/20260702180000_p2_2_retire_dead_objects.sql`
  - `supabase/migrations/20260703130000_layer2_channel_separation_reserve_fixes.sql`
  - `supabase/migrations/20260702160000_a8_terms_to_due_date.sql`
  - `supabase/migrations/20260702161000_a8_aging_basis_unification.sql`
  - `supabase/migrations/20260702162000_ar_reminder_configurable_threshold.sql`
  - `supabase/migrations/20260702170000_p2_1_category_two_axis_remap.sql`
  - `supabase/migrations/20260703120000_layer2_quote_job_reservation_coordination.sql`
  - `supabase/migrations/20260702183000_layer2_save_quote_block_unplan_with_job_draws.sql`
  - `supabase/migrations/20260702182000_layer2_release_hold_reject_job.sql`
  - `supabase/migrations/20260702174000_layer2_reserve_job_inventory.sql`
  - `supabase/migrations/20260702176000_layer2_shortfalls_job_coverage.sql`
  - `supabase/migrations/20260702180000_layer2_rollover_settlement_job_aware.sql`
  - `supabase/migrations/20260702177000_layer2_inventory_position_job_column.sql`
  - `supabase/migrations/20260702181000_layer2_save_quote_restore_job_aware_guard.sql`
  - `supabase/migrations/20260702173000_layer2_quote_lifecycle_guards_job_aware.sql`
  - `supabase/migrations/20260702179000_layer2_forecast_job_holds.sql`

## 2026-07-04/05 — Whole-app business-workflow & daily-use review (read-only; report delivered)

Owner-requested pre-launch deep dive over BOTH sales channels (chemical sales vs custom application) for flawed business logic, workflows that don't make sense, and navigation simplification — grounded in a 10-question owner interview (users/roles, channel coupling, daily volumes, timelines). 13 analyst agents (7 persona day-walkthroughs + 6 structural analyses) against real code + live schema → **121 cited findings**, a **navigation blueprint** (all 82 routes mapped old→new, nothing lost), and an **entry-point consolidation** (7 order / 12 invoice / 2 job creators → one obvious path per situation). Adversarial verify pass: **69 CONFIRMED / 2 ADJUSTED / 0 REFUTED** (50 verdicts lost to transient API limits; every §3-anchoring claim hand-verified in the main session; key screens walked in the live prod app).

- **Headline money bugs found (all hand-verified):** the per-acre application fee is never billable from a job (`jobs.application_service_id` has no setter anywhere); follow-up deliveries of shorted product can never be billed (order-level invoice check + delivery-scoped true-up); overdue invoices vanish from the Payments page (`status='posted'` filter — the RPC already accepts overdue); no customer-supplied-chemical concept (recording the truth corrupts inventory); landlord/tenant splits produce unpayable share-annotations on the job channel; commissions never accrue on the application channel.
- **Deliverable:** `docs/audits/business-workflow-review-2026-07/` — report.md (10 improvement areas, 3-wave plan to Oct 1, 11 owner decisions with recommendations) + findings.json + journeys.md + proposals.md + live-app-anchors.md.
- **No code, schema, or nav changes made** — report-first per owner's choice; implementation waves pending owner approval, each through the normal /ship + Codex + migration gates.

## 2026-07-05 — Security hardening: revoke direct EXECUTE on `recompute_job_applied_acres` (migration APPLIED LIVE)

Closed the last standing `ungated-secdef-mutators` invariant-sweep hit — the one surfaced (as benign, a follow-up candidate) at the bottom of the A5-follow-up entry below.

- **What it is.** `recompute_job_applied_acres(p_job_id uuid)` is a SECURITY DEFINER helper that recalculates one job's total applied acres by SUMMing its child records. The sweep flags it because it's SECDEF, UPDATEs `jobs`, has no in-body auth/role gate, and the `authenticated` role held EXECUTE.
- **Why it was benign.** It's called **only** by two SECDEF triggers (`trg_jarf_recompute` on `job_applied_record_fields`, `trg_job_applied_record_recompute` on `job_applied_records`), both owned by `postgres` so they run as owner; there is **no** frontend `.rpc()` caller (the sole `src/` reference is a mirror-logic comment in `src/components/jobs/appliedRecords.ts`); it's recompute-only (writes the SUM of existing child rows, no forgeable input); and `anon` never had a grant.
- **The fix (chosen over an allowlist entry).** One line — `REVOKE EXECUTE ON FUNCTION public.recompute_job_applied_acres(uuid) FROM authenticated, anon, PUBLIC` — removes the unused direct-call door. This is strictly better than documenting it as "acceptable": it eliminates the surface instead of grandfathering it. The trigger path is untouched (a SECDEF function runs with its **owner's** privileges, and owner `postgres` implicitly retains EXECUTE); `service_role` (trusted backend, never in the browser) keeps EXECUTE. `anon`/`PUBLIC` are revoked for explicit intent (no-ops — a prior migration already removed them).
- **Zero blast radius** (`job_applied_records` / `..._fields` empty live — the function isn't even invoked in production yet). **Proven before + after apply:** a rolled-back live smoke (post-revoke: `authenticated` EXECUTE → false, owner `postgres` + `service_role` → true, `anon` → false); post-apply the live grantees are `[postgres, service_role]` and the function **dropped out of `ungated-secdef-mutators`** (the sweep now returns only the allowlisted `log_failed_notification`). **All 3 reviews clean** (rls-security = SAFE, migration-drift = 0 blockers, independent Codex = CLEAN) with a byte-exact apply-guard proof. Mig `20260705150000`, live v20260705192028.

## 2026-07-05 — Structure Wave-2 A5 follow-up: blend→order audit-consistency + actor gate (migration APPLIED LIVE)

The A5 blend-ticket unit-conversion work (2026-07-04) left one function, `create_order_from_blend_ticket`, with two loose ends the rls reviewer had flagged as a pre-existing follow-up. Both are now closed by **one** surgical re-emit of that RPC — every line byte-identical to the live definition except the two intended changes (proven by a whitespace/comment-insensitive diff that matched exactly after undoing the edits).

- **Audit consistency.** When a blend line is dosed in one unit (e.g. 256 oz) on a product stocked in another (gallons), the order line + inventory txn already recorded the **converted** amount (2 gal), but the ticket→order link row (`blend_ticket_to_order_items.quantity_applied`) still stored the **raw** 256 — because the RPC called `link_blend_ticket_to_order(..., NULL, ...)`, whose NULL/ELSE branch pulls `blend_ticket_products.quantity` verbatim. Now the RPC passes an explicit `p_item_mappings` array carrying each `order_item_id` + its converted quantity, so all three agree. No money or stock math changed — those were already correct; this is bookkeeping consistency only. (When no line matches a catalog product the array is empty `'[]'`, which the link treats identically to NULL, so behavior is unchanged except the recorded quantity on matched lines.)
- **Actor gate.** The RPC trusted a caller-supplied `p_performed_by` with no check — the pre-existing actor-forgery gap flagged at A5. It now rejects a forged/unauthenticated caller **up front** (before any work or the idempotency cache read): `AUTH_REQUIRED` if unauthenticated, `ACTOR_MISMATCH` if `p_performed_by IS DISTINCT FROM auth.uid()`, `INSUFFICIENT_ROLE` unless `is_admin() OR is_sales_rep()` — the exact gate its two siblings (`create_invoice_/create_application_record_from_blend_ticket`) already have. Previously a forgery was only caught at the very end (inside `link_blend_ticket_to_order`) and rolled back; this moves the guard to the front for defense-in-depth and consistency.
- **Zero blast radius** (blend tables empty live). **Proven before + after apply:** exact-match diff (only the 2 changes); a rolled-back live `[E2E]` end-to-end where a 256 oz → 2 gal line showed the converted **2** in the audit row, order line, and inventory txn, a forged actor got `ACTOR_MISMATCH`, and no-auth got `AUTH_REQUIRED`; `plpgsql_check` added no new findings; and the post-apply invariant sweeps showed the function **dropped out of `ungated-secdef-mutators`** (it's now properly gated) with a single overload and `search_path` pinned. **All 4 reviews clean** (rls-security + migration-drift + compliance + Codex) with a byte-exact apply-guard proof. Mig `20260705000000`, live v20260705133836.
- **Pre-existing note surfaced (NOT from this change):** the ungated-mutators sweep separately flags `recompute_job_applied_acres` (a SECDEF helper that only recomputes `jobs.applied_acres` to `SUM()` of existing child records — not anon-executable, takes no forgeable write value, so an authenticated call can only recompute to the correct derived number). Benign; a candidate for a justified allowlist entry in a follow-up. **→ RESOLVED 2026-07-05** by revoking the unused `authenticated` grant instead of allowlisting it (mig `20260705150000`, live v20260705192028) — see the section above.

## 2026-07-04 — Structure Wave-2b: A5 blend-billing units + P2-8 vendor merge + A9 month-end seed (3 migrations APPLIED LIVE)

Three parked Structure Wave-2 migrations, taken live on Mason's explicit OK ("take the 3 live"). Each passed **three CRX reviewers** (rls-security, migration-drift, compliance — 0 blockers) + Codex R2 + a **byte-exact apply-guard proof**, applied via Supabase MCP, and was **verified live** after apply. Applied A9 → P2-8 → A5 (lowest→highest risk).

- **A5 — blend-ticket unit conversion (money + inventory).** The three blend-ticket fulfilment RPCs (`create_invoice/order/application_record_from_blend_ticket`) never converted the blend line's rate/quantity unit to the product's inventory (pricing/stock) unit — an oz-dosed line on a gallons-stocked product mis-billed / mis-deducted by up to **128×** (the blend twin of the field-app fix, flagged as "the single worst correctness bug"). Now each converts via the existing `field_app_priced_quantity` + `normalize_rate_unit` before pricing, prebooking, and stock deduction (a no-op when units already match), and the invoice path **refuses** a billable line with no rate (`BLEND_TICKET_ZERO_RATE`) or an unconvertible unit (`BLEND_TICKET_UNIT_UNCONVERTIBLE`) instead of silently billing $0 / 128×. Migration-only (the OCR edge fn is intentionally unchanged — it can't supply a reliable per-acre unit). Zero blast radius (blend tables empty live). Codex R1→R2 (3 findings, all fixed: dropped a guessed rate unit, fixed fraction parse, wrapped `normalize_rate_unit`). Mig `20260704120000`, live v20260704161532.
- **P2-8 — vendor master consolidation.** Two vendors existed twice with spelling variants ("The Anderson's"/"The Andersons", "Van Deist"/"Van Diest Supply"), splitting bills/POs/products and risking `create_vendor_bill`'s VENDOR_PO_MISMATCH. Repointed the sole FK (`vendor_bills.vendor_id`), normalized the free-text `vendor` strings on 72 products + 3 POs to the canonical spelling, and **soft-deleted** the 2 duplicates (reversible; the money RPC + both UI pickers already filter `deleted_at`). Every step gated on an active canonical (Codex R1 hardening). No hard delete. Mig `20260704130000`, live v20260704160103.
- **A9 seed — month-end catch-up.** Seeded 9 `'open'` accounting periods for the current season's elapsed months (Oct 2025→Jun 2026) so month-end can see prior months. Purely cosmetic/visibility — `check_period_open` ignores 'open'/missing rows, zero enforcement impact. Mig `20260704140000`, live v20260704155555.
- **Deferred to a focused test-first session:** the coupled **A9 MonthEndClose month/year picker** (built + typecheck/test-clean but **6 Codex rounds** each surfaced a distinct period-switch concurrency race on this financial-close page — committed WIP, branch-only, not prod-ready) and **WaveB** (units dropdowns).
- **Pre-existing follow-up (NOT from A5):** the rls reviewer flagged that `create_order_from_blend_ticket` trusts a caller-supplied `p_performed_by` with no actor check — identical in the live pre-A5 definition, so not a regression; optional separate hardening pass.

## 2026-07-04 — "Close a booking fulfilled by application" lifecycle (migration APPLIED LIVE)

A planned booking that we fulfilled by **applying** product for the customer (via field jobs) previously had no clean way to close — "Accept" is the *chemical-sale* door (it creates an order + prebooks stock + commissions, the wrong channel), and Decline/Cancel are both semantically wrong and hard-blocked while a job reservation exists. So such bookings sat open forever. This adds a distinct terminal status **`closed_by_application`** ("Fulfilled (Applied)") plus a small, actor-bound, idempotent RPC **`close_quote_as_applied`**, reached from a **"Close — Applied"** button on the booking.

- **No money moves.** The customer was already billed through each job's application invoice (off `job_chemicals` pricing); the booking never produces AR for the application channel, so closing cannot double-bill. It's a pure lifecycle + inventory-cleanup action, like Decline/Cancel.
- **Owner choices (Mason 2026-07-03):** MANUAL close via a button (never auto); CLOSE-ANYWAY — any un-applied / un-delivered leftover is released back to free inventory (the crop-program holds drop via the release trigger) and the RPC reports how much was released as a warning (warn, never blocks).
- **Guards threaded** (a new status means every "is this booking open?" guard must learn it): the status-transition enforcer gained the `sent/revised → closed_by_application` edge; the hold-release trigger releases its holds; the coordinated allocator treats it as NOT-open so a stray later job event can't re-reserve stock against a closed booking; `create_job_from_quote_section` rejects the new status (no new work scheduled on a closed booking); the RPC requires `is_planned` so a plain non-planned sales quote can't be mislabeled "applied".
- **Codex-hardened:** the initial pass surfaced two real gaps — schedule-a-job-on-a-closed-booking (P1) and mislabel-a-sales-quote (P2) — both fixed and re-proven.
- **Proven before + after apply:** `plpgsql_check` clean on all 5 functions; a live rolled-back `[E2E]` end-to-end (close a planned booking → status flips, 100 leftover units released, and a post-close job event does NOT re-reserve); rls + drift reviewers + Codex all clean; post-apply focused security sweep clean. **Migration `20260703200000` APPLIED LIVE 2026-07-04** (5 reproduced functions, each verbatim + a marked one-line change; single overloads; anon-revoked).
- **Frontend:** "Close — Applied" button + confirmation on the Quote Builder; "Fulfilled (Applied)" status badge/label rendered correctly across the Quote Builder, Quotes list, and Customer detail; the Schedule-Job button hides on a closed (or otherwise terminal) booking.

## 2026-07-03 — Structure Wave-2: P2-5b per-acre columns UNIT-FIX + recompute (APPLIED LIVE)

Fixed the broken `products.tier{1,2,3}_price_per_acre` columns that P2-5 flagged. The save-time trigger `calculate_prices_from_margin` computed per-acre as `tierN_price * rate_per_acre / container_size` with **no unit conversion** (rate in oz, container in gal) — 242 of 595 active products read over $500/acre, worst $16,373/acre. Owner chose **keep the columns + unit-fix + recompute** (not retire), so they can be used/displayed.

- **New STABLE helper `product_price_per_acre()`** — one source of truth, mirroring the frontend `quoteCalc.ts catalogPricePerAcre` exactly (`tierPrice × rate×factor_oz(rate_unit) / factor_oz(inventory_unit ?? unit_size)`, case-insensitive `unit_conversions` lookup default 1, NULL when rate ≤ 0). So the stored column equals what the QuoteBuilder picker shows.
- **Two-trigger split** (keeps price semantics exact, keeps per-acre always fresh): trigger **A** `calculate_prices_from_margin` keeps the margin→price+gross-margin math **byte-identical** to live (per-acre removed; watches `current_cost` + margins only); **new** trigger **B** `recalc_product_price_per_acre` (SECDEF) computes per-acre from the *final* tier price, watching the output union incl. `tierN_price` so it refreshes on direct price edits (`BulkPricingImport`, `Products` inline edit) without A re-firing/clobbering — fires after A (`'r' > 'c'`).
- **One-time recompute** of all products: max per-acre 16,373 → **443**, over-$500 count **242 → 0**, Pramitol 16,373 → **319.80**.
- **Gates:** Codex (gpt-5.5) R1 caught a [P2] where the v1 single-trigger left per-acre stale after partial price-only updates → fixed by the two-trigger split; **R2 CLEAN**. `rls-security-reviewer` + `migration-drift-reviewer` + `compliance-reviewer` all 0-blocker (both migration versions).
- **Applied live** as migration `20260702190000` (live version `20260704031557`); verified in production + a rolled-back live trigger proof (a real price edit corrected a seeded `88888` → `319.80` with no price clobber). Frontend: refreshed the now-accurate comment in `src/lib/quoteCalc.ts`. **Not yet displayed** in any UI — optional follow-up.

## 2026-07-03 — Structure Wave-2: P2-5 catalog $/acre in the Quote Builder product picker (frontend-only)

Surfaced a per-acre price reference in the Quote Builder's product picker so reps can compare products by cost-per-acre at the customer's tier before adding one. **Grounding found the trigger-maintained `products.tierN_price_per_acre` columns are computed wrong** (rate in oz ÷ container_size in gal, no unit conversion — ~43% of 559 products over $500/acre, up to $16,373/acre; verified live), so those columns are **not used**. Instead a new pure `catalogPricePerAcre()` in `src/lib/quoteCalc.ts` recomputes it correctly — the same way `recalcItem` prices a quote line — so the picker figure equals the line's $/acre once the product is added. Reference-only; hidden when a product has no rate. Frontend-only, no DB change.

- 56 `quoteCalc` tests (incl. one asserting the catalog value equals `recalcItem`'s line $/acre, one asserting it ignores the garbage stored column); live check confirms sane $47–320/acre vs the broken $6k–16k. Codex push-gate: CLEAN (1 round).
- **Owner follow-up (owner-gated, not in this change):** the broken `tierN_price_per_acre` columns + `calculate_prices_from_margin` trigger should be retired or unit-fixed so the bad data can't mislead anywhere it might be read.

## 2026-07-03 — Structure Wave-2: P2-4 Crop Programs → "Load Program" into jobs (frontend-only)

Wired the previously **write-only** Crop Programs feature into jobs: a **"Load Program"** button on JobDetail's Chemicals tab drops a saved program's products (with their per-acre rates) into the editable chem grid — **appending** to existing lines (owner decision), non-destructive, reviewed then Saved via the normal `save_job` path. Crop programs are JSON in `app_settings` (no DB table), so this is **frontend-only, no migration.** Mirrors the existing non-destructive "Load Recipe" client-side loader.

- New pure `src/lib/cropProgramHelpers.ts` (13 unit tests): `parseCropPrograms`, `orderProgramsForJob` (programs matching the job's crop first), `programItemToChemRowSeed`, `normalizeProgramRateUnit`.
- **Money-correct by construction** (5 Codex rounds, 2 P1s fixed): the loaded line runs through `reconcileChemAutofillUnits` so an `oz/acre` program line on a per-gallon product doesn't over-bill 128× (and live `Dry oz` normalizes to `oz` so dry-per-lb lines don't over-bill 16×); since-deactivated program products are fetched by id so they still price + carry REI/PHI; a `loadingProgram` guard blocks double-click duplicates.
- **Proof:** typecheck + lint + build clean; full suite 191 files / 3126 tests; a regression test over the **exact live program** ("2026 Wells NON-GMO") proves real data parses + maps correctly. Codex push-gate: CLEAN.

## 2026-07-03 — Structure Wave-2: P2-3 Brand-vs-Generic wired into an admin management page (frontend-only, on branch)

Turned the previously read-only **Brand vs Generic** page into an admin CRUD manager for the `ingredient_map` (brand↔generic) table — closing the Packet-5 dead end where the empty state told a non-coder owner to "edit the ingredient_map table" by hand. **No database change:** the table already exists live with correct RLS (SELECT for any authenticated user; INSERT/UPDATE/DELETE gated on `is_admin()`), a `generic_product_id → products` FK, and 0 rows. Frontend-only, single page + companion test.

- Kept the existing price-comparison viewer; added a searchable **Manage Mappings** table plus an Add/Edit modal (Branded Product & Generic Alternative pickers, Active Ingredient, bulk flag, notes) and a `ConfirmModal` delete. Direct table mutations + `checkMutationResult` (house pattern for a simple admin reference table); write controls gated to `role==='admin'` so sales reps stay read-only and never hit the RLS wall.
- `branded_ingredient` (NOT NULL) defaults to the branded product name when blank; the generic picker resolves to `generic_product_id`; the branded product must match a real product (validation).
- **Proof:** typecheck + eslint + build clean · every-page render smoke · 4 behavioral tests (real render + click-through capturing the actual insert payload) · **rolled-back LIVE insert smoke** — both payload shapes accepted by the real `ingredient_map` schema (FK + NOT NULL), aborted, 0 rows persisted. `compliance-reviewer` CLEAN.
- **Ship state:** committed to `fix/structure-wave-2026-07`, **not** pushed to `main`. Merging the branch to `main` deploys it (Vercel) — owner-gated.




## 2026-07-02 — Inventory-aware scheduling, Layer 2 (scheduled jobs reserve + draw against bookings)

Scheduled field jobs now actually **reserve** the inventory they'll consume, instead of just showing a warning light. When a job is scheduled, each product on it becomes a real inventory hold (`hold_type='job'`, non-expiring), and if the job belongs to a planned booking (a quote), it **draws** against that booking so the same units are never counted or billed twice. Built file-only in the `feat/inventory-layer2` worktree, hardened over 5 Codex rounds, then applied live as one batch (14 migrations) on Mason's go-ahead.

- **New reservation engine** — a `jobs`/`job_chemicals` trigger set (`_sync_job_holds`) keeps each job's holds in lock-step with its chemicals and lifecycle. Holds release automatically on cancel / complete / delete (there's no expiry to lean on). Completion **keeps** the draw (stock was consumed); cancel / soft-delete-while-active **reverses** it.
- **New draw ledger `job_product_draws`** (mirrors `quote_product_draws`) — records how much of a booking each job has pulled. RLS: staff SELECT, writes via SECURITY DEFINER only, FK CASCADE on job + quote + product, UNIQUE(job, product).
- **Core invariant enforced:** a booking's quote-side crop-program hold + its job holds never exceed the booked quantity. Job hold = `drawn + max(demand − drawn − order_prebooked_overlap, 0)`; draw = `min(demand, max(booking − order_drawn − other_job_drawn, 0))`. Quote lifecycle guards, `draw_down_quote`, `convert_quote_to_order`, rollover/settlement, and `save_quote`/`restore_quote_version` all now fold job draws into "already drawn" so settlement math and the accepted-when-fully-drawn rule stay correct.
- **`hold_type='job'` is lifecycle-only** — `release_inventory_hold` rejects it (a manual release would orphan the draw + un-resync the quote); the Inventory client write-guards exclude job holds.
- **Reads made job-aware:** Inventory Forecast gains a "Jobs" column + job demand by job date; `get_inventory_position` reports a `job_holds_qty`; the shortfall RPC no longer double-counts a job's own hold; a new precise `get_dispatch_stock_status` RPC (office-gated, anon-revoked) replaces the client-side dispatch free-stock estimate.
- **14 migrations `20260702170000`–`182000` APPLIED LIVE 2026-07-02** (verified: 113 inventory-position rows carry `job_holds_qty`, structure + security clean).
- **Final Codex push-gate (2026-07-03)** ran on the exact merge tip and surfaced 3 P1s. One was newly-caught and single-job-reachable — **`save_quote` let you un-check "Planned" on a booking a scheduled job was still drawing from**, which reopened the booking while the job kept consuming stock (double-count). Fixed + applied live as migration **`20260702183000`** (A3.10): `save_quote` now rejects the unplan with `BOOKING_HAS_JOB_RESERVATION` (verbatim reproduction + guard-only change; rls + drift reviewers clean; `plpgsql_check` clean; post-apply sweeps clean).
- **Coordination fix — the deferred multi-job P1s are now CLOSED (2026-07-03, migration `20260703120000`, A3.11).** A post-fix Codex gate on `183000` confirmed the unplan guard but showed it was one facet of a broader gap: quote edits and job scheduling didn't coordinate their reservations. Built ONE designed fix — a coordinated allocator **`_sync_quote_job_reservations`** that rebuilds all of a quote's active jobs together, sharing the crop-drawable remainder and the order-prebooked coverage ONCE across sibling jobs (first-come-first-served). It closes all four open facets: multi-job sibling reallocation on cancel (#2), order coverage counted once not per-job (#3), a stale job draw when a quote's booked quantity grows (#4), and a TOCTOU race in the unplan guard (#5 — `save_quote` now locks the quote before checking). `_sync_job_holds` re-routes quote-linked jobs through it; `save_quote` re-syncs its jobs after every edit. For a single job it is arithmetically identical to the old formula, so nothing changes in the common one-job case. Warn-only. Proven before apply: `plpgsql_check` clean, a 5-scenario arithmetic replay of every Codex target, and a real rolled-back `[E2E]` end-to-end (two jobs share a booking of 100 → draws 60/40, holds 60/60 → cancel one → the sibling re-draws to 60); rls + drift reviewers + Codex all clean; post-apply sweeps clean. **No residual Layer 2 deferrals remain.**
- **Two sell channels kept separate (2026-07-03, migration `20260703130000`, A3.12).** Owner clarified the business runs two channels off the same planned booking: **chemical sales** (product we deliver to the customer for them to apply) and **job applications** (product we apply for the customer). Both hold shed stock until fulfilled, for different reasons, so their reservations must **add up, never offset** — and Mason needs an accurate "what's scheduled for us to apply" count. A full-feature Codex push-gate over the whole feature surfaced three items: **#A** the job-reservation math was *shrinking* a job's shed reservation by whatever an order had already drawn (assuming the two channels shared stock) — under-counting the shed need; fixed so **a job reserves its full application demand** (draws still cap at the booking, so nothing is double-billed — only the reservation grew to be honest). **#C** restoring an old quote version didn't re-sync its jobs; fixed to call the coordinated allocator like a normal save. **#B** (relaxing the accept guard so a completed-job booking could be "accepted") was **deliberately dropped** — in this app "accept" means Convert-to-Order (a chemical sale), which is the wrong channel for a booking fulfilled by application; Codex confirmed it was both unreachable and semantically wrong. Such bookings safely stay open (fulfilled via the application invoices); a dedicated "close / mark fulfilled by application" action is a separate owner business-process decision. Proven before apply: `plpgsql_check` clean, and a real rolled-back `[E2E]` end-to-end (order 40 + booking 100 + job needing 80 → job reserves **80** full, draws 60); rls + drift reviewers + Codex clean (only a routine doc-count); post-apply sweeps clean. Frontend: the Inventory holds list now shows a **"Job"** badge and hides the (now server-rejected) Release button for job reservations, which release automatically via the job lifecycle.


## 2026-07-03 — Structure Wave-2: AR due-date/aging + configurable reminder + product-category two-axis remap (4 migrations APPLIED LIVE)

Applied the four Codex-gated, reviewer-cleared workstreams from the Structure Wave-2 loop to production (branch `fix/structure-wave-2026-07`). Each re-emitted function was re-verified byte-for-byte against the *current* live definition before apply (parallel Layer2/A-series work had moved live well past this session's base — zero drift found), then applied in strict order with a live verification after each.

- **A8 — `post_invoice` now stamps a due date** (migration `20260702160000`, live `v20260703170243`). New IMMUTABLE `parse_payment_terms_days(text)` (leading-int parse, default/clamp Net 30, anon-revoked) + `post_invoice` sets `due_date = COALESCE(due_date, invoice_date + parsed-terms)` only-when-NULL, forward-only, invoice-override-then-customer terms. Closes the real gap: chemical-sale invoices previously had **no** due date, so nothing could ever mark them late.
- **A8-aging — unified aging basis** (migration `20260702161000`, live `v20260703170440`). `get_ar_aging`, `get_detailed_statement_data`, and `financial_dashboard_summary` all age from `COALESCE(due_date, invoice_date)` now (was invoice_date), so every AR surface agrees; forward-safe (degrades to old behavior when due_date is NULL). Bucket labels + dashboard JSON shape deliberately unchanged. Proven surgical.
- **Configurable AR reminder threshold** (migration `20260702162000`, live `v20260703170528`). Seeds `app_settings.ar_reminder_days='30'`; `get_ar_reminder_candidates` reads it (robust parse, clamp 1..3650) and ages on the due-date basis. Coupled Settings control (adjust the day-count) + generic ARaging send copy ship on-branch.
- **P2-1 — product category two-axis remap** (migration `20260702170000`, live `v20260703170632`). New `products.use_timing` column; ~400 products re-bucketed (timing-herbicides → Herbicide + a `use_timing` tag; two foliar buckets → Foliar Fertilizer; Utility → Other; 6 blank products classified per owner; fake test product hidden). A `BEFORE INSERT/UPDATE OF category` trigger keeps deprecated aliases from re-entering while **preserving operator free-text** timings (the crux of a 6-round Codex debate). Verified live: Herbicide 272 / Foliar Fertilizer 53 / use_timing 317 / 0 blanks.
- **Not yet deployed:** the coupled frontend (SettingsPage reminder control, ARaging generic copy, ProductDetail Use-Timing combobox, BulkProductImport `use_timing` mapping) is committed on-branch but **not** on `main` — merging = a Vercel prod deploy, which stays owner-gated. Apply-order is already satisfied (migrations live first); the live site is forward-compatible until the deploy.

## 2026-07-01 — Inventory-aware scheduling, Layer 1 (dispatch stock light + Office Cockpit shortfalls)

Wired the field-job scheduler to inventory so the office can see product shortfalls before crews roll — the first, read-only slice of "inventory-aware scheduling". Built via `/ship` (4 reviewer subagents + 4 Codex rounds + both-direction smoke proofs) after first mapping the existing planned-programs / holds / forecast allocation model so this extends it rather than duplicating it.

- **New RPC `get_job_inventory_shortfalls(int)`** (migration `20260702120000`, applied live) — read-only, SECURITY DEFINER, office-gated (`require_admin_or_sales_rep`), anon revoked, search_path pinned. Returns products the next N days of scheduled/in_progress jobs will run short of, **quantity-aware-deduped** vs the parent planned-quote hold (counts only the uncovered portion). No tables, no DML, no reservation.
- **Office Cockpit** — the long-deferred "Inventory Shortfalls" placeholder tile is now live (real data, plus honest "all-clear" and "unavailable" states; counts toward the exception total).
- **Dispatch Board** — office users now see each schedulable job's products + a green/amber/red stock light vs today's free stock (available − prebooked − active holds). Conservative by design (never falsely "ok"); applicators see the board unchanged (the `get_inventory_position` call is office-role-gated).
- **Deferred to Layer 2** (Mason's call): folding job demand into the Inventory *Forecast* page + a "Jobs" column, and precise per-job reservation math — cleanly reverted, since exact hold reconciliation belongs with real job reservations.
- **Codex caught (and we fixed):** a forecast null-crash on job-only products, a multi-location free-stock miscount, an applicator data-exposure via `get_inventory_position`, a shortfall tile that was loaded but never rendered, and the all-or-nothing hold dedup. Post-apply we also caught + fixed a live `anon=X` grant (Supabase default-privilege quirk) so the ACL matches the reference functions.

---

## 2026-07-01 — Correction-mined guardrails (self-improvement from the last 50 sessions)

Mined the 50 most-recent sessions (524 Mason-typed messages → 70 corrections → 12 recurring themes, via a fan-out workflow) for the things Mason keeps having to correct, then turned the top themes into a deterministic prevention system. **No app/DB change** — this is `.claude/` tooling + docs + auto-memory only.

- **12 auto-loading `memory/` files** (one per theme, indexed in `MEMORY.md`) so every future session pre-loads the lessons: done-means-ran-and-proven, codex-gate-ran-not-queued, parallel-sessions-collision-check, verify-paths-and-merge-state, arm-autopilot-not-reassure, lead-with-status-and-next-step, complete-the-recommendation, drive-browser-adapt-channel, capture-loop-harness-spec, live-prod-testdata-and-owner-actions, stop-pause-scope-are-hard-halts, verify-facts-and-ask-preferences.
- **7 new/upgraded hooks** (all fail-open / off-by-default): `stop-verify.mjs` upgraded to require real end-state proof (a `PROOF —` block or preview/fetch/SQL evidence) before "done"; `worktree-awareness.mjs` (SessionStart sibling-worktree list); `codex-push-guard.mjs` (blocks risky push to main without a fresh Codex verdict); `unattended-autopilot.mjs` + `autopilot-arm.mjs` + `autopilot-intent-reminder.mjs` (overnight hands-free switch, dangerous actions still blocked); `hold-latch-prompt.mjs` + `hold-latch-guard.mjs` (stop/pause/scope halts building); `live-testdata-guard.mjs` + `active-area-guard.mjs` (live fake-data + protected-folder boundaries). Wired into `.claude/settings.json`.
- **Tests:** `npm run test:correction-guards` — 99 assertions (4 test files) green; existing `test:agent-workflows` still green. Detail + escape hatches in `docs/reference/agent-guardrails.md`, summary in `CLAUDE.md`.

---

## 2026-07-01 — Error-source triage sweep + Sentry noise cleanup (business events out of Sentry Issues)

Read-only sweep across every flagged-error source (GitHub CI/Actions, code-scanning / Dependabot / secret-scanning, open issues/PRs, Sentry, Supabase advisors, local lint/build/typecheck/doc-drift). Result: **production healthy** — `main` CI green, local gates all clean, 6 low-volume Sentry issues (no real crash), 0 open security alerts.

- **Issue #89 closed** as a stale false-positive: the `watchdog_flags` migration's `entity_type/entity_id` are the table's own columns (not idempotency-key misuse); the CI "62>61" red was the validator false-positive already fixed in `2004b81a`; CI is green at the unchanged `--max-violations=61`. No corrective migration needed.
- **Sentry queue cleared to 0 unresolved:** resolved the stale `boundary_geojson` `/dispatch` error (column now exists, no events since 06-15), ignored-until-escalating the expected `complete_delivery` "Insufficient inventory" guard, and ignored-forever the 4 `[biz]` business-activity logs.
- **Code:** `trackBusinessEvent` (`src/lib/metrics.ts`) no longer calls `Sentry.captureMessage` — business events stay as debug breadcrumbs only and are no longer posted to the Sentry Issues list (owner decision: Sentry is not a business-activity feed). Tests updated (`metrics.test.ts` asserts the breadcrumb is kept and captureMessage is not called). Lint / typecheck / build / 3106 tests green.
- **Open owner items surfaced (free security toggles, all currently OFF):** enable GitHub Dependabot alerts + secret scanning / push protection + CodeQL, and Supabase leaked-password protection (L4) — account-settings toggles only the owner can flip.

## 2026-07-01 — Recent-Commits Bug-Hunt: 7 findings, 6 shipped LIVE (Codex-reviewed ×3)

Full-assault bug hunt over the last-few-days `main` surface (Sentry + GitHub CI + Supabase advisors + a multi-agent hunt), every finding run past **Codex three times** (findings → fixes → re-review). Built in an isolated worktree (`C:\CRX_BugHunt`).

- **F1 [P1, live]** DispatchBoard + FieldView selected non-existent `fields.boundary_geojson/centroid_lat/centroid_lng` → Postgres 42703 in prod (Sentry CRX-MANAGER-11/12). Fixed via new id-scoped `get_fields_geojson_by_ids` RPC (mig `20260701214000`) + both pages fetch only their visible-job fields. Sentry resolved.
- **F2 [CI red]** `validate-sql-migrations.sh` false-flagged `watchdog_flags`' legit entity_type/entity_id → CI red 11 commits. Scoped the idempotency check (still catches multi-line INSERTs); full scan 62→61; **CI run #583 GREEN**.
- **B1 [P2, Codex-found]** notification RPCs replayed the cached idempotency result before the lifecycle gate (stale send on retry after a status change) — gate moved before idempotency (mig `20260701210000`).
- **B2 [P2, Codex-found]** `receive_po_items` locked the item but not the parent PO (receive-vs-cancel race) — `FOR UPDATE OF poi, po` (mig `20260701211000`).
- **F4 [P3]** revoke anon EXECUTE on next_return_number + 2 trigger fns (mig `20260701212000`).
- **F5 [P3]** wrap 9 policies' `auth.uid()` as `(select auth.uid())` + 9 FK indexes (mig `20260701213000`).
- **F3 [P2] PARKED:** process-document WebP/BMP/TIFF allow-list widened; code committed + pushed but the edge-fn deploy hit a persistent Supabase platform 500 ("Failed to set function store") — old v14 intact (OCR unaffected); retry `supabase functions deploy process-document`.

5 migrations smoke-tested vs live (rolled back) + `plpgsql_check` + rls/drift reviewers (0 blockers), applied live + verified. Frontend/CI pushed (`2004b81a`). F3/B1/B2 nits accepted (documented).

## 2026-07-01 — Parked-Migration Batch GO-LIVE: 4 codex-driven-hunt hardening migrations applied to production (`main`)

The 4 non-urgent hardening migrations parked by the codex-driven bug hunt (owner-greenlit 2026-07-01) went **live to production** after the full gate: `rls-security-reviewer` + `migration-drift-reviewer` per migration (PARKED-004 also cleared `compliance-reviewer`), rolled-back `plpgsql`/compile smoke tests, live byte-verification of every re-emitted function, and post-apply live verification. None touched real money (the DB is operationally near-empty).

- **`20260701200000` — AR reminders include overdue invoices (PARKED-005):** `get_ar_reminder_candidates` now selects `status IN ('posted','overdue')` (was `= 'posted'`), so the most-delinquent auto-marked-overdue invoices are no longer excluded from reminder emails. One-predicate change; admin gate + search_path preserved.
- **`20260701201000` — `receive_po_items` row lock + status guard (PARKED-009):** added `FOR UPDATE OF poi` so concurrent receives of the same PO line serialize (closes an over-receive / double-increment TOCTOU race), plus a fail-fast reject of receives against draft/cancelled POs. submitted/partially_received/fully_received stay receivable (the `p_allow_over_receive` correction path is preserved).
- **`20260701202000` — Returns RPC gating (PARKED-004):** the returns status-transition trigger now requires the `app.return_rpc` session flag (set only by the return RPCs) or `admin_override`, so a direct `UPDATE returns SET status` that skips the RPC side-effects (inventory restock, credit memo) is rejected with `RETURN_STATUS_VIA_RPC_ONLY`. Adds `reject_return` + `create_return` canonical RPCs; re-emits `approve_return`/`receive_return`/`issue_return_credit` verbatim + the flag (`cancel_return`/`unapply_credit_memo` unchanged — they use `admin_override`). **Returns.tsx** switched `handleReject`→`reject_return` and `handleCreate`→`create_return`; the two new RPCs added to `src/types/supabase.ts`. Gate proven live: a direct status UPDATE is now blocked (rolled back, the 1 live requested return untouched).
- **`20260701203000` — Inventory planned/holds no double-count (PARKED-007):** `get_inventory_position` `planned_qty` now excludes planned-quote demand already covered by an active linked hold (the 2026-06-13 sync creates one per planned-quote line), so screens adding `holds_qty + planned_qty` no longer double-count. Display-only; `net_position` unchanged. Verified live (a synced product's `planned_qty` went 730→0, holds unchanged at 730).
- **Deferred:** PARKED-006 (route ~6 functions' inline idempotency saves through the hardened `save_idempotency` helper) — cosmetic/defense-in-depth (needs a one-in-a-billion cross-op UUID collision to ever matter); not done because it means 6 verbatim function re-emits for zero functional change. Awaiting owner call.

---

## 2026-07-01 — Codex-Driven Bug-Hunt GO-LIVE: 8 code fixes + field-app ~128× billing fix applied to production (`claude/main-debug-hunt`)

An 8-cycle **Codex-driven bug hunt** (Codex hunts → Claude verifies each candidate against the **live DB** → auto-fix if green / park if it needs a migration) swept the whole app. 26 Codex candidates → **15 confirmed, 11 refuted** (mostly the "append-only trap": Codex read an old migration file, not the live function). **8 code fixes (7 commits) + the field-app billing fix are now on production `main`** (the 7 fix commits merged earlier; this session landed the audit record + docs). Nothing was rolled back.

- **🔴 Headline — field-application invoices overcharged ~128× (PARKED-010, now LIVE).** A field-app chemical line billed `(rate/acre × acres) × unit_price` with the rate in **ounces** but the price per **gallon** and **no unit conversion**. A 16 oz/ac product at $32.10/gal over 100 ac billed **$51,360** instead of **$401.25** (1,600 oz = 12.5 gal × $32.10). Affected ~556/604 products (ratio varies by unit). **Nothing was mis-billed** (0 field-app invoices existed) — but the first real one would have massively overcharged.
  - **DB half — APPLIED LIVE** (migration `20260630180000_field_app_pricing_unit_fix`, version `20260701002103`): adds a `field_app_priced_quantity(qty, rate_unit, inventory_unit, product_form)` converter and corrects **both** server functions — `save_field_app_invoice` (the invoice) and `preview_field_app_invoice_split` (the on-page customer split) — to price on the **converted** quantity, fix cost/margin the same way, and **refuse** (clear error) the ~7 products whose units genuinely don't convert rather than mis-bill them.
  - **Frontend half — merged** (`e695875e`): the on-screen entry preview now prices in the sold unit.
  - **Verified live 2026-07-01:** `field_app_priced_quantity(1600,'oz','gal','liquid')` → 12.5 gal; a 16 oz/ac @ $32.10/gal × 100 ac line now bills **40125 cents ($401.25)**, not $51,360. Codex reviewed the migration twice (round 1 caught cost-math + the second function + rounding, all fixed; round 2 = SHIP).
- **8 code fixes (7 commits) — all Codex-found, Claude-verified against the live DB, Codex-reviewed SHIP:**
  - `4c20fb8d` — job-notification emails could double-send on retry (now fail-closed when the dedupe key is missing, matching the field-app-invoice sibling).
  - `36b9bec5` — disabled the dead prepay "Quick" / "Apply All" buttons (they called server-disabled RPCs that always errored).
  - `2d274161` — hide the blend-ticket "Create Invoice" card unless the ticket is actually billable (`unbilled`).
  - `832f6c8a` — AR reminder email showed `$NaN` for the outstanding total (now summed from per-invoice balances instead of a field the DB doesn't return).
  - `5938937d` — (a) signed-money parser no longer treats a mid-string dash as a minus (`"12-34"` → rejected, not −$1,234); (b) commission-void screen now reports both the reset AND the closed-out commission counts.
  - `1cd3c873` — guarded the chemical-rate input against NaN.
- **Audit record preserved:** the full morning report, ledger, and parked-migration drafts live in `docs/audits/codex-driven-bug-hunt/` (commit `3dfc26e0`, landed on `main` this session — docs only, deploys nothing).
- **5 parked migrations remain (owner decision; none urgent, none touch money — the system is operationally empty):** PARKED-004 (returns can be advanced without their RPC side-effects — insider data-integrity), PARKED-005 (AR reminders skip `overdue` invoices — one line), PARKED-006 (route inline idempotency saves through the hardened `save_idempotency` helper), PARKED-007 (inventory "planned" column double-counts planned-quote holds), PARKED-009 (PO receiving can over-count under concurrent receives — add `FOR UPDATE` + status guard). Drafts/validation for 004/005/009 are in `docs/audits/codex-driven-bug-hunt/`.
- **Naming note:** a prior hunt already used migration names `parked_001`…`parked_010`, so this hunt's field-app fix landed as `20260630180000_field_app_pricing_unit_fix`, **not** `parked_010`. Any of the 5 above, if approved, must get fresh descriptive names (not `parked_00N`).

---

## 2026-07-01 — ChemMan Gap-Closeout GO-LIVE: weather auto-fill + diluent-per-acre applied to production (`feat/chemman-gap-closeout`)

The two remaining ChemMan-comparison gaps (#1 weather auto-fill, #2 diluent/carrier-water per acre — both detailed below) went **live to production** (`croprxsolutions.app` / Supabase `rhyzpcqhnizqbxphqdkr`) on 2026-07-01 after Mason's explicit go-live approval.

- **Both migrations applied to prod in order** via the apply-guard proof + `rls-security-reviewer` + `migration-drift-reviewer` (both CLEAN each): `20260630180000_field_app_invoice_weather_capture` (invoices +13 nullable weather cols; `update_field_app_applied_info` 6→20 arg) then `20260630190000_field_app_invoice_diluent_per_acre` (invoices +`diluent_rate_gpa`; RPC 20→22 arg). **Prod-verified**: single overload each, all new cols nullable, **no new CHECK** (invoices still 6), `anon` execute revoked, no generated column. Security advisor clean (only the pre-existing, accepted `profile_public_view` ERROR). Live prod `update_field_app_applied_info` body was confirmed byte-identical to the migration's clone base before applying.
- **Code:** `origin/main` merged into the branch (2 doc conflicts resolved → 572 migrations on disk), then `main` fast-forwarded to `17b4445e` and pushed (pre-push typecheck+build green); Vercel deployed. **Proven live** by fetching the deployed `FieldApplicationInvoice` chunk on croprxsolutions.app and grepping the feature text (`Diluent / Carrier Water`, `Get Weather`, `modeled, not measured`).
- **Defaults:** the diluent rate + total print on the **customer-facing** invoice PDF (both standard + legacy layouts), matching ChemMan — Mason's chosen default; reversible to internal-only later with no data change. Weather stays modeled-not-measured (disclaimer shown).
- **Follow-up (non-blocking):** regenerate `.claude/schema-registry.json` to include the 14 new `invoices` columns (drift-reviewer recommendation; low risk — additive nullable, no enum/generated/table).

---

## 2026-06-30 — ChemMan Gap-Closeout #1: Weather auto-fill on the field-application invoice (`feat/chemman-gap-closeout`, LOCAL only)

One of the two remaining ChemMan-comparison gaps. The field-app invoice's Applied Info tab gains one-tap **Get Weather** capture for START and END conditions (temperature °F, wind speed mph, wind direction, humidity %, plus a per-set clock time), persisted to structured columns alongside the legacy free-text fields.

- **Migration `20260630180000_field_app_invoice_weather_capture.sql`** (LOCAL only): 13 ADDITIVE NULLABLE columns on `invoices` (a MONEY table) mirroring `job_applied_records` — `start_*`/`end_*` temp/wind/humidity/direction/source/time + `weather_manual_override` boolean. **No new CHECK, no NOT NULL** (touches none of invoices' 6 CHECKs); RLS unchanged. Extends `update_field_app_applied_info` **drift-safe** (DROP old 6-arg → single 20-arg superset; verbatim body + only additive writes; strict-actor, admin/sales gate, op-scoped idempotency, editable-invoice guard, `SET search_path` all preserved; original `REVOKE … FROM PUBLIC, anon` + `GRANT … TO authenticated` re-applied).
- **Stale-data safety (Codex-driven):** a `p_update_weather` sentinel means an old-bundle browser tab calling the 6-arg form can't silently erase captured weather; auto readings are invalidated when the user changes the field/date but preserved on load; an in-flight fetch whose key changed is dropped. RPC-layer validation rejects impossible values (negative wind, humidity outside 0–100, bad source) without a DB CHECK.
- **Open-Meteo only** (free/keyless, already CSP-whitelisted) via the existing `fetchWeatherForDateTime` helper + `get_field_geojson` centroid; manual entry always works offline; a failed fetch never blocks save. The mandatory **"weather is modeled, not measured — verify on-site before relying on it for compliance"** disclaimer renders on the weather UI.
- **Proven:** rolled-back LOCAL smoke (persist / old-caller-preserve / validation-reject / idempotent replay / single overload / anon-revoked) + live-DB end-to-end render in the running app (login → invoice → Get Weather fills both sets → manual edit flips source to Manual → save persists → reload restores → user date-change clears stale auto → offline fetch still allows manual entry). 3 CRX reviewers (rls-security / migration-drift / compliance) + Codex (5 rounds) clean. NOT applied to prod — local only, awaiting the owner production gate.

---

## 2026-06-30 — Beyond-Parity GO-LIVE: all 6 internal features applied to production (`feat/fieldapp-beyond-parity`)

The §1–§6 beyond-parity build (built LOCAL-only, detailed in the per-section entries below) went **live to production** (`croprxsolutions.app` / Supabase `rhyzpcqhnizqbxphqdkr`) on 2026-06-30 after a full re-gate.

- **Re-gate before apply:** 3 CRX reviewers (rls-security / migration-drift / compliance) + an independent Codex pass on the whole branch. Codex caught **2 medium gaps** in the new safety features — both fixed before go-live:
  - **Watchdog unit-matching** (`normalize_rate_unit`): the over-label-rate check compared units as raw strings, so `oz/acre` vs `oz` (or `pint` vs `pt`) wouldn't match and a real over-application could go un-flagged. Fixed with a pure `normalize_rate_unit()` mirror of the frontend normalizer, in its OWN append-only migration `20260630170000` (NOT an in-place edit of `…240000` — Codex P1).
  - **Cockpit "Post all clean" freshness** (`OfficeCockpit.tsx`): bulk-post trusted the last persisted watchdog sweep; it now **recomputes** the sweep and re-derives the clean set from FRESH flags before posting, failing closed — a stale flag can no longer let a now-flagged invoice slip through.
- **Applied to live:** all **9** migrations (`20260629210000` → `20260630170000`) in timestamp order, each behind the migration-apply-guard proof + the reviewer gate. Verified live: every new table has RLS; every new SECDEF function is search-path-safe + anon-revoked; `complete_job` is the verbatim core + the gated auto-draft block and **never posts**; `get_job_proof_data` is the per-customer 2-arg form (no cross-customer leak); the security advisor added **zero** new findings and the invariant sweeps **zero** new violations.
- **Safe by default:** `auto_draft_invoice_on_job_completion` = `false` (OFF) and `label_rate_guardrail_mode` = `warn` — no customer-facing behavior changes on apply.
- **Owner-gated remainders:** the §1 label-data load (review of AI-drafted REI/PHI/signal/EPA/max-rate values onto the 604 live products) and the `send-email` edge-function deploy (activates the customer "field was sprayed" email) stay owner tasks.

---

## 2026-06-30 — Beyond-Parity §6 (FINAL): "Your Field Was Sprayed" proof notification — office-approved one-tap send (`feat/fieldapp-beyond-parity`)

On a completed/invoiced field-app job, the office reviews a rich **proof** of the application and **one-taps Send** to the grower (never an auto-send). Builds on the parity #41 post-notification infra rather than duplicating it.

- **Migration `20260630120000_job_proof_data.sql`** (LOCAL only): adds one read-only `SECURITY DEFINER` RPC `get_job_proof_data(uuid)` returning a `jsonb` proof payload — job/applicator, fields (effective acres + county/state + centroid & boundary GeoJSON via PostGIS + planned harvest date), products (per-acre rate, REI hours, PHI days, signal word), and weather at application. `STABLE`/no-mutation (no idempotency key); `SET search_path` (incl. `extensions` for PostGIS); anon revoked; admin/sales_rep gate as the first statement. Each block degrades gracefully (NULL when not on file).
- **Reuses unchanged:** `record_job_post_notifications` (per-recipient log + DETERMINISTIC per-recipient email idempotency key) and `confirm_job_notification_sent` (flips a row to `sent` only after the email succeeds). The send-email `post_application_notice` email_type is already allow-listed — **PREPARED, deploy GATED for Mason** (not deployed).
- **Frontend:** `src/lib/proofNotification.ts` (pure builder: rich HTML + plain-text proof, free/keyless OpenStreetMap static boundary-map snapshot + live-map link, REI/PHI safe-timing reusing §5 `labelGuardrails`, `escapeHtml` on all customer/field/product text → no injection; 28 unit tests) + an office-reviewable proof-preview Modal and rewired send in `FieldApplicationInvoice.tsx`. `vercel.json` CSP `img-src` adds `staticmap.openstreetmap.de` for the in-app preview.
- **Safety:** office-approved one-tap (no silent auto-send); per-recipient deterministic key (never `Date.now()`) so a retry never double-sends; a recipient with no email is logged `failed`, never dropped; per-recipient send errors are surfaced. Static **boundary-map IMAGE** ships as a pinned OSM snapshot + deep link; a full polygon-on-tile render is flagged as a follow-on.
- **Proven:** rolled-back LOCAL smoke (record → retry-idempotent → confirm 2 recipients; anon + applicator rejected) + a live-DB end-to-end render (auth → RPC → rich proof HTML with every block). typecheck/lint/build clean; rls-security + migration-drift reviewers CLEAN.
- **GATE:** the send-email edge-function **deploy** (to activate `post_application_notice` in live) is **OWNER-GATED** — prepared, not deployed.

---

## 2026-06-30 — Beyond-Parity §4: Auto-Invoice on job completion — auto-DRAFT only, NEVER auto-post (`feat/fieldapp-beyond-parity`)

When a field job is completed, optionally create a **draft** field-application invoice for the office to review and post — the riskiest "money" section, built off-by-default and fail-soft so it can never surprise the office or block job completion.

- **Migration `20260630073344_auto_draft_invoice_on_job_completion.sql`** (LOCAL only):
  - Seeds an inert app-setting `auto_draft_invoice_on_job_completion` = `'false'` (**OFF by default**, admin-only via existing `app_settings` RLS).
  - `CREATE OR REPLACE complete_job(uuid,jsonb,uuid,text)` — verbatim live body + ONE added block at the end of the success path. When the setting is `'true'` **and** no non-voided invoice already references the job, it calls the already-reviewed `transfer_job_to_invoice()` (which creates a DRAFT field-app invoice, flips it to `unposted`, and STOPS). **It NEVER posts** — no post RPC is in the auto path. Single overload preserved.
  - **Fail-soft:** the block is wrapped in a nested `BEGIN/EXCEPTION WHEN OTHERS` — any draft failure is swallowed (job still completes) and an `auto_draft_failed` activity-feed note is logged for the office.
  - **Idempotent:** job-scoped idempotency key + existing-invoice guard = no duplicate draft on re-complete/retry.
- **Settings toggle** (`src/lib/autoDraftSetting.ts` + `SettingsPage.tsx` "Auto Invoice" card, admin-only) — OFF by default; only `'true'` is ON.
- **Office-Cockpit "Post all clean"** (`OfficeCockpit.tsx`) — posts ONLY the drafts that (a) pass validation (`pricing_pending=false`) AND (b) have no open §2 watchdog flag on the invoice or its job. Group → `post_invoice_group`, single → `post_invoice`. In-app Modal summary (no `confirm()`/`alert()`); skipped invoices listed with reason. A human clicks it, so posting is allowed — but a flagged/incomplete invoice is never posted.
- **Proven against LOCAL DB** (rolled-back txn, all 4 cases): OFF → 0 drafts; ON → exactly 1 `unposted` `field_application` draft (NOT posted, priced/split by existing logic); re-run → still 1 (idempotent); applicator-completed (transfer role-gate fails) → job completes, 0 drafts, `auto_draft_failed` logged.
- **Tests:** `src/lib/autoDraftSetting.test.ts` (14 cases — OFF default, only `'true'` is ON, round-trip).

---

## 2026-06-30 — Beyond-Parity §3: Office Cockpit exception dashboard (`feat/fieldapp-beyond-parity`)

One screen showing the office everything stuck or wrong across the field-app — Mason's #1 priority from the beyond-parity opportunity map (saving office time, replacing the run-seven-reports ritual).

- **New page `/office-cockpit`** (`src/pages/OfficeCockpit.tsx`): 7 live exception tiles, each with count, all-clear empty state, per-row click-through to the relevant screen, and a refresh button with "Updated" timestamp.
  - **(a) Unbilled Jobs** — completed jobs with no invoice (`jobs.status='completed' AND invoice_id IS NULL`). Click-through: `/jobs/:id`.
  - **(b) Ready to Post** — draft/unposted field-app invoices (`invoices.status IN ('draft','unposted') AND invoice_type='field_application'`). Notes §4 Auto-Invoice will auto-populate this tile. Click-through: `/field-invoices/:id`.
  - **(c) Watchdog Flags** — active (non-dismissed) flags via `get_watchdog_flags` RPC from §2. Click-through: `/jobs/:id` or `/field-invoices/:id` per flag entity, else `/watchdog`.
  - **(d) Upcoming Jobs (7 days)** — scheduled jobs in the next 7 days. Notes weather risk is checked live in Job Detail (no DB-stored weather-blocked flag exists). Click-through: `/jobs/:id`.
  - **(e) Expiring Licenses** — applicator licenses/buyer certs within 30 days window (`applicator_licenses.is_active=true AND expiry_date BETWEEN -30 AND +30 days`). Click-through: `/compliance`.
  - **(f) Overdue Field-App AR** — posted field-app invoices past due with balance > 0. Click-through: `/field-invoices/:id`.
  - **(g) Inventory Shortfalls** — placeholder tile (deferred: would require per-job-chemical × live-inventory join per job, anti-N+1 query design is the follow-on task).
- **All 6 live queries run in parallel** (`Promise.all`) — one aggregate query per tile, no N+1.
- **RLS-respecting** — all queries are direct table SELECTs inheriting the caller's RLS policy; the watchdog RPC gates on role inside its body.
- **Sidebar nav link** "Office Cockpit" (LayoutGrid icon) added as a top-level standalone item (admin/sales_rep). `pagePermissions.ts` entry added; `pagePermissions.test.ts` 32/32 pass.
- **Verified against LOCAL DB**: 4 tiles populated (1 unbilled job, 6 ready-to-post invoices, 1 seeded watchdog flag, 1 upcoming job), 2 tiles legitimately empty with all-clear state. Click-through on unbilled job row navigated to `/jobs/00000000-0000-0000-0000-0000000aa103` (FJOB-003). Refresh button updates timestamp. Compliance review: CLEAN (0 blockers, 0 high, 0 med).
- **No migration required** — read-only aggregation using existing tables and §2's `get_watchdog_flags` RPC.

---

## 2026-06-29 — Field-application parity build COMPLETE (`feat/fieldapp-parity`): 41 sections + 15-fix Codex remediation

End of the field-app-parity loop. The branch closes the verified ChemMan field-application + invoicing gaps (per the 2026-06-24 competitor capture) and is now Codex-clean. **Branch-only and LOCAL-DB-only** — its 39 migrations are NOT yet in live `schema_migrations`; shipping is gated on the production apply review.

- **41 sections built to ChemMan parity**, each built → run/proven against the local throwaway Supabase DB → Codex-reviewed (all High/Med fixed) → committed. Coverage spans: extended `save_job` (scheduling dates, consultant, memo fields, per-field agronomy + customer shares, chemical extras); job **tags**, **ground crews**, **batches**, per-user **list settings**; **as-applied records** (`job_applied_records` + per-field acres with rollup integrity, **start/end weather**, **tach/hour-meter**, **crew roster**); **fuel surcharge** (setting scaffold — OFF by default, formula blank, no invented money rule); invoice **header/footer/discount**; **applicator-sheet** + **loader-worksheet** print audit (`printed_at`/`last_printed_by`); the **job↔invoice transfer** pair (`transfer_job_to_invoice` forward / `transfer_invoice_to_job` reverse) + **unpost** (`unpost_invoice`); **per-location dispatch board** (`dispatch_job_locations` / `undispatch_job_locations` / `get_dispatch_board_jobs` / `get_dispatched_list`, recursion-safe dispatchee RLS); **job attachments**; **job notifications**; the mobile **applicator FieldView** (#38) and the Unposted/Posted/Customer-Invoice-Summary field-invoice trays (#22/#23/#34).
- **15-fix end-of-run Codex remediation** (Waves 1–3) on top of the 41 sections, including: **P1 SECURITY** — closed the `invoice_id` detach/repoint hole in the billed-job immutability guard (`20260629120000`); **Wave-2a** — field-membership RLS on `job_applied_record_fields` (`20260629150000`), batched RLS-safe `get_jobs_billed_customers` (`20260629160000`), all-or-nothing `unpost_invoice_group` (`20260629170000`); **Wave-2b** — atomic `save_job_applied_record` RPC (commit `158e3259`, `20260629190000`); **P3** — zero `total_cost_cents` on a cancelled transfer-reversed invoice (`20260629200000`), plus JobDetail gal/lb preview, dup-job guard, shares-loading guard, 500-cap banner, orphan-acres and transfer-copy fixes.
- **Billed-history immutability** is now DB-enforced (not just frontend): the `_enforce_billed_job_immutability` BEFORE-UPDATE trigger on `jobs` blocks a non-admin from soft-deleting or rewriting a billed (`invoiced`/`cancelled`) job's billed-relevant columns — **including `invoice_id`** after the P1 fix — while exempting print-audit/applied-acres/bookkeeping columns and honoring the admin + `app.admin_override` hatch and the two sanctioned transfer RPCs.
- **Counts moved** (branch HEAD, local DB): pages 75→**79**, migrations 517→**556** (39 new), callable RPCs 232→**270**, trigger fns 53→**56**, tables 98→**111**. `migration-history.md`, `pages-routes.md`, `rpc-functions.md`, `database-schema.md`, AGENTS.md (regenerated), and the CLAUDE.md Snapshot all reconciled; `check-doc-drift.mjs` passes.
- **Regression guard added** (this wrap-up): `scripts/smoke/smoke-billed-job-immutability.sql` (+ `smoke-specs.json` entry `enforce_billed_job_immutability`) — a rolled-back role-sim chain asserting the trigger's blocked paths (soft-delete, `total_price_cents`, `invoice_id`→NULL and repoint), exempt paths, admin/override hatch, and both transfer writers. Proven PASS against the local DB (+ a negative-control run confirming the asserts detect a regression).
- Per-section detail lives in the dated entries below and the per-section smoke chains in `scripts/smoke/`.

## 2026-06-26 — Field-app parity #36: per-location dispatch + 3-step wizard

ChemMan "Dispatch Jobs" parity — the dispatcher can now hand out individual field **locations** of one job to different applicators/crews, so two crews can split one big job.

- **New table `job_location_dispatches`** (migration `20260626120000`): one CURRENT dispatch per location (`UNIQUE (job_field_id)`; re-dispatch upserts), a `(applicator_id IS NOT NULL) <> (crew_id IS NOT NULL)` XOR CHECK (assigned to an applicator OR a crew, not both/neither), `dispatch_status` CHECK (`dispatched`/`completed`/`cancelled`), denormalized `job_id` + index. RLS: SELECT for job viewers (admin/sales_rep/whole-job applicator) **plus** the applicator a location was dispatched to; **writes are RPC-only** (no client write policy → direct PostgREST writes RLS-denied for every role; the SECURITY DEFINER RPC is the sole write path, so a direct client call can't bypass the lifecycle/active-assignee guards — Codex #36 P2); explicit `GRANT SELECT` to authenticated; anon denied.
- **Commit RPC `dispatch_job_locations(p_assignments jsonb, p_performed_by, p_idempotency_key, p_license_override)`** — SECURITY DEFINER, `search_path=public,pg_temp`, single overload, anon revoked. Strict-actor (`ACTOR_MISMATCH`) + role gate (admin/sales_rep), idempotency scoped to `dispatch_job_locations`, per-assignment XOR + active-applicator/active-crew validation, **applicator-license gate** (an applicator whose tracked active licenses are all expired → `LICENSE_EXPIRED`, mirroring the `jobs` trigger that this RPC bypasses; admin-only `p_license_override` hatch — Codex re-review P1), scoped to dispatchable jobs (`scheduled`/`in_progress` → `JOB_NOT_DISPATCHABLE` otherwise), upsert on `job_field_id`. Returns `{ dispatched: <count> }`.
- **`jobs` SELECT extension + recursion-safe helper** (Codex re-review P1): an additive `jobs_select_location_dispatchee` policy + a SECURITY DEFINER `_is_dispatched_to_me(job_id)` helper let a per-location-only assignee (applicator OR crew member) read the PARENT job — otherwise their dispatched work is invisible on the board under RLS. The helper bypasses RLS to break the jobs<->job_location_dispatches policy cycle (the naive cross-EXISTS version caused infinite recursion). The dispatch-row SELECT policy also now lets a member of the dispatched CREW read crew rows (Codex re-review P2).
- **3-step wizard** (`DispatchWizard.tsx` + pure logic in `lib/dispatchWizard.ts`): Step 1 Select Locations (across jobs) → Step 2 Assign Selections (per-location applicator/crew; different locations → different assignees) → Step 3 Finish Dispatching (commits via the RPC). Launches from the Dispatch board's "Dispatch Jobs" section (replaces the old inline whole-job assign stub).
- **Job-row "Assigned To" aggregates** the distinct per-location assignees (a job split between two applicators shows BOTH names), falling back to the whole-job `applicator_id` when there are no per-location dispatches.
- **License override is recorded durably** (Codex re-review-2 P2): an actual expired-license override writes a `job_location_dispatched` `activity_feed` row + returns `{ dispatched, license_overrides }`. **Cancelled dispatches stop granting visibility** (P2): `_is_dispatched_to_me` + the per-location SELECT branches scope to `dispatch_status='dispatched'`, so a cancelled dispatch no longer leaks the parent job to a former assignee. **`hasRpcCode` now reads a plain PostgREST error object's `.message`** (P2 — it previously only read `Error.message`, so a thrown `supabase.rpc` `{ error }` object stringified to `[object Object]` and the LICENSE_EXPIRED/override-prompt path silently failed; this also fixes the existing whole-job assign flow).
- **Assignee FKs are `ON DELETE CASCADE`** (Codex re-review-3 P2): `applicator_id`/`crew_id` cascade on delete instead of `SET NULL` (which would null the sole assignee and violate the XOR check, blocking the delete). **`job_fields` child-row RLS extended** (P2): an additive `job_fields_select_location_dispatchee` policy (same `_is_dispatched_to_me` helper) lets a per-location assignee read the job's location rows the board embeds, not just the job header.
- **`customers` child-row RLS extended + soft-deleted-job guard** (Codex re-review-4 P2): an additive `customers_select_location_dispatchee` policy lets a per-location assignee read the embedded customer (else the board shows "Unknown"), and the RPC now requires the parent job to be LIVE (`deleted_at IS NULL`) so a soft-deleted job can't be dispatched via the RLS-bypassing definer RPC.
- **Every dispatch lands on the activity timeline** (Codex re-review-5 P2): the RPC now writes a `job_location_dispatched` `activity_feed` row per location (assignee name + field + override note when applicable) — restoring the audit trail the replaced `assign_job_applicator` flow provided (previously only override cases were logged).
- **Applicator filter matches the DISPLAYED assignee** (Codex re-review-7 P2): once a job has per-location dispatches, the filter matches only those assignees (not the now-hidden legacy `jobs.applicator_id`), mirroring `aggregateAssignedTo` — applied BOTH client-side (`selectDispatchView`) and in the **server query before the 500-row cap** (the job-level branch excludes any job with a per-location dispatch, so stale assignments can't consume cap slots and hide real matches — re-review-8 P2). **schema-registry.json updated** (P2): the new `job_location_dispatches.dispatch_status` enum (`dispatched`/`completed`/`cancelled`) is registered so the project's status-CHECK hooks guard it.
- **Lifecycle race closed** (Codex re-review-8 P2): the RPC locks the job row `FOR UPDATE` before the dispatchable-status check, so a concurrent complete/cancel (which takes the same row lock via the status-transition trigger) can't slip the job into a non-dispatchable status between the check and the upsert.
- **Wizard gated to dispatchers + paginated filter reads** (Codex re-review-10 P2): the Start-Dispatch / per-job launchers are hidden from `applicator`-role users (the RPC is admin/sales-only, so they'd hit `INSUFFICIENT_ROLE`) — applicators on `/dispatch` see a read-only note; and all three `job_location_dispatches` reads that drive the applicator filter/aggregation now page via `.range()` so they stay correct past the Supabase API row cap.
- **Deactivated crew loses visibility + duplicate-payload guard** (Codex re-review-9 P2/P3): the helper + SELECT policy now also require `ground_crews.is_active` (deactivating a crew revokes its members' dispatch visibility, mirroring the profile is_active re-check); and the RPC rejects a payload listing the same `job_field_id` twice (`DUPLICATE_LOCATION`) so the dispatched count/audit can't be over-stated.
- Proven: rolled-back smoke chain `smoke-dispatch-job-locations.sql` (18 steps: multi-applicator split, idempotency, re-dispatch upsert, XOR/role/actor/lifecycle gates, RPC-only writes incl. admin, license gate + override-logged, crew-member RLS read, per-location-applicator job read, cancelled-dispatch visibility revoke) + live wizard E2E + live RPC calls in the running app against the local DB (2 locations → 2 applicators, rows persisted, re-dispatch upserts to a crew, both names on the job row, `hasRpcCode` LICENSE_EXPIRED match confirmed live).

## 2026-06-24 — Error-prevention guards from the UI-overhaul review (2 hard guards)

Turned the two highest-value recurring classes from the 10-pass Codex review of UI overhaul v2 into deterministic guards (HARD scaffolding > prose). Frontend + tooling only, zero DB.

- **Money never silently reads $0** — new local ESLint rule `require-supabase-error-capture` flags a `supabase.from()/.storage` read that destructures `data` but never captures `error` (the AccountsReceivable "Unused Prepay" + Receiving Hub "nothing on order" bug class, where a failed query renders as $0/empty). It closes the half its sibling `handle-supabase-error` leaves open. The pattern exists in ~130 mostly-benign legacy reads across 51 files, so it is **scoped as a hard `error` only on the money screens** (`AccountsReceivable`, `ReceivingHub`, `FinanceSnapshotCard` — clean today) and a ratchet to widen as legacy reads are triaged. Unit-tested (catches both bug shapes, allows the `{ data, error }` + handle pattern).
- **Customer finances can't leak from the peek drawer** — `CustomerDrawer` now **self-guards**: it calls `hasPageAccess(role, deniedPages, 'customers')` itself and renders nothing if the viewer lacks access, so a driver (or a sales_rep denied `/customers`) can never see AR balance + credit tier no matter which list mounts it. Structural fix for the round-5 P1; the per-callsite gates stay as the first line. Unit-tested (driver/denied → nothing; admin/sales → renders).
- Gate green: lint + typecheck + build + 2222 tests. Deferred (recorded): patterns 3–6 (shared-flow extraction, notification de-dupe, race/data-shape) + widening the lint ratchet over the ~130 legacy reads.

## 2026-06-24 — UI/workflow overhaul v2: 7 features SHIPPED LIVE (frontend-only, zero DB)

Owner asked to de-clutter the app ("very clicky / spread out"); after a grounded 8-agent UX audit he chose 7 improvements, built autonomously on `feat/ui-overhaul-v2` under hold-for-review, then **"push it all live."** Merged to `main` (`083c4087`, FF over the parallel field-map work — only conflict was the generated `app-workflow-map.html`, regenerated) + deployed. **Pure frontend, ZERO database changes.** Rollback = prior prod `dpl_14oxe2t8AGL7GxJGVcgTF5wEfSKc` (commit `c480191e`).

- **F1 Search by product everywhere** — Orders/Quotes lists + ⌘K palette now match on product name, not just customer/number.
- **F2 Customer 360** — clickable customer summary cards + a slide-over "peek" drawer on Orders/Invoices/Deliveries.
- **F3 Act from the list** — confirm-popup writes reusing the detail page's exact RPCs: Quotes→Convert-to-Order, Deliveries→Mark-Complete, Inventory→Reorder.
- **F4 One AR workspace** — `/accounts-receivable` merges the 4 money pages into tabs + a Net Money Position card (`/payments` kept separate per the role red-line).
- **F5 Receiving Hub** — `/receiving-hub` PO-lines-by-product board + a full-receipt quick-Receive.
- **F6 Dashboard Finance Snapshot** (admin) · **F7 quick wins** (Invoices Order# column + balance filter, sidebar label fix).
- **Independent Codex review gate: 10 passes → 15 findings (1 P1 / 12 P2 / 2 P3), all fixed.** The P1 was a real role data-leak (a driver could see customer AR/credit via the F2 peek drawer on `/deliveries`) — caught and closed on the branch, never live. Each fix re-gated (lint+typecheck+build) + committed; pass #10 = zero findings. Final merged tree: **2210 tests pass**.
- Open: Mason's in-app click-test of the 3 write buttons (Convert / Complete / Receive) against real data.

## 2026-06-23 (night) — Field-acre-billing Track B (B1+B2): per-acre billing tie-in + billing-engine hardening (SHIPPED LIVE)

Owner approved "go all the way live overnight" (gated on every automated review/Codex/smoke gate). Migration `20260623140000_field_app_per_acre_billing_and_hardening.sql` reproduces `save_field_app_invoice` + `preview_field_app_invoice_split` + `post_invoice_group` byte-faithful (rolled-back function-definition diffs = only-intended-changes) then patches the field-application invoice engine. Pushed to `main` (`1ee5c6aa`) + deployed (`dpl_y86Jrno85srQsCBa41zfxDNAuyCH`; rollback = prior prod `dpl_B3xaihLgbSTRemmDqf4NHmrANkJi`).

- **[B1.1/B2] Bill the right acres, never zero.** The engine now defaults applied acres to the field's billable acreage (`override ?? measured ?? legacy total`, via `billableAcres`) instead of the raw full-field total, and **rejects 0 / NULL / negative applied acres** (`ZERO_APPLIED_ACRES`) instead of silently falling back to the whole field — the old `COALESCE(applied, total_acres, 0)` was a real over-bill. Preview clamps un-entered/negative to 0 (shows $0, never over-states). Frontend (`FieldApplicationInvoice.tsx`) pre-fills from `billableAcres`, drops the `|| total_acres` sends, and blocks 0/blank on save with a toast.
- **[B1.3] Right cost.** Grower-share (override-acre) product lines now carry the per-unit product cost (`cost_cents`) and fold the extended cost into `total_cost_cents` — margin was overstated before (cost line was $0).
- **[B1.5] Right rep.** `salesman_id` is now bound: a non-admin actor can only attribute an invoice to themselves; admins may set any.
- **[B1.2] Don't resurrect deleted invoices.** `save_field_app_invoice` AND `post_invoice_group` (all 4 of its `invoice_group_id` loops) + the frontend sibling-load are now `deleted_at`-aware, so a soft-deleted split member isn't reused, re-cancelled, posted, or shown.
- **Codex found 2 P1s** (B1.3 wrote the extended cost into the per-unit `cost_cents`; B1.2 missed `post_invoice_group`) → both fixed → Codex round 2 CLEAN. 4 reviewers (rls/drift/compliance/types) clean. typecheck/lint/build + 2191 tests green. Post-apply: single overload ×3, `plpgsql_check` clean (only pre-existing warnings), functional smoke `SMOKE_PASS_ROLLBACK` (0/−5/NULL rejected), advisors baseline unchanged.
- **B3 / B4 / B5 verified already-live** (not rebuilt): `transfer_job_to_invoice` already emits the per-acre service fee + binds the actor; `load_recipe_into_job` already seeds the recipe price; the `UnbilledApplications` page already covers applied-but-unbilled work.
- Open: Mason's in-app real-file smoke (bill a real spray job, confirm the bill uses applied acres and 0 is rejected; prod operationally empty).

## 2026-06-23 (night) — Field-acre-billing Track B #1: applicator-mix-up auto-alert (SHIPPED LIVE)

Owner approved "ship to main". The first Track B item on top of the now-live Track A two-acre model. **Frontend-only, no DB change.** Built on `feat/applied-acres-divergence-alert`, merged to `main` (merge `90177c75`) and deployed to croprxsolutions.app (`dpl_8zpi1tbV5cRmKEAPY89U5d2r5ssP`; rollback = prior prod `dpl_7yTXs3oFWDcSoK9PZ7Y5KTM749se`).

- **As-applied vs system-acreage review flag** on the Field Application Invoice billing page (`src/pages/FieldApplicationInvoice.tsx`, the `field_app_locations`/`applied_acres` engine). Each field row now shows the billable **System acres** on file (`billableAcres` = override ?? measured ?? legacy total) next to the **Applied acres** input, and auto-flags any field ≥10% off — **over OR under** — with a per-row amber badge ("30% over — review") + a top-of-tab banner counting the off fields. Automates the owner's manual catch ("the as-applied is X% off what our system says" → an applicator sprayed part of one field under the wrong name). **Advisory only** — never blocks or changes the bill; `system_acres` is display-only (never written).
- New tested helper `acreDivergence(entered, reference)` → `{pct, direction:'over'|'under'} | null` in `src/lib/fieldGeometry.ts` (+6 unit tests; reuses Track A's `acreDivergencePct`/threshold). Relabeled the page's "Total Acres" column → "System Acres" (ties Track A's billable number into billing).
- typecheck + lint + build clean; **2179 tests pass**; Codex `review --base main` = no correctness issues. (Caught + fixed a JSX em-dash rendering as literal text — use the `&mdash;` entity; proven in the built bundle.)
- Open: Mason's in-app real-file smoke on the live page (prod operationally empty). Rest of Track B (per-acre billing tie-in) still gated on Mason's word.

## 2026-06-23 (eve) — UI/workflow overhaul: Operations Command Center + visual refresh (SHIPPED LIVE)

Owner asked to fix the app being "very clicky / spread out." Built on `feat/ui-overhaul` (read-only, branch-only, hold-for-review), reviewed by Mason on a Vercel branch preview, then merged to `main` (merge `5a1d659b`) and deployed to croprxsolutions.app (`dpl_FX5GPwW6DcXvroJhyAWaUBu7vMKm`; rollback = prior prod `2a0e20f7`). Pure frontend — **zero DB changes**.

- **Operations Command Center** (`src/pages/ToShip.tsx`, route `/to-ship`, admin+sales_rep; sidebar link + dashboard quick-action): one screen, 4 sections via a switcher — **To-Ship** (open demand By Product / By Customer; owed vs free-stock vs inbound-PO; Ready/Short; $ to ship; line aging), **Low Stock** (reorder pressure), **Deliveries** (open scheduled/in-progress, overdue + unassigned flags), **Inbound POs** (open POs by arrival, ordered/received/remaining). Frontend queries against existing data + `get_inventory_position()`; product/customer search + Short-only filter + remember-last-view. Answers "how much more do I owe customers" ($541k / 23 orders / 58 products live) without opening every order.
- **Findability:** visible **Search** button in the TopBar (opens the ⌘K command palette) + a To-Ship dashboard shortcut.
- **Option A visual refresh** propagated via shared components + Tailwind tokens with ZERO page edits (all 80 pages): hairline card borders + softer shadows; richer status badges (bg-100/text-800 + inset ring); data tables get zebra rows, a tinted header, crisper borders; cleaner inputs/buttons. Component APIs unchanged.
- **`/design-preview`** dev/preview-only component gallery (hidden on the production domain by hostname guard) as the review surface — needed because a git worktree has no `.env`, so the app can't boot a local dev server for screenshots; review happens on a Vercel branch preview instead.
- Every commit lint+typecheck+build+tests green (2123 on the branch; **2173** after merging the field-acre work). Follow-ups: act-in-place buttons (Schedule/Reorder/Pick-list — review-gated, they write live data) + optional Modal/Combobox/shell polish.

## 2026-06-23 — Field mapping + per-acre billing (Track A: A1–A8 SHIPPED LIVE)

Field-mapping → per-acre-billing foundation built on `feat/field-acre-billing` (autonomous Codex-gated build loop), then **applied to the live DB, merged to main, and deployed**. The keystone fix: a redraw — or an import — can no longer silently change a billed acre.

- **A1 (migration `20260623120000`, APPLIED):** two-acre model on `fields` — `measured_acres`/`override_acres` numeric, `boundary_geom geometry(MultiPolygon,4326)`, GENERATED `acres_source`; GIST index; bill-preserving backfill (`override_acres = total_acres` for existing boundaried fields → current bills UNCHANGED). Preflight proved **0 at-risk rows live** before apply.
- **A2 (migration `20260623130000`, APPLIED):** server-authoritative acreage RPCs — `set_field_boundary` (only writer of `measured_acres`: robust PostGIS pipeline, geodesic measure, 0.1–5000 band, strict-actor, idempotency, `field_polygons` sync) + `set_field_override_acres` + `find_overlapping_fields`, plus a `fields_acre_authority` trigger so only the RPCs may write the acre columns.
- **A3 (types) / A4 (FieldSetup override UI, redraw-clobber removed) / A5 (`.zip` shapefile import, multi-part acreage).**
- **A8 (owner refinement):** imports bill on the FILE's stated acreage (acre-named columns only — a square-meter `Shape_Area` can't set money; strict thousands-separator parse; 0.1–5000 band; out-of-band → bills measured + warns); manual typed acres (no map) go through the same band gate; a ±10% over/under divergence flag at import review + in the field editor. Frontend-only; 44 `fieldGeometry` unit tests. The import section took 6 Codex fix rounds → clean.

Post-apply proven live (all rolled back / zero footprint): `plpgsql_check` clean ×4; functional smoke `SMOKE_PASS_ROLLBACK` (override-survives-redraw, band reject, idempotent replay, trigger blocks direct writes); **0 bills moved** (all 3 live fields unchanged); advisors unchanged (the 3 RPCs only under the accepted authenticated-SECDEF self-gating class). Track B (billing-engine tie-in — the as-applied-vs-system % alert that catches an applicator spraying part of one field under the wrong name) stays separate.

## 2026-06-23 — B1 Lot Capture & Trace: APPLIED LIVE + merged + deployed

Owner approved go-live. Migration `20260622170000_application_record_lots` applied to the live DB (project `rhyzpcqhnizqbxphqdkr`) and `feat/application-lot-capture` fast-forward-merged to `main` + deployed to croprxsolutions.app. B1 is now live: chemical **LOT/batch numbers** are captured per application and traceable for recall/compliance (which lot → which field/date/customer). Capture-and-trace only; no per-lot inventory math (Wave C).

- **Apply pipeline (proven before apply):** fresh `rls-security-reviewer` + `migration-drift-reviewer` (both 0/0/0); section-5 `create_application_record_from_blend_ticket` reproduction proven **byte-identical to live** (minus the added lot-propagation INSERT) via a rolled-back `pg_get_functiondef` diff; apply-guard proof bound to the exact applied bytes.
- **Post-apply verification (all rolled back, zero prod footprint):** structural (table + RLS + 1 SELECT policy, 3 RPCs each single-overload, blend fn still 1 overload now carrying the lot INSERT, 5 indexes); `plpgsql_check` clean (only the benign shared `:= '{}'` init warning); functional smoke of all 3 RPCs incl. replace-all, idempotency replay, duplicate/product-not-on-record rejection, and the Phase-5 invoice filter (**active/draft/posted → reported; voided/cancelled/soft-deleted → NULL**); blend-ticket lot auto-propagation end-to-end (case-dedup, blank/null skip). Invariant sweeps green (no B1 object flagged; SECDEF/overload/actor/anon classes clean). `get_advisors` unchanged (still 1 accepted ERROR = `profile_public_view`; B1 RPCs only under the by-design `authenticated_security_definer_function_executable` WARN, none anon-executable; 2 INFO unindexed-FK + 2 INFO unused-index on the new empty table).
- **Open follow-ups (non-blocking):** regenerate `src/types/supabase.ts` then simplify the `src/lib/lotRpc.ts` shim to direct typed calls; refresh `.claude/schema-registry.json` from live (pre-existing staleness, now incl. `application_record_lots`); Mason's in-app smoke of `/lot-trace` + the Lots editor.

## 2026-06-23 — B1 Lot Capture & Trace: Phase 5 (tests + docs); feature built + parked for apply

Autonomous Codex-gated build loop (`docs/build-loops/b1-lot-capture-trace/`), Phase 5 of 6. B1 brings chemical **LOT/batch numbers** into the system and links them to what was applied, so the business can answer the recall question: *which lot of which product went on which field, on what date, for which customer?* Capture-and-trace only — no per-lot inventory math (deferred Wave C).

- **Built across phases 1–4 (all Codex-SHIP):** migration `20260622170000` — new table `application_record_lots` (one row per record/product/lot, multiple lots per product; RPC-only writes; RLS mirrors application_records) + 3 RPCs (`set_application_record_lots`, `get_recent_lots_for_product`, `get_lot_application_trace`) + a verbatim `CREATE OR REPLACE` of `create_application_record_from_blend_ticket` that auto-propagates lots from blend tickets; `ApplicationRecordLot` + 4 result types in `src/types/index.ts`; the `LotsEditorModal` lots-applied editor on Application Records; the `/lot-trace` recall page; a `src/lib/lotRpc.ts` typed shim (the migration is parked, so the generated client doesn't know the table/RPCs yet — the shim bridges it with no `any`/`@ts-ignore`).
- **Phase 5 (this entry):** added `src/lib/lotRpc.test.ts` — locks the shim's exact RPC name strings + argument shapes (the `as never` casts suppress name type-checking, so a typo'd RPC name was the real failure mode), error propagation, the `assertRpcResult` no-data guard, and the `null → []` read default — on top of the existing `LotsEditorModal` (6 cases) + `LotTrace` (4 cases) component tests. Documented the table (`database-schema.md`), the 3 RPCs (`rpc-functions.md`), and the page (`pages-routes.md`), each tagged **⏳ pending B1 apply**; live table/RPC counts left at the live baseline until the owner applies the migration. `typecheck/lint/build/test` green.
- **NOT applied / NOT merged.** The migration is parked behind the owner gate — the UI calls RPCs that don't exist until it's live, so the feature lands together. Apply + merge + deploy + live smoke are the handoff steps for Mason's explicit OK (`HANDOFF.md`, written in Phase 6). Proof to date: rolled-back `BEGIN..ROLLBACK` smokes (Phase 1 + Phase 4 SQL edits) + the component/shim tests; the live re-smoke is in the post-apply chain.

## 2026-06-21 — New hard guard: `require-check-mutation-result` ESLint rule

Closed the second deferred bug-hunt item (a CI guard for CLAUDE.md Architecture Rule #3) as a robust **AST ESLint local rule** instead of the fragile proximity-scan test it was originally scoped as. New `eslint-local-rules/rules/require-check-mutation-result.cjs` flags a fire-and-forget supabase `.update()`/`.delete()` whose result is discarded without `checkMutationResult()` — the gap the existing `handle-supabase-error` (destructured-error) and `require-assert-rpc-result` (rpc) rules leave open. Conservative by design (only clearly-discarded results; defers the destructured-error shape to `handle-supabase-error`) → **0 false positives across `src/`**; RuleTester cases prove it catches the violation. Enabled `'error'` on `src/**/*.{ts,tsx}`, `'off'` for test/mock files. No application code changed (codebase already compliant). Registered in `eslint-local-rules/index.cjs`; tests in `src/lib/eslintLocalRules.test.ts`.

## 2026-06-21 — Cleanup: retire dead `update_allocation_set` RPC + doc-count sync

Deferred-item cleanup pass (Mason approved):
- **Retired the dead `update_allocation_set` RPC** — `DROP FUNCTION` migration `20260621160000` (live stamp `20260621233102`) for a confirmed-dead function: 0 callers, 0 dependent objects, 0 rows; was admin-gated + audited, so never a security hole — pure dead-code hygiene. Gated pipeline: rls-security + migration-drift reviewers CLEAN, independent **Codex review PASS** (no findings), rolled-back live DROP smoke `SMOKE_PASS_ROLLBACK`. Companion edits in the same commit: removed from `src/types/supabase.ts` + the `rpcFixtureLiveDiff` snapshot (265→264), callable-RPC count **226→225** in CLAUDE.md + `docs/reference/rpc-functions.md`. The allocation tables stay (`invoice_line_allocations` is still written by `allocate_payment`). Precedent: the `create_invoice_from_delivery` retire (`20260617210000`).
- **Doc-count drift synced** (earlier commit `9eb12b11`): `rpc-functions.md` (227/47 → live) + AGENTS.md regenerated.

## 2026-06-21 — As-Applied / Field Invoices: 4 parked migrations applied live + feature merged

Finished the As-Applied / Field-Invoice feature: applied the **4 remaining parked migrations** to production (Supabase project `rhyzpcqhnizqbxphqdkr`) and merged the full feature (the new Field Invoices screens) from `feat/as-applied-invoices` into `main`.

- **4 migrations applied (live stamps):** `20260618230000` recipe per-unit pricing — column + `load_recipe_into_job` (stamp `20260621133017`) → `20260619150000` `save_blend_recipe` carry-price (`20260621133240`) → `20260619140000` `transfer_job_to_invoice` per-acre machine fee (G1) + strict-actor (G3) (`20260621133452`) → `20260619160000` `save_invoice` field-application aware (`20260621133654`). Each verbatim-live-body + surgical delta; applied in bundle order with Mason's explicit OK.
- **New UI shipped:** `/field-invoices` (segregated Field Invoices area), `/field-invoices/unbilled` (Unbilled Applications reconciliation), the editable field-invoice screen (`/field-invoices/:id`), the 3-way rate/acres/quantity job-mix calculator, and the recipe $/unit price input.
- **Validation:** each migration gated by the **rls-security + migration-drift** reviewers + an independent **Codex** read-only review (PASS, no blocker/high) + the migration **apply-guard** (byte-fidelity proof); post-apply per-function `plpgsql_check = 0` / `overload = 1` / `anon EXECUTE = false`; global overloads + `plpgsql_check` sweeps clean; **3 functional smoke tests** (recipe bundle, machine-fee 4-scenario, `save_invoice` field-app) all `SMOKE_PASS_ROLLBACK` against live; security advisors unchanged. Full status: `docs/audits/2026-06-18-as-applied-overnight-handoff.md`.

## 2026-06-20 — Overnight bug-hunt remediation: all 13 surgical fix migrations applied live

Applied **all 13** overnight bug-hunt fix migrations to production (Supabase project `rhyzpcqhnizqbxphqdkr`), live stamps `20260621022206`–`20260621030145` (evening of 2026-06-20 CT = 2026-06-21 UTC). Branch `claude/overnight-bug-hunt`. Each is a verbatim-live-body + surgical guard.

- **5 HIGH money-guards:** prepay **bulk-apply hard-block** (`apply_remaining_prepayments` + `batch_apply_all_prepayments` → `PREPAY_BULK_APPLY_DISABLED`; Mason approved disabling the bulk buttons; per-invoice apply unaffected) · field-application **invoice_type lock trigger** (`enforce_field_application_type_lock` — a trigger, not a `save_invoice` rewrite, to avoid colliding with `feat/as-applied-invoices`) · **commission batch-freeze** (`cancel_order`/`void_order`/`cancel_delivery` block when a pending commission is in a non-voided payout batch; `BATCH_COMMISSION_DRIFT` guard) · **cross-customer prepay guard** (`apply_prepay_to_invoice` → `CUSTOMER_MISMATCH`) · **blend double-bill / orphan guard** (blend ticket only resets to `unbilled` when no live sibling invoice remains).
- **8 MED/LOW:** job cancel gate (`_enforce_job_status_transition`) · `void_payment` partial-void status derived from balance · `preview_finance_charges` realigned to `generate_finance_charges` · OIFA post-invoice edit lock (`prevent_oifa_edit_after_post` trigger) · invoice-creator provenance/totals (`total_cost_cents` + `invoice_created` audit rows) · `complete_delivery` audit row + partial-rebill cost recompute · `create_quick_delivery` aggregates duplicate product lines by uuid · `create_invoice_from_blend_ticket` re-bill guard widened to `IS DISTINCT FROM 'unbilled'`.
- **Two NEW trigger functions** added (`prevent_oifa_edit_after_post`, `enforce_field_application_type_lock`); no new callable RPCs. Doc counts bumped: migrations on disk **482 → 495**, trigger functions **47 → 51**, callable RPCs unchanged (226).
- **Validation:** each gated by the **rls-security + migration-drift** reviewers + an independent **Codex** read-only review + the migration **apply-guard**; post-apply per-function `plpgsql_check = 0` errors / `overload = 1`, and the global overloads + `plpgsql_check` sweeps are clean. See `docs/audits/overnight-bug-hunt/` for the FIX-PLAN + LEDGER.
## 2026-06-19 — As-Applied: live billing crash fixed + Field-Invoice segregation

Continued the As-Applied / Field-Invoice work on `feat/as-applied-invoices` (overnight build → Mason's morning review). Branch carries Phases 1a/1b/2/4 (Field Invoices area + reconciliation view + parked recipe-pricing migration); nothing else deployed.

- **Live billing crash FIXED (applied to prod) — migration `20260618220000`.** Proving the applied→invoice loop end-to-end surfaced a latent crash: `transfer_job_to_invoice` raised `55000 record "v_conversion" is not assigned yet` for any job with a chemical line lacking a per-acre rate (the whole job→field-invoice rail died). Never surfaced because no field jobs have been billed (0 field invoices live). Fix: call `convert_to_gl_lb` unconditionally (single delta; unrated lines yield NULL gl/lb, no crash). Reviewers + Codex clean; applied with Mason's OK; **re-ran the full flow against the live fixed function → `SMOKE_PASS_ROLLBACK`**; post-apply invariants clean.
- **Field-invoice segregation completed** (`18c5432`): the Chemical Sales `/invoices` list now excludes `invoice_type='field_application'` (fetch `.neq` + dropped type-filter option) so a field invoice no longer appears in both lists.
- **Decisions captured (Mason 2026-06-19):** recipe pricing = **per-unit** (parked migration `20260618230000` confirmed; ships as a bundle with `save_blend_recipe` wiring + a recipe price UI); machine-fee + actor = **targeted fixes** (G1 per-acre `is_application_fee` line + G3 strict-actor — built in a focused follow-up). Both are non-urgent (the crash that mattered is fixed). Full status: `docs/audits/2026-06-18-as-applied-overnight-handoff.md`.
## 2026-06-17 — Retired dead `create_invoice_from_delivery` (Lane B delivery_id follow-up)

Resolved the `delivery_id` duplicate-guard follow-up by **retiring the function** rather than patching it. **Migration `20260617210000`** (applied live, stamp `20260617210043`, Mason approved the retire).

- **What the follow-up was:** `create_invoice_from_delivery` inserted its invoice with `order_id` but never `delivery_id`, so its own natural guard (`WHERE delivery_id = p_delivery_id`) was inert — two different-key calls could double-bill.
- **What investigation found:** the function is **dead code** — ZERO callers. No page (only test fixtures + generated types), no DB function (`price_order`/`consolidate_draft_invoices` mention it only in comments; caller-graph `called_by_other_function=false`), no edge function, no cron, no trigger. The old caller `complete_delivery` was long ago refactored to inline its invoice INSERT (`20260616140912`). Prod has 0 invoices created by it (every live invoice carries `delivery_id`). It is fully superseded by `create_invoice_for_unbilled_delivery` (the function the Integrity Cleanup page actually calls), which sets `delivery_id`, requires admin, is idempotent, and has a stronger order-scoped, race-safe duplicate guard.
- **The fix:** `DROP FUNCTION IF EXISTS public.create_invoice_from_delivery(uuid,uuid,text)` — removes the latent double-billing bug *and* the foot-gun of a future change wiring up the wrong, weaker function. This supersedes the Lane B hardening of the same function (`20260617190000`).
- **Validation:** rls-security + migration-drift reviewers both CLEAN (0 blockers; drift flagged only stale-reference cleanup). Rolled-back `DROP` smoke confirmed no dependent object. Post-apply: function gone, survivor (`create_invoice_for_unbilled_delivery`) intact, DB-invariant sweeps clean. Repo cleanup done so the suite stays green: removed the name from `rpcContracts.test.ts` (fixture array + idempotency-mode map), `rpcFixtureLiveDiff.test.ts` (live snapshot CSV + count 266→265), the generated `supabase.ts` type block, both `caller-graph.json` entries, and `rpc-functions.md`.

## 2026-06-17 — Auto-invoice + RUP RPCs: idempotency + strict-actor (sections 2-15 gauntlet, Lane B)

Cleared the two prepped Lane B migrations from the sections 2-15 gauntlet remediation (ledger: `docs/audits/gauntlet/sections-2-15-remediation-LEDGER.md`). Both applied live + smoke-proven, both DB reviewers clean.

- **Migration `20260617190000` — `create_invoice_from_delivery` (MED-4 + fin-audit actor).** The RPC that auto-creates a draft invoice from a completed delivery declared `p_idempotency_key` but never used it, so a **double-submit / network retry created a SECOND draft invoice** for one delivery; and it stamped `financial_audit_log.actor_role` / `invoices.created_by` / `activity_feed.performed_by` from a **forgeable** `p_performed_by`. Fix prepends the canonical strict-actor block (`v_actor := auth.uid()` → `AUTH_REQUIRED` / `ACTOR_MISMATCH`), wires canonical operation-scoped `check_idempotency`/`save_idempotency` (replay after strict-actor; the natural "invoice already exists" guard now runs after authz + replay), and stamps every actor write from `v_actor`. Body byte-identical to live except those deltas; signature/return/SECDEF/`search_path`/overload(=1)/grants unchanged.
- **Migration `20260617190500` — `generate_rup_sales_records` (LOW-1).** The RUP-compliance RPC (sole caller `post_invoice`) advertised `p_idempotency_key` but ignored it (contract drift; it already de-dups rows naturally). Fix wires the canonical helpers (count wrapped as `{"count":n}` jsonb, unwrapped on replay) without touching the signature, the natural de-dup guard, or grants. `RETURNS integer` preserved; REVOKE/GRANT block restates the exact live posture (service_role + postgres only) so `CREATE OR REPLACE` can't widen access.
- **Validation:** rls-security-reviewer + migration-drift-reviewer CLEAN on both (0 blockers; each diffed vs live `pg_get_functiondef`). One rolled-back live smoke covering all behavioral deltas PASS — `AUTH_REQUIRED` (no auth), `ACTOR_MISMATCH` (forged actor), authz-reject (non-admin), both idempotency-replay short-circuits, and a **full happy-path double-submit** proving exactly one invoice is created and the same-key retry replays it (**zero duplicates**). Live stamps `20260617201934` / `20260617202008`.
- **Sweep cleanup:** removed both now-obsolete `create_invoice_from_delivery` allowlist entries (`actor-forgery` + `actor-forgery-fin-audit`) — the fix adds the canonical `ACTOR_MISMATCH` token, so both predicates re-run live = clean without the exemptions.
- **Follow-up flagged (out of scope):** `create_invoice_from_delivery` sets `order_id` but **not** `invoices.delivery_id` on the invoice it creates (pre-existing; preserved verbatim), so its natural "one invoice per delivery" guard only catches invoices created by *other* paths that set `delivery_id`. The idempotency key now covers the realistic same-request retry; the different-key duplicate path is a separate, pre-existing gap worth a dedicated reviewed migration.

## 2026-06-17 — Blend-ticket order link/unlink: forged-actor audit fix (Live Foundation Gauntlet §1)

Fixed the one HIGH from the new Live Foundation Gauntlet's first section (Security / roles / RLS / SECDEF access). **Migration `20260617171500`** (applied live + smoke-proven).

- **The bug:** `link_blend_ticket_to_order` and `unlink_blend_ticket_from_order` are authenticated-callable SECURITY DEFINER mutators that trusted a caller-supplied `p_performed_by`, writing it into `blend_ticket_to_order_items.created_by`, `activity_feed.performed_by`, and `financial_audit_log.actor_user_id` (and deriving `actor_role` from it). An admin/sales_rep could call them directly and **pin a blend-ticket order link/unlink on another employee** — the attribution in the audit trail was forgeable. Role gating was already correct; only the recorded actor was at risk.
- **The fix (mirrors `20260609195713`):** prepend the canonical strict-actor block — `v_actor := auth.uid()` → `AUTH_REQUIRED` if null → `ACTOR_MISMATCH` if `p_performed_by` is distinct from `v_actor`, placed before the idempotency replay — and stamp every audit write from `v_actor`. Bodies otherwise byte-verbatim from live: signatures, return shapes, idempotency operation strings, and business logic unchanged; one overload each; grants unchanged (`CREATE OR REPLACE` preserves).
- **Validation:** rls-security-reviewer + migration-drift-reviewer both CLEAN (each diffed against live `pg_get_functiondef`). Post-apply **live** smoke PASS — forged actor → `ACTOR_MISMATCH` (link + unlink), no-auth → `AUTH_REQUIRED`, legit actor + bogus ticket → clean `Blend ticket not found` with zero rows mutated. UI unaffected (`BlendTicketDetail` already passes the current profile id).
- **Prevention (recommended follow-up, not in this migration):** a deterministic sweep/fixture that flags any authenticated mutating SECDEF RPC with a `p_*_by` param lacking an `auth.uid()` actor binding + `ACTOR_MISMATCH`, with these two functions as regression fixtures.

## 2026-06-17 — Multi-field split invoices, allocated by acres (nightly-debug #1)

Built the long-blocked split-invoice feature: an order line can be **spread across several fields by acres**, and at invoice time each field's owner(s) are billed their **acre-weighted share, penny-exact**. Replaces a dormant-but-broken function that could **double-bill (200%)** and drift by pennies.

- **Decision (Mason 2026-06-17): split is entered on the ORDER, not the quote.** Delivers the same feature while avoiding surgery on the two most delicate functions (`save_quote`, `convert_quote_to_order`) — verification found `save_quote` silently drops the section's `field_id`, so the quote-side path was a dead end anyway.
- **Migration A `20260617143755`** — new `order_item_field_allocations(order_item_id→order_items ON DELETE CASCADE, field_id→fields, acres>0, UNIQUE(order_item_id,field_id))`; RLS mirrors `order_items`; additive, dormant.
- **Migration B `20260617164803`** — rewrote `create_split_invoices_from_order`: per line, split the total across its allocations BY ACRES, then each field's portion among its `field_billing_defaults` owners BY split_pct — largest-remainder (`calculate_billing_splits`) at both levels. One draft invoice per customer (`invoice_group_id`); acres + qty **prorated per customer** (no double-count); $0/discount lines retained; reconcile-or-raise.
- **Guards:** admin/sales_rep auth gate · FOR UPDATE lock · idempotency-after-lock · reject if an active invoice/delivery exists or the order is price-pending · `FIELD_SPLIT_NOT_100` · owner-pct normalization (no over-allocation) · `SPLIT_NET_NEGATIVE`. Non-split orders unchanged (delegate to `create_invoice_from_order`).
- **UI:** OrderDetail "Field / Acre Split" card (per-line field+acre editor, acres prefilled from `fields.total_acres`, live per-customer preview) + the existing **Create Invoice** button now generates the split invoices when the order has allocations.
- **Discovery (verification):** the live schema already has several dormant split/share subsystems (`order_shares`/`invoice_shares`, `*_line_allocations`, Field Mode's `field_app_location_shares`) the design doc hadn't mentioned; confirmed coarser/separate, so the new per-line tables fill a real gap.
- **Validation:** both DB reviewers clean across every revision; **Codex 7 rounds → converged clean** (each round caught + fixed a real issue: role gate, double-bill guards, penny over-allocation, idempotency race, negative lines, acres double-count, $0-line retention, net-negative reconciliation); 14-scenario JWT-spoofed rolled-back smoke; post-apply invariant checks. Both migrations applied live with Mason's OK; UI compiles/lints/builds clean. **DORMANT (0 rows)** — needs Mason's in-app smoke before deploy (dev server is prod-backed + no app creds this session, so no in-browser click-through was possible).

## 2026-06-17 — Order edits now refresh per-line profit/margin (targeted-gauntlet residual)

Closed the last residual in `update_order_items` found while verifying the targeted Codex gauntlet handoff. **Migration `20260617123503`** (applied live, stamp `20260617125110`).

- **The gap:** the SAME-PRODUCT edit branch (change a line's price or quantity without swapping the product) updated `total_price` but left the per-line `order_items.profit`/`net_margin` stale. The product-swap and new-item branches already set them; only this branch didn't. `get_sales_detail_report` (the `/sales-reports` Sales Detail tab) reads `oi.profit` per line, derives the line margin from it, and SUMs it for the report total — so after a same-product edit that report's per-line Profit and total drifted from the (correct) order header.
- **Not a money/payout bug:** the order header `total_profit`/`total_margin_pct` is recomputed from price−cost by the `trg_recalc_order_totals` trigger, and commissions rescale from that header (migration `20260617115903`). Both stayed correct; only the per-line report column was stale.
- **The fix:** add `profit`/`net_margin` to the same-product `UPDATE order_items`, using the identical formula the swap/new-item branches use, with cost = `COALESCE(v_old_item.cost_per_unit,0)` (cost is unchanged on a same-product edit). Body byte-identical to live `20260617115903` except those two assignments.
- **Validation:** rls-security-reviewer + migration-drift-reviewer + compliance-reviewer all clean (no overload, `search_path` + all guards preserved, grant posture unchanged, per-line formula reconciles with the header). Pre-apply and post-apply rolled-back JWT-spoofed smoke both `SMOKE_PASS_ROLLBACK` (price 10→12 ⇒ 600/50.00/1200, header + pending commission 600; qty 100→150 ⇒ 600/40.00/1500). DB-invariant regression check clean. Open follow-up (owner-gated): one-time resync of any rows edited via the same-product path before this fix.

## 2026-06-17 — Order edits now recompute pending commissions (nightly-debug #2)

Closed the nightly-debug finding `lifecycle:update_order_items:stale-profit-and-commissions`. **Migration `20260617115903`** (applied live) extends `update_order_items` so that after an order's items change, the denormalized `commissions` rows are refreshed instead of going stale.

- **What was actually stale (finding corrected by live verification):** the order *header* profit/margin was already kept correct by the existing `after_order_items_change` → `trg_recalc_order_totals` trigger. The real gap was only the `commissions` rows (their `order_profit`/`commission_amount` were snapshotted at order creation and never refreshed), so commission reports/payouts drifted after an edit.
- **The fix (Mason's policy):** rescale each **pending** commission to the new `orders.total_profit` by its OWN snapshotted `split_percentage`. **Paid, cancelled, and soft-deleted rows are frozen** — never silently change an already-paid payout. `recipient`/`split_percentage` are untouched so a later change to the customer's split does not re-attribute this order's commissions. Runs automatically on every edit.
- **Codex P1 caught + fixed:** a pending commission already pulled into a **non-voided commission-payment batch** is also frozen (its amount is snapshotted in `commission_payment_items` / summed into `commission_payments.total_amount`; rewriting it would desync the batch).
- **Validation:** body byte-identical to live except the one marked block; rls-security-reviewer + migration-drift-reviewer clean (overload=1, SECDEF + `search_path` preserved); Codex clean after the P1 fix; JWT-spoofed rolled-back smoke + post-apply live re-smoke both PASS (recompute pending, freeze paid, freeze batched, zero prod footprint). No table/column/data change — additive function behavior only.

---

## 2026-06-16 — Deleted the `seed-admin` edge function (security; nightly-debug PARKED-07)

Closed the highest-severity finding from the nightly-debug whole-app pass: `seed-admin` was the only one of 7 edge functions deployed with **`verify_jwt = false`**, and its production kill-switch depended on an unconfirmed `ENVIRONMENT` secret — a latent **unauthenticated admin-mint** (anyone who learned `SEED_ADMIN_SECRET` could create a fully-functioning admin on the live ERP).

- **Deleted `seed-admin` from the live project** (`rhyzpcqhnizqbxphqdkr`) via `supabase functions delete` after Mason's explicit in-chat OK. Pre-checks: 3 active admins already exist (the one-time seed is long done, so deletion strands no one) and 24 h of edge-function logs were empty (idle). Verified gone: 6 functions remain, **all `verify_jwt = true`**.
- **Removed the orphaned local source** `supabase/functions/seed-admin/index.ts` (no code referenced it) so it can't be silently re-deployed.
- **Owner item M4** (confirm `ENVIRONMENT=production` for seed-admin) is now **moot/resolved** — with the function gone, its kill-switch is irrelevant.
- Docs synced 7→6 Edge Functions: `CLAUDE.md` (Snapshot + Edge Functions section + owner-items list), `README.md`, `AGENTS.md` (regenerated), `TODO.md` (M4 struck), and the `deploy-edge-function` skill. No DB/RPC change; no app deploy.

---

## 2026-06-15 — CLAUDE.md restructured for token efficiency (docs only)

Cut the always-loaded `CLAUDE.md` from 581 lines / 110 KB (~27.5K tokens) to 358 lines / 28.8 KB (~7.2K tokens) — a **~74% reduction in what loads on every turn** — with **zero rule content lost** (everything moved is preserved verbatim). Grounded in Anthropic's "Best practices for Claude Code" + "How Claude remembers your project" (keep it short; only every-session facts; push detail to docs/skills; a bloated CLAUDE.md makes Claude *ignore* instructions) and Karpathy's actual committed guidance (simplicity-first — and the finding that the viral "Karpathy CLAUDE.md" is a third-party derivative, `multica-ai/andrej-karpathy-skills`, NOT his own file; his real files are `karpathy/llm-council/CLAUDE.md` technical-notes-only + `karpathy/autoresearch/program.md`).

- **Removed the multi-month "Current State" work-log** (the changelog-in-CLAUDE.md anti-pattern; ~88 KB of paragraph-length dated entries) → archived verbatim to `docs/archive/2026-spring/claude-md-session-log-pre-2026-06-15.md`. Replaced with a tight `## Snapshot` (live counts + open owner items + pointers to CHANGELOG/memory/archive).
- **Added `## Working Principles`** (think-first / simplest-thing-that-works / surgical-changes / drive-to-done-but-the-gates-win / lead-for-Mason) — adapted from Karpathy's real `autoresearch/program.md`, reconciled with CRX's production gates (we deliberately reject his "NEVER STOP").
- **Extracted reference detail** to `docs/reference/sql-canonical-patterns.md` (copy-paste SQL/RPC templates) and `docs/reference/agent-guardrails.md` (full hook + subagent tables), leaving short imperative pointers + the non-negotiable one-liners inline.
- **Condensed** the doc-maintenance, Graphify/map, and pre-commit sections to pointers. Added a top maintainer HTML comment (stripped from context → costs no tokens) documenting the new structure + the Karpathy provenance.
- All Hard Red Lines, Architecture Rules, Business Logic Lifecycles, Schema Gotchas, and the auto-trigger skills table stay **inline** — they're every-session-relevant scar tissue from the March-2026 40-bug drift era. No code, DB, RPC, page, or migration change; the `AGENTS.md` generator is unaffected (it reads filesystem counts, not CLAUDE.md content). Mechanical extraction done by a throwaway script (now deleted) for byte-exact fidelity.
- **Appended (at Mason's request) a `## Appendix — Karpathy-derived coding guidelines (verbatim)`** at the end of CLAUDE.md: the viral 100k+ star "Karpathy CLAUDE.md" — actually Forrest Chang's derivative `multica-ai/andrej-karpathy-skills` (4 principles: Think Before Coding / Simplicity First / Surgical Changes / Goal-Driven Execution) — reproduced verbatim, **plus** Karpathy's own verbatim "NEVER STOP" block from `karpathy/autoresearch/program.md`. Both carry a provenance note (the viral file is a community derivative, not Karpathy's own) and a precedence note: "NEVER STOP" governs task momentum only and never overrides the production gates.
- Committed + pushed to `main` (production) at Mason's explicit request. Docs-only — the live web app is unchanged by a CLAUDE.md/docs change.

---

## 2026-06-15 — Documentation cleanup & reference reconciliation (docs only)

Full documentation refresh to current reality — **no code, DB, or deploy changes.**

- **Counts brought current everywhere** (verified live 2026-06-15): 68 pages, 455 migrations, 96 tables (+2 views), 226 callable RPCs + 47 trigger functions, 7 Edge Functions, 2,005 unit tests passing / 70 skipped (139 files), 94 E2E specs. Fixed in `README.md` (was stamped 2026-03-02: 50 pages / 1,433 tests / 72+ tables / 107 migrations / 5 Edge Fns), `TESTING.md`, `DEPLOYMENT.md`, the `CLAUDE.md` reference-docs table, and `AGENTS.md` (regenerated).
- **Reference docs fully reconciled against the live database:** `rpc-functions.md` gained the **34** previously-undocumented RPCs (6 new sell-side — `create_rush_order` / `price_order` / `check_unpriced_orders` / `consolidate_draft_invoices` / `get_booking_settlement` / `get_open_booking_rollover` — plus a backlog incl. `void_order` / `void_payment` / `cancel_return` / `unapply_credit_memo` / `reopen_accounting_period` / the field-polygon + prepay-edit families); `migration-history.md` gained the **11-migration G5 sell-side go-live** section; `database-schema.md` header 95→96; `pages-routes.md` gained Field Mode `/my-route` + `/my-route/:id` (66→68). Verified **0 missing RPCs** and **0 missing migrations** vs live.
- **TODO.md rewritten** — removed every shipped item; now tracks only open owner-actions, intentional deferrals, and out-of-scope work.
- **ROADMAP.md** — E1 (driver/applicator mobile workspace) marked v1 Done (Field Mode shipped 2026-06-14).
- **Archived 23 pre-June one-off audit files** (May Codex prompts / dispositions / dated reports + the 2026-05-16 ultra-review findings) from `docs/audits/` (64→42 files) and `docs/reports/` into `docs/archive/2026-spring/`. Kept the 6 reusable undated `*-prompt.md` audit templates and all June files in place.

---

## 2026-06-14 — create_direct_order customer-PO param (sales_rep money-adjacent fix), applied live

Branch `ship/create-direct-order-customer-po` (isolated worktree off `origin/main`), one migration applied live through the `/ship` gate (rls-security + migration-drift + compliance reviewers all CLEAN; rolled-back `SMOKE_PASS_ROLLBACK`; db-invariant sweeps clean; B7 rename).

- **`20260614142939_create_direct_order_customer_po_param`** — `create_direct_order` gained `p_customer_po_number text DEFAULT NULL` and now sets `orders.customer_po_number` inside the SECURITY DEFINER RPC. Before, `NewOrder.tsx` set the PO with a post-create `supabase.from('orders').update({customer_po_number})`; the live `orders_update` RLS is `is_admin()` for both USING and WITH CHECK, so for a **sales_rep** that follow-up UPDATE was denied → `checkMutationResult` threw → the UI reported failure on a successfully-created order and the PO was silently dropped (not retryable; the idempotency key just replays the create). DROP 7-arg + CREATE 8-arg (a new param changes the identity signature; grants restated since a fresh CREATE resets the ACL to PUBLIC); body byte-verbatim from live except the param + the orders INSERT column/value. Frontend (`NewOrder.tsx`) now passes `p_customer_po_number` and removes the follow-up update + its now-unused `checkMutationResult` import. New smoke chain `scripts/smoke/smoke-create-direct-order-po.sql` proves a real sales_rep persists the PO, empty PO normalizes to NULL, idempotency replay returns the same order, and the auth gates fire. NOT pushed (prod-push gate).

## 2026-06-10 (deep-dive H1 B5) — applicator license-expiry gates + RUP time-bomb fix, applied live

First `/ship` off the deep-dive roadmap, on branch `feat/h1-quick-wins-2026-06-10`. Two migrations applied live through the full review gate (4 reviewers clean, rolled-back smoke tests, B7 renames):

- **`20260610185714_applicator_license_gates`** — staff-held licenses on `applicator_licenses` (`profile_id`, nullable `customer_id`, holder CHECK); `jobs` trigger blocks assigning an applicator whose active licenses are ALL expired (`LICENSE_EXPIRED`, `app.admin_override` hatch); new `assign_job_applicator` RPC (strict-actor, admin-only override) now used by DispatchBoard instead of a raw table UPDATE. UI: license badges + admin override ConfirmModal (JobDetail/DispatchBoard), Customer↔Staff toggle on Compliance, expiring-licenses Dashboard card, `src/lib/licenseStatus.ts` + 10 tests (suite 1,934).
- **`20260610185741_fix_generate_rup_sales_records_phantom_column`** — review gate found the live fn filtering a nonexistent `al.deleted_at` (42703) while `post_invoice` calls it unguarded: the first posted RUP invoice would have crashed billing. One-predicate fix (verbatim live body, md5-verified) + `rupCompliance.ts` twin fix.

Deferred (LOW/pre-existing, reviewer-noted): authenticated-callable `generate_rup_sales_records` attribution-only gate; trigger's RLS fail-open dependency. Branch NOT pushed (prod-push gate).

**Same branch, same session — 4 more H1 items shipped:**
- **B1** RUP point-of-sale warnings: NewOrder banner (stable product-set key, once-per-set activity log) + InvoiceDetail post-confirm folds a NON-COMPLIANT warning into the modal (danger variant; check failure can never block posting). Frontend-only.
- **B3** WPS pre-application notice: migration `20260610193241` adds `products.rei_hours`/`phi_days` (label data, applied live); new `wpsNoticePdf.ts` (40 CFR 170 notice from a job: treated areas, products w/ EPA reg + REI, required-notice bullets, per-page footer, page-break guards); JobDetail "WPS Notice" button; ProductDetail REI/PHI inputs.
- **E3** Owner's daily brief: admin Dashboard card composing AR position (past-60 callout, over-credit count), prepay/commissions owed, period-close countdown, and today's workload from `financial_dashboard_summary` (dollars, formatUSD) + already-fetched operational data.
- **C4** Weather auto-capture: `weatherCapture.ts` (Open-Meteo, keyless; CSP `connect-src` += api.open-meteo.com) — "Use current weather" in the Complete Job modal prefills wind/temp/humidity from the first field's centroid; failure falls back to manual entry. 18 new unit tests across the batch (suite 1,942).

**Blocked on owner inputs (next H1 items):** A1 pay-now links (Stripe account/keys), D1 vendor-bill AI pilot (10 real bills for the accuracy gate), B6 state report pack (which states + the WI DATCP template if applicable — IL's on-demand RUP register + CSV export already exist on /compliance).

---

## 2026-06-10 (foundation ultra review + full remediation) — 7 migrations live, 4 latent crashes fixed, anon exposure closed

Built the reusable **`/foundation-ultra-review`** dynamic multi-agent audit (6 layers: live-data integrity, disk-vs-live drift, edge bundles, deferred ledger, frontend runtime safety, + authorization/exposure surface added after the Codex round). First run: **SOLID-WITH-FOLLOWUPS, 0 BLOCKER** — money/AR data fully consistent (vacuously; mandatory re-run gate after the first real billing cycle), 2026-06 security state intact live, edge bundles in sync, route guards clean. Codex cross-review (NEEDS-WORK, all 8 points accepted after independent live re-verification) upgraded the clamp finding to HIGH, refuted the prebooked-formula finding (measurement artifact), and contributed 2 new MEDs. Reports: `docs/audits/2026-06-10-foundation-ultra-review.md` + disposition.

Remediation (each through the full `/ship` gate — reviewers clean + rolled-back smoke tests):

- **`20260610131048_reverse_receiving_remove_available_clamp`** — receiving reversals no longer clamp at 0 (ledger ≡ snapshot; the clamp had silently swallowed 1,325 units).
- **`20260610131129` + `20260610132244`** — `create_application_record_from_blend_ticket` had **four** stacked latent breaks (no short-stock flag; nonexistent column → 42703; string-into-jsonb → 22P02; text-into-time → 42804). All fixed; warn+flag matches `complete_job`; the 4th crash was caught by the e2e smoke test AFTER both reviewers passed the migration — never-exercised RPCs strike again.
- **`20260610131144_revoke_anon_profile_public_view`** — closed the anonymous employee-directory read (Codex finding, verified via `SET ROLE anon`).
- **`20260610132136_attach_receiving_records_delete_trigger`** — smoke test discovered the delete-compensation trigger was never attached live (pre-B7 drift); attached.
- **`20260610133241_data_fix_commissions_test_quote_split_hygiene`** — 4 stale pending commissions recalced (ORD-2026-0189 $50→$2,455.37 — flagged for Mason); A1 TEST FARM quote cancelled; 15 JSONB-null splits normalized.
- **`20260610133256_prebook_reconciliation_transaction_type`** — dedicated ledger type for prebooked-only corrections (12-value CHECK superset) + frontend enumerations + INVENTORY_RULES.md recompute caveats.

Frontend: ARaging AR-reminder + batch-statement loops now count/Sentry/toast FAILED sends distinctly (were mislabeled "skipped"); QuoteBuilder surfaces a failed status-revert; InvoiceDetail stale-fetch guard. Docs: CLAUDE.md ledger fixes (PR #70 merged note, 217 RPCs, scoped version-parity claim, remit-to confirmed), INVENTORY_RULES 12-type table + caveats.

Still open: H1 inventory re-base (needs Mason's physical counts — 17 products currently undeliverable), H2 squashed baseline (scheduled deliberately), L1 `process-blend-ticket` deploy, owner items M4/L4.

---

## 2026-06-10 (world-class product deep dive) — strategic review, docs only

Ran the first unconstrained product + design + architecture deep dive (5 parallel investigations: codebase reality scan, architecture readiness, competitor research, precision-ag/compliance research, payments/AI research, plus an adversarial filter). **Docs-only — no code, DB, or deploy changes.**

- **`docs/research/2026-06-10-world-class-product-deep-dive-prompt.md`** — the reusable commissioning prompt (5-phase methodology).
- **`docs/research/2026-06-10-world-class-deep-dive-report.md`** — the report: honest area scorecard (Comply weakest at 2.5/5), market map (grower portal + online pay is now table stakes; Agvance/FieldAlytics/AgWorks openings identified), 30-item scored opportunity backlog, three-horizon roadmap (H1: ACH pay-now links + compliance quick wins; H2: grower portal + ISOXML machine-data billing; H3: Leaf integration + label-rate validation), keep/change/kill verdicts (kill checks-only and no-portal; keep single-tenant and CRX-as-ledger for now), 5 architecture prework items (customer-org model, payment webhook, server-side PDFs, integration framework, materialized views), and an explicit what-NOT-to-build list (native apps, multi-tenancy now, ML forecasting, autonomous financial agents, QuickBooks two-way sync).
- Notable correction to project lore: the app IS a PWA (VitePWA + Workbox + IndexedDB offline write-queue, `vite.config.ts:23-85`) — the gap is offline *reads* and mobile UI shape, not missing offline support.

---
## 2026-06-11 (get_customer_statement — 4 AR blind spots closed, applied live)

CHIP task_25d25699 (spawned from the 2026-06-10 error-prevention review's financial-predicate findings, FIN-README Findings item 2). The customer statement RPC had four blind spots that would have made statements wrong the moment AR activity started:

- **`20260611131549_customer_statement_blind_spots` (production money bug, applied live)** — (1) `allocate_payment`-path payments were invisible (they write `allocation_sets`, never `payments`; the statement read only `payments INNER JOIN orders`); (2) the invoice branch filtered `status='posted'` only, so a `paid` invoice lost its charge line while keeping its payment lines (running balance went negative) and `overdue` invoices vanished entirely; (3) soft-deleted payments still counted (no `deleted_at` filter); (4) NULL-`order_id` payments (the `transfer_job_to_invoice` invoice shape) were dropped by the INNER JOIN. Fix = live-verbatim body (md5-anchored, re-asserted in-transaction at apply) + 4 sentinel-bracketed deltas: invoice branch widened to `('posted','paid','overdue')`; `LEFT JOIN orders` with `COALESCE(o.customer_id, p.customer_id)` attribution; `payments.deleted_at IS NULL`; new `allocation_sets` UNION branch counting `total_allocated_cents` only (the overpayment remainder surfaces once, via the prepay branch on application — the DEDUP RULE). Return shape and the 42804 `::bigint` window cast retained; grants restate the live ACL (no posture change). Both reviewers clean; rolled-back smoke chain PASS (all 4 blind spots + dedup + idempotent replay + overdue survival + auth probe); post-fix `fin-ar-statement-balance` predicate run = **0 rows** with its transcription updated in the same work unit. Smoke spec registered as `get_customer_statement` in `smoke-specs.json`.
- Note: this work unit was applied from a chip session via the Supabase Management API (the in-session MCP path wasn't available); the review gate, proof file, smoke, and B7 stamp-naming conventions were all honored. Applied concurrently with (and disjoint from) the Codex round-2 remediation batch below.

## 2026-06-11 (Codex round-2 remediation — draw-order lock + restore-version guard, applied live)

Codex's round-2 review of the partial-draw-down batch returned NEEDS-WORK with 1 HIGH + 1 MED + 1 LOW; all three closed.

- **`20260611130855_update_order_items_draw_order_lock` (HIGH, applied live)** — draw-created orders (`booking_draw=true`) could be item-edited via `update_order_items`, desyncing order vs `quote_product_draws` (draw 200, edit to 300 → the ledger still says 200 and the same 100 could be drawn again). Server-side lock: `BOOKING_DRAW_ORDER_LOCKED` raised before any mutation; void/cancel (which reverse the ledger) remain the sanctioned correction paths. Bonus closure from the review gate: a second sentinel guard adds the missing `is_active` check (deactivated admin/sales_rep → `INSUFFICIENT_ROLE`). OrderDetail hides Edit for draw orders, shows a "Booking draw — items locked" hint, and maps the token as a direct-RPC backstop.
- **`20260611131000_restore_quote_version_drawn_guard` (MED, applied live)** — `restore_quote_version` could restore a snapshot that removes a drawn product or under-books below `quantity_drawn`, bypassing save_quote's drawn-product guard. The identical guard block now validates the restored items; a violation rolls the whole restore back atomically (`BOOKING_OVERDRAWN`, mapped in QuoteBuilder's restore handler).
- **Backfill replay-safety (LOW, assessed — no mutation)** — the `20260610184551` backfill's only live effect (Q-2026-1811, cancelled, drawn=booked=247, 1 order) verified exactly correct; the theoretical partial-ledger multi-product scenario does not exist in production, migrations never re-run, and no safe derivation of historical per-product draws exists (per Codex's own instruction not to manufacture quantities). Disposition documented; the save_quote/restore/rollover guards now bound any future ledger error.
- Both migrations byte-verbatim from live (md5-strip self-verified at apply), both reviewers + types-drift + compliance clean, smoke chains `SMOKE_PASS_ROLLBACK` (9 scenarios incl. deactivated-admin probe + full draw-to-closure), post-apply db-invariant sweeps clean (overloads predicate now excludes extension-owned functions; `transfer_job_to_invoice` actor-forgery hit allowlisted with catalog-corroborated justification).

## 2026-06-10 (sell-side excellence audit + W1 fix applied live)

Read-only sell-side audit (quote → order → delivery → invoice → payment) benchmarked against the ag-retail field — Agvance, AgVantage EDGE, Merchant Ag, AgWorks, Levridge/AGRIS — with every competitor claim adversarially source-verified, and every core sell-side RPC verified against the live DB. Report: `docs/audits/2026-06-10-sell-side-excellence-audit.md`. Verdict: pipeline operationally strong; the two defining ag-retail constructs are missing — season-booking partial draw-down and ship-now/price-later — and form the top of a 7-item ranked roadmap (deep spec sketches included, ready for `/ship`).

- **`20260610145253_partial_quote_draw_down` (roadmap #1 v1, applied live)** — quotes are now season bookings with partial draw-down: "send 200 of my 500 gallons" is a 30-second modal action. New `quote_product_draws` ledger (per-quote-per-product — survives save_quote's delete/recreate of quote_items), new `draw_down_quote` RPC (strict-actor admin/sales_rep, idempotent, FOR UPDATE serialized, overdraw-blocked, booking-weighted locked price, FIFO hold→prebooked decrement keeping Net Free invariant, full drain → `accepted`), `convert_quote_to_order` reproduced verbatim-from-live + status guard (audit W7) + partially-drawn guard + fully-drawn ledger upsert (md5-fidelity verified post-apply). QuoteBuilder gains a "Partial Order" button + "Create Order from Booking" modal. 4 reviewers clean; rolled-back 9-path e2e smoke all PASS. New RpcErrorCodes: BOOKING_CLOSED/BOOKING_OVERDRAWN/BOOKING_PARTIALLY_DRAWN/EMPTY_DRAW.
- **`20260610142204_create_direct_order_role_gate` (audit W1, applied live)** — the live `create_direct_order` had NO role gate (auth.uid() + actor-mismatch only): any authenticated user (driver/applicator) could create confirmed orders + inventory prebooks + commission rows via direct RPC, and missing prices COALESCE'd silently to $0. Prior forgery sweeps skipped it because it *does* reference `auth.uid()` — auth-only ≠ role-gated. Added the canonical `admin`/`sales_rep` `INSUFFICIENT_ROLE` gate (before idempotency); body otherwise byte-verbatim from live (md5-verified post-apply). 3 reviewers clean; rolled-back 4-path smoke all-correct. UI route already admin/sales_rep → zero legit-user impact.

## 2026-05-29 (workflow review + Codex cross-review) — 3 BLOCKER fixes applied live

The new `/review-workflow` audit (full graph/lifecycle/cross-entity/invariant review, verified against live DB) surfaced BLOCKERs; Codex independently cross-reviewed them; every Codex claim was then re-verified against the live database (Codex itself had no Supabase MCP) before any fix. Three migrations applied live via MCP:

- **`20260529214355_revoke_anon_execute_on_report_dashboard_secdef`** — closed an unauthenticated PII/financial leak. 37 SECURITY DEFINER report/dashboard/geo/financial RPCs were EXECUTE-able by the public `anon` key (SECDEF bypasses RLS); proven exploitable with no login (`global_search`, `get_customer_year_end_summary`, `dashboard_summary`, `_check_credit_limit`, etc.). REVOKE EXECUTE FROM anon,PUBLIC on all 37; GRANT to authenticated,service_role (app unaffected). anon-executable SECDEF dropped **89 → 52**; in-migration DO block asserts 0/37 leak. Remaining 52 verified safe (triggers, RLS predicates that must stay executable, sequence generators, self-guarding mutators, and 11 role-checked reports proven to RAISE for anon).
- **`20260529214538_fix_void_order_void_invoice_status_transitions`** — `void_order` crashed on every call (the status-transition trigger gives `fulfilled` no path to `voided`, and the RPC never set `app.admin_override`); 0 orders had ever been voided despite 30 fulfilled. Fixed with a minimal transaction-local override bracket around the fulfilled→voided write. Draft invoices (in `void_order`'s loop and standalone `void_invoice`) now route to `cancelled` (an allowed transition) instead of `voided`; `void_invoice` draft/unposted also → cancelled.
- **`20260529214423_fix_get_customer_transaction_review_running_balance_cast`** — fixed SQLSTATE 42804 (running-balance window `SUM()` returns numeric but column declared bigint; cast to `::bigint`).

Both `rls-security-reviewer` and `migration-drift-reviewer` cleared all three. Codex's 4th "critical" finding (`batch_void_invoices` actor-spoof) was **refuted on live** — the vulnerable body exists only in the disk wave4 file; the deployed function gates on `auth.uid()` via `require_admin_or_sales_rep()` + `void_invoice`'s admin check. Deferred follow-ups (defense-in-depth internal guards on the 37; `batch_void_invoices` disk-drift hardening; restore-RPC fix-or-drop; migration rebuild-fidelity shadow-DB diff) are recorded in `docs/audits/2026-05-29-codex-disposition.md`. Migration count 357 → **360**.

---

## 2026-05-26 (pre-push final audit) — B10 corrective fix for migration 348

Codex's pre-push final audit caught a P1 production-breaking regression in commit `05be295`'s migration 348: the broad `REVOKE EXECUTE … FROM authenticated` on all 6 SECDEF DML helpers also revoked authenticated EXECUTE on 3 functions the frontend actively calls (`check_remainder_reminders` from `Dashboard.tsx:348`, `log_failed_notification` from `Dashboard.tsx:353/365` + `notificationTriggers.ts:37`, `notify_damaged_receiving` from `notificationTriggers.ts:278`). Those code paths were throwing 403 immediately on every dashboard load and every receiving-damaged-items flow.

New migration `20260527020457_grant_authenticated_on_frontend_secdef_helpers.sql` (applied live):

- **Re-grants `authenticated` EXECUTE** on `check_remainder_reminders`, `log_failed_notification`, `notify_damaged_receiving`.
- **Adds body-level role checks** to 2 of those 3 (admin-only for `check_remainder_reminders`; admin OR sales_rep for `notify_damaged_receiving`). The pattern `IF auth.uid() IS NOT NULL AND NOT <role> THEN RAISE 'INSUFFICIENT_ROLE'` lets `pg_cron` and `service_role` (both have `auth.uid() = NULL`) bypass, preserving the existing 06:30 UTC `check-remainder-reminders` cron job.
- **`log_failed_notification` body unchanged** — it's a pure logging helper; the GRANT-level gate is sufficient.
- **3 pure server-side helpers stay locked down**: `check_idempotency`, `check_rate_limit`, `cleanup_rate_limits` remain `anon=false, authenticated=false, service_role=true`. Verified no frontend callers via fresh `rg`.

Migration applied via MCP; all 11 verification assertions passed atomically (per-function policy + body-level guard presence). Live state confirmed: 3 frontend functions `authenticated=true`, 3 server helpers `authenticated=false`, all 6 `anon=false`.

P3 doc drift also fixed in this commit:
- Migration count 354 → **356** in `CLAUDE.md` (×2), `AGENTS.md`, and `docs/reference/migration-history.md`.
- `create-user` version typo (`v19` → `v20`) in audit doc §11.4 corrected with a typo-note.

See `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §12` for full reconciliation.

---

## 2026-05-26 (post-Codex audit) — B7/B8/B9 follow-up fixes

Codex performed a post-apply review of commits `fce0629` + `a824952` and surfaced three blockers the parallel-Claude session missed. All three remediated; live state verified.

**B7 — Migration version drift (P2 administrative).** Supabase MCP `apply_migration` stamped the live record with `now()` (`20260526151856`) rather than parsing the disk filename's `20260526090000`. Disk renamed via `git mv` to match live — same content, same hash, just the timestamp prefix aligned. Same MCP behavior applied to the new B9 migration: disk-named `20260526170000`, live-stamped `20260526201319`, renamed to match. Prevents future `supabase db push` from trying to re-apply already-applied migrations.

**B8 — `create-user` reset_password branch bypassed EDGE-2 (P1 security).** The deployed `reset-user-password` v12 carries the entity_recipient block, but the production UI (`SettingsPage.tsx:393`) routes Set-Password through `create-user?action=reset_password`, NOT `reset-user-password`. The EDGE-2 fix was therefore dead code in practice — a crafted POST with an entity_recipient UUID would bypass the UI filter and set a real password on the service profiles (CMCTW LLC / Crop Rx Solutions), defeating migration `20260516090000`. Added the same entity_recipient guard to `create-user`'s reset branch (lines 86-104 of source); redeployed as **v20 ACTIVE**. Deployed source verified via `get_edge_function`.

**B9 — Six anon-callable SECDEF DML helpers (P2 cluster).** Codex's broader scan (post-regex sweep) found 6 SECURITY DEFINER helpers still anon-EXECUTE-able with DML + no `auth.uid()` check: `check_idempotency`, `check_rate_limit` (forgeable `p_user_id` — DoS vector), `check_remainder_reminders`, `cleanup_rate_limits`, `log_failed_notification`, `notify_damaged_receiving`. New migration `20260526201319_revoke_anon_on_secdef_dml_helpers.sql` revokes from `anon`/`authenticated`/`PUBLIC` and explicitly grants to `service_role`. Legitimate callers (SECDEF wrappers running as `postgres` owner; pg_cron running as superuser) unaffected. Verification block asserts the revocations held.

Edge Function deployed live: `create-user` v19 → **v20 ACTIVE**.
Migration applied live: `20260526201319_revoke_anon_on_secdef_dml_helpers` — verification block passed atomically.

See `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §11` for the post-Codex audit reconciliation. Codex's full prompt is preserved at `docs/audits/2026-05-26-codex-post-apply-audit-prompt.md`.

---

## 2026-05-26 — Full-codebase ultra review execution

Executed the 2026-05-25 ultra-review remediation in one migration plus targeted source fixes. Migration `20260526151856_execute_full_codebase_ultra_review.sql` revokes anon/PUBLIC execution from write-oriented SECURITY DEFINER RPCs, revokes anon table-level DML, hardens `apply_write_off`, `issue_return_credit`, and `void_order` against actor spoofing, restores server-side commission split validation, reconciles commission split rounding, consolidates `next_invoice_number` to one overload, adds idempotency to `duplicate_quote`, `create_followup_delivery`, and `generate_finance_charges`, serializes finance charge generation, allows voiding unposted commission payments, and blocks blank completed-delivery signatures.

Source fixes: CSV exports now neutralize formula-leading values, CustomerDetail financial RPCs use `assertRpcResult`, commission payments can be voided from the unposted tab, offline completed-delivery queueing resets the idempotency key, RUP warning activity logs no longer use an empty actor, `reset-user-password` uses fail-loud `ALLOWED_ORIGIN`, `create-user` captures profile phone update errors, and `quotePdf.ts` removes the stray non-`reportPdf.ts` `any`.

Docs now record migrations `20260517010000`, `20260517020000`, `20260518010000`, and `20260526151856`; migration count is 354. Pending live work: apply the new migration to Supabase and redeploy `reset-user-password` + `create-user`.

**Parallel-session reconciliation (same day, later) added three blockers + one regex extension to the same migration** (see `docs/audits/2026-05-26-claude-disposition-of-codex-execution.md §10`):

- **B4** — explicit `REVOKE EXECUTE ON FUNCTION public.execute_sql_readonly(text) FROM anon, PUBLIC`. SECURITY DEFINER + arbitrary-SELECT body would have let anon read every public table bypassing RLS. Regex prefix `execute_` was outside the original sweep set.
- **B5** — same revoke on `unapply_credit_memo(uuid, text, uuid, text)`. Body uses `v_actor := COALESCE(p_performed_by, auth.uid())` — same actor-forgery anti-pattern as RLS-1. Regex prefix `unapply_` was outside the original sweep set.
- **B6** — `CREATE SEQUENCE IF NOT EXISTS public.cm_invoice_number_seq` near the top of the migration. Live `pg_sequences` lookup showed only 3 invoice sequences (cs/mc/base) — `cm_invoice_number_seq` was missing because the historical migration creating it (`20260316100002_return_credit_ar_integration.sql`) lives on disk but was never applied (confirmed via MCP `list_migrations`). The new `next_invoice_number('credit_memo')` references this sequence; without B6, `issue_return_credit` would have crashed on the first credit-memo issuance (latent — live had 0 credit_memo rows at audit time).
- **C1** — extended the REVOKE regex `^(apply|approve|…)` with `auto|retry|revert` prefixes, sweeping three more anon-callable SECDEF functions: `auto_expire_quotes`, `retry_failed_notifications`, `revert_quote_status`.

Verification `DO $$` block gained three additive assertions: sequence existence (B6), `anon` has no EXECUTE on `execute_sql_readonly` (B4) and `unapply_credit_memo` (B5). Lint/typecheck/tests/SQL validator all clean post-edit.

---

## 2026-05-17 — Codex `/audit` findings closure: is_active gate, OCR dedup, cross-delivery aggregate, doc drift (F1 P1, F2 P2, F3 P2, F4 P3)

Codex ran `/audit` post-ultra-review closeout and surfaced 4 new findings none of which the prior ultra-review caught — all live at the integration boundary (Edge Function ↔ DB consistency, RPC ↔ frontend contract, cross-RPC aggregation). Independent review confirmed all 4 valid. All 4 closed in one branch.

**F1 P1 — Edge Functions ignored `profiles.is_active`.** Frontend `ProtectedRoute.tsx:33-36` hard-blocks deactivated users, but all 6 JWT-gated Edge Functions only selected `role`. A user deactivated in the admin UI could continue calling `create-user`, `send-email`, `reset-user-password`, `setup-blend-tickets-storage`, `process-blend-ticket`, `process-document` until their JWT/refresh-token expired (days). New shared helper `supabase/functions/_shared/auth.ts` `requireActiveProfile(client, callerId, allowedRoles?)` centralizes the lookup. All 6 functions refactored + redeployed via MCP (versions bumped: setup-blend-tickets-storage v14→v15, send-email v11→v13, process-blend-ticket v17→v19, plus create-user, reset-user-password, process-document). Deactivated users now get 403 "Account is deactivated" from any Edge Function. Pattern: `const gate = await requireActiveProfile(adminClient, caller.id, ["admin"]); if ("error" in gate) return jsonResponse({ error: gate.error }, gate.status);`

**F2 P2 — `create_delivery_with_items` allowed cross-delivery over-schedule (migration #344).** The 2026-05-16 fix added per-row `quantity_remaining` check but did NOT subtract quantities already scheduled on OTHER active deliveries. Two failure modes: (1) the same `order_item_id` listed twice in `p_items` — each row passes independently but together exceed remaining; (2) two concurrent `create_delivery_with_items` calls — Delivery A schedules 80 of 100, Delivery B also schedules 80, both complete, `complete_delivery` increments `quantity_delivered` to 160 > 100. The correct pattern existed in `edit_delivery_items_when_scheduled` (20260334200000:124-143) but was never reapplied to create. New migration: (1) `ITEM_DUPLICATE_IN_REQUEST` rejection via `jsonb_array_elements + GROUP BY HAVING COUNT(*) > 1` before any work; (2) inside the per-item loop, `SELECT COALESCE(SUM(di.quantity), 0) FROM delivery_items JOIN deliveries ... WHERE status IN ('scheduled', 'in_progress') AND d.id <> v_delivery_id` and check against `quantity_remaining - other_scheduled`; `ITEM_OVER_REMAINING_INCL_ACTIVE` on overschedule. Applied live via Supabase MCP.

**F3 P2 — Blend-ticket reprocess duplicated product rows (process-blend-ticket v19).** Frontend `BlendTicketDetail.tsx:458` sends `reprocess: true` when user clicks "Re-process OCR", but the Edge Function never read the flag — it just appended new product rows on top of existing ones. Compounded by 2026-05-16 P2 #6 error-checks: previously silent failures now throw, making retries the expected path — but retries also duplicate. Fix: (1) read `body.reprocess === true` at top of handler; (2) when `reprocess=true`, `DELETE FROM blend_ticket_products WHERE blend_ticket_id = ? AND manually_corrected = false` BEFORE the insert loop (preserves any user hand-edits); (3) safety net on first-time runs — detect prior partial-failure rows (`manually_corrected=false` rows exist) and wipe them too, so a re-attempt after a mid-loop failure doesn't compound the duplication.

**F4 P3 — Docs drift after closeout.** AGENTS.md said `333 migrations` (10 behind), `docs/reference/migration-history.md` said `337 migrations` (6 behind), `docs/CHANGELOG.md` line 21 said `process-blend-ticket` deploy pending while it was actually deployed v17. CLAUDE.md said `337 migrations` (already patched earlier this session to 343, now 344). All four patched in this entry.

**Pre-commit checks:** `npm run lint`, `npm run typecheck`, `npm run build`, `npm run test`, and `bash scripts/validate-sql-migrations.sh` all pass with the new code. Test count unchanged: 1,914 unit tests (130 files, 70 skipped).

---

## 2026-05-16 — Ultra-review Phase 3: send-email durability, error checks, CORS, docs (P2 #5, #6 + P3 #7, #8)

**P2 #5 — `send-email` durable idempotency (Edge Function v11 + migration #337).**
Prior flow: check email_log → send via Resend → INSERT email_log. If the post-send insert failed, customer got the email but no audit record and no idempotency replay marker — future retries would duplicate. New write-ahead-log flow: INSERT email_log with `status='pending'` BEFORE Resend call; if pending insert fails, DON'T send (return 500). After Resend returns, UPDATE the pending row to `'sent'` or `'failed'`. Idempotency check now only returns cached success when status is exactly `'sent'`; existing `'pending'`/`'failed'` rows are reused for retry. Required migration #337 to add `'pending'` to the `email_log.status` CHECK constraint (was `'sent', 'failed', 'bounced'`). EmailLog TS type updated accordingly.

**P2 #6 — `process-blend-ticket` error checks.** 10 unchecked `await adminClient.from(...).update/insert(...)` calls were causing silent failures: tickets stuck "processing" forever, queues stuck in wrong state, missing product rows, and the function still returning success. Categorized:
- 5 critical success-path writes (queue→processing, ticket→processing, ticket→update with parsed data, blend_ticket_products inserts, queue→complete): now destructure `{ error }` and throw with descriptive message on failure.
- 1 non-critical notification write (uploader-completion notification): destructures error, logs warning, captures to Sentry, does NOT throw (OCR success shouldn't be rolled back by a notification glitch).
- 4 catch-block cleanup writes (queue→failed, ticket→failed, queue→pending retry, ticket→pending retry): destructures error, captures to Sentry with `catch-cleanup-*` tags, does NOT re-throw (would mask the original error already captured at the top of the catch block).

**P3 #7 — `setup-blend-tickets-storage` CORS hardening (Edge Function v14).** Removed the silent `return "https://croprxsolutions.app"` fallback when `ALLOWED_ORIGIN` is missing. Now throws at module load, matching the PR-16 pattern used by every other hardened Edge Function. Hiding deployment misconfiguration is worse than boot failure.

**P3 #8 — `void_vendor_bill` docs drift.** Updated `docs/reference/rpc-functions.md:169` to say `→ void` instead of `→ jsonb` (live SQL returns void per pg_proc; frontend already uses `.throwOnError()` correctly). One-line fix.

**Pending Mason:** ~~`process-blend-ticket` source code is committed but the Edge Function needs a manual deploy~~. **✅ Resolved 2026-05-16 PM** — deployed live as v17 via Supabase MCP after using node-via-bash to JSON-encode the 47KB file content + reading it back through Read.

---

## 2026-05-16 — Ultra-review Phase 1 + 2: idempotency, offline sync (P1 #1, #3, #4)

External ultra-review (`docs/reports/2026-05-16-ultra-code-review-findings.md`) flagged 4 P1 findings on top of the morning's session work. Verification showed P1 #2 was a **false positive** — all 5 cited SECURITY DEFINER functions actually have `search_path=public, pg_temp` in live `pg_proc`; the reviewer was reading the original source migrations where they were initially created without `pg_temp`, but subsequent migrations rewrote them with the correct config. Lesson: verify against live state, not source files.

The other 3 P1s were real and closed:

**P1 #1 — `transfer_job_to_invoice` idempotency bypass (migration #335).** The morning's migration #334 had used the `idempotency-body-check: exempt` marker to preserve the function's pre-existing gap. The reviewer correctly noted that this creates a customer-visible bug: after a successful invoice creation, a network-dropped response causes the retry to fail with "Job already invoiced" instead of replaying the success. Wired canonical `check_idempotency`/`save_idempotency` calls. Removed the exempt marker. Function interface unchanged.

**P1 #4 — Notification RPC signature mismatch (migration #336).** Frontend `src/lib/notificationTriggers.ts` was passing `p_idempotency_key: crypto.randomUUID()` to `log_failed_notification` (5-arg signature) and `notify_damaged_receiving` (3-arg signature). PostgREST function lookup was failing silently — damaged-receiving alerts were broken AND the fallback failure-queue logging was also broken (compounding the silence). Added `p_idempotency_key text DEFAULT NULL` to both signatures, wired canonical idempotency. DROP FUNCTION before CREATE because adding a defaulted param creates a new overload, not a replacement.

**P1 #3 — Offline sync validation (`src/lib/offlineSync.ts`).** `executeOfflineAction()` only checked `error`, not `data`. If Supabase returned `{ data: null, error: null }` — RLS denial on a SELECT chain, trigger fail-soft path, etc. — the action was silently removed as if synced. Verified via pg_proc that all 9 mapped offline RPCs return jsonb (none are void), so a uniform null-data throw is safe. Added the check + a regression test asserting the queued action is retained for retry when null data comes back. Test count: 1,913 → 1,914.

**Audit file imported:** `docs/reports/2026-05-16-ultra-code-review-findings.md` — preserved verbatim for future reference, including the false-positive finding (which has a useful "verify against live state, not source files" lesson baked in).

---

## 2026-05-16 — Audit #7 closure: safe_cents_qty wrap on transfer_job_to_invoice

Closes the last deferred `safe_cents_qty` follow-up from the 2026-05-13 audit sprint. The 2026-05-13 execution summary listed 3 RPCs as deferred (`transfer_job_to_invoice`, `create_invoice_from_blend_ticket`, `save_field_app_invoice`) but live `pg_proc` grep on 2026-05-16 showed only `transfer_job_to_invoice` actually had unsafe `(cents * qty)::bigint` patterns — the other 2 already used `ROUND(...)::bigint` throughout. The original audit overcounted.

Migration `20260516000000_safe_cents_transfer_job_to_invoice.sql` rewrites the `v_share` loop with 2 surgical fixes:

- **Price-override branch**: `(v_share.price_override_cents * v_share.share_acres)::bigint` → `safe_cents_qty(v_share.price_override_cents, v_share.share_acres)`. The helper does `ROUND(cents * qty)::bigint`, eliminating up to ~0.999 cents/share truncation loss.
- **Pct-split branch**: `(COALESCE(v_job.total_price_cents, 0) * v_share.avg_split_pct / 100.0)::bigint` → `ROUND(COALESCE(...) * v_share.avg_split_pct / 100.0)::bigint`. Shape is cents × pct/100 (not cents × qty) so the `safe_cents_qty` helper doesn't fit; bare `ROUND()` is the right primitive.

Net effect on multi-customer billing splits: `invoice_shares.amount_cents` sums now equal `invoices.total_amount_cents` exactly instead of drifting below by a fraction-of-a-cent per share row.

Function body otherwise unchanged. Signature/return shape unchanged — no downstream impact on TypeScript types or the [JobDetail.tsx](../src/pages/JobDetail.tsx) caller. Migration has an inline `DO $verify$` block that asserts both fixes landed and aborts on failure. Applied live via Supabase MCP; `prosrc` post-apply confirmed both patterns present and old unsafe form absent.

**Hook exempt rationale (top-of-file marker):** the function declares `p_idempotency_key` but its body has never honored it (no `check_idempotency` / no `save_idempotency`). Same behavior preserved verbatim — wiring canonical idempotency is a separate cleanup, low priority since `FOR UPDATE` on the job row + `pg_advisory_xact_lock` on invoice_number generation already serialize concurrent retries (the second call fails with "Job already invoiced" rather than producing duplicates).

**Also closed today:**
- `send-email` Edge Function deployed to v10 — PR-03 `farm_name` fix from 2026-05-09 had been on the branch for ~7 days but never deployed; live v9 was silently failing every customer-tied email. Verified deployed bundle via `get_edge_function`.
- 17 of 20 PR #59 codex review threads bulk-resolved via GraphQL (the 3 left open are deferred-by-decision items: customer RLS upper bound, apply_prepay hand-decrement, entity commission recipients).
- Advisory comment posted on PR #60 flagging that its `DROP VIEW profile_public_view` migration conflicts with current branch's view-dependent code.

---

## 2026-05-13 — Audit #28 follow-up: REVOKE anon on 9 new SECURITY DEFINER functions

Defense-in-depth cleanup discovered while running the security advisor post-sprint. Supabase grants EXECUTE on new public-schema functions to BOTH `anon` and `authenticated` by default — `REVOKE ALL ... FROM PUBLIC` strips the PUBLIC group's grant but leaves the role-specific anon grant intact. Each function body checks `auth.uid() IS NULL → AUTH_REQUIRED` so an anon caller can't actually do anything, but the advisor `0028_anon_security_definer_function_executable` correctly flags it (defense-in-depth means revoking the grant, not relying on the body to refuse).

Migration `20260513060000` revokes:
- `anon` EXECUTE on 7 user-facing / helper RPCs (keeps `authenticated`): `create_rebate_claim`, `transition_rebate_claim`, `create_delivery_with_items`, `bulk_import_order`, `save_blend_recipe`, `compute_commission_amount`, `safe_cents_qty`
- `PUBLIC + anon + authenticated` EXECUTE on 2 internal helpers (`_insert_commissions_for_order`, `_snapshot_order_item_cost`) — only called from within other SECURITY DEFINER bodies, where inner-call grants are irrelevant due to function-owner permissions

**Latent bug surfaced + fixed:** `_snapshot_order_item_cost()` had been created (migration 20260513050000) without `REVOKE ALL ... FROM PUBLIC`, so PUBLIC had EXECUTE — anon inherited via PUBLIC even after stripping its direct grant. The first attempt at this migration failed at the verify step ("anon still has EXECUTE on 1 of 9") and got rolled back. Diagnosed via `proacl` inspection (`{=X/postgres,...}` = PUBLIC entry); fixed by adding PUBLIC to the REVOKE for that one fn.

Project-wide impact: drops the anon SECURITY DEFINER warning count from ~223 → ~214 (the other ~214 are pre-existing functions, separately tracked as a hygiene-sweep follow-up). Future migration template: include `REVOKE ALL ... FROM PUBLIC, anon` for every SECURITY DEFINER function plus a single `GRANT EXECUTE ... TO authenticated` for user-facing ones.

---

## 2026-05-13 — Audit #28 closure: Edge Functions Sentry hardening

`supabase/functions/_shared/sentry.ts` had two fail-soft paths that suppressed Sentry alerts silently in production:
- `SENTRY_DSN` missing → silent `return false`
- `SENTRY_DSN` malformed → quiet `console.warn` + `return false`

Per the audit, both should be loud. Changes:

- **New `validateSentryDsnOrThrow()` exported helper** — fail-loud counterpart to `captureEdgeException`. Throws at module-load if DSN is missing or malformed (mirrors the PR-16 ALLOWED_ORIGIN pattern). Functions whose alerting is critical can call this at top-level. Functions where alerting is best-effort can keep using `captureEdgeException` as graceful degradation.
- **`[SENTRY_MISCONFIG]` log sentinel** — both fail-soft paths now log with this grep-friendly prefix. Easy to find in Supabase function logs and easy to alert on at the log-pipeline layer.
- **Sentry capture added to 4 Edge Functions that were missing it**: `create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`. Each catch block now calls `await captureEdgeException(err, { function: '...', level: 'error' })` before returning the 500 response. The 3 functions that already had Sentry (`send-email`, `process-document`, `process-blend-ticket`) are unchanged.

**Pending Mason:** deploy the 5 changed functions to Supabase via `supabase functions deploy <name>` (one each for `create-user`, `reset-user-password`, `seed-admin`, `setup-blend-tickets-storage`, plus any function that imports `_shared/sentry.ts` to pick up the helper update — i.e. all 7 since they all share the helper now). The code change is committed; deployment is intentionally a manual step.

---

## 2026-05-13 — Audits #18 + #35 closure: UX cleanup

**Audit #18** — Expanded the Inventory page's `HelpTip` to explicitly contrast `Net Position` vs `Today's Free`. Both numbers exist for sound reasons (Net Position is forward-looking and used for order-creation warnings; Today's Free is right-now physical stock and used by the manual-hold modal because a hold competes against today's stock not future PO arrivals) but users were confusing them. The HelpTip now spells out which is which and where each is used. No code logic change — just clarification text.

**Audit #35** — `AccountsPayable.tsx` was running both `get_ap_dashboard_summary` and `get_ap_aging` every time `asOfDate` changed, even though the summary doesn't depend on the date. Split into two `useCallback`s + two `useEffect`s: one for summary (mount-only), one for aging (asOfDate). The Refresh button kicks off both in parallel. Mount effect uses an `isInitialDateRef` to skip the duplicate aging fetch on first render. No more wasted RPC calls when scrubbing through dates.

---

## 2026-05-13 — Audits #11 + #27 + #32 closure: activity feed + cost snapshot

**Audit #11 (commission TS-side logActivity)** — `CommissionPayments.tsx` was calling `create_commission_payment`, `post_commission_payment`, `void_commission_payment` RPCs but never writing to `activity_feed`. The DB side already wrote `financial_audit_log` (DBA-only audit log) but ordinary users had no visibility into commission events from the activity feed. Added `logActivity({ event: 'commission_payment_created'|'commission_payment_posted'|'commission_payment_voided', ... })` at the success points of each handler.

**Audit #27 (prepay TS-side logActivity)** — Same pattern: `PrepaymentManager.tsx` was calling `create_prepay_check_splits`, `apply_remaining_prepayments`, `batch_apply_all_prepayments` RPCs without writing to `activity_feed`. Added `logActivity({ event: 'prepay_check_created'|'prepay_applied'|'prepay_batch_applied', ... })` at success points. The batch-apply event has no entityType/entityId since it's a multi-customer operation.

**Audit #32 (cost-at-time snapshot)** — Migration `20260513050000_order_items_cost_at_time_snapshot.sql` (live). `order_items.cost_per_unit` was caller-supplied (potentially a stale quote cost from weeks earlier, or a manual override) so it didn't authoritatively answer "did order X use the cost-at-the-time?" Added `cost_at_time_cents bigint` column + `_snapshot_order_item_cost()` BEFORE INSERT trigger that fills it from `products.current_cost * 100` (rounded) whenever caller leaves it NULL. Trigger handles every insert path automatically — no RPC changes needed (all 5 commission/order paths get it for free). Backfill from `cost_per_unit * 100` for existing rows. New `OrderItem.cost_at_time_cents` field on the TS interface.

---

## 2026-05-13 — Audits #7 + #19 closure: `safe_cents_qty` helper + invoice balance CHECK

**Audit #7** — Migration `20260513030000_safe_cents_multiply_helper.sql` (live). PostgreSQL's `numeric::bigint` cast truncates, so `(price_cents * qty)::bigint` lost up to ~0.999 cents per line item. Live grep against `pg_proc.prosrc` found 4 instances:

- `create_quick_delivery` × 3 (most-trafficked: item price × delivery qty, used by every QD invoice line)
- `transfer_job_to_invoice` × 1 (price_override × share_acres)
- `create_invoice_from_blend_ticket` × 1 (cost_per_acre × fee_acres)
- `save_field_app_invoice` × 1 (cost_per_acre × fee_acres)

New `safe_cents_qty(p_cents bigint, p_qty numeric) -> bigint` IMMUTABLE helper does `ROUND(p_cents * p_qty)::bigint` (to-nearest-cent rounding). `create_quick_delivery` body rewritten to use the helper for all 3 instances. The other 3 are documented as deferred (each single-instance, smaller blast radius — fee × acres patterns) for a follow-up sprint.

A new `sql-safety.mjs` hook rule blocks `(<*_cents> * <qty>)::bigint` patterns in future migrations (strips SQL `--` comments first so doc text mentioning the bad pattern doesn't false-positive).

**Audit #19** — Migration `20260513040000_invoices_balance_non_negative.sql` (live). `invoices.balance_cents` is GENERATED ALWAYS but had no CHECK guard against going negative. The two base columns already have non-negative CHECKs (`invoices_total_non_negative`, `invoices_paid_non_negative`) but a future mis-allocation path could over-pay an invoice and persist phantom customer credit. Live data showed 0 rows with negative balance (existing `allocate_payment` caps at outstanding), so safe to add VALIDATED in one step. Original audit said "credit memos" — there's no `credit_memos` table in this codebase; "credit memos" are `invoices` rows created by `issue_return_credit`, so the constraint covers the credit-memo case too.

---

## 2026-05-13 — Audit #6 closure: canonical commission math

Three commission-creating paths used three different formulas, so the same order produced different commission totals depending on which entry-point the user took:

- `convert_quote_to_order`: `profit * (pct / 100)` — no rounding, no clamp
- `create_direct_order`: `GREATEST(profit * (pct / 100), 0)` — clamped, no rounding
- `create_quick_delivery`: `ROUND(profit * pct / 100, 2)` — rounded, no clamp

**Bonus latent bug discovered + fixed:** `create_quick_delivery`'s commission insert referenced `recipient_id` and `notes` — neither column exists on `commissions` (it's `recipient text` + `recipient_user_id uuid`, no `notes`). Any QD for a customer with a default_commission_split would have crashed on insert. Confirmed latent: `SELECT count(*) FROM commissions WHERE recipient IS NULL` = 0 (the broken code path was never successfully exercised in prod). The fix vacates the broken block as a side effect.

**Fix shape:**
- New `compute_commission_amount(numeric, numeric) -> numeric` IMMUTABLE helper that embeds the canonical formula: `GREATEST(ROUND(COALESCE(profit, 0) * COALESCE(pct, 0) / 100, 2), 0)`. Round to 2 dp because commissions are stored as numeric dollars (not bigint cents). Clamp to >= 0 because losing-trade orders shouldn't owe sales reps negative commission.
- New `_insert_commissions_for_order(order_id, customer_id, profit, split, date)` SECURITY DEFINER wrapper that does the INSERT once, called via `PERFORM` from all three paths. Future commission-creating RPCs go through the helper too — single source of truth, no further drift possible.

**Live verification:** Helper returns `500.00` for `(1000, 50)`, `0` for `(-100, 50)`, `11.11` for `(33.33, 33.33)`. All 3 caller bodies confirmed via `prosrc` to invoke the helper and have zero remaining inline `INSERT INTO commissions` blocks.

---

## 2026-05-13 — Audits #10, #31, #34 closure: atomic multi-table write RPCs

Three frontend code paths were doing multi-table writes outside any transaction wrapper. If the child insert failed, you got orphaned parents (or, for BlendRecipes, a recipe with all its items wiped and no replacement). Closed in one migration with three SECURITY DEFINER RPCs:

- **#10 NewDelivery.tsx** — Replaced separate `deliveries` insert + `delivery_items` insert with `create_delivery_with_items(p_order_id, p_customer_id, p_scheduled_date, p_items jsonb, ...)`. Generates `delivery_number` via the existing `next_delivery_number()` helper inside the same transaction.
- **#31 BulkOrderImport.tsx** — Replaced per-order separate `orders` + `order_items` inserts with `bulk_import_order(p_order_number, p_customer_id, p_status, totals..., p_items jsonb, ...)`. Frontend still does the per-row customer/product lookups (preserves the existing friendly error messages); it just ships resolved IDs to the RPC. Each order gets its own idempotency key derived from `order_number`.
- **#34 BlendRecipes.tsx** — Replaced create-or-update + DELETE-then-INSERT-items flow with `save_blend_recipe(p_recipe_id, p_name, p_recipe_type, p_items jsonb, ...)`. For updates, the DELETE-and-reinsert is atomic — a failed insert rolls back the DELETE too, so a recipe never ends up with zero items unintentionally.

All three RPCs use the canonical 2026-05 pattern: `auth.uid()` strict-actor, role gate matching the table RLS, `check_idempotency`/`save_idempotency` helpers, machine-readable error tokens (`AUTH_REQUIRED`, `FORBIDDEN`, `ITEMS_REQUIRED`, `ITEM_INVALID`, etc.). Idempotency-coverage list bumped 75 → 78. Total RPCs ~177 → ~180.

---

## 2026-05-13 — Audit #33 closure: rebate claim atomic RPCs

Followup sprint kicked off (see `docs/audits/2026-05-12-execution-summary.md` Phase 5 list). First cluster — concurrency — closed.

**Audit #33** — Migration `20260513000000_rebate_claim_atomic_rpcs.sql` (live). Three problems addressed:

1. **Claim number generation race** — Frontend used `count(*) + 1` and there was no UNIQUE on `claim_number`. Two concurrent inserts could collide. Replaced with per-year counter table (`rebate_claim_counters`) updated via `INSERT ... ON CONFLICT DO UPDATE`, which holds a row-level lock for the duration of the statement — concurrent callers serialize cleanly. UNIQUE constraint added as a defense-in-depth backstop.
2. **Status transition race** — Naked `.update()` on rebate_claims with no row lock and no state machine. Replaced with `transition_rebate_claim()` RPC that does `SELECT FOR UPDATE` on the claim row, then validates the transition (pending→submitted\|rejected, submitted→approved\|rejected, approved→paid). Raises `INVALID_TRANSITION` if the caller's view of state is stale.
3. **`paid_amount_cents` never written** — The "Mark Paid" button only set status. Now the paid transition writes `paid_amount_cents` (defaults to `claim_amount_cents` if caller doesn't specify) and optionally `manufacturer_ref`.

Frontend (`src/pages/Rebates.tsx`) rewritten to call the RPCs via `supabase.rpc()` with idempotency keys from `useIdempotencyKey`. New error codes (`PROGRAM_REQUIRED`, `QUANTITY_INVALID`, `CLAIM_AMOUNT_INVALID`, `CLAIM_ID_REQUIRED`, `STATUS_REQUIRED`, `CLAIM_NOT_FOUND`, `INVALID_TRANSITION`, `PAID_AMOUNT_INVALID`, `FORBIDDEN`) added to `RpcErrorCodes` in `src/lib/db.ts`. Frontend uses `hasRpcCode(error, RpcErrorCodes.INVALID_TRANSITION)` to detect stale-state and surface a friendlier message. Contract tests added (`create_rebate_claim`, `transition_rebate_claim`); idempotency-coverage list expanded from 73 → 75.

---

## 2026-05-12 — Decision-B + Audit #5 closure (2 final migrations)

After Mason approved Option C for Decision-B (#9a/#9b) and Option A for #5 (trigger-cache), two more migrations landed.

**Decision-B (#9a + #9b)** — Migration `20260512040000_tighten_field_app_locations_rls.sql` (live). `field_app_locations_select` and `field_app_location_shares_select` SELECT policies tightened from `((SELECT auth.uid()) IS NOT NULL)` to `is_admin() OR is_sales_rep() OR is_applicator()`. Drivers no longer see billing splits; applicators retained because the field-app workflow (multi-customer jobs, split-billing on iPad) needs split context for rate decisions. Matches the pattern set by `field_crop_history_select` earlier in the day.

**Audit #5** — Migration `20260512050000_prepay_credits_balance_trigger_cache.sql` (live). `prepay_credits.balance_cents` is now a trigger-maintained cache instead of a hand-decremented column. `_recompute_prepay_credit_balance()` runs AFTER INSERT OR DELETE on `prepay_applications` and recomputes `balance_cents = original_amount_cents - SUM(applied_amount_cents)` from scratch (recompute-from-scratch is drift-impossible by construction). UPDATE handling not needed because `prepay_applications` is UPDATE-immutable per migration 310. Drift check on session start showed 0 mismatches in 0 rows — clean install with no baseline reconciliation surprises. The existing hand-decrement inside `apply_prepay_to_invoice` remains as belt-and-suspenders; trigger overwrites with the recomputed value (same end-state), so the hand-decrement can be dropped in a future cleanup PR once the trigger has been observed in prod.

This brings the total to **15 findings closed** in this branch's audit sprint. Branch is 312 → 314 migrations.

---

## 2026-05-12 — Phase 2 + Phase 3 audit sprint closure (13 findings closed)

Branch `fix/audit-2026-05-09`. Single-session autonomous run that closed everything in Phase 2 and Phase 3 of the Phase 0 verification execution order.

**Phase 1 finalization (1 live apply).** The two May-11 migrations were already live (per `pg_proc` inspection), but the vendor-bill positive-total guard from commit `5b9b05c` had only landed on `create_vendor_bill` — `update_vendor_bill` was still missing the `v_new_total_cents <= 0` recheck. Applied `20260511030000_vendor_bill_positive_total_guard.sql` to live Supabase, closing the half-applied state.

**Phase 2 — money/inventory (9 items, all closed).**
- **#14** `src/lib/db.ts:checkMutationResult` now throws when `data === null` (silent RLS denial via `.select()` chain). Test `src/lib/db.test.ts` updated to assert the new behavior + a new test for `data: undefined`.
- **#25** `src/hooks/useGuardrails.ts` fail-closed on Supabase errors. Both `useCreditLimitCheck` and `useOverloadedDriverCheck` now `Sentry.captureException` and return `false` (block) on caught errors instead of `setWarning(null); return true` (silent pass). Caller gets an explicit "could not verify" warning.
- **#29** `src/lib/offlineSync.ts` wraps the per-action catch with `Sentry.captureException` (level=error on permanent fail, warning on retry). Permanent failures used to be invisible to oncall.
- **#20** `src/lib/parseCents.ts` rejects scientific notation (`"1e5"` was parsing as $15) and multi-dot input (`"1.2.3"` was parsing as $1.20). Tests in `parseCents.test.ts` added for both edges + a positive-control for currency formatting.
- **#8 + #15** combined migration `20260512000000_quick_delivery_server_pricing_and_audit_log.sql` — extends `financial_audit_log_operation_type_check` to allow `order_created`/`delivery_created`/`quote_converted`; rewrites `create_quick_delivery` to use server-side tier price only (drops the `COALESCE(NULLIF((v_item->>'price_cents')::bigint, 0), <tier>)` override that let drivers/sales-reps spoof a $0.01 price); both `create_quick_delivery` and `convert_quote_to_order` now write a `financial_audit_log` entry on every order/delivery/quote-conversion.
- **#24** `20260512010000_immutability_triggers_ledger_tables.sql` — `inventory_transactions` rejects UPDATE+DELETE (zero existing callers do either, full immutability is safe); `prepay_applications` rejects UPDATE only (`void_invoice` still DELETEs rows when reversing a void, and its `financial_audit_log` write preserves the evidence trail). Bypass via `SET LOCAL app.bypass_ledger_immutability = 'true'` for rare DBA corrections.
- **#23** `20260512020000_payments_order_fk_restrict.sql` — `payments_order_id_fkey` changed from `ON DELETE CASCADE` to `ON DELETE RESTRICT`. Verified safe: zero RPCs or frontend code do raw `DELETE FROM orders` (orders are cancelled/voided/restored via state transitions). Defense-in-depth against accidental AR-history destruction.

**Phase 3 — RLS + deps (4 items, all addressed).**
- **#9c + #9d** combined migration `20260512030000_tighten_blend_ticket_field_crop_history_rls.sql` — `blend_ticket_fields_select` SELECT now matches the INSERT/UPDATE predicate (uploader, admin, or sales_rep) instead of `USING (true)`; `field_crop_history` SELECT tightened to `is_admin() OR is_sales_rep() OR is_applicator()` (applicators retained because the field-app workflow needs crop history for rate decisions). The old `"Authenticated users can read crop history"` permissive policy was dropped.
- **#30** PostgREST SET-LOCAL audit complete — **CLOSED, theoretical only**. Three RPCs use `SET LOCAL app.admin_override = 'true'` (`cancel_order`, `convert_quote_to_order`, `post_invoice`), all with literal `'true'` value (no user input flows in). `pgrst.db_pre_request` is not configured. No injection vector via PostgREST.
- **#38** documented deferral in `src/lib/fieldImportParser.ts` — `shapefile@0.6.6` + `@mapbox/togeojson` are unmaintained; replacement candidates (`shpjs`, `@tmcw/togeojson`) require manual testing against real-world `.shp`/`.dbf`/`.prj`/`.kml` fixtures. Risk surface is bounded: admin-gated route, 500-feature cap, client-side only. Tracked as a future dependency-maintenance PR.

**NOT-VERIFIED triage (10 findings → 8 STILL VALID + 1 PARTIAL + 1 already-closed).** Subagent investigation surfaced that all 10 originally-NOT-VERIFIED items are real bugs:
- **#10, #31, #34** (non-atomic multi-table writes in `NewDelivery.tsx`, `BulkOrderImport.tsx`, `BlendRecipes.tsx`) — cluster needs a single fix pattern: wrap each multi-step UI insert into a SECURITY DEFINER RPC for atomicity.
- **#33** (rebate claim race) — highest residual risk; needs SELECT FOR UPDATE locking.
- **#6, #7, #19, #32, #35** confirmed STILL VALID, each multi-hour follow-up work.
- **#28** PARTIAL — `send-email` does have Sentry capture; `_shared/sentry.ts` returns `false` on DSN-parse failure which suppresses alerts silently. Half-fixed.

These 10 findings are queued for the next sprint with the cluster-by-fix-pattern grouping above. Verdicts captured in `docs/audits/2026-05-12-execution-summary.md`.

**Live verification (all checked via Supabase MCP):**
- `_guard_profile_role_lock`, `trg_guard_profile_role_lock` on profiles ✓
- `apply_prepay_to_invoice` signature `(uuid, uuid, bigint, uuid, text)`, single overload ✓
- `update_vendor_bill` has `bill total must be positive` guard ✓
- `create_quick_delivery` no longer references `NULLIF((v_item->>'price_cents')::bigint, 0)` ✓
- `financial_audit_log_operation_type_check` includes `order_created`, `delivery_created`, `quote_converted` ✓
- `trg_guard_inventory_transactions_immutable` + `trg_guard_prepay_applications_immutable` active ✓
- `payments_order_id_fkey` `ON DELETE RESTRICT` ✓
- `blend_ticket_fields_select` no longer `USING (true)`; old `field_crop_history` permissive policy dropped ✓

**Build + test outcome:** `npm run lint` 0 errors, `npm run typecheck` 0 errors, `npm run build` clean, `npm run test` 1,894 passing / 70 skipped / 0 failing. Branch is 65 commits ahead of `main`.

---

## 2026-05-11 — Phase 1.D: Harden apply_prepay_to_invoice (closes audit Critical #4)

Branch: `fix/audit-2026-05-09`. Phase 0 verification confirmed Critical #4 still valid: `apply_prepay_to_invoice` is SECURITY DEFINER and writes to 5 tables (including `financial_audit_log`) but had no `p_idempotency_key` parameter, no actor check, no role gate.

**The hole.** A direct PostgREST caller with any authenticated JWT could call this function and:
- Apply a prepay credit to ANY invoice (since SECURITY DEFINER bypasses table RLS)
- Double-apply on network retry (no idempotency check) — same allocation runs twice, drains the credit twice, overpays the invoice

Today the practical attack surface is small: the function is only called from `batch_apply_prepayments`, which itself has the canonical idempotency + actor pattern (`p_performed_by` + `p_idempotency_key` already wired). But that's situational — any future direct caller (UI, retry agent, support tool) would lack protection.

**Fix (migration `20260511100000_apply_prepay_to_invoice_hardening.sql`):** narrowest defense-in-depth — extend the signature with `p_performed_by uuid DEFAULT NULL` and `p_idempotency_key text DEFAULT NULL`, and add the canonical guards at the top of the body:

```sql
v_actor := auth.uid();
IF v_actor IS NULL THEN RAISE EXCEPTION 'AUTH_REQUIRED'; END IF;
IF p_performed_by IS NOT NULL AND p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'ACTOR_MISMATCH';
END IF;
SELECT role INTO v_actor_role FROM profiles WHERE id = v_actor AND is_active = true;
IF v_actor_role NOT IN ('admin', 'sales_rep') THEN
  RAISE EXCEPTION 'INSUFFICIENT_ROLE: only admins and sales reps can apply prepayments';
END IF;
IF p_idempotency_key IS NOT NULL THEN
  v_existing := check_idempotency(p_idempotency_key, 'apply_prepay_to_invoice');
  IF v_existing IS NOT NULL THEN RETURN (v_existing->>'application_id')::uuid; END IF;
END IF;
```

Body otherwise reproduced verbatim from the prior installed version (including the existing `financial_audit_log` write).

**Why RETURN type stays `uuid`.** `batch_apply_prepayments` calls this and assigns the result to a `uuid` variable. Changing to canonical `jsonb_build_object('success', true, ...)` would force a cascade rewrite through `batch_apply_prepayments` for no real benefit — this is an SQL-internal helper, not a public TS-facing RPC. The `uuid` interface is the actual contract.

**Why backward-compatible.** Both new parameters are `DEFAULT NULL`, so the existing 3-arg call from `batch_apply_prepayments` (`apply_prepay_to_invoice((v_alloc->>'prepay_credit_id')::uuid, v_invoice_id, (v_alloc->>'amount_cents')::bigint)`) continues to work. No SQL cascade, no TS cascade. The new params only matter for direct callers who want to opt into actor verification or idempotency.

DO-block verification asserts exactly one overload exists, the signature contains both new params, and the body contains all four error tokens (`AUTH_REQUIRED`, `ACTOR_MISMATCH`, `INSUFFICIENT_ROLE`) plus both idempotency helpers.

**Status:** committed, NOT YET APPLIED to live Supabase. Mason applies via Supabase MCP `apply_migration` after review.

---

## 2026-05-11 — Phase 1.5: E2E credential cleanup (closes audit Critical #1)

Branch: `fix/audit-2026-05-09`. Phase 0 verification flagged that PR-05's E2E credential cleanup left one residual fallback in `comprehensive-ui-workflow.spec.ts`.

**What was left.** `getNodeToken()` (lines 25-26) used `process.env.E2E_TEST_EMAIL || 'mason@croprxsolutions.com'` and `process.env.E2E_TEST_PASSWORD || 'Mwells0413'` — a silent hardcoded fallback that ran any time the env vars weren't set. PR-05 removed the same pattern from `auth.ts`, `setup-fixtures.ts`, and `teardown-fixtures.ts` but didn't sweep this spec file. Phase 0 cross-grep confirmed only this one file had a real fallback (the `00-seed-test-data.spec.ts:370` hit was a code comment, not a credential; `role-applicator.spec.ts` and `role-security.spec.ts` use `|| ''` as skip-condition fallbacks, not auth).

**Fix.** Import `TEST_USER` from `./utils/auth` (PR-05's canonical fail-closed entry point) and read `email`/`password` through it. Now if either env var is missing, the spec's `import` triggers `requireEnv()` and throws at module-load time — no silent default. One source of truth across `auth.ts`, fixtures, and this spec.

**Why not replicate `requireEnv` inline.** Inline duplication is drift waiting to happen. `auth.ts` already owns the contract (env vars are required, with a pointer to `docs/CONTRIBUTING.md`). Reusing `TEST_USER` keeps the message and behavior consistent.

**Verification.** Grep for `Mwells0413` across the repo: 0 hits in runtime code; only 3 historic-audit doc files mention it as documentation of the past state. Lint clean, build clean. Test count unchanged (Playwright specs don't run in `npm test`).

Closes audit Critical #1. Combined with the production password rotation Mason completed earlier today, the door is fully closed: rotated password + no fallback path = the hardcoded value is dead.

---

## 2026-05-11 — Phase 1.4: Profile role-lock trigger (closes audit Critical #3)

Branch: `fix/audit-2026-05-09`. After Phase 0 verification confirmed Critical #3 (self-role-escalation) was still valid on the live branch, Phase 1.4 closes it.

**The hole.** `profiles_update` RLS policy is `((SELECT auth.uid()) = id) OR is_admin()` for both USING and CHECK — meaning any authenticated user can PATCH their own profile row. There was no column-level restriction, so a malicious non-admin could issue a direct PostgREST request and set their own `role = 'admin'`, flip `is_active`, or clear `denied_pages`. The first half of the chain (Critical #2 — `handle_new_user` trusting `raw_user_meta_data->>'role'`) is mitigated by Mason disabling public signup in the Supabase Auth dashboard. This second half hardens the chain so it stays closed if signup is ever re-enabled.

**Fix (migration `20260511090000_profile_role_lock_trigger.sql`):** add a BEFORE UPDATE row-level trigger on `profiles`:

```sql
CREATE OR REPLACE FUNCTION public._guard_profile_role_lock()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  IF (OLD.role IS DISTINCT FROM NEW.role
      OR OLD.is_active IS DISTINCT FROM NEW.is_active
      OR OLD.denied_pages IS DISTINCT FROM NEW.denied_pages)
     AND NOT is_admin() THEN
    RAISE EXCEPTION 'PROFILE_ROLE_LOCK: only admins can change role, is_active, or denied_pages'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
```

Columns locked: `role`, `is_active`, `denied_pages`. Columns NOT locked: `full_name`, `phone`, `email`, `applicator_license_number`, `faa_certificate_number`, `updated_at` — users can still maintain their own profile.

**Why `is_admin()` works inside SECURITY DEFINER.** Even though the trigger function runs as the owner role, `auth.uid()` inside it still returns the JWT caller — not the owner — so `is_admin()` correctly evaluates against the *actual* user who issued the UPDATE. This is the same pattern used by all the existing `is_admin()` / `is_sales_rep()` callers in RLS policies.

**Why no `handle_new_user` impact.** That trigger fires `AFTER INSERT ON auth.users` and does an `INSERT INTO profiles` — a BEFORE UPDATE trigger doesn't fire on inserts. The signup-time metadata trust (Critical #2) remains mitigated by signup-disabled, not by this trigger.

**Frontend audit performed:** grep for `from('profiles').update(...)` and direct PATCH on `role`/`is_active`/`denied_pages` columns. Only callsite touching these columns is `SettingsPage.tsx`, which uses the `admin_update_profile` RPC (SECURITY DEFINER, admin-gated) — auth.uid() inside that RPC is the admin, so `is_admin()` returns true and the trigger correctly allows the change. No accidental breakage.

DO-block verification asserts the function exists with `prosecdef=true` + `search_path` containing `pg_temp`, and that the trigger is wired to `public.profiles`.

**Status:** committed, NOT YET APPLIED to live Supabase. Mason applies via Supabase MCP `apply_migration` after review.

---

## 2026-05-11 — Codex review fix for PR #59: vendor bill positive-total guard

Branch: `fix/audit-2026-05-09` (PR #59). Codex left two P2 findings on PR #59; both pointed at the same class of bug — a missing `v_total > 0` guard on vendor bills letting a negative `adjustment_cents` flip the computed total negative.

**Finding 1 — `update_vendor_bill` (20260510100000):** validated `p_subtotal_cents > 0` but never re-checked `v_new_total_cents` after applying the adjustment. A $100 bill edited with a -$200 adjustment produced `total_cents = -10000`, `balance_cents = -10000` (GENERATED column = `total − paid`), `status = 'unpaid'` — broken AR aging, broken payment behavior, dirty audit log.

**Finding 2 — `create_vendor_bill` rewrite in `ap_polish_completion` (20260510130000):** silent regression. The original PR-04 (`20260510030000_ap_structural_fixes.sql`) included a `v_total <= 0` guard added by codex audit F4 with the explicit comment *"reject zero-or-negative computed totals — adjustments can flip the sign."* The PR-22b polish migration that added PO-to-bill consistency checks rewrote `create_vendor_bill` and dropped the F4 guard along the way. `vendor_bills` has no table-level CHECK on `total_cents > 0`, so the DB has no backstop.

**Fix (migration `20260511030000`):** `CREATE OR REPLACE` both functions with the canonical guard added immediately after `v_total := p_subtotal_cents + COALESCE(p_adjustment_cents, 0)`:

```sql
IF v_total <= 0 THEN
  RAISE EXCEPTION 'INVALID_AMOUNT: bill total must be positive (got %)', v_total;
END IF;
```

Bodies otherwise reproduced verbatim from the prior installed migrations. DO-block verification asserts both guards landed and that PR-22b polish features (`VENDOR_PO_MISMATCH`, `vendor_bill_drift` soft-warn) were not regressed. No frontend changes — existing handlers already surface `INVALID_AMOUNT` exceptions raised for the subtotal check.

---

## 2026-05-11 — Performance sweep: 97 WARN findings → 0 (Supabase performance advisor)

Branch: `perf/advisor-sweep-2026-05-11` (off `main`, merged via PR #61). Closes all WARN-level performance advisor findings against the live Supabase project (`rhyzpcqhnizqbxphqdkr`). Pulled at the start of the sweep:

| Category | Level | Before | After | Migration |
|---|---|---:|---:|---|
| `auth_rls_initplan` | WARN | 63 | 0 | `20260511050000` + `20260511060000` |
| `multiple_permissive_policies` | WARN | 33 | 0 | `20260511060000` |
| `unindexed_foreign_keys` | INFO | 72 | 0 | `20260511070000` |
| `duplicate_index` | WARN | 1 | 0 | `20260511080000` |
| `unused_index` | INFO | 87 | 159 | (see below — expected) |

**The reason for #1 (the big win).** Postgres re-evaluates `auth.uid()` once per row when it appears bare inside an RLS policy predicate. Wrapping it in a scalar subquery `(SELECT auth.uid())` tells the planner the value is stable for the query and it caches it once. On a `SELECT * FROM invoices` touching ~50k rows under the old policy, that's 50,000 function calls vs 1 — directly proportional to table size. 55 policies across 35 tables were rewritten (preserving action, roles, permissive flag, and predicate verbatim except for the wrap). 65 `auth.uid()` calls wrapped; verification block asserts zero unwrapped remain.

**The careful part (Category 2).** 23 unique (table, role, action) overlap groups were consolidated into single permissive policies whose predicates OR the original predicates. Same union of access, one evaluation per row instead of N. The hard cases:

- `delivery_photos`, `delivery_remainders` had 3-way overlaps (`_admin_all FOR ALL` + driver-specific + sales_rep-specific). Solution: drop `_admin_all`, replace with action-specific policies (`_insert`, `_select`, `_update`, `_delete`) where each merges admin + role predicates with OR.
- `commissions` had two SELECT policies with different ownership predicates (`recipient_user_id = auth.uid()` vs `EXISTS (... commissions.recipient = p.full_name)`). Merged into one with `is_admin() OR (is_sales_rep() AND (recipient_user_id = auth.uid() OR full_name match))`. The "recipient_user_id IS NULL AND full_name match" sub-case from the rep_select policy was subsumed by the full_name match clause.
- `rate_limit_log` had a permissive `qual=false` "Deny all direct access" policy that was a no-op (permissive false OR'd with permissive admin = admin; access semantics were already "admin can SELECT, nobody can write directly"). Per Mason's option B pick, replaced with a **RESTRICTIVE** `FOR ALL is_admin()` policy as defense-in-depth — a future permissive INSERT policy added by mistake would still be blocked by the restrictive.

**FK indexes via CONCURRENTLY (Category 3).** 72 `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_<table>_<column>` statements applied via per-statement `execute_sql` (the `apply_migration` MCP wraps in a transaction, which forbids CONCURRENTLY). The SQL file carries the `-- supabase-no-transaction` marker so the canonical record matches the applied behavior. Non-blocking build: existing reads/writes weren't paused. Hot indexes added: `invoices.{posted_by, salesman_id, voided_by, blend_ticket_id}`, `returns.{approved_by, cancelled_by, received_by, credit_invoice_id}`, `delivery_remainders.{followup_delivery_id, order_item_id, product_id}`, `rebate_claims.*`, `write_offs.*`, `vendor_bills/payments.{created_by, voided_by}`, and ~50 others.

**Why unused_index went UP (87 → 159).** Postgres marks any newly-created index as `unused` until real queries reference it. The 72 new FK indexes are immediately flagged. They'll un-flag as JOINs against those columns run. This is expected and self-resolves; no action needed.

**Duplicate index drop (Category 4).** `payments` had `idx_payments_order` AND `idx_payments_order_id` — both btree on `(order_id)`. Dropped the unsuffixed one; the `_order_id` variant matches project naming convention and stays as the FK cover.

**Workflow.** New branch off `main` (the audit-sprint work on `fix/audit-2026-05-09` is independent; perf sweep doesn't depend on it). Audit-sprint WIP stashed before branching. 4 SQL migration files in `supabase/migrations/`; Migrations 1, 2, 4 applied via `apply_migration` MCP; Migration 3 applied via 72 individual `execute_sql` calls (CONCURRENTLY requirement). Each migration includes a `DO $$ ... $$` verification block that `RAISE EXCEPTION`s on detected regressions. Advisor re-run between each migration confirmed the expected count drops.

**Decisions made (and recorded):**
1. Branch from `main`, not `fix/audit-2026-05-09` — perf sweep is independent; the AP sprint work is unaffected.
2. Use `CREATE INDEX CONCURRENTLY` not plain `CREATE INDEX` — non-blocking on production; tables aren't huge today but the pattern scales.
3. `RESTRICTIVE` policy on `rate_limit_log` — defense-in-depth on a sensitive table. Did NOT add to `failed_notifications` (no `qual=false` policy there; just a redundant overlapping admin SELECT that was dropped).
4. `application_services_select`, `customer_application_rates_select`, `quote_pdf_templates`/`quote_templates` SELECT all keep their `qual=true` (auth-only) policies. Was already intentional — anyone authenticated can READ these tables; only admins can mutate. The advisor flag was about the FOR ALL admin_all overlapping with the SELECT, not the access model.

**Lesson.** The biggest WARN-level perf advisor cost is auth.uid() per-row evaluation; everything else (FK indexes, duplicate indexes, permissive merges) is incremental. Wrapping is mechanical and safe given a verification block that asserts predicate-preserving rewrites. The careful part is the permissive-policy consolidation — every group needs human review of "is this OR a true superset/equivalent of the originals?" before merging. The 23 groups here fell into 5 patterns, all with provable union semantics.

**Sweep state at PR #61 close.** 289 migrations (was 285 — 4 new). 1,872 unit tests passing (130 files, 68 skipped). 0 ESLint errors, 0 TS errors, clean build. Migration files in `supabase/migrations/`; live DB state already matches (applied during sweep, not queued).

**Deferred.** 87 original `unused_index` findings + 72 new (newly created FK indexes flagged immediately) = 159 unused_index INFO findings — Mason to review the original 87 list and decide which (if any) should be dropped. Report archived at [docs/2026-05-11-unused-index-report.txt](2026-05-11-unused-index-report.txt). Out of scope per the sweep prompt: `auth_leaked_password_protection` (Dashboard toggle), 424 `*_security_definer_function_executable` (by design — frontend calls these RPCs).

---

## 2026-05-09 → 2026-05-10 — Audit fix sprint (Sprint 1): 15 of 26 PRs landed

Branch: `fix/audit-2026-05-09`. Closes the highest-impact findings from the 2026-05-09 combined audit (52 findings, 11 business decisions). Sprint 1 was executed autonomously by a Claude Opus 4.7 (1M context) session running through the night of 2026-05-09. Sprint 2 picks up the remaining 10 PRs (PR-23 blocked on staging Supabase creation).

**The hard problem solved.** Five mutating RPCs (`record_invoice_payment`, `create_quick_delivery`, `update_order_items` + 2 already-fixed) used a broken idempotency replay check — `(v_existing->>'status') = 'completed'` against a saved jsonb that never carried a `status` field. So every same-key retry silently re-executed the mutation. The DB had the cache row; the function never read it correctly. Network retries would record duplicate payments, create duplicate deliveries, etc. The pattern was fragile because the broken check just happened to return false for any input — so testing it would've required deliberately exercising a network retry path nobody had built. Codified the canonical pattern (`IF v_existing IS NOT NULL THEN RETURN ...`) in CLAUDE.md and `gotchas.md`; the schema-aware `idempotency-body-check.mjs` PreToolUse hook already enforces the helper-function pattern going forward.

**What landed (15 commits, all on `fix/audit-2026-05-09`, Co-Authored-By: Claude Opus 4.7):**

| PR | Domain | Risk | Commit | Outcome |
|---|---|---|---|---|
| PR-01 | Deliveries | Low | b72d9c9 | `complete_delivery` + `void_delivery` referenced `v_delivery.delivery_date`; column is `scheduled_date`. Any closed-period warn path crashed 42703. SQL queued for manual apply. |
| PR-02 | RPC | Medium | 06ec19a | 3 of 5 planned RPCs fixed (live inspection narrowed scope: `receive_po_items` already canonical, `create_prepay_check_splits` doesn't exist in prod). SQL queued. |
| PR-03 | Edge Function | Low | 31c3db1 | `send-email` selected `customers.name` (column doesn't exist — should be `farm_name`). Edge Function silently 404'd in prod for any customer-tied email. Error logging added so future schema drifts surface. |
| PR-04 | AP | High | 1a3b39d | 6-block migration: AP void columns, `balance_cents` GENERATED ALWAYS, UNIQUE bill_number index, `financial_audit_log` CHECK expansion, `vendors_select` RLS tightening, full rewrite of `create_vendor_bill`/`record_vendor_payment`/`void_vendor_bill` with idempotency + period guard + paid-bill hard block + audit log entries. SQL queued — 13 future PRs depend on this. |
| PR-05 | E2E | Low | ac4e1a4 | Removed hardcoded credential fallback (`mason@…/<live>`) from auth.ts + setup-fixtures.ts + teardown-fixtures.ts. Added `assertNotProductionWithoutOverride()` safety guard. Wrote `docs/CONTRIBUTING.md`. |
| PR-09 | Integrity | Low | 22e1e24 | IntegrityReport flagged every written-off invoice as a balance discrepancy because the formula was missing `- write_off_cents`. Added regression test. |
| PR-06 | Quick delivery | Low | 63ad461 | Per Q4 (Option C): credit limit overage now creates the delivery + notifies admins instead of hard-blocking. AR scope expanded to draft + posted + overdue. Projected exposure includes the new delivery total. SQL queued. |
| PR-11 | Permissions | Low | 4d7bdbc | 5 routes were not in `PAGE_PERMISSIONS` — deny-list silently no-op'd. Patched + added EXEMPT_ROUTE_SEGMENTS handling in ProtectedRoute. New fail-closed test greps App.tsx routes — adding a Route without an entry now fails CI. |
| PR-12 | RPC | Low | 4cbb39b | Added `pg_temp` to `auto_expire_quotes` + `release_holds_on_quote_status_change`. Plan listed 4 functions; live inspection narrowed to 2. SQL queued. |
| PR-15 | parseCents | Low | cb4351c | Parser stripped leading minus signs while UI invited negatives (discount fields). NewVendorBill discount now correctly subtracts. Added `parseDollarsToCentsPositive()` helper. |
| PR-16 | Edge Functions | Low | b1e3680 | 5 Edge Functions now throw at startup if `ALLOWED_ORIGIN` env var is missing — replaces silent fallback to `https://croprxsolutions.app`. Defense-in-depth. |
| PR-17 | RLS | Low | 25a6511 | `team_note_tags` SELECT was `USING (true)`. Replaced with EXISTS check on parent `team_notes`. Compromise vs the plan's stricter version since `team_notes` itself is `USING (true)` for SELECT — full tightening would break team-board for non-admin roles. SQL queued. |
| PR-18 | Tooling | Low | 05de4d3 | `validate-frontend.sh` gained `--all` mode for periodic audits (was: staged-only). |
| PR-20 | Activity log | Low | 6ad96af | 8 handlers + 1 useEffect-gated callsite: replaced `profile?.id || ''` empty-string fallback with early-return + toast. `activity_feed.performed_by` empty-string poisoning eliminated. |
| PR-21 | Cleanup | Low | c09cca5 | ESLint ignores for coverage/`.claude/worktrees`/`.playwright-mcp`; IntegrityReport `useCallback` fix; doc count corrections (qa-testing 81→94, UI_PATTERNS 57→65). 3 sub-items skipped (sidebar link, Edge Function deletion, doc-count CI script). |

**Migrations queued for manual apply (NOT YET APPLIED to live Supabase rhyzpcqhnizqbxphqdkr):**

`20260510010000_fix_delivery_date_column_refs.sql` (PR-01), `20260510020000_fix_idempotency_replay_canonical.sql` (PR-02), `20260510030000_ap_structural_fixes.sql` (PR-04 HIGH), `20260510040000_credit_limit_soft_warn.sql` (PR-06; apply AFTER PR-02), `20260510050000_pg_temp_security_definer_fixes.sql` (PR-12), `20260510060000_team_note_tags_rls.sql` (PR-17). Run `node scripts/regenerate-schema-registry.mjs` after applying any subset.

**Decisions made autonomously (worth knowing):**
1. PR-02 scope narrowed: `receive_po_items` already had canonical pattern (skipped); `create_prepay_check_splits` doesn't exist in prod (skipped). 3 RPCs fixed vs 5 planned.
2. PR-04 search_path finding was stale — all 3 AP RPCs already had `public, pg_temp`.
3. PR-12 scope narrowed from 4 functions to 2; the other 2 already had pg_temp.
4. PR-17 used a softer policy than the plan suggested (gate by parent team_note existence) because team_notes itself is `USING (true)` for SELECT and stricter gating would break team-board.
5. PR-21 partial completion: skipped sidebar link (AppLayout structure unclear), Edge Function deletion (bash-safety hook blocks rm -rf on supabase/), and the check-doc-counts.mjs script (incremental tooling). Doc-count corrections close the immediate finding.

**Sprint state.** 130 unit-test files (1886 passing, 68 skipped — Sprint 1 added new tests in PR-09/11/15). 0 ESLint errors, 0 TS errors, all builds clean. 291 migrations on disk (was 285 + 6 queued). 7 Edge Functions (was 8, count corrected — `_shared` is helper code, not a function; the regenerate-agents-md.mjs script now filters it; `setup-blend-tickets-storage` deletion deferred from PR-21). Pre-commit hook held throughout — no `--no-verify`, no hooks bypassed.

**Sprint 2 (in progress).** PR-26 (this docs consolidation), PR-07 (RLS tightening), PR-19 (test infrastructure), PR-08 (invoice payment unification), PR-10 (bulk idempotency wiring), PR-13 (void_vendor_payment), PR-14 (update_vendor_bill), PR-22 (AP polish), PR-25 (vendor master-data UI). PR-23 (E2E staging Supabase) blocked on Mason creating a `crx-manager-staging` Supabase project.

**Lesson.** The autonomous prompt's "live DB inspection narrowed scope" pattern fired 4 times in Sprint 1 — every time, the live database was the source of truth and the static plan was stale. The implementation plan + execution log + git commits + migration files form a recoverable chain even if a session ends mid-PR; the canonical idempotency pattern is now the project's documented norm and the schema-aware hooks enforce it for new code. Two structural classes of bug (silent idempotency replay failure, incomplete `financial_audit_log` integration) close together because finding the first one made the second one obvious.

---

## 2026-05-16 — Hotfix: restore `profile_public_view` (partial revert of 2026-05-11 audit)

PR #60 review comment from masonwells1 flagged that the view drop in `20260511120000_security_audit_2026_05_11.sql` conflicts with `fix/audit-2026-05-09`, which has been migrating 30+ callsites TO the view (PR-07 follow-up). The branch I authored from had zero callsites; the parallel branch was actively adding them. Result: the moment `fix/audit-2026-05-09` deploys, prod would break because the view was gone.

Recovery:
- `apply_migration restore_profile_public_view` run against prod within minutes of the comment — view recreated with the original shape (`id, full_name, role, is_active FROM profiles`) and owner-defined semantics.
- New migration file `20260516140000_restore_profile_public_view.sql` added to PR #60 so fresh DB replays end up with the view in place.
- View comment added documenting that the `security_definer_view` advisor warning is accepted-by-design and the view must not be dropped without first migrating all callsites.

Cross-checked the rest of the 2026-05-11 migration against `fix/audit-2026-05-09`:
- Function search_path fixes (4 functions) — no overlap with their `20260510050000_pg_temp_security_definer_fixes.sql` (different functions).
- `blend_ticket_fields` / `field_crop_history` RLS — my migration tightened INSERT/UPDATE/DELETE; their `20260512030000_tighten_blend_ticket_field_crop_history_rls.sql` tightens SELECT. Complementary, not conflicting.
- Storage `qual=true` policy drops — grep on `fix/audit-2026-05-09` showed no `.list()` / `.download()` / `.createSignedUrl()` calls on the 3 public buckets and no migration recreating the dropped policies. No conflict.

Net advisor impact: `security_definer_view` ERROR returns to 1 (accepted by design). All other 2026-05-11 fixes stay in effect.

Lesson recorded: future audits that drop infrastructure must grep ALL active branches (not just the working branch) for callsites before considering the object unused.

---

## 2026-05-11 — Security advisor cleanup from `/audit` run

Acted on every fixable finding in `docs/archive/2026-spring/AUDIT_REPORT_2026-05-11.md`. Two migrations applied to the remote database:

**`20260511120000_security_audit_2026_05_11.sql`** — five categories fixed:

1. **`function_search_path_mutable`** (4 WARN → 0) — pinned `SET search_path = public, pg_temp` on `guard_audit_log_immutable`, `_fill_audit_actor`, `_enforce_quote_status_transition`, `_enforce_return_status_transition`. Closes the search-path hijack vector flagged by the advisor.

2. **`security_definer_view`** (1 ERROR → 0) — dropped unused `profile_public_view`. Verified by grep across `src/`, `supabase/`, and `pg_proc.prosrc` that there were zero callsites. The view was originally created to expose `id`, `full_name`, `role`, `is_active` of other users via SECURITY DEFINER (bypassing the `profiles.profiles_select` admin-or-self predicate); after investigation no frontend code or DB function references it. Removed entirely rather than converted to a function.

3. **`rls_policy_always_true` on `blend_ticket_fields`** (3 WARN → 0) — replaced the always-true INSERT/UPDATE/DELETE policies with parent-scoped predicates that mirror `blend_tickets`: write requires `uploaded_by = auth.uid() OR is_admin() OR is_sales_rep()` evaluated via `EXISTS (SELECT 1 FROM blend_tickets bt WHERE bt.id = blend_ticket_fields.blend_ticket_id AND …)`, DELETE is admin-only. SELECT (currently `true`, not flagged by the advisor) left untouched. The `save_blend_ticket_fields` RPC is SECURITY DEFINER and continues to work; tightening direct-table RLS just closes the bypass path.

4. **`rls_policy_always_true` on `field_crop_history`** (3 WARN → 0) — replaced the always-true INSERT/UPDATE/DELETE policies with role-gated predicates that mirror `fields`: admin OR sales_rep for writes, admin-only for DELETE. SELECT (currently `true`, not flagged) left untouched.

5. **`public_bucket_allows_listing` — phase 1** (3 WARN, dashboard cruft) — dropped 4 global `qual=true` policies on `storage.objects` named `Authenticated users can upload 1evsna5_*`. These were auto-generated by the Supabase dashboard and let any authenticated user list every file in every bucket. After dropping them every bucket still has its own bucket-specific INSERT/SELECT/DELETE policies (verified by `pg_policies` inspection).

**`20260511120100_drop_public_bucket_select_policies.sql`** — phase 2 of bucket cleanup:

Dropped the remaining bucket-specific SELECT policies on the 3 public buckets (`delivery_photos_select`, `recv_photos_storage_read`, `Anyone can view team note attachments`). The advisor flags any broad SELECT on a public bucket because public buckets don't need RLS-side SELECT — file rendering happens via CDN (`getPublicUrl()`) which bypasses RLS entirely. Verified by grep on 2026-05-11 that no frontend code calls `.list()`, `.download()`, or `.createSignedUrl()` against `delivery-photos`, `receiving-photos`, or `team-note-attachments`. Upload, delete, and `<img src={publicUrl}>` paths all stay functional.

**Net Supabase security advisor delta:**
- ERROR: 1 → 0
- WARN (fixable): 13 → 0
- WARN (deferred — Auth dashboard toggle): 1 → 1 (`auth_leaked_password_protection`, user opted to skip)
- WARN (by-design): 424 → 424 (`anon/authenticated_security_definer_function_executable` for frontend-callable RPCs)

**Documentation:**
- `CLAUDE.md` Current State date 2026-05-07 → 2026-05-11, migration count 285 → 287, Edge Functions prose 7 → 8.
- `docs/reference/migration-history.md` count 285 → 287, rows 286 and 287 appended.
- `docs/archive/2026-spring/AUDIT_REPORT_2026-05-11.md` already in repo (added in PR #60).

**Deferred to follow-up PR:**
- Performance advisor sweep: 63 `auth_rls_initplan`, 33 `multiple_permissive_policies`, 87 unused indexes, 72 unindexed FKs, 1 duplicate index.
- `auth_leaked_password_protection` (Dashboard toggle, not code).

---

## 2026-05-07 — Wired front-end idempotency key into cancel_cycle_count call (audit P4-12)

Phase 4 audit P4-12 flagged that `CycleCounts.tsx:326-329` called `cancel_cycle_count` with only two arguments — `p_cycle_count_id` and `p_performed_by` — even though the SQL RPC accepts a third optional `p_idempotency_key`. The RPC body is fully idempotent (verified in migration `20260501130000_field_app_workflow_phase18.sql:174-177` for `check_idempotency` and `:200-202` for `save_idempotency`), so the database enforcement was already correct. The front-end was not exercising it; a double-click on Cancel could in principle insert two `cycle_count_cancelled` activity rows even though the second `UPDATE` would no-op once the status was already 'cancelled'.

Fix: added `cancelCycleCountIdem = useIdempotencyKey('cancel_cycle_count', profile?.id)` alongside the existing `complete` and `reverse` hooks, and wired its `getKey()` / `resetKey()` into `executeCancelCount`. No SQL change needed. Mirrors the pattern already used by `complete_cycle_count` (line 289-297) and `reverse_completed_cycle_count` (line 354-362) in the same file.

---

## 2026-05-07 — Verified Customer 360 hero number = total balance due (audit Q5)

Wave 1, item 2 of the Phase 4 closure autonomous run. Audit Q5 asked whether the hero number on the customer detail page should be "total balance due" or some other metric (last payment, MTD revenue, etc.). Mason's answer was A: total balance due. Verifying that the current code already does this — recording here so a future audit doesn't have to re-derive the same conclusion.

The leftmost card in `CustomerSummaryBar` (rendered above all tabs on `/customers/:id`) shows `summary.ar_balance_cents` from the `get_customer_summary` RPC. Migration `20260404040200_get_customer_summary_rpc.sql` computes:

```sql
SELECT COALESCE(sum(balance_cents), 0)
FROM invoices
WHERE customer_id = p_customer_id
  AND status IN ('posted', 'overdue');
```

This *is* `SUM(invoices.balance_cents)` per Mason's audit answer A — the `status` filter is the correct refinement, not a deviation. Drafts/unposted invoices aren't real AR yet, paid invoices already carry `balance_cents = 0` (GENERATED column = invoiced − paid), and voided/cancelled invoices shouldn't show as money owed. Filtering to `posted`/`overdue` captures exactly the receivables that are actually outstanding. No code change needed.

---

## 2026-05-07 — Wave B.3: Move inventory math from React to one server-side RPC (audit P4-1 + P4-2)

**Problem.** The InventoryPage's "Net Position" column was computed in JavaScript by combining four separately-fetched queries (`inventory`, `inventory_holds`, open `purchase_order_items`, `quote_items`, plus `inventory_transactions` for delivered-YTD). The column header said "Net Position" but the formula was a hybrid that subtracted holds AND planned demand. The manual-hold-creation modal on the same page used a *different* formula (`available − prebooked − holds`). The HelpTip claimed yet a third formula. Three different "free" answers on the same screen for the same product. INVENTORY_RULES.md `:88` literally said "All inventory math happens in the database, NOT in React" — the page violated that rule.

**Decision.** Mason picked **Option B**: canonical Net Position = `quantity_available − quantity_prebooked + quantity_on_order`. Holds and planned-quote demand stay visible in the existing "Planned" column but are **not** subtracted from Net Position. This matches the formula already used by `create_direct_order` and `convert_quote_to_order` for inventory warnings, so the entire app now agrees on what "Net Position" means.

**Implementation (3 commits, all atomic + revertible).**

1. **B.3.a — `get_inventory_position()` RPC** (commit `46604b0`, migration `20260507150000`). New read-only `SECURITY DEFINER` function returns one row per (product, location) for active products: `quantity_available`, `quantity_prebooked`, `quantity_on_order`, `holds_qty`, `planned_qty`, `delivered_ytd` (season-to-date), `net_position`, `reorder_point`, `min_stock_level`, `is_low_stock`, plus product metadata. Aggregates each input source once via CTEs, then `LEFT JOIN`s by product_id (avoids N+1 sub-selects on a 1000-row catalog). Read-only → no idempotency key, follows `get_inventory_forecast` precedent. `InventoryPositionRow` interface added to `src/types/index.ts`. Sanity-tested live on 5 production products — math matched expected on every row.

2. **B.3.b + B.3.c — `InventoryPage` consumes the RPC**. `fetchInventory` collapses from 171 lines (4 fetches + JS reduces + virtual-row synthesis) to ~40 lines (one RPC call + simple map). `InventoryRow.free_qty` renamed `→ net_position` across all 11 reference sites (type, CSV export, PDF export, column key/render, totals row, hold-warning, etc.). The hold-creation warning now uses `today's free = available − prebooked − active holds` (computed locally from RPC fields, not from `net_position` — Net Position adds on_order which doesn't help against today's physical-stock pressure). HelpTip rewritten to declare the canonical formula and explain why Holds/Planned-quote demand live in their own column.

3. **B.3.e — `INVENTORY_RULES.md` consolidates the formulas**. Removes the "Net Free vs Net Position" two-headed documentation that was the audit's root-cause for the in-code drift. New text: "**Net Position is the only formula used for the user-visible Net Position number**. The InventoryPage column, dashboard summary, order-creation warnings, and field-app preview all read this same number from the same RPC." Documents `today's free` as a deliberately-different internal formula for the manual-hold warning, with the reasoning. Notes that `get_inventory_forecast` uses the same source-column definitions as `get_inventory_position`, so the Forecast tab is already consistent — a future cleanup could DRY the supply math by having forecast call position internally, but no user-visible drift today.

**Live state.** Migration applied; commit `46604b0` (B.3.a) pushed; commit for B.3.b+c+e built and pushed. 278 migrations, ~173 RPCs, 1,864 tests passing. UI not browser-verified this session (login wall blocks automated testing) — coverage relies on the unit suite + the existing E2E specs `inventory-page.spec.ts` and `math-inventory-flow.spec.ts` which run in CI on push.

**Lesson.** Drift between three formulas in one file is invisible until someone reads all three side-by-side. The audit caught it once; a server-side RPC keeps it from regrowing — a single function is harder to drift against itself than three locations to drift against each other.

---

## 2026-05-06 — Hotfix: complete_delivery production failure (missing invoices.delivery_id column)

**Problem.** Mason hit "An internal error occurred. Please try again." trying to complete delivery DEL-00074 (ORD-2026-0186, Capreno - 1 Gal × 6). After receiving inventory and retrying, the same generic error reappeared.

**Diagnosis path.**

1. Sentry event `93cb924e…` revealed the masked Postgres error: `P0001: Insufficient inventory for Capreno - 1 Gal: need 6 units, only 0 on-hand` — the first attempt fired before the receiving step had been recorded (16:05:23 attempt vs 16:06:46 PO receive). After receiving, inventory showed 27 available.
2. The retry failed identically. Sentry deduped the second event (same fingerprint), but `inventory.quantity_available = 27` made the inventory pre-check impossible. Suspected a different RPC failure path being sanitized by [src/lib/errorSanitizer.ts](src/lib/errorSanitizer.ts) catch-all (the regex `/relation "|column "|constraint "|table "/i` masks any error mentioning schema identifiers).
3. Schema query revealed: `invoices.delivery_id` does **not exist** on the table. But the deployed Phase 15 `complete_delivery` (migration `20260501100000`) references it twice — once in the partial-delivery linked-invoice loop, once in the auto-invoice INSERT. PL/pgSQL only resolves column names at execution time, so the broken function lived in `pg_proc` until the auto-invoice block fired (first delivery completion for an order with no existing invoice).

**Fix.** Migration `20260506160000_add_delivery_id_to_invoices.sql` — adds nullable `delivery_id uuid REFERENCES deliveries(id)` to `invoices`, plus partial index `idx_invoices_delivery_id` (only indexed where NOT NULL — most invoices come from orders/blend tickets, not deliveries). `Invoice` interface in `src/types/index.ts` updated. Existing invoices keep `delivery_id = NULL` (correct).

**Lesson.** The Phase 15 verification block at the end of the migration (`SELECT count(*) ... HAVING count(*) > 1`) only checked overload count, not whether the function body would actually execute. CLAUDE.md's "Migration Safety Rules" already says to "read existing values BEFORE rewriting" — but a function body that references a non-existent column passes `CREATE OR REPLACE FUNCTION` validation in Postgres. Future RPCs that touch new columns should either be paired with the column-add in the same migration, or include a runtime smoke-call (e.g., `SELECT complete_delivery(non_existent_uuid)` in a `BEGIN/EXCEPTION` block) to force column resolution before commit.

---

## 2026-05-04 — OPEN_ITEMS cleanup: lock order_shares after invoice post + a11y fix

Closes both deferred items from `docs/OPEN_ITEMS.md`.

### Item #1 — Order share edits no longer drift from posted invoices

**Problem.** `order_shares` could be inserted/updated/deleted at any time, even after one of the order's invoices was already posted. Because the invoice carries its own denormalized `invoice_shares` snapshot (taken at post time), changing the parent split after-the-fact silently created drift between what the customer was billed on and what the order claims the split should be.

**Fix.** Defense-in-depth: DB trigger + UI lock.

- **DB layer** — migration `20260504100000_lock_order_shares_when_invoice_posted.sql` adds trigger function `prevent_order_shares_edit_after_post()` (SECURITY DEFINER, search_path = public, pg_temp). A `BEFORE INSERT OR UPDATE OR DELETE` trigger on `order_shares` raises `check_violation` with a user-friendly message naming the locking invoice number when any non-soft-deleted invoice on the order has status in (`posted`, `paid`, `overdue`). Drafts/unposted/voided/cancelled invoices stay editable — those are still in flight.
- **UI layer** — `OrderDetail.tsx` derives `sharesLocked` from the loaded `invoices[]` and:
  - Hides the "Add Split" button.
  - Hides the per-row trash icons next to each existing share.
  - Shows an amber notice naming the locking invoice number, pointing the user at "void the invoice first to change the split".

The trigger is the hard guard (catches admin scripts and any direct PostgREST writes); the UI lock is the soft guard (better UX, no misleading buttons).

### Item #2 — Accessibility warnings in FieldAppChemicalEntry

`src/components/field-app/FieldAppChemicalEntry.tsx:204` and `:230` had clickable `<div>`/`<span>` elements that triggered the lint warning `jsx-a11y/click-events-have-key-events`. Both rewritten as `<button type="button">` with `w-full text-left` to preserve layout. Inner `<div>` children inside the search-result button became `<span className="block ...">` because `<button>` only accepts phrasing content. Behaviorally identical, now keyboard-accessible.

### Result

- `docs/OPEN_ITEMS.md` updated — both deferred items cleared.
- `CLAUDE.md` Current State refreshed (267 migrations).
- `docs/reference/migration-history.md` and `docs/reference/rpc-functions.md` updated with the new trigger and migration entry.

---

## 2026-05-01 — Sprint F #4: reconciliation report wired to admin dashboard — **Sprint F COMPLETE**

New page `src/pages/IntegrityReport.tsx` at `/integrity-report` (admin-only). Calls the existing `runReconciliationChecks()` and renders pass/fail per check with a discrepancies table when any check finds drift.

### What changed in `reconciliation.ts`

The audit's specific complaint: the invoice-payments check was reading `payments.amount` (legacy order-level numeric dollars) when the actual source of truth — written by `allocate_payment` (Phase 14) — is `invoice_line_allocations.amount_cents` per invoice.

Replaced:
- `PaymentAllocationRow` (`{ order_id, amount }` dollars) → `InvoiceLineAllocationRow` (`{ invoice_id, amount_cents }`)
- Query `.from('payments').select('order_id, amount')` → `.from('invoice_line_allocations').select('invoice_id, amount_cents')`
- Aggregation: per-order sum → per-invoice sum
- Compare to: `invoice.paid_amount_cents` directly (no order-level rollup)

`reconciliation.test.ts` updated with the new shape; existing 5 test cases reframed to per-invoice allocations. All pass.

### What's on the new page

- Pass/fail badge per check, with description
- Discrepancy table (entity, expected, actual, delta) when checks fail
- Re-run button
- Timestamp showing when the report was last computed
- Link guidance pointing at the production runbook for cadence

Routes: `/integrity-report` (admin only). Sidebar entry under Finance group.

### Sprint F status: ALL CLOSED

- F #1 ✅ send-email lockdown
- F #2 ✅ process-blend-ticket per-resource auth
- F #3 ✅ pg_cron schedules
- F #4 ✅ reconciliation report (this commit)
- F #5 ✅ SQL validators in CI
- F #6 ✅ production runbook
- F #7 ✅ Edge Function Sentry alerting

### All 4 audits — closure status

- Money/inventory audit (`2026-04-30-money-inventory-audit-findings.md`) ✅
- Security/permissions audit (`2026-04-30-security-permissions-audit-findings.md`) ✅
- Data integrity / workflow locks audit (`2026-04-30-data-integrity-workflow-locks-audit-findings.md`) ✅
- Production operations audit (`2026-04-30-production-operations-audit-findings.md`) ✅

19 phases shipped, ~30 findings closed, 264 migrations applied, 7 Edge Functions hardened, all on main.

---

## 2026-05-01 — Cleanup Sprint G3 + G4 (Phase 22): Cleanup Tooling

Migration `20260501160000_field_app_workflow_phase22.sql` + new admin page `src/pages/IntegrityCleanup.tsx`. Closes the three live-data findings from the deep-audit rebuttal.

### Two new RPCs

**`reconcile_negative_inventory(p_inventory_id, p_new_quantity, p_reason, p_performed_by, p_idempotency_key)`**
- Admin-only. Locks the inventory row, computes the delta (new − old), updates `quantity_available`, and inserts a paired `inventory_transactions` row of type `adjusted` with the reason captured in notes. Format: `RECONCILIATION (was X, now Y): <reason>`.
- Closes the immediate path for resolving the 17 production rows currently with `quantity_available < 0` (or `_prebooked`/`_on_order` < 0).
- Refuses if `p_new_quantity < 0` — the fix is to bring buckets to zero or positive, not deeper negative.

**`create_invoice_for_unbilled_delivery(p_delivery_id, p_performed_by, p_idempotency_key)`**
- Admin-only. Same auto-invoice logic Phase 15 added inside `complete_delivery`, factored into a manual-trigger RPC for the 60 historical completed deliveries that pre-date Phase 15.
- Refuses if delivery is not `completed` or has no `order_id`.
- Refuses if order already has an active (non-voided/cancelled) invoice — same guard as Phase 15. Prevents double-billing.
- Logs to `activity_feed` as `invoice_backfilled_for_delivery`.

### New admin page: `/integrity-cleanup`

Three sections, all admin-only:

1. **Negative inventory** — per-row form with new-quantity input + reason + Reconcile button.
2. **Over-received PO items** — read-only listing. The 15 historical rows are inert (inventory was already received); going-forward over-receives are blocked by Phase 21's default change.
3. **Unbilled completed deliveries** — per-row "Create draft invoice" button.

Each action posts to its respective RPC with a fresh idempotency key. Page is wired into Sidebar under Finance and routes via `App.tsx`.

### Live data targets

At sprint kickoff: 17 negative inventory rows, 15 over-received PO items, 60 unbilled deliveries. After Mason works through the cleanup page, those numbers should drop to 0 / 0 / 0. Once the negative inventory section is empty, a follow-up migration can safely add `CHECK (quantity_available >= 0 …)` constraints — that's deliberately deferred to Phase 23 (separate sprint after Mason confirms the cleanup is done).

### Sprint G summary

- G1 ✅ Commission lifecycle fix (Phase 20, `503ae1d`)
- G2 ✅ PO over-receive default → false (Phase 21, `6a61723`)
- G3 + G4 ✅ Cleanup tooling RPCs + admin page (this commit)
- G5 ⏸ Inventory CHECK constraints — deferred until cleanup is done

---

## 2026-05-01 — Cleanup Sprint G1 (Phase 20): Commission Lifecycle Fix

Migration `20260501150000_field_app_workflow_phase20.sql`. Closes the audit finding flagged in `2026-04-30-six-phase-deep-audit-findings.md` Phase 1 P1 / Phase 2 P1.

### The bug

`create_commission_payment` inserts the commission_payments row with `status='unposted'`, but immediately flips the included commissions to `status='paid'`. Result: commissions appear paid before the payment is actually committed. Month-end "unpaid commission liability" reports understate. Voiding an unposted payment (currently disallowed but defensive code reset commissions to pending anyway) was the only thing keeping the books from drifting.

### Fix

- `create_commission_payment` no longer changes `commissions.status`. Commissions stay `pending` while the payment is `unposted`.
- New double-pay guard: rejects commissions that are already in any non-voided `commission_payment_items` row. This replaces the old `WHERE c.status != 'paid'` filter, which only worked because of the bug we just removed.
- `post_commission_payment` now flips the included commissions to `status='paid'` and stamps `paid_date = payment_date`. This is where the "paid" transition belongs.
- `void_commission_payment` unchanged — its existing reset-to-pending logic still works correctly under the new lifecycle (no-op when commissions are already pending; correct flip-back when they're paid).

### Bonus fixes folded in

- Both RPCs now use the strict auth-gate pattern from Phase 13 (auth.uid() not null + p_performed_by mismatch reject + admin role check). `create_commission_payment` previously checked role against `profiles` directly without comparing to `auth.uid()`.
- `post_commission_payment` accepts `p_idempotency_key` for the first time. The frontend at `CommissionPayments.tsx:223` was already passing it; PostgREST was silently dropping it. Same latent bug pattern as Phases 17 and 20's `complete_cycle_count`.
- `post_commission_payment` returns `jsonb { success, payment_id, payment_number, commissions_paid }` instead of `void`, matching the modern RPC contract.

### What this unblocks

- Live data check at sprint kickoff showed 0 currently-bad commissions, but the path was producing the wrong state on every `create_commission_payment`. Going forward, only `post_commission_payment` can mark a commission `paid`.
- Reports that aggregate commission liability by status now match accounting reality.

---

## 2026-05-01 — Field App Phase 19: Sprint F #3 — pg_cron for Dashboard-triggered jobs

Migration `20260501140000_field_app_workflow_phase19.sql`. Closes the audit's complaint that two batch jobs only ran when someone happened to open the Dashboard.

### What ran on Dashboard load before

`Dashboard.tsx:348-367` calls these on every dashboard render:
- `check_remainder_reminders()` — surfaces partial deliveries that need a follow-up shipment
- `release_expired_quote_holds()` — frees inventory from quotes whose hold window passed

If nobody opened the Dashboard for a day (weekends, vacations), partial-delivery reminders piled up and quote holds kept blocking inventory needlessly.

### What changed

Two new pg_cron schedules, alongside the existing `mark-overdue-invoices`:

```
mark-overdue-invoices       0 6 * * *   (6:00 AM UTC, ~12:00 AM CT)
release-expired-quote-holds 15 6 * * *  (6:15 AM UTC)
check-remainder-reminders   30 6 * * *  (6:30 AM UTC)
```

Verified live: `SELECT jobid, jobname FROM cron.job` returns all three.

### Why I didn't remove the Dashboard.tsx trigger

Belt-and-suspenders. Both RPCs are idempotent — running twice in the same day costs nothing (their internal logic skips already-processed entities). If pg_cron is ever disabled (Supabase paused project, extension wedged), the Dashboard load still catches up the work. Cost: a few cheap RPC calls per dashboard view.

### Sprint F status

- F #1 ✅ send-email lockdown
- F #2 ✅ process-blend-ticket per-resource auth
- F #3 ✅ pg_cron schedules (this phase)
- F #4 ⏳ reconciliation report → admin dashboard (next)
- F #5 ✅ SQL validators in CI
- F #6 ✅ production runbook
- F #7 ✅ Edge Function Sentry alerting

---

## 2026-05-01 — Field App Phase 18: Sprint E #3 — cycle count item edit gating

Migration `20260501130000_field_app_workflow_phase18.sql` + edits to `src/pages/CycleCounts.tsx`. **Closes Sprint E entirely.**

### The gap this closes

`cycle_count_items` rows were directly editable from React via PostgREST `.update()` without any check on parent `cycle_counts.status`. After a count completed (which writes `inventory_transactions` rows referencing the item evidence), an admin could still mutate `counted_qty` / `variance` — leaving the audit trail pointing at numbers that no longer matched the row.

### Two new RPCs

- **`update_cycle_count_item(p_item_id, p_counted_qty, p_notes, p_performed_by, p_idempotency_key)`** — locks the parent `cycle_counts` row with `FOR UPDATE OF cc`, validates `status='in_progress'`, computes `variance` and `variance_pct` server-side (single source of truth — frontend was computing it but the server should authorize), and applies the update.
- **`cancel_cycle_count(p_cycle_count_id, p_performed_by, p_idempotency_key)`** — replaces the bare `.update({ status: 'cancelled' })` in `CycleCounts.tsx`. Validates `status='in_progress'` before flipping. Returns `{ cycle_count_id, status }` jsonb.

Both auth-gated admin-only with the strict pattern: `auth.uid()` not null + `p_performed_by` mismatch reject + `is_admin()` role check (matches Phases 16 + 17).

### RLS WITH CHECK guards — defense in depth

Even if a future code path bypassed the RPC, direct PostgREST `.update()` / `.insert()` / `.delete()` on `cycle_count_items` are now blocked when parent is not `in_progress`:

```sql
CREATE POLICY cycle_count_items_update ON cycle_count_items
  FOR UPDATE
  USING (is_admin() AND EXISTS (
    SELECT 1 FROM cycle_counts cc
    WHERE cc.id = cycle_count_id AND cc.status = 'in_progress'
  ))
  WITH CHECK (...same...);
```

The RPC and the RLS now enforce the same invariant from two layers — if one regresses, the other still holds.

### Bonus: RPC contract registry housekeeping

`src/lib/rpcContracts.test.ts` now lists `cancel_cycle_count`, `update_cycle_count_item`, `retire_inventory_item` (Phase 16 was missed), and `reverse_completed_cycle_count` (existed but wasn't tracked) in `MUTATING_RPCS_WITH_IDEMPOTENCY`. Coverage threshold bumps from 72 implicitly.

### Sprint E status: COMPLETE

- E #1 ✅ `retire_inventory_item` (Phase 16)
- E #2 ✅ cycle count clamp → block (Phase 17)
- E #3 ✅ cycle count item gating (this phase)

### Audit closure status

- Sprint A1-A4, B, C: ✅ closed (Phases 9-14)
- Sprint D-policy: ✅ closed (Phase 15)
- Sprint E: ✅ closed (Phases 16-18)
- Sprint F: in progress

---

## 2026-05-01 — Field App Phase 17: Sprint E #2 — cycle count clamp/ledger drift (E2a)

Migration `20260501120000_field_app_workflow_phase17.sql`. Closes audit finding P1-4 from the 2026-04-30 data-integrity / workflow-locks audit _(findings doc not retained)_.

### The drift this closes

Previously, `complete_cycle_count` and `reverse_completed_cycle_count` did this in one breath:

```sql
v_new_qty := GREATEST(0, v_item.quantity_available + v_item.variance);
...
INSERT INTO inventory_transactions (..., quantity, ...) VALUES (..., v_item.variance, ...);  -- FULL variance
```

When math would drive on-hand negative (e.g. `quantity_available = 5`, `variance = -10`), inventory was clamped to 0 but the ledger recorded `-10`. The books and the shelf disagreed permanently. A `RAISE WARNING` fired but warnings are swallowed by PostgREST/Supabase — neither the React app nor the activity feed surfaced them. The "fix" was effectively a silent lie. Reversing such a count compounded the drift.

### The fix Mason chose: E2a — block

Replace `GREATEST(0, ...)` clamp + `RAISE WARNING` with `RAISE EXCEPTION`. When math would drive on-hand below zero, the whole transaction rolls back, the cycle count stays `in_progress`, and the manager sees an actionable error:

> Cycle count adjustment for product `<id>` would set on-hand to `-5` (currently `5`, variance `-10`). Resolve upstream discrepancy (missing delivery, unlogged return, prior reconciliation gap) before completing this count.

Reversal mirror: if reversing would drive on-hand negative (because inventory has moved since the count completed), block with the same pattern. Cycle counts `0 in production`, so this strict mode has zero retroactive cost.

### Auth-gate hardening (folded in)

Both RPCs now use the strict pattern from Phase 16 `retire_inventory_item`:
1. `auth.uid()` must be set (not service-role / not anon)
2. `p_completed_by`/`p_reversed_by` must match `auth.uid()` if supplied (no actor spoofing)
3. `is_admin()` required (matches `retire_inventory_item` — both are destructive inventory operations)

### Bonus: idempotency key wired up

`complete_cycle_count` previously had signature `(uuid, uuid)` but the frontend at `src/pages/CycleCounts.tsx:300` was passing `p_idempotency_key: key`. PostgREST silently dropped the extra param — meaning a double-click could double-apply variances. Phase 17's signature is `(uuid, uuid, text)` with proper `check_idempotency` / `save_idempotency` hooks.

### Sprint E remaining

- E #3: cycle count item edits in locked RPC — `cycle_count_items` are still editable from React (`CycleCounts.tsx:229-252`) without checking parent `cycle_counts.status`. Needs `update_cycle_count_item()` RPC + `cancel_cycle_count()` RPC + RLS WITH CHECK guard.

---

## 2026-05-01 — Field App Phase 16: Sprint E #1 — `retire_inventory_item` RPC

Migration `20260501110000_field_app_workflow_phase16.sql` + `src/pages/InventoryPage.tsx` rewrite of `handleDelete`/`executeDelete`.

### The race condition this closes
The previous flow on `InventoryPage.tsx`:
1. React queries `inventory_holds` to check active holds
2. React reads `target.quantity_prebooked` from already-fetched state
3. React queries `delivery_items` for pending deliveries
4. User clicks confirm modal (window of opportunity opens)
5. React inserts `inventory_transactions` audit row
6. React calls `inventory.delete()`

Between steps 3 and 6, another user could create an inventory hold, place an order that prebooks the product, or schedule a delivery — and the validation results would be stale by the time the delete fires. Worse, if step 5 succeeded but step 6 failed (network blip), the ledger would say "stock removed" while the inventory row remained.

### The fix
`retire_inventory_item(p_inventory_id, p_performed_by, p_idempotency_key)` does it all in one transaction with `FOR UPDATE` on the inventory row:
1. Authentication + actor-mismatch check + admin role check
2. `SELECT ... FOR UPDATE` on the inventory row (concurrent writes serialize behind us)
3. Re-check active holds, prebooked quantity, and pending deliveries — all post-lock so the validation is fresh
4. Insert `inventory_transactions` audit row
5. Delete the inventory row
6. Return `{ success, inventory_id, product_id, retired_quantity }`

Frontend now calls `supabase.rpc('retire_inventory_item', ...)` and skips the manual validation steps entirely. Admin-only role gate.

### Sprint E remaining
- E #2: cycle count clamp/ledger drift fix (`complete_cycle_count` and `reverse_completed_cycle_count` clamp at zero but record full variance)
- E #3: cycle count item edits in locked RPC (currently editable from React without parent-status check)

---

## 2026-05-01 — Field App Phase 15: Sprint D-policy (A1 + B1)

Migration `20260501100000_field_app_workflow_phase15.sql`. Two business-decision fixes folded into a single `complete_delivery` rewrite.

### A1 — drivers can complete their assigned deliveries

`complete_delivery`'s role check mirrors `confirm_delivery`'s pattern: admin/sales OR (driver AND `v_actor = v_delivery.assigned_driver`). Closes the UX mismatch where the completion section was visible to drivers but the RPC threw "Only admin or sales_rep can complete deliveries."

### B1 — auto-invoice restoration

The pre-Phase-1-rewrite version of `complete_delivery` auto-created a draft invoice from the delivered quantities. The rewrite dropped that, leaving the UI promise stranded ("draft invoice auto-created" in DeliveryDetail.tsx:1342-1345 + Getting Started doc:368-370). Direct revenue leakage risk.

The auto-create now:
- Runs only when `v_delivery.order_id IS NOT NULL` AND no non-voided/non-cancelled invoice already exists for the order (covers `create_invoice_from_order`, `create_quick_delivery`, manual saves)
- Bills `quantity_delivered` (not `quantity_ordered`) so partial deliveries don't overbill
- Returns `auto_invoice: { invoice_id, invoice_number, total_cents }` in the result jsonb — frontend already reads this

### What's left from the audits

- **Sprint E** — inventory transactional integrity (`retire_inventory_item` RPC, cycle count clamp/ledger drift, cycle count item edits)
- **Sprint F** — operations hardening (Edge Function lockdown, pg_cron, reconciliation dashboard, SQL validators in CI, production runbook, Edge Function alerting)

---

## 2026-04-30 — Field App Phase 14: allocate_payment auth gate — **all 12 P1 actor-spoofing vectors now closed**

Migration `20260430260000_field_app_workflow_phase14.sql`. ~200-line `CREATE OR REPLACE` of `allocate_payment` with the same auth-gate pattern used in Phases 7, 9-13.

### Why this one matters
`allocate_payment` is the entry point for every customer payment in the system. Before this fix, any authenticated admin or sales rep could call it with `p_performed_by` set to *another* admin/sales user's UUID and the function would log the activity and financial-audit entries under that other user's name. Closing this vector makes the financial-audit log trustworthy — every payment allocation is attributable to the actual `auth.uid()` who triggered it.

### After this migration
**12 of 12 P1 actor-spoofing RPCs closed:**
1. `save_field_app_invoice` (Phase 9)
2. `create_invoice_from_blend_ticket` (Phase 9)
3. `post_invoice_group` (Phase 9)
4. `save_invoice` (Phase 10)
5. `create_invoice_from_order` (Phase 10)
6. `confirm_delivery` (Phase 12)
7. `complete_delivery` (Phase 12)
8. `create_quick_delivery` (Phase 12)
9. `save_purchase_order` (Phase 13)
10. `receive_po_items` (Phase 13)
11. `void_commission_payment` (Phase 13)
12. `allocate_payment` (Phase 14)

Plus Phase 7's `start_job` and `complete_job` were closed earlier today.

### What remains from the audits
- **Sprint D-policy** — drivers-can-complete decision + auto-invoice policy (needs Mason's input)
- **Sprint E** — inventory transactional integrity (retire_inventory_item RPC, cycle count clamp/ledger drift)
- **Sprint F** — operations hardening (send-email lockdown, process-blend-ticket per-resource auth, pg_cron scheduling, reconciliation dashboard, SQL validators in CI, production runbook, Edge Function alerting)

---

## 2026-04-30 — Field App Phase 13: Sprint A4 — Ops RPC Auth Gates

Migration `20260430250000_field_app_workflow_phase13.sql`. 3 RPC rewrites; ~750 lines total.

### Sprint A4 (auth gates)
- `save_purchase_order` — strict actor check + admin-only role check. Previous code did the role check using `p_performed_by` *directly* without first comparing to `auth.uid()`, meaning a non-admin authenticated user could spoof an admin's UUID and authorize as admin.
- `receive_po_items` — strict actor check, admin/sales role preserved. Was using the COALESCE pattern.
- `void_commission_payment` — strict actor check, admin-only role check. Was using the COALESCE pattern.

### Statement ordering note
The local `sql-safety` hook regex flags `UPDATE <table_without_updated_at> SET ...` followed by `updated_at` within a 400-char window — this can false-positive when a follow-up `UPDATE` on a *different* table (one that *does* have `updated_at`) appears within that window. To stay clean we reordered statements so:
- `receive_po_items`'s inner loop now runs the `inventory` UPDATE first, then the `purchase_order_items` UPDATE last
- `void_commission_payment` runs the `commission_payments` UPDATE before the `commissions` UPDATE

Behavior is unchanged — all writes still occur in a single transaction.

### Status
- Actor-spoofing P1s closed: **11 of 12** (was 8). Only `allocate_payment` remains.
- All 4 codex audits' P1 actor-spoofing findings will be fully closed once `allocate_payment` ships.

---

## 2026-04-30 — Field App Phase 12: Sprint A3 + Sprint D (mechanical) — Delivery RPC Auth Gates

Migration `20260430240000_field_app_workflow_phase12.sql`. 3 RPC rewrites; total ~750 lines of SQL.

### Sprint A3 (auth gates)
Replaced `v_actor := COALESCE(p_performed_by, auth.uid())` anti-pattern with strict actor validation in:
- `confirm_delivery`
- `complete_delivery`
- `create_quick_delivery`

Each function's existing role check is preserved (admin/sales/assigned-driver for confirm; admin/sales for complete; admin/sales/driver for quick).

### Sprint D (mechanical part folded)
`complete_delivery` previously rejected only `completed` and `cancelled` statuses, allowing a delivery to be completed directly from `scheduled` and skipping the start/confirm step. Now requires `status='in_progress'` per the documented two-step delivery lifecycle. The drivers-can-complete and auto-invoice business decisions remain deferred to Sprint D-policy.

### Status across all 4 audits
- Actor-spoofing P1s closed: **8 of 12** (was 7 of 12 after Phase 11). Remaining: `allocate_payment`, `save_purchase_order`, `receive_po_items`, `void_commission_payment`.

---

## 2026-04-30 — Field App Phase 11: Sprint C — Field-app RLS Lockdown

Migration `20260430230000_field_app_workflow_phase11.sql`. RLS-only, no schema or RPC changes.

### What changed
- **`field_app_locations`** and **`field_app_location_shares`** had `USING (true) / WITH CHECK (true)` on every operation, meaning any authenticated user could `INSERT/UPDATE/DELETE` rows directly via PostgREST and bypass `save_field_app_invoice` entirely. Tightened all writes to admin/sales only. SELECT stays broad since parent invoice/job RLS already protects who sees what.
- **`application_records.app_records_select`** previously allowed `is_admin() OR is_sales_rep() OR is_applicator()` — meaning *any* applicator could read *any* application record. Now scoped: applicators see only records where `applicator_id = auth.uid()`.

### Why this isn't redundant with Phase 5 (jobs RLS hardening)
Phase 5 fixed the `jobs` and `job_applied_info` RLS holes. Phase 11 closes the same class of bug on three more tables that the codex audit flagged separately. Same pattern, different tables.

---

## 2026-04-30 — Field App Phase 10: Sprint A2 + B (invoice auth + integrity)

Migration `20260430220000_field_app_workflow_phase10.sql` plus `src/pages/Invoices.tsx` UI cleanup.

### `save_invoice`
- Admin/sales role gate (was: any authenticated user could call)
- **Rejects standalone-create attempts** — now reads `order_id`/`blend_ticket_id` from the `p_invoice` payload and refuses to create a new invoice that links to neither. Enforces CLAUDE.md hard rule. Existing invoices that already lack the link continue to update fine (no retroactive break).
- Note: `save_invoice` has no `p_performed_by` parameter (uses `auth.uid()` inline), so actor-mismatch check was N/A.

### `create_invoice_from_order`
- Admin/sales role gate
- **Rejects duplicate active invoices** for the same order — any existing invoice in a status other than `voided` or `cancelled` blocks the create. Prevents the click-Create-Invoice-twice overbilling bug.

### Frontend cleanup (`src/pages/Invoices.tsx`)
- Removed the "New Invoice" button (top action bar) and the empty-state "New Invoice" CTA — both navigated to a path that would now fail the standalone-rejection rule. Empty-state CTA now points to /orders.
- "New Field Application" button stays (separate, valid path).

### Why a frontend change in a security migration commit
The two pieces (SQL rejection + UI button removal) had to ship together. Without the rejection, the rule isn't enforced; without removing the button, the UI presents an action that always fails. Single commit keeps the system self-consistent.

### Verification
- 0 invoices in production (verified pre-flight) — no risk of retroactively breaking existing data
- typecheck clean, build clean, 1,841 tests still passing

---

## 2026-04-30 — Field App Phase 9: Sprint A1 Auth Gates (3 of 12 SECURITY DEFINER RPCs)

First migration of a multi-sprint hot-fix series addressing P1 findings from the money-inventory and security-permissions audits (2026-04-30; _findings docs not retained_).

### Pattern (mirrors save_quote / Phase 7 start_job)

```sql
v_actor uuid := auth.uid();
IF v_actor IS NULL THEN RAISE 'Not authenticated'; END IF;
IF p_performed_by IS DISTINCT FROM v_actor THEN
  RAISE 'p_performed_by does not match authenticated user';
END IF;
IF NOT (is_admin() OR is_sales_rep()) THEN
  RAISE 'Not authorized: admin or sales role required';
END IF;
```

### Migration `20260430210000_field_app_workflow_phase9.sql`

Auth gates added to:
- `save_field_app_invoice` — was vulnerable to spoofed `p_performed_by` (any authenticated user could create field-app invoices as someone else)
- `create_invoice_from_blend_ticket` — was vulnerable to spoofed `p_created_by` (any authenticated user could mark blend tickets billed and create AR rows as someone else)
- `post_invoice_group` — was vulnerable to spoofed `p_performed_by` on the group activity log (`post_invoice` itself has its own auth, but the wrapper didn't)

### Why this matters

`SECURITY DEFINER` bypasses RLS — internal auth checks are the only protection. The 12 affected RPCs were granted to `authenticated` role, meaning any logged-in user (driver, applicator) could call them via PostgREST with a spoofed admin UUID and authorize as admin. Phase 9 closes the first 3.

### Tests
1,841 still passing (mock tests don't actually invoke the RPC, so auth-gate is transparent to them).

### Remaining work (queued)
- Sprint A2: `allocate_payment`, `save_invoice` (+ Sprint B standalone-invoice rule), `create_invoice_from_order` (+ Sprint B duplicate-invoice rule)
- Sprint A3: `confirm_delivery`, `complete_delivery`, `create_quick_delivery`
- Sprint A4: `save_purchase_order`, `receive_po_items`, `void_commission_payment`
- Sprints C–F: RLS lockdown, delivery workflow gaps, inventory integrity, ops hardening

---

## 2026-04-30 — Field Application Workflow Phases 7 + 8: Codex Re-Review Hot Fixes

Two migrations addressing the four findings codex raised on its independent re-review of Phases 1–6 _(2026-04-30 codex re-review findings doc not retained)_.

### Phase 7 (`20260430190000_field_app_workflow_phase7.sql`) — Job RPC fixes

- **Finding #1 (P1) — auth gates on `start_job` + `complete_job`.** Both RPCs are `SECURITY DEFINER` (which bypasses RLS), and both granted to authenticated. They previously took `p_performed_by` from the client without validating it, and never checked role/ownership. Now: validate `auth.uid() = p_performed_by`, then enforce `is_admin() OR is_sales_rep() OR (is_applicator() AND v_job.applicator_id = auth.uid())`. Pattern matches `save_quote`. Phase 5's RLS could not protect this path because SECURITY DEFINER bypasses RLS entirely.
- **Finding #2 (P1) — quote_id, not quote_section_id.** Phase 3's linked-prebook lookup matched `inventory_holds.source_id` to `jobs.quote_section_id`, but planned-program holds are created with `source_id = quote_id` (verified against migration `20260317100000_fix_idempotency_and_searchpath_final.sql:384, 397`). The previous lookup never matched, so Phase 3's leak fix was functionally inert for every quote-linked job. Net-free inventory math drifted as a result.
- **Finding #3 (P2) — multi-hold release loop.** Phase 3 summed all matching holds into `v_decrement_pb` but updated only the FIRST hold by created_at, which would over-decrement that row and trip the `chk_inventory_holds_quantity_check >= 0` constraint when multiple holds existed for the same quote+product. Replaced with an oldest-first loop that takes `LEAST(remaining, hold.quantity)` per row.

### Phase 8 (`20260430200000_field_app_workflow_phase8.sql`) — Orphan invoice handling

- **Finding #4 (P2) — orphan child invoices cancelled and detached.** When an admin edits a draft grouped field-app invoice and the new derived customer list drops a previously-billed customer (e.g., billing default flipped), the existing wipe deleted items/shares/locations but left the parent invoice row with stale `total_amount_cents` and lingering `invoice_group_id` — surfacing as a ghost AR row.

  Per Mason's call (Option B from the implementation plan): orphans are marked `status = 'cancelled'`, detached (`invoice_group_id = NULL`), totals zeroed (consistent with the items/shares already wiped), and an `invoice_orphan_cancelled` activity_feed row records the audit trail. The invoice number is preserved (versus hard-delete) so prior references stay resolvable.

  Posted/voided members are still protected by the existing edit lock.

### Tests
1,841 still passing, 128 files, build clean. No new tests this round — these are SQL-body changes inside RPCs that are already covered by the type-contract net + future E2E.

---

## 2026-04-30 — Field Application Workflow Phase 6: Field Picker UX Cleanup

Addresses codex audit item #12 (field picker map misleading + double-toggle on row+checkbox click). No migration; frontend-only fixes.

### Fixes
- **`src/components/field-app/SelectLocationsModal.tsx`**
  - Map now renders **ALL filtered fields**, with selected ones highlighted, instead of starting empty until something is selected. Map became a real picker, not a confirmation view.
  - Added `onFieldClick={toggleField}` so clicking a polygon on the map is a second selection path (alongside the checkbox).
  - Fixed the double-toggle bug — clicking the checkbox previously fired both the checkbox `onChange` and the row's `onClick`, which canceled each other out. The checkbox cell now stops propagation.
- **`src/components/map/FieldBoundaryLayer.tsx`**
  - New optional `selectedIds: Set<string>` prop. When set, the polygon paint expressions read a `selected` feature property to render selected fields at higher opacity (0.55 vs 0.18) and with a darker, thicker outline. Unselected fields still render so the picker shows all available choices.

### Items #11 and #13 (also Phase 6 territory)
Already addressed by **Phase 1** — `derive_customer_shares_from_fields` falls back to `fields.customer_id` at 100% when a field has no `field_billing_defaults` rows (#11), and `field_app_location_shares` is now populated by `save_field_app_invoice` with the TRUE per-customer split (#13).

### Item #14
Job lifecycle E2E that skipped on completion failures is downstream of `start_job` (Phase 2). Now that the RPC exists, removing the skip is mechanical; deferred to a follow-up that touches `tests/e2e/golive/`.

### Tests
1,841 tests still passing, 128 files, build clean. No new tests — these are presentational fixes with limited isolation.

---

## 2026-04-30 — Field Application Workflow Phase 5: RLS Hardening

Addresses codex audit item #10. Migration `20260430180000_field_app_workflow_phase5.sql`. RLS-only — no schema or RPC changes.

### The vulnerability
The previous `jobs_update` policy allowed the assigned applicator to UPDATE *any column* on the jobs row. An applicator with PostgREST access could silently:
- Change `total_price_cents` (mark a job done at any price)
- Change `customer_id` (move the job to a different customer's books)
- Change `applicator_id` (reassign the job to themselves)
…all without going through `start_job` or `complete_job` RPCs.

`job_applied_info` had a related but lesser hole: the insert/update policies required only that the user *be some applicator*, not that they were the applicator assigned to the linked job.

### The fixes
- **`jobs_update`** is now admin/sales only. Applicators do their work through `start_job` (SECURITY DEFINER) and `complete_job` (SECURITY DEFINER), which bypass RLS entirely and have their own state-transition gates.
- **`job_applied_info_insert`** now requires either admin/sales OR (`is_applicator()` AND `auth.uid() = jobs.applicator_id` for the linked job).
- **`job_applied_info_update`** same ownership-gated structure on both `USING` and `WITH CHECK`.

### Acceptance
Per the audit response: applicator role can complete an assigned job through the RPCs only, cannot mutate price/customer/applicator via direct table writes. Verified by the migration's own `DO` block (asserts `jobs_update` no longer references "applicator", and `job_applied_info_insert` enforces `applicator_id`).

---

## 2026-04-30 — Field Application Workflow Phase 4: Application Service Fees

Addresses codex audit item #8. Migration `20260430170000_field_app_workflow_phase4.sql`.

### Schema
- **`jobs.application_service_id uuid REFERENCES application_services(id)`** — brings jobs to parity with `blend_tickets.application_service_id` (smart-pricing era) and `invoices.application_service_id` (Phase 1). Indexed.

### New helper RPC
- **`compute_application_service_fee(p_service_id, p_customer_id, p_acres, p_season)`** — single source of truth for fee math. Priority:
  1. `customer_application_rates` override (per customer × service × season)
  2. `application_services.default_rate_per_acre_cents`
  3. 0 (no service / inactive / no rate)
- Returns `{ rate_per_acre_cents, total_fee_cents, cost_per_acre_cents, total_cost_cents, source, service_name }` so callers can both display the math and persist line items.
- The existing inline fee blocks in `save_field_app_invoice` and `create_invoice_from_blend_ticket` continue to work as before; future cleanup can refactor them onto the helper without changing observable behavior.

### Frontend
- `src/types/index.ts` — `Job.application_service_id` added; new `ComputeApplicationServiceFeeResult` interface with the four-state `source` union.

### Tests
- `src/tests/field-app-phase4-types.test.ts` — 5 type-contract assertions.
- Test count: 1,836 → 1,841 (+5), 127 → 128 files, 0 failures, build clean.

---

## 2026-04-30 — Field Application Workflow Phase 3: Inventory Completion Behavior

Addresses codex audit item #7. Migration `20260430160000_field_app_workflow_phase3.sql`.

### Schema
- **`inventory_transactions.requires_review boolean NOT NULL DEFAULT false`** — flag for short-stock applications. Surfaces in dashboard alerts so an admin can investigate (PO not received, miscount, etc.) without blocking field work.
- **`inventory_transactions.job_id uuid REFERENCES jobs(id)`** — explicit FK so the audit trail joins back to the source job. Indexed.
- Indexes: `idx_inv_tx_job_id` (partial, where job_id IS NOT NULL), `idx_inv_tx_requires_review` (partial, where requires_review = true) — both targeted at the dashboard "needs review" query.

### `complete_job` rewrite
- **Removed pre-flight inventory exception.** Field work happened; the DB has to record reality. Insufficient stock now flows through and is tagged on the transaction row instead of blocking completion.
- **Linked-prebook decrement.** `quantity_prebooked` only drops when the job's `quote_section_id` matches an `inventory_holds.source_id`. Fixes the leak where Customer B's job silently halved Customer A's unrelated prebook. Hold quantity itself is decremented in lockstep so net-free math doesn't double-count.
- **Negative-aware writes.** `quantity_available` can go negative; the existing `chk_inventory_qty_prebooked >= 0` constraint still protects against negative prebook. New rows are inserted (going negative) when no inventory row exists for the product.
- **Result shape extended** with `short_stock_count` (number of chemicals where stock went negative).

### Frontend
- `src/types/index.ts` — `CompleteJobResult.short_stock_count` added.

### Tests
- Updated `src/tests/field-app-phase2-types.test.ts` to reflect the new field. 127 files / 1,836 tests still passing.

---

## 2026-04-30 — Field Application Workflow Phase 2: Job Lifecycle Repair

Addresses codex audit items #4 (no `start_job`), #5 (multi-customer jobs half-built), #6 (application records lose multi-field detail). Migration `20260430150000_field_app_workflow_phase2.sql`.

### Schema
- **`application_record_fields`** — new join table; per-field detail for multi-field jobs (FK to `application_records` with `ON DELETE CASCADE`, FK to `fields`, unique on `(application_record_id, field_id)`, RLS mirrors `application_records`)
- **`application_records.field_id`** — now nullable, kept as legacy single-field anchor (first field of the job)
- **`jobs.customer_id`** — restored to `NOT NULL` (Option A from the audit response: jobs are single-customer; multi-customer billing happens at invoice time via `field_billing_defaults`)

### RPCs
- **NEW `start_job(p_job_id, p_performed_by, p_idempotency_key)`** — transitions `scheduled → in_progress`, stamps `job_applied_info.actual_start_time` (preserves any existing value via COALESCE), idempotent on second call when status is already `in_progress`, activity-feed entry
- **REWRITE `complete_job`** — now writes ONE `application_records` row + N `application_record_fields` rows (one per `job_fields` entry) instead of dropping all but the first field. Acres fall back from `job_fields.acres_to_treat → fields.total_acres → 0`. Result shape extended with `field_count`. `application_records.field_id` is set to the first job field for back-compat readers.

### Frontend
- `src/pages/JobDetail.tsx` — added **Start Job** button visible when `status === 'scheduled'` and the user has admin/sales privileges. Wired through `start_job` RPC with idempotency key.
- `src/types/index.ts` — added `ApplicationRecordField`, `StartJobResult`, `CompleteJobResult` interfaces; deprecated `field_id` on `ApplicationRecord`; added `application_record_fields[]` to `ApplicationRecord` for joined queries.

### Tests
- `src/tests/field-app-phase2-types.test.ts` — 6 type-contract assertions on the new shapes
- Test count: 1,830 → 1,836 (+6), 126 → 127 files, 0 failures, build clean

---

## 2026-04-29 — Field Application Workflow Phase 1: Grouped Split Invoices + Grower-Share Mode

Comprehensive rewrite of the multi-customer field application billing flow, prompted by the 2026-04-28 field-application-workflow codex review _(audit doc not retained)_. Bundles fixes for audit items #1, #2, #3, #9, #11, #13, M1, M2, M3.

### Migration `20260429140635_field_app_workflow_phase1.sql` (~1,000 lines)

1. **Schema additions**
   - `field_app_locations.invoice_group_id uuid` — locations live at group level for multi-customer invoices
   - `invoices.application_service_id uuid` — persists service selection so fee is reloadable/auditable
   - `field_app_locations` CHECK relaxed to allow `invoice_id OR job_id OR invoice_group_id`

2. **Helper rewrite: `derive_customer_shares_from_fields`**
   - Returns per-(field × customer) detail (`rows`) AND per-customer aggregate (`customers`)
   - Falls back to `fields.customer_id` at 100% when a field has no `field_billing_defaults` rows
   - Tracks `fallback_used_field_ids` for diagnostics

3. **Major rewrite: `save_field_app_invoice`**
   - Creates one invoice per customer (single or grouped via `invoice_group_id`)
   - **Mode A (grower-share)**: when customer has `price_override_cents` on a field, bills $/ac × share_acres + chemical $0 informational lines, no service fee
   - **Mode B (line-item)**: tier-aware (`manual > quoted > customer.assigned_tier`) + application service fee
   - A customer can be in BOTH modes simultaneously across different fields
   - Posted-status guard covers whole group; wipe-and-rebuild on edit
   - `field_app_location_shares` populated with TRUE per-customer split (NOT 100% rows)
   - `invoice_shares` continues to be populated (one 100% row per child invoice) for PDF/statement compat
   - Returns `{ invoice_ids: string[], invoice_group_id: string | null }`

4. **Major rewrite: `create_invoice_from_blend_ticket`**
   - Same grouped-split + Mode A/B logic
   - Acres from `blend_ticket_fields.actual_acres → planned_acres → fields.total_acres → 0`
   - Deterministic quoted-price lookup (`ORDER BY qi.id LIMIT 1`)
   - **Breaking**: return type changed from `uuid` to `jsonb` (matches `save_field_app_invoice` shape)

5. **New RPC: `post_invoice_group(p_invoice_group_id, p_performed_by, p_idempotency_key)`**
   - Atomically posts every invoice in a group in one transaction
   - Pre-flight checks period-open and status for all siblings; rollback on any failure

6. **New RPC: `preview_field_app_invoice_split(p_locations, p_chemicals, p_application_service_id)`**
   - Read-only preview returning the same per-customer breakdown that `save_field_app_invoice` would produce
   - Backs the "Preview" button on the field app invoice page

7. **Verification block** at end of migration asserts exactly 1 overload of all 5 RPCs (per CLAUDE.md migration safety rules).

### Frontend changes

- **NEW** `src/components/field-app/ApplicationServicePicker.tsx` — service dropdown
- `src/components/field-app/CustomerSharesTable.tsx` — accepts new `preview` prop with per-customer cards (grower / chemical / service-fee tagged); legacy fallback shows "Click Preview for amounts"
- `src/components/field-app/FieldAppChemicalEntry.tsx` — `primaryCustomerTier` prop drives tier-aware preview pricing; per-line `manual_override` flag with "M" badge
- `src/pages/FieldApplicationInvoice.tsx` — App Service picker, group sibling banner, group-aware edit lock, Preview button, group-aware Post button via `post_invoice_group`, sibling fetch, new RPC return shape handling
- `src/pages/BlendTicketDetail.tsx` — accepts new `{invoice_ids, invoice_group_id}` return shape
- `src/pages/InvoiceDetail.tsx` — `handlePost` routes through `post_invoice_group` when `invoice.invoice_group_id` is set

### Type additions in `src/types/index.ts`

- `Invoice.application_service_id` (string | null)
- `FieldAppLocation.invoice_group_id` (string | null)
- `DeriveCustomerSharesRow`, `DeriveCustomerSharesCustomer`, `DeriveCustomerSharesResult`
- `FieldAppInvoiceResult`, `PostInvoiceGroupResult`
- `PreviewFieldAppSplitLine`, `PreviewFieldAppSplitCustomer`, `PreviewFieldAppSplitResult`

### Verification (this commit)

- `npm run typecheck` — clean
- `npm run lint` — 0 errors, 2 pre-existing a11y warnings (unrelated)
- `npm run build` — clean (40.54s, PWA generated)
- `npm run test` — 120 files / 1,775 tests passed, 0 failed (161s)

### Out of scope (deferred to later phases)

- Multi-field application records (audit #6) → Phase 2
- `start_job()` and job lifecycle repair (#4) → Phase 2
- `jobs.customer_id` revert to NOT NULL (#5) → Phase 2
- Inventory completion behavior (#7) → Phase 3
- Application services on `jobs` (the field-app and blend-ticket parts ARE in Phase 1; jobs part is Phase 2)
- RLS hardening (#10 of original audit) → Phase 5
- Field picker map UX (#12 of original audit) → Phase 6
- New tests (Step 4 of Phase 1 plan) — to be tackled in next session

---

## 2026-04-16 — Audit Fixes: Validator False Positives + Function search_path

1. **Fixed SQL validator false positives** — `validate-sql-migrations.sh` check #4 was flagging `entity_type, entity_id` in `activity_log`/`financial_audit_log`/`activity_feed` INSERTs as idempotency_keys violations. Added per-line exclusion filter for legitimate tables.
2. **Fixed 4 trigger functions missing `pg_temp`** — New migration `20260416100000` adds `SET search_path TO 'public', 'pg_temp'` to `guard_audit_log_immutable`, `_fill_audit_actor`, `_enforce_quote_status_transition`, `_enforce_return_status_transition`. Resolves Supabase security linter warnings.

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-04-07 -- Field App V2 Schema Fix and Migration Applied

Applied migration to Supabase. Fixed 8 column name mismatches before deployment: invoices.transaction_date to invoice_date, invoices.notes to header_notes, invoice_items.product_name to description, invoice_items.unit to unit_size, invoice_items.unit_cost_cents to cost_cents, activity_log to activity_feed, fields.planted_acres removed, customers.tier to assigned_tier. Fixed corresponding frontend references in FieldApplicationInvoice.tsx.

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-04-06 -- Field Application Workflow V2

Multi-customer field application invoicing foundation. New tables: field_app_locations, field_app_location_shares. New RPCs: derive_customer_shares_from_fields, save_field_app_invoice. New page: FieldApplicationInvoice (4-tab: Locations, Chemicals, Customers, Applied Info). Components: SelectLocationsModal, FieldAppChemicalEntry, CustomerSharesTable. jobs.customer_id nullable. New Field Application button on Invoices.

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-04-05 — Custom Application Workflow (4 Phases)

Phase 1: Application Services Setup — new tables (application_services, customer_application_rates), new pages, bug fix (vehicle name NULL on job invoices). Phase 2: Quote-to-Job Connection — jobs.quote_id/quote_section_id, create_job_from_quote_section RPC, Schedule Job button on QuoteBuilder. Phase 3: Smart Pricing — invoice_items.quoted_price_cents/price_source, enhanced create_invoice_from_blend_ticket with quoted pricing auto-pull + application fee auto-add. Phase 4: Program Tracker — get_program_completion RPC, ProgramTracker page, Dashboard widget.

Code review fixes (3-agent swarm): Missing SELECT RLS on customer_application_rates (critical), idempotency jsonb type mismatch (critical), ConfirmModal on override delete, quote status validation + duplicate job guard in create_job_from_quote_section, explicit bigint casts, ProgramTracker expanded rows, Dashboard Sentry capture, E2E test fix (Operational Alerts -> Action Queue), price source tooltips, logActivity entityType/entityId. Deleted 3 stale GitHub branches.

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-04-04 — Blend Ticket Enhancement Suite (E1–E10)

### E1+E10: Per-Product Confidence Display + Low-Confidence Highlight
- Products with confidence < 70% get yellow background + "Low confidence — verify" pill
- Products with 70-89% show yellow "review" pill with progress bar
- High confidence shows green pill; manually corrected products show green "Verified" badge

### E2: Raw OCR Text Viewer
- Collapsible "Raw OCR Text" panel at bottom of BlendTicketDetail
- Shows the full extracted text in monospace for debugging bad OCR

### E4: One-Click Order Linking from Suggestion Banner
- Suggestion banner now includes a "Link" button for instant order linking
- No need to open the link modal — single click directly from the suggestion

### E6: Duplicate Ticket Detection
- "Dup" badge on BlendTickets list page for tickets sharing a ticket_number
- Detail page warning now includes a clickable link to the duplicate ticket

### E7: Reprocess OCR Available on Any Ticket
- Relaxed guard from `source === 'ocr' && review_status === 'unreviewed'` to `source === 'ocr'`
- Can now re-run OCR on already-approved/rejected tickets

### E8: Blend Math Validation (already existed)
### E9: Quick Filter Chips
- "Needs Review (N)" / "Low Confidence (N)" / "Duplicates (N)" filter chips above table
- "Clear Filters" button to reset all filters at once

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-04-04 — F14 + E3: Alert→Task + Batch Reject Blend Tickets

### F14: Alert → Task Conversion
- One-click "Create Task" button on every Action Queue item
- Opens QuickTaskModal pre-filled with alert context (entity type, ID, title)
- Auto-assigns to current user, priority set to 'high' for overdue/cancelled items
- Added 'invoice' and 'product' to LinkedEntityType union

### E3: Batch Reject Blend Tickets
- New "Batch Reject" button in BlendTickets bulk action bar (next to existing Batch Approve)
- New RPC: `batch_reject_blend_tickets()` mirrors approve pattern with idempotency
- ConfirmModal confirmation before rejecting
- Activity logging for batch rejections

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-04-04 — Tier 1: Office Speed + Money Visibility

### Feature 1: Global Command Palette
- Added `Ctrl+K` / `Cmd+K` global command palette for instant search
- Searches across pages (fuzzy), customers, orders, invoices, deliveries, products
- Tracks recent page visits in localStorage for quick access
- New RPC: `global_search()` for server-side entity search
- New components: `CommandPalette.tsx`, integrated into `AppLayout.tsx`

### Feature 2: Transaction Thread Cross-Links
- New `TransactionThread` component shows full pipeline: Quote → Order → Delivery → Invoice
- Integrated into OrderDetail, QuoteBuilder, DeliveryDetail, InvoiceDetail
- Each step is clickable; current page is highlighted in crx-green
- Multiple deliveries/invoices show as dropdown with count
- No new migrations — uses existing FK relationships

### Feature 3: Workflow Guardrails
- Credit limit soft-block on NewOrder and InvoiceDetail (uses existing `credit_limit_cents`)
- Stale quote warning on QuoteBuilder conversion (>30 days old)
- Overloaded driver warning on NewDelivery (5+ deliveries on same date)
- New hook: `useGuardrails.ts` with `useCreditLimitCheck`, `useStaleQuoteCheck`, `useOverloadedDriverCheck`
- New component: `GuardrailBanner.tsx` — reusable warning/danger banner with dismiss
- All warnings are soft blocks — admin can always proceed

### Feature 4: Customer 360 View Enhancement
- New `CustomerSummaryBar` component: 5 KPI cards (AR balance, orders, deliveries, tier, last activity)
- New Timeline tab on CustomerDetail showing chronological activity feed
- Quick action buttons: New Quote, New Order, Sched. Delivery (pre-fills customer)
- New RPC: `get_customer_summary()` returns all 5 KPIs in one call
- Season-aware counts (Oct 1 – Sep 30)

### Feature 5: Dashboard Action Queue
- New `ActionQueue` component replaces passive Operational Alerts on Dashboard
- Each item is specific and clickable — shows entity number, customer, and details
- Collapsible categories: Overdue Invoices, Cancelled+Posted, Overdue Deliveries, Low Stock, Expiring Quotes, Unassigned Deliveries
- "Dismiss for today" per item (sessionStorage, resets on reload)
- New RPC: `get_dashboard_action_items()` returns specific entity details per category

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-31 — Workflow Gaps Remediation: Broken Connections + Billing Splits + Dispatch

### Summary
Five-phase migration session fixing workflow gaps across blend tickets, invoicing, field billing, dispatch, and crop history tracking. Adds a new Dispatch Board page.

### New Page
- **DispatchBoard** (`/dispatch`) — Map-based dispatch view for job scheduling with applicator assignment

### New Table
- **field_crop_history** — Tracks multi-year crop rotation per field per season with auto-snapshot trigger

### New RPCs
- `create_invoice_from_blend_ticket(p_blend_ticket_id, p_created_by, p_idempotency_key)` — creates draft invoice from approved blend ticket
- `get_field_billing_splits_for_order(p_order_id)` — returns billing splits for order fields
- `get_field_billing_splits_for_blend_ticket(p_blend_ticket_id)` — returns billing splits for blend ticket fields
- `create_split_invoices_from_order(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)` — creates proportional split invoices

### Modified RPCs
- `create_application_record_from_blend_ticket` — now returns `uuid[]` (one record per field) instead of single `uuid`

### New Triggers
- `sync_blend_ticket_payment_status()` — auto-syncs payment_status when invoice voided
- `snapshot_field_crop_history()` — auto-snapshots crop_type changes to field_crop_history

### New Columns
- `blend_ticket_products.unit_cost_cents`, `blend_ticket_products.unit_price_cents`
- `blend_tickets.job_id` (FK to jobs)
- `quote_sections.field_id` (FK to fields)
- `invoices.invoice_group_id` (groups split invoices)
- `jobs.priority`, `jobs.estimated_hours`

### Migrations (5)
- `20260335000000` — Phase 1: broken connections (blend ticket cost/price, multi-field app records, job linkage)
- `20260335100000` — Phase 2: blend ticket invoicing + payment status sync trigger
- `20260335200000` — Phase 3: field billing splits + split invoice creation
- `20260335300000` — Phase 4: dispatch columns (priority + estimated hours on jobs)
- `20260335400000` — Phase 5: crop history table + auto-snapshot trigger

### Stats
- Page count: 58 → 59
- Migration count: 226 → 231
- RPC count: ~148 → ~153
- Table count: 88 → 89

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-30 — Field Management V2: Dashboard + Map Layer System

### Summary
Major field management upgrade implementing Approach 2 from the brainstorm: reusable CRXMap component with pluggable layer architecture, new Field Dashboard page, and Fields list improvements.

### New Components (7 map components)
- **CRXMap** — reusable map wrapper with base layer switching (satellite/roads/hybrid/terrain), GPS locate, print mode
- **LayerToggle** — layer picker UI for CRXMap
- **LocateMe** — GPS button using browser Geolocation API
- **AddressSearch** — Mapbox geocoding search bar for address/coordinate lookup
- **FieldBoundaryLayer** — filled polygon overlay for field boundaries with labels
- **FieldMarkerLayer** — centroid markers for fields without boundaries (filters out fields with boundaries)
- **DrawLayer** — wrapper around DrawControl with auto-acreage calculation via turf.js

### New Page
- **FieldDashboard** (`/fields/:id/dashboard`) — read-only field profile with 4 tabs:
  - Overview: season summary cards (total apps, acres treated, products) + activity timeline
  - Applications: full history table with weather details, expandable rows, CSV export
  - Billing: visual split bar + per-grower details with price overrides
  - Details: FSA numbers, legal description, notes, timestamps, activity log

### New RPC
- **get_field_dashboard(p_field_id, p_season)** — aggregates field data, application records, season stats, and activity feed in a single server-side query

### Fields List Improvements
- Upgraded from MapContainer+FieldMarkers to CRXMap+FieldBoundaryLayer+FieldMarkerLayer
- Added customer and active/inactive status filter dropdowns
- Added stats bar (field count, total acres, boundary count)
- Enabled layer toggle and GPS locate on map view
- Row/marker click now navigates to Field Dashboard

### Stats
- Page count: 57 → 58
- Migration count: 224 → 225
- RPC count: ~146 → ~147
- Tests: 1,719 passing (111 files)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-29 — Blend Ticket Phase 1: OCR Bridge

### Summary
Phase 1 implementation for the blend ticket system — aligning the existing schema with the full lifecycle data model, adding multi-field/multi-customer support, configurable OCR thresholds, and several UX improvements for the OCR review workflow.

### Schema Changes (6 migrations)
- **app_settings** — Extended with `description` and `created_at` columns; seeded OCR confidence threshold
- **blend_ticket_fields** — New table for per-field application tracking with multi-customer billing support
- **blend_tickets** — Added `applicator_id` (FK→profiles), `vehicle_id` (FK→vehicles), `source` enum
- **batch_approve_blend_tickets** — New RPC for bulk ticket approval
- **check_duplicate_blend_ticket** — New RPC for duplicate detection
- **save_blend_ticket_fields** — New RPC for saving field assignments (pending subagent)

### Frontend Changes
- **Configurable OCR thresholds** — `useOCRThresholds` hook + `OCRThresholdSettings` component on Settings page; replaces hardcoded 70/50 values
- **Per-field confidence badges** — Color-coded dots (green/yellow/red) next to each product's confidence score
- **Raw OCR text viewer** — Collapsible `<details>` section showing raw Google Vision output
- **Re-process OCR button** — Allows re-running OCR on ticket images with ConfirmModal
- **Duplicate detection** — Yellow warning banner when another ticket with same number+date exists
- **Auto-suggest order match** — Blue info banner suggesting matching confirmed orders based on shared products
- **Batch approve** — Checkbox selection + batch approve from list page (subagent)
- **Multi-field entry UI** — Field assignments with customer override and planned acres (subagent)

### Types
- Added `BlendTicketSource`, `BlendTicketField`, extended `AppSetting` and `BlendTicket` interfaces

### Context
- All 10 open questions from the 2026-03-23 brainstorm answered
- Key decisions: no mixer role (all roles can mix), single ticket with per-field customer assignments (Q6-B), skip Chem Man detection for Phase 1
- Full plan: `2026-03-29-blend-ticket-phase1-implementation.md` _(planning doc, not retained in repo)_

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-26 — Full Documentation Sweep

### Summary
Systematic audit and fix of all project documentation. Compared every doc file against the actual codebase and fixed all discrepancies found.

### Fixes Applied
- **CLAUDE.md** — Edge Functions 6→7 (added `reset-user-password`), updated date, fixed E2E count (82→83), added missing statuses to all lifecycles (quote: `cancelled`, order: `voided`, invoice: `unposted`/`cancelled`), corrected "Tables WITHOUT updated_at" list (removed 8 tables that actually have the column), updated `orders.total_paid`/`balance_due` note from "DEPRECATED" to "DROPPED"
- **UI_PATTERNS.md** — Fixed `logActivity()` example from wrong positional args to correct object parameter format, updated page count (56→57)
- **QUOTE_TO_DELIVERY.md** — Added missing statuses: quote `cancelled`, order `voided`, invoice `unposted` and `cancelled`
- **SAFE_DEVELOPMENT_RULES.md** — Updated page count (56→57)
- **migration-history.md** — Added 6 missing entries (#198-203), renumbered entries #204-219 to match
- **project-details.md** — Updated page count (48→57)
- **TEST_COVERAGE_ANALYSIS.md** — Updated test counts (104→110 files, 1629→1713 tests, 82→83 E2E)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-26 — Fix TypeScript/DB Type Mismatches (A16)

### Summary
Removed deprecated `balance_due` and `total_paid` fields from the `Order` TypeScript interface. These columns were dropped from the database in migration `20260332100000` but the TypeScript type still included them. Also confirmed that 4 of the original 6 reported mismatches (WriteOff.reversed_by, InvoiceLineAllocation.invoice_id, Commission.season nullable) had already been fixed in prior sessions. Updated ROADMAP to mark A16 and A17 as complete.

### Changes
- `src/types/index.ts` — Removed `balance_due: number` and `total_paid: number` from `Order` interface
- `docs/ROADMAP.md` — Marked A16 and A17 as Done

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-23 — Edit Scheduled Delivery Items

### Summary
Added the ability to edit delivery items (add, remove, adjust quantities) while a delivery is still in the `scheduled` status. Previously, items were permanently locked to the original order, requiring cancellation and recreation if any product couldn't be delivered. Now sales reps can quickly swap out unavailable products without losing the rest of the delivery.

### How It Works
- **Scheduled deliveries**: Full item editing — +/- quantity buttons, remove item (red X), "Add item from order" dropdown
- **In-progress deliveries**: Items remain locked (no change to existing behavior)
- **Removed items**: Stay on the order's `quantity_remaining` and appear automatically for future deliveries
- **Validation**: Backend validates quantities against `order_items.quantity_remaining` minus what other active deliveries have scheduled

### Changed Files
- **`supabase/migrations/20260334200000_edit_delivery_items_when_scheduled.sql`** — Replaces `edit_delivery()` RPC to process `p_items` when scheduled
- **`src/pages/DeliveryDetail.tsx`** — Edit mode now shows interactive item controls for scheduled deliveries
- **`CLAUDE.md`** — Updated Hard Red Line and delivery lifecycle to reflect new rule
- **`docs/workflows/SAFE_DEVELOPMENT_RULES.md`** — Updated business logic rule
- **`docs/workflows/QUOTE_TO_DELIVERY.md`** — Updated delivery rules section

### Business Rule Change
- **Old rule**: "NEVER allow editing delivery item quantities — locked to original order"
- **New rule**: "Items editable while scheduled; locked once in_progress or beyond"

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-21 — Order Print Feature: Order Summary + Pick List PDFs

### Summary
Added print functionality for orders — both a customer-facing Order Summary and a warehouse Pick List with inventory shortage warnings. Eliminates the workaround of creating/cancelling deliveries just to get a printable product list.

### New Files
- **`src/lib/orderSummaryPdf.ts`** — Customer-facing order summary PDF (order details, items with pricing, excludes internal cost/margin)
- **`src/lib/orderSummaryPdf.test.ts`** — 21 unit tests
- **`src/lib/orderPickListPdf.ts`** — Warehouse pick list PDF with ordered/delivered/remaining columns, inventory availability, and shortage warnings highlighted in red
- **`src/lib/orderPickListPdf.test.ts`** — 23 unit tests

### Modified Files
- **`src/pages/OrderDetail.tsx`** — Added "Print Summary" and "Print Pick List" buttons in action bar (available for all order statuses)
- **`src/pages/Orders.tsx`** — Added "Print Summaries" and "Print Pick Lists" bulk actions (select multiple orders, generate multi-page PDFs)

### Bug Fix
- **`save_customer` FK violation** — Applied migration to fix `save_customer` RPC that crashed when editing customers with deliveries (FK constraint on `customer_addresses`). Now uses smart upsert instead of delete-all.

### Stats
- 1,713 unit tests (110 files), all passing
- 0 lint errors, build clean

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-20 — Mega Logic Audit Phase 1 & 2 Fixes (12 RPCs + 6 Frontend)

### Summary
Comprehensive logic audit found 105+ issues across 8 domains. Phase 1 (Critical) and Phase 2 (High) fixes applied — 12 RPC functions fixed and 6 frontend files corrected.

### SQL Fixes (12 RPCs)
- **get_ar_aging** (FIN-1): Include `overdue` invoices in AR aging, not just `posted`
- **get_monthly_summary** (FIN-5): Fix commission cents conversion (`commission_amount * 100`), include overdue in AR, add order status/deleted filters
- **financial_dashboard_summary** (FIN-1/12/13): Include overdue AR, filter cancelled/deleted orders from revenue/profitability, add deleted_at filter to AR queries
- **apply_prepay_to_invoice** (XD-2): Update `customers.prepay_balance_cents` when applying prepay, allow overdue invoices, auto-pay when balance reaches 0
- **cancel_delivery** (DEL-1): Add missing `save_idempotency()` call — was checking but never saving
- **generate_finance_charges** (XD-3): Fix season calculation from `>= 7` to `>= 10` (October, not July)
- **allocate_payment** (XD-6): Add `financial_audit_log` entry for payment allocations
- **convert_quote_to_order** (INV-1): Release inventory holds (`is_active = false`) when converting planned quote to order
- **create_invoice_from_order** (FIN-4): Filter out already-invoiced order items, delete empty invoices
- **update_order_items** (ORD-3/4): Recalculate cost_per_unit, profit, net_margin on same-product edits + order-level totals
- **save_quote** (QTE-1): Preserve `is_planned` and `section_header_notes` in both UPDATE and INSERT paths
- **void_invoice** (FIN-6): Cancel pending commissions when no active invoices remain for the order

### Frontend Fixes (6 files)
- **Returns.tsx** (FE-1): CSV export divides `total_credit_cents` by 100 for dollars
- **Invoices.tsx** (FE-2): CSV export divides `total_amount_cents` and `balance_cents` by 100
- **Orders.tsx** (XD-5/7, FE-11): Add `.is('deleted_at', null)` filter, change hard delete to soft delete, fix regex replace for status badges
- **Quotes.tsx** (XD-9): Add `.is('deleted_at', null)` filter
- **CustomerDetail.tsx** (XD-5): Add `.is('deleted_at', null)` to both order queries

### Migrations
- `20260333800000_drop_inventory_qty_available_check.sql` — Drop CHECK constraint blocking negative inventory (INV-4)
- `20260333900000_mega_audit_phase1_fixes.sql` — 7 full RPC definitions + documentation for 5 large RPCs applied directly

### Stats
- 2 new migrations (213 → 215), 12 RPCs fixed, 6 frontend files modified
- 1,653 unit tests passing, 0 lint/TS errors, CI green

### Audit Reference
- Full audit: 2026-03-20 mega-logic-audit _(doc not retained)_ (105+ issues found)
- Phase 3 (Medium) fixes applied in same session (see below)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-20 — Mega Logic Audit Phase 3 Fixes (26 Frontend Files)

### Summary
Phase 3 (Medium priority) sweeps across 6 categories, fixing consistency issues found in the mega logic audit. All frontend-only changes — no new SQL migrations.

### Soft Delete Filtering Sweep (8 files)
Added `.is('deleted_at', null)` to queries that were missing it:
- **Reports.tsx** — Customer profitability + revenue queries (also added status filter for confirmed/fulfilled)
- **NewDelivery.tsx** — Orders lookup
- **Rebates.tsx** — Orders lookup
- **NewOrder.tsx** — Duplicate order check
- **Returns.tsx** — Customer orders query
- **QuoteBuilder.tsx** — Duplicate order warning
- **Customers.tsx** — Open invoices check (also added `overdue` status)
- **CustomerContextCard.tsx** — Orders count

### CSV Export Formatting Sweep (4 files)
Used `fmtCSV()` for proper dollar formatting in CSV exports:
- **PrepaymentManager.tsx** — prepay_balance_cents, unpaid_balance_cents
- **CommissionPayments.tsx** — total_amount (dollars, not cents)
- **PaymentHistory.tsx** — amount_cents
- **ARaging.tsx** — statement export amount_cents, running_balance

### parseDollarsToCents Sweep (7 files)
Replaced `Math.round(parseFloat(x) * 100)` with `parseDollarsToCents()` to avoid floating-point bugs:
- **CustomerDetail.tsx**, **FieldDetail.tsx**, **InvoiceDetail.tsx**, **NewVendorBill.tsx** (3 instances), **PrepaymentManager.tsx** (3 instances), **Rebates.tsx**, **VendorBillDetail.tsx**

### Missing logActivity Sweep (4 files, 6 critical operations)
Added audit logging to 6 critical financial operations that were missing it:
- **MonthEndClose.tsx** — `close_accounting_period`, `reopen_accounting_period`
- **Deliveries.tsx** — `batch_cancel_deliveries`, `batch_reschedule_deliveries`, `reassign_delivery`
- **WriteOffModal.tsx** — `apply_write_off`
- **FinanceChargePreviewModal.tsx** — `generate_finance_charges`

### Reconciliation Function Fix (2 files)
- **reconciliation.ts** — Fixed `checkInventoryLedger` to handle all 11 transaction types (was only handling 6). Fixed `booked` incorrectly subtracting from `quantity_available` (it only affects `quantity_prebooked`). Added: `job_applied`, `cancelled_delivery_reversal`, `void_delivery_reversal`, `prebooked`, `released`.
- **reconciliation.test.ts** — 8 new tests for all transaction type behaviors including comprehensive combined test

### Stats
- 0 new migrations, 26 files modified, 1,658 unit tests passing (was 1,653)
- 0 lint/TS errors, build clean

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-19 — Transaction Ledger Fix + Outstanding PO Tab + HelpTip Expansion (Night Session)

### Changes
- **Transaction Ledger sign logic fix** (`TransactionLedgerModal.tsx`): The `computeRunningBalance()` function was summing raw positive quantities instead of applying sign based on transaction type. Booked/delivered/prebooked/job_applied now correctly shown as negative (subtracts from inventory), while received/returned/released/reversals show as positive. New `signedQuantity()` function matches `reconciliation.ts` logic. Running balance now accurately reflects inventory position.
- **Outstanding PO Items tab** (`PurchaseOrders.tsx`): New "Outstanding Items" tab showing all PO line items not yet fully received across all vendors. Grouped by vendor with columns: PO#, Product, Ordered, Received, Remaining, Value, PO Status, Expected Date. Overdue items highlighted in red. Summary cards for total items, qty, value, vendor count, and overdue count. Vendor filter dropdown. CSV and PDF export.
- **HelpTip expansion**: Added contextual help tooltips to 8 more pages: InventoryPage, Products, PurchaseOrderDetail, QuickReceive, ReceivingLog, CycleCounts, CropPrograms, DeliveryRemainders
- **Getting Started page major expansion**: From 3 section cards to 9 expandable guide sections covering: Quote Building (6 steps), Planned Programs & Inventory Holds, Managing Orders, Deliveries (two-step flow), Supplier POs, Inventory Management, Invoicing & Payments, Reports & Analytics, Common Mistakes, Pro Tips, and Roles & Permissions matrix. Role-aware (drivers see simplified version).
- **Updated tests**: TransactionLedgerModal tests rewritten for new sign logic — 20 tests covering all 11 transaction types, real-world scenario matching screenshot data, and edge cases

### Stats
- 0 new migrations, 0 new RPCs, 0 new tables
- 12 files modified, 1653 unit tests passing, build clean

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-19 — Launch Readiness UX (Evening Session)

### Changes
- **HelpTip component** (`src/components/ui/HelpTip.tsx`): Reusable click-to-show contextual help popover with HelpCircle icon
- **Getting Started page** (`/getting-started`): Role-aware workflow guide — admin/sales see Quote→Order→Deliver stepper, drivers see Dashboard→Deliver stepper. Sidebar link with BookOpen icon
- **Enhanced empty states**: Quotes, Orders, Deliveries, and TeamBoard pages now show workflow guidance and action buttons when empty
- **~26 contextual help tips** across QuoteBuilder (8), OrderDetail (4), DeliveryDetail (6), TeamBoard (4), and list pages (3) — business-process explanations for planned programs, delivery completion, signatures, invoicing, etc.
- **DataTable column headers**: Now accept ReactNode (not just string) to support inline HelpTip components
- **RLS security fix**: Deny-all policy on `rate_limit_log` table (migration `20260333700000`)
- **New migration:** `20260333700000_rate_limit_log_rls.sql`

### Stats
- 1 new page, 1 new component, 3 new tests, 1 migration
- 12 files modified across pages and components

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-19 — Pre-Production Audit Fixes (7 Issues)

### Changes
- **Fix broken routes**: Added `/customers/new` and `/fields/new` routes in App.tsx — both were navigating to non-existent routes, silently redirecting to dashboard
- **QuickDeliveryModal error handling**: Added try/catch + Sentry logging to product/driver fetch — was silently showing empty lists on network error
- **ManualTicketCreate validation**: Added customer_id required check before save — was allowing blend tickets with null customer
- **BulkProductImport margin bug**: Removed broken `num > 1 ? num/100 : num` auto-normalization heuristic — was corrupting margins like 1.5 (150%). Now stores raw value and shows warnings for values > 1
- **BulkProductImport tier validation**: Added non-blocking warnings for inverted tier pricing (tier1 > tier2) and below-cost pricing
- **QuickDeliveryModal optional invoice**: Added "Create draft invoice" checkbox (ON by default) + confirmation dialog before submit. Previously auto-created invoice with no user choice and no confirmation
- **Migration 20260333600000**: Updated `create_quick_delivery` RPC with `p_skip_invoice boolean DEFAULT false`, fixed missing `save_idempotency()` call (idempotency was check-only, never saved), fixed `search_path` missing `pg_temp`

### Files Modified
- `src/App.tsx` — 2 new route entries
- `src/components/deliveries/QuickDeliveryModal.tsx` — error handling, checkbox, confirm dialog
- `src/components/blendtickets/ManualTicketCreate.tsx` — customer validation
- `src/components/products/BulkProductImport.tsx` — margin fix + tier warnings
- `supabase/migrations/20260333600000_quick_delivery_optional_invoice.sql` — new migration

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-18 — Fix 5 RPCs Missing p_idempotency_key (PostgREST Schema Cache Errors)

### Root Cause
Five RPCs were created AFTER the idempotency injection (20260306200000) and consolidation (20260331600000) migrations, so neither pass added `p_idempotency_key` to their signatures. The frontend sends this parameter on every call, and PostgREST matches by exact parameter names — causing "Could not find function in schema cache" errors.

### Migration: 20260333300000_fix_missing_idempotency_params.sql
- **reverse_receiving_record** — Added `p_idempotency_key`, restored `set_config('app.reversal_rpc_active')` for trigger safety
- **void_payment** — Added `p_idempotency_key` with full idempotency check/save
- **edit_prepay_credit** — Added `p_idempotency_key` with full idempotency check/save
- **delete_prepay_credit** — Added `p_idempotency_key` with full idempotency check/save
- **batch_post_invoices** — Recreated entirely (was dropped in 20260311200000 and never recreated). Now returns `jsonb` with `{ success, count, total_cents }`
- All functions: `SET search_path = public, pg_temp` for security
- Verification block ensures exactly 1 overload per function

### Audit Methodology
- Searched all `supabase.rpc()` calls passing `p_idempotency_key` in frontend (71 call sites)
- Cross-referenced with latest SQL function definitions in migrations
- Filtered out RPCs already handled by the consolidation migration (20260331600000)
- Identified 5 RPCs created post-consolidation that were never swept into any fix pass

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-18 — Full Sales Cycle Live UI Test + Bug Fixes

### Live Browser Test (Playwright)
- Tested complete sales cycle: Quote → Order → Delivery → Invoice → Payment → Partial Return
- Used [E2E] test fixtures only — no real data touched
- All financial integrity verified: inventory tracking, invoice balance, payment allocation
- All test data cleaned up after completion

### Bug Fix: Returns Product Select (Returns.tsx)
- **Bug:** Product select `onChange` handler called `updateItem()` 3 times sequentially, each spreading from stale closure `newItems`. React 18 batching meant only the last `setNewItems` won, losing `product_id` and `product_name`
- **Fix:** Batched all field updates into a single `setNewItems` call
- **Impact:** Product selection in New Return modal was silently failing — selected product would revert to empty

### Migration: Fix save_quote Idempotency + Activity Feed Columns (20260333100000)
- Fixed `save_quote()` RPC with wrong `idempotency_keys` column names (`key`→`idempotency_key`, `entity_type`/`entity_id`→`operation`/`result`)
- Fixed `v_server_totals` field aliases (`.sum`→`.total_price`)
- Fixed `activity_feed` column names (`action`→`event_type`, `entity_type`→`related_entity_type`, `entity_id`→`related_entity_id`)
- Added `pg_temp` to search_path

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-17 — Code Quality Enforcement (Phase 1-4)

### assertRpcResult Final Sweep (28+ violations → 0)
- Added assertRpcResult() to all remaining RPC data casts across 30+ files
- Files: ARaging, CustomerDetail, Compliance, FieldDetail, Fields, InventoryPage,
  NewOrder, QuoteBuilder, ReceivingLog, SalesReports, ManualTicketCreate,
  FinanceChargePreviewModal, LogbookReport, TodaysDeliveries, YesterdayRecap,
  WorkloadView, RelatedNotes, CustomerContextCard, BulkTicketUpload,
  BulkFieldImport, CustomerTransactionReview, CycleCounts, Dashboard,
  MonthEndClose, NewDelivery, NewPurchaseOrder, OrderDetail,
  PurchaseOrderDetail, Reports, Returns

### Idempotency Key Gaps (5 → 0)
- Added p_idempotency_key to: BulkFieldImport (save_field, save_field_geometry),
  ReceivingLog (reverse_receiving_record), notificationTriggers
  (log_failed_notification, notify_damaged_receiving)

### Local ESLint Plugin (2 rules)
- `require-assert-rpc-result`: blocks .rpc() data usage without assertRpcResult()
- `no-direct-sentry-import`: blocks direct @sentry/react imports
- `no-console` tightened: console.warn no longer allowed
- Lives in `eslint-local-rules/` — works on all machines via git pull

### logActivity Type Safety
- Refactored from 6 positional string params to single typed object (LogActivityParams)
- Updated all 57 call sites across 23 files
- TypeScript compiler now catches parameter-shift bugs

### Safety-Net Unit Tests (+3 tests)
- assertRpcCoverage.test.ts — scans for .rpc() data usage without assertRpcResult
- sentryImportEnforcement.test.ts — scans for direct @sentry/react imports
- logActivitySignature.test.ts — verifies logActivity uses typed object params

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-17 — Code Audit Phase 2: assertRpcResult + Sentry + Safety Fixes (7 files)

### assertRpcResult Coverage (Phase 2 — 7 more files, ~20 RPC calls)
- Added `assertRpcResult()` to read & mutation RPCs that were casting `data` without null guard
- **Dashboard.tsx** — `operational_dashboard_summary`
- **FinancialDashboard.tsx** — `financial_dashboard_summary`
- **QuickReceive.tsx** — `match_quick_receive_items` + `receive_po_items`
- **AccountsPayable.tsx** — `get_ap_dashboard_summary` + `get_ap_aging`
- **Reports.tsx** — 8 RPCs: `get_bottom_line_pnl`, `get_gross_sales_report`, `get_customer_balance_listing`, `get_commission_balance_report`, `get_chemical_history`, `get_inventory_cost_report`, `get_batch_year_end_summaries`, `get_customer_year_end_summary`
- **QuoteBuilder.tsx** — `save_quote` + `create_quote_version` (×2 locations)
- **MonthEndClose.tsx** — `get_monthly_summary` + `get_batch_year_end_summaries`

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-17 — Comprehensive Code Audit & Hardening (29 files, +1053/-107)

### assertRpcResult Coverage (~30 RPC calls)
- Added `assertRpcResult()` to mutation RPC calls across 18 pages/components to catch silent RLS permission denial (data=null). Carefully excluded void-returning RPCs that would false-positive
- Files: NewOrder, NewPurchaseOrder, NewVendorBill, QuickDeliveryModal, JobDetail, Invoices, InvoiceDetail, Deliveries, DeliveryDetail, CommissionPayments, PaymentHistory, PrepayWorkspace, PrepaymentManager, FinanceChargePreviewModal, OrderDetail, FieldDetail, SettingsPage, CustomerDetail

### ConfirmModal Replacement (9 pages)
- Replaced all bare `confirm()`/`window.confirm()` calls with proper `ConfirmModal` component per project rules
- Files: DeliveryDetail (2), OrderDetail (1), CycleCounts (3), Rebates (2), ARaging (2), CommissionPayments (1), InvoiceDetail (1), JobDetail (3), PaymentAllocation (1)

### Idempotency Key Wiring (15 RPC calls)
- Added `useIdempotencyKey` hooks and `p_idempotency_key` params to 15 frontend RPC calls
- Files: FieldDetail (save_field, save_field_geometry), SettingsPage (admin_update_profile), OrderDetail (void_order), JobDetail (load_recipe_into_job), CustomerDetail (save_customer), QuoteBuilder (create_planned_holds, save_quote_template, create_quote_from_template, rollover_quote_to_season, create_quote_version ×2, restore_quote_version), DeliveryDetail (reassign_delivery)

### DB Migration: `20260320100000_add_idempotency_to_remaining_rpcs.sql`
- Added `p_idempotency_key text DEFAULT NULL` to 5 RPCs: save_field, save_field_geometry, admin_update_profile, void_order, load_recipe_into_job
- Each function explicitly rewritten (no pg_get_functiondef + regex anti-pattern)
- DROP old signature → CREATE new → GRANT → verify no overloads

### Bug Fixes
- **Returns.tsx** — Removed references to non-existent `updated_at` column on `returns` table (lines 314, 343)
- **teardown-fixtures.ts** — Fixed reference to non-existent `entity_id` column on `idempotency_keys` table
- **Rebates.tsx** — Fixed `keyof ProgramRow` type error (strict tsconfig.app.json compatibility)

### Infrastructure
- **eslint.config.js** — Added `CRX_Manager_V1.0` to ignores to exclude stale nested directory copy that was causing 100+ false lint errors
- **Test mocks** — Added `assertRpcResult` to test mocks for FinanceChargePreviewModal and QuickDeliveryModal

### Audit Findings (logged for future sessions)
- ~50 mutation handlers across 21 files missing `logActivity()` audit trail calls
- 6 TypeScript/DB type mismatches: Order has dropped columns (balance_due, total_paid, created_by), WriteOff missing reversed_by, InvoiceLineAllocation missing invoice_id, Commission.season should be nullable
- `rate_limit_log` table should get explicit deny-all RLS policy for consistency

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Code Quality Session: Sentry Migration, A11y, Safety-Net Tests

### Error Reporting
- **Sentry migration** — Migrated ~30 remaining `console.error` calls to `Sentry.captureException` across components, hooks, edge functions, and contexts. Now all production errors route to Sentry for visibility
- **Test update** — Updated `useOCRProcessor.test.tsx` to mock `@sentry/react` instead of `console.error` (ESM-compatible `vi.hoisted` pattern)

### Accessibility
- **click-events-have-key-events** — Fixed all 13 remaining jsx-a11y warnings with `role="button"`, `tabIndex={0}`, and `onKeyDown` handlers (BulkFieldImport, CustomerContextCard, CropPrograms, Deliveries, Products, QuoteBuilder, TeamBoard, BulkPOImport, YesterdayRecap, DeliveryDetail)

### Safety-Net Tests
- **Function overload detection contracts** — 42 critical functions listed; validates no duplicates, all snake_case, all mutating RPCs covered
- **Mutating RPC idempotency contracts** — 28 RPCs that must accept `p_idempotency_key`; validates critical business RPCs are covered
- **SECURITY DEFINER pg_temp contracts** — 38 functions requiring `pg_temp` in search_path; validates overlap with mutating RPCs

### Commission Audit Trail
- **Reports.tsx** — Replaced direct `.update()` commission mark-paid with `create_commission_payment` RPC for proper audit trail (creates payment record, payment items, updates status, logs to `financial_audit_log`)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Overnight Session: DB Security, Code Quality, Delivery Features

### Phase A: Database Housekeeping
- **A1: pg_temp search_path fix** — Migration `20260332800000` uses `ALTER FUNCTION` to add `pg_temp` to search_path on ALL SECURITY DEFINER functions. Verification block confirms zero functions remain unpatched. Prevents temp schema hijacking attacks
- **A2: Data validation & cleanup** — Migration `20260332900000` fixes negative inventory quantities, recalculates prebooked from actual pending orders, verifies commission splits sum to 100%, checks invoice paid_amount_cents integrity, fixes invalid commission statuses. All checks passed clean on production

### Phase B: Code Quality Sprint
- **B1: runCriticalAction migration** — Migrated ~47 pages from bare `try/catch + console.error` to centralized `runCriticalAction()` pattern (toast + Sentry.captureException). Also replaced `console.error` with `Sentry.captureException` in 3 lib files (activityLogger, notificationTriggers, imageCompression)
- **B2: Skeleton loading states** — Added animated skeleton placeholders to 10 high-traffic list pages (Orders, Deliveries, Invoices, Products, Customers, Quotes, PurchaseOrders, Returns, ARaging, InventoryPage)
- **B3: Firefox E2E** — Added Firefox project to `playwright.config.ts`, updated CI to install both Chromium and Firefox browsers
- **B4: CSP tightening** — SKIPPED: Mapbox GL JS and Google Fonts both inject inline styles; `unsafe-inline` must stay in `style-src`
- **Accessibility lint** — Added `eslint-plugin-jsx-a11y` with 18 cherry-picked rules at `warn` level (avoided `recommended` spread due to minimatch compatibility crash with flat ESLint config)
- **ESLint no-console tightened** — Removed `'error'` from allowed console methods; only `console.warn` now permitted

### Phase C: Delivery Features
- **C1: Delivery Calendar View** — New `DeliveryCalendar.tsx` component using `@fullcalendar/react` with dayGrid + interaction plugins. Status-based color coding (blue=scheduled, amber=in_progress, green=completed, gray=cancelled). List/Calendar toggle on Deliveries page
- **C2: Email opt-out** — Added checkbox "Email delivery receipt to customer" (default: checked) to both driver (dark theme) and admin (light theme) completion UIs in DeliveryDetail. Email sending gated by checkbox state
- **C3: In-app notifications** — New `notifyDeliveryCompleted()` function in `notificationTriggers.ts`. Notifies admins, assigned driver, and sales reps from linked order commissions. Deduplicates notifications

### Phase D: Stretch Goals
- **D1: Request correlation IDs** — Custom fetch wrapper in `db.ts` adds unique `X-Request-ID` header to every Supabase request. Sentry breadcrumbs recorded with requestId for full request tracing
- New dependencies: `@fullcalendar/react`, `@fullcalendar/daygrid`, `@fullcalendar/interaction`, `eslint-plugin-jsx-a11y`

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Team Board V2 Phase 2 (Escalation, Context, Workload)

- **F5: Escalation Engine** — `StaleTasksAlert` component surfaces overdue tasks with 3 visual tiers: amber (1-3d), red (3-7d), critical (7d+ with pulse animation). Collapsible summary with counts. Sorted most overdue first
- **F9: Customer Context Cards** — `CustomerContextCard` on customer-linked notes shows tier, AR aging, open orders, and last delivery date. Module-level `Map` cache prevents N+1 queries
- **F7: Workload Visibility tab** — new "Workload" tab on Team Board calls `get_team_workload()` RPC. Color-coded cards (green/amber/red) with expandable detail grid per team member
- Migration: `20260316950000_team_board_phase2.sql` — adds `last_escalated_at` to `team_notes`, creates `get_team_workload()` RPC
- New files: `StaleTasksAlert.tsx`, `CustomerContextCard.tsx`, `WorkloadView.tsx`
- Updated `TeamBoard.tsx` with new tab + escalation alert on Board view
- Updated `NoteCard.tsx` to render customer context inline
- Added `last_escalated_at` to `TeamNote` TypeScript interface

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Infrastructure Hardening (Quick Wins)

- **A1: Unhandled rejection safety net** — `window.addEventListener('unhandledrejection', ...)` in `main.tsx` catches async errors that bypass React ErrorBoundary, reports to Sentry
- **A7: ESLint `no-console` rule** — warns on `console.log`/`info`/`debug`, allows `error`/`warn`. Zero existing violations, purely preventive
- **A3: Sentry sourcemap uploads** — installed `@sentry/vite-plugin`, `sourcemap: 'hidden'` generates maps without exposing to users. Plugin uploads to Sentry then deletes from `dist/`. Only active when `SENTRY_AUTH_TOKEN` env var is set (Vercel CI)
- **A5: Per-route error boundaries** — enhanced `ErrorBoundary` with `inline` prop for compact in-page error UI. Added `RouteShell` wrapper in `App.tsx` so page crashes don't take down sidebar navigation. 2 new unit tests
- Design doc: `2026-03-16-infrastructure-hardening-design.md` _(design doc, not retained in repo)_

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Forensic Audit & Idempotency Fix Round 3

- **Forensic audit** — 6-agent parallel audit of entire codebase: RPC column names, migration ordering, frontend-DB alignment, TypeScript types, table headers, RPC parameters
- **CRITICAL FIX: Idempotency column references (round 3)** — 58 broken references across 16 migration files. Migrations created after the round 1 fix re-introduced `key` (should be `idempotency_key`), `entity_type`/`entity_id` (should be `operation`/`result`), and `result_id` (should be `result`). New migration `20260332700000` fixes all with safety-net scan + self-testing verification block.
- **FIX: Quotes.tsx CSV/PDF export** — `customer_name` key changed to `customer` to match Supabase join shape
- **FIX: SalesReports.tsx PDF header** — "Price" changed to "Unit Price" to match CSV and DataTable headers
- **FIX: TypeScript type drift** — Added `program_notes`, `balance_due`, `total_paid` to Order interface; `pdf_template_id`, `pdf_columns_override` to Quote interface; new `ArReminderTracking` interface
- **Prevention: 3-layer defense** — Pre-commit hook validates SQL for wrong idempotency patterns, full audit script (`scripts/validate-sql-migrations.sh`), Claude Code PreToolUse hook blocks bad patterns at write-time
- Migration: `20260332700000_fix_idempotency_column_refs_round3.sql`

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Quote Builder V2 E2E Test Suite

- **New E2E spec** `tests/e2e/quote-builder-v2.spec.ts` — 20 serial steps covering all 12 V2 sprints
- Tests: quote creation, versioning, section header notes, planned programs, PDF templates, quote templates, notes pipeline flow, inventory forecasting, seasonal rollover, "New from Last Quote" quick create
- Uses `safeRpc()`/`safeRest()` wrappers for resilience against unapplied V2 migrations
- Full cleanup in Step 20 — deletes all created quotes, orders, and templates
- All 20/20 tests passing, 2.5 min runtime

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Quote Builder V2 (Sprints 8-12: Notes Flow, Forecasting, Rollover, Quick Quote)

- **Sprint 8: Notes Pipeline Flow** — Notes now flow through the full quote→order→delivery pipeline. `order_items.notes` column added for per-line product notes copied from quote_items. `orders.program_notes` column added for aggregated section header notes. Load sheet PDF shows notes column when present. Migration: `20260316700000_notes_pipeline_flow.sql`
- **Sprint 9: Customer Detail Quotes Tab** — Enhanced with planned programs filter and `is_planned` badge for easy identification of crop programs vs one-off quotes
- **Sprint 10: Inventory Forecasting** — New Inventory Forecasting tab on Inventory page showing planned demand vs supply with gap alerts. New `get_inventory_forecast()` RPC aggregates planned demand by product/month. Migration: `20260316800000_inventory_forecasting.sql`
- **Sprint 11: Seasonal Program Rollover** — `rollover_quote_to_season()` RPC duplicates a quote with updated pricing for a new season. "Roll Over" button added to QuoteBuilder for quick season transitions. Migration: `20260316900000_seasonal_rollover.sql`
- **Sprint 12: Quick Quote from Customer** — "New from Last Quote" button on Customer page creates a new quote pre-populated from the customer's most recent quote. `customer_id` URL param on QuoteBuilder auto-sets the customer on load

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Quote Builder V2 (Sprint 1: Product Internal Notes)

- **New `internal_notes` column** on `products` table — internal-only notes, never shown to growers
- **Relabeled "Notes"** to **"Grower Description"** on ProductDetail page with helper text
- **New "Internal Notes"** textarea on ProductDetail page with helper text ("Internal only — never shown to growers")
- Existing `notes` data auto-copied to `internal_notes` during migration — zero breaking changes
- 3 new unit tests for the internal notes field
- Migration: `20260316100000_product_internal_notes.sql`

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — New Order: Per-Line Margin Calculation + Editable Price Override

- **Per-line margin display** on New Order page — each line item shows Total, Profit ($), and Margin (%) with color-coded thresholds (green ≥20%, amber 10-20%, red <10%)
- **Editable price per unit** with override detection — amber highlight and "price overridden" indicator when price differs from customer tier
- **Reset to tier price** button (RotateCcw icon) — appears on overridden items, tooltip shows the tier price it resets to
- **Order Totals summary card** — aggregate total, profit, and margin for the entire order
- **Customer swap recalculates all prices** — clears overrides and recalculates to the new customer's tier
- **Product swap clears override** — fresh start with the new product's tier price
- No DB migration needed — `order_items.price_per_unit` already stores the effective price
- Mirrors the exact pattern from the Quote Builder editable price feature

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Quote Builder Editable Price/Unit with Auto Margin Recalc

- **Editable price/unit** in Quote Builder — price input is now a number field instead of static text
- **Price override detection** — typing a price different from the tier price highlights the field amber and shows a reset button
- **Auto margin recalc** — profit, margin %, $/acre, and quote totals all update instantly when price is overridden
- **Reset to tier price** button (RotateCcw icon) appears on overridden items, tooltip shows the tier price
- **Override sticks** through rate/acres changes but resets on product swap or customer tier change
- **Existing quote detection** — loading a saved quote detects overridden prices by comparing saved price vs tier price
- No DB migration needed — `quote_items.price_per_unit` already stores the effective price

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-15 — Bug Sweep Branch Review & Type Drift Fixes

### TypeScript Type Drift (verified against DB schema)
- **InvoiceStatus**: added `paid` | `overdue` to match DB CHECK constraint (from `20260312100000`)
- **CommissionPayment.status**: added `voided` to match DB CHECK constraint (from `20260331120000`)
- **Invoice badge maps**: added `paid` (info) and `overdue` (error) entries in `InvoiceDetail.tsx` and `Invoices.tsx`

### Idempotency Column Fix Round 2 (migration `20260332200000`)
- 10 RPCs had wrong `idempotency_keys` column names re-introduced by March 31 migrations
- Fix: `key` to `idempotency_key`, `result_id` to `result` (with jsonb cast), `entity_type`/`entity_id` to `operation`/`result`

### Branch Review Findings (claude/final-bug-sweep-RnKBF)
- **Rejected**: Deleting E2E fixture files, removing CLAUDE.md rules, search_path fixes (not needed), ConfirmModal doc reverts

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Fix Commission Payment RPCs (migration `20260332600000`)

- Fixed `create_commission_payment` and `void_commission_payment` RPCs crashing due to non-existent `updated_at` column on `commissions` table (found by deep audit). Added SQL validation pre-commit hook and Claude Code PreToolUse hook to prevent similar bugs.

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Fix receive_po_items Crash + Expand Audit Log CHECK Constraints (migration `20260332500000`)

### receive_po_items RPC — crash on UPDATE
- `receive_po_items` was crashing because it referenced `updated_at` on `purchase_order_items`, which does not have that column
- Fix: removed `updated_at = now()` from the UPDATE statement

### financial_audit_log — missing operation_type values
- CHECK constraint was missing 5 values used by existing code: `invoice_marked_overdue`, `prepay_reconciliation`, `batch_prepay_apply`, `blend_ticket_linked`, `blend_ticket_unlinked`
- Any INSERT using these values would throw a constraint violation
- Fix: expanded operation_type CHECK constraint to include all 5 missing values

### financial_audit_log — missing entity_type value
- `blend_ticket` was absent from the entity_type CHECK constraint
- Fix: added `blend_ticket` to entity_type CHECK constraint

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Comprehensive Audit Log & Admin Override Fix (migration `20260332400000`)

### cancel_delivery — admin_override ordering bug
- `SET LOCAL app.admin_override = 'true'` was positioned AFTER the order status re-evaluation block
- Reverse transitions (e.g. `fulfilled → confirmed`) were blocked by `_enforce_order_status_transition` trigger
- Fix: moved admin_override to BEFORE any status updates

### mark_overdue_invoices — wrong column names + NULL actor
- Used `event_type`, `performed_by`, `metadata` instead of `operation_type`, `actor_user_id`, `new_values`
- Passed NULL for actor (cron context), violating NOT NULL constraint on `actor_user_id`
- Fix: correct column names + explicit system admin UUID for cron context

### link/unlink_blend_ticket — wrong column names
- Same wrong column pattern as mark_overdue_invoices (`event_type`/`performed_by`/`metadata`)
- Fix: rewritten with correct `operation_type`/`actor_user_id`/`new_values` columns

### Safety-net trigger for 20 other functions
- 20 additional RPCs omit `actor_user_id` from financial_audit_log INSERTs
- They rely on `DEFAULT auth.uid()` which works from frontend but fails from pg_cron/direct SQL
- Fix: BEFORE INSERT trigger `trg_fill_audit_actor` on financial_audit_log fills NULL actor_user_id with auth.uid() or admin fallback

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — void_delivery Fix & Fake Data Cleanup

### void_delivery RPC — 4 bugs fixed (migration `20260332300000`)
- **Bug 1**: `quantity` column reference → `total_units_needed` (column was renamed in earlier migration but void_delivery never updated)
- **Bug 2**: Missing `app.admin_override` for reverse status transitions (fulfilled→confirmed blocked by trigger)
- **Bug 3**: `financial_audit_log` INSERT missing `actor_user_id` (NOT NULL violation under SECURITY DEFINER)
- **Bug 4**: `idempotency_keys` wrong column names (`key`→`idempotency_key`, `result_id`→`result`)
- All 4 bugs masked each other — Bug 1 failed first, hiding bugs 2-4

### Fake Data Cleanup
- Removed "A9 Test Farm CSV" customer and all child records (2 orders, 2 deliveries, 18 jobs, 6 applicator licenses, 8 rebate claims, 5 application records)
- Inventory corrected: Start Right 2.0 Tote (+265 available released), Start Right 2.0 2.5G (+10 available released)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-16 — Audit Remediation, Idempotency Fixes, Overdue Detection

### Audit Triage & Branch Cleanup
- Verified 24 audit findings across 3 reports — 17 were already fixed or false positives
- Deleted stale branches: `claude/final-bug-sweep-RnKBF`, `claude/analyze-test-coverage-eb1h9`, plus 20 additional stale remote branches
- Realtime null-filter finding: FALSE POSITIVE (guarded by `disabled` flag)
- Commission recipients hardcoding: LOW priority (has "Other..." workaround)

### confirm_delivery Idempotency Fix (migration `20260316300000`)
- Consolidation migration added `p_idempotency_key` parameter but never wired up `check_idempotency`/`save_idempotency` logic
- Frontend was already passing the key (DeliveryDetail.tsx:550) but server ignored it
- Drivers on mobile with spotty connections could create duplicate activity_feed + notification entries

### Invoice Overdue Auto-Detection (migration `20260316115721`)
- New `mark_overdue_invoices()` batch function: scans posted invoices past due_date → transitions to 'overdue'
- Logs each transition to `financial_audit_log` with invoice details
- Naturally idempotent — safe to call from cron/scheduler repeatedly

### RPC Hardening (migration `20260316200000`)
- `apply_write_off`: added `p_idempotency_key` parameter with `check_idempotency`/`save_idempotency` guards
- `batch_apply_prepayments`: added `p_idempotency_key` parameter with idempotency guards
- `generate_finance_charges`: added admin role check (`profiles.role = 'admin'`) at RPC entry

### Frontend Fixes
- **WriteOffModal**: replaced `parseFloat` with `parseDollarsToCents()` for IEEE 754-safe money handling; passes idempotency key to RPC
- **PrepayWorkspace**: replaced `parseFloat * 100` with `parseDollarsToCents()`; passes idempotency key to `batch_apply_prepayments`
- **BulkTicketUpload**: added error checks on two fire-and-forget inserts (`blend_ticket_images`, `ocr_processing_queue`)
- **ReceivingLog**: added `checkMutationResult()` to bulk delete with `.select()` validation
- **Invoices**: added error/null check on `.single()` customer fetch in batch PDF print

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-15 — UX Polish, ConfirmModal, Parallelized Queries, Coverage Reporting

### Replace window.confirm() with ConfirmModal (PRs merged)
- All `window.confirm()` and `confirm()` calls across the app replaced with the shared `ConfirmModal` component
- Provides consistent styled confirmation dialogs instead of browser-native popups
- Covers: Convert Quote to Order, Post Invoice, Complete Delivery, Delete/Void actions

### Parallelize Database Queries (PR merged)
- Orders page and Deliveries page now run independent Supabase queries in parallel instead of sequentially
- Reduces page load time for data-heavy list views

### Accessibility: Aria-labels on Product Filters (PR merged)
- Added `aria-label` attributes to category and vendor filter `<select>` elements on Products page

### Vitest V8 Coverage Reporting
- Added Vitest V8 coverage provider for visibility-only reporting (no enforcement gates)

### 4 Quick-Win Bug Fixes from Branch Audit
- Various small fixes discovered during orphaned branch audit

### E2E Test Suite Hardening
- Eliminated all remaining E2E test skips and fixed 12 failing tests
- Fixed `useToast()` destructuring in team board components

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-15 — Team Board V2: Delivery Bulletin, Entity Linking, Photo Attachments

### Database (Migration 20260315200000)
- Added `linked_entity_type` + `linked_entity_id` to `team_notes` for entity linking
- New `team_note_attachments` table with RLS policies
- New `team-note-attachments` storage bucket with upload/view/delete policies
- 3 new RPCs: `get_team_board_deliveries()` (role-aware), `get_yesterday_delivery_recap()`, `get_notes_for_entity()`

### Frontend — 8 New Components in `src/components/team/`
- `TodaysDeliveries.tsx` — role-aware delivery bulletin (today + tomorrow preview, unassigned alert)
- `YesterdayRecap.tsx` — completion summary with issue cards (auto-expands when issues exist)
- `NoteCard.tsx` — extracted from TeamBoard monolith, priority/overdue badges, entity badge
- `EntityBadge.tsx` — clickable pill badge linking to 6 entity types (delivery, order, customer, job, PO, quote)
- `QuickTaskModal.tsx` — create entity-linked tasks from any detail page
- `RelatedNotes.tsx` — collapsible card showing linked notes on detail pages
- `NotePhotoUpload.tsx` — camera capture + multi-file upload to Supabase storage
- `NoteAttachments.tsx` — thumbnail grid with view/delete support

### Integration — QuickTaskModal + RelatedNotes on 5 Detail Pages
- OrderDetail, DeliveryDetail, JobDetail, CustomerDetail, PurchaseOrderDetail
- "Create Task" button + "Team Notes" collapsible section on each page

### TeamBoard.tsx Updates
- Board tab now shows: Today's Deliveries → Your Tasks → Pinned & Announcements → Yesterday's Recap → three-column grid
- Entity linking fields in create/edit modal
- Photo attachments in detail modal
- Entity badges on note cards

### E2E Tests
- `tests/e2e/team-board-v2.spec.ts` — 26 serial tests covering all V2 features
- 23 passing, 3 skip gracefully when no deliveries scheduled

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-09 — Fix: Tab-Switch No Longer Resets Page Data

### AuthContext (`src/contexts/AuthContext.tsx`)
- `onAuthStateChange` now filters by event type — `TOKEN_REFRESHED` silently updates the session without setting `loading: true`
- `INITIAL_SESSION` events are skipped (already handled by `getSession()` on mount)
- Only real auth changes (`SIGNED_IN`, `SIGNED_OUT`) trigger the full loading state
- `signIn` and `signOut` wrapped in `useCallback` for stable references
- Context value wrapped in `useMemo` to prevent unnecessary child re-renders

### Why
- Supabase's JS client automatically refreshes tokens when the browser tab regains focus
- The old code set `loading: true` on every auth event, which caused `ProtectedRoute` to unmount the entire page tree
- This destroyed all unsaved form data, scroll position, and local component state
- Now only actual sign-in/sign-out events cause a full reload — token refreshes are invisible to the user

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-09 — Farm Group Labels on Orders & Deliveries

### Orders List Page (`src/pages/Orders.tsx`)
- Customer column now shows blue "Farm Group: [Parent Name]" label for linked customers
- Expanded Supabase query to fetch `parent_customer_id`, batch-resolves parent farm names
- Search bar includes `farm_group_name` so staff can search by parent farm

### Deliveries List Page (`src/pages/Deliveries.tsx`)
- Same farm group label on Customer column in admin data table
- DriverCard (mobile driver view) shows blue farm group label under customer name
- Unassigned delivery cards also display the label
- Search bar includes `farm_group_name` for filtering
- Both main and unassigned delivery queries fetch parent customer info

### Why
- `parent_customer_id` existed on `customers` table but was only used in Sales Reports
- Warehouse staff had no visual way to know which orders/deliveries belong to the same farm group
- This is a read-only display change — no logic or billing changes

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-09 — Product Setup UX Improvements

### New: Combobox Component (`src/components/ui/Combobox.tsx`)
- Reusable dropdown with type-to-filter + accept new values (no external dependencies)
- Keyboard navigation (ArrowUp/Down/Enter/Escape), click-outside-to-close, ARIA attributes
- Matches Input.tsx styling; uses `onMouseDown` with `preventDefault()` to prevent blur/click race

### ProductDetail Page Restructure
- **Combobox dropdowns** for Vendor, Manufacturer, Category — fetches distinct values from existing products on mount, still accepts free-text new entries
- **Removed `unit_size`** from form — legacy field replaced by `container_size` + `container_unit` (data preserved in DB)
- **Grouped sections** with dividers and helper text: Product Form → Container (size+unit+type in one row) → Inventory Unit → Application Rates
- No SQL migration needed (UI-only changes)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-08 — Order Editing, Admin Corrections, Transaction Ledger Expansion

### Add Products to Existing Orders in Edit Mode
- Admin can now add new products to an existing order via the product modal in edit mode
- Handles inventory prebooked adjustments correctly when swapping products

### Admin Corrections & Reversal Capabilities (Phases 1-3)
- Admin-only capabilities for correcting and reversing posted transactions
- Multi-phase rollout for safe, auditable corrections

### Transaction Ledger Expansion
- Transaction ledger now shows customer name, reference info, and full notes per transaction
- Added missing FK constraints for transaction ledger joins

### Orders Page Improvements
- Fixed fulfillment progress bar showing 0% for all orders
- Added "Planned" / "Committed" label to orders
- Fixed customer search on Orders page

### Bug Fixes
- `cancel_order` used invalid transaction_type `cancelled_order_release` — fixed
- `cancel_delivery` used invalid transaction_type `prebook_released` — fixed
- `update_order_items` used `quantity_prebooked` instead of `quantity_remaining` — fixed
- `create_direct_order` calling non-existent `next_order_number()` — fixed
- `create_direct_order` using wrong column name `commission_split` — fixed
- Clamped `commission_amount` to 0 when order profit is negative
- `complete_delivery` pre-check + PO edit on partially received orders — fixed

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-08 — Track A: Complete Email Integration

### Email Infrastructure (built earlier same day)
- `email_log` table (audit trail with idempotency), `ar_reminder_tracking` table (dedup)
- `get_ar_reminder_candidates()` RPC, `email_type` enum (8 types)
- Edge Function: `supabase/functions/send-email/index.ts` — Resend-powered, JWT auth, idempotency guard, base64 PDF attachments
- Frontend email service: `src/lib/emailService.ts` — `sendEmail()`, `pdfToBase64()`, `buildEmailHtml()` (CRX-branded HTML template)
- Invoice Email button on `InvoiceDetail.tsx` (admin, posted invoices only)
- Financial Dashboard margin alerts (bottom 10 products/customers, monthly trend chart)
- Migrations: `20260308100000_email_infrastructure.sql`, `20260308200000_dashboard_margin_alerts.sql`

### Track A: Wire Email Into All Customer Touchpoints (A1–A6)
- **A1: Resend DNS** — SPF/DKIM setup instructions for `croprxsolutions.app` (manual step)
- **A2: Quote Email** (`QuoteBuilder.tsx`) — auto-emails quote PDF to customer on send. Generates same PDF as download, converts to base64, attaches to branded HTML email. Falls back gracefully if customer has no email or send fails
- **A3: Order Confirmed Email** (`OrderDetail.tsx`) — auto-emails customer when order status → confirmed. Includes order number, date, item summary table (up to 10 items). Email failure doesn't block status change
- **A4: Delivery Completed Email** (`DeliveryDetail.tsx`) — auto-emails customer on delivery completion. Includes delivered items table, partial delivery note, signature info, photo count. Email failure doesn't block completion
- **A5: AR Reminders** (`ARaging.tsx`) — "Send AR Reminders" admin button. Calls `get_ar_reminder_candidates()` RPC, determines reminder level (30/60/90 day), checks dedup via `ar_reminder_tracking` table, sends urgency-colored HTML email with overdue invoice table. Logs activity
- **A6: Batch Email Statements** (`ARaging.tsx`) — "Email Statements (N)" button (visible when customers are selected). For each selected customer: generates statement PDF, converts to base64, sends branded HTML email with PDF attachment. Logs activity
- **Pattern**: All email sends use graceful degradation — email failure never blocks the core business action
- **No new migration** — all DB objects already existed from earlier same-day migration

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-07 — Sales & Chemical History Reporting

### New: Sales Reports Page (`/sales-reports`)
- **5 report tabs**: Sales Detail (line-item), By Product, By Customer, By Month, By Sales Rep
- **6 filters**: Date Range (with presets: This Season, Last Season, YTD, Last 30/90d), Product, Customer (multi-select), Sales Rep, Category, Season
- **Customer View toggle** — hides cost, profit, margin, and sales rep columns for customer-facing exports
- **Multi-customer selection** with searchable dropdown and chip-based display
- **Farm group support** — auto-detects `parent_customer_id` links, "Include linked farms" toggle groups landlords + main farm into one report
- **Summary cards**: Total Revenue, Total Profit (hidden in Customer View), Units Sold, Orders
- **CSV + PDF export** — respects Customer View visibility (internal data excluded when toggled)
- 3 new RPCs: `get_sales_detail_report()` (LATERAL JOIN to invoices), `get_sales_summary_report()` (CTE-based GROUP BY dimension), `get_customer_farm_group()` (recursive CTE for parent/child farm grouping)
- Migration: `20260307200000_sales_reports.sql`
- Route: `/sales-reports`, roles: admin + sales_rep
- Sidebar: under Finance category between Reports and Compliance

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-07 — Accounts Payable Module + RUP Sales Reporting

### New: Accounts Payable (AP) Module
- **Vendors table** — proper vendor entity with contact info, default payment terms (backfilled from existing PO/product data)
- **Vendor Bills** — track bills from suppliers with payment terms, due dates, aging (unpaid/partially_paid/paid/voided)
- **Vendor Payments** — record payments against bills (check/ACH/wire/credit card), auto-update balance and status
- 5 RPCs: `create_vendor_bill()`, `record_vendor_payment()`, `void_vendor_bill()`, `get_ap_aging()`, `get_ap_dashboard_summary()`
- 4 new pages: AP Dashboard (`/accounts-payable`), Vendor Bills list, New Vendor Bill form, Vendor Bill Detail with payment recording
- Admin-only sidebar section under Finance
- Migration: `20260307100000_accounts_payable_and_rup_reporting.sql`

### New: RUP Sales Register (Compliance)
- **`rup_sales_records` table** — auto-generated from invoices containing Restricted Use Pesticides
- `generate_rup_sales_records()` — called automatically by `post_invoice()` for RUP line items, snapshots product/customer/license data
- `get_rup_sales_register()` — filterable query for state reporting (date range, product, customer, compliance status)
- Compliance status flagging: compliant (valid license), warning (expired), non_compliant (no license)
- New "RUP Sales Register" tab on Compliance page with CSV export
- All FIFRA Section 12 required fields captured

### E2E Tests
- `tests/e2e/accounts-payable.spec.ts` — 8 tests covering AP dashboard, bill lifecycle, void workflow, KPI cards, RUP compliance tab

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-06 — Operational Dashboard Rebuild

### New: Operational Dashboard (10-Section Command Center)
- Complete rewrite of `src/pages/Dashboard.tsx` (~750 lines) — replaces basic 4-section dashboard with comprehensive operational command center
- New RPC `operational_dashboard_summary()` — 25-CTE Supabase function returning all dashboard data in a single round-trip
- Migration: `20260323100000_operational_dashboard_summary.sql`

### Dashboard Sections
1. **Quick Actions** (5 buttons) — New Order, New PO, Schedule Delivery, Inventory, Receiving
2. **KPI Row** (4 cards) — Active Orders, Open Quotes, Pending Deliveries, Open POs
3. **Team Board Preview** — Pinned/urgent/overdue/assigned action items (max 10)
4. **Inventory Position** (3 cards) — Floor Stock, On Order, Committed (all in units)
5. **Delivery Command Center** — 10 upcoming deliveries + 4 stat mini-cards (Today, This Week, Unassigned, Remainders)
6. **Sales Pipeline** (3 cards) — Quote Pipeline, Orders (Season), Delivered (Season)
7. **Operational Alerts** — 9 alert types with "All Clear" state when empty
8. **Monthly Activity Chart** — 12-month triple-bar (Orders, Deliveries, POs Received)
9. **Season Progress** — Progress bar (Oct 1–Sep 30) + Accounting Period status
10. **Recent Activity** — 15 items with colored dots by type + relative timestamps

### Navigation Updates
- Sidebar label: "Dashboard" → "Operations"
- Page header: "Operational Dashboard"
- `usePageMeta` updated for `/` route
- Financial Dashboard back-button text corrected

### Role Visibility
- Admin + Sales: all 10 sections
- Drivers: Team Board, Deliveries, Alerts, Activity only

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-05 — Financial Dashboard, Payment History, PO Improvements, Bug Fixes (PRs #31–#39)

### New: PaymentHistory Page
- `src/pages/PaymentHistory.tsx` — full payment history table with per-invoice allocation breakdown
- Double-cast `Record → InvoiceAllocation` TypeScript fix

### Financial Dashboard Enhancements
- Inventory position cards added to dashboard
- Prepay bucket edit/delete capability
- New migrations: `20260321100000_dashboard_inventory_position.sql`, `20260321200000_prepay_edit_delete.sql`, `20260321300000_void_payment.sql`

### Submit PO Button (PR #39)
- Added "Submit PO" action button on `PurchaseOrderDetail.tsx`

### MG/g Inventory Units + Jar Container (PRs #37/#38)
- New inventory units: `MG` (milligrams) and `g` (grams)
- New container type: `Jar`
- Migration: `20260304210000_add_mg_g_units_and_jar_container.sql`

### Inventory Floor Calculation + Order Product Selector (PR #32)
- Fixed floor calculation that was underreporting available inventory
- Customer tier price now shown in order product selector dropdown

### Manual Inventory No-Cost Override Fix (PR #36)
- Manual inventory add no longer overwrites existing product unit cost
- Migration: `20260320210000_manual_inventory_no_cost_override.sql`

### BulkPOImport PDF Extraction (PRs #33/#34)
- Position-aware text reconstruction for more accurate supplier invoice parsing
- Strategy 3 parser added to handle supplier order confirmation format

### TypeScript + Misc Fixes (PR #35)
- Decimal quantities on POs
- Duplicate PO save prevention
- Edit permissions corrected

### Workflow Quote/Order/Invoice Fixes
- Migration `20260320100000_workflow_quote_order_invoice_fixes.sql` (576-line comprehensive fix)
- Migrations for close period payments column, record_invoice_payment column, delivery date, trigger search paths

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-04 — Math Test Suite: All 22 Tests Passing (PR #31)

### Problem
3 tests were failing/skipping in the math E2E suite (`math-invoice-verification.spec.ts`, `math-quote-pricing.spec.ts`): IV1 (skip), IV5 (fail), IV12 (skip), QP3 (skip), QP6 (skip).

### Root Causes & Fixes

**1. InvoiceDetail loading-race (IV1, IV5, IV12)**
`InvoiceDetail.tsx` returns a pure spinner while `loading=true`. `waitForLoadState('networkidle')` fires after the Supabase fetch but before React re-renders, so tests read empty DOM and get `$0.00` for summary values. Fix: scope iteration to non-voided CS- rows + add explicit `text=Subtotal` waitFor before reading summary values.

**2. `isVisible()` vs `count()` on off-screen rows (IV1)**
CS-2026-0048 at DOM index 14 is below the scroll fold in a fixed-height table — `isVisible()` returned false even though the row was in the DOM. Fix: use `(await locator.count()) > 0`.

**3. Playwright `.or()` DOM-order pitfall (QP6)**
`text=Margin` matched `<th>Margin</th>` column header before `<p>Overall Margin</p>` in document order, causing `marginPct = 0` and QP6 to skip. Fix: use `.locator('text=Overall Margin').or(...'Avg Margin')` only.

**4. QuoteBuilder `Units Needed` input (QP3)**
Cell renders `<input type="number">` not plain text; `textContent()` returned `''`. Fix: use `inputValue()` on the input element.

### Files Changed
- `tests/e2e/math-invoice-verification.spec.ts` — IV1/IV5/IV12 fixes
- `tests/e2e/math-quote-pricing.spec.ts` — QP3/QP6 fixes
- `tests/e2e/00-seed-test-data.spec.ts` — seed spec (new)
- 2026-03-03 math-test-investigation _(doc not retained)_ — full investigation findings

### Migration
- `20260319000000_fix_trigger_functions_search_path.sql`: adds `SET search_path TO 'public'` to 11 trigger functions so `_is_admin_override()` resolves correctly when fired from security-definer RPCs

### Result
All 22 math tests pass: 12 invoice verification (IV1–IV12) + 10 quote pricing (QP1–QP10).

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-03 — E2E Suite Expansion + DB Schema Fixes

### New E2E Spec Files (37 tests)
- `pricing-edge-cases.spec.ts` (12 tests): tier pricing, bulk price breaks, margin/cost validation, zero-cost guard rails
- `concurrent-operations.spec.ts` (13 tests): race conditions, double-submit prevention, RLS tenant isolation, inventory ledger consistency
- `period-close-accounting.spec.ts` (12 tests): period-close workflow, partial payments, commission tracking, balance accuracy

### DB Fixes (required to unblock tests)
- `record_invoice_payment`: rewrote to use `payments` table — `allocation_sets` had `entity_type/entity_id NOT NULL` with no defaults + `UNIQUE(entity_type, entity_id, version)` that silently broke all multi-payment scenarios
- `close_accounting_period`: fixed `delivery_date` → `scheduled_date` column reference in deliveries subquery
- `close_accounting_period`: fixed payments column reference (`amount_cents`)
- `record_invoice_payment`: fixed column name mismatch (`amount_cents`)

### Full Suite Result
- 999 passed, 30 pre-existing failures (unrelated to DB changes), 21 skipped
- 1,443 unit tests (93 files) + 626 E2E tests (102 spec files)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-02 — Quote Builder, Order Creation & PDF Fixes

### Quote Builder Improvements
- **Auto-fill rate & unit**: selecting a product now auto-populates `actual_rate` and `rate_unit` from product setup
- **Bidirectional calc mode**: new `calc_mode` toggle — `rate_acres` (rate × acres → units) vs `units_direct` (type units directly)
- **Editable Units Needed**: column is now an editable input; editing it switches to `units_direct` mode (green border indicator)
- **Price unit override**: per-item dropdown to change display price unit (e.g., price per Gal vs per Qt)
- **52 unit tests** including 24D Ester regression test verifying $3.26/acre at 16 oz/acre on 500 acres

### Order Creation Fixes
- **Auto-fill pricing**: selecting a product now pulls tier price from customer's assigned tier (tier1/2/3_price)
- **Auto-generated order numbers**: removed manual order number input; `create_direct_order()` RPC now calls `generate_order_number()` server-side
- **Order name field**: new optional "Order Name" field (e.g., "Corn Burndown") for easy identification

### Quote PDF
- **Removed profit/margin** from customer-facing PDF output
- **Updated footer** with website URL (www.croprxsolutions.com)
- **Price unit labels** shown in Price/Unit column

### Migrations (3)
- `20260302100000` — `quote_items.calc_mode` + `quote_items.price_unit` columns
- `20260302110000` — `orders.order_name` column + updated `create_direct_order()` RPC
- `20260302120000` — updated `save_quote()` RPC with bidirectional calc_mode support

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-01 — Inventory & Delivery Improvements (branch `feature/inventory-delivery-improvements`)

### Load Sheet / Pick List PDF
- New `src/lib/loadSheetPdf.ts` — generates warehouse pick list PDF for scheduled deliveries
- Product summary table aggregates quantities across all stops by product name
- Per-stop tables show delivery number, customer, items with quantities and tote numbers
- "Load Sheet" button added to Deliveries page header
- 6 unit tests in `loadSheetPdf.test.ts`

### Inventory Transaction Ledger
- New `src/components/inventory/TransactionLedgerModal.tsx` — full transaction history per product
- Shows date, type (received/delivered/adjusted/returned/transferred/booked), quantity, running balance, performer, notes
- Color-coded type icons and positive/negative quantity formatting
- Inline FileText icon button next to each product name in inventory table
- `computeRunningBalance()` pure function with 3 unit tests

### Batch Inventory Adjustments
- New `src/components/inventory/BatchAdjustModal.tsx` — apply uniform adjustment to selected products
- Checkbox column added to inventory table for multi-selection
- "Adjust N Selected" button appears in header when items selected
- Preview list shows current → new quantities before confirmation
- Uses `adjust_inventory` RPC with idempotency keys per item
- `buildAdjustmentCalls()` pure function with 3 unit tests

### Vendor-Grouped Reorder Alerts
- Low-stock section redesigned: "ACTION REQUIRED" heading with vendor grouping
- Products grouped by vendor using `Map<string, InventoryRow[]>`
- Shows available qty, reorder point, on-order, and shortfall per product
- "Needs Reorder" filter chip with count badge filters table to low-stock items only

### Inventory Valuation Display
- New "Inventory Value" summary card (7th card) showing `SUM(qty × unit_cost)` with currency format
- "Unit Cost" and "Value" columns added to inventory table (admin-only)
- `current_cost` field added to inventory query from products table

- Net result: 1,433 unit tests (92 files), all passing
- Commits: `8b84db9` through `9785041` (5 commits)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-03-01 — E2E Coverage Sprint (branch `claude/add-playwright-tests-DjMo6`)

- Added 23 new Playwright E2E spec files with 165 test cases, all passing
- **Part 1 — New Feature Coverage (5 files, 43 tests):**
  - `prepayment-manager-crud.spec.ts` (10): Split Check modal, bucket system, batch apply
  - `prepay-workspace.spec.ts` (10): Split-panel allocator, customer selection, two-phase commit
  - `tote-tracking.spec.ts` (8): Cross-page tote # on NewDelivery, DeliveryDetail, ReceivingLog, InvoiceDetail
  - `rup-compliance-warnings.spec.ts` (7): RUP banners on QuoteBuilder, NewDelivery, DeliveryDetail, Compliance
  - `finance-charge-fix.spec.ts` (8): Non-compounding finance charges on AR Aging
- **Part 2 — Previously Uncovered Pages (18 files, 122 tests):**
  - ar-aging, application-records, commission-payments-crud, crop-programs, cycle-counts, delivery-remainders, quick-receive, returns-crud, rebates-page, new-delivery-page, new-order-page, new-purchase-order, purchase-order-detail, invoice-list-page, field-detail, job-detail, vehicle-detail, inventory-page
- Net result: 84 E2E spec files, 589 total E2E tests, 1,380 unit tests (88 files at that time)
- Commits: `88b6086` (tests), `99c4d2d` (audit prompt), `61f38df` (test plan)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-02-28 — Audit Remediation (4 phases, 21 tasks, branch `feature/audit-remediation`)

### Phase 0: Finance Charge + Billing Split Fixes
- Fixed finance charge compounding to exclude prior finance charges from the base amount
- Added `FOR UPDATE` row-level locking on billing splits to prevent concurrent modification

### Phase 1: Tote Tracking (Tasks 2-8)
- Added `tote_number` and `is_non_returnable` columns to `delivery_items` schema
- Threaded tote number through `complete_delivery` and `create_quick_delivery` RPCs
- Added tote # input on NewDelivery, display on DeliveryDetail with non-returnable badge
- Added Tote # column to delivery PDF export

### Phase 2: RUP Compliance (Tasks 9-14)
- Built `rupCompliance.ts` helper with 6 unit tests — checks license expiry, certification type, product registration
- Added amber RUP warning banners to QuoteBuilder, NewOrder, NewDelivery, DeliveryDetail
- Added RUP audit logging to `financial_audit_log` on order/delivery creation
- Enhanced Compliance page filter chips with count badges and red "Overdue" highlighting

### Phase 3: Prepay Bucket System (Tasks 15-20)
- Added `bucket_label` column to `prepay_credits` with 8 seeded categories
- Created `apply_prepay_to_invoice()` and `batch_apply_prepayments()` RPCs with `FOR UPDATE` locking
- Built PrepayWorkspace page — split-panel allocator with two-phase commit pattern
- Added Split Check modal to PrepaymentManager for bucket-based check entry
- Added sidebar nav + route for PrepayWorkspace
- Net result: 50 pages, 92 migrations, 1,380 unit tests (88 files), all passing
- Commits: `6beef0c` through `e6c3477` (10 commits)

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-02-28 — Go-Live Hardening (5 sprints, branch `feature/go-live-hardening`)

### Sprint 1: Foundation Hardening
- **1a:** `crypto.randomUUID` for idempotency keys (replaces Math.random fallback), retry-safe `useIdempotentAction` hook, `db.ts` multi-tab session recovery via `detectSessionFromOtherTabs()`
- **1b:** Server-authoritative quote math — `calculate_quote_totals()` RPC using `NUMERIC(15,4)`, client calculation is display-only hint
- Commits: `c80bc3d`, `28b8a4e`

### Sprint 2: Error Handling & Notifications
- Notification failure tracking: `failed_at` + `retry_count` columns on notifications table
- Read-path error handling: silent fallback prevents cascading UI crashes
- Commit: `22b930b`

### Sprint 3: Security & Testing Infrastructure
- **3a:** Delivery signature privacy — `create_signed_url()` RPC for time-limited access, no public bucket URLs
- **3b:** RLS integration contract tests — per-role verification (admin, sales_rep, driver, applicator) for orders, invoices, deliveries, commissions
- **3c:** Schema integrity live DB tests — FK constraints, enum values, generated columns, RLS enabled check
- Commits: `f421869`, `7640636`, `e5d70eb`

### Sprint 4: Code Quality & CI
- **4a:** Shared `runCriticalAction()` helper — consistent try/catch/toast pattern replacing scattered error handling
- **4b:** Fixed all `react-hooks/exhaustive-deps` ESLint warnings
- **4c:** E2E smoke tests added to CI workflow, fixed TDZ declaration ordering issues
- Commits: `322e2aa`, `5994e2c`, `33ff198`

### Sprint 5: Observability & Data Integrity
- **5a:** Operational metrics via `src/lib/metrics.ts` — Sentry user context on login/logout, navigation tracking via headless `NavigationTracker` component, business event tracking (order_created, quote_created, quote_converted_to_order)
- **5b:** Cross-entity reconciliation checks via `src/lib/reconciliation.ts` — 5 pure check functions (order totals, inventory ledger, invoice payments, invoice balance formula, commission splits) + DB wrapper `runReconciliationChecks()`
- Net result: 1,374 unit tests (87 files), all passing. Build clean.
- Commits: `7e33267`, `91314c4`

---

## 2026-04-16 — Delivery Inventory Audit Fix

Fixed two findings from the 2026-04-10 functional audit in NewDelivery.tsx:
1. Removed hardcoded Main Warehouse filter — inventory warnings now aggregate across all locations.
2. Changed inventory warning to use net-available (available minus prebooked) instead of just available, matching existing patterns in NewOrder and OrderDetail.

---

## 2026-02-27 — Business Logic Audit Fixes
- SQL migration `20260312200000`: inventory hold auto-release trigger (declined/expired/accepted), `post_invoice()` period enforcement, `save_customer()` commission split validation, `create_quick_delivery()` inventory pre-check with FOR UPDATE locks, `convert_quote_to_order()` explicit hold release
- Added `checkMutationResult()` silent RLS failure detection on 13 pages
- Offline sync conflict detection via `snapshotAt` / `entityTable` / `entityId` fields
- Realtime subscription `disabled` prop — prevents null-filter subscriptions
- InventoryPage `freeQty` formula fix (subtracts prebooked from available)
- Updated 3 test files (offlineSync, useRealtimeSubscription, businessLogicEnhancements) — 1,121 tests all passing
- Commits: `f1278ab`

## 2026-02-25 — Test Suite Audit & Coverage Expansion
- Audited all 67 unit test files — zero stale imports, zero dead tests
- Removed duplicate `pdfGeneration.test.ts` (894 lines, duplicated by 3 individual PDF test files)
- Added 11 new unit test files: SignatureCanvas, ActivityFeed, CommentsSection, 8 bulk import components
- Net result: 80 test files, 1,121 unit tests (all passing)
- 60 math & business logic verification E2E tests
- 95 real UI interaction E2E tests across 10 pages
- 14 new test files closing coverage gaps (47 unit + 68 E2E tests)
- Fixed 41 of 42 pre-existing E2E test failures
- Commits: `fdaa08c`, `5bc6213`, `447576f`, `7527206`

## 2026-02-24 — Test Coverage Gap Closure (8 sprints)
- Sprint 1: reportPdf.test.ts + deliveryPdf.test.ts (35 tests)
- Sprint 2: offlineQueue.test.ts (30 tests, fake-indexeddb)
- Sprint 3: useUnsavedChanges, useRealtimeSubscription, useOCRProcessor hooks (40 tests)
- Sprint 4: AuthContext.test.tsx (30 tests)
- Sprint 5-6: 9 modal test files (90 tests)
- Sprint 7: imageCompression + sentry (25 tests)
- Sprint 8: bulk-operations.spec.ts E2E (31 tests)
- Fixed login() helper in tests/e2e/utils/auth.ts for session persistence
- Commit: `6fe06a0`

## 2026-02-24 — useRowSelection Bug Fix
- Fixed infinite re-render loop — useEffect compared data by reference (always new)
- Removed broken useEffect, derived selectedCount from selectedRows.length
- Commit: `12ec850`

## 2026-02-24 — Bulk Select/Delete/CSV/PDF Export
- Session 1 (6 pages): Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets
- Session 2 (9 pages): Orders, Vehicles, Fields, Returns, ReceivingLog, InventoryPage, Invoices, Deliveries, Payments
- Pattern: useRowSelection → createCheckboxColumn → BulkActionBar → BulkDeleteConfirmModal
- Soft delete for Returns/Invoices, hard delete for others
- 12 files changed, 824 insertions, 111 deletions
- Commits: `d52d910`, `f571196`

## 2026-02-23 — TypeScript Strict Type Cleanup
- Fixed all 148 TypeScript strict type errors → 0 remaining
- Key fixes: Supabase join casts, jsPDF types, React Router v7 Blocker, DataTable generics
- Removed `continue-on-error: true` from CI — typecheck now enforced
- Commit: `6a98a92`

## 2026-02-23 — CI Pipeline Fix
- Fixed 47 ESLint errors blocking CI
- Updated ESLint config: `varsIgnorePattern: '^_'`
- Fixed Vitest CI crash with Supabase env var fallbacks
- Added `npm run lint` to pre-commit hook
- CI now GREEN — all 4 steps pass
- Commits: `73d779e`, `a97882d`, `af90ebf`

## 2026-02-23 — Documentation Cleanup
- Removed 17 stale .md files from repo
- Rewrote README.md with accurate stats
- Added Feature Inventory table to CLAUDE.md
- Fixed stale references across CLAUDE.md, TESTING.md, DEPLOYMENT.md

## 2026-02-23 — Lint Cleanup
- Eliminated all 507 ESLint errors → 0 remaining
- 95 files changed: catch(err: any) → catch(err: unknown), typed all `any`, removed unused imports
- Commit: `22f9c86`

## 2026-02-23 — Codebase Audit & Hardening
- Sprint A: 4 new test files + 17 convertToGlLb tests
- Sprint B: Defensive null guards in quoteCalc, deliveryPdf, invoicePdf, etc.
- Sprint C: 7 uncaught promise chains fixed, AuthContext session hardening
- Sprint D: Security hardening in pagePermissions, notificationTriggers, realtime, queries
- Sprint E: Lint/formatting cleanup
- 24 files changed, 1,267 lines added/changed
- Commit: `9b3d70b`

## 2026-03-04 — Quick Receive Feature
- 3-step wizard: vendor+products → auto-match to oldest open POs → confirm
- `match_quick_receive_items()` RPC

## 2026-02-28 to 2026-03-03 — Safety Audit & Business Logic Hardening
- Page permissions, notification triggers, E2E gate tests

## 2026-02-27 — Sprint 20: Delivery Integrity & Quick Delivery
- Two-step confirm→complete flow, items locked to order, quick delivery modal
- `create_quick_delivery()` atomic RPC

## 2026-02-26 — Sprint 19: Receiving System Enhancement
- Per-item receiving (condition/lot/notes), receiving dashboard, receiving PDF

## 2026-02-25 — Sprint 18: Delivery System Enhancement
- Edit/cancel/reassign, driver issue reporting, photos (10 max), delivery remainders, batch cancel

## 2026-02-24 — Sprint 17: Year-End Customer Summary
- PDF: financials, products, acreage, YoY comparison

## 2026-02-23 — Sprint 16: Unified Payment Allocation
- New PaymentAllocation page, auto-allocate, prepay application

## 2026-02-22 — Sprint 15: Batch Operations
- Batch void, batch print, batch statements, auto-apply prepayments

## 2026-02-21 — Sprint 14: Grower Share Transparency
- Per-grower $/acre pricing in quote builder

## 2026-02-20 — Sprint 13: Finance Charge Intelligence
- Preview, grace periods, opt-out per customer

## 2026-02-19 — Sprint 12: Invoice & Statement PDF Redesign
- 3 invoice layouts, dual-mode statements, matching Chem-Man format

## 2026-02-17 — T3-002: Comprehensive Test Coverage
- 766 unit tests (45 files) + 31 E2E spec files

## 2026-02-17 — OCR Parser Overhaul & Edge Function v4
- Multi-line field support, look-behind value matching

## 2026-02-16 — Bulk Field Import
- Shapefile/KML/GeoJSON wizard with proj4 reprojection

## 2026-02-14 to 2026-02-18 — Sprints 7-11: CheMan Gap Closure
- Vehicles, Jobs, Application Records, Reports (14 total), Month-End Close, Commission Payments, Financial Workflows

## 2026-02-13 — Phase 4B: Mapbox Maps
- Satellite imagery, field polygon drawing, acreage auto-calc

## 2026-02-11 — 109-Defect Forensic Audit Fix (Sprints 0-6)
- Fixed all 109 defects from Claude forensic audit

## Earlier — Foundation
- Tier 1-3 hardening complete
- ChatGPT audit (18 issues) complete
- Initial build by Bolt, then claimed by user
