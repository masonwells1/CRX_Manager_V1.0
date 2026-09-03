## 2026-09-03 — PR #535: closed the CodeRabbit findings on the frozen candidate

The exact-head review of `8cddf226e` returned `CHANGES_REQUESTED` with five findings. Four were
real, including one in this PR's own previous fix.

## The cross-tab branch opened the wrong dialog

Detecting the surviving claim was only half the fix. `setOverageMessage()` is what opens
`ReasonModal`, and its confirm path calls `handleSave(true, reason)` — but the call site is
`unresolvedIntent ? beginIntent(unresolvedIntent) : beginIntent({ ...fresh })`, and on the retry
render `unresolvedIntent` IS set, so the confirmed args are computed and then discarded before the
hook ever sees them. The operator would type a reason, confirm, and land back in the same branch.

The blocker now renders as a plain amber banner (`overageBlockedMessage`) with no confirmation
control; `ReasonModal` stays bound to `overageMessage` alone. The banner clears when a real attempt
starts, so it survives a validation bounce.

This is the same family as the stale-`useState` defect this PR already fixed — the guard moved, the
response did not. **Partial compliance with a review finding is the same bug.**

## The absent-role guard did not actually guard

`EXISTS (...) AND has_table_privilege('name', …)` is not sufficient. SQL does not promise
left-to-right `AND` evaluation, so the planner may still evaluate the privilege call and raise
`role "<name>" does not exist`, aborting the statement and producing exactly the false CLEAN the
guard was added to prevent.

All eight arms across `vendors` and `vendor_bills` now pass the role's OID from a scalar subquery.
`has_table_privilege` is strict, so an absent role yields NULL — never TRUE, never an error, which
is the correct outcome: a role that does not exist holds nothing.

Proven read-only against live rather than asserted: an absent role returns `null` with no error;
`authenticated`/`anon` return `false`; the rewritten `vendors` arm parses and returns zero rows.

## Applied migrations must not be edited

All six migration files carried a `-- STATUS: APPLIED LIVE …` line added *after* they were applied
live — exactly what the Hard Rule forbids and what CodeRabbit's `mode: error` pre-merge check
encodes. The review flagged two; the pattern was swept and all six removed.

Nothing was lost: the ledger versions are already recorded in `docs/reference/migration-history.md`
rows 904–909. No guard requires the stamp — verified before removing it, and
`check:migration-hard-rules` reports only a pre-existing unrelated failure in
`20260221200000_rate_limiting.sql`.

## Coverage was coverage-shaped

The existing tests were a hook test on ref timing plus page tests that grep source text; neither
would catch the branch defect above. Added `drops the overage confirmation from a retry while a
pending record survives`, which mirrors the page's real retry call and asserts the returned payload
still carries `p_confirm_po_overage: false` with no reason.

Its first two drafts failed, and both failures were informative rather than noise:

- Breaking IndexedDB to force the record to survive also breaks `beginIntent()`, which throws
  `DURABLE_MUTATION_INTENT_STORAGE_UNAVAILABLE`. The cause of survival is irrelevant; only the
  consequence matters, so the test no longer sabotages storage.
- Passing *different* args on the retry raises `DURABLE_MUTATION_INTENT_CONFLICT` rather than
  silently freezing. That is why the page's actual call site — re-sending the stale intent — is the
  loop, and the test now mirrors it exactly.

The fifth finding asked for a focused page-level test, and `src/pages/NewVendorBill.overage.test.tsx`
now provides one. It renders the real page, fills the form, and drives a real `22023` rejection:

- The healthy path still prompts, and confirming it puts `p_confirm_po_overage: true` and the typed
  reason on the wire — asserted from `mockRpc`'s second call, which is the payload the stale
  `useState` read used to strip.
- The blocked path shows the banner, opens no reason prompt, exposes no reason textarea, and leaves
  a plain `Retry Exact Bill` button. The durable store is killed inside the RPC mock, so
  `beginIntent()` has already succeeded and only the release fails — which is the shape a live peer
  claim produces.

Mutation-tested with the right specificity: pointing the branch back at `setOverageMessage(` reddens
the blocked-path test **and leaves the healthy-path test green**, so the guard binds to the branch
under test rather than to the page loading at all.

## Verification

`npm run typecheck`, `npm run lint`, `npm run test` (4987 passed / 353 files), `npm run build` and
`npm run check:docs` all green. The new source contract was mutation-tested: pointing the branch
back at `setOverageMessage(` turns it red, and reverting restores green.

## Process finding: the CodeRabbit gate's request is ignored

The gate's `@coderabbitai review` comment is authored by `github-actions[bot]`, and CodeRabbit does
not honour commands from bot accounts. Two bot-authored commands on 2026-09-03 (#535 at 16:09:16Z,
#449 at 16:48:40Z) went unacknowledged for 62 and 24 minutes; two human-authored ones on the same
PR were acknowledged in 11 and 6 seconds. The permission fix that first let the gate post landed the
same day, so every "review requested" it has recorded is a false positive — it reports success,
records the marker, drops the ready label, and CodeRabbit never hears it. Filed for repair; the
working retry today is a human-authored comment, which also leaves gate state intact because the
cleanup only removes Actions-authored comments matching the canonical body.
