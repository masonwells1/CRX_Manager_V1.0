## 2026-09-05 - Warn against re-importing a bulk field import, and stop showing "[object Object]" as the reason

Three changes to the bulk field import results screen. None touches the import
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
"Field created but boundary measurement failed" rows specifically. **That condition was
widened in section 3 below** — `created` alone proved insufficient.

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

### 3. Codex P1 on the PR — a lost response is not a rejection

The first version counted only rows whose `save_field` call returned an id. Codex's review
of PR #623 pointed out the hole, confirmed here from the installed `postgrest-js` source
before fixing: if the request reaches PostgreSQL and **commits** but the HTTP response is
lost, Supabase surfaces a fetch error and the row looks un-created. The warning would then
have told the operator that row was safe to re-import — causing exactly the duplicate it
exists to prevent, with more confidence than before the warning existed.

`postgrest-js` (`dist/index.mjs`, the fetch-failure branch) returns `status: 0` and an empty
`code` **only** when fetch itself failed and no response arrived; any real PostgreSQL
rejection carries a real HTTP status. That is the discriminator. Each row now resolves to
one of `not-sent` / `committed` / `rejected` / `unknown`, set pessimistically to `unknown`
the moment the request goes out and narrowed only when the server actually says something.
`unknown` also covers a 200 carrying a null id, where `assertRpcResult` throws and the row's
fate is equally unknowable.

The screen now shows two separate sentences: confirmed-existing fields, and rows whose
outcome is unknown and must be looked up before retrying.

**The counter alone was not enough.** "Re-import only the rows the server rejected" is
unusable advice if a lost response reads exactly like a rejection in the error list — the
operator has no way to sort one from the other. Unknown-outcome rows are therefore labelled
`OUTCOME UNKNOWN` in the list itself, and the warning points at that label. A genuine
rejection is never labelled, or the label would mean nothing.

### Verification

- `npm run typecheck` clean · `npm run lint` clean · `npm run build` succeeded.
- `npm run test` — 352 files, 5014 passed, 0 failed, 123 skipped.
- New `src/components/fields/BulkFieldImport.duplicateWarning.test.tsx` — 6 tests
  driving the **real** component through the **real** `handleUpload`, mocking only the
  network boundary, auth, toast, the child steps and the file parser: a boundary-failed
  row is counted; a clean row and a boundary-failed row are counted together; no
  warning on a fully clean import; no warning when `save_field` itself failed and
  nothing reached the database; a lost response still warns; a 200 carrying no id still warns.
- **Eight mutations, each verified to be a real edit and not a silent no-op, source
  restored byte-identical after every run — all eight caught:** the warning driven by
  `success` instead of `created`; the count displayed from `success`; `created`
  incremented only after the boundary lands; the boundary error `String()`-ed back to
  `[object Object]`; a lost response treated as a definite rejection; the warning
  suppressed for an unknown-outcome row; unknown-outcome rows left unlabelled in the error
  list; and the outcome assumed known until the server answers. **That last one ESCAPED on the first run** — nothing covered a 200 carrying
  a null id, so the pessimistic default could be deleted with every test still green. The
  sixth test exists because of it; reading the suite did not reveal the gap.
- **Rendered and looked at**, four times: before and after the `[object Object]` fix, and
  again for the unknown-outcome panel, whose first render read "They are marked" for a
  single row. The real component's results panel was captured from the test DOM and viewed
  in the browser each time. The first shot is what exposed `[object Object]`.
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
