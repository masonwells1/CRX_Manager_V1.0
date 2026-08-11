/**
 * RPC Contract Tests
 *
 * These tests verify that the parameter shapes sent from the frontend
 * match the expected SQL function signatures. They don't call a real
 * Supabase instance — they validate the contract/shape only.
 *
 * This catches mismatches like:
 *   - Frontend sends `user_id` but RPC expects `p_user_id`
 *   - Frontend passes a number where RPC expects a string
 *   - Missing required parameters
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// -------------------------------------------------------------------------
// RPC parameter type definitions (must match SQL function signatures)
// -------------------------------------------------------------------------

interface ConvertQuoteToOrderParams {
  p_quote_id: string;    // uuid
  p_performed_by: string; // uuid
}

interface CreateDirectOrderParams {
  p_customer_id: string;  // uuid
  p_items: Array<{
    product_id: string;
    price_per_unit: number;
    current_cost: number;
    actual_rate: number | null;
    rate_unit: string | null;
    oz_per_acre: number | null;
    price_per_acre: number | null;
    acres: number | null;
    total_units_needed: number;
    unit_size: number | null;
    total_price: number;
    total_cost: number;
    profit: number;
    net_margin: number;
    notes: string | null;
  }>;
  p_commission_split: { splits: Array<{ recipient: string; recipient_user_id?: string | null; percentage: number }> } | null;
  p_performed_by: string;
}

interface CompleteDeliveryParams {
  p_delivery_id: string;  // uuid
  p_signed_by: string;    // text
  p_performed_by: string; // uuid
  p_quantities?: Record<string, number>; // optional jsonb
}

// RecordPaymentParams removed — RPC is deprecated

interface SaveQuoteParams {
  p_quote_id: string | null;
  p_customer_id: string;
  p_tier: number;
  p_status: string;
  p_is_planned: boolean;
  p_commission_split: { splits: Array<{ recipient: string; recipient_user_id?: string | null; percentage: number }> } | null;
  p_valid_days: number;
  p_header_notes: string | null;
  p_footer_notes: string | null;
  p_sections: Array<{
    id: string | null;
    section_name: string;
    sort_order: number;
    section_notes: string | null;
    items: Array<{
      id: string | null;
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
    }>;
  }>;
  p_performed_by: string;
}

interface SaveCustomerParams {
  p_customer_id: string | null;  // uuid — null for new customer
  p_customer_payload: {
    farm_name: string;
    contact_name?: string | null;
    phone?: string | null;
    email?: string | null;
    billing_address?: string | null;
    assigned_tier?: number;
    assigned_sales_rep?: string | null;
    total_acres?: number | null;
    corn_acres?: number | null;
    soybean_acres?: number | null;
    other_acres?: number | null;
    payment_terms?: string | null;
    default_commission_split?: { splits: Array<{ recipient: string; recipient_user_id?: string | null; percentage: number }> } | null;
    notes?: string | null;
    is_active?: boolean;
    credit_limit_cents?: number | null;
    finance_charge_enabled?: boolean;
    finance_charge_rate?: number | null;
    finance_charge_grace_days?: number | null;
    parent_customer_id?: string | null;
  };
  p_addresses: Array<{
    id?: string | null;
    label: string;
    address_line: string;
    city?: string | null;
    state?: string | null;
    zip?: string | null;
    delivery_notes?: string | null;
    is_default?: boolean;
  }> | null;
  p_performed_by: string;
}

interface SavePurchaseOrderParams {
  p_po_id: string | null;
  p_po_payload: {
    po_number: string;
    vendor: string;
    status: 'draft';
    submitted_date: null;
    expected_delivery_date: string | null;
    notes: string | null;
  };
  p_items: Array<{
    product_id: string;
    product_name: string | null;
    quantity_ordered: number;
    unit_cost: number;
    unit_size: string | null;
    quantity_received: 0;
  }>;
  p_performed_by: string;
  p_idempotency_key?: string;
}

interface ReceivePOItemsParams {
  p_items: Array<{
    po_item_id: string;
    quantity: number;       // RPC reads v_item->>'quantity', NOT 'quantity_received'
    condition?: string;     // default: 'good'
    lot_number?: string;
    notes?: string;
    storage_location?: string; // default: 'Main Warehouse'
  }>;
  p_performed_by: string;
  p_idempotency_key?: string;
  p_allow_over_receive?: boolean;
}

interface AdjustInventoryParams {
  p_product_id: string;
  p_location: string;
  p_quantity_delta: number;
  p_reason: string;
  p_performed_by: string;
}

interface UpdateOrderItemsParams {
  p_order_id: string;
  p_items: Array<{
    id: string;
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
  }>;
  p_performed_by: string;
}

interface CancelOrderParams {
  p_order_id: string;
  p_performed_by: string;
}

interface DuplicateQuoteParams {
  p_quote_id: string;
  p_performed_by: string;
}

interface AdminUpdateProfileParams {
  p_user_id: string;
  p_full_name: string;
  p_phone: string | null;
  p_role: 'admin' | 'sales_rep' | 'driver';
  p_is_active: boolean;
}

interface DeletePurchaseOrderParams {
  p_po_id: string;
  p_performed_by: string;
}

// -------------------------------------------------------------------------
// Helper: validate that a params object conforms to the expected shape
// -------------------------------------------------------------------------

function assertShape<T>(params: T): T {
  return params;
}

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('RPC contract: convert_quote_to_order', () => {
  it('accepts valid params', () => {
    const params = assertShape<ConvertQuoteToOrderParams>({
      p_quote_id: 'e7c1e3a4-0001-0001-0001-000000000001',
      p_performed_by: 'e7c1e3a4-0002-0002-0002-000000000002',
    });
    expect(params.p_quote_id).toBeTruthy();
    expect(params.p_performed_by).toBeTruthy();
  });
});

describe('RPC contract: create_direct_order', () => {
  it('accepts valid params with items', () => {
    const params = assertShape<CreateDirectOrderParams>({
      p_customer_id: 'cust-uuid',
      p_items: [
        {
          product_id: 'prod-uuid',
          price_per_unit: 20,
          current_cost: 10,
          actual_rate: 32,
          rate_unit: 'fl oz',
          oz_per_acre: 32,
          price_per_acre: 5,
          acres: 100,
          total_units_needed: 25,
          unit_size: null,
          total_price: 500,
          total_cost: 250,
          profit: 250,
          net_margin: 50,
          notes: null,
        },
      ],
      p_commission_split: {
        splits: [{ recipient: 'Alice', percentage: 100 }],
      },
      p_performed_by: 'user-uuid',
    });
    expect(params.p_items).toHaveLength(1);
    expect(params.p_items[0].total_price).toBe(500);
  });

  it('accepts null commission_split', () => {
    const params = assertShape<CreateDirectOrderParams>({
      p_customer_id: 'cust-uuid',
      p_items: [],
      p_commission_split: null,
      p_performed_by: 'user-uuid',
    });
    expect(params.p_commission_split).toBeNull();
  });
});

describe('RPC contract: complete_delivery', () => {
  it('accepts params without quantities (full delivery)', () => {
    const params = assertShape<CompleteDeliveryParams>({
      p_delivery_id: 'del-uuid',
      p_signed_by: 'John Doe',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_quantities).toBeUndefined();
  });

  it('accepts params with quantities (partial delivery)', () => {
    const params = assertShape<CompleteDeliveryParams>({
      p_delivery_id: 'del-uuid',
      p_signed_by: 'John Doe',
      p_performed_by: 'user-uuid',
      p_quantities: {
        'item-uuid-1': 5,
        'item-uuid-2': 10,
      },
    });
    expect(params.p_quantities).toBeDefined();
    expect(Object.keys(params.p_quantities!)).toHaveLength(2);
  });
});

// record_payment contract removed — RPC is deprecated. Use allocate_payment instead.

describe('RPC contract: save_quote', () => {
  it('accepts valid params for new quote', () => {
    const params = assertShape<SaveQuoteParams>({
      p_quote_id: null,
      p_customer_id: 'cust-uuid',
      p_tier: 1,
      p_status: 'draft',
      p_is_planned: false,
      p_commission_split: null,
      p_valid_days: 30,
      p_header_notes: null,
      p_footer_notes: null,
      p_sections: [
        {
          id: null,
          section_name: 'Herbicides',
          sort_order: 1,
          section_notes: null,
          items: [
            {
              id: null,
              product_id: 'prod-uuid',
              sort_order: 1,
              notes: null,
              price_per_unit: 20,
              current_cost: 10,
              suggested_rate: null,
              actual_rate: 32,
              rate_unit: 'fl oz',
              oz_per_acre: 32,
              price_per_acre: 5,
              acres: 100,
              total_units_needed: 25,
              unit_size: 'Gallon',
              profit: 250,
              total_price: 500,
              net_margin: 50,
            },
          ],
        },
      ],
      p_performed_by: 'user-uuid',
    });
    expect(params.p_quote_id).toBeNull();
    expect(params.p_sections).toHaveLength(1);
    expect(params.p_sections[0].items).toHaveLength(1);
  });

  it('accepts existing quote id for update', () => {
    const params = assertShape<SaveQuoteParams>({
      p_quote_id: 'existing-quote-uuid',
      p_customer_id: 'cust-uuid',
      p_tier: 2,
      p_status: 'draft',
      p_is_planned: true,
      p_commission_split: { splits: [{ recipient: 'Bob', percentage: 100 }] },
      p_valid_days: 60,
      p_header_notes: 'Test header',
      p_footer_notes: 'Test footer',
      p_sections: [],
      p_performed_by: 'user-uuid',
    });
    expect(params.p_quote_id).toBeTruthy();
  });
});

describe('RPC contract: save_customer', () => {
  it('accepts valid params for new customer', () => {
    const params = assertShape<SaveCustomerParams>({
      p_customer_id: null,
      p_customer_payload: {
        farm_name: 'Test Farm',
        contact_name: 'John Doe',
        phone: '555-1234',
        email: 'john@test.com',
        billing_address: '123 Farm Rd',
        assigned_tier: 1,
        assigned_sales_rep: null,
        total_acres: 1000,
        corn_acres: 500,
        soybean_acres: 300,
        other_acres: 200,
        payment_terms: 'Net 30',
        default_commission_split: null,
        notes: null,
        is_active: true,
        credit_limit_cents: 50000000,
        finance_charge_enabled: true,
        finance_charge_rate: 1.5,
        finance_charge_grace_days: 30,
      },
      p_addresses: [
        { label: 'Main', address_line: '123 Farm Rd', city: 'Springfield', state: 'IL', zip: '62701', delivery_notes: null, is_default: true },
      ],
      p_performed_by: 'user-uuid',
    });
    expect(params.p_customer_payload.farm_name).toBe('Test Farm');
    expect(params.p_addresses).toHaveLength(1);
  });

  it('accepts existing customer id for update', () => {
    const params = assertShape<SaveCustomerParams>({
      p_customer_id: 'existing-customer-uuid',
      p_customer_payload: {
        farm_name: 'Updated Farm',
      },
      p_addresses: null,
      p_performed_by: 'user-uuid',
    });
    expect(params.p_customer_id).toBeTruthy();
  });
});

describe('RPC contract: save_purchase_order', () => {
  it('accepts valid params', () => {
    const params = assertShape<SavePurchaseOrderParams>({
      p_po_id: null,
      p_po_payload: {
        po_number: 'PO-2026-0001',
        vendor: 'Acme Chemicals',
        status: 'draft',
        submitted_date: null,
        expected_delivery_date: '2026-03-15',
        notes: null,
      },
      p_items: [
        {
          product_id: 'prod-uuid',
          product_name: 'Example Product',
          quantity_ordered: 100,
          unit_cost: 10.50,
          quantity_received: 0,
          unit_size: 'Gallon',
        },
      ],
      p_performed_by: 'user-uuid',
      p_idempotency_key: 'save_purchase_order:user-uuid:intent-1',
    });
    expect(params.p_items).toHaveLength(1);
    expect(params.p_po_payload.status).toBe('draft');
  });
});

describe('RPC contract: receive_po_items', () => {
  it('accepts valid params', () => {
    const params = assertShape<ReceivePOItemsParams>({
      p_items: [
        { po_item_id: 'item-1', quantity: 50 },
        { po_item_id: 'item-2', quantity: 25, condition: 'damaged', notes: 'Box crushed' },
      ],
      p_performed_by: 'user-uuid',
    });
    expect(params.p_items).toHaveLength(2);
  });

  it('accepts optional idempotency key and over-receive flag', () => {
    const params = assertShape<ReceivePOItemsParams>({
      p_items: [{ po_item_id: 'item-1', quantity: 10 }],
      p_performed_by: 'user-uuid',
      p_idempotency_key: 'receive_po_items:user-uuid:1234',
      p_allow_over_receive: true,
    });
    expect(params.p_allow_over_receive).toBe(true);
  });
});

describe('RPC contract: adjust_inventory', () => {
  it('accepts positive adjustment', () => {
    const params = assertShape<AdjustInventoryParams>({
      p_product_id: 'prod-uuid',
      p_location: 'Warehouse A',
      p_quantity_delta: 50,
      p_reason: 'Manual count adjustment',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_quantity_delta).toBeGreaterThan(0);
  });

  it('accepts negative adjustment', () => {
    const params = assertShape<AdjustInventoryParams>({
      p_product_id: 'prod-uuid',
      p_location: 'Warehouse A',
      p_quantity_delta: -10,
      p_reason: 'Spillage',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_quantity_delta).toBeLessThan(0);
  });
});

describe('RPC contract: update_order_items', () => {
  it('accepts valid params', () => {
    const params = assertShape<UpdateOrderItemsParams>({
      p_order_id: 'order-uuid',
      p_items: [
        {
          id: 'item-uuid',
          price_per_unit: 22,
          cost_per_unit: 10,
          actual_rate: 32,
          rate_unit: 'fl oz',
          acres: 100,
          total_units_needed: 25,
          unit_size: 'Gallon',
          total_price: 550,
          profit: 300,
          net_margin: 54.55,
        },
      ],
      p_performed_by: 'user-uuid',
    });
    expect(params.p_items).toHaveLength(1);
  });
});

describe('RPC contract: cancel_order', () => {
  it('accepts valid params', () => {
    const params = assertShape<CancelOrderParams>({
      p_order_id: 'order-uuid',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_order_id).toBeTruthy();
  });
});

describe('RPC contract: duplicate_quote', () => {
  it('accepts valid params', () => {
    const params = assertShape<DuplicateQuoteParams>({
      p_quote_id: 'quote-uuid',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_quote_id).toBeTruthy();
  });
});

describe('RPC contract: admin_update_profile', () => {
  it('accepts valid params', () => {
    const params = assertShape<AdminUpdateProfileParams>({
      p_user_id: 'user-uuid',
      p_full_name: 'New Name',
      p_phone: '555-9999',
      p_role: 'sales_rep',
      p_is_active: true,
    });
    expect(params.p_role).toBe('sales_rep');
  });

  it('accepts all role values', () => {
    for (const role of ['admin', 'sales_rep', 'driver'] as const) {
      const params = assertShape<AdminUpdateProfileParams>({
        p_user_id: 'user-uuid',
        p_full_name: 'Test',
        p_phone: null,
        p_role: role,
        p_is_active: true,
      });
      expect(params.p_role).toBe(role);
    }
  });
});

describe('RPC contract: delete_purchase_order', () => {
  it('accepts valid params', () => {
    const params = assertShape<DeletePurchaseOrderParams>({
      p_po_id: 'po-uuid',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_po_id).toBeTruthy();
  });
});

// -------------------------------------------------------------------------
// D3 — allocate_payment and create_quick_delivery contract tests
// -------------------------------------------------------------------------

interface AllocatePaymentParams {
  p_customer_id: string;       // uuid
  p_total_cents: number;       // bigint — total check amount in cents
  p_allocations: Array<{
    invoice_id: string;        // uuid
    amount_cents: number;      // bigint
  }>;
  p_payment_method: string;    // e.g. 'check', 'ach', 'wire'
  p_reference_number: string | null;
  p_notes: string | null;
  p_performed_by: string;      // uuid
  p_idempotency_key?: string;
}

interface CreateQuickDeliveryParams {
  p_customer_id: string;       // uuid
  p_items: Array<{
    product_id: string;        // uuid
    quantity: number;
    unit_size: string | null;
    price_cents: number;       // bigint
  }>;
  p_driver_id: string | null;  // uuid or null
  p_scheduled_date: string;    // ISO date string
  p_delivery_notes: string | null;
  p_performed_by: string;      // uuid
  p_idempotency_key?: string;
}

describe('RPC contract: allocate_payment', () => {
  it('accepts valid params with allocations', () => {
    const params = assertShape<AllocatePaymentParams>({
      p_customer_id: 'cust-uuid',
      p_total_cents: 500000,
      p_allocations: [
        { invoice_id: 'inv-uuid-1', amount_cents: 300000 },
        { invoice_id: 'inv-uuid-2', amount_cents: 200000 },
      ],
      p_payment_method: 'check',
      p_reference_number: 'CHK-4567',
      p_notes: null,
      p_performed_by: 'user-uuid',
      p_idempotency_key: 'allocate_payment:user-uuid:1234567890',
    });
    expect(params.p_total_cents).toBe(500000);
    expect(params.p_allocations).toHaveLength(2);
    expect(params.p_allocations[0].amount_cents).toBe(300000);
  });

  it('accepts params with empty allocations (prepay only)', () => {
    const params = assertShape<AllocatePaymentParams>({
      p_customer_id: 'cust-uuid',
      p_total_cents: 100000,
      p_allocations: [],
      p_payment_method: 'ach',
      p_reference_number: null,
      p_notes: 'Prepayment for spring season',
      p_performed_by: 'user-uuid',
    });
    expect(params.p_allocations).toHaveLength(0);
    expect(params.p_notes).toBeTruthy();
  });

  it('requires cents not dollars', () => {
    // Verify the interface enforces number type (not string)
    const params = assertShape<AllocatePaymentParams>({
      p_customer_id: 'cust-uuid',
      p_total_cents: 250099,   // $2,500.99 in cents
      p_allocations: [{ invoice_id: 'inv-uuid', amount_cents: 250099 }],
      p_payment_method: 'wire',
      p_reference_number: 'WIRE-001',
      p_notes: null,
      p_performed_by: 'user-uuid',
    });
    expect(typeof params.p_total_cents).toBe('number');
    expect(typeof params.p_allocations[0].amount_cents).toBe('number');
  });
});

describe('RPC contract: create_quick_delivery', () => {
  it('accepts valid params with driver and items', () => {
    const params = assertShape<CreateQuickDeliveryParams>({
      p_customer_id: 'cust-uuid',
      p_items: [
        {
          product_id: 'prod-uuid-1',
          quantity: 5,
          unit_size: 'Gallon',
          price_cents: 8750,
        },
        {
          product_id: 'prod-uuid-2',
          quantity: 2,
          unit_size: null,
          price_cents: 12000,
        },
      ],
      p_driver_id: 'driver-uuid',
      p_scheduled_date: '2026-03-15',
      p_delivery_notes: 'Call before arriving',
      p_performed_by: 'admin-uuid',
      p_idempotency_key: 'create_quick_delivery:admin-uuid:1234567890',
    });
    expect(params.p_items).toHaveLength(2);
    expect(params.p_items[0].price_cents).toBe(8750);
    expect(params.p_driver_id).toBeTruthy();
  });

  it('accepts null driver (unassigned delivery)', () => {
    const params = assertShape<CreateQuickDeliveryParams>({
      p_customer_id: 'cust-uuid',
      p_items: [
        { product_id: 'prod-uuid', quantity: 10, unit_size: 'Quart', price_cents: 5000 },
      ],
      p_driver_id: null,
      p_scheduled_date: '2026-03-20',
      p_delivery_notes: null,
      p_performed_by: 'admin-uuid',
    });
    expect(params.p_driver_id).toBeNull();
    expect(params.p_delivery_notes).toBeNull();
  });

  it('price_cents enforces number type (not dollars)', () => {
    const params = assertShape<CreateQuickDeliveryParams>({
      p_customer_id: 'cust-uuid',
      p_items: [
        { product_id: 'prod-uuid', quantity: 1, unit_size: null, price_cents: 150000 }, // $1,500.00
      ],
      p_driver_id: null,
      p_scheduled_date: '2026-04-01',
      p_delivery_notes: null,
      p_performed_by: 'admin-uuid',
    });
    expect(typeof params.p_items[0].price_cents).toBe('number');
    expect(params.p_items[0].price_cents).toBe(150000);
  });
});

// -------------------------------------------------------------------------
// RPC contract: reverse_write_off
// Wave A.1 / audit finding P3-1. Documents the param shape AND the result
// jsonb shape so downstream callers can rely on the new fields.
// -------------------------------------------------------------------------

interface ReverseWriteOffParams {
  p_write_off_id: string;            // uuid
  p_reason: string;                  // non-empty; SQL rejects null/blank
  p_performed_by: string | null;     // uuid; falls back to auth.uid() in SQL
  p_idempotency_key?: string | null;
}

interface ReverseWriteOffResult {
  success: true;
  write_off_id: string;
  amount_cents: number;
  invoice_id: string;
  new_balance_cents: number;
  status_changed: boolean;           // true when invoice flipped from 'paid'
  new_status?: 'posted' | 'overdue' | 'paid'; // added in 20260506200000 follow-up
}

describe('RPC contract: reverse_write_off', () => {
  it('accepts the four-param shape used by InvoiceDetail.tsx', () => {
    const params = assertShape<ReverseWriteOffParams>({
      p_write_off_id: 'wo-uuid',
      p_reason: 'Customer disputed write-off after settlement',
      p_performed_by: 'admin-uuid',
      p_idempotency_key: 'reverse_write_off:admin-uuid:1234567890',
    });
    expect(params.p_reason.trim().length).toBeGreaterThan(0);
    expect(params.p_idempotency_key).toBeTruthy();
  });

  it('reason cannot be empty (SQL guards trim)', () => {
    // The SQL function raises 'Reason is required to reverse a write-off'
    // when p_reason is null or blank; this test documents the contract.
    const blank = '   ';
    expect(blank.trim()).toBe('');
  });

  it('result jsonb has the post-fix shape (round-trip contract)', () => {
    // Simulates the jsonb the SQL function returns. Documents that callers
    // can read new_balance_cents and status_changed without schema surprise.
    const result: ReverseWriteOffResult = {
      success: true,
      write_off_id: 'wo-uuid',
      amount_cents: 50000,
      invoice_id: 'inv-uuid',
      new_balance_cents: 50000,
      status_changed: true,
    };
    expect(result.new_balance_cents).toBe(50000);
    expect(result.status_changed).toBe(true);
  });

  it('status_changed is false when reversal does not lift balance > 0', () => {
    // Edge case: write-off was partial, invoice already had other payments,
    // reversal leaves balance still 0. status stays 'paid'.
    const result: ReverseWriteOffResult = {
      success: true,
      write_off_id: 'wo-uuid',
      amount_cents: 0,
      invoice_id: 'inv-uuid',
      new_balance_cents: 0,
      status_changed: false,
    };
    expect(result.status_changed).toBe(false);
  });
});

// -------------------------------------------------------------------------
// RPC contracts: returns lifecycle (Wave B.2 + audit B-7 / B-9)
//
// All four return-lifecycle RPCs were rebuilt in Wave B.2 with proper
// idempotency wrappers and structured jsonb returns. These contracts
// document the param shapes AND the result jsonb shapes so downstream
// callers (Returns.tsx today, future audit/dashboard tools tomorrow) can
// rely on the new fields without re-reading the migration.
// -------------------------------------------------------------------------

interface ApproveReturnParams {
  p_return_id: string;
  p_approved_by: string;
  p_idempotency_key?: string | null;
}
interface ApproveReturnResult {
  success: true;
  return_id: string;
  return_number: string;
  status: 'approved';
}

interface ReceiveReturnParams {
  p_return_id: string;
  p_received_by: string;
  p_idempotency_key?: string | null;
}
interface ReceiveReturnResult {
  success: true;
  return_id: string;
  return_number: string;
  status: 'received';
  restocked_count: number;
  restocked_quantity: number;
  skipped_count: number; // items skipped because no inventory row exists
}

interface CancelReturnParams {
  p_return_id: string;
  p_reason: string;             // non-empty; SQL rejects null/blank
  p_performed_by: string;
  p_idempotency_key?: string | null;
}
interface CancelReturnResult {
  success: true;
  return_id: string;
  return_number: string;
  status: 'cancelled';
  was_received: boolean;
  reversed_count: number;
  reversed_quantity: number;
  skipped_count: number;        // items where inventory row was missing at cancel time
}

interface IssueReturnCreditParams {
  p_return_id: string;
  p_actor_id: string;
  p_idempotency_key?: string | null;
}
interface IssueReturnCreditResult {
  success: true;
  return_id: string;
  return_number: string;
  credit_invoice_id: string;
  credit_invoice_number: string;
  credit_amount_cents: number;
  customer_id: string;
  credited_at: string;          // ISO timestamp
}

describe('RPC contract: approve_return', () => {
  it('accepts the three-param shape used by Returns.tsx', () => {
    const params = assertShape<ApproveReturnParams>({
      p_return_id: 'return-uuid',
      p_approved_by: 'admin-uuid',
      p_idempotency_key: 'approve_return:admin-uuid:1234567890',
    });
    expect(params.p_return_id).toBeTruthy();
  });

  it('result jsonb has the post-rewrite shape', () => {
    const result: ApproveReturnResult = {
      success: true,
      return_id: 'r-uuid',
      return_number: 'RET-001',
      status: 'approved',
    };
    expect(result.status).toBe('approved');
  });
});

describe('RPC contract: receive_return', () => {
  it('accepts the three-param shape used by Returns.tsx', () => {
    const params = assertShape<ReceiveReturnParams>({
      p_return_id: 'return-uuid',
      p_received_by: 'admin-uuid',
      p_idempotency_key: 'receive_return:admin-uuid:1234567890',
    });
    expect(params.p_return_id).toBeTruthy();
  });

  it('result jsonb includes the skipped_count surfaced after Wave B.2', () => {
    // skipped_count was the audit B-2 fix that ensures the admin sees
    // when a product had no inventory row at receive time. Mirrors the
    // same field added to cancel_return.
    const result: ReceiveReturnResult = {
      success: true,
      return_id: 'r-uuid',
      return_number: 'RET-002',
      status: 'received',
      restocked_count: 3,
      restocked_quantity: 30,
      skipped_count: 1,
    };
    expect(result.skipped_count).toBeGreaterThanOrEqual(0);
    expect(result.restocked_count + result.skipped_count).toBeGreaterThan(0);
  });
});

describe('RPC contract: cancel_return', () => {
  it('accepts the four-param shape used by Returns.tsx via ReasonModal', () => {
    const params = assertShape<CancelReturnParams>({
      p_return_id: 'return-uuid',
      p_reason: 'Customer changed mind after delivery',
      p_performed_by: 'admin-uuid',
      p_idempotency_key: 'cancel_return:admin-uuid:1234567890',
    });
    expect(params.p_reason.trim().length).toBeGreaterThan(0);
  });

  it('was_received=true + reversed_count > 0 means inventory was decremented', () => {
    // When the return was already 'received', cancel_return reverses the
    // restock by inserting negative-qty inventory_transactions rows.
    const result: CancelReturnResult = {
      success: true,
      return_id: 'r-uuid',
      return_number: 'RET-003',
      status: 'cancelled',
      was_received: true,
      reversed_count: 2,
      reversed_quantity: 20,
      skipped_count: 0,
    };
    expect(result.was_received).toBe(true);
    expect(result.reversed_count).toBeGreaterThan(0);
  });

  it('skipped_count > 0 signals the admin must reconcile manually', () => {
    // Wave B audit B-2: when the inventory row no longer exists at cancel
    // time (product retired between receive and cancel), the function
    // can't decrement; it surfaces skipped_count so the admin knows.
    const result: CancelReturnResult = {
      success: true,
      return_id: 'r-uuid',
      return_number: 'RET-004',
      status: 'cancelled',
      was_received: true,
      reversed_count: 1,
      reversed_quantity: 10,
      skipped_count: 1,
    };
    expect(result.skipped_count).toBeGreaterThan(0);
  });

  it('was_received=false skips the inventory loop entirely', () => {
    // Cancelling a return that was only 'requested' or 'approved' —
    // nothing was restocked yet, so reversed_count and skipped_count
    // are both zero and was_received is false.
    const result: CancelReturnResult = {
      success: true,
      return_id: 'r-uuid',
      return_number: 'RET-005',
      status: 'cancelled',
      was_received: false,
      reversed_count: 0,
      reversed_quantity: 0,
      skipped_count: 0,
    };
    expect(result.was_received).toBe(false);
    expect(result.reversed_count).toBe(0);
  });
});

describe('RPC contract: issue_return_credit', () => {
  it('accepts the three-param shape used by Returns.tsx', () => {
    const params = assertShape<IssueReturnCreditParams>({
      p_return_id: 'return-uuid',
      p_actor_id: 'admin-uuid',
      p_idempotency_key: 'issue_return_credit:admin-uuid:1234567890',
    });
    expect(params.p_return_id).toBeTruthy();
  });

  it('result jsonb includes the credit memo invoice id + amount', () => {
    // Wave B.2 restored RETURNS jsonb on this RPC after a prior dynamic
    // consolidation had silently regressed it to RETURNS void. The result
    // shape lets a future audit/dashboard caller link the return to its
    // credit memo without re-querying.
    const result: IssueReturnCreditResult = {
      success: true,
      return_id: 'r-uuid',
      return_number: 'RET-006',
      credit_invoice_id: 'inv-uuid',
      credit_invoice_number: 'CM-2026-0001',
      credit_amount_cents: 25000,
      customer_id: 'cust-uuid',
      credited_at: '2026-05-07T01:00:00Z',
    };
    expect(result.credit_amount_cents).toBeGreaterThan(0);
    expect(result.credit_invoice_number).toMatch(/^CM-/);
  });
});

// -------------------------------------------------------------------------
// create_rebate_claim / transition_rebate_claim (audit #33)
// -------------------------------------------------------------------------

interface CreateRebateClaimParams {
  p_program_id: string;          // uuid
  p_quantity: number;            // numeric
  p_claim_amount_cents: number;  // bigint
  p_order_id?: string | null;
  p_customer_id?: string | null;
  p_product_id?: string | null;
  p_notes?: string | null;
  p_idempotency_key?: string | null;
}

interface CreateRebateClaimResult {
  success: true;
  claim_id: string;
  claim_number: string;  // RC-YYYY-NNNN
}

interface TransitionRebateClaimParams {
  p_claim_id: string;
  p_new_status: 'submitted' | 'approved' | 'paid' | 'rejected';
  p_paid_amount_cents?: number | null;
  p_manufacturer_ref?: string | null;
  p_idempotency_key?: string | null;
}

interface TransitionRebateClaimResult {
  success: true;
  claim_id: string;
  old_status: string;
  new_status: string;
}

describe('RPC contract: create_rebate_claim', () => {
  it('accepts the minimal required params', () => {
    const params = assertShape<CreateRebateClaimParams>({
      p_program_id: 'prog-uuid',
      p_quantity: 100,
      p_claim_amount_cents: 50000,
    });
    expect(params.p_program_id).toBeTruthy();
  });

  it('accepts all optional params + idempotency key', () => {
    const params = assertShape<CreateRebateClaimParams>({
      p_program_id: 'prog-uuid',
      p_quantity: 250,
      p_claim_amount_cents: 125000,
      p_order_id: 'ord-uuid',
      p_customer_id: 'cust-uuid',
      p_product_id: 'prod-uuid',
      p_notes: 'Q3 manufacturer rebate batch',
      p_idempotency_key: 'create_rebate_claim:user-uuid:1234567890',
    });
    expect(params.p_idempotency_key).toBeTruthy();
  });

  it('result includes generated claim_number in RC-YYYY-NNNN form', () => {
    const result: CreateRebateClaimResult = {
      success: true,
      claim_id: 'claim-uuid',
      claim_number: 'RC-2026-0001',
    };
    expect(result.claim_number).toMatch(/^RC-\d{4}-\d{4}$/);
  });
});

describe('RPC contract: transition_rebate_claim', () => {
  it('accepts a simple submit transition', () => {
    const params = assertShape<TransitionRebateClaimParams>({
      p_claim_id: 'claim-uuid',
      p_new_status: 'submitted',
    });
    expect(params.p_new_status).toBe('submitted');
  });

  it('accepts a paid transition with explicit paid_amount and manufacturer_ref', () => {
    const params = assertShape<TransitionRebateClaimParams>({
      p_claim_id: 'claim-uuid',
      p_new_status: 'paid',
      p_paid_amount_cents: 49500,
      p_manufacturer_ref: 'CHK-2026-1234',
      p_idempotency_key: 'transition_rebate_claim:user-uuid:1234567890',
    });
    expect(params.p_paid_amount_cents).toBe(49500);
  });

  it('result reports old and new status for caller diffing', () => {
    const result: TransitionRebateClaimResult = {
      success: true,
      claim_id: 'claim-uuid',
      old_status: 'approved',
      new_status: 'paid',
    };
    expect(result.old_status).not.toBe(result.new_status);
  });
});

// -------------------------------------------------------------------------
// create_delivery_with_items / bulk_import_order / save_blend_recipe
// (audits #10, #31, #34 — atomic multi-table writes)
// -------------------------------------------------------------------------

interface CreateDeliveryWithItemsParams {
  p_order_id: string;
  p_customer_id: string;
  p_scheduled_date: string;  // ISO date
  p_items: Array<{
    order_item_id: string;
    product_id: string;
    quantity: number;
    unit_size: string | null;
    tote_number: string | null;
    notes: string | null;
  }>;
  p_delivery_address_id?: string | null;
  p_assigned_driver?: string | null;
  p_scheduled_time?: string | null;
  p_delivery_notes?: string | null;
  p_idempotency_key?: string | null;
}

interface CreateDeliveryWithItemsResult {
  success: true;
  delivery_id: string;
  delivery_number: string;
  item_count: number;
}

interface BulkImportOrderParams {
  p_order_number: string;
  p_customer_id: string;
  p_status: string;
  p_total_price: number;
  p_total_cost: number;
  p_total_profit: number;
  p_total_margin_pct: number;
  p_order_date: string;  // ISO date
  p_items: Array<{
    product_id: string;
    product_name: string;
    price_per_unit: number;
    unit_cost?: number;
    total_units_needed: number;
    unit_size?: string;
    notes?: string;
    sort_order: number;
  }>;
  p_notes?: string | null;
  p_idempotency_key?: string | null;
}

interface SaveBlendRecipeParams {
  p_recipe_id: string | null;  // null for create, uuid for update
  p_name: string;
  p_recipe_type: 'generic' | 'crop_specific';
  p_items: Array<{
    product_id: string;
    product_name: string;
    quantity: number;
    unit: string;
    rate_per_acre: number | null;
    notes: string | null;
  }>;
  p_description?: string | null;
  p_crop_type?: string | null;
  p_timing?: string | null;
  p_idempotency_key?: string | null;
}

interface SaveBlendRecipeResult {
  success: true;
  recipe_id: string;
  created: boolean;
  item_count: number;
}

describe('RPC contract: create_delivery_with_items', () => {
  it('accepts the minimum required params with one item', () => {
    const params = assertShape<CreateDeliveryWithItemsParams>({
      p_order_id: 'ord-uuid',
      p_customer_id: 'cust-uuid',
      p_scheduled_date: '2026-05-15',
      p_items: [
        {
          order_item_id: 'oi-uuid',
          product_id: 'prod-uuid',
          quantity: 5,
          unit_size: '2.5 gal',
          tote_number: null,
          notes: null,
        },
      ],
    });
    expect(params.p_items).toHaveLength(1);
  });

  it('accepts driver + address + idempotency for full path', () => {
    const params = assertShape<CreateDeliveryWithItemsParams>({
      p_order_id: 'ord-uuid',
      p_customer_id: 'cust-uuid',
      p_scheduled_date: '2026-05-15',
      p_items: [],
      p_delivery_address_id: 'addr-uuid',
      p_assigned_driver: 'drv-uuid',
      p_scheduled_time: '14:30',
      p_delivery_notes: 'Gate code 1234',
      p_idempotency_key: 'create_delivery_with_items:user-uuid:1234567890',
    });
    expect(params.p_assigned_driver).toBe('drv-uuid');
  });

  it('result includes generated delivery_number and item_count', () => {
    const result: CreateDeliveryWithItemsResult = {
      success: true,
      delivery_id: 'del-uuid',
      delivery_number: 'D-2026-0123',
      item_count: 3,
    };
    expect(result.item_count).toBeGreaterThan(0);
  });
});

describe('RPC contract: bulk_import_order', () => {
  it('accepts a single order with computed totals', () => {
    const params = assertShape<BulkImportOrderParams>({
      p_order_number: 'IMP-001',
      p_customer_id: 'cust-uuid',
      p_status: 'confirmed',
      p_total_price: 1000,
      p_total_cost: 700,
      p_total_profit: 300,
      p_total_margin_pct: 30,
      p_order_date: '2026-05-15',
      p_items: [
        {
          product_id: 'prod-uuid',
          product_name: 'Roundup PowerMax',
          price_per_unit: 100,
          unit_cost: 70,
          total_units_needed: 10,
          unit_size: '2.5 gal',
          notes: 'imported',
          sort_order: 1,
        },
      ],
      p_notes: 'CSV row 12',
      p_idempotency_key: 'bulk_import_order:IMP-001:user-uuid:1234567890',
    });
    expect(params.p_items[0].product_id).toBeTruthy();
  });

  it('requires the resolved product UUID used for inventory booking', () => {
    const params = assertShape<BulkImportOrderParams>({
      p_order_number: 'IMP-002',
      p_customer_id: 'cust-uuid',
      p_status: 'confirmed',
      p_total_price: 0,
      p_total_cost: 0,
      p_total_profit: 0,
      p_total_margin_pct: 0,
      p_order_date: '2026-05-15',
      p_items: [
        {
          product_id: 'prod-uuid',
          product_name: 'Resolved product',
          price_per_unit: 0,
          unit_cost: 0,
          total_units_needed: 1,
          sort_order: 1,
        },
      ],
    });
    expect(params.p_items[0].product_id).toBe('prod-uuid');
  });

  it('enforces canonical lifecycle side effects in the final Section 4 migration body', () => {
    const body = getMigrationFiles().find(
      ({ name }) => name === '20260806023048_surface_bulk_import_inventory_warnings.sql',
    )?.content ?? null;
    expect(body).not.toBeNull();
    expect(body).toContain("INVALID_IMPORT_STATUS: only confirmed orders can be imported");
    expect(body).toMatch(/'confirmed',\s+v_total_price/);
    expect(body).toContain('quantity_prebooked = public.inventory.quantity_prebooked + EXCLUDED.quantity_prebooked');
    expect(body).toContain("'booked',");
    expect(body).toContain('public._insert_commissions_for_order(');
    expect(body).toContain('INSERT INTO public.activity_feed');
    expect(body).toContain("v_qty::text IN ('NaN', 'Infinity', '-Infinity')");
    expect(body).toContain("v_price_per_unit::text IN ('NaN', 'Infinity', '-Infinity')");
    expect(body).toContain("v_cost_per_unit::text IN ('NaN', 'Infinity', '-Infinity')");
    expect(body).toContain('v_price_per_unit := round(v_price_per_unit, 2)');
    expect(body).toContain('v_cost_per_unit := round(v_cost_per_unit, 2)');
    expect(body).toContain('round(v_qty * v_price_per_unit, 2)');
    expect(body).toContain("NULLIF(btrim(v_item->>'unit_cost'), '')::numeric");
    expect(body).toContain('v_product.current_cost');
    expect(body).toContain('v_supplied_cost :=');
    expect(body).toContain('v_cost_per_unit := v_cost_cents::numeric / 100');
    expect(body).not.toContain('v_cost_per_unit := COALESCE');
    expect(body).toContain("ITEM_INVALID: supplied unit_cost must be finite and >= 0");
    expect(body).toContain("RAISE EXCEPTION 'ITEM_INVALID: quantity, price, cost, and sort order must be valid numbers'");
    expect(body).toContain('v_normalized_items := v_normalized_items || jsonb_build_array');
    expect(body).toContain('jsonb_array_elements(v_normalized_items)');
    expect(body).toContain("hashtextextended('crx:idempotency:' || p_idempotency_key, 0)");
    expect(body).toContain('request_actor_id IS DISTINCT FROM v_actor');
    expect(body).toContain('request_fingerprint IS DISTINCT FROM v_request_fingerprint');
    expect(body).toContain("RAISE EXCEPTION 'IDEMPOTENCY_INTENT_MISMATCH'");
    expect(body).toMatch(/SELECT total_price, total_cost, total_profit, total_margin_pct[\s\S]*FROM public\.orders/);
    expect(body).toContain('SET profit = profit + (v_total_profit - v_line_profit_sum)');
    expect(body).toMatch(/public\._insert_commissions_for_order\([\s\S]*v_total_profit/);
    expect(body).toContain('FOR SHARE OF p');
    expect(body).toContain('v_cost_cents := round(v_product.current_cost * 100)::bigint');
    expect(body).toContain("'cost_at_time_cents', v_cost_cents");
    expect(body).toMatch(/cost_per_unit,\s+cost_at_time_cents,\s+total_units_needed/);
    expect(body).toContain('round(v_qty * v_price_per_unit, 2) - round(v_qty * v_cost_per_unit, 2)');
    expect(body).toContain('jsonb_to_recordset(v_normalized_items)');
    expect(body).toContain("'warnings', to_jsonb(v_warnings)");
    // 60s (vs. the 5s default): the migration corpus is read once at module load,
    // but this test still scans it, and the whole suite runs 150 files in parallel
    // against one disk. Generous headroom keeps machine load from failing a test
    // whose assertions are pure string matching.
  }, 60_000);
});

describe('RPC contract: save_blend_recipe', () => {
  it('accepts create-path params (recipe_id = null)', () => {
    const params = assertShape<SaveBlendRecipeParams>({
      p_recipe_id: null,
      p_name: 'Spring Burndown',
      p_recipe_type: 'generic',
      p_items: [
        {
          product_id: 'prod-uuid',
          product_name: 'Glyphosate 5L',
          quantity: 32,
          unit: 'fl oz',
          rate_per_acre: 32,
          notes: null,
        },
      ],
      p_description: 'Standard pre-plant',
    });
    expect(params.p_recipe_id).toBeNull();
  });

  it('accepts update-path params with crop_type + timing', () => {
    const params = assertShape<SaveBlendRecipeParams>({
      p_recipe_id: 'recipe-uuid',
      p_name: 'V4 Corn Foliar',
      p_recipe_type: 'crop_specific',
      p_crop_type: 'corn',
      p_timing: 'V4',
      p_items: [],
      p_idempotency_key: 'save_blend_recipe:recipe-uuid:user-uuid:1234567890',
    });
    expect(params.p_recipe_type).toBe('crop_specific');
  });

  it('result reports whether the operation was a create vs update', () => {
    const result: SaveBlendRecipeResult = {
      success: true,
      recipe_id: 'recipe-uuid',
      created: false,
      item_count: 4,
    };
    expect(result.created).toBe(false);
  });
});

// -------------------------------------------------------------------------
// Idempotency Key Coverage — Track which mutating RPCs accept p_idempotency_key
// -------------------------------------------------------------------------

/**
 * Every mutating RPC MUST accept `p_idempotency_key text DEFAULT NULL`.
 * This list is the source of truth for which RPCs have been updated.
 * If you add a new mutating RPC, add it here AND add the parameter to the SQL function.
 */
const MUTATING_RPCS_WITH_IDEMPOTENCY: string[] = [
  // Internal _impl delegates (direct EXECUTE revoked; the public wrapper owns the
  // client contract). They appear in generated types after the 2026-07-21 regen,
  // declare p_idempotency_key, and use the canonical replay machinery, so they are
  // classified here rather than in the migration-only bucket.
  '_cancel_order_idem_impl_20260721',
  '_save_field_app_split_invoice_impl',
  '_save_purchase_order_ascii_identity_impl',
  'adjust_inventory',
  'allocate_payment',
  // credit-memo RPCs (landed on main 2026-07-10) — classified WITH idempotency: verified against
  // live pg_proc that each body uses check_idempotency/save scoped to its own operation. They were
  // added to src/types/supabase.ts but never classified here, which left main RED for all sessions.
  'apply_credit_memo_to_invoice',
  'apply_product_cost_basis_change_set',
  'apply_product_pricing_change_set',
  'apply_remaining_prepayments',
  'apply_write_off',
  'approve_return',
  // Supplier Pricing Phase 1b (live since 2026-07-20, admin-only lockdown applied;
  // types regenerated 2026-07-21): each declares p_idempotency_key and replays via
  // check_idempotency/save_idempotency.
  'approve_supplier_price_import',
  'batch_apply_all_prepayments',
  'batch_apply_prepayments',
  'batch_cancel_deliveries',
  'batch_post_invoices',
  'batch_reschedule_deliveries',
  'batch_void_invoices',
  // label-draft + watchdog RPCs (applied live, no migration file) — classified WITH
  // idempotency 2026-07-11: verified against live pg_proc that each body caches its
  // result in idempotency_keys scoped to its own operation and replays on a repeat key.
  'bulk_create_label_drafts',
  'bulk_import_order',
  'cancel_cycle_count',
  'cancel_delivery',
  'cancel_order',
  'cancel_purchase_order',
  'cancel_return',
  'close_accounting_period',
  // close_quote_* (Layer 2, in-migration): bodies use the canonical idempotency_keys block.
  'close_quote_as_applied',
  'close_quote_as_short',
  'commit_blend_ticket_ocr_result',
  'commit_label_draft',
  'complete_cycle_count',
  'complete_delivery',
  'complete_job',
  'confirm_delivery',
  'convert_quote_to_order',
  'correct_supplier_price_observation', // Supplier Pricing 1b — see approve_supplier_price_import note
  'create_application_record_from_blend_ticket',
  'create_blend_ticket',
  'create_commission_payment',
  'create_delivery_with_items',
  'create_direct_order',
  'create_followup_delivery',
  'create_invoice_for_unbilled_delivery',
  'create_invoice_from_order',
  'create_label_draft',
  'create_order_from_blend_ticket',
  'create_pricing_workbook_export',
  'create_quick_delivery',
  'create_rebate_claim',
  'create_split_invoices_from_order',
  'create_vendor_bill',
  'delete_invoices',
  'delete_prepay_credit',
  'delete_purchase_order',
  'dismiss_watchdog_flag',
  'duplicate_quote',
  'edit_delivery',
  'edit_prepay_credit',
  'generate_batch_statements',
  'generate_finance_charges',
  'generate_rup_sales_records',
  'get_ap_aging',
  'get_ap_dashboard_summary',
  'increment_customer_prepay',
  'issue_return_credit',
  'link_blend_ticket_to_order',
  // CRM retry-safe fact intake (applied live 2026-08-07 as 20260807220323) —
  // required p_idempotency_key, replays via check_idempotency/save_idempotency
  // with an exact-request fingerprint.
  'log_customer_fact',
  // CRM retry-safe call logging (migration 20260717060000) — declares
  // p_idempotency_key and replays via check_idempotency/save_idempotency.
  'log_customer_interaction',
  'manual_inventory_add',
  'post_commission_payment',
  'post_invoice',
  'preview_product_cost_basis_changes',
  'preview_product_pricing_changes',
  'process_offline_action',
  'reactivate_vendor',
  'reassign_delivery',
  'receive_po_items',
  'receive_return',
  'record_invoice_payment',
  'record_vendor_payment',
  'reject_supplier_price_import', // Supplier Pricing 1b follow-ups (live) — see approve_supplier_price_import note
  'release_inventory_hold',
  'reopen_accounting_period',
  'resolve_offline_action',
  'restore_cancelled_delivery',
  'restore_cancelled_order',
  'retire_inventory_item',
  'reverse_blend_ticket_approval',
  'reverse_completed_cycle_count',
  'reverse_credit_memo_application', // credit-memo (landed 2026-07-10) — WITH idempotency (see apply_credit_memo_to_invoice note above)
  'reverse_write_off',
  'revert_quote_status',
  // CRM Phase 2 fact RPCs (migration 20260716181306_crm_customer_facts) — classified WITH
  // idempotency 2026-07-16 after the types regen landed them in src/types/supabase.ts:
  // both declare p_idempotency_key and replay via check_idempotency/save_idempotency.
  'review_customer_fact',
  'review_vendor_alias', // Supplier Pricing 1b — see approve_supplier_price_import note
  'save_blend_recipe',
  'save_blend_ticket',
  'save_customer',
  'save_field',
  // Per-line split billing (applied live 2026-07-20 via 20260720233000, PR #164;
  // types regenerated 2026-07-21). Public wrapper does check_idempotency +
  // payload-hash conflict and delegates to _save_field_app_split_invoice_impl.
  'save_field_app_split_invoice',
  'save_invoice',
  'save_job',
  'save_job_applied_record',
  'save_purchase_order',
  'save_quote',
  'set_product_phase3_metadata',
  'stage_offline_action',
  'stage_supplier_price_import', // Supplier Pricing 1b — see approve_supplier_price_import note
  'stage_vendor_alias', // Supplier Pricing 1b — see approve_supplier_price_import note
  'supersede_customer_fact',
  'transfer_invoice_to_job',
  'transfer_job_to_invoice',
  'transition_rebate_claim',
  'unapply_credit_memo',
  'unlink_blend_ticket_from_order',
  'update_blend_ticket_billing_status',
  'update_cycle_count_item',
  'update_order_items',
  'upsert_product_supplier_link', // Supplier Pricing 1b — see approve_supplier_price_import note
  'void_commission_payment',
  'void_delivery',
  'void_invoice',
  'void_invoice_group',
  'void_order',
  'void_payment',
  'void_vendor_bill',
];

/**
 * These mutating RPCs have `p_performed_by` but are MISSING `p_idempotency_key`.
 * Track the gap here so it shrinks over time. When you add idempotency to one,
 * move it from this list to MUTATING_RPCS_WITH_IDEMPOTENCY above.
 */
const MUTATING_RPCS_MISSING_IDEMPOTENCY: string[] = [];

describe('Idempotency Key Coverage', () => {
  it('covers at least 78 mutating RPCs with p_idempotency_key', () => {
    expect(MUTATING_RPCS_WITH_IDEMPOTENCY.length).toBeGreaterThanOrEqual(78);
  });

  it('has no duplicates in the covered list', () => {
    const unique = new Set(MUTATING_RPCS_WITH_IDEMPOTENCY);
    expect(unique.size).toBe(MUTATING_RPCS_WITH_IDEMPOTENCY.length);
  });

  it('has no duplicates in the missing list', () => {
    const unique = new Set(MUTATING_RPCS_MISSING_IDEMPOTENCY);
    expect(unique.size).toBe(MUTATING_RPCS_MISSING_IDEMPOTENCY.length);
  });

  it('has no known mutating RPCs missing idempotency', () => {
    expect(MUTATING_RPCS_MISSING_IDEMPOTENCY).toEqual([]);
  });

  it('no RPC appears in both lists', () => {
    const overlap = MUTATING_RPCS_WITH_IDEMPOTENCY.filter(
      (rpc) => MUTATING_RPCS_MISSING_IDEMPOTENCY.includes(rpc)
    );
    expect(overlap).toEqual([]);
  });

  it('both lists are sorted alphabetically for maintainability', () => {
    const sortedCovered = [...MUTATING_RPCS_WITH_IDEMPOTENCY].sort();
    expect(MUTATING_RPCS_WITH_IDEMPOTENCY).toEqual(sortedCovered);

    const sortedMissing = [...MUTATING_RPCS_MISSING_IDEMPOTENCY].sort();
    expect(MUTATING_RPCS_MISSING_IDEMPOTENCY).toEqual(sortedMissing);
  });

  it('total tracked RPCs (covered + missing) is at least 81', () => {
    const total = MUTATING_RPCS_WITH_IDEMPOTENCY.length + MUTATING_RPCS_MISSING_IDEMPOTENCY.length;
    expect(total).toBeGreaterThanOrEqual(81);
  });
});

// -------------------------------------------------------------------------
// Idempotency BODY verification — the lists above only track which RPCs
// DECLARE p_idempotency_key. That is not enough: the 2026-05-29 review found
// save_job (and others) declared the param but the SQL body never read or
// wrote idempotency_keys, so a double-submit still created duplicate rows —
// and the list-membership tests above happily reported them as "covered."
//
// This block reads the actual migration SQL and asserts that every "covered"
// RPC's LATEST definition genuinely references idempotency_keys (or the
// check_idempotency/save_idempotency helpers). Anything that legitimately does
// NOT must be listed in IDEMPOTENCY_BODY_EXEMPT with a reason — so the gap is
// explicit and visible, never silently mislabeled as covered again.
// -------------------------------------------------------------------------

const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'supabase',
  'migrations'
);

/**
 * Covered-list RPCs whose *disk* body does NOT visibly reference idempotency_keys,
 * each with the reason it is acceptable. Every entry was checked against the LIVE
 * database on 2026-05-29 (pg_get_functiondef + mutation heuristic), since the disk
 * migrations are consolidated/renamed and "latest by filename" is not always the
 * true latest applied definition.
 *
 *  - 'verified-live'  : live body DOES use idempotency_keys, but the disk scan
 *                       can't resolve it across consolidated migrations. Live-confirmed.
 *  - 'natural'        : naturally idempotent — UPDATE-only path, or a NOT EXISTS /
 *                       "already exists" guard makes replay safe.
 *  - 'gap'            : genuine double-submit gap, fix pending. Should shrink to zero.
 *  - 'non-mutating'   : a read / deprecated RPC that was historically parked in the
 *                       covered list; mutates=false live, so idempotency is N/A.
 *                       (Left in place to avoid churning count thresholds; flagged
 *                       for a future list-hygiene cleanup.)
 */
const IDEMPOTENCY_BODY_EXEMPT: Record<
  string,
  'verified-live' | 'natural' | 'gap' | 'non-mutating' | 'table-unique' | 'receipt-unique' | 'delegated'
> = {
  // The batch boundary binds actor + ordered invoice IDs through the private
  // lifecycle claim/complete helpers and gives every post_invoice child a
  // deterministic indexed key. The generic detector does not parse those
  // private helper names; the dedicated test below pins the full contract.
  batch_post_invoices: 'delegated',
  // The live public wrapper authorizes before delegating to the unchanged,
  // directly non-executable implementation that owns the canonical replay
  // lookup/save. A dedicated test below pins that indirection and both grants.
  complete_delivery: 'delegated',
  // The private-provenance wrapper owns a bound replay claim, adds stable
  // order-item serialization and an owner-only creation claim, then invokes
  // the canonical private implementation without a second legacy key.
  create_split_invoices_from_order: 'delegated',
  // The private-provenance wrapper owns the actor + normalized-ID replay claim,
  // adds an owner-only mutation claim, then invokes the private implementation.
  delete_invoices: 'delegated',
  // The terminal-provenance wrapper binds actor + order before issuing exact
  // governed cancellation claims and invoking the private implementation.
  cancel_order: 'delegated',
  // The restored actor guard (migration 20260809170500) authorizes —
  // AUTH_REQUIRED, ACTOR_MISMATCH, is_admin() — and then delegates to
  // _batch_apply_prepayments_impl, which owns the canonical
  // check_idempotency/save_idempotency pair. The wrapper deliberately holds no
  // replay logic of its own: duplicating it would record the same key twice.
  // _impl has no `authenticated` EXECUTE, so the wrapper is the only reachable
  // entry point.
  batch_apply_prepayments: 'delegated',
  // Required-key wrappers fail closed before delegating to the preserved,
  // directly non-executable implementations that own replay and mutation.
  create_invoice_for_unbilled_delivery: 'delegated',
  create_invoice_from_order: 'delegated',
  // The public finance-charge RPC binds actor + as-of date + normalized
  // customer selection through the private lifecycle claim/complete helpers.
  // Its rollback smoke proves exact replay and changed-request rejection.
  generate_finance_charges: 'delegated',
  post_invoice: 'delegated',
  // The public wrapper authorizes active customer scope before delegating to
  // the directly non-executable implementation that owns canonical replay.
  save_invoice: 'delegated',
  // The terminal-provenance wrapper binds the actor and invoice before issuing
  // its exact lifecycle claim and invoking the private implementation.
  void_invoice: 'delegated',
  // The atomic group wrapper binds actor + group + reason through the private
  // lifecycle helpers, then calls the owner-only single-member implementation.
  void_invoice_group: 'delegated',
  // The public wrapper hydrates an omitted cost only for a recognized existing
  // line, then delegates to the directly non-executable integer-cents writer
  // that owns the canonical replay lookup/save.
  save_purchase_order: 'delegated',
  // Section 9 wrappers acquire the PO-derived-state serialization lock before
  // delegating to directly non-executable preserved implementations. Those
  // implementations retain the canonical idempotency lookup/save behavior.
  cancel_purchase_order: 'delegated',
  delete_purchase_order: 'delegated',
  receive_po_items: 'delegated',
  //  - 'table-unique'   : idempotency is enforced NOT via the idempotency_keys table
  //                       but by a dedicated column + PARTIAL UNIQUE index on the RPC's
  //                       own table, with a catch-unique-violation replay. Used when the
  //                       RPC is SECURITY INVOKER (so it cannot call the owner-only
  //                       check_idempotency/save_idempotency helpers) and must preserve
  //                       caller RLS. Verified by its own dedicated test below.
  save_job_applied_record: 'table-unique',
  // Stage 1B-1A uses the permanent receipt's UNIQUE idempotency_key claim.
  // The processor locks that same receipt, verifies the exact key, returns
  // terminal success without re-running, and forwards the key to the canonical
  // completion RPC. The rolled-back smoke proves both business branches replay
  // without a second inventory/application-record effect.
  process_offline_action: 'receipt-unique',
  stage_offline_action: 'receipt-unique',
  // disk scan can't resolve the latest body; live body_uses_idem=true (2026-05-29)
  create_rebate_claim: 'verified-live',
  manual_inventory_add: 'verified-live',
  save_blend_recipe: 'verified-live',
  transition_rebate_claim: 'verified-live',
  unapply_credit_memo: 'verified-live',
  // H4 (2026-07-18): restore_cancelled_order was reduced to an auth gate + an
  // unconditional RAISE (restore is forbidden — it could not safely reverse the
  // cancel's inventory/commission/draw side-effects). It no longer mutates, so
  // there is nothing to make idempotent; the p_idempotency_key param is retained
  // only to keep the signature identical for in-place CREATE OR REPLACE.
  restore_cancelled_order: 'non-mutating',
  // H3 follow-up (2026-07-18): obsolete writer is now an unconditional RAISE
  // compatibility stub. The legacy signature remains so callers fail with an
  // actionable error, but it cannot mutate or require replay protection.
  record_invoice_payment: 'non-mutating',
  // naturally idempotent
  save_blend_ticket: 'natural', // UPDATE-only path; replay overwrites identically
  generate_rup_sales_records: 'natural', // per-row NOT EXISTS guard
  // (no remaining 'gap' entries — batch_apply_all_prepayments + batch_void_invoices
  //  were wrapped with the canonical check_idempotency/save_idempotency helpers in
  //  the P2-3 migration (batch_rpc_idempotency); the body-scan below now detects
  //  them, so they MUST NOT be re-added here.)
  // non-mutating reads / deprecated — idempotency N/A, list-hygiene cleanup pending
  get_ap_aging: 'non-mutating', // pure read (does not even declare the param live)
  get_ap_dashboard_summary: 'non-mutating', // pure read
  generate_batch_statements: 'non-mutating', // mutates=false live
};

/**
 * Migration files (name + content), read from disk ONCE at module load.
 *
 * Why read them once: `latestFunctionBody` is called once per covered RPC, and
 * each call used to re-`readdirSync` + re-`readFileSync` its way back through
 * the 800+ migration files. That O(RPCs × files) synchronous disk I/O finishes
 * in ~2s when this file runs alone (warm cache, no contention) but blew the 5s
 * test timeout under the full parallel suite (150 files contending for CPU/disk)
 * — a perf flake, not a logic failure. Reading each file once makes the disk
 * work O(files) total; the per-RPC scan is then pure in-memory regex.
 *
 * Why EAGER (module scope) rather than lazy-memoized: with a lazy cache the
 * whole directory read was billed to whichever test happened to touch it first,
 * so that one test carried ~900ms warm and >13s under heavy machine load —
 * enough to blow even a generous per-test timeout while every later test ran
 * free. Doing it at import time keeps the cost outside any test's timeout
 * budget and makes it independent of test ordering and `-t` filtering.
 */
const MIGRATION_FILES: { name: string; content: string }[] = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort() // timestamp-prefixed → ascending chronological
  .map((name) => ({ name, content: readFileSync(join(MIGRATIONS_DIR, name), 'utf8') }));

function getMigrationFiles(): { name: string; content: string }[] {
  return MIGRATION_FILES;
}

/**
 * Returns the body of the LATEST migration definition of `rpc`, or null if no
 * disk migration defines it by name (some functions live in consolidated files
 * under a different filename — existence is covered by other tests + live).
 */
function latestFunctionBody(rpc: string): string | null {
  const files = getMigrationFiles();
  const sigRe = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${rpc}\\s*\\(`,
    'i',
  );
  for (let i = files.length - 1; i >= 0; i--) {
    const content = files[i].content;
    const sigIdx = content.search(sigRe);
    if (sigIdx === -1) continue;
    // Extract the dollar-quoted body that follows the signature:  AS $tag$ ... $tag$
    const after = content.slice(sigIdx);
    const bodyMatch = after.match(/AS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/);
    return bodyMatch ? bodyMatch[2] : after;
  }
  return null;
}

function bodyUsesIdempotency(body: string): boolean {
  return /idempotency_keys|check_idempotency|save_idempotency|_claim_bound_lifecycle_idempotency|_bind_completed_lifecycle_idempotency/i.test(body);
}

describe('Idempotency BODY verification (reads migration SQL)', () => {
  it('every covered RPC body actually reads/writes idempotency_keys (not just declares the param)', () => {
    const offenders: string[] = [];
    for (const rpc of MUTATING_RPCS_WITH_IDEMPOTENCY) {
      if (rpc in IDEMPOTENCY_BODY_EXEMPT) continue;
      const body = latestFunctionBody(rpc);
      if (body === null) continue; // defined in a consolidated file; existence covered elsewhere
      if (!bodyUsesIdempotency(body)) offenders.push(rpc);
    }
    // If this fails, the listed RPCs declare p_idempotency_key but never use it.
    // Either add the canonical idempotency block to the SQL, or (if genuinely
    // naturally idempotent) add the RPC to IDEMPOTENCY_BODY_EXEMPT with a reason.
    expect(offenders).toEqual([]);
  });

  it('save_job specifically uses idempotency_keys (regression guard for the 2026-05-29 fix)', () => {
    const body = latestFunctionBody('save_job');
    expect(body).not.toBeNull();
    expect(bodyUsesIdempotency(body as string)).toBe(true);
  });

  it('complete_delivery authorizes before delegating to its idempotent internal implementation', () => {
    const files = getMigrationFiles();
    const wrapper = files.find(
      ({ name }) => name === '20260716173342_authorize_delivery_before_replay.sql'
    )?.content;
    const implementationSource = files.find(
      ({ name }) => name === '20260716120104_gauntlet_access_boundaries.sql'
    )?.content;

    expect(wrapper).toContain('RENAME TO _complete_delivery_authorized_impl');
    expect(wrapper).toMatch(/REVOKE EXECUTE ON FUNCTION public\._complete_delivery_authorized_impl[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
    expect(wrapper).toMatch(/Not authorized to complete this delivery[\s\S]*RETURN public\._complete_delivery_authorized_impl/);
    expect(implementationSource).toContain("v_existing := check_idempotency(p_idempotency_key, 'complete_delivery')");
    expect(implementationSource).toContain("PERFORM save_idempotency(p_idempotency_key, 'complete_delivery', v_result)");
    expect(IDEMPOTENCY_BODY_EXEMPT.complete_delivery).toBe('delegated');
  });

  it('save_invoice authorizes customer scope before delegating to its idempotent implementation', () => {
    const files = getMigrationFiles();
    const initialWrapper = files.find(
      ({ name }) => name === '20260716190000_harden_sales_financial_scope.sql'
    )?.content;
    const wrapper = files.find(
      ({ name }) => name === '20260716210000_harden_invoice_existing_customer_scope.sql'
    )?.content;
    const implementationSource = files.find(
      ({ name }) => name === '20260716120112_gauntlet_money_workflows.sql'
    )?.content;

    expect(initialWrapper).toContain('RENAME TO _save_invoice_scoped_impl');
    expect(initialWrapper).toMatch(/REVOKE ALL ON FUNCTION public\._save_invoice_scoped_impl[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
    expect(wrapper).toMatch(/WHERE id = v_invoice_id[\s\S]*FOR UPDATE/);
    expect(wrapper).toMatch(/WHERE id = v_existing_customer_id[\s\S]*AND assigned_sales_rep = v_actor/);
    expect(wrapper).toMatch(/WHERE id = v_target_customer_id[\s\S]*AND assigned_sales_rep = v_actor[\s\S]*RETURN public\._save_invoice_scoped_impl/);
    expect(implementationSource).toContain("v_existing := check_idempotency(p_idempotency_key, 'save_invoice')");
    expect(implementationSource).toContain("PERFORM save_idempotency(p_idempotency_key, 'save_invoice'");
    expect(IDEMPOTENCY_BODY_EXEMPT.save_invoice).toBe('delegated');
  });

  it('split provenance wrappers preserve the idempotent implementations and forward the exact key', () => {
    const files = getMigrationFiles();
    const wrapper = files.find(
      ({ name }) => name === '20260719044912_trust_only_post_revoke_split_provenance.sql'
    )?.content;
    const splitImplementation = files.find(
      ({ name }) => name === '20260707090000_u7_split_gate_allow_predelivery.sql'
    )?.content;
    const deleteImplementation = files.find(
      ({ name }) => name === '20260711050000_credit_apply_reversal_and_lifecycle.sql'
    )?.content;

    expect(wrapper).toContain(
      'RENAME TO _create_split_invoices_from_order_provenance_impl_20260719'
    );
    expect(wrapper).toContain('RENAME TO _save_invoice_split_provenance_impl_20260719');
    expect(wrapper).toContain('RENAME TO _delete_invoices_split_provenance_impl_20260719');
    expect(wrapper).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\._create_split_invoices_from_order_provenance_impl_20260719[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(wrapper).toMatch(
      /REVOKE ALL ON FUNCTION\s+public\._delete_invoices_split_provenance_impl_20260719[\s\S]*FROM PUBLIC, anon, authenticated, service_role/
    );
    expect(wrapper).toMatch(
      /_create_split_invoices_from_order_provenance_impl_20260719\([\s\S]*p_idempotency_key[\s\S]*INSERT INTO public\.split_invoice_provenance/
    );
    expect(wrapper).toMatch(
      /_delete_invoices_split_provenance_impl_20260719\([\s\S]*p_idempotency_key[\s\S]*UPDATE public\.invoices i[\s\S]*SET status = 'cancelled'/
    );
    expect(splitImplementation).toContain("operation = 'create_split_invoices_from_order'");
    expect(splitImplementation).toContain(
      "VALUES (p_idempotency_key, 'create_split_invoices_from_order'"
    );
    expect(deleteImplementation).toContain(
      "v_existing := check_idempotency(p_idempotency_key, 'delete_invoices')"
    );
    expect(deleteImplementation).toContain(
      "PERFORM save_idempotency(p_idempotency_key, 'delete_invoices'"
    );
    expect(IDEMPOTENCY_BODY_EXEMPT.create_split_invoices_from_order).toBe('delegated');
    expect(IDEMPOTENCY_BODY_EXEMPT.delete_invoices).toBe('delegated');
  });

  it('binds split creation, deletion, void, and cancellation replays to exact requests', () => {
    const files = getMigrationFiles();
    const wrapper = files.find(
      ({ name }) => name === '20260719060256_allow_governed_split_terminal_lifecycle.sql'
    )?.content;
    const splitImplementation = files.find(
      ({ name }) => name === '20260707090000_u7_split_gate_allow_predelivery.sql'
    )?.content;
    const deleteImplementation = files.find(
      ({ name }) => name === '20260711050000_credit_apply_reversal_and_lifecycle.sql'
    )?.content;
    const voidImplementation = files.find(
      ({ name }) => name === '20260718221505_preserve_voided_payment_allocation_history.sql'
    )?.content;
    const cancelImplementation = files.find(
      ({ name }) => name === '20260714222000_return_credit_source_of_truth.sql'
    )?.content;

    expect(wrapper).toContain('CREATE FUNCTION public._claim_bound_lifecycle_idempotency');
    expect(wrapper).toContain('IDEMPOTENCY_REQUEST_MISMATCH');
    expect(wrapper).toContain("v_contract CONSTANT text := 'create_split_invoices_from_order_v1'");
    expect(wrapper).toContain("v_contract CONSTANT text := 'delete_invoices_v1'");
    expect(wrapper).toContain("v_contract CONSTANT text := 'void_invoice_v1'");
    expect(wrapper).toContain("v_contract CONSTANT text := 'cancel_order_v1'");
    expect(wrapper).toContain('SPLIT_INVOICE_IDEMPOTENCY_RESPONSE_MISMATCH');
    expect(wrapper).toContain('RENAME TO _void_invoice_split_provenance_impl_20260719');
    expect(wrapper).toContain('RENAME TO _cancel_order_split_provenance_impl_20260719');
    expect(wrapper).toMatch(
      /_create_split_invoices_from_order_provenance_impl_20260719\([\s\S]*NULL::text/
    );
    expect(wrapper).toMatch(
      /_delete_invoices_split_provenance_impl_20260719\([\s\S]*NULL::text/
    );
    expect(wrapper).toMatch(
      /_void_invoice_split_provenance_impl_20260719\([\s\S]*NULL::text/
    );
    expect(wrapper).toMatch(
      /_cancel_order_split_provenance_impl_20260719\([\s\S]*NULL::text/
    );
    expect(splitImplementation).toContain(
      "VALUES (p_idempotency_key, 'create_split_invoices_from_order'"
    );
    expect(deleteImplementation).toContain(
      "v_existing := check_idempotency(p_idempotency_key, 'delete_invoices')"
    );
    expect(voidImplementation).toContain(
      "v_existing := check_idempotency(p_idempotency_key, 'void_invoice')"
    );
    expect(cancelImplementation).toContain(
      "v_existing := public.check_idempotency(p_idempotency_key, 'cancel_order')"
    );
    expect(IDEMPOTENCY_BODY_EXEMPT.create_split_invoices_from_order).toBe('delegated');
    expect(IDEMPOTENCY_BODY_EXEMPT.delete_invoices).toBe('delegated');
    expect(IDEMPOTENCY_BODY_EXEMPT.void_invoice).toBe('delegated');
    expect(IDEMPOTENCY_BODY_EXEMPT.cancel_order).toBe('delegated');
  });

  it('generate_finance_charges binds replay to actor, date, and normalized customer selection', () => {
    const wrapper = latestFunctionBody('generate_finance_charges');
    const implementationSource = getMigrationFiles().find(
      ({ name }) => name === '20260721125937_ignore_voided_finance_charge_month_dedup.sql',
    )?.content;
    expect(wrapper).not.toBeNull();
    expect(wrapper).toContain('IDEMPOTENCY_KEY_REQUIRED: generate_finance_charges');
    expect(wrapper).toContain('public._generate_finance_charges_idem_impl_20260721(');
    expect(implementationSource).toContain("v_contract CONSTANT text := 'generate_finance_charges_v2'");
    expect(implementationSource).toContain('array_agg(DISTINCT customer_id ORDER BY customer_id)');
    expect(implementationSource).toContain('public._claim_bound_lifecycle_idempotency');
    expect(implementationSource).toContain('public._bind_completed_lifecycle_idempotency');
    expect(implementationSource).toContain("'actor_id', v_actor");
    expect(implementationSource).toContain("'as_of_date', p_as_of_date");
    expect(implementationSource).toContain("'customer_ids', to_jsonb(v_customer_ids)");
    expect(IDEMPOTENCY_BODY_EXEMPT.generate_finance_charges).toBe('delegated');
  });

  it('batch_post_invoices binds replay and forwards a deterministic key to every child post', () => {
    const body = latestFunctionBody('batch_post_invoices');
    expect(body).not.toBeNull();
    expect(body).toContain("v_contract CONSTANT text := 'batch_post_invoices_v2'");
    expect(body).toContain('public._claim_bound_lifecycle_idempotency(');
    expect(body).toContain('public._bind_completed_lifecycle_idempotency(');
    expect(body).toContain("'actor_id', v_actor");
    expect(body).toContain("'invoice_ids', to_jsonb(p_invoice_ids)");
    expect(body).toContain("p_idempotency_key || ':post:' || v_index::text");
    expect(body).not.toMatch(/post_invoice\s*\(\s*v_id\s*\)/);
    expect(IDEMPOTENCY_BODY_EXEMPT.batch_post_invoices).toBe('delegated');
  });

  it('save_purchase_order hydrates omitted cost before delegating to its idempotent implementation', () => {
    const files = getMigrationFiles();
    const wrapper = files.find(
      ({ name }) => name === '20260716213000_preserve_purchase_order_omitted_cost.sql'
    )?.content;
    const implementationSource = files.find(
      ({ name }) => name === '20260716183501_purchase_order_integer_cents.sql'
    )?.content;

    expect(wrapper).toContain('RENAME TO _save_purchase_order_cost_input_impl');
    expect(wrapper).toMatch(/REVOKE ALL ON FUNCTION public\._save_purchase_order_cost_input_impl[\s\S]*FROM PUBLIC, anon, authenticated, service_role/);
    expect(wrapper).toMatch(/poi\.purchase_order_id = p_po_id[\s\S]*RETURN public\._save_purchase_order_cost_input_impl/);
    expect(implementationSource).toContain("v_existing := check_idempotency(p_idempotency_key, 'save_purchase_order')");
    expect(implementationSource).toContain("PERFORM save_idempotency(p_idempotency_key, 'save_purchase_order'");
    expect(IDEMPOTENCY_BODY_EXEMPT.save_purchase_order).toBe('delegated');
  });

  it("every 'gap' exemption genuinely still lacks body idempotency (forces removal when fixed)", () => {
    const stillGap = Object.entries(IDEMPOTENCY_BODY_EXEMPT)
      .filter(([, kind]) => kind === 'gap')
      .map(([rpc]) => rpc)
      .filter((rpc) => {
        const body = latestFunctionBody(rpc);
        return body !== null && bodyUsesIdempotency(body);
      });
    // If an RPC here now uses idempotency, remove it from IDEMPOTENCY_BODY_EXEMPT
    // and move it to fully-covered status.
    expect(stillGap).toEqual([]);
  });

  it("known idempotency 'gap' set is zero (P2-3 closed the last two)", () => {
    const gaps = Object.values(IDEMPOTENCY_BODY_EXEMPT).filter((k) => k === 'gap');
    // batch_apply_all_prepayments + batch_void_invoices were the final two gaps,
    // wrapped with canonical idempotency in the P2-3 migration. Keep this at 0 —
    // any new gap must be fixed in the SQL, not parked here.
    expect(gaps.length).toBe(0);
  });

  it('every exempt RPC is also tracked in the covered list (no orphan exemptions)', () => {
    const orphans = Object.keys(IDEMPOTENCY_BODY_EXEMPT).filter(
      (rpc) => !MUTATING_RPCS_WITH_IDEMPOTENCY.includes(rpc)
    );
    expect(orphans).toEqual([]);
  });
});

// -------------------------------------------------------------------------
// Idempotency COVERAGE DRIFT — fail-closed guard driven by the generated types.
//
// Live Foundation Gauntlet Section 6 MED-1 (2026-07-08): the hand-maintained
// WITH/MISSING lists went stale and a NEW mutating RPC (save_job_applied_record)
// shipped with no double-submit protection while every list-membership test above
// stayed green. Root cause: nothing cross-checked the lists against the CURRENT
// set of RPCs.
//
// src/types/supabase.ts is generated from the live DB (`generate_typescript_types`)
// and is the deterministic, in-repo source of every RPC's real argument shape. This
// block parses it and FAILS when a NEW RPC declares p_idempotency_key without being
// classified — so the guardrail can no longer stay green through a stale list.
// -------------------------------------------------------------------------

type GeneratedRpcShape = { name: string; source: string };
type MigrationFunctionDefinition = { body: string; definition: string; fileName: string };

/** Current RPC names and Args blocks from the generated Supabase types. */
function generatedRpcShapes(): GeneratedRpcShape[] {
  const supabaseTypesPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'types',
    'supabase.ts'
  );
  const src = readFileSync(supabaseTypesPath, 'utf8').replace(/\r\n/g, '\n');
  const start = src.indexOf('Functions: {');
  const end = src.indexOf('\n    CompositeTypes', start);
  const block = src.slice(start, end === -1 ? undefined : end);
  // Each RPC is declared at a 6-space indent: `      <name>:`
  const nameRe = /\n {6}([a-z_][a-z0-9_]*):/g;
  const marks: { name: string; idx: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = nameRe.exec(block))) marks.push({ name: m[1], idx: m.index });
  const out: GeneratedRpcShape[] = [];
  for (let i = 0; i < marks.length; i++) {
    const s = marks[i].idx;
    const e = i + 1 < marks.length ? marks[i + 1].idx : block.length;
    out.push({ name: marks[i].name, source: block.slice(s, e) });
  }
  return out;
}

/** RPC names whose generated Args include p_idempotency_key. */
function generatedRpcsDeclaringIdempotencyKey(): Set<string> {
  return new Set(
    generatedRpcShapes()
      .filter(({ source }) => /p_idempotency_key\??:/.test(source))
      .map(({ name }) => name)
  );
}

/**
 * Build the current disk-side function inventory from migration history.
 * Later definitions replace earlier definitions with the same name, matching
 * PostgreSQL's CREATE OR REPLACE behavior closely enough for the non-overloaded
 * application RPCs this guard covers. Intersecting this with generated types
 * removes dropped functions and trigger-only helpers from the client RPC set.
 */
function latestMigrationFunctions(): Map<string, MigrationFunctionDefinition> {
  const latest = new Map<string, MigrationFunctionDefinition>();
  const signature = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi;
  for (const file of getMigrationFiles()) {
    let match: RegExpExecArray | null;
    while ((match = signature.exec(file.content))) {
      const after = file.content.slice(match.index);
      const nextDefinition = after.slice(match[0].length).search(/\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\b/i);
      const definition = nextDefinition === -1
        ? after
        : after.slice(0, match[0].length + nextDefinition);
      const bodyMatch = definition.match(/\bAS\s+\$([A-Za-z_]*)\$([\s\S]*?)\$\1\$/i);
      if (bodyMatch) {
        latest.set(match[1], {
          body: bodyMatch[2],
          definition,
          fileName: file.name,
        });
      }
    }
  }
  return latest;
}

function latestMigrationFunctionBodies(): Map<string, string> {
  return new Map(
    [...latestMigrationFunctions()].map(([name, value]) => [name, value.body]),
  );
}

function stripSqlComments(body: string): string {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\r\n]*/g, ' ');
}

/** Direct data-changing statements. Transaction/control keywords are excluded. */
function functionBodyMutates(body: string): boolean {
  const sql = stripSqlComments(body);
  return /\b(?:INSERT\s+INTO|UPDATE\s+(?:ONLY\s+)?(?:public\.)?[a-z_"]|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+(?:TABLE\s+)?)/i.test(sql);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Direct DML plus wrappers that call another discovered mutator. */
function transitiveMutatingFunctionNames(bodies: Map<string, string>): Set<string> {
  const mutators = new Set(
    [...bodies].filter(([, body]) => functionBodyMutates(body)).map(([name]) => name),
  );
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, body] of bodies) {
      if (mutators.has(name)) continue;
      const sql = stripSqlComments(body);
      const callsKnownMutator = [...mutators].some((mutator) =>
        new RegExp(`\\b${escapeRegExp(mutator)}\\s*\\(`, 'i').test(sql),
      );
      if (callsKnownMutator) {
        mutators.add(name);
        changed = true;
      }
    }
  }
  return mutators;
}

function registryMigrationHighWater(): string {
  const registryPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '.claude',
    'schema-registry.json'
  );
  const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
    _meta?: { migrations_high_water?: string };
  };
  return registry._meta?.migrations_high_water || '';
}

// Intentional bookkeeping gate: update this set when Section 9 applies or a
// new current pending migration is added; otherwise the inventory fails closed.
// Keep this set aligned with rows explicitly marked PENDING APPLY in
// docs/reference/migration-history.md.
//
// Empty as of 2026-08-10: the Team Board delegation migrations and the
// foundation-review migrations are all applied live and documented below.
const EXPECTED_PENDING_MIGRATION_TIMESTAMPS = new Set<string>([]);

/**
 * Explicitly pending migrations remain part of the contract inventory even
 * when Supabase assigned a later ledger version to another applied migration.
 */
function pendingMigrationTimestamps(): Set<string> {
  const historyPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    'docs',
    'reference',
    'migration-history.md',
  );
  const migrationDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'supabase', 'migrations');
  const lines = readFileSync(historyPath, 'utf8').split(/\r?\n/);
  const pendingRows = lines.filter((line) =>
    /^\|\s*\d+\s*\|\s*\d{14}\s*\|.*\bPENDING APPLY\b/i.test(line),
  );
  const timestamps = new Set(
    pendingRows.map((line) => {
      const match = line.match(/^\|\s*\d+\s*\|\s*(\d{14})\s*\|\s*\*\*PENDING APPLY\b/i);
      if (!match) {
        throw new Error(`Pending migration-history row must start its purpose with PENDING APPLY: ${line}`);
      }
      return match[1];
    }),
  );
  const expected = [...EXPECTED_PENDING_MIGRATION_TIMESTAMPS].sort();
  const actual = [...timestamps].sort();
  if (actual.length !== expected.length || actual.some((timestamp, index) => timestamp !== expected[index])) {
    throw new Error(`Pending migration-history drift: expected ${expected.join(', ')}, found ${actual.join(', ') || '(none)'}`);
  }
  const diskTimestamps = new Set(
    readdirSync(migrationDir)
      .filter((file) => /^\d{14}_.+\.sql$/.test(file))
      .map((file) => file.slice(0, 14)),
  );
  const missingSources = [...timestamps].filter((timestamp) => !diskTimestamps.has(timestamp));
  if (missingSources.length > 0) {
    throw new Error(`Pending migration-history rows lack checked-in migration sources: ${missingSources.join(', ')}`);
  }
  return timestamps;
}

/**
 * Generated RPCs plus mutators introduced after the generated schema snapshot.
 * The latter closes the normal pre-apply gap where a PR migration exists before
 * src/types/supabase.ts can truthfully be regenerated from production.
 */
function generatedMutatingRpcInventory(): Set<string> {
  const generatedNames = new Set(generatedRpcShapes().map(({ name }) => name));
  const functions = latestMigrationFunctions();
  const mutators = transitiveMutatingFunctionNames(latestMigrationFunctionBodies());
  const highWater = registryMigrationHighWater();
  const pendingTimestamps = pendingMigrationTimestamps();
  return new Set([...mutators].filter((name) => {
    const timestamp = functions.get(name)?.fileName.match(/^\d{14}/)?.[0] || '';
    return generatedNames.has(name)
      || (timestamp !== '' && (timestamp > highWater || pendingTimestamps.has(timestamp)));
  }));
}

const MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY = new Set<string>([
  // The live registry/type regeneration through 20260722064814 moved every
  // former entry into
  // MUTATING_RPCS_WITH_IDEMPOTENCY. This bucket remains for the normal pre-apply
  // window: an RPC introduced by a PR migration that is not yet live belongs
  // here until the next truthful live type regeneration.

  // Wave A fix #4 (20260811050000, parked). It accepts p_idempotency_key and
  // routes it through check_idempotency/save_idempotency, but it cannot appear
  // in the generated types until the migration applies, so the inventory sees a
  // mutator with no declared key. This is exactly the pre-apply window this
  // bucket exists for; the staleness test above deletes it for us by failing the
  // moment the RPC shows up in the generated types.
  'correct_job_commission_split',
]);

/**
 * Discovered mutating RPCs for which replay safety does not use p_idempotency_key.
 * Every exemption needs a concrete mechanism/reason. This is intentionally
 * separate from the missing-key backlog: an ordinary business mutator belongs
 * in MUTATING_RPCS_MISSING_IDEMPOTENCY and must eventually be fixed.
 *
 * Trigger-only functions that never reach the generated types enter the
 * inventory only while their migration is newer than the registry high-water,
 * so their entries here are pre-apply-window entries and the
 * "exemptions are current" test below requires pruning them once the migration
 * is applied and the high-water moves past it. `notify_team_note_assignment`
 * (20260810010308) and `trg_recalc_order_totals` (20260809230500) were pruned
 * on 2026-08-10 for exactly that reason — both are live; neither is exempt from
 * anything, they are simply no longer discovered.
 */
const MUTATOR_INVENTORY_EXEMPT: Record<string, string> = {
  _close_undelivered_order_remainder_20260718:
    'preserved internal cancel-remainder impl (Phase 1a closeout); the required-key public cancel_order wrapper owns idempotency and every application-role EXECUTE is revoked',
  _post_deleted_delivery_recovery_invoice_20260719:
    'preserved internal recovery-invoice impl (Phase 1a closeout); the required-key public wrapper owns idempotency and every application-role EXECUTE is revoked',
  _bind_completed_lifecycle_idempotency:
    'idempotency infrastructure helper (sections 2-6 closeout): binds a completed lifecycle result to its key; direct client EXECUTE is revoked',
  _claim_bound_lifecycle_idempotency:
    'idempotency infrastructure helper (sections 2-6 closeout): claims a bound lifecycle key for replay; direct client EXECUTE is revoked',
  _guard_job_commission_split_immutable:
    'performs no DML at all (Wave A fix #4, 20260811050000, parked); it is classified as a mutator only because its refusal message names public.correct_job_commission_split so the office can see how to fix a wrong split, and the scanner reads that message text as a call. It RETURNS trigger, so PostgreSQL refuses any direct call, and every application-role EXECUTE is revoked. Pre-apply-window entry: prune it once the migration is at or below the registry high-water',
  _insert_commissions_for_job: 'internal helper; caller owns idempotency and direct EXECUTE is revoked',
  _insert_commissions_for_order: 'internal helper; caller owns idempotency and direct EXECUTE is revoked',
  _reverse_credit_memo_application: 'internal helper called only by idempotent credit-memo reversal RPCs',
  _recompute_po_on_order_for_products:
    'internal convergent PO-cache recomputation helper; trigger parents own the transaction and direct browser EXECUTE is revoked',
  // Trigger-only helpers whose migrations are now at or below the live registry
  // high-water are absent from generated client types and this inventory. Keeping
  // dead exemptions would silently pre-suppress any future RPC reusing a name.
  _sync_job_holds: 'internal convergent hold-sync helper; direct client EXECUTE is revoked',
  _sync_planned_holds: 'internal convergent hold-sync helper called within parent transactions',
  _sync_quote_job_reservations: 'internal convergent reservation-sync helper called by parent RPCs',
  auto_expire_quotes: 'service-role maintenance sets only currently-expirable quote statuses',
  check_idempotency: 'idempotency infrastructure helper; mutation only purges an expired key',
  check_rate_limit: 'rate-limit counter intentionally records every invocation, including retries',
  check_remainder_reminders: 'maintenance reminder sweep uses persisted sent markers to deduplicate',
  check_unpriced_orders: 'cron reminder sweep uses persisted reminder and escalation sent markers',
  mark_overdue_invoices: 'service-role maintenance updates only invoices currently eligible as overdue',
  recompute_job_applied_acres: 'trigger-only derived-total recomputation; direct client EXECUTE is revoked',
  reconcile_prepay_balances: 'convergent repair sets balances to recomputed ledger truth',
  refresh_watchdog_flags: 'convergent watchdog rebuild deduplicates flags by persisted natural key',
  release_expired_quote_holds: 'maintenance releases only holds that remain in the expired state',
  reserve_job_inventory: 'frontend-callable wrapper over rebuild-from-scratch _sync_job_holds; replays converge and return current shortfalls',
  retry_failed_notifications: 'service-role retry worker advances persisted failed-notification state',
  run_data_integrity_sweep: 'convergent integrity repair recomputes current invariant state',
  run_morning_notification_checks: 'cron sweep has persisted per-recipient notification deduplication',
  run_weekly_db_backup: 'cron-only maintenance with authenticated and anonymous EXECUTE revoked; each dated snapshot is independently retained and pruned',
  save_idempotency: 'idempotency infrastructure helper that stores the parent operation result',
  set_primary_customer_contact: 'convergent primary-contact promotion; replays settle to the same single-primary state; SECURITY INVOKER under customer RLS',
  settle_applied_record_acres: 'trigger-only derived-acre recomputation; direct client EXECUTE is revoked',
  // trg_recalc_order_totals was listed here only for the pre-apply window: the
  // inventory admits a discovered mutator whose defining migration is still
  // ahead of the registry high-water. 20260809230500 is live and the registry
  // was rebuilt from live introspection on 2026-08-10, so the function is no
  // longer in the inventory at all and the exemption went stale. Its safety
  // argument is unchanged and now recorded in migration-history row 862: it
  // RETURNS trigger, so PostgreSQL refuses any direct call, and its
  // recomputation of the order header from the current lines is convergent.
};


describe('Idempotency coverage drift (generated-types driven, fail-closed)', () => {
  it('classifies wrappers that mutate only by calling another function', () => {
    const syntheticBodies = new Map([
      ['internal_writer', 'BEGIN INSERT INTO public.example(id) VALUES (1); END'],
      ['client_wrapper', 'BEGIN PERFORM internal_writer(); END'],
      ['pure_reader', 'BEGIN RETURN QUERY SELECT 1; END'],
    ]);
    expect([...transitiveMutatingFunctionNames(syntheticBodies)].sort()).toEqual([
      'client_wrapper',
      'internal_writer',
    ]);
  });

  it('every generated direct or indirect mutating RPC is classified even when it omits p_idempotency_key', () => {
    const mutators = generatedMutatingRpcInventory();
    const declaresKey = generatedRpcsDeclaringIdempotencyKey();
    const classified = new Set([
      ...MUTATING_RPCS_WITH_IDEMPOTENCY,
      ...MUTATING_RPCS_MISSING_IDEMPOTENCY,
      ...MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY,
      ...Object.keys(MUTATOR_INVENTORY_EXEMPT),
    ]);
    const unclassified = [...mutators]
      .filter((rpc) => !declaresKey.has(rpc) && !classified.has(rpc))
      .sort();

    // A parser regression must not turn the inventory empty and create a false green.
    expect(mutators.size).toBeGreaterThanOrEqual(100);

    // This is the Section 6 escape-class guard: a new function that mutates
    // directly or by calling a discovered mutating helper and
    // omits p_idempotency_key is still discovered from its migration body and
    // fails here until explicitly classified. Never baseline a business mutator
    // as exempt merely to make this test green.
    expect(unclassified).toEqual([]);
  });

  it('migration-only idempotent RPCs are explicit and really enforce the key', () => {
    const generatedNames = new Set(generatedRpcShapes().map(({ name }) => name));
    const functions = latestMigrationFunctions();
    const stale = [...MIGRATION_ONLY_RPCS_WITH_IDEMPOTENCY].filter((rpc) => {
      const current = functions.get(rpc);
      return generatedNames.has(rpc)
        || !/p_idempotency_key\s+text/i.test(current?.definition || '')
        || !bodyUsesIdempotency(current?.body || '');
    });
    expect(stale).toEqual([]);
  });

  it('mutator inventory exemptions are current, explicit, and non-empty', () => {
    const mutators = generatedMutatingRpcInventory();
    const declaresKey = generatedRpcsDeclaringIdempotencyKey();
    const stale = Object.keys(MUTATOR_INVENTORY_EXEMPT)
      .filter((rpc) => !mutators.has(rpc) || declaresKey.has(rpc));
    const vague = Object.entries(MUTATOR_INVENTORY_EXEMPT)
      .filter(([, reason]) => reason.trim().length < 25)
      .map(([rpc]) => rpc);
    expect(stale).toEqual([]);
    expect(vague).toEqual([]);
  });

  it('missing-idempotency backlog remains present and keyless in generated types', () => {
    const generatedNames = new Set(generatedRpcShapes().map(({ name }) => name));
    const declaresKey = generatedRpcsDeclaringIdempotencyKey();
    const stale = MUTATING_RPCS_MISSING_IDEMPOTENCY
      // Some live-confirmed backlog bodies are not reconstructable from the
      // consolidated disk migrations, so generated existence/Args are the
      // honest deterministic check here.
      .filter((rpc) => !generatedNames.has(rpc) || declaresKey.has(rpc))
      .sort();
    expect(stale).toEqual([]);
  });

  it('save_job_applied_record declares p_idempotency_key in the generated types (regression lock for Section 6 HIGH-1)', () => {
    expect(generatedRpcsDeclaringIdempotencyKey().has('save_job_applied_record')).toBe(true);
    expect(MUTATING_RPCS_WITH_IDEMPOTENCY).toContain('save_job_applied_record');
  });

  it('save_job_applied_record body enforces idempotency via its own column + partial unique index (table-unique mechanism)', () => {
    // It is SECURITY INVOKER, so it cannot use the owner-only check_idempotency /
    // save_idempotency helpers; the dedup is the idempotency_key column + a
    // catch-unique-violation replay. Verify that mechanism is actually present.
    const body = latestFunctionBody('save_job_applied_record');
    expect(body).not.toBeNull();
    expect(/idempotency_key/i.test(body as string)).toBe(true);
    expect(/unique_violation/i.test(body as string)).toBe(true);
    // Guard against a silent flip to the helper path that this exemption would mask.
    expect(IDEMPOTENCY_BODY_EXEMPT.save_job_applied_record).toBe('table-unique');
    // The catch-unique-violation replay is only correct if the PARTIAL UNIQUE index
    // actually exists — without it, two same-key creates BOTH insert and the dedup
    // silently breaks while this test would otherwise stay green (Codex P2). Assert
    // the index DDL is present in the migrations.
    const hasPartialUniqueIndex = getMigrationFiles().some((f) =>
      /CREATE\s+UNIQUE\s+INDEX[\s\S]*?job_applied_records[\s\S]*?\(\s*idempotency_key\s*\)[\s\S]*?WHERE\s+idempotency_key\s+IS\s+NOT\s+NULL/i.test(
        f.content
      )
    );
    expect(hasPartialUniqueIndex).toBe(true);
  });

  it('every covered RPC (except non-mutating reads) declares p_idempotency_key in the generated types', () => {
    const generated = generatedRpcsDeclaringIdempotencyKey();
    const offenders = MUTATING_RPCS_WITH_IDEMPOTENCY.filter(
      (rpc) => IDEMPOTENCY_BODY_EXEMPT[rpc] !== 'non-mutating' && !generated.has(rpc)
    );
    // A covered RPC no longer declaring the param = it lost idempotency in a re-emit,
    // or the name drifted. Re-verify against the live DB and fix the SQL or the list.
    expect(offenders).toEqual([]);
  });

  it('every key-declaring generated mutator has a real replay mechanism', () => {
    const generatedWithKey = generatedRpcsDeclaringIdempotencyKey();
    const mutators = generatedMutatingRpcInventory();
    const functions = latestMigrationFunctions();

    const offenders = [...generatedWithKey]
      .filter((rpc) => mutators.has(rpc))
      .filter((rpc) => {
        if (rpc in IDEMPOTENCY_BODY_EXEMPT) return false;
        const body = functions.get(rpc)?.body || latestFunctionBody(rpc) || '';
        return !bodyUsesIdempotency(body);
      })
      .sort();

    // This replaces the old 55-name untriaged baseline. A param alone is never
    // treated as coverage: every discovered mutator must use the canonical
    // ledger helpers or carry a narrow, evidence-backed exemption.
    expect(offenders).toEqual([]);
  });
});
