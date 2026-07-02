# Structure-Fix Loop — Mission Spec (2026-07-02)

**Owner intent (Mason, verbatim):** "run this in a fresh session and want it in a loop where codex reviews and you don't ask me for input unless generally needed."
**You are:** an autonomous Claude Code session in the dedicated worktree `C:\CRX_StructureFix`, branch `fix/structure-wave-2026-07` (based on main @ ccc81f05). Codex CLI v0.142+ is installed and is your independent reviewer.
**Source findings (both in-tree, read them first):**
- `docs/roadmap/app-wide-structure-audit-2026-07-01.md` (Tier 0–3 + ride-along manifest) — Wave A comes from its Tier 0.
- `docs/roadmap/product-units-scheduling-deep-dive-2026-07-01.md` (the phased units/category plan) — Wave B = its Phase 1.

## Hard gates (non-negotiable, harness-enforced — do NOT route around)
1. **NEVER apply a live migration.** All SQL ships as PARKED drafts in `scripts/.staging-migrations/` (the established DRAFT/APPLY protocol), each with its smoke evidence + Codex verdict noted in a header comment. Mason's later APPLY session moves them.
2. **NEVER deploy an edge function.** Code changes to `supabase/functions/` are committed; deploy is parked.
3. **NEVER delete or mutate live data.** Live DB access = read-only SELECTs + `BEGIN;<sql>;ROLLBACK;` smoke runs + `plpgsql_check` only. No `[E2E]`-less writes, period.
4. **NEVER push to `main`.** Push the loop branch to `origin fix/structure-wave-2026-07` after each successful cycle (backup). Merge to main happens later, with Mason.
5. Stop/pause from Mason = hard halt (checkpoint the ledger first).
6. Don't touch sibling worktrees/branches (`git worktree list` before any teardown-ish action). Other sessions run in parallel; you own ONLY this worktree and branch.

## Autopilot
The flag `.claude/session-state/AUTOPILOT.on` in THIS worktree is pre-armed. If it expires mid-run: `node .claude/hooks/autopilot-arm.mjs --hours 12` (it only suppresses prompts for reversible work — the gates above stay blocked). Verify with `--status`.

## Step 0 (once, before cycle 1)
1. Read both roadmap docs end-to-end.
2. `/regen-schema-registry` — the schema-aware hooks were flagged stale (registry behind the applied 2026-07-01 migration waves).
3. `npm run typecheck && npm run build && npm run test` — prove the baseline is green before changing anything. If baseline is red, fix or park THAT first.
4. Create `docs/loops/structure-fix-ledger.md` (table: cycle · item · status DONE/PARKED · proof summary · codex verdict · commit sha).

## Per-cycle protocol (the loop Mason asked for)
For each worklist item, in order:
1. **VERIFY the finding against live reality first** (read the actual file / live `pg_get_functiondef` / live SQL). The audit was agent-produced; if a finding doesn't reproduce, mark ledger `PARKED — did not reproduce` and move on. For `save_quote` specifically: rebuild from LIVE function source, additively — and grep ALL pending/staged migrations for another `save_quote` emission first (the clobber class that caused the bug).
2. **Implement the smallest correct fix.** Match house patterns (`docs/reference/sql-canonical-patterns.md`): SECURITY DEFINER + `SET search_path`, `p_idempotency_key` + scoped lookup (`AND operation=`), bigint cents, `assertRpcResult`/`checkMutationResult`, revoke anon on new SECDEF fns.
3. **PROVE it ran** — not "tests pass": open the page via the dev server for UI fixes (preview tools), or run the SQL through a rolled-back live transaction + `plpgsql_check` for RPC drafts. Record a `PROOF — Ran: … · Saw: …` line in the ledger.
4. **Codex review (mandatory, every cycle):** run `/codex-review` on the change (real CLI verdict recorded this session — queued ≠ reviewed). Small related frontend fixes MAY be batched into one commit + one review. Fix findings; **cap 3 rounds** — if still contested, mark `PARKED — codex contested` with both positions in the ledger and move on.
5. **Commit** on the loop branch (pre-commit suite must pass), push the branch to origin, update the ledger, next item.

## WAVE A — Tier-0 broken features (from the app-wide audit; do in this order)
| # | Item | Ships as |
|---|---|---|
| A1 | Blend product-select stale-closure bug (ManualTicketCreate.tsx:459-466, BlendTicketDetail.tsx:1088-1094) | frontend |
| A2 | `save_blend_ticket` persists `job_id` + `application_service_id` (dead wires) | parked migration |
| A3 | `save_quote` restore dropped fields (is_planned, section_header_notes, needed_by_date, field_id) + fix `create_job_from_quote_section` idempotency (`AND operation=`) in the same migration | parked migration |
| A4 | `create_quick_delivery` tier-price $0 fallback + ONE shared `getTierPrice` replacing the 5 frontend cascades | parked migration + frontend |
| A5 | Blend unit conversion: `create_invoice_from_blend_ticket`, `create_order_from_blend_ticket`, `create_application_record_from_blend_ticket` (reuse `field_app_priced_quantity`); carry OCR `ratePerAcre` into `blend_ticket_products.rate_per_acre`; warn/refuse on $0-rate billable lines | parked migrations + edge-fn code (deploy parked) |
| A6 | `complete_job` inventory deduction unit conversion + `get_job_inventory_shortfalls` + DispatchBoard unit-safe compare (= approved plan Phase 3.1) | parked migration + frontend |
| A7 | PO single write path + `quantity_on_order` recompute for the 20 drifted products (recompute UPDATE must show an old-vs-new diff for all 604 products in the smoke) | parked migration + frontend |
| A8 | Terms→due-date: `payment_terms_days` + terms select + `post_invoice` defaults due_date forward-only (NEVER backfill posted invoices). Build it, PARK it flagged **"needs Mason policy confirm"** | parked migration + frontend |
| A9 | Month-end catch-up (close past months + seed periods + persist checklist confirmations). Build, PARK flagged **"needs Mason confirm"** | parked migration + frontend |
| A10 | Email idempotency: stable intent-scoped keys (drop `Date.now()`), all 5 invoice-email sites through `buildInvoiceEmailPayload` | frontend/lib |
| A11 | Wire `get_expiring_planned_holds` into Dashboard/ActionQueue (9 live holds at risk) | frontend |
| A12 | PHI guardrail writer: field crop-history editor (season, crop, planting/harvest dates) on FieldDashboard + upsert RPC | frontend + parked migration |
| A13 | `reorder_point` edit UI (InventoryPage/ProductDetail) + below-reorder list | frontend |
| A14 | `convert_to_gl_lb` pint/quart aliases (additive) | parked migration |

## WAVE B — only after Wave A is fully ledgered: Phase 1 of the units plan
`src/lib/units.ts` canonical module → rate-unit dropdowns (ProductDetail:470, JobDetail:2964/2986 with `unit` auto-derived, field-app line editable UM, LabelReview, CropPrograms) → unit-drift read-only report generated for Mason → normalization UPDATE as parked migration → normalize-on-save in the bulk importers → E2E fixture/locator updates in the same commits. Respect the frozen-keys rule: `unit_conversions` rows are NEVER renamed; canonical/synonym columns are additive.

## Decision packets (produce as docs, write NO code for these)
Create `docs/loops/owner-decisions-2026-07.md` collecting, with concrete side-by-side lists: (1) vendor + manufacturer merge mappings; (2) category remap of the 19 live values; (3) junk-data delete list (8 'RTJ Recipe', 3 'Test Mfg', vendor 'we', 5 invalid emails); (4) due-date/aging policy confirm; (5) wire-vs-retire calls (ingredient_map page, CropPrograms/ProgramTracker, per-acre tier columns, dead-tables drop); (6) 'wire' as allowed payment method.

## Definition of done
Every Wave-A item is DONE (proven + Codex-clean + committed) or PARKED (with reason + packet). Wave B same, if reached. Ledger complete. Final commit includes a handoff section at the top of the ledger: apply-order for the parked migrations, the decision packet, and a plain-English summary for Mason (lead with what's safe to apply and what needs his call). Do NOT merge to main; do NOT apply anything.
