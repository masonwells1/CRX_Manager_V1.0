/**
 * Canonical money formatting helpers.
 *
 * The codebase historically had 15+ inline `Intl.NumberFormat(...)` definitions
 * for currency display, some operating on integer CENTS (dividing by 100) and
 * some on DOLLARS (no divide). That divergence is the source of double-divide /
 * no-divide bugs in invoices, exports, and PDFs (foundation audit P2-B).
 *
 * Use these two helpers for all USD display going forward:
 *   - formatCents(cents)   — value is stored as integer cents (the project standard)
 *   - formatDollars(dollars) — value is already a dollar-denominated number
 *
 * Both render "$1,234.56" (USD, 2 fraction digits). Pick by what the source
 * value actually IS, not by what reads nicer — picking wrong is a 100x error.
 *
 * TODO (follow-up sweep — NOT done in this pass, audit P2-B is incremental):
 *   Migrate remaining inline formatters to these helpers, including:
 *     - src/pages/Reports.tsx (whole-dollar variant, maximumFractionDigits: 0)
 *     - src/lib/reportPdf.ts (dollar formatter used in PDF generation)
 *     - the ~50 other currency-formatter sites Codex counted across pages/components
 *   Migrated in this pass: QuoteBuilder, InvoiceDetail, ARaging.
 */

const USD = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

/** Format integer cents as USD with 2 decimals. e.g. 12345 → "$123.45" */
export function formatCents(cents: number): string {
  return USD.format(cents / 100);
}

/**
 * Format a dollar-denominated number as USD with 2 decimals. e.g. 123.45 → "$123.45".
 * Use only when the value is ALREADY in dollars (e.g. quote math, `commissions.commission_amount`).
 * For integer-cents values use formatCents().
 */
export function formatDollars(dollars: number): string {
  return USD.format(dollars);
}
