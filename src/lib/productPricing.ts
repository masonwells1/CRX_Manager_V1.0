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
    const cost = Number(row.new_cost.trim());
    if (Number.isFinite(cost) && cost === 0) {
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
  cost_cents: number | null;
  tier1_margin_percent: string | null;
  tier1_margin: number | null;
  tier1_price: string | null;
  tier1_price_cents: number | null;
  tier2_margin_percent: string | null;
  tier2_margin: number | null;
  tier2_price: string | null;
  tier2_price_cents: number | null;
  tier3_margin_percent: string | null;
  tier3_margin: number | null;
  tier3_price: string | null;
  tier3_price_cents: number | null;
  tier1_price_per_acre_cents?: number | null;
  tier2_price_per_acre_cents?: number | null;
  tier3_price_per_acre_cents?: number | null;
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
  return assertRpcResult<PricingPreviewResult>(data, 'preview_product_pricing_changes');
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
  return assertRpcResult<ApplyPricingResult>(data, 'apply_product_pricing_change_set');
}
