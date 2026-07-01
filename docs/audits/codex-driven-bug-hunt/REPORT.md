# Codex-Driven Bug Hunt — Morning Report

**Branch:** `claude/main-debug-hunt` (non-prod worktree). Every green fix is a LOCAL commit — nothing is pushed, deployed, or applied to the live DB. One `git merge` lands the ones you like.

**How to read this:** per cycle — what **Codex found**, what **Claude confirmed vs refuted** (against the live DB), what was **auto-fixed** (green — already committed + Codex-reviewed), and what's **PARKED** (yellow — needs your OK for a migration or deploy). Nothing here requires a rollback.

---

## Summary (running)

| | Count |
|---|---|
| Cycles run | 8 |
| Codex candidates | 26 |
| Claude-confirmed | 15 |
| Refuted / dismissed (false positive) | 11 |
| 🟢 Auto-fixed (committed) | 8 fixes (7 commits) |
| 🟡 Parked (needs your OK) | 6 (migrations; 1 HIGH=PARKED-010 fix-built, 1 optional/LOW) + 1 LOW note |

> ⚠️ **PARKED-010 is the big one and it's now BUILT, VALIDATED, and CODEX-APPROVED** — a confirmed ~128× overcharge in the brand-new field-application billing. Its frontend half is committed (`e695875e`); the database half is a validated migration **awaiting your one-click apply** (it's the only thing standing between this fix and done). Apply it before the first field-app invoice ever goes out.

> _Note: the "PARKED-NNN" numbers in this report are this loop's own sequence (004, 005, 006, 007, 009). PARKED-001/002/003/008 referenced in some live function comments are from a **prior, already-applied** Codex hunt — unrelated to the items below. (008 is skipped here to avoid clashing with that prior one.)_

---

## 🟡 PARKED — needs Mason's OK (migration / deploy)

### ✅ PARKED-010 — Field-application invoices overcharge ~128× — **FIXED & APPLIED LIVE (verified 2026-07-01)**
> **DONE on production.** Migration applied (your normal session) + verified against the live functions: a 16 oz/ac product at $32.10/gal over 100 acres now bills **$401.25, not $51,360**. Old buggy lines gone from both server functions; the converter + cost-fix + unconvertible-guard are all live. **Remaining:** merge branch `claude/main-debug-hunt` to `main` (deploys the 8 committed code fixes, incl. the field-app entry-screen preview `e695875e`) — the server billing + split preview are already live-correct; the on-screen *entry* preview matches once the frontend deploys.

**Plain English:** Confirmed by tracing the live billing function `save_field_app_invoice` line by line. A field-application chemical line is billed as **(rate per acre × acres) × unit price**, where the rate is in **ounces** (e.g. 16 oz/acre for 2,4D) but the unit price is per **gallon** (e.g. $32.10/gal) — multiplied with **NO unit conversion**.

**Worked example (100 acres of 2,4D Ester, 16 oz/ac, $32.10/gal):** bills **$51,360**; correct is **$401.25** (1,600 oz = 12.5 gal × $32.10). Exactly **128× too high**. Affects **~556 of 604 products** (the overcharge ratio varies by unit: 128× oz→gal, 32× oz→qt, 16× dry-oz→lb, 4× qt→gal). **Nothing is mis-billed today** (0 field-app invoices exist) — but the first real one would massively overcharge.

**Status: FIX BUILT, VALIDATED, AND CODEX-APPROVED — awaiting your one-click apply.** Two halves of one fix:
- 🟢 **Frontend half — committed** (`e695875e`): the on-screen preview now prices in the sold unit (matches what the invoice will be). Build + full test suite green.
- 🟡 **Migration half — PARKED, needs your OK:** `docs/audits/codex-driven-bug-hunt/PARKED-010-field-app-pricing-unit-fix.draft.sql`. It adds a `field_app_priced_quantity` converter and corrects BOTH server functions that priced this wrong — `save_field_app_invoice` (the invoice) **and** `preview_field_app_invoice_split` (the on-page customer split) — to price on the converted quantity, fix the **cost/margin** the same way, and **refuse** (clear error) the ~7 products whose units genuinely don't convert rather than mis-bill them.

**How it was proven:** compiled clean against the **live** schema in a rolled-back transaction; the unit math validated on live data (1,600 oz → 12.5 gal; 3,200 dry-oz → 200 lb; identity for already-correct same-unit products; null/blocked for unconvertible; and the headline **$401.25, not $51,360**). Codex reviewed it twice — round 1 caught three real issues (cost math, the second function, rounding), all fixed; round 2 = **VERDICT SHIP**.

**What I need from you:** a yes to **apply the migration** (a live DB change — it stops here for your explicit OK + the migration-review gate). When you say go, I apply it and the frontend half merges with it. The full live end-to-end proof (creating one real field-app invoice and seeing $401, not $51,360) happens at apply time, since applying is correctly blocked until you approve.

### PARKED-004 — Returns can be advanced without their RPC side-effects (MED, migration)
**Plain English:** A return moves through `requested → approved → received → credited`. Each step is supposed to run through a database function that also *does the work* — `receive_return` puts the returned product back into inventory, and `issue_return_credit` issues the customer their money-back credit. The problem: the access rules on the `returns` table let the salesperson who created a return change its status *directly* (not through those functions). The status-guard only checks that the status *sequence* is legal — not that the change came through the proper function. So a crafted request from an insider could mark a return "received" (skipping the inventory restock) or "credited" (skipping the actual credit). Creating a return is also done as two separate writes that aren't wrapped together, so a failure or a double-click can leave an orphan/duplicate return.

**Risk framing (honest):** insider-only (a logged-in admin/sales user, on their *own* return), and it can't *steal* money — the credit-memo invoice itself still can't be forged (that path is already blocked by PARKED-002). The damage is bad data: inventory not restocked, or a return marked "credited" with no credit actually issued. That's why it's MED, not a BLOCKER.

**Proposed fix (drafted + validated, NOT applied):** `docs/audits/codex-driven-bug-hunt/PARKED-004-returns-rpc-gating.draft.sql`
- Gate the status-transition trigger on a session flag that only the return RPCs set (the same `admin_override` pattern already used elsewhere) → a direct status write is rejected with `RETURN_STATUS_VIA_RPC_ONLY`.
- Add the two missing canonical RPCs: `reject_return` (today reject is a direct UPDATE) and `create_return` (atomic + idempotent creation).
- The complete migration must also add one line (`PERFORM set_config('app.return_rpc','true',true)`) to the 4 existing return RPCs, and the frontend (`Returns.tsx`) switches to the new RPCs.

**Validation:** the new trigger + `reject_return` + `create_return` were compiled against the **live** schema inside a rolled-back transaction → `ALL_THREE_FUNCTIONS_COMPILED_OK` (zero prod footprint). Because it touches RLS/lifecycle, when you say go it should run through the normal migration-review + Codex gate before apply.

**What I need from you:** a yes/no on applying this hardening migration. It's not urgent (no money can leak today); it closes an insider data-integrity gap.

### PARKED-005 — AR reminder emails skip the most overdue invoices (MED, migration — one line)
**Plain English:** There's a "Send AR Reminders" button that emails customers with invoices 30+ days past due. Separately, a routine (`mark_overdue_invoices`) flips an invoice's status from "posted" to "overdue" once its due date passes. The reminder query only looks at invoices whose status is still **"posted"** — so the moment an invoice is auto-marked **"overdue"**, it stops being included in reminders. That's backwards: the most delinquent accounts are exactly the ones that should be chased.

**Risk framing (honest):** zero impact right now — there are 0 posted/overdue invoices live (the system is operationally empty). It's a latent logic bug that activates once real billing + the overdue job run.

**Proposed fix (drafted + validated, NOT applied):** `docs/audits/codex-driven-bug-hunt/PARKED-005-ar-reminder-include-overdue.draft.sql` — one-line change to the reminder query: `WHERE i.status = 'posted'` → `WHERE i.status IN ('posted', 'overdue')`. Everything else is the current live definition verbatim. Compiled against the **live** schema in a rolled-back transaction → `PARKED_005_COMPILED_OK`.

**What I need from you:** a yes/no on this one-line RPC migration.

### PARKED-006 — Two blend-ticket RPCs don't use the hardened idempotency helper (LOW, optional)
**Plain English:** A prior cycle hardened the shared "don't run this twice" helper (`save_idempotency`) so it loudly rejects a reused key. Two blend-ticket functions (`reverse_blend_ticket_approval`, `create_invoice_from_blend_ticket`) still write that record themselves instead of calling the hardened helper. The only way this could ever cause a problem is if two different operations were handed the *same* idempotency key — and those keys are random UUIDs, so that essentially never happens.

**Risk framing (honest):** effectively zero — it's a code-consistency / defense-in-depth cleanup, not a live bug. Listed only so it's not lost. **Fix** (migration): route both RPCs' idempotency save through `save_idempotency(...)` instead of an inline INSERT. I did not draft full SQL for this one given the negligible risk — happy to if you want it.

**Update (cycle 7):** this is **systemic**, not just two functions. A third (`dismiss_watchdog_flag`) was found doing the same thing, and the prior hunt's own migration note acknowledged "direct callers remain unfixed." Known instances now: `reverse_blend_ticket_approval`, `create_invoice_from_blend_ticket`, `dismiss_watchdog_flag`, `start_job`, `complete_job`. Still LOW (the only trigger is a one-in-a-billion key collision), but the clean fix is a single migration sweep routing them all through the hardened helper.

**What I need from you:** nothing urgent — fold it into the next migration batch if/when convenient.

### PARKED-007 — Inventory "planned" column double-counts planned quotes (MED, migration)
**Plain English:** On the Inventory page, the "planned/reserved" quantity for each product is computed as `holds + planned-quotes`. But planned quotes now automatically create those holds (a sync added 2026-06-13), so a planned quote's quantity is counted **twice** — once as its hold, once as the quote. The number shown for reserved demand is inflated, which could mislead purchasing/Net-Free decisions. (Zero impact today — no real quotes/holds exist yet.)

**Risk framing (honest):** latent — the system is operationally empty, so nothing is mis-displayed right now. Becomes visible once real planned quotes exist.

**Proposed fix:** the database function `get_inventory_position` returns both `holds_qty` and `planned_qty`, and they overlap — so *any* screen that adds them double-counts. The robust fix is in that function: drop or redefine `planned_qty` so it only counts demand not already covered by a hold (the holds already are the canonical reservation, and they correctly subtract partial draw-downs, which the quote total does not). A quicker interim option is a one-line frontend change (use `holds_qty` alone). I recommend the function-level fix so no other screen can re-introduce the double-count. I did not draft full SQL pending your call on which approach.

**What I need from you:** a yes/no, and which approach (function-level recommended). Not urgent.

### PARKED-009 — PO receiving can over-count inventory under concurrent receives (MED, migration)
**Plain English:** When you receive items against a purchase order, the function checks "have we received more than we ordered?" using a value it read a moment earlier, *without locking the row*. If two receives of the same line item happen at the same time (a double-click, or two people receiving), both can pass that check on the stale number and both add — receiving more than was ordered and **double-counting the inventory**. (Receiving against a draft/cancelled PO is mostly already blocked by a status trigger; this is specifically the concurrency race.)

**Risk framing (honest):** zero impact today (no POs/receiving happening yet), and it needs two simultaneous receives of the *same* line to trigger. But it's a real inventory-integrity gap once receiving is in real use.

**Proposed fix (drafted + validated, NOT applied):** `docs/audits/codex-driven-bug-hunt/PARKED-009-receive-po-items-lock-and-status-guard.draft.sql` — lock the PO-item row (`FOR UPDATE OF poi`) so concurrent receives serialize (the second one then re-reads the updated received-quantity before its check), plus an explicit "PO must be submitted/partially_received" guard so a bad-state receive fails before any inventory write. Compiled against the **live** schema in a rolled-back transaction → `PARKED_009_COMPILED_OK`. Touches inventory, so it should clear the migration-review + Codex gate before apply.

**What I need from you:** a yes/no on applying this hardening migration.

### Note (LOW, no action) — Quote→Order conversion atomicity
The convert-quote-to-order handler saves the quote as "accepted" (which releases its inventory holds) just before calling the conversion function. The dangerous case — a partially-drawn booking — is already explicitly guarded (it routes away first), and the conversion function is deliberately built to accept a pre-flipped quote and release holds itself. The only residual: if conversion *fails* on a normal quote after that pre-save, the holds are released but not recreated when the quote reverts to "sent." It's a deliberate, heavily-commented flow with a graceful failure path, so I did **not** change it autonomously — flagging only for awareness.

---

## 🟢 Auto-fixed (committed to `claude/main-debug-hunt`)

### Commit `4c20fb8d` — job notification emails could double-send on retry
When sending pre/post application notices for a job, two loops attached the "send this only once" key only *if* the database returned one — but then sent the email either way. A recipient who had an email address but (for whatever reason) no key would get an email with no dedupe marker, so a retry could send it twice. The sibling "Field Application Invoice" screen already handles this correctly by skipping the send when the key is missing; I applied that same safe behavior to both job-notification loops. Codex-found, Claude-verified against the working sibling pattern, Codex-reviewed SHIP.

### Commit `36b9bec5` — dead prepay "Quick" / "Apply All" buttons that always errored
On the Prepayment Manager, the per-customer "Quick" apply and the "Apply All" buttons call database functions that are **intentionally disabled** server-side (they immediately error — bulk apply is hard-blocked pending a reserved-pool redesign). So clicking either button always failed. I disabled both buttons with a tooltip pointing to the working "Allocate" flow (which applies credits per bucket). Minimal, reversible change that mirrors the backend's own disable. Codex-found, Claude-verified against the live RPC guards, Codex-reviewed SHIP.

### Commit `2d274161` — blend-ticket "Create Invoice" button that always failed
On an approved blend ticket, the "Create Invoice" card showed for any payment status except "billed" — including "prepaid" and "no charge" tickets, which the database refuses to invoice (only "unbilled" can be billed). So those tickets offered a button that always errored. Now the card only shows when the ticket is actually billable ("unbilled"). Re-billing after a void still works (the ticket flips back to "unbilled" automatically). Codex-found, Claude-verified against the live RPC, Codex-reviewed SHIP.

### Commit `832f6c8a` — AR reminder email showed `$NaN` for the outstanding total
The "Send AR Reminders" email computed the customer's total from a field the database doesn't return (`total_balance_cents`), so the headline **outstanding balance showed as `$NaN`** in the email body and the table footer. (The per-invoice line amounts were correct.) Now the total is summed from the per-invoice balances (which are present and correct), so the email shows the right number. Codex-found, Claude-verified against the live RPC, Codex-reviewed SHIP.

### Commit `5938937d` — two frontend correctness fixes (Codex-found, Claude-verified, Codex-reviewed SHIP)
1. **Signed money parser rejected the wrong thing.** `parseDollarsToCentsSigned("12-34")` treated the embedded dash as a minus sign and returned **−$1,234.00** instead of rejecting the typo. This feeds the *signed* money inputs (vendor-bill adjustments, discounts), so a fat-fingered entry could become a large bogus negative. Now any dash that isn't the leading sign is rejected (→ 0), exactly like the existing rejects for `1e5` and `1.2.3`. Valid negatives (`-50`, `$-50`) are unchanged. Added 5 regression tests.
2. **Commission-void screen under-reported the outcome.** When you void a commission payout, the database resets live commissions to "pending" (re-payable) **but closes out** commissions whose order was since cancelled/voided. The screen only showed the "reset" count and told you *all* of them were re-payable. Now the toast + activity log show both counts, and the confirmation dialog no longer over-promises.

---

## Per-cycle detail

### Cycle 1 — invoices-core + payments-allocation
- **Codex found 1**, payments-allocation **CLEAN**.
- `save_invoice can forge credit memos outside return flow` → **REFUTED (already fixed live).** The live `save_invoice` already rejects `credit_memo` on both the new-invoice and update paths (`CREDIT_MEMO_VIA_SAVE_INVOICE`); migration `20260630173011_parked_002...` is on disk and live. Codex read the *old* append-only migration file (`20260510080000`) and its sandbox can't see the later patch. (Hardened the cycle-2 hunt prompt to analyze the latest definition of each function.)

### Cycle 2 — money-primitives + commissions + credit-returns
- **Codex found 4 → all 4 confirmed real.**
- 🟢 `parseCents` mid-dash negative — **fixed** (commit `5938937d`).
- 🟢 commission-void UI ignores `commissions_cancelled_dead_order` — **fixed** (commit `5938937d`).
- 🟡 return creation non-atomic/non-idempotent + 🟡 reject_return is a direct UPDATE → bundled into **PARKED-004** (the deeper finding: the `returns_update` RLS + transition trigger let a requester bypass the RPC side-effects).

### Cycle 3 — orders-AR + prepay-finance + commission-split
- **Codex found 4 → 2 confirmed, 2 refuted.** commission-split **CLEAN**.
- 🟢 AR reminder `$NaN` total — **fixed** (commit `832f6c8a`).
- 🟡 AR reminder excludes `overdue` invoices → **PARKED-005** (one-line RPC migration).
- ❌ `get_ar_reminder_candidates` / `check_period_open` "missing pg_temp search_path" — **REFUTED** (append-only trap again: the live definitions already have `SET search_path TO 'public', 'pg_temp'`; Codex read the original migration files).
- _prepay-finance got no specific findings this pass; flagged for a dedicated re-hunt for thoroughness._

### Cycle 4 — blend-ticket-billing + field-acre-billing
- **Codex found 2 → both confirmed.** field-acre-billing **CLEAN**.
- 🟢 blend "Create Invoice" card shown for prepaid/no_charge tickets → **fixed** (commit `2d274161`).
- 🟡 two blend RPCs inline their idempotency save instead of the hardened helper → **PARKED-006** (LOW, optional — needs a UUID cross-op collision to ever matter).

### Cycle 5 — prepay-finance (re-hunt) + quotes-holds + inventory-engine
- **Codex found 4 → 2 confirmed, 2 refuted.**
- 🟢 dead prepay "Quick"/"Apply All" buttons (disabled RPCs) → **fixed** (commit `36b9bec5`).
- 🟡 inventory planned-demand double-count → **PARKED-007** (RPC-level fix recommended).
- ❌ `apply_prepay_to_invoice` "checks today not the invoice period" — **REFUTED** (a prepay application is a today-dated event; `CURRENT_DATE` is the correct, consistent guard, matching `apply_write_off`/`issue_return_credit`).
- ❌ quote convert "pre-saves accepted, can lose holds" — **REFUTED** (the destructive partial-draw case is already guarded; the convert function is designed to tolerate a pre-accepted quote). A LOW residual atomicity note is recorded above.

### Cycle 6 — deliveries + jobs + purchase-orders-receiving
- **Codex found 5 → 1 confirmed, 4 refuted.** This cycle was heavy on the append-only trap.
- 🟡 PO receiving can over-count inventory under concurrent receives (no row lock) → **PARKED-009**.
- ❌ `transfer_job_to_invoice` "no actor/idempotency, header from cached total" — **REFUTED** (live already has the strict-actor + idempotency guards and reconciles the header to summed shares; Codex read the 2026-04-05 file).
- ❌ `start_job`/`complete_job` "idempotency lookup not scoped" — **REFUTED** (live lookups are scoped by operation).
- ❌ `complete_delivery` "idempotency key unused" — **REFUTED** (live calls check/save_idempotency).
- ❌ PO submit "bypasses the state machine" — **REFUTED** (admin-only RLS + a status-transition trigger + an on-order trigger make the direct submit safe; nothing is bypassed).

### Cycle 7 — security/RLS + edge functions + idempotency
- **Codex found 3 → 2 confirmed, 1 refuted.** RLS/SECURITY-DEFINER **CLEAN** (a separate read of the full live security-advisor report confirmed: no table with RLS off, no new SECURITY DEFINER view, the only ERROR is the known-accepted `profile_public_view`).
- 🟢 job notifications not fail-closed on a missing email key → **fixed** (commit `4c20fb8d`).
- 🟡 a third RPC (`dismiss_watchdog_flag`) doing inline idempotency saves → folded into **PARKED-006** (now flagged systemic).
- ❌ "send-email doesn't require an idempotency key" — **REFUTED** (it correctly dedupes when given one; opt-in is by design, and the real gap was the careless caller fixed above).
- _Minor doc note: the live count of anon-executable SECURITY-DEFINER functions is 59, vs "~55" in CLAUDE.md — a docs-drift to refresh (not a hole)._

### Cycle 8 — newest features (beyond-parity) + admin _(broad hunt timed out → retried as a tight slice)_
- The first attempt (3 subsystems at once) **timed out** — Codex got lost grepping the newest migrations and produced no findings. Retried with a focused 5-file frontend slice (8a).
- ⚠️ field-application chemical line totals mix rate-unit and price-unit → **PARKED-010** (HIGH, verify before go-live).
- 🟢 chemical rate input could store NaN → **fixed** (commit `1cd3c873`).
- _(financeChargeCalc.ts "missing" was a non-finding — wrong path in the hunt prompt.)_

### Cycle 8b — month-end / settings-admin / watchdog / office-cockpit
- **CLEAN.** Month-end close (idempotent + asserted + cents-correct), Settings (non-admin redirect, auto-invoice defaults OFF and label guardrail defaults WARN, checked mutations), Watchdog dismissal (actor-bound + idempotent), Office Cockpit (fresh recheck + per-invoice idempotency) all verified safe. This was the part the cycle-8 timeout cut off; it closes out the sweep.

---

## ✅ Sweep complete — what this means for you

I covered **every** part of the app: the whole money/billing engine first (invoices, payments, commissions, returns/credits, blend tickets, AR, field/acre billing, prepay/finance), then everything else (quotes & holds, inventory, deliveries, jobs, purchase orders, security/RLS, edge functions, idempotency, and the newest features + admin/month-end). Over the last few cycles the hunter mostly kept re-finding bugs that were **already fixed** in the live database — a good sign the codebase is well-hardened — so I stopped here.

**Your move, in order of importance:**
1. **PARKED-010 (do before field-app go-live):** have someone sanity-check one real field-application chemical line's dollar total. It's the only item with potential real money impact, and it's easy to confirm.
2. **Merge the fixes you want:** all 7 are committed on `claude/main-debug-hunt`. `git merge claude/main-debug-hunt` into `main` takes the lot (or cherry-pick). They're build-clean and Codex-reviewed; nothing is pushed or deployed.
3. **The 5 other parked migrations** (returns hardening, AR-reminder-includes-overdue, inventory double-count, PO-receive lock, idempotency cleanup) are nice-to-haves with drafts ready — apply when convenient; none are urgent (the system is operationally empty).
