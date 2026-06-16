# CRX Nightly Debug — Running Report

**Mission started:** 2026-06-15 22:50 America/Chicago
**Branch:** `claude/priceless-austin-0d3ccd` (non-prod — nothing here is deployed)
**Safety:** 🟢 Green = auto-fixed + committed here · 🟡 Yellow = drafted + parked for your OK · 🔴 Red = never autonomous

> Read this over coffee. Everything under **Auto-fixed (Green)** is already done and verified.
> Everything under **Parked for your approval (Yellow)** is prepared, validated, and waiting —
> approve the ones you want and I'll ship them via `/ship`.

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
- **Parked at:** [`parked-migrations/PARKED-01-invoice-paid-status-transitions.sql`](parked-migrations/PARKED-01-invoice-paid-status-transitions.sql) — approve and I'll ship it through `/migration-review` + `/ship`.

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
  [`PARKED-02`](parked-migrations/PARKED-02-allocate-payment-over-allocation-guard.sql). Rather than
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
