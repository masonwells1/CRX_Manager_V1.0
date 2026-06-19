# As-Applied (Application) Invoices — Build Plan & Draft Spec

**Date:** 2026-06-18 · **Status:** DRAFT — pending Mason's approval + Codex review. **Nothing built yet. No code until approved.**
**Owner:** Mason · **Author:** Claude (grounded in a verified 6-explorer codebase map, 2026-06-18)
**Companions (adjacent, do NOT duplicate):** [`2026-06-14-spray-compliance-data-model.md`](2026-06-14-spray-compliance-data-model.md) (compliance log / grower portal / shed), [`sprayer-packet-feature-todo.md`](sprayer-packet-feature-todo.md) (printable applicator packet).

---

## 0. Goal & the hard requirement

Add **As-Applied / Application invoices** — billing for jobs CRX sprays with its **own equipment** — as a **separate, segregated area** from Chemical Sales, mirroring how the current "Chem Man" system keeps the two sale types apart.

**Two segregated sales types (Mason, 2026-06-18):**

| | ① Chemical Sales | ② Application Sales |
|---|---|---|
| What | Customer orders product → it's **delivered** | What CRX **applies with its own sprayer** |
| Start | Order → delivery | **Scheduling** → the job is scheduled |
| Draft | **Unposted** chemical invoice | **Unposted field invoice** |
| Review | confirm | **check for accuracy** (acres / products / weather) |
| Go live | **Post** → customer balance | **Post** → customer balance |

**Locked decisions (Mason, 2026-06-18):**
1. The two sale types stay **segregated** — separate workflows and separate lists.
2. Application invoices get their **own separate area** (own nav item + own list screen).
3. The existing **Chemical Sales** invoice screen is **untouched and unrisked**.
4. Both still post against the **one** customer balance (a customer has a single account / statement).
5. **Build on the existing spray engine** — do not reinvent it.
6. **Build order: billing first, machine-data import LAST** (Mason approved reordering away from the spec's "import first" — import isn't required to start billing).
7. **Billing basis: per-acre only** for application charges (no per-hour / flat for v1).
8. **Bill actual, not planned** — bill the **actual applied** amounts, reconciled/edited against the **blend ticket** on the unposted invoice before posting. The field invoice MUST stay **freely editable until posted** (it never comes out perfect; the operator always adjusts). The blend ticket is the reconciliation reference for "what actually went out."
9. **Menu name = "Field Invoices"** (the new separate area's nav label).
10. **Weather captured/stored but NOT printed on the customer invoice PDF** (internal-only). Phase 3 snapshots weather onto the invoice transactionally, but the PDF layout stays unchanged.
11. **Attempt recipe pricing (Phase 4) overnight** — pick a sensible model (a per-acre `$`/ac on the recipe) for Mason's morning review.
12. **Hold everything for morning review** — overnight is **branch-only**: NO live migration applies, NO prod deploy while Mason sleeps. Each go-live step is parked with an apply-proof + plain-English explainer for one-click approval.

---

## 1. The big finding: ~70% of this already exists

A 6-explorer read-only map (verified against on-disk code + the live schema, 2026-06-18) shows CRX already has a near-complete application engine. The work is mostly **finish + wire-up + prove**, plus one genuinely-new piece (machine-data import, which is **not required to start billing**).

### Reuse map (verified)
| Existing asset | Role for As-Applied | Evidence |
|---|---|---|
| `jobs` (scheduled→in_progress→completed→**invoiced**) | The application work order. Exactly Mason's "schedule → apply" flow. | `20260215200000_job_scheduling_tables.sql`; `src/pages/JobDetail.tsx` |
| `application_records` (+ `application_record_fields`) | Immutable regulatory log: what/where/when/who/which machine + weather. Carries `invoice_id`. | `20260214220000_application_records_table.sql` |
| `job_applied_info` | Structured weather + actual gallons captured at completion (open-meteo auto-fill). | `complete_job` in `20260430190000_field_app_workflow_phase7.sql` |
| `invoice_type='field_application'` + its PDF layout | The application invoice **type already exists**, with a dedicated print layout. | type originates in `20260316100002_return_credit_ar_integration.sql:43-47` (Codex); current live CHECK in `20260609130744…`; `drawFieldApplicationLayout` in `src/lib/invoicePdf.ts` |
| `FieldApplicationInvoice.tsx` (tabs: Locations/Chemicals/Customers/Applied Info) | A full application-invoice builder UI: per-grower acre splits + applied-info capture. | `src/pages/FieldApplicationInvoice.tsx` |
| `vehicles` | Equipment catalog (sprayer/airplane/spreader/drone, capacity, N-number). | `20260214200000_vehicles_table.sql`; `src/pages/Vehicles.tsx` |
| `application_services` + `customer_application_rates` | Machine **per-acre billing rates** (e.g. "Hagie Y-Drop $13/ac") + per-customer overrides. | `20260405000000_application_services.sql`; `src/pages/ApplicationServices.tsx` |
| `transfer_job_to_invoice` | Existing **job → unposted field invoice** rail; links `application_records.invoice_id`; flips job→invoiced. | `20260611002255_transfer_job_invoice_column_fixes.sql` |
| `save_field_app_invoice` / `preview_field_app_invoice_split` / `post_invoice_group` / `derive_customer_shares_from_fields` | The richer field-app billing engine: multi-customer acre splits, grower-share vs priced lines, draft→post. | `20260429140635_field_app_workflow_phase1.sql` |
| `post_invoice` / `check_period_open` / `financial_audit_log` / idempotency / `balance_cents` (generated) | The whole money + draft→post + closed-period + audit + AR layer — reuse wholesale. | various |
| `blend_recipes` + `load_recipe_into_job` | Tank-mix templates loaded into a job. | `20260213140000_phase4a_blend_recipes.sql`; `20260611201929_load_recipe_column_fix.sql` |

**Translation:** Mason's described workflow (schedule → apply → unposted field invoice → check → post) **already maps onto live objects.** The job is to give it a home (separate area), prove it runs, and fill specific gaps.

---

## 2. Gap analysis (what's actually missing)

| # | Gap | Severity | Notes / evidence |
|---|---|---|---|
| G1 | **Dropped machine fee.** `transfer_job_to_invoice` never reads `jobs.application_service_id` and never emits the per-acre machine `is_application_fee` line — even though `compute_application_service_fee()` exists for exactly this. A job invoiced today bills **chemicals only**. | HIGH (wrong money) | `application_service_id` appears **only in a comment** in `20260611002255…`; helper in `20260430170000_field_app_workflow_phase4.sql` |
| G2 | **No separate Application area.** Field invoices land in the same `/invoices` list as chemical sales (type filter only) — violates the segregation requirement. | HIGH (requirement) | `src/pages/Invoices.tsx`, `src/components/layout/Sidebar.tsx` |
| G3 | **Actor-forgery gap.** `transfer_job_to_invoice` is role-gated only — no `auth.uid()` binding / `ACTOR_MISMATCH` — unlike `complete_job`/`start_job`. A forgeable performer on a money step. | HIGH (security) | red-line: strict-actor on mutating money RPCs |
| G4 | **Weather doesn't reach the bill.** Jobs capture structured weather; `transfer_job_to_invoice` doesn't copy it and the PDF has no weather slot — invoice has only free-text `wind_direction`/`temperature_text`. | MED | `20260507100000_field_app_applied_info.sql`; `invoicePdf.ts` |
| G5 | **No recipe pricing.** `load_recipe_into_job` always sets `price_per_unit_cents=0`; recipes carry no price → every recipe-driven job is hand-priced before billing. | MED | `20260611201929_load_recipe_column_fix.sql` |
| G6 | **No reconciliation view.** Nothing lists "applied but not yet invoiced" (completed jobs / approved-unbilled blend tickets / `application_records` WHERE `invoice_id IS NULL`). | MED | — |
| G7 | **No machine/controller import.** Applications only enter by hand (completed job / approved blend ticket). No Raven/John Deere/ISOXML ingestion. `application_records.source_type` CHECK is only `('job','blend_ticket')`. | NEW BUILD (not required to bill) | `20260214220000…` |
| G8 | **Two divergent billing rails.** `transfer_job_to_invoice` (simple, one-shot) vs `save_field_app_invoice`+`post_invoice_group` (richer: multi-customer groups, grower-share/priced modes, draft→post). They re-implement fee/share math separately and can drift. | DESIGN | needs a "standardize on one" decision |
| G9 | **Unproven on real data.** Live: ~1 job, **0** completed/invoiced, **0** application records, **0** field-app invoices, **0** posted invoices. `transfer_job_to_invoice` was broken (5 bugs) until 2026-06-10. The applied→invoice loop has **never run end-to-end**. | RISK | money/AR audits remain "vacuously clean" |

---

## 3. Recommended build order (small, reviewable steps)

> The spec's stated order is *equipment import → blend recipes → machine-aware billing → applied info + weather → draft/post → reconciliation*. Because most of that **already exists**, I recommend **reordering to do the high-value, low-risk, loop-proving work first and defer the hardest/most-uncertain piece (import) to last** — import is *not* required to start billing applications. Each step pauses for Mason to test.

*(Order refined per Codex 2026-06-18: reconciliation moved up; rails converged; weather snapshot moved into the save RPC.)*

### Phase 1 — Separate area + prove & repair the loop (foundation)
- **1a. Separate Application Invoices area** (frontend-only, low risk). New nav item + new list page showing only `field_application` invoices and their drafts/unposted, with their own counts/totals. Chemical Sales screen untouched. Add `PAGE_PERMISSIONS` coverage for the new route (Codex MED). *Files: new `src/pages/FieldInvoices.tsx`, `App.tsx` route (before `/invoices/:id`), `Sidebar.tsx`, `src/lib/pagePermissions.ts` (+ its test).*
- **1b. Prove the loop end-to-end** on a **rolled-back** smoke run: schedule a job → start → complete (writes application record + weather) → unposted field invoice → edit → post → void. Fix whatever breaks. (*"Done = ran and proven."*)
- **1c. Fix the machine fee + actor gap by CONVERGING the rails (G1 + G3 + G8 together — Codex)** — standardize on the canonical `save_field_app_invoice` + `post_invoice_group` engine, which **already** emits the per-acre `is_application_fee` line (`application_service_id` + `compute_application_service_fee()`) **and** binds the actor and writes the audit row. Make `transfer_job_to_invoice` a **thin adapter** that maps job data into that engine + updates the job/application-record links — rather than patching the divergent transfer logic. Guard idempotency-key ownership (one outer op owns the key; nested helpers must not reuse the same external key — Codex LOW). Remove the duplicate client-side `job_invoiced` log (Codex LOW). New migration, heavily gated: migration reviewers + a fresh Codex pass + rolled-back smoke asserting an `is_application_fee=true` row **and** actor-mismatch rejection; **re-run the smoke after the migration** (Codex); Mason's explicit OK to apply.

### Phase 2 — Reconciliation view (G6) — moved up per Codex (read-only, high value, zero write risk)
- Read-only "Applied but not yet invoiced" screen: completed jobs + approved-unbilled blend tickets + `application_records` where `invoice_id IS NULL`. Gives visibility into what's owed-but-unbilled while the billing fixes settle. No money writes.

### Phase 3 — Applied info + weather snapshot (G4) — INTERNAL ONLY (Mason: not on the customer PDF)
- **Snapshot** job weather (wind speed/dir, temp, humidity, actual gallons) onto the field invoice **inside the save RPC (transactional)** — NOT as a second non-transactional frontend `.update()` after save, which is today's pattern in `FieldApplicationInvoice.tsx:420-443` (Codex MED). **Do NOT add weather to the customer invoice PDF** (Mason decision #10 — internal-only); display it on the internal Field-invoice screen only.

### Phase 4 — Recipe-aware billing (G5) — ATTEMPT overnight (Mason #11)
- Let a recipe carry/drive pricing so recipe-loaded jobs don't need full manual re-pricing. **Model to attempt:** add an optional per-acre `$`/ac (and/or per-unit price) to `blend_recipe_items`; `load_recipe_into_job` seeds `price_per_unit_cents` from it instead of `$0`. Additive + reviewable; Mason confirms the pricing model in the morning. (Until applied, Phase 1 billing still requires hand-priced lines — recipe-loaded jobs arrive at `$0` today.)

### Phase 5 — Machine/controller import (G7) — LAST, biggest, most uncertain
- Import as-applied data (Raven Viper Pro / John Deere) into `application_records` (+ a new `source_type`, widened as a superset). **Not required to bill** — manual entry already works. Format-dependent (Phase-5 decision). **File export** path for v1; defer any live API.

---

## 4. Open questions (Mason's calls — with my recommendations)

1. **Equipment-import format** — Raven Viper Pro export type (CSV / ISOXML / shapefile)? And John Deere **live API vs. file export**? → *Deferred to Phase 5 (Mason): settle the format when we reach the import build; rec is file export first.*
2. ~~**Billing basis**~~ → **RESOLVED (Mason): per-acre only** for v1. (See locked decision #7.)
3. ~~**Planned vs. actual**~~ → **RESOLVED (Mason): bill ACTUAL, reconciled/edited against the blend ticket** on the unposted invoice before posting; the invoice stays freely editable until posted. (See locked decision #8.)
4. ~~**Two billing rails (G8)**~~ → **RESOLVED (Codex): standardize on `save_field_app_invoice` + `post_invoice_group`**; make `transfer_job_to_invoice` a thin adapter into it (it already does actor checks, group lock, service validation, fee rows, audit rows). Folded into Phase 1c.
5. ~~**Structured weather on the invoice**~~ → **RESOLVED: structured + snapshotted inside the save RPC** (transactional), per Codex MED. Folded into Phase 3.

---

## 5. Hard constraints (always apply)
- **Do not touch / break Chemical Sales.** Additive only.
- RLS on every new table; money in **bigint cents**; `balance_cents` is generated (never write it).
- Every mutating RPC: `p_idempotency_key`, operation-scoped idempotency, `SECURITY DEFINER` + `SET search_path = public, pg_temp`, **strict-actor**.
- `financial_audit_log` append-only; every money-creating RPC writes an `invoice_created` row.
- Migrations only (new files); reviewers + Codex + rolled-back smoke before any apply; **Mason's explicit OK to apply any live migration.**
- Never bypass `check_period_open()`.

---

## 6. What Codex is asked to validate
1. Is the **reuse map (§1)** accurate against live code — is `field_application` truly the right base, or is there a reason to build fresh?
2. Is the **gap analysis (§2)** correct — especially **G1 (dropped machine fee)** and **G3 (actor gap)** — and is anything missing?
3. Is the **build order (§3)** the safest sequence for a money-touching, multi-migration feature, given the loop is unproven (G9)?
4. **G8:** which billing rail to standardize on, and the cleanest way to converge them?
5. Any **money / RLS / lifecycle / idempotency / actor** traps in the proposed approach.

---

## 7. Codex review — verdict & refinements (2026-06-18)

Independent read-only review by Codex (gpt-5.5), full output in `.claude/session-state/codex-asapplied-plan-review.txt`. **Verdict: no fresh-build blocker — reuse the existing engine; gate release on the HIGH fixes (which are exactly the G1/G3/G8 work in Phase 1).** Claude agrees with every finding; all are folded into the plan above.

- **Foundation is right (no build-fresh).** `jobs`, `application_records`, `invoice_type='field_application'`, the field-app PDF layout, `application_services`, and `save_field_app_invoice` are the correct base. The only weak piece is `transfer_job_to_invoice`.
- **G1 + G3 confirmed** with exact cites: `transfer_job_to_invoice` bills chemical rows only (`20260611002255…:216-252`) and writes caller-supplied `p_performed_by` without an `auth.uid()` bind (`:101-103`, `:146-150`, `:213`).
- **G8 — converge on `save_field_app_invoice` + `post_invoice_group`** (it already has fee rows, strict actor, group lock, audit). Make `transfer_job_to_invoice` a thin adapter. → **resolves G1+G3+G8 together (Phase 1c).**
- **Reordering:** move the read-only reconciliation view **earlier** (now Phase 2) — high value, zero write risk. Re-run the smoke **after** the G1/G3 migration.
- **G4 weather:** snapshot **inside the save RPC** (transactional), not the current second non-transactional frontend `.update()`.
- **G5:** until recipe pricing lands, Phase 1 billing requires **hand-priced** lines (recipe-loaded jobs arrive at `$0`).
- **LOWs:** fix the §1 citation (done); guard idempotency-key ownership across the converged rail; remove the duplicate client-side `job_invoiced` activity log (`JobDetail.tsx:704`).
- **G9 caveat:** Codex could not refresh live counts from its sandbox; the "0 posted field invoices" figure is unrefreshed-but-consistent with `CLAUDE.md:27`. We will re-verify live counts before any migration apply.
