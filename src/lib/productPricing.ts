import { assertRpcResult, supabaseUntyped } from './db';

export type PricingSource = 'pricing_worksheet' | 'product_page' | 'products_inline';
export type PricingMode = 'margin_driven' | 'price_driven';
export type PricingRowStatus = 'ready' | 'conflict' | 'invalid' | 'unchanged';
export type PricingChangeSetStatus =
  | 'previewed'
  | 'invalid'
  | 'no_changes'
  | 'applied'
  | 'expired';

const MAX_PRICING_CENTS = 9_223_372_036_854_775_807n;
const PRICING_DOLLAR_INPUT = /^([0-9]+)(?:\.([0-9]{1,2}))?$/;

/**
 * Convert a browser-entered dollar string to cents without passing through a
 * JavaScript Number. Null means the value is not accepted by the database
 * pricing boundary (including values outside PostgreSQL bigint cents).
 */
export function pricingDollarInputToCents(value: string): bigint | null {
  const match = PRICING_DOLLAR_INPUT.exec(value.trim());
  if (!match) return null;
  const wholeDollars = match[1].replace(/^0+(?=\d)/, '');
  if (wholeDollars.length > 17) return null;
  const cents = (BigInt(wholeDollars) * 100n) + BigInt((match[2] ?? '').padEnd(2, '0') || '0');
  return cents <= MAX_PRICING_CENTS ? cents : null;
}

export function formatPricingMarginPercent(value: number): string {
  if (!Number.isFinite(value)) throw new Error('Pricing margin must be a finite number.');
  return (value * 100).toFixed(8).replace(/\.?0+$/, '');
}

export function assertPricingPreviewRowsSafe(
  rows: ReadonlyArray<{
    pricing_mode: PricingMode | '';
    new_cost: string;
    product_name?: string;
  }>,
): void {
  for (const row of rows) {
    if (row.pricing_mode !== 'margin_driven') continue;
    const costCents = pricingDollarInputToCents(row.new_cost);
    const submittedZero = costCents === 0n
      || /^[+-]?0+(?:\.0+)?(?:e[+-]?\d+)?$/i.test(row.new_cost.trim());
    if (submittedZero) {
      const productName = row.product_name?.trim() || 'this Product';
      throw new Error(
        `Margin-driven pricing requires a cost greater than $0 for ${productName}. No prices were changed.`,
      );
    }
  }
}

export interface PricingWorkbookExportRow {
  product_id: string;
  sku: string | null;
  product_name: string;
  category: string | null;
  container_size: string | null;
  unit_size: string | null;
  inventory_unit: string | null;
  identity_fingerprint: string;
  row_token: string;
  row_version: number;
  current_cost: string | null;
  current_tier1_margin_percent: string | null;
  current_tier1_price: string | null;
  current_tier2_margin_percent: string | null;
  current_tier2_price: string | null;
  current_tier3_margin_percent: string | null;
  current_tier3_price: string | null;
}

export interface PricingWorkbookExport {
  export_id: string;
  manifest_fingerprint: string;
  expires_at: string;
  rows: PricingWorkbookExportRow[];
}

export interface PricingPreviewInputRow {
  product_id: string;
  product_name?: string;
  sku?: string;
  row_version: number | string;
  pricing_mode: PricingMode;
  new_cost: string;
  tier1_margin_percent?: string;
  tier1_price?: string;
  tier2_margin_percent?: string;
  tier2_price?: string;
  tier3_margin_percent?: string;
  tier3_price?: string;
  change_reason?: string;
}

export interface PricingSnapshot {
  cost: string | null;
  cost_cents: bigint | null;
  tier1_margin_percent: string | null;
  tier1_margin: number | null;
  tier1_price: string | null;
  tier1_price_cents: bigint | null;
  tier2_margin_percent: string | null;
  tier2_margin: number | null;
  tier2_price: string | null;
  tier2_price_cents: bigint | null;
  tier3_margin_percent: string | null;
  tier3_margin: number | null;
  tier3_price: string | null;
  tier3_price_cents: bigint | null;
  tier1_price_per_acre_cents?: bigint | null;
  tier2_price_per_acre_cents?: bigint | null;
  tier3_price_per_acre_cents?: bigint | null;
}

export interface PricingWorksheetPreviewRow {
  product_id: string;
  sku: string;
  product_name: string;
  category: string;
  container_size: string;
  unit_size: string;
  inventory_unit: string;
  identity_fingerprint: string;
  row_token: string;
  row_version: string;
  current_cost: string;
  current_tier1_margin_percent: string;
  current_tier1_price: string;
  current_tier2_margin_percent: string;
  current_tier2_price: string;
  current_tier3_margin_percent: string;
  current_tier3_price: string;
  pricing_mode: PricingMode | '';
  new_cost: string;
  tier1_margin_percent: string;
  tier1_price: string;
  tier2_margin_percent: string;
  tier2_price: string;
  tier3_margin_percent: string;
  tier3_price: string;
  change_reason: string;
  has_formula: boolean;
  formula_cells: string[];
}

export interface PricingEffect extends PricingSnapshot {
  product_id: string;
  product_name?: string;
  sku?: string;
  before?: PricingSnapshot;
  pricing_mode?: PricingMode;
  tier1_gross_margin?: number | null;
  tier2_gross_margin?: number | null;
  tier3_gross_margin?: number | null;
}

export interface PricingPreviewRow {
  sequence: number;
  product_id: string | null;
  submitted_row: Record<string, unknown>;
  row_status: PricingRowStatus;
  error_code: string | null;
  effect: PricingEffect | null;
}

export interface PricingPreviewResult {
  change_set_id: string;
  request_fingerprint: string;
  source: PricingSource;
  status: PricingChangeSetStatus;
  expires_at: string;
  submitted_row_count: number;
  ready_count: number;
  unchanged_count: number;
  conflict_count: number;
  invalid_count: number;
  apply_allowed: boolean;
  rows: PricingPreviewRow[];
}

export interface AppliedPricingRow extends PricingEffect {
  pricing_version: number;
}

export interface ApplyPricingResult {
  change_set_id: string;
  status: 'applied';
  applied_count: number;
  rows: AppliedPricingRow[];
}

export interface CreatePricingWorkbookExportInput {
  productIds?: string[] | null;
  performedBy: string;
  idempotencyKey: string;
}

interface PricingPreviewInputBase {
  performedBy: string;
  idempotencyKey: string;
}

export type PreviewPricingChangesInput =
  | (PricingPreviewInputBase & {
      source: 'pricing_worksheet';
      exportId: string;
      rows: PricingWorksheetPreviewRow[];
    })
  | (PricingPreviewInputBase & {
      source: 'product_page' | 'products_inline';
      exportId?: never;
      rows: PricingPreviewInputRow[];
    });

export interface ApplyPricingChangeSetInput {
  changeSetId: string;
  requestFingerprint: string;
  performedBy: string;
  idempotencyKey: string;
}

type PricingCentsField =
  | 'cost_cents'
  | 'tier1_price_cents'
  | 'tier2_price_cents'
  | 'tier3_price_cents'
  | 'tier1_price_per_acre_cents'
  | 'tier2_price_per_acre_cents'
  | 'tier3_price_per_acre_cents';

type PricingSnapshotWire = Omit<PricingSnapshot, PricingCentsField> & {
  cost_cents: unknown;
  tier1_price_cents: unknown;
  tier2_price_cents: unknown;
  tier3_price_cents: unknown;
  tier1_price_per_acre_cents?: unknown;
  tier2_price_per_acre_cents?: unknown;
  tier3_price_per_acre_cents?: unknown;
};

type PricingEffectWire = PricingSnapshotWire
  & Omit<PricingEffect, keyof PricingSnapshot | 'before'>
  & { before?: PricingSnapshotWire };

type PricingPreviewResultWire = Omit<PricingPreviewResult, 'rows'> & {
  rows: Array<Omit<PricingPreviewRow, 'effect'> & { effect: PricingEffectWire | null }>;
};

type ApplyPricingResultWire = Omit<ApplyPricingResult, 'rows'> & {
  rows: Array<PricingEffectWire & Pick<AppliedPricingRow, 'pricing_version'>>;
};

function exactDollarCents(value: string | null, field: string): bigint | null {
  if (value === null) return null;
  const cents = pricingDollarInputToCents(value);
  if (cents === null) throw new Error(`Pricing RPC returned an invalid ${field} value.`);
  return cents;
}

function exactIntegerCents(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`Pricing RPC returned an unsafe ${field} value.`);
}

function normalizePricingSnapshot(snapshot: PricingSnapshotWire): PricingSnapshot {
  return {
    ...snapshot,
    cost_cents: exactDollarCents(snapshot.cost, 'cost'),
    tier1_price_cents: exactDollarCents(snapshot.tier1_price, 'tier 1 price'),
    tier2_price_cents: exactDollarCents(snapshot.tier2_price, 'tier 2 price'),
    tier3_price_cents: exactDollarCents(snapshot.tier3_price, 'tier 3 price'),
    tier1_price_per_acre_cents: exactIntegerCents(
      snapshot.tier1_price_per_acre_cents,
      'tier 1 per-acre cents',
    ),
    tier2_price_per_acre_cents: exactIntegerCents(
      snapshot.tier2_price_per_acre_cents,
      'tier 2 per-acre cents',
    ),
    tier3_price_per_acre_cents: exactIntegerCents(
      snapshot.tier3_price_per_acre_cents,
      'tier 3 per-acre cents',
    ),
  };
}

function normalizePricingEffect(effect: PricingEffectWire): PricingEffect {
  return {
    ...effect,
    ...normalizePricingSnapshot(effect),
    before: effect.before ? normalizePricingSnapshot(effect.before) : undefined,
  } as PricingEffect;
}

function normalizePricingPreviewResult(result: PricingPreviewResultWire): PricingPreviewResult {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      effect: row.effect ? normalizePricingEffect(row.effect) : null,
    })),
  };
}

function normalizeApplyPricingResult(result: ApplyPricingResultWire): ApplyPricingResult {
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...normalizePricingEffect(row),
      pricing_version: row.pricing_version,
    })),
  };
}

export async function createPricingWorkbookExport(
  input: CreatePricingWorkbookExportInput,
): Promise<PricingWorkbookExport> {
  const { data, error } = await supabaseUntyped.rpc('create_pricing_workbook_export', {
    p_product_ids: input.productIds ?? null,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<PricingWorkbookExport>(data, 'create_pricing_workbook_export');
}

export async function previewProductPricingChanges(
  input: PreviewPricingChangesInput,
): Promise<PricingPreviewResult> {
  // Defense in depth for the staged rollout: the live bootstrap intentionally
  // preserves legacy compatibility, so block the one input that could compute
  // zero sell prices before any frontend path reaches the RPC. The separately
  // parked database guard enforces the same rule server-side before deployment.
  assertPricingPreviewRowsSafe(input.rows);
  const { data, error } = await supabaseUntyped.rpc('preview_product_pricing_changes', {
    p_source: input.source,
    p_export_id: input.source === 'pricing_worksheet' ? input.exportId : null,
    p_rows: input.rows,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<PricingPreviewResultWire>(data, 'preview_product_pricing_changes');
  return normalizePricingPreviewResult(result);
}

export async function applyProductPricingChangeSet(
  input: ApplyPricingChangeSetInput,
): Promise<ApplyPricingResult> {
  const { data, error } = await supabaseUntyped.rpc('apply_product_pricing_change_set', {
    p_change_set_id: input.changeSetId,
    p_request_fingerprint: input.requestFingerprint,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<ApplyPricingResultWire>(data, 'apply_product_pricing_change_set');
  return normalizeApplyPricingResult(result);
}
