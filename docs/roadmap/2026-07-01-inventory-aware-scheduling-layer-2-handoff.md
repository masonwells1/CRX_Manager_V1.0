# Inventory‑Aware Scheduling — Layer 2 Handoff

**Written:** 2026‑07‑01, at the end of the session that shipped **Layer 1**.
**For:** a fresh Claude session (assume zero prior context).
**Owner:** Mason (non‑coder — explain in plain English, lead with a recommendation, get his OK before writing code on anything multi‑file / SQL / money / RLS).

> ⚠️ **VERIFY BEFORE YOU TRUST THIS DOC.** Handoffs go stale and parallel sessions change things. Do the "Step 0 — Verify ship‑state" checklist below FIRST. Treat every function/table/column name here as *"check it against live before you rely on it."*

---

## 1. What Layer 1 already shipped (DO NOT rebuild it)

Layer 1 = **read‑only visibility** of job product shortfalls. Live on `main` as of 2026‑07‑01 (commit `f7e74c9c`, migration `20260702120000_inventory_job_demand_visibility`).

- **RPC `get_job_inventory_shortfalls(p_days_ahead int)`** — SECURITY DEFINER, office‑gated (`require_admin_or_sales_rep()` as first statement), anon revoked, search_path pinned. Returns products the next N days of `scheduled`/`in_progress` jobs will run short of. It is **read‑only** — it reserves nothing.
- **Office Cockpit** (`src/pages/OfficeCockpit.tsx`) — the "Inventory Shortfalls" tile is live (was a placeholder).
- **Dispatch Board** (`src/pages/DispatchBoard.tsx`) — office users see per‑job products + a 🟢/🟡/🔴 stock light vs `available − prebooked − active holds`. Applicator‑safe (the `get_inventory_position` call is gated to admin/sales_rep).

Layer 1 does **not** touch the inventory ledger. Its one known imperfection is exactly what Layer 2 fixes (see §5).

---

## 2. Step 0 — Verify ship‑state (run these first, every fresh session)

1. `git worktree list` + read the SessionStart "PARALLEL WORK" note — Mason runs concurrent sessions. Don't collide. Check no one else is already doing Layer 2 (`git log --all --oneline | grep -i reserv` etc.).
2. Supabase MCP `list_migrations` — confirm `get_job_inventory_shortfalls` exists live and Layer 1 is applied.
3. `git log origin/main --oneline -5` — confirm `f7e74c9c` (Layer 1) is on main and you're branching from the latest.
4. Read the live definitions before extending anything: `SELECT pg_get_functiondef('public.get_inventory_position'::regproc)`, same for `get_inventory_forecast`, `create_inventory_hold`, `_sync_planned_holds`, `create_planned_holds`, `draw_down_quote`, `release_holds_on_quote_status_change`, `create_job_from_quote_section`, `save_job`, `complete_job`.
5. `SELECT status, count(*) FROM jobs GROUP BY status;` and `SELECT hold_type, is_active, count(*) FROM inventory_holds GROUP BY 1,2;` — know the real data volume (as of Layer 1: ~2 jobs, ~9 crop_program holds on 1 planned quote).

---

## 3. The existing allocation model Layer 2 EXTENDS (do not duplicate it)

CRX already has a mature reservation/forecast engine for **quotes**. Layer 2 brings **jobs** into it. Map it before building.

- A **"planned program" = a quote with `is_planned = true`.** Saving it calls `_sync_planned_holds(quote_id, actor)` which creates `inventory_holds` rows (`hold_type = 'crop_program'`, `source_id = quote_id`), sized `GREATEST(total_units_needed − quantity_drawn, 0)` per product, expiring `needed_by_date + 14 days`.
- **`create_inventory_hold(...)`** is the canonical hold writer: takes a `FOR UPDATE` lock on the inventory row, validates against **today's free = available − prebooked − active holds**, supports an admin `p_force` override with reason, is idempotent. **Reuse this for jobs.**
- **Quote → order handoff** uses `draw_down_quote()` + the `quote_product_draws` ledger (per‑product `quantity_drawn`), and re‑syncs the quote's holds so `holds + prebooked = total planned` stays invariant. **This is the exact pattern to mirror for job reservations that descend from a planned quote.**
- **`get_inventory_position()`** returns `holds_qty` / `planned_qty` (deduped via the PARKED‑007 `NOT EXISTS` pattern so a held planned‑quote line isn't double‑counted). **`get_inventory_forecast(int)`** aggregates `crop_program` holds by month (the Inventory → Forecast tab).
- Holds are released on quote terminal transition via the `release_holds_on_quote_status_change` trigger.
- **Jobs are currently the ONLY lifecycle outside this.** `save_job` / `create_job_from_quote_section` write `job_chemicals` but create **no hold**. Inventory is only touched at `complete_job()` (a `job_applied` transaction + a hard "insufficient inventory" block — the worst moment to discover a shortfall).
- **`job_chemicals.quantity`** is the per‑job product demand. **`jobs.deleted_at IS NULL`** filters soft‑deleted jobs.

**Related, READ IT:** `docs/roadmap/shelved-earmark-engine/` — the #6b prepay‑earmark engine was **shelved** because two prepay‑spend mechanisms could double‑spend, pending a "reserved‑pool redesign." Layer 2 reservations overlap that concept. Do **not** re‑apply those shelved migrations; do understand why it was shelved so Layer 2 doesn't repeat the double‑spend class. (Memory: `project_earmark-engine-shelved-2026-06-14`.)

---

## 4. Layer 2 scope — two parts, build Part A first

### Part A — Jobs reserve product (the write side; the core of Layer 2)
Make a scheduled job **earmark (soft‑reserve)** its `job_chemicals` so two dispatchers can't double‑book the same stock, and so a shortfall surfaces at *schedule* time, not at completion.

- Add a job hold type: extend the `inventory_holds.hold_type` CHECK to include e.g. `'job'` (read the live CHECK first; the new list must be a **superset** of the old). Holds use `source_id = job_id`.
- New RPC(s), reusing `create_inventory_hold`'s lock+validate pattern:
  - `reserve_job_inventory(p_job_id, ...)` — sum `job_chemicals`, create/refresh a `'job'` hold per product. Needs `p_idempotency_key`, strict‑actor (`auth.uid()`), role gate, `SET search_path = public, pg_temp`, **and REVOKE anon explicitly** (see the gotcha in §6).
  - A `_sync_job_holds(p_job_id, actor)` helper mirroring `_sync_planned_holds` so edits/reschedules rebuild the hold.
- **Parent‑quote dedup (critical):** a job created from a planned quote (`jobs.quote_id`) is already covered by that quote's `crop_program` hold. The job must **draw down** the parent quote's hold (mirror `draw_down_quote` + `quote_product_draws`, e.g. a `job_product_draws` ledger) rather than create a second full reservation — otherwise you double‑count. This is the same invariant the quote→order path already maintains.
- **Release on lifecycle:** a trigger (or in‑RPC) releases the job hold when `jobs.status` → `completed` / `cancelled` (mirror `release_holds_on_quote_status_change`). On completion, the hold converts to the actual `job_applied` deduction (don't leave a dangling hold).
- **Optional ledger visibility:** if you want holds in the transaction ledger, add a `'job_reserved'` / `'released'` type to the `inventory_transactions` type CHECK (again, superset).

### Part B — Fold job demand into position + forecast (the read side, now EXACT)
Once jobs have real holds (Part A), the read side becomes precise (no all‑or‑nothing dedup needed — the hold *is* the reservation):

- Extend `get_inventory_position()` to include job‑hold demand as its own column (this is the version Layer 1 built then **reverted** — it's exact now).
- Extend `get_inventory_forecast(int)` so scheduled field work shows up alongside planned‑quote demand.
- Add a "Jobs" column to the Inventory page main table (`src/pages/InventoryPage.tsx`).
- Make the Dispatch Board stock light **precise**: subtract holds EXCEPT the job's own job‑hold (now possible because holds are attributed by `source_id`). This removes Layer 1's conservative over‑warn.

---

## 5. The specific imperfection Layer 2 removes
Layer 1's dispatch light subtracts **all** active holds from free stock (conservative — it never falsely says "ok"). The cost: a job backed by its **own** planned‑quote reservation can show "tight/short" when it's actually fine. There's no read‑only fix — you can't attribute "whose hold is this" without real per‑job reservations. Part A gives jobs `source_id`‑attributed holds, so the light can finally say "free for THIS job = free + this job's own reservation."

---

## 6. Owner decisions to confirm with Mason BEFORE coding
(These are business/risk calls — lead with a recommendation, but they're his.)
1. **Conflict behavior:** if two jobs need the same drum and stock is short, does reserving **warn** (soft, like orders today) or **block** (hard)? Recommend warn‑first (matches the rest of the app; hard‑block is a later toggle).
2. **Automatic vs manual:** does scheduling a job auto‑reserve, or is "Reserve" a deliberate dispatcher action? Recommend auto on schedule/dispatch, with an admin release.
3. **Expiry:** should job holds expire (like quote holds = needed‑by + 14 days), or live until the job completes/cancels? Recommend live‑until‑lifecycle + a safety expiry.
4. **Loop‑harness spec** (Mason's standing ask for big features): confirm DRIVER (one session? its own worktree?), granularity, definition‑of‑done, and the delivery gate before starting. Recommend: one session, its own git worktree (this touches the live inventory ledger — isolate it), file‑only DB drafts until an APPLY step, `/ship` for each migration.

---

## 7. Safety / gates (this is money‑ and ledger‑sensitive — max care)
- Route every migration through **`/ship`** (scaffold → 4 reviewer subagents → fix → apply‑guard proof → **Mason's explicit OK to apply live** → smoke‑chain → db‑invariant sweeps → **Codex gate** → commit → push).
- **Reservations touch the inventory ledger** → treat like the money path. Atomicity matters: use the `FOR UPDATE` lock pattern from `create_inventory_hold`; test concurrent reserve+use; prove reverse‑on‑cancel.
- **Every new SECDEF fn:** `SET search_path = public, pg_temp`, strict‑actor (`auth.uid()` bind + `ACTOR_MISMATCH`), `p_idempotency_key`, and **`REVOKE ALL ... FROM PUBLIC, anon`** — `REVOKE FROM PUBLIC` alone does NOT remove the direct `anon` grant Supabase's default privileges add (Layer 1 hit this exact bug post‑apply). Verify with `has_function_privilege('anon', oid, 'EXECUTE')` = false after applying.
- Smoke every RPC in a rolled‑back tx (`BEGIN; …; ROLLBACK;`) against live schema before calling it done; for a SECDEF role gate, set `request.jwt.claim.sub` to a real admin id to test the happy path and a bad id to prove rejection.
- Watch the dormant tables `allocation_sets` / `order_line_allocations` / `invoice_line_allocations` / `order_shares` / `invoice_shares` (all 0 rows) — reserved multi‑party allocation infra; understand before reusing, don't reinvent.

---

## 8. Effort / risk (rough)
- **Part A (job reservations):** L — ~2–3 focused sessions. Medium‑high risk (writes the inventory ledger; concurrency + parent‑quote draw‑down are the hard parts). 1–3 migrations + release trigger + dispatch/job UI wiring.
- **Part B (precise forecast/position):** M — ~1 session on top of Part A. Lower risk (mostly read RPC extensions + UI), because the dedup is exact once Part A exists.
- **Value ramps with job volume.** At ~2 live jobs it's premature; when the field side is running many jobs/week (double‑booking becomes real), it's high value.

---

## 9. Suggested opening move for the fresh session
Do §2 (verify ship‑state) → read §3's live function definitions → write a short plain‑English plan for Mason (Part A first: which tables/RPCs, the conflict/auto/expiry decisions from §6) → get his OK → build Part A via `/ship`. Don't start Part B until Part A's holds exist.
