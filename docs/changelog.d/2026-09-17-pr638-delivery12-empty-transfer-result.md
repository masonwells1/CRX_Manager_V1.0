## 2026-09-17 - An empty transfer result reconciles instead of asserting

**What changed.** Four review findings on PR #708 were fixed and shipped as delivery PR #709 for
PR #638. The feature itself is unchanged; these are corrections to the guard, a smoke fixture, a
test-only scanner and one documentation sentence.

- `src/lib/db.ts` gained `assertTransferDataPresent()`. Both job-invoice screens
  (`src/pages/JobDetail.tsx`, `src/components/field-invoices/UnbilledApplicationsPanel.tsx`) now
  call it before `assertRpcResult()`, so a `null` or `undefined` `transfer_job_to_invoice` payload
  raises `TRANSFER_INVOICE_RESULT_INVALID` and takes the same reconcile-before-retry route as a
  result naming another job. Previously an empty payload reached the generic assert and produced a
  failure the screens could not route.
- `scripts/smoke/smoke-transfer_job_invoice_machine_fee.sql` now requires
  `product_form = 'liquid'` in both fixture product selections. Every scenario bills both products
  as liquid GL lines, and Scenario A converts a PT rate through `convert_to_gl_lb`, so a dry
  product would not match the fixtures. The suggested `unit_size` constraint was declined: no
  assertion in the file reads `products.unit_size`, so it would shrink the fixture pool without
  changing an asserted value.
- `src/__tests__/idempotency-reset-order.test.ts`: `findResetBeforeAssert()` scans masked lines but
  discovered aliases from the unmasked source, so an alias named only in a comment or a string
  counted as real. It now reads the masked text. Two stale comments were corrected to match.
- `docs/changelog.d/2026-09-10-transfer-cutover-drains-readers-and-expired-receipts.md` line 29
  claimed no unbound transfer receipt survives cutover. It is narrowed to committed state, because
  a pre-cutover `REPEATABLE READ` or `SERIALIZABLE` snapshot can still read a deleted row. The
  residual was already documented below that line.

**Proof observed.** Each fix was written test-first; the six new cases failed on `742f70f5c` and
pass on `31e267974`. On the fixed tree: 92 tests passed across `db`, the reset-order scanner,
`JobDetailRoute` and `UnbilledApplicationsPanel`; `npm run typecheck` reported 0 errors; `eslint`
was clean on all seven changed files; `npm run test:correction-guards` passed every guard; and
`node scripts/check-doc-drift.mjs` reported that reference documentation matches repository
reality. The pre-push gate (Phase 3C containment, type check, build) passed.

The new `invoice_id` requirement was checked against the authoritative function source rather than
against the new tests: both success paths of `transfer_job_to_invoice` always return `invoice_id` -
the single-invoice path and the U7 multi-owner split path (the anchor member) - in the live
definition `20260713060000_harden_field_split_sum100.sql` and in the parked `20260914100500`.
There is no `success:false` return; failures raise and are thrown before the guard runs. This
frontend `invoice_id` guard therefore cannot refuse a transfer the database completed. That claim is
about the screen guard only: the database can still refuse a transfer by raising, including the
parked `20260914100800` receipt trigger's `TRANSFER_INVOICE_INTENT_CUTOVER_RETRY` for a pre-cutover
call that did not go through the intent-bound wrapper. Such a refusal is an error the screens show;
it never reaches this guard.

**Not verified.** The machine-fee smoke SQL runs only against a real database, and no live database
was read or written in this work, so that fixture change is verified against
`.claude/schema-registry.json` (`products.product_form` is a two-value CHECK column, `liquid` or
`dry`, constraint `products_product_form_check`) rather than by an executed run. Nothing was applied
live; `20260914100800_bind_transfer_invoice_intent.sql` remains parked and unapplied.
