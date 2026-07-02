# Inventory‑Aware Scheduling — Layer 2 Handoff (v2)

**Written:** 2026‑07‑01 (v1 at the end of the Layer 1 session; **v2 same day**, after a 22‑agent deep verification of v1 against the live DB + code — 36 fact checks, adversarial design review, every serious finding independently re‑proven by a skeptic pass).
**For:** a fresh Claude session (assume zero prior context).
**Owner:** Mason (non‑coder — explain in plain English, lead with a recommendation, get his OK before writing code on anything multi‑file / SQL / money / RLS).

> ⚠️ **VERIFY BEFORE YOU TRUST THIS DOC.** Handoffs go stale and parallel sessions change things. Do "Step 0 — Verify ship‑state" FIRST. Treat every function/table/column name here as *"check it against live before you rely on it."* v2's claims were live‑verified on 2026‑07‑01; anything can have moved since.

**v1 → v2 changelog (what the verification changed):**
1. **Corrected two factual errors:** `complete_job` does NOT hard‑block on insufficient inventory (it soft‑flags and lets stock go negative), and it ALREADY drains parent‑quote holds at completion — via a mechanism that is **broken today** (see §3.5, a live bug).
2. **Fixed a BLOCKER design flaw:** v1's "separate `job_product_draws` ledger" design double‑counts reservations, because `_sync_planned_holds` rebuilds quote holds knowing only about `quote_product_draws`. v2 requires making the quote‑side functions job‑draw‑aware (§4A.3).
3. **Fixed the release design:** job soft‑delete bypasses status transitions and would orphan holds forever (§4A.6).
4. Added `get_job_inventory_shortfalls` to the mandatory Part B change‑set (it double‑counts once jobs hold their own stock, §4B).
5. Documented why "reuse `create_inventory_hold`" is not literally possible and what must change in it (§4A.4).
6. Added the omissions that would burn a fresh session: schema‑registry regen, the four test‑contract suites, new‑table conventions, idempotency helper pattern, doc‑sync list (§7).
7. Re‑estimated effort honestly: 4–6 migrations, not 1–3 (§8).
8. Added two owner decisions v1 missed: backfill and force‑override policy (§6).

---

## 1. What Layer 1 already shipped (DO NOT rebuild it)

Layer 1 = **read‑only visibility** of job product shortfalls. Live on `main` as of 2026‑07‑01 (commit `f7e74c9c`, migration `20260702120000_inventory_job_demand_visibility` — note: this migration name is **double‑recorded** in live `schema_migrations` (two applied‑version rows, same name); harmless, but a disk‑vs‑live 1:1 count over this window sees 12 live entries for 11 disk files).

- **RPC `get_job_inventory_shortfalls(p_days_ahead int)`** — SECURITY DEFINER, office‑gated (`require_admin_or_sales_rep()` first statement), anon revoked (verified `has_function_privilege('anon', …) = false`), search_path pinned. Returns products the next N days of `scheduled`/`in_progress` jobs (by `jobs.job_date`, `deleted_at IS NULL`) will run short of. Read‑only. It already **nets job demand against the parent planned‑quote's active holds** (quantity‑aware, `LEFT JOIN LATERAL … WHERE ih.source_id = wj.quote_id`, `GREATEST(job_qty − coverage, 0)`) — better than v1 described.
- **Office Cockpit** (`src/pages/OfficeCockpit.tsx:944‑985`) — the "Inventory Shortfalls" tile is live.
- **Dispatch Board** (`src/pages/DispatchBoard.tsx:341‑426, 862‑887`) — office users see per‑job products + a 🟢/🟡/🔴 stock light vs `available − prebooked − ALL active holds`. The `get_inventory_position` call is UI‑gated to admin/sales_rep — **UI‑layer only**: the live function has NO in‑body role gate and is EXECUTE‑granted to `authenticated`, so any logged‑in role can call it directly via the API (reads product cost/vendor/stock). Accepted for now; Layer 2 touches this fn, so consider adding defense‑in‑depth while you're in there.

Layer 1 does **not** touch the inventory ledger. Its known imperfection is §5.

---

## 2. Step 0 — Verify ship‑state (run these first, every fresh session)

1. `git worktree list` + read the SessionStart "PARALLEL WORK" note — Mason runs concurrent sessions. Check no one else is already doing Layer 2 (`git log --all --oneline | grep -i -E "reserv|layer.?2"`). As of 2026‑07‑01 verified: nobody is.
2. Supabase MCP `list_migrations` — confirm Layer 1 applied (match on **name**, not version; remember the double‑recording above).
3. `git log origin/main --oneline -5` — confirm `f7e74c9c` is an ancestor and you're branching from latest.
4. Read the live definitions before extending anything (`SELECT pg_get_functiondef(oid) FROM pg_proc WHERE proname = '…'`): `get_inventory_position`, `get_inventory_forecast`, `get_job_inventory_shortfalls`, `create_inventory_hold`, `_sync_planned_holds`, `create_planned_holds`, `draw_down_quote`, `release_holds_on_quote_status_change`, `create_job_from_quote_section`, `save_job`, **`load_recipe_into_job`** (v1 missed it — it's the third `job_chemicals` writer), `complete_job`, `transfer_job_to_invoice`.
5. `SELECT status, count(*) FROM jobs GROUP BY status;` and `SELECT hold_type, is_active, count(*) FROM inventory_holds GROUP BY 1,2;` — know the data volume (as of Layer 1: ~2 jobs, ~9 crop_program holds on 1 planned quote, ~20 `manual` holds with **NULL `source_id`**, 17 products with negative `quantity_available`).
6. **Repo‑burn‑history checks v1 omitted:** (a) look in `scripts/.staging-migrations/` for parked drafts; (b) grep other on‑disk/pending migrations before re‑emitting any function verbatim (`_sync_planned_holds` alone has been re‑emitted in 3 prior migrations — the overlap‑clobber class); (c) the apply‑guard proof file goes in the **PRIMARY worktree's** `CLAUDE_PROJECT_DIR` session‑state, not your build worktree; (d) pick migration timestamps that sort AFTER everything on disk (Layer 1's file is future‑stamped `20260702120000` — go after it).

---

## 3. The existing allocation model Layer 2 EXTENDS (verified live 2026‑07‑01)

CRX has a mature reservation/forecast engine for **quotes**. Layer 2 brings **jobs** into it. Everything below was verified against live definitions — the sub‑section numbers are referenced from §4.

### 3.1 Planned quotes & holds
- A **"planned program" = a quote with `is_planned = true`.** Saving it calls `_sync_planned_holds(quote_id, actor)` which **rebuilds from scratch** (`DELETE FROM inventory_holds WHERE source_id = quote_id AND is_active` then re‑INSERT), one hold row **per quote_item** (a product in multiple sections gets multiple rows), sized per product `GREATEST(total_units_needed − quantity_drawn, 0)` (drawn consumed FIFO earliest‑`needed_by_date`‑first), expiring `needed_by_date + 14 days`, `hold_type = 'crop_program'`, `source_id = quote_id`. It takes the quote row `FOR UPDATE` first and does **NO free‑stock validation**. Invoked by `save_quote`, `restore_quote_version`, `create_planned_holds`, `cancel_order`, `void_order`.
- **`create_inventory_hold(...)`** — the validating hold writer: `FOR UPDATE` on the inventory row (`location = 'Main Warehouse'`), validates against **today's free = available − prebooked − active holds** and hard‑RAISEs `INSUFFICIENT_HOLD_INVENTORY`; escape is `p_force` (**admin‑only** + mandatory reason). ⚠️ Three things v1 glossed: it has **no `p_source_id` parameter** (its INSERT omits `source_id`), it **hard‑codes `p_hold_type IN ('manual','crop_program')`** in the body (extending the table CHECK alone still gets `INVALID_HOLD_TYPE` at runtime), and its inline raw‑SQL idempotency lookups are **explicitly disavowed as precedent** by `docs/reference/sql-canonical-patterns.md` — new code uses the `check_idempotency`/`save_idempotency` helpers + the `-- idempotency-body-check: exempt` marker.
- **Expiry is read‑filter‑only.** Nothing ever deactivates a past‑`expires_at` hold: the only cron sweep (`release_expired_quote_holds`, 6:15 daily) releases holds of declined/expired **quotes** and ignores `expires_at`. Reads (`create_inventory_hold` validation, `get_inventory_position`, `get_job_inventory_shortfalls`) filter expiry; but `draw_down_quote`'s FIFO consumption and `complete_job`'s drain filter only `is_active` — an "expired" hold stops protecting stock yet is still consumed by draws. Any job‑hold expiry design inherits this split brain (§6.3).

### 3.2 Quote → order draw‑down
`draw_down_quote()` + the `quote_product_draws` ledger (per‑product `quantity_drawn`; columns `id/quote_id/product_id/quantity_drawn/created_at/updated_at`; RLS = single authenticated SELECT policy, writes via SECDEF RPCs only). Draws lock quote‑first, then inventory, then holds; shortfalls are **warned, not blocked** (`v_shortfalls` appended, proceeds) — this is the app's actual warn precedent, not `create_inventory_hold`.

### 3.3 Read side
- **`get_inventory_position()`** returns `holds_qty` (ALL active non‑expired holds, one aggregate per product — **no per‑source attribution in the output**) and `planned_qty` deduped via the PARKED‑007 `NOT EXISTS(active linked hold)` filter (migration `20260701203000`, applied live). ⚠️ That dedup is **hold‑EXISTENCE‑based**: `_sync_planned_holds` inserts no row when the computed hold is 0, so a fully‑drawn line's demand **resurfaces** in `planned_qty` while the drawer's hold also counts in `holds_qty` (the order path mostly dodges this because a full draw flips the quote to `accepted`; a job draw would not). `net_position` does NOT subtract holds/planned. No in‑body role gate (§1).
- **`get_inventory_forecast(int)`** filters `hold_type = 'crop_program'` only and buckets by `DATE_TRUNC('month', expires_at − INTERVAL '14 days')` — **`expires_at` is the only date signal on a hold**. Job holds are invisible to it until rewritten, and unbucketable unless their expiry follows a date convention or the fn joins `jobs` via `source_id` (§4B.4).
- Holds are released on quote terminal transition via the `release_holds_on_quote_status_change` trigger (pure status‑transition gate).

### 3.4 The job side today
- `save_job` / `create_job_from_quote_section` / **`load_recipe_into_job`** write `job_chemicals` (the latter two DELETE + re‑INSERT all lines; `save_job`'s chemicals rewrite has **no status guard**) and create **no hold**. Jobs link to quotes via `jobs.quote_id`; jobs' date column is `jobs.job_date` (a separate `schedule_date` column also exists — pick deliberately); `jobs.deleted_at` soft‑deletes; status CHECK = `scheduled / in_progress / completed / cancelled / invoiced`.
- **`complete_job` does NOT hard‑block on insufficient stock** (v1 was wrong). It computes `v_short_flag := new_avail < 0`, proceeds (driving `quantity_available` negative — 17 products are negative live), stamps the `job_applied` transaction `[SHORT STOCK — review required]` + `requires_review`. Deduction uses **planned** `job_chemicals.quantity`, not actuals (`actual_gallons_applied` is stored but never drives the deduction; the applied‑acres divergence feature touches no inventory).
- **Billing path: `transfer_job_to_invoice`** creates a `field_application` invoice **directly from the job** — no order, and it never touches `quote_product_draws`. So today a planned‑quote section can be job‑scheduled, completed, and billed while the quote's drawable booking balance still shows the full amount (drawable to an order = potential double‑fulfillment). Part A is where this gets fixed or cemented (§6.5).

### 3.5 ⚠️ LIVE BUG (exists today, pre‑Layer‑2): `complete_job`'s quote‑hold drain is dead code for planned quotes
`complete_job` "Phase 7" ALREADY tries to drain the parent quote's holds (`source_id = v_job.quote_id`, oldest‑first) and decrement `quantity_prebooked` — but the drain amount is clamped to `quantity_prebooked` first (`v_decrement_pb := LEAST(qty, hold_qty); IF prebooked < v_decrement_pb THEN v_decrement_pb := prebooked`), and **planned‑quote holds create no prebooked**, so the drain computes 0 and the quote hold stays fully active after real stock was deducted. Free stock is double‑reduced for up to ~2 weeks per completion. Skeptic‑verified 2026‑07‑01. **Part A's completion rewrite (§4A.5) must fix this**; a standalone fix chip also exists ("Fix complete_job quote-hold drain live bug") — check it wasn't already shipped before you rewrite.

**Related, READ IT:** `docs/roadmap/shelved-earmark-engine/` (exists: README + 3 unapplied SQL files) — the #6b prepay‑earmark engine was shelved because **two unreconciled spend mechanisms tracked the same money**. Job holds are a different mechanism (one ledger, one free‑stock formula), so the class doesn't transfer 1:1 — but the Layer 2 analog is real and specific: **a job draw and a `draw_down_quote` order draw consuming the same quote hold concurrently**. That exact race needs a `FOR UPDATE`‑serialized test (§7).

---

## 4. Layer 2 scope — two parts, build Part A first

### Part A — Jobs reserve product (the write side; the core)
Make a scheduled job **earmark (soft‑reserve)** its `job_chemicals` so two dispatchers can't double‑book the same stock, and so a shortfall surfaces at *schedule* time.

1. **Extend `inventory_holds.hold_type` CHECK** with `'job'` (live values today: exactly `manual, crop_program` — new list must be a superset). Job holds use `source_id = job_id`. **Same migration must also update `create_inventory_hold`'s in‑body whitelist** (§3.1) or the new type is rejected at runtime. After this migration applies live, **run `/regen-schema-registry` before writing any follow‑up SQL** that uses the new value — the `status-enum-check` hook validates literals against `.claude/schema-registry.json` and will hard‑block otherwise.
2. **New RPCs:** `reserve_job_inventory(p_job_id, …)` + a `_sync_job_holds(p_job_id, actor)` helper. Conventions: `SET search_path = public, pg_temp`, strict‑actor (`auth.uid()` bind + `ACTOR_MISMATCH`), `p_idempotency_key` via the **`check_idempotency`/`save_idempotency` helpers** (operation‑scoped lookup — the restore_quote_version bug class) + the `-- idempotency-body-check: exempt` marker, **REVOKE anon explicitly** (§7). `_sync_job_holds` must fire from **all three** `job_chemicals` mutators (`create_job_from_quote_section`, `save_job`, `load_recipe_into_job`) — or a `job_chemicals` statement trigger — and only for status IN (`scheduled`,`in_progress`).
3. **Parent‑quote dedup — the BLOCKER v1 got wrong.** A job from a planned quote must draw down the quote's hold, yes — but a *separate* `job_product_draws` ledger alone **double‑counts**: `_sync_planned_holds` rebuilds quote holds from scratch knowing only `quote_product_draws` (§3.1), so the first quote edit resurrects the full quote hold on top of the job hold (100 booked + 60 job‑reserved ⇒ 160 held). And `draw_down_quote`'s remaining‑balance math is equally blind, so the office could draw the full booking to an order after a job consumed part of it. **Required:** whichever ledger shape you pick (a `job_product_draws` table mirroring `quote_product_draws`, or job rows in a shared ledger), make **`_sync_planned_holds` AND `draw_down_quote` subtract live‑job draws** in the same Part A change‑set — they are named rewrite targets, not side effects. Job cancel/delete must reverse the draws and resync the quote's holds.
4. **Do not "just call" `create_inventory_hold`** (§3.1: no `p_source_id`, type whitelist, hard‑block semantics). Either extend it (add `p_source_id`; **single‑overload replacement** — check `pg_proc` for overloads; `schemaIntegrity.test.ts` enforces no‑overloads lists) with a warn mode, or write the job path with its own lock+validate honoring the §6.1 decision. **Validation semantics must be ONE deliberate choice:** `create_inventory_hold` blocks; `_sync_planned_holds` doesn't validate at all; `draw_down_quote` warns. Recommend **warn (draw_down_quote‑style)** — 17 products are negative‑stock today; a blocking auto‑reserve makes jobs on them unschedulable for sales_reps (force is admin‑only).
5. **Completion rewrite (`complete_job`):** drain the job's **own** hold (`source_id = job_id`) as it deducts; stop draining the parent‑quote hold for job‑reserved demand (the job draw already shrank it at reserve time); **fix the §3.5 prebooked‑gate bug** for legacy/unreserved jobs; re‑derive the prebooked decrement rules. Atomicity: if the job's own hold isn't counted as available‑to‑this‑job, completion self‑blocks/warns against its own reservation — the drain and the deduction go in one transaction.
6. **Release on lifecycle — including soft delete.** Release the job hold when `jobs.status` → `completed`/`cancelled` AND when **`deleted_at` transitions NULL → NOT NULL** — the Jobs page soft‑deletes via a direct table UPDATE with no status change (`Jobs.tsx:1182‑1187`, DELETABLE includes `scheduled`/`in_progress`), which would orphan holds forever (no sweep can clean them). Add a db‑invariant sweep: active `job` holds whose job is deleted/terminal = 0.
7. **Lock ordering (deadlock + self‑block):** for quote‑descended jobs, lock the **parent quote first** (matching `draw_down_quote` / `_sync_planned_holds`), then inventory, then holds; decrement the quote hold **before** inserting the job hold, in one transaction (otherwise the reserve's own validation counts the demand twice and falsely fails).
8. **Ledger visibility (optional):** if you want reserve/release in `inventory_transactions`, only `'job_reserved'` is new — **`'released'` already exists** (live CHECK has exactly the 12 documented types; the rewrite must reproduce all 12 verbatim + the new one).

### Part B — Fold job demand into the read side (only after Part A's holds exist)
1. **`get_job_inventory_shortfalls` — mandatory, v1 omitted it.** Post‑Part‑A it double‑counts: coverage only checks quote holds (`source_id = wj.quote_id`) while free stock subtracts ALL holds — a job that reserved its own 60 units reports a phantom shortfall whenever free < 2× its demand. Treat the job's own `source_id` hold as coverage.
2. **`get_inventory_position`:** add job‑hold demand as its own column (split the holds CTE by `hold_type`) AND make the planned‑quote dedup **quantity‑aware** (subtract drawn quantities per line, not existence‑of‑hold — §3.3's resurface bug). Update `inventoryPositionValidator.ts` REQUIRED_NUMERIC_FIELDS + `InventoryPositionRow` (src/types/index.ts:515‑536; note its doc comment records that holds/planned are NOT in `net_position` — changing that is a semantic decision).
3. **Dispatch light precision needs an API change** — v1's "now possible because holds are attributed by `source_id`" glossed this: `get_inventory_position` returns only aggregate `holds_qty`. Either extend its row shape or (more likely) a dedicated dispatch RPC that returns free‑excluding‑this‑job's‑own‑hold. Keep/improve the role gating (§1).
4. **`get_inventory_forecast`:** decide the date source for job holds — either job‑hold `expires_at` follows a convention derived from `jobs.job_date` (couples to the §6.3 expiry decision) or the fn joins `jobs` by `source_id`. Then add a "Jobs" column to `src/pages/InventoryPage.tsx` (already consumes `get_inventory_position`).

---

## 5. The specific imperfection Layer 2 removes
Layer 1's dispatch light subtracts **all** active holds from free stock (conservative — never falsely "ok"). Cost: a job backed by its own planned‑quote reservation can show "tight/short" when it's fine. (The Cockpit shortfall tile already dedups quantity‑aware against quote holds; the light doesn't.) No read‑only fix exists — attribution requires Part A's `source_id` job holds, plus the Part B.3 API change.

---

## 6. Owner decisions to confirm with Mason BEFORE coding
(Lead with a recommendation; the calls are his.)
1. **Conflict behavior — corrected framing:** today **NOTHING blocks anywhere** — completion goes negative with a review flag (§3.4), order draw‑down warns. So: reserve‑time **warn**, reserve‑time **block**, or warn‑at‑reserve + keep the completion flag? Recommend **warn‑first** (matches the app; block is a later toggle) — and note 17 negative‑stock products make any blocking auto‑reserve immediately painful.
2. **Automatic vs manual:** auto‑reserve on schedule/dispatch, or a deliberate "Reserve" action? Recommend auto, with an admin release.
3. **Expiry:** job holds live‑until‑lifecycle, or also a safety expiry? Constraint v1 didn't state: expiry is **read‑filter‑only** today (no sweep flips `is_active`, §3.1), and the forecast **buckets on `expires_at`** — so this choice shapes Part B.4. Recommend live‑until‑lifecycle + a safety expiry **with a real sweep shipped alongside**.
4. **Loop‑harness spec** (standing ask for big features): DRIVER, granularity, worktree, definition‑of‑done, delivery gate. Recommend: one session, own git worktree (this touches the live inventory ledger), file‑only DB drafts until an APPLY step, `/ship` per migration.
5. **Booking consumption (new):** should a job draw also consume the quote's drawable **order** balance so the same demand can't be billed twice via `transfer_job_to_invoice` + a later order draw (§3.4)? Recommend **yes** — it falls out of the §4A.3 shared‑remaining computation.
6. **Backfill + override (new):** do the existing scheduled jobs get retro‑reserved on ship, or only new/edited jobs (two‑regime until they cycle)? Recommend reserve‑on‑next‑edit + a one‑time office review. And who may force‑reserve when short — keep force admin‑only (warn mode already lets dispatchers proceed with a logged warning)?

---

## 7. Safety / gates (inventory‑ledger‑sensitive — max care)
- Route every migration through **`/ship`** (scaffold → reviewer subagents → fix → apply‑guard proof → **Mason's explicit OK to apply live** → rolled‑back smoke → db‑invariant sweeps → **Codex gate** → commit → push).
- **Every new SECDEF fn:** `SET search_path = public, pg_temp`, strict‑actor, idempotency **via helpers** (§4A.2), and **`REVOKE ALL … FROM PUBLIC, anon` + re‑grant to authenticated/service_role** — `REVOKE FROM PUBLIC` alone does NOT remove Supabase's direct `anon` grant (Layer 1 hit this). Verify `has_function_privilege('anon', …) = false` after applying.
- **RLS + table conventions for the new draws table:** mirror `quote_product_draws` exactly — RLS enabled, single authenticated SELECT policy, **writes via SECDEF RPCs only**, `updated_at` present, TS interface added. Note `inventory_holds` UPDATE policy is creator‑or‑admin — any hold writer/release path that isn't SECURITY DEFINER gets silently RLS‑filtered (all three existing writers are SECDEF).
- **Concurrency tests to prove:** concurrent `draw_down_quote` (order) vs job draw on the same quote hold (the earmark‑class race, §3.5 box); concurrent reserve+reserve on the same product; reserve → cancel reversal. Smoke every RPC in a rolled‑back tx (`BEGIN; …; ROLLBACK;`) against live schema; test the SECDEF role gate with a real admin `request.jwt.claim.sub` and a bad one.
- **Test‑contract suites that WILL fail if unattended** (regen recipes in each file's header): `src/lib/rpcFixtureLiveDiff.test.ts` (checked‑in pg_proc snapshot — regen after any new/renamed fn), `src/lib/rpcIdempotencyScope.test.ts` (disk‑scans idempotency lookups for operation scoping), `src/lib/schemaIntegrity.test.ts` (no‑overloads list includes `get_inventory_forecast`), `src/lib/inventoryPositionValidator.ts` (runtime row‑shape validation for `get_inventory_position`). E2E hold coverage to extend: `tests/e2e/holds-cleanup-paths.spec.ts`, `tests/e2e/quote-builder-v2.spec.ts`.
- **Frontend conventions:** `assertRpcResult` after the new RPC calls; `logActivity({event, description, performedBy, …})` on reserve/release actions (DispatchBoard has zero calls today — copy `QuoteBuilder.tsx`'s usage); types in `src/types/index.ts` (`InventoryHoldType` union at :492 is exactly `'manual' | 'crop_program'` — must gain `'job'`; `InventoryHold` :494‑510; `Job` :2000; `JobChemical` :2227; new draw interface).
- **Doc sync (MANDATORY per CLAUDE.md):** `docs/workflows/INVENTORY_RULES.md` (hold_type list :133, Net Free rules :140/:156), CLAUDE.md lifecycles (transaction types, Net Free), `docs/reference/database-schema.md` / `rpc-functions.md` / `migration-history.md`, `docs/CHANGELOG.md`, `node scripts/regenerate-agents-md.mjs` — **and the user‑facing Net Free copy in `src/pages/GettingStarted.tsx` (:321, :421)**, whose definition Part A changes.
- Dormant multi‑party allocation tables (`allocation_sets`, `order_line_allocations`, `invoice_line_allocations`, `order_shares`, `invoice_shares` — all confirmed 0 rows live) — understand before reusing, don't reinvent.

---

## 8. Effort / risk (re‑estimated after verification)
- **Part A:** **4–6 migrations, ~3–4 focused sessions.** v1's "1–3 migrations" missed that three live billing‑critical RPCs need rewrites (`complete_job`, `_sync_planned_holds`, `draw_down_quote`) — each wants its own reviewed migration per repo convention — plus the CHECK+whitelist migration, the draws table, the reserve/sync RPCs, the delete‑aware release trigger, and an expiry sweep if §6.3 keeps the safety expiry. Medium‑high risk: writes the inventory ledger; the §4A.3 shared‑draw math and §4A.5 completion rewrite are the hard parts.
- **Part B:** M — ~1 session on top of Part A (4 read fns/pages incl. the shortfall RPC + the dispatch API change).
- **Value ramps with job volume.** At ~2 live jobs it's premature; at many jobs/week (double‑booking real), high value. The §3.5 live bug, however, is worth fixing regardless of when Layer 2 starts.

---

## 9. Suggested opening move for the fresh session
Do §2 (verify ship‑state — including whether the §3.5 bug fix already shipped) → read §3's live definitions → write a short plain‑English plan for Mason (Part A first: the §4A.3 shared‑draw design, the §6 decisions with recommendations) → get his OK → build Part A via `/ship`, one gated migration at a time. Don't start Part B until Part A's holds exist.
