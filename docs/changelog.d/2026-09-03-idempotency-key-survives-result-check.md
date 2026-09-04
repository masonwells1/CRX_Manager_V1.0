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

## What changed — 14 changes across 7 files

Deliberately narrow, and narrowed twice more by review. The reorder makes the client
**retain** the key, which is only safe when the key binds **everything a retry can
vary** — not merely the record the RPC names. `check_idempotency` matches on key plus
operation and returns the cached result *without looking at the new payload*, so a
retained key on an RPC that also carries free text or quantities replays the FIRST
payload while the screen reports the edited one. Every site below clears that bar:

- **`OrderDetail`** — cancel order, split invoicing, create invoice. Plus
  two **click-level repairs**: `onCreateInvoiceClick` and the Cancel Order button each
  minted a fresh key per click. `create_invoice_from_order` takes only
  `(p_order_id, p_salesman_id, p_invoice_type, p_idempotency_key)` and `cancel_order`
  only `(p_order_id, p_performed_by, p_idempotency_key)`, so neither payload can vary
  between attempts and a per-click reset only removed duplicate protection. The old
  comment claiming "date/notes vary" was wrong on both counts.
- **`DeliveryDetail`** — create follow-up ONLY. Its payload is exactly
  `(p_original_delivery_id, p_performed_by, p_idempotency_key)`. Cancel, void and
  complete stay in `main`'s order: they carry free-text reasons and, for complete, the
  signature, per-item quantities and issue notes, none of which a route-id scope binds.
- **`InvoiceDetail`** — `save_invoice` is now validated **unconditionally**: it returns
  the invoice id for EDITS as well as creates, and validating only the `isNew` arm left
  every edit retiring its key on an empty reply and reporting "saved". Plus transfer to
  scheduling.
- **`FieldApplicationInvoice`** — delete invoices, transfer to scheduling.
- **`Returns`** — the cancel key's scope and its request now use ONE value. The scope
  trimmed the reason while the request sent it raw, and the server fingerprints and
  stores the raw reason without normalising it, so the two halves could describe
  different intents. **This was NOT reachable in production and no user hit it:**
  `ReasonModal` is the only caller and already passes `onConfirm(trimmed)`. The change
  is defensive and runtime-equivalent today — it removes a latent trap for any future
  caller that does not trim. Recorded this way because an earlier draft of this entry
  described it as a live defect, which was wrong.
- **`PrepaymentManagerPanel`**, **`MonthEndClose`**. The individual
  prepayment apply is additionally scoped **by customer** via `getKeyFor`: the panel
  lists every customer, so an unscoped retained key would hand customer A's receipt to
  customer B.

**Record scoping.** Retaining a key is unsafe if it can follow the user to a different
record. Detail pages do **not** remount when the route id changes (every `<x>/:id` route
in `src/App.tsx` is rendered without a `key` prop), so 9 keys are now record-scoped via
the hook's `intentScope` / `getKeyFor` — the same record retries under the same key, and
each record gets its own. `InvoiceDetail`'s `saveIdem` was already record-scoped and was
left alone.

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
`QuickDeliveryModal`, `FieldSetup`. Plus `JobDetail` (3 pinned sites, owned by a
concurrent session, plus 2 real defects of a different shape the scanner cannot see —
`runJobSave` and `assignWithOverride` retire the key BEFORE the call that uses it).
Fixing them needs the key bound to the **request payload**, which is the
`fingerprintIntentPayload` approach from PR #535 — not the URL.

**Reverted after round 3:** `FieldStop` (it does not remount stop-to-stop, and the file's
own stale-route guard proves it) and `OrderDetail`'s `void_order` (it sends a free-text
reason, so the route id does not bind it).

**Reverted after round 4:** `DeliveryDetail`'s complete, cancel and void. The HIGH was
`complete_delivery`, which sends the signature, per-item quantities, issue type and issue
notes — all editable before a retry, none bound by a route-id scope. Cancel and void
carry the same problem through their free-text reasons.

**Also still open:** the original sweep matched `resetKey()` / `resetKeyFor(` literally
and therefore missed **aliased** resets from destructured hooks. The guard now resolves
aliases, which surfaced live defects in `QuoteBuilder` (`save_quote`) and `CustomerDetail`
×2 (`save_customer`). It also produced two **false positives** the round-4 review
corrected — `BulkTicketUpload` and `ManualTicketCreate` are correct code, pinned only so
the scan stays honest. Neither the real defects nor the false positives are money paths.

## ⚠️ A `resetKey()` inside an `if (error)` branch is CORRECT

`QuickDeliveryModal`, `InvoiceDetail` and `Returns` retire the
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
  — each defect reintroduced, confirmed red at the exact line, restored. The known-broken
  files are **identity-pinned**, not count-pinned: round 4 showed a count alone lets a new
  defect be swapped in as an old one is removed, and it records EVERY reset on a line, not
  just the first. Comments and string literals are stripped before matching — a comment
  mentioning `assertRpcResult` used to hide a real reset, and one mentioning `.update(` used
  to invent a site that was not there.
- **Real-browser proof** on the running `OrderDetail`: with an ambiguous reply, the retry
  reused the key; with the pre-fix behavior restored, the same flow sent two different
  keys. For the record scoping: A(ambiguous) → B → back to A produced key1, key2, key1
  with the component confirmed still mounted across the route change.
- `typecheck`, `lint`, `test`, `build` — all green, and CI green on the candidate commit.
- Reviewed by Codex `gpt-5.6-sol` at high effort over six rounds; every round found real
  defects **in this change**. Round 1 (2 HIGH) included a cross-record replay *introduced
  by the first version of this fix*. Round 2 (6 HIGH) found the whole generalisation
  unsafe, which is why twelve pages were reverted. Round 3 (3 HIGH) rejected `FieldStop`
  and `void_order`. Round 4 (1 HIGH) rejected three of the four `DeliveryDetail` actions
  and found three defects in the guard itself. Round 5 (0 HIGH, 5 MEDIUM) audited every
  retained site against its RPC's full parameter list from the migration source: ten of
  eleven cleared, and the eleventh — `cancel_return`'s trimmed-scope/raw-request mismatch
  — is fixed above. It also showed the guard was both over- and under-counting
  `JobDetail`. Round 6 (0 HIGH, 5 MEDIUM, 2 LOW) re-audited all eleven retained sites
  against their current migration contracts and found **no money regression**; every one
  of its findings was about the scanner's own precision or about wording in these docs.
  **That is where the review was stopped.** When findings move out of the product and
  into the instrument, the review has stopped describing the change — the remaining
  scanner limits are recorded as residuals (a)–(j) in `KNOWN_ISSUES.md` rather than
  chased, because closing them needs an AST and belongs to the owed aliased-reset sweep.
  The narrowness of this change is the review's doing, not the plan's.
