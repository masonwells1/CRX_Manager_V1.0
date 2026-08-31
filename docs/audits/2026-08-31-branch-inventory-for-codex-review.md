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
> file that also exists on `main`. It labelled 15 branches safe when only 2 were at the time
> (3 now, after a Dependabot PR merged mid-review) — including
> every Dependabot branch, all of which had open PRs at the time. It also could not see a branch that
> **modifies an existing migration**, of which there are four.

## The baseline this is measured against

Every figure below is relative to **`origin/main` at `4436aded119d1437e43499ee90f394e5092be03f`**.

This matters as much as the branch tip OIDs. `main` moves, and when it does the comparison
changes underneath a branch that never moved at all. **`main` moved twice while this report was
in review, and both times the numbers changed.**

The first move, to `ec90015d`, deleted `.github/workflows/production-migration.yml` and
`production-approval-canary.yml`. Seven branches changed their unique-content figures without a
single commit being pushed to any of them; both `dependabot/github_actions/*` branches bump an
action version *inside* those deleted files, so what was a modification of a file `main` has
became the addition of a file `main` lacks.

The second move is the sharper one, because it changed a **deletion verdict**. `main` advanced
to the commit above, which merged Dependabot PR #520. That branch,
`dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea`, was listed here as *open PR — leave it
alone*. Its PR is now merged and its content is on `main`, so it is now one of the
mechanically-safe branches. **A reader working from the previous revision of this report would
have protected a branch that no longer needed protecting — and, had the change run the other
way, could have deleted one that did.** Nothing was pushed to that branch; only the baseline
moved.

Across both moves no branch's *migration* classification changed. That is luck, not a property
of the measure.

Before acting on this report, confirm the server's `main` still points at the OID above with
`git ls-remote origin refs/heads/main` — **not** a bare `git rev-parse origin/main`, which reads
the local remote-tracking ref and happily returns a stale OID in a checkout that has not fetched.
A stale read here is the worst possible failure mode: it says the baseline is current when `main`
has moved, which is exactly the condition under which these classifications are wrong. Fetch, or
ask the server.
If it does not, re-run the measurement rather than trusting these counts.

## How this is measured

Three trees per branch: the branch, `origin/main`, and their merge base.

1. **Authored by the branch** — paths whose blob differs from the *merge base*, **plus paths
   present at the merge base and absent from the branch, which the branch deleted**. A path
   still matching the merge base was never touched by the branch; any difference from `main`
   there is `main` moving ahead, i.e. staleness, and is not counted.
2. **Unique** — of those, the paths where `main` does not hold the identical blob, plus the
   authored deletions of paths `main` still carries. This is the change that is not present
   on `main` today.

> **Deletions were added to this measure in round 5, after Codex found them missing.** The
> comparison walked only paths *present in the branch tree*, so a path the branch removed
> appeared nowhere and was never counted. A branch whose only unique work was a deletion would
> have reported `unique = 0` and been declared mechanically safe — precisely the false
> all-clear this report exists to prevent.
>
> Re-measured with deletions counted, **the mechanically-safe branches below are
> unchanged**: neither authors any deletion, so neither all-clear was wrong. The only branch
> the omission actually affected was this cleanup's own, which deletes and moves records.
> The bug was real and the exposure was luck, not design.

**Unique is not the same as lost.** A change can be absent byte-identically because it was
superseded, reworked, or landed in a different shape. Unique means *needs a human or Codex
judgement*, not *must be preserved*. Only `unique = 0` is a mechanical all-clear.

Commit ahead/behind counts are not used: this repository squash-merges, so a merged branch
still reports unmerged commits.

## Totals

| | Count |
|---|---|
| Remote branches besides `main` | 63 |
| Holding **nothing** unique (mechanically safe) | 3 |
| Carrying migrations `main` does not have | 12 |
| **Modifying an existing migration file** | 4 |
| — of which appear in **both** rows above | 2 |
| Distinct branches touching migrations | **14** |
| Attached to an open PR | 15 |
| No PR in the scanned window | 22 |

## Read this first: branches that modify an existing migration

**4 branches change a `supabase/migrations/*.sql` file that already exists on `main`, to
content `main` does not have.** Editing an applied migration is forbidden by the CRX Hard Rules,
so each of these is either a rebase artifact, an abandoned edit, or a real rule violation that
never landed. Resolve these before anything else — and note one is on an open PR.

> **These two migration sections overlap — do not add their counts.** 2 branches appear in
> both (`claude/recover-applied-migrations-20260812`, `codex/pr389-coderabbit-fixes`), so the two
> sections cover **14 distinct branches**, not 16.

### What to do with one of these before deleting it

Establish which of three cases it is, from the PR, the ledger and the file itself — never from
the fact that `main` differs:

- **A rebase or merge artifact.** The branch's copy is an older or re-stamped version of a file
  `main` already carries. Nothing to preserve; delete once the tip is tagged.
- **An abandoned edit.** A real change that was never applied and never landed. Confirm the
  superseding work exists, then delete once the tip is tagged.
- **Applied live in the modified form.** The branch holds the only exact source of SQL running
  in production. Use **"A modified migration needs a forward reconciliation"** below — *not* the
  byte-identical recovery rule written for absent files, which is unsafe here: restoring to the
  original path edits an applied migration, and re-stamping under a new timestamp runs it again.
  Do not assume a modified file is safe merely because a file of that name already exists on
  `main`; what matters is which bytes production is running.

A branch on an **open PR** is pending: leave it alone regardless of which case it looks like.
`codex/pr509-source-recognition-fix-v2-20260830` is in exactly that position on PR #517.

Editing an applied migration is forbidden by the CRX Hard Rules, so if any of these turns out to
be case three, the violation already reached production and the ledger needs correcting as well
as the branch preserving.

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
  See the byte-identical recovery rule below before deleting anything. It is the right rule for
  *these* branches, because the file is absent from `main` entirely.
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

### If a migration is applied live, recover the SQL before deleting the branch

**This rule governs only the *absent-file* case** — a branch holding a migration `main` does not
have. Branches that **modify** a migration `main` already has need a different procedure, below;
applying this one to them is unsafe.

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

### A modified migration needs a forward reconciliation, never a re-stamp

For the four branches that modify a migration `main` already has, the recovery rule above does not
apply, and following it would be unsafe. Both of its obvious readings are wrong:

- **Restore the branch's version to the original path.** That edits an applied migration, which the
  CRX Hard Rules forbid outright.
- **Re-stamp the payload under a new timestamp.** That makes it *execute again*. These are not
  abstractly replayable scripts.

`20260812115238_repair_historical_order_line_cents.sql`, carried by
`claude/recover-applied-migrations-20260812`, is the concrete case. It is a one-time historical
money repair that binds an approved preimage — 35 mapped rows, 16 orders, 151 order lines, and a
content digest — and raises `APPROVED_SET_DRIFTED` when the database no longer matches. Re-stamped
after the repair has landed, it does not silently corrupt anything, but it *does* abort, so the
attempt fails a deploy rather than recovering anything.

The procedure for these is therefore:

1. **Leave the file on `main` exactly as it is.** It is applied; it is immutable.
2. **Recover the branch's version as evidence, not as a migration** — extract it to an audit note
   or attach it to the branch's disposition record, so the difference is readable without the
   branch.
3. **Diff the two and decide whether the difference ever reached the database.** Read-only live
   introspection answers this; the branch file alone does not.
4. **If, and only if, a real difference must reach production**, write a *new* migration that is
   deliberately replay-safe — guarded so that running it against an already-reconciled database is
   a no-op rather than an error. That is a forward reconciliation, and it is a separate reviewed
   change, not part of a branch cleanup.

Nothing in step 4 belongs in a deletion sweep. If a modified migration turns out to hold a real
difference, the branch stays until that reconciliation has shipped.

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

Only these 3 branches hold nothing `main` lacks — every blob they authored is already on
`main` byte-for-byte.

| Branch | Tip OID at scan | Last commit | PR status |
|---|---|---|---|
| `pr435-work` | `0f095b81efe5b97ae4b8356ef22699585cd65b8e` | 2026-08-20 | no PR in scanned window |
| `claude/jobdetail-savegate-flake` | `60700533eb38ae0c19ce525e523ae71486617c48` | 2026-08-26 | PR #485 merged |
| `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` | `949a1c5bec624f1f441ebd112188bac2b294927d` | 2026-08-31 | PR #520 merged |

**Re-verify the tip before deleting.** Every classification in this report is a snapshot of a
specific commit, listed above in full. If `git ls-remote origin <branch>` no longer returns that
OID, the branch moved after the scan and its classification is stale — rerun the authored/unique
tree comparison before acting. A cleanup tag preserves whatever commit it points at; it does not
make an out-of-date classification correct.

**Re-check the PR state too, and separately.** A matching tip OID does **not** mean the PR column
below is still right: a branch can acquire an open pull request without a single commit being
pushed to it, so the content check and the PR check can disagree. This report's PR scan stops at
PR `#528`, and PR `#529` — the pull request carrying this very report — is already past it, which
is the demonstration rather than a hypothetical. Before deleting any branch, run a fresh PR lookup
for it *in addition to* `git ls-remote`, and leave it alone if it now has an open PR.

## Every branch

Tip OIDs are abbreviated here; the 3 mechanically-safe branches carry their full OID above.

| Branch | Tip at scan | Unique files | new | modified | New migs | Mod migs | Behind | PR status |
|---|---|---|---|---|---|---|---|---|
| `codex/section1-security-hardening-20260725` | `53f6177eb6af` | 16 | 4 | 12 | 1 |  | 603 | no PR in scanned window |
| `chore/migration-ledger-reconcile-20260729` | `65716b1c2d91` | 6 | 0 | 6 |  |  | 558 | PR #275 closed unmerged |
| `codex/idempotency-reset-order-hardening-20260802` | `9049efc80e3e` | 26 | 2 | 24 |  |  | 489 | no PR in scanned window |
| `codex/section4-lifecycle-20260805` | `99cfcff5825e` | 11 | 0 | 11 |  |  | 442 | PR #321 closed unmerged |
| `claude/log-session-attribution-fix` | `f9f5e5642b30` | 1 | 1 | 0 |  |  | 438 | PR #317 merged |
| `claude/push-guard-fix-rescue-e3320d` | `300206b9c113` | 4 | 0 | 4 |  |  | 435 | no PR in scanned window |
| `claude/rescue-unique-docs-20260807` | `bad8c8dbe4de` | 10 | 9 | 1 |  |  | 435 | no PR in scanned window |
| `claude/ordering-cycle-review-t41vat-local-20260831` | `8fc8d81460e3` | 2 | 0 | 2 |  |  | 355 | no PR in scanned window |
| `claude/return-credit-cogs-reversal` | `c4e83dea632b` | 4 | 1 | 3 | 1 |  | 357 | **open PR #361** |
| `claude/ordering-cycle-review-t41vat` | `992ee0888176` | 2 | 0 | 2 |  |  | 353 | PR #356 merged; PR #363 closed unmerged |
| `claude/pricing-audit-strategy-jym8rr` | `f4eaa8259834` | 31 | 8 | 23 | 2 |  | 357 | PR #350 closed unmerged |
| `claude/wave-a-migrations-857dcd` | `3bfd6271caae` | 8 | 4 | 4 | 4 |  | 292 | no PR in scanned window |
| `codex/harden-actor-binding-sql-reader` | `e652f7232da2` | 7 | 4 | 3 | 3 |  | 292 | PR #373 closed unmerged |
| `claude/recover-applied-migrations-20260812` | `27817c2a5329` | 28 | 6 | 22 | 5 | 2 | 289 | PR #395 closed unmerged |
| `claude/restrict-draw-down-owner` | `13e4c7b14f38` | 14 | 4 | 10 | 1 |  | 286 | no PR in scanned window |
| `codex/pr389-coderabbit-fixes` | `203a4742a9c2` | 96 | 37 | 59 | 7 | 1 | 282 | PR #397 closed unmerged |
| `codex/sol-gate-recovery-exception` | `9817fb9e058a` | 13 | 1 | 12 |  |  | 282 | PR #403 closed unmerged |
| `claude/blend-unit-rebuild-step1` | `91051d74ecb3` | 7 | 0 | 7 |  |  | 207 | no PR in scanned window |
| `claude/draw-down-price-tier-lines` | `b4c80b37c2a4` | 16 | 0 | 16 |  | 1 | 216 | PR #404 merged |
| `claude/zealous-agnesi-aa7423` | `4347e4566435` | 12 | 2 | 10 |  |  | 214 | no PR in scanned window |
| `claude/zen-easley-7d771d` | `23343e15409c` | 5 | 0 | 5 |  |  | 209 | no PR in scanned window |
| `codex/fleet-scan-parked-state` | `6f766135fddb` | 5 | 0 | 5 |  |  | 180 | no PR in scanned window |
| `pr435-work` | `0f095b81efe5` | 0 | 0 | 0 |  |  | 164 | no PR in scanned window |
| `claude/coderabbit-setup-optimize-0f308d` | `5b58e3524aa4` | 13 | 3 | 10 |  |  | 106 | PR #441 closed unmerged |
| `claude/codex-guard-single-ampersand` | `dddc6d74820a` | 4 | 0 | 4 |  |  | 91 | PR #464 closed unmerged |
| `claude/codex-recursion-hard-guard` | `47820dff7ed6` | 15 | 10 | 5 |  |  | 106 | PR #452 closed unmerged |
| `claude/push-guard-git-resolution` | `62d22b6e9de2` | 8 | 0 | 8 |  |  | 102 | PR #445 closed unmerged |
| `codex/proof-wrapper-trusted-git-bootstrap` | `a2e1d0a18369` | 3 | 0 | 3 |  |  | 106 | PR #454 closed unmerged |
| `fix/quote-fixture-stale-date` | `be5df11c5daf` | 1 | 0 | 1 |  |  | 89 | PR #468 closed unmerged |
| `claude/codex-claude-cogs-handoff-7bde15` | `e3c4a3fc47df` | 4 | 2 | 2 |  |  | 81 | no PR in scanned window |
| `claude/control-file-coverage-a41c` | `b985e919bef5` | 2 | 0 | 2 |  |  | 75 | no PR in scanned window |
| `claude/guard-content-scan-and-savegate-flake` | `480dc106ef7b` | 7 | 0 | 7 |  |  | 75 | no PR in scanned window |
| `claude/pr401-proof` | `9b2d86a5401a` | 14 | 1 | 13 | 1 |  | 81 | no PR in scanned window |
| `claude/session-orchestration-setup-d73e6c` | `238d242ea87f` | 42 | 19 | 23 |  |  | 81 | **open PR #364** |
| `codex/bootstrap-raw-patch-guard-20260825` | `fe73022380ed` | 2 | 0 | 2 |  |  | 82 | no PR in scanned window |
| `codex/pr402-review-gaps-20260819` | `8811927fff8d` | 25 | 7 | 18 |  |  | 84 | PR #432 closed unmerged |
| `claude/changelog-docs-honesty` | `cc8eed92c508` | 3 | 1 | 2 |  |  | 61 | PR #505 closed unmerged |
| `claude/comment-fix-applied-closeout` | `01660702bca6` | 4 | 0 | 4 |  |  | 60 | PR #501 closed unmerged |
| `claude/hold-latch-cross-session-envelope` | `c903bda704a5` | 7 | 0 | 7 |  |  | 63 | no PR in scanned window |
| `claude/jobdetail-savegate-flake` | `60700533eb38` | 0 | 0 | 0 |  |  | 69 | PR #485 merged |
| `claude/offline-review-stale-snapshot` | `5c2c129d431c` | 1 | 0 | 1 |  |  | 67 | no PR in scanned window |
| `claude/pr364-guard-commits-local-20260831` | `57d27e79105b` | 45 | 19 | 26 |  |  | 72 | no PR in scanned window |
| `claude/pr401-quote-version-trust-8e3db6` | `510a16121e6c` | 18 | 1 | 17 | 1 |  | 65 | no PR in scanned window |
| `claude/remove-guard-hooks-f23691` | `0ac235d0e50e` | 4 | 1 | 3 |  |  | 60 | PR #503 closed unmerged |
| `claude/xenodochial-dubinsky-b55362` | `b7e847d98ccd` | 11 | 0 | 11 |  |  | 67 | PR #493 merged |
| `codex/actor-binding-mixed-notation-repair-20260810` | `5cd3d379da4f` | 12 | 3 | 9 |  |  | 72 | **open PR #449** |
| `codex/section9-ap-safety-remediation` | `0f8bf3aad7f0` | 27 | 6 | 21 | 2 |  | 67 | PR #491 closed unmerged |
| `claude/product-plan-rev12-followup` | `74ccba0f7888` | 3 | 1 | 2 |  |  | 57 | PR #507 closed unmerged |
| `codex/section9-ap-safety-remediation-v2` | `4148f335e682` | 45 | 14 | 31 | 2 |  | 57 | **open PR #500** |
| `codex/autonomy-with-hard-boundaries-20260827` | `3accebbef6ab` | 31 | 3 | 28 |  |  | 6 | PR #513 closed unmerged |
| `codex/coderabbit-ready-label-20260830` | `7e87e0231601` | 16 | 5 | 11 |  |  | 5 | **open PR #516** |
| `claude/bash-safety-opacity-cleanup` | `3d1690428695` | 3 | 1 | 2 |  |  | 4 | **open PR #527** |
| `claude/crx-manager-cleanup-5da404` | `738d311a1e65` | 2 | 2 | 0 |  |  | 4 | **open PR #526** |
| `claude/document-cleanup-review-r2nbhj` | `370c73b952f8` | 24 | 16 | 7 |  |  | 0 | no PR in scanned window |
| `claude/harness-guardrail-review-bee189` | `2198e43db6e3` | 2 | 0 | 2 |  |  | 4 | **open PR #525** |
| `claude/optimize-claude-md-79f8ad` | `86229bb0e361` | 1 | 0 | 1 |  |  | 4 | **open PR #528** |
| `claude/pending-set-apply-guard` | `b141e84d56b1` | 11 | 4 | 7 |  |  | 57 | **open PR #502** |
| `codex/pr509-source-recognition-fix-v2-20260830` | `259856da608f` | 6 | 1 | 5 |  | 2 | 4 | **open PR #517** |
| `dependabot/github_actions/actions/checkout-7.0.1` | `cbf14d3e2af8` | 4 | 2 | 2 |  |  | 5 | **open PR #518** |
| `dependabot/github_actions/actions/setup-node-7.0.0` | `bc8183c9e963` | 3 | 2 | 1 |  |  | 5 | **open PR #519** |
| `dependabot/npm_and_yarn/eslint-10.4.1` | `66103fdbb6ae` | 2 | 0 | 2 |  |  | 5 | **open PR #522** |
| `dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea` | `949a1c5bec62` | 0 | 0 | 0 |  |  | 5 | PR #520 merged |
| `dependabot/npm_and_yarn/react-major-cbee5c902d` | `2da0ec8cbd56` | 2 | 0 | 2 |  |  | 5 | **open PR #521** |

## Suggested review order

1. **The 4 branches modifying an existing migration.** Hard-rule territory; one is on an open PR.
   Establish rebase artifact / abandoned edit / applied-live from the PR and the ledger, per
   "What to do with one of these before deleting it" above. If applied live, follow **"A
   modified migration needs a forward reconciliation, never a re-stamp"** — *not* the
   byte-identical recovery rule, which is written for absent files and is unsafe here. A file of
   that name existing on `main` is not evidence the branch's bytes are preserved.
2. **The 12 branches holding migrations absent from `main`** (2 of which are also in step 1, so
   steps 1 and 2 are 14 branches in total). Establish each migration's disposition —
   **applied live**, **pending**, or **abandoned** — from its PR and the ledger, never from the
   absence of a live apply. Applied live: land the byte-identical SQL before the branch goes —
   that rule is correct here because the file is absent from `main`. **For the 2 branches that
   are also in step 1, the file they *modify* takes the forward-reconciliation route instead;
   only their genuinely absent migrations take this one.**
   Pending: leave it alone. Abandoned: delete once the tip is preserved.
3. **The 3 mechanically-safe branches.** Confirm and delete.
4. **Everything else.** Each holds unique blobs that need a judgement on whether the work was
   superseded. Start with branches whose PR closed unmerged.
5. **Leave every open-PR branch alone** — 4 Dependabot branches are live dependency
   PRs. Note the Dependabot set is **not** uniform: 1 of them (`dependabot/npm_and_yarn/minor-and-patch-7fe11a6bea`) merged
   mid-review and is now mechanically safe, so do not treat "dependabot/" as a blanket
   leave-alone rule. Check each one's current PR state.

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
