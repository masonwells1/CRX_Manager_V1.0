## 2026-08-26 — Return credits reverse recognized COGS in the current season

Rebuilt the parked PR #361 accounting repair as an ordered five-migration chain above the current
production and merged-migration high-water marks (`20260827041000` through `20260827041400`). The
reporting migration aligns invoice-basis P&L, monthly reporting, and customer year-end summaries on
paid, overdue, and posted invoices. The COGS migration creates negative-cost return-credit lines from
the exact historical source-invoice cost already recognized by those reports and assigns that reversal
to `current_season()` (2026 today), while customer prior-year reporting remains on the original invoice
season.

Usable returned product is restored transactionally to Main Warehouse, including creation of a missing
inventory row. Credit memos never count as sale billing coverage or create fresh delivery allocation;
the delivery, dashboard, and order invoice gates all use the same active, non-deleted, non-credit
intersection. Void and unapply wrappers clear their narrow trigger-bypass settings on both success and
failure before rethrowing an error.

Damaged or otherwise non-restocked returns still reverse the customer's revenue but intentionally
reverse zero COGS because no saleable inventory value returned. Batch year-end customer discovery now
paginates through every recognized invoice, so the API's per-response row cap cannot silently omit a
customer from the run.

No migration was applied to production by this repository change. The fresh read-only production
schema must pass the 46-signal disposable PostgreSQL proof, exact-SHA adversarial reviews, the governed
migration review, and a fresh live ledger high-water check before the separately approved live apply.
