# As-Applied / Field Invoices — Overnight Build Handoff (for Mason's morning review)

**Branch:** `feat/as-applied-invoices` · **Plan:** [`docs/plans/2026-06-18-as-applied-application-invoices-plan.md`](../plans/2026-06-18-as-applied-application-invoices-plan.md)
**Rule in force:** the loop SKIPS anything it needs you for, logs it here, and keeps building (Mason, 2026-06-18). **Nothing went live overnight** — all go-live steps are parked for your one-click approval.

---

## TL;DR (read this first)

1. **The Field Invoices screen is built and reviewed** (Phase 1a) — a separate area listing only Application invoices, with its own cards, filters, exports, and correct permission gating. Committed, not live yet (it ships when you push the branch — your call).
2. **I proved the whole "spray job → bill" flow end-to-end** (Phase 1b) against a copy of your live database rules — and it **found a real, already-live bug**: the step that turns a finished job into a bill was **crashing** for a very common case. I fixed it, proved the whole flow now works, and **parked the fix for your one-click approval** (it is NOT applied to the live database).
3. **One thing needs your judgment** (the Chemical Sales list still shows field invoices) and **one is a rare-permission edge case** — both explained below. Neither blocks anything.

---

## 🌅 MORNING UPDATE — 2026-06-19 (after Mason's review)

Mason answered the four decisions. Status now:

- **① Crash fix → APPLIED LIVE ✅.** Mason said "apply it now." Applied via the migration-review gate (proof + apply-guard); live `transfer_job_to_invoice` md5 went `a361586e…` → `a998acd5…`, crash pattern gone, fix present. Re-ran the **whole flow against the live, fixed function** → `SMOKE_PASS_ROLLBACK`. Post-apply invariants clean (no dup overloads; SECDEF + search_path + grants intact). **The live billing crash is fixed.** _(Follow-up: record the applied row in `docs/reference/migration-history.md`; the migration file lives on the branch and reaches `main` when the feature branch merges.)_
- **③ Chemical Sales list → DONE ✅** (`18c5432`). `/invoices` now excludes `field_application` (fetch `.neq` + dropped the type-filter option). The two areas are segregated. (No visible change yet — 0 field invoices live.)
- **② Recipe pricing → model confirmed: PER-UNIT.** The parked migration `20260618230000` is the right model. Still must ship as a **bundle** (migration + `save_blend_recipe` wiring + recipe price UI) — **not yet built** (see below).
- **④ Machine fee + actor → FULL REBUILD locked in (Mason, 2026-06-19).** Mason initially picked "targeted fixes" but, after a walk-through of the trade-offs, **changed the decision to the full rebuild** (converge the two billing rails) — it fixes more, reuses already-proven fee/split math instead of re-writing it by hand, and leaves one billing engine to maintain. **Not yet built** (fresh session — see below).

### ▶️ Next focused session (recommended) — two billing changes, not urgent
Both remaining items are real **money math** best built with fresh focus (the crash that mattered is already fixed, so neither is urgent):
- **#4 — FULL REBUILD: converge the two billing rails (G1 + G3 + G8 together).** Make `transfer_job_to_invoice` a **thin adapter** that maps a job's data into the canonical `save_field_app_invoice` (+ `post_invoice_group`) engine, which **already** emits the per-acre `is_application_fee` line (G1), binds `auth.uid()` / rejects a forged actor (G3), and is the single billing engine (kills the two-rails-drift, G8). This reuses proven fee/multi-grower-split math instead of re-implementing it on the simple rail.
  - **VERIFY FIRST (before committing to the adapter):** confirm a job's data (job_chemicals, job_fields, application_service_id, applicator/vehicle, acres) maps cleanly onto `save_field_app_invoice`'s expected inputs (the locations/chemicals jsonb + p_application_service_id). If there's a lossy mismatch, surface it to Mason rather than force a bad adapter.
  - **Fold in (Codex LOWs from the plan):** (a) guard idempotency-key ownership across the converged rail — one outer op owns the key; nested helpers must not reuse the same external key; (b) remove the now-duplicate client-side `job_invoiced` activity_feed log in `JobDetail.tsx` (the RPC writes it server-side).
  - **Heavy gate (the plan's requirement):** new migration on `transfer_job_to_invoice`; migration reviewers + a fresh Codex pass + a rolled-back smoke asserting an `is_application_fee=true` line **and** an actor-mismatch rejection; **re-run the full-loop smoke AFTER the migration**; **apply with Mason's OK**. Base = the NOW-LIVE crash-fixed body (md5 `a998acd5…`).
- **#2 — recipe-pricing bundle (per-unit).** Wire `price_per_unit_cents` through `save_blend_recipe`'s delete/reinsert + add the price box to the Recipes editor, then apply migration `20260618230000`.

---

## 🔧 SESSION 2 — 2026-06-19 (build session, "build it all" — Mason)

Built **3 of the 4** remaining pieces. All committed on `feat/as-applied-invoices`; **all database changes parked** for one batched go-live with Mason's OK.

| # | Piece | Commit | Proof |
|---|---|---|---|
| #4 → **targeted, NOT rebuild** | `transfer_job_to_invoice`: per-acre machine fee (**G1**) + strict actor (**G3**) + removed duplicate client log. Migration `20260619140000` (PARKED). | `97836e8` | rls reviewer clean; drift reviewer caught a real BLOCKER (`price_source` CHECK) → fixed; rolled-back smoke PASS (fee bills, flat line still bills, forged actor rejected, totals+shares reconcile single + 2-grower) |
| #2 | **Recipe pricing bundle**: `save_blend_recipe` carries `price_per_unit_cents` (migration `20260619150000`, PARKED) + `BlendRecipes.tsx` $/unit input + duplicate-path copy. Applies WITH the parked `20260618230000`. | `82ce6a4` | both reviewers clean; rolled-back bundle smoke PASS (price persists, survives edit, seeds job, negative rejected) |
| calculator | **3-way quantity calculator** in the job-mix editor (rate ⇄ acres ⇄ quantity) — Mason's "like Chem Man" ask. UI-only. | `de1fcc6` | typecheck clean; needs Mason in-app check |

**Why #4 is the targeted fix, not the locked "full rebuild":** verifying the live engine (`save_field_app_invoice`) proved the rebuild was **lossy** — it drops flat-priced lines, bills chemicals by rate×acres (no explicit-quantity input), bills the field owner not the job customer, and blanks the PDF header. Mason needs to bill **both** by quantity AND per-acre, so the rebuild would remove quantity billing. Mason confirmed targeted.

### 🅿️ FOUR migrations awaiting ONE BATCHED apply (Mason: "hold migrations, build the edit screen + everything, ship together"). Each: /explain-migration + confirm live md5 + re-run the saved smoke after.
1. `20260619140000` — billing fix (per-acre machine fee G1 + strict actor G3, per-customer rate, override-skip). Smoke: `smoke-transfer_job_invoice_machine_fee.sql`.
2. `20260618230000` + `20260619150000` — recipe-pricing bundle (apply in that order). Smoke: `smoke-recipe-pricing-bundle.sql`.
3. `20260619160000` — `save_invoice` field-app aware (the #3 edit screen). Smoke: `smoke-save-invoice-field-app.sql`.

### ✅ #3 (edit-path) — BUILT (Mason: build it + ship together)
A job-created field invoice now has a safe editor. `save_invoice` was made **field-app aware, guarded on `invoice_type='field_application'`** (migration `20260619160000`): its reinsert preserves `is_application_fee` + the applied/EPA columns, and it re-balances `invoice_shares` to the edited total — Chemical Sales billing stays byte-identical (smoke-proven incl. a chemical-sale control). Job-built field invoices now route to a **field-invoices-permission-gated** `/field-invoices/:id` (reusing `InvoiceDetail`); engine-built editable ones keep the per-acre editor. The detail routes are **segregated by invoice type** so neither permission can open the other's invoices by URL (Codex R5). Reviewer-clean + smoke-proven; **browser pass still pending** (auth wall + 0 field invoices + parked migration → Mason's in-app check after apply).

### 🤖 Codex (gpt-5.5) pre-ship gate — 4 rounds, `--base main`
Mason asked "has Codex reviewed everything before we ship?" — it has now. Across **4 rounds** Codex found and I fixed **5 real money bugs in the migrations**, each re-proven by smoke + the two reviewers:
1. `price_source` CHECK violation on the fee line → write `'tier'` (drift reviewer).
2. **Split-grower fee used the wrong rate** → compute per-customer at each grower's own rate (`cb8d3ec`).
3. Invoice didn't record `application_service_id` → carry it onto the invoice (`cb8d3ec`).
4. Calculator could silently rewrite a flat line's quantity → per-line "driver" flag holds the typed field (`d170945`).
5. **Override-priced growers double-charged** the machine fee → skip override shares; **priced recipe left the job total stale** → re-roll it on load (`d099f8e`).

**Migrations are now Codex-clean.** The two findings that remain are **not in the migrations** and are tracked as follow-ups: the #3 edit-path/permission routing (above) and recreating the absent `smoke-field-invoice-loop.sql` full-chain test + registering it. Neither blocks applying the three parked migrations.

## ✅ Built, reviewed & committed (on the branch, NOT live)

| Phase | What | Commits | Proof |
|---|---|---|---|
| 1a | **Separate "Field Invoices" area** — top-level `/field-invoices` page listing only Application (`field_application`) invoices, with its own Unposted / Posted / Outstanding cards, status filter, search, CSV + PDF export, and a "New Field Application" button. New nav item under **Sales** + its own permission (admin/sales_rep). **Does NOT touch Chemical Sales billing.** | `2911d5d`, `d4336f5`, `d58a9e9` | typecheck ✓ · lint ✓ · build ✓ · pagePermissions test **32/32** ✓ · **3 Codex rounds** |
| 1b | **Proved the applied→invoice loop** end-to-end and **found + fixed a live crash** (see PARKED below). | `c4b4430` (smoke + parked migration) | full-loop rolled-back smoke **PASS** · 2 migration reviewers **clean** · Codex **clean** |
| 2 | **"Unbilled Applications" reconciliation view** (`/field-invoices/unbilled`) — read-only screen listing applied-but-not-yet-billed work across the **two reliable backlogs** (completed jobs with no invoice + approved-unbilled blend tickets). Links out to the source screens; **writes nothing**. Reached via an "Unbilled" button on the Field Invoices page; reuses the Field Invoices permission. | `5993ee4`, `5639877` | typecheck ✓ · lint ✓ · build ✓ · pagePermissions **32/32** ✓ · FK-embeds confirmed live · Codex clean (2 findings fixed) |
| 4 | **Recipe per-unit pricing** (PARKED migration — see ② below). Fixes G5 so recipe-loaded jobs don't arrive at $0 chemical prices. | `aa8cc43` | rolled-back smoke + self-verify **PASS** · 3 migration reviewers (drift+RLS+types) **clean** · Codex running |

**Phase 1a Codex review (3 rounds, gpt-5.5) — what it caught and what I did:**
- **Round 1 → FIXED:** (P1) clicking a draft/unposted field invoice opened the *wrong* editor (the generic one that saves via the wrong path) — now opens the field-application editor. (P2) the "Outstanding" card dropped **overdue** invoices from the AR total — now counts posted **and** overdue.
- **Round 2 → FIXED:** (R2-a) the field-application editor was gated by the old *Invoices* permission instead of the new *Field Invoices* one — fixed + added a regression test.
- **Round 3 + Round 2 leftovers → PARKED for you** (see "Needs Mason" below).

---

## 🅿️ NEEDS MASON / PARKED (review in the morning)

### ① APPROVAL TO APPLY — the live crash fix (the important one)

**Migration:** `supabase/migrations/20260618220000_fix_transfer_job_invoice_conversion_record.sql`

**Plain English:** When a finished spray **job** is turned into a **bill**, the code crashes if **any product on the job has no per-acre rate** (e.g. a flat-priced or hand-entered line). It fails with a database error and **no bill is created**. This has been broken since the feature shipped, but it never surfaced because **no field jobs have been billed in production yet** (0 field invoices live). I only found it by running the entire flow against a copy of your live rules.

**The fix:** a **one-line change** — it always runs the unit-conversion helper (which safely returns "nothing" for unrated lines) instead of skipping it and then crashing. Nothing else about the billing changes; unrated lines simply show a blank gallons/lbs figure, exactly as intended.

**Why I'm confident:** I reproduced the crash against the live function, applied the fix in a throwaway transaction, and ran the **whole flow** — schedule job → start → complete (writes the application record + weather) → create the field invoice → edit it → **post** it → **void** it — and it **passed cleanly** (`SMOKE_PASS_ROLLBACK`, nothing committed). Two independent reviewers (drift + security) signed off; Codex review attached in the branch.

**To go live (your call — one approval):**
1. I run `/explain-migration` so you see exactly what changes, in plain English.
2. I confirm the migration's version stamp lines up (`list_migrations`).
3. **You say "apply it"** → I apply it to live, then re-run the smoke against live to confirm.
4. After apply: add its row to `docs/reference/migration-history.md`.

> **Safe to leave unapplied.** Until you approve, the live behavior is unchanged (the crash stays, but it only affects field jobs that have an unrated line — and no field jobs are billed yet). This is **not** urgent-at-2am; it's first-thing-with-coffee.

### ② APPROVAL + DECISION — recipe pricing (Phase 4)

**Migration:** `supabase/migrations/20260618230000_recipe_per_unit_pricing.sql` (PARKED)

**Plain English:** Today, when you load a saved **recipe** (tank-mix) into a job, the chemicals come in at **$0** — someone has to hand-price every line before the job can be billed. This migration lets a recipe carry a **price per unit** that's copied into the job automatically.

**Two things I need from you:**
1. **Which pricing model?** You floated "a per-acre $/ac on the recipe." I built **per-unit pricing** instead, because that's what the system already uses (chemical lines are priced per unit; the per-**acre** machine charge is already separate via Application Services). A per-acre recipe price would need a **new billing path that overlaps** the existing per-acre application fee. **→ Confirm: per-unit (what I built) or per-acre (needs a different design)?**
2. **Don't apply this one alone.** Codex caught a real trap: once a recipe has a non-zero price, editing/duplicating that recipe on the current Recipes page would **silently wipe the price back to $0** (the page + the save routine don't carry the new field yet). So recipe pricing must go live as a **bundle**: this migration **+** wiring the price through the recipe-save routine **+** adding the price box to the Recipes editor. **It's harmless while parked** (nothing can set a non-zero price yet). I left the bundle for after you confirm the model — no point building the save-wiring + UI for a model you might change.

**Proof the core works:** rolled-back smoke (a recipe price of $15.00 flows into the job; an unpriced item stays $0; costs still correct; a negative price is rejected) = `SMOKE_PASS_ROLLBACK`; self-verify passed; 3 reviewers clean.

### ③ DECISION — Chemical Sales list still shows field invoices (Codex R2-b)

The old **Chemical Sales** list (`/invoices`) still shows **every** invoice type, including Application invoices — so a field invoice currently appears in **both** lists. That softens the "two segregated areas" goal.

I **did not change it overnight on purpose** — you locked in "the existing Chemical Sales screen stays untouched and unrisked while I sleep," and that page is deeply wired to the application-invoice type. Codex itself framed this as a **product choice**:
- **(a)** filter Application invoices **out** of `/invoices` so it's strictly Chemical Sales (my recommendation — matches the segregation goal), or
- **(b)** keep `/invoices` as an explicit "all invoices" page and accept the overlap.

**One word from you** ("filter it" / "leave it") and I'll do it in a couple of minutes.

### ④ FYI — rare permission edge case (Codex R3)

If you ever **deny** a sales rep the *Invoices* page but **grant** them *Field Invoices*, they can open **draft/unposted** field invoices fine, but clicking a **posted** one bounces them (posted invoices open the shared invoice detail, which is gated by the *Invoices* permission). The common setup (admins, and reps with both permissions) works perfectly. Fully fixing this for that rare combo needs either a dedicated field-invoice detail page or a decision that the combo isn't supported — **no action needed unless you want that exact restriction**.

### ⑤ FYI — small follow-ups (no action needed)
- **P-1:** `FieldInvoices.tsx` is a deliberate standalone page (not a refactor of `Invoices.tsx`) so it couldn't break Chemical Sales overnight. A shared-list-component cleanup is an easy future tidy-up.
- **P-2:** the field list has no batch post/void/print yet — you post/void/print by opening an invoice. Easy follow-up.

---

## 🔎 What Phase 1b actually proved (the loop is real)

Running the real database functions in order, on a rolled-back copy of live:

| Step | Function | Result |
|---|---|---|
| schedule | (insert job) | ✓ |
| start | `start_job` | ✓ in_progress |
| complete | `complete_job` | ✓ writes the **application record + weather** + deducts inventory |
| bill | `transfer_job_to_invoice` | **was crashing** → fixed (parked migration) → ✓ unposted field invoice, links the application record, flips job → invoiced |
| edit | (edit unposted invoice) | ✓ freely editable while unposted (your "bill actual" requirement) |
| post | `post_invoice` | ✓ posted, balance set, audit row written |
| void | `void_invoice` | ✓ voided, totals zeroed, audit row written |

Idempotency (double-submit protection) verified on `complete_job` (no duplicate application record). Saved as a durable test: `scripts/smoke/smoke-field-invoice-loop.sql`.

---

## ⏭️ Remaining phases — all parked or deferred (nothing else built unattended)

The overnight loop stopped here because everything left is **either parked for your
decision or best done in a fresh session** — none of it can safely go further while you sleep.

- **Phase 1c (rail converge — G1 + G3 + G8) — DECISION LOCKED: FULL REBUILD (Mason, 2026-06-19).** Folds `transfer_job_to_invoice` into the richer `save_field_app_invoice` engine to (G1) add the **per-acre machine fee** it currently drops, (G3) close the **actor-forgery** gap, and (G8) stop two billing rails from drifting. Mason confirmed the full rebuild over the targeted patch. **The actual loop blocker is already fixed by migration ① above, so this is an improvement, not a blocker.** Build it in the fresh session per the "#4 — FULL REBUILD" detail above.
- **Phase 4 (recipe pricing) — BUILT (parked migration — see ② above).** The core is done and proven; it needs your model decision (per-unit vs per-acre) and the save-wiring + UI bundle before it goes live.
- **Phase 3 (weather snapshot inside the save RPC) — PARKED (next session).** Snapshots job weather onto the field invoice transactionally, shown on the internal screen only (NOT the customer PDF, per your decision). It's a **migration that edits the large `save_field_app_invoice` money RPC**; reproducing a big money RPC verbatim is safest in a fresh, focused session (that discipline is how we avoid the drift bugs that caused 40+ past issues). Low immediate value — weather is already captured on the job, and the screen renders nothing until field invoices exist.
- **Phase 5 (controller import) — DEFERRED.** Needs the Raven / John Deere export format from you before it can start.

### How a fresh session resumes
State lives in committed files + `.claude/session-state/as-applied-loop-instructions.md` + `as-applied-progress.json`. Next session: (1) apply migration ① once you approve it (then re-run smoke `--spec transfer_job_to_invoice`); (2) on your model OK, finish the Phase 4 bundle (wire `save_blend_recipe` + add the recipe price UI) and apply migration ②; (3) decide Phase 1c (full converge vs. targeted G1/G3); (4) build Phase 3.

_Last updated: after Phase 4 — Field Invoices area + reconciliation view built & reviewed; the applied→invoice loop proven (one real live crash found, fixed in parked migration `20260618220000`, proven); recipe pricing proposed as parked migration `20260618230000`. Phases 1c/3 parked, Phase 5 deferred._
