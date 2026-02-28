/**
 * Schema Integrity Live DB Tests
 *
 * These tests query the ACTUAL Supabase database's information_schema to verify
 * that schema contracts are met in the real deployment. They complement the
 * static contract tests in schemaIntegrity.test.ts.
 *
 * WHEN THESE RUN:
 *   - Skipped by default when VITE_SUPABASE_URL = 'https://test.supabase.co' (mock)
 *   - Run automatically when pointed at a real Supabase instance
 *   - In CI: set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY to real values
 *
 * WHAT THEY VERIFY:
 *   1. Critical columns exist with expected data types
 *   2. Foreign key constraints point to correct tables
 *   3. RLS is enabled on all business tables
 *   4. Expected RLS policies exist for each table
 *   5. Indexes exist for critical query patterns
 *
 * Sprint 3c: Go-live hardening
 */
import { describe, it, expect } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// ─── Setup ────────────────────────────────────────────────────────────

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';
const isLiveDB = supabaseUrl !== '' && !supabaseUrl.includes('test.supabase.co');

// Create a real client only when pointing at a live DB
const supabase = isLiveDB ? createClient(supabaseUrl, supabaseAnonKey) : null;

/**
 * Helper: run a SQL query via Supabase RPC.
 * Uses the pg_catalog and information_schema views which are readable
 * by the anon role in Supabase.
 */
async function queryInformationSchema(sql: string) {
  if (!supabase) throw new Error('No live DB connection');
  // Use rpc to execute raw SQL for information_schema queries
  // We query via PostgREST views that expose schema metadata
  const { data, error } = await supabase.rpc('execute_sql_readonly', { sql_query: sql });
  if (error) throw error;
  return data;
}

// ─── Column Type Mapping ──────────────────────────────────────────────
// PostgreSQL types → expected information_schema.columns.data_type values

const PG_TYPE_MAP: Record<string, string[]> = {
  uuid: ['uuid'],
  string: ['text', 'character varying', 'USER-DEFINED'], // enums show as USER-DEFINED
  number: ['integer', 'bigint', 'numeric', 'double precision', 'smallint', 'real'],
  boolean: ['boolean'],
};

// ─── Tables requiring RLS ─────────────────────────────────────────────
// Every table in the public schema that holds business data must have RLS.

const TABLES_REQUIRING_RLS = [
  'profiles', 'products', 'cost_history', 'customers', 'customer_addresses',
  'quotes', 'quote_sections', 'quote_items', 'quote_versions',
  'orders', 'order_items',
  'inventory', 'inventory_transactions', 'inventory_holds',
  'purchase_orders', 'purchase_order_items',
  'deliveries', 'delivery_items', 'delivery_photos', 'delivery_remainders',
  'commissions',
  'invoices', 'invoice_items',
  'payments',
  'blend_tickets', 'blend_ticket_products', 'blend_ticket_images',
  'team_notes', 'team_note_comments',
  'activity_feed', 'notifications', 'app_settings',
  'failed_notifications',
  'fields', 'field_billing_defaults',
  'jobs', 'job_fields', 'job_chemicals', 'job_applied_info',
  'accounting_periods', 'commission_payments', 'commission_payment_items',
  'returns', 'return_items',
  'vehicles', 'application_records',
  'warehouses', 'cycle_counts', 'cycle_count_items',
  'receiving_records', 'receiving_photos',
  'rate_limit_log', 'idempotency_keys',
];

// ─── Expected Column Contracts ────────────────────────────────────────
// These match CRITICAL_COLUMNS from schemaIntegrity.test.ts but are
// verified against the actual database.

interface ColumnContract {
  table: string;
  column: string;
  expectedTypes: string[]; // Acceptable PostgreSQL data_type values
  nullable: boolean;
}

const COLUMN_CONTRACTS: ColumnContract[] = [
  // commissions — most common source of schema bugs
  { table: 'commissions', column: 'id', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'commissions', column: 'order_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'customer_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'recipient_user_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'season', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'commissions', column: 'order_number', expectedTypes: PG_TYPE_MAP.string, nullable: true },
  { table: 'commissions', column: 'customer_name', expectedTypes: PG_TYPE_MAP.string, nullable: true },

  // customers — farm_name NOT business_name
  { table: 'customers', column: 'id', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'customers', column: 'farm_name', expectedTypes: PG_TYPE_MAP.string, nullable: true },
  { table: 'customers', column: 'assigned_sales_rep', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'customers', column: 'credit_limit', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'customers', column: 'prepay_balance', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'customers', column: 'finance_charge_enabled', expectedTypes: PG_TYPE_MAP.boolean, nullable: true },

  // cycle_counts — count_number NOT cycle_count_number
  { table: 'cycle_counts', column: 'count_number', expectedTypes: PG_TYPE_MAP.string, nullable: true },
  { table: 'cycle_counts', column: 'initiated_by', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'cycle_counts', column: 'completed_by', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },

  // deliveries
  { table: 'deliveries', column: 'assigned_driver', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'deliveries', column: 'signature_url', expectedTypes: PG_TYPE_MAP.string, nullable: true },
  { table: 'deliveries', column: 'is_quick_delivery', expectedTypes: PG_TYPE_MAP.boolean, nullable: true },

  // invoices — financial precision
  { table: 'invoices', column: 'total_amount_cents', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'invoices', column: 'paid_amount_cents', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'invoices', column: 'balance_cents', expectedTypes: PG_TYPE_MAP.number, nullable: true },

  // orders
  { table: 'orders', column: 'total_paid', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'orders', column: 'balance_due', expectedTypes: PG_TYPE_MAP.number, nullable: true },

  // quote_items — NUMERIC precision for financial fields (Sprint 1b)
  { table: 'quote_items', column: 'price_per_unit', expectedTypes: ['numeric'], nullable: true },
  { table: 'quote_items', column: 'current_cost', expectedTypes: ['numeric'], nullable: true },
  { table: 'quote_items', column: 'total_price', expectedTypes: ['numeric'], nullable: true },
  { table: 'quote_items', column: 'profit', expectedTypes: ['numeric'], nullable: true },
  { table: 'quote_items', column: 'net_margin', expectedTypes: ['numeric'], nullable: true },
];

// ─── FK Contracts ─────────────────────────────────────────────────────

interface FKContract {
  table: string;
  column: string;
  referencedTable: string;
  reason: string;
}

const FK_CONTRACTS: FKContract[] = [
  { table: 'cycle_counts', column: 'initiated_by', referencedTable: 'profiles', reason: 'Profile embedding for display names' },
  { table: 'cycle_counts', column: 'completed_by', referencedTable: 'profiles', reason: 'Profile embedding for display names' },
  { table: 'commissions', column: 'recipient_user_id', referencedTable: 'profiles', reason: 'Commission recipient display name' },
  { table: 'deliveries', column: 'assigned_driver', referencedTable: 'profiles', reason: 'Driver display name embedding' },
  { table: 'commissions', column: 'order_id', referencedTable: 'orders', reason: 'Order details for commission display' },
  { table: 'commissions', column: 'customer_id', referencedTable: 'customers', reason: 'Customer details for commission display' },
  { table: 'invoices', column: 'customer_id', referencedTable: 'customers', reason: 'Customer display on invoices' },
  { table: 'invoices', column: 'order_id', referencedTable: 'orders', reason: 'Order reference on invoices' },
];

// ─── Test Suites ──────────────────────────────────────────────────────

describe.skipIf(!isLiveDB)('Live DB: Column Existence and Types', () => {
  for (const contract of COLUMN_CONTRACTS) {
    it(`${contract.table}.${contract.column} exists with correct type`, async () => {
      const result = await queryInformationSchema(`
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '${contract.table}'
          AND column_name = '${contract.column}'
      `);

      expect(result, `Column ${contract.table}.${contract.column} does not exist`).toHaveLength(1);

      const row = result[0];
      expect(
        contract.expectedTypes,
        `${contract.table}.${contract.column} type '${row.data_type}' not in expected: ${contract.expectedTypes.join(', ')}`
      ).toContain(row.data_type);

      const actualNullable = row.is_nullable === 'YES';
      expect(actualNullable).toBe(contract.nullable);
    });
  }
});

describe.skipIf(!isLiveDB)('Live DB: Foreign Key Targets', () => {
  for (const fk of FK_CONTRACTS) {
    it(`${fk.table}.${fk.column} → ${fk.referencedTable} (${fk.reason})`, async () => {
      const result = await queryInformationSchema(`
        SELECT
          kcu.table_name,
          kcu.column_name,
          ccu.table_name AS referenced_table
        FROM information_schema.key_column_usage kcu
        JOIN information_schema.referential_constraints rc
          ON kcu.constraint_name = rc.constraint_name
          AND kcu.constraint_schema = rc.constraint_schema
        JOIN information_schema.constraint_column_usage ccu
          ON rc.unique_constraint_name = ccu.constraint_name
          AND rc.unique_constraint_schema = ccu.constraint_schema
        WHERE kcu.table_schema = 'public'
          AND kcu.table_name = '${fk.table}'
          AND kcu.column_name = '${fk.column}'
      `);

      expect(result.length, `No FK found for ${fk.table}.${fk.column}`).toBeGreaterThan(0);
      expect(
        result[0].referenced_table,
        `FK ${fk.table}.${fk.column} points to '${result[0].referenced_table}' instead of '${fk.referencedTable}'`
      ).toBe(fk.referencedTable);
    });
  }
});

describe.skipIf(!isLiveDB)('Live DB: RLS Enabled on All Business Tables', () => {
  it('all required tables have RLS enabled', async () => {
    const result = await queryInformationSchema(`
      SELECT tablename, rowsecurity
      FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename = ANY(ARRAY[${TABLES_REQUIRING_RLS.map(t => `'${t}'`).join(',')}])
    `);

    const tableMap = new Map(result.map((r: { tablename: string; rowsecurity: boolean }) => [r.tablename, r.rowsecurity]));

    for (const table of TABLES_REQUIRING_RLS) {
      const hasRLS = tableMap.get(table);
      if (hasRLS === undefined) {
        // Table might not exist yet (migration not applied) — skip
        continue;
      }
      expect(hasRLS, `SECURITY: RLS is NOT enabled on ${table}`).toBe(true);
    }
  });
});

describe.skipIf(!isLiveDB)('Live DB: Critical RLS Policies Exist', () => {
  const EXPECTED_POLICIES: Array<{ table: string; policyName: string; cmd: string }> = [
    // Admin policies
    { table: 'orders', policyName: 'orders_admin_select', cmd: 'SELECT' },
    { table: 'orders', policyName: 'orders_admin_insert', cmd: 'INSERT' },
    { table: 'orders', policyName: 'orders_admin_update', cmd: 'UPDATE' },
    { table: 'orders', policyName: 'orders_admin_delete', cmd: 'DELETE' },

    // Driver restricted update policy
    { table: 'deliveries', policyName: 'del_driver_signature_only', cmd: 'UPDATE' },

    // Sales rep scoped policies
    { table: 'quotes', policyName: 'quotes_rep_select', cmd: 'SELECT' },
    { table: 'quotes', policyName: 'quotes_rep_insert', cmd: 'INSERT' },
    { table: 'quotes', policyName: 'quotes_rep_update', cmd: 'UPDATE' },

    // Admin-only sensitive tables
    { table: 'cost_history', policyName: 'cost_history_select', cmd: 'SELECT' },
    { table: 'purchase_orders', policyName: 'po_admin_select', cmd: 'SELECT' },
    { table: 'failed_notifications', policyName: 'fn_admin_select', cmd: 'SELECT' },

    // Notification privacy
    { table: 'notifications', policyName: 'notif_select', cmd: 'SELECT' },
  ];

  for (const { table, policyName, cmd } of EXPECTED_POLICIES) {
    it(`policy "${policyName}" exists on ${table} for ${cmd}`, async () => {
      const result = await queryInformationSchema(`
        SELECT policyname, cmd
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = '${table}'
          AND policyname = '${policyName}'
      `);

      expect(result.length, `Policy "${policyName}" missing on ${table}`).toBeGreaterThan(0);
      expect(result[0].cmd).toBe(cmd);
    });
  }
});

describe.skipIf(!isLiveDB)('Live DB: Column Naming — No Wrong Names', () => {
  const WRONG_COLUMN_NAMES: Array<{ table: string; wrongName: string; correctName: string }> = [
    { table: 'customers', wrongName: 'business_name', correctName: 'farm_name' },
    { table: 'customers', wrongName: 'company_name', correctName: 'farm_name' },
    { table: 'cycle_counts', wrongName: 'cycle_count_number', correctName: 'count_number' },
  ];

  for (const { table, wrongName, correctName } of WRONG_COLUMN_NAMES) {
    it(`${table} does NOT have column "${wrongName}" (should be "${correctName}")`, async () => {
      const result = await queryInformationSchema(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = '${table}'
          AND column_name = '${wrongName}'
      `);

      expect(
        result.length,
        `NAMING BUG: ${table} has column "${wrongName}" — should be "${correctName}"`
      ).toBe(0);
    });
  }
});

describe.skipIf(!isLiveDB)('Live DB: Helper Functions Exist', () => {
  const REQUIRED_FUNCTIONS = [
    'is_admin',
    'is_sales_rep',
    'is_driver',
    'save_quote',
    'log_failed_notification',
  ];

  for (const funcName of REQUIRED_FUNCTIONS) {
    it(`function ${funcName}() exists`, async () => {
      const result = await queryInformationSchema(`
        SELECT routine_name, security_type
        FROM information_schema.routines
        WHERE routine_schema = 'public'
          AND routine_name = '${funcName}'
      `);

      expect(result.length, `Function ${funcName}() does not exist`).toBeGreaterThan(0);
    });
  }

  it('role helper functions are SECURITY DEFINER', async () => {
    for (const funcName of ['is_admin', 'is_sales_rep', 'is_driver']) {
      const result = await queryInformationSchema(`
        SELECT routine_name, security_type
        FROM information_schema.routines
        WHERE routine_schema = 'public'
          AND routine_name = '${funcName}'
      `);

      expect(result.length).toBeGreaterThan(0);
      // SECURITY DEFINER functions show as 'DEFINER' in information_schema
      expect(
        result[0].security_type,
        `${funcName}() must be SECURITY DEFINER but is ${result[0].security_type}`
      ).toBe('DEFINER');
    }
  });
});

// ─── Static Tests (always run) ────────────────────────────────────────
// These validate the contracts themselves are well-formed.

describe('Schema Live DB: Contract Completeness', () => {
  it('column contracts cover all critical tables', () => {
    const coveredTables = [...new Set(COLUMN_CONTRACTS.map(c => c.table))];
    const criticalTables = ['commissions', 'customers', 'deliveries', 'invoices', 'orders', 'quote_items'];
    for (const t of criticalTables) {
      expect(coveredTables, `No column contracts for ${t}`).toContain(t);
    }
  });

  it('FK contracts cover all PostgREST embedding FKs', () => {
    const coveredFKs = FK_CONTRACTS.map(f => `${f.table}.${f.column}`);
    const criticalFKs = [
      'cycle_counts.initiated_by',
      'cycle_counts.completed_by',
      'commissions.recipient_user_id',
      'deliveries.assigned_driver',
    ];
    for (const fk of criticalFKs) {
      expect(coveredFKs, `Missing FK contract for ${fk}`).toContain(fk);
    }
  });

  it('RLS table list covers all core business tables', () => {
    const coreBusinessTables = [
      'profiles', 'customers', 'orders', 'order_items',
      'deliveries', 'delivery_items', 'invoices', 'payments',
      'commissions', 'inventory', 'products',
    ];
    for (const t of coreBusinessTables) {
      expect(TABLES_REQUIRING_RLS, `Missing from RLS list: ${t}`).toContain(t);
    }
  });

  it(`isLiveDB flag matches environment (currently: ${isLiveDB ? 'LIVE' : 'MOCK'})`, () => {
    if (supabaseUrl.includes('test.supabase.co')) {
      expect(isLiveDB).toBe(false);
    } else if (supabaseUrl.includes('supabase.co')) {
      expect(isLiveDB).toBe(true);
    }
  });
});

// ─── Exports ──────────────────────────────────────────────────────────
export {
  COLUMN_CONTRACTS,
  FK_CONTRACTS,
  TABLES_REQUIRING_RLS,
  isLiveDB,
};
