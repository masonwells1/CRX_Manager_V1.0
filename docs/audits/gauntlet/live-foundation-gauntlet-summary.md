# CRX Live Foundation Gauntlet Summary

Last updated: 2026-07-05

This summary tracks the ranked fix queue from the recurring read-only gauntlet. Current production risk is dominated by checkout/schema drift: the branch used for the 2026-07-05 Section 5 run is behind both `origin/main` and the live Supabase migration catalog.

## Ranked Fix Queue

| Rank | Severity | Area | Item | Current evidence | Recommended next action |
|---:|---|---|---|---|---|
| 1 | HIGH | Section 5 - Database drift | Refresh this worktree before schema-aware work | Section 5 found branch `codex/BrainstormFable` is 95 commits behind local `origin/main`, missing 38 migrations from `origin/main`, and live Supabase has migration versions through `20260704161532` while this checkout stops at `20260702120000`. | Move the automation/run to current `main` or refresh this branch, then rerun Section 5. |
| 2 | MED | Section 5 - Schema registry | Regenerate `.claude/schema-registry.json` from live | Current registry high-water is `20260701205341`, while six newer migration files exist in this checkout and local `origin/main` has high-water `20260704161532`. | Run the normal schema-registry regeneration after refreshing to current `main`; do not hand-edit only the high-water field. |
| 3 | HIGH | Section 1/2 carryover | `batch_apply_prepayments` direct RPC role gate | Automation memory for Sections 1-2 recorded the prepay workspace RPC as authenticated-executable SECURITY DEFINER without its own admin-only gate. Current stale checkout did not re-audit this in Section 5. | Revalidate from current `main` before fixing or closing. |
| 4 | HIGH | Section 3 carryover | Receiving concurrency gap | Automation memory for Section 3 recorded `receive_po_items` missing a parent/row lock, but current migration history indicates follow-up fixes may have landed. | Revalidate from current `main`; likely close if live `20260701201000`/`20260701211000` are present and bodies match. |
| 5 | MED | Section 6 carryover | Idempotency gaps need refreshed review | Consolidated 2026-06-17 run noted legacy idempotency gaps; newer migrations may have changed the state. | Next automation run should refresh Section 6 from current `main`. |

## Current Queue Position

Next section queued: Section 6 - Idempotency and double-submit safety for mutating RPCs and frontend callers.

## Visibility Notes

- The 2026-07-05 run proved live SECURITY DEFINER search-path coverage returned `0` missing search paths.
- Additional live catalog queries hit the linked Supabase CLI auth circuit breaker and requested `SUPABASE_DB_PASSWORD`, so overload/CHECK/generated-column parity was not overclaimed.
