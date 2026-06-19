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
- **④ Machine fee + actor → "smaller targeted fixes" chosen** (not the full rebuild) — **not yet built** (see below).

### ▶️ Next focused session (recommended) — two billing changes, not urgent
Both remaining items are real **money math** best built with fresh focus (the crash that mattered is already fixed, so neither is urgent):
- **#4 — machine fee (G1) + actor (G3) targeted fixes.** G3 is a clean strict-actor block. G1 adds a per-acre `is_application_fee` line via `compute_application_service_fee` and must fold into the invoice total **and** the customer share-split (single-customer is simple; multi-grower split needs care, matching `save_field_app_invoice`'s `is_application_fee`/`price_source` line convention). A new migration on `transfer_job_to_invoice`; build → prove totals/shares tie out → review → **apply with Mason's OK**.
- **#2 — recipe-pricing bundle (per-unit).** Wire `price_per_unit_cents` through `save_blend_recipe`'s delete/reinsert + add the price box to the Recipes editor, then apply migration `20260618230000`.

---

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

- **Phase 1c (rail converge — G1 + G3 + G8) — PARKED for your sign-off.** Folds `transfer_job_to_invoice` into the richer `save_field_app_invoice` engine to (G1) add the **per-acre machine fee** it currently drops, (G3) close the **actor-forgery** gap, and (G8) stop two billing rails from drifting. This is a **large, architectural money-migration** the plan explicitly gates on your OK. **The actual loop blocker is already fixed by migration ① above, so 1c is an improvement, not a blocker.** If you'd rather not do the big converge, G1 and G3 can each be done as small, targeted fixes instead — your call.
- **Phase 4 (recipe pricing) — BUILT (parked migration — see ② above).** The core is done and proven; it needs your model decision (per-unit vs per-acre) and the save-wiring + UI bundle before it goes live.
- **Phase 3 (weather snapshot inside the save RPC) — PARKED (next session).** Snapshots job weather onto the field invoice transactionally, shown on the internal screen only (NOT the customer PDF, per your decision). It's a **migration that edits the large `save_field_app_invoice` money RPC**; reproducing a big money RPC verbatim is safest in a fresh, focused session (that discipline is how we avoid the drift bugs that caused 40+ past issues). Low immediate value — weather is already captured on the job, and the screen renders nothing until field invoices exist.
- **Phase 5 (controller import) — DEFERRED.** Needs the Raven / John Deere export format from you before it can start.

### How a fresh session resumes
State lives in committed files + `.claude/session-state/as-applied-loop-instructions.md` + `as-applied-progress.json`. Next session: (1) apply migration ① once you approve it (then re-run smoke `--spec transfer_job_to_invoice`); (2) on your model OK, finish the Phase 4 bundle (wire `save_blend_recipe` + add the recipe price UI) and apply migration ②; (3) decide Phase 1c (full converge vs. targeted G1/G3); (4) build Phase 3.

_Last updated: after Phase 4 — Field Invoices area + reconciliation view built & reviewed; the applied→invoice loop proven (one real live crash found, fixed in parked migration `20260618220000`, proven); recipe pricing proposed as parked migration `20260618230000`. Phases 1c/3 parked, Phase 5 deferred._
