import type { Database, Json } from './supabase';

// Canonical generated row shape for the append-only financial audit ledger.
export type FinancialAuditLog = Database['public']['Tables']['financial_audit_log']['Row'];

export type UserRole = 'admin' | 'sales_rep' | 'driver' | 'applicator';
export type ProductForm = 'liquid' | 'dry';
export type ContainerType = 'Jug' | 'Drum' | 'Pallet' | 'Mini-Bulk' | 'Shuttle' | 'Bag' | 'Tote' | 'Ea' | 'Jar';
export type UnitType = 'liquid' | 'dry' | 'both';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  phone: string | null;
  is_active: boolean;
  denied_pages: string[];
  applicator_license_number: string | null;
  faa_certificate_number: string | null;
  created_at: string;
  updated_at: string;
}

// Non-PII shape from `public.profile_public_view` (PR-07, 2026-05-10).
// Use for assignment dropdowns, joined display names, and any read that
// doesn't need email/phone/license/certificate.
//
// As of migration 20260729125227 the view is `security_invoker = true` and reads
// `public.profile_public_directory` -- a non-sensitive mirror of profiles kept in
// sync by trigger -- NOT `public.profiles` directly. Any active signed-in user can
// read it by policy, which is why the non-admin pickers still work even though
// SELECT on `profiles` itself remains admin/self.
//
// Before that migration the view was `security_invoker = off`, so it ran as its
// owner `postgres` (BYPASSRLS) and was a full RLS bypass onto `profiles`. See
// docs/manual/KNOWN_ISSUES.md section 0d.
export interface ProfilePublic {
  id: string;
  full_name: string;
  role: UserRole;
  is_active: boolean;
}

export interface Product {
  id: string;
  product_name: string;
  sku: string | null;
  category: string | null;
  use_timing?: string | null;
  vendor: string | null;
  manufacturer: string | null;
  container_size: number | null;
  unit_size: string | null;
  epa_registration: string | null;
  is_rup: boolean;
  signal_word: 'Danger' | 'Warning' | 'Caution' | null;
  /** WPS restricted-entry interval in hours, from the product label (NULL = not entered) */
  rei_hours: number | null;
  /** Pre-harvest interval in days, from the product label (NULL = not entered) */
  phi_days: number | null;
  product_form: ProductForm | null;
  product_family_id?: string | null;
  return_policy?: 'returnable' | 'no_return' | 'not_applicable' | 'unknown';
  packaging_variant?: string | null;
  is_full_tote_only?: boolean;
  inventory_unit: string | null;
  container_unit: string | null;
  container_type: ContainerType | null;
  current_cost: number | null;
  cost_updated_date: string | null;
  tier1_price: number | null;
  tier1_margin: number | null;
  tier1_gross_margin: number | null;
  tier2_price: number | null;
  tier2_margin: number | null;
  tier2_gross_margin: number | null;
  tier3_price: number | null;
  tier3_margin: number | null;
  tier3_gross_margin: number | null;
  tier1_price_per_acre: number | null;
  tier2_price_per_acre: number | null;
  tier3_price_per_acre: number | null;
  /** Optimistic concurrency token for governed pricing preview/apply flows. */
  pricing_version: number;
  suggested_rate: string | null;
  rate_per_acre: number | null;
  rate_unit: string | null;
  /** Maximum application rate from the product label (e.g. 2.5) */
  max_label_rate: number | null;
  /** Unit for max_label_rate (e.g. 'oz/acre', 'pt/acre', 'lb/acre') */
  max_label_rate_unit: string | null;
  notes: string | null;
  internal_notes: string | null;
  /** Customer-facing guidance preferred when adding this Product to a quote. */
  quoting_notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// ─── EPA PPLS Lookup ────────────────────────────────────────────────────────
// Keep this shape in sync with supabase/functions/epa-lookup/logic.ts.

export type EpaRegistrationType = 'section3' | 'distributor';
export type EpaSignalWordCanonical = 'Danger' | 'Warning' | 'Caution';

export interface EpaActiveIngredient {
  name: string;
  percent: number | null;
  pcCode: string | null;
  casNumber: string | null;
}

export interface EpaLabelPdf {
  fileName: string;
  acceptedDate: string | null;
  url: string;
}

export interface EpaLookupResult {
  found: boolean;
  regType: EpaRegistrationType;
  eparegno: string | null;
  productname: string | null;
  signalWordCanonical: EpaSignalWordCanonical | null;
  needsManual: boolean;
  manufacturer: string | null;
  rupYn: 'Yes' | 'No' | null;
  productStatus: string | null;
  isCancelled: boolean;
  activeIngredients: EpaActiveIngredient[];
  latestLabelPdfUrl: string | null;
  labelPdfs: EpaLabelPdf[];
}

// ─── Label Drafts (§1 AI Label-Data Backfill) ───────────────────────────────

export type LabelDraftConfidence = 'high' | 'medium' | 'low';
export type LabelDraftStatus = 'pending' | 'accepted' | 'edited' | 'rejected' | 'needs_manual';

export interface ProductLabelDraft {
  id: string;
  product_id: string;
  signal_word: string | null;
  rei_hours: number | null;
  phi_days: number | null;
  epa_registration: string | null;
  max_label_rate: number | null;
  max_label_rate_unit: string | null;
  source_note: string;
  confidence: LabelDraftConfidence;
  status: LabelDraftStatus;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  run_idempotency_key: string | null;
  created_at: string;
  updated_at: string;
  // Joined from products query
  product?: Pick<Product, 'id' | 'product_name' | 'sku' | 'vendor' | 'signal_word' | 'rei_hours' | 'phi_days' | 'epa_registration' | 'max_label_rate' | 'max_label_rate_unit'>;
}

export interface LabelCoverageReport {
  total_active_products: number;
  signal_word: number;
  rei_hours: number;
  phi_days: number;
  epa_registration: number;
  max_label_rate: number;
  pending_drafts: number;
  accepted_drafts: number;
  rejected_drafts: number;
  needs_manual: number;
}

export interface CommitLabelDraftResult {
  draft_id: string;
  product_id: string;
  decision: 'accepted' | 'edited' | 'rejected';
  applied: string[];
  skipped: string[];
}

export interface CostHistory {
  id: string;
  product_id: string;
  changed_by: string;
  change_source: 'legacy_frontend' | 'pricing_worksheet' | 'product_page' | 'products_inline';
  change_reason: string | null;
  change_set_id: string | null;
  old_cost: number | null;
  new_cost: number | null;
  old_tier1_margin: number | null;
  old_tier1_price: number | null;
  new_tier1_margin: number | null;
  new_tier1_price: number | null;
  old_tier2_margin: number | null;
  old_tier2_price: number | null;
  new_tier2_margin: number | null;
  new_tier2_price: number | null;
  old_tier3_margin: number | null;
  old_tier3_price: number | null;
  new_tier3_margin: number | null;
  new_tier3_price: number | null;
  old_pricing_version: number | null;
  new_pricing_version: number | null;
  change_note: string | null;
  changed_at: string;
}

// ── Pricing worksheet persistence (Phase 1a) ────────────────────

export type PricingWorkbookExportStatus = 'active' | 'consumed' | 'expired';
export type PricingChangeSetSource = 'pricing_worksheet' | 'product_page' | 'products_inline';
export type PricingChangeSetStatus = 'previewed' | 'invalid' | 'no_changes' | 'applied' | 'expired';
export type PricingMode = 'margin_driven' | 'price_driven';
export type PricingPreviewRowStatus = 'ready' | 'conflict' | 'invalid' | 'unchanged';

/** Database row from pricing_workbook_exports. */
export interface PricingWorkbookExportRecord {
  id: string;
  created_by: string;
  request_fingerprint: string;
  manifest_fingerprint: string;
  idempotency_key: string;
  row_count: number;
  status: PricingWorkbookExportStatus;
  format_version: string;
  created_at: string;
  expires_at: string;
}

/** Database row from pricing_workbook_export_rows. Money fields are integer cents. */
export interface PricingWorkbookExportRowRecord {
  export_id: string;
  product_id: string;
  sku_snapshot: string | null;
  product_name_snapshot: string;
  category_snapshot: string | null;
  container_size_snapshot: string | null;
  unit_size_snapshot: string | null;
  inventory_unit_snapshot: string | null;
  identity_fingerprint: string;
  row_token: string;
  row_version: number;
  current_cost_cents: bigint | null;
  current_tier1_margin: number | null;
  current_tier1_price_cents: bigint | null;
  current_tier2_margin: number | null;
  current_tier2_price_cents: bigint | null;
  current_tier3_margin: number | null;
  current_tier3_price_cents: bigint | null;
  suggested_rate_snapshot: string | null;
  rate_per_acre_snapshot: number | null;
  rate_unit_snapshot: string | null;
  use_timing_snapshot: string | null;
  internal_notes_snapshot: string | null;
  quoting_notes_snapshot: string | null;
}

/** Database row from pricing_change_sets. */
export interface PricingChangeSetRecord {
  id: string;
  export_id: string | null;
  created_by: string;
  source: PricingChangeSetSource;
  request_fingerprint: string;
  preview_idempotency_key: string;
  submitted_row_count: number;
  row_count: number;
  status: PricingChangeSetStatus;
  created_at: string;
  expires_at: string;
  applied_by: string | null;
  applied_at: string | null;
  apply_idempotency_key: string | null;
  apply_result: Record<string, unknown> | null;
}

/** Database row from pricing_change_set_rows. Money fields are integer cents. */
export interface PricingChangeSetRowRecord {
  change_set_id: string;
  product_id: string;
  identity_fingerprint: string;
  expected_version: number;
  pricing_mode: PricingMode;
  change_reason: string | null;
  input_cost_cents: bigint;
  input_tier1_margin: number | null;
  input_tier2_margin: number | null;
  input_tier3_margin: number | null;
  input_tier1_price_cents: bigint | null;
  input_tier2_price_cents: bigint | null;
  input_tier3_price_cents: bigint | null;
  output_cost_cents: bigint;
  output_tier1_margin: number;
  output_tier2_margin: number;
  output_tier3_margin: number;
  output_tier1_price_cents: bigint;
  output_tier2_price_cents: bigint;
  output_tier3_price_cents: bigint;
  output_tier1_gross_margin: number | null;
  output_tier2_gross_margin: number | null;
  output_tier3_gross_margin: number | null;
  output_tier1_price_per_acre_cents: bigint | null;
  output_tier2_price_per_acre_cents: bigint | null;
  output_tier3_price_per_acre_cents: bigint | null;
  output_fingerprint: string;
}

/** Database row from pricing_change_set_preview_rows. */
export interface PricingChangeSetPreviewRowRecord {
  change_set_id: string;
  sequence: number;
  product_id: string | null;
  submitted_row: Record<string, unknown>;
  row_status: PricingPreviewRowStatus;
  error_code: string | null;
  effect: Record<string, unknown> | null;
}

// ── Supplier price evidence (Phase 1b) ──────────────────────────

export type SupplierReviewStatus = 'pending' | 'approved' | 'rejected';
export type SupplierComparisonStatus = 'pending' | 'comparable' | 'not_comparable';
export type SupplierLinkStatus = 'pending' | 'confirmed' | 'rejected';
export type SupplierPriceKind = 'list' | 'quote' | 'contract' | 'promo' | 'manual';
export type SupplierPriceImportMethod = 'quote_sheet' | 'quick_quote';
export type SupplierPriceImportStatus =
  | 'draft'
  | 'needs_review'
  | 'approved'
  | 'rejected'
  | 'partially_approved';
export type SupplierPriceImportRowStatus =
  | 'new'
  | 'changed'
  | 'cannot_compare'
  | 'invalid'
  | 'unchanged'
  | 'duplicate'
  | 'approved'
  | 'rejected';

export interface VendorAlias {
  id: string;
  vendor_id: string | null;
  proposed_vendor_id: string | null;
  alias_raw: string;
  alias_normalized: string;
  alias_display: string;
  source: 'legacy_product' | 'legacy_po' | 'import' | 'manual';
  review_status: SupplierReviewStatus;
  review_note: string | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  // Durable idempotent-replay receipt (migration 20260720230000). Server-internal:
  // stage_vendor_alias strips both from its RPC response, so they are only seen
  // by direct table reads.
  idempotency_key?: string | null;
  request_fingerprint?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LegacyVendorResolution {
  id: string;
  original_text: string;
  normalized_text: string;
  vendor_id: string | null;
  confidence: number;
  review_status: SupplierReviewStatus;
  source_table: 'products' | 'purchase_orders';
  review_note: string | null;
  created_by: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProductSupplierLink {
  id: string;
  product_id: string;
  vendor_id: string;
  supplier_sku: string | null;
  supplier_product_name: string;
  supplier_uom: string | null;
  supplier_pack_description: string | null;
  inventory_units_per_supplier_unit: number | null;
  /** Generated compatibility alias; use inventory_units_per_supplier_unit for direction. */
  conversion_factor: number | null;
  conversion_unit: string | null;
  comparison_status: SupplierComparisonStatus;
  comparison_note: string | null;
  link_status: SupplierLinkStatus;
  is_reusable: boolean;
  is_active: boolean;
  is_preferred: boolean;
  match_confidence: number | null;
  confirmed_by: string | null;
  confirmed_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface SupplierPriceImport {
  id: string;
  vendor_id: string;
  document_date: string;
  ingestion_method: SupplierPriceImportMethod;
  format_version: string;
  status: SupplierPriceImportStatus;
  source_document_path: string | null;
  source_document_name: string | null;
  source_document_mime: 'application/pdf' | null;
  request_fingerprint: string;
  idempotency_key: string;
  // Durable idempotent-replay receipts (migration 20260720230000). Server-internal:
  // approve/reject RPC responses strip these, so they are only seen by direct table reads.
  approve_idempotency_key?: string | null;
  approve_request_fingerprint?: string | null;
  reject_idempotency_key?: string | null;
  reject_request_fingerprint?: string | null;
  row_count: number;
  eligible_row_count: number;
  approved_observation_count: number;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  rejection_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface SupplierPriceImportRow {
  id: string;
  import_id: string;
  row_number: number;
  submitted_row: Record<string, unknown>;
  product_id: string | null;
  vendor_id: string | null;
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
  reviewer_note: string | null;
  reviewed_by: string | null;
  reviewed_at: string | null;
  observation_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Append-only supplier_price_observations row. Money is integer cents. */
export interface SupplierPriceObservation {
  id: string;
  product_id: string;
  vendor_id: string;
  product_supplier_link_id: string;
  import_id: string;
  import_row_id: string;
  price_kind: SupplierPriceKind;
  cost_cents: bigint;
  price_unit: string;
  package_quantity: number;
  effective_from: string;
  effective_to: string | null;
  observed_at: string;
  supersedes_observation_id: string | null;
  created_by: string;
  created_at: string;
}

// ── Governed Product cost basis (Supplier Pricing Phase 2) ─────

export type ProductCostBasisType =
  | 'selected_supplier_price'
  | 'actual_purchase'
  | 'manual_override';
export type ProductCostBasisSelectionSource =
  | 'migration_baseline'
  | 'pricing_worksheet'
  | 'product_page'
  | 'products_inline'
  | 'supplier_pricing'
  | 'product_detail';

/** Server-owned Product cost-basis history. Money is integer cents. */
export interface ProductCostBasis {
  id: string;
  product_id: string;
  basis_type: ProductCostBasisType;
  cost_cents: bigint;
  supplier_price_observation_id: string | null;
  purchase_order_item_id: string | null;
  pricing_change_set_id: string | null;
  selection_source: ProductCostBasisSelectionSource;
  reason: string;
  selected_by: string | null;
  selected_at: string;
  effective_from: string;
  effective_to: string | null;
  created_at: string;
}

/** Durable provenance attached to an existing Phase 1a pricing preview. */
export interface ProductCostBasisChangeRow {
  pricing_change_set_id: string;
  product_id: string;
  expected_version: number;
  expected_active_basis_id: string | null;
  basis_type: ProductCostBasisType;
  cost_cents: bigint;
  supplier_price_observation_id: string | null;
  purchase_order_item_id: string | null;
  selection_source: Exclude<ProductCostBasisSelectionSource, 'migration_baseline'>;
  reason: string;
  force_selection: boolean;
  created_at: string;
}

export interface CommissionSplit {
  /** recipient is the display name; recipient_user_id (profile UUID, stamped
   *  by the DB on write since migration 20260722170000) is authoritative for
   *  routing. Optional because pre-migration rows and drafts may lack it. */
  splits: Array<{ recipient: string; recipient_user_id?: string | null; percentage: number }>;
}

export interface Customer {
  id: string;
  farm_name: string;
  /** Controlled list, enforced by customers_crops_allowed_check (see src/lib/crops.ts). */
  crops: string[];
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  billing_address: string | null;
  shipping_address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  account_number: string | null;
  assigned_tier: number;
  assigned_sales_rep: string | null;
  parent_customer_id: string | null;
  total_acres: number | null;
  corn_acres: number | null;
  soybean_acres: number | null;
  other_acres: number | null;
  payment_terms: string | null;
  default_commission_split: CommissionSplit | null;
  default_application_service_id?: string | null;
  credit_limit_cents: number | null;
  finance_charge_rate: number | null;
  finance_charge_enabled: boolean;
  finance_charge_grace_days: number;
  prepay_balance_cents: number;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  parent_customer?: Customer;
}

export interface CustomerAddress {
  id: string;
  customer_id: string;
  label: string;
  address_line: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  delivery_notes: string | null;
  is_default: boolean;
  latitude: number | null;
  longitude: number | null;
  created_at: string;
}

export type PreferredContactMethod = 'phone' | 'text' | 'email';

export interface CustomerContact {
  id: string;
  customer_id: string;
  name: string | null;
  role: string | null;
  phone_display: string | null;
  phone_e164: string | null;
  email: string | null;
  preferred_contact_method: PreferredContactMethod | null;
  is_primary: boolean;
  can_place_orders: boolean;
  is_decision_maker: boolean;
  is_billing_contact: boolean;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExternalIdentity {
  id: string;
  customer_id: string;
  contact_id: string | null;
  provider: string;
  external_id: string;
  verified_at: string | null;
  verified_by: string | null;
  created_at: string;
  updated_at: string;
}

export type InteractionType = 'call' | 'visit' | 'meeting' | 'text' | 'email' | 'voicemail';
export type InteractionDirection = 'inbound' | 'outbound';
export type InteractionSource = 'rep' | 'ai_receptionist' | 'system' | 'web_store';
export type InteractionOutcome = 'connected' | 'left_voicemail' | 'no_answer' | 'busy' | 'follow_up_needed' | 'order_placed' | 'resolved' | 'other';
export type RecordingConsentStatus = 'granted' | 'announced' | 'declined' | 'not_applicable';

export interface CustomerInteraction {
  id: string;
  customer_id: string;
  contact_id: string | null;
  interaction_type: InteractionType;
  direction: InteractionDirection | null;
  source: InteractionSource;
  occurred_at: string;
  duration_seconds: number | null;
  outcome: InteractionOutcome | null;
  summary: string | null;
  owner_user_id: string | null;
  created_by: string | null;
  provider: string | null;
  external_call_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface InteractionTranscript {
  id: string;
  interaction_id: string;
  transcript: string | null;
  ai_summary: string | null;
  extraction: Record<string, unknown> | null;
  recording_path: string | null;
  recording_consent_status: RecordingConsentStatus | null;
  recording_consent_at: string | null;
  recording_consent_method: string | null;
  recording_disclosed_at: string | null;
  ai_disclosed_at: string | null;
  disclosure_version: string | null;
  retention_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export type QuoteStatus = 'draft' | 'sent' | 'revised' | 'accepted' | 'declined' | 'expired' | 'cancelled' | 'closed_by_application' | 'closed_short';

export interface Quote {
  id: string;
  row_version?: number;
  quote_number: string;
  customer_id: string;
  created_by: string;
  tier: number;
  status: QuoteStatus;
  is_planned: boolean;
  commission_split: CommissionSplit | null;
  total_price: number;
  total_cost: number;
  total_profit: number;
  total_margin_pct: number;
  valid_days: number;
  expires_at: string | null;
  header_notes: string | null;
  footer_notes: string | null;
  season: number | null;
  salesman_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
  pdf_template_id: string | null;
  pdf_columns_override: Record<string, unknown> | null;
  customer?: Customer;
}

export interface QuoteSection {
  id: string;
  quote_id: string;
  section_name: string;
  sort_order: number;
  section_notes: string | null;
  section_header_notes: string | null;
  needed_by_date: string | null;
  field_id: string | null;
}

export interface QuoteItem {
  id: string;
  quote_id: string;
  section_id: string;
  product_id: string;
  sort_order: number;
  notes: string | null;
  price_per_unit: number;
  price_override: number | null;
  current_cost: number;
  // Immutable as-of-quote cost snapshot (20260812115236), mirroring
  // order_items.cost_at_time_cents. Trigger-stamped on insert and never
  // written by the browser. NULL only on a legacy row whose product carried
  // a NULL current_cost at backfill time. Optional because partial projections
  // may omit it; the column is server-managed and the browser never writes it.
  cost_at_quote_cents?: number | null;
  suggested_rate: string | null;
  actual_rate: number | null;
  rate_unit: string | null;
  oz_per_acre: number | null;
  price_per_acre: number | null;
  acres: number | null;
  total_units_needed: number | null;
  unit_size: string | null;
  profit: number;
  total_price: number;
  net_margin: number;
  calc_mode: string | null;
  price_unit: string | null;
  product?: Product;
}

// Per-(quote, product) booking draw-down ledger (sell-side roadmap #1).
// Lives in its own table — NOT on quote_items — because save_quote recreates
// all quote_items on every edit, which would wipe item-level draw history.
export interface QuoteProductDraw {
  id: string;
  quote_id: string;
  product_id: string;
  quantity_drawn: number;
  created_at: string;
  updated_at: string;
}

// Layer 2: per-(job, product) draw-down of a parent planned quote's booking by
// a scheduled job. Mirrors QuoteProductDraw; lives in its own table because the
// job_chemicals writers recreate all chemical lines on every edit.
export interface JobProductDraw {
  id: string;
  job_id: string;
  quote_id: string;
  product_id: string;
  quantity_drawn: number;
  created_at: string;
  updated_at: string;
}

export interface QuoteVersion {
  id: string;
  quote_id: string;
  version_number: number;
  sent_by: string;
  sent_at: string;
  sent_method: string;
  snapshot_data: {
    quote: {
      quote_number: string;
      customer_id: string;
      tier: number;
      status: string;
      total_price: number;
      total_cost: number;
      total_profit: number;
      total_margin_pct: number;
      valid_days: number;
      expires_at: string | null;
      header_notes: string | null;
      footer_notes: string | null;
      is_planned: boolean;
      commission_split: CommissionSplit | null;
    };
    sections: Array<{
      section_name: string;
      sort_order: number;
      section_notes: string | null;
      section_header_notes: string | null;
      needed_by_date: string | null;
      items: Array<{
        product_id: string;
        product_name: string;
        sku: string | null;
        sort_order: number;
        notes: string | null;
        price_per_unit: number;
        current_cost: number;
        suggested_rate: string | null;
        actual_rate: number | null;
        rate_unit: string | null;
        oz_per_acre: number | null;
        price_per_acre: number | null;
        acres: number | null;
        total_units_needed: number | null;
        unit_size: string | null;
        profit: number;
        total_price: number;
        net_margin: number;
        calc_mode: string | null;
        price_unit: string | null;
      }>;
    }>;
  };
  pdf_url: string | null;
  notes: string | null;
}

export interface QuoteTemplate {
  id: string;
  template_name: string;
  description: string | null;
  sections: Array<{
    section_name: string;
    sort_order: number;
    section_notes: string | null;
    section_header_notes: string | null;
    items: Array<{
      product_id: string;
      product_name: string;
      sku: string | null;
      sort_order: number;
      notes: string | null;
      suggested_rate: string | null;
      actual_rate: number | null;
      rate_unit: string | null;
      calc_mode: string | null;
    }>;
  }>;
  created_by: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface QuotePdfTemplate {
  id: string;
  template_name: string;
  columns: string[];
  is_default: boolean;
  is_system: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export type OrderStatus = 'confirmed' | 'partially_fulfilled' | 'fulfilled' | 'cancelled' | 'voided';

export interface Order {
  id: string;
  order_number: string;
  order_name: string | null;
  quote_id: string | null;
  /** true when the order was created by draw_down_quote (a booking draw) —
   * voiding/cancelling a draw order returns its quantity to the booking. */
  booking_draw?: boolean;
  customer_id: string;
  status: OrderStatus;
  commission_split: CommissionSplit | null;
  total_price: number;
  total_cost: number;
  total_profit: number;
  total_margin_pct: number;
  order_date: string;
  season: number | null;
  salesman_id: string | null;
  deleted_at: string | null;
  customer_po_number: string | null;
  is_planned: boolean;
  /** Ship-now/price-later (sell-side #2): 'needs_pricing' = rush order shipped
   * before pricing was finalized; its invoices cannot POST until price_order
   * runs. Defaults to 'priced' for every normal order. */
  pricing_status: 'priced' | 'needs_pricing';
  /** Ship-now/price-later (#2 v3): check_unpriced_orders cron dedupe stamps —
   * when the 48h reminder / 7d escalation notification was last sent. Internal. */
  pricing_reminder_sent_at: string | null;
  pricing_escalation_sent_at: string | null;
  notes: string | null;
  program_notes: string | null;
  /** U7 SAFE-SCOPE: set true by complete_delivery when a delivered order has
   * field/acre allocations — the mono-bill auto-draft is skipped and the order
   * is queued for a manual "Create Split Invoices" pass. Cleared back to false
   * once create_split_invoices_from_order successfully bills it. */
  needs_split_billing?: boolean | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
}

// ── Order Shares (bill-split between multiple customers) ─────────────────
export interface OrderShare {
  id: string;
  order_id: string;
  customer_id: string;
  customer_name: string;
  split_percentage: number;
  amount_cents: number;
  is_primary: boolean;
  sort_order: number;
  created_at: string;
}

/**
 * Per-LINE field/acre attribution for multi-field split invoices (nightly-debug #1).
 * A single order line can be "spread across" several fields by acres; at invoice time
 * create_split_invoices_from_order splits the line's total across these fields by acres,
 * then each field's portion among that field's owners (field_billing_defaults) by split_pct.
 * Entered on the order (not the quote). See migration 20260617200000.
 */
export interface OrderItemFieldAllocation {
  id: string;
  order_item_id: string;
  field_id: string;
  acres: number;
  created_at: string;
}

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  quote_item_id: string | null;
  section_name: string | null;
  product_name: string;
  price_per_unit: number;
  cost_per_unit: number;
  /**
   * Snapshot of `products.current_cost` (cents, rounded) at row insert time.
   * Distinct from `cost_per_unit` (caller-supplied — may be a stale quote cost
   * or manual override). Populated by trg_snapshot_order_item_cost trigger.
   * See migration 20260513050000 (audit #32).
   */
  cost_at_time_cents: number | null;
  actual_rate: number | null;
  rate_unit: string | null;
  acres: number | null;
  total_units_needed: number;
  unit_size: string | null;
  total_price: number;
  profit: number;
  net_margin: number;
  quantity_delivered: number;
  quantity_remaining: number;
  sort_order: number;
  notes: string | null;
  /** Ship-now/price-later (sell-side #2): true = line awaiting its final price
   * (rush order shipped before pricing). Cleared by price_order. */
  pricing_pending: boolean;
  /** Ship-now/price-later (sell-side #2): tier price snapshot captured by
   * create_rush_order at ship time (per customer.assigned_tier); the v2 pricing
   * screen's default suggestion. NULL on normally-priced lines. */
  suggested_price: number | null;
}

export interface Inventory {
  id: string;
  product_id: string;
  location: string;
  quantity_available: number;
  quantity_prebooked: number;
  quantity_on_order: number;
  unit_size: string | null;
  reorder_point: number;
  min_stock_level: number;
  last_counted_at: string | null;
  // P4-7: true when this inventory row was created by a delivery completion
  // that found no prior record for the product. Cleared by the
  // mark_inventory_row_verified RPC after admin physical-stock confirmation.
  manufactured_at_delivery: boolean;
  updated_at: string;
  product?: Product;
}

export type InventoryHoldType = 'manual' | 'crop_program' | 'job';

export interface InventoryHold {
  id: string;
  product_id: string;
  customer_id: string | null;
  quantity: number;
  hold_type: InventoryHoldType;
  source_id: string | null;
  notes: string | null;
  created_by: string;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  product?: Product;
  customer?: Customer;
  creator?: Profile;
}

// Wave B.3 — return shape of the get_inventory_position() RPC.
// One row per (product, location). net_position = quantity_available - quantity_prebooked + quantity_on_order.
// holds_qty and planned_qty are reported separately; they are NOT subtracted from net_position.
// Layer 2 (B2): holds_qty still sums ALL active holds; job_holds_qty is the job-type
// SUBSET of holds_qty (a breakout, not additive to totals). planned_qty is now the
// quantity-aware unreserved remainder per line (no longer all-or-nothing dedup).
export interface InventoryPositionRow {
  inventory_id: string | null;
  product_id: string;
  product_name: string;
  inventory_unit: string | null;
  container_size: number | null;
  container_type: string | null;
  vendor: string | null;
  current_cost: number | null;
  location: string | null;
  unit_size: string | null;
  quantity_available: number;
  quantity_prebooked: number;
  quantity_on_order: number;
  holds_qty: number;
  job_holds_qty: number;
  planned_qty: number;
  delivered_ytd: number;
  net_position: number;
  reorder_point: number;
  min_stock_level: number;
  is_low_stock: boolean;
}

// Layer 2 (B3) — return shape of get_dispatch_stock_status(uuid[]). One row per
// (job, product) the schedulable job needs. free_excluding_own_hold subtracts every
// active hold EXCEPT this job's own job-hold, so the dispatch light never warns a job
// against its own reservation. demand_qty is already converted to the product's
// inventory unit server-side. has_inventory=false means no stock record → treat as short.
export interface DispatchStockRow {
  job_id: string;
  product_id: string;
  demand_qty: number;
  has_inventory: boolean;
  free_excluding_own_hold: number;
  reorder_point: number;
}

export type DeliveryStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'voided';
export type DeliveryPriority = 'low' | 'normal' | 'high' | 'urgent';
export type DeliveryIssueType = 'none' | 'customer_not_home' | 'gate_locked' | 'road_blocked' | 'wrong_address' | 'refused' | 'weather' | 'other';

export interface Delivery {
  id: string;
  delivery_number: string;
  order_id: string;
  customer_id: string;
  delivery_address_id: string | null;
  assigned_driver: string | null;
  scheduled_date: string;
  scheduled_time: string | null;
  status: DeliveryStatus;
  delivery_notes: string | null;
  priority: DeliveryPriority;
  delivery_window_start: string | null;
  delivery_window_end: string | null;
  completed_at: string | null;
  signature_url: string | null;
  signed_by: string | null;
  receipt_pdf_url: string | null;
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  issue_type: DeliveryIssueType | null;
  issue_notes: string | null;
  last_edited_by: string | null;
  last_edited_at: string | null;
  season: number | null;
  deleted_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  is_quick_delivery?: boolean;
  customer?: Customer;
  order?: Order;
  driver?: Profile;
  address?: CustomerAddress;
}

export interface DeliveryItem {
  id: string;
  delivery_id: string;
  order_item_id: string;
  product_id: string;
  quantity: number;
  quantity_delivered: number;
  unit_size: string | null;
  notes: string | null;
  tote_number: string | null;
  product?: Product;
}

export interface DeliveryPhoto {
  id: string;
  delivery_id: string;
  storage_path: string;
  image_url: string;
  caption: string | null;
  uploaded_by: string;
  uploaded_at: string;
  file_size: number | null;
  sort_order: number;
  uploader?: Profile;
}

export type DeliveryRemainderStatus = 'pending' | 'scheduled' | 'fulfilled' | 'cancelled';

export interface DeliveryRemainder {
  id: string;
  original_delivery_id: string;
  order_id: string;
  order_item_id: string;
  customer_id: string;
  product_id: string;
  quantity_remaining: number;
  unit_size: string | null;
  status: DeliveryRemainderStatus;
  followup_delivery_id: string | null;
  notes: string | null;
  reminder_sent_at: string | null;
  escalation_sent_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined fields from RPC
  customer_name?: string;
  product_name?: string;
  original_delivery_number?: string;
  original_delivery_date?: string;
  order_number?: string;
}

// Stage 1B-1A durable acknowledgement for delivery/job work captured offline.
// Browser code reads the sanitized RPC result, never the table directly.
export type OfflineActionOperation = 'complete_delivery' | 'complete_job';
export type OfflineActionReceiptStatus = 'received' | 'succeeded' | 'needs_review';
export type OfflineActionReviewResolution = 'already_completed' | 'abandoned';
export type OfflineActionFailureCode =
  | 'ACTOR_MISMATCH'
  | 'IDEMPOTENCY_KEY_REUSE'
  | 'LEGACY_OUTCOME_UNKNOWN'
  | 'NOT_AUTHORIZED'
  | 'PAYLOAD_INVALID'
  | 'PAYLOAD_TOO_LARGE'
  | 'RESULT_INVALID'
  | 'RETRY_LIMIT'
  | 'TARGET_NOT_FOUND'
  | 'TARGET_STATE_CONFLICT'
  | 'UNEXPECTED_SERVER_ERROR'
  | 'UNSUPPORTED_OPERATION'
  | 'UNSUPPORTED_SCHEMA_VERSION';

export type OfflineActionRpcErrorCode =
  | OfflineActionFailureCode
  | 'AUTH_REQUIRED'
  | 'OFFLINE_ACTION_ID_REUSE'
  | 'OFFLINE_ACTION_NEEDS_REVIEW'
  | 'OFFLINE_STAGE_CONFLICT'
  | 'OFFLINE_STAGE_RATE_LIMIT'
  | 'OFFLINE_STAGE_DAILY_CAP'
  | 'OFFLINE_STAGE_REVIEW_BACKLOG'
  | 'OFFLINE_RESOLUTION_INVALID'
  | 'OFFLINE_ACTION_NOT_REVIEWABLE'
  | 'OFFLINE_ACTION_ALREADY_RESOLVED'
  | 'REASON_REQUIRED'
  | 'IDEMPOTENCY_ARGUMENT_MISMATCH';

// The database keeps DEFAULT NULL to satisfy CRX's one-overload mutator rule,
// but every app caller must supply a real key. These stricter app-layer types
// prevent the generated optional parameter from leaking into browser code.
export interface StageOfflineActionArgs {
  p_client_action_id: string;
  p_operation: OfflineActionOperation;
  p_entity_id: string;
  p_schema_version: number;
  p_client_created_at: string;
  p_payload: { [key: string]: Json | undefined };
  p_idempotency_key: string;
  p_entity_snapshot_at?: string;
}

export interface ProcessOfflineActionArgs {
  p_client_action_id: string;
  p_idempotency_key: string;
}

/** Shape shared by stage/process responses. Individual states omit fields that do not apply. */
export interface OfflineActionReceiptResult {
  client_action_id: string;
  operation: OfflineActionOperation;
  entity_id: string;
  client_created_at?: string;
  status: OfflineActionReceiptStatus;
  result?: Record<string, unknown> | null;
  failure_code?: OfflineActionFailureCode | null;
  failure_summary?: string | null;
  attempt_count?: number;
  received_at?: string;
  review_resolution?: OfflineActionReviewResolution | null;
  review_note?: string | null;
  resolved_at?: string | null;
  resolved_by?: string | null;
  updated_at?: string;
}

/** Full sanitized lookup returned by get_offline_action_status. */
export interface OfflineActionStatusResult extends OfflineActionReceiptResult {
  actor_id: string;
  schema_version: number;
  result: Record<string, unknown> | null;
  failure_code: OfflineActionFailureCode | null;
  failure_summary: string | null;
  attempt_count: number;
  last_attempt_at?: string | null;
  received_at: string;
  succeeded_at?: string | null;
  needs_review_at?: string | null;
  updated_at: string;
}

export interface OfflineActionReviewQueueItem {
  client_action_id: string;
  actor_id: string;
  actor_name: string;
  operation: OfflineActionOperation;
  entity_id: string;
  failure_code: OfflineActionFailureCode;
  failure_summary: string;
  attempt_count: number;
  client_created_at: string;
  received_at: string;
  needs_review_at: string;
  updated_at: string;
  review_resolution: OfflineActionReviewResolution | null;
  review_note: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  resolver_name: string | null;
}

export interface OfflineActionReviewQueueResult {
  items: OfflineActionReviewQueueItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface ResolveOfflineActionArgs {
  p_client_action_id: string;
  p_resolution: OfflineActionReviewResolution;
  p_note: string;
  p_idempotency_key: string;
}

export interface ResolveOfflineActionResult {
  client_action_id: string;
  operation: OfflineActionOperation;
  entity_id: string;
  status: 'needs_review';
  review_resolution: OfflineActionReviewResolution;
  review_note: string;
  resolved_at: string;
  resolved_by: string;
  updated_at: string;
}

export type POStatus = 'draft' | 'submitted' | 'partially_received' | 'fully_received' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor: string;
  status: POStatus;
  submitted_date: string | null;
  expected_delivery_date: string | null;
  total_cost: number;
  total_cost_cents: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  cancelled_at?: string | null;
  cancelled_by?: string | null;
  cancel_reason?: string | null;
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  product_id: string;
  product_name?: string;
  quantity_ordered: number;
  unit_cost: number;
  unit_cost_cents: number;
  quantity_received: number;
  unit_size: string | null;
  notes: string | null;
  product_supplier_link_id?: string | null;
  supplier_price_observation_id?: string | null;
  inventory_units_per_supplier_unit_snapshot?: number | null;
  cost_provenance?: 'manual' | 'supplier_observation' | 'legacy' | null;
  cost_snapshot_at?: string | null;
  product?: Product;
}

// ── Receiving ─────────────────────────────────────────────────

export type ReceivingCondition = 'good' | 'damaged' | 'short' | 'wrong_product' | 'mixed';

export interface ReceivingRecord {
  id: string;
  purchase_order_id: string;
  po_item_id: string;
  product_id: string;
  quantity_received: number;
  received_by: string;
  received_at: string;
  notes: string | null;
  condition: ReceivingCondition;
  lot_number: string | null;
  storage_location: string;
  unit_size: string | null;
  created_at: string;
  is_non_returnable?: boolean;
  // Joined fields from RPC
  po_number?: string;
  vendor?: string;
  product_name?: string;
  received_by_name?: string;
  photo_count?: number;
}

export interface ReceivingPhoto {
  id: string;
  receiving_record_id: string;
  storage_path: string;
  image_url: string;
  caption: string | null;
  uploaded_by: string;
  uploaded_at: string;
  file_size: number | null;
  sort_order: number;
}

export interface ReceivingSummary {
  expected_today: number;
  pending_receipt: number;
  received_this_week: number;
  items_received_ytd: number;
  damaged_this_week: number;
}

export interface Commission {
  id: string;
  /** Source order (chemical-sale channel). NULL on job-sourced rows (U8). */
  order_id: string | null;
  /** Source job (application channel, U8). NULL on order-sourced rows. */
  job_id: string | null;
  /** The field_application invoice that minted a job commission (U8) — reversal
   *  and payout-void liveness are generation-precise on this. NULL on order rows. */
  invoice_id: string | null;
  customer_id: string;
  recipient: string;
  recipient_user_id: string | null;
  split_percentage: number;
  commission_amount: number;
  order_profit: number;
  order_date: string;
  order_number: string;
  customer_name: string;
  season: number | null;
  status: 'pending' | 'paid' | 'cancelled';
  paid_date: string | null;
  paid_note: string | null;
  deleted_at: string | null;
  created_at: string;
}

export type NotePriority = 'low' | 'medium' | 'high' | 'urgent';
export type NoteType = 'note' | 'todo' | 'announcement';

export type LinkedEntityType = 'delivery' | 'order' | 'customer' | 'job' | 'purchase_order' | 'quote' | 'invoice' | 'product';

export interface TeamNote {
  id: string;
  title: string;
  content: string | null;
  note_type: NoteType;
  priority: NotePriority;
  is_completed: boolean;
  completed_by: string | null;
  completed_at: string | null;
  due_date: string | null;
  created_by: string;
  assigned_to: string | null;
  is_pinned: boolean;
  deleted_at: string | null;
  deleted_by: string | null;
  last_escalated_at: string | null;
  linked_entity_type: string | null;
  linked_entity_id: string | null;
  created_at: string;
  updated_at: string;
  creator?: Profile;
  assignee?: Profile;
}

export interface ExtendedTeamNote extends TeamNote {
  tags?: Array<{ id: string; name: string; color: string }>;
  comment_count?: number;
  completer?: { full_name: string } | null;
}

export interface TeamNoteAttachment {
  id: string;
  note_id: string;
  file_url: string;
  file_name: string;
  file_type: string;
  file_size_bytes: number;
  uploaded_by: string;
  created_at: string;
}

export interface TeamBoardDelivery {
  id: string;
  delivery_number: string;
  status: string;
  priority: string;
  scheduled_date: string;
  scheduled_time: string | null;
  delivery_address: string | null;
  delivery_notes: string | null;
  customer_name: string;
  driver_name: string | null;
  assigned_driver: string | null;
  item_count: number;
}

export interface TeamBoardDeliveryData {
  today: TeamBoardDelivery[];
  tomorrow: TeamBoardDelivery[];
  unassigned_count: number;
  today_total: number;
}

export interface YesterdayRecapData {
  completed: Array<{
    id: string;
    delivery_number: string;
    customer_name: string;
    driver_name: string | null;
    completed_at: string;
    item_count: number;
    has_issues: boolean;
  }>;
  issues: Array<{
    id: string;
    delivery_number: string;
    customer_name: string;
    driver_name: string | null;
    issue_type: string;
    issue_description: string | null;
  }>;
  summary: {
    total_completed: number;
    total_with_issues: number;
    total_cancelled: number;
  };
}

export interface TeamNoteComment {
  id: string;
  note_id: string;
  content: string;
  created_by: string;
  deleted_at: string | null;
  deleted_by: string | null;
  parent_id: string | null;
  mentions: string[];
  created_at: string;
  updated_at: string;
  creator?: Profile;
}

export interface ActivityFeedItem {
  id: string;
  event_type: string;
  description: string;
  performed_by: string;
  related_entity_type: string | null;
  related_entity_id: string | null;
  customer_id: string | null;
  created_at: string;
  performer?: Profile;
}

export interface Notification {
  id: string;
  user_id: string;
  title: string;
  message: string;
  notification_type: string;
  is_read: boolean;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
}

export interface AppSetting {
  id: string;
  setting_key: string;
  setting_value: string;
  description: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface IngredientMap {
  id: string;
  branded_ingredient: string;
  generic_product_id: string | null;
  generic_has_bulk: boolean;
  fallback_branded_product: string | null;
  notes: string | null;
  generic_product?: Product;
}

export interface UnitConversion {
  id: string;
  unit: string;
  factor_oz: number;
  unit_type: UnitType;
  notes: string | null;
}

export type BlendTicketStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'needs_review';
export type BlendTicketReviewStatus = 'unreviewed' | 'approved' | 'rejected';
export type BlendTicketOrderLinkStatus = 'unlinked' | 'linked';
export type BlendTicketPaymentStatus = 'unbilled' | 'billed' | 'prepaid' | 'no_charge';
export type BlendTicketSource = 'ocr' | 'manual' | 'digital';

export interface BlendTicket {
  id: string;
  ticket_number: string;
  uploaded_by: string;
  customer_id: string | null;
  upload_date: string;
  ticket_date: string | null;
  status: BlendTicketStatus;
  review_status: BlendTicketReviewStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  ocr_confidence_score: number;
  raw_ocr_text: string | null;
  driver_name: string | null;
  tank_number: string | null;
  applicator_name: string | null;
  signature_detected: boolean;
  notes: string | null;
  job_number: string | null;
  invoice_number: string | null;
  ticket_time: string | null;
  vehicle_info: string | null;
  mixer_name: string | null;
  field_names: string | null;
  total_acres: number | null;
  application_rate: string | null;
  total_volume: number | null;
  total_volume_unit: string | null;
  season: number | null;
  deleted_at: string | null;
  // Phase 1: Entity FKs (alongside text fields for OCR compat)
  applicator_id: string | null;
  vehicle_id: string | null;
  source: BlendTicketSource;
  // Phase 3: Order linkage
  field_id: string | null;
  salesman_id: string | null;
  order_link_status: BlendTicketOrderLinkStatus;
  payment_status: BlendTicketPaymentStatus;
  job_id: string | null;
  application_service_id: string | null;
  manually_corrected_fields: string[];
  created_at: string;
  updated_at: string;
  uploader?: Pick<Profile, 'id' | 'full_name'> | null;
  reviewer?: Pick<Profile, 'id' | 'full_name'> | null;
  customer?: Pick<Customer, 'id' | 'farm_name'> | null;
  field?: Pick<Field, 'id' | 'field_name'> | null;
  job?: Job;
  salesman?: Pick<Profile, 'id' | 'full_name'> | null;
  applicator?: Profile;
  vehicle?: Vehicle;
  application_service?: ApplicationService;
  images?: BlendTicketImage[];
  products?: BlendTicketProduct[];
  blend_ticket_fields?: BlendTicketField[];
}

export interface BlendTicketProduct {
  id: string;
  blend_ticket_id: string;
  product_id: string | null;
  product_name: string;
  quantity: number;
  unit: string | null;
  lot_number: string | null;
  sequence_order: number;
  confidence_score: number;
  manually_corrected: boolean;
  rate_per_acre: number | null;
  rate_per_acre_unit: string | null;
  unit_cost_cents: number | null;
  unit_price_cents: number | null;
  created_at: string;
  product?: Product;
}

export interface BlendTicketImage {
  id: string;
  blend_ticket_id: string;
  storage_path: string;
  image_url: string;
  file_size: number;
  mime_type: string;
  upload_order: number;
  width: number | null;
  height: number | null;
  created_at: string;
}

// Phase 3: Blend Ticket ↔ Order Linkage
export interface BlendTicketToOrderItem {
  id: string;
  blend_ticket_id: string;
  blend_ticket_product_id: string;
  order_item_id: string;
  order_id: string;
  quantity_applied: number | null;
  notes: string | null;
  created_at: string;
  created_by: string;
  // Joined relations
  order?: Order;
  order_item?: OrderItem;
}

// Phase 1: Per-field tracking for blend tickets
export interface BlendTicketField {
  id: string;
  blend_ticket_id: string;
  field_id: string;
  customer_id: string | null;
  planned_acres: number | null;
  actual_acres: number | null;
  applied_at: string | null;
  applied_by: string | null;
  notes: string | null;
  sort_order: number;
  created_at: string;
  // Joined
  field?: Field;
  customer?: Customer;
  applied_by_profile?: Profile;
}

// Phase 4A: Saved Blend Recipes
export type RecipeType = 'crop_specific' | 'generic';

export interface BlendRecipe {
  id: string;
  name: string;
  description: string | null;
  recipe_type: RecipeType;
  crop_type: string | null;
  timing: string | null;
  created_by: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Joined
  creator?: Profile;
  items?: BlendRecipeItem[];
}

export interface BlendRecipeItem {
  id: string;
  recipe_id: string;
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  sort_order: number;
  notes: string | null;
  // Optional per-unit price (bigint cents) seeded into job_chemicals.price_per_unit_cents
  // by load_recipe_into_job (Phase 4 / migration 20260618230000 — recipe pricing).
  // Defaults 0; only populated once the recipe-editor price UI lands.
  price_per_unit_cents?: number;
  created_at: string;
  // Joined
  product?: Product;
}

// Phase 2: Billing / Invoices

export type InvoiceType = 'chemical_sale' | 'field_application' | 'misc_charge' | 'credit_memo';
export type InvoiceStatus = 'draft' | 'unposted' | 'posted' | 'paid' | 'overdue' | 'voided' | 'cancelled';
export type InvoiceDueDateSource = 'system' | 'explicit' | 'legacy';

export interface Invoice {
  id: string;
  invoice_number: string;
  order_id: string | null;
  blend_ticket_id: string | null;
  customer_id: string;
  invoice_type: InvoiceType;
  status: InvoiceStatus;
  season: number;
  salesman_id: string | null;
  created_by: string;

  // Financial (stored in cents)
  total_amount_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  /** Credit-memo application lever (mig 20260711020000). Non-negative on both row types;
   * on a credit_memo it is credit applied OUT, on a real invoice it is credit received IN.
   * Written only by apply_credit_memo_to_invoice / reverse_credit_memo_application. */
  credit_applied_cents: number;
  balance_cents: number; // generated column (5 levers, type-aware: credit adds on memos, subtracts on invoices)

  // Posting workflow
  posted_by: string | null;
  posted_at: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;
  /** Ship-now/price-later (sell-side #2): true = invoice for a still-unpriced
   * rush order. CREATION is allowed; post_invoice / post_invoice_group raise
   * PRICING_INCOMPLETE until price_order finalizes and clears this. */
  pricing_pending: boolean;

  // Metadata
  invoice_date: string;
  due_date: string | null;
  /** System dates recalculate from the Chicago posting date; explicit and
   * pre-provenance legacy dates are preserved through post/unpost cycles. */
  due_date_source: InvoiceDueDateSource;
  purchase_order_ref: string | null;
  header_notes: string | null;
  footer_notes: string | null;
  // Field-app parity #33: invoice-level payment terms (free text, printed; distinct
  // from customers.payment_terms — an invoice override) + an internal memo that is
  // saved but NOT printed on the customer copy.
  payment_terms: string | null;
  internal_notes: string | null;
  // #33: owner-entered early-pay "Discount Earned" (bigint cents, default 0/off) and
  // its date. INFORMATIONAL/displayed only — it does NOT reduce the GENERATED
  // balance_cents (the real reduction flows through payments/write-off). Never a formula.
  discount_earned_cents: number;
  discount_date: string | null;
  parent_invoice_id: string | null;

  // Field application context (snapshot from job)
  crop_type: string | null;
  field_names: string[] | null;
  total_acres: number | null;
  applicator_name: string | null;
  // Wave B.1 / P2-1: invoice-level "Applied Info" fields. Free-form text;
  // nullable per Mason's Q9 answer (business-internal, not legally required).
  // temperature_text is named explicitly to disambiguate from the numeric
  // temperature fields on BlendTicket / FieldAppLocation / JobAppliedInfo
  // (Wave B audit B-3 / migration 20260507120000).
  wind_direction: string | null;
  temperature_text: string | null;
  // ChemMan Gap-Closeout #1: structured START/END weather captured on the
  // field-application invoice (mirrors job_applied_records' shape exactly). All
  // nullable — weather auto-fill (Open-Meteo) is a convenience and never gates a
  // save; the legacy wind_direction/temperature_text free-text fields above are
  // preserved alongside these for back-compat. source = 'auto' (fetched) |
  // 'manual' (hand-entered/edited). weather_manual_override flags that the user
  // overrode an auto-filled value (compliance audit — modeled, not measured).
  // Optional (?) because not every invoice query selects them; they are present
  // (nullable) on the field-application invoice editor's `select('*')` load.
  start_temp_f?: number | null;
  start_wind_mph?: number | null;
  start_wind_direction?: string | null;
  start_humidity_pct?: number | null;
  start_weather_time?: string | null; // 'HH:MM' / 'HH:MM:SS'
  start_weather_source?: 'auto' | 'manual' | null;
  end_temp_f?: number | null;
  end_wind_mph?: number | null;
  end_wind_direction?: string | null;
  end_humidity_pct?: number | null;
  end_weather_time?: string | null;
  end_weather_source?: 'auto' | 'manual' | null;
  weather_manual_override?: boolean | null;
  // ChemMan Gap-Closeout #2: diluent / carrier-water RATE per acre (gallons/acre),
  // mirroring the job-side jobs.carrier_rate_gpa. Nullable — optional. The TOTAL
  // diluent (rate x applied acres) is computed for display/PDF, NOT stored, because
  // invoices.total_acres is not reliably written on save. A QUANTITY, never money/cents.
  diluent_rate_gpa?: number | null;
  vehicle_name: string | null;
  application_date: string | null;
  job_id: string | null;
  total_cost_cents: number;

  is_quick_delivery?: boolean;
  write_off_cents: number;
  invoice_group_id: string | null;
  application_service_id: string | null;
  delivery_id: string | null;
  // Per-line split billing (mig 20260720213000, flag-gated/additive). Server-computed
  // suppression flag for a fully-$0 split child: 'suppressed_zero_total' means "record it,
  // show it in the account summary, but do NOT email it" (a paid-in-full invoice at $0 stays
  // 'normal' and emailable). Back-link to the field_app_billing_sets row that produced this
  // child invoice. Both default-neutral until the split feature ships. Optional (?)
  // because the migration is not applied yet and no invoice query selects them today
  // (same convention as the additive weather fields above); the DB column is NOT NULL
  // with default 'normal' once live.
  send_disposition?: 'normal' | 'suppressed_zero_total';
  field_app_billing_set_id?: string | null;

  deleted_at: string | null;
  created_at: string;
  updated_at: string;

  // Relations
  customer?: Customer;
  order?: Order;
  salesman?: Profile;
  items?: InvoiceItem[];
  shares?: InvoiceShare[];
}

/** One application of a credit memo to an open invoice (mig 20260711030000).
 * Immutable/append-only: a reversal stamps reversed_at/by/reason, never deletes.
 * Written only by apply_credit_memo_to_invoice / reverse_credit_memo_application. */
export interface CreditMemoApplication {
  id: string;
  credit_memo_id: string;
  target_invoice_id: string;
  amount_cents: number;
  applied_by: string;
  applied_at: string;
  reversed_at: string | null;
  reversed_by: string | null;
  reversal_reason: string | null;
}

export interface InvoiceItem {
  id: string;
  invoice_id: string;
  order_item_id: string | null;
  product_id: string | null;
  description: string;
  quantity: number;
  unit_price_cents: number;
  extended_cents: number;
  cost_cents: number;
  sort_order: number;
  rate_per_acre: number | null;
  acres: number | null;
  unit_size: string | null;
  rate_unit: string | null;
  total_applied: number | null;
  total_applied_unit: string | null;
  total_applied_gl_lb: number | null;
  gl_lb_unit: string | null;
  epa_registration: string | null;
  product_form: string | null;
  // Field-app parity #25: ChemMan per-line Warehouse (free text) + Vendor
  // (defaults from products.vendor, editable). Informational; never priced.
  warehouse: string | null;
  vendor: string | null;
  is_application_fee: boolean;
  quoted_price_cents: number | null;
  price_source: 'quoted' | 'tier' | 'manual' | null;
  tote_number: string | null;
  notes: string | null;
  // Per-line split billing (mig 20260720213000, additive). When set, this item was
  // produced by a split billing line and its qty/price MUST be read-only in the
  // InvoiceDetail editor (extended_cents is the server-allocated residual — never
  // recompute qty x price for a split line). Optional (?) — additive column, not
  // selected by today's queries; nullable in the DB once live.
  billing_line_id?: string | null;
  // Forward PR #361 ledger fields. Optional until the reviewed migration is
  // applied live and the generated schema artifacts are refreshed.
  return_credit_cogs_cents?: number | null;
  return_credit_source_item_id?: string | null;
  created_at: string;
  updated_at: string;
  product?: Product;
}

// ── Invoice Shares (grower splits for PDF display) ──────────────────────

export interface InvoiceShare {
  id: string;
  invoice_id: string;
  customer_id: string;
  customer_name: string;
  split_percentage: number;
  acres: number | null;
  amount_cents: number;
  is_primary: boolean;
  sort_order: number;
  price_per_acre_cents: number | null;
  pricing_note: string | null;
  created_at: string;
  customer?: Customer;
}

// ── Per-line split billing (migs 20260720213000 / 020000 / 030000) ──────────
// Flag-gated, additive. A "billing set" is one durable field-application billing
// event; it has one server-created "billing line" per chemical/service/flat fee;
// each billing line is allocated across customers into per-line "shares" bound 1:1
// to the invoice_item they produced. Money is bigint cents; split_micro_pct is
// integer micro-percent (100000000 = 100%). Frozen while the parent invoice is
// posted; an append-only snapshot preserves post history across unpost/edit/repost.

export interface FieldAppBillingSet {
  id: string;
  invoice_group_id: string | null;
  source_job_id: string | null;
  created_by: string | null;
  created_at: string;
}

export type FieldAppBillingLineKind = 'chemical' | 'service' | 'fuel_surcharge' | 'flat_fee';

export interface FieldAppBillingLine {
  id: string;
  billing_set_id: string;
  line_kind: FieldAppBillingLineKind;
  product_id: string | null;
  application_service_id: string | null;
  description: string | null;
  source_quantity: number | null;
  source_acres: number | null;
  source_unit_price_cents: number | null;
  source_line_cents: number | null;
  sort_order: number;
  created_at: string;
}

export type SplitBasePriceSource =
  | 'manual' | 'quoted' | 'tier' | 'service_rate' | 'service_default' | 'grower_share' | 'flat';

export interface InvoiceLineShare {
  id: string;
  billing_line_id: string;
  invoice_item_id: string;
  customer_id: string;
  split_mode: 'field_default' | 'custom';
  split_micro_pct: number; // micro-percent, 0..100000000
  allocated_quantity: number | null;
  allocated_acres: number | null;
  base_unit_price_cents: number;
  base_price_source: SplitBasePriceSource;
  price_mode: 'default' | 'override';
  unit_price_cents: number;
  amount_cents: number; // == the child invoice_item.extended_cents (authoritative)
  split_override_reason: string | null;
  price_override_reason: string | null;
  calculation_hash: string;
  vector_hash: string;
  created_by: string;
  created_at: string;
}

export interface InvoiceLineShareSnapshot {
  id: string;
  invoice_id: string;
  billing_line_id: string | null;
  customer_id: string;
  posted_at: string;
  split_micro_pct: number;
  allocated_quantity: number | null;
  allocated_acres: number | null;
  unit_price_cents: number;
  amount_cents: number;
  // Self-contained line identity (Codex round-4) — survives the source rows being deleted on re-save.
  line_kind?: string | null;
  product_id?: string | null;
  application_service_id?: string | null;
  line_description?: string | null;
  // Override/pricing provenance (Codex round-7 P2) — nullable; pre-fix snapshot rows have none.
  base_unit_price_cents?: number | null;
  base_price_source?: string | null;
  split_mode?: string | null;
  price_mode?: string | null;
  split_override_reason?: string | null;
  price_override_reason?: string | null;
  calculation_hash?: string | null;
  vector_hash?: string | null;
  snapshot_reason: string;
  created_at: string;
}

// ── Invoice & Statement PDF Data Types ──────────────────────────────────

export interface InvoicePrintOptions {
  show_shares: boolean;
  show_price_per_acre: boolean;
  show_epa_registration: boolean;
  /**
   * Which printed layout to render (field-app parity #30 — ChemMan "Print" vs
   * "Old Print"). 'current' (default/undefined) = the modern CRX-branded layout;
   * 'legacy' = the denser monochrome "Old Print" format some customers still
   * expect. Money is identical in both — the same InvoicePdfData feeds each, so
   * Total / Payments / Prepay / Balance Due reconcile regardless of format.
   */
  format?: 'current' | 'legacy';
}

export interface StatementOptions {
  mode: 'summary' | 'detailed';
  show_shares: boolean;
  as_of_date: string;
}

export interface DetailedStatementData {
  customer: {
    id: string;
    farm_name: string;
    contact_name: string | null;
    account_number: string | null;
    email: string | null;
    phone: string | null;
    billing_address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    payment_terms: string | null;
  };
  transactions: DetailedStatementTransaction[];
  aging: {
    current_cents: number;
    days_30_cents: number;
    days_60_cents: number;
    days_90_cents: number;
    over_120_cents: number;
  };
  outstanding_balance_cents: number;
  /** Gross positive invoice balance; open credit memos remain separate by design. */
  open_credit_cents: number;
  /** Gross open invoices less unapplied credit memos; may be negative. */
  net_account_position_cents: number;
  as_of_date: string;
  mode: 'summary' | 'detailed';
}

export interface DetailedStatementTransaction {
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  invoice_type: string;
  status: string;
  days_aged: number;
  description: string;
  crop_type: string | null;
  field_names: string[] | null;
  total_acres: number | null;
  grower_names: string[] | null;
  total_amount_cents: number;
  paid_amount_cents: number;
  prepay_applied_cents: number;
  balance_cents: number;
  items: DetailedStatementItem[];
  shares: InvoiceShare[];
  finance_charge_cents: number;
  net_due_cents: number;
  price_per_acre: number | null;
}

export interface DetailedStatementItem {
  product_name: string;
  epa_registration: string | null;
  rate_per_acre: number | null;
  rate_unit: string | null;
  total_applied: number | null;
  total_applied_unit: string | null;
  total_applied_gl_lb: number | null;
  gl_lb_unit: string | null;
  unit_price_cents: number;
  total_cost_cents: number;
  is_application_fee: boolean;
  quantity: number;
  unit_size: string | null;
  product_form: string | null;
}

// ── Allocation Sets ─────────────────────────────────────────────────────

export interface AllocationSet {
  id: string;
  entity_type: 'order' | 'invoice';
  entity_id: string;
  version: number;
  created_by: string | null;
  is_active: boolean;
  notes: string | null;
  customer_id: string | null;
  total_payment_cents: number;
  total_allocated_cents: number;
  payment_method: string | null;
  reference_number: string | null;
  check_number: string | null;
  payment_date: string | null;
  season: number | null;
  created_at: string;
  updated_at: string;
}

export interface PrepayCredit {
  id: string;
  customer_id: string;
  season: number;
  original_amount_cents: number;
  balance_cents: number;
  payment_method: string | null;
  reference_number: string | null;
  notes: string | null;
  source_type: string | null;
  source_reference: string | null;
  bucket_label: string | null;
  quote_id: string | null; // roadmap #6: earmark a prepay credit to a booking (quote)
  allocation_set_id: string | null; // the payment whose overpayment minted this credit (null for manual credits)
  created_by: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
}

// Roadmap #6(a): per-booking settlement read shape (get_booking_settlement RPC).
// All *_cents are bigint cents (divide by 100 to display). Qty fields are product
// units; locked_price is numeric dollars per unit (the booked weighted-average).
export interface BookingSettlementLine {
  product_id: string;
  product_name: string | null;
  booked_qty: number;
  drawn_qty: number;
  remaining_qty: number;
  locked_price: number;
  current_price?: number;
  booked_cents: number;
  drawn_cents: number;
  remaining_cents: number;
}

export interface BookingSettlement {
  success: boolean;
  found: boolean;
  quote_id: string;
  quote_number?: string;
  customer_id?: string;
  status?: string;
  season?: number | null;
  is_planned?: boolean;
  lines?: BookingSettlementLine[];
  booked_cents?: number;
  drawn_cents?: number;
  remaining_cents?: number;
  prepay_earmarked_cents?: number;
  prepay_applied_cents?: number;
  prepay_remaining_cents?: number;
}

// Roadmap #6(d): one summary row per open booking (get_open_booking_rollover RPC).
// All *_cents are bigint cents (÷100 to display).
export interface BookingRolloverRow {
  quote_id: string;
  quote_number: string;
  customer_id: string;
  customer_name: string | null;
  status: string;
  season: number | null;
  booked_cents: number;
  drawn_cents: number;
  remaining_cents: number;
  prepay_earmarked_cents: number;
  prepay_remaining_cents: number;
  prepay_applied_cents: number;
}

export interface PrepayApplication {
  id: string;
  prepay_credit_id: string;
  invoice_id: string;
  applied_amount_cents: number;
  applied_by: string | null;
  applied_at: string;
}

// Phase 1: Fields

export interface Field {
  id: string;
  customer_id: string;
  field_name: string;
  legal_description: string | null;
  county: string | null;
  state: string | null;
  total_acres: number | null;
  // Two-acre model (migration 20260623120000): measured = server-computed from the
  // boundary; override = human-typed billable acres (survives a redraw). Billable acres =
  // override_acres ?? measured_acres ?? total_acres. acres_source is GENERATED (never written).
  measured_acres?: number | null;
  override_acres?: number | null;
  acres_source?: 'measured' | 'override' | 'legacy';
  fsa_farm_number: string | null;
  fsa_tract_number: string | null;
  fsa_field_number: string | null;
  crop_type: string | null;
  soil_type: string | null;
  irrigation: boolean;
  notes: string | null;
  is_active: boolean;
  centroid_geojson?: string | null;
  boundary_geojson?: string | null;
  parent_field_id?: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
  billing_defaults?: FieldBillingDefault[];
}

export type FieldObstacleKind =
  | 'oil_well'
  | 'windmill'
  | 'tower'
  | 'tree_line'
  | 'power_line'
  | 'waterway'
  | 'other';

export interface FieldObstacle {
  id: string;
  field_id: string;
  kind: FieldObstacleKind;
  label: string | null;
  point_geojson: { type: 'Point'; coordinates: [number, number] };
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Result shapes for the two-acre RPCs (migration 20260623130000)
export interface SetFieldBoundaryResult {
  field_id: string;
  measured_acres: number;
  billable_acres: number;
  acres_source: 'measured' | 'override';
}

export interface SetFieldOverrideAcresResult {
  field_id: string;
  override_acres: number | null;
  billable_acres: number | null;
  acres_source: 'measured' | 'override' | 'legacy';
}

export interface OverlappingField {
  field_id: string;
  field_name: string | null;
  customer_id: string | null;
  measured_acres: number | null;
  overlap_pct: number;
}

export interface FieldBillingDefault {
  id: string;
  field_id: string;
  customer_id: string;
  split_pct: number;
  is_primary: boolean;
  notes: string | null;
  price_override_cents: number | null;
  pricing_note: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
}

// Field Dashboard (from get_field_dashboard RPC)
export interface FieldDashboardBillingDefault extends FieldBillingDefault {
  customer_name: string;
}

export interface FieldDashboardField extends Omit<Field, 'billing_defaults'> {
  customer_name: string;
  billing_defaults: FieldDashboardBillingDefault[];
}

export interface FieldDashboardResponse {
  field: FieldDashboardField;
  season_summary: FieldSeasonSummary;
  application_records: FieldApplicationRecord[];
  recent_activity: FieldActivityEntry[];
}

export interface FieldSeasonSummary {
  total_applications: number;
  total_acres_treated: number;
  distinct_products: number;
  season: number;
}

export interface FieldApplicationRecord {
  id: string;
  record_number: string;
  application_date: string;
  application_time: string | null;
  total_acres: number | null;
  total_volume: number | null;
  total_volume_unit: string | null;
  product_data: Array<{
    product_name?: string;
    product_id?: string;
    rate?: number;
    rate_unit?: string;
    quantity?: number;
    unit?: string;
  }>;
  weather_conditions: {
    wind_speed?: number;
    wind_direction?: string;
    temperature?: number;
    humidity?: number;
  } | null;
  notes: string | null;
  source_type: 'job' | 'blend_ticket';
  source_id: string;
  applicator_name: string;
  vehicle_name: string | null;
}

export interface FieldActivityEntry {
  id: string;
  event_type: string;
  description: string;
  performed_by_name: string;
  created_at: string;
}

// Field Import
export interface ParsedImportField {
  index: number;
  field_name: string;
  customer_id: string | null;
  legal_description: string | null;
  county: string | null;
  state: string | null;
  total_acres: number | null;
  crop_type: string | null;
  fsa_farm_number: string | null;
  fsa_tract_number: string | null;
  fsa_field_number: string | null;
  soil_type: string | null;
  irrigation: boolean;
  notes: string | null;
  boundary_geojson: object;
  // Full original geometry (multi-part preserved) sent to set_field_boundary on save;
  // boundary_geojson above is the largest-ring display polygon. (migration 20260623130000)
  full_boundary_geojson: object;
  full_acres: number;   // geodesic acres of the FULL geometry — pre-checked against the band on import
  // The acreage the FILE itself reported (the mapped "Acres" attribute), if any. On import this
  // becomes the field's billable override (owner choice 2026-06-23) so the bill matches the
  // grower's own records; measured map acres (full_acres) are kept underneath for the divergence
  // check. null when the file carried no acreage column → the field bills on the measured acres.
  stated_acres: number | null;
  centroid_geojson: object;
  calculated_acres: number;
  raw_properties: Record<string, unknown>;
  errors: string[];
  isValid: boolean;
}

// Phase 5: Inventory Enhancements

export interface Warehouse {
  id: string;
  name: string;
  code: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  is_active: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export type CycleCountStatus = 'in_progress' | 'completed' | 'cancelled';

export interface CycleCount {
  id: string;
  count_number: string;
  warehouse: string;
  status: CycleCountStatus;
  initiated_by: string;
  completed_by: string | null;
  notes: string | null;
  started_at: string;
  completed_at: string | null;
  created_at: string;
  // Joined
  initiator?: Profile;
  completer?: Profile;
  items?: CycleCountItem[];
}

export interface CycleCountItem {
  id: string;
  cycle_count_id: string;
  product_id: string;
  inventory_id: string | null;
  expected_qty: number;
  counted_qty: number | null;
  variance: number | null;
  variance_pct: number | null;
  is_counted: boolean;
  counted_by: string | null;
  counted_at: string | null;
  notes: string | null;
  created_at: string;
  // Joined
  product?: Product;
}

// Phase 6: Returns / RMA

export type ReturnStatus = 'requested' | 'approved' | 'received' | 'credited' | 'rejected' | 'cancelled';
export type ReturnReason = 'defective' | 'damaged' | 'wrong_product' | 'overstock' | 'expired' | 'other';
export type ReturnItemCondition = 'unopened' | 'opened' | 'damaged' | 'expired';

export interface Return {
  id: string;
  return_number: string;
  order_id: string | null;
  customer_id: string;
  status: ReturnStatus;
  reason: ReturnReason;
  reason_notes: string | null;
  requested_by: string;
  approved_by: string | null;
  received_by: string | null;
  total_credit_cents: number;
  credit_invoice_id: string | null;
  credited_by: string | null;
  requested_at: string;
  approved_at: string | null;
  received_at: string | null;
  credited_at: string | null;
  // Wave B.2 / P4-4: cancellation triplet, mirrors approved/received/credited.
  cancelled_at: string | null;
  cancelled_by: string | null;
  cancellation_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  // Joined
  customer?: Customer;
  order?: Order;
  requester?: Profile;
  items?: ReturnItem[];
}

export interface ReturnItem {
  id: string;
  return_id: string;
  order_item_id: string | null;
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  unit_price_cents: number;
  extended_cents: number;
  condition: ReturnItemCondition;
  restock: boolean;
  restocked: boolean;
  sort_order: number;
  notes: string | null;
  created_at: string;
  // Joined
  product?: Product;
}

// Phase 7: Compliance, Rebates, AR Aging

export type LicenseType = 'private' | 'commercial' | 'public';

export interface ApplicatorLicense {
  id: string;
  /** Customer-held license (RUP buyer). NULL when staff-held. */
  customer_id: string | null;
  /** Staff-held license (internal applicator profile). NULL when customer-held. */
  profile_id: string | null;
  license_number: string;
  license_type: LicenseType;
  holder_name: string;
  state: string;
  issued_date: string | null;
  expiry_date: string;
  certification_categories: string[] | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  customer?: Customer;
}

export type RebateType = 'per_unit' | 'percentage' | 'volume_tier' | 'flat';
export type RebateProgramStatus = 'active' | 'expired' | 'closed';
export type RebateClaimStatus = 'pending' | 'submitted' | 'approved' | 'paid' | 'rejected';

export interface RebateProgram {
  id: string;
  program_name: string;
  manufacturer: string;
  season: number;
  product_id: string | null;
  rebate_type: RebateType;
  rebate_amount: number;
  rebate_pct: number | null;
  min_volume: number | null;
  max_volume: number | null;
  start_date: string;
  end_date: string;
  status: RebateProgramStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  product?: Product;
}

export interface RebateClaim {
  id: string;
  program_id: string;
  order_id: string | null;
  customer_id: string | null;
  product_id: string | null;
  claim_number: string;
  quantity: number;
  claim_amount_cents: number;
  status: RebateClaimStatus;
  submitted_date: string | null;
  approved_date: string | null;
  paid_date: string | null;
  paid_amount_cents: number | null;
  manufacturer_ref: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  program?: RebateProgram;
  order?: Order;
  customer?: Customer;
  product?: Product;
}

export interface ARAgingRow {
  customer_id: string;
  farm_name: string;
  current_amount: number;
  days_30: number;
  days_60: number;
  days_90: number;
  over_90: number;
  total_outstanding: number;
}

export interface CustomerStatementRow {
  transaction_date: string;
  transaction_type: string;
  reference_number: string;
  description: string;
  amount_cents: number;
  running_balance: number;
}

export interface SeasonComparisonRow {
  metric: string;
  season_a_val: number;
  season_b_val: number;
  change_pct: number | null;
}

// Sprint 7: Vehicles

export type VehicleType = 'ground' | 'air';
export type VehicleStatus = 'active' | 'inactive' | 'maintenance';

export interface Vehicle {
  id: string;
  vehicle_name: string;
  vehicle_type: VehicleType;
  category: string | null;
  capacity_gallons: number | null;
  capacity_unit: string | null;
  registration: string | null;
  status: VehicleStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Application Services (custom application pricing per vehicle/service)

// cost_per_acre_cents is NOT on this interface. Migration 20260729015706 revoked
// that column from the `authenticated` DB role, so it never arrives on an ordinary
// table read or on an embedded `application_service` relation — only admins can
// reach it, and only through admin_get_application_service_costs. A type that
// promised the field would be lying to every one of those call sites.
export interface ApplicationService {
  id: string;
  name: string;
  vehicle_id: string | null;
  default_rate_per_acre_cents: number;
  is_active: boolean;
  sort_order: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  vehicle?: Vehicle;
}

// The admin-only shape: a service row with the internal cost merged back in from
// admin_get_application_service_costs. Use this ONLY where that RPC was called.
//
// `null` means "the cost could not be read" — the table read and the cost RPC are
// two separate calls and the second can fail on its own (a non-admin, or a build
// deployed before the migration that creates the RPC). That is NOT the same fact
// as a cost of zero, and the difference is expensive: rendering or exporting an
// unread cost as $0.00 puts a fabricated 100%-margin number in an admin's CSV or
// PDF, and on the detail page it would be written back over the real cost on the
// next unrelated save. Render it as "-", never as a figure.
export interface ApplicationServiceWithCost extends ApplicationService {
  cost_per_acre_cents: bigint | null;
}

export interface CustomerApplicationRate {
  id: string;
  customer_id: string;
  application_service_id: string;
  rate_per_acre_cents: number;
  season: number;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  customer?: Customer;
  application_service?: ApplicationService;
}

// Sprint 7: Application Records

export interface ApplicationProduct {
  product_id: string;
  product_name: string;
  quantity: number;
  unit: string;
  rate_per_acre: number | null;
  rate_unit: string | null;
  epa_registration: string | null;
  is_rup: boolean;
}

export interface WeatherConditions {
  wind_speed: number | null;
  wind_direction: string | null;
  temperature: number | null;
  humidity: number | null;
}

export interface ApplicationRecord {
  id: string;
  record_number: string;
  source_type: 'job' | 'blend_ticket';
  source_id: string;
  customer_id: string;
  applicator_id: string | null;
  /** U10 (#106b, 2026-07-06) — as-of-application snapshots; profiles rows mutate but the legal record must not. */
  applicator_name: string | null;
  applicator_license_number: string | null;
  /** DEPRECATED — single-field anchor. Phase 2 (2026-04-30): multi-field detail lives in application_record_fields. */
  field_id: string | null;
  application_date: string;
  application_time: string | null;
  product_data: ApplicationProduct[];
  total_acres: number | null;
  total_volume: number | null;
  total_volume_unit: string | null;
  vehicle_id: string | null;
  weather_conditions: WeatherConditions | null;
  notes: string | null;
  season: number | null;
  invoice_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  customer?: Customer;
  applicator?: Profile;
  field?: Field;
  vehicle?: Vehicle;
  /** Phase 2 (2026-04-30) — per-field rows for multi-field jobs. */
  application_record_fields?: ApplicationRecordField[];
}

// Phase 2 (2026-04-30): per-field rows for multi-field application records.
// One application_records row + N application_record_fields rows; field_id on
// the parent is the legacy single-field anchor (first field of the job).
export interface ApplicationRecordField {
  id: string;
  application_record_id: string;
  field_id: string;
  acres: number;
  sort_order: number;
  created_at: string;
  // Joined
  field?: Field;
}

// B1 Lot Capture & Trace (2026-06-22): one row per (application record, product, lot).
// Multiple lots per product allowed. Written ONLY via set_application_record_lots /
// create_application_record_from_blend_ticket (RPC-only — direct writes are RLS-denied).
// Table application_record_lots (migration 20260622170000); no updated_at (rows are replaced).
export interface ApplicationRecordLot {
  id: string;
  application_record_id: string;
  product_id: string;
  lot_number: string;
  /** Set when the lot was chosen from a received lot; null if free-typed. */
  source_receiving_record_id: string | null;
  /** Informational "how much from this lot" — NOT inventory math. >= 0 or null. */
  quantity_from_lot: number | null;
  unit: string | null;
  notes: string | null;
  created_at: string;
  created_by: string | null;
}

// Input entry for set_application_record_lots(p_lots jsonb). The RPC validates each
// product_id is on the record, any source_receiving_record_id matches the product+lot,
// rejects blank lots and duplicate (product, normalized-lot) pairs.
export interface ApplicationRecordLotInput {
  product_id: string;
  lot_number: string;
  source_receiving_record_id?: string | null;
  quantity_from_lot?: number | null;
  unit?: string | null;
  notes?: string | null;
}

// set_application_record_lots return shape.
export interface SetApplicationRecordLotsResult {
  success: boolean;
  count: number;
}

// get_recent_lots_for_product return row — the application-time suggestion dropdown.
// receiving_record_id lets the editor save source_receiving_record_id so the receipt link
// (and the RPC's provenance validation) is preserved when a suggested lot is chosen.
export interface RecentLotForProduct {
  lot_number: string;
  last_received_at: string;
  receiving_record_id: string;
  source: string;
}

// get_lot_application_trace return row — the recall / compliance lookup (one row per
// application×lot). field_names falls back to the legacy application_records.field_id.
export interface LotApplicationTraceRow {
  application_record_id: string;
  record_number: string;
  product_id: string;
  product_name: string | null;
  lot_number: string;
  quantity_from_lot: number | null;
  unit: string | null;
  application_date: string;
  customer_id: string | null;
  customer_name: string | null;
  applicator_id: string | null;
  applicator_name: string | null;
  field_names: string | null;
  invoice_id: string | null;
  source_receiving_record_id: string | null;
}

// Phase 2 (2026-04-30): start_job RPC return shape.
export interface StartJobResult {
  job_id: string;
  status: 'in_progress';
  started_at: string | null;
  already_started: boolean;
}

// Phase 2/3 (2026-04-30): complete_job RPC return shape.
//   - Phase 2 added field_count (per-field application_record_fields rows)
//   - Phase 3 added short_stock_count (chemicals where inventory went negative
//     and the inventory_transactions row was tagged requires_review = true)
export interface CompleteJobResult {
  success: boolean;
  job_id: string;
  application_record_id: string;
  record_number: string;
  field_count: number;
  short_stock_count: number;
}

// Sprint 8: Job Scheduling

export type JobStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled' | 'invoiced';

export interface Job {
  id: string;
  job_number: string;
  customer_id: string;
  status: JobStatus;
  job_date: string;
  scheduled_time: string | null;
  applicator_id: string | null;
  vehicle_id: string | null;
  recipe_id: string | null;
  notes: string | null;
  tags: string[] | null;
  batch_id: string | null;
  season: number | null;
  total_acres: number | null;
  total_cost_cents: number;
  total_price_cents: number;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  estimated_hours: number | null;
  invoice_id: string | null;
  quote_id: string | null;
  quote_section_id: string | null;
  /** U8 (#99, 2026-07-06): commission split snapshot copied from the quote at
   *  scheduling — read by transfer_job_to_invoice to mint application-channel
   *  commissions (chemical-line profit only). */
  commission_split: CommissionSplit | null;
  /** Phase 4 (2026-04-30): drives per-acre service fee on transfer_job_to_invoice. */
  application_service_id: string | null;
  // Field-app parity #1 (2026-06-24): ChemMan scheduling + memo fields.
  call_date: string | null;
  date_proposed: string | null;
  time_proposed: string | null;
  schedule_date: string | null;
  date_expires: string | null;
  consultant_id: string | null;
  loader_comment: string | null;
  additional_info: string | null;
  /** Internal Job/Invoice memo — NEVER printed on customer-facing docs. */
  internal_memo: string | null;
  /** Field-app parity #10: carrier (water/spray) gallons per acre. Spray volume =
   *  total_acres × carrier_rate_gpa drives the loader-worksheet loads count. Not money. */
  carrier_rate_gpa: number | null;
  /** Field-app parity #10: optional per-job loader tank-capacity override (gallons).
   *  When set, wins over the assigned vehicle's capacity_gallons. Not money. */
  loader_tank_capacity: number | null;
  /** Acres treated so far (0 until the as-applied sections land). */
  applied_acres: number;
  /** GENERATED = GREATEST(total_acres - applied_acres, 0). Read-only. */
  remaining_acres: number | null;
  /** Set by save_job to the editing actor (ChemMan "Updated By" column). */
  updated_by: string | null;
  /** Stamped when the WPS notice / applicator printout is generated. */
  printed_at: string | null;
  /** Field-app parity #9: profile who generated the most recent printout
   *  (resolve the name via profile_public_view). Companion to printed_at. */
  last_printed_by: string | null;
  /** Field-app parity #6: nullable FK to a ground crew (filterable job attribute). */
  ground_crew_id: string | null;
  /** Field-app parity #3: nullable FK to a named job batch. The OLD free-text
   *  batch_id label is separate and unchanged. */
  batch_ref: string | null;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
  // Joined
  customer?: Customer;
  applicator?: Profile;
  vehicle?: Vehicle;
  recipe?: BlendRecipe;
  job_fields?: JobField[];
  job_chemicals?: JobChemical[];
  job_field_shares?: JobFieldShare[];
  applied_info?: JobAppliedInfo;
  /** Field-app parity #4: colored tags assigned to this job (via job_tag_assignments). */
  job_tags?: JobTag[];
}

// Field-app parity #4 (2026-06-24): color-coded job tags.
// A reusable tag definition (name + hex color). Distinct from team-note tags
// (note_tags) — these are for the Job Schedule list. The dead jobs.tags text[]
// column is NOT used.
export interface JobTag {
  id: string;
  name: string;
  /** Hex color, e.g. '#3b82f6'. DB-constrained to ^#[0-9A-Fa-f]{6}$. */
  color: string;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** Many-to-many link row between a job and a tag. */
export interface JobTagAssignment {
  job_id: string;
  tag_id: string;
  created_at: string;
}

// Field-app parity #3 (2026-06-24): job batches.
// A NAMED batch groups a set of jobs so the office can process/print them as
// one unit. A job belongs to at most one batch via jobs.batch_ref (a separate
// column from the OLD free-text jobs.batch_id label, which is unchanged).
export interface JobBatch {
  id: string;
  name: string;
  description: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

// Field-app parity #8 (2026-06-24): per-user, per-list saved view config.
// One row per (user_id, list_key). `settings` is an opaque jsonb blob whose
// shape the frontend owns (e.g. visible-column ids + show-completed flag).
// RLS-scoped to the owner (auth.uid() = user_id) — a user reads/writes only
// their own rows.
export interface UserListSettings {
  id: string;
  user_id: string;
  list_key: string;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// Field-app parity #6 (2026-06-24): Ground crews.
// A managed crew (the extra hands on the ground for a job). Surfaced first as a
// FILTERABLE job attribute (ChemMan's "Ground Crews" filter); the Applied-Info
// section (#13) attaches crew/members per application later.
export interface GroundCrew {
  id: string;
  name: string;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/** A person belonging to a ground crew (crew has-many members). */
export interface GroundCrewMember {
  id: string;
  crew_id: string;
  name: string;
  /** Optional link to a system user; null for a typed-name seasonal hand. */
  profile_id: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

// Phase 4 (2026-04-30): compute_application_service_fee RPC result.
// Single source of truth for fee math: customer override → service default → 0.
export interface ComputeApplicationServiceFeeResult {
  rate_per_acre_cents: number;
  total_fee_cents: number;
  cost_per_acre_cents: number;
  total_cost_cents: number;
  source: 'customer_override' | 'service_default' | 'inactive' | 'none';
  service_name: string | null;
}

export interface JobField {
  id: string;
  job_id: string;
  field_id: string;
  acres_to_treat: number | null;
  // Field-app parity #1 (2026-06-24): per-field agronomy.
  planted_acres: number | null;
  crop: string | null;
  strip: string | null;
  pests: string | null;
  sort_order: number;
  // Joined
  field?: Field;
}

/**
 * Field-app parity #1 (2026-06-24): per-job, per-field customer share %.
 * Defaults from field_billing_defaults; section #26 splits a job's cost by these.
 */
export interface JobFieldShare {
  id: string;
  job_id: string;
  field_id: string;
  customer_id: string;
  split_pct: number;
  is_primary: boolean;
  created_at: string;
  // Joined
  customer?: Customer;
}

/**
 * Field-app parity #16 (2026-06-25): a log file / proof document attached to a
 * field job. Bytes live in the PRIVATE `job-attachments` storage bucket at
 * `<job_id>/<uuid>_<filename>`; this row is the catalog. Job-scoped RLS mirrors
 * jobs_select (admin / sales_rep / the assigned applicator). Downloads use signed
 * URLs (the bucket is private).
 */
export interface JobAttachment {
  id: string;
  job_id: string;
  storage_path: string;
  file_name: string;
  file_size: number | null;
  content_type: string | null;
  uploaded_by: string | null;
  uploaded_at: string;
}

/** One saved vehicle/tank loader worksheet scenario for a field job. */
export interface JobLoaderWorksheet {
  id: string;
  job_id: string;
  vehicle_id: string | null;
  capacity_gal: number;
  carrier_rate_gpa: number | null;
  load_balance_mode: 'proportional' | 'full_loads_remainder';
  /** Null means the load acres are auto-computed. */
  per_load_acres: number[] | null;
  /** Zero-based indexes of loads marked complete. */
  loads_done: number[];
  comment: string | null;
  is_selected: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Field-app parity #36 (2026-06-26): a per-LOCATION dispatch record. One current
 * dispatch per job_field (location); a location is dispatched to an applicator OR
 * a crew (never both/neither). Written by the dispatch_job_locations RPC (the
 * 3-step wizard's commit). A job split between two applicators has two rows here
 * with different applicator_ids, so the dispatch board aggregates BOTH assignees.
 */
export interface JobLocationDispatch {
  id: string;
  job_field_id: string;
  job_id: string;
  applicator_id: string | null;
  crew_id: string | null;
  dispatched_at: string;
  dispatch_status: 'dispatched' | 'completed' | 'cancelled';
  dispatched_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface JobChemical {
  id: string;
  job_id: string;
  product_id: string;
  quantity: number;
  unit: string | null;
  rate_per_acre: number | null;
  rate_unit: string | null;
  cost_per_unit_cents: number;
  price_per_unit_cents: number;
  // Field-app parity #1 (2026-06-24): ChemMan chemical extras.
  diluent_rate: number | null;
  rei_hours: number | null;
  phi_days: number | null;
  warehouse: string | null;
  vendor: string | null;
  // #53/#54 (2026-07-06): grower supplied this product — applied but NOT deducted
  // from our inventory and NOT billed (a $0 informational invoice line). It still
  // appears in the application_records legal product_data (flagged customer_supplied).
  customer_supplied: boolean;
  sort_order: number;
  // F06 (2026-09-03): which field the operator TYPED on this line — 'rate' (quantity was
  // derived as rate × acres) or 'qty' (the total was typed and the rate back-solved).
  // null = unknown (rows saved before the column existed, and rows written by the
  // close-quote and recipe paths). The grid re-derives the OTHER side on an acreage change
  // only when this is set; a null row is left exactly as saved. Column added by migration
  // 20260903150000; optional here so a build against the pre-apply schema still types.
  driver?: 'rate' | 'qty' | null;
  // Joined
  product?: Product;
}

// Field-app parity #40: a per-job customer-facing notification log entry. 'pre'
// is the before-application courtesy notice (this section); 'post' is reserved
// for #41 (after-application). One row per recipient (a split-billed job has many
// share customers). A recipient with no email on file is recorded status='failed'
// — surfaced in the log, never silently dropped. Channel is email-only by design.
export type JobNotificationType = 'pre' | 'post';
export type JobNotificationStatus = 'sent' | 'failed';

export interface JobNotification {
  id: string;
  job_id: string;
  notification_type: JobNotificationType;
  customer_id: string | null;
  recipient_email: string | null;
  channel: 'email';
  subject: string | null;
  message: string | null;
  status: JobNotificationStatus;
  /** NULL until the row is confirmed 'sent' (a failed/pending row has no send time). */
  sent_at: string | null;
  sent_by: string | null;
  idempotency_key: string | null;
  created_at: string;
  // Joined (optional)
  customer?: { farm_name: string } | null;
}

export interface JobAppliedInfo {
  id: string;
  job_id: string;
  actual_start_time: string | null;
  actual_end_time: string | null;
  wind_speed: number | null;
  wind_direction: string | null;
  temperature: number | null;
  humidity: number | null;
  actual_gallons_applied: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

// Field-app parity #17: a single as-applied entry on a job. A job can have MANY
// of these — one per pass / day / applicator+vehicle. Applicator and vehicle are
// REAL references (profiles / vehicles), not free text. This row is the anchor
// that Phase-2 sections extend: #18 per-location applied acres (drives
// applied_acres -> jobs.applied_acres), #19 start/end weather, #20 tach hours,
// #21 ground crew. New fields hang off `id`; do not collapse this back to 1:1.
export interface JobAppliedRecord {
  id: string;
  job_id: string;
  applicator_id: string | null;
  vehicle_id: string | null;
  application_date: string; // 'YYYY-MM-DD'
  applied_acres: number | null;
  notes: string | null;
  // Field-app parity #19: START + END weather pair (the spray window). Each set
  // has Time (HH:MM, field-local — date is application_date), Temp (F), Wind
  // Direction (cardinal/free text), Wind mph, Humidity %, and a source flag
  // ('auto' = Open-Meteo pull, 'manual' = hand-entered/edited). All nullable —
  // weather is a convenience capture and never gates a save.
  start_weather_time: string | null; // 'HH:MM' / 'HH:MM:SS'
  start_temp_f: number | null;
  start_wind_direction: string | null;
  start_wind_mph: number | null;
  start_humidity_pct: number | null;
  start_weather_source: 'auto' | 'manual' | null;
  end_weather_time: string | null;
  end_temp_f: number | null;
  end_wind_direction: string | null;
  end_wind_mph: number | null;
  end_humidity_pct: number | null;
  end_weather_source: 'auto' | 'manual' | null;
  // Field-app parity #20: tach (engine-hour meter) readings for the pass.
  // beginning_tach / end_tach are optional numeric readings; net_tach is a
  // GENERATED column = GREATEST(end_tach - beginning_tach, 0) (NULL when either
  // reading is missing) — read-only, never written by the client.
  beginning_tach: number | null;
  end_tach: number | null;
  net_tach: number | null;
  created_by: string | null;
  // Insert-once dedup token for the CREATE path (save_job_applied_record). Set only
  // on a new record; a retried create replays the same key and a partial UNIQUE index
  // collapses it to the first row (no duplicate applied-record). NULL on legacy rows
  // and never set on edit. Not surfaced in the UI.
  idempotency_key: string | null;
  // md5 fingerprint of the create request stamped alongside idempotency_key on a keyed
  // create. On a retried create the server compares it: identical -> replay (dedup);
  // different -> raises APPLIED_RECORD_ALREADY_SAVED_DIFFERENT so a corrected retry
  // surfaces a conflict instead of silently dropping the correction. Internal; not in UI.
  idempotency_request_hash: string | null;
  created_at: string;
  updated_at: string;
}

// Field-app parity #18: per-location applied acres for one as-applied entry.
// Child of job_applied_records. The SUM of these across ALL of a job's entries
// is rolled (by a DB trigger) into jobs.applied_acres, which feeds the GENERATED
// jobs.remaining_acres = GREATEST(total_acres - applied_acres, 0). One row per
// (entry, field). NEVER write jobs.remaining_acres directly.
export interface JobAppliedRecordField {
  id: string;
  application_record_id: string;
  field_id: string;
  applied_acres: number;
  created_at: string;
  updated_at: string;
}

// Field-app parity #21: a ground-crew MEMBER attached to one as-applied entry.
// Link table between job_applied_records (#17) and the ground_crew_members
// catalog (#6). member_id is a live FK (ON DELETE SET NULL) so a member later
// removed from the catalog never erases the legal record of who was on the crew
// that day — member_name_snapshot (NOT NULL) + crew_*_snapshot are captured at
// attach time and persist even after member_id goes NULL. Show the live member
// name when present (handles renames), the snapshot once the member is deleted.
export interface JobAppliedRecordCrew {
  id: string;
  application_record_id: string;
  /** Live FK to the catalog member; NULL once that member is deleted (record survives via the snapshot). */
  member_id: string | null;
  /** Durable name captured at attach time — the legal record of who was present. */
  member_name_snapshot: string;
  crew_id_snapshot: string | null;
  crew_name_snapshot: string | null;
  created_at: string;
  // Joined: the live catalog member (null when deleted) — lets the UI show a
  // renamed member's current name while it still exists.
  member?: { name: string | null; is_active: boolean } | null;
}

// Joined display shape used by the Applied Info tab (record + resolved names +
// its per-location applied-acres detail rows + its ground-crew members).
export interface JobAppliedRecordRow extends JobAppliedRecord {
  applicator?: { full_name: string | null } | null;
  vehicle?: { vehicle_name: string | null; vehicle_type: string | null } | null;
  job_applied_record_fields?: JobAppliedRecordField[];
  // #21: the ground-crew members attached to this entry.
  job_applied_record_crew?: JobAppliedRecordCrew[];
}

// Sprint 9: Report Row Types

export interface LogbookRow {
  [k: string]: unknown;
  record_id: string;
  record_number: string;
  application_date: string;
  application_time: string | null;
  customer_name: string;
  applicator_name: string | null;
  field_name: string | null;
  field_legal_description: string | null;
  total_acres: number | null;
  total_volume: number | null;
  total_volume_unit: string | null;
  vehicle_name: string | null;
  vehicle_type: string | null;
  vehicle_registration: string | null;
  weather_conditions: WeatherConditions | null;
  product_data: ApplicationProduct[];
  invoice_number: string | null;
  season: number | null;
  source_type: string;
  created_at: string;
}

export interface FAALogbookRow extends LogbookRow {
  applicator_license: string | null;
  faa_certificate: string | null;
  field_county: string | null;
  field_state: string | null;
  vehicle_category: string | null;
}

export interface PnLRow {
  [k: string]: unknown;
  line_item: string;
  amount: number;
  pct_of_revenue: number;
}

export interface FieldProfitabilityRow {
  [k: string]: unknown;
  // NULL for the "(unassigned field)" bucket row.
  field_id: string | null;
  field_name: string;
  customer_id: string;
  // LEFT-joined; can be null for the unassigned bucket.
  customer_name: string | null;
  season: string;
  total_acres_applied: number;
  revenue_cents: number;
  cost_cents: number;
  margin_cents: number;
  margin_per_acre_cents: number;
}

export interface GrossSalesRow {
  [k: string]: unknown;
  group_name: string;
  total_revenue: number;
  total_cost: number;
  gross_profit: number;
  margin_pct: number;
  units_sold: number;
  order_count: number;
}

export interface CustomerBalanceRow {
  [k: string]: unknown;
  customer_id: string;
  farm_name: string;
  total_invoiced: number;
  total_paid: number;
  prepay_applied: number;
  outstanding_balance: number;
  open_credit: number;
  invoice_count: number;
  oldest_unpaid_date: string | null;
}

export interface ChemicalHistoryRow {
  [k: string]: unknown;
  transaction_date: string;
  transaction_type: string;
  reference_number: string;
  customer_name: string | null;
  quantity: number;
  unit: string | null;
  unit_price: number;
  total_amount: number;
  notes: string | null;
}

export interface SalesDetailRow {
  [k: string]: unknown;
  order_date: string;
  order_number: string;
  customer_name: string;
  customer_id: string;
  product_name: string;
  product_id: string;
  sku: string;
  category: string;
  quantity: number;
  unit: string;
  unit_price: number;
  total_price: number;
  cost: number;
  profit: number;
  margin_pct: number;
  sales_rep_name: string;
  invoice_number: string | null;
  season: number;
}

export interface SalesSummaryRow {
  [k: string]: unknown;
  group_key: string;
  group_id: string | null;
  total_quantity: number;
  total_revenue: number;
  total_cost: number;
  total_profit: number;
  margin_pct: number;
  order_count: number;
  line_count: number;
}

export interface FarmGroupMember {
  id: string;
  farm_name: string;
  is_parent: boolean;
}

export interface CommissionBalanceRow {
  [k: string]: unknown;
  recipient_id: string | null;
  recipient_name: string;
  total_earned: number;
  total_paid: number;
  outstanding_balance: number;
  pending_count: number;
  paid_count: number;
}

export interface InventoryCostRow {
  [k: string]: unknown;
  product_id: string;
  product_name: string;
  sku: string | null;
  category: string | null;
  vendor: string | null;
  quantity_available: number;
  quantity_prebooked: number;
  net_available: number;
  unit_cost: number;
  total_cost_value: number;
  reorder_point: number;
  below_reorder: boolean;
}

// Sprint 10: Accounting & Commission Payment Types

export interface AccountingPeriod {
  id: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  closed_by: string | null;
  closed_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommissionPayment {
  id: string;
  payment_number: string;
  recipient_id: string;
  total_amount: number;
  status: 'unposted' | 'posted' | 'voided';
  payment_method: string | null;
  reference_number: string | null;
  payment_date: string;
  posted_by: string | null;
  posted_at: string | null;
  notes: string | null;
  season: number | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CommissionPaymentItem {
  id: string;
  commission_payment_id: string;
  commission_id: string;
  amount: number;
  created_at: string;
}

// Sprint 11: Financial Workflow Types

export interface WriteOff {
  id: string;
  invoice_id: string;
  customer_id: string;
  amount_cents: number;
  reason: string;
  approved_by: string | null;
  created_by: string | null;
  reversed_at: string | null;
  reversed_by: string | null;
  reversed_reason: string | null;
  created_at: string;
}

export interface FinanceCharge {
  id: string;
  customer_id: string;
  invoice_id: string | null;
  amount_cents: number;
  charge_rate: number;
  base_amount_cents: number;
  period_start: string;
  period_end: string;
  created_by: string | null;
  created_at: string;
}

export interface CustomerTransactionRow {
  [k: string]: unknown;
  transaction_date: string;
  transaction_type: string;
  reference_number: string | null;
  description: string | null;
  debit_cents: number;
  credit_cents: number;
  running_balance_cents: number;
}

// Sprint 16: Payment Allocation

export interface PaymentAllocationEntry {
  invoice_id: string;
  invoice_number: string;
  invoice_date: string;
  due_date: string | null;
  invoice_type: InvoiceType;
  total_amount_cents: number;
  balance_cents: number;
  days_aged: number;
  allocated_cents: number; // user-editable
}

export interface PaymentAllocationResult {
  success: boolean;
  allocation_set_id: string;
  total_allocated_cents: number;
  prepay_created_cents: number;
  invoices_paid: number;
}

// Sprint 13: Finance Charge Intelligence

export interface FinanceChargePreview {
  customer_id: string;
  customer_name: string;
  account_number: string | null;
  overdue_balance_cents: number;
  charge_rate: number;
  grace_days: number;
  days_overdue: number;
  charge_amount_cents: number;
  finance_charge_enabled: boolean;
  open_credit_cents: number;
}

// Sprint 17: Year-End Customer Summary

export interface YearEndSummaryData {
  customer: {
    id: string;
    farm_name: string;
    contact_name: string | null;
    account_number: string | null;
    email: string | null;
    phone: string | null;
    billing_address: string | null;
    city: string | null;
    state: string | null;
    zip: string | null;
    assigned_tier: number;
    payment_terms: string | null;
  };
  season: number;
  season_start: string;
  season_end: string;
  financial: {
    total_invoiced_cents: number;
    total_paid_cents: number;
    prepay_applied_cents: number;
    outstanding_balance_cents: number;
    invoice_count: number;
  };
  product_usage: YearEndProductUsage[];
  acreage: {
    total_acres: number;
    by_crop: Array<{ crop_type: string; acres: number }>;
  };
  invoices: YearEndInvoiceRow[];
  shares: YearEndShareRow[];
  prior_season: {
    total_invoiced_cents: number;
    total_paid_cents: number;
    invoice_count: number;
    total_acres: number;
  } | null;
}

export interface YearEndProductUsage {
  category: string;
  product_name: string;
  epa_registration: string | null;
  total_quantity: number;
  unit_size: string | null;
  avg_rate_per_acre: number | null;
  rate_unit: string | null;
  total_acres_treated: number;
  total_cost_cents: number;
  total_applied: number;
  total_applied_unit: string | null;
  total_applied_gl_lb: number;
  gl_lb_unit: string | null;
  is_application_fee: boolean;
}

export interface YearEndInvoiceRow {
  invoice_number: string;
  invoice_date: string;
  invoice_type: string;
  field_names: string[] | null;
  total_acres: number | null;
  crop_type: string | null;
  total_amount_cents: number;
  balance_cents: number;
  status: string;
}

export interface YearEndShareRow {
  invoice_number: string;
  field_names: string[] | null;
  share_customer_name: string;
  split_percentage: number;
  acres: number | null;
  amount_cents: number;
  price_per_acre_cents: number | null;
  pricing_note: string | null;
}

// ── Accounts Payable ──────────────────────────────────────────────

export interface Vendor {
  id: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  default_payment_terms: string | null;
  default_payment_terms_days: number | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export type VendorBillStatus = 'unpaid' | 'partially_paid' | 'paid' | 'voided';

export interface VendorBill {
  id: string;
  vendor_id: string;
  purchase_order_id: string | null;
  bill_number: string;
  bill_date: string;
  due_date: string;
  payment_terms: string | null;
  subtotal_cents: number;
  adjustment_cents: number;
  total_cents: number;
  paid_cents: number;
  balance_cents: number; // GENERATED ALWAYS as (total_cents - paid_cents) — read-only
  status: VendorBillStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  // Joined
  vendor?: Vendor;
  purchase_order?: PurchaseOrder;
}

export interface VendorPayment {
  id: string;
  vendor_bill_id: string;
  payment_date: string;
  amount_cents: number;
  payment_method: string | null;
  reference_number: string | null;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  voided_at: string | null;
  voided_by: string | null;
  void_reason: string | null;
  // Joined
  creator?: Profile;
}

export interface APAgingRow {
  [k: string]: unknown;
  vendor_id: string;
  vendor_name: string;
  current_amount: number;
  days_1_30: number;
  days_31_60: number;
  days_61_90: number;
  over_90: number;
  total_outstanding: number;
  bill_count: number;
}

export interface APDashboardSummary {
  total_owed_cents: number;
  due_this_week_cents: number;
  due_this_week_count: number;
  due_this_month_cents: number;
  overdue_cents: number;
  overdue_count: number;
  unpaid_count: number;
  total_bills: number;
  paid_this_month_cents: number;
}

export interface RUPSalesRecord {
  [k: string]: unknown;
  id: string;
  invoice_id: string;
  invoice_item_id: string | null;
  order_id: string | null;
  customer_id: string;
  product_id: string;
  sale_date: string;
  product_name: string;
  epa_registration: string | null;
  quantity: number;
  unit: string;
  unit_price_cents: number | null;
  total_cents: number | null;
  buyer_name: string;
  buyer_certification_number: string | null;
  buyer_certification_type: string | null;
  buyer_certification_expiry: string | null;
  signal_word: string | null;
  compliance_status: 'compliant' | 'warning' | 'non_compliant';
  compliance_notes: string | null;
  season: number | null;
  invoice_number?: string;
  created_at: string;
}

// ── Quick Receive ─────────────────────────────────────────────────

export interface QuickReceiveItem {
  key: string;
  product_id: string;
  product_name: string;
  sku: string | null;
  quantity: number;
  condition: ReceivingCondition;
  lot_number: string;
  notes: string;
}

export interface QuickReceiveAllocation {
  po_item_id: string;
  purchase_order_id: string;
  po_number: string;
  po_vendor: string;
  unit_cost: number;
  quantity_allocated: number;
  po_remaining_before: number;
  po_remaining_after: number;
  unit_size: string | null;
}

export interface QuickReceiveMatchResult {
  product_id: string;
  product_name: string;
  quantity_requested: number;
  quantity_allocated: number;
  quantity_unmatched: number;
  has_multiple_costs: boolean;
  lot_number: string | null;
  allocations: QuickReceiveAllocation[];
}

// ── Email Infrastructure ─────────────────────────────────────────────

export type EmailType =
  | 'invoice'
  | 'statement'
  | 'order_confirmed'
  | 'delivery_completed'
  | 'quote'
  | 'ar_reminder'
  | 'low_stock_alert'
  | 'month_end_close'
  // Field-app parity #40: pre-application customer notice (matches the DB
  // email_type enum value; the send-email edge allow-list entry is prepared,
  // its deploy gated for Mason).
  | 'pre_application_notice';

export interface EmailLog {
  id: string;
  customer_id: string | null;
  recipient_email: string;
  email_type: EmailType;
  subject: string;
  html_body: string | null;
  attachment_name: string | null;
  resend_message_id: string | null;
  status: 'pending' | 'sent' | 'failed' | 'bounced';
  error_message: string | null;
  idempotency_key: string | null;
  created_by: string | null;
  created_at: string;
}

// ── Financial Dashboard Margin Alerts ────────────────────────────────

export interface BottomProduct {
  product_name: string;
  total_revenue: number;
  total_cost: number;
  margin_pct: number;
  units_sold: number;
}

export interface BottomCustomer {
  farm_name: string;
  total_revenue: number;
  total_cost: number;
  margin_pct: number;
  order_count: number;
}

export interface MonthlyMargin {
  month: string;
  revenue: number;
  cost: number;
  margin_pct: number;
}

// ── Global Search ───────────────────────────────────────────────────

export interface CustomerSummary {
  ar_balance_cents: number;
  order_count: number;
  delivery_count: number;
  credit_tier: number;
  last_activity: string | null;
}

export interface ActionQueueCategory {
  items: ActionQueueItem[];
  label: string;
  path: string;
}

export interface ActionQueueItem {
  id: string;
  primary_text: string;
  secondary_text: string;
  days_overdue?: number;
  days_until_expiry?: number;
  amount_cents?: number;
  current_qty?: number;
  reorder_point?: number;
  invoice_number?: string;
  scheduled_date?: string;
}

// Field Application Workflow V2

export interface FieldAppLocation {
  id: string;
  invoice_id: string | null;
  job_id: string | null;
  invoice_group_id: string | null;
  field_id: string;
  map_number: number | null;
  total_acres: number | null;
  planted_acres: number | null;
  applied_acres: number | null;
  crop_type: string | null;
  wind_direction: string | null;
  sort_order: number;
  created_at: string;
  // Joined
  field?: Field;
}

export interface FieldAppLocationShare {
  id: string;
  location_id: string;
  customer_id: string;
  split_pct: number;
  acres: number | null;
  amount_cents: number;
  created_at: string;
  // Joined
  customer?: Customer;
}

export interface CustomerShareResult {
  customer_id: string;
  customer_name: string;
  is_primary: boolean;
  total_acres: number;
  split_pct: number;
}

// ── Phase 1 (2026-04-29): per-field per-customer detail returned by
//    derive_customer_shares_from_fields(uuid[], jsonb)
//    See: supabase/migrations/20260429140635_field_app_workflow_phase1.sql

export interface DeriveCustomerSharesRow {
  field_id: string;
  field_name: string;
  customer_id: string;
  customer_name: string;
  is_primary: boolean;
  split_pct: number;
  share_acres: number;
  price_override_cents: number | null;
  pricing_note: string | null;
  tier: number | null;
  field_total_acres: number | null;
  field_applied_acres: number;
  used_fallback: boolean;
}

export interface DeriveCustomerSharesCustomer {
  customer_id: string;
  customer_name: string;
  is_primary: boolean;
  total_share_acres: number;
  overall_split_pct: number;
  tier: number | null;
  has_override: boolean;
}

export interface DeriveCustomerSharesResult {
  rows: DeriveCustomerSharesRow[];
  customers: DeriveCustomerSharesCustomer[];
  total_applied_acres: number;
  field_count: number;
  fallback_used_field_ids: string[];
}

// ── Phase 1: save_field_app_invoice and create_invoice_from_blend_ticket
//    return shape standardized to { invoice_ids, invoice_group_id }.
export interface FieldAppInvoiceResult {
  invoice_ids: string[];
  invoice_group_id: string | null;
}

// ── Phase 1: post_invoice_group return shape
export interface PostInvoiceGroupResult {
  posted_invoice_ids: string[];
  invoice_group_id: string;
  total_posted_cents: number;
  member_count: number;
}

// ── Phase 1: preview_field_app_invoice_split return shape
export interface PreviewFieldAppSplitLine {
  // #32: 'fuel_surcharge' = the owner-configured fuel surcharge line (only present
  // when the admin enabled it AND set a rate; absent at the OFF/blank default).
  kind: 'grower_share' | 'chemical' | 'service_fee' | 'fuel_surcharge';
  description: string;
  quantity: number;
  unit_price_cents: number;
  extended_cents: number;
}

export interface PreviewFieldAppSplitCustomer {
  customer_id: string;
  customer_name: string;
  is_primary: boolean;
  tier: number;
  total_cents: number;
  lines: PreviewFieldAppSplitLine[];
}

export interface PreviewFieldAppSplitResult {
  per_customer: PreviewFieldAppSplitCustomer[];
  grand_total_cents: number;
  customer_count: number;
  shares_detail: DeriveCustomerSharesResult;
}

export type SearchEntityType = 'customer' | 'order' | 'invoice' | 'delivery' | 'product';

export interface GlobalSearchResult {
  entity_type: SearchEntityType;
  id: string;
  primary_text: string;
  secondary_text: string;
}

// ── §2 Watchdog Flags ────────────────────────────────────────────────────────

export type WatchdogFlagType =
  | 'acre_divergence'
  | 'rate_over_label'
  | 'double_bill'
  | 'rei_not_cleared';

export type WatchdogSeverity = 'warning' | 'info';
export type WatchdogEntityType = 'job' | 'invoice' | 'job_chemical';
export type WatchdogResolution = 'looks_fine' | 'needs_fix';

export interface WatchdogFlag {
  id: string;
  flag_type: WatchdogFlagType;
  severity: WatchdogSeverity;
  entity_type: WatchdogEntityType;
  entity_id: string;
  job_id: string | null;
  invoice_id: string | null;
  product_id: string | null;
  field_id: string | null;
  customer_id: string | null;
  message: string;
  detail: Record<string, unknown> | null;
  created_at: string;
  // joined from get_watchdog_flags RPC
  is_dismissed: boolean;
  dismissed_at: string | null;
  dismissed_by: string | null;
  resolution: WatchdogResolution | null;
  dismiss_note: string | null;
}

export interface WatchdogFlagDismissal {
  id: string;
  flag_id: string;
  dismissed_by: string;
  resolution: WatchdogResolution;
  note: string | null;
  dismissed_at: string;
}

export interface DismissWatchdogFlagResult {
  dismissal_id: string;
  flag_id: string;
  resolution: WatchdogResolution;
  dismissed_at: string;
}

export interface RefreshWatchdogFlagsResult {
  flags_total: number;
  flags_deleted: number;
  scope: string;
}

// Data-integrity sentinel (20260704120000): one row per NEW integrity break
// found by the daily run_data_integrity_sweep() cron. Admin-only read/resolve;
// rows are inserted only by the SECURITY DEFINER sweep, never by the client.
export type IntegrityAlertType =
  | 'negative_inventory'
  | 'negative_invoice_balance'
  | 'stale_quote_hold'
  | 'booking_overdraw';

export interface IntegrityAlert {
  id: string;
  alert_type: IntegrityAlertType;
  entity_table: string;
  entity_id: string;
  details: Record<string, unknown>;
  detected_at: string;
  resolved_at: string | null;
}

// Weekly automated in-DB backup store (admin-read-only; written by the
// run_weekly_db_backup pg_cron routine). Ops-only — no UI consumes it today.
export interface BackupSnapshot {
  id: number;
  taken_at: string;
  table_name: string;
  row_count: number;
  data: unknown[];
}

// One row per weekly backup run (admin-read-only). `succeeded` is false if any
// table failed; retention pruning is skipped on a failed run. Ops-only.
export interface BackupRun {
  id: number;
  ran_at: string;
  tables_backed_up: number;
  rows_backed_up: number;
  failed: string[];
  succeeded: boolean;
}

export interface BelowCostApprovalDetail {
  operation: string | null;
  entity_type: string | null;
  entity_id: string | null;
  line_id: string | null;
  product_id: string | null;
  product_name: string | null;
  unit_price_cents: number | null;
  locked_unit_cost_cents: number | null;
}

export interface BelowCostApprovalError {
  kind: 'context' | 'admin' | 'reason';
  detail: BelowCostApprovalDetail | null;
}
