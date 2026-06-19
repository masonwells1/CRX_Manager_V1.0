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

## 🔎 Cycle log

### Cycle 1 — 2026-06-19 — Phase 1 (all 7 billing subsystems) — PROOF run
- **Found:** 12 confirmed (0 BLOCKER / 0 HIGH / 5 MEDIUM / 7 LOW), 4 refuted as false positives.
- **Codex finding-gate:** confirmed the 3 acted-on findings REAL; **disagreed up** on the actor bug (MED→HIGH).
- **Fixed (green):** 1 — cancelled-commissions leak (committed `6ded5ce`, both Codex gates passed).
- **Parked (yellow):** 11 — all need a migration; documented above + in `LEDGER.json`.
- **Proven:** the full chain — hunt → Codex confirms finding → fix → Codex reviews fix → tests → commit-to-branch — works end-to-end. Nothing pushed; nothing touched live.
