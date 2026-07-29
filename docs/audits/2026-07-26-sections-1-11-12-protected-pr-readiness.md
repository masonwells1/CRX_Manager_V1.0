# Protected-PR Readiness Packet — Sections 1, 11, and 12

> **Recovered history — read with the note below.** Rescued on 2026-07-29 from the deleted branch
> `codex/protected-pr-readiness-20260726` (see
> `docs/audits/2026-07-29-branch-worktree-cleanup-restore-ledger.md`). It records readiness as of
> 2026-07-26 and is **not** a statement about current state.
>
> **On Section 1 at `53f6177e`, this packet and the queue ledger do not actually conflict.**
> `docs/audits/2026-07-25-governed-noninterference-queue-ledger.md` records "fresh independent Sol
> round 7: **CLEAN**" — a code review that came back clean *at that exact SHA*. This packet marks
> Section 1 **PARKED** because a rebase mints a new SHA, which invalidates SHA-bound review
> evidence, and because the candidate carries a pending migration that still needs the guarded
> live-apply gate. Clean review at a SHA is not the same as ready to publish; both statements hold.
>
> **Current status, verified 2026-07-29:** Section 1 is partly resolved. The `save_field`
> activity-actor spoofing MED is fixed live by
> `20260729222311_bind_save_field_actor`; only the anon-executable SECDEF number-generator MED
> remains open. Branch `codex/section1-security-hardening-20260725` still exists locally **and on
> `origin`**, and is additionally pinned by tag
> `preserve/2026-07-29/codex-section1-security-hardening-20260725`, but it must not be applied
> as-is. When rebasing it, drop the `save_field` half of
> `20260725234503_harden_section1_number_and_field_actor.sql` and the duplicate
> `save-field-actor-binding` predicate and predicate-test files. Reapplying its older function
> body would replace the live definition and make the hash-pinned standing invariant fail closed.

**Date:** 2026-07-26
**Mode:** Report-only; no candidate branch was rebased, changed, pushed, PR-opened, merged, deployed, or applied to the live database.
**Fresh base:** `origin/main` = `31d8e4d3ed25832d4d63206488fdf4a910222c91` (`Complete Supplier Pricing Phase 3 Stage B1 (#229)`).
**Packet worktree:** `codex/protected-pr-readiness-20260726`, freshly created at that base; initially clean and `origin/main...HEAD = 0 0`.

## Owner-facing verdict

None of these immutable accepted SHAs is publish-ready: each forks from the pre-B1 base `25363345adeabb5b2b08a3772a0de3f0edcb3952`, and a rebase would create a new SHA that invalidates SHA-bound review evidence. Do not push or open a PR from the listed SHA.

| Section | Accepted local SHA | Classification | Why |
| --- | --- | --- | --- |
| 1 — Security remediation | `53f6177eb6afe628c5de437ac27f4a9cd8fbb7cf` | **PARKED — REWORK REQUIRED** | The `save_field` half is superseded live by `20260729222311` and must be removed, together with the duplicate predicate files, before rebase or apply. Only the number-generator hardening remains. That narrowed future diff still requires fresh independent Sol review, fresh read-only live proof, and the guarded live-apply gate at its new SHA. |
| 11 — PDFs/compliance audit | `b754bf8db85c1ed163dd3d7af17f678ace32e30f` | **READY FOR REBASE/REPROOF** | Report-only diff, no collision with Supplier B1/B2. Rebase, check the report's historical facts still hold at the new base, and rerun the normal PR proof. |
| 12 — Edge-function audit | `a94ef7f1e8050667314d9c7bddc1ea36be3a46ba` | **READY FOR REBASE/REPROOF** | Report-only diff, no collision with Supplier B1/B2. Rebase, refresh any time-sensitive live metadata/report assertions, and rerun the normal PR proof. |

“Ready for rebase/reproof” is deliberately not “ready to publish.” A rebased branch must receive a new HEAD/base-bound review and current checks before it is pushed or merged.

## Accepted evidence that was read

| Section | Exact accepted artifact | What it establishes, and what it does not |
| --- | --- | --- |
| 1 | `docs/audits/gauntlet/2026-07-25-section-01-security-remediation-lane-ledger.md` at `53f6177` | Local security remediation/proof history. It expressly leaves a fresh exact-SHA Sol adversarial review, live read-only predicate proof, owner-approved guarded migration apply, rollback-only smoke, and live invariant sweep outstanding. |
| 11 | `docs/audits/gauntlet/2026-07-25-section-11-pdfs-compliance-documents-refresh.md` at `b754bf8` | Read-only audit of `25363345`; it records two test-coverage follow-ups and a blocked authenticated browser/download proof, not a confirmed defect. |
| 12 | `docs/audits/gauntlet/2026-07-25-section-12-edge-functions-refresh.md` at `a94ef7f` | Read-only audit of `25363345`; it records S12-1 (MEDIUM invoice-email retry deduplication) and an observed July 25 live metadata inventory, not bundle parity, secret proof, invocation, or deployment proof. |

## Fresh ancestry, cleanliness, and remote state

All three candidates have merge-base `25363345adeabb5b2b08a3772a0de3f0edcb3952`. The following ahead/behind values are `origin/main...candidate` after `git fetch origin --prune`:

| Candidate | Behind | Ahead | Candidate worktree | Corresponding remote branch |
| --- | ---: | ---: | --- | --- |
| Section 1 | 1 | 6 | Clean | Absent (`git ls-remote --heads origin codex/section1-security-hardening-20260725` returned no ref) |
| Section 11 | 1 | 2 | Clean | Absent (`git ls-remote --heads origin codex/section11-pdf-compliance-refresh-20260725` returned no ref) |
| Section 12 | 1 | 1 | Clean | Absent (`git ls-remote --heads origin codex/section12-edge-functions-refresh-20260725` returned no ref) |

Each candidate's `git merge-tree --write-tree origin/main <candidate>` exited `0`, with no conflict entries: Section 1 tree `f79fc780e8acf70f7c50e2431029ad507a242a37`; Section 11 `0fe379ce9d530d66e084beaa935921ba45ee599c`; Section 12 `49caaf52c61a0b24fa197b7dfe7a620a65d5d1af`. This is a conflict forecast only; it does not make the old SHAs merge-ready.

## Exact cumulative candidate file lists

These are the complete `git diff --name-status 25363345...<candidate>` lists, not a guessed PR scope.

### Section 1 — six commits ahead of the old base

```text
M docs/app-workflow-map.html
A docs/audits/gauntlet/2026-07-25-section-01-security-remediation-lane-ledger.md
M docs/manual/CURRENT_STATE.md
M docs/manual/KNOWN_ISSUES.md
M docs/reference/migration-history.md
M scripts/db-invariant-sweeps/README.md
M scripts/db-invariant-sweeps/allowlist.json
A scripts/db-invariant-sweeps/predicates/save-field-actor-binding.sql
A scripts/db-invariant-sweeps/save-field-actor-binding-predicate.test.mjs
M scripts/smoke/README.md
A scripts/smoke/prove-section1-number-and-field-actor.mjs
A scripts/smoke/smoke-section1-number-and-field-actor.sql
M scripts/smoke/smoke-specs.json
M scripts/test-areas.json
M src/lib/rpcContracts.test.ts
A supabase/migrations/20260725234503_harden_section1_number_and_field_actor.sql
```

### Section 11 — two commits ahead of the old base

```text
M docs/app-workflow-map.html
A docs/audits/gauntlet/2026-07-25-section-11-pdfs-compliance-documents-refresh.md
```

### Section 12 — one commit ahead of the old base

```text
M docs/app-workflow-map.html
A docs/audits/gauntlet/2026-07-25-section-12-edge-functions-refresh.md
```

## Supplier-lane collision check

The Supplier B1 worktree (`codex/supplier-pricing-phase3-stage-b1`, `a7ed9c5ee644cbeb2f4277c0cfe9b1e3dad35077`) was clean. Its retained branch is `1` behind and `17` ahead of current `origin/main`; B1 itself is already represented by the current squash-merge base commit above.

The active Supplier B2 worktree (`codex/supplier-pricing-phase3-stage-b2`) is excluded from any rebase, proof, or commit. Its dirty state is volatile, so this packet does not present a path list as durable/current truth. At the point-in-time observation `2026-07-26T08:19:48.916-05:00`, B2 HEAD and its merge-base with `origin/main` were both `31d8e4d3ed25832d4d63206488fdf4a910222c91`; `git status --porcelain=v1 --untracked-files=all` contained 30 paths. The sorted-path snapshot SHA-256 was `65a769502904675140b06499b6789e145192d02553597a07a62bc4fe3e09d09d`. Representative categories were Product identity resolver work, product-presentation adoption tests, bulk import callers/tests, receiving, purchase-order, job/blend-ticket, Inventory/Rebates pages, and the Supplier Phase 3 goal handoff.

At that exact snapshot, the dirty-path intersection was zero files for each Section 1, Section 11, and Section 12 cumulative list. The exact-file intersection with B1's base diff and with B2's committed base diff was also zero for every candidate. These are point-in-time non-collision observations only; any future rebase/proof must recompute them against the then-current B2 status.

## Section 1 source and Graphify check

Graphify was refreshed only to scope the risky Section 1 review. `graphify-out/GRAPH_REPORT.md` was built from `31d8e4d3`; query run: `graphify explain "save_field"`. It located the prior `save_field()` migration root, not the candidate change. Therefore, no behavioral conclusion below is graph-only.

Directly reading the Section 1 candidate migration confirms that `save_field(uuid,jsonb,jsonb,uuid,text)` binds `v_actor := auth.uid()` before the idempotency/write path, rejects a distinct non-null caller actor with `ACTOR_MISMATCH`, and writes `activity_feed.performed_by = v_actor`. The same migration sets `search_path TO public, pg_temp`, revokes `PUBLIC, anon` execution for the six number generators and `save_field`, and grants execution deliberately to `authenticated, service_role`. This confirms the local candidate's stated source shape only; because `20260725234503_harden_section1_number_and_field_actor.sql` is still pending, it is not live proof.

## Map churn handling

Every candidate changes exactly one line in `docs/app-workflow-map.html`: `Updated Jul 23, 2026` to `Updated Jul 25, 2026`, with the route/RPC/issue counts unchanged. This is stale hook-generated date-only churn, not a functional workflow-map change and not a Supplier collision.

When a future rebase is committed, the normal pre-commit hook will regenerate and stage the map. Keep that resulting one-line date change only if the hook produces it; record its exact before/after line in the PR description and do not present it as audit substance. Do not manually preserve the old Jul 25 date just to retain the candidate's historical SHA.

## Protected-PR runbook after a future authorized rebase

1. Start from a new clean worktree at freshly fetched `origin/main`; rebase one candidate only. Do not reuse Supplier B2's dirty worktree. Record the new HEAD SHA, the current base SHA, merge-base, exact changed-file list, `git diff --check`, and a fresh merge-tree result.
2. Re-read the candidate's accepted artifact against that new base. For Section 11, preserve its two coverage follow-ups and blocked browser proof unless newly disproved. For Section 12, refresh the time-sensitive live inventory before repeating it as a current assertion. For Section 1, do not carry forward the old exact-SHA proof as valid.
3. Run the normal local pipeline appropriate to the rebased content: at minimum `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run test:agent-workflows`, `npm run test:schema-baseline`, and `npm run check:docs`; Section 1 additionally reruns its changed-SQL audit, security/rpc-contract coverage, disposable PostgreSQL proof, and registered smoke/predicate evidence described in its ledger.
4. Section 1 remains parked. Before any rebase or apply, remove the now-superseded `save_field` replacement from `20260725234503_harden_section1_number_and_field_actor.sql`, remove its duplicate `save-field-actor-binding` predicate and predicate-test files, and narrow the smoke/proof artifacts to the still-open number generators. Applying the old combined migration would overwrite the live `20260729222311` function body and fail the standing hash-pinned invariant closed. The narrowed candidate then needs an independent fresh Sol adversarial review at the **new** SHA and the normal guarded live-apply path (owner approval or the documented armed hands-free exception), followed by rollback-only smoke and the full live invariant sweep.
5. Only after the branch is stable and clean, push the rebased branch and open a PR. Wait for all checks, including the required Vercel check; read CodeRabbit's review, fix every real issue, and briefly document any dismissed nit.
6. Section 1 is a risky diff because it changes `supabase/migrations/`. Immediately before merge, fetch so `origin/main` matches the PR's actual GitHub base and run `node scripts/write-codex-push-proof.mjs`. It must produce a clean, machine-generated proof bound to both the PR HEAD and base; it expires after 30 minutes, and a moved base or changed HEAD requires another run. For this risky PR, do not use `gh pr merge --auto`; after checks and proof are green, merge immediately without auto-merge. Sections 11 and 12 are documentation-only PRs, but still require the full green pipeline and CodeRabbit/Vercel process.

## Scope and non-actions

This packet changed only this report (plus the unavoidable hook-generated map date update, if present in the commit). It did not alter any candidate branch, Supplier branch, remote ref, PR, production deployment, Edge Function, live migration, or live data.
