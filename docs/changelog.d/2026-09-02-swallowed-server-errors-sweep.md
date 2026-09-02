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

Known gaps recorded rather than silently widened into this change: `WorkloadView.tsx:47` discards the
RPC error entirely (an RPC failure shows the operator nothing at all), and three sites hand a raw
Supabase `error.message` straight to a toast, bypassing `sanitizeError` — `CustomerDetail.tsx:793`,
`QuoteBuilder.tsx:1513`, `FieldSetup.tsx:570`. Those are the mirror-image defect (leaking rather
than swallowing) and are not among the 63 sites this change was scoped to.

## Review round 2 — a disclosure regression this change introduced, and a live one it uncovered

The first review round found that routing 52 sites through `sanitizeError()` had made things worse in
one specific way, and that the underlying flaw was older and wider than this PR.

`sanitizeError`'s permission rule was `/permission denied for (table|relation|schema|sequence) "[^"]+"/i`
— it required **quoted** identifiers. PostgreSQL emits them **unquoted**: `permission denied for table
orders`. So the rule never matched a real permission error, the quoted-only catch-all did not match
either, and the message fell through to "pass through safe messages" and was shown verbatim.

Two distinct consequences, and only the first belongs to this PR:

- **Introduced here:** the 52 converted sites previously showed a canned literal for that error, which
  accidentally hid the identifier. Routing them through a sanitizer that does not redact it turned a
  harmless generic message into a table-name disclosure.
- **Pre-existing and live:** `main` already had **235 `sanitizeError(` call sites**, none of which ever
  had the canned-literal accident protecting them. Every one has been passing
  `permission denied for table <name>` straight to the operator since the function was written. That
  half is not a regression from this change — it is a live defect this change surfaced.

Fixing the pattern in `errorSanitizer.ts` closes both at once, which is why the fix lives there rather
than at the call sites.

**How a wrong pattern survived review:** the sanitizer was written against its own test's fiction rather
than against the database's real output. `errorSanitizer.test.ts` asserted the quoted form
(`permission denied for table "invoices"`), while three other fixtures in the same repo already used the
real unquoted form — `criticalAction.test.ts:107`, `applicatorSheetPrintData.test.ts:35`,
`previousApplications.test.ts:153`. The rest of the repo knew what Postgres emits; this module's own test
did not. That is the same failure as the mock stubs above: a test that agrees with the code instead of
with reality.

The replacement matches the **region** — `permission denied for <anything>`, quoted or not — rather than
enumerating object types, because Postgres has many (view, materialized view, foreign table, function,
procedure, large object, …) and an enumeration silently reopens the hole for whichever one is missing. A
second region rule redacts PostgREST schema-cache misses (`Could not find … in the schema cache`), which
name the function, table, column or relationship they could not resolve. A hand-written `RAISE EXCEPTION`
that merely uses the words "permission denied" without naming an object still reaches the operator, since
those are written to be read.

Also fixed: `JobDetail`'s `SHARE_NOT_100` branch used
`err instanceof Error && err.message.includes('SHARE_NOT_100')`, which was **dead on arrival** — `save_job`
raises the bare token as a plain PostgREST object, so the guard never matched a real refusal and the
friendly "shares must total 100%" message never fired. Before this PR it fell through to the literal
"Failed to save job"; after the sweep it fell through to the raw token. `SHARE_NOT_100` is now registered
in `RpcErrorCodes` and matched with the object-aware `hasRpcCode()`.

### The rule this round produced: never stub an error-path helper in a `vi.mock` factory

Writing the plain-object regression tests surfaced a third way the suite had been disarmed, worse than
the first two. State it as one rule, because the specific function is incidental:

> **Any error-path helper stubbed inside a `vi.mock` factory deletes the path it exists to exercise.**
> The grep-able shape is a no-op `vi.fn()` — or a trivial lambda — standing in for a function that has
> real behaviour. Use `vi.importActual` and run the real one.

Three instances, all found here, all reaching the same place by different routes:

1. **Missing entirely** — `ProductDetail.pricing-flow`, `WriteOffModal` and `FinanceChargePreviewModal`
   mocked `lib/db` without exporting `sanitizeError`. It was `undefined`, the call threw *inside* the
   catch, and the handler died silently. Vitest reported `Number of calls: 0` — the test did not fail
   because the message changed, it failed because the error path stopped existing.
2. **Behaviourally wrong** — seven suites stub `sanitizeError` as
   `e instanceof Error ? e.message : 'Request failed'`, which re-implements the exact defect this
   change fixes; a screen could regress all the way back to swallowing and they would stay green.
   `InventoryPage.productIdentity.test.ts:57` and `PurchaseOrderDetail.productIdentity.test.ts:85` are
   worse still — they return the fallback unconditionally, so they assert the canned literal by
   construction and **cannot fail**.
3. **No-op** — `ProductDetail.pricing-flow` stubbed `checkMutationResult` as a bare `vi.fn()`. The real
   helper **re-throws `result.error`**. Neutered, a save the database *refused* completed silently, the
   catch never ran, and any test aimed at that catch asserted against a phantom success. That suite
   could not distinguish "the save worked" from "the save was rejected and we ignored it."

Instances 1 and 3 are fixed here (real `sanitizeError` and a faithful `checkMutationResult` in every
suite this change touches). The seven in instance 2 are listed in the known-gaps section above and are
left for a separate change, since they sit in files this diff does not otherwise touch.

Guarded by tests that pin the real Postgres forms, including a mutation check: reverting the pattern to
the quoted-only version makes the new test fail with `expected 'permission denied for table orders' to be
'You do not have permission…'` — the leak, reproduced. Re-verified on the real `VehicleDetail` screen:
`permission denied for table vehicles` now renders "You do not have permission to perform this action"
with no table name present, the schema-cache form renders the generic internal-error line with no function
name, and `WriteOffModal` still shows the server's genuine refusal verbatim, so the redaction did not
start swallowing legitimate messages.
