# Invoice Due Dates — Net 30 default + per-invoice override (APPROVED spec)

> **AMENDED 2026-09-03 — the terms run from the INVOICE DATE, not the posting date.** This
> spec says "posting date + 30 days" and "compute from posting timestamp" below. That wording was
> written when the two coincided (an invoice was drafted and posted the same day). Mason decided
> on 2026-09-03 (`docs/manual/DECISION_LOG.md`, 2026-09-03 entry) that when an invoice is entered
> later than its invoice date, the payment terms run from the **invoice date the customer reads**,
> which is exactly what the shipped posting RPC does (`due_date = invoice_date + terms days`,
> `20260702160000_a8_terms_to_due_date.sql`). Do NOT "correct" the code back to the posting date
> on the strength of the sentences below. The genuine timezone rule still stands: `invoice_date`
> itself must be the America/Chicago business date, which is what
> `20260903170000_invoice_date_fallbacks_chicago.sql` enforces on the server-side fallbacks.

**Status:** APPROVED by Mason 2026-07-16 (in-chat decision) — ready for a dedicated build session.
**Decision:** "Net 30 normal, but I want an option to set it to Net 15, or even immediately,
as well as an override / enter my own random time."
**Why it matters:** chemical-sale invoices currently post with no `due_date`, so the entire
late-AR machine (overdue cron, finance charges, cockpit tile) protects nothing. This was
owner-decision packet 4 in `docs/loops/owner-decisions-2026-07.md` and unblocks the parked
"A8" migration.

## Requirements (owner's words → behavior)

1. **Default: Net 30.** Posting an invoice with no explicit choice stamps
   `due_date = posting date + 30 days`.
2. **Quick options at posting/edit:** Net 30 · Net 15 · Due on receipt (due = posting date).
3. **Full override:** a custom date field — any date the owner types wins over the terms.
4. Terms/due date must be editable while an invoice is still draft, and visible on the
   invoice detail + PDF once posted.

## Design sketch (for the build session — verify against live schema first)

- `invoices.payment_terms text` CHECK in `('net30','net15','due_on_receipt','custom')`,
  default `'net30'`; `invoices.due_date date` (exists? verify — the aging machinery expects it).
- Due-date stamping happens in the **posting RPC(s)** (all posting surfaces were aligned in
  the batch-posting work — change the shared path, not one caller): if `custom`, require an
  explicit `due_date`; else compute from posting timestamp (America/Chicago business date —
  remember live DB runs UTC).
- UI: terms selector + custom date input on the posting dialog and draft invoice editor
  (InvoiceDetail + batch posting screen); show due date on invoice PDF.
- Backfill: the existing 2 posted invoices get `due_date = posted_at + 30 days` unless Mason
  says otherwise (ask at build time — it's a live-data write).
- Follow-up (same or next ticket): point the overdue cron / cockpit aging tile at `due_date`
  (the parked A8 work) so the late-AR machine turns on.

## Routing / gates (per the settled loop-driver model)

Money-domain schema + RPC change: **Codex builds** the migration + RPC re-emit,
**full migration-review gate** (RLS/drift reviewers + Codex verdict + apply-guard proof +
Mason's in-chat OK), frontend follows the store-cents/edit-dollars and assertRpcResult
patterns. One reviewable ticket; proof = post an `[E2E]` invoice with each terms option and
SELECT the stamped `due_date`.
