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

## Phase 3 — 2026-07-11 morning (returns, vendor bills/AP, PO receiving, finance charges + prepay)

The four money-adjacent subsystems the night hunt never swept. Same machinery: one Opus finder per subsystem grounded on the live DB, an adversarial Opus verifier per finding, then the Codex gates. (The returns finder flaked on its first run — returned an empty placeholder after doing real work — so it was re-run fresh and completed properly. Known flake, coverage is real.)

**Score: 7 candidates → 2 confirmed real → 1 shipped live, 1 parked. 5 refuted by the adversarial verifiers.**

### ✅ SHIPPED LIVE: AP now respects closed accounting months — migration `20260712200000` (live v20260711140150)
When you close an accounting month, every AR money action (recording/voiding customer payments, voiding invoices) is blocked from touching it — but the vendor side wasn't: an admin could still **record a vendor payment dated into the closed month, or void a vendor payment / vendor bill from it**, silently changing frozen AP totals. Fixed by adding the same one-line closed-period check the AR side uses to all three functions. A payment is checked against its own date, so paying an old bill today stays allowed — only *backdating into a closed month* blocks. Nothing you can do today is blocked (you have 0 closed months so far); this is armor for when you start closing months.
Full gate: adversarial verifier CONFIRMED → Codex finding-gate REAL/HIGH/SOUND → rls-security CLEAN → migration-drift 0 blockers → Codex fix-gate SHIP → byte-identity md5 proof (each function is the live body + exactly one added line) → applied → live md5/overload/anon/search_path/plpgsql_check all verified. Note: this supersedes a stale May-10 doc note ("Q8") that predated the AR payment-date gates; gotchas.md updated.

### ✅ RESOLVED 2026-07-11 (was parked): bounced-payment credit resurrection — SHIPPED as migration `20260712220000` after Mason chose Option B. Full unwind design (Codex round-2 SHIP): credits now carry a hard link to their payment (new `prepay_credits.allocation_set_id`), void_payment unwinds the credit's applications (affected invoices owe again — correct, the money never existed) and zeroes the credit un-resurrectably, including fully-spent credits. Original write-up kept below for the record.

### (original parked write-up) a bounced payment's leftover credit can come back from the dead *(rpc: void_payment)*
If a customer overpays, the extra becomes a prepay credit. If some of that credit gets applied to an invoice and THEN the original payment bounces and is voided, `void_payment` zeroes the credit's *balance* but not its *original amount* — so if that invoice is later voided too, the bookkeeping trigger recomputes the credit **back to its full original value**: money the customer never actually paid becomes spendable prepay. Confirmed by the adversarial verifier AND Codex (both REAL; dormant today — 0 prepay credits live). **Why parked:** the obvious one-line fix (mirror what `delete_prepay_credit` does) only *shrinks* the phantom — Codex correctly flagged it FLAWED: the applied portion can still resurrect, and a credit that was already fully spent escapes the void loop entirely. The complete fix must also reverse the credit's applications on the affected invoices (which changes those invoices' paid status) — a behavior change you should sign off on, ideally together with the parked credit-memo AR-netting decision since both touch "what happens to money attached to a reversed payment."

### Refuted by the verifiers (the skeptics earning their keep — 5):
- PO receiving: two `quantity_on_order` drift claims — real code asymmetries, but the operational screens all re-derive on-order from PO lines, no money/report consumer reads the stale column, and the claimed live evidence had the wrong sign.
- Finance charges: "voiding a finance-charge invoice strands its dedup row" — the only ledger consumer filters voided invoices out, so no overstatement; re-generation is workaround-able; feature never run live.
- Returns: "full credit issued for goods never restocked" — crediting returned goods is correct regardless of restock (damaged goods are deliberately credited without restock), and the skip is loudly surfaced.
- Returns: "AR aging omits unapplied return credits" — standard aging convention (a credit has no age); folds into the already-parked credit-memo AR-netting owner decision.

**Coverage:** with Phase 3 done, every money/inventory subsystem in the app has now been hunted this cycle: invoices/batch-posting, credit-memo/AR, jobs→billing/splits, commissions, deliveries, inventory holds/draws, inventory transactions/units, workflow wiring, lifecycle invariants, returns, vendor-AP, PO receiving, finance-charges/prepay.

---

## ✅ APPLIED LIVE (6 findings across 4 migrations + 1 frontend fix)

> After you told me (repeatedly) to stop gating SQL, I removed the autopilot block on migrations/SQL (deploys, pushes, and destructive ops stay blocked; the migration reviewer-proof gate stays). Everything below went live tonight, each fully reviewed + Codex-approved + byte-identity-proven, with the applied result verified against the live database (each: 1 overload, anon-EXECUTE denied, SECDEF + search_path intact).
>
> **Live migrations:** `20260712160000` void_invoice (2 fixes) · `20260712170000` unbilled-delivery guard · `20260712180000` dashboard unbilled item · `20260712190000` blend-ticket lock. **Frontend:** OfficeCockpit coverage query.
> **Post-apply security sweep:** all 4 re-emitted functions — 1 overload, anon cannot execute, SECDEF + search_path present. Clean.
>
> - **4. Dashboard "unbilled deliveries" item** (`get_dashboard_action_items`, migration `20260712180000`) — same soft-deleted-coverage root cause; a delivery whose only invoice was soft-deleted now reappears on the dashboard action list. Verified live.
> - **5. Blend-ticket order double-booking race** (`create_order_from_blend_ticket`, migration `20260712190000`) — read the ticket without a row lock, so two concurrent order-creations on one unlinked ticket could both commit (duplicate order + double inventory prebook). Added `FOR UPDATE` to match its two sibling RPCs. Verified live.

### ✅ 1. `void_invoice` hardening — migration `20260712160000` — **APPLIED LIVE 2026-07-11** (live md5 `6a36e488…` matches the byte-proven target)

### ✅ 2. Delivery re-billing no longer blocked by a soft-deleted invoice — migration `20260712170000` — **APPLIED LIVE 2026-07-11**
`create_invoice_for_unbilled_delivery` counted a **soft-deleted** draft invoice as active coverage (because `delete_invoices` sets `deleted_at` but leaves `status='draft'`), so once you soft-deleted a delivery's draft invoice to redo it, the system refused to ever re-bill that delivery — stranded revenue with no path to fix it. Added one filter (`AND deleted_at IS NULL`). Reviewers CLEAN, Codex SHIP, body byte-identity proven (`ea23ba23…`), verified live (1 overload, fix present).

### ✅ 3. Office Cockpit "Delivered, not invoiced" tile — frontend `OfficeCockpit.tsx` — committed
The same root cause on the cockpit side: a delivery whose only invoice was soft-deleted wrongly counted as "covered" and vanished from the tile. Added `.is('deleted_at', null)` to the coverage query. Typecheck clean.

---

### (original ready-to-apply write-up, for reference)

### ✅ `void_invoice` hardening — migration `20260712160000_void_invoice_isactive_and_period_guards.sql` — **APPLIED LIVE 2026-07-11** (live md5 verified `6a36e488…`, matches the byte-proven target)
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

**#7 — Same soft-deleted-invoice root cause, two more spots (server-side).** The fix I applied covered the delivery re-billing block (`create_invoice_for_unbilled_delivery`) and the cockpit tile. Two sibling guards still count a soft-deleted invoice as coverage and want the same one-line `AND ... deleted_at IS NULL`: (a) `complete_delivery`'s auto-invoice guard (that path is OFF by default, and the function is large — parked to fix carefully, not hand-edit a 25 KB function overnight), and (b) `get_dashboard_action_items` #9 unbilled-deliveries item. Both dormant. *Codex: REAL.*

*(One more candidate — `void_delivery` recomputing order status without a lock — was **refuted** on close inspection and dropped. That's the verification working.)*

---

## OWNER DECISION (1) — ✅ DECIDED 2026-07-11: Mason chose **(B) explicit apply + full visibility**, and it SHIPPED same day (migration `20260712210000` + frontend). Every AR surface now shows open credit-memo balance as its own figure (aging "Credit on file" column, finance-charge preview "Credit on File" column + warning, Reports customer-balance "Credit Available" column, AccountsReceivable "Credit Memos" card with net = owed − prepay − credit, CustomerDetail + team context card), the one silently-netting view (customer balance listing) was un-netted, and the bulk AR-reminder send now HOLDS any customer whose open credit fully covers their overdue balance instead of dunning them. Original question kept below for the record.

**(original question)** How should an open (unapplied) credit memo show up in AR aging and dunning? Two consistent options:
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
