# Theme synthesis — CRM-UX lens

**Date:** 2026-06-19
**Synthesizer:** THEME SYNTHESIZER (CRM-UX lens)
**Inputs:** 10 raw "CRM-UX" candidates scouted from 6 repos (frappe/erpnext, twentyhq/twenty, microsoft/farmvibes-ai, ekylibre/ekylibre, LiteFarmOrg/LiteFarm, farmOS/farmOS).
**Job:** dedup overlapping ideas into a clean, ranked set for CRX Manager (an ag-retail **dealer** platform), weighted toward CRX's named gaps; kill grower-only noise.

---

## How the raw 10 collapsed (dedup map)

The single biggest signal: **three different mature systems independently model the exact same thing** — a pre-quote sales pipeline (Lead → Opportunity, data-driven Stage, probability, weighted forecast). That is CRX's loudest named CRM gap, so it becomes candidate #1 and absorbs the duplicates.

| Raw candidate (repo) | Disposition |
|---|---|
| CRM sales pipeline / Opportunity + Sales Stage (erpnext) | **MERGED → #1** (canonical shape: data-driven stage, probability, expected_closing, line items, lost_reasons) |
| Sales pipeline / opportunity board (twenty) | **MERGED → #1** (Kanban board UX, owner, drag `position`) |
| Affair: deal-netting w/ probability_pct (ekylibre) | **SPLIT:** the `probability_pct` + deal-state half **→ #1**; the "one balanced AR view across quote/order/invoice/payment/credit" half **→ #2** (the timeline/360 view). Not a standalone top candidate. |
| Kanban `position`-ordering pattern (twenty) | **FOLDED into #1** as the standard ordering technique (fractional/gap-renumber). Too small to stand alone; also reusable in dispatch/task ordering. |
| Polymorphic activity timeline (twenty) | **KEPT → #2** (the "activity half" of a CRM; distinct from the pipeline). |
| Notes & tasks attachable to any record (twenty) + Task system w/ typed sub-tasks (litefarm) | **MERGED → #3** (rep follow-up workflow: tasks + notes via a polymorphic link table; litefarm confirms the one-parent-task + assignee/due/abandon-reason lifecycle). |
| Per-object duplicate-detection criteria (twenty) | **KEPT → #4** (small, standalone, real ag pain: duplicate farm records across reps). |
| Flags (code) vs Categories (user) triage layer (farmOS) | **FOLDED into #3** (a worklist needs a "Priority / Needs-review / Monitor" axis; ship it as flags on tasks/customers rather than a separate engine). |
| Seasonal-field crop-plan & practice-event model (farmvibes, **MIT**) + Plan + Plan-Record planned-vs-actual (farmOS) | **MERGED → #5** (a season-scoped grower **program** with target-vs-actual variance; farmvibes is MIT so its dataclass shape may be lifted, not just idea'd). |

Net: **10 raw → 5 deduped candidates.**

---

## License posture (applies throughout)

Every source repo except farmvibes is **strong copyleft** (twenty AGPL-3.0 w/ Enterprise carve-out, erpnext GPL-3.0, ekylibre AGPL-3.0, farmOS GPL-2.0, LiteFarm GPL). CRX is hosted SaaS, so AGPL's network-use trigger applies — **borrow IDEAS / DATA-MODEL SHAPES / FORMULAS only, clean-room re-implemented on Supabase + React. Lift NO source.** The CRM data model (Company→customer, Person→contact, Opportunity→season booking) is a generic, decades-old shape — re-implementing it independently is safe. **Exception: microsoft/farmvibes-ai is MIT**, so its `SeasonalFieldInformation` dataclass shape (#5) may be copied with attribution.

---

## Deduped, ranked candidate set

### 1. CRM sales pipeline — Opportunity board with data-driven Stages + weighted forecast  ·  relevance 5 · effort M
**CRX has:** customers (farms, credit, prepay) and a quote→order→delivery→invoice flow, but **nothing before the quote** — no lead/opportunity, no stage, no probability, no forecast. A "what deals are we working and what will they close at" view does not exist.
**Best repo does:** erpnext and twenty both model `Opportunity` with a **Sales Stage stored as data (not a hard-coded enum)**, `probability %`, `expected_closing`, `amount`, an `owner`, `lost_reasons`/`competitors`, optional line items, and (twenty) a `position` int for drag-ordering within a Kanban stage. ekylibre's `Affair` adds the same `probability_percentage` on its deal header.
**The idea we'd build:** a `sales_opportunities` table keyed to `customer_id` — `name`, `stage_id` (FK to a small admin-editable `sales_stages` config table, not a CHECK enum), `probability` (0–100), `expected_close_date`, `amount_cents bigint`, `owner` (sales_rep), `lost_reason`, `position` int, `source_quote_id` nullable. Optional `opportunity_items`. RLS so reps see their own pipeline, admin sees all. A React **Kanban-by-stage** page with drag-between-columns (using the fractional `position` technique: insert between A,B = (posA+posB)/2, periodic gap-renumber), a **weighted-pipeline report** (Σ amount×probability by stage/month), and a "convert to quote" action that hands off to CRX's existing convert path. On "won," kick off the quote flow; on "lost," capture `lost_reason`.
**Effort: M.** **Risk:** medium — net-new subsystem (table + RLS + page + report), but additive and isolated from the money/lifecycle core; no migration to existing financial tables. Keep stages admin-only-editable to avoid enum drift. **License:** AGPL/GPL — clean-room data-model only.
**Source repos:** twentyhq/twenty, frappe/erpnext, ekylibre/ekylibre.

### 2. Customer 360 activity timeline (unified, human-readable feed)  ·  relevance 4 · effort M
**CRX has:** `activityLogger` + an append-only `financial_audit_log`, but **no per-customer human-readable timeline UI**. A rep can't see "last 90 days of this farm: quotes, deliveries, payments, calls" in one stream, and AR is stitched by joins each time.
**Best repo does:** twenty's `timeline-activity` is one feed table — `happens_at`, `name`, a free-form `properties` jsonb, a cached linked-record name, and a `target*` FK per first-class object — producing one chronological "what happened to this record" stream that mixes system events, notes, and tasks. ekylibre's `Affair` contributes the **netting** angle: one balanced running view across a customer's quotes/orders/invoices/payments/credits.
**The idea we'd build:** a `customer_timeline` read-model (a Postgres VIEW or a thin materialized feed) with `happens_at`, `actor`, `event_type`, `summary`, `properties jsonb`, `target_type` + `target_id` — fed from existing logs + (later) notes/tasks from #3 + opportunities from #1. A React Timeline component on the customer detail page (and order detail), plus a small running-balance roll-up (reusing `invoices.balance_cents`) so the timeline doubles as a customer AR/deal 360. Read-only over existing data → low blast radius.
**Effort: M.** **Risk:** low-medium — mostly a read-model + UI; the only judgment is which existing events to surface and keeping the view performant (index `target_type, target_id, happens_at`). **License:** AGPL — clean-room feed shape (`target_type`/`target_id` + `properties jsonb`).
**Source repos:** twentyhq/twenty, ekylibre/ekylibre.

### 3. Reps' tasks & notes worklist — attach a follow-up to anything, with triage flags  ·  relevance 4 · effort M
**CRX has:** no "call this grower back Friday" workflow at all — no tasks, no per-record notes, no worklist for a sales rep.
**Best repo does:** twenty uses thin polymorphic join tables (`task-target`, `note-target`) so one task or note links to a person/company/opportunity/custom object via `targetXId`, with the task carrying `status`, `dueAt`, `assignee`, `position`. LiteFarm confirms the durable shape: a single `task` parent (assignee, due-date, abandonment-reason lifecycle) with typed children. farmOS adds the orthogonal triage axis: **Flags** (code-defined Priority/Needs-review/Monitor) vs **Categories** (user taxonomy).
**The idea we'd build:** a `crx_tasks` table (`title`, `body`, `status` open/done/abandoned + `abandon_reason`, `due_at`, `assignee` sales_rep, `created_by`, `priority` flag) + a `crx_task_links` join (`task_id`, `target_type`, `target_id`) so a follow-up attaches to a customer, quote, opportunity (#1), or delivery. Lightweight notes the same way. A React "My worklist" page (due-today / overdue / flagged), filterable by the Priority/Needs-review flag axis. Pairs directly with the pipeline (#1) and feeds the timeline (#2).
**Effort: M.** **Risk:** low — additive, no financial coupling; main care is RLS (a rep sees their assigned + their customers' tasks) and not over-building the flag/category taxonomy (start with a fixed flag set). **License:** AGPL/GPL — concept + join-table pattern, clean-room.
**Source repos:** twentyhq/twenty, LiteFarmOrg/LiteFarm, farmOS/farmOS.

### 4. Duplicate-customer detection at create time  ·  relevance 3 · effort S
**CRX has:** no guard against two reps entering the same farm twice — a known ag-dealer data-quality problem that corrupts AR, commissions, and pipeline rollups.
**Best repo does:** twenty's `objectMetadata` carries a declarative `duplicateCriteria` jsonb — which fields make two records "the same" (email, name) so the CRM warns at create time.
**The idea we'd build:** a small `find_possible_duplicate_customers(p_name, p_phone, p_fsa_number)` RPC + a React "Did you mean [existing customer]?" prompt on new-customer save. Match rules: name fuzzy + phone, or FSA farm number exact. Non-blocking (warn, let admin override). Cheap, high-leverage data hygiene.
**Effort: S.** **Risk:** low — read-only RPC + a confirm prompt; the only risk is over-eager matching annoying users, so make it a soft warning, not a hard block. **License:** AGPL — borrow the declarative-criteria idea only.
**Source repos:** twentyhq/twenty.

### 5. Grower program — season-scoped planned-vs-actual crop plan  ·  relevance 4 · effort M
**CRX has:** thin crop planning. CRX tracks deliveries and application services per field but has no **season program** object (what we *intend* to sell/apply on a field this year) and therefore no target-vs-actual variance — and no agronomic "what did we do on this field this season" backbone for a future grower portal.
**Best repo does:** farmvibes-ai's `SeasonalFieldInformation` is a per-field/per-season object = crop + typed event lists (fertilizer, tillage, harvest) with dates/quantities. farmOS's `Plan` + `Plan Record` pair stores the **relationship metadata** — the *Target* lives on the Plan↔record link, the *Actual* lives on the fulfilling Log; the variance is the report.
**The idea we'd build:** a `field_seasons` table (`field_id`, `season` Oct 1–Sep 30 per CRX, `crop`, `acres`) + a `grower_program` / `program_line` pair (per customer/field, intended products with a `target_rate`), where each fulfilled CRX application/delivery/blend ticket links back and **variance (target vs actual) is the report**. Gives the dealer a per-field agronomic timeline and a "program" object to sell against — the backbone of the greenfield grower portal.
**Effort: M.** **Risk:** medium — touches the field/application data model and depends on linking existing `application_records`/deliveries back to a plan line (define that link carefully). Start read-mostly (record the plan, compute variance) before adding auto-fulfillment. **License:** **MIT** for the farmvibes dataclass shape (may be lifted w/ attribution); GPL-2.0 for the farmOS Plan/Plan-Record relationship pattern (idea only).
**Source repos:** microsoft/farmvibes-ai, farmOS/farmOS.

---

## Killed / out-of-scope for this lens

- **Kanban `position`-ordering as a standalone idea** — folded into #1; it's a one-formula technique, not a project.
- **Flags-vs-Categories as a standalone engine** — folded into #3; a fixed flag set on tasks/customers captures the value without a taxonomy engine.
- **ekylibre `Affair` as its own candidate** — its two useful halves (probability → #1, AR-netting view → #2) are already captured; the full polymorphic deal-header is more than CRX needs.
- **Grower-only noise from the farm apps** — animal/herd management, planting/bed plans, harvest yields, employee wage/shift tracking, grower-to-buyer marketplace (LiteFarm/farmOS/ekylibre). CRX is a dealer, not a grower's own-farm app.
- Metadata-driven custom fields, i18n, double-entry ledger, inventory valuation, soil/lab tests, label-data registry → real CRX gaps but belong to the **architecture / financial / compliance / field-intel** lenses, not CRM-UX.

---

## Build-order recommendation (for Mason, plain English)

Ship in this order — each step makes the next more valuable:

1. **#1 Sales pipeline** first — it's the loudest named gap and the anchor every other CRM piece hangs off.
2. **#3 Tasks/notes worklist** next — small, and it's what makes the pipeline actually *used* day-to-day (follow-ups).
3. **#2 Customer 360 timeline** — once #1 and #3 exist there's something worth putting in the feed; it's mostly a read-only view so it's low-risk.
4. **#4 Duplicate detection** — a cheap quality guard, drop it in any time.
5. **#5 Grower program** — the biggest payoff toward the grower portal, but it touches the field/application model, so do it once the lighter CRM pieces are proven.
