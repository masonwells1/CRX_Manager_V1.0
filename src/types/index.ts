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

export interface Product {
  id: string;
  product_name: string;
  sku: string | null;
  category: string | null;
  vendor: string | null;
  manufacturer: string | null;
  container_size: number | null;
  unit_size: string | null;
  epa_registration: string | null;
  is_rup: boolean;
  signal_word: 'Danger' | 'Warning' | 'Caution' | null;
  product_form: ProductForm | null;
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
  suggested_rate: string | null;
  rate_per_acre: number | null;
  rate_unit: string | null;
  notes: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface CostHistory {
  id: string;
  product_id: string;
  changed_by: string;
  old_cost: number | null;
  new_cost: number | null;
  old_tier1_price: number | null;
  new_tier1_price: number | null;
  old_tier2_price: number | null;
  new_tier2_price: number | null;
  old_tier3_price: number | null;
  new_tier3_price: number | null;
  change_note: string | null;
  changed_at: string;
}

export interface CommissionSplit {
  splits: Array<{ recipient: string; percentage: number }>;
}

export interface Customer {
  id: string;
  farm_name: string;
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

export type QuoteStatus = 'draft' | 'sent' | 'revised' | 'accepted' | 'declined' | 'expired' | 'cancelled';

export interface Quote {
  id: string;
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
  customer?: Customer;
}

export interface QuoteSection {
  id: string;
  quote_id: string;
  section_name: string;
  sort_order: number;
  section_notes: string | null;
}

export interface QuoteItem {
  id: string;
  quote_id: string;
  section_id: string;
  product_id: string;
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
  product?: Product;
}

export type OrderStatus = 'confirmed' | 'partially_fulfilled' | 'fulfilled' | 'cancelled' | 'voided';

export interface Order {
  id: string;
  order_number: string;
  order_name: string | null;
  quote_id: string | null;
  customer_id: string;
  status: OrderStatus;
  commission_split: CommissionSplit | null;
  total_price: number;
  total_cost: number;
  total_profit: number;
  total_margin_pct: number;
  order_date: string;
  /** @deprecated Use invoice-derived AR instead. Column is no longer maintained. */
  total_paid?: number;
  /** @deprecated Use invoice-derived AR instead. Column is no longer maintained. */
  balance_due?: number;
  season: number | null;
  salesman_id: string | null;
  deleted_at: string | null;
  customer_po_number: string | null;
  is_planned: boolean;
  notes: string | null;
  created_by: string | null;
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

export interface OrderItem {
  id: string;
  order_id: string;
  product_id: string;
  quote_item_id: string | null;
  section_name: string | null;
  product_name: string;
  price_per_unit: number;
  cost_per_unit: number;
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
  updated_at: string;
  product?: Product;
}

export type InventoryHoldType = 'manual' | 'crop_program';

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

export type POStatus = 'draft' | 'submitted' | 'partially_received' | 'fully_received' | 'cancelled';

export interface PurchaseOrder {
  id: string;
  po_number: string;
  vendor: string;
  status: POStatus;
  submitted_date: string | null;
  expected_delivery_date: string | null;
  total_cost: number;
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
  quantity_received: number;
  unit_size: string | null;
  notes: string | null;
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
  order_id: string;
  customer_id: string;
  recipient: string;
  recipient_user_id: string | null;
  split_percentage: number;
  commission_amount: number;
  order_profit: number;
  order_date: string;
  order_number: string;
  customer_name: string;
  season: number;
  status: 'pending' | 'paid' | 'cancelled';
  paid_date: string | null;
  paid_note: string | null;
  deleted_at: string | null;
  created_at: string;
}

export type NotePriority = 'low' | 'medium' | 'high' | 'urgent';
export type NoteType = 'note' | 'todo' | 'announcement';

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
  created_at: string;
  updated_at: string;
  creator?: Profile;
  assignee?: Profile;
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
  updated_by: string | null;
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
export type OCRQueueStatus = 'pending' | 'processing' | 'completed' | 'failed';

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
  // Phase 3: Order linkage
  field_id: string | null;
  salesman_id: string | null;
  order_link_status: BlendTicketOrderLinkStatus;
  payment_status: BlendTicketPaymentStatus;
  created_at: string;
  updated_at: string;
  uploader?: Profile;
  reviewer?: Profile;
  customer?: Customer;
  field?: Field;
  salesman?: Profile;
  images?: BlendTicketImage[];
  products?: BlendTicketProduct[];
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
  created_at: string;
  // Joined
  product?: Product;
}

export interface OCRProcessingQueue {
  id: string;
  blend_ticket_id: string;
  status: OCRQueueStatus;
  priority: number;
  started_at: string | null;
  completed_at: string | null;
  error_message: string | null;
  retry_count: number;
  max_retries: number;
  created_at: string;
  updated_at: string;
}

// Phase 2: Billing / Invoices

export type InvoiceType = 'chemical_sale' | 'field_application' | 'misc_charge';
export type InvoiceStatus = 'draft' | 'unposted' | 'posted' | 'voided' | 'cancelled';

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
  balance_cents: number; // generated column

  // Posting workflow
  posted_by: string | null;
  posted_at: string | null;
  voided_by: string | null;
  voided_at: string | null;
  void_reason: string | null;

  // Metadata
  invoice_date: string;
  due_date: string | null;
  purchase_order_ref: string | null;
  header_notes: string | null;
  footer_notes: string | null;
  parent_invoice_id: string | null;

  // Field application context (snapshot from job)
  crop_type: string | null;
  field_names: string[] | null;
  total_acres: number | null;
  applicator_name: string | null;
  vehicle_name: string | null;
  application_date: string | null;
  job_id: string | null;
  total_cost_cents: number;

  is_quick_delivery?: boolean;
  write_off_cents: number;

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
  is_application_fee: boolean;
  tote_number: string | null;
  notes: string | null;
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

// ── Invoice & Statement PDF Data Types ──────────────────────────────────

export interface InvoicePrintOptions {
  show_shares: boolean;
  show_price_per_acre: boolean;
  show_epa_registration: boolean;
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
    over_90_cents: number;
  };
  outstanding_balance_cents: number;
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

export interface OrderLineAllocation {
  id: string;
  allocation_set_id: string;
  order_item_id: string;
  bill_to_customer_id: string;
  split_percentage: number;
  amount_cents: number;
  created_at: string;
  customer?: Customer;
}

export interface InvoiceLineAllocation {
  id: string;
  allocation_set_id: string;
  invoice_item_id: string;
  bill_to_customer_id: string;
  split_percentage: number;
  amount_cents: number;
  split_invoice_id: string | null;
  created_at: string;
  customer?: Customer;
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
  created_by: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
}

export interface PrepayApplication {
  id: string;
  prepay_credit_id: string;
  invoice_id: string;
  applied_amount_cents: number;
  applied_by: string | null;
  applied_at: string;
}

export interface FinancialAuditEntry {
  id: string;
  operation_type: string;
  entity_type: string;
  entity_id: string;
  actor_user_id: string;
  actor_role: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  total_impact_cents: number | null;
  description: string | null;
  created_at: string;
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
  created_at: string;
  updated_at: string;
  customer?: Customer;
  billing_defaults?: FieldBillingDefault[];
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
  customer_id: string;
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
  invoice_id: string | null;
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
  applied_info?: JobAppliedInfo;
}

export interface JobField {
  id: string;
  job_id: string;
  field_id: string;
  acres_to_treat: number | null;
  sort_order: number;
  // Joined
  field?: Field;
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
  sort_order: number;
  // Joined
  product?: Product;
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
  status: 'unposted' | 'posted';
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
  balance_cents: number;
  status: VendorBillStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
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
  // Joined
  creator?: Profile;
}

export interface APAgingRow {
  [k: string]: unknown;
  vendor_id: string;
  vendor_name: string;
  current_amount: number;
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
  | 'month_end_close';

export interface EmailLog {
  id: string;
  customer_id: string | null;
  recipient_email: string;
  email_type: EmailType;
  subject: string;
  html_body: string | null;
  attachment_name: string | null;
  resend_message_id: string | null;
  status: 'sent' | 'failed' | 'bounced';
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
