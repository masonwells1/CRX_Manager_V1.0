import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const schemaSql = readFileSync(
  join(repoRoot, 'supabase', 'migrations', '20260718225511_supplier_price_evidence_phase1b.sql'),
  'utf8',
);
const aliasSql = readFileSync(
  join(repoRoot, 'supabase', 'migrations', '20260718235717_stage_supplier_vendor_aliases_phase1b.sql'),
  'utf8',
);
const retiredVendorReplaySql = readFileSync(
  join(
    repoRoot,
    'supabase',
    'migrations',
    '20260721130846_replay_vendor_alias_after_vendor_retirement.sql',
  ),
  'utf8',
);
const wellsResolutionSql = readFileSync(
  join(
    repoRoot,
    'supabase',
    'migrations',
    '20260722025808_resolve_wells_legacy_vendor_history.sql',
  ),
  'utf8',
);
const phase1bSmokeSql = readFileSync(
  join(repoRoot, 'scripts', 'smoke', 'smoke-supplier-pricing-phase1b.sql'),
  'utf8',
);

const newTables = [
  'vendor_aliases',
  'legacy_vendor_resolution',
  'product_supplier_links',
  'supplier_price_imports',
  'supplier_price_import_rows',
  'supplier_price_observations',
];

const mutatingRpcs = [
  'upsert_product_supplier_link',
  'stage_supplier_price_import',
  'approve_supplier_price_import',
  'stage_vendor_alias',
  'review_vendor_alias',
  'correct_supplier_price_observation',
];

describe('live supplier pricing Phase 1b migrations', () => {
  it('replays an existing alias before re-validating mutable vendor state', () => {
    const durableLookup = retiredVendorReplaySql.indexOf(
      'WHERE receipt.idempotency_key = p_idempotency_key',
    );
    const vendorLookup = retiredVendorReplaySql.indexOf('WHERE id = p_proposed_vendor_id');

    expect(durableLookup).toBeGreaterThan(-1);
    expect(vendorLookup).toBeGreaterThan(durableLookup);
    expect(retiredVendorReplaySql).toContain("RAISE EXCEPTION 'VENDOR_NOT_FOUND'");
    expect(retiredVendorReplaySql).toContain('CREATE TABLE public.vendor_alias_stage_receipts');
    expect(retiredVendorReplaySql).toContain('ENABLE ROW LEVEL SECURITY');
    expect(retiredVendorReplaySql).toContain('vendor_alias_stage_receipts_no_direct_access');
    expect(retiredVendorReplaySql).toContain('RETURN v_durable.response');
    expect(retiredVendorReplaySql).toContain('SET search_path = public, pg_temp');
    expect(retiredVendorReplaySql).toContain('FROM PUBLIC, anon');
    expect(retiredVendorReplaySql).toContain('TO authenticated, service_role');
    expect(phase1bSmokeSql).toContain("DELETE FROM public.idempotency_keys");
    expect(phase1bSmokeSql).toContain('PERFORM public.review_vendor_alias');
    expect(phase1bSmokeSql).toContain('UPDATE public.vendors SET deleted_at = now()');
    expect(phase1bSmokeSql).toContain('reviewed, retired-vendor durable replay changed response');
  });

  it('records the evidence migration ledger reconciliation and keeps the approved alias step non-destructive', () => {
    expect(schemaSql).toContain('LIVE — Supplier Pricing Phase 1b supplier-evidence MVP');
    expect(schemaSql).toContain('20260718230000_supplier_price_evidence_phase1b');
    expect(schemaSql).toContain('live ledger version 20260718225511 under the B7 rule');
    expect(aliasSql).toContain('OWNER-APPROVED GO-LIVE DATA STEP');
    expect(aliasSql).toContain('sanctioned migration review/proof gate');
    expect(aliasSql).toContain('The Andersons');
    expect(aliasSql).toContain('Van Diest Supply');
    expect(aliasSql).not.toMatch(/DELETE\s+FROM\s+public\.vendors/i);
    expect(aliasSql).not.toMatch(/UPDATE\s+public\.vendors/i);
  });

  it('resolves Wells purchase history without rewriting purchases or Product pricing', () => {
    expect(wellsResolutionSql).toContain('SUPPLIER_VENDOR_CANONICAL_NOT_UNIQUE: Wells Ag Supply');
    expect(wellsResolutionSql).toContain('SUPPLIER_LEGACY_VENDOR_CONFLICT: Wells Ag Supply');
    expect(wellsResolutionSql).toContain('SUPPLIER_LEGACY_VENDOR_PRICE_INVARIANT_FAILED: Wells Ag Supply');
    expect(wellsResolutionSql).toContain('INSERT INTO public.legacy_vendor_resolution');
    expect(wellsResolutionSql).toContain("'Wells Ag Supply'");
    expect(wellsResolutionSql).toContain("'approved'");
    expect(wellsResolutionSql).toContain("'purchase_orders'");
    expect(wellsResolutionSql).toContain('ON CONFLICT (normalized_text) DO NOTHING');

    expect(wellsResolutionSql).not.toMatch(/UPDATE\s+public\.purchase_orders/i);
    expect(wellsResolutionSql).not.toMatch(/UPDATE\s+public\.purchase_order_items/i);
    expect(wellsResolutionSql).not.toMatch(/UPDATE\s+public\.products/i);
    expect(wellsResolutionSql).not.toMatch(/INSERT\s+INTO\s+public\.supplier_price_observations/i);
    expect(wellsResolutionSql).not.toMatch(/INSERT\s+INTO\s+public\.vendor_aliases/i);
  });

  it.each(newTables)('creates %s with RLS and a policy', (table) => {
    expect(schemaSql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}\\s*\\(`, 'i'));
    expect(schemaSql).toMatch(new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, 'i'));
    expect(schemaSql).toMatch(new RegExp(`CREATE POLICY [\\s\\S]+?ON public\\.${table}`, 'i'));
  });

  it('uses integer cents and enforces append-only observations', () => {
    expect(schemaSql).toMatch(/supplier_price_observations[\s\S]+cost_cents bigint NOT NULL/i);
    expect(schemaSql).toContain('BEFORE UPDATE OR DELETE ON public.supplier_price_observations');
    expect(schemaSql).toContain("RAISE EXCEPTION 'SUPPLIER_PRICE_OBSERVATION_IMMUTABLE'");
    expect(schemaSql).toContain('trg_supplier_price_observations_immutable');
    expect(schemaSql).toContain('You are adding %s supplier observations. You are changing ZERO sell prices.');
    expect(schemaSql).not.toMatch(/cost_cents\s+(real|double precision)/i);
  });

  it('adds the directional conversion and Gate-0 PO cost snapshots only', () => {
    expect(schemaSql).toContain('inventory_units_per_supplier_unit numeric(20,8)');
    expect(schemaSql).toContain('inventory_units_per_supplier_unit_snapshot numeric(20,8)');
    expect(schemaSql).toContain('supplier_price_observation_id uuid');
    expect(schemaSql).toContain('cost_provenance text');
    expect(schemaSql).not.toContain('CREATE TABLE IF NOT EXISTS public.product_cost_basis');
    expect(schemaSql).toContain('SUPPLIER_CONVERSION_UNIT_MUST_MATCH_INVENTORY_UNIT');
  });

  it('keeps replacement cost current and gives staged rows explicit review meaning', () => {
    expect(schemaSql).toContain('o.effective_from <= current_date');
    expect(schemaSql).toContain('correction.supersedes_observation_id = o.id');
    expect(schemaSql).toContain("row_status IN ('new', 'changed', 'cannot_compare')");
  });

  it('labels only received PO quantities as actual-purchase evidence', () => {
    expect(schemaSql).toContain('poi.quantity_received > 0');
    expect(schemaSql).toContain("'recent_po_window', 'trailing_12_months'");
    expect(schemaSql).toContain("'recent_po_weighted_average_cents'");
  });

  it('prevents an approved supplier link from rewriting historical evidence', () => {
    expect(schemaSql).toContain('SUPPLIER_LINK_WITH_HISTORY_IMMUTABLE');
    expect(schemaSql).toMatch(
      /supplier_price_observations observation[\s\S]+observation\.product_supplier_link_id = l\.id/i,
    );
  });

  it.each(mutatingRpcs)('%s is actor-guarded, idempotent, and search-path pinned', (name) => {
    const match = schemaSql.match(new RegExp(
      `CREATE OR REPLACE FUNCTION public\\.${name}\\([\\s\\S]+?\\$function\\$;`,
      'i',
    ));
    expect(match, `${name} function body`).not.toBeNull();
    const body = match![0];
    expect(body).toContain('p_idempotency_key text DEFAULT NULL');
    expect(body).toContain('p_performed_by IS DISTINCT FROM v_actor');
    expect(body).toContain('SET search_path = public, pg_temp');
    expect(body).not.toMatch(/COALESCE\s*\(\s*p_performed_by\s*,\s*auth\.uid\(\)/i);
    expect(schemaSql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}`, 'i'));
  });

  it('normalizes supplier cost by package_quantity before inventory units in both evidence RPCs', () => {
    // Acceptance criterion (2026-07-16 BUILD-HANDOFF line 61): two suppliers with
    // DIFFERENT pack sizes must produce a correct per-inventory-unit comparison.
    // A "case of 4 totes" quote (package_quantity = 4) must be divided by 4 before
    // the supplier-unit -> inventory-unit conversion, or a cheaper supplier looks ~4x dearer.
    const marketBody = schemaSql.match(
      /CREATE OR REPLACE FUNCTION public\.get_supplier_market_evidence\([\s\S]+?\$function\$;/i,
    );
    const historyBody = schemaSql.match(
      /CREATE OR REPLACE FUNCTION public\.get_product_price_history\([\s\S]+?\$function\$;/i,
    );
    expect(marketBody, 'get_supplier_market_evidence body').not.toBeNull();
    expect(historyBody, 'get_product_price_history body').not.toBeNull();

    const normalizeFormula =
      'round(o.cost_cents::numeric / o.package_quantity / l.inventory_units_per_supplier_unit)::bigint';
    expect(marketBody![0]).toContain(normalizeFormula);
    expect(historyBody![0]).toContain(normalizeFormula);

    // Guard against the regressed formula that ignored package sizing.
    expect(marketBody![0]).not.toContain(
      'round(o.cost_cents::numeric / l.inventory_units_per_supplier_unit)::bigint',
    );
    expect(historyBody![0]).not.toContain(
      'round(o.cost_cents::numeric / l.inventory_units_per_supplier_unit)::bigint',
    );
  });

  it('ranks the larger-pack supplier as cheapest once package_quantity is honored', () => {
    // Mirrors the SQL normalization: cost_cents / package_quantity / inventory_units_per_supplier_unit.
    const normalize = (costCents: number, packageQuantity: number, inventoryUnits: number) =>
      Math.round(costCents / packageQuantity / inventoryUnits);

    // Supplier A: $12.00 for a single tote (package_quantity = 1), 1 inventory unit per tote.
    const supplierA = normalize(1200, 1, 1);
    // Supplier B: $44.00 for a case of 4 totes (package_quantity = 4), 1 inventory unit per tote.
    const supplierB = normalize(4400, 4, 1);

    expect(supplierA).toBe(1200); // $12.00 / unit
    expect(supplierB).toBe(1100); // $44.00 / 4 = $11.00 / unit

    // Best (cheapest) comparable supplier is B — the bug made it look ~4x more expensive.
    const cheapest = [
      { name: 'A', normalized: supplierA },
      { name: 'B', normalized: supplierB },
    ].sort((x, y) => x.normalized - y.normalized)[0];
    expect(cheapest.name).toBe('B');

    // The pre-fix (buggy) formula ignored package_quantity and mis-ranked A as cheapest.
    const buggyB = Math.round(4400 / 1);
    expect(buggyB).toBeGreaterThan(supplierA);
  });

  it('records corrections by appending a superseding observation, never editing in place', () => {
    const body = schemaSql.match(
      /CREATE OR REPLACE FUNCTION public\.correct_supplier_price_observation\([\s\S]+?\$function\$;/i,
    );
    expect(body, 'correct_supplier_price_observation body').not.toBeNull();
    const fn = body![0];

    // Admin-only, actor-pinned, idempotent, search-path pinned (hard rules).
    expect(fn).toContain('SECURITY DEFINER');
    expect(fn).toContain('SET search_path = public, pg_temp');
    expect(fn).toContain('p_performed_by IS DISTINCT FROM v_actor');
    expect(fn).toContain('IF NOT public.is_admin() THEN RAISE EXCEPTION');
    expect(fn).toContain('IDEMPOTENCY_KEY_REQUIRED');
    expect(fn).toContain("check_idempotency(p_idempotency_key, 'correct_supplier_price_observation')");
    expect(fn).toMatch(
      /save_idempotency\(\s*p_idempotency_key,\s*'correct_supplier_price_observation'/i,
    );

    // Dollars->cents crosses ONLY the shared parser; no float path is introduced.
    expect(fn).toContain('public._parse_pricing_dollars(btrim(COALESCE(p_corrected_cost');
    expect(fn).not.toMatch(/::(?:real|double precision|float)/i);

    // Append-only: it INSERTs a superseding observation and never UPDATE/DELETEs one.
    expect(fn).toContain('supersedes_observation_id, created_by');
    expect(fn).toContain('v_original.id, v_actor');
    expect(fn).not.toMatch(/UPDATE\s+public\.supplier_price_observations/i);
    expect(fn).not.toMatch(/DELETE\s+FROM\s+public\.supplier_price_observations/i);

    // Only the current observation is correctable, so chain A<-B<-C resolves to C.
    expect(fn).toContain('SUPPLIER_OBSERVATION_ALREADY_SUPERSEDED');
    expect(fn).toContain('correction.supersedes_observation_id = v_original.id');

    // Grants: revoked from anon/PUBLIC, granted to authenticated only.
    expect(schemaSql).toContain(
      'REVOKE ALL ON FUNCTION public.correct_supplier_price_observation(uuid, text, text, uuid, text)',
    );
    expect(schemaSql).toContain(
      'GRANT EXECUTE ON FUNCTION public.correct_supplier_price_observation(uuid, text, text, uuid, text)',
    );
  });

  it('models supersession chains so a corrected quote drops out of "current" evidence', () => {
    // The read models exclude any observation that has a superseding row. Mirror
    // that resolution here: a chain A<-B<-C must surface ONLY C as current, and the
    // cheapest/replacement cost must use the corrected value, not the fat-fingered one.
    interface Observation { id: string; costCents: number; supersedes: string | null }
    const observations: Observation[] = [
      { id: 'A', costCents: 9900, supersedes: null }, // original, fat-fingered $99.00
      { id: 'B', costCents: 1250, supersedes: 'A' },  // correction to $12.50
      { id: 'C', costCents: 1100, supersedes: 'B' },  // re-correction to $11.00
    ];
    const superseded = new Set(
      observations.map((o) => o.supersedes).filter((id): id is string => id !== null),
    );
    const current = observations.filter((o) => !superseded.has(o.id));

    // Only the tail of the chain survives as current evidence.
    expect(current.map((o) => o.id)).toEqual(['C']);

    // The original ($99.00) and intermediate ($12.50) are gone from "cheapest".
    const cheapest = [...current].sort((x, y) => x.costCents - y.costCents)[0];
    expect(cheapest.id).toBe('C');
    expect(cheapest.costCents).toBe(1100);
    expect(current.some((o) => o.costCents === 9900)).toBe(false);
  });

  it('retains PDFs as private audit evidence without an extraction function', () => {
    expect(schemaSql).toContain("source_document_mime = 'application/pdf'");
    expect(schemaSql).toContain("'supplier-price-evidence'");
    expect(schemaSql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.(?:parse|extract|ocr|process)_supplier/i);
  });
});
