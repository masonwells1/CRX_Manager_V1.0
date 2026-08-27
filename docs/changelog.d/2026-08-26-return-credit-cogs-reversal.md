## 2026-08-26 — Return credits reverse recognized COGS in the current season

Rebuilt the parked PR #361 accounting repair as an ordered five-migration chain above the current
production and merged-migration high-water marks (`20260827041000` through `20260827041400`). The
reporting migration aligns invoice-basis P&L, monthly reporting, and customer year-end summaries on
paid, overdue, and posted invoices. The COGS migration creates negative-cost return-credit lines from
the exact historical source-invoice cost already recognized by those reports and assigns that reversal
to `current_season()` (2026 today), while customer prior-year reporting remains on the original invoice
season.

Invoice-basis P&L and monthly COGS now round each ordinary sale line to whole cents before summing.
That is a deliberate reporting change: it makes the report basis exactly match the return allocator's
whole-cent ceiling, so a return cannot reverse more than the report recognized. Reprinting a period
with fractional-quantity invoice lines can therefore differ by a cent from an older copy. Year-end
financial access is also tightened: admins can read every customer, while sales reps can read only
customers assigned to them; batch discovery pages and chunks both invoice and assignment reads.

Usable returned product is restored transactionally to Main Warehouse, including creation of a missing
inventory row. The warehouse stock unit must match the return source; the one pinned legacy RMA that
records 15 containers as `ea` uses the product's authoritative 2.5-gallon container size and restores
exactly 37.5 gallons. Every other unit mismatch fails closed. Credit memos never count as sale billing coverage or create fresh delivery allocation;
the delivery, dashboard, and order invoice gates all use the same active, non-deleted, non-credit
intersection. Void and unapply wrappers clear their narrow trigger-bypass settings on both success and
failure before rethrowing an error.

Damaged or otherwise non-restocked returns still reverse the customer's revenue but intentionally
reverse zero COGS because no saleable inventory value returned. Batch year-end customer discovery now
paginates through every recognized invoice, so the API's per-response row cap cannot silently omit a
customer from the run.

Apply warning: the quote-version trust migration must be live first. The first return-credit file then
intentionally freezes credit issuance until the second succeeds; if the second fails, returns remain
fail-closed and an engineer must repair the reported drift and rerun it before credits resume.

No migration was applied to production by this repository change. The fresh read-only production
schema must pass the 50-signal disposable PostgreSQL proof, exact-SHA adversarial reviews, the governed
migration review, and a fresh live ledger high-water check before the separately approved live apply.
