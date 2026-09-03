## 2026-09-03 - Align invoice due dates to the Chicago posting date

Added an unapplied migration candidate for PR-comment finding #198. Invoices now record whether a
due date is `system`, `explicit`, or a preserved pre-provenance `legacy` value. Normal, group,
batch, newly transfer-created, and deleted-delivery recovery invoices recalculate system dates from the
`America/Chicago` posting date plus effective payment terms. Explicit and legacy values remain
unchanged. Unposting clears only a system date so a later post recalculates it, while
`invoice_date` still controls the accounting-period gate. Both invoice editors now read this
provenance directly: even an explicit or legacy date that happens to equal the calculated terms
date remains Custom, while only a system date is cleared for recalculation. A pre-migration row
with a non-null date is conservatively treated as legacy rather than guessed from date equality.

The backfill changes only the new provenance column: NULL dates become system dates and every
historical non-null date is conservatively marked legacy. Even an exact transfer +30 shape could
have been selected later by an operator, and historical audit rows do not record that intent, so
date equality is never treated as proof. New transfer-created rows still receive system provenance
from the column default. The backfill pins and temporarily suspends the exact
`set_invoices_updated_at` and `trg_guard_invoice_terminal_order` triggers, then restores both on
success or exception. Suspending the terminal-order guard is necessary only for valid recovery
drafts linked to a soft-deleted order after their transaction-local recovery capability has cleared;
all other guards remain active, and the trigger DDL holds an `ACCESS EXCLUSIVE` lock against
concurrent writers. No stored due date, money value, or historical `updated_at` timestamp is
rewritten. The save and
field-application billing writers now validate and record operator intent, and all private/public
function grants remain at their existing boundaries. Both the hand-maintained invoice model and
the generated Supabase Row/Insert/Update shapes include the new column. The save wrapper stages an
existing explicit/legacy-to-system change as one constraint-safe update before its historical
delegate writes the remaining invoice fields; older callers that send only a null date retain the
same system-default meaning.

Draft and unposted PDFs with system provenance now display `Set when posted` instead of a
speculative `invoice_date + terms` date. Explicit and legacy dates, plus posted system dates, remain
dated. The shared PDF builder, InvoiceDetail and field-application callers, and both current and
legacy renderers use the same rule; the current layout right-aligns the wider pending label inside
the print-safe margin. During the pre-migration rollout window, the shared builder retries only an
exact missing-`due_date_source` schema error without that one column, preserving every established
billing field; unrelated permission, network, or query failures still surface.

Expanded the focused structural regression test and four registered rollback-only smoke chains.
They cover direct and batch posting, transferred single and split invoices, per-member group terms,
non-Net-30 terms, explicit overrides, recovery posting, and system-versus-explicit unpost/repost
behavior. The five focused migration, PDF-builder, renderer, InvoiceDetail, and
FieldApplicationInvoice suites pass 141/141.
The database smokes have not been run because they create
live fixtures even though each ends in rollback, and this task explicitly forbids a live apply. The
migration remains unapplied; merging and applying it remain separate protected actions. A deliberate
mutation from the `system` branch to `explicit` made two focused assertions fail, and restoring the
implementation returned the suite to green. Two additional mutants proved the new review fixes are
load-bearing: reversing the editor provenance comparison failed both equal-date cases, and leaving
the timestamp trigger enabled failed the backfill guard test; restoring both returned the suites to
green. Further mutations proved the recovery and customer-facing guards: replacing the terminal
trigger disable with enable failed the migration suite, and changing the PDF pending rule from
`system` to `explicit` failed five renderer assertions. Changing the conservative backfill to mark
non-null dates system, changing the atomic transition predicate away from system, and disabling the
narrow PDF compatibility retry each made their focused regression tests fail. A later candidate
review caught a false
direct-call assumption in migration preflight; the
guard now verifies every adjacent executable edge in the real six-function `save_invoice` wrapper
chain. Breaking one edge made the new static assertion fail before restoration.
