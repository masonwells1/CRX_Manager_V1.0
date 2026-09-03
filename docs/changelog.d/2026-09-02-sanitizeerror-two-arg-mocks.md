## 2026-09-02 — Two `sanitizeError` mocks declared a parameter the real function never had

`2026-09-02-swallowed-server-errors-sweep.md` closed 52 screens that discarded the server's error
message, and recorded the rule that made them possible: **any error-path helper stubbed inside a
`vi.mock` factory deletes the path it exists to exercise.** That change fixed the instances in the
files it already touched and listed the rest as known gaps. This closes two of them.

`InventoryPage.productIdentity.test.tsx:57` and `PurchaseOrderDetail.productIdentity.test.tsx:85`
mocked `sanitizeError` with a **two-argument** signature:

```ts
sanitizeError: (_error: unknown, fallback = 'error') => fallback,       // InventoryPage
sanitizeError: (_error: unknown, fallback: string) => fallback,         // PurchaseOrderDetail
```

The real `sanitizeError` (`src/lib/errorSanitizer.ts:96`, re-exported from `src/lib/db.ts:4`) takes
exactly one parameter. Verified across all **294** `sanitizeError(` call sites in `src/`: none passes
a second argument. So the first mock returned the constant `'error'` for every input and the second
returned `undefined` for every input, because the parameter no caller supplies was the only thing
either one read. **Every assertion about displayed error text in those two files was vacuous by
construction — it could not fail regardless of what the app did.**

**Why the type system did not catch it.** `vi.mock` factories are not checked against the real
module's signature. A mock may declare an arity the real function never had and nothing complains —
neither `tsc` nor the suite. That is a general blind spot in this repo's test setup, not a one-off,
and it is why this survived review.

**The fix is not a better stub.** The obvious repair is the shape 18 other suites use,
`(error: unknown) => error instanceof Error ? error.message : String(error)`. That is the shape the
swallowed-server-errors sweep explicitly rejected: a non-throwing `supabase.rpc()` resolves its error
as a **plain object**, so `instanceof Error` is false and the stub yields `[object Object]` rather
than the server's message — re-implementing, inside the harness, the exact defect the sweep fixed,
and staying green against a regressed product. Both files now pull the **real** function via
`vi.importActual('../lib/errorSanitizer')`, matching the precedent set by `WriteOffModal.test.tsx`
and `FinanceChargePreviewModal.test.tsx`. Importing `errorSanitizer` directly rather than `db` keeps
the Supabase client out of the mock factory. The reasoning is recorded at the changed lines, so a
reviewer sees it in the diff rather than only here.

**Honest impact: this does not fix a currently-wrong test result.** Both suites pass before and
after — every mocked path in them resolves `{ error: null }`, so nothing exercises the error branch
today. What it removes is a mock that would have silently accepted wrong behaviour in any future
assertion written in those files. Preventive, not corrective.

Verified: both suites green against the real `sanitizeError` (2 files, 3 tests), `tsc --noEmit`
clean, ESLint clean on both files. Wiring proved by mutation rather than assumed — repointing the
`vi.importActual` specifier at a nonexistent module fails the suite with
`ERR_MODULE_NOT_FOUND ... imported from InventoryPage.productIdentity.test.tsx`, confirming the mock
resolves the real module at runtime instead of quietly falling back to a stub.

**Not fixed here, deliberately.** Five further mocks diverge from the real function and each needs a
different repair; they sit in files this diff does not otherwise touch:

- `OfficeCockpit.test.tsx:95` — `vi.fn((error: unknown) => error)` returns the error **object**, not a string.
- `MonthEndClose.test.tsx:99` — prefixes `Safe: `, which the real function never emits.
- `FieldAppSplitInvoiceEditor.test.tsx:45` and `Returns.race.test.tsx:40` — typed `(error: Error)`, so
  they misrepresent the null / string / plain-object inputs the real function exists to survive.

Also left alone: `InventoryPage.productIdentity.test.tsx:56` stubs `checkMutationResult` as a bare
`vi.fn()`. The real helper **re-throws `result.error`**, so neutered, a refused save reads as a
successful one — instance 3 of the rule above, live in a file this change touches but outside the
scope it was given.
