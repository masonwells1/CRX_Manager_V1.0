## 2026-09-15 - Transfer results need an invoice id; wrapper restamped to 20260914100800

**What changed.** Two CodeRabbit findings on PR #699 were fixed, and PR #638's parked transfer
wrapper now follows the PR #704 restamp.

- `assertTransferResultForJob` (`src/lib/db.ts`) accepted a result for the right job with no
  `invoice_id`. JobDetail then retired its request key and navigated to
  `/field-invoices/undefined`; the unbilled panel retired its key and dropped the job. The RPC
  always returns `invoice_id` (the anchor member for a split), so a missing, blank or non-string
  one now throws `TRANSFER_INVOICE_RESULT_INVALID` and both screens reconcile first.
- The reset-order test scanner read every `!` before `/` as the start of an expression, so
  `value! / 2 + supabase.rpc('save') / 3` hid the RPC. A `!` after an identifier, `)` or `]` is
  now the TypeScript non-null assertion; after an operator, keyword or control head it stays NOT.
- After PR #704 merged, `20260908130800_bind_transfer_invoice_intent.sql` was renamed to
  `20260914100800_bind_transfer_invoice_intent.sql`. Its header prerequisite is now
  `20260914100500` (formerly `20260905200400`). The static and Docker transfer proofs, the plan-order
  proof, `.gitattributes`, and the manual/reference docs name the new file. The plan-order proof
  lists the wrapper as the seventh parked commission file. PR #638's earlier comment edits to the
  label repair and recipient guard were dropped in favour of PR #704's text.

The `20260905200400` cutover marker value, every md5 pin, and every SQL statement are unchanged.

**Proof observed.** Six new tests failed before the fix, and 86/86 passed after it, covering the
scanner, `db`, `UnbilledApplicationsPanel` and `JobDetailRoute` tests. Typecheck passed.
`prove-transfer-invoice-intent-binding-static.mjs` printed `TRANSFER_INVOICE_INTENT_STATIC_PROOF_PASS`.
The Docker plan-order and behaviour proof results are recorded in the delivery PR.

**Not verified.** Nothing was applied live, and no live database was read.
