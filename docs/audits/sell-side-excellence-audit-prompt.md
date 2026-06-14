# Sell-Side Excellence Audit Prompt — CRX Manager V1.0 (Quote → Order → Invoice → Payment)

**For:** A fresh Claude Code session in this repo (full read tools + read-only Supabase MCP + web search).
Also usable by Codex or any reviewer with repo + read-only live-DB access (skip web research if unavailable; say so in the report).
**Repo:** https://github.com/masonwells1/CRX_Manager_V1.0 (branch `main`).
**Supabase project ref:** `rhyzpcqhnizqbxphqdkr` (**read-only access only**).
**Output:** write the report to `docs/audits/<today>-sell-side-excellence-audit.md`.

**Your job:** CRX Manager is a live ag-retail ERP (chemicals/fertilizer sales to farms). Mason (non-coder, sole owner) wants the **sell side** — quote → order → delivery → invoice → payment — to be **the best in ag retail software**. Produce an evidence-based gap-and-weakness analysis of the sell-side workflow, benchmark it against the major ag retail systems, and end with a **ranked roadmap of high-impact improvements**, each with a short spec sketch Mason can hand to `/ship`.

This is **analysis + design direction, not implementation.** You produce a report. You change nothing.

---

## The business reality this must serve (weight everything against this)

1. **Season-long booking.** A farmer gets quoted a season's worth of product (often multi-field, multi-product). Through the season they call in and take *portions* of it — "send 200 of my 500 gallons to the north farm." Today the system can only convert a quote whole, once. **Mason's target model: a quote acts as an open booking — pick any lines AND partial quantities into an order, quote stays open and convertible repeatedly until drawn down (or expires/season ends).** Treat this as a fixed requirement to design around, not an open question.
2. **Speed under pressure.** Orders sometimes ship **within an hour** of the call. The person answering may be warehouse staff, not a salesperson. **Mason's target model: any authorized staff can create an order with just customer + products + quantities and get it shipped; pricing is filled in later by a sales rep/admin; the invoice CANNOT be posted until priced; reps see a "needs pricing" queue.** Also fixed — design around it (but DO flag risks, e.g. unpriced orders aging out, period-close interactions, inventory effects).
3. **Non-experts use it.** Drivers, warehouse staff, and seasonal help touch this flow. Every screen in the hot path should be judged for "can a non-salesman do this in under a minute without breaking money data?"
4. **Money correctness is sacred.** Cents-only bigint, `financial_audit_log` append-only, period close, idempotency, strict-actor auth. Any proposed feature must state how it preserves these.

---

## Absolute rules (do not violate)

1. **READ-ONLY. #1 rule.** Allowed: `Read`, `Grep`, `Glob`, read-only subagents, read-only Supabase MCP (`list_tables`, `list_migrations`, `execute_sql` with SELECT only), web search/fetch. Forbidden: editing/creating ANY file except the one report; `apply_migration`; any INSERT/UPDATE/DELETE/DDL; git commits; mutating Bash. Unsure whether an action writes? **Don't do it.**
2. **Evidence or it doesn't count.** Internal findings cite `file:line`, RPC name, or migration filename. Competitor claims cite the URL/source and get marked **[verified]** (vendor docs/screenshots/help center) or **[inferred]** (marketing copy, reviews). Never present an inferred competitor capability as fact.
3. **Verify the live DB, don't trust docs.** This repo's own audits proved docs and even migration files drift from live. For any RPC behavior you lean on, check the live definition (`pg_get_functiondef` via read-only SELECT) — not just the disk migration.
4. **Impact-ranked, not exhaustive.** The deliverable is "the 5–10 changes that most move the needle toward best-in-class," not a 60-item nitpick list. Park minor findings in an appendix.
5. **Respect what's already hardened.** RLS/security, performance advisors, and the 2026-06-09 foundation-audit fixes are done — do not re-audit them. If a *new* severe issue falls out of this analysis, report it, but security re-review is not the mission.
6. **Exclude `node_modules/` and `.claude/worktrees/` from ALL searches.**

---

## Verified starting facts (from a 2026-06-10 capability survey — re-verify anything you build on)

- `convert_quote_to_order` (latest disk definition: migration `20260513020000`; redefined many times since `20260320100000`): whole-quote only — processes ALL `quote_items` for the quote, no subset/quantity selection; quote → `accepted`; if already accepted, returns the existing order. One quote → max one order. admin/sales_rep only.
- `create_direct_order` (latest disk definition: migration `20260513030000`): `price_per_unit` mandatory per item; status `confirmed` on create; admin/sales_rep only.
- `create_quick_delivery` (rewritten in migration `20260512000000`): atomic order + delivery + draft invoice; **server-side tier pricing only — client-supplied `price_cents` is deliberately IGNORED** (audit fix #8), price always comes from the customer's assigned tier. So even the fastest path cannot take a custom price at entry.
- These RPCs each have 15–25 disk redefinitions; the live DB is the only authority (rule 3) — `pg_get_functiondef` before relying on any behavior detail.
- Quotes already have: **sections** (per-field), **versioning** (`create_quote_version`/`restore_quote_version`), **templates**, **planned quotes with inventory holds**, **quote→job** (`create_job_from_quote_section`).
- Invoicing: per-delivery (`create_invoice_from_delivery` invoices delivered qty only → partial invoicing across multiple deliveries works), customer statements, credit memos, prepay credits with auto/batch application, payment allocation page (admin + sales_rep).
- Known absent: partial quote conversion; price-later/TBD pricing; backorder tracking; customer-facing quote portal / e-signature; contract or booking-level pricing beyond the 3-tier product pricing; formal seasonal prepay-booking program tie-in.
- Lifecycles (enforced by triggers): Quote `draft → sent ⇄ revised → accepted/declined/expired/cancelled`; Order `confirmed → partially_fulfilled → fulfilled` (+cancel/void); Invoice `draft → unposted → posted → paid/overdue` (+void/cancel); `check_period_open()` gates posting.

---

## Method — four phases

### Phase 1 — Ground (map the real current flow)
Trace the sell pipeline end-to-end in code + live DB. Produce a written flow map (inline in the report appendix): every page, RPC, status transition, and role gate from "customer calls" to "payment allocated." Pay special attention to:
- every entry point that creates an order (quote conversion, NewOrder, quick delivery, blend-ticket→invoice, job→invoice) and what each requires;
- where quantity vs. price vs. inventory commitments happen in each path;
- what happens TODAY when someone tries Mason's two scenarios (partial draw-down; unpriced rush order) — document the exact failure/workaround.

### Phase 2 — Benchmark (parallel research subagents)
Dispatch **read-only research subagents in a single message**, one per competitor: **Agvance (SSI)**, **AgVantage EDGE**, **Merchant Ag**, **AgWorks (EFC Systems)** — plus one wildcard agent for "anything else notable in ag retail order/booking workflows" (e.g. Levridge, Greenstone/AGRIS). Each returns a structured capability sheet for: quote/proposal handling, **season bookings & partial draw-down**, fast/counter order entry, price-later or deferred pricing, prepay programs tied to bookings, invoicing models, grower-facing portals/e-sign, and anything clearly best-in-class. Mark every claim [verified]/[inferred] with source.

### Phase 3 — Gap analysis (where CRX loses, ties, or wins)
Merge Phase 1 + 2 into a capability matrix: rows = sell-side capabilities, columns = CRX / each competitor. For each gap, judge **impact for Mason's actual business** (booking-style ag sales, rush logistics, small staff) — not feature-checklist completeness. Also do a **weakness pass on what exists**: friction (clicks/screens for the hot paths), failure modes (double-entry, dead ends, statuses users get stuck in), and data-integrity risks in order+invoice edit/void/reverse paths.

### Phase 4 — Roadmap (the deliverable)
Rank the top 5–10 improvements by impact. For each, a **spec sketch** (½–1 page): what it does, the user story in Mason's words, rough data-model direction (tables/columns/statuses touched — respect existing lifecycles and the trigger enforcers), which existing RPCs/pages change vs. new, how it preserves the money invariants (cents, audit log, idempotency, period close, strict-actor), effort (S/M/L), risk-to-build, and what to ship first if split into stages. **Items #1 and #2 are pre-decided**: (1) partial quote→order draw-down per the model above; (2) ship-now/price-later per the model above — for these two, go deepest: design the status/quantity-accounting model (e.g. quote_items quantity_converted tracking; an order/invoice `pending_pricing` gate before `unposted→posted`), and call out the hard edges (inventory holds vs. draw-down, tier-price changes mid-season, who may price, period close with unpriced work, partial-draw + voids).

---

## Report format (`docs/audits/<today>-sell-side-excellence-audit.md`)

Written **for Mason first** — plain English up top.

1. **Executive summary** — where CRX's sell side stands vs. the ag-retail field in one paragraph; the 3 changes that matter most and why.
2. **Capability matrix** — CRX vs. competitors, ✓ / partial / ✗ per capability, with the "so what" column.
3. **Gap findings** — `[impact High/Med/Low][effort S/M/L][risk]` Title — evidence — why it matters for Mason's business — competitor reference.
4. **Weakness findings on existing flow** — same format, citing `file:line`/RPC.
5. **Ranked roadmap with spec sketches** (Phase 4 output). #1 partial draw-down, #2 price-later, then the rest by impact.
6. **Appendix** — Phase-1 flow map; competitor source list with [verified]/[inferred] tags; parked minor findings.

## Final reminder
Best-in-the-world is judged by Mason's reality: season bookings drawn down over months, and a rush order shipping an hour after the call, entered by whoever picked up the phone — with the money side staying bulletproof. Depth on the two anchor features beats breadth everywhere else.
