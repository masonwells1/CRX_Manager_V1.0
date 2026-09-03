export interface JobChemicalPayloadSource {
  product_id: string;
  quantity: string;
  unit: string;
  rate_per_acre: string;
  rate_unit: string;
  cost_per_unit_cents: string;
  price_per_unit_cents: string;
  diluent_rate: string;
  rei_hours: string;
  phi_days: string;
  warehouse: string;
  vendor: string;
  customer_supplied: boolean;
  /** F06: which field the operator typed ('rate' | 'qty'); undefined = unknown. */
  driver?: 'rate' | 'qty';
}

export function buildJobChemicalsPayload(rows: JobChemicalPayloadSource[]) {
  return rows.map((row, index) => {
    const parsedRatePerAcre = Number.parseFloat(row.rate_per_acre);
    return {
    product_id: row.product_id,
    quantity: parseFloat(row.quantity) || 0,
    unit: row.unit || null,
    rate_per_acre: Number.isFinite(parsedRatePerAcre) ? parsedRatePerAcre : null,
    rate_unit: row.rate_unit || null,
    cost_per_unit_cents: parseInt(row.cost_per_unit_cents) || 0,
    price_per_unit_cents: parseInt(row.price_per_unit_cents) || 0,
    diluent_rate: row.diluent_rate || null,
    rei_hours: row.rei_hours || null,
    phi_days: row.phi_days || null,
    warehouse: row.warehouse || null,
    vendor: row.vendor || null,
    customer_supplied: row.customer_supplied || false,
    sort_order: index,
    // F06 (2026-09-03): persisted to job_chemicals.driver so a RELOADED line knows which
    // side to hold when the acreage changes. Only the two values the calculator produces
    // are sent; anything else is null (unknown), which the server stores as NULL and the
    // client leaves exactly as saved. save_job refuses any other string
    // (CHEM_DRIVER_INVALID), so this narrowing is what keeps a stale tab from being refused.
    driver: row.driver === 'rate' || row.driver === 'qty' ? row.driver : null,
    };
  });
}
