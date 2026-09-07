## 2026-09-04 - PR #535: fix two real CodeRabbit findings, disprove three

CodeRabbit reviewed frozen candidate `be4863f9c` (requested 06:24:13Z, acknowledged 06:24:18Z,
review returned 06:34:55Z) and posted 5 actionable comments plus 2 outside-diff comments. Each was
verified against current source. Two were real and are fixed; three were misreadings and are
recorded here so they are not re-raised; one is immutable-migration backlog.

### Fixed

- **`src/pages/CycleCounts.tsx` — the "complete anyway?" confirmation carried no record identity
  (Major).** The confirm path calls `executeComplete()` with no snapshot, and that branch
  deliberately skips the uncounted-items re-check because the operator already answered. But the
  dialog's state is independent of the detail modal's, so if `activeCount` changed between question
  and answer, a *different* count could be completed — skipping its own uncounted check — on the
  strength of another count's yes. The confirmation now stores the `cycleCountId` it was asked
  about and aborts with an explanation when it no longer matches.
- **`src/pages/VendorBillDetail.tsx` — `editOverageMessage` survived a route change (Minor).** The
  component stays MOUNTED across `/accounts-payable/bills/:id` changes. The `[id]` reset effect
  cleared every other edit field but not this one, and `ReasonModal` opens solely on it being
  non-null — so navigating with the overage prompt open carried the previous bill's prompt onto the
  next bill, with the surrounding edit state already cleared out from under it. Added to the reset.

### Disproved — do not re-raise

- **"`ReceivingLogPanel` retires the scoped keys inside the loop" (Major).** It does not. The only
  in-loop `resetKeyFor` is in the idempotency-binding-rejection branch, which is correct (a bound
  key must not be reused for different intent). Successful scopes accumulate in `completedScopes`
  and are retired *after* the loop completes — which is exactly the change the finding asked for.
  The described retry failure (`Receiving record not found` on an already-reversed row) depends on
  the key having been retired, so it cannot occur; the retained key replays the stored receipt.
- **"`BulkFieldImport` allows dismissal while an upload is active" (Minor).** All three dismissal
  paths are already blocked: `handleClose` returns early on `uploadInFlightRef.current` *before*
  clearing any state, the modal has `closeDisabled={uploading}`, and the Cancel button is
  `disabled={uploading}`.
- **"`docs/reference/rpc-functions.md` does not document the new vendor-bill overage parameters"
  (Minor).** Both `create_vendor_bill` and `update_vendor_bill` already list
  `p_confirm_po_overage` and `p_po_overage_reason`, with their migrations and applied-live ledger
  versions.

### Not actionable here

- **`20260831235900` reparenting trigger (P2).** On an UPDATE that changes `cycle_count_id`,
  `COALESCE` selects the new parent, so the old count's revision is neither locked nor advanced.
  Plausible and worth pursuing, but that migration was **applied live on 2026-09-03 and is
  immutable** — closing it needs a forward migration, not an edit here. Parked with the other
  forward-migration backlog.
- **`docs/manual/KNOWN_ISSUES.md` commission rollout contradiction (Minor).** The comment's line
  anchors (2631/2650) no longer point at the described content after this branch merged `main`, and
  the claim is pre-existing drift unrelated to #535. Not guess-edited; left for a targeted pass.

### Verification

`npm run typecheck`, `npm run lint`, `npm run test` (354 files, 4992 passed, 0 failed) and
`npm run build` all pass. The two fixes are React state-lifecycle changes and are **not**
browser-verified — same standing limitation as the rest of this branch's UI work (no `.env` in this
worktree; copying one in was denied by permission and not worked around).
