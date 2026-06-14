# G5 Go-Live Runbook — Sell-Side Roadmap (plain English)

**For:** Mason (owner). **Branch:** `chore/sell-side-roadmap` @ `28029bb`. **Date drafted:** 2026-06-14.

This is the *only* step left. Everything below is built, reviewed by my in-house reviewers,
cross-reviewed CLEAN by Codex (12 rounds), and pushed — but **nothing is live yet**. This
runbook is what takes it live. We do it together; you approve each live step.

---

## What's going live (in business terms)
- **Ship now, price later** — create a rush order today and set its prices later; its invoice
  can't be *posted* until it's priced.
- **Quote lifecycle** — decline / cancel / reopen quotes; quotes auto-expire on schedule.
- **Order billing cockpit** — see every invoice for an order, post all drafts, consolidate
  drafts into one; you can't double-bill an order that already has a delivery.
- **Auto-expire + two safety triggers** — Planned Programs never wrongly expire; a drawn
  booking can't be silently closed; reopening a planned booking rebuilds its inventory holds.
- **Credit warnings** — over-limit orders warn (never block).
- **Booking views (read-only)** — see a season booking's booked / drawn / remaining.

**NOT going live (shelved on purpose):** the prepay *earmark engine* (#6b) — it needs a
reserved-pool redesign (see `docs/roadmap/shelved-earmark-engine/`). Its booking views ship
read-only; their prepay columns just read 0 until that redesign lands.

---

## Before we start (must be true)
1. **A write-capable Supabase session.** The session I'm in right now is **read-only**
   (`transaction_read_only = on`), so I cannot apply migrations from it. We need a session where
   `apply_migration` works (your `crx-new-session` helper, or a session whose Supabase MCP is in
   write mode).
2. **An OPEN accounting period** — some smoke tests post invoices, which require an open period.
3. **Pre-flight (already confirmed 2026-06-14):** none of the 12 migrations are applied yet, and
   none of their new tables/columns/functions exist live — so they will apply cleanly.

---

## Step 1 — Apply the 12 migrations, IN THIS ORDER
For **each** migration I will: (a) re-run the rls-security + migration-drift reviewers (fresh
proof file), (b) apply it via Supabase `apply_migration`, (c) rename the disk file to the stamp
Supabase assigns (B7 rule), (d) run its rolled-back smoke test and confirm `SMOKE_PASS_ROLLBACK`,
(e) tell you it's done before moving to the next. **You say "go" before each apply.**

| # | Migration | What it does (plain English) |
|---|-----------|------------------------------|
| 1 | `20260613150000_planned_holds_drawn_sync` | Recovery base: planned-program inventory holds = booked − already-drawn (no double-reservation). |
| 2 | `20260613160000_auto_expire_quotes_skip_planned_and_schedule` | Auto-expire old sent/revised quotes daily, but never Planned Programs or drawn bookings. |
| 3 | `20260613170000_pricing_status_columns_and_post_gate` | Adds the "needs pricing" flags + blocks *posting* an invoice whose order isn't priced. |
| 4 | `20260613180000_create_rush_order` | The "ship now, price later" order creator (after #3). |
| 5 | `20260613190000_price_order` | Sets the prices on a rush order later + sweeps its draft invoice (after #3, #4). |
| 6 | `20260613200000_check_unpriced_orders_cron` | Daily reminder/escalation for orders still needing pricing (after #3). |
| 7 | `20260613210000_invoice_from_order_delivery_guard` | Stops order-level invoicing when the order already has a delivery (no double-billing). |
| 8 | `20260613220000_consolidate_draft_invoices` | Merge an order's draft invoices into one. |
| 9 | `20260613230000_prepay_booking_link_and_settlement` | The booking link column + read-only settlement view (prepay parts read 0 for now). |
| 10 | `20260613260000_open_booking_rollover` (after #9) | Read-only season "what's still open" report. |
| 11 | `20260613270000_quote_terminal_draw_guard` | Safety trigger: can't decline/cancel a booking that's been partially drawn. |
| 12 | `20260613290000_revert_quote_status_recreate_planned_holds` | Reopening a planned quote rebuilds its inventory holds atomically. |

> The shelved earmark-engine migrations (`240000`/`250000`/`280000`) are **NOT** in this list —
> do not apply them.

## Step 2 — Post-apply verification
- Regenerate the schema registry (`node scripts/regenerate-schema-registry.mjs` or MCP refresh).
- Run the DB invariant sweeps (`npm run db-sweeps` → execute each via MCP) — expect **zero**
  un-allowlisted rows.
- Confirm the two new cron jobs registered (auto-expire 06:05, check-unpriced 06:10).

## Step 3 — Ship to production (the final gate — you approve)
- Merge `chore/sell-side-roadmap` → `main`.
- Push `main` → Vercel auto-deploys to **croprxsolutions.app**. Confirm the deploy is READY.
- Live smoke: create a rush order → price it → post; view a booking's settlement + rollover;
  an over-limit order shows a warning but still goes through.

## If something looks wrong
- Each migration is reversible via a follow-up migration (we never edit applied ones).
- The merge to main is the point of no easy return — that's why it's last and needs your OK.
- Vercel keeps the previous deploy for one-click rollback.

---

## After go-live — the two documented follow-ups (separate efforts)
1. **#6b earmark engine reserved-pool redesign** — the shelved prepay feature, done right.
2. **`create_direct_order` PO-number bug** — a sales rep loses the PO + sees a false error on
   *direct* orders (same class as the rush-order one already fixed). Small, mirrors that fix.
