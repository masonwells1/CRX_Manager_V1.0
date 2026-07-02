# Structure Wave-2 Loop — Mission Spec (2026-07-02)

**Owner intent (Mason, this session):** after Wave-A items A12+A13 shipped live, Mason went through ALL remaining
parked items and made the decisions below. Phase 1 (4 quick migrations) is being executed **in the main session**;
this loop owns **Phase 2 + Phase 3**. "Run it in a loop where Codex reviews and don't ask me unless generally needed."

**You are:** an autonomous Claude Code session in a **fresh dedicated worktree** on a **new branch off `main`**
(e.g. `git worktree add C:\CRX_StructureWave2 -b fix/structure-wave-2b origin/main`). Codex CLI is your independent
reviewer. Do **NOT** run in `C:\CRX_StructureFix` — that worktree/branch is in active use by the Phase-1 session.

## Locked decisions (do NOT re-ask these — Mason already decided, 2026-07-02)
- **Category remap:** YES — do the two-axis model (functional `category` + optional `use_timing` tag).
  The 2 genuinely-ambiguous buckets ("Foliar Nutrition & Liquid Fertilizer" → one of Foliar/Liquid Fertilizer;
  "Utility" → Charge/Service or Other) and the **6 empty-category products** → PARK a proposed classification for
  Mason to confirm (propose, don't guess-and-apply). Everything else maps per Packet 2 in `owner-decisions-2026-07.md`.
- **Dead-code retire:** YES — retire the unused legacy structures (legacy `payments` table [booby-trap 2nd payment
  path], `order_line_allocations`, `rate_limit_log`, `document_processing_log`, `jobs.tags`/`jobs.batch_id`,
  `receipt_pdf_url`, `create_prepay_credit`). Verify 0 rows / 0 readers live before dropping each.
- **Wire up all 3 half-built features** (Mason chose to KEEP all three, retire none of them):
  (a) **ingredient_map** brand↔generic management page; (b) **Crop Programs → jobs** ("Apply Program" into jobs,
  the deep-dive's Phase 4.2); (c) **per-acre tier pricing** surfaced in the Quote Builder (`tier1/2/3_price_per_acre`,
  trigger-maintained on 560 products, zero readers today).
- **Big builds — all three wanted:** A5 (blend unit math), A9 (month-end catch-up), Wave B (units cleanup).
- **A11 (expiring-holds card):** HOLD OFF — dormant (all holds have `expires_at = NULL` live); do not wire a
  permanently-empty card. Not in scope.
- **"Bayer (BASF)":** leave as-is (not a merge). Handled in Phase-1 merges.

## Hard gates (non-negotiable — same as the Wave-A loop)
1. **NEVER apply a live migration.** All SQL ships PARKED in `scripts/.staging-migrations/` with smoke evidence +
   Codex verdict in the header. Mason's later APPLY session (with per-migration OK) moves + applies them.
2. **NEVER deploy an edge function** (A5 touches `process-blend-ticket`): commit the code, PARK the deploy.
3. **NEVER delete/mutate live data.** Read-only SELECTs + `BEGIN;<sql>;ROLLBACK;` smokes + `plpgsql_check` only.
   Dead-table drops ship as parked migrations too (Mason applies).
4. **NEVER push to `main`.** Push the loop branch to origin after each cycle (backup); merge to main happens with Mason.
5. Stop/pause = hard halt (checkpoint the ledger). Don't touch sibling worktrees (`git worktree list` first).

## Per-cycle protocol
Verify-vs-live first (the specs below are grounded but re-confirm) → smallest correct fix (house patterns:
SECDEF + `SET search_path`, `p_idempotency_key` scoped `AND operation=`, bigint cents, `assertRpcResult`/
`checkMutationResult`, revoke anon on new SECDEF fns, register error tokens in `src/lib/db.ts`) → PROVE it ran
(rolled-back `plpgsql_check` for RPCs / open the page for UI) → **mandatory `/codex-review` (≤3 rounds)** → commit →
push branch → update this loop's ledger.

## PHASE 2 worklist (do first — medium builds)
| # | Item | Ships as | Spec source |
|---|---|---|---|
| P2-1 | Category two-axis remap (add `use_timing`, remap 19 values, backfill BEFORE any enforcement) + park the ambiguous-2 + 6-blank proposal for Mason | parked mig + frontend (ProductDetail/BulkImport category selects) | Packet 2, `owner-decisions-2026-07.md` |
| P2-2 | Retire dead tables/columns (verify 0 rows/readers each, then DROP) | parked mig | Packet 5 dead-tables row |
| P2-3 | Ingredient-map (brand↔generic) management page | frontend (+ mig only if a write RPC is needed) | Packet 5 |
| P2-4 | Crop Programs → "Apply Program" into jobs (make CropPrograms/ProgramTracker consumed) | frontend + parked mig | Packet 5; deep-dive Phase 4.2 |
| P2-5 | Surface per-acre tier pricing in QuoteBuilder (readers for `tier{1,2,3}_price_per_acre`) | frontend | Packet 5 |

## PHASE 3 worklist (the big builds)
| # | Item | Ships as | Spec source |
|---|---|---|---|
| A5 | Blend unit conversion: convert rate→inventory unit in `create_invoice_from_blend_ticket` / `create_order_from_blend_ticket` / `create_application_record_from_blend_ticket` via `field_app_priced_quantity`; carry OCR `ratePerAcre` into `blend_ticket_products.rate_per_acre`/`_unit` (edge-fn code, deploy PARKED); warn/refuse $0-rate billable lines | parked migs (per-RPC) + edge-fn code | ledger "Remaining Wave-A items" A5 |
| A9 | Month-end catch-up: month/year picker in `MonthEndClose.tsx` + seed prior `accounting_periods` as 'open' before first real billing. GOTCHA: pull LIVE `close_accounting_period` first (differs from `20260217200000` source). Behavior change on historical dates | parked mig + frontend | ledger A9 spec |
| WaveB | Units Phase 1: `src/lib/units.ts` canonical module (cached from `unit_conversions`) → rate-unit dropdowns (ProductDetail:470, JobDetail:2964/2986, field-app line UM, LabelReview, CropPrograms) → read-only unit-drift report for Mason → normalization UPDATE parked mig (backfill BEFORE enforcement) → normalize-on-save in bulk importers → E2E updates. FROZEN-KEYS: never rename `unit_conversions` rows; canonical/synonym cols additive only | parked migs + frontend | ledger Wave B spec + `product-units-scheduling-deep-dive-2026-07-01.md` |

## Definition of done
Every P2/P3 item DONE (proven + Codex-clean + committed) or PARKED (with reason). Ledger complete
(`docs/loops/structure-wave-2-ledger.md`), with a handoff at the top: apply-order for the parked migrations,
the parked owner-confirms (category ambiguous-2 + 6 blanks), and a plain-English summary leading with what's safe
to apply vs what needs Mason's call. Do NOT merge to main; do NOT apply anything.
