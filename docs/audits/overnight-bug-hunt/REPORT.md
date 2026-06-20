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

### Cycle 5 — 2026-06-19 — Phase 1: `prepay-blend` + `splits-shares-allocation` — **richest cycle (2 HIGH)**
- **Found:** 5 confirmed (0 BLOCKER / **2 HIGH** / 1 MEDIUM / 2 LOW), **4 refuted** as false positives. After dedupe: **4 new** + **1 escalated re-confirm**; **0 green** (every fix needs a migration).
- **Codex finding-gate:** ran in 2 batches; Codex independently confirmed **all 5 real**. On one of the HIGHs (the blend-ticket one) Codex rated it **HIGH** while my own checker rated it MEDIUM-because-dormant — I've kept **both opinions** for you rather than picking one.
- **Fixed (green):** 0. **Parked (yellow):** 4 new (items K–N below) + 1 escalation (item K-prepay).
- **Learning capture:** because there were 2 HIGHs, I wrote down the exact money-rules they break into `docs/reference/gotchas.md`, so whoever writes the fix can't reintroduce the bug. (Test comes with the fix.)
- **Nothing was pushed or touched live.** Everything is dormant today (the prepay & blend-ticket features have ~0 live data), so none of this is corrupting anything right now — but these are the most serious traps the hunt has found.

### Parked — added in Cycle 5 (need a migration; all dormant today, but 2 are HIGH)

| # | Plain-English issue | Why it matters | Severity |
|---|---|---|---|
| K | **Prepayments: the "apply all" / bulk buttons can let the same prepaid dollars get spent twice.** When you bulk-apply prepayments, the code lowers the customer's overall prepaid *balance* but never records *which credit paid which invoice* — so each individual credit still shows its full balance, and those same dollars can be applied again through the normal one-at-a-time button. | Real money double-spend on a shipped page. **This is the Cycle-1 item I previously rated MEDIUM — I've now raised it to HIGH** because I confirmed the buttons are live and the path is fully reachable. Latent only because no prepayments exist on live yet. | **HIGH** ⬆ |
| L | **A blend ticket split across several customers can get billed twice if one of its invoices is voided.** Voiding *one* customer's invoice flips the *whole* ticket back to "unbilled," so the system will happily generate a *second* full set of invoices for *every* customer on that ticket. | Double-billing every customer on a multi-customer blend ticket. **Codex rates this HIGH; my checker said MEDIUM (because no blend tickets exist live yet) — both noted.** Activates the first time a multi-customer ticket is billed. | **HIGH / MED** |
| M | **A fully-prepaid invoice stays marked "posted" instead of "paid."** The bulk-prepay path zeroes the invoice's balance but never advances its status, so any list/report that keys off "paid vs posted" would show it as still open. (The actual balance is correct — only the status label is wrong.) | Mislabels settled invoices as open in status-based views. Latent (no prepay-settled invoices live). | MEDIUM |
| N | **Two low-risk split/rounding items.** (1) A dead, unused "edit allocation set" function saves billing splits with no "must add up to 100%" check — best **retired** (deleted) since nothing calls it. (2) Field-application acre splitting rounds each owner's acres independently, so a 3-way split can be off by a hundredth of an acre (doesn't over/under-bill anyone — each owner is billed their own real acres — but the per-field acre totals won't tie out exactly for year-end reporting). | Both dormant; both small. The acre one folds into the field-app rework already happening on another branch. | LOW |

> **Refuted (no action) — 4 false alarms this cycle:** a prepay batch function that *looks* like it trusts a fake "who did it" value but the inner function re-checks the real user; an unused legacy prepay-credit function (already on your deferred list); an order-share percentage guard missing a lower bound (but that percentage doesn't actually feed any invoice); and a two-meanings-in-one-column allocation design that's only a risk if someone writes new code wrong (no such code exists). All logged as false positives in `LEDGER.json`.

### Cycle 6 — 2026-06-19 — Phase 1: re-checking `invoices` + `job-to-billing` (the two busiest areas) — **mostly old news**
- **Found:** 7 confirmed, 0 false alarms — but after de-duplicating, **6 of the 7 were the same issues already on your list** from Cycle 1 (the job→invoice function's known problems), each just re-discovered by two different review agents. Only **1 was new.**
- **The 1 new one (LOW):** when you turn a completed job into an invoice, the invoice's header total is taken from the *stored job total* rather than re-added from the invoice's own line items — so if that stored total were ever out of date, the header wouldn't match the lines. In practice the screen re-calculates the total on every save, so this is only reachable by a hand-crafted direct database call, and it's dormant (no jobs have been invoiced yet). Codex confirmed it's real and distinct from the related Cycle-1 item. Parked (needs a migration).
- **What this tells us:** the job→invoice function (`transfer_job_to_invoice`) is the single busiest trouble spot — it alone carries **four** of the recurring bug types (forgeable "who did it", missing audit-log row, header-not-from-lines, split shares that don't add up). I bundled all four into one plain-English fix-list in `gotchas.md` so they can be fixed together in one migration (and there's already a partial fix waiting on your other branch — they should be coordinated). 
- **Fixed (green):** 0. **Parked (yellow):** 1 new + the 3 known job→invoice items got more detail. Nothing pushed or touched live.
- **Drain status:** these two areas have now been hunted 3×; the rate of *new* findings is dropping fast (lots → 4 → 1), so one more quiet pass should let me mark them "done."

### Cycle 7 — 2026-06-19 — Phase 1: re-checking commissions + deliveries — **clean (0 new), 2 areas now "done"**
- **Found:** nothing new. The 2 issues that surfaced were both **already on your list** (the delivery auto-invoices missing an audit-log entry; the commission penny-rounding on order edits), just re-discovered.
- **One useful correction:** an issue I'd parked in Cycle 4 as a **MEDIUM** ("partial deliveries leave the invoice's cost stale → wrong month-end margin") turned out to be **overstated**. On a closer look at the actual month-end report code, the month-end totals are *recomputed from the line items* (not from the stale stored number), and only *posted* invoices count — so month-end margin is **not** affected. The only real leftover is a cosmetic cost figure on a single draft-invoice screen. **I downgraded that item from MEDIUM to LOW** to reflect the true (much smaller) impact. Net: your list is slightly *less* scary than before, not more.
- **One reassuring detail:** I confirmed the "missing audit-log row" issue is real on actual data — all 4 invoices currently in the system were created by the delivery path and none has its creation logged in the money ledger. It's still draft-stage only (the *posting* step is logged), so it stays MEDIUM, but it's now proven rather than theoretical. The fix bundles both delivery-invoice functions into one migration.
- **Fixed (green):** 0. **Parked (yellow):** 0 new (existing items enriched / one re-scoped down). Nothing pushed or touched live.
- **Drain status:** commissions + deliveries-billing are now marked **DONE** (two passes, no new issues). That's **1 of the 3 quiet cycles** needed before the whole hunt auto-stops. Several Phase-1 areas have one more confirming pass to go, then I move to the broad whole-app sweep (Phase 2).
