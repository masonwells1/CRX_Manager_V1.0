# Branch inventory for Codex review — 2026-08-31

Read-only inventory of every remote branch on `masonwells1/CRX_Manager_V1.0`.
**Nothing was deleted.** This list exists so Codex can review it before any branch is removed.

> **Revised twice after Codex review of PR #529.** Both earlier measurements were wrong and
> both were caught here, not by me.
>
> *Round 1* used `git diff origin/main...<branch>`. Three-dot diff compares the merge base with
> the branch, so squash-merged files were re-reported as branch-only work.
>
> *Round 2* switched to a whole-tree comparison but then called any branch with no new file
> paths "safe to delete, loses no content". That was unsound: a branch can hold unique work in a
> file that also exists on `main`. It labelled 15 branches safe when only **2** are — including
> all five Dependabot branches, which have open PRs. It also could not see a branch that
> **modifies an existing migration**, of which there are four.

## How this is measured

Three trees per branch: the branch, `origin/main`, and their merge base.

1. **Authored by the branch** — paths whose blob differs from the *merge base*. A path still
   matching the merge base was never touched by the branch; any difference from `main` there is
   `main` moving ahead, i.e. staleness, and is not counted.
2. **Unique** — of those, the paths where `main` does not hold the identical blob. This is the
   content that is not byte-for-byte present on `main` today.

**Unique is not the same as lost.** A change can be absent byte-identically because it was
superseded, reworked, or landed in a different shape. Unique means *needs a human or Codex
judgement*, not *must be preserved*. Only `unique = 0` is a mechanical all-clear.

Commit ahead/behind counts are not used: this repository squash-merges, so a merged branch
still reports unmerged commits.

## Totals

| | Count |
|---|---|
| Remote branches besides `main` | 63 |
| Holding **nothing** unique (mechanically safe) | 2 |
| Carrying migrations `main` does not have | 12 |
| **Modifying an existing migration file** | 4 |
| — of which appear in **both** rows above | 2 |
| Distinct branches touching migrations | **14** |
| Attached to an open PR | 16 |
| No PR in the scanned window | 22 |

## Read this first: branches that modify an existing migration

**4 branches change a `supabase/migrations/*.sql` file that already exists on `main`, to
content `main` does not have.** Editing an applied migration is forbidden by the CRX Hard Rules,
so each of these is either a rebase artifact, an abandoned edit, or a real rule violation that
never landed. Resolve these before anything else — and note one is on an open PR.

> **These two migration sections overlap — do not add their counts.** 2 branches appear in
> both (`claude/recover-applied-migrations-20260812`, `codex/pr389-coderabbit-fixes`), so the two
> sections cover **14 distinct branches**, not 16.

| Branch | Last commit | Modified migrations | PR status |
|---|---|---|---|
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | `20260812115238_repair_historical_order_line_cents.sql`<br>`20260813080000_lock_quote_versions_writes_to_rpc.sql` | PR #395 closed unmerged |
| `codex/pr509-source-recognition-fix-v2-20260830` | 2026-08-31 | `20260827041100_rebuild_return_credit_cogs_reversal.sql`<br>`20260827041400_align_return_credit_order_invoice_gates.sql` | **open PR #517** |
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | `20260813080000_lock_quote_versions_writes_to_rpc.sql` | PR #397 closed unmerged |
| `claude/draw-down-price-tier-lines` | 2026-08-19 | `20260816120000_draw_down_split_order_lines_by_price_tier.sql` | PR #404 merged |

## Migrations absent from `main`

**12 branches hold `supabase/migrations/*.sql` files that do not exist on `main` at all.**

Each has one of **three** dispositions, and the third is easy to miss:

- **Applied live** — the branch may hold the only exact source of SQL running in production.
  See the recovery rule below before deleting anything.
- **Pending** — a candidate still under review or awaiting its rollout. `main` not having it is
  the normal state, not evidence of abandonment. The repository's own ledger uses this state
  explicitly (`LOCAL CANDIDATE — NOT APPLIED`, `SOURCE ONLY — NOT APPLIED LIVE`), and the
  branches below on **open PRs are pending by default** — leave them alone.
- **Abandoned** — superseded or dropped. Safe to delete once the tip is preserved.

**"Not applied live" does not mean abandoned.** Establish disposition from the PR and the ledger,
never from the absence of a live apply.

| Branch | Last commit | New migrations | Unique files | PR status |
|---|---|---|---|---|
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | **7** | 96 | PR #397 closed unmerged |
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | **5** | 28 | PR #395 closed unmerged |
| `claude/wave-a-migrations-857dcd` | 2026-08-12 | **4** | 8 | no PR in scanned window |
| `codex/harden-actor-binding-sql-reader` | 2026-08-12 | **3** | 7 | PR #373 closed unmerged |
| `claude/pricing-audit-strategy-jym8rr` | 2026-08-10 | **2** | 31 | PR #350 closed unmerged |
| `codex/section9-ap-safety-remediation` | 2026-08-26 | **2** | 27 | PR #491 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | 2026-08-27 | **2** | 45 | **open PR #500** |
| `codex/section1-security-hardening-20260725` | 2026-07-25 | **1** | 16 | no PR in scanned window |
| `claude/return-credit-cogs-reversal` | 2026-08-09 | **1** | 4 | **open PR #361** |
| `claude/restrict-draw-down-owner` | 2026-08-14 | **1** | 14 | no PR in scanned window |
| `claude/pr401-proof` | 2026-08-25 | **1** | 14 | no PR in scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | 2026-08-26 | **1** | 18 | no PR in scanned window |

### If a migration here is applied live, recover the SQL before deleting the branch

**A prose entry in `docs/reference/migration-history.md` is necessary but NOT sufficient.** Where a
branch holds the only exact source of SQL that is running in production, deleting the branch on the
strength of a ledger note leaves production behaviour absent from the repository — a cleanup tag
preserves the commit object, but `main` still would not describe the live database.

The established remedy is in this repository already. The recovery note for rows 880–885 of
`docs/reference/migration-history.md` covers six migrations applied to production on 2026-08-12 by
sessions that never landed their files. It records that for part of a day `main` did not describe
production, and that the fix was to publish the exact `apply_migration` payload **byte-identical**
under `supabase/migrations/` — explicitly *not* reconstructions — with fidelity then proven by
md5-comparing extracted function bodies against live `pg_proc.prosrc`.

So, per branch in this section: confirm live status, and if it is live, land the byte-identical SQL
into `supabase/migrations/` **first**. Only then is the branch free to delete.

<details><summary>Migration filenames per branch</summary>

**`codex/pr389-coderabbit-fixes`** — absent from `main`:

- `20260812145628_snapshot_cost_reporting.sql`
- `20260812151606_quote_items_cost_at_quote_snapshot.sql`
- `20260812154028_enforce_below_cost_admin_approval.sql`
- `20260813090000_restrict_restore_quote_owner_impl.sql`
- `20260813161614_restrict_draw_down_quote_owner.sql`
- `20260814041419_fresh_below_cost_reason.sql`
- `20260814063000_quote_sections_rpc_owned.sql`

**`claude/recover-applied-migrations-20260812`** — absent from `main`:

- `20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `20260813020000_round_order_header_money.sql`
- `20260813030000_reject_non_finite_money_and_quantities.sql`
- `20260813040000_clamp_negative_commission_remainder.sql`
- `20260813180000_quote_version_restore_trust_boundary.sql`

**`claude/wave-a-migrations-857dcd`** — absent from `main`:

- `20260813010000_wave_a_order_cost_authority_and_finiteness.sql`
- `20260813020000_round_order_header_money.sql`
- `20260813030000_reject_non_finite_money_and_quantities.sql`
- `20260813040000_clamp_negative_commission_remainder.sql`

**`codex/harden-actor-binding-sql-reader`** — absent from `main`:

- `20260813030000_reject_non_finite_money_and_quantities.sql`
- `20260813050000_guard_job_commission_split_immutable.sql`
- `20260813060000_require_completed_delivery_before_invoice_post.sql`

**`claude/pricing-audit-strategy-jym8rr`** — absent from `main`:

- `20260808170100_snapshot_cost_reporting.sql`
- `20260808170200_quote_items_cost_at_quote_snapshot.sql`

**`codex/section9-ap-safety-remediation`** — absent from `main`:

- `20260826125456_bind_section9_ap_receiving_intent_and_month_dashboard.sql`
- `20260826140333_correct_ap_aging_due_date_buckets.sql`

**`codex/section9-ap-safety-remediation-v2`** — absent from `main`:

- `20260826221000_bind_section9_ap_receiving_intent_and_month_dashboard.sql`
- `20260826222000_correct_ap_aging_due_date_buckets.sql`

**`codex/section1-security-hardening-20260725`** — absent from `main`:

- `20260725234503_harden_section1_number_and_field_actor.sql`

**`claude/return-credit-cogs-reversal`** — absent from `main`:

- `20260808170000_return_credit_cogs_reversal.sql`

**`claude/restrict-draw-down-owner`** — absent from `main`:

- `20260813161614_restrict_draw_down_quote_owner.sql`

**`claude/pr401-proof`** — absent from `main`:

- `20260825190000_quote_version_restore_trust_boundary.sql`

**`claude/pr401-quote-version-trust-8e3db6`** — absent from `main`:

- `20260825190000_quote_version_restore_trust_boundary.sql`

**`claude/recover-applied-migrations-20260812`** — modifies an existing migration:

- `20260812115238_repair_historical_order_line_cents.sql`
- `20260813080000_lock_quote_versions_writes_to_rpc.sql`

**`codex/pr509-source-recognition-fix-v2-20260830`** — modifies an existing migration:

- `20260827041100_rebuild_return_credit_cogs_reversal.sql`
- `20260827041400_align_return_credit_order_invoice_gates.sql`

**`codex/pr389-coderabbit-fixes`** — modifies an existing migration:

- `20260813080000_lock_quote_versions_writes_to_rpc.sql`

**`claude/draw-down-price-tier-lines`** — modifies an existing migration:

- `20260816120000_draw_down_split_order_lines_by_price_tier.sql`

</details>

## Mechanically safe to delete

Only these 2 branches hold nothing `main` lacks — every blob they authored is already on
`main` byte-for-byte.

| Branch | Last commit | PR status |
|---|---|---|
| `pr435-work` | 2026-08-20 | no PR in scanned window |
| `claude/jobdetail-savegate-flake` | 2026-08-26 | PR #485 merged |

## Every branch

| Branch | Last commit | Unique files | new | modified | New migs | Mod migs | Behind | PR status |
|---|---|---|---|---|---|---|---|---|
| `codex/section1-security-hardening-20260725` | 2026-07-25 | 16 | 4 | 12 | 1 |  | 599 | no PR in scanned window |
| `chore/migration-ledger-reconcile-20260729` | 2026-07-29 | 6 | 0 | 6 |  |  | 554 | PR #275 closed unmerged |
| `codex/idempotency-reset-order-hardening-20260802` | 2026-08-02 | 26 | 2 | 24 |  |  | 485 | no PR in scanned window |
| `codex/section4-lifecycle-20260805` | 2026-08-05 | 11 | 0 | 11 |  |  | 438 | PR #321 closed unmerged |
| `claude/log-session-attribution-fix` | 2026-08-06 | 1 | 1 | 0 |  |  | 434 | PR #317 merged |
| `claude/push-guard-fix-rescue-e3320d` | 2026-08-07 | 4 | 0 | 4 |  |  | 431 | no PR in scanned window |
| `claude/rescue-unique-docs-20260807` | 2026-08-07 | 10 | 9 | 1 |  |  | 431 | no PR in scanned window |
| `claude/ordering-cycle-review-t41vat-local-20260831` | 2026-08-09 | 2 | 0 | 2 |  |  | 351 | no PR in scanned window |
| `claude/return-credit-cogs-reversal` | 2026-08-09 | 4 | 1 | 3 | 1 |  | 353 | **open PR #361** |
| `claude/ordering-cycle-review-t41vat` | 2026-08-10 | 2 | 0 | 2 |  |  | 349 | PR #356 merged; PR #363 closed unmerged |
| `claude/pricing-audit-strategy-jym8rr` | 2026-08-10 | 31 | 8 | 23 | 2 |  | 353 | PR #350 closed unmerged |
| `claude/wave-a-migrations-857dcd` | 2026-08-12 | 8 | 4 | 4 | 4 |  | 288 | no PR in scanned window |
| `codex/harden-actor-binding-sql-reader` | 2026-08-12 | 7 | 4 | 3 | 3 |  | 288 | PR #373 closed unmerged |
| `claude/recover-applied-migrations-20260812` | 2026-08-13 | 28 | 6 | 22 | 5 | 2 | 285 | PR #395 closed unmerged |
| `claude/restrict-draw-down-owner` | 2026-08-14 | 14 | 4 | 10 | 1 |  | 282 | no PR in scanned window |
| `codex/pr389-coderabbit-fixes` | 2026-08-14 | 96 | 37 | 59 | 7 | 1 | 278 | PR #397 closed unmerged |
| `codex/sol-gate-recovery-exception` | 2026-08-14 | 13 | 1 | 12 |  |  | 278 | PR #403 closed unmerged |
| `claude/blend-unit-rebuild-step1` | 2026-08-19 | 7 | 0 | 7 |  |  | 203 | no PR in scanned window |
| `claude/draw-down-price-tier-lines` | 2026-08-19 | 16 | 0 | 16 |  | 1 | 212 | PR #404 merged |
| `claude/zealous-agnesi-aa7423` | 2026-08-20 | 12 | 2 | 10 |  |  | 210 | no PR in scanned window |
| `claude/zen-easley-7d771d` | 2026-08-20 | 5 | 0 | 5 |  |  | 205 | no PR in scanned window |
| `codex/fleet-scan-parked-state` | 2026-08-20 | 5 | 0 | 5 |  |  | 176 | no PR in scanned window |
| `pr435-work` | 2026-08-20 | 0 | 0 | 0 |  |  | 160 | no PR in scanned window |
| `claude/coderabbit-setup-optimize-0f308d` | 2026-08-24 | 13 | 3 | 10 |  |  | 102 | PR #441 closed unmerged |
| `claude/codex-guard-single-ampersand` | 2026-08-24 | 4 | 0 | 4 |  |  | 87 | PR #464 closed unmerged |
| `claude/codex-recursion-hard-guard` | 2026-08-24 | 15 | 10 | 5 |  |  | 102 | PR #452 closed unmerged |
| `claude/push-guard-git-resolution` | 2026-08-24 | 8 | 0 | 8 |  |  | 98 | PR #445 closed unmerged |
| `codex/proof-wrapper-trusted-git-bootstrap` | 2026-08-24 | 3 | 0 | 3 |  |  | 102 | PR #454 closed unmerged |
| `fix/quote-fixture-stale-date` | 2026-08-24 | 1 | 0 | 1 |  |  | 85 | PR #468 closed unmerged |
| `claude/codex-claude-cogs-handoff-7bde15` | 2026-08-25 | 4 | 2 | 2 |  |  | 77 | no PR in scanned window |
| `claude/control-file-coverage-a41c` | 2026-08-25 | 2 | 0 | 2 |  |  | 71 | no PR in scanned window |
| `claude/guard-content-scan-and-savegate-flake` | 2026-08-25 | 7 | 0 | 7 |  |  | 71 | no PR in scanned window |
| `claude/pr401-proof` | 2026-08-25 | 14 | 1 | 13 | 1 |  | 77 | no PR in scanned window |
| `claude/session-orchestration-setup-d73e6c` | 2026-08-25 | 42 | 19 | 23 |  |  | 77 | **open PR #364** |
| `codex/bootstrap-raw-patch-guard-20260825` | 2026-08-25 | 2 | 0 | 2 |  |  | 78 | no PR in scanned window |
| `codex/pr402-review-gaps-20260819` | 2026-08-25 | 25 | 7 | 18 |  |  | 80 | PR #432 closed unmerged |
| `claude/changelog-docs-honesty` | 2026-08-26 | 3 | 1 | 2 |  |  | 57 | PR #505 closed unmerged |
| `claude/comment-fix-applied-closeout` | 2026-08-26 | 4 | 0 | 4 |  |  | 56 | PR #501 closed unmerged |
| `claude/hold-latch-cross-session-envelope` | 2026-08-26 | 7 | 0 | 7 |  |  | 59 | no PR in scanned window |
| `claude/jobdetail-savegate-flake` | 2026-08-26 | 0 | 0 | 0 |  |  | 65 | PR #485 merged |
| `claude/offline-review-stale-snapshot` | 2026-08-26 | 1 | 0 | 1 |  |  | 63 | no PR in scanned window |
| `claude/pr364-guard-commits-local-20260831` | 2026-08-26 | 44 | 19 | 25 |  |  | 68 | no PR in scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | 2026-08-26 | 18 | 1 | 17 | 1 |  | 61 | no PR in scanned window |
| `claude/remove-guard-hooks-f23691` | 2026-08-26 | 4 | 1 | 3 |  |  | 56 | PR #503 closed unmerged |
| `claude/xenodochial-dubinsky-b55362` | 2026-08-26 | 11 | 0 | 11 |  |  | 63 | PR #493 merged |
| `codex/actor-binding-mixed-notation-repair-20260810` | 2026-08-26 | 12 | 3 | 9 |  |  | 68 | **open PR #449** |
| `codex/section9-ap-safety-remediation` | 2026-08-26 | 27 | 6 | 21 | 2 |  | 63 | PR #491 closed unmerged |
| `claude/product-plan-rev12-followup` | 2026-08-27 | 3 | 1 | 2 |  |  | 53 | PR #507 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | 2026-08-27 | 45 | 14 | 31 | 2 |  | 53 | **open PR #500** |
| `codex/autonomy-with-hard-boundaries-20260827` | 2026-08-28 | 31 | 3 | 28 |  |  | 2 | PR #513 closed unmerged |
| `codex/coderabbit-ready-label-20260830` | 2026-08-30 | 16 | 5 | 11 |  |  | 1 | **open PR #516** |
| `claude/bash-safety-opacity-cleanup` | 2026-08-31 | 3 | 1 | 2 |  |  | 0 | **open PR #527** |
| `claude/crx-manager-cleanup-5da404` | 2026-08-31 | 3 | 2 | 1 |  |  | 0 | **open PR #526** |
| `claude/document-cleanup-review-r2nbhj` | 2026-08-31 | 33 | 27 | 6 |  |  | 0 | no PR in scanned window |
| `claude/harness-guardrail-review-bee189` | 2026-08-31 | 7 | 2 | 5 |  |  | 0 | **open PR #525** |
| `claude/optimize-claude-md-79f8ad` | 2026-08-31 | 3 | 1 | 2 |  |  | 0 | **open PR #528** |
| `claude/pending-set-apply-guard` | 2026-08-31 | 11 | 4 | 7 |  |  | 53 | **open PR #502** |
| `codex/pr509-source-recognition-fix-v2-20260830` | 2026-08-31 | 7 | 1 | 6 |  | 2 | 0 | **open PR #517** |
| `dependabot/github_actions/actions/checkout-7.0.1` | 2026-08-31 | 4 | 0 | 4 |  |  | 1 | **open PR #518** |
| `dependabot/github_actions/actions/setup-node-7.0.0` | 2026-08-31 | 3 | 0 | 3 |  |  | 1 | **open PR #519** |
| `dependabot/npm_and_yarn/eslint-10.4.1` | 2026-08-31 | 2 | 0 | 2 |  |  | 1 | **open PR #522** |
| `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` | 2026-08-31 | 2 | 0 | 2 |  |  | 1 | **open PR #520** |
| `dependabot/npm_and_yarn/react-major-cbee5c902d` | 2026-08-31 | 2 | 0 | 2 |  |  | 1 | **open PR #521** |

## Suggested review order

1. **The 4 branches modifying an existing migration.** Hard-rule territory; one is on an open PR.
2. **The 12 branches holding migrations absent from `main`** (2 of which are also in step 1, so
   steps 1 and 2 are 14 branches in total). Establish each migration's disposition —
   **applied live**, **pending**, or **abandoned** — from its PR and the ledger, never from the
   absence of a live apply. Applied live: the recovery rule above applies before the branch goes.
   Pending: leave it alone. Abandoned: delete once the tip is preserved.
3. **The 2 mechanically-safe branches.** Confirm and delete.
4. **Everything else.** Each holds unique blobs that need a judgement on whether the work was
   superseded. Start with branches whose PR closed unmerged.
5. **Leave every open-PR branch alone** — all five Dependabot branches are live dependency PRs.

Before deleting anything, read `docs/audits/2026-07-27-branch-worktree-cleanup-restore-ledger.md`.
The previous cleanup preserved each deleted tip with a real tag on `origin`, because a SHA written
in Markdown keeps nothing alive once the last ref is gone. Use the same approach.

## Method

- Branch list and PR states: GitHub API, 2026-08-31. The PR scan covered #210 (2026-07-22)
  through #528, spanning every branch here — the oldest dates to 2026-07-25.
- Merged-ness read from each PR's `merged_at` timestamp, not the `merged` boolean, which the API
  returned as `false` for PRs that had plainly merged.
- Trees read with `git ls-tree -r` on a clone fetched with `git fetch --unshallow`; the original
  checkout was shallow, which made ancestry unusable.
- No branch was created, deleted, force-pushed, or modified in producing this report.
