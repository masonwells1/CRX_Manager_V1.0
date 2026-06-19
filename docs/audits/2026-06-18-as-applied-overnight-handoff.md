# As-Applied / Field Invoices — Overnight Build Handoff (for Mason's morning review)

**Branch:** `feat/as-applied-invoices` · **Plan:** [`docs/plans/2026-06-18-as-applied-application-invoices-plan.md`](../plans/2026-06-18-as-applied-application-invoices-plan.md)
**Rule in force:** the loop SKIPS anything it needs you for, logs it here, and keeps building (Mason, 2026-06-18). **Nothing went live overnight** — all go-live steps are parked for your one-click approval.

---

## TL;DR (read this first)

1. **The Field Invoices screen is built and reviewed** (Phase 1a) — a separate area listing only Application invoices, with its own cards, filters, exports, and correct permission gating. Committed, not live yet (it ships when you push the branch — your call).
2. **I proved the whole "spray job → bill" flow end-to-end** (Phase 1b) against a copy of your live database rules — and it **found a real, already-live bug**: the step that turns a finished job into a bill was **crashing** for a very common case. I fixed it, proved the whole flow now works, and **parked the fix for your one-click approval** (it is NOT applied to the live database).
3. **One thing needs your judgment** (the Chemical Sales list still shows field invoices) and **one is a rare-permission edge case** — both explained below. Neither blocks anything.

---

## ✅ Built, reviewed & committed (on the branch, NOT live)

| Phase | What | Commits | Proof |
|---|---|---|---|
| 1a | **Separate "Field Invoices" area** — top-level `/field-invoices` page listing only Application (`field_application`) invoices, with its own Unposted / Posted / Outstanding cards, status filter, search, CSV + PDF export, and a "New Field Application" button. New nav item under **Sales** + its own permission (admin/sales_rep). **Does NOT touch Chemical Sales billing.** | `2911d5d`, `d4336f5`, `d58a9e9` | typecheck ✓ · lint ✓ · build ✓ · pagePermissions test **32/32** ✓ · **3 Codex rounds** |
| 1b | **Proved the applied→invoice loop** end-to-end and **found + fixed a live crash** (see PARKED below). | smoke + migration (parked) | full-loop rolled-back smoke **PASS** · 2 migration reviewers **clean** |

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

### ② DECISION — Chemical Sales list still shows field invoices (Codex R2-b)

The old **Chemical Sales** list (`/invoices`) still shows **every** invoice type, including Application invoices — so a field invoice currently appears in **both** lists. That softens the "two segregated areas" goal.

I **did not change it overnight on purpose** — you locked in "the existing Chemical Sales screen stays untouched and unrisked while I sleep," and that page is deeply wired to the application-invoice type. Codex itself framed this as a **product choice**:
- **(a)** filter Application invoices **out** of `/invoices` so it's strictly Chemical Sales (my recommendation — matches the segregation goal), or
- **(b)** keep `/invoices` as an explicit "all invoices" page and accept the overlap.

**One word from you** ("filter it" / "leave it") and I'll do it in a couple of minutes.

### ③ FYI — rare permission edge case (Codex R3)

If you ever **deny** a sales rep the *Invoices* page but **grant** them *Field Invoices*, they can open **draft/unposted** field invoices fine, but clicking a **posted** one bounces them (posted invoices open the shared invoice detail, which is gated by the *Invoices* permission). The common setup (admins, and reps with both permissions) works perfectly. Fully fixing this for that rare combo needs either a dedicated field-invoice detail page or a decision that the combo isn't supported — **no action needed unless you want that exact restriction**.

### ④ FYI — small follow-ups (no action needed)
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

## ⏭️ What's next in the loop (still building safely)

- **Phase 1c (rail converge — G1 + G3 + G8):** the plan calls for folding `transfer_job_to_invoice` into the richer `save_field_app_invoice` engine to (G1) add the **per-acre machine fee** it currently drops, (G3) close the **actor-forgery** gap, and (G8) stop two billing rails from drifting. This is a **large, architectural** money-migration that the plan says needs **your explicit sign-off** — so it is a candidate to **park for you** rather than build wholesale unattended. **Note:** the actual *loop blocker* is already fixed by migration ①, so 1c is now an **improvement**, not a blocker.
- **Phase 2 (reconciliation view):** read-only "applied but not yet billed" screen — safe, high value, no money writes. Good next buildable step.
- **Phase 3 (weather on the internal screen, not the PDF)** and **Phase 4 (recipe pricing)** follow.
- **Phase 5 (controller import):** still **deferred** — needs the Raven / John Deere export format from you.

_Last updated: after Phase 1b — loop proven, crash fix parked (migration `20260618220000`), 2 reviewers clean._
