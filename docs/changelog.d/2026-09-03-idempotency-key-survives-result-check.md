## 2026-09-03 - Money screens keep the idempotency key until the RPC reply is verified (F1)

**Type:** fix (money paths, frontend only — no migration, no live database change)

## What was wrong

A mutating RPC's reply is only known-good once `assertRpcResult()` has accepted it. Across
20 files the idempotency key was retired one step too early — after the error check but
**before** `assertRpcResult`:

```
rpc() -> if (error) throw -> resetKey()  <-- too early -> assertRpcResult()
```

`assertRpcResult` throws on a null or malformed success payload — the **ambiguous reply**,
where the server may already have committed but the client cannot tell. Because the key was
already gone, the user's natural retry travelled under a **fresh** key, which the server
cannot replay, so the work was applied twice: a duplicate invoice, a double-allocated
payment, a double-credited return.

## What changed

**39 call sites across 20 files** now retire the key only after the reply is verified.
Affected money paths: invoice creation and split invoicing, invoice posting, payment
allocation, prepayment application, returns/credits, month-end statements, finance charges,
order cancel/void, delivery completion and follow-ups, blend-ticket approval, quote
draw-down and rollover.

**Two click-level repairs in `OrderDetail.tsx`.** Reordering the post-RPC reset is not
enough when a *button* retires the key before the RPC runs:

- `onCreateInvoiceClick` reset per click, justified in a comment as "date/notes vary".
  That is not true: `create_invoice_from_order` takes only
  `(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)`.
- The Cancel Order button reset on every dialog open. `cancel_order` takes only
  `(p_order_id, p_performed_by, p_idempotency_key)`.

Neither payload can vary between attempts, so reopening either dialog is the *same* intent
and a fresh key only removed duplicate protection. **The Cancel Order defect was found by
driving the real screen — the unit tests and the new static guard both passed over it.**

## Deliberately not changed

- **Three verified-correct sites.** A `resetKey()` inside an `if (error)` recovery branch is
  correct: `QuickDeliveryModal.tsx:392`, `InvoiceDetail.tsx:815` and `Returns.tsx:406` sit
  behind `getIdempotencyMismatchResult` (server returned a committed receipt — the outcome is
  known, so the app reopens the committed record) or `isDefinitiveRpcRejection` (nothing
  committed). "Fixing" these breaks duplicate recovery.
- **`voidOrderIdem` / `updateOrderIdem` click resets.** `void_order` takes a free-text
  `p_reason` and `update_order_items` takes `p_items`, so those resets encode real intent
  rotation. The correct fix is a scoped key (as `VendorBillDetail` already does for
  `void_vendor_bill`), which is a design change tracked separately.
- **`JobDetail.tsx`** — 4 sites of the same class, excluded because a concurrent session owns
  the file. Tracked as a follow-up in `docs/manual/KNOWN_ISSUES.md`.
- **`CycleCounts.tsx`** — its RPCs return void and use `.throwOnError()`; there is no payload
  to assert, so the resets there are already correct.

## Proof

- `src/__tests__/idempotency-reset-order.test.ts` — 10 tests: transport failure, failure
  envelope, lost-response replay, success, changed intent; plus a repo-wide static guard that
  fails on any new reset-before-assert and on a fixed-payload key retired from a click
  handler. Both guards were mutation-tested (reintroduced each bug, confirmed red, restored).
- Real-browser proof on the running `OrderDetail`: with an ambiguous reply scripted, the
  retry reused the key (`create_invoice_from_order`, `cancel_order`) and the app navigated to
  the replayed invoice. With the old behavior temporarily restored, the same flow sent two
  different keys.
- `npm run typecheck`, `npm run lint`, `npm run test` (348 files / 4909 tests), `npm run build`.
