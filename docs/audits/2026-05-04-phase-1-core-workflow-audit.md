# Phase 1 — Core Business Workflow Audit

**Date:** 2026-05-04
**Auditor:** Claude (Opus 4.7, 1M context)
**Scope:** Read-only audit of the core business pipeline — quote → order → delivery → invoice → payment. No source files were edited. Findings are written for a non-technical owner; every claim points at an exact file and line number.

---

## Plain-English Summary

The pipeline works correctly when everything goes well: an accepted quote builds an order, a delivery deducts inventory, completing a delivery auto-creates a draft invoice, posting the invoice opens AR, and a payment closes the loop. The mechanics are sound. What is missing is **guidance and continuity.** Several screens leave the user at a dead end, push them to re-enter data they already have, or hide the next obvious step behind a status badge. A handful of gaps are also genuinely dangerous to the books: a "Create Invoice" button that can be clicked at the wrong time and produce a duplicate-shaped scenario, a "Record Payment" button that loses the customer, a customer-confirmation email that is wired to an unreachable status transition, and an `Edit Order` flag that turns off the moment any partial delivery happens — even though there are still undelivered items the user might legitimately need to add or correct. None of these block work today, but together they are the difference between an app that runs the business and one that *guides* the business.

This phase recommends ten findings ordered by impact. Fixing them does not change the database, the money math, or the inventory rules. It tightens the seams.

---

## Evidence Reviewed (with line ranges where citations land)

- `src/components/ui/TransactionThread.tsx:1` through `:229` — the link strip that runs across stages.
- `src/pages/Quotes.tsx:1` through `:367` — quote list, conversion path entry.
- `src/pages/QuoteBuilder.tsx:1199` through `:1310` — `handleConvertToOrder` / `executeConvertToOrder` (creates the order); `:1349` through `:1487` (header buttons, transaction thread embedding).
- `src/pages/Orders.tsx` — list (used for context, not deeply cited).
- `src/pages/NewOrder.tsx:1` through `:120` — direct order entry; uses `create_direct_order` RPC.
- `src/pages/OrderDetail.tsx:51` through `:1117` (header, status flows, AR derivation, action buttons, Linked Deliveries, Linked Invoices). Specifically:
  - `:117` — `canEdit` predicate (key finding P1-3).
  - `:458` through `:587` — `executeStatusChange` and customer-confirmation email gated on a transition that does not happen (P1-7).
  - `:704` through `:724` — `handleCreateInvoice` (P1-1).
  - `:760` through `:786` — TransactionThread instantiation; AR summary derivation.
  - `:811` through `:830` — Create Invoice / Schedule Delivery buttons (P1-1, P1-8).
  - `:983` through `:996` — Record Payment context-loss link (P1-4).
- `src/pages/Deliveries.tsx` (skim — list/batch ops; deeper detail in Phase 4).
- `src/pages/NewDelivery.tsx:1` through `:120` — accepts `?order=` to preselect an order.
- `src/pages/DeliveryDetail.tsx:1` through `:2135` (header, complete flow, auto-invoice banner). Specifically:
  - `:179` through `:185` — role/status predicates.
  - `:702` through `:722` — `handleStartDelivery` (`confirm_delivery` RPC).
  - `:739` through `:943` — `handleComplete` (`complete_delivery` RPC; reads `auto_invoice` from result).
  - `:1431` through `:1440` — TransactionThread embedding.
  - `:1887` through `:1906` — auto-invoice banner shown only after a fresh completion.
  - `:2025` through `:2135` — admin/sales-rep "Complete Delivery" panel (in_progress only).
- `src/pages/DeliveryRemainders.tsx` (skim — referenced for follow-up flow).
- `src/pages/Invoices.tsx:560` through `:680` — header buttons, empty state, summary cards, list filters. Specifically:
  - `:583` through `:589` — only `New Field Application` button + comment that the standalone-create path was removed (P1-5).
- `src/pages/InvoiceDetail.tsx:1` through `:1330` (post, void, payment, transaction thread). Specifically:
  - `:428` through `:459` — `handlePost` (routes through `post_invoice_group` for grouped invoices).
  - `:484` through `:514` — `handlePayment` (in-page modal — only path that preserves customer + invoice context).
  - `:705` through `:716` — TransactionThread embedding.
  - `:740` through `:799` — header action stack (Save / Post / Print / Email / Record Payment / Write Off / Void).
- `src/pages/PaymentAllocation.tsx:1` through `:220` — unified payment entry; customer search starts cold (P1-4).
- `src/pages/PaymentHistory.tsx` (skim — admin-only history view).
- `src/pages/IntegrityCleanup.tsx:1` through `:428` — three back-fill flows the team built specifically because old completions sometimes left no invoice (P1-1, P1-6).
- `supabase/migrations/20260501100000_field_app_workflow_phase15.sql:170` through `:293` — current `complete_delivery` RPC; auto-invoice block at `:208` through `:262` (skips when any active invoice already exists for the order).

---

## Findings

### P1-1 — `Create Invoice` on the order can be pushed at the wrong time and creates a duplicate-shaped path

**Business risk.** When a user opens an order that is `confirmed` or `partially_fulfilled`, the green action area shows two equally-prominent buttons: `Create Invoice` and `Schedule Delivery` (`src/pages/OrderDetail.tsx:811` through `:830`). The user is not told which one is the correct next step. If they click `Create Invoice` *before* a delivery has been completed, `handleCreateInvoice` (`src/pages/OrderDetail.tsx:704` through `:724`) calls `create_invoice_from_order`, which produces a draft invoice keyed off the *ordered* quantities. Then when the driver completes the delivery, the auto-invoice block in `complete_delivery` (`supabase/migrations/20260501100000_field_app_workflow_phase15.sql:208` through `:262`) sees that an active invoice already exists for the order and **skips creating one** — but the linked draft is then *patched* with the partial delivered quantities only when `delivery_id` matches (the patch loop at `:191` through `:206` requires `invoices.delivery_id = p_delivery_id`, which a manually-created `create_invoice_from_order` invoice does NOT have). Net effect: a manual `Create Invoice` clicked before delivery, followed by a partial delivery, leaves the manual invoice with the *originally-ordered* quantities while the customer was billed for less. The user has no warning that this happened. In the office this looks fine; on the customer's statement it's an over-bill.

**Evidence.**
- `src/pages/OrderDetail.tsx:811` through `:822` — Create Invoice rendered with no preflight check for an already-active invoice or for in-flight deliveries.
- `src/pages/OrderDetail.tsx:704` through `:724` — `handleCreateInvoice` calls the RPC and navigates away.
- `supabase/migrations/20260501100000_field_app_workflow_phase15.sql:191` through `:206` — partial-delivery quantity patch only fires when `invoices.delivery_id = p_delivery_id`.
- `supabase/migrations/20260501100000_field_app_workflow_phase15.sql:213` through `:218` — auto-invoice on completion is suppressed if any active invoice already exists for the order.
- `src/pages/IntegrityCleanup.tsx:376` through `:425` — the existence of an "Unbilled Deliveries" backfill section is itself evidence that this seam has historically gone wrong.

**Plain-English fix direction.** The `Create Invoice` button on Order Detail should be hidden, or at minimum demoted, when the order has any `scheduled` or `in_progress` delivery, *or* when an active (non-voided/cancelled) invoice already exists for the order. The header should display a single primary green button that reads "Create Draft Invoice (covers all delivered items)" only when there is at least one completed delivery and no active invoice, and the button should be visibly secondary in all other states. Add a banner at the top of the order page that states the next step in plain English: "Schedule a delivery", "Wait for delivery to complete", "Review draft invoice", "Post invoice", or "Record payment".

**Likely files to touch.** `src/pages/OrderDetail.tsx` (header action stack, banner), `src/components/ui/TransactionThread.tsx` (next-step messaging), no DB changes.

---

### P1-2 — The transaction thread is informational, not a workflow

**Business risk.** The transaction thread (`src/components/ui/TransactionThread.tsx:117` through `:227`) is a clever, decorative strip — but it answers "what is linked?", not "what should I do next?". When a step is missing, it renders inert grey text such as `No deliveries` (`:191` through `:194`) or `No invoices` (`:222` through `:225`), with no action button. Worse, the component bails out entirely when the count of present links is 1 or fewer (`:107` through `:108`). On a brand-new order, that means the thread vanishes, and the user is left scanning the buttons in the header — which (per P1-1) compete with each other. The user has to remember the lifecycle to know which button is correct. This is the single largest cause of "I don't know what's wrong, I just keep getting confused" friction in the pipeline.

**Evidence.**
- `src/components/ui/TransactionThread.tsx:107` through `:108` — early return when fewer than 2 entities are linked.
- `src/components/ui/TransactionThread.tsx:131` through `:135` — "No quote" inert label.
- `src/components/ui/TransactionThread.tsx:160` through `:163` — "No order" inert label.
- `src/components/ui/TransactionThread.tsx:191` through `:194` — "No deliveries" inert label.
- `src/components/ui/TransactionThread.tsx:222` through `:225` — "No invoices" inert label.
- `src/pages/OrderDetail.tsx:777` through `:786` — embedded with no next-step prop.
- `src/pages/DeliveryDetail.tsx:1431` through `:1440` — same.
- `src/pages/InvoiceDetail.tsx:705` through `:716` — same.
- `src/pages/QuoteBuilder.tsx:1349` through `:1358` — only renders if `threadOrders.length > 0` (so a brand-new quote with no order yet has no thread at all).

**Plain-English fix direction.** Promote the thread into a workflow header. Each step should be one of three states: done (linked), current (highlighted with one green action button), or upcoming (greyed). When a step is missing AND the prior step is complete, the inert `No deliveries` / `No invoices` label should become an action button (`Schedule Delivery`, `Review Draft Invoice`, `Record Payment`). Always render the thread on every detail page — never hide it because there is "nothing linked yet". On a new order with no delivery and no invoice, it should still render and show the user where they are.

**Likely files to touch.** `src/components/ui/TransactionThread.tsx`, plus the four pages that embed it (`OrderDetail.tsx`, `DeliveryDetail.tsx`, `InvoiceDetail.tsx`, `QuoteBuilder.tsx`).

---

### P1-3 — Once a partial delivery happens, the order becomes uneditable, even when items still need to be fixed

**Business risk.** The `canEdit` predicate on Order Detail (`src/pages/OrderDetail.tsx:117`) excludes any order with status `partially_fulfilled`. The instant the first delivery completes a partial drop, the user can no longer:
- correct a typo on a line that hasn't shipped yet,
- add a product the customer asked for after the first drop,
- or adjust price on an item that was wrong from the beginning.

The only way to fix the order is to cancel it (which cascades to draft invoices and inventory reversals), or to use the void path. In a real-world farm pipeline, partial deliveries are common — the office needs to be able to keep adjusting upstream lines while drivers work through the rest. The current rule is a safety overcorrection that turns into a daily annoyance.

**Evidence.**
- `src/pages/OrderDetail.tsx:117` — `canEdit = (admin || sales_rep) && status !== 'fulfilled' && status !== 'cancelled' && status !== 'partially_fulfilled'`.
- `src/pages/OrderDetail.tsx:380` through `:430` — `handleSaveEdits` calls `update_order_items` RPC.
- The Edit Order button is conditionally rendered at `src/pages/OrderDetail.tsx:801` through `:809`, gated by `canEdit`.

**Plain-English fix direction.** Allow editing on `partially_fulfilled`, but only for items whose `quantity_delivered = 0` (lines that haven't shipped yet) and for adding new lines. Items already partially delivered should be shown read-only with an explanatory tooltip ("This item has been partially delivered and cannot be edited"). This preserves the safety guarantee (no editing what's already shipped) while restoring the office's ability to keep working on the rest of the order. If that turns out to require a DB change, the simpler interim fix is to allow header-only edits (notes, customer PO, dates) on partially_fulfilled.

**Likely files to touch.** `src/pages/OrderDetail.tsx` (canEdit predicate, edit-mode item gating). May require a small `update_order_items` audit to confirm the RPC accepts edits on partially-fulfilled orders before relaxing the front-end gate.

---

### P1-4 — Recording a payment from anywhere except Invoice Detail loses the customer and invoice context

**Business risk.** The Order Detail "Record Payment" button (`src/pages/OrderDetail.tsx:988` through `:996`) navigates to `/payments` with no query string. The Payment Allocation page (`src/pages/PaymentAllocation.tsx:80` through `:189`) starts cold — no customer is preselected, no invoice list is preloaded. The user has to type the customer name into the search again, watch the typeahead populate, click the customer, and only then see the invoices they were already looking at on the order. For a sales rep posting a payment they took at the counter, this is two extra clicks and one extra search every time. Worse, if the user is colorblind or in a hurry, they can search for the wrong farm name and post the payment to the wrong customer entirely. The `InvoiceDetail` page already has the right pattern (`src/pages/InvoiceDetail.tsx:773` through `:794` — Record Payment opens an in-page modal with the balance prefilled), but it is admin-only and only accessible if the user knew to navigate to that specific invoice.

**Evidence.**
- `src/pages/OrderDetail.tsx:988` through `:996` — `navigate('/payments')` with no params.
- `src/pages/PaymentAllocation.tsx:104` through `:133` — `customerSearch` typeahead starts empty.
- `src/pages/PaymentAllocation.tsx:137` through `:171` — `fetchInvoices(customerId)` only runs after a customer is selected from the dropdown.
- `src/pages/InvoiceDetail.tsx:773` through `:794` — admin-only direct payment modal with prefilled balance.
- `src/pages/InvoiceDetail.tsx:484` through `:514` — `handlePayment` calls `record_invoice_payment` (a different RPC than `allocate_payment` used on the unified page).

**Plain-English fix direction.** Two parts. First, `/payments` should accept query params `?customer=<id>` and `?invoice=<id>` and use them to preselect the customer and pre-allocate the check amount to the named invoice — the page already has the helper functions (`selectCustomer` at `:173`, `setAllocationForInvoice` at `:195`) needed to wire this up. Second, the OrderDetail "Record Payment" button should pass the order's customer and the largest unpaid posted invoice on the order. As a stretch, copy the in-page modal pattern from InvoiceDetail to OrderDetail and the customer page so that a single-invoice payment can be recorded without leaving the page — but only after the URL-context fix has shipped.

**Likely files to touch.** `src/pages/PaymentAllocation.tsx` (read URL params on mount, prefill), `src/pages/OrderDetail.tsx` (pass params on navigate), `src/pages/CustomerDetail.tsx` (same), `src/pages/InvoiceDetail.tsx` (no change required; already correct).

---

### P1-5 — The invoice list does not lead the user to the correct creation entry point

**Business risk.** The invoice list page (`src/pages/Invoices.tsx:560` through `:590`) shows exactly one creation button: `New Field Application`. There is a code comment explaining that the standalone "New Invoice" path was removed because invoices must come from an order, blend ticket, or field-application workflow — but that rule is only visible to developers reading the file. To a user who needs to bill an order, the screen tells them nothing about *where* to start. The empty-state action (`:642` through `:644`) helpfully says "Go to Orders", but that nudge only shows up when the list is empty; on a returning user with hundreds of invoices it never appears. Meanwhile `IntegrityCleanup.tsx` carries an entire backfill flow for "Completed deliveries without invoices" (`src/pages/IntegrityCleanup.tsx:376` through `:425`), strongly suggesting that the discoverability of "where do I bill from?" has been a recurring problem.

**Evidence.**
- `src/pages/Invoices.tsx:583` through `:589` — only `New Field Application` button + comment about the rule.
- `src/pages/Invoices.tsx:639` through `:645` — empty-state nudge to Orders (only fires when the list is empty).
- `src/pages/IntegrityCleanup.tsx:376` through `:425` — manual backfill section for unbilled deliveries.
- Blend Ticket Detail provides a third invoice-creation entry point (referenced in UI/nav audit at `src/pages/BlendTicketDetail.tsx:1418`) that the invoice list doesn't acknowledge.

**Plain-English fix direction.** Replace the single `New Field Application` button with a `Create Invoice From…` dropdown that lists three options: (1) Order — opens a customer/order picker that finds confirmed orders without an active invoice, (2) Blend Ticket — opens a picker for approved blend tickets, (3) Field Application — current behavior. Below the table, add a small admin-only link "See unbilled deliveries" that deep-links into Integrity Cleanup. The accounting rule (no standalone invoices) is preserved; the user is now told where every kind of invoice begins.

**Likely files to touch.** `src/pages/Invoices.tsx`, possibly a new lightweight picker modal; no DB changes.

---

### P1-6 — Deliveries that fail to auto-invoice are only discoverable by an admin who knows about Integrity Cleanup

**Business risk.** When a delivery is completed, the auto-invoice block in `complete_delivery` skips invoice creation if any active invoice already exists for the order (`supabase/migrations/20260501100000_field_app_workflow_phase15.sql:213` through `:218`). That is normally correct, but it means that a user who completes a delivery does not always get the green "draft invoice created" toast. The Delivery Detail page only renders the "View Invoice" banner (`src/pages/DeliveryDetail.tsx:1887` through `:1906`) when `autoInvoiceId` was set on the same browser session, from the same RPC response (`src/pages/DeliveryDetail.tsx:813` through `:816`). If the user reloads, takes a different delivery on the same order, or opens an old completed delivery, **the banner is gone forever** and the user has to manually navigate to the invoice list and search by order number. There is no "Linked Invoice" card on the completed-delivery page; there are only the cross-link `relatedInvoices` shown via the transaction thread, which only works if the order is set. A delivery that was completed before Phase 15 (the auto-invoice fix) and never got an invoice will sit unbilled forever unless the admin happens to open Integrity Cleanup.

**Evidence.**
- `src/pages/DeliveryDetail.tsx:107` — `const [autoInvoiceId, setAutoInvoiceId] = useState<string | null>(null)` — never persisted, only set in-memory on a fresh completion.
- `src/pages/DeliveryDetail.tsx:813` through `:816` — `setAutoInvoiceId` set from the `complete_delivery` response only.
- `src/pages/DeliveryDetail.tsx:1887` through `:1906` — banner gated on `autoInvoiceId`.
- `src/pages/DeliveryDetail.tsx:259` through `:267` — `relatedInvoices` populated via the order link, but no top-level "Linked Invoice" card; only flows into the transaction thread.
- `src/pages/IntegrityCleanup.tsx:376` through `:425` — admin-only backfill, not surfaced to the user who completed the delivery.

**Plain-English fix direction.** On Delivery Detail, replace the in-memory `autoInvoiceId` banner with a persistent "Billing" card that always shows the linked invoice for this delivery (or its parent order). If the delivery is `completed` and there is no active invoice, the card should show a `Create Draft Invoice` button (calling `create_invoice_for_unbilled_delivery`, the same RPC the cleanup page uses) so any user can resolve the gap from the delivery they're looking at, not just admins on a separate cleanup screen. This brings the recovery flow to the place the problem becomes visible.

**Likely files to touch.** `src/pages/DeliveryDetail.tsx` (new persistent billing card), no DB changes (the backfill RPC already exists).

---

### P1-7 — The "order confirmed" customer email is wired to a transition that never happens

**Business risk.** Inside `executeStatusChange` on Order Detail, there is a 60-line block that builds and sends a customer-facing "Order Confirmed" email when the new status is `confirmed` (`src/pages/OrderDetail.tsx:512` through `:578`). Orders, however, are **born** in the `confirmed` state — both `create_direct_order` and `convert_quote_to_order` insert orders directly as `confirmed` (the `Status transitions` documented in `docs/workflows/QUOTE_TO_DELIVERY.md:70` start *at* `confirmed`). The only way to reach this code path is for an admin to manually change a `confirmed` order back to some other state and then back to `confirmed` — a path which is also blocked because the validTransitions table at `src/pages/OrderDetail.tsx:489` through `:493` does not allow any transition that targets `confirmed`. Net effect: this email never fires for a normal customer, no matter how many orders are placed. The team thinks they have an order-confirmation email; customers never receive it. This is a quiet defect that has likely existed for months.

**Evidence.**
- `src/pages/OrderDetail.tsx:489` through `:493` — `validTransitions = { confirmed: ['cancelled'], partially_fulfilled: ['cancelled'] }` — no path *to* `confirmed`.
- `src/pages/OrderDetail.tsx:512` through `:578` — entire email block gated on `targetStatus === 'confirmed'`.
- `docs/workflows/QUOTE_TO_DELIVERY.md:70` through `:77` — order lifecycle starts at `confirmed`.
- `src/pages/QuoteBuilder.tsx:1287` — convert flow navigates to the new order after creation; no email sent here either.
- `src/pages/NewOrder.tsx` (skim of header — no email send on creation).

**Plain-English fix direction.** Either remove the dead email block (and admit the app does not email customers when an order is created), or wire the email to the actual moment of creation — at the end of `convert_quote_to_order` and at the end of `create_direct_order` (call sites in `src/pages/QuoteBuilder.tsx:1287` and `src/pages/NewOrder.tsx`). The simplest version is a small post-creation email helper called from both navigation points, with the same idempotency-key pattern used elsewhere. Decide first whether the team *wants* this email — if not, the dead block should still be deleted because it's a future maintenance trap.

**Likely files to touch.** `src/pages/OrderDetail.tsx` (delete or move), `src/pages/QuoteBuilder.tsx` and `src/pages/NewOrder.tsx` (call site), `src/lib/emailService.ts` (helper extraction), no DB changes.

---

### P1-8 — `Schedule Delivery` does not warn when a delivery already exists or when nothing is left to deliver

**Business risk.** The Schedule Delivery button on Order Detail (`src/pages/OrderDetail.tsx:823` through `:831`) is rendered any time the order is not `cancelled` or `fulfilled`. It does not check whether a `scheduled` or `in_progress` delivery already exists, nor whether any items have remaining quantity > 0. There is an "Active deliveries" banner above it (`:864` through `:894`) that lists active deliveries, but the user can still click Schedule Delivery and create a second one in parallel. `NewDelivery` (`src/pages/NewDelivery.tsx:106` onward) has logic to check available quantities, but only after the user selects an order — so the user has already navigated away from the order they were on. If the user accidentally creates a second scheduled delivery for the same lines, the `edit_delivery` flow's per-delivery max-quantity math (`src/pages/DeliveryDetail.tsx:412` through `:434`) handles the duplication, but the customer/driver UX of "two delivery numbers covering the same products" is confusing and avoidable.

**Evidence.**
- `src/pages/OrderDetail.tsx:823` through `:831` — Schedule Delivery button with no preflight.
- `src/pages/OrderDetail.tsx:864` through `:894` — "Active deliveries" banner — informational only, doesn't block.
- `src/pages/NewDelivery.tsx:106` through `:120` — `fetchOrderDetails` runs *after* navigation, not before.

**Plain-English fix direction.** When the order has any items still un-delivered, show one green Schedule Delivery button. When all items have `quantity_remaining = 0` and there is no active delivery, hide the button and show "All items delivered." When there is already an active scheduled delivery, demote the button to secondary and add a confirm prompt: "An active delivery already exists for this order. Create a second delivery anyway?" — same pattern used by the duplicate-order check in `QuoteBuilder` (`src/pages/QuoteBuilder.tsx:1218` through `:1224`).

**Likely files to touch.** `src/pages/OrderDetail.tsx` (button gating), no DB changes.

---

### P1-9 — Posting an invoice does not propose the next step (record payment, send statement)

**Business risk.** When the user successfully posts an invoice (`src/pages/InvoiceDetail.tsx:428` through `:459`), the page just refreshes via `fetchInvoice(id!)` and shows a `success` toast. The header now shows three new buttons: Record Payment, Write Off, Void (`:773` through `:799`) — but the user is given no nudge about which one is normal next. For a sales rep who has just posted an invoice for a paying customer, the natural next step is to record the payment they took at the counter; for an admin posting in a batch, the natural next step is to email the invoice. Neither is offered. Compounding this: Record Payment and Email are *admin-only* (`:773` and `:762`), so a sales rep who just posted is shown nothing at all. They have to know that they need to navigate to /payments, find the customer, find the invoice they just posted, and record from there — see P1-4.

**Evidence.**
- `src/pages/InvoiceDetail.tsx:447` through `:451` — post handler refreshes the page but does not propose a next action.
- `src/pages/InvoiceDetail.tsx:761` through `:799` — header action stack post-post; Record Payment / Email are `isAdmin` only.
- `src/pages/InvoiceDetail.tsx:72` — `isAdmin = profile?.role === 'admin'`.
- `src/pages/PaymentAllocation.tsx:1` through `:11` — header docstring confirms `/payments` is the *sole* payment entry point ("AR Single Source of Truth").

**Plain-English fix direction.** After post succeeds, replace the toast with a one-line green confirmation banner directly under the header: "Invoice posted. Record payment now • Email customer • Done." (Buttons inline.) The sales-rep role should at minimum see a `Record Payment` link that navigates to `/payments?invoice=<id>` (which P1-4 wires up). For admins, also surface `Email Customer`. Drop "Done" once enough users have learned the flow.

**Likely files to touch.** `src/pages/InvoiceDetail.tsx`, no DB changes.

---

### P1-10 — Quote Detail does not show the customer's open AR or recent activity at the moment of conversion

**Business risk.** `executeConvertToOrder` (`src/pages/QuoteBuilder.tsx:1231` through `:1310`) does run a credit-limit RPC *after* the order is created (`:1271` through `:1283`) and pops a non-blocking toast warning if the customer is over their limit. By that point the order is already created, inventory is already prebooked, commissions are already written, and the user is one navigate call away from the new order page. The quote builder header itself (`:1390` through `:1487`) does not show the customer's current AR, recent payment activity, or whether their last few invoices are paid. A sales rep about to convert a $40k program for a customer who is six months overdue on $80k of prior AR will not know unless they happened to open Customer Detail in another tab first. This is the single highest-leverage place to *prevent* a credit problem rather than detect it after the fact.

**Evidence.**
- `src/pages/QuoteBuilder.tsx:1271` through `:1283` — credit-limit check is *after* order creation.
- `src/pages/QuoteBuilder.tsx:1271` — uses RPC `check_customer_credit_limit`, which already exists.
- `src/pages/QuoteBuilder.tsx:1449` through `:1461` — Convert to Order button rendered with no AR context.
- `src/pages/QuoteBuilder.tsx:2400` through `:2425` — confirm-convert modal opens but does not surface AR.
- `src/pages/OrderDetail.tsx:973` through `:998` — the same kind of AR summary already exists for an order; the Quote screen is missing it.

**Plain-English fix direction.** When the user opens a quote with a real (selected) customer, fetch the customer's open AR and the last 3 invoice statuses in the same query that loads the customer record. Show a small "Customer Account" panel in the quote header: balance due, days oldest, last payment date. If the credit-limit RPC says the limit is exceeded, color the panel red and show a one-line warning above the Convert button — *before* the modal — so the rep can pause to ask the customer about the open balance. The credit RPC is already run; just move the call earlier and surface the result.

**Likely files to touch.** `src/pages/QuoteBuilder.tsx` (header panel + earlier credit check), no DB changes.

---

## What's Already Working (Keep These)

These pieces of the pipeline are sound and should be preserved as later phases iterate:

- **`complete_delivery` is atomic and idempotent.** The RPC handles inventory deduction, order-status roll-up, remainder creation, partial-quantity patching of pre-existing draft invoices, and auto-creation of a fresh draft invoice — all in one transaction (`supabase/migrations/20260501100000_field_app_workflow_phase15.sql:170` through `:293`).
- **Invoice posting is period-aware.** `post_invoice` calls `check_period_open()` and rejects backdated transactions (referenced in `CLAUDE.md` business-logic rules).
- **Group posting for split invoices.** `InvoiceDetail.handlePost` correctly routes through `post_invoice_group` when `invoice.invoice_group_id` is set, so a multi-customer field-app invoice cannot be half-posted (`src/pages/InvoiceDetail.tsx:438` through `:448`).
- **Cancel cascades are well-summarized.** Cancelling an order returns a structured result and the UI tells the user exactly what happened — holds released, draft invoices cancelled, posted invoices flagged for admin (`src/pages/OrderDetail.tsx:475` through `:485`).
- **Delivery items lock at the right moment.** `scheduled` is editable; `in_progress` and beyond are locked with a clear "Items are locked while delivery is in progress" banner (`src/pages/DeliveryDetail.tsx:1729` through `:1746`).
- **AR is derived, not stored.** OrderDetail computes `totalInvoiced`, `totalPaid`, and `balanceDue` from linked invoices each render (`src/pages/OrderDetail.tsx:752` through `:758`); the comment on `:752` correctly warns "AR derived from invoices (single source of truth — never use order.total_paid / balance_due)". This is the right architecture and matches the dropped-columns note in `CLAUDE.md`.
- **Idempotency keys are everywhere they need to be.** Every mutating RPC the audit touched accepts and uses an idempotency key (`useIdempotencyKey` hook references at `src/pages/OrderDetail.tsx:56` through `:59`, `src/pages/DeliveryDetail.tsx:75` through `:81`, `src/pages/InvoiceDetail.tsx:73` through `:77`).
- **The InvoiceDetail in-page payment modal is the gold standard.** `src/pages/InvoiceDetail.tsx:1241` through `:1270` — preserves customer + invoice + balance context. The rest of the app should converge on this pattern (see P1-4).
- **IntegrityCleanup exists at all.** Most apps don't have a dedicated screen for "things that should not exist". The fact that CRX has one (`src/pages/IntegrityCleanup.tsx:38` through `:428`) is a sign the team takes integrity seriously. The fix direction in P1-1 / P1-6 is to make those gaps fewer, not to remove the cleanup screen.

---

## Open Questions for Mason

Decisions only the owner can make. None blocks Phase 1 implementation, but each one shapes the fix.

1. **Order-confirmed customer email (P1-7).** Do you actually want an email to go to customers at the moment an order is created? If yes, we should wire it correctly. If no, we should delete the dead block. Either way, today no customer ever receives it.
2. **Editing partially-fulfilled orders (P1-3).** Are you comfortable allowing edits to *un-shipped* lines on a partially-fulfilled order? If yes, this is a small UI change. If no, we need a different escape hatch (e.g., an admin-only "Force Edit" with a reason field).
3. **Auto-record payment on delivery completion?** Today the cycle is: complete delivery → auto-create draft invoice → admin posts invoice → user records payment. Some farm-supply ops collect a check on delivery; do you want a "Record payment as part of completion" hook on Delivery Detail? (This is bigger than Phase 1 — flag for Phase 3 if yes.)
4. **Two payment paths.** Today `/payments` allows admin + sales_rep, while the InvoiceDetail "Record Payment" modal is admin-only (`src/pages/InvoiceDetail.tsx:773`). Should sales reps be able to record a payment directly from an invoice they just posted (P1-9)? The role split feels accidental.
5. **Should the invoice list's `Create Invoice From…` menu (P1-5) include a "From Quick Delivery" entry?** Quick Deliveries already create their own draft invoice atomically (`docs/workflows/QUOTE_TO_DELIVERY.md:212` through `:227`); listing it there could be confusing — but it would also acknowledge the path exists.

---

## Recommended Fix Order Within Phase 1

In approximate order of "least risk per unit of business value":

1. **P1-7 (delete or wire up order-confirmed email).** Tiny scope, removes a quiet defect, decision is binary.
2. **P1-4 (preserve customer/invoice context on Record Payment).** Small URL-param change, removes daily friction, reuses existing functions.
3. **P1-2 (turn TransactionThread into a workflow header).** Higher visibility win; component is self-contained; no DB or RPC changes needed.
4. **P1-1 (gate `Create Invoice` on Order Detail).** Prevents the one genuinely dangerous double-billing seam. Pairs naturally with the P1-2 work.
5. **P1-8 (gate `Schedule Delivery` on Order Detail).** Same kind of fix as P1-1; once #4 is done, doing this one is mostly the same pattern again.
6. **P1-6 (persistent linked-invoice card on Delivery Detail).** Surfaces the invoice for old completions and reuses the existing backfill RPC.
7. **P1-9 (post-invoice next-step banner).** Nice-to-have, depends on P1-4 being shipped first to be truly useful for sales reps.
8. **P1-5 (`Create Invoice From…` dropdown).** Discoverability win; small but visible.
9. **P1-3 (allow edits to un-shipped lines on partially_fulfilled orders).** Highest user value of any item here, but the safest implementation may need a Phase 6 permissions discussion first.
10. **P1-10 (AR/credit panel in QuoteBuilder before convert).** Best left until after P1-2 settles, because the workflow header (P1-2) is the natural place to surface this.

If only two items get implemented, do P1-7 and P1-4 — they are the lowest risk and fix the most-felt friction. If only one finding is acted on, do P1-1 — it's the only one that protects the books.

---

*End of Phase 1. Phase 2 (Field Application) follows in a separate file.*
