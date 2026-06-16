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
