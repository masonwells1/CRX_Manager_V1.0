# Workflow Waves — Morning Report (2026-07-10)

**STATUS: The whole work queue is done. Every unit either SHIPPED to production or was PARKED with a written plan. Nothing needs a decision from you to stay safe.**

**ONE NEXT STEP:** open croprxsolutions.app and click around the new navigation for 10 minutes (you'll land on "Today" now instead of the KPI dashboard). If anything feels wrong, say "roll back the nav" — it's one frontend revert, nothing in the database depends on it.

---

## What shipped tonight (all live on croprxsolutions.app)

**How it was built:** exactly as you asked — Codex 5.6 wrote ALL the code (sol for money/database, terra for screens, luna for the mechanical sweeps), and Claude only planned, reviewed, gated, and landed it. Every unit got real independent reviews (Opus for money/database, Sonnet for screens, plus a Codex read-only verdict before every risky push). The gates caught ~15 real bugs before they shipped — including two that could have re-opened an already-converted booking (double-billing risk). All fixed.

### Phone fixes (Sprint A)
- A job finished on the phone now moves to a "Done" section on My Day instead of vanishing (and the finished job's details stay readable for 7 days).
- When the office reassigns a whole job, any applicator who loses their piece now gets an "off your plate" notification.
- Crew members who are allowed to run a job now see Start/Complete on the job page, not just on My Day.

### Daily flow (U14, U15)
- "Sell & Deliver Now" one-tap phone-order flow: on the Dashboard, on every customer page, and in the search palette.
- New Order: searchable customer picker, smarter duplicate warning (only when the same product was ordered in the last 2 days — and it warns instead of blocking), a banner when the customer has an open booking, and an optional requested-delivery-date that opens the delivery form pre-filled.
- Deliveries: office can "Mark Delivered" a scheduled delivery in one step (confirm+complete together) and can set the REAL delivery date when recording it late — the invoice gets that date (posting into a closed month is still blocked, as always). The driver's phone flow lost its annoying double-confirm, the photo step folded into the review screen, and there's a "No one present — left at site" option. Lists sort today-first, and you can now filter to see cancelled/voided.

### Billing home (U16)
- The Today page (Office Cockpit) now shows chemical drafts waiting to post and completed deliveries that never got an invoice, plus a payments shortcut.
- Unbilled Applications: one-click "Create Invoice" per job with "Bill next (N left)" chaining.
- Posting rights: sales reps can now post invoices everywhere the database always allowed them to (the buttons were admin-only by mistake). Batch-post now posts each invoice individually and tells you exactly which ones failed and why. Posting a split (landlord/tenant) group is all-or-nothing — no more half-posted splits.
- Chemical invoices can be un-posted (was field-app only). "Ready to Post" filter shows drafts+unposted together. A banner warns when grower-share pricing is active. Voided commission batches have their own tab now. A draft quote has "Book as Order" (one step), and revised quotes can convert.

### Booking hygiene (U17)
- Planned bookings show what's actually held in the shed per section — with the expiry date, red when lapsed.
- "Email to Grower" is now the big green button (it actually emails; "Mark as Presented" never did — the old tooltips said the opposite). A little "Emailed <date> ✓" chip proves it went out.
- Picking a field on a quote section auto-fills its acres. The product picker has a "keep open" mode for adding many products fast. The Today page flags planned bookings whose holds are expiring or already lapsed.

### Safety nets (U18)
- Negative inventory now counts as LOW STOCK everywhere (it was invisible to all three low-stock checks before).
- The quote-expiry warnings and the auto-expire sweep now agree on which quotes count, the sweep actually notifies the rep whose quote expired, and its broken log entry is fixed.
- **New 06:20 daily check** runs the low-stock and expiring-quote alerts even if nobody opens the Dashboard. → **Worth a glance after 06:20 today: check the bell for the first run.**
- A/R aging + reminder lists now show each customer's prepay-on-file next to what they owe.

### Navigation (U19) — the biggest visible change
- You now land on **"Today"** (the cockpit) when you log in. The old KPI dashboard lives under Insights → Overview.
- The sidebar is reorganized into 9 plain-English groups (Sell & Deliver, Spray Fields, Customers & Fields, Inventory & Buying, Money, Compliance & Records, Insights, Setup & Admin) exactly per the proposals doc. Applicators and drivers get their own small menus and land on My Day / My Route.
- A green **"+ New"** button in the top bar creates anything (quote, order, delivery, job, field invoice, PO, quick receive) from any page.
- Nobody's permissions changed — every page kept its exact access rules, and the deny-list screen mirrors the new groups.

### Entry points & polish (U20)
- One "Create Order ▾" button on quotes (convert whole booking / draw part). The rarely-used manual invoice editors moved behind "⋯" menus; the misc-charge editor got a proper button (type locked). Dispatch Board's "Add New Job" is a real button now. Blend-ticket orders auto-number. 23 icon-only buttons got screen-reader labels, and 10 giant dropdowns became type-to-search pickers.

## Database changes (all additive, all reviewed, all verified live)
6 migrations applied: `v20260709203120` (A1 dispatch tail) · `v20260709204814` (A1b visibility tail) · `v20260709220435` (U15 backdate) · `v20260710001736` (U17 email-log policy) · `v20260710005441` (U18 safety nets + cron) · `v20260710010846` (U18b fixes). Each went through: Opus security + drift reviewers → rolled-back live smoke (or the documented substitute with live probes) → hash-bound apply proof → post-apply verification. Overload + search_path invariant sweeps: clean.

## Parked (needs you, or a future session — NOT applied)
1. **Dispatch backfill** (`scripts/.staging-migrations/workflow-waves-parked/PARKED-dispatch-backfill.sql`): would create dispatch rows for legacy-assigned jobs. **It affects 0 rows today** (no such jobs exist live), so there's nothing to decide right now — it's parked for the future with the count-check built in.
2. **Sprint D tech follow-ups** (plan in the ledger): logbook reports preferring the new name/license snapshots; a unit-normalization gap on the hold-reserve side (money-adjacent — wants a focused session); the two U8 leftovers. None urgent.

## Small things you should know
- Sales reps can now also batch-PRINT invoices (side effect of opening the posting toolbar to them — printing is harmless, just flagging it).
- The "Emailed ✓" chip only shows for the person who sent that email (plus admins). If you ever want the whole team to see send history, that's a one-line policy change.
- A person added to a crew AFTER a job finished can see that crew's finished-job details for up to 7 days (read-only). Harmless, but it's a policy call if you ever care.
- The U15 backdate purposely has no lower bound (backdating is the point); posting into a CLOSED month is still blocked at posting time, so finance is protected.

## Health
- Full test suite: **3,171 passed / 125 skipped / 0 failures** (grew from 3,155 at session start).
- Vercel: production READY, verified twice during the run and at wrap.
- No usage-limit or Codex-CLI failures (two builds were cut off by a 10-minute tool cap and cleanly resumed/repaired; one review verdict got truncated by my own output-trimming and was honestly re-run — lesson recorded).
- Sentry: not newly checked at wrap (nothing in the run touched error-handling paths destructively); "is prod okay?" → /spot-check-prod any time.

*Everything above is also in `docs/loops/workflow-waves-ledger.md` with per-unit PROOF lines, reviewer verdicts, and commit SHAs.*
