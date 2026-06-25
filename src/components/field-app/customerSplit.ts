/**
 * customerSplit.ts — pure helpers for the per-customer invoice SPLIT
 * (section #26: "Auto-split one job into per-customer invoices by share").
 *
 * The split itself is owned server-side: save_field_app_invoice creates ONE
 * invoice per billing customer (linked by invoice_group_id) and
 * preview_field_app_invoice_split computes each customer's amount independently
 * from their own share-acres × prices. Because every per-customer total is
 * computed and rounded on its own, the GRAND TOTAL is exactly the SUM of the
 * per-customer totals — there is no single number being divided, so no
 * remainder cent can be lost (penny-exact by construction). These helpers are
 * the client-side parity layer on top of that engine:
 *
 *   - deriveSplitRef:  ChemMan's "<jobnumber>-<NNN>" display reference that ties
 *     each split back to its source. The real invoices.invoice_number stays the
 *     globally-unique INV-YYYY-NNNN value (the sequence generator scans it); this
 *     is a DISPLAY label only, never written to the DB.
 *   - reconcileSplit:  an explicit check that the sum of the per-customer
 *     amounts (and acres) equals the whole — the safety assertion the acceptance
 *     criteria require ("no acres or dollars lost or duplicated").
 *
 * All money is bigint CENTS. Never use floats for the cent comparison.
 */

import type { PreviewFieldAppSplitResult } from '../../types';

/** How the user chose to view the customer split (parity with ChemMan's
 *  "Customer Shares By" dropdown). The underlying engine always splits by
 *  acres-weighted per-location share; this only changes how the Customers tab
 *  *presents* the split, never the dollars. */
export type CustomerSharesBasis = 'location' | 'share';

export const CUSTOMER_SHARES_BASIS_OPTIONS: { value: CustomerSharesBasis; label: string }[] = [
  { value: 'location', label: 'Locations' },
  { value: 'share', label: 'Share %' },
];

/**
 * Build the ChemMan-style split reference for a customer's invoice within a
 * group: "<base>-<NNN>" (e.g. "230568-001", "230568-002"), where <base> is the
 * source job number when the split came from a job, else the group's primary
 * invoice number, and <NNN> is the 1-based sequence position (zero-padded to 3).
 *
 * A single (non-split) invoice has no group and returns the base unchanged.
 *
 * @param base       job number (preferred) or fallback invoice number.
 * @param seqIndex   0-based position of this customer within the ordered split.
 * @param isSplit    true when this invoice is one of N (>1) in a group.
 */
export function deriveSplitRef(base: string, seqIndex: number, isSplit: boolean): string {
  const cleanBase = (base ?? '').trim();
  if (!isSplit) return cleanBase;
  const suffix = String(seqIndex + 1).padStart(3, '0');
  return cleanBase ? `${cleanBase}-${suffix}` : suffix;
}

export interface SplitReconciliation {
  /** sum of the per-customer invoice totals (cents) */
  sumCustomerCents: number;
  /** the server's grand total (cents) — must equal sumCustomerCents */
  grandTotalCents: number;
  /** sum of the per-customer share acres */
  sumCustomerAcres: number;
  /** total applied acres across all locations (from shares_detail) */
  totalAppliedAcres: number;
  /** true when BOTH dollars (exact cents) and acres (within tolerance) tie out */
  balanced: boolean;
  /** signed cent difference (sumCustomerCents − grandTotalCents); 0 when exact */
  centDifference: number;
  /** signed acre difference (sumCustomerAcres − totalAppliedAcres) */
  acreDifference: number;
}

/**
 * Reconcile a split preview: prove the per-customer amounts sum exactly to the
 * grand total (to the CENT) and the per-customer acres sum to the total applied
 * acres (within a small float tolerance — acres are numeric, not cents).
 *
 * Returns a structured result so the UI can render a green "reconciles" badge or
 * a red mismatch warning. centDifference MUST be 0 for a correct split.
 */
export function reconcileSplit(
  preview: Pick<PreviewFieldAppSplitResult, 'per_customer' | 'grand_total_cents' | 'shares_detail'>,
  acreTolerance = 0.011,
): SplitReconciliation {
  const sumCustomerCents = preview.per_customer.reduce(
    (s, c) => s + Math.round(c.total_cents),
    0,
  );
  const grandTotalCents = Math.round(preview.grand_total_cents);

  // Per-customer share acres: sum the share_acres of every share row belonging
  // to each customer (the same grain save_field_app_invoice writes to
  // invoice_shares.acres). Falls back to 0 when shares_detail is absent.
  const rows = preview.shares_detail?.rows ?? [];
  const acresByCustomer = new Map<string, number>();
  for (const r of rows) {
    acresByCustomer.set(
      r.customer_id,
      (acresByCustomer.get(r.customer_id) ?? 0) + (r.share_acres ?? 0),
    );
  }
  let sumCustomerAcres = 0;
  for (const c of preview.per_customer) {
    sumCustomerAcres += acresByCustomer.get(c.customer_id) ?? 0;
  }
  const totalAppliedAcres = preview.shares_detail?.total_applied_acres ?? 0;

  const centDifference = sumCustomerCents - grandTotalCents;
  const acreDifference = round2(sumCustomerAcres) - round2(totalAppliedAcres);

  return {
    sumCustomerCents,
    grandTotalCents,
    sumCustomerAcres: round2(sumCustomerAcres),
    totalAppliedAcres: round2(totalAppliedAcres),
    centDifference,
    acreDifference,
    balanced: centDifference === 0 && Math.abs(acreDifference) <= acreTolerance,
  };
}

/** Sum a customer's share acres from the shares_detail rows (cents-grain helper
 *  for the Customers tab "Total acres" column). */
export function customerShareAcres(
  preview: Pick<PreviewFieldAppSplitResult, 'shares_detail'>,
  customerId: string,
): number {
  const rows = preview.shares_detail?.rows ?? [];
  let acres = 0;
  for (const r of rows) {
    if (r.customer_id === customerId) acres += r.share_acres ?? 0;
  }
  return round2(acres);
}

/** Overall split percentage for a customer (from shares_detail.customers), used
 *  for the "Total Shares" column when the basis is "Share %". */
export function customerSharePct(
  preview: Pick<PreviewFieldAppSplitResult, 'shares_detail'>,
  customerId: string,
): number {
  const c = (preview.shares_detail?.customers ?? []).find((x) => x.customer_id === customerId);
  return c ? c.overall_split_pct : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
