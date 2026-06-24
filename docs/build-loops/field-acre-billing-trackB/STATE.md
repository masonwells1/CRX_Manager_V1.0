# STATE — Field Acre Billing **Track B** (per-acre billing tie-in) build loop

> The loop reads this at the start of every turn and updates it after every phase. Status values: `PENDING` · `IN-PROGRESS` · `DONE` · `BLOCKED` · `PARKED`.
> Run the **first `PENDING`** phase each turn. Append-only run log; never delete history.

**Owner mandate (Mason, 2026-06-23, before sleep):**
- **"Go all the way live overnight"** — explicit advance OK to **apply each migration to live prod `rhyzpcqhnizqbxphqdkr`, merge to `main`, and deploy** — **but ONLY after that change passes EVERY automated gate** (rls-security + migration-drift + types-drift + compliance reviewers CLEAN, an independent **Codex** review CLEAN, a **rolled-back live smoke** ending `SMOKE_PASS_ROLLBACK`, apply-guard proof, and `get_advisors` showing **no new** findings). **Anything that fails a gate, or any gate that is unavailable (e.g. Codex rate-limited), is PARKED for Mason — never self-certify, never bypass the apply-guard.** One-click Vercel rollback stays available.
- **Scope = Track B + small loose ends.** NOT Phase 4 (grower portal) / Phase 5 (auto-ingest).

**Worktree:** `C:\CRX_FieldMapping` · **Branch:** `feat/field-acre-billing-trackB` (off `main` `db9b32ea`).
**Prod:** `rhyzpcqhnizqbxphqdkr`. One DB writer at a time — the parallel `feat/ui-overhaul` session is **frontend-only** (no DB collision) but **pushes to `main`** → expect push races (fetch→merge→re-verify→re-push).
**Migration stamps:** start at `20260623140000` (latest on disk = Track A's `20260623130000`).
**Apply-guard gotcha (carried from B1/Track A):** bind the proof `queryHash` to the **exact SQL string passed to `apply_migration`**, and the MCP **strips a trailing newline** — hash the transmitted bytes, not the file's. Write proof JSON with **Node, not PowerShell** (BOM). 30-min expiry → regenerate at apply time.

---

## B0 grounding — VERIFIED LIVE 2026-06-23 (don't re-derive; this is ground truth)
Pulled live `pg_get_functiondef` for all four engine RPCs. The overnight batch `e8145393` did **not** close these:
- **`save_field_app_invoice`** (single overload, 20735 chars): acres line is `COALESCE((v_loc->>'applied_acres'), (v_loc->>'total_acres'), 0)` → **0 silently becomes full-field acres** (B1.1/B2 open). The "included in grower share" chem line (`v_chem_qty_a>0`) inserts `cost_cents = 0` and never adds to `v_invoice_cost` → **margin overstated** (B1.3 open). `salesman_id` taken from `p_invoice` **unchecked** on both INSERT and UPDATE (B1.5 open). Group selects (locked_count, orphan loop, sibling reuse) filter by `invoice_group_id` **without** `deleted_at IS NULL` (B1.2 — `invoices.deleted_at` EXISTS; `invoice_items.deleted_at` does NOT; verify `delete_invoices` can soft-delete a single field-app group member to set severity). Actor binding + scoped idempotency are present (good).
- **`preview_field_app_invoice_split`** (single overload, 7256 chars): same `COALESCE(applied, total, 0)` fallback → needs the **same 0-acre reject** for parity. No internal-cost path (preview only).
- **`derive_customer_shares_from_fields`** (single overload): applied_acres = `COALESCE(map ->> field_id, f.total_acres)` (secondary fallback; dead once save/preview guard 0). `share_acres` rounded to 2dp (B1.4 — **DEFER**, lowest-priority MED, touching the math is higher-risk than the guards).
- **`transfer_job_to_invoice`** (single overload, 14926 chars): actor-bound + references the service-fee path already → **B3 likely already converged by the overnight batch; VERIFY the body actually emits the `is_application_fee` line, don't blind-rewrite.**
- **B4 recipe:** `blend_recipe_items.price_per_unit_cents` **already exists** + `load_recipe_into_job` exists → **VERIFY** whether load already seeds the price; only patch if it still inserts 0.
- **B4b reconciliation:** `application_records.invoice_id` exists → "applied-but-unbilled" query is feasible.

---

## Phase checklist
| Phase | Status | Migration / files | Notes |
|---|---|---|---|
| B0 — Re-ground vs live code | DONE | — | findings above; all 4 RPCs single-overload |
| B1+B2 — `save_field_app_invoice` + `preview_field_app_invoice_split`: 0-acre reject (no total fallback) + override-acre cost capture + salesman gate + deleted_at-aware group selects | BUILT — reviewers CLEAN; apply at go-live | `20260623140000_field_app_per_acre_billing_and_hardening.sql` + `src/pages/FieldApplicationInvoice.tsx` | **Byte-fidelity diff vs live = only-intended-changes (rolled back, 0 footprint).** Both fns reproduced byte-faithful + patched (B1.1 0-acre RAISE, B1.2 deleted_at×4, B1.3 v_qa_cost, B1.5 salesman gate; preview clamps to GREATEST(...,0)). Frontend: default applied_acres from `billableAcres()`, drop `\|\| total_acres` sends, handleSave blocks 0/blank via toast. typecheck/lint/build green; 2179+12 tests pass. **4 reviewers (rls/drift/compliance/types) CLEAN.** Codex next; plpgsql_check + functional smoke at apply (Track-A pattern). |
| B3 — `transfer_job_to_invoice` convergence | DONE — already live (verified) | none | Live fn already binds actor (`ACTOR_MISMATCH` L48), emits the per-acre fee (`compute_application_service_fee` L210 + `is_application_fee` INSERT L227), scoped idempotency; live caller `JobDetail.tsx:702`. Converged by Phase-4 work. No migration. |
| B4 — recipe pricing (`load_recipe_into_job` seeds `price_per_unit_cents`) | DONE — already live (verified) | none | `load_recipe_into_job` already seeds `price_per_unit_cents` from the recipe (`COALESCE(v_item.price_per_unit_cents,0)` L36) + re-rolls `total_price_cents` (L49). Phase-4 + a prior Codex P1. No migration. |
| B5 — "applied but not yet billed" reconciliation view + page | DONE — already live (verified) | none | `UnbilledApplications.tsx` (route `/field-invoices/unbilled`, `App.tsx:203`) covers completed-unbilled jobs + unbilled blend tickets; documents why derived `application_records` aren't double-listed. Shipped with as-applied-invoices. |
| B6 — loose ends: regen schema-registry + supabase types | PENDING | `.claude/schema-registry.json`, `src/types/supabase.ts` | from live, post-apply |
| Z — handoff + docs + ship | PENDING | CHANGELOG, migration-history, doc-drift | go-live: apply migs (fresh proofs) → merge → deploy → memory + morning summary |

## Hard gates (binding — encode the owner mandate)
- [ ] Each migration: rls-security + migration-drift + types-drift + compliance reviewers CLEAN
- [ ] Each migration: Codex `codex review --base main` CLEAN (≤3 fix rounds; if Codex unavailable → PARK)
- [ ] Each migration: rolled-back live smoke `SMOKE_PASS_ROLLBACK` (BEGIN…ROLLBACK against prod; zero footprint)
- [ ] Each migration: apply-guard proof bound to transmitted SQL → `apply_migration` live → post-apply `plpgsql_check` + `get_advisors` no-new-findings
- [ ] Frontend: `npm run typecheck` (tsconfig.app.json — the ONLY real one) + lint + build + test green
- [ ] Merge `feat/field-acre-billing-trackB` → main (resolve doc conflicts keeping both intents) → push = deploy → Vercel READY
- [ ] PARK-not-force rule: any failed/unavailable gate → stop that piece, keep the rest moving, hand off a plain-English morning summary

## Run log (append-only)
- 2026-06-23 — Harness authored; B0 grounding DONE (live function bodies pulled + analyzed); branch `feat/field-acre-billing-trackB` cut off `db9b32ea`. Next: B1+B2.
- 2026-06-23 — **🚀 B1+B2 APPLIED LIVE to prod `rhyzpcqhnizqbxphqdkr`** (migration `20260623140000`, stamped version `20260624…`). Post-apply on live: all 3 fns single-overload; patches confirmed present (save: 0-acre guard + v_qa_unit_cost + salesman gate + 5 deleted_at filters; post_invoice_group: 4 filters; preview: clamp); **plpgsql_check clean** (only pre-existing `'{}'`-cast + unused-var warnings, byte-faithful); **functional smoke `SMOKE_PASS_ROLLBACK`** (0, −5, NULL applied acres all rejected with ZERO_APPLIED_ACRES); `get_advisors` security = baseline unchanged (no new finding; no GRANT/REVOKE in migration). Apply-guard gotcha logged below. Next: merge + deploy.
- 2026-06-23 — **B3/B4/B5 DONE — already live (verified, not rebuilt):** transfer_job_to_invoice already converged (actor + service fee), load_recipe_into_job already seeds recipe price, UnbilledApplications page already covers applied-but-unbilled. No migrations needed.
- 2026-06-23 — **B1+B2 BUILT + FULLY GATED** (commits `01b614d7`, `9ab28ccd`). Migration `20260623140000` reproduces `save_field_app_invoice` + `preview_field_app_invoice_split` + `post_invoice_group` byte-faithful (rolled-back diffs = only-intended-changes, 0 prod footprint) + patches B1.1 (0-acre RAISE) / B1.2 (deleted_at-aware across save **and** post_invoice_group + frontend sibling-load) / B1.3 (override-acre cost) / B1.5 (salesman gate) + B2 frontend default from billableAcres. **Codex r1 found 2 P1s** (B1.3 wrote extended cost into per-unit `cost_cents`; B1.2 missed post_invoice_group) → fixed → **Codex r2 CLEAN**. 4 reviewers r1 + 3 reviewers r2 all CLEAN. typecheck/lint/build + 2191 tests green. Apply at go-live (B7 stamp check + migration-history.md row pending). Next: B3.
