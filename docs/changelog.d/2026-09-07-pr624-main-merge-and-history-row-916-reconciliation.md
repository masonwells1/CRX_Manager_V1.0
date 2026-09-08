## 2026-09-07 — PR #624 unblocked from `CONFLICTING`, and the row 916 record correction carried forward

PR #624 (`claude/inventory-idempotency-key-reset-888161`) had drifted to
`mergeStateStatus: DIRTY` / `mergeable: CONFLICTING` against `origin/main` at `c2eb87f40`.
That state matters beyond the merge button: a conflicted PR can silently skip its CI
workflow, so the green check wall standing on `dba2e5f18` proved nothing about the branch
as it would actually land.

### The conflict, and why it was resolved this way

Exactly one file conflicted: `docs/reference/migration-history.md`, at row 916
(`20260904185900_refuse_null_job_field_acres`).

- **`origin/main` side** carried the 2026-09-07 *record correction*: row 916 had asserted
  the migration was a parked draft, never merged and never applied, and closed with "No
  live apply or mutation was performed." All of that was false — the migration is live
  under the server-assigned ledger version `20260905185938` and merged by PR #606. The
  correction also documents *how* the row hid: a hand apply lands under a version Supabase
  assigns at apply time, not the file's own stamp, so searching the file for the file's
  timestamp finds only the stale row and searching for the live version finds nothing.
- **Branch side** carried the pre-correction (false) text for row 916, plus a genuinely new
  row 923 for `20260905230000_bind_create_inventory_hold_receipt_to_intent.sql`.

Resolved **by content, not by side**: `main`'s corrected row 916 was taken, and the
branch's new row 923 was kept. Taking either side wholesale would have lost real
information — "ours" would have silently reverted a factual correction about a live
migration back to a false claim, and "theirs" would have dropped the new candidate row.

Verified after the resolution: zero conflict markers remain; rows 916, 917 and 923 each
appear exactly once; row 916 now opens `**APPLIED LIVE`.

### Proof observed

- `npm run typecheck` — clean.
- Full `vitest run` on the merged tree — **358 files, 5073 passed, 123 skipped**. The
  stack traces in that output are `ErrorBoundary.test.tsx`'s deliberate throw, not failures.
- Branch-specific tests re-run after the merge: `createInventoryHoldIntentBinding`,
  `InventoryPage.uncertainRetry`, `InventoryPage.productIdentity`,
  `sqlRoleGateNullFailOpen` — 14 tests, all passing.

### State recorded, not fixed here

- **The migration `20260905230000` is still NOT applied to live.** Nothing in this change
  applies it; row 923 keeps its LOCAL CANDIDATE marker. Applying it remains a hard gate
  needing Mason's explicit in-conversation approval, and it must precede the
  `InventoryPage` fix reaching real users.
- **PR #624 still reads `CHANGES_REQUESTED`.** All five CodeRabbit review threads are
  resolved, but the blocking `CHANGES_REQUESTED` review sits at `e9d0d344e` and was never
  superseded by an `APPROVED`. The two later reviews on the PR are zero-length bodies —
  the empty review objects a thread reply mints at the replying head — and a `COMMENTED`
  review does not clear `CHANGES_REQUESTED`. The repo also reports
  "Review skipped: automatic reviews are disabled", so CodeRabbit will not re-review
  unaided. Clearing this needs a fresh CodeRabbit pass or Mason's dismissal.

### Not verified

The live apply and its post-apply checks, the regenerated `src/types/supabase.ts`, and the
browser flow against an applied wrapper. All of those come after the apply, which has not
happened. The merge commit was also not pushed as part of this entry.
