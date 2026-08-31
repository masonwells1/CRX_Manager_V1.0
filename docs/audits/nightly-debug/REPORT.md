# CRX Nightly Debug — Running Report

**Mission started:** 2026-06-15 22:50 America/Chicago
**Branch:** `claude/priceless-austin-0d3ccd` (non-prod — nothing here is deployed)
**Safety:** 🟢 Green = auto-fixed + committed here · 🟡 Yellow = drafted + parked for your OK · 🔴 Red = never autonomous

> Read this over coffee. Everything under **Auto-fixed (Green)** is already done and verified.
> Everything under **Parked for your approval (Yellow)** is prepared, validated, and waiting —
> approve the ones you want and I'll ship them via `/ship`.

---

## ☀️ Morning summary — what happened overnight (read this first)

The mission ran **6 cycles** and completed **two full audit passes**: the **sales pipeline**
(quote→order→delivery→invoice→payment) and the **whole app** (edge functions, RLS, PDFs,
non-pipeline pages, dependencies). It surfaced **39 verified findings** and ruled out **16 false
positives**. **Nothing touched production** — every fix is either a commit on this branch or a parked
draft awaiting your OK.

### 🔴 Needs YOU first (in priority order)
1. **`PARKED-07` — `seed-admin` security (HIGH).** The `seed-admin` edge function is deployed with JWT
   verification OFF; its only real barrier is the unconfirmed `ENVIRONMENT=production` secret (your open
   M4 item). Worst case: an unauthenticated admin account could be minted. **Confirm `ENVIRONMENT` is set
   on the live project, then redeploy or delete `seed-admin`.** I did not touch it (deploy = your call).
2. **Two one-word decisions** that unblock parked fixes: **"cancel_delivery: Option A"** (the quick-delivery
   prebook leak) and your **AR-aging gross-vs-net** preference.

### 🟢 Already fixed + committed on this branch (5)
AR-aging column label · a stale CLAUDE.md fact · a misleading test comment · the BlendTicket Approve/Reject
buttons now require a completed ticket · 3 PDF footers now single-source the company legal name.

### 🟡 Parked for your approval — validated, ready to ship (7)
`PARKED-01` invoice-void **BLOCKER** · `PARKED-02` payment over-allocation · `PARKED-03` delivery prebook
(needs your Option A/B) · `PARKED-04` order-share >100% guard · `PARKED-05` delivery-item lock ·
`PARKED-06` quote partial-draw guard · `PARKED-07` seed-admin security (owner action). Each was validated
against your live DB inside a rolled-back transaction (zero footprint). Approve any and I'll ship it via
`/migration-review` + `/ship`.

### ⏭️ Queued for a careful, Codex-reviewed pass (≈11)
Real fixes that require rewriting large database functions (split-invoice rounding, quick-delivery billing,
`save_quote` idempotency, the 7-RPC error-token cleanup, etc.). I deliberately did **not** reproduce big
functions unattended at 2 AM — that's exactly the migration-drift risk this project guards against. They're
recorded with exact fix specs in [`LEDGER.json`](LEDGER.json), ready for a focused pass with you + Codex.

**How to proceed:** action the 🔴 items, reply with the two decisions, and tell me which 🟡 parked fixes to
ship. I can then run the queued large-RPC fixes one at a time with Codex cross-review.

---

## 🔧 Remediation — LIVE applies in progress (2026-06-16)

You authorized auto-apply-after-review. Applying safest-first; each fix goes through the 5-reviewer apply
gate (rls-security + migration-drift) + a rolled-back live check + post-apply invariant sweeps. **Applied
to your live database so far (5 migrations):**
- ✅ Quote partial-draw guard (adds `expired`)
- ✅ **Invoice-void BLOCKER** — voiding/correcting a fully-paid invoice no longer crashes
- ✅ Payment over-allocation guard (`ALLOCATIONS_EXCEED_PAYMENT`)
- ✅ Order bill-split 100% cap (`SECURITY DEFINER` + per-order lock)
- ✅ Grant tightening on the order-share guard (sweep stayed at its 53 baseline)

**The gate caught a regression and held a fix back:** broadening the delivery-item lock would have broken
legitimate order editing (`update_order_items` deletes cancelled/voided items without the override). Folded
into the `update_order_items` rewrite instead — this is the review gate doing exactly its job.

**Next:** the larger fixes (`cancel_delivery` Option A, the ~10 RPC rewrites), each Codex-reviewed
individually, then the frontend cleanups. **Nothing pushed to `main` or deployed — your live website is
unchanged**; only the database has these additive, reversible guards.

---

## 🔁 Codex cross-review (2026-06-16) — done, 4 fixes applied

You asked for an independent Codex pass before remediating. Codex (a different model — gpt-5.5) reviewed the whole
branch and **did not dispute the 39 findings or the core parked fixes** (PARKED-01/02/03/05/06). It found **4 real
defects in my own audit artifacts**, and I agreed with and fixed all four:
1. **The page-crawler wasn't truly read-only** — `/quotes/new` would have burned a real quote number on load. Removed
   all 7 creation-form routes from the crawl (it never ran, so no harm).
2. **PARKED-07's config example** would have kept `seed-admin` unauthenticated if copied — flipped it to require a JWT.
3. **The crawler mis-counted** a redirected (broken) page as healthy — now flagged.
4. **PARKED-04's order-share guard** had a race + permissions hole — hardened to `SECURITY DEFINER` + a per-order lock
   (re-validated against your live DB).
5. **(confirming re-review) the page-crawler still mutated prod** — Dashboard runs maintenance RPCs on mount, and every
   blocked route redirects through it — so the crawler is now **hard-gated to staging-only** (it refuses to run against
   your prod project). Net: the runtime-crawl pillar needs a staging/disposable DB to be usable; it can't run against
   your live database safely.

Full disposition: [`docs/archive/2026-summer-closeout/audits/2026-06-16-claude-disposition-of-codex-nightly-debug.md`](../../archive/2026-summer-closeout/audits/2026-06-16-claude-disposition-of-codex-nightly-debug.md).
**The 7 parked fixes are now cross-reviewed and ready** — say the word and I'll ship them one at a time through the
normal review + deploy gate.

---

## Launch readiness (cycle 0)

- ✅ Live DB (Supabase MCP) + Sentry read access confirmed.
- ✅ Worktree `.env` created (Vite vars), `npm ci` installing node_modules.
- ✅ Production Sentry is quiet (1 unresolved issue, 1 event) → the mission targets *silent/latent*
  bugs, not crashes.
- ⏸️ **Runtime crawl pending creds.** Add `E2E_TEST_EMAIL`/`E2E_TEST_PASSWORD`
  (+ optional salesrep/driver) to the worktree `.env` to enable the per-role page crawl.

---

## Cycle log

### Cycle 1 — sales pipeline deep audit (2026-06-15 ~23:30)

**Verdict:** the pipeline is *structurally* healthy (static layer 100% green — typecheck, lint,
build, and all ~2,005 unit tests pass) but carries **latent money/lifecycle landmines** that are
invisible today only because live AR is empty. The audit surfaced **30 findings**; adversarial
verification confirmed 4 and refuted 3, but **~23 verifier agents got rate-limited**, so 21 real
findings are *unverified* (not refuted) and queued for cycle 2. I re-verified the three most
dangerous by hand against the live DB.

#### 🔴 The big one — a BLOCKER (drafted + parked for your OK)
**Voiding a fully-paid invoice would crash.** The invoice status-transition guard
(`_enforce_invoice_status_transition`) has rules for every status *except* `paid` — it has no exit
from `paid`. And `void_invoice`, `void_payment`, and `reverse_write_off` all change a paid invoice's
status **without** the admin-override wrapper the other RPCs use. So the first time anyone voids a
paid invoice, voids a payment that fully paid one, or reverses a write-off — all routine accounting
corrections — the operation throws *"Invalid invoice status transition"* and AR becomes
uncorrectable for that invoice. It hasn't fired yet only because you have 0 paid invoices live.
- **Fix drafted + validated** (compiles against live, rolled back): adds the three legitimate
  `paid → {voided, posted, overdue}` transitions. Strict superset — removes nothing.
- **Parked at:** `parked-migrations/PARKED-01-invoice-paid-status-transitions.sql` — since applied live and the draft file removed in `1effc0b0`, so this path no longer exists.

#### 🟠 Two HIGHs (verified real; fixes drafted in cycle 2)
1. **`allocate_payment` can over-allocate a payment.** It checks each allocation against its own
   invoice but never checks that the *sum* of allocations ≤ the actual check amount. The only guard
   is in the React page — a non-UI caller (the **offline-sync queue**) bypasses it, which would mark
   more AR paid than cash received, silently. Fix = one server-side guard line.
2. **Quick-delivery inventory leak.** Cancelling a *scheduled* quick delivery never releases the
   inventory it pre-booked at creation, so "Net Free" stays understated forever. Fix needs careful
   inventory-model scoping (drafting in cycle 2).

#### 🟢 Auto-fixed (done + committed on this branch)
- **AR Aging column mislabel** — the column captioned "90 Days" actually held the **90–119** bucket
  (next column jumps to "120+"). Relabeled the table + CSV export to "90–119 Days". Cosmetic, no math
  change.

#### 🟡 Needs a decision from you (not auto-changed)
- **AR Aging excludes credit memos.** Aging totals only count positive balances, so an unapplied
  customer credit (a negative-balance credit memo) doesn't net against what they owe. This is a
  *system-wide* convention (gross AR), not a one-off bug. **Your call:** keep gross-AR (I'll document
  it) or net the credits in (I'll change the report). Tell me which.

#### Backlog (21 findings — real, awaiting cycle-2 verification)
The rate-limited verifiers left a real backlog (quote draw-down price locks, order-share 100% split
constraint, delivery item-lock on terminal states, split-invoice rounding, several missing-audit /
missing-idempotency paths, and a handful of green frontend cleanups). All recorded in
[`LEDGER.json`](LEDGER.json). Cycle 2 re-verifies them with direct SQL (no flaky fan-out) and
fixes/drafts the confirmed ones.

**Nothing here touched production.** Green fix = a label on this branch; everything risky is parked.

### Cycle 2 — both HIGHs drafted/parked + backlog verification (2026-06-15 ~23:35)

- 🟡 **`allocate_payment` over-allocation (HIGH) — drafted + validated + parked** as
  `PARKED-02` (`parked-migrations/PARKED-02-allocate-payment-over-allocation-guard.sql`, since
  applied live and the draft file removed in `1effc0b0`). Rather than
  risk a byte-imperfect reproduction of the 6 KB function, the fix is an **additive guard trigger**
  on `allocation_sets` that rejects `total_allocated_cents > total_payment_cents`
  (error `ALLOCATIONS_EXCEED_PAYMENT`) — and it protects *every* writer, including the offline-sync
  path that bypasses the UI. Compiles against live (rolled back); 0 existing rows violate it.
- 🟠 **`cancel_delivery` prebook leak (HIGH) — verified, parked as a one-question decision**
  ([`PARKED-03`](parked-migrations/PARKED-03-cancel-delivery-scheduled-quick-prebook-leak.md)).
  Cancelling a *scheduled quick delivery* strands its pre-booked inventory **and** leaves a zombie
  `confirmed` order. The clean fix (recommended: also cancel the auto-created order) is a small
  behavior change, so I want your nod first. **Reply "cancel_delivery: Option A"** and I'll ship the draft.
- ✅ **Verified a MEDIUM:** `save_quote`'s internal transition map advertises `expired→revised`
  (and a few `draft→…` edges) that the database's own guard trigger rejects — a real divergence, but
  it can't be reached from the UI today. Cleanup queued (trim `save_quote`'s map to match the guard).

**Parked for your approval right now:** PARKED-01 (invoice BLOCKER) · PARKED-02 (payment
over-allocation) · PARKED-03 (delivery prebook — needs your one-word decision). Cycle 3 keeps
verifying the remaining ~20 backlog findings and applies the safe Green cleanups.

### Cycle 3 — Green cleanups + verification catching an unsafe "recommended" fix (2026-06-16 ~00:05)

**Applied (Green, committed on the branch):**
- Corrected a stale `CLAUDE.md` claim that "`invoices` has zero CHECK constraints" — live has **5**
  (status, type, and three non-negativity checks). Kept the load-bearing point intact (there's no
  `order_id`-OR-`blend_ticket_id` CHECK; that rule is an RPC convention). Synced `accepted-findings.json`.
- Clarified a misleading `commissionSplit.test.ts` comment (the in-test helper is a *naive* mirror; the
  production commission RPC is penny-exact — last recipient absorbs the remainder).

**Verified real but deliberately NOT auto-applied — this is the safety model working:**
- 🛑 **`QuoteBuilder` convert-failure revert (MEDIUM):** the audit's recommended fix — route the revert
  through `revert_quote_status` — would have **broken sales-rep conversions**, because that RPC is
  **admin-only**. The bug is real (a failed conversion of a *planned* quote doesn't rebuild its inventory
  holds), but the fix needs a sales-rep-safe approach. Parked as a note, not applied. *(Good thing I read
  the function before wiring it in.)*
- **`OrderDetail` "Amount Paid" tile (LOW, latent):** it omits write-offs, so Invoiced − Paid ≠ Balance
  when an invoice has a write-off. Real but cosmetic and needs a small UX choice (relabel "Settled" vs add
  a "Written Off" tile) — deferred to you.
- **`money.ts` dual-`fmt` footgun (LOW):** real latent hazard, but the suggested 7-file rename is itself
  risky (could introduce the 100× bug it's meant to prevent). Queued as a safer ESLint-rule idea.

Backlog ~14 unverified remain; later cycles continue. Still nothing touching production.

### Cycle 4 — MEDIUM backlog verified; two more clean fixes parked (2026-06-16 ~00:35)

Verified all 5 remaining MEDIUMs against the live DB. Two had clean, low-risk fixes — **drafted,
validated, and parked**:
- 🟡 **`PARKED-04` — order bill-splits can exceed 100%.** `order_shares` only guards each row
  (0–100%); nothing caps the *sum* per order, and shares are written by a direct table insert (no
  RPC), so two racing "Add Share" clicks or a direct API write can total >100% and mis-state each
  party's share. Fix = an additive trigger that rejects an over-100% total. Validated.
- 🟡 **`PARKED-05` — items editable on cancelled/voided deliveries.** The lock trigger only fires for
  `in_progress`/`completed`, so a sales rep could add/remove line items on a *cancelled* or *voided*
  delivery via the API, corrupting history. Fix = lock items whenever the delivery isn't `scheduled`
  (the real RPCs use the admin override, so they're unaffected). Validated.

Three more MEDIUMs are **verified real but need a careful rewrite of a large function**, so I've
recorded them for a dedicated drafting pass rather than risk a botched reproduction overnight:
split-invoice penny rounding (should use the existing Hamilton helper), quick-delivery draft invoice
missing its `delivery_id` (defeats partial-quantity billing), and `save_quote`'s idempotency caching a
throwaway UUID (a retried new-quote save returns the wrong id).

**Now parked for your approval: 5 items** — PARKED-01 (invoice BLOCKER), PARKED-02 (payment
over-allocation), PARKED-03 (delivery prebook decision), PARKED-04 (order-share 100% guard),
PARKED-05 (delivery-item lock). Only 9 LOW findings left to verify. Still nothing touching production.

### Cycle 5 — final 9 LOWs verified · sales-pipeline backlog DRAINED (2026-06-16 ~01:05)

Every one of the 30 cycle-1 findings is now dispositioned. One more clean fix parked:
- 🟡 **`PARKED-06`** — the partial-draw protection guard blocked decline/cancel of a drawn booking but
  **not expire**. Unreachable today, but a latent gap; added `'expired'` for symmetry. Validated.

The other 8 LOWs: 6 are real but their fixes mean carefully rewriting a large database function
(split-invoice rounding, quick-delivery `delivery_id`, `save_quote` idempotency, order-edit stale
profit/commissions, void-order audit-type, blend/field-app invoice audit rows, the soft-delete RPC,
the 7-RPC error-token cleanup, `void_delivery` idempotency shape) — recorded with the exact fix for a
focused drafting pass so I don't ship a botched 2 AM reproduction. One (`draw_down_quote` weighted-avg
pricing) is a **documented v1 simplification**, not a defect. One (`create_prepay_credit`) is **unused
legacy** (retire-or-harden, low priority).

**Scoreboard:** 3 Green fixes applied · **6 fixes parked** for approval (PARKED-01…06) · 10 verified
fixes queued for a careful drafting pass · 2 decisions for you · 3 false positives ruled out · **0 left
unverified.** 

The first audit only covered the **sales pipeline**. Next the loop turns to the rest of the app —
other pages, the 7 edge functions, PDF generators, broad RLS, dependencies — which hasn't been
reviewed yet. Still nothing touching production.
