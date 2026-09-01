## 2026-08-26 — Return credits reverse recognized COGS in the current season

Rebuilt the parked PR #361 accounting repair as an ordered six-migration chain above the current
production and merged-migration high-water marks (`20260827041000` through `20260827041500`). The
reporting migration aligns invoice-basis P&L, monthly reporting, and customer year-end summaries on
paid, overdue, and posted invoices. The COGS migration creates negative-cost return-credit lines from
the exact historical source-invoice cost already recognized by those reports and assigns that reversal
to the season for the America/Chicago business date at issuance time, while customer prior-year reporting remains on the original invoice
season. The return-credit period check, invoice date, due date, and crop season all share that same
Chicago business date, including the hours between UTC midnight and local midnight.

Cached `unapply_credit_memo` retries revalidate authentication, exact actor binding,
active-admin authorization, and the required reason before returning the financial result.

Invoice-basis P&L and monthly COGS now round each ordinary sale line to whole cents before summing.
That is a deliberate reporting change: it makes the report basis exactly match the return allocator's
whole-cent ceiling, so a return cannot reverse more than the report recognized. Reprinting a period
with fractional-quantity invoice lines can therefore differ by a cent from an older copy. The posted
return-credit detail view uses the stored, penny-exact COGS header as well, so grouped fractional lines
cannot introduce a one-cent display mismatch. Year-end
financial access is also tightened: admins can read every customer, while sales reps can read only
customers assigned to them; batch discovery pages and chunks both invoice and assignment reads.

The allocator now orders source lots by the immutable `(created_at, line id)` tuple, not a backdateable
invoice date; the line id is the explicit stable tiebreaker when one transaction gives several lines the
same timestamp. Each generated return-credit line points to the exact original invoice line it consumed
and stores its exact extended COGS in whole cents. The source-recognition guard now follows that exact
line link, so a credit funded by one split invoice cannot freeze date, status, or deletion corrections
on another invoice that happens to share the same order line, product, and unit. A cumulative
cost-bucket cap aborts if those stored reversals would exceed what the recognized source lines reported.
The rollback smoke proves a later-created, backdated same-cost lot lands at 251 + 375 = 626 cents and
mutation-tests both the stable ordering and the cap against the former 627-cent over-reversal.

Usable returned product is restored transactionally to Main Warehouse, including creation of a missing
inventory row. The warehouse stock unit must match the return source; the one pinned legacy RMA that
records 15 containers as `ea` uses the product's authoritative 2.5-gallon container size and restores
exactly 37.5 gallons. Every other unit mismatch fails closed. Credit memos never count as sale billing coverage or create fresh delivery allocation;
the delivery, dashboard, and order invoice gates all use the same active, non-deleted, non-credit
intersection. Void and unapply wrappers clear their narrow trigger-bypass settings on both success and
failure before rethrowing an error.

The unapply wrapper now acquires its idempotency-key lock before it delegates any state change, so
concurrent retries with the same key serialize before accounts-receivable or return state can move.

Damaged or otherwise non-restocked returns still reverse the customer's revenue but intentionally
reverse zero COGS because no saleable inventory value returned. Batch year-end customer discovery now
paginates through every recognized invoice, so the API's per-response row cap cannot silently omit a
customer from the run.

Apply warning: the quote-version trust migration must be live first. The first return-credit file then
intentionally freezes credit issuance; every dependent file verifies that exact barrier, and only the
sixth removes it after the durable invoice-lineage writer passes postflight. If any file fails, returns
remain fail-closed and an engineer must repair the reported drift and rerun from that file.
Rerun the 29 read-only PR #361 predicates, including the open-restock unit query, inside that same
maintenance window and stop before the first return-credit file if any new unhandled row appears.

The general Invoice Detail writer's pre-existing loss of `invoice_items.order_item_id` is closed by the
sixth candidate: existing generated lines return their ids, server validation refuses removal or source
identity substitution, and the wrapper restores the server-held id, order link, historical cost,
creation order, and delivery provenance after the legacy rewrite. Merge remains safe because these
migrations do nothing until separately applied.

The same final candidate now reverses received-return inventory once per product, using the combined
persisted restock quantity from every return line. If two order lines return the same product after some
of that stock has been consumed, cancellation fails closed against the one locked inventory balance
instead of letting each line reuse a stale pre-update balance and drive inventory negative.

No migration was applied to production by this repository change. The fresh read-only production
schema passed the disposable PostgreSQL proof, including an edit -> post -> return lineage case, an equal-timestamp source-line case, same-product cancellation after partial stock consumption, and a mutant that removes the open-return
warehouse-unit preflight; the run ended in `SMOKE_PASS_ROLLBACK` with zero residue. A 2026-08-27 live
read found one open restock row, exactly the pinned legacy RMA above, and zero unhandled warehouse-unit
mismatches. Exact-SHA adversarial reviews, the governed migration review, and a fresh live ledger
high-water check remain required before the separately approved live apply.
