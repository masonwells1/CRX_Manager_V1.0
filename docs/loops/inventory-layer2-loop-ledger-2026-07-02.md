# Inventory‑Aware Scheduling — Layer 2 Build Loop Ledger

**Started:** 2026‑07‑02 · **Worktree:** `C:\CRX_Layer2` · **Branch:** `feat/inventory-layer2`
**Mode:** autonomous, file‑only, Codex‑gated per cycle (per handoff §6.4). NO live applies / deploys / pushes during the loop. ONE batched apply/merge decision handed to Mason at the end.
**Source of truth:** `docs/roadmap/2026-07-01-inventory-aware-scheduling-layer-2-handoff.md` (v2).

---

## Step 0 — ship‑state verification (done 2026‑07‑02)
- Layer 1 (`f7e74c9c`, mig `20260702120000_inventory_job_demand_visibility`) is an ancestor of `origin/main`; branch is at latest, nothing ahead. Layer 1 migration is double‑recorded live (harmless, as documented).
- No other session/branch is building Layer 2 (grep across all branches = docs commits only; no `_sync_job`/`reserve_job` code anywhere).
- No parked Layer 2 drafts in `scripts/.staging-migrations/`.
- **§3.5 live bug is UNFIXED** (no standalone `complete_job` drain‑fix migration shipped) → fold into A5.
- Live snapshot: 2 scheduled jobs (FAKE test data — **no backfill**, §6.6), 9 active `crop_program` holds, 20 inactive `manual` holds. `hold_type` CHECK = `('manual','crop_program')`; `inventory_transactions` type CHECK = the 12 documented types. All target fns single‑overload. Helpers `check_idempotency(text,text)`, `save_idempotency(text,text,jsonb)`, `require_admin_or_sales_rep()` confirmed live.

## Design decisions (mine — technical; owner decisions are all §6, DECIDED)
- **D1 — Separate WARN writer.** Do NOT route job reserves through `create_inventory_hold` (hard‑block, no `source_id`). Leave it untouched (whitelist stays `manual/crop_program`). New `_sync_job_holds` engine + `reserve_job_inventory` RPC use warn semantics (draw_down_quote‑style).
- **D2 — `job_product_draws` table** mirrors `quote_product_draws` (RLS on, single authenticated SELECT `is_admin() OR is_sales_rep()`, writes via SECDEF only, updated_at set by RPC, parent FK ON DELETE CASCADE). Keyed UNIQUE(job_id, product_id); stores parent quote_id for the resync SUM.
- **D3 — Shared remaining‑computation.** Job hold quantity = **full job demand**. `job_product_draws.quantity_drawn` = `LEAST(job_demand, remaining_quote_booking)`. `_sync_planned_holds` hold = `GREATEST(total_needed − order_drawn − job_drawn, 0)`; `draw_down_quote` remaining = same. ⇒ quote_remaining + job_hold never exceeds the booking (kills the 160‑held double‑count).
- **D4 — No `job_reserved` ledger type.** Reserves are holds, not physical movements (mirrors quotes). Avoids touching `inventory_transactions` CHECK. `complete_job` still writes its `job_applied` row.
- **D5 — Auto‑reserve via explicit calls** from the 3 job_chemicals writers (matches quote‑side, which calls `_sync_planned_holds` explicitly, not a trigger) — PLUS a db‑invariant sweep so a forgotten future writer is caught. (Verify at A4 that no frontend writes `job_chemicals` directly; if it does, switch to a statement trigger.)
- **D6 — Release via a `jobs` AFTER UPDATE trigger** on cancel + soft‑delete (deleted_at NULL→NOT NULL), because the Jobs page soft‑deletes with a direct table UPDATE (no RPC). Completion path (status→completed) is owned by `complete_job` (deducts + releases in one tx); the trigger only handles cancel/delete (release hold + reverse draws + resync parent quote).
- **Lock order (§4A.7):** parent quote → inventory → holds; decrement quote hold before inserting job hold, one tx.
- **Expiry:** job holds `expires_at = NULL` (§6.3) → forecast (B4) joins `jobs` by source_id, buckets on `jobs.job_date`.

## Cycle plan & status  (timestamps sort AFTER Layer 1's `20260702120000`)
| Cycle | Migration file | What | Status |
|------|----------------|------|--------|
| A1 | `20260702130000_layer2_job_holds_schema.sql` | `job` hold_type + `job_product_draws` table + **SECDEF-only job-hold write policies** + types | **Codex P2 FIXED+PROVEN — re-review running** |
| A2 | `20260702131000_layer2_sync_planned_holds_job_aware.sql` | `_sync_planned_holds` subtracts job draws | pending |
| A3 | `20260702132000_layer2_draw_down_quote_job_aware.sql` | `draw_down_quote` remaining subtracts job draws (§6.5) | pending |
| A4 | `20260702133000_layer2_reserve_job_inventory.sql` | `_sync_job_holds` + `reserve_job_inventory` + wire 3 writers + FE | pending |
| A5 | `20260702134000_layer2_complete_job_and_release.sql` | `complete_job` rewrite (+§3.5 fix) + `jobs` release trigger + invariant sweep | pending |
| B1 | `20260702135000_layer2_shortfalls_job_coverage.sql` | `get_job_inventory_shortfalls` treats own hold as coverage | pending |
| B2 | `20260702136000_layer2_inventory_position_job_column.sql` | `get_inventory_position` split holds by type + qty‑aware planned dedup | pending |
| B3 | `20260702137000_layer2_dispatch_free_precision.sql` | dispatch RPC free‑excluding‑own‑hold + FE light | pending |
| B4 | `20260702138000_layer2_forecast_job_holds.sql` | `get_inventory_forecast` joins jobs, buckets on job_date + FE column | pending |

**Per‑cycle gate:** write file‑only → rolled‑back smoke vs live schema (`BEGIN;…;ROLLBACK;` + `plpgsql_check`) → reviewer fan‑out (rls/drift/types) → `/codex-review` real verdict → commit. Post‑apply (Mason's batch): `/regen-schema-registry`, regen caller‑graph, doc‑sync, test‑contract suites.

### A1 review results (2026‑07‑02)
- **rls-security-reviewer:** CLEAN (0). New table RLS mirrors `quote_product_draws` (staff SELECT, SECDEF‑only writes).
- **typescript-types-drift-reviewer:** CLEAN (0 drift). `InventoryHoldType`+`'job'` and `JobProductDraw` match the table 1:1; no exhaustive `switch(hold_type)` exists.
- **migration-drift-reviewer:** 0 BLOCKER. H1 (B7 version‑stamp) RESOLVED — file `20260702130000` sorts above all on‑disk files and the highest live version stamp `20260701205341`; `apply_migration` stamps fresh at apply time. MEDs = post‑apply doc/registry (below).

### A1 Codex gate (2026‑07‑02)
- **Codex P2:** the pre‑existing `inventory_holds_insert` policy (`WITH CHECK auth.uid()=created_by`) let any authenticated client directly insert a `hold_type='job'` row (bogus/NULL source_id) and bypass the SECDEF reserve/release engine. **FIXED in A1** by adding `AND hold_type <> 'job'` to all three write policies (INSERT/UPDATE/DELETE) → job holds are SECDEF‑only. **PROVEN** via rolled‑back authenticated‑role smoke: `job_blocked=t manual_ok=t` (job insert RLS‑denied, manual insert still allowed).

### Design notes surfaced by review (for later cycles)
- **A2–A5 SECDEF fns** each need `SET search_path=public,pg_temp` + `REVOKE EXECUTE … FROM anon, PUBLIC` + strict‑actor + idempotency helpers (rls reviewer).
- **`job_product_draws` has NO updated_at trigger** (mirror) → every SECDEF RPC that mutates it MUST set `updated_at = now()` in‑statement (drift reviewer).
- **A4 display:** `InventoryPage.tsx:1171,1173` is a 2‑way ternary → a `'job'` hold renders as the purple "Program" badge; add a "Job" badge branch when wiring the reserve engine (types reviewer).
- **A3 scope choice:** subtract job draws from `draw_down_quote`'s `v_remaining` only (kills §6.5 double‑billing); leave `v_fully_drawn` (auto‑accept) on order‑draws to avoid entangling the quote‑accept lifecycle with reversible job draws. Known edge: a booking fully consumed by jobs stays `sent` with 0 drawable (office can accept manually) — documented, safe.

## POST‑APPLY BATCH CHECKLIST (hand to Mason at the end — do NOT do during the loop)
1. Apply migrations A1→B4 in filename order via Supabase MCP `apply_migration` (Mason's explicit OK per file).
2. `node scripts/regenerate-schema-registry.mjs` (from live) so `hold_type='job'` + `job_product_draws` are known to the write‑time hooks. **[A1: M2]**
3. Regenerate `src/types/supabase.ts` (`supabase gen types`) — adds `job_product_draws`. **[A1: i2]**
4. `node scripts/generate-caller-graph.mjs` (caller‑graph is 2026‑06‑13, stale).
5. Doc‑sync: `docs/reference/migration-history.md` rows **[A1: M1]** + database‑schema.md/rpc‑functions.md + INVENTORY_RULES.md hold_type list + CLAUDE.md lifecycles/Net‑Free + GettingStarted.tsx Net‑Free copy + `docs/CHANGELOG.md` + `node scripts/regenerate-agents-md.mjs`.
6. Run the 4 test‑contract suites (rpcFixtureLiveDiff, rpcIdempotencyScope, schemaIntegrity, inventoryPositionValidator) + db‑invariant sweeps.
