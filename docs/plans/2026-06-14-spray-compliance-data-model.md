# Spray-Compliance Data Model — First-Build Design (G1–G3)

**Date:** 2026-06-14 · **Status:** DESIGN DRAFT — feeds a future `/ship`; **nothing built yet.**
**Companion to:** [`2026-06-10-grower-portal-brainstorm.md`](2026-06-10-grower-portal-brainstorm.md) (esp. §6, §6.8, §6.9)
**Owner:** Mason

This is the concrete data-model bridge from the §6 vision to a buildable first slice.
It covers the **shared foundation** under G1 (chemical shed + spray checklist +
compliance log), G2 (timers), and G3 (internal crew board). **Internal-first:** every
table is usable inside CRX Manager *before* any portal auth exists; the grower portal
later reads the same tables through `portal_*` RPCs. All column lists below were checked
against the live DB on 2026-06-14.

---

## 0. Design principles
- **Reuse before build.** Most of the engine already exists (§1) — we add a thin layer, not a parallel system.
- **One data model, two front doors** (§6.5): a pass is assigned to the grower (self-spray) or a CRX crew (custom). `application_records.source_type` already discriminates source.
- **Two regimes, enforced** (§6.8): *private* (grower) vs *commercial* (CRX-for-hire) carry different required fields, timeliness, and a customer-copy duty.
- **Snapshot, don't reference**: copy label/license values onto the compliance record at completion.
- Inherit CRX red lines: RLS on every new table; money in bigint cents; `p_idempotency_key` on every mutating RPC; compliance records append-only after completion.

---

## 1. Reuse map (verified live 2026-06-14)

| Existing asset | Role in this feature |
|---|---|
| `application_records` (21 cols: customer_id, applicator_id, field_id, application_date/time, `product_data` jsonb, total_acres/volume, `weather_conditions` jsonb, season, invoice_id, `source_type`/`source_id`) | **The compliance log itself.** Extend, don't replace (§2.3). `source_type` is `job`/`blend_ticket` today → add `spray_pass`. |
| `application_record_fields` (application_record_id, field_id, acres, sort_order) | Per-field breakdown of a multi-field pass. Reuse as-is. |
| `applicator_licenses` (customer- **and** staff-held; `expiry_date`, `certification_categories`, `state`) | License/cert lookup + the value snapshotted onto each record. Job-assignment expiry **gate** already exists (B5). |
| `jobs` (customer_id, status, job_date, `applicator_id`, total_acres, `invoice_id`, season, `application_service_id` …) | A CRX **custom** pass *is* a job. Link, don't duplicate (§4). Job→invoice path (`transfer_job_to_invoice`) already exists. |
| `fields` (customer_id, `total_acres`, `boundary_geojson`, `centroid_geojson`) | Field + acres auto-fill; centroid for weather (C4). |
| `products` (`inventory_unit`, `rate_unit`, `rate_per_acre`, `container_size/unit`, `product_form`, `epa_registration`, `is_rup`, `signal_word`, `rei_hours`, `phi_days`) | Shed units + label auto-fill. **REI/PHI/RUP columns exist but are 0% populated** — see worksheet. |
| `unit_conversions` (14 rows, pivot to oz; liquid vs dry) | Shed math. **Gap: no liquid↔dry density bridge** (§6.9 / §2.6). |
| `inventory_transactions` (deducts via `quantity` + `job_id`/`delivery_id`) | Pattern to mirror for the **customer** shed ledger (§2.4). Note: CRX's own inventory ≠ the grower's shed — separate ledger. |
| `notifications` (user_id, title, message, notification_type, related_entity_type/id, is_read) | In-app reminder delivery (G2). |
| `email_log` + `send-email` Edge Function | Email reminder delivery (G2). SMS = add Twilio at the same dispatch point later. |
| `ar_reminder_tracking` (customer_id, reminder_level, sent_date, email_log_id) | **The dedup pattern to mirror** so a timer fires once (§2.5). |
| `activity_feed`, `idempotency_keys` | Audit + double-submit protection — standard. |

**Takeaway:** the compliance log, the units engine, the license model, the reminder
delivery, and the crew→job→invoice path all already exist. The genuinely new tables are
the *spray plan/pass* layer, the *customer shed ledger*, and the *reminder rows*.

---

## 2. New tables

### 2.1 `spray_plans` — the per-field season plan
`id, customer_id (FK), field_id (FK), season int, crop text, source text ('program'|'copied'|'manual'), status text ('active'|'archived'), created_by, created_at, updated_at, p_idempotency`
- One plan per field per season. Seeded from the grower's CRX nutrition/chem program (§3), copied from last year, or manual.

### 2.2 `spray_passes` — the checklist rows + the trigger for a compliance record
`id, spray_plan_id (FK), pass_type text ('burndown'|'pre_emerge'|'post_emerge'|'fungicide'|'insecticide'|'desiccation'|'other'), sequence int, planned_window daterange|date, status text, assignment text ('grower'|'crew'), job_id (FK nullable → jobs), application_record_id (FK nullable → application_records), parent_pass_id (FK self, for follow-up chaining), followup_interval_days int nullable (per-pass override), planned_products jsonb, created_by, timestamps, p_idempotency`
- **Status lifecycle:** `planned → applied → recorded` (+ terminal `skipped`, `cancelled`). "Applied" = it happened; "recorded" = the compliance record is complete (§3).
- **Checking a pass off creates/links the compliance record** — `application_record_id` is set when recorded.
- `assignment='crew'` ⇒ `job_id` is set (§4); `assignment='grower'` ⇒ no job.
- `parent_pass_id` chains follow-ups (pre-emerge → its 2nd-trip pass).

### 2.3 `application_records` — **extend, don't replace** (the compliance log)
Add to the existing table / its write path:
- `source_type` CHECK: add `'spray_pass'` (currently `job`/`blend_ticket`).
- `regime text` — `'private'` | `'commercial'`, **derived** (CRX-staff applicator + job → commercial; grower applicator + spray_pass → private) and stored for enforcement (§6.8).
- **Snapshot columns** (point-in-time, set at completion): `epa_registration_snapshot`, `applicator_license_number`, `applicator_license_expiry`, `is_rup_snapshot`, `rate_source text ('crx_recommended'|'grower_chosen')`.
- `completion_status text ('draft'|'complete')` — the two-state record (§3 / open Q4). Only `complete` is export-eligible and append-only.
- `customer_copy_sent_at timestamptz`, `customer_copy_email_log_id` — proves the commercial customer-copy duty was met (§6.8).
- Append-only enforced once `completion_status='complete'` (trigger; amendments only, like `financial_audit_log`).

### 2.4 `customer_chemical_inventory_txns` — the shed ledger (G1 §6.1)
`id, customer_id (FK), product_id (FK), txn_type text ('delivered_in'|'applied_out'|'manual_add'|'reconcile'), quantity numeric (in product.inventory_unit, signed), source text ('crx_delivery'|'application'|'manual'|'count'), source_id uuid, performed_by, notes, created_at`
- **On-hand = SUM(quantity)** per (customer_id, product_id). Immutable ledger (mirror `inventory_transactions`), customer-scoped.
- **Auto-credit:** completing a CRX delivery to that customer writes a `delivered_in` row (qty from `delivery_items`, converted to `inventory_unit`). *This is the moat — zero data entry.*
- **Deplete:** recording a pass writes `applied_out` rows **per product line** (`rate × acres`, converted per §2.6) — **NOT** from tank `total_volume` (§6.9 gap 3).
- **Reconcile:** a "count my shed" action writes a `reconcile` adjustment (mirror cycle counts). On-hand shown as **"estimated," with the math exposed** (§6.9).

### 2.5 `spray_reminders` — the timer rows (G2 §10.6)
`id, customer_id (FK), field_id (FK), spray_pass_id (FK), reminder_type text ('followup_trip'|'rei_expiry'|'phi_earliest_harvest'|'records_due'|'resupply'), due_at timestamptz, status text ('pending'|'sent'|'dismissed'|'done'), channel text ('email'|'sms'|'in_app'), sent_at, email_log_id, notification_id, created_at`
- Each recorded pass writes its follow-up rows (next-trip date, REI-expiry, PHI-earliest-harvest). A daily **pg_cron** scans `due_at <= now() AND status='pending'` → dispatch via `notifications` + `send-email`, then mark `sent` (dedup by row, mirroring `ar_reminder_tracking`).
- **CRX side:** the same rows, filtered across all customers, = the delivery/crew **workload forecast** ("17 fields enter their 2nd-trip window next week").
- Governance (digest/quiet-hours/severity tiers) is the §6 deferred-#6 item — schema supports it; UX later.

### 2.6 `products` — new columns
- `followup_interval_days int` — default residual/2nd-trip interval (drives G2). Overridable per pass (§2.2).
- `density_lb_per_gal numeric nullable` — closes §6.9 gap 1 (liquid↔dry). Only needed where rate-dimension ≠ inventory-dimension; missing ⇒ shed flagged "approximate."
- (Later) **per-crop PHI** → promote to `product_application_intervals` (§2.7); for v1 keep the single `phi_days` + a free-text PHI-notes field on the record.

### 2.7 `product_application_intervals` — **deferred** (later normalization)
`product_id, crop, pass_type, rei_hours, phi_days, followup_interval_days, plant_back_days` — when residual/PHI genuinely varies by crop+context. v1 lives on `products` columns + per-pass overrides; promote when the nuance is needed.

---

## 3. The two-state compliance record (open Q4, resolved direction)
One-tap check-off → `application_records` row with `completion_status='draft'` (date, field, product from the plan). The record is freely editable and **incomplete** until the regime's required fields are in, with the 14-day `records_due` reminder chasing it. Marking `complete` runs the regime-aware validation, snapshots the label/license values (§2.3), and flips on append-only. Same pattern as invoice `draft → posted`.

---

## 4. The `jobs ↔ spray_passes` link (G3 — least greenfield)
A CRX custom pass = a **planned job** with spray context:
1. Schedule: create a `spray_passes` row with `assignment='crew'` + a linked `jobs` row (`job_id`). The B5 license-expiry gate already fires on `jobs.applicator_id`.
2. Complete the job → write the `application_records` row (`source_type='spray_pass'`, `regime='commercial'`, applicator = crew, license snapshotted), set the pass to `recorded`, generate + deliver + log the customer copy (§2.3).
3. Bill: job → invoice via the existing `transfer_job_to_invoice` path; `application_records.invoice_id` links it.
→ The internal crew board is a filtered view over `spray_passes` (+ their jobs) across all customers, fed by the §2.5 reminder rows. **This is mostly wiring existing parts** — the recommended first `/ship`.

---

## 5. RLS & portal scoping
- Every new table: RLS on before first deploy. Internal policies = staff roles (as today). 
- Portal access is **never** direct table grants — only `portal_*` RPCs hard-scoped to `auth.uid()`'s `customer_id` (via the future `customer_users` map + `customer` role). The portal can't see another grower's shed/plans/records.
- Compliance-record reads for growers go through a `portal_get_application_records(field_id?)` RPC that filters to their `customer_id`.

---

## 6. The shed unit math (§6.9, recap for implementers)
`applied_out qty = Σ over product lines of (rate × acres)`, converted **rate_unit → inventory_unit** via `unit_conversions` **within a dimension**; cross-dimension (lb↔gal) needs `products.density_lb_per_gal`. Normalize `rate_unit`/`inventory_unit` to the controlled vocabulary (FK to `unit_conversions.unit`) and **surface non-convertible products loudly** rather than silently drifting the shed.

---

## 7. Open design questions (async — no rush, mobile-friendly)
1. **Plan granularity:** one `spray_plans` row per field per season (proposed) vs per crop-stage program? (Per-field keeps the board simple.)
2. **Whole-farm vs per-field shed:** `customer_chemical_inventory_txns` is per (customer, product) — i.e., one shed per farm, not per field. Confirm growers think of the shed farm-wide (almost certainly yes).
3. **Commercial required-field set:** what exactly must be filled before a CRX-crew record can be marked `complete`? (Drives §3 validation — confirm against the IL rule + your insurer per §10.5.)
4. **Generic products' EPA #:** recorded per delivery (since `Gen …` products span multiple brands) — store the chosen EPA # on the shed `delivered_in` row, and snapshot it onto the record. Confirm that's how you want it.

---

## 8. What this unblocks + suggested first `/ship` slice
- **First slice (internal-only, no portal):** `spray_plans` + `spray_passes` + the `application_records` extensions + the `jobs` link (§4) + an internal spray-board page. Validates the model, builds the label catalog in practice, needs **no** portal-security work.
- **Hard prerequisite (parallel, non-code):** the top-20 label-data lift (worksheet sent 2026-06-14) — `followup_interval_days`/REI/PHI/RUP are 0% populated, and the timers can't run without them.
- **Then:** shed ledger (§2.4) → reminders (§2.5) → portal read-only (G9) → grower self-logging.

> Nothing here is committed to build. When the model feels right, the first slice goes through the normal `/ship` pipeline (brainstorm → migration → RLS + drift review → apply → smoke test).
