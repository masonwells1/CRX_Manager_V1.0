# Theme synthesis — ARCHITECTURE lens

**Date:** 2026-06-19
**Synthesizer:** architecture lens
**Source repos:** frappe/erpnext, twentyhq/twenty, microsoft/farmvibes-ai, ekylibre/ekylibre, LiteFarmOrg/LiteFarm, farmOS/farmOS
**Job:** dedupe the 14 raw "architecture"-tagged scout ideas into a clean, ranked set for CRX Manager (an ag-retail **dealer** platform on Supabase Postgres + React).

## How the raw ideas collapsed

The 14 raw candidates clustered into **8 deduped themes**. The big dedups:

- **Custom fields** appeared 3× (twenty `fieldMetadata`, ekylibre `custom_field`, farmOS `Term`/`Data` escape-hatch) plus an *enabler* (twenty colored-tag SELECT option). Merged into **one** theme with the tag-option shape folded in as the recommended sub-component. farmOS's freeform-JSON "Data" escape-hatch is the cheap stopgap *within* the same theme, not a separate idea.
- **i18n** appeared 2× (twenty Lingui, litefarm i18next) → **one** theme; Lingui/react-i18next are both MIT libraries, so the borrow is "adopt the library + the en/es catalog config," not source.
- **Inventory valuation / ledger replay** spanned 2 architecture ideas (erpnext Repost Item Valuation + farmOS derived event-sourced inventory). They are two halves of the *same* re-architecture: stop trusting a mutable `inventory.quantity_available` column, derive on-hand from the ledger, and make corrections a controlled replay. Merged into **one** theme. (The erpnext FIFO/moving-average *valuation* formula itself is a financial-lens candidate handled by that synthesizer — this theme is the architectural spine it would sit on.)

**Grounding check (verified against live CRX, not memory):**
- `financial_audit_log` today is `(entity_type, entity_id, action, old_data/new_data jsonb, performed_by)` — it has **no** `reverses_id`/`against_voucher` linkage. So the "against-voucher reversal" idea is a real addition, not already-present.
- On-hand stock is a **mutable** `inventory.quantity_available` column with a separate `inventory_transactions` audit trail that carries **no** running `qty_after_transaction`/`valuation_rate`. So derived-inventory + repost is a genuine gap (and is exactly the disciplined mechanism for Mason's H1 "re-base 17 negative-inventory products").
- No `custom_field*`, `offline_event*`, `field_mode_offline*`, `valuation_reposts`, or taxonomy table exists on disk. All themes below are greenfield.

**License posture:** every source repo here is copyleft (AGPL/GPL) **except** farmvibes (MIT). So everything is **idea / data-model shape / formula only, clean-room on Supabase+React** — with the single exception of the farmvibes geometry-hash, which is ~10 lines of MIT and may be lifted with attribution.

---

## Ranked deduped set

### 1. Metadata-driven custom fields (registry + jsonb values + colored-tag options) — **Relevance 5, Effort L**
**CRX has** hard-coded columns; a new per-dealer attribute (e.g. a customer's co-op number, a product's mode-of-action group) needs a developer + a migration every time.
**Best repo does** Twenty's `fieldMetadata` row *is* the schema (`name`, `type`, `options` jsonb, `defaultValue` jsonb, `isNullable`, unique on `(name, objectMetadataId, workspaceId)`); ekylibre's `custom_field` is the lighter version (`customized_type`, slugged `column_name`, `nature` enum text/decimal/boolean/date/choice, min/max validators, values in a `custom_fields` jsonb column on the host row).
**We'd build** a **scoped** version (full runtime-schema is overkill for one dealer): a `custom_field_defs` registry (`entity_type` enum customer/product/field/order, `field_key` slug, `label`, `data_type`, `options` jsonb, `is_required`, `position`, `is_active`) + a `custom_fields` jsonb column on each host table, GIN-indexed. A React `<FieldRenderer>` reads the defs and renders/validates inputs; an admin "Custom Fields" settings page manages them. **Fold in Twenty's colored-tag option shape** `{id, position, label, value, color}` for SELECT-type fields (and reuse it for customer/product tags) — a shared `<Tag>` component maps the color name to a Tailwind class.
**Risk** the heaviest item here; scope-creep toward a full runtime-schema engine is the trap — hold the line at "extra typed fields on 4 entities, jsonb-stored." jsonb values bypass CRX's column-level RLS/type discipline, so validation lives in the renderer + a CHECK, not the DB type system.
**License** AGPL (twenty) / AGPL (ekylibre) — data-model shape only, clean-room. The color palette is generic.

### 2. Offline event log for Field Mode replay (idempotent) — **Relevance 5, Effort M**
**CRX has** a `/my-route` Field Mode driver workspace, but the **offline replay path is incomplete** (named gap; a driver who queues deliveries/applications offline has no exactly-once replay on reconnect).
**Best repo does** LiteFarm's `offline_event_log` (`session_id` uuid, `event_name`, `status_code`, network/browser/os/device_model, `app_version`, `event_at`, `went_online_at`) with **`UNIQUE(session_id, event_name, event_at)`** so replays are idempotent.
**We'd build** a `field_mode_offline_events` table with a uniqueness key on (device session, event, timestamp); the reconnect handler replays queued events through the existing mutating RPCs, deduped by that key. This rides CRX's existing `idempotency_keys` discipline rather than inventing a new mechanism (each replayed write also carries its `p_idempotency_key`).
**Risk** low and contained — additive table; the real work is the client-side queue/replay logic, not the schema. Must reconcile the uniqueness key with CRX's existing idempotency convention so the two don't fight.
**License** GPL (litefarm) — data-model shape only.

### 3. Event-sourced inventory + repost-from-date replay — **Relevance 4, Effort L**
**CRX has** a **mutable** `inventory.quantity_available` column plus an `inventory_transactions` audit trail that carries no running balance; corrections to back-dated counts are ad-hoc `adjusted` rows. CRX has 17 negative-inventory products and an open owner task (H1) to re-base them from physical counts.
**Best repo does** farmOS *derives* on-hand: `inventory = Σincrements − Σdecrements since the most recent reset`, per (measure, unit). ERPNext's **Repost Item Valuation** is the controlled job (`item_code`, `posting_date`, `recalculate_valuation_rate`, `allow_negative_stock`, `status`, `error_log`) that replays the ledger *forward* from a back-dated correction so qty/value stay internally consistent.
**We'd build** (a) adopt the **reset-anchor** idea — a periodic reset row from a cycle count + signed adjustment rows, so on-hand is recomputable from the ledger and auditable; reconcile against CRX's existing 12 txn types. (b) A `valuation_reposts` job table + an idempotent RPC that, given a product and an as-of date, recomputes the ledger forward and writes a **single reconciling adjustment** with an audit trail — the disciplined mechanism for H1 instead of hand-entered correction rows. This is the architectural spine the FIFO/moving-average *valuation* formula (financial lens) would sit on.
**Risk** highest-stakes here — it touches the inventory source of truth that the whole sell→deliver pipeline reads. Must be additive-first (derive in a view, prove it equals the stored column, *then* consider flipping the source of truth). Negative-stock handling is the subtle bit (erpnext freezes the rate when the balance would go negative). Gate behind a migration review + a rolled-back smoke test; never re-base live counts without Mason's explicit OK.
**License** GPL-2.0 (farmOS) / GPL-3.0 (erpnext) — formula + job-concept only, clean-room.

### 4. "Against-voucher" reversal columns on the audit log — **Relevance 3, Effort S**
**CRX has** an append-only `financial_audit_log`, but a correction is a fresh row with no link back to what it offsets — you can't cheaply trace "this reversal cancels that posting."
**Best repo does** ERPNext never edits/deletes a posted GL Entry; a correction posts a new `is_cancelled` row pointing back via `against_voucher_type`/`against_voucher`, keeping the ledger immutable yet self-documenting.
**We'd build** add `reverses_id` (self-FK) + `against_voucher_type`/`against_voucher` columns to `financial_audit_log`, and adopt the convention that every correction posts a *linked* reversal rather than a bare row. Makes period close and statement re-derivation trivially auditable. Low effort because the append-only spine already exists; pairs naturally with the (financial-lens) double-entry ledger if that ships.
**Risk** very low — additive nullable columns + a code convention. Main risk is half-adoption (some RPCs link, some don't), so enforce via a small reviewer/lint check.
**License** GPL-3.0 (erpnext) — pattern/concept only.

### 5. Geometry+time idempotency hash for external-data caches — **Relevance 3, Effort S**
**CRX has** an `idempotency_keys` convention for writes, but no dedupe key for *reads* from paid external APIs (weather/imagery/soil) — relevant once any field-intel feature lands.
**Best repo does** farmvibes' `gen_forecast_time_hash_id`: a deterministic SHA-256 over `(name + canonical WKT geometry + publish_time + time_range)` to dedupe identical data pulls.
**We'd build** the same hash as the cache key for external-data pulls: `key = hash(source + field_WKT + window)`, so a re-pull for the same field/window is a no-op. Small infrastructural enabler — bundle it with whichever field-intel feature (NDVI/weather/soil) ships first; on its own it has nothing to cache yet.
**Risk** minimal — ~10 lines. The only nuance is canonicalizing the WKT before hashing so geometrically-identical polygons hash equal.
**License** **MIT (farmvibes)** — the one item here whose code may be lifted with attribution; re-expressed in TS/SQL anyway.

### 6. Exact-fraction (numerator/denominator) rates — **Relevance 3, Effort S**
**CRX has** money as `bigint` cents (correct), but agronomic **rates** and split allocations are still decimals/floats — a drift risk in per-acre math and penny-exact reconciliation (the split-invoices-by-acre work already had to be made "penny-exact").
**Best repo does** farmOS stores every Quantity as two integers (numerator/denominator), preserving exact fractions for rates and splits.
**We'd build** store rate as integer numerator/denominator (or a scaled integer) where exactness matters — `order_item_field_allocations` and application-rate fields — so per-acre math never accumulates float error.
**Risk** low but invasive in a narrow way: it changes how rate fields are read/written everywhere they're used, so scope it to the allocation/rate columns that actually reconcile, not all decimals. Reuses CRX's existing cents-discipline mindset.
**License** GPL-2.0 (farmOS) — numeric-representation idea only.

### 7. pending/done/abandoned status + revision history on ops events — **Relevance 3, Effort M**
**CRX has** a job lifecycle (scheduled→in_progress→completed) but no unified "a plan became the record of what happened," and no revision trail on application records — weaker compliance audit story than it could be.
**Best repo does** every farmOS Log carries `pending → done → abandoned`, and every edit is stored as a revision, so a planned application visibly evolves into the canonical record of the event.
**We'd build** apply the planned→done→abandoned framing to scheduled applications/jobs (partly present) **plus** a revision trail on `application_records`, so the scheduled and completed application are one row's history — strengthening the RUP/compliance audit story. Implement on the existing append-only `financial_audit_log` pattern (ops-event variant), no new lifecycle tables.
**Risk** low-medium — mostly a convention + a revision side-table; the trap is duplicating the job lifecycle CRX already has, so this should *extend* application_records specifically, not re-model jobs.
**License** GPL-2.0 (farmOS) — workflow idea only.

---

## Killed / out of scope
- **Twenty colored-tag SELECT option (raw #4)** — not killed, **folded into theme 1** as its enabler (it only has value as part of the custom-fields SELECT type + tagging).
- **farmOS Term vocabularies + "Data" escape-hatch (raw #12, #14)** — **folded into theme 1**; the freeform-jsonb escape-hatch is the *cheap stopgap version* of custom fields, and the taxonomy idea overlaps the registry. Not a separate build.
- Nothing here is grower-only noise — all 8 architecture themes are dealer-relevant infrastructure. The lens stayed clean.

## One-line recommendation for Mason
The two highest-leverage, gap-filling, *low-risk* picks are **#2 (offline Field Mode replay)** — it finishes a feature you already shipped and is contained — and **#4 (audit-log reversal columns)** — a few hours that makes your financial trail self-documenting. **#1 (custom fields)** is the biggest strategic win but the heaviest; do it scoped, not as a runtime-schema engine. **#3 (event-sourced inventory)** is the one to treat with the most care — it touches the inventory source of truth, so additive-first and Mason-gated.
