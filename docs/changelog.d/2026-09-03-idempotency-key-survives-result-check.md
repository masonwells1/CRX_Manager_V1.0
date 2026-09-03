## 2026-09-03 - Money screens keep the idempotency key until the RPC reply is verified (F1, partial)

**Type:** fix (money paths, frontend only — no migration, no live database change)

## What was wrong

A mutating RPC's reply is only known-good once `assertRpcResult()` has accepted it. The
idempotency key was being retired one step too early — after the error check but
**before** that assert:

```
rpc() -> if (error) throw -> resetKey()  <-- too early -> assertRpcResult()
```

`assertRpcResult` throws on an empty reply — the **ambiguous reply**, where the server
may already have committed but the client cannot tell. Because the key was already gone,
the user's retry travelled under a **fresh** key the server cannot replay, so the work
was applied twice: a duplicate invoice, a double-allocated payment, a double credit.

`assertRpcResult` rejects only `null`/`undefined`; it does not validate shape. A path
needing a real shape check must do it itself and retire the key after it.

## What changed — 16 call sites across 8 files

Deliberately narrow. The reorder makes the client **retain** the key, which is only safe
when the key is bound to what the RPC actually targets. Every site below satisfies that:

- **`OrderDetail`** — cancel order, void order, split invoicing, create invoice. Plus
  two **click-level repairs**: `onCreateInvoiceClick` and the Cancel Order button each
  minted a fresh key per click. `create_invoice_from_order` takes only
  `(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)` and `cancel_order`
  only `(p_order_id, p_performed_by, p_idempotency_key)`, so neither payload can vary
  between attempts and a per-click reset only removed duplicate protection. The old
  comment claiming "date/notes vary" was wrong on both counts.
- **`DeliveryDetail`** — cancel, void, complete, create follow-up.
- **`InvoiceDetail`** — `save_invoice` is now validated **unconditionally**: it returns
  the invoice id for EDITS as well as creates, and validating only the `isNew` arm left
  every edit retiring its key on an empty reply and reporting "saved". Plus transfer to
  scheduling.
- **`FieldApplicationInvoice`** — delete invoices, transfer to scheduling.
- **`FieldStop`**, **`Returns`**, **`PrepaymentManagerPanel`**, **`MonthEndClose`**.

**Record scoping.** Retaining a key is unsafe if it can follow the user to a different
record. Detail pages do **not** remount when the route id changes (every `<x>/:id` route
in `src/App.tsx` is rendered without a `key` prop), so 10 keys on `OrderDetail`,
`DeliveryDetail`, `InvoiceDetail` and `FieldApplicationInvoice` are now scoped to the
route id via the hook's `intentScope` — same record retries under the same key, each
record gets its own. `InvoiceDetail`'s `saveIdem` was already record-scoped and was left
alone.

## What is deliberately NOT fixed

Twelve pages were reverted to `main` after the round-2 adversarial review. On each, the
key is not bound to what the RPC targets — an in-page selection, a staged payload,
component state, or a `/new` route with no id — so retaining it would trade
duplicate-on-retry for **cross-record replay**. Demonstrated worst case: on
`PrepayWorkspacePanel`, batch B would receive batch A's receipt, report success, and
clear B's staged allocations without applying them.

Reverted and tracked: `QuoteBuilder`, `BlendTicketDetail`, `PrepayWorkspacePanel`,
`Deliveries` (batch cancel), `Invoices` (batch void/delete), `PaymentAllocation`,
`FinanceChargePreviewModal`, `Quotes`, `DeliveryRemainders`, `NewOrder`,
`QuickDeliveryModal`, `FieldSetup`. Plus `JobDetail` (4 sites, owned by a concurrent
session). Fixing them needs the key bound to the **request payload**, which is the
`fingerprintIntentPayload` approach from PR #535 — not the URL.

**Also still open:** the original sweep matched `resetKey()` / `resetKeyFor(` literally
and therefore missed **aliased** resets from destructured hooks. `QuoteBuilder.tsx:1522`
(`resetSaveQuoteIdempotencyKey()` before the assert on 1523) still carries the F1 defect
on `save_quote`, and `CustomerDetail`, `ProductDetail`, `PurchaseOrderDetail` and
`JobDetail` use the same aliased form and were never examined.

## ⚠️ A `resetKey()` inside an `if (error)` branch is CORRECT

`QuickDeliveryModal.tsx:392`, `InvoiceDetail.tsx:815` and `Returns.tsx:406` retire the
key **before** the assert and are **verified correct**: they sit behind
`getIdempotencyMismatchResult` (the server returned a committed receipt, so the outcome
is known and the app reopens the committed record) or `isDefinitiveRpcRejection` (the
server refused, nothing committed). A sweep will flag them; changing them breaks
duplicate recovery.

## Proof

- `src/__tests__/idempotency-reset-order.test.ts` — behavioral tests (transport failure,
  failure envelope, lost-response replay, success, changed intent) plus repo-wide guards
  against a new reset-before-assert, a fixed-payload key retired from a click handler,
  and an unscoped retained key on a page that can switch records. Guards mutation-tested
  — each defect reintroduced, confirmed red at the exact line, restored.
- **Real-browser proof** on the running `OrderDetail`: with an ambiguous reply, the retry
  reused the key; with the pre-fix behavior restored, the same flow sent two different
  keys. For the record scoping: A(ambiguous) → B → back to A produced key1, key2, key1
  with the component confirmed still mounted across the route change.
- `typecheck`, `lint`, `test` (348 files / 4937 tests), `build` — all green.
- Reviewed by Codex `gpt-5.6-sol` at high effort over two rounds. Round 1 found 2 HIGH —
  including a cross-record replay **introduced by the first version of this fix**. Round
  2 found the generalisation unsafe, which is why the scope is now narrow.
