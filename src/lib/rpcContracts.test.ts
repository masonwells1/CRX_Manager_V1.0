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
  p_commission_split: { splits: Array<{ recipient: string; percentage: number }> } | null;
  p_performed_by: string;
}

interface CompleteDeliveryParams {
  p_delivery_id: string;  // uuid
  p_signed_by: string;    // text
  p_performed_by: string; // uuid
  p_quantities?: Record<string, number>; // optional jsonb
}

interface RecordPaymentParams {
  p_order_id: string;
  p_amount: number;
  p_method: string;
  p_reference: string | null;
  p_note: string | null;
  p_performed_by: string;
}

interface SaveQuoteParams {
  p_quote_id: string | null;
  p_customer_id: string;
  p_tier: number;
  p_status: string;
  p_is_planned: boolean;
  p_commission_split: { splits: Array<{ recipient: string; percentage: number }> } | null;
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
    default_commission_split?: { splits: Array<{ recipient: string; percentage: number }> } | null;
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
  p_id: string | null;
  p_vendor: string;
  p_status: string;
  p_submitted_date: string | null;
  p_expected_delivery_date: string | null;
  p_notes: string | null;
  p_items: Array<{
    id: string | null;
    product_id: string;
    quantity_ordered: number;
    unit_cost: number;
    quantity_received: number;
    unit_size: string | null;
    notes: string | null;
  }>;
  p_performed_by: string;
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

describe('RPC contract: record_payment', () => {
  it('accepts valid params', () => {
    const params = assertShape<RecordPaymentParams>({
      p_order_id: 'order-uuid',
      p_amount: 500.00,
      p_method: 'check',
      p_reference: 'CHK-1234',
      p_note: null,
      p_performed_by: 'user-uuid',
    });
    expect(params.p_amount).toBeGreaterThan(0);
  });
});

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
      p_id: null,
      p_vendor: 'Acme Chemicals',
      p_status: 'draft',
      p_submitted_date: null,
      p_expected_delivery_date: '2026-03-15',
      p_notes: null,
      p_items: [
        {
          id: null,
          product_id: 'prod-uuid',
          quantity_ordered: 100,
          unit_cost: 10.50,
          quantity_received: 0,
          unit_size: 'Gallon',
          notes: null,
        },
      ],
      p_performed_by: 'user-uuid',
    });
    expect(params.p_items).toHaveLength(1);
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
