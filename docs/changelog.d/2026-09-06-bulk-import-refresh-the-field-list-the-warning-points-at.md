## 2026-09-06 - Refresh the field list the bulk-import warning tells the operator to check

Fourth Codex round on the same PR. One High, and it undercut the whole change.

### The finding

Every version of this warning ends by telling the operator to look a row up in the field list
before re-importing it. That list lives on the page behind the modal and refreshes only when the
parent's `onSuccess` callback fires - which was gated on `success > 0`. Closing the modal
refreshes nothing either.

So in exactly the two situations the warning exists for:

- a field was created but its boundary step failed, or
- the row may have committed before its response was lost,

`success` stays zero, the refresh never runs, and the operator checks a **pre-import** list.
They do not find the field, conclude it was never created, and re-import it - producing the
duplicate the warning was written to prevent. The advice was not merely unhelpful; following it
correctly led to the bad outcome.

### The fix

The refresh now runs whenever anything reached the database or may have
(`success > 0 || created > 0 || unknownOutcome > 0`), and it is awaited rather than fired and
forgotten. `onSuccess` is typed `() => void | Promise<void>` to say so; the parent's
`fetchFields` is async and can throw.

A refresh that fails is reported rather than swallowed, for the same reason the original bug
mattered: a silent failure leaves the operator reading a stale list while being told to trust it.
The results list gains a line naming the failure and saying to reload the page before checking
any row.

### Verification

- `npm run typecheck` clean, `npm run lint` clean, `npm run build` succeeded.
- `npm run test` - 352 files, 5022 passed, 0 failed, 123 skipped.
- Fourteen tests in `src/components/fields/BulkFieldImport.duplicateWarning.test.tsx`. The
  refresh is now asserted in three existing tests - it must fire for a created-but-boundary-failed
  row, must fire for an unknown-outcome row where `created` is zero, and must NOT fire when the
  server genuinely rejected the row and nothing reached the database. A fourth, new test drives a
  rejecting refresh and asserts the operator is told to reload.
- **Twenty mutations, each verified to be a real edit and not a silent no-op, source restored
  byte-identical after every run - all twenty caught.** Three are new: the refresh gated back on
  `success`; the refresh dropped for unknown-outcome rows; and a failed refresh swallowed instead
  of reported.
- **Rendered and looked at** once more, for the failed-refresh case, captured from the real
  component's test DOM and served through the dev server.
- Not verified: no live-database round trip. The Supabase boundary is mocked throughout.

### Still open - unchanged

Re-importing still duplicates. This is operator guidance, not a fix. Durable protection needs a
stable per-row idempotency key and server-side reconciliation - ideally one atomic RPC creating
field, boundary and override in a single transaction - which is a migration awaiting Mason's
decision.
