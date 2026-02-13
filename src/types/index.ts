export type UserRole = 'admin' | 'sales_rep' | 'driver';
export type ProductForm = 'liquid' | 'dry';
export type ContainerType = 'Jug' | 'Drum' | 'Pallet' | 'Mini-Bulk' | 'Shuttle' | 'Bag' | 'Tote' | 'Ea';
export type UnitType = 'liquid' | 'dry' | 'both';

export interface Profile {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
  phone: string | null;
  is_active: boolean;
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
  assigned_tier: number;
  assigned_sales_rep: string | null;
  parent_customer_id: string | null;
  total_acres: number | null;
  corn_acres: number | null;
  soybean_acres: number | null;
  other_acres: number | null;
  payment_terms: string | null;
  default_commission_split: CommissionSplit | null;
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
  created_at: string;
}

export type QuoteStatus = 'draft' | 'sent' | 'revised' | 'accepted' | 'declined' | 'expired';

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
  product?: Product;
}

export type OrderStatus = 'confirmed' | 'partially_fulfilled' | 'fulfilled' | 'cancelled';

export interface Order {
  id: string;
  order_number: string;
  quote_id: string | null;
  customer_id: string;
  status: OrderStatus;
  commission_split: CommissionSplit | null;
  total_price: number;
  total_cost: number;
  total_profit: number;
  total_margin_pct: number;
  order_date: string;
  total_paid: number;
  balance_due: number;
  season: number | null;
  salesman_id: string | null;
  deleted_at: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  customer?: Customer;
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

export type DeliveryStatus = 'scheduled' | 'in_progress' | 'completed' | 'cancelled';

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
  completed_at: string | null;
  signature_url: string | null;
  signed_by: string | null;
  receipt_pdf_url: string | null;
  season: number | null;
  deleted_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
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
  product?: Product;
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
}

export interface PurchaseOrderItem {
  id: string;
  purchase_order_id: string;
  product_id: string;
  quantity_ordered: number;
  unit_cost: number;
  quantity_received: number;
  unit_size: string | null;
  notes: string | null;
  product?: Product;
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
  status: 'pending' | 'paid';
  paid_date: string | null;
  paid_note: string | null;
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
  created_at: string;
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
  created_at: string;
  updated_at: string;
  uploader?: Profile;
  reviewer?: Profile;
  customer?: Customer;
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

  deleted_at: string | null;
  created_at: string;
  updated_at: string;

  // Relations
  customer?: Customer;
  order?: Order;
  salesman?: Profile;
  items?: InvoiceItem[];
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
  notes: string | null;
  created_at: string;
  updated_at: string;
  product?: Product;
}

export interface AllocationSet {
  id: string;
  entity_type: 'order' | 'invoice';
  entity_id: string;
  version: number;
  created_by: string | null;
  is_active: boolean;
  notes: string | null;
  created_at: string;
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
  created_at: string;
  updated_at: string;
  customer?: Customer;
}
