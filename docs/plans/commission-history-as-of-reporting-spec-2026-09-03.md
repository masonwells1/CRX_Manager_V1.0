# Commission "as of a past date" reporting — deferred build spec

**Status:** IMPLEMENTED AND APPLIED LIVE 2026-09-03 as ledger version `20260903202611`; exact reporting begins `2026-09-04` Chicago time. Source merge is pending; no live `[E2E]` fixtures were created.
**Deadline driver:** must land **before the first commission payout of the season**, which Mason
put at *"probably a few months out"* (so roughly 2026-11 → 2026-12; confirm with him, don't
assume the date).
**Owner decision on record (2026-09-03):** *"Yes I want to be able to look at historical dates."*
Mason uses this capability and wants it back — this is a deferral, **not** a decision to drop it.

The remaining sections preserve the design and acceptance record that governed the build. Current
ship state is recorded in `docs/reference/migration-history.md`.

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
- Therefore there is no payout-event history to reconstruct. The 2 `cancelled` commissions still
  demonstrate why current rows are not historical facts, and earlier changes to amount, recipient,
  order date, status, or deletion were never recorded.
- Therefore **pre-cutover earned-state history remains unrecoverable.** The correct opening is an
  observation at the real database cutover, never a backdated claim. Build this before the first
  payout and future payout history is complete from row one; wait until after payouts and that
  missing interval becomes unrecoverable too.

**Re-verify these counts before starting.** If `commission_payment_items` is no longer 0, the
cheap window has closed and the spec's scope changes (see §6).

---

## 3. What already exists — do not rebuild it

Payment headers and immutable item amounts already exist, but they are operational state—not a
complete historical ledger. The final design must record posting and voiding as signed immutable
events and must snapshot the earned liability whenever a report-relevant commission field changes.

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

Those rows provide the source facts for the cutover, but current header status and mutable
commission fields cannot by themselves reproduce a past answer.

---

## 4. The four real gaps

All four must be closed **before** the first payout or the payout-history gap becomes permanent.

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
`cancelled`. Accept the 2 existing rows as unknown — do **not** invent a date for them. Capture
them as excluded legacy states in the real cutover observation and refuse every pre-cutover date.

### Gap 3 — earned liability is mutable

`commission_amount`, recipient assignment, order date, status, and `deleted_at` can all change.
Reading the current commission row therefore rewrites earlier reports after a later correction.

**Fix:** add `commission_history_cutover` plus `commission_earned_state_ledger`. The immutable
cutover records the real database observation time and the first complete reportable Chicago day.
Opening rows are effective at that cutover, not at historical order dates; the two unrecoverable
legacy cancellations enter as excluded states. Every later insert or report-relevant update records
its actual wall-clock transition time.

### Gap 4 — payout state is mutable

Even with `posted_at` and `voided_at`, a report that rereads current payment headers/items is not
an immutable audit trail and can incorrectly discard paid cash when the earning is later cancelled
or soft-deleted.

**Fix:** add `commission_settlement_events`, an append-only signed bigint-cent ledger. Posting
creates positive events and voiding creates matching negative events with frozen recipient and
reconciliation labels. Paid totals are aggregated independently from earned totals.

---

## 5. Target behaviour

Rewrite `get_commission_balance_report(p_as_of_date date)` to answer only from the two immutable
event ledgers rather than from current status:

- **Earned as of D** — the latest earned-state event for each commission before the Chicago
  end-of-day cutoff, restricted to snapshotted `order_date <= D` and `is_earned = true`.
- **Paid as of D** — the independent sum of signed settlement events before that cutoff whose
  snapshotted `payment_date <= D`.
- **Outstanding as of D** — earned minus paid, both as computed above.
- Preserve a negative outstanding balance when paid cash survives a later cancellation/deletion;
  that is an exception signal, not a value to hide or clamp.
- Begin exact date-only reporting on the first complete Chicago day after the immutable cutover.
  The partial cutover day and all earlier dates must fail closed.
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
3. One immutable cutover record defines the real observation time and first complete reportable
   Chicago day. It and the append-only earned-state/signed-settlement ledgers have RLS, no direct
   non-owner grants, RESTRICT foreign keys where applicable, and UPDATE/DELETE/TRUNCATE refusal triggers.
4. `get_commission_balance_report` computes earned and paid independently from those ledgers;
   detail reads frozen settlement snapshots and never current commission/profile/customer labels.
5. A refusal path remains for dates the ledger genuinely cannot answer (before ledger start, or
   any future date), with a message that names the boundary date.
6. **Real-path proof, not just unit tests:** create a commission payment, post it, prove the RPC
   stamped `posted_at`/`posted_by` and appended the positive settlement event, run the report
   for a date *before* the payment and a date *after* it, and confirm the two answers differ
   correctly. Then void it and re-run both. Use `[E2E]`-tagged fixtures per the live-test-data
   policy — never real recipients.
7. Both money paths verified exact — see the money rules in `AGENTS.md`. Note `commission_amount`
   and `commission_payments.total_amount` are `numeric`, not bigint cents; this spec does **not**
   authorise a unit rewrite, only that new math stays exact.
8. New/changed migration passes the RLS + migration-drift gates and the exact-SHA adversarial
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
`commissions.paid_date`; they do not create the item rows themselves. The build reuses those
operational facts but adds the immutable cutover and event ledgers required for stable reporting,
plus dated void/cancellation evidence.

---

## 9. Cross-references

- Migration creating the refusal: `supabase/migrations/20260831162000_fail_closed_historical_commission_balance.sql` (PR #535)
- Report source of truth: live `public.get_commission_balance_report(date)`
- Frontend: `src/pages/CommissionPayments.tsx`
- Money rules: `AGENTS.md` → CRX Hard Rules
- Live-test-data policy: `docs/manual/KNOWN_ISSUES.md`
