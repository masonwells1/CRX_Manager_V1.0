# Overnight Bug Hunt — Running Report

> Mason's morning read. Per cycle: what was found, what was **auto-fixed** (green — already
> committed to `claude/overnight-bug-hunt`, Codex-blessed, green toolchain) and what's
> **parked** (yellow — needs your OK; plain-English explanation + validation proof + Codex note).
> Nothing here is live. One `git merge claude/overnight-bug-hunt` (or cherry-pick) lands the
> green fixes you like; parked items ship via `/ship` after you approve.

**Branch:** `claude/overnight-bug-hunt` (based on `main`) · **Started:** 2026-06-19

---

## ✅ Committed this run (green — safe, reversible, already verified)

**1. Cancelled commissions no longer show up when you go to pay commissions** — `commit 6ded5ce`
The "create commission payment" screen listed every commission that wasn't already paid — which
**also included *cancelled* ones**, so a cancelled commission could be selected and paid by mistake,
and it inflated the unpaid totals. Now it shows only **pending** (actually-payable) commissions.
One-line change to `CommissionPayments.tsx`. Codex independently confirmed the bug (REAL) **and**
reviewed the fix (SHIP); lint + build + ~2,000 tests passed.

> **Cycle 2 committed nothing new** — every issue it found needs a database migration, so by your
> rule they're all parked below (none is a safe auto-fix-to-branch). Nothing was pushed or touched live.

## 🅿️ Parked for your approval (yellow — needs a database migration; NOT applied)

These are real, verified issues whose fix changes a database function — so by your rule they wait
for your OK. None is on fire (the billing engine had **0 critical/high-severity** issues). Ordered
worst-first.

| # | Plain-English issue | Why it matters | Note |
|---|---|---|---|
| A | **`transfer_job_to_invoice` lets the caller fake "who did it."** It checks your *role* but doesn't verify the recorded user is actually you. | The "created by" stamp on a job→invoice and its activity-log entry can be set to someone else. | ⚠️ **Codex rates this HIGH**, Claude rated it MEDIUM — surfaced both. Already has a parked strict-actor fix on the `feat/as-applied-invoices` branch (G3) — coordinate so it's fixed once, not twice. |
| B | **Two invoice-creating paths don't write a row to the money audit log** (`create_invoice_for_unbilled_delivery`, the `complete_delivery` auto-invoice). | Your append-only financial ledger would be missing those invoices for an auditor. | Both are latent (rarely/never hit in prod). Same gap nightly-debug already closed on two sibling paths — just two more. |
| C | **Bulk "apply prepayments" can double-spend a customer's prepaid balance.** The bulk buttons decrement the cached balance but don't write the prepay-applied ledger rows, so a later reconcile can re-create the spent balance. | Real money correctness — a customer's prepaid credit could come back after being used. | Needs live-reachability check first; route the bulk path through the same ledger the single-apply path uses. |
| D | **A partially-voided payment can leave an invoice stuck showing "paid."** | The invoice's status wouldn't match its real balance. | Derive status from the balance after the void. |
| E | 6 more LOW items | per-penny rounding drift in the (dormant) field-billing split, stale job totals after loading a recipe, a blend-ticket that's manually marked prepaid/no-charge could be billed twice, a duplicate-line oversell guard, and a job-invoice audit-log row. | All low blast-radius; details in `LEDGER.json`. |

> One green item (field-application invoices being editable through the generic invoice screen) is a
> **frontend** fix but I **parked it on purpose** — that exact area is being reworked on
> `feat/as-applied-invoices`, so fixing it here would collide at merge.

### Parked — added in Cycle 2 (deeper dive on invoices + job-to-billing; all need a migration)

Each was independently confirmed by Codex (REAL) at the severity shown. All are **latent** — the
billing engine is still operationally near-empty, so none is corrupting live data today; they're
traps that would bite once invoices/jobs start flowing. Worst-first.

| # | Plain-English issue | Why it matters | Severity |
|---|---|---|---|
| F | **Editing a field-application invoice doesn't "lock" it, so two people acting at the same instant can clash.** If one person edits the invoice's lines while another posts it in the same split-second, you can end up with a *posted* invoice whose line items were rewritten afterward — its total no longer matching the money audit log. | Every other invoice action locks the row first; this one edit path doesn't. Could produce a posted invoice that disagrees with the permanent ledger. | MEDIUM |
| G | **Two invoice paths don't refresh the stored "total cost" after an edit/creation** (`save_invoice` after a line edit; `create_invoice_from_order`). The stored cost stays at 0 / stale while the line items have real costs. | Today every report recomputes cost from the line items, so nothing visible is wrong — but any future report that trusts the stored number would understate cost / overstate margin. Best fixed as **one** small migration. | LOW |
| H | **Dropping a customer from a field-app invoice group cancels their invoice but writes no money-audit row.** | The append-only financial ledger would show the invoice being created but never cancelled — an auditor sees a dangling entry. Same gap class already closed elsewhere. | LOW |

> Also re-confirmed (already on your parked list from Cycle 1, not new): the `transfer_job_to_invoice`
> "who-did-it" forgery item — Cycle 2's check rated it **MEDIUM** (Cycle 1's Codex had said HIGH; both
> kept on record) — plus the job→invoice split-rounding item, now with a clearer fix (the header total
> isn't reconciled to the per-customer shares at all on the no-override path), and the missing
> job→invoice audit-log row. No new action — they're already in `LEDGER.json`.

## 🔎 Cycle log

### Cycle 1 — 2026-06-19 — Phase 1 (all 7 billing subsystems) — PROOF run
- **Found:** 12 confirmed (0 BLOCKER / 0 HIGH / 5 MEDIUM / 7 LOW), 4 refuted as false positives.
- **Codex finding-gate:** confirmed the 3 acted-on findings REAL; **disagreed up** on the actor bug (MED→HIGH).
- **Fixed (green):** 1 — cancelled-commissions leak (committed `6ded5ce`, both Codex gates passed).
- **Parked (yellow):** 11 — all need a migration; documented above + in `LEDGER.json`.
- **Proven:** the full chain — hunt → Codex confirms finding → fix → Codex reviews fix → tests → commit-to-branch — works end-to-end. Nothing pushed; nothing touched live.

### Cycle 2 — 2026-06-19 — Phase 1 focused: `invoices-core` + `jobs-to-billing` (hottest cluster)
- **Found:** 7 confirmed (0 BLOCKER / 0 HIGH / 3 MEDIUM / 4 LOW), 0 refuted, **0 green** (every fix needs a migration).
- **Dedupe:** 3 of the 7 were re-confirmations of already-parked Cycle-1 items (job→invoice actor-forgery, job→invoice share-rounding, job→invoice missing audit row) — enriched, not re-parked. **4 were new.**
- **Codex finding-gate:** independently confirmed **all 4 new findings REAL**, severities **matching** Claude's verifier exactly (1 MEDIUM + 3 LOW) — no disagreements this cycle.
- **Fixed (green):** 0 — nothing was committable (all migration-class).
- **Parked (yellow):** 4 new (items F–H above) + the 3 enriched re-confirmations.
- **Note:** `invoices-core` + `jobs-to-billing` still surfaced new findings, so they're **not drained** yet — they need one quiet cycle before being marked done. Recurring pattern flagged: several RPCs don't keep their stored derived totals in sync — worth one consolidating migration.

### Cycle 3 — 2026-06-19 — Phase 1: `field-app-invoices` — **DRY (nothing new)**
- **Found:** 1 confirmed (MEDIUM), 0 refuted — but on dedupe it was the **same issue already on your parked list** (field-application invoices opening in the generic invoice editor, which corrupts their structure on Save). So **0 new findings** this cycle.
- **Codex gate:** not run — there was no new finding to confirm and nothing to fix, so there was no change for Codex to gate (it only gates new candidates/diffs).
- **Fixed (green):** 0. **Parked (yellow):** 0 new — I enriched the existing parked item with more detail instead of double-listing it.
- **Why I left it alone:** this is the green/frontend item I deliberately parked in Cycle 1 — that whole area is being rebuilt on the `feat/as-applied-invoices` branch, so a fix here would clash at merge. Cycle 3 also surfaced a subtlety that *confirms* parking is right: a blanket "send all field-app invoices to the field-app editor" fix would be **partly wrong** (blend-ticket-backed ones are *supposed* to use the generic editor) — so the correct fix is the more careful one the feature branch is already building. It's also harmless today: there are **0 field-application invoices live**.
- **Take-away:** the `field-app-invoices` area looks **tapped out** for new signal — its one open defect is parked pending the feature-branch rework. Counts as the **1st dry cycle** (3 in a row stops the hunt). Next cycle moves to a **fresh** area: commissions + deliveries-billing.

### Cycle 4 — 2026-06-19 — Phase 1: `commissions` + `deliveries-billing`
- **Found:** 3 confirmed (0 BLOCKER / 0 HIGH / 1 MEDIUM / 2 LOW), **1 refuted** as a false positive. After dedupe: **2 new** (1 was a re-confirm of a Cycle-1 parked item), **0 green** (both new ones need a migration).
- **Codex finding-gate:** independently confirmed **both new findings REAL**, severities **matching** mine (1 MEDIUM + 1 LOW), and settled a tricky dedupe question on the first one (see note) — *and* caught a mistake in my proposed fix, which I've recorded so the eventual migration is correct.
- **Fixed (green):** 0 — nothing committable (both migration-class). **Parked (yellow):** 2 new (items I & J below).
- **Re-confirmed (already on your list):** the quick-delivery "same product listed twice could oversell" item from Cycle 1 — enriched, not re-listed.
- **Refuted (no action):** a commission-report item that *looks* wrong (the "Total Earned" column doesn't filter out cancelled commissions) but **can't actually produce a wrong number today** — cancelling an order zeroes the commission in the same step, so there's nothing to mis-count. Logged as a false positive.

### Parked — added in Cycle 4 (need a migration; all latent today)

| # | Plain-English issue | Why it matters | Severity |
|---|---|---|---|
| I | **A partial delivery on an already-drafted invoice fixes the *price* but not the *cost*.** When you deliver only part of an order that already has a draft invoice, the invoice's revenue drops to what was actually delivered — but its recorded **cost stays at the full ordered amount**. | The invoice's profit/margin would read too low (cost overstated). It feeds month-end margin/COGS numbers and is never corrected later. **Codex flagged that the right field to fix is the invoice's stored total cost** (the per-item cost is per-unit, so it shouldn't be re-multiplied) — noted for the migration. | MEDIUM |
| J | **Editing an order can leave a multi-person commission split a penny off.** When commissions are first created, the last person's share is adjusted so the parts add up exactly to the order's profit. The *edit* path doesn't do that final adjustment, so after an edit an uneven or 3-way split can be off by a cent. | The commission rows would no longer sum to the order's profit (off by ±1¢ per edit). **Harmless today** — every current split is either one person (100%) or an even 50/50, neither of which can drift. It only bites once you set up an uneven or 3-way split *and* then edit that order. | LOW |

> Both are **latent** — they can't produce a wrong number on today's live data; they're traps that activate once partial deliveries / uneven commission splits actually happen. The fix for both is a database migration, so by your rule they wait for your OK.
