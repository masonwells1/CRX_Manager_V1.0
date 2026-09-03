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
