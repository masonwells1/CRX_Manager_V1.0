## 2026-09-03 — PR #535: applied the last two gauntlet migrations and closed the open review findings

## Applied live (Mason's explicit in-chat approval, one per migration)

The gauntlet Section 9 chain is now complete in production. Ledger 990 → 992.

| Migration | Ledger version |
|---|---|
| `20260831233000_bind_section9_replays_to_intent` | `20260903124710` |
| `20260831235900_serialize_gauntlet_write_boundaries` | `20260903124741` |

Both passed the full migration-apply gate (ordering, autopilot state, destructive-content,
reviewer proof, Codex gate) and both Codex charter reviews returned `CODEX_PROOF_VERDICT: CLEAN`
with 0 BLOCKER/HIGH/MED. Verified post-apply against the live catalog rather than the exit code:
`update_vendor_bill` is a single 9-argument overload accepting `p_confirm_po_overage` and
`p_po_overage_reason`; `cycle_counts.item_revision` exists; `trg_bump_cycle_count_item_revision`
is present and carries the `CYCLE_COUNT_ITEM_REPARENT_FORBIDDEN` guard.

This clears the merge blocker recorded on the PR: the branch's `VendorBillDetail.tsx` call now
resolves against a real live signature instead of 404-ing on every bill edit.

### Adjudicated: the migration-5 three-layer concern

Migration 5 places a third wrapper over an existing wrapper→impl pair, so
`check_idempotency_intent` runs twice. **Redundant but benign**, confirmed from the live catalog:
both triggers on `idempotency_keys` are `tgtype=7` — BEFORE INSERT ROW only — so the outer
wrapper's closing `UPDATE ... SET request_fingerprint` is not re-stamped back to the inner
layer's value, and the stored fingerprint ends as the outer 9-field one, which is what a replay
compares against. The inner check can only ever see NULL, because a pre-existing receipt makes the
outer layer return or raise first, and the advisory lock on the key is held for the transaction.

### Accepted residual: the exact-SHA Codex review's HIGH on the apply window

The `gpt-5.6-sol` push-proof review of `1e1c645e9` returned `CODEX_PROOF_VERDICT: BLOCKERS` with one
HIGH, and it is correct: `SHARE ROW EXCLUSIVE` does not conflict with `ACCESS SHARE`, so the old
`reverse_receiving_record` body's opening plain `SELECT` on `idempotency_keys` passes through the
migration's `LOCK TABLE`. A legacy reversal already in flight could clear the preflight, run the old
body unprotected, delete the receiving record and photos, and block only at its final receipt
`INSERT`.

Mason accepted this on 2026-09-03 as a closed residual rather than a remediation, because it
describes the rollout procedure (not the code), an applied migration must never be edited, and the
window was demonstrably never entered — zero application activity at both applies, verified via
`idempotency_keys` (0 rows that day, 52 total, newest 2026-08-18, table not purged),
`financial_audit_log` (226 rows, 0 since 2026-09-02 12:00Z) and `receiving_records` (130 rows,
newest 2026-06-10 20:58:54Z, nothing after it — a `>= '2026-06-10'` query returns 1, not 0, because
the newest row falls on that date). The durable output is a prevention rule in `docs/manual/KNOWN_ISSUES.md` and the
decision record in `docs/manual/DECISION_LOG.md`: a migration that replaces a function whose OLD
body writes to a table the migration locks is not serialized against that old body, and needs a
quiesced rollout plus a concurrency proof covering a legacy call that has already passed its
receipt lookup.

## Frontend fixes (review findings that were genuinely still open)

- `src/pages/CycleCounts.tsx` — failed item writes are now keyed by their owning cycle count. A
  failure left behind in count A previously blocked completing **every other count** until the
  operator reopened A or reloaded.
- `src/pages/CycleCounts.tsx` — the `complete_cycle_count` idempotency key is now scoped to
  `complete:<countId>:<expectedRevision>`. An unscoped key survived closing count A, so completing
  count B replayed A's key, the server raised a payload conflict, and every retry for B failed
  until reload.
- `src/pages/NewVendorBill.tsx` — the PO-overage branch now detects the case where the pending
  intent could not be cleared (another tab holds a live claim) and says so, instead of silently
  looping: `beginIntent()` returns the stale intent verbatim whenever a pending record exists, so
  the confirmation fields never reached the server.
- `scripts/db-invariant-sweeps/predicates/section9-po-ap-controls.sql` — the two
  `has_table_privilege` arms now test `pg_roles` first. A missing `anon`/`authenticated` role
  raised `role does not exist`, which aborted the whole statement and made every other arm of the
  `UNION ALL` return nothing — a false CLEAN. Same shape migration `20260831235900` already uses.

## Documentation corrected

All six migration files carried `-- STATUS: PARKED - NOT APPLIED` while live; they now carry an
applied stamp with their ledger version. `docs/reference/migration-history.md` rows 903–908,
`docs/reference/rpc-functions.md` (both vendor-bill entries), `docs/manual/CURRENT_STATE.md` and
the `docs/manual/KNOWN_ISSUES.md` header block all still described the chain as parked/unapplied
and are now accurate.

Added a `KNOWN_ISSUES.md` entry for the four migrations that were applied live on 2026-09-03 with
their source only on this unmerged branch. Live is healthy — all four added optional capability
that `main` does not reference — and it closes when this PR merges. **This is the fourth occurrence
of that class**; the 2026-08-13 entry already records that the prevention gap is open because
nothing reconciles the live ledger against tracked migration files automatically.

## Fixed: the PO-overage guard could not fire

Codex and CodeRabbit independently flagged the same defect in this PR's own vendor-bill change, from
opposite directions. `NewVendorBill.tsx`'s PO-overage branch runs entirely inside one save handler:
`beginIntent()`, the RPC rejection, `classifyFailure()`, then the decision. It branched on
`createBillIntent.unresolvedIntent`, which is `useState` — inside that handler it still holds its
render-time value, `null`. So the "this bill is open in another tab" message was **dead code in
exactly the case it was written for**: the operator instead got the ordinary reason prompt, confirmed
it, and the retry reused the surviving intent with `p_confirm_po_overage` stripped, looping with no
explanation.

`classifyFailure()`'s return value cannot substitute. `deleteCoordinatedRecord()` returning
`{deleted:false, current:<pending>}` falls through to `return 'definitive'` — identical to the healthy
delete — so the disposition genuinely cannot discriminate. The ref is the only correct read.

- `useUncertainMutationIntent.ts` — added `getUnresolvedIntent()`, reading `intentRef.current`.
  `applyRecord()` writes that ref synchronously, so it is correct in the same tick that
  `classifyFailure()` resolves. The state field remains for rendering.
- `NewVendorBill.tsx` — the branch reads the accessor, commented with the trap *and* why the
  disposition cannot be used, so the next reader does not "simplify" it back.

Both mutation-tested. Pointing the accessor at the state field turns the new
`useUncertainMutationIntent` test red with `expected null to deeply equal { amount: 100 }`; reverting
the call site turns the new `gauntletFrontendSafetyGuards` source contract red. The hook test models
the component closure — it captures `result.current` before `beginIntent()` and reads both forms
inside one `act()` — because asserting after `act()` flushes the state update and hides the bug.

**Review-thread status is not evidence about code.** These threads read 39 unresolved / 18 not
outdated; triaging every substantive one against current source resolved that to six already fixed,
one real, and two pre-existing judgment calls on the commission report. Comment anchors surviving
means GitHub does not mark a genuinely-fixed thread outdated, so "unresolved" over-reports and
"outdated" under-reports at the same time.
