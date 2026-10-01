## 2026-10-01 — Field-app invoice tests no longer break when today is 2026-10-01

Two tests in `src/pages/FieldApplicationInvoice.test.tsx` started failing on every branch,
including `main`, on 2026-10-01:

- "discards a rendered preview when the transaction date changes"
- "drops a preview response that arrives after the transaction date changed"

Both move the Transaction Date to a hard-coded `'2026-10-01'` to cross the Oct 1 season
boundary and expect the on-screen preview to be thrown away. The field defaults to today,
so on 2026-10-01 that "change" set the field to the value it already had: no change event
reached the page and the preview correctly stayed. The app was fine; the tests had a
calendar time bomb.

A small helper, `crossSeasonDate`, now picks `'2026-09-30'` when the field already reads
`'2026-10-01'`, and `'2026-10-01'` otherwise. That is always a real change on the other
side of the season boundary. No app code changed.

### Proof observed

- Before: `npx vitest run src/pages/FieldApplicationInvoice.test.tsx` on `main` (4bbf13a)
  fails exactly these 2 tests; the full suite fails only these 2.
- After: all 44 tests in the file pass. `eslint` and `tsc --noEmit` are clean.
