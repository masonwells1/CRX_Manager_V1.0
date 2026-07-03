# Inventory‑Aware Scheduling — Layer 2 Build Loop Ledger

**Started:** 2026‑07‑02 · **Worktree:** `C:\CRX_Layer2` · **Branch:** `feat/inventory-layer2`
**Mode:** autonomous, file‑only, Codex‑gated per cycle (per handoff §6.4). NO live applies / deploys / pushes during the loop. ONE batched apply/merge decision handed to Mason at the end.
**Source of truth:** `docs/roadmap/2026-07-01-inventory-aware-scheduling-layer-2-handoff.md` (v2).

---

## ⚠️ AUTHORITATIVE STATUS (2026‑07‑02, supersedes any stale refs below)

**Part A CORE is BUILT + PROVEN + gated** — 7 migrations, all renumbered to the `20260702170000+` range (see below). Frontend job‑draw pre‑checks in `QuoteBuilder.tsx`. Final authoritative file list:
| Cycle | File | Proven |
|---|---|---|
| A1 | `20260702170000_layer2_job_holds_schema.sql` | job hold_type + `job_product_draws` + SECDEF‑only job‑hold policies; RLS‑block e2e |
| A2 | `20260702171000_layer2_sync_planned_holds_job_aware.sql` | `_sync_planned_holds` job‑aware; executed on live quote |
| A3 | `20260702172000_layer2_draw_down_quote_job_aware.sql` | `draw_down_quote` job‑aware; plpgsql_check == live |
| A3.5 | `20260702172500_layer2_convert_quote_to_order_job_aware.sql` | `convert_quote_to_order` job‑aware (5 Codex rounds) |
| A3.6 | `20260702173000_layer2_quote_lifecycle_guards_job_aware.sql` | accept+terminal triggers job‑aware |
| A4 | `20260702174000_layer2_reserve_job_inventory.sql` | reserve engine + `job_chemicals` triggers + `jobs` lifecycle trigger + inventory‑unit conversion; lifecycle e2e (reserve/complete‑keep/cancel‑reverse) PROVEN |
| A5 | `20260702175000_layer2_complete_job_drop_phase7_drain.sql` | §3.5 fix; before/after e2e (prebooked no longer drained) |

**🚨 BLOCKER — branch divergence (Mason's call):** a **parallel session (structure‑fix wave)** advanced `origin/main` by **15 commits** DURING this build, incl. an "a‑series" of migrations that took the SAME `20260702130000–135000` timestamps I'd used (a2 save_quote, a6 = live complete_job, a7 PO, …) — all APPLIED LIVE (live max version `20260702161533`). Two consequences:
1. **RENUMBERED** all Layer 2 migrations to `170000–175000` (past the live max) so they don't collide / get skipped. ✅ done.
2. **Merge reconciliation needed:** this branch is behind `main`; `main`'s `2aa374b4 feat(types): typed Supabase client` touched `QuoteBuilder.tsx` + `src/types/*` → my job‑draw edits will conflict on merge. **Recommend: rebase `feat/inventory-layer2` onto latest `origin/main`** (getting the a‑series), resolve the `QuoteBuilder.tsx`/types conflicts, re‑verify Layer 2 applies after the a‑series, THEN the batched apply.

**REMAINING to finish Layer 2 (do AFTER the rebase, on the reconciled base):**
- Part A polish (DEFERRED, low-risk): **`save_quote` drawn‑product guard → job‑aware** (Codex A3.5 round‑5 root cause), **db‑invariant sweep** (active `job` holds on terminal/deleted jobs = 0), **rollover/settlement trio** (`rollover_quote_to_season`/`get_open_booking_rollover`/`get_booking_settlement` subtract job draws).
- Part B (read side): `get_job_inventory_shortfalls` own‑hold coverage · `get_inventory_position` job column + qty‑aware dedup · dispatch free‑excluding‑own‑hold · `get_inventory_forecast` job holds via `jobs.job_date`.
- A4‑cohort frontend: DispatchBoard/Jobs reserve wiring + a "Job" badge at `InventoryPage.tsx:1171‑1173`.
- Note: A4's inventory‑unit conversion (Codex A5 P1 fix) is `plpgsql_check`‑clean + 1:1 for the common (matching‑unit) case; wants a final Codex confirmation post‑rebase. Codex A5 P2 (blank‑unit job rows blocked at completion) is **pre‑existing a6 behavior** (live), not a Layer 2 regression.

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
| A1 | `20260702170000_layer2_job_holds_schema.sql` | `job` hold_type + `job_product_draws` table + **SECDEF-only job-hold write policies** + types | ✅ **COMMITTED `4ff80fb4`** — reviewers+Codex clean (P2 fixed+proven) |
| A2 | `20260702171000_layer2_sync_planned_holds_job_aware.sql` | `_sync_planned_holds` subtracts job draws | ✅ **COMMITTED `df61b823`** — reviewers+Codex clean |
| A3 | `20260702172000_layer2_draw_down_quote_job_aware.sql` | `draw_down_quote` remaining subtracts job draws (§6.5) | ✅ **COMMITTED** — reviewers+Codex clean |
| A3.5 | `20260702172500_layer2_convert_quote_to_order_job_aware.sql` | **`convert_quote_to_order` job-aware** (Codex P1) + **P2 fix** (raise instead of null-order `already_converted`) | drift+rls CLEAN; **P2 edit re-review running** |
| A3.5/A3.6/FE | `…132500`+`…133000`+`QuoteBuilder.tsx` | convert + accept/terminal guards + FE pre-checks job-aware | ✅ **COMMITTED** — 5 Codex rounds, all clean |
| A4 | `20260702174000_layer2_reserve_job_inventory.sql` | **reserve engine**: `_sync_job_holds` + `job_chemicals` triggers + **`jobs` lifecycle release trigger** + `reserve_job_inventory` RPC | reviewers v1 CLEAN; **3 Codex findings FIXED+PROVEN**; re-gate running |

**A4 Codex round 1 (3 findings, all FIXED + lifecycle e2e PROVEN):**
- **P1 lifecycle release** — job holds are `expires_at=NULL` + only `job_chemicals` triggers were wired, so a terminal/deleted job stranded its reservation. FIX: added `jobs` AFTER-UPDATE-OF-status/deleted_at trigger → re-runs the engine (reserves if scheduled/in_progress, releases otherwise). **Completion KEEPS the draw** (consumed), **cancel/soft-delete REVERSES it** (restored). PROVEN e2e: reserve 2 jobs (crop 91.25→88.25), complete A (hold released, draw KEPT=1) + cancel B (hold released, draw REVERSED), quote crop → 90.25 (=booking−kept draw).
- **P2 concurrent same-product** — added `FOR UPDATE` on the inventory row in the reserve loop (serializes so the shortfall warning isn't missed).
- **P2 missing inventory row** — explicit `IF v_free IS NULL → short = full demand` (was `LEAST(NULL,0)=0` → false "short: 0").
- `plpgsql_check` CLEAN on the rewritten engine + lifecycle trigger. Dropped `p_idempotency_key` (unused; engine is rebuild-idempotent).

**A4 e2e PROOF (rolled-back, live planned quote):** inserted an [E2E] scheduled job + chemical (qty 1) on a product booked 91.25 → trigger auto-reserved: `job_hold=1`, `job_draw=1`, quote `crop_program` shrank `91.25→90.25` (= draw). Invariant `crop(90.25)+job(1)=91.25=booking` holds — no double-count. `plpgsql_check` clean on `_sync_job_holds`+`reserve_job_inventory` (dropped `p_idempotency_key` — engine is rebuild-idempotent). `release_job_inventory` deferred (admin can release by cancelling the job → A5). save_quote guard + "Job" badge = A4-cohort follow-ups.

### A4 design (finalized 2026-07-02, grounded in live)
- **`_sync_job_holds(p_job_id, p_actor) → jsonb{shortfalls}`** (SECDEF): lock job (FOR UPDATE) → lock parent quote (if any) → if job deleted/terminal: release job holds + reverse its draws + resync quote, return. Else rebuild: delete this job's `job` holds + draws; per product (SUM `job_chemicals.quantity`): if parent quote is planned & non-terminal, `job_drawn = LEAST(job_demand, GREATEST(quote_booking − order_drawn − OTHER_job_drawn, 0))`, upsert `job_product_draws`; insert `job` hold = **full job_demand** (`expires_at=NULL`, `source_id=job_id`); resync parent quote via `_sync_planned_holds`; THEN compute warn shortfalls (free = avail − prebooked − active non-expired holds, AFTER resync). Warn‑only (§6.1). Lock order quote→inventory→holds.
- **Wiring = `job_chemicals` statement-level triggers** (INSERT/DELETE/UPDATE, transition table `affected`) → `_sync_job_holds(job_id, auth.uid())` per distinct job_id. Avoids rewriting the 3 large writers; catches all writers (§6.2 auto). No recursion (writes holds/draws, not job_chemicals).
- **`reserve_job_inventory(p_job_id, p_performed_by, p_idempotency_key)`** (SECDEF, strict-actor, admin/sales_rep, idempotency helpers, REVOKE anon): calls `_sync_job_holds`, returns shortfalls — explicit entry so the dispatcher sees warnings. **`release_job_inventory`** (admin): manual release (§6.2).
- **Jobs come from planned quotes only, status ≠ declined/expired/cancelled** — DRAFT job draws are real → terminal guard (A3.6) already covers draft. `-- status-enum-check: exempt` (writes `'job'` literal). No `inventory_transactions` row (D4 — holds, not movements).
| A4 | `20260702174000_layer2_reserve_job_inventory.sql` | `_sync_job_holds` + `reserve_job_inventory` + wire 3 writers + FE | ✅ done (Codex-clean; unit fix) |
| A5 | `20260702175000_layer2_complete_job_drop_phase7_drain.sql` | `complete_job` rewrite (+§3.5 fix; A4 trigger owns release) | ✅ done (Codex-clean; e2e proved fix) |
| B1 | `20260702176000_layer2_shortfalls_job_coverage.sql` | `get_job_inventory_shortfalls` treats own hold as coverage | ✅ done (rls+drift CLEAN; smoke proved phantom gone; Codex batched at end-of-B) |
| B2 | `20260702177000_layer2_inventory_position_job_column.sql` | `get_inventory_position` split holds by type + qty‑aware planned dedup | ✅ done (rls+drift+types CLEAN; smoke: resurface 100→0, 3 regressions clean; typecheck clean; +job_holds_qty type/validator/test) |
| B3 | `20260702178000_layer2_dispatch_free_precision.sql` | dispatch RPC free‑excluding‑own‑hold + FE light | ✅ done (rls+drift+compliance CLEAN; smoke: own-hold add-back old-free 20→short vs new-free 80→ok; new fn no overload; plpgsql_check CLEAN; DispatchBoard rewired to supabaseUntyped RPC, client unit-conv removed) |

**B3 location-scope note (for final Codex):** the dispatch RPC's `avail`/`total_holds` sum across ALL inventory locations — this PRESERVES the Layer 1 dispatch light (which summed all-location `available−prebooked` from get_inventory_position). All read-side RPCs (position/shortfalls/forecast-demand) are all-location; only the A4 reserve engine + forecast's `current_available` snapshot use `location='Main Warehouse'`. Pre-existing; CRX is operationally single-location. Not a B3 defect — flagged so the final combined Codex can weigh the reserve-vs-read location split holistically.
| B4 | `20260702179000_layer2_forecast_job_holds.sql` | `get_inventory_forecast` joins jobs, buckets on job_date + FE column | ✅ done (rls+drift+compliance CLEAN; smoke: job hold → job_date bucket 2026-07 planned=50/job=50, crop → expires−14d bucket 2026-08; plpgsql_check CLEAN; InventoryPage forecast "Jobs" column, cols 9=9) |

## Part B COMPLETE + Codex A+B gate RAN → 5 findings, ALL FIXED + proven
Remaining before the single apply/merge decision: (1) reviewer + ONE final `/codex-review` confirm-clean pass over the fixes, (2) present ONE batched apply/merge decision.

### Codex `/codex-review --base origin/main` (2026-07-02) — 5 findings, disposition:
Real, valuable review. All fixed file-only + behaviorally proven + plpgsql_check CLEAN:
- **P1 #1** (A4 `174000`): completed/invoiced job soft-deleted REVERSED its draw → restored booking for applied chemical. FIX: reverse draw only for `cancelled` OR (`deleted_at` + scheduled/in_progress). Truth-table proof: completed/invoiced+deleted now KEEP; cancelled/scheduled/in_progress+deleted reverse.
- **P1 #2** (A3.6 `173000`): a reversible job draw + save_quote dropping the product left the accept-guard's `COALESCE(bool_and,true)` = true → accept could strand the booking. FIX: force `v_fully_drawn=false` when a reversible (scheduled/in_progress) job draw exists, checked DIRECTLY vs job_product_draws (not via the booked join). Proof: old=true(pass) → new=false(block). **This CLOSES the save_quote hole.**
- **P2 #3** (B1 `176000`): subtracting the quote crop-hold from job demand double-discounted → hid shortfalls. FIX: needed = full job demand (own hold already covered via the free-side exclusion). Proof: old_shortfall 10 → new 50 (matches Codex example).
- **P2 #4** (rollover/settlement ignore job draws): = A3.7 (built this session). ✅
- **P2 #5** (B4 `179000`): scalar subqueries returned NULL (not 0) with no inventory row → frontend `.toLocaleString()` crash. FIX: outer COALESCE(...,0). Proof: old=NULL → new=0.

### A3.7 = rollover/settlement trio job-aware — ✅ DONE (mig `20260702180000`)
get_open_booking_rollover + get_booking_settlement (reads: remaining subtracts job draws; additive job_drawn_cents/qty; booked=order+job+remaining identity) + rollover_quote_to_season (mutating FIFO: v_drawn = order+job). Proofs: plpgsql_check ALL THREE CLEAN; remaining-math + FIFO logic (old rolls 80 → new rolls 30 = 100−20−50); no live mutation (mock, avoided the generate_quote_number sequence bump). **Post-apply owner-smoke recommended:** roll a real [E2E] job-drawn booking on live and confirm the new quote qty = booked−order−job.

### Codex `/codex-review` ROUND 2 (final re-review, 2026-07-02) — 3 findings, ALL FIXED + proven
The re-review confirmed round-1's 5 fixes closed, and found 3 DEEPER issues. All fixed file-only + behaviorally proven + plpgsql_check CLEAN:
- **P1** (save_quote + restore_quote_version, NEW mig `20260702181000` = A3.8): the drawn guards only counted ORDER draws → a quote could be edited/restored below a job-reserved qty, leaving job_drawn > booking and corrupting settlement/rollover math (NOT inert — my earlier "defer" call was wrong; Codex was right). FIX: both guards now aggregate ORDER+JOB draws per product (UNION ALL) and block if booked < combined drawn. Both reproduced VERBATIM from live (only the guard's FROM changed); plpgsql_check BOTH CLEAN; guard truth-table proven (blocks 60<80, job-only-removed 0<60, order-only 30<40; allows =/above).
- **P2** (A4 `174000`): a job from a CONVERTED (accepted) quote added a full job hold on top of the order's prebooked → double-reserve. FIX: hold qty = `v_job_drawn + GREATEST(demand − booking, 0)` (reserves drawn + un-booked excess, excludes prebooked-covered demand; skip zero-qty). Proof: converted→0, open→full demand, over-booked→full, quote-less→full.
- **P2** (B2 `177000`): product-level hold/draws subtracted PER quote-line → a product on multiple lines over-deducted. FIX: aggregate booking per (quote,product) FIRST, subtract once, sum per product. Proof: two 50-lines + 60 job draw → old 0, new 40; plpgsql_check CLEAN.
Migration count now 13 (added `20260702181000`). save_quote/restore reproduced with the byte-safe guard-only change; drift+rls reviewers + a round-3 Codex confirm-clean pass gate this before the apply decision.

### Codex `/codex-review` ROUND 3 (2026-07-02) — 4 findings, ALL P2 (no P1/BLOCKER — converging), ALL FIXED
Severity trend P1→P1→none confirms convergence on edge cases. All fixed file-only + behaviorally proven:
- **P2** (A4 `174000`, a REGRESSION from my round-2 fix): the round-2 hold term `− v_quote_booking` UNDER-reserved when a booking had prior OTHER-JOB draws (50-unit job on a 100-booking already 80-drawn by other jobs held only 20). Corrected to `v_job_drawn + GREATEST(demand − v_job_drawn − v_order_drawn, 0)` — excludes ONLY the order-prebooked overlap, not the whole booking. Proof: other-job case now holds 50 (was 20); converted still 0; open still full demand; +reset v_order_drawn.
- **P2** (B1 `176000`): a PRE-EXISTING job (no own hold yet — no backfill, §6.6) would report a phantom shortfall (full demand counted while crop hold still subtracted from free). FIX: cover = 0 when the job HAS its own job hold, else fall back to the parent quote crop coverage (Layer-1 behavior). plpgsql_check CLEAN.
- **P2** (A3.7 `180000` rollover): job-aware remainder mode was gated to sent/revised, but jobs can draw from DRAFT planned quotes → a draft rollover cloned job-consumed units. FIX: gate now `IN ('draft','sent','revised')` (order draws only exist on sent/revised, so adding draft only affects job-draw detection).
- **P2** (A3.7 `180000` reads): the additive job_drawn_cents/qty buckets weren't rendered by the existing settlement card / rollover table → booked ≠ drawn+remaining on screen. FIX: FOLD job draws into `drawn_cents`/`drawn_qty` (order at locked price + job at wavg); dropped the separate buckets + the v_job_drawn_cents var. 2-bucket identity restored, no frontend change. Proof: drawn(80)+remaining(20)=booked(100).
Migration set stays 13 (all edits to existing Layer 2 files). A round-4 Codex confirms convergence before the apply decision.

### Codex `/codex-review` ROUND 4 (2026-07-02) — 2 findings (1 P1, 1 P2), a NEW CLASS (adjacent existing code), ALL FIXED
Not regressions — these are pre-existing paths that adding job holds/draws rippled into. Both fixed + proven:
- **P1** (NEW mig `20260702182000` = A3.9): `release_inventory_hold` (the generic admin "Release" RPC, SECDEF, bypasses RLS) didn't reject `hold_type='job'` → an admin could deactivate a job reservation via that path, orphaning `job_product_draws` + leaving the quote un-resynced (drawn-but-not-reserved). FIX: reject 'job' holds ('release automatically via the job lifecycle'). Reproduced verbatim + the guard; plpgsql_check CLEAN.
- **P2** (`QuoteBuilder.tsx` openDrawDownModal): the Partial Order modal computed `remaining` from order draws only, so with a job reservation it showed too much and let the user submit an amount `draw_down_quote` now rejects (BOOKING_OVERDRAWN). FIX: fetch `job_product_draws` and fold into `drawn` (order+job) so remaining = booked − order − job = the server balance. typecheck + lint CLEAN.
Migration count now 14 (`170000`–`182000`). A round-5 Codex confirms.

## 🚀 APPLIED LIVE 2026-07-02 (Mason's explicit "Go")
All 14 migrations applied to prod (`rhyzpcqhnizqbxphqdkr`) in filename order 170000→182000 (fresh version stamps at apply time — no collision with the live high-water). Rebased clean onto latest `origin/main` first (15 commits, 0 conflicts). Post-apply verification:
- **Functional**: `get_inventory_position()` returns 113 rows live WITH the new `job_holds_qty` key.
- **Structural**: `'job'` in the live `inventory_holds_hold_type_check`; `job_product_draws` table + RLS on; `get_dispatch_stock_status` RPC + `trg_release_job_holds_on_lifecycle` trigger present.
- **Security**: 0 function overloads across all 18 Layer 2 fns; targeted sweep = 0 anon-exec / 0 missing-search_path; the only ERROR advisor is the pre-existing accepted `profile_public_view`; new fns are `authenticated`-exec + self-gated.
- Reserve engine is warn-only (§6.1) and the DB is operationally empty, so the 2 deferred multi-job-allocation P1s are dormant.
**Remaining OWNER item**: the multi-job coordinated-allocation refinement (round-5 P1s) — build before real multi-job bookings exist. Everything else DONE.

### Codex `/codex-review` ROUND 5 (2026-07-02) — 3 findings (2 P1 multi-job allocation + 1 P2 soft-delete). P2 FIXED; the two P1s = OWNER DECISION (redesign).
- **P2 FIXED** (`Quotes.tsx` handleDelete): the bulk-delete guard checked `quote_product_draws` only → a quote with a job draw could be soft-deleted (no status trigger fires, FK cascades only on hard delete) while its booking stays consumed. Now folds `job_product_draws` into the skip-set. typecheck+lint CLEAN.
- **P1 ×2 = DEFERRED, presented to Mason (multi-job coordinated allocation — a redesign, not a point fix):**
  1. *Sibling draw reallocation on release* (`174000:83`): when one of N jobs on the SAME quote+product is cancelled/deleted, its draw is dropped + the crop hold rebuilt, but SIBLING jobs aren't re-drawn → freed booking shows drawable while a sibling still needs it.
  2. *Order-coverage allocated once* (`174000:165`): the round-3 hold formula subtracts the quote-level `v_order_drawn` PER JOB, so with multiple jobs on one product the shared prebooked coverage is over-applied → under-reserve.
  **Root cause:** the reserve engine sizes each job INDEPENDENTLY; correct multi-job behavior needs the booking + order coverage ALLOCATED ONCE across sibling jobs (FIFO/proportional) — a coordinated-allocation model.
  **Impact:** requires multiple jobs on the SAME planned quote AND product with insufficient booking; layer is WARN-ONLY (never blocks; complete_job still flags short-stock; draw_down_quote's BOOKING_OVERDRAWN backstops re-draw); **ZERO current impact** (DB operationally empty — no real bookings, existing jobs are fake, §6.6).
  **Recommendation:** apply the 15-fix hardened core now; build the coordinated sibling-allocation as a scoped follow-up (it deserves its own careful pass + would likely surface further edge cases). Neither simple choice satisfies both round-2 (no over-reserve) and round-5 (no under-reserve) — only coordinated allocation does.
Migration count 15 (`170000`–`182000` + the P2 was a frontend-only change, no new migration). Codex rounds: 5+3+4+2+3 = **17 findings, 15 fixed**; 2 residual P1s = the multi-job-allocation decision above.

### ⚠️ Branch topology (verified 2026-07-02 — matters for the merge target)
- **local `main` is STALE** (HEAD `30adac32`, the Layer 2 handoff commit) — it does NOT have the structure-fix work.
- **origin/main is AHEAD** (HEAD `8d908bce`) and ALREADY contains the structure-fix loop's commits (`022ee69e` etc. ARE in origin/main).
- `feat/inventory-layer2` is based on merge-base `01d1eead` (in origin/main); origin/main has 3 commits beyond it (A12/A13 promote + ledger stamps) that don't touch Layer 2 files.
- **`origin/main...feat/inventory-layer2` = CLEAN Layer-2-only diff** (exactly the 11 migrations `170000→179000` + frontend). The structure-fix commits cancel because they're in origin/main.
- **⇒ Merge/apply target is `origin/main`, NOT stale local `main`.** Codex was scoped `--base origin/main` for this reason. Before apply, `git checkout main && git pull` to refresh local main, then merge feat/inventory-layer2 (clean; no Layer-2-file conflicts expected).

### A3.7 = rollover/settlement trio → job-aware (BUILDING — Mason's selected option said "finish Part A polish")
Mason chose "Finish everything, then one apply" whose text = "finish Part A polish + Part B + frontend" → the trio is in scope. Money-plan-first rule preserved: file-only, reviewed + Codex-gated, his OK at the apply gate before it goes live.
1. **Rollover/settlement trio → job-aware (§6.5 read+action consistency).** All three compute drawable "remaining" as `booked − order_drawn` and IGNORE `job_product_draws` (verified: `refs_job_draws=false`):
   - `get_open_booking_rollover` (STABLE read): `per_product.remaining_cents = GREATEST(booked − order_drawn, 0)×wavg` → add `− job_drawn`; add a `job_drawn_cents = job_drawn×wavg` bucket so `booked = order_drawn_cents + job_drawn_cents + remaining_cents` stays exact.
   - `get_booking_settlement` (STABLE read): same `line_rows` idiom — same fix + `job_drawn_qty`/`job_drawn_cents` additive fields.
   - `rollover_quote_to_season` (**MUTATING money action**, FIFO): `v_has_draws` should be true if order OR job draws exist; `v_total_remainder` and per-item `v_drawn` must be `order_drawn + job_drawn` so FIFO rolls only the truly-undrawn remainder.
   - **Why deferred / why plan-first:** it's coupled (can't split reads from action without inconsistency) and includes a MUTATING money function → Mason's standing rule = plain-English plan + OK before money code. **Risk today is LOW:** the PRIMARY double-fulfillment vector (re-drawing a job-consumed booking to an ORDER) is already closed by A3 (`draw_down_quote` subtracts job draws); this trio is the SECONDARY path (rolling to next season / settlement report) and is dormant until Layer 2 is live AND a real planned booking is job-drawn AND someone rolls/settles it.
   - **Proof plan when built:** reads via mock+`plpgsql_check` (auth-gated, like B1); the mutating rollover via a rolled-back e2e using `SET LOCAL request.jwt.claims` to impersonate a live admin uuid + a synthetic planned quote with both an order draw and a job draw, asserting the new quote's rolled qty = `booked − order − job` (FIFO).
2. **`save_quote` drawn-product guard → job-aware.** LOW-risk: the A3.5 null-guard already prevents the crash; an orphaned draw is inert. Make its drawn-product pre-check also consider `job_product_draws`.
3. **db-invariant sweep predicate:** add `active 'job' holds whose job is terminal/deleted = 0` to `scripts/db-invariant-sweeps/`. Only returns rows post-apply; a permanent safety net for the non-expiring job holds.

### POST-APPLY BATCH CHECKLIST (Mason's gate)
Apply the 11 migrations in filename order `170000→179000` via Supabase MCP `apply_migration` (each needs Mason's explicit OK + apply-guard proof). Then: `/regen-schema-registry`; regen caller-graph; doc-sync (migration-history.md rows for the 11 files + Snapshot counts); regen `rpcFixtureLiveDiff` pg_proc snapshot (position/forecast/shortfalls return shapes changed + new `get_dispatch_stock_status`); run `node scripts/db-invariant-sweeps/run-sweeps.mjs` (each query 0 rows); merge feat/inventory-layer2 → main.

**Codex cadence (efficiency decision 2026‑07‑02):** Part A cycles were Codex‑gated individually (all clean). Part B is entirely **read‑only reporting fns** (no writes / RLS mutation / money) + type/validator/UI — low‑risk. To avoid burning a full gpt‑5.5‑high pass per micro‑cycle, Part B runs the specialized reviewer fan‑out per cycle and **ONE batched `/codex-review` over all of B1–B4 at end‑of‑B**, then the **final combined Codex over A+B** before the single apply gate. No code goes live without a real Codex verdict — the invariant ([[feedback_codex-gate-ran-not-queued]]) is preserved because nothing applies/pushes until that final gate.

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

### Booking‑consumption paths — job‑draw awareness (Codex P1, 2026‑07‑02)
Codex caught a gap the handoff §4A.3 missed: it named `_sync_planned_holds` + `draw_down_quote`, but there is a THIRD order‑creating path. Full audit of functions that read `quote_product_draws`:
- `_sync_planned_holds` → **A2** ✓ · `draw_down_quote` (partial draw) → **A3** ✓ · `convert_quote_to_order` (whole conversion) → **A3.5** ✓ (block whole‑convert when job draws exist).
- `cancel_order`/`void_order`/`restore_quote_version` — reverse ORDER draws + call `_sync_planned_holds` (now job‑aware) → no change needed.
- **REQUIRED (sequenced AFTER A4/A5 — all inert until job draws exist):** the remainder/rollover trio all read `quote_product_draws` and NOT `job_product_draws`, so they over‑report/over‑roll the undrawn balance by the job‑drawn amount (booking‑accuracy, not double‑bill — lower severity but a real feature gap):
  - **A3.6** `rollover_quote_to_season` (WRITE — inflates next‑season booking) · **A3.7** `get_open_booking_rollover` (read feeding rollover UI) · **A3.8** `get_booking_settlement` (settlement report). Same surgical "subtract job draws" pattern.
- **Assessed, likely NO change:** `restore_quote_version` / `_enforce_quote_terminal_not_drawn` / `enforce_quote_accepted_fully_drawn` / `auto_expire_quotes` — these GUARD on draw existence (don't compute a billable remainder); revisit only if a job‑draw‑only quote mis‑behaves. `cancel_order`/`void_order` reverse ORDER draws + resync via job‑aware `_sync_planned_holds` — fine.

### Codex P1/P2 on the whole‑conversion path (2026‑07‑02) — RESOLVED in A3.5 + A3.6 + FE
- **P1 (accept race):** QuoteBuilder saves the quote `accepted` BEFORE calling convert; the BEFORE‑UPDATE accept trigger (`enforce_quote_accepted_fully_drawn`) only counted order draws, so a partial‑job‑drawn quote accepted → **released its remaining planned holds** before A3.5's convert guard could refuse. **Fix (A3.6):** both BEFORE‑UPDATE quote triggers (accept + terminal) count job draws → the accept is blocked before any hold releases. No `auto_expire` change (it skips `is_planned=false`; job draws exist only on planned quotes). Frontend pre‑checks (convert + decline/cancel) also detect job reservations for clean UX.
- **P2 (null order_id):** convert's fully‑drawn branch could return `{status:'already_converted', order_id:null}` for a job‑fully‑consumed booking, but the caller does `result.order_id!`.
- **P2 round 2 — STRANDING (Codex v2, the key correction):** my first A3.5/A3.6 made `v_fully_drawn` *count* job draws — but job draws are **reversible**. A mixed booking (60 order + 40 job) would be "fully drawn" → allowed to `accept`; if the job later cancels, `revert_quote_status` can't reopen an accepted‑quote‑with‑an‑order → the restored 40 units strand. **Corrected design (consistent with A3):** job draws **never** satisfy "fully drawn". The existence gate counts job draws (to block/prevent double‑book), but `v_fully_drawn` stays **ORDER‑ONLY** in convert (A3.5), the accept trigger (A3.6), AND draw_down_quote (A3). Net rule everywhere: **any live job draw ⇒ booking is "partially drawn" ⇒ can't whole‑convert or direct‑accept** (use jobs / draw_down_quote for the remainder). This dropped A3.5's null‑order raise (unreachable now) — the ONLY delta vs each baseline is the existence‑gate `OR EXISTS(job_product_draws)`. Documented edge (safe): a booking fully consumed by completed jobs stays `sent`/`revised` (can't be accepted) — no corruption, office fulfils via the jobs.

### Codex v2 round‑4/5 edges (2026‑07‑02)
- **Draft cancellation (fixed A3.6):** a job can be scheduled from a `draft` planned quote, but the terminal guard only covered `sent`/`revised` → `draft→cancelled` bypassed it. Fix: the terminal guard now blocks a terminal transition from ANY status when a live job draw exists (order‑draw part stays sent/revised‑scoped). No `auto_expire` impact (skips planned quotes).
- **Vacuous‑true null order (fixed A3.5):** if a job‑drawn product is dropped from `quote_items`, order‑only `v_fully_drawn` is vacuously true → convert's `already_converted` could return a null `order_id` the caller force‑uses. Fix: re‑added a defensive `IF v_order_id IS NULL THEN RAISE BOOKING_PARTIALLY_DRAWN` in that branch.
- **DEFERRED to A4 cohort (root cause):** `save_quote`'s drawn‑product guard only checks `quote_product_draws` — it can drop a product that has a job draw (the vacuous‑true root, + would let the accept guard vacuously allow accept). **A4 must extend `save_quote`'s guard to also block dropping a product with a live job draw.** A FINAL combined Codex over complete Part A will confirm the whole set.

### A4 COHORT — requirements (build A4 to these so the quote‑side edges close at the source)
1. `_sync_job_holds(p_job_id, actor)` + `reserve_job_inventory(...)` — warn semantics, `expires_at = NULL`, `source_id = job_id`, job hold = full job demand; upsert `job_product_draws` = `LEAST(demand, remaining_quote_booking)`; resync parent quote via job‑aware `_sync_planned_holds`. Lock parent quote → inventory → holds.
2. Wire the 3 `job_chemicals` writers (`create_job_from_quote_section`, `save_job`, `load_recipe_into_job`) to call `_sync_job_holds` (status IN scheduled/in_progress). + invariant sweep backstop.
3. **Gate:** only create `job_product_draws` for planned quotes; check `create_job_from_quote_section`'s status requirement (can a job come from a draft quote?). Terminal guard already covers draft defensively.
4. **`save_quote` drawn‑product guard → job‑aware** (closes the round‑5 vacuous‑true root).
5. Frontend: DispatchBoard/Jobs reserve calls + `assertRpcResult` + `logActivity`; add a "Job" badge branch at `InventoryPage.tsx:1171-1173` (A1 types‑review i3).
6. **REVOKE anon** on the new SECDEF fns + verify `has_function_privilege('anon',…)=false`.

### A5 — `complete_job` §3.5 fix (2026‑07‑02)
- **File:** `20260702175000_layer2_complete_job_drop_phase7_drain.sql`. Removes the buggy "Phase 7" quote‑hold drain (`v_hold_qty`/`v_decrement_pb`/prebooked decrement/crop FIFO drain + unused vars). complete_job now ONLY deducts physical stock; A4's jobs trigger (fired on `status='completed'`) owns the hold release + quote resync. Everything else byte‑faithful.
- **PROVEN before/after (rolled back, live product w/ prebooked=305.5):** LIVE buggy → prebooked 305.5→**304.5** + crop 90.25→**89.25** (double‑reduction). A5 fixed → avail 1100→1099, prebooked 305.5→**305.5** (untouched), crop 90.25→**90.25** (draw kept), job hold released. `plpgsql_check` CLEAN.

### Revised cycle order (core first, then quote‑side polish, then Part B)
A3.5/A3.6 → A4 (reserve engine) → **A5 (complete_job §3.5 fix)** ✅ built → **db‑invariant sweep** (active `job` holds on terminal/deleted jobs = 0) + `save_quote` guard (A4‑cohort) → A3.7/A3.8/A3.9 (rollover/settlement) → Part B (B1–B4 read side).

## POST‑APPLY BATCH CHECKLIST (hand to Mason at the end — do NOT do during the loop)
1. Apply migrations A1→B4 in filename order via Supabase MCP `apply_migration` (Mason's explicit OK per file).
2. `node scripts/regenerate-schema-registry.mjs` (from live) so `hold_type='job'` + `job_product_draws` are known to the write‑time hooks. **[A1: M2]**
3. Regenerate `src/types/supabase.ts` (`supabase gen types`) — adds `job_product_draws`. **[A1: i2]**
4. `node scripts/generate-caller-graph.mjs` (caller‑graph is 2026‑06‑13, stale).
5. Doc‑sync: `docs/reference/migration-history.md` rows **[A1: M1]** + database‑schema.md/rpc‑functions.md + INVENTORY_RULES.md hold_type list + CLAUDE.md lifecycles/Net‑Free + GettingStarted.tsx Net‑Free copy + `docs/CHANGELOG.md` + `node scripts/regenerate-agents-md.mjs`.
6. Run the 4 test‑contract suites (rpcFixtureLiveDiff, rpcIdempotencyScope, schemaIntegrity, inventoryPositionValidator) + db‑invariant sweeps.

---

## Final push-gate Codex review (2026-07-02, vs origin/main @ 35bd91ea, HEAD 37f6d73c)

Ran one final independent Codex review (gpt-5.5, xhigh) against the exact pushable tip
after rebasing/merging origin/main + doc-sync. **Verdict: NOT clean — 3 P1 findings**, all
in the reserve-accounting layer, all WARN-only, all dormant on the current empty operational DB:

1. **[P1] Unplan-after-job-draw** (`20260702181000` save_quote:96) — **NEWLY surfaced.**
   save_quote lets `is_planned` flip to false even when a live `job_product_draws` row exists.
   On the next job re-sync the draw is deleted and (quote no longer planned) not re-inserted,
   so the booking's drawable/rollable balance reopens fully while the job still consumes stock
   → double-count. Single-job reachable. **Small, pattern-matching fix** (guard the unplan,
   like the existing terminal/drawn guards).
2. **[P1] Sibling reallocation on cancel/delete** (`20260702174000`:79-88) — KNOWN round-5
   deferral. Multi-job only.
3. **[P1] Allocate order coverage once across siblings** (`20260702174000`:165-171) — KNOWN
   round-5 deferral. Multi-job only.

#2 + #3 = the two owner-acknowledged multi-job coordinated-allocation P1s (need 2+ real jobs
on one quote+product to matter; genuine redesign). #1 is new and single-job-reachable.

**Push is correctly BLOCKED by codex-push-guard** (no clean verdict). Not bypassing.
Recommendation carried to Mason: fix #1 now (one small migration, gated apply), defer #2/#3
as the already-planned multi-job follow-up, then complete merge/push. Full output archived at
`.claude/session-state/codex-review-latest.txt`.

---

## Push-gate P1 #1 fix APPLIED LIVE (2026-07-03)

Migration `20260702183000_layer2_save_quote_block_unplan_with_job_draws` (A3.10) — save_quote
now rejects unplanning a booking (`is_planned`→false) while a live `job_product_draws` row
exists, with `BOOKING_HAS_JOB_RESERVATION`. Closes the newly-surfaced, single-job-reachable
push-gate P1 #1.

Verification chain: plpgsql_check CLEAN (rolled-back vs live) · guard truth-table correct ·
rls-security-reviewer CLEAN · migration-drift-reviewer CLEAN (byte-faithful diff, single
overload, all 3 referenced columns exist) · APPLIED LIVE (apply-guard proof hash
871229f0…, autopilot disarmed) · live-verified (1 overload, unplan guard + drawn guard both
present, search_path pinned) · post-apply sweeps CLEAN (overloads 0, secdef-searchpath 0,
actor-forgery only the pre-existing allowlisted cancel_delivery — save_quote absent).

Remaining: push-gate P1 #2 (sibling reallocation on cancel) + #3 (order coverage across
siblings) — the multi-job coordinated-allocation redesign, owner-accepted deferral (warn-only,
zero impact until 2+ real jobs share one booking).

---

## Post-fix Codex gate (2026-07-03, HEAD 9b484702) — 2 NEW findings; push held

The re-review confirmed the A3.10 unplan guard is present but surfaced that it's one facet of a
broader "quote edits don't re-sync job reservations" gap:

- **[P1 #4] Re-sync job reservations after quote quantity changes** (save_quote) — a job synced
  against a smaller booking whose quote is later saved with MORE quantity keeps its stale (small)
  draw; the added quantity is exposed as re-drawable balance that draw_down/rollover can commit
  again while the job hold already reserves that demand. Single-job reachable. NOT a quick guard —
  the real fix is making save_quote re-sync the quote's active jobs (touches the core quote RPC +
  inventory locking; entangled with the multi-job #2/#3 sibling allocation).
- **[P2 #5] Lock the quote FOR UPDATE before the unplan guard** — TOCTOU: _sync_job_holds locks
  the quote then inserts a draw; my EXISTS check can run before save_quote's UPDATE lock, so a
  concurrent schedule slips a draw between check and update. Small fix (lock early).

ROOT CAUSE: #2, #3, #4, #5 are all facets of ONE area — quote edits + job scheduling don't
coordinate their reservations. All DORMANT on the current empty operational DB (zero real
jobs/bookings). The applied A3.10 guard is a valid, harmless partial protection (over-blocks at
worst). Recommendation to Mason: do NOT keep applying midnight guards to the core save_quote RPC;
build ONE designed "job-reservation coordination" follow-up (covers #2–#5) before real jobs exist.
Push remains correctly BLOCKED (open P1 #4) — not bypassing.

## OWNER DECISION 2026-07-03: build coordination fix BEFORE merging

Mason chose: do NOT merge to main tonight. Next focused session, build ONE designed
"quote edits re-sync job reservations" fix covering #2/#3/#4/#5, with its own reviewer +
Codex gate, then merge `feat/inventory-layer2` → main fully clean.

STATE AT HANDOFF (branch `feat/inventory-layer2` @ 9b484702, NOT pushed):
- All 15 Layer 2 migrations (170000–183000) APPLIED LIVE + verified; DB is live & dormant-safe.
- #1 unplan guard (183000) applied — valid harmless partial protection (over-blocks at worst).
- Branch merged up to origin/main (0 behind / 20 ahead); docs synced to 610; drift PASS.
- OPEN (all dormant, zero real jobs/bookings): #4 (P1, save_quote stale draw on quantity change),
  #5 (P2, guard race — lock quote FOR UPDATE), #2 (P1, sibling realloc on cancel), #3 (P1, order
  coverage across siblings). Root: quote/job reservation coordination incomplete.

NEXT-SESSION PLAN (the coordination fix):
- Design: make save_quote (+ quote lifecycle) re-sync the quote's ACTIVE jobs after quote_items
  change, and lock the quote FOR UPDATE before the unplan guard (#5). Handle multi-job sibling
  allocation (#2/#3) in the same reserve-engine pass (reallocate order+booking coverage across
  sibling jobs once; re-sync remaining siblings on cancel/delete).
- Gate: rls + drift reviewers + rolled-back smoke + Codex until SHIP (only then merge/push).
- Codex full output archived: .claude/session-state/codex-review-latest.txt

---

## ✅ COORDINATION FIX BUILT + APPLIED LIVE (2026-07-03) — migration `20260703120000` (A3.11)

Mason approved ("Go", 2026-07-03) after the full gate came back green. Closes the last four open
findings (#2/#3/#4/#5) as ONE designed change — no more midnight guards on save_quote.

**What it is:** new SECDEF allocator **`_sync_quote_job_reservations(quote, actor)`** that rebuilds
EVERY active job's draws+holds for a quote together, allocating the crop-drawable remainder AND the
order-prebooked coverage ONCE across sibling jobs (FIFO by job creation):
```
crop_pool = booking − order_drawn − consumed_job_drawn ; preb_pool = order_drawn
per active job (FIFO): draw=LEAST(demand,crop_pool); crop_pool−=draw
                       rem=demand−draw; cover=LEAST(rem,preb_pool); preb_pool−=cover
                       hold=draw+(rem−cover)
```
For a lone active job with no consumed sibling this is **arithmetically identical** to the old per-job
formula (`draw=LEAST(demand,booking−order−consumed)`, `hold=draw+GREATEST(demand−draw−order,0)`), so
single-job behavior is unchanged; it differs — correctly — only for 2+ jobs on one product.
- **`_sync_job_holds`** re-routed to a thin router: quote-linked jobs → the allocator (handles this
  job's reserve/release AND sibling reallocation); quote-less jobs keep independent full-demand holds.
  Still returns per-job warn shortfalls, so the job_chemicals/jobs triggers + `reserve_job_inventory`
  are unchanged.
- **`save_quote`** (verbatim + 2 marked lines): (#5) `SELECT status ... FOR UPDATE` locks the quote
  before the unplan guard (kills the TOCTOU); (#4) trailing `_sync_planned_holds` → the allocator, so a
  quote edit re-syncs its jobs (a grown line re-draws; a shrunk line reallocates siblings).

**Which finding each piece closes:** #2 (sibling realloc on cancel) + #3 (order coverage once) = the
coordinated per-quote rebuild; #4 (stale draw on quantity growth) = save_quote calling the allocator;
#5 (guard TOCTOU) = the FOR UPDATE lock.

**Verification chain (all before apply):**
- `plpgsql_check` CLEAN on allocator + router (rolled-back vs live).
- `save_quote` byte-diff vs applied-live `183000` = EXACTLY the 2 intended lines (drift reviewer
  independently confirmed).
- Arithmetic replay of all 5 Codex target scenarios → ALL PASS (single-converted=0, single-open=60,
  #3=0/20, other-job=80/50, #2 realloc 60/40→60).
- **Real rolled-back `[E2E]` end-to-end on live tables:** 2 jobs share a booking of 100 → J1 draw 60
  hold 60, J2 draw 40 hold 60, crop 0; soft-delete J1 (lifecycle trigger fires) → J1 draw NULL, J2
  re-draws to 60 hold 60. #2 proven on real triggers, rolled back (live untouched; `[E2E]` markers).
- rls-security-reviewer CLEAN · migration-drift-reviewer CLEAN · `npm run typecheck` clean.
- **Codex `/codex-review --uncommitted`**: 0 BLOCKER/HIGH/P1; only 1 P2 = doc-count 610→611 (now fixed).

**APPLIED LIVE 2026-07-03** (apply-guard proof `dab0306a…`, autopilot disarmed). Live-verified: 1
overload each (save_quote/_sync_job_holds/_sync_quote_job_reservations); save_quote FOR UPDATE +
allocator call both present; router delegates; allocator search_path pinned; anon EXEC = false on all
three (service_role only). Post-apply sweeps CLEAN (no new overloads/searchpath/anon-exec/actor-forgery
— only the pre-existing allowlisted `cancel_delivery`). Docs synced to **611** (drift PASS), AGENTS.md
regenerated, CHANGELOG + this ledger + memory updated.

**NO RESIDUAL LAYER 2 DEFERRALS REMAIN.** Remaining: commit → push-gate Codex (`--base origin/main`,
HEAD-tied for codex-push-guard) → merge `feat/inventory-layer2` → `main` + push (Mason's go).
Post-merge follow-ups (pre-existing, non-blocking): schema-registry regen for `job_product_draws` +
`'job'` hold_type (SessionStart staleness note — from the earlier 15 migs, not this fix); regen
`rpcFixtureLiveDiff` pg_proc snapshot if it captures function bodies.

---

## ✅ CHANNEL-SEPARATION FIX APPLIED LIVE (2026-07-03) — migration `20260703130000` (A3.12)

After A3.11's coordination fix, a **full-feature Codex push-gate** (`--base origin/main` over all 22
commits) surfaced 4 more items. Mason then clarified the **business model** (the key that unblocked it):
**two sell channels off the same booking — CHEMICAL SALES (we deliver → order draws) and JOB
APPLICATIONS (we apply → job holds) are SEPARATE shed demands that ADD UP, never offset.** That
resolved the ambiguity behind the earlier round-2/3 "order coverage" logic (which had wrongly assumed
the channels shared stock).

Disposition of the 4 push-gate findings:
- **#A [P1, FIXED]** — the allocator shrank a job's shed hold by the order's drawn qty → under-counted
  what's needed in the shed to apply. FIX: **job hold = FULL application demand** (dropped preb_pool /
  order-offset). Draws unchanged (cap at booking → no double-BILL); only the shed RESERVATION grew to
  be honest. This also dissolved the multi-job "order-coverage-once" #3 (no order offset exists now).
- **#C [P2, FIXED]** — `restore_quote_version` now re-syncs the quote's active jobs via the allocator
  (verbatim + 1 line), like save_quote.
- **#B [P1, DROPPED — owner business-process follow-up]** — relaxing `enforce_quote_accepted_fully_drawn`
  so a completed-job booking could be "accepted" was **unreachable AND semantically wrong**: in this app
  "accept" == Convert-to-Order == a CHEMICAL SALE, so accepting an APPLICATION-fulfilled booking would
  mix channels. Left the accept guard UNCHANGED. Such bookings safely stay sent/revised (fulfilled via
  application invoices). **OPEN OWNER ITEM:** a dedicated "close / mark fulfilled by application" action
  (a lifecycle/UX feature, not a guard change) — build if/when Mason wants it.
- **#D [P2, FIXED]** — InventoryPage: "Job" badge + hide the (server-rejected) Release button on job holds.

**Verification (before apply):** plpgsql_check CLEAN (allocator + restore) · real rolled-back `[E2E]`
proving **#A** (order 40 + booking 100 + job demand 80 → job draw 60, hold **80** = full, NOT order-
reduced) **AND** the (then-still-present) #B accept path · save_quote/restore verbatim diffs · rls +
drift reviewers CLEAN · Codex first flagged #B as unreachable-and-wrong (P2) → **#B removed** → Codex
re-run CLEAN (only a doc-count P2, now fixed). **APPLIED LIVE 2026-07-03** (apply-guard proof
`a87162c1…`): overloads 1/1/1, allocator full-demand + anon-revoked, restore re-syncs jobs, accept
guard UNCHANGED (#B not applied); post-apply sweeps CLEAN. Docs synced to **612** (drift PASS).

## 🎉 MERGED TO MAIN + PUSHED (2026-07-03) — LAYER 2 COMPLETE

`feat/inventory-layer2` merged to `main` and pushed (`937e2634..a7d3ae37`). The merge folded in a
parallel **structure-wave2** session that had advanced `origin/main` by 8 commits (+4 migrations:
`20260702160000/161000/162000` + `20260702170000_p2_1`; AR due-date/aging + category remap) — no Layer 2
CODE conflicts (they touched AR/category only); doc-count files reconciled to the true merged disk total
(**616 migrations**, drift PASS: migration-history rows re-sorted+renumbered 596–616, CLAUDE.md keeps both
snapshots, CHANGELOG keeps both entries, AGENTS.md + workflow-map regenerated). Pre-push typecheck+build
GREEN; codex-push-guard satisfied (HEAD-tied proof `codex-review-a7d3ae37….json`). Vercel deploys the
frontend delta (#D InventoryPage Job badge / Release-button gating).

**Push-gate Codex verdict:** 0 BLOCKER/HIGH/P1 on the risky migration files; one **P2 = regenerate
`.claude/schema-registry.json`** (its high-water/`job_product_draws` are stale). This is NON-blocking,
metadata-only (drives write-time guard accuracy for FUTURE migrations), and **pre-existing + SHARED** with
structure-wave (their live tables are missing from it too). Deferred because a true rebuild needs the
`--from-introspection` workflow, which can't cleanly pipe a 115-table JSON through the MCP tool in-session.

**OPEN FOLLOW-UPS (owner / maintenance — none block the live app, which is correct now):**
1. **Schema-registry regen** (`node scripts/regenerate-schema-registry.mjs --from-introspection <live.json>`):
   run Q1–Q5 via MCP, assemble the JSON, rebuild. Add `job_product_draws` + `'job'` hold_type + the
   structure-wave tables + bump high-water to `20260703170632`+.
2. **"Close / mark fulfilled by application" lifecycle** (the dropped-#B follow-up): a way to close a booking
   fully fulfilled by job applications WITHOUT converting it to a chemical-sale order. Business-process +
   UX design with Mason.
3. Pre-existing owner items unchanged (label CSV, etc.).
