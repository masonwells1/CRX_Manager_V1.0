# Claude Review Prompt - Codex Validation of Ultra Code Review

Claude, review Codex's independent validation of `docs/audits/2026-06-02-ultra-code-review-structure-simplify.md`.

Scope is review-only unless Mason explicitly approves implementation. Do not push, deploy, apply migrations, delete files, or make production changes. Treat Codex's findings below as claims to verify against the real code, not as truth.

## Context

This is CRX Manager, a live production financial app. Money is stored as bigint cents where applicable, lifecycle/status transitions are DB-enforced, idempotency keys prevent double-submit, and some reads are required post-mutation refetches. Refactors that look cosmetic can still break money, inventory, RLS, or lifecycle behavior.

Codex verdict: `SHIP-WITH-CORRECTIONS`.

Codex found the safe cleanup batch is mostly real, but several LOW/MEDIUM refactors in the report are under-rated because they move money math, idempotency/actor paths, or mutation refetches.

## What I Want You To Do

1. Independently verify each Codex finding below with `file:line` evidence.
2. Confirm or refute the corrected risk ratings.
3. If you agree, update your implementation plan so these items are not applied as low-risk cleanup.
4. Do not implement any cleanup yet unless Mason separately approves it.

## Codex Blockers / Corrections To Verify

1. Sequencing contradiction:
   - Report §7 says "confirmed dead-code deletions" first, but also says `quoteCalc.ts` deletion is STOP/HIGH.
   - Codex found no production import of `quoteCalc`, but tests still import it:
     - `src/lib/quoteCalc.test.ts:3`
     - `src/lib/commissionSplit.test.ts:2`
     - `src/lib/financeChargeCalc.test.ts:15`
   - Conclusion to verify: deleting `quoteCalc.ts` without moving/removing tests breaks CI. Keep `quoteCalc.ts` deletion separate from the safe-deletion batch.

2. `QuoteSectionCard` is not LOW:
   - Report cites `src/pages/QuoteBuilder.tsx:1872-2275` as LOW.
   - That range includes the row money handlers:
     - price override and tier math at `QuoteBuilder.tsx:2064-2072`
     - calc mode flip at `QuoteBuilder.tsx:2132-2138`
     - units-direct calc mode flip at `QuoteBuilder.tsx:2205-2211`
   - Conclusion to verify: `QuoteSectionCard` should be HIGH unless the extract excludes the row handlers entirely.

## Codex Risk Re-Rates To Verify

| Finding | Report rating | Codex corrected rating | Evidence |
|---|---:|---:|---|
| `QuoteItemRow` | MEDIUM | HIGH | price override/tier math `QuoteBuilder.tsx:2064-2072`; calc mode flips `2132-2138`, `2205-2211` |
| `QuoteSectionCard` | LOW | HIGH | cited range includes same row money handlers `QuoteBuilder.tsx:1872-2275` |
| `useDeliveryData` | MEDIUM | HIGH | `fetchDelivery` is refetch for lifecycle RPCs: `edit_delivery` `DeliveryDetail.tsx:505-527`, cancel `538-557`, void/log `568-587`, confirm `714-723`, complete/log/email `783-944` |
| `useOrderDetail` | MEDIUM | HIGH | `fetchOrder` loads invoices/shares `OrderDetail.tsx:119-209` and is post-mutation refetch after `update_order_items` `394-439`, status/void/share paths `480-642` |
| `OrderBillSplit` | MEDIUM | HIGH | cents math `OrderDetail.tsx:615`, <=100% guard `605-608`, invoice lock gate `743-747`, UI lock `1276-1288` |
| `useInventoryData` | LOW | HIGH | fetches are post-mutation refreshes after hold/create/force `InventoryPage.tsx:392-424`, adjustment `584-602`, retire `623-637` |
| `useCreateHold` | MEDIUM | HIGH | inventory RPC with actor/idempotency/admin override `InventoryPage.tsx:339-357`, force path `416-424` |
| `OrderItemsTable` | LOW | MEDIUM | price/unit inputs and new total feed `update_order_items`: UI `OrderDetail.tsx:1135-1154`, total `1251-1253`, RPC payload `394-429` |
| `InvoiceDetail PaymentModal` | MEDIUM | HIGH | `allocate_payment` idempotency `InvoiceDetail.tsx:552-569`, balance prefill/reset `856-857`, refetch callback `1388-1389` |

## Codex False-Dead Result To Verify

Codex found no production false-dead callers for:

- `src/lib/quoteCalc.ts` production imports: none found, but tests import it.
- The 8 listed `src/types/index.ts` interfaces outside `index.ts`: none found.
  - `OCRProcessingQueue:953`
  - `OrderLineAllocation:1192`
  - `InvoiceLineAllocation:1203`
  - `FinancialAuditEntry:1243`
  - `FieldPolygon:1284`
  - `FieldWithGroup:1294`
  - `ArReminderTracking:2361`
  - `FieldAppInvoicePayload:2456`
- `Dashboard._alerts`: built and voided only at `Dashboard.tsx:403-530`.
- `generateBatchStatementsPdf`: test-only; real paths use `downloadBatchStatements` at `statementPdf.ts:828-838`, called by `ARaging.tsx:18/452` and `MonthEndClose.tsx:18/241`.
- Static `X-Request-ID`: global header `db.ts:28-32` is overwritten by per-fetch header `db.ts:33-44`.
- `getFailedActions`, exported `MAX_RETRIES`, exported `formatCSVCell`: no production external callers; internal/test-only usage.
- `FieldAppChemicalEntry.recipes`: declared `FieldAppChemicalEntry.tsx:31-78`, caller does not pass it `FieldApplicationInvoice.tsx:756-761`.

## Codex Confirmed-Safe Quick Wins To Verify

Codex says these are safe/no-op cleanup, assuming tests/build pass:

- no-op ternaries `OrderDetail.tsx:1124-1125`
- CustomerDetail phantom stub `CustomerDetail.tsx:201-204`
- write-only setters `DeliveryDetail.tsx:132/408` and `JobDetail.tsx:137/231`
- duplicate `reverseIdem.resetKey()` `PurchaseOrderDetail.tsx:362-368`
- duplicate ReceivingLog effect `ReceivingLog.tsx:123-131`
- duplicate invoice scan `Invoices.tsx:508-514`
- duplicate OCR viewer `BlendTicketDetail.tsx:824-833` vs `1584-1600`
- `Dashboard._alerts` delete after auditing now-unused imports
- `FieldAppChemicalEntry.recipes` and local `Recipe` interface removal
- 8 dead interfaces listed above
- static global `X-Request-ID` removal from `db.ts:28-32`
- dropping only the export keyword for `getFailedActions`, `MAX_RETRIES`, and `formatCSVCell` if tests are adjusted or continue importing through allowed test patterns

## Codex Refutation Verdicts To Verify

Codex upheld all major refutations:

1. UPHELD: full `useQuoteBuilder` hook should stay rejected.
   - Evidence: 9 idempotency hooks `QuoteBuilder.tsx:152-160`; quote money math `519-646`; save/audit/status paths `863-903`; version/status/revert paths `1115-1318`.

2. UPHELD: full `useBlendTicketData` hook should stay rejected.
   - Evidence: loader and in-component handlers both own `products`/fields/order state: `BlendTicketDetail.tsx:197`, `216`, `277`, `473-526`; `products` is saved through `save_blend_ticket` at `345-360`.

3. UPHELD: Reports 4-component split should stay rejected.
   - Evidence: `handleMarkPaid` moves `create_commission_payment`, actor/idempotency, audit, and refetch `Reports.tsx:446-484`; columns close over state `646-655`, `678-683`.

4. UPHELD: ARaging 3-tab split should stay rejected.
   - Evidence: Aging columns drive statement state `ARaging.tsx:171-200`; statement RPCs `128-149`, `352-368`; reminder/email/tracking path `461-579`.

5. UPHELD: `usePOReceivingHistory` should stay rejected as written.
   - Evidence: reversal is ledger/inventory RPC with actor/idempotency/audit and must refresh both PO and history `PurchaseOrderDetail.tsx:380-394`.

6. UPHELD: Deliveries mega-hook plus load-sheet batch rewrite should stay rejected.
   - Evidence: driver RLS boundary is in fetch `Deliveries.tsx:199-202`; route includes drivers `App.tsx:213`; load-sheet item fetch is deliberately per-delivery with `.eq(...).order('id')` `Deliveries.tsx:543-548`.

## NewOrder Note

Codex confirmed `NewOrder.tsx:192` dollar-float math is intentional for the current RPC contract:

- frontend sends `price_per_unit` dollar/numeric values to `create_direct_order` at `NewOrder.tsx:330-347`
- the latest RPC body stores `price_per_unit` and order totals as numeric dollars at `supabase/migrations/20260513020000_canonical_commission_math.sql:291-459`

Action: add a clarifying comment only. Do not convert this path to cents unless auditing and changing the RPC contract.

## Sequencing Correction

Codex says the safest-first order is sound only after these corrections:

1. Apply §2 quick wins and truly dead cleanup first.
2. Do not include `quoteCalc.ts` deletion in the first safe batch. Treat it as a separate test-reorg item.
3. Do not bundle tier-price consolidation with `quoteCalc.ts` deletion.
4. Move all HIGH re-rates into one-at-a-time sessions with before/after numeric checks and mutation-refetch smoke checks.

## Required Response Format

Respond with:

- `ACCEPT CODEX FINDINGS` / `ACCEPT WITH CHANGES` / `REJECT CODEX FINDINGS`
- Any Codex findings you disagree with, with `file:line` evidence.
- A corrected implementation sequence.
- A list of cleanup items Mason can approve first with confidence.
- A list of items that require separate high-risk review before implementation.

Again: review only. Do not edit, push, deploy, delete, or apply anything unless Mason explicitly approves the implementation step.
