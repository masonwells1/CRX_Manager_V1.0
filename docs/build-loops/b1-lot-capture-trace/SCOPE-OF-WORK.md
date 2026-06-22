# Scope of Work — B1: Lot Capture & Trace

> **Self-contained spec.** The session building this has no memory of the planning conversation. Everything needed is here + in `BUILD-LOOP.md` (how to build it) + `STATE.md` (progress). Parent vision: `docs/audits/2026-06-19-future-projects-idea-mining/UNIFIED-LONG-TERM-PLAN.md` (item **B1**).

## 1. What & why (one paragraph)
CRX Manager is an ag-retail **dealer** platform (sells + custom-blends + applies crop chemicals/fertilizer, carries the compliance load). Today, the **product LOT/batch number is tracked only on paper.** The business cannot answer the recall/compliance question: *"which lot of which product went on which field, on what date, for which customer?"* B1 brings lot into the system and links it to what was actually applied. This is the keystone the future grower portal and compliance-packet generator build on.

## 2. Owner decisions (locked — do not re-litigate)
1. **Depth = "Capture & trace" only.** Record which lot(s) were applied so we can trace lot → field → date → customer. **No inventory math** — no quantity-on-hand-per-lot, no FIFO, no "how much of lot X remains." (That heavier inventory-valuation work is deferred to Wave C; do NOT pull it in.)
2. **Capture point = "Both."** Lot is recorded at **receiving** (suggested to the user) AND confirmed/overridden at **application** time.
3. **Multiple lots per product = YES.** One product on one application may come from more than one lot (e.g. two jugs from two lots on the same field). Store lot as a *list* per product line.

## 3. What ALREADY EXISTS (do NOT rebuild — verified against live code 2026-06-22)
The application-record subsystem is mature. Confirm each still true before building, but the design assumes:
- `application_records` (canonical "what was applied"): `product_data` JSONB array `[{product_id, product_name, quantity, unit, rate_per_acre, rate_unit, epa_registration, is_rup}]`, `applicator_id`→profiles, `vehicle_id`→vehicles (equipment), `application_date`/`application_time`, `weather_conditions` JSONB, `customer_id`, `invoice_id`, `source_type`('job'|'blend_ticket')+`source_id`. Migration `20260214220000_application_records_table.sql`.
- `application_record_fields` (per-field acres treated): `application_record_id`, `field_id`, `acres`. Migration `20260430150000_field_app_workflow_phase2.sql`.
- `field_app_locations` / `field_app_location_shares` (per-field/per-customer billing splits for field-app invoices). Migration `20260406100000_field_app_workflow_v2.sql`.
- Lot already exists as **loose text** (the raw material to reuse): `receiving_records.lot_number` (text; table also has `product_id`, `quantity_received`, `received_at`, `unit_size`; **NO `updated_at`**) — migration `20260226200000`; and `blend_ticket_products.lot_number` (text, per product, OCR-extracted) — migration `20260206203908`.
- Field-application → invoice flow already merged (`feat/as-applied-invoices`): `save_field_app_invoice`, `create_invoice_from_blend_ticket`, `update_field_app_applied_info` (migration `20260622030000`). **B1 must not disturb this billing path.**

**The ONLY real gap is lot.** Applicator, equipment, field, acres, products, rate, weather are all already captured.

## 4. What to BUILD (the changes — all phases together)

### 4a. Database (one new additive migration; no changes to existing columns/money/lifecycle)
- **New table `application_record_lots`** — one row per (application record, product, lot); multiple rows per product allowed. Proposed columns (verify types against live + canonical patterns):
  - `id uuid PK default gen_random_uuid()`
  - `application_record_id uuid NOT NULL REFERENCES application_records(id) ON DELETE CASCADE`
  - `product_id uuid NOT NULL REFERENCES products(id)`
  - `lot_number text NOT NULL`
  - `source_receiving_record_id uuid NULL REFERENCES receiving_records(id)` (set when chosen from a received lot; null if free-typed)
  - `quantity_from_lot numeric NULL` + `unit text NULL` (optional "how much from this lot" — informational only, no inventory math)
  - `notes text NULL`
  - `created_at timestamptz NOT NULL default now()`, `created_by uuid NULL REFERENCES profiles(id)`
  - **No `updated_at`** (rows are replaced, not edited) — keep off the no-updated_at hazard list.
  - **RLS REQUIRED** (every table must): mirror `application_records` policies — admin/sales INSERT, admin UPDATE/DELETE, appropriate SELECT.
  - Indexes: `(application_record_id)`, `(product_id)`, `(lower(lot_number))` for trace lookups.
- **RPC `set_application_record_lots(p_application_record_id uuid, p_lots jsonb, p_performed_by uuid, p_idempotency_key text DEFAULT NULL)`** — replaces the lot rows for one application record from `p_lots` (array of {product_id, lot_number, source_receiving_record_id?, quantity_from_lot?, unit?, notes?}). SECURITY DEFINER + `SET search_path = public, pg_temp`; canonical idempotency (`operation = 'set_application_record_lots'`); strict-actor (bind `auth.uid()`, reject mismatched `p_performed_by` with `ACTOR_MISMATCH`); validate each `product_id` is in the record's `product_data`. Returns `{ count }`.
- **RPC `get_recent_lots_for_product(p_product_id uuid)`** — read-only; returns recent distinct `lot_number`s for that product from `receiving_records` (and optionally `blend_ticket_products`), newest first, for the application-time suggestion dropdown. Admin/sales gated.
- **RPC `get_lot_application_trace(p_lot_number text)`** — read-only; returns every application that used that lot: product, lot, application_date, field(s), customer, applicator, record_number, invoice_id. Admin/sales gated. **This is the compliance payoff.**
- **Blend-ticket propagation** — when an application record is created from a blend ticket, auto-insert `application_record_lots` rows from the existing `blend_ticket_products.lot_number` so blend-sourced applications get lots with no re-typing. Add this as an *additive* insert at the end of the existing blend→app-record creation function (find it: migrations `20260609142548` / `20260610145350` area) — do not otherwise change that function's behavior.

### 4b. Frontend (React 18 + TS + Tailwind + Lucide; single Supabase client `src/lib/db.ts`; `assertRpcResult` after RPCs)
- **Lots-applied editor** on the application-record screen (`src/pages/ApplicationRecords.tsx` and/or `ApplicationServiceDetail.tsx` — confirm the canonical editor). Per product line: list lot rows, add/remove, **multiple per product**, with a suggestion dropdown from `get_recent_lots_for_product` + free-type override. Saves via `set_application_record_lots`.
- **Lot-trace / recall lookup** — a small page `src/pages/LotTrace.tsx`: enter a lot number → table of everywhere it went (via `get_lot_application_trace`). Lazy-import + Route in `App.tsx`, nav link in `AppLayout.tsx`. *(Owner open choice: own page vs a search box inside Compliance/Reports — default to own page; flip if owner says so.)*
- Surface lot on the field-application history where natural (e.g. FieldDashboard applications tab) — optional, low priority.

### 4c. Types & docs
- Add `ApplicationRecordLot` + RPC result interfaces to `src/types/index.ts`.
- Update `docs/reference/database-schema.md`, `rpc-functions.md`, `pages-routes.md`, CLAUDE.md Snapshot counts, `docs/CHANGELOG.md`. Run `node scripts/check-doc-drift.mjs`.

## 5. Out of scope for v1 (explicitly do NOT build)
- Inventory quantity tracking per lot, FIFO/average valuation, "remaining lot" math. (Deferred Wave C.)
- Lot expiry dates + expiry alerts. (Owner chose capture-and-trace, not the expiry option.)
- Photos / signatures on applications. (Owner marked non-essential.)
- Lots on deliveries. (v1 centers on field applications; deliveries are a later extension.)

## 6. Acceptance criteria ("done" for the build, before the human gate)
1. Migration written, **RLS present**, canonical idempotency + strict-actor + search_path on the mutating RPC, no overloads, no `updated_at` on the new table.
2. Migration **proven to run** — exercised end-to-end (Supabase dev branch preferred; else rolled-back-transaction smoke ending in `SMOKE_PASS_ROLLBACK`). NOT applied to prod.
3. The three RPCs behave: save lots (incl. multiple per product), suggest recent lots, trace a lot to its applications. Blend-ticket lots auto-propagate.
4. UI: lots editor works (multi-lot, suggestions, override); lot-trace lookup returns correct results.
5. `npm run typecheck && lint && build && test` all green. Component/unit tests cover the new RPCs + editor + trace (a regression test for any bug found).
6. Every phase passed its Codex review (verdict SHIP / SHIP-WITH-FOLLOWUPS) and the scoped subagent reviewers are clean.
7. Branch pushed to origin; **handoff packet written** listing exactly what the owner must approve.

## 7. Hard gates — the loop must NEVER do these autonomously
- **Apply the migration to the live DB** → owner's explicit OK only.
- **Merge to `main` / push to `main` / deploy** → owner's explicit OK (the UI calls RPCs that don't exist until the migration is live, so code-first-to-main would break prod — the whole feature lands together, gated).
- **Delete data.**
- If **Codex is unavailable** (CLI/auth down) → STOP and hand off; never proceed without the independent gate (fall back to the `/codex-cross-review` packet).
