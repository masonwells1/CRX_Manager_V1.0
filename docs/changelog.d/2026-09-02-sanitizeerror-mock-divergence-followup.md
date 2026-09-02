## 2026-09-02 — Four more `sanitizeError` stubs replaced with the real function, and a test that asserted a fiction

Third change in the chain that began with `2026-09-02-swallowed-server-errors-sweep.md` and its rule:
**any error-path helper stubbed inside a `vi.mock` factory deletes the path it exists to exercise.**
The sweep fixed the files it already touched; `2026-09-02-sanitizeerror-two-arg-mocks.md` closed the
two mocks that declared a parameter the real function never had. This closes the four remaining
divergent stubs listed there as known gaps.

| File | Old stub | How it diverged |
|---|---|---|
| `OfficeCockpit.test.tsx:95` | `vi.fn((error: unknown) => error)` | returned the error **object**, never a string |
| `MonthEndClose.test.tsx:99` | ``vi.fn((e) => `Safe: ${...}`)`` | invented a `Safe: ` prefix the real function never emits |
| `FieldAppSplitInvoiceEditor.test.tsx:45` | `vi.fn((error: Error) => error.message)` | typed `Error`, misrepresenting the null / string / plain-object inputs the real function exists to survive |
| `Returns.race.test.tsx:40` | `vi.fn((error: Error) => error.message)` | same |

All four now pull the real function via `vi.importActual('../lib/errorSanitizer')`, matching
`WriteOffModal`, `FinanceChargePreviewModal`, and the two files fixed earlier today. None of the four
asserted on the `sanitizeError` spy itself, so no test lost a capability in the swap.

**Unlike the two-arg change, this one was not purely preventive — it caught a live wrong assertion.**

`MonthEndClose.test.tsx` has a test named *"sanitizes a batch year-end RPC guard error before showing
it."* It injected the real PostgREST shape — a **plain object** `{ message: 'CUSTOMER_SCOPE_DENIED' }`
— and asserted:

```ts
expect(mockToast).toHaveBeenCalledWith('error', 'Safe: CUSTOMER_SCOPE_DENIED');
```

Both halves of that string were wrong. The `Safe: ` prefix exists only in the stub. And the raw token
never reaches the operator at all: `errorSanitizer.ts:8` maps `/^CUSTOMER_SCOPE_DENIED\b/i` to
**"You can only work with customers assigned to you."** So a test whose stated purpose was to prove
sanitization *happens* was pinning the claim that it does **not** — asserting the operator sees an
internal guard token. It passed only because the stub manufactured the string it was checking for.

The assertion now pins the real sentence. This is the "assertions that agreed with the bug" failure
from the sweep changelog, found again in a file that change did not touch.

Worth recording how it was caught: the prediction going in was that `CUSTOMER_SCOPE_DENIED` would
pass through unchanged, since no constraint pattern *looked* like it would match. Running the suite
disproved that — the mapping is the very first entry in `CONSTRAINT_PATTERNS`. Reading the function
was not enough; executing it was.

Verified: all four suites green — **4 files, 30 tests** — plus `tsc --noEmit` clean and ESLint clean
on all four. The `MonthEndClose` failure was observed first (`expected 'CUSTOMER_SCOPE_DENIED'`,
received `'You can only work with customers assigned to you'`) and then fixed, so the corrected
assertion is pinned to observed behaviour rather than to a second guess.

**Remaining known gap, and it is now unblocked:** `InventoryPage.productIdentity.test.tsx:56` stubs
`checkMutationResult` as a bare `vi.fn()`. The real helper **re-throws `result.error`**, so neutered,
a save the database refused reads as a successful one — instance 3 of the sweep's rule, and the
dangerous shape: not a weak test but an inverted one. It was previously blocked because that file was
being modified on an unmerged branch; PR #555 has since landed, so the collision risk is gone and it
is a clean next change. It stays out of this diff only to keep this one to the four sites it was
scoped to — not because anything still prevents it.

**This does not finish the job, and should not be read as finishing it.** It closes the four sites
named as known gaps, not the class. Counted on this branch, rebased onto `main` after PR #555 landed
(`91353629f`), **17** `sanitizeError` stubs remain divergent:

- **`String(e)` / `String(error)`** — `BatchAdjustModal:7`, `TransactionLedgerModal:12`,
  `rupCompliance:25`. Yields `[object Object]` for the plain-object errors postgrest-js resolves.
- **`e instanceof Error ? e.message : <literal>`** — `LotsEditorModal:41`, `BlendTickets:97`,
  `FieldApplicationInvoice:49`, `LotTrace:21`, `Orders:29`, `Orders.pickListShortage:43`,
  `Products.pricing-flow:67`. The exact shape the sweep rejected: false for plain objects.
- **`(e as Error)?.message || 'Error'`** — `BlendTicketDetail:48`, `Deliveries.shortageBadge:45`,
  `InvoiceDetail:54`, `JobDetail.billingHazard:48`, `OrderDetail.pickListShortage:65`,
  `PaymentAllocation:34`. These *do* read `.message` off a plain object, so they are the closest of
  the three — but they still perform no redaction and no token mapping, so a suite using one cannot
  detect a `permission denied for table …` leak or assert the friendly text an operator really sees.
  That is precisely the gap that made the `MonthEndClose` assertion above wrong for two years' worth
  of reading.
- **`mockSanitizeError`** — `OrderDetail:58`, a named spy whose behaviour was not audited here.

They are left alone deliberately rather than swept: each sits in a file this diff does not otherwise
touch, and the `MonthEndClose` case shows the swap is not mechanical — replacing a stub can expose an
assertion that was written against the stub's fiction and needs a judgement call about what the
correct expectation is. A blind find-and-replace across 17 files would produce failures that are real
findings, not noise, and each deserves to be read.
