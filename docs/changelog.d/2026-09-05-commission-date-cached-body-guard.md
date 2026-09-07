## 2026-09-05 - Pending commission-date cutover cached-body compatibility boundary

The parked atomic commission/document Chicago-date migration (`20260905200400`) now closes the
remaining cached PL/pgSQL-body race inside the same database transaction as its writer drain and
six function replacements. This is a source-only correction: nothing was applied to production.

- Every replacement helper/writer sets the same transaction-local Chicago-date cutover marker
  before any early return or write.
- A tightly scoped `SECURITY INVOKER`, owner-only compatibility function and three exact BEFORE
  triggers on `orders`, `invoices`, and `commissions` inspect `PG_CONTEXT`. Only a call stack from
  one of the six cutover functions without the marker is rejected with
  `CHICAGO_DATE_CUTOVER_RETRY`; direct writes and unrelated functions retain existing behavior.
- Helper catalog pins now include exact argument types/names, exactly one default, the Chicago
  default expression, and non-set integer return. A default-only mutation retaining the original
  function body is refused before replacement.
- The disposable PostgreSQL 17 proof holds a real old `_insert_commissions_for_order` inside its
  unchanged validator, applies the unified migration, then releases it. The old call is rejected
  with the stable retry error and actual stack frame without a commission row; the retry uses the
  new body and records the source document's Chicago date. It also retains the writer-lock and
  lock-removal negative controls and rejects trigger/marker/ACL weakening.

The cached execution case is behavioral for the commission helper. The four authenticated
document-writer bodies are statically pinned to the same marker by the migration postflight (and
the missing-marker mutation removes the helper's marker); an equivalent old authenticated
document-writer session is not yet a separate fixture. That remaining coverage limit is explicit,
not a claim that the helper session exercised all four external entry points.

The pending commission plan still contains exactly six files; the former `20260905200500` remains
superseded before apply and must not be recreated.
