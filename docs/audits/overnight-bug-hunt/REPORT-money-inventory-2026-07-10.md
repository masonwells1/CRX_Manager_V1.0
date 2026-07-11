# Money + Inventory Night Hunt — Morning Report (2026-07-10 → 07-11)

**For Mason. Plain-English first; details below each item.**

## TL;DR

I ran an autonomous find → adversarially-verify → Codex-gate loop over everything that touches **money, inventory, and workflows** — the new surface built since June 20 (Layer-2 job reservations, U7 split invoicing, U8 job commissions, credit-memo apply, U16 batch posting, unit conversions, the U14–U20 workflow waves). Three hunt cycles, one Opus agent per subsystem, every finding challenged by a second Opus agent, then independently confirmed by Codex (a different AI model).

**Result: 8 real issues found, all confirmed. Zero are urgent — every one lives in a part of the system that has no live data yet** (0 posted invoices, 0 field/split invoices, empty commission batches), so **none can affect a real customer or a real dollar today.** They're the kind of latent bugs you want fixed *before* the first real billing cycle, not fires.

**What I did with them:**
- **1 fix is built, fully reviewed, and ready to apply** — a security + accounting hardening of `void_invoice`. It passed all three reviewers (RLS, drift, Codex) clean and I byte-proved it's identical to the live function except the two intended one-line guards. **I did NOT apply it live** — applying a migration to the production database is a hard gate that stays yours to approve even in a hands-free run. **It's a one-tap apply for you** (details below).
- **6 more are parked** with the exact fix written out, each needing your eyes because they change financial *behavior* (not just tighten a guard).
- **1 is a genuine business decision for you**, not a code fix (how credit memos should show up in AR aging / dunning).

Nothing was pushed to `main`. Nothing live was changed. The one built migration sits on the loop branch, committed, ready.

---

## READY TO APPLY (1) — one tap from you

### ✅ `void_invoice` hardening — migration `20260712160000_void_invoice_isactive_and_period_guards.sql`
Fixes **two** issues in the invoice-void function at once (both are strictly *adding a safety check* — they can't break anything a legitimate active admin does):

1. **A deactivated admin could still void invoices.** The void function checked "are you an admin?" but not "is your account still active?" — every other money function checks both. So an offboarded admin whose login still worked could reverse invoices (which reverses AR, restores customer prepay, cancels commissions). Fix: also require the account be active. *(Severity: medium — real access-control gap, but needs a deactivated-yet-still-logged-in admin.)*
2. **Voiding a paid/overdue invoice skipped the closed-period check.** The "you can't touch a closed accounting month" guard only ran for *posted* invoices, not *paid* or *overdue* ones — so a backdated void could land in a closed month. Fix: run the guard for posted/paid/overdue alike (matches how un-posting already works). *(Severity: low — dormant: 0 closed periods and 0 paid/overdue invoices exist today.)*

**Why it's safe:** both changes only *add* a guard. I re-emitted the whole function and mathematically proved (md5 hash match) it's byte-for-byte identical to what's live except those two lines. Reviews: RLS reviewer **CLEAN**, drift reviewer **0 blockers**, Codex **VERDICT: SHIP**.

**To apply:** say "apply the void_invoice migration" (or apply it yourself from the Supabase dashboard). The proof file is already written, so it'll go straight through.

---

## PARKED — need your eyes (6). Each has the exact fix ready; they change behavior, so they're yours to green-light.

**#1 — Credit memos don't reduce AR in finance charges / aging / dunning, but DO reduce it on the customer summary.** *(rpc: generate_finance_charges + get_ar_aging + get_ar_reminder_candidates)* A customer with a $1,000 open credit memo against a $1,000 overdue invoice shows **net $0** on their summary — but the aging report still says $1,000 outstanding, the dunning report would email them a past-due notice, and finance-charge generation would **charge interest on the full $1,000**. Two parts of the system give two different answers. **This one is really a business-policy question** (see next section) more than a bug. *Codex: REAL. Dormant (0 posted invoices).*

**#2 — A multi-owner (landlord/tenant) split-job invoice can be re-priced on just one owner, silently breaking the penny-exact split.** *(rpc: save_invoice)* When a spray job is billed to multiple owners, each owner gets their own invoice sharing the acres proportionally. The edit-lock that's supposed to force "void and reissue" for split invoices doesn't recognize these job-born group members, so an operator editing one owner's line re-prices only that owner — the members no longer sum to the job total, and that owner's commission diverges. Fix: lock any invoice that belongs to a bill-group. *Codex: REAL. Dormant (0 split invoices live).*

**#3 — Backdated delivery completion doesn't warn finance when the backdate lands in a closed month.** *(rpc: complete_delivery)* The office "mark delivered on date X" flow can set an effective/invoice date different from the scheduled date. The closed-period warning checks the *scheduled* date, not the backdated one — so a backdate into a closed month skips the warning and creates a draft invoice that can never be posted (a dead-end). Fix: base the check on the effective date. *Codex: REAL. Low (no posted row lands in the closed period; posting is still blocked separately).*

**#4 — Editing an order whose commissions are already in a payout batch doesn't block or re-sync them.** *(rpc: update_order_items)* If you create an order, batch its commissions for payout, then edit the order's price, the order's profit changes but the batched commission keeps its old amount — and posting the batch pays the stale number. The application/job side already blocks this exact situation with an error; the order side doesn't. Fix: mirror that block. *Codex: REAL. Dormant (commission batches are empty live).*

**#5 — Two people creating an order from the same blend ticket at once can double-book it.** *(rpc: create_order_from_blend_ticket)* This function reads the ticket without a row-lock, so two simultaneous sessions (different order numbers) can both create an order and both reserve inventory for one ticket — a duplicate order + double prebook. Its two sibling functions both lock the row; this one doesn't. Fix: add the same row-lock. *Codex: REAL. Needs two concurrent operators on one ticket.*

**#6 — Blend-ticket order idempotency replay returns a truncated result.** *(rpc: create_order_from_blend_ticket)* On a duplicate/retried call, the cached replay payload is missing fields the first call returned, so a caller relying on the full shape could misbehave. Fix: return the same payload shape on replay. *Confirmed by the adversarial verifier; low.*

*(One more candidate — `void_delivery` recomputing order status without a lock — was **refuted** on close inspection and dropped. That's the verification working.)*

---

## OWNER DECISION (1) — not a code fix

**How should an open (unapplied) credit memo show up in AR aging and dunning?** Two consistent options:
- **(A) Net it automatically** — subtract a customer's open credit-memo balance from their outstanding invoices before aging/dunning/finance-charges, so they're never dunned or charged interest on money already offset by a credit.
- **(B) Require credits to be explicitly applied first** (like prepay works today) — but then *surface* the open-credit balance on the AR reports (the way prepay balance already shows), so an operator doesn't dun a net-zero account.

Today it's inconsistent (netted in one place, ignored in another). Tell me which model you want and I'll make all the AR paths agree.

---

## How to read the severities
Everything is LOW/MEDIUM and **dormant** because the money subsystems are still operationally empty (the money audits have been "vacuously clean" — ~0 posted invoices/payments live). These are pre-first-billing-cycle hardening, exactly what you want caught now. When real billing starts, re-run this hunt.

## Process proof
- Find + verify: `.claude/workflows/money-inventory-hunt.js` (Opus finders, Opus adversarial verifiers).
- Independent gate: Codex (gpt-5-codex) via `scripts/overnight-codex-gate.mjs` — verdicts saved in `.claude/session-state/codex-finding-gate-*.txt`.
- The one applied-ready fix: 3 reviewers clean + Codex SHIP + md5 byte-identity proof (`52363be1fb5b307a0cdc025a1a0829b0`) + apply-guard proof written.
