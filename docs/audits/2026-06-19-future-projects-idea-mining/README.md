# Future-Projects Idea Backlog — CRX Manager

**Date:** 2026-06-19
**What this is:** a ranked "what should we build next" list for CRX Manager. We scouted six mature open-source farm/ERP systems for good ideas, ran every candidate through an adversarial check (does CRX already have it? is it actually buildable? is it legally safe to borrow?), and kept only the ones that survived. This README is the plain-English summary; the detailed evidence lives in the per-theme and per-repo files linked at the bottom.

**A few terms, defined once (they appear throughout):**

- **CRX is a *dealer*** — we sell, custom-blend, and apply chemicals/fertilizer *to* farms, and we carry the legal/compliance paperwork. We are **not** a grower's own farm-management app. Ideas only count if they help the *dealer*.
- **Copyleft** — a license condition (on most of the repos we scouted) that says: if you copy this source code into your own product, you must open-source your product too. To stay safe, we only borrow *ideas, data shapes, and formulas* and re-build them from scratch ("clean-room") on our own stack. We never paste their code.
- **AGPL** — the strictest copyleft. It even triggers when you just *run* the software as a website (which CRX is). So for AGPL repos (twenty, ekylibre) we are extra careful: ideas only, never code.
- **Named CRX gap** — a hole in CRX that we already know about and listed up front. Ideas that fill a named gap rank higher.

---

## The short version (ranked recommendation)

**Build these soon — small/medium effort, real value:**

1. **Lab/soil-test records** — store the soil and tissue test results that justify a blend or prescription. Fills two named gaps (no soil integration, thin crop planning), low risk, and it's a natural future grower-portal feature. *Best first move.*
2. **Audit-grade application record** — finish turning each "we applied X to this field" record into a complete, legally defensible document (lot number, method, rate, area, planned-vs-done). This *is* the row a regulator asks for.
3. **Payment terms with early-pay discount** — classic "2% off if you pay within 10 days." Cheapest real money feature; lives entirely inside the AR module we already run.
4. **Compliance document vault** — one place to store SDS sheets, applicator licenses, permits, and insurance certificates, with "expiring in 30/60/90 days" alerts.
5. **Application-time compliance check** — automatically compute re-entry (REI) and pre-harvest (PHI) clearance dates and warn if an applied rate exceeds the label max. *Must come after #1 and #2 — see why below.*
6. **Duplicate-customer warning** — a soft "Did you mean [existing farm]?" prompt when a rep adds a new customer, to stop the same farm being entered twice (which quietly corrupts billing and commissions).

**Bigger, strategic bets (large effort — plan separately):** a sales pipeline (CRM), a double-entry accounting ledger, an inventory-cost (FIFO) engine, satellite field-health imagery, and a grower self-service portal.

**The single most important sequencing fact:** five of these compliance ideas all burn the same fuel — **product label data (REI/PHI/signal word), and right now 0 of 604 products carry any.** That data fill is an *owner task*, not code. Loading it is the unlock for the whole compliance tier; until it's done, those features render "unknown" everywhere.

---

## Tier 1 — Near-term buildable

Ranked by value-for-effort. Effort: **S** = small (days), **M** = medium (1–2 weeks). Value reflects real dealer payoff, not novelty.

| # | Idea | Lens | Value | Effort | What we'd build (plain English) | Why now | Named gap filled | License note |
|---|------|------|-------|--------|--------------------------------|---------|------------------|--------------|
| 1 | **Lab/soil-test record capture** (soil/tissue/water) | field-intel | High | M | Two new tables: a test "header" (which field, which lab, sample date, soil/tissue/water) and the result rows (each nutrient + its value, unit, and lab method). Use the public **SoilGrids** nutrient/unit list as our standard vocabulary so columns are consistent. A map heatmap can come later. | Lowest-risk way to fill two named gaps; needs no paid outside service; gives blend recommendations a factual backing and is an obvious grower-portal feature ("here are your soil results"). The theme docs rate it the #1 place to start. | No soil/lab integration; thin crop planning | Borrowed shape only. The SoilGrids nutrient dictionary is **MIT** (reuse OK with attribution); farmOS/LiteFarm shapes are copyleft so rebuilt clean-room. |
| 2 | **Audit-grade application record** | compliance | High | M | Add the missing columns to `application_records`: lot number, application method, source, applied rate + unit, area treated, % of field treated, and a clear planned-vs-done flag. Compute rate = quantity ÷ area in one standard unit. Treat this row as *the* restricted-use-product register row and the future "what was applied to my field" view. | Directly strengthens the compliance paperwork CRX is legally on the hook for, and seeds the grower portal. Mostly additive columns. **Coordinate with the active `feat/as-applied-invoices` work and the existing `docs/plans/2026-06-14-spray-compliance-data-model.md` spec — build *with* them, don't fork.** | (Hardens compliance load; no single named gap) | Data-model/formula only (farmOS/LiteFarm are copyleft); rebuilt clean-room. |
| 3 | **Payment terms with prompt-pay (early-payment) discount** | financial | Medium | S | Add `discount_pct` + `discount_days` to customer/invoice terms (e.g. "2/10 net 30" = 2% off if paid within 10 days). The existing payment flow auto-computes the discounted amount due when a payment lands inside the window. | Cheapest real financial win, fully self-contained in the AR module we already run, standard low-risk formula. Good cash-flow lever for an ag-retail dealer. | None (polish, not a gap-fill) | Idea from erpnext (copyleft); 2/10-net-30 is a standard, non-copyrightable formula, rebuilt clean-room. The "post the discount to the ledger" half waits on the (not-yet-built) double-entry ledger; the core discount stands alone. |
| 4 | **Compliance document vault with expiry tracking** | compliance | Medium | M | A typed document store on Supabase Storage for SDS sheets, applicator licenses, dealer permits, and insurance certificates, with valid-until / no-expiration / archived flags and a "documents expiring in 30/60/90 days" dashboard widget. | Solves a real dealer paperwork-shelf-life problem and gives the future compliance-packet exporter something to pull from. Low risk, no lifecycle entanglement. **Scope to *new* doc types (SDS/permits/COIs) and reuse the existing applicator-license expiry alerting rather than rebuilding it.** | None (real capability, no named gap) | Document-model shape from LiteFarm (copyleft); rebuilt clean-room. |
| 5 | **Application-time compliance check + frozen label snapshot** | compliance | Medium | M | A database function that, on each application, writes the re-entry-clear and pre-harvest-clear dates onto the record, checks applied rate vs the label max, and stamps a go / caution / stop result. A red/amber/green badge in Field Mode and a "field restricted until [date]" banner; softly warns on conflicting deliveries/jobs. | High-value worker-safety + compliance capability that turns the dealer's compliance load into an enforced gate. **Must come strictly *after* #1 (label data) and #2 (hardened record): with 0/604 products carrying label data, every badge reads "unknown" today.** Default to *warn*, not hard-block, until data coverage is high. | (Compliance gate; depends on label-data fill) | Public EPA label facts + standard interval formulas; no code copied. |
| 6 | **Duplicate-customer detection at create time** | CRM-UX | Medium | M | A read-only database function that fuzzy-matches a new farm's name + phone against existing customers, plus a non-blocking "Did you mean [existing customer]?" prompt on save with an admin override. | Cheap guard against a known ag-dealer data-quality problem — duplicate farms quietly corrupt AR aging, commission splits, and pipeline rollups. Only ~150 customers today, so matching is fast. | None (data-quality guard) | Idea from twenty (AGPL); concept only. **Spec fix: drop the proposed FSA-number match — customers have no FSA number (FSA numbers live on the *fields* table). Match on fuzzy farm name + phone (+ optional email).** Needs the `pg_trgm` extension (available, not yet installed). |

---

## Tier 2 — Big bets / someday (large or platform-level)

These are the named-gap fills with the biggest payoff *and* the biggest blast radius. Each is a project, not a task — they need their own plan, phased build, and double review. They are listed here so they're on the radar, not because they're next.

| Idea | Lens | Value | Effort | What we'd build (plain English) | Why it's a big bet |
|------|------|-------|--------|--------------------------------|--------------------|
| **Double-entry general ledger + chart of accounts** | financial | High | L | A real accounting backbone: every financial event posts balanced debit/credit rows to an account tree, never edited (corrections post a reversal). Profit-and-loss and balance-sheet statements become simple rollups. *(Double-entry ledger = the bookkeeping standard where every transaction hits two accounts so the books always balance.)* | Fills the #1 named financial gap, but touches money, period-locking, and every existing financial RPC. Must be additive (mirror, not replace, today's `balance_cents`), reconciled to the penny, and double-reviewed. Highest value, highest risk. |
| **Perpetual inventory-valuation engine (FIFO / moving average)** | financial | High | L | Attach a real *cost* to every inventory movement so on-hand value and profit margins are grounded in what we actually paid. *(FIFO / inventory valuation = "first in, first out" — the method that decides which cost layer a sale draws from, so margin math is honest.)* Includes a negative-stock-safe guard. | Fills the "no inventory-valuation method" named gap and makes margin reporting honest. Rewrites the cost meaning of every stock movement and feeds the ledger's cost-of-goods line. Build the negative-stock guard first as a de-risking slice (CRX has 17 negative-inventory products). |
| **CRM sales pipeline (opportunity board + weighted forecast)** | CRM-UX | High | M–L | Everything *before* a quote: leads/opportunities with admin-editable stages, win-probability, expected close date, a drag-and-drop Kanban board, and a weighted forecast. *(CRM pipeline = the deal-tracking view that shows what business you're working and what it'll likely close at.)* | The loudest named CRM gap and the anchor that the other CRM pieces (tasks, timeline) hang off. A net-new subsystem (table + security + page + report), but additive and isolated from the money core. |
| **Satellite field-health imagery (NDVI time-series)** | field-intel | Medium | L | Pull satellite imagery for each field polygon via a hosted API and store summary health numbers over time (no raster pipeline of our own), charted as a field-health tab. *(NDVI = a satellite "greenness" index that flags crop stress — visual evidence that justifies the blend/prescription we sell.)* | Flashiest field-intel idea but the heaviest, and it depends on a paid imagery API. Do it only after the lighter field-intel pieces (lab tests, weather) prove the direction earns its keep. Start NDVI-only, one provider, summaries only. |
| **Grower self-service portal** | platform | High | L | A greenfield customer-facing layer where growers log in to see their fields, soil results, what was applied, and their compliance documents. | A whole new platform surface, not a feature. Nearly every Tier-1 idea above (lab tests, application records, compliance vault) is partly justified as *content for this portal*. Build the content first; build the portal when there's enough to show. |

---

## Tier 3 — Killed (and why)

Kept here for transparency so we don't re-propose them.

| Idea | Why killed |
|------|-----------|
| **"Against-voucher" reversal columns on the audit log** | Low standalone value and dependency-orphan. A "reversal that offsets a posting" only means something against a balanced debit/credit ledger, which CRX doesn't have yet — and once that ledger (big bet above) ships, it brings reversal-linkage natively. CRX's audit log is an event log, not a posting ledger. Redundant before *and* after the ledger. |
| **Reps' tasks & notes worklist** | Already built. CRX's `team_notes` + `team_notes.linked_entity_type/id` + the `/team-board` page (with my-tasks, overdue badges, stale-task triage, and a workload view) already deliver "attach a follow-up to anything" and a personal worklist, almost feature-for-feature. |
| **Customer 360 activity timeline** | Already built. `CustomerDetail.tsx` already has a per-customer timeline tab over the `activity_feed` table (fed from 89 logging call sites) plus a "Customer 360" financials tab with a running balance. |
| **Grower program (planned-vs-actual crop plan)** | Already built across three live pieces: the variance engine (`get_program_completion` + `/program-tracker`), the program object (`/crop-programs` with per-product target rates), and the per-field/per-season backbone (`field_crop_history` + the field dashboard). |
| **Sensor data-stream ingestion substrate** | Speculative infrastructure with nothing to ingest — no sensor/device partner exists, and the project is operationally empty even on existing data. Building a generic device-feed pipeline before a single feed exists is exactly the speculative infra the project rules forbid. |

---

## Where the detail lives

**Per-theme syntheses** (deduped, ranked candidate sets with full citations):

- [theme-compliance.md](theme-compliance.md) — label data, application-time checks, audit-grade records, document vault, packet exporter, recommendation-of-record
- [theme-financial.md](theme-financial.md) — double-entry ledger, inventory valuation, pricing rules, payment terms, landed cost, depreciation
- [theme-field-intel.md](theme-field-intel.md) — NDVI imagery, lab/soil tests, sampling-plan generator, field weather, sensor substrate
- [theme-CRM-UX.md](theme-CRM-UX.md) — sales pipeline, customer 360 timeline, tasks/notes worklist, duplicate detection, grower program
- [theme-architecture.md](theme-architecture.md) — structural/architecture-lens candidates

**Per-repo scouting notes** (what each source system does, its license, and what's worth borrowing):

- [repo-erpnext.md](repo-erpnext.md) — frappe/erpnext (GPL-3.0)
- [repo-twenty.md](repo-twenty.md) — twentyhq/twenty (AGPL-3.0, mixed Enterprise carve-out)
- [repo-farmvibes.md](repo-farmvibes.md) — microsoft/farmvibes-ai (MIT — the one repo whose code may be reused, with attribution)
- [repo-ekylibre.md](repo-ekylibre.md) — ekylibre/ekylibre (AGPL-3.0)
- [repo-litefarm.md](repo-litefarm.md) — LiteFarmOrg/LiteFarm (GPL-3.0)
- [repo-farmos.md](repo-farmos.md) — farmOS/farmOS (GPL-2.0)
