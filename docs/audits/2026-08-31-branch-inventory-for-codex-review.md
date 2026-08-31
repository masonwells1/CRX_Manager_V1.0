# Branch inventory for Codex review — 2026-08-31

Read-only inventory of every remote branch on `masonwells1/CRX_Manager_V1.0`.
**Nothing was deleted.** Mason asked for this list so Codex can review it before any branch
is removed or any surviving work is condensed.

## How to read this

The decisive column is **Still adds**: the number of files the branch would still change if it
were merged into `main` today (`git diff --name-only origin/main...<branch>`). A branch with
`0` contains nothing `main` does not already have, so deleting it loses nothing.

Ahead/behind commit counts are deliberately **not** used here. This repository squash-merges
its pull requests, so a fully-merged branch still reports dozens of "unmerged" commits.
Comparing file content is the only reading that survives that.

## Totals

| | Count |
|---|---|
| Remote branches besides `main` | 63 |
| Fully contained in `main` (add nothing) | 3 |
| Carrying migration files not in `main` | 16 |
| Attached to an open PR | 16 |
| Left behind by an already-merged PR | 5 |
| No pull request in the scanned window | 22 |

## The part that actually matters: unmerged migrations

**16 branches carry `supabase/migrations/*.sql` files that never reached `main`.**
A migration outside the shipped history is either already applied to the live database (in which
case the file is the only record of what was applied) or was abandoned. Codex should decide which,
per branch, before any of these is deleted.

| Branch | Last commit | Migrations | Still adds | PR status |
|---|---|---|---|---|
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | **12** | 35 files | PR #395 closed unmerged |
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | **10** | 99 files | PR #397 closed unmerged |
| `claude/wave-a-migrations-857dcd` | 2026-08-12 | **4** | 8 files | no PR in the scanned window |
| `chore/migration-ledger-reconcile-20260729` | 2026-07-29 | **3** | 9 files | PR #275 closed unmerged |
| `codex/section4-lifecycle-20260805` | 2026-08-05 | **3** | 14 files | PR #321 closed unmerged |
| `codex/harden-actor-binding-sql-reader` | 2026-08-12 | **3** | 7 files | PR #373 closed unmerged |
| `claude/draw-down-price-tier-lines` | 2026-08-19 | **3** | 28 files | PR #404 merged |
| `claude/pricing-audit-strategy-jym8rr` | 2026-08-10 | **2** | 31 files | PR #350 closed unmerged |
| `codex/section9-ap-safety-remediation` | 2026-08-26 | **2** | 27 files | PR #491 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | 2026-08-27 | **2** | 45 files | **open PR #500** |
| `codex/pr509-source-recognition-fix-v2-20260830` | 2026-08-31 | **2** | 7 files | **open PR #517** |
| `codex/section1-security-hardening-20260725` | 2026-07-25 | **1** | 16 files | no PR in the scanned window |
| `claude/return-credit-cogs-reversal` | 2026-08-09 | **1** | 4 files | **open PR #361** |
| `claude/restrict-draw-down-owner` | 2026-08-14 | **1** | 14 files | no PR in the scanned window |
| `claude/pr401-proof` | 2026-08-25 | **1** | 16 files | no PR in the scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | 2026-08-26 | **1** | 21 files | no PR in the scanned window |

<details><summary>The migration filenames on each branch</summary>

**`claude/recover-applied-migrations-20260812`**

- `supabase/migrations/20260812010000_blend_ticket_order_header_runtime_assert.sql`
- `supabase/migrations/20260812011000_restore_quote_version_whole_cent_money.sql`
- `supabase/migrations/20260812115235_snapshot_cost_reporting.sql`
- `supabase/migrations/20260812115236_quote_items_cost_at_quote_snapshot.sql`
- `supabase/migrations/20260812115237_enforce_below_cost_admin_approval.sql`
- `supabase/migrations/20260812115238_repair_historical_order_line_cents.sql`
- `supabase/migrations/20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `supabase/migrations/20260813020000_round_order_header_money.sql`
- `supabase/migrations/20260813030000_reject_non_finite_money_and_quantities.sql`
- `supabase/migrations/20260813040000_clamp_negative_commission_remainder.sql`
- `supabase/migrations/20260813080000_lock_quote_versions_writes_to_rpc.sql`
- `supabase/migrations/20260813180000_quote_version_restore_trust_boundary.sql`

**`codex/pr389-coderabbit-fixes`**

- `supabase/migrations/20260812010000_blend_ticket_order_header_runtime_assert.sql`
- `supabase/migrations/20260812011000_restore_quote_version_whole_cent_money.sql`
- `supabase/migrations/20260812145628_snapshot_cost_reporting.sql`
- `supabase/migrations/20260812151606_quote_items_cost_at_quote_snapshot.sql`
- `supabase/migrations/20260812154028_enforce_below_cost_admin_approval.sql`
- `supabase/migrations/20260813080000_lock_quote_versions_writes_to_rpc.sql`
- `supabase/migrations/20260813090000_restrict_restore_quote_owner_impl.sql`
- `supabase/migrations/20260813161614_restrict_draw_down_quote_owner.sql`
- `supabase/migrations/20260814041419_fresh_below_cost_reason.sql`
- `supabase/migrations/20260814063000_quote_sections_rpc_owned.sql`

**`claude/wave-a-migrations-857dcd`**

- `supabase/migrations/20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `supabase/migrations/20260813020000_round_order_header_money.sql`
- `supabase/migrations/20260813030000_reject_non_finite_money_and_quantities.sql`
- `supabase/migrations/20260813040000_clamp_negative_commission_remainder.sql`

**`chore/migration-ledger-reconcile-20260729`**

- `supabase/migrations/20260729125227_secure_profile_public_directory.sql`
- `supabase/migrations/20260729125251_pin_contact_sync_search_path.sql`
- `supabase/migrations/20260729125314_application_service_cost_exact_text.sql`

**`codex/section4-lifecycle-20260805`**

- `supabase/migrations/20260805211951_harden_bulk_order_import_lifecycle.sql`
- `supabase/migrations/20260805220757_reject_nonfinite_bulk_import_values.sql`
- `supabase/migrations/20260805224819_snapshot_bulk_import_product_cost.sql`

**`codex/harden-actor-binding-sql-reader`**

- `supabase/migrations/20260813030000_reject_non_finite_money_and_quantities.sql`
- `supabase/migrations/20260813050000_guard_job_commission_split_immutable.sql`
- `supabase/migrations/20260813060000_require_completed_delivery_before_invoice_post.sql`

**`claude/draw-down-price-tier-lines`**

- `supabase/migrations/20260816110000_draw_down_cutover_barrier.sql`
- `supabase/migrations/20260816120000_draw_down_split_order_lines_by_price_tier.sql`
- `supabase/migrations/20260817120000_carry_allocated_line_cents_through_lifecycle.sql`

**`claude/pricing-audit-strategy-jym8rr`**

- `supabase/migrations/20260808170100_snapshot_cost_reporting.sql`
- `supabase/migrations/20260808170200_quote_items_cost_at_quote_snapshot.sql`

**`codex/section9-ap-safety-remediation`**

- `supabase/migrations/20260826125456_bind_section9_ap_receiving_intent_and_month_dashboard.sql`
- `supabase/migrations/20260826140333_correct_ap_aging_due_date_buckets.sql`

**`codex/section9-ap-safety-remediation-v2`**

- `supabase/migrations/20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard.sql`
- `supabase/migrations/20260826222000_correct_ap_aging_due_date_buckets.sql`

**`codex/pr509-source-recognition-fix-v2-20260830`**

- `supabase/migrations/20260827041100_rebuild_return_credit_cogs_reversal.sql`
- `supabase/migrations/20260827041400_align_return_credit_order_invoice_gates.sql`

**`codex/section1-security-hardening-20260725`**

- `supabase/migrations/20260725234503_harden_section1_number_and_field_actor.sql`

**`claude/return-credit-cogs-reversal`**

- `supabase/migrations/20260808170000_return_credit_cogs_reversal.sql`

**`claude/restrict-draw-down-owner`**

- `supabase/migrations/20260813161614_restrict_draw_down_quote_owner.sql`

**`claude/pr401-proof`**

- `supabase/migrations/20260825190000_quote_version_restore_trust_boundary.sql`

**`claude/pr401-quote-version-trust-8e3db6`**

- `supabase/migrations/20260825190000_quote_version_restore_trust_boundary.sql`

</details>

## Safe to delete on content alone

These add nothing to `main`. Still Codex's call, but there is no content to lose.

| Branch | Last commit | PR status |
|---|---|---|
| `pr435-work` | 2026-08-20 | no PR in the scanned window |
| `claude/jobdetail-savegate-flake` | 2026-08-26 | PR #485 merged |
| `claude/document-cleanup-review-r2nbhj` | 2026-08-31 | no PR in the scanned window |

## Every branch

| Branch | Last commit | Kind | Still adds | Migrations | PR status |
|---|---|---|---|---|---|
| `codex/section1-security-hardening-20260725` | 2026-07-25 | MIGRATIONS | 16 | 1 | no PR in the scanned window |
| `chore/migration-ledger-reconcile-20260729` | 2026-07-29 | MIGRATIONS | 9 | 3 | PR #275 closed unmerged |
| `codex/idempotency-reset-order-hardening-20260802` | 2026-08-02 | CODE | 26 |  | no PR in the scanned window |
| `codex/section4-lifecycle-20260805` | 2026-08-05 | MIGRATIONS | 14 | 3 | PR #321 closed unmerged |
| `claude/log-session-attribution-fix` | 2026-08-06 | DOCS-ONLY | 1 |  | PR #317 merged |
| `claude/push-guard-fix-rescue-e3320d` | 2026-08-07 | CODE | 4 |  | no PR in the scanned window |
| `claude/rescue-unique-docs-20260807` | 2026-08-07 | DOCS-ONLY | 10 |  | no PR in the scanned window |
| `claude/ordering-cycle-review-t41vat-local-20260831` | 2026-08-09 | CODE | 11 |  | no PR in the scanned window |
| `claude/return-credit-cogs-reversal` | 2026-08-09 | MIGRATIONS | 4 | 1 | **open PR #361** |
| `claude/ordering-cycle-review-t41vat` | 2026-08-10 | DOCS-ONLY | 2 |  | PR #356 merged; PR #363 closed unmerged |
| `claude/pricing-audit-strategy-jym8rr` | 2026-08-10 | MIGRATIONS | 31 | 2 | PR #350 closed unmerged |
| `claude/wave-a-migrations-857dcd` | 2026-08-12 | MIGRATIONS | 8 | 4 | no PR in the scanned window |
| `codex/harden-actor-binding-sql-reader` | 2026-08-12 | MIGRATIONS | 7 | 3 | PR #373 closed unmerged |
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | MIGRATIONS | 35 | 12 | PR #395 closed unmerged |
| `claude/restrict-draw-down-owner` | 2026-08-14 | MIGRATIONS | 14 | 1 | no PR in the scanned window |
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | MIGRATIONS | 99 | 10 | PR #397 closed unmerged |
| `codex/sol-gate-recovery-exception` | 2026-08-14 | CODE | 13 |  | PR #403 closed unmerged |
| `claude/blend-unit-rebuild-step1` | 2026-08-19 | CODE | 7 |  | no PR in the scanned window |
| `claude/draw-down-price-tier-lines` | 2026-08-19 | MIGRATIONS | 28 | 3 | PR #404 merged |
| `claude/zealous-agnesi-aa7423` | 2026-08-20 | CODE | 12 |  | no PR in the scanned window |
| `claude/zen-easley-7d771d` | 2026-08-20 | CODE | 5 |  | no PR in the scanned window |
| `codex/fleet-scan-parked-state` | 2026-08-20 | CODE | 5 |  | no PR in the scanned window |
| `pr435-work` | 2026-08-20 | CONTAINED | 0 |  | no PR in the scanned window |
| `claude/coderabbit-setup-optimize-0f308d` | 2026-08-24 | CODE | 13 |  | PR #441 closed unmerged |
| `claude/codex-guard-single-ampersand` | 2026-08-24 | CODE | 4 |  | PR #464 closed unmerged |
| `claude/codex-recursion-hard-guard` | 2026-08-24 | CODE | 15 |  | PR #452 closed unmerged |
| `claude/push-guard-git-resolution` | 2026-08-24 | CODE | 8 |  | PR #445 closed unmerged |
| `codex/proof-wrapper-trusted-git-bootstrap` | 2026-08-24 | CODE | 3 |  | PR #454 closed unmerged |
| `fix/quote-fixture-stale-date` | 2026-08-24 | CODE | 1 |  | PR #468 closed unmerged |
| `claude/codex-claude-cogs-handoff-7bde15` | 2026-08-25 | CODE | 4 |  | no PR in the scanned window |
| `claude/control-file-coverage-a41c` | 2026-08-25 | CODE | 2 |  | no PR in the scanned window |
| `claude/guard-content-scan-and-savegate-flake` | 2026-08-25 | CODE | 7 |  | no PR in the scanned window |
| `claude/pr401-proof` | 2026-08-25 | MIGRATIONS | 16 | 1 | no PR in the scanned window |
| `claude/session-orchestration-setup-d73e6c` | 2026-08-25 | CODE | 42 |  | **open PR #364** |
| `codex/bootstrap-raw-patch-guard-20260825` | 2026-08-25 | CODE | 2 |  | no PR in the scanned window |
| `codex/pr402-review-gaps-20260819` | 2026-08-25 | CODE | 25 |  | PR #432 closed unmerged |
| `claude/changelog-docs-honesty` | 2026-08-26 | DOCS-ONLY | 3 |  | PR #505 closed unmerged |
| `claude/comment-fix-applied-closeout` | 2026-08-26 | DOCS-ONLY | 4 |  | PR #501 closed unmerged |
| `claude/hold-latch-cross-session-envelope` | 2026-08-26 | CODE | 7 |  | no PR in the scanned window |
| `claude/jobdetail-savegate-flake` | 2026-08-26 | CONTAINED | 0 |  | PR #485 merged |
| `claude/offline-review-stale-snapshot` | 2026-08-26 | CODE | 3 |  | no PR in the scanned window |
| `claude/pr364-guard-commits-local-20260831` | 2026-08-26 | CODE | 45 |  | no PR in the scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | 2026-08-26 | MIGRATIONS | 21 | 1 | no PR in the scanned window |
| `claude/remove-guard-hooks-f23691` | 2026-08-26 | CODE | 4 |  | PR #503 closed unmerged |
| `claude/xenodochial-dubinsky-b55362` | 2026-08-26 | CODE | 13 |  | PR #493 merged |
| `codex/actor-binding-mixed-notation-repair-20260810` | 2026-08-26 | CODE | 14 |  | **open PR #449** |
| `codex/section9-ap-safety-remediation` | 2026-08-26 | MIGRATIONS | 27 | 2 | PR #491 closed unmerged |
| `claude/product-plan-rev12-followup` | 2026-08-27 | DOCS-ONLY | 3 |  | PR #507 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | 2026-08-27 | MIGRATIONS | 45 | 2 | **open PR #500** |
| `codex/autonomy-with-hard-boundaries-20260827` | 2026-08-28 | CODE | 31 |  | PR #513 closed unmerged |
| `codex/coderabbit-ready-label-20260830` | 2026-08-30 | CODE | 16 |  | **open PR #516** |
| `claude/bash-safety-opacity-cleanup` | 2026-08-31 | CODE | 3 |  | **open PR #527** |
| `claude/crx-manager-cleanup-5da404` | 2026-08-31 | DOCS-ONLY | 3 |  | **open PR #526** |
| `claude/document-cleanup-review-r2nbhj` | 2026-08-31 | CONTAINED | 0 |  | no PR in the scanned window |
| `claude/harness-guardrail-review-bee189` | 2026-08-31 | CODE | 16 |  | **open PR #525** |
| `claude/optimize-claude-md-79f8ad` | 2026-08-31 | DOCS-ONLY | 3 |  | **open PR #528** |
| `claude/pending-set-apply-guard` | 2026-08-31 | CODE | 11 |  | **open PR #502** |
| `codex/pr509-source-recognition-fix-v2-20260830` | 2026-08-31 | MIGRATIONS | 7 | 2 | **open PR #517** |
| `dependabot/github_actions/actions/checkout-7.0.1` | 2026-08-31 | CODE | 4 |  | **open PR #518** |
| `dependabot/github_actions/actions/setup-node-7.0.0` | 2026-08-31 | CODE | 3 |  | **open PR #519** |
| `dependabot/npm_and_yarn/eslint-10.4.1` | 2026-08-31 | CODE | 2 |  | **open PR #522** |
| `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` | 2026-08-31 | CODE | 2 |  | **open PR #520** |
| `dependabot/npm_and_yarn/react-major-cbee5c902d` | 2026-08-31 | CODE | 2 |  | **open PR #521** |

## Suggested review order for Codex

1. **The 16 migration-carrying branches.** For each, establish whether its SQL is already
   live. If it is, the branch can go once the migration is recorded in
   `docs/reference/migration-history.md`; if it is not, decide keep-and-finish or abandon.
2. **The 3 contained branches.** Confirm the empty diff, then delete.
3. **Branches with no PR in the scanned window (22).** These never entered review. Most are
   local rescue or scratch branches pushed for safekeeping. Check for anything unique before deleting.
4. **Closed-unmerged PR branches.** The PR was closed without merging, so the work was rejected or
   superseded. Confirm the superseding change landed, then delete.
5. **Leave every open-PR branch alone.**

## Method

- Branch list and PR states: GitHub API, 2026-08-31. The PR scan covered #210 (2026-07-22)
  through #528, which spans every branch listed here — the oldest branch dates to 2026-07-25.
- Content comparison: local clone fetched with full history (`git fetch --unshallow`) — the
  original checkout was shallow, which made ancestry unreliable.
- Merged-ness is taken from a PR's `merged_at` timestamp, not the `merged` boolean.
- No branch was created, deleted, force-pushed, or modified in producing this report.
