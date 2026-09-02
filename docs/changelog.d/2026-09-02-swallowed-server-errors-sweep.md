## 2026-09-02 — H5 follow-up: 52 screens stopped discarding the server's error message

`2026-09-02-h5-split-billing-invoice-button.md` fixed four catch blocks in `IntegrityCleanupPanel`
and established the cause: a non-throwing `supabase.rpc()` / `.update()` / `.delete()` resolves its
error as a **plain object**, not an `Error` subclass — postgrest-js only constructs `PostgrestError`
under `.throwOnError()`. So `err instanceof Error` is false after `if (error) throw error` or after
`checkMutationResult()` re-throws `result.error`, and
`toast('error', err instanceof Error ? err.message : '<literal>')` silently replaces the server's
explanation with the canned literal. The operator was told "Failed to apply write-off" when the
database had already said exactly why.

That ternary occurred 63 more times across 28 files. This change triages every one of them.
Frontend-only; no migration, no behaviour change beyond which string reaches the toast.

**52 were the same live defect** — fixed by routing through the existing `sanitizeError()`, which
already reads object-shaped PostgREST errors, passes user-facing `RAISE EXCEPTION` text through
unchanged, and redacts raw schema identifiers. No code-to-message lookup table was introduced.
21 files: `WriteOffModal`, `FinanceChargePreviewModal`, `PrepaymentManagerPanel`, `OrderDetail`
(consolidate + price), `ProductDetail` (6, including apply-pricing and all three cost-basis
previews), `QuoteBuilder` (6), `JobDetail` (6, including transfer-to-invoice),
`BlendTicketDetail` (7), `QuickReceivePanel` (2, including the definitive-refusal branch of a stock
receipt), `TeamBoard` (4), `Notifications` (2), `Rebates` (2), `CommentsSection` (2),
`CustomerContacts`, `LogInteractionModal`, `PrintOptionsDialog`, `TagsManager`,
`ApplicationServiceDetail`, `CustomerDetail`, `DeliveryRemainders`, `VehicleDetail`.

**11 were harmless and were deliberately left alone**, each for a verified reason rather than a
guess: `IntegrityReportPanel` (`runReconciliationChecks` only ever throws `new Error(...)`);
`CycleCounts` (uses `.throwOnError()`, which is the one path that *does* construct a real
`PostgrestError extends Error`); `SettingsPage` ×2 (raw `fetch`, so only real `TypeError` /
`SyntaxError` reach the catch); `ProductDetail` EPA lookup (every branch throws `new Error`);
`TodaysDeliveries`, `YesterdayRecap`, `CustomerDetail` save, `FieldSetup` save, `QuoteBuilder` save
(the RPC error is handled inline and returns before the catch); `WorkloadView` (the error is
discarded at destructuring, so nothing object-shaped can reach the catch — see the known issue
below).

**The tests were part of the defect, in two distinct ways.** Both are recorded inline at the
changed lines so a reviewer can tell a justified change from a bent one.

1. *Assertions that agreed with the bug.* `WriteOffModal`, `FinanceChargePreviewModal` and
   `QuoteBuilder` ("uses the cached post token when the first lifecycle response is lost") asserted
   `stringContaining('Failed')` or the literal itself. They passed **because** the screen was
   showing its canned fallback, so they could never have caught this. They now pin the server's
   message reaching the operator, and assert the literal does *not*.
2. *Mocks that re-implemented the bug.* `ProductDetail.pricing-flow` and both invoice modals
   mocked `lib/db` without exporting `sanitizeError` at all — the call threw inside the catch and
   the error path stopped existing (vitest reported "Number of calls: 0", not a changed message).
   The fix is **not** to stub `sanitizeError`: a stub shaped `e instanceof Error ? e.message : …`
   reproduces this exact defect inside the harness and stays green against a regressed product.
   All four files now pull the REAL `sanitizeError` via `vi.importActual('../lib/errorSanitizer')`,
   so the mock exercises real redaction and real pass-through.

A new `WriteOffModal` test pins the other half: raw constraint text
(`violates check constraint "invoices_balance_chk"`) must still be redacted, so the fix does not
trade a swallowed message for a schema leak.

Verified by driving three real screens in a browser, not by trusting the suite — the suite is what
encoded the bug. The harness aliases `@supabase/supabase-js` only, so the real `db.ts`,
`sanitizeError` and the real page components run unmodified. Observed: `WriteOffModal` surfaced the
server's refusal verbatim where the literal used to appear; an A/B run against the real `db.ts` in
the page showed `err instanceof Error === false`, `constructor.name === 'Object'`, old ternary →
"Failed to apply write-off", `sanitizeError` → the real sentence; `VehicleDetail`'s raw
`violates check constraint "vehicles_status_check"` was redacted to "The provided value is not
valid" rather than leaked; `FinanceChargePreviewModal` surfaced the real generate-path refusal. The
postgrest-js premise was re-confirmed from the installed source, not from memory.

Known gaps recorded rather than silently widened into this change: `WorkloadView` discards the RPC
error entirely (an RPC failure shows the operator nothing at all), and three sites hand a raw
Supabase `error.message` straight to a toast, bypassing `sanitizeError` — `CustomerDetail.tsx:789`,
`QuoteBuilder.tsx:1513`, `FieldSetup.tsx:570`. Those are the mirror-image defect (leaking rather
than swallowing) and are not among the 63 sites this change was scoped to.
