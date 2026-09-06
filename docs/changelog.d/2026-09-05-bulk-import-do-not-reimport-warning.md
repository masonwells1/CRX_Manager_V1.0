## 2026-09-05 - Warn against re-importing a bulk field import, and stop showing "[object Object]" as the reason

Two changes to the bulk field import results screen. Neither touches the import
logic itself; the underlying duplicate-field defect is unchanged and still needs the
server-side fix described at the bottom.

### 1. A warning against re-importing the file

`save_field` COMMITS before `set_field_boundary` runs, and every RPC on this screen
sends a fresh `crypto.randomUUID()` as its idempotency key, so the server cannot
recognise a repeat. Re-importing a file therefore creates a second copy of every row
that already reached the database — and `fields_delete` RLS is admin-only, so a
sales_rep cannot clean that up.

The trap is that **a row counted as `failed` may still have created a field.** The
boundary-failure path at the `set_field_boundary` catch increments `failed` even
though `save_field` already committed. So "re-import the failed rows" — the obvious
advice, and what an operator would naturally do — is itself unsafe.

The results state therefore gained a third counter, `created`, incremented
immediately after `assertRpcResult(fieldId, 'save_field')` succeeds, before anything
else can fail. It counts every row that reached the database regardless of how the
row was ultimately classified. The results screen shows an amber warning when
`created > 0 && failed > 0`, naming the count and calling out the
"Field created but boundary measurement failed" rows specifically.

Driving the warning off `success` instead of `created` would have made it **absent in
the single worst case** — one row, boundary failed: 0 imported, 1 failed, one field
sitting in the database. That case is the first test.

### 2. `[object Object]` in the error list — a live defect, found by looking

This was not part of the requested change. It was found by screenshotting the real
rendered results panel while verifying the warning above, and it matters here because
the new warning explicitly tells the operator to read that error line.

Supabase rejections are **plain objects with a `.message`, not `Error` instances**.
All three catch blocks in the import loop used
`err instanceof Error ? err.message : String(err)`, so `String()` rendered every RPC
failure as the literal text `[object Object]`. The operator was told a row failed and
given no reason whatsoever.

All three now use `sanitizeError` from `src/lib/errorSanitizer.ts`, which already
handles the plain-object shape and additionally strips schema identifiers — the same
treatment the rest of the app gives RPC errors.

### Verification

- `npm run typecheck` clean · `npm run lint` clean · `npm run build` succeeded.
- `npm run test` — 352 files, 5012 passed, 0 failed, 123 skipped.
- New `src/components/fields/BulkFieldImport.duplicateWarning.test.tsx` — 4 tests
  driving the **real** component through the **real** `handleUpload`, mocking only the
  network boundary, auth, toast, the child steps and the file parser: a boundary-failed
  row is counted; a clean row and a boundary-failed row are counted together; no
  warning on a fully clean import; no warning when `save_field` itself failed and
  nothing reached the database.
- **Four mutations, each verified to be a real edit and not a silent no-op, source
  restored byte-identical after every run — all four caught:** the warning driven by
  `success` instead of `created`; the count displayed from `success`; `created`
  incremented only after the boundary lands; and the boundary error `String()`-ed back
  to `[object Object]`.
- **Rendered and looked at.** The real component's results panel was captured from the
  test DOM and viewed in the browser, before and after the error-message fix. The
  before shot is what exposed `[object Object]`.
- Not verified: no live-database round trip. The suite drives the real React tree but
  mocks the Supabase boundary; it does not exercise the live RPCs.

### Still open — unchanged by this

This is operator guidance, not a fix. Re-importing still duplicates, because the
client cannot identify a row across uploads: `field_name` falls back to the
**positional** `Imported Field ${i + 1}` and column mapping is optional, so two
genuinely different fields can carry byte-identical attributes. A durable
server-side per-row identity — ideally one atomic RPC creating field + boundary +
override in a single transaction with actor/payload-bound idempotency — is the only
sound fix, and it is a migration awaiting Mason's decision.
