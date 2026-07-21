import { assertRpcResult, supabase, supabaseUntyped } from './db';
import type {
  SupplierComparisonStatus,
  SupplierPriceImportMethod,
  SupplierPriceImportRowStatus,
  SupplierPriceKind,
  SupplierReviewStatus,
} from '../types';

const SUPPLIER_EVIDENCE_BUCKET = 'supplier-price-evidence';

export interface SupplierVendorOption {
  id: string;
  name: string;
}

export interface SupplierProductOption {
  id: string;
  product_name: string;
  sku: string | null;
  inventory_unit: string | null;
}

export interface SupplierWorkspaceLink {
  id: string;
  product_id: string;
  product_name: string;
  vendor_id: string;
  vendor_name: string;
  supplier_sku: string | null;
  supplier_product_name: string;
  supplier_uom: string | null;
  supplier_pack_description: string | null;
  inventory_units_per_supplier_unit: number | null;
  conversion_unit: string | null;
  comparison_status: SupplierComparisonStatus;
  comparison_note: string | null;
  link_status: 'pending' | 'confirmed' | 'rejected';
  is_reusable: boolean;
  is_preferred: boolean;
  is_active: boolean;
}

export interface SupplierWorkspaceImport {
  id: string;
  vendor_id: string;
  vendor_name: string;
  document_date: string;
  ingestion_method: SupplierPriceImportMethod;
  status: 'draft' | 'needs_review' | 'approved' | 'rejected' | 'partially_approved';
  row_count: number;
  eligible_row_count: number;
  approved_observation_count: number;
  source_document_name: string | null;
  created_at: string;
}

export interface SupplierWorkspaceAlias {
  id: string;
  vendor_id: string | null;
  proposed_vendor_id: string | null;
  alias_raw: string;
  alias_normalized: string;
  alias_display: string;
  source: 'legacy_product' | 'legacy_po' | 'import' | 'manual';
  review_status: SupplierReviewStatus;
  review_note: string | null;
  created_at: string;
}

export interface SupplierEvidenceDetail {
  vendor_id: string;
  vendor_name: string;
  product_supplier_link_id: string;
  quoted_package_cost_cents: bigint;
  normalized_cost_cents: bigint | null;
  effective_from: string;
  comparison_status: 'comparable' | 'cannot_compare';
  is_best_comparable: boolean;
}

export interface SupplierMarketEvidence {
  product_id: string;
  supplier_quote_count: number;
  comparable_quote_count: number;
  replacement_cost_cents: bigint | null;
  replacement_cost_as_of: string | null;
  best_supplier: string | null;
  last_paid_cents: bigint | null;
  last_paid_as_of: string | null;
  recent_po_weighted_average_cents: bigint | null;
  recent_po_window: 'trailing_12_months';
  comparison_status: 'no_evidence' | 'cannot_compare' | 'comparable';
  suppliers: SupplierEvidenceDetail[];
}

export interface SupplierPricingWorkspace {
  vendors: SupplierVendorOption[];
  products: SupplierProductOption[];
  links: SupplierWorkspaceLink[];
  imports: SupplierWorkspaceImport[];
  aliases: SupplierWorkspaceAlias[];
  evidence: SupplierMarketEvidence[];
}

export interface SupplierQuoteSheetRow {
  product_supplier_link_id: string;
  product_id: string;
  vendor_id: string;
  supplier_sku: string | null;
  product_name: string;
  supplier_product_name: string;
  supplier_uom: string | null;
  supplier_pack_description: string | null;
  inventory_unit: string | null;
  inventory_units_per_supplier_unit: number | null;
  comparison_status: SupplierComparisonStatus;
  last_cost: string | null;
  last_effective_date: string | null;
  new_cost: string;
  effective_date: string;
  price_kind: SupplierPriceKind;
}

export interface SupplierQuoteSheet {
  format_version: string;
  vendor_id: string;
  vendor_name: string;
  generated_at: string;
  rows: SupplierQuoteSheetRow[];
}

export interface SupplierImportInputRow {
  product_supplier_link_id: string;
  new_cost: string;
  effective_date: string;
  effective_to?: string;
  price_kind: SupplierPriceKind;
  price_unit: string;
  package_quantity: string;
  has_formula: boolean;
  formula_cells: string[];
}

export interface SupplierImportReviewRow {
  id: string;
  row_number: number;
  product_id: string | null;
  product_name: string | null;
  product_supplier_link_id: string | null;
  supplier_sku: string | null;
  supplier_product_name: string | null;
  cost_cents: bigint | null;
  price_unit: string | null;
  package_quantity: number | null;
  effective_from: string | null;
  effective_to: string | null;
  price_kind: SupplierPriceKind | null;
  row_status: SupplierPriceImportRowStatus;
  validation_errors: string[];
  observation_id: string | null;
}

export interface SupplierImportReview {
  id: string;
  vendor_id: string;
  vendor_name: string;
  document_date: string;
  ingestion_method: SupplierPriceImportMethod;
  format_version: string;
  status: 'draft' | 'needs_review' | 'approved' | 'rejected' | 'partially_approved';
  source_document_name: string | null;
  row_count: number;
  eligible_row_count: number;
  approved_observation_count: number;
  created_at: string;
  rows: SupplierImportReviewRow[];
  approved_count?: number;
  sell_prices_changed?: 0;
  summary?: string;
}

export interface SupplierPriceHistoryPoint {
  stream: 'supplier_observation' | 'selected_cost_basis' | 'actual_purchase';
  source_id: string;
  vendor_id: string | null;
  supplier_name: string | null;
  cost_cents: bigint;
  normalized_cost_cents: bigint | null;
  occurred_at: string;
  detail: string;
  provenance: Record<string, unknown>;
}

export interface SupplierPriceHistory {
  product_id: string;
  summary: SupplierMarketEvidence;
  suppliers: SupplierVendorOption[];
  points: SupplierPriceHistoryPoint[];
}

interface SupplierEvidenceDetailWire extends Omit<SupplierEvidenceDetail, 'quoted_package_cost_cents' | 'normalized_cost_cents'> {
  quoted_package_cost_cents: unknown;
  normalized_cost_cents: unknown;
}

interface SupplierMarketEvidenceWire extends Omit<
  SupplierMarketEvidence,
  | 'replacement_cost_cents'
  | 'last_paid_cents'
  | 'recent_po_weighted_average_cents'
  | 'suppliers'
> {
  replacement_cost_cents: unknown;
  last_paid_cents: unknown;
  recent_po_weighted_average_cents: unknown;
  suppliers: SupplierEvidenceDetailWire[];
}

interface SupplierPricingWorkspaceWire extends Omit<SupplierPricingWorkspace, 'evidence'> {
  evidence: SupplierMarketEvidenceWire[];
}

interface SupplierImportReviewWire extends Omit<SupplierImportReview, 'rows'> {
  rows: Array<Omit<SupplierImportReviewRow, 'cost_cents'> & { cost_cents: unknown }>;
}

interface SupplierPriceHistoryWire extends Omit<SupplierPriceHistory, 'summary' | 'points'> {
  summary: SupplierMarketEvidenceWire;
  points: Array<Omit<SupplierPriceHistoryPoint, 'cost_cents' | 'normalized_cost_cents'> & {
    cost_cents: unknown;
    normalized_cost_cents: unknown;
  }>;
}

function exactIntegerCents(value: unknown, field: string): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new Error(`Supplier pricing RPC returned an unsafe ${field} value.`);
}

function requiredIntegerCents(value: unknown, field: string): bigint {
  const cents = exactIntegerCents(value, field);
  if (cents === null) throw new Error(`Supplier pricing RPC omitted ${field}.`);
  return cents;
}

function normalizeEvidence(evidence: SupplierMarketEvidenceWire): SupplierMarketEvidence {
  return {
    ...evidence,
    replacement_cost_cents: exactIntegerCents(evidence.replacement_cost_cents, 'replacement cents'),
    last_paid_cents: exactIntegerCents(evidence.last_paid_cents, 'last paid cents'),
    recent_po_weighted_average_cents: exactIntegerCents(
      evidence.recent_po_weighted_average_cents,
      'recent PO weighted average cents',
    ),
    suppliers: evidence.suppliers.map((supplier) => ({
      ...supplier,
      quoted_package_cost_cents: requiredIntegerCents(
        supplier.quoted_package_cost_cents,
        'quoted package cents',
      ),
      normalized_cost_cents: exactIntegerCents(
        supplier.normalized_cost_cents,
        'normalized supplier cents',
      ),
    })),
  };
}

export function formatSupplierCents(value: bigint | null): string {
  if (value === null) return '—';
  const sign = value < 0n ? '-' : '';
  const absolute = value < 0n ? -value : value;
  return `${sign}$${absolute / 100n}.${(absolute % 100n).toString().padStart(2, '0')}`;
}

export async function getSupplierPricingWorkspace(
  productId: string | null = null,
  vendorId: string | null = null,
): Promise<SupplierPricingWorkspace> {
  const { data, error } = await supabaseUntyped.rpc('get_supplier_pricing_workspace', {
    p_product_id: productId,
    p_vendor_id: vendorId,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierPricingWorkspaceWire>(data, 'get_supplier_pricing_workspace');
  return { ...result, evidence: result.evidence.map(normalizeEvidence) };
}

export async function getSupplierQuoteSheet(vendorId: string): Promise<SupplierQuoteSheet> {
  const { data, error } = await supabaseUntyped.rpc('get_supplier_quote_sheet', {
    p_vendor_id: vendorId,
  });
  if (error) throw error;
  return assertRpcResult<SupplierQuoteSheet>(data, 'get_supplier_quote_sheet');
}

export async function getSupplierMarketEvidence(
  productIds: string[] | null,
): Promise<SupplierMarketEvidence[]> {
  const { data, error } = await supabaseUntyped.rpc('get_supplier_market_evidence', {
    p_product_ids: productIds,
  });
  if (error) throw error;
  return assertRpcResult<SupplierMarketEvidenceWire[]>(data, 'get_supplier_market_evidence')
    .map(normalizeEvidence);
}

export async function getSupplierPriceImport(importId: string): Promise<SupplierImportReview> {
  const { data, error } = await supabaseUntyped.rpc('get_supplier_price_import', {
    p_import_id: importId,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierImportReviewWire>(data, 'get_supplier_price_import');
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      cost_cents: exactIntegerCents(row.cost_cents, 'import row cents'),
    })),
  };
}

export async function getProductPriceHistory(productId: string): Promise<SupplierPriceHistory> {
  const { data, error } = await supabaseUntyped.rpc('get_product_price_history', {
    p_product_id: productId,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierPriceHistoryWire>(data, 'get_product_price_history');
  return {
    ...result,
    summary: normalizeEvidence(result.summary),
    points: result.points.map((point) => ({
      ...point,
      cost_cents: requiredIntegerCents(point.cost_cents, 'history cents'),
      normalized_cost_cents: exactIntegerCents(point.normalized_cost_cents, 'normalized history cents'),
    })),
  };
}

export interface UpsertSupplierLinkInput {
  linkId?: string | null;
  productId: string;
  vendorId: string;
  supplierSku: string;
  supplierProductName: string;
  supplierUom: string;
  supplierPackDescription: string;
  inventoryUnitsPerSupplierUnit: string;
  conversionUnit: string;
  comparisonStatus: SupplierComparisonStatus;
  comparisonNote: string;
  isPreferred: boolean;
  performedBy: string;
  idempotencyKey: string;
}

export async function upsertProductSupplierLink(
  input: UpsertSupplierLinkInput,
): Promise<SupplierWorkspaceLink> {
  const { data, error } = await supabaseUntyped.rpc('upsert_product_supplier_link', {
    p_product_id: input.productId,
    p_vendor_id: input.vendorId,
    p_supplier_sku: input.supplierSku,
    p_supplier_product_name: input.supplierProductName,
    p_supplier_uom: input.supplierUom,
    p_supplier_pack_description: input.supplierPackDescription,
    p_inventory_units_per_supplier_unit: input.inventoryUnitsPerSupplierUnit,
    p_conversion_unit: input.conversionUnit,
    p_comparison_status: input.comparisonStatus,
    p_comparison_note: input.comparisonNote,
    p_is_preferred: input.isPreferred,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
    p_link_id: input.linkId ?? null,
  });
  if (error) throw error;
  return assertRpcResult<SupplierWorkspaceLink>(data, 'upsert_product_supplier_link');
}

export interface StageSupplierPriceImportInput {
  vendorId: string;
  documentDate: string;
  ingestionMethod: SupplierPriceImportMethod;
  formatVersion: string;
  sourceDocumentPath?: string | null;
  sourceDocumentName?: string | null;
  sourceDocumentMime?: 'application/pdf' | null;
  rows: SupplierImportInputRow[];
  performedBy: string;
  idempotencyKey: string;
}

export async function stageSupplierPriceImport(
  input: StageSupplierPriceImportInput,
): Promise<SupplierImportReview> {
  const { data, error } = await supabaseUntyped.rpc('stage_supplier_price_import', {
    p_vendor_id: input.vendorId,
    p_document_date: input.documentDate,
    p_ingestion_method: input.ingestionMethod,
    p_format_version: input.formatVersion,
    p_source_document_path: input.sourceDocumentPath ?? null,
    p_source_document_name: input.sourceDocumentName ?? null,
    p_source_document_mime: input.sourceDocumentMime ?? null,
    p_rows: input.rows,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierImportReviewWire>(data, 'stage_supplier_price_import');
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      cost_cents: exactIntegerCents(row.cost_cents, 'import row cents'),
    })),
  };
}

export async function approveSupplierPriceImport(input: {
  importId: string;
  rowIds: string[];
  performedBy: string;
  idempotencyKey: string;
}): Promise<SupplierImportReview> {
  const { data, error } = await supabaseUntyped.rpc('approve_supplier_price_import', {
    p_import_id: input.importId,
    p_row_ids: input.rowIds,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierImportReviewWire>(data, 'approve_supplier_price_import');
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      cost_cents: exactIntegerCents(row.cost_cents, 'import row cents'),
    })),
  };
}

export async function rejectSupplierPriceImport(input: {
  importId: string;
  reason: string;
  performedBy: string;
  idempotencyKey: string;
}): Promise<SupplierImportReview> {
  const { data, error } = await supabaseUntyped.rpc('reject_supplier_price_import', {
    p_import_id: input.importId,
    p_reason: input.reason,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierImportReviewWire>(data, 'reject_supplier_price_import');
  return {
    ...result,
    rows: result.rows.map((row) => ({
      ...row,
      cost_cents: exactIntegerCents(row.cost_cents, 'import row cents'),
    })),
  };
}

export async function stageVendorAlias(input: {
  aliasRaw: string;
  aliasDisplay: string;
  proposedVendorId: string;
  source: SupplierWorkspaceAlias['source'];
  performedBy: string;
  idempotencyKey: string;
}): Promise<SupplierWorkspaceAlias> {
  const { data, error } = await supabaseUntyped.rpc('stage_vendor_alias', {
    p_alias_raw: input.aliasRaw,
    p_alias_display: input.aliasDisplay,
    p_proposed_vendor_id: input.proposedVendorId,
    p_source: input.source,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<SupplierWorkspaceAlias>(data, 'stage_vendor_alias');
}

export async function reviewVendorAlias(input: {
  aliasId: string;
  vendorId: string | null;
  decision: 'approved' | 'rejected';
  reviewNote: string;
  performedBy: string;
  idempotencyKey: string;
}): Promise<SupplierWorkspaceAlias> {
  const { data, error } = await supabaseUntyped.rpc('review_vendor_alias', {
    p_alias_id: input.aliasId,
    p_vendor_id: input.vendorId,
    p_decision: input.decision,
    p_review_note: input.reviewNote,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  return assertRpcResult<SupplierWorkspaceAlias>(data, 'review_vendor_alias');
}

export interface SupplierObservationCorrection {
  observation_id: string;
  supersedes_observation_id: string;
  product_id: string;
  vendor_id: string;
  product_supplier_link_id: string;
  cost_cents: bigint;
  price_unit: string;
  package_quantity: number;
  price_kind: SupplierPriceKind;
  effective_from: string;
  effective_to: string | null;
  import_id: string;
  import_row_id: string;
  reason: string;
  sell_prices_changed: 0;
  summary: string;
}

interface SupplierObservationCorrectionWire
  extends Omit<SupplierObservationCorrection, 'cost_cents'> {
  cost_cents: unknown;
}

export async function correctSupplierPriceObservation(input: {
  observationId: string;
  correctedCost: string;
  reason: string;
  performedBy: string;
  idempotencyKey: string;
}): Promise<SupplierObservationCorrection> {
  const { data, error } = await supabaseUntyped.rpc('correct_supplier_price_observation', {
    p_observation_id: input.observationId,
    p_corrected_cost: input.correctedCost,
    p_reason: input.reason,
    p_performed_by: input.performedBy,
    p_idempotency_key: input.idempotencyKey,
  });
  if (error) throw error;
  const result = assertRpcResult<SupplierObservationCorrectionWire>(
    data,
    'correct_supplier_price_observation',
  );
  return {
    ...result,
    cost_cents: requiredIntegerCents(result.cost_cents, 'corrected observation cents'),
  };
}

export async function uploadSupplierSourcePdf(file: File, actorId: string): Promise<string> {
  if (file.type !== 'application/pdf' || !file.name.toLowerCase().endsWith('.pdf')) {
    throw new Error('The optional source document must be a PDF. It is stored for audit only.');
  }
  if (file.size > 20 * 1024 * 1024) {
    throw new Error('The optional source PDF must be 20 MB or smaller.');
  }

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const path = `${actorId}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}-${safeName}`;
  const { error } = await supabase.storage
    .from(SUPPLIER_EVIDENCE_BUCKET)
    .upload(path, file, { contentType: 'application/pdf', upsert: false });
  if (error) throw error;
  return path;
}
