## 2026-09-02 — H5: no more dead-end "Create invoice" button on split-billing orders

Admins were offered a "Create invoice" action on deliveries whose order uses split billing, where
the server guard `ORDER_NEEDS_SPLIT_BILLING` refuses it and always did. On `DeliveryDetail` the
operator at least saw the server's explanation; on the integrity cleanup panel the reason was
discarded and replaced with the literal string `Backfill failed`. Frontend-only fix — the database
already behaved correctly and no migration was needed.

**Part 1 — stop discarding the server's explanation.** A non-throwing `supabase.rpc()` resolves its
error as a plain object, not an `Error` subclass (postgrest-js only constructs `PostgrestError`
under `.throwOnError()`), so `err instanceof Error` was false and every server sentence was
replaced by a literal fallback. All four catch blocks in `IntegrityCleanupPanel` — backfill,
reconcile, verify-manufactured, resolve-alert — now route through the existing `sanitizeError()`,
which already handles object-shaped PostgREST errors and is what `DeliveryDetail` uses on the same
RPC. No code-to-message lookup table was introduced.

**Part 2 — one shared predicate, not two conditions that drift.** New `src/lib/deliverySplitBilling.ts`
mirrors the server guard as an OR of `orders.needs_split_billing` and the existence of
`order_item_field_allocations` rows under the order, and both surfaces consume it. The button is
rendered disabled with the reason rather than hidden, so an operator can see why a listed row is not
actionable there. The read is chunked and range-paged so neither the PostgREST row cap nor a long id
list can silently truncate the answer into a false "this order is fine". A read failure fails OPEN
(button kept): the server still refuses, and after part 1 that refusal now reaches the operator
intact on both surfaces, whereas failing closed would remove a working action from a legitimate
delivery.

`src/lib/deliverySplitBilling.test.ts` pins the predicate's truth table, pins the client mirror to
the shipped migration's guard shape, and pins both surfaces to the shared module — a surface that
re-derives the rule from `needs_split_billing` or the allocations table directly fails the suite.

Verified by rendering both real page components in a browser against stubbed data (the harness
aliases `@supabase/supabase-js` only, so the real `db.ts`, `sanitizeError` and both page components
run unmodified). Observed: on the panel, the plain delivery keeps an enabled button while both a
flag-only order and an allocations-only order render disabled with the reason; clicking the enabled
row surfaced the full `ORDER_NEEDS_SPLIT_BILLING` sentence, and reverting the one line reproduced
`Backfill failed`. On `DeliveryDetail`, the button is disabled with the reason for both split-billing
arms and enabled for the plain control. Live read-only check on 2026-09-02 confirmed production
currently has zero flagged orders and zero allocation rows, so no existing row reproduces the defect
today.
