# Branch inventory for Codex review — 2026-08-31

Read-only inventory of every remote branch on `masonwells1/CRX_Manager_V1.0`.
**Nothing was deleted.** This list exists so Codex can review it before any branch is removed.

> **Corrected 2026-08-31 after Codex review of PR #529.** The first version of this file measured
> branch content with `git diff origin/main...<branch>`. Three-dot diff compares the *merge base*
> with the branch, not main's current tree, so every file a squash-merge had already landed was
> re-reported as branch-only work. Codex's falsifier: the file claimed three unmerged migrations on
> `claude/draw-down-price-tier-lines`, and all three are in `main`. That branch now correctly shows
> **0**. Every number below was recomputed by comparing whole trees, and the migration-carrying set
> changed in both counts and membership.

## How this is measured

For each branch, `git ls-tree -r` produces the full path-to-blob map of the branch and of
`origin/main`. Two figures come out of comparing those maps directly:

- **New files** — paths the branch has that `main` does not have at all. This is the number that
  matters for deletion: it is content that disappears with the branch.
- **Modified files** — paths both contain with different bytes. Nearly every branch here is far
  behind `main`, so this is usually *staleness* (the branch holds an older copy), not new work.
  It is reported for context and should not be read as unmerged content.

Commit ahead/behind counts are not used at all. This repository squash-merges, so a fully merged
branch still reports dozens of "unmerged" commits. Only tree comparison survives that.

## Totals

| | Count |
|---|---|
| Remote branches besides `main` | 63 |
| Holding **no** file absent from `main` | 15 |
| Carrying migrations absent from `main` | 16 |
| Attached to an open PR | 16 |
| No pull request in the scanned window | 22 |

## Unmerged migrations — the part that matters

**16 branches hold `supabase/migrations/*.sql` files that do not exist in `main`.**
Each is either already applied to the live database — in which case the branch holds the only
record of what was applied — or was abandoned. Decide which, per branch, before deleting.

| Branch | Last commit | New migrations | New files | PR status |
|---|---|---|---|---|
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | **7** | 8 | PR #395 closed unmerged |
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | **7** | 37 | PR #397 closed unmerged |
| `claude/pricing-audit-strategy-jym8rr` | 2026-08-10 | **6** | 12 | PR #350 closed unmerged |
| `claude/wave-a-migrations-857dcd` | 2026-08-12 | **6** | 6 | no PR in the scanned window |
| `codex/harden-actor-binding-sql-reader` | 2026-08-12 | **6** | 7 | PR #373 closed unmerged |
| `claude/return-credit-cogs-reversal` | 2026-08-09 | **5** | 5 | **open PR #361** |
| `claude/ordering-cycle-review-t41vat-local-20260831` | 2026-08-09 | **4** | 4 | no PR in the scanned window |
| `claude/ordering-cycle-review-t41vat` | 2026-08-10 | **4** | 4 | PR #356 merged; PR #363 closed unmerged |
| `codex/section1-security-hardening-20260725` | 2026-07-25 | **2** | 25 | no PR in the scanned window |
| `codex/section9-ap-safety-remediation` | 2026-08-26 | **2** | 20 | PR #491 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | 2026-08-27 | **2** | 28 | **open PR #500** |
| `claude/restrict-draw-down-owner` | 2026-08-14 | **1** | 4 | no PR in the scanned window |
| `claude/pr401-proof` | 2026-08-25 | **1** | 15 | no PR in the scanned window |
| `claude/changelog-docs-honesty` | 2026-08-26 | **1** | 16 | PR #505 closed unmerged |
| `claude/hold-latch-cross-session-envelope` | 2026-08-26 | **1** | 15 | no PR in the scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | 2026-08-26 | **1** | 15 | no PR in the scanned window |

<details><summary>Migration filenames per branch</summary>

**`claude/recover-applied-migrations-20260812`**

- `20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `20260813020000_round_order_header_money.sql`
- `20260813030000_reject_non_finite_money_and_quantities.sql`
- `20260813040000_clamp_negative_commission_remainder.sql`
- `20260813050000_guard_job_commission_split_immutable.sql`
- `20260813060000_require_completed_delivery_before_invoice_post.sql`
- `20260813180000_quote_version_restore_trust_boundary.sql`

**`codex/pr389-coderabbit-fixes`**

- `20260812145628_snapshot_cost_reporting.sql`
- `20260812151606_quote_items_cost_at_quote_snapshot.sql`
- `20260812154028_enforce_below_cost_admin_approval.sql`
- `20260813090000_restrict_restore_quote_owner_impl.sql`
- `20260813161614_restrict_draw_down_quote_owner.sql`
- `20260814041419_fresh_below_cost_reason.sql`
- `20260814063000_quote_sections_rpc_owned.sql`

**`claude/pricing-audit-strategy-jym8rr`**

- `20260808150100_restore_batch_apply_prepayments_actor_guard.sql`
- `20260808150200_cancel_order_zeroes_quantity_remaining.sql`
- `20260808150300_revoke_inventory_truncate_and_mark_payments_dead.sql`
- `20260808150400_round_money_to_whole_cents.sql`
- `20260808170100_snapshot_cost_reporting.sql`
- `20260808170200_quote_items_cost_at_quote_snapshot.sql`

**`claude/wave-a-migrations-857dcd`**

- `20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `20260813020000_round_order_header_money.sql`
- `20260813030000_reject_non_finite_money_and_quantities.sql`
- `20260813040000_clamp_negative_commission_remainder.sql`
- `20260813050000_guard_job_commission_split_immutable.sql`
- `20260813060000_require_completed_delivery_before_invoice_post.sql`

**`codex/harden-actor-binding-sql-reader`**

- `20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `20260813020000_round_order_header_money.sql`
- `20260813030000_reject_non_finite_money_and_quantities.sql`
- `20260813040000_clamp_negative_commission_remainder.sql`
- `20260813050000_guard_job_commission_split_immutable.sql`
- `20260813060000_require_completed_delivery_before_invoice_post.sql`

**`claude/return-credit-cogs-reversal`**

- `20260808150100_restore_batch_apply_prepayments_actor_guard.sql`
- `20260808150200_cancel_order_zeroes_quantity_remaining.sql`
- `20260808150300_revoke_inventory_truncate_and_mark_payments_dead.sql`
- `20260808150400_round_money_to_whole_cents.sql`
- `20260808170000_return_credit_cogs_reversal.sql`

**`claude/ordering-cycle-review-t41vat-local-20260831`**

- `20260808150100_restore_batch_apply_prepayments_actor_guard.sql`
- `20260808150200_cancel_order_zeroes_quantity_remaining.sql`
- `20260808150300_revoke_inventory_truncate_and_mark_payments_dead.sql`
- `20260808150400_round_money_to_whole_cents.sql`

**`claude/ordering-cycle-review-t41vat`**

- `20260808150100_restore_batch_apply_prepayments_actor_guard.sql`
- `20260808150200_cancel_order_zeroes_quantity_remaining.sql`
- `20260808150300_revoke_inventory_truncate_and_mark_payments_dead.sql`
- `20260808150400_round_money_to_whole_cents.sql`

**`codex/section1-security-hardening-20260725`**

- `20260722222742_section9_po_ap_high_remediation.sql`
- `20260725234503_harden_section1_number_and_field_actor.sql`

**`codex/section9-ap-safety-remediation`**

- `20260826125456_bind_section9_ap_receiving_intent_and_month_dashboard.sql`
- `20260826140333_correct_ap_aging_due_date_buckets.sql`

**`codex/section9-ap-safety-remediation-v2`**

- `20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard.sql`
- `20260826222000_correct_ap_aging_due_date_buckets.sql`

**`claude/restrict-draw-down-owner`**

- `20260813161614_restrict_draw_down_quote_owner.sql`

**`claude/pr401-proof`**

- `20260825190000_quote_version_restore_trust_boundary.sql`

**`claude/changelog-docs-honesty`**

- `20260825190000_quote_version_restore_trust_boundary.sql`

**`claude/hold-latch-cross-session-envelope`**

- `20260825190000_quote_version_restore_trust_boundary.sql`

**`claude/pr401-quote-version-trust-8e3db6`**

- `20260825190000_quote_version_restore_trust_boundary.sql`

</details>

## Safe to delete on content alone

These 15 branches hold no file that `main` lacks. Deleting them loses no content.

| Branch | Last commit | Modified-but-stale files | PR status |
|---|---|---|---|
| `claude/blend-unit-rebuild-step1` | 2026-08-19 | 166 | no PR in the scanned window |
| `claude/draw-down-price-tier-lines` | 2026-08-19 | 162 | PR #404 merged |
| `claude/zen-easley-7d771d` | 2026-08-20 | 166 | no PR in the scanned window |
| `codex/fleet-scan-parked-state` | 2026-08-20 | 165 | no PR in the scanned window |
| `pr435-work` | 2026-08-20 | 160 | no PR in the scanned window |
| `claude/codex-guard-single-ampersand` | 2026-08-24 | 124 | PR #464 closed unmerged |
| `claude/push-guard-git-resolution` | 2026-08-24 | 128 | PR #445 closed unmerged |
| `codex/proof-wrapper-trusted-git-bootstrap` | 2026-08-24 | 131 | PR #454 closed unmerged |
| `fix/quote-fixture-stale-date` | 2026-08-24 | 123 | PR #468 closed unmerged |
| `codex/bootstrap-raw-patch-guard-20260825` | 2026-08-25 | 120 | no PR in the scanned window |
| `dependabot/github_actions/actions/checkout-7.0.1` | 2026-08-31 | 6 | **open PR #518** |
| `dependabot/github_actions/actions/setup-node-7.0.0` | 2026-08-31 | 5 | **open PR #519** |
| `dependabot/npm_and_yarn/eslint-10.4.1` | 2026-08-31 | 4 | **open PR #522** |
| `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` | 2026-08-31 | 4 | **open PR #520** |
| `dependabot/npm_and_yarn/react-major-cbee5c902d` | 2026-08-31 | 4 | **open PR #521** |

## Every branch

| Branch | Last commit | New files | New migrations | Modified | Behind main | PR status |
|---|---|---|---|---|---|---|
| `codex/section1-security-hardening-20260725` | 2026-07-25 | 25 | 2 | 361 | 599 | no PR in the scanned window |
| `chore/migration-ledger-reconcile-20260729` | 2026-07-29 | 1 |  | 323 | 554 | PR #275 closed unmerged |
| `codex/idempotency-reset-order-hardening-20260802` | 2026-08-02 | 14 |  | 311 | 485 | no PR in the scanned window |
| `codex/section4-lifecycle-20260805` | 2026-08-05 | 13 |  | 299 | 438 | PR #321 closed unmerged |
| `claude/log-session-attribution-fix` | 2026-08-06 | 17 |  | 295 | 434 | PR #317 merged |
| `claude/push-guard-fix-rescue-e3320d` | 2026-08-07 | 17 |  | 295 | 431 | no PR in the scanned window |
| `claude/rescue-unique-docs-20260807` | 2026-08-07 | 26 |  | 295 | 431 | no PR in the scanned window |
| `claude/ordering-cycle-review-t41vat-local-20260831` | 2026-08-09 | 4 | 4 | 285 | 351 | no PR in the scanned window |
| `claude/return-credit-cogs-reversal` | 2026-08-09 | 5 | 5 | 286 | 353 | **open PR #361** |
| `claude/ordering-cycle-review-t41vat` | 2026-08-10 | 4 | 4 | 285 | 349 | PR #356 merged; PR #363 closed unmerged |
| `claude/pricing-audit-strategy-jym8rr` | 2026-08-10 | 12 | 6 | 291 | 353 | PR #350 closed unmerged |
| `claude/wave-a-migrations-857dcd` | 2026-08-12 | 6 | 6 | 239 | 288 | no PR in the scanned window |
| `codex/harden-actor-binding-sql-reader` | 2026-08-12 | 7 | 6 | 241 | 288 | PR #373 closed unmerged |
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | 8 | 7 | 238 | 285 | PR #395 closed unmerged |
| `claude/restrict-draw-down-owner` | 2026-08-14 | 4 | 1 | 221 | 282 | no PR in the scanned window |
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | 37 | 7 | 245 | 278 | PR #397 closed unmerged |
| `codex/sol-gate-recovery-exception` | 2026-08-14 | 1 |  | 220 | 278 | PR #403 closed unmerged |
| `claude/blend-unit-rebuild-step1` | 2026-08-19 | 0 |  | 166 | 203 | no PR in the scanned window |
| `claude/draw-down-price-tier-lines` | 2026-08-19 | 0 |  | 162 | 212 | PR #404 merged |
| `claude/zealous-agnesi-aa7423` | 2026-08-20 | 2 |  | 170 | 210 | no PR in the scanned window |
| `claude/zen-easley-7d771d` | 2026-08-20 | 0 |  | 166 | 205 | no PR in the scanned window |
| `codex/fleet-scan-parked-state` | 2026-08-20 | 0 |  | 165 | 176 | no PR in the scanned window |
| `pr435-work` | 2026-08-20 | 0 |  | 160 | 160 | no PR in the scanned window |
| `claude/coderabbit-setup-optimize-0f308d` | 2026-08-24 | 3 |  | 131 | 102 | PR #441 closed unmerged |
| `claude/codex-guard-single-ampersand` | 2026-08-24 | 0 |  | 124 | 87 | PR #464 closed unmerged |
| `claude/codex-recursion-hard-guard` | 2026-08-24 | 10 |  | 131 | 102 | PR #452 closed unmerged |
| `claude/push-guard-git-resolution` | 2026-08-24 | 0 |  | 128 | 98 | PR #445 closed unmerged |
| `codex/proof-wrapper-trusted-git-bootstrap` | 2026-08-24 | 0 |  | 131 | 102 | PR #454 closed unmerged |
| `fix/quote-fixture-stale-date` | 2026-08-24 | 0 |  | 123 | 85 | PR #468 closed unmerged |
| `claude/codex-claude-cogs-handoff-7bde15` | 2026-08-25 | 16 |  | 121 | 77 | no PR in the scanned window |
| `claude/control-file-coverage-a41c` | 2026-08-25 | 14 |  | 114 | 71 | no PR in the scanned window |
| `claude/guard-content-scan-and-savegate-flake` | 2026-08-25 | 14 |  | 114 | 71 | no PR in the scanned window |
| `claude/pr401-proof` | 2026-08-25 | 15 | 1 | 121 | 77 | no PR in the scanned window |
| `claude/session-orchestration-setup-d73e6c` | 2026-08-25 | 33 |  | 126 | 77 | **open PR #364** |
| `codex/bootstrap-raw-patch-guard-20260825` | 2026-08-25 | 0 |  | 120 | 78 | no PR in the scanned window |
| `codex/pr402-review-gaps-20260819` | 2026-08-25 | 7 |  | 126 | 80 | PR #432 closed unmerged |
| `claude/changelog-docs-honesty` | 2026-08-26 | 16 | 1 | 88 | 57 | PR #505 closed unmerged |
| `claude/comment-fix-applied-closeout` | 2026-08-26 | 14 |  | 81 | 56 | PR #501 closed unmerged |
| `claude/hold-latch-cross-session-envelope` | 2026-08-26 | 15 | 1 | 92 | 59 | no PR in the scanned window |
| `claude/jobdetail-savegate-flake` | 2026-08-26 | 14 |  | 99 | 65 | PR #485 merged |
| `claude/offline-review-stale-snapshot` | 2026-08-26 | 14 |  | 96 | 63 | no PR in the scanned window |
| `claude/pr364-guard-commits-local-20260831` | 2026-08-26 | 33 |  | 110 | 68 | no PR in the scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | 2026-08-26 | 15 | 1 | 98 | 61 | no PR in the scanned window |
| `claude/remove-guard-hooks-f23691` | 2026-08-26 | 15 |  | 83 | 56 | PR #503 closed unmerged |
| `claude/xenodochial-dubinsky-b55362` | 2026-08-26 | 14 |  | 100 | 63 | PR #493 merged |
| `codex/actor-binding-mixed-notation-repair-20260810` | 2026-08-26 | 17 |  | 107 | 68 | **open PR #449** |
| `codex/section9-ap-safety-remediation` | 2026-08-26 | 20 | 2 | 111 | 63 | PR #491 closed unmerged |
| `claude/product-plan-rev12-followup` | 2026-08-27 | 15 |  | 84 | 53 | PR #507 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | 2026-08-27 | 28 | 2 | 105 | 53 | **open PR #500** |
| `codex/autonomy-with-hard-boundaries-20260827` | 2026-08-28 | 3 |  | 41 | 2 | PR #513 closed unmerged |
| `codex/coderabbit-ready-label-20260830` | 2026-08-30 | 5 |  | 13 | 1 | **open PR #516** |
| `claude/bash-safety-opacity-cleanup` | 2026-08-31 | 1 |  | 2 | 0 | **open PR #527** |
| `claude/crx-manager-cleanup-5da404` | 2026-08-31 | 2 |  | 1 | 0 | **open PR #526** |
| `claude/document-cleanup-review-r2nbhj` | 2026-08-31 | 2 |  | 6 | 0 | no PR in the scanned window |
| `claude/harness-guardrail-review-bee189` | 2026-08-31 | 2 |  | 5 | 0 | **open PR #525** |
| `claude/optimize-claude-md-79f8ad` | 2026-08-31 | 1 |  | 2 | 0 | **open PR #528** |
| `claude/pending-set-apply-guard` | 2026-08-31 | 18 |  | 83 | 53 | **open PR #502** |
| `codex/pr509-source-recognition-fix-v2-20260830` | 2026-08-31 | 1 |  | 6 | 0 | **open PR #517** |
| `dependabot/github_actions/actions/checkout-7.0.1` | 2026-08-31 | 0 |  | 6 | 1 | **open PR #518** |
| `dependabot/github_actions/actions/setup-node-7.0.0` | 2026-08-31 | 0 |  | 5 | 1 | **open PR #519** |
| `dependabot/npm_and_yarn/eslint-10.4.1` | 2026-08-31 | 0 |  | 4 | 1 | **open PR #522** |
| `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` | 2026-08-31 | 0 |  | 4 | 1 | **open PR #520** |
| `dependabot/npm_and_yarn/react-major-cbee5c902d` | 2026-08-31 | 0 |  | 4 | 1 | **open PR #521** |

## Suggested review order

1. **The 16 migration-carrying branches.** For each, establish whether its SQL is already live.
   If it is, the branch can go once the migration is recorded in `docs/reference/migration-history.md`;
   if not, decide keep-and-finish or abandon.
2. **The 15 branches holding nothing new.** Confirm and delete.
3. **Branches with no PR in the scanned window (22).** These never entered review — mostly local
   rescue or scratch branches. Check for anything unique before deleting.
4. **Closed-unmerged PR branches.** Confirm the superseding change landed, then delete.
5. **Leave every open-PR branch alone.**

Before deleting anything, read `docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md`.
The previous branch cleanup preserved each deleted tip with a real tag on `origin`, because a SHA
written in a Markdown file keeps nothing alive once the last ref is gone. Use the same approach.

## Method

- Branch list and PR states: GitHub API, 2026-08-31. The PR scan covered #210 (2026-07-22)
  through #528, which spans every branch here — the oldest branch dates to 2026-07-25.
- Merged-ness is read from each PR's `merged_at` timestamp, not the `merged` boolean, which the
  API returned as `false` for PRs that had plainly merged.
- Tree comparison ran on a clone fetched with `git fetch --unshallow`; the original checkout was
  shallow, which made ancestry unusable.
- No branch was created, deleted, force-pushed, or modified in producing this report.
