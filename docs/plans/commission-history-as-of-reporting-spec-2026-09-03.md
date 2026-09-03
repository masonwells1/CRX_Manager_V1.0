# Commission "as of a past date" reporting — deferred build spec

**Status:** LOCAL CANDIDATE PROVEN — not applied live, live-tested, merged, or deployed.
**Deadline driver:** must land **before the first commission payout of the season**, which Mason
put at *"probably a few months out"* (so roughly 2026-11 → 2026-12; confirm with him, don't
assume the date).
**Owner decision on record (2026-09-03):** *"Yes I want to be able to look at historical dates."*
Mason uses this capability and wants it back — this is a deferral, **not** a decision to drop it.

---

## 1. Why this is on the list

Migration `20260831162000_fail_closed_historical_commission_balance.sql` (shipping with PR #535)
makes `get_commission_balance_report(p_as_of_date)` **raise
`HISTORICAL_COMMISSION_BALANCE_UNAVAILABLE` for any date that is not Chicago-today.** It is an
equality test (`p_as_of_date IS DISTINCT FROM v_today`), so **future dates are refused too**, not
only past ones.

That migration is correct and should ship. It replaces a silently wrong answer with an honest
refusal. But it removes a capability Mason actually uses, and the refusal is a stopgap, not the
fix. **This document is the fix.**

### The underlying defect

`commissions` stores *current* payout status only — there is no dated status history. The old
report resolved an as-of date by filtering `order_date <= p_as_of_date` and then summing
**today's** `status` for each row. So a commission that was unpaid on 2026-06-01 but paid in
2026-07 reports as *already paid* in a 2026-06-01 run: the report understates what was owed on
that date, with no warning.

---

## 2. Live state as of 2026-09-03 (verified read-only, do not trust without re-checking)

This is the single most important section. **The window to do this cheaply is open because
almost nothing has happened yet.**

| Table | Rows | Detail |
|---|---|---|
| `commissions` | 35 | **33 `pending`, 2 `cancelled`, 0 `paid`** |
| `commission_payments` | 8 | **all `unposted`** |
| `commission_payment_items` | **0** | nothing has ever been linked to a payment |

Verified live 2026-09-03 against project `rhyzpcqhnizqbxphqdkr`.

Consequences:

- **No commission has ever been paid.** No `paid_date` is populated anywhere.
- Therefore the pre-migration report was *accidentally* correct for past dates, except that the
  2 `cancelled` commissions still counted toward `total_earned`. There is no meaningful history
  being lost by shipping the refusal today.
- Therefore **there is no back-history to reconstruct.** Build this before the first payout and
  the ledger is correct from row one. Build it after a season of payouts and everything before
  that point is unrecoverable — the data to reconstruct it will never have existed.

**Re-verify these counts before starting.** If `commission_payment_items` is no longer 0, the
cheap window has closed and the spec's scope changes (see §6).

---

## 3. What already exists — do not rebuild it

A dated payment ledger is **already in place and already correct in shape.** This work is far
smaller than "build commission history"; it is mostly *pointing the report at the ledger that is
already there.*

`commission_payments`
: `id`, `payment_number`, `recipient_id`, `total_amount`, `status`, `payment_method`,
  `reference_number`, **`payment_date` (date)**, `posted_by`, **`posted_at` (timestamptz)**,
  `notes`, `season`, `created_by`, `created_at`, `updated_at`.
  `status` CHECK: `unposted` | `posted` | `voided`.

`commission_payment_items`
: `id`, `commission_payment_id`, `commission_id`, `amount`, `created_at`.

RPCs already live: `create_commission_payment`, `post_commission_payment`,
`void_commission_payment`, `next_commission_payment_number`.
Frontend already live: `src/pages/CommissionPayments.tsx` (lifecycle pending → paid → cancelled;
voiding a payment resets its commissions to `pending`).

So the answer to *"was this commission paid as of date D?"* is already derivable:
a `posted` payment whose `payment_date <= D`, joined through `commission_payment_items`.

---

## 4. The two real gaps

Both are small, and both must be closed **before** the first payout or the gap becomes permanent.

### Gap 1 — voids are not dated

`commission_payments.status` can become `voided`, but there is **no `voided_at` column.** Once a
payment is voided we cannot tell *when*, so we cannot answer "was it paid as of D?" for any date
between the payment and the void. `updated_at` is not a substitute: any later update overwrites
it.

**Fix:** add `voided_at timestamptz` (and `voided_by uuid`) to `commission_payments`, set by
`void_commission_payment`. Backfill is trivial today — zero rows are voided.

### Gap 2 — commission cancellations are not dated

`commissions.status` can become `cancelled`, but there is **no `cancelled_at` column.** The 2
currently-cancelled rows have `deleted_at` NULL, so their cancellation date is already
unrecoverable. Going forward this must be stamped, or "cancelled as of D" stays unanswerable.

**Fix:** add `cancelled_at timestamptz` to `commissions`, stamped wherever status moves to
`cancelled`. Accept the 2 existing rows as unknown — do **not** invent a date for them; treat
them as cancelled-from-inception and say so in the report footnote.

---

## 5. Target behaviour

Rewrite `get_commission_balance_report(p_as_of_date date)` to answer from the dated ledger rather
than from current status:

- **Earned as of D** — commissions with `order_date <= D`, excluding any cancelled **on or
  before D** (`cancelled_at <= D`; the 2 legacy unknowns are excluded always).
- **Paid as of D** — sum of `commission_payment_items.amount` whose parent payment is `posted`,
  has `payment_date <= D`, and was **not voided on or before D** (`voided_at IS NULL OR
  voided_at > D`).
- **Outstanding as of D** — earned minus paid, both as computed above.
- Remove the `HISTORICAL_COMMISSION_BALANCE_UNAVAILABLE` raise **only once the above is proven**.
  Keep refusing dates earlier than the ledger's own start (see §7), and keep refusing future
  dates — a future as-of date has no legitimate meaning here.

Keep everything the migration got right: `require_admin()`, `SECURITY DEFINER` with
`SET search_path = public, pg_temp`, the `REVOKE ... FROM PUBLIC, anon` grant shape, and
excluding `cancelled` from earned.

---

## 6. If the cheap window has closed

If `commission_payment_items` is non-zero when this is picked up, payouts have begun. Then:

- Everything before the `voided_at` / `cancelled_at` columns exist is **not reconstructable**.
  Do not fabricate it.
- Ship the columns anyway, and have the report **refuse dates earlier than the ledger start
  date** with a message naming that date, rather than silently returning a partial answer.
- Tell Mason plainly which date range is answerable and which is gone. He would rather have a
  report that says "I can't answer before 2026-11-14" than a number that quietly lies.

---

## 7. Acceptance criteria

Done means all of these, not "the tests pass":

1. `voided_at` / `voided_by` on `commission_payments`, stamped by `void_commission_payment`.
2. `cancelled_at` on `commissions`, stamped on every path that sets `status = 'cancelled'`
   (check `cancel_order` and the order-void paths — they zero pending commissions).
3. `get_commission_balance_report` computes earned/paid/outstanding from the dated ledger.
4. A refusal path remains for dates the ledger genuinely cannot answer (before ledger start, or
   any future date), with a message that names the boundary date.
5. **Real-path proof, not just unit tests:** create a commission payment, post it, run the report
   for a date *before* the payment and a date *after* it, and confirm the two answers differ
   correctly. Then void it and re-run both. Use `[E2E]`-tagged fixtures per the live-test-data
   policy — never real recipients.
6. Both money paths verified exact — see the money rules in `AGENTS.md`. Note `commission_amount`
   and `commission_payments.total_amount` are `numeric`, not bigint cents; this spec does **not**
   authorise a unit rewrite, only that new math stays exact.
7. New/changed migration passes the RLS + migration-drift gates and the exact-SHA adversarial
   review, per the standing gates.

---

## 8. What Mason uses this for — ANSWERED 2026-09-03

Asked directly, he said:

> *"I use historical commission balance for year end, checking what I owed and reconciling payouts
> — all of it. It is very important to have this."*

**Treat this as a financial-reporting requirement, not a convenience feature.** All three uses are
accounting uses, and two of them are the kind you have to be able to defend after the fact:

1. **Year-end** — commission liability as of the fiscal close. A reported number that later
   silently changes is the worst failure mode here; year-end figures get filed and referenced.
2. **What was owed at a point in time** — outstanding liability per recipient as of any date.
3. **Reconciling payouts** — tying a specific payment back to the individual commissions it
   covered, and confirming the totals agree.

Design consequences:

- Not just a date picker. Use 3 needs **per-payment detail** — payment number, date, and the
  commission lines it settled — not only per-recipient aggregates.
- Use 1 means the report must be **stable when re-run**: the same as-of date must return the same
  answer next year. That is exactly what the current current-status implementation cannot do, and
  it is the strongest argument for the ledger-backed rewrite.
- Timing note: the first payouts land around "a few months out" (≈2026-11/12), which is roughly
  **year-end 2026**. So the first year-end that needs this is likely the first one with payouts in
  it. Do not let this slip past the first payout.

**Corrected from live source inspection 2026-09-03 — the reconciliation plumbing already works.**
`create_commission_payment` writes the immutable `commission_payment_items` snapshots. The post and
void wrappers delegate to `_post_commission_payment_intent_impl_20260809` and
`_void_commission_payment_intent_impl_20260809`, which consume those rows and maintain
`commissions.paid_date`; they do not create the item rows themselves. The build therefore remains a
reporting rewrite over data the existing lifecycle records, plus dated void/cancellation evidence.

---

## 9. Cross-references

- Migration creating the refusal: `supabase/migrations/20260831162000_fail_closed_historical_commission_balance.sql` (PR #535)
- Report source of truth: live `public.get_commission_balance_report(date)`
- Frontend: `src/pages/CommissionPayments.tsx`
- Money rules: `AGENTS.md` → CRX Hard Rules
- Live-test-data policy: `docs/manual/KNOWN_ISSUES.md`
