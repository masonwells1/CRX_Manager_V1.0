## 2026-09-05 - Use the shared rejection classifier in the bulk field import, and stop asserting a boundary is missing

Third Codex round on the same PR, two findings, both correct.

### 1. High - a non-blank error code does not authenticate a response as PostgreSQL's

The previous entry narrowed "the server rejected this row" to a 4xx carrying an error code.
That is still too loose: transport libraries and intermediaries attach codes of their own
(`ETIMEDOUT`, `ECONNRESET`), and `PGRST0xx` are pool-level failures that can occur *after* a
statement already committed. A coded JSON `408` or `429` from an intermediary would have been
displayed as a clean rejection, and the operator told to re-import a row that may already exist.

CRX already has the right answer for this and this screen was not using it.
`isDefinitiveRpcRejection()` in `src/lib/idempotency.ts` returns true only for a positively
identified PostgreSQL/PostgREST refusal: it matches real SQLSTATE classes, excludes connection
class 08 and the individually ambiguous codes (`40003`, `57P01/02/03`), and accepts only
`PGRST1xx+`, because `PGRST0xx` are connection-level. That reasoning is exactly what this screen
needs, and it is now what this screen uses. The local helper keeps only the 4xx status bound on
top of it and is renamed `rpcDefinitelyRolledBack()`, since both RPCs on this screen now use it.

### 2. Medium - the screen stated an unverified database condition as fact

`set_field_boundary` is independently transactional and commits before it answers, exactly like
`save_field`. But every boundary error was reported as "Field created but boundary measurement
failed", and the warning went further: it said the field "has no map boundary yet" and told the
operator to ask an admin to remove any incomplete field. If the boundary landed and only the
response was lost, that is a correctly imported field being described as broken - and an admin
invited to delete it.

The boundary call now starts pessimistic in the same way. Only a positive refusal produces the
definite "boundary measurement failed" wording; anything ambiguous reads "Field created, but we
never learned whether its map boundary landed - check this field before changing or removing it".
The warning no longer claims anything about boundaries, and no longer recommends removal
unconditionally: it says to look a field up before asking an admin to change or remove it,
because a row can report a step as failed when the server simply never answered.

### Verification

- `npm run typecheck` clean, `npm run lint` clean, `npm run build` succeeded.
- `npm run test` - 352 files, 5021 passed, 0 failed, 123 skipped.
- Thirteen tests in `src/components/fields/BulkFieldImport.duplicateWarning.test.tsx`. Three are
  new: a `408` carrying `ETIMEDOUT`; a `400` carrying `PGRST001`; and a lost `set_field_boundary`
  response, which must not be described as a missing boundary while the re-import warning still
  stands. The two existing boundary tests were corrected to mock a real PostgREST refusal
  (`400` + SQLSTATE `22023`) rather than an error with no status - without one they were
  describing a response that never arrived, which is now a different and correct outcome.
- **Seventeen mutations, each verified to be a real edit and not a silent no-op, source restored
  byte-identical after every run - all seventeen caught.** Three are new: the shared classifier
  swapped back for a bare non-blank code check; the boundary outcome assumed known until the
  server answers; and an ambiguous boundary reported as a definite measurement failure.
- **Rendered and looked at** once more, for the lost-boundary case, to confirm the panel never
  states the boundary is missing. Captured from the real component's test DOM and served through
  the dev server.
- Not verified: no live-database round trip. The Supabase boundary is mocked; the real gateway
  and PostgREST behaviour is reasoned from the installed `postgrest-js` source and from the
  existing shared classifier, not observed against production.

### Still open - unchanged

Re-importing still duplicates. This is operator guidance, not a fix. Codex's standing point is
that durable protection needs a stable per-row idempotency key and reconciliation - ideally one
atomic RPC creating field, boundary and override in a single transaction - which is a migration
awaiting Mason's decision.
