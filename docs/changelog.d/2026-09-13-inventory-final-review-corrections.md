## 2026-09-13 — Inventory final review corrections (candidate, not deployed)

CodeRabbit's authenticated review 5193096238 of PR #679 at
`b5357ce6450175cffe684ee1aa64a8fbb98e285c` returned CHANGES_REQUESTED with
six findings. The candidate remains preserved; these corrections form a new
immutable candidate rather than changing its reviewed head.

Vendor payment completion now compares the submitted bill ID with the committed
current route before changing cleanup state, showing outcome warnings, closing
forms, refreshing the bill or finishing its spinner. A stale fetch also returns
before setting loading. Navigation retires the old visible paying state while
keeping its durable payment record. Error reporting and old-request bookkeeping
still execute. Rendered tests pause the actual hook's database cleanup after it
captures the old request, navigate to another bill, and reject the pending
cleanup. Both a normal successful RPC and a saved-receipt response preserve the
new bill, report the old failure, and allow return to the original bill and retry
with the original exact amount and key. The preceding implementation stranded
the next bill on a spinner and emitted the old warning on its screen.

Quick Receive emits its automatic receipt PDF only for the initial submission,
so a locked replay does not download another copy with a new date. Receipt-based
damaged-goods notification remains enabled on replay. The rendered cleanup test
previously observed two downloads; the correction observes one across two
identical RPC calls. The restored damaged receipt test observes the notification
with committed receiving IDs and no replay PDF. No PDF layout or asset changed.

The vendor-bill Sentry module mock resets between cases, preventing an earlier
case from satisfying a later reporting assertion. The existing keyless cutover
prover now requires an explicit zero baseline, a failing old invocation, and the
actual insert-barrier retry token, rather than accepting any coincidental SQL
failure. Smoke descriptions name the hold-insert barrier, and an independent
rolled-back direct receipt insert exercises the receipt guard's unbound-context
branch. September 7 changelog entries retain historical findings and explicitly
point to the September 13 superseding proof.

Focused rendered recovery and migration contract validation passed 24 tests
across four suites. Broader recovery validation passed all 211 tests across 16
suites; typecheck, lint and build passed. The strengthened actual PostgreSQL
full-chain proof passed with 93 predecessors, the explicit zero baseline and
insert-barrier error, direct unbound receipt rejection, identical keyed-race
hold IDs, legacy receipt refusal, successful rerun and guard-drift refusal.
A fresh independent exact-head review is required before publication; remote
checks and an actual final CodeRabbit review remain required for merge.

Migration 20260908130000 remains NOT APPLIED. Its executable body, replay hashes,
authoritative money math and grants are unchanged in this correction. No live
database transaction or production mutation ran. The accepted production rollback
is Vercel's previous deployment. Expired 23-hour administrator recovery remains
separate follow-up work.
