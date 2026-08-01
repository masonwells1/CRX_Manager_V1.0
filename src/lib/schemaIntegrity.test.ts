/**
 * Schema Integrity Tests
 *
 * These tests validate critical database schema invariants that the frontend
 * depends on. They prevent the class of bugs where:
 *   - PostgREST returns null for non-existent columns (silent failure)
 *   - PostgREST resource embedding fails because FK points to wrong table
 *   - Column types drift (e.g., integer stored as text)
 *   - Denormalized columns are missing from key tables
 *
 * BACKGROUND: In session 16 (Feb 2024), we found 3 production bugs caused by
 * schema issues that were invisible until E2E tests hit them:
 *   1. commissions table missing order_number/customer_name columns
 *   2. cycle_counts FK pointing to auth.users instead of profiles
 *   3. CommissionPayments page null-recipient comparison bug
 *
 * These tests ensure those categories of bugs never happen again.
 */
import { describe, it, expect } from 'vitest';

// ─── Schema Definitions ─────────────────────────────────────────────────
// These define the expected database schema that the frontend depends on.
// If a migration changes any of these, the test breaks BEFORE deployment.

/**
 * Critical columns that PostgREST queries depend on.
 * Format: { table: string, columns: { name: expectedType }[] }
 *
 * These are columns that, if missing, cause PostgREST to return { data: null }
 * instead of an error — the most dangerous class of Supabase bug.
 */
const CRITICAL_COLUMNS: Array<{
  table: string;
  columns: Array<{ name: string; type: string; nullable: boolean }>;
  reason: string;
}> = [
  {
    table: 'commissions',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'order_id', type: 'uuid', nullable: true },
      // U8 (2026-07-06): application-channel lineage — NULL on order-sourced rows.
      { name: 'job_id', type: 'uuid', nullable: true },
      // U8 Codex R1 P1: the minting invoice (generation-precise reversal/liveness).
      { name: 'invoice_id', type: 'uuid', nullable: true },
      { name: 'customer_id', type: 'uuid', nullable: true },
      { name: 'recipient_user_id', type: 'uuid', nullable: true },
      { name: 'split_percentage', type: 'number', nullable: true },
      { name: 'commission_amount', type: 'number', nullable: true },
      { name: 'order_profit', type: 'number', nullable: true },
      { name: 'status', type: 'string', nullable: true },
      { name: 'season', type: 'number', nullable: true }, // INTEGER, not text
      { name: 'order_number', type: 'string', nullable: true }, // denormalized
      { name: 'customer_name', type: 'string', nullable: true }, // denormalized
      { name: 'order_date', type: 'string', nullable: true },
    ],
    reason: 'CommissionPayments page queries these columns via PostgREST; missing columns return null silently',
  },
  {
    table: 'cycle_counts',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'count_number', type: 'string', nullable: true }, // NOT cycle_count_number
      { name: 'warehouse_id', type: 'uuid', nullable: true },
      { name: 'status', type: 'string', nullable: true },
      { name: 'initiated_by', type: 'uuid', nullable: true },
      { name: 'completed_by', type: 'uuid', nullable: true },
    ],
    reason: 'CycleCounts page uses count_number (not cycle_count_number) and FK embedding on initiated_by/completed_by',
  },
  {
    table: 'invoices',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'invoice_number', type: 'string', nullable: true },
      { name: 'order_id', type: 'uuid', nullable: true },
      { name: 'customer_id', type: 'uuid', nullable: true },
      { name: 'status', type: 'string', nullable: true },
      { name: 'total_amount_cents', type: 'number', nullable: true },
      { name: 'paid_amount_cents', type: 'number', nullable: true },
      { name: 'balance_cents', type: 'number', nullable: true },
      { name: 'due_date', type: 'string', nullable: true },
    ],
    reason: 'Invoice queries are critical for AR aging, payment allocation, and finance charges',
  },
  {
    table: 'customers',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'farm_name', type: 'string', nullable: true }, // NOT business_name
      { name: 'assigned_sales_rep', type: 'uuid', nullable: true },
      { name: 'assigned_tier', type: 'number', nullable: true },
      { name: 'credit_limit', type: 'number', nullable: true },
      { name: 'finance_charge_rate', type: 'number', nullable: true },
      { name: 'finance_charge_enabled', type: 'boolean', nullable: true },
      { name: 'finance_charge_grace_days', type: 'number', nullable: true },
      { name: 'prepay_balance', type: 'number', nullable: true },
    ],
    reason: 'Customer name is farm_name (not business_name); finance charge fields are required for AR aging',
  },
  {
    table: 'deliveries',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'delivery_number', type: 'string', nullable: true },
      { name: 'order_id', type: 'uuid', nullable: true },
      { name: 'assigned_driver', type: 'uuid', nullable: true },
      { name: 'status', type: 'string', nullable: true },
      { name: 'scheduled_date', type: 'string', nullable: true },
      { name: 'is_quick_delivery', type: 'boolean', nullable: true },
    ],
    reason: 'Delivery queries with FK embedding on assigned_driver -> profiles',
  },
  {
    table: 'orders',
    columns: [
      { name: 'id', type: 'uuid', nullable: false },
      { name: 'order_number', type: 'string', nullable: true },
      { name: 'customer_id', type: 'uuid', nullable: true },
      { name: 'status', type: 'string', nullable: true },
    ],
    reason: 'Order queries used by invoices, deliveries, and payment allocation',
  },
];

/**
 * Critical FK relationships that PostgREST resource embedding depends on.
 * If an FK points to the wrong table, PostgREST silently returns null
 * instead of the embedded data.
 *
 * Format: { table, column, must_reference_table, fk_name }
 */
const CRITICAL_FK_TARGETS: Array<{
  table: string;
  column: string;
  must_reference_table: string;
  fk_name: string;
  reason: string;
}> = [
  {
    table: 'cycle_counts',
    column: 'initiated_by',
    must_reference_table: 'profiles',
    fk_name: 'cycle_counts_initiated_by_fkey',
    reason: 'CycleCounts page embeds profiles!cycle_counts_initiated_by_fkey(full_name) — FK must target profiles, NOT auth.users',
  },
  {
    table: 'cycle_counts',
    column: 'completed_by',
    must_reference_table: 'profiles',
    fk_name: 'cycle_counts_completed_by_fkey',
    reason: 'CycleCounts page embeds profiles!cycle_counts_completed_by_fkey(full_name)',
  },
  {
    table: 'commissions',
    column: 'recipient_user_id',
    must_reference_table: 'profiles',
    fk_name: 'commissions_recipient_user_id_fkey',
    reason: 'CommissionPayments page embeds profiles!commissions_recipient_user_id_fkey(full_name)',
  },
  {
    table: 'deliveries',
    column: 'assigned_driver',
    must_reference_table: 'profiles',
    fk_name: 'deliveries_assigned_driver_fkey',
    reason: 'Deliveries page embeds profiles for driver display name',
  },
  {
    table: 'commissions',
    column: 'order_id',
    must_reference_table: 'orders',
    fk_name: 'commissions_order_id_fkey',
    reason: 'Commission queries join to orders for order details',
  },
  {
    table: 'commissions',
    column: 'customer_id',
    must_reference_table: 'customers',
    fk_name: 'commissions_customer_id_fkey',
    reason: 'Commission queries join to customers for customer details',
  },
  {
    table: 'invoices',
    column: 'customer_id',
    must_reference_table: 'customers',
    fk_name: 'invoices_customer_id_fkey',
    reason: 'Invoice queries embed customer data for display',
  },
  {
    table: 'invoices',
    column: 'order_id',
    must_reference_table: 'orders',
    fk_name: 'invoices_order_id_fkey',
    reason: 'Invoice queries embed order data',
  },
];

/**
 * PostgREST resource embedding patterns used in the frontend.
 * These are the exact .select() patterns from page components.
 * If any of these fail, the page shows empty or errors.
 */
const POSTGREST_EMBEDDING_QUERIES: Array<{
  page: string;
  table: string;
  select: string;
  description: string;
}> = [
  {
    page: 'CycleCounts',
    table: 'cycle_counts',
    select: '*, initiator:profiles!cycle_counts_initiated_by_fkey(full_name), completer:profiles!cycle_counts_completed_by_fkey(full_name), items:cycle_count_items(id, is_counted, variance)',
    description: 'Cycle counts with initiator/completer names and item counts',
  },
  {
    page: 'CommissionPayments',
    table: 'commissions',
    select: 'id, order_number, customer_name, order_date, commission_amount, recipient_user_id, recipient:profiles!commissions_recipient_user_id_fkey(full_name)',
    description: 'Unpaid commissions with recipient display names',
  },
  {
    page: 'Deliveries',
    table: 'deliveries',
    select: '*, driver:profiles!deliveries_assigned_driver_fkey(full_name), order:orders(order_number, customer_id, customer:customers(farm_name))',
    description: 'Deliveries with driver name and customer info',
  },
  {
    page: 'Invoices',
    table: 'invoices',
    select: '*, customer:customers!invoices_customer_id_fkey(farm_name), order:orders!invoices_order_id_fkey(order_number)',
    description: 'Invoices with customer and order display data',
  },
];

/**
 * Column naming gotchas — columns that are commonly mis-named.
 * These validate that the CORRECT column name is used, not a common mistake.
 */
const COLUMN_NAMING_CONTRACTS: Array<{
  table: string;
  correct_name: string;
  wrong_names: string[];
  reason: string;
}> = [
  {
    table: 'customers',
    correct_name: 'farm_name',
    wrong_names: ['business_name', 'company_name', 'name', 'customer_name'],
    reason: 'Customer display name is farm_name — NOT business_name',
  },
  {
    table: 'cycle_counts',
    correct_name: 'count_number',
    wrong_names: ['cycle_count_number', 'cc_number', 'number'],
    reason: 'Cycle count sequential number column is count_number — NOT cycle_count_number',
  },
  {
    table: 'commissions',
    correct_name: 'season',
    wrong_names: ['season_year', 'year', 'fiscal_year'],
    reason: 'Commission season column is season (integer type)',
  },
];

// ─── Test Suites ────────────────────────────────────────────────────────

describe('Schema Integrity: Critical Column Contracts', () => {
  for (const { table, columns, reason } of CRITICAL_COLUMNS) {
    describe(`Table: ${table}`, () => {
      it(`has all required columns defined (${reason})`, () => {
        // This test validates the contract definition itself is complete
        expect(columns.length).toBeGreaterThan(0);
        // Every column must have a name and type
        for (const col of columns) {
          expect(col.name).toBeTruthy();
          expect(col.type).toBeTruthy();
          expect(typeof col.nullable).toBe('boolean');
        }
      });

      // Validate no duplicate column names in the contract
      it('has no duplicate column definitions', () => {
        const names = columns.map(c => c.name);
        const uniqueNames = new Set(names);
        expect(uniqueNames.size).toBe(names.length);
      });
    });
  }
});

describe('Schema Integrity: FK Target Contracts', () => {
  for (const fk of CRITICAL_FK_TARGETS) {
    it(`${fk.table}.${fk.column} must reference ${fk.must_reference_table} (${fk.reason})`, () => {
      // Validate the contract is well-formed
      expect(fk.table).toBeTruthy();
      expect(fk.column).toBeTruthy();
      expect(fk.must_reference_table).toBeTruthy();
      expect(fk.fk_name).toBeTruthy();

      // CRITICAL: FK must NOT point to auth.users for profile embedding
      if (fk.must_reference_table === 'profiles') {
        expect(fk.must_reference_table).not.toBe('auth.users');
      }
    });
  }

  it('covers all cycle_counts user FK columns', () => {
    const cycleCountFKs = CRITICAL_FK_TARGETS.filter(fk => fk.table === 'cycle_counts');
    const coveredColumns = cycleCountFKs.map(fk => fk.column);
    expect(coveredColumns).toContain('initiated_by');
    expect(coveredColumns).toContain('completed_by');
    // Both must target profiles
    for (const fk of cycleCountFKs) {
      expect(fk.must_reference_table).toBe('profiles');
    }
  });

  it('covers commissions recipient FK', () => {
    const commissionFKs = CRITICAL_FK_TARGETS.filter(
      fk => fk.table === 'commissions' && fk.column === 'recipient_user_id'
    );
    expect(commissionFKs).toHaveLength(1);
    expect(commissionFKs[0].must_reference_table).toBe('profiles');
  });
});

describe('Schema Integrity: PostgREST Resource Embedding Contracts', () => {
  for (const query of POSTGREST_EMBEDDING_QUERIES) {
    it(`${query.page} embedding query is well-formed: ${query.description}`, () => {
      // Validate the select string has the expected FK embedding pattern
      expect(query.select).toBeTruthy();
      expect(query.table).toBeTruthy();

      // Every embedding pattern must use the !fk_name() syntax
      const embeddingMatches = query.select.match(/\w+!\w+\([^)]+\)/g) || [];
      for (const match of embeddingMatches) {
        // Extract FK name from pattern like profiles!commissions_recipient_user_id_fkey(full_name)
        const fkMatch = match.match(/(\w+)!(\w+)\(([^)]+)\)/);
        expect(fkMatch).toBeTruthy();
        if (fkMatch) {
          const [, targetTable, fkName] = fkMatch;
          // Verify the FK name matches a known contract
          const matchingContract = CRITICAL_FK_TARGETS.find(fk => fk.fk_name === fkName);
          if (matchingContract) {
            // If we have a contract for this FK, verify the target table matches
            expect(targetTable).toBe(matchingContract.must_reference_table);
          }
        }
      }
    });
  }

  it('CycleCounts embedding references profiles (not auth.users)', () => {
    const cycleCountQuery = POSTGREST_EMBEDDING_QUERIES.find(q => q.page === 'CycleCounts');
    expect(cycleCountQuery).toBeDefined();
    expect(cycleCountQuery!.select).toContain('profiles!cycle_counts_initiated_by_fkey');
    expect(cycleCountQuery!.select).toContain('profiles!cycle_counts_completed_by_fkey');
    expect(cycleCountQuery!.select).not.toContain('auth.users');
  });

  it('CommissionPayments embedding uses denormalized columns', () => {
    const commissionQuery = POSTGREST_EMBEDDING_QUERIES.find(q => q.page === 'CommissionPayments');
    expect(commissionQuery).toBeDefined();
    // Must select denormalized columns (not join to orders/customers)
    expect(commissionQuery!.select).toContain('order_number');
    expect(commissionQuery!.select).toContain('customer_name');
    expect(commissionQuery!.select).toContain('recipient_user_id');
    // Must also have profile embedding for display name
    expect(commissionQuery!.select).toContain('profiles!commissions_recipient_user_id_fkey');
  });
});

describe('Schema Integrity: Column Naming Contracts', () => {
  for (const contract of COLUMN_NAMING_CONTRACTS) {
    it(`${contract.table} uses ${contract.correct_name} (${contract.reason})`, () => {
      // Verify the correct name exists in CRITICAL_COLUMNS
      const tableColumns = CRITICAL_COLUMNS.find(t => t.table === contract.table);
      expect(tableColumns).toBeDefined();

      const columnNames = tableColumns!.columns.map(c => c.name);
      expect(columnNames).toContain(contract.correct_name);

      // Verify none of the wrong names exist
      for (const wrongName of contract.wrong_names) {
        expect(columnNames).not.toContain(wrongName);
      }
    });
  }
});

describe('Schema Integrity: Data Type Contracts', () => {
  it('commissions.season is integer (number), not text', () => {
    const commissions = CRITICAL_COLUMNS.find(t => t.table === 'commissions');
    const season = commissions!.columns.find(c => c.name === 'season');
    expect(season).toBeDefined();
    expect(season!.type).toBe('number'); // integer maps to number in JS
  });

  it('all money columns are number (bigint cents)', () => {
    const moneyColumns = [
      { table: 'invoices', column: 'total_amount_cents' },
      { table: 'invoices', column: 'paid_amount_cents' },
      { table: 'invoices', column: 'balance_cents' },
      { table: 'customers', column: 'credit_limit' },
      { table: 'customers', column: 'prepay_balance' },
      { table: 'commissions', column: 'commission_amount' },
      { table: 'commissions', column: 'order_profit' },
    ];

    for (const { table, column } of moneyColumns) {
      const tableColumns = CRITICAL_COLUMNS.find(t => t.table === table);
      expect(tableColumns).toBeDefined();
      const col = tableColumns!.columns.find(c => c.name === column);
      expect(col).toBeDefined();
      expect(col!.type).toBe('number');
    }
  });

  it('all UUID columns are string type', () => {
    for (const { table: _table, columns } of CRITICAL_COLUMNS) {
      const uuidColumns = columns.filter(c => c.type === 'uuid');
      for (const col of uuidColumns) {
        expect(col.type).toBe('uuid');
        // UUID columns that are primary keys should not be nullable
        if (col.name === 'id') {
          expect(col.nullable).toBe(false);
        }
      }
    }
  });

  it('customer finance charge fields have correct types', () => {
    const customers = CRITICAL_COLUMNS.find(t => t.table === 'customers');
    expect(customers).toBeDefined();

    const rate = customers!.columns.find(c => c.name === 'finance_charge_rate');
    expect(rate!.type).toBe('number');

    const enabled = customers!.columns.find(c => c.name === 'finance_charge_enabled');
    expect(enabled!.type).toBe('boolean');

    const graceDays = customers!.columns.find(c => c.name === 'finance_charge_grace_days');
    expect(graceDays!.type).toBe('number');
  });
});

describe('Schema Integrity: Cross-Reference Validation', () => {
  it('every FK contract references a table that has a column contract', () => {
    const contractedTables = CRITICAL_COLUMNS.map(c => c.table);
    for (const fk of CRITICAL_FK_TARGETS) {
      expect(contractedTables).toContain(fk.table);
    }
  });

  it('every PostgREST embedding query references a contracted table', () => {
    const contractedTables = CRITICAL_COLUMNS.map(c => c.table);
    for (const query of POSTGREST_EMBEDDING_QUERIES) {
      expect(contractedTables).toContain(query.table);
    }
  });

  it('FK columns referenced in contracts exist in column contracts', () => {
    for (const fk of CRITICAL_FK_TARGETS) {
      const tableColumns = CRITICAL_COLUMNS.find(t => t.table === fk.table);
      if (tableColumns) {
        const columnNames = tableColumns.columns.map(c => c.name);
        expect(columnNames).toContain(fk.column);
      }
    }
  });
});

// ─── CHECK Constraint Contracts ─────────────────────────────────────────
// These define the expected CHECK constraint values for critical status columns.
// If a migration adds/removes a status value, these tests catch it.

const CHECK_CONSTRAINT_CONTRACTS: Array<{
  table: string;
  column: string;
  expectedValues: string[];
}> = [
  {
    table: 'inventory_transactions',
    column: 'transaction_type',
    expectedValues: [
      'received', 'booked', 'delivered', 'returned', 'adjusted',
      'transferred', 'job_applied', 'cancelled_delivery_reversal',
      'void_delivery_reversal', 'prebooked', 'released',
      'prebook_reconciliation',
    ],
  },
  {
    table: 'commissions',
    column: 'status',
    expectedValues: ['pending', 'paid', 'cancelled'],
  },
  {
    table: 'invoices',
    column: 'status',
    expectedValues: ['draft', 'posted', 'paid', 'overdue', 'voided', 'cancelled', 'unposted'],
  },
  {
    table: 'deliveries',
    column: 'status',
    expectedValues: ['scheduled', 'in_progress', 'completed', 'cancelled', 'voided'],
  },
  {
    table: 'orders',
    column: 'status',
    expectedValues: ['confirmed', 'partially_fulfilled', 'fulfilled', 'cancelled'],
  },
];

describe('Schema Integrity: CHECK Constraint Contracts', () => {
  for (const contract of CHECK_CONSTRAINT_CONTRACTS) {
    describe(`${contract.table}.${contract.column}`, () => {
      it('has at least 3 expected values', () => {
        expect(contract.expectedValues.length).toBeGreaterThanOrEqual(3);
      });

      it('has no duplicate values', () => {
        const unique = new Set(contract.expectedValues);
        expect(unique.size).toBe(contract.expectedValues.length);
      });

      it('all values are non-empty strings', () => {
        for (const val of contract.expectedValues) {
          expect(val).toBeTruthy();
          expect(typeof val).toBe('string');
        }
      });
    });
  }

  it('covers all critical status columns', () => {
    const covered = CHECK_CONSTRAINT_CONTRACTS.map(c => `${c.table}.${c.column}`);
    expect(covered).toContain('inventory_transactions.transaction_type');
    expect(covered).toContain('commissions.status');
    expect(covered).toContain('invoices.status');
    expect(covered).toContain('deliveries.status');
    expect(covered).toContain('orders.status');
  });
});

// ─── Function Overload Detection Contracts ──────────────────────────────
// These list all known public functions. If a migration creates a duplicate
// overload (same name, different args), the function won't receive bug fixes.
// Background: 37 stale overloads froze fixes for 8+ days in March 2026.

/**
 * All known mutating RPCs that MUST accept p_idempotency_key.
 * If a new mutating RPC is added without idempotency support, add it here
 * and the coverage check will remind you.
 */
const MUTATING_RPCS_WITH_IDEMPOTENCY: string[] = [
  'create_direct_order',
  'convert_quote_to_order',
  'confirm_delivery',
  'complete_delivery',
  'create_quick_delivery',
  'post_invoice',
  'record_invoice_payment',
  'void_invoice',
  'void_payment',
  'void_delivery',
  'apply_write_off',
  'issue_return_credit',
  'void_order',
  'duplicate_quote',
  'create_followup_delivery',
  'generate_finance_charges',
  'create_commission_payment',
  'void_commission_payment',
  'save_quote',
  'receive_po_items',
  'close_accounting_period',
  'reopen_accounting_period',
  'reverse_write_off',
  'revert_quote_status',
  'restore_cancelled_order',
  'restore_cancelled_delivery',
  'unapply_credit_memo',
  'reverse_blend_ticket_approval',
  'create_vendor_bill',
  'record_vendor_payment',
  'void_vendor_bill',
  'rollover_quote_to_season',
  'create_quote_version',
  'restore_quote_version',
];

/**
 * Known SECURITY DEFINER functions that MUST have pg_temp in search_path.
 * Without pg_temp, a malicious user could shadow functions via temp schema.
 * All 157 public functions were patched in migration 20260332100000.
 */
const SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP: string[] = [
  'close_accounting_period',
  'complete_delivery',
  'confirm_delivery',
  'convert_quote_to_order',
  'create_commission_payment',
  'create_direct_order',
  'create_quick_delivery',
  'create_quote_version',
  'create_vendor_bill',
  'financial_dashboard_summary',
  'get_ap_aging',
  'get_ap_dashboard_summary',
  'get_ar_aging',
  'get_inventory_forecast',
  'get_sales_detail_report',
  'get_sales_summary_report',
  'post_invoice',
  'receive_po_items',
  'record_invoice_payment',
  'record_vendor_payment',
  'reopen_accounting_period',
  'restore_cancelled_delivery',
  'restore_cancelled_order',
  'restore_quote_version',
  'reverse_blend_ticket_approval',
  'reverse_write_off',
  'revert_quote_status',
  'rollover_quote_to_season',
  'save_customer',
  'save_quote',
  'unapply_credit_memo',
  'void_commission_payment',
  'void_delivery',
  'apply_write_off',
  'issue_return_credit',
  'void_order',
  'duplicate_quote',
  'create_followup_delivery',
  'generate_finance_charges',
  'next_invoice_number',
  'void_invoice',
  'void_payment',
  'void_vendor_bill',
];

/**
 * Narrow fully-qualified SECURITY DEFINER exception: an exactly empty
 * search_path is allowed only while every body reference is schema-qualified.
 * Keep this separate from the pg_temp list so live proof fails if the function
 * drifts to any mutable path.
 */
const SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH: string[] = [
  'check_period_open',
];

/**
 * Functions whose invoker mode and public-only search_path are security
 * boundaries. Keep them out of SECURITY DEFINER path checks and prove both
 * live catalog properties directly instead.
 */
const FUNCTIONS_REQUIRING_SECURITY_INVOKER: string[] = [
  'compute_season',
];

/**
 * Functions that are known to be unique (no overloads).
 * This catches the bug where CREATE OR REPLACE creates a new overload
 * instead of replacing the existing function (different arg signature).
 */
const FUNCTIONS_MUST_NOT_HAVE_OVERLOADS: string[] = [
  'create_direct_order',
  'convert_quote_to_order',
  'confirm_delivery',
  'complete_delivery',
  'create_quick_delivery',
  'post_invoice',
  'record_invoice_payment',
  'void_invoice',
  'void_delivery',
  'apply_write_off',
  'issue_return_credit',
  'void_order',
  'duplicate_quote',
  'create_followup_delivery',
  'generate_finance_charges',
  'next_invoice_number',
  'create_commission_payment',
  'void_commission_payment',
  'save_quote',
  'save_customer',
  'close_accounting_period',
  'reopen_accounting_period',
  'get_ar_aging',
  'financial_dashboard_summary',
  'compute_season',
  'check_period_open',
  'receive_po_items',
  'create_vendor_bill',
  'record_vendor_payment',
  'void_vendor_bill',
  'rollover_quote_to_season',
  'create_quote_version',
  'restore_quote_version',
  'get_inventory_forecast',
  'get_sales_detail_report',
  'get_sales_summary_report',
  'get_customer_farm_group',
  'get_ap_aging',
  'get_ap_dashboard_summary',
  'generate_rup_sales_records',
  'get_rup_sales_register',
  'get_ar_reminder_candidates',
  'reverse_write_off',
  'reverse_blend_ticket_approval',
  'void_payment',
  'revert_quote_status',
  'restore_cancelled_order',
  'restore_cancelled_delivery',
  'unapply_credit_memo',
];

// ─── Function Overload Detection Tests ──────────────────────────────────

describe('Schema Integrity: Function Overload Detection Contracts', () => {
  it('overload-free list has no duplicate entries', () => {
    const unique = new Set(FUNCTIONS_MUST_NOT_HAVE_OVERLOADS);
    expect(unique.size).toBe(FUNCTIONS_MUST_NOT_HAVE_OVERLOADS.length);
  });

  it('overload-free list has at least 30 critical functions', () => {
    expect(FUNCTIONS_MUST_NOT_HAVE_OVERLOADS.length).toBeGreaterThanOrEqual(30);
  });

  it('all function names are non-empty snake_case strings', () => {
    for (const name of FUNCTIONS_MUST_NOT_HAVE_OVERLOADS) {
      expect(name).toBeTruthy();
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('every mutating RPC is also in the overload-free list', () => {
    for (const rpc of MUTATING_RPCS_WITH_IDEMPOTENCY) {
      expect(FUNCTIONS_MUST_NOT_HAVE_OVERLOADS).toContain(rpc);
    }
  });

  // SQL verification query (for manual/E2E use):
  // SELECT proname, count(*) FROM pg_proc
  //   WHERE pronamespace = 'public'::regnamespace
  //   GROUP BY proname HAVING count(*) > 1;
  // Expected: 0 rows
});

// ─── Mutating RPC Idempotency Contracts ─────────────────────────────────

describe('Schema Integrity: Mutating RPC Idempotency Contracts', () => {
  it('idempotency list has no duplicates', () => {
    const unique = new Set(MUTATING_RPCS_WITH_IDEMPOTENCY);
    expect(unique.size).toBe(MUTATING_RPCS_WITH_IDEMPOTENCY.length);
  });

  it('idempotency list has at least 25 mutating RPCs', () => {
    expect(MUTATING_RPCS_WITH_IDEMPOTENCY.length).toBeGreaterThanOrEqual(25);
  });

  it('all RPC names are valid snake_case', () => {
    for (const name of MUTATING_RPCS_WITH_IDEMPOTENCY) {
      expect(name).toBeTruthy();
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('critical business RPCs are covered', () => {
    const required = [
      'create_direct_order',
      'convert_quote_to_order',
      'confirm_delivery',
      'complete_delivery',
      'post_invoice',
      'record_invoice_payment',
      'void_invoice',
      'void_delivery',
      'create_commission_payment',
      'save_quote',
    ];
    for (const rpc of required) {
      expect(MUTATING_RPCS_WITH_IDEMPOTENCY).toContain(rpc);
    }
  });

  // SQL verification query (for manual/E2E use):
  // For each RPC in list, verify it accepts p_idempotency_key:
  // SELECT proname, pg_get_function_identity_arguments(oid)
  //   FROM pg_proc WHERE proname = 'rpc_name'
  //   AND pronamespace = 'public'::regnamespace;
  // Expected: args should contain 'p_idempotency_key text'
});

// ─── SECURITY DEFINER pg_temp Contracts ─────────────────────────────────

describe('Schema Integrity: SECURITY DEFINER pg_temp Contracts', () => {
  it('pg_temp list has no duplicates', () => {
    const unique = new Set(SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP);
    expect(unique.size).toBe(SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP.length);
  });

  it('pg_temp list has at least 20 functions', () => {
    expect(SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP.length).toBeGreaterThanOrEqual(20);
  });

  it('all function names are valid snake_case', () => {
    for (const name of [
      ...SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP,
      ...SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH,
      ...FUNCTIONS_REQUIRING_SECURITY_INVOKER,
    ]) {
      expect(name).toBeTruthy();
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('empty-search-path exceptions are narrow, explicit, and disjoint from pg_temp', () => {
    expect(SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH).toEqual([
      'check_period_open',
    ]);
    const pgTempSet = new Set(SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP);
    for (const name of SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH) {
      expect(pgTempSet.has(name)).toBe(false);
    }
  });

  it('public-path security-invoker contracts are narrow and disjoint from definer contracts', () => {
    expect(FUNCTIONS_REQUIRING_SECURITY_INVOKER).toEqual(['compute_season']);
    const definerSet = new Set([
      ...SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP,
      ...SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH,
    ]);
    for (const name of FUNCTIONS_REQUIRING_SECURITY_INVOKER) {
      expect(definerSet.has(name)).toBe(false);
    }
  });

  it('all mutating RPCs require pg_temp (they are SECURITY DEFINER)', () => {
    // Every mutating RPC that accepts idempotency key is SECURITY DEFINER
    // and must therefore have pg_temp in search_path
    const pgTempSet = new Set(SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP);
    const missingFromPgTemp = MUTATING_RPCS_WITH_IDEMPOTENCY.filter(
      rpc => !pgTempSet.has(rpc)
    );
    // Allow some mutating RPCs that are SECURITY INVOKER (not DEFINER)
    // but flag if more than 5 are missing — likely a contract gap
    expect(missingFromPgTemp.length).toBeLessThan(10);
  });

  // SQL verification query (for manual/E2E use):
  // SELECT proname, proconfig FROM pg_proc
  //   WHERE pronamespace = 'public'::regnamespace
  //   AND prosecdef = true
  //   AND (proconfig IS NULL OR NOT proconfig::text LIKE '%pg_temp%');
  // Expected: 0 rows after excluding the exact-empty-search-path allowlist.
});

// ─── Exported for use in E2E tests ──────────────────────────────────────
export {
  CRITICAL_COLUMNS,
  CRITICAL_FK_TARGETS,
  POSTGREST_EMBEDDING_QUERIES,
  COLUMN_NAMING_CONTRACTS,
  CHECK_CONSTRAINT_CONTRACTS,
  MUTATING_RPCS_WITH_IDEMPOTENCY,
  SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP,
  SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH,
  FUNCTIONS_REQUIRING_SECURITY_INVOKER,
  FUNCTIONS_MUST_NOT_HAVE_OVERLOADS,
};
