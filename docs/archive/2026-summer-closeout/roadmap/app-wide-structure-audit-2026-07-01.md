# App-Wide Structure Audit — Quotes · Invoices/AR · Orders · Deliveries · Customers/Fields · Purchasing/AP · Blend Tickets · Settings · Cross-cutting

**Date:** 2026-07-01 · **Status:** RESEARCH ONLY — no code changed. Companion to [product-units-scheduling-deep-dive-2026-07-01.md](product-units-scheduling-deep-dive-2026-07-01.md) (the units/category/scheduling plan, "the Phase plan" below).
**Method:** 10 parallel read-only domain analysts + a completeness critic (11 agents, ~2.2M tokens), every claim carrying file:line or live-SQL evidence, plus a live Chem-Man walkthrough of their Invoices/Chemical-Sales/Inventory modules. Analysts were told NOT to re-report the prior deep-dive's findings.
**Timing fact that shapes everything:** every AR-side table is EMPTY live (0 payments, allocation_sets, write_offs, finance_charges, prepay rows; 4 draft invoices). Constraints and lookups added NOW are zero-backfill; after the first real billing cycle each becomes a data-migration project.

---

## TIER 0 — Broken features (bugs found in passing; fix before/with everything else)

1. **save_quote silently drops 4 fields the UI edits** (`is_planned`, `section_header_notes`, `needed_by_date`, `field_id`) and wipes them on every re-save via its section DELETE+re-INSERT — verified against live `pg_get_functiondef`. Breaks: Planned Program hold creation (create_planned_holds always errors), quote-section→job scheduling (job gets today's date, no field, no notes — `20260405100000:78,108-115`), order program_notes handoff. Regression trail: `20260609195843` persisted them; `20260613191120`/`20260616204400` rebuilt from a reduced body (the pending-migration-clobber class). **FIX RULE: rebuild from live fn source, additive reads only, grep sibling pending migrations for another save_quote emission first.**
2. **PHI safety guardrail is permanently blind:** `field_crop_history.harvest_date` has NO write path anywhere (only writer is a crop_type-only trigger), yet 4 shipped consumers read it (`JobDetail.tsx:1234`, `FieldApplicationInvoice.tsx:493`, `FieldAppChemicalEntry.tsx:96`, proof-notification RPC `20260630160000:111-117`). Unlike the label CSV, no data load can fix this — the entry point doesn't exist. Table has RLS insert policies already; small FieldDashboard editor (or capture at job) wires it.
3. **Blend-ticket product select never persists** — stale-closure double-setState (`ManualTicketCreate.tsx:459-466`, `BlendTicketDetail.tsx:1088-1094`): the office picks a product, product_id stays null → $0 pricing, FK crash on create-order (fabricated `gen_random_uuid()`), 0-item order links. Two-line frontend fix per file.
4. **save_blend_ticket ignores `job_id` + `application_service_id`** (dead dropdowns on BlendTicketDetail) → the application-fee lines and quoted-pricing branches inside create_invoice_from_blend_ticket are unreachable from the UI. One additive CREATE OR REPLACE.
5. **quantity_on_order live drift on 20 products** (worst: 9,000 expected vs 0 stored): 3 PO write paths (RPC / direct status UPDATE / direct OCR INSERT-as-submitted that the trigger misses) + dual bookkeeping. Fix = single PO write path + make on-order derived (or recompute + fire-on-insert); rolled-back smoke diff on all 604 products before applying.
6. **create_quick_delivery bills $0 on missing tier price** while 5 hand-mirrored frontend cascades fall back to tier1 and show a real total — client-shows-price/server-bills-$0. One RPC fix + one shared getTierPrice.
7. **Blend billing/inventory has zero unit conversion** — the ~128× field-app class, live and unguarded in `create_invoice_from_blend_ticket` (rate×acres at tier price, no conversion), plus TWO more complete_job-class unconverted inventory writes: `create_order_from_blend_ticket` (prebook) and `create_application_record_from_blend_ticket` (deduct). Also: OCR parses rate_per_acre then THROWS IT AWAY → every OCR ticket line bills $0 until re-keyed, and $0-rate lines are silently dropped from invoices. (Tables empty today — fix before first ticket.)
8. **Chemical-sale invoices can never get a due_date** (no UI input, no RPC default, no terms→days), yet the ENTIRE late-AR machine keys on due_date: daily posted→overdue cron, generate_finance_charges, Office Cockpit overdue tile, PrepayWorkspace flags. Field-app invoices get a hardcoded +30d (`20260219210000:117`) + an editable input — the two paths need one terms-driven rule. PDF prints "On receipt" when null. **Policy decision required (see Owner Decisions).**
9. **Month-end close guards nothing:** only the current calendar month can be closed, zero months ever closed live, and `check_period_open` treats missing months as open — the "NEVER bypass check_period_open" red line currently protects zero dates. Needs month picker + period seeding before real billing. (Behavior change on historical dates — own owner decision, not a ride-along.)
10. **Email dedup is structurally inert:** every send-email caller appends `Date.now()` to the idempotency key (emailService.ts:140), so the edge function's real dedup can never fire; invoice email built by 3 divergent builders across 5 call sites.
11. **get_expiring_planned_holds has zero callers while 9 live crop-program holds carry expiry dates** — holds can lapse silently, un-reserving product Mason believes is held. One dashboard card wires it.
12. Minor but proven: `convert_to_gl_lb` pint/quart client-vs-server drift (already in Phase 3.2); `create_job_from_quote_section` idempotency lookup missing `AND operation=` (the restore_quote_version class) — fix inside the same migration as #1.

## TIER 1 — The vocabulary disease is app-wide (same class as units/category)

Live-SQL-proven drifted vocabularies, worst first:

| Vocabulary | Where it lives | Live drift proof | Fix shape |
|---|---|---|---|
| **Vendor** | free text on products/POs/receiving/job lines + 13-row `vendors` table (AP-only) | typo pairs ARE master records: "The Anderson's"/"The Andersons", "Van Diest"/"Van Deist"; a PO vendored to **"we"**; bill↔PO link is exact-string and hard-fails on the typos | vendors-table pickers everywhere first (frontend); vendor_id FKs + owner-approved merge later — **merge re-buckets AP spend history: Mason signs the mapping** |
| **Manufacturer** (critic's find — nobody audited it) | products.manufacturer 602/604, 41 distinct | Syngenta/Syngtenta/Syngeta, Corteva/Cortteva, NuFarm case-split, "Bayer (BASF)", 116× "Various", 3× "Test Mfg", 1 blank — and **Rebates joins manufacturer money claims on an independently free-typed string** (Rebates.tsx:700-701) | same lookup wave as categories; rebates side is 0-row free |
| **Warehouse/location** | 'Main Warehouse' hardcoded in 2 frontend files + inside create_quick_delivery SQL + complete_job; 4 free-text columns; 1-row orphan `warehouses` table; 3 divergent stock-check patterns | 114 inventory rows all one string — **the cheapest moment ever**; second warehouse today = silent stock fork | bind all entry points to warehouses table now (frontend-first), FK later |
| **Crop** | ≥8 representations: 6 live columns + customers' hardcoded corn/soybean/other_acres + crop_programs JSON | two hardcoded lists disagree ('soybean' vs 'soybeans'); job-line crop free text; 0-populated county | one crop lookup (clone the product_categories migration), feeds Phase 4.2 Apply-Program |
| **Payment terms** | 3 shapes: customers free text, invoice free-text override, vendors label+days (the CORRECT pattern, already in-house) | 'net_30' vs 'Net 30' vs '' at n=8; prints verbatim on customer PDFs | terms select + `payment_terms_days` int; drives Tier-0 #8 |
| **Payment method** | 3 divergent hardcoded UI lists → 5 columns; only CHECK sits on the DEAD `payments` table (0 rows) and bans 'wire' which two UIs offer | designed-in divergence before any real payment exists | one shared list + CHECKs on allocation_sets/commission_payments/vendor_payments while all are empty |
| **People identities** | applicator/driver/mixer free text BESIDE existing FK columns (blend_tickets, invoices.applicator_name); commission recipients = hardcoded 4-name array in CommissionSplitEditor.tsx:5-10 + free-text 'Other' | live commission row with recipient='' ; app-record bridge is exact case-sensitive name match | profile-driven pickers writing id+name-snapshot; recipients from profiles (service profiles already exist, `20260516090000`); critic: recipient_user_id already populated 33/34 — fix the PICKER, not a new FK |
| **unit_size ≡ inventory_unit** | duplicate product columns, independently editable | 594/604 identical; the 10 divergent incl. 3 self-contradicting Piksi MG products; snapshots carry 'Gallon ' (trailing space), 'Lb'/'LB' | collapse into Phase 1 backfill (ride-along) |
| **Reasons / misc** | write-off & void reasons free text (Returns has the enum pattern to copy); wind direction free text on WPS-printed docs; state drifted 'IL'/'Illinois'/'IN' at n=5; activity_feed.event_type 43 spellings, no registry; notification_type unchecked | — | reason enums; 16-pt compass select; state dropdown; typed event registry (frontend const) |

**Choke-point map (critic + analysts):** invoices/payments/deliveries/quotes/jobs/customers/fields all HAVE RPC choke points (good skeleton) — but products (4 direct writers), POs (3 writers), order_shares/order_item_field_allocations, customer_application_rates, rebate programs (direct insert/update/hard-DELETE), and BulkCustomerImport/BulkQuoteImport bypass theirs. **BulkQuoteImport is the worst side door:** raw inserts skip server recalc (quotes.total_price stays $0 → poisons list/convert/commissions), free-text rate_unit re-pollutes the ONE domain whose units are clean, CSV can mint 'accepted' quotes. Route through save_quote.

## TIER 2 — Placebo & dead structure (schema/UI lying to the owner)

- **6 of 15 app_settings keys are placebo** — Company Info ×4, default_quote_valid_days (stored 30, code hardcodes 15 at QuoteBuilder.tsx:196), default_tier consumed by nothing; ocr_confidence_threshold stored 85/50 vs hardcoded 70/70. companyInfo.ts:11-13 even has the "FUTURE: thread settings here" note. Wire or remove ("Settings truth pass").
- **Dormant-but-valuable (wire up):** reorder_point displayed + drives ActionQueue but NO edit UI and 0/114 set (= ChemMan "Reorder Report" gap); tier1/2/3_price_per_acre trigger-maintained on 560 products with ZERO readers (QuoteBuilder re-derives by hand); quotes.season never stamped (dead column, no list filter); pdf_template_id/pdf_columns_override dormant (office re-picks columns every session; emailed vs downloaded PDFs can differ); credit memos invisible (no page names them, no apply workflow — only an orphan unapply RPC); prepay bucket labels + finance-charge minimum have no admin UI; unit_conversions/warehouses/ingredient_map have no management page (BrandVsGeneric's empty state tells a no-code owner to edit the raw table).
- **Dead (retire):** legacy `payments` table + record_invoice_payment RPC (0 rows, UI-invisible second payment path — booby trap); order_line_allocations; rate_limit_log; document_processing_log; jobs.tags + jobs.batch_id (vs the wired job_tags/job_batches); receipt_pdf_url; allocation_sets.check_number (write-never twin of reference_number); create_prepay_credit RPC (no caller); dead 'digital' source enum; delivery photo captions rendered but un-enterable; order-status modal options the handler always rejects; 12 all-NULL invoice_items columns; customers.city/state/zip/shipping_address 0/153 while invoice PDFs read them (pick a model or drop).
- **Live junk data (owner-gated deletes):** 8 'RTJ Recipe' test rows polluting two production recipe pickers; 3 'Test Mfg' products; vendor 'we'; the 5 non-email strings in customers.email (23/153 email coverage blocks §6 proof notices for 130+ customers).
- **Duplicated concepts needing a DESIGN DECISION, not code yet:** FOUR parallel split-billing mechanisms (order_shares %-split, order_item_field_allocations, field_app_location_shares, job_field_shares) + the dead order_line_allocations twin, and TWO as-applied stores (application_records vs job_applied_records). One-page canonical-model decision before the first real billing season.

## TIER 3 — Consistency & UX debt

- Product picker = 3 different interfaces for the same office task (QuoteBuilder searchable modal = best; job grid flat 604-option select; field-app type-ahead). Extract QuoteBuilder's as THE shared picker (delivers Phase 4.1).
- Delivery scheduling already has the calendar, 7-day strip, batch reschedule, overload guardrail jobs lack — **extract the chassis and reuse for jobs (Phase 4.6 becomes a refactor, not a build)**.
- Quote expiry: 3 different answers per path (re-based on every save / computed from created_at in email / stamped today on download). Server-side expiry from created_at.
- Aging: 2 bases × 2 bucket boundaries across 4 surfaces (a 30-day invoice is 'Current' on the statement, '30 Days' on the aging report). One SQL bucket function; Mason picks the basis once.
- Permission matrix hand-duplicated: App.tsx allowedRoles vs Sidebar roles (~90 entries, 2 copies + in-RPC third layer). Single config both consume.
- Combobox is suggest-only by design — add a strict mode so every future vocabulary adoption inherits enforcement.
- Stragglers (one cleanup PR): BulkPOImport date-as-text; blend ticket_time free text; 'Strip' as N/Y text input; TeamBoard raw-UUID entity linking; phone validated on 1 of 5 pages; blend manual entry = densest unstructured page (comma-separated field names vs the existing field picker).
- Two weather generations written from one screen (free-text wind/temp + structured start/end) — stop writing the legacy pair.
- PO money is numeric dollars vs the bigint-cents red line — document the fence + hook rule (full conversion not worth it now).

## How this merges with the approved phase plan (critic's ride-along manifest)

**RIDE-ALONGS (absorb into existing phases — same patterns, same gates, ONE E2E fixture PR):**
- Phase 1 (units): collapse unit_size≡inventory_unit; normalize order/delivery unit_size snapshots ('Gallon ' etc.); units module also feeds blend-ticket lines + PO lines; canonical+synonym COLUMNS on unit_conversions (NEVER rename rows — frozen keys); snapshot unit_size server-side from the product master in the delivery RPCs.
- Phase 2 (category lookup): clone the pattern for **crop** and **manufacturer**; vendors-table pickers (UI-only part); E2E fixtures update (categories + units + payment_terms 'net_30' at e2e-constants.ts:46-101 — 'Fertilizer'/'Adjuvant' must exist in the seeded list).
- Phase 3 (correctness): add the two blend RPC unit conversions + PO receive-time conversion + create_quick_delivery tier fix + save_quote field restore + blend dead-wire fixes to the same gated migration wave.
- Phase 4 (scheduling): warehouse dropdowns everywhere = the home for ALL warehouse findings; shared product picker; delivery-chassis calendar reuse; wire reorder_point editing (was Phase 5, promote).
- Owner-gated data-cleanup migration: sweep RTJ recipes, 'Test Mfg', 'we', unit drift, category remap in ONE reviewed pass.

**NOT ride-alongs (each needs its own Mason decision cycle — money-behavior changes):**
1. **Due-date/terms policy** (Tier-0 #8): derive due_date at post time going forward, NEVER backfill posted invoices (retroactive overdue/finance-charge exposure); pick aging basis.
2. **Vendor + manufacturer merge mapping** (re-buckets AP spend + rebate history irreversibly; which spelling is the legal entity is a business fact).
3. **Month-end seeding/catch-up** (flips guard behavior on historical dates).
4. **Split-billing consolidation** (design doc first).

## Owner (Mason) decisions queue
1. Approve the **Tier-0 broken-features fix wave** (recommended first — most are S-effort, all gated individually).
2. Vendor/manufacturer **merge mappings** (we'll generate the side-by-side lists for sign-off).
3. **Due-date policy**: age from invoice date or due date; default terms Net 30?
4. **Junk-data deletions**: RTJ recipes, 'Test Mfg' products, vendor 'we', 5 bad emails (list will be provided; deletes are yours to approve).
5. **Retire-vs-wire calls**: ingredient_map/BrandVsGeneric page, CropPrograms+ProgramTracker (wire to jobs or retire), per-acre tier pricing columns (surface in QuoteBuilder or drop trigger), dead tables drop migration.
6. Confirm 'wire' as an allowed payment method (two UIs offer it; the old CHECK bans it).

## Verification note
All claims above came from read-only analysts + an adversarial critic pass that cross-checked contradictions against the live DB (three were resolved and are reflected here). Per house rules, the implementing session must still re-verify each item against live code/schema before changing it — especially save_quote (rebuild from live source) and anything touching posted financial rows (never rewritten).
