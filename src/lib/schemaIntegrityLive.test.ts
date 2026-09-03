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
 *   - In a trusted local/agent run: opt in with CRX_LIVE_SCHEMA_TESTS=true and
 *     provide the live URL plus CRX_LIVE_SCHEMA_SERVICE_ROLE_KEY
 *     (server-only; never VITE-prefixed)
 *   - Run only this suite with `npm run test:schema-live`; do not point the
 *     entire unit suite at a live project
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
import { assertRpcResult } from './db';

// ─── Setup ────────────────────────────────────────────────────────────

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseServiceRoleKey =
  process.env.CRX_LIVE_SCHEMA_SERVICE_ROLE_KEY || '';
const isLiveDB = supabaseUrl !== '' && !supabaseUrl.includes('test.supabase.co');

// Create a real client only when pointing at a live DB
const supabase = isLiveDB
  ? createClient(supabaseUrl, supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    })
  : null;

/**
 * Helper: run a SQL query via Supabase RPC.
 * execute_sql_readonly is deliberately revoked from anon/authenticated and is
 * callable only by service_role/postgres. This test-only client is never bundled
 * into the application and performs SELECT/WITH metadata checks only.
 */
async function queryInformationSchema(sql: string) {
  if (!supabase) throw new Error('No live DB connection');
  // Use rpc to execute raw SQL for information_schema queries
  // We query via PostgREST views that expose schema metadata
  const { data, error } = await supabase.rpc('execute_sql_readonly', { sql_query: sql });
  if (error) throw error;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return assertRpcResult<any[]>(data, 'execute_sql_readonly');
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
  // U8 (2026-07-06): order_id became nullable — job-sourced (application-channel)
  // commissions carry job_id + invoice_id instead; chk_commission_source enforces
  // that at least one lineage is set.
  { table: 'commissions', column: 'order_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'job_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'invoice_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'customer_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'commissions', column: 'recipient_user_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'commissions', column: 'season', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'commissions', column: 'order_number', expectedTypes: PG_TYPE_MAP.string, nullable: true },
  { table: 'commissions', column: 'customer_name', expectedTypes: PG_TYPE_MAP.string, nullable: true },

  // customers — farm_name NOT business_name, money columns use _cents suffix
  { table: 'customers', column: 'id', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'customers', column: 'farm_name', expectedTypes: PG_TYPE_MAP.string, nullable: false },
  { table: 'customers', column: 'assigned_sales_rep', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'customers', column: 'credit_limit_cents', expectedTypes: PG_TYPE_MAP.number, nullable: true },
  { table: 'customers', column: 'prepay_balance_cents', expectedTypes: PG_TYPE_MAP.number, nullable: false },
  { table: 'customers', column: 'finance_charge_enabled', expectedTypes: PG_TYPE_MAP.boolean, nullable: true },

  // cycle_counts — count_number NOT cycle_count_number
  { table: 'cycle_counts', column: 'count_number', expectedTypes: PG_TYPE_MAP.string, nullable: false },
  { table: 'cycle_counts', column: 'initiated_by', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'cycle_counts', column: 'completed_by', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },

  // deliveries
  { table: 'deliveries', column: 'assigned_driver', expectedTypes: PG_TYPE_MAP.uuid, nullable: true },
  { table: 'deliveries', column: 'signature_url', expectedTypes: PG_TYPE_MAP.string, nullable: true },
  { table: 'deliveries', column: 'is_quick_delivery', expectedTypes: PG_TYPE_MAP.boolean, nullable: true },

  // invoices — financial precision (NOT NULL with defaults)
  { table: 'invoices', column: 'total_amount_cents', expectedTypes: PG_TYPE_MAP.number, nullable: false },
  { table: 'invoices', column: 'paid_amount_cents', expectedTypes: PG_TYPE_MAP.number, nullable: false },
  { table: 'invoices', column: 'balance_cents', expectedTypes: PG_TYPE_MAP.number, nullable: true },

  // orders — core order columns (balance_due/total_paid deprecated and dropped)
  { table: 'orders', column: 'id', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'orders', column: 'order_number', expectedTypes: PG_TYPE_MAP.string, nullable: false },
  { table: 'orders', column: 'customer_id', expectedTypes: PG_TYPE_MAP.uuid, nullable: false },
  { table: 'orders', column: 'status', expectedTypes: PG_TYPE_MAP.string, nullable: false },

  // quote_items — NUMERIC precision for financial fields (Sprint 1b)
  { table: 'quote_items', column: 'price_per_unit', expectedTypes: ['numeric'], nullable: false },
  { table: 'quote_items', column: 'current_cost', expectedTypes: ['numeric'], nullable: false },
  { table: 'quote_items', column: 'total_price', expectedTypes: ['numeric'], nullable: false },
  { table: 'quote_items', column: 'profit', expectedTypes: ['numeric'], nullable: false },
  { table: 'quote_items', column: 'net_margin', expectedTypes: ['numeric'], nullable: false },
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
  { table: 'commissions', column: 'job_id', referencedTable: 'jobs', reason: 'U8: job details for application-channel commission display' },
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
      SELECT t.tablename, t.rowsecurity, count(p.policyname)::int AS policy_count
      FROM pg_tables t
      LEFT JOIN pg_policies p
        ON p.schemaname = t.schemaname
       AND p.tablename = t.tablename
      WHERE t.schemaname = 'public'
        AND t.tablename <> 'spatial_ref_sys'
      GROUP BY t.tablename, t.rowsecurity
      ORDER BY t.tablename
    `);

    const tableMap = new Map(
      result.map((r: { tablename: string; rowsecurity: boolean; policy_count: number | string }) => [
        r.tablename,
        { rowsecurity: r.rowsecurity, policyCount: Number(r.policy_count) },
      ]),
    );

    expect(result.length, 'Live public-table inventory unexpectedly returned no tables').toBeGreaterThan(0);

    for (const table of TABLES_REQUIRING_RLS) {
      const tableState = tableMap.get(table);
      expect(tableState, `SCHEMA DRIFT: expected live table ${table} is missing`).toBeDefined();
      expect(tableState?.rowsecurity, `SECURITY: RLS is NOT enabled on ${table}`).toBe(true);
    }

    for (const [table, tableState] of tableMap) {
      expect(tableState.rowsecurity, `SECURITY: public table ${table} has RLS disabled`).toBe(true);
      expect(
        tableState.policyCount,
        `SECURITY: public table ${table} has RLS enabled but no policies`,
      ).toBeGreaterThan(0);
    }
  });
});

describe.skipIf(!isLiveDB)('Live DB: Critical RLS Policies Exist', () => {
  const EXPECTED_POLICIES: Array<{ table: string; policyName: string; cmd: string }> = [
    // Orders — CRUD policies
    { table: 'orders', policyName: 'orders_select', cmd: 'SELECT' },
    { table: 'orders', policyName: 'orders_insert', cmd: 'INSERT' },
    { table: 'orders', policyName: 'orders_update', cmd: 'UPDATE' },
    { table: 'orders', policyName: 'orders_delete', cmd: 'DELETE' },

    // Driver restricted update policy
    { table: 'deliveries', policyName: 'del_driver_signature_only', cmd: 'UPDATE' },

    // Quotes — CRUD policies
    { table: 'quotes', policyName: 'quotes_select', cmd: 'SELECT' },
    { table: 'quotes', policyName: 'quotes_insert', cmd: 'INSERT' },
    { table: 'quotes', policyName: 'quotes_update', cmd: 'UPDATE' },

    // Sensitive tables
    { table: 'cost_history', policyName: 'cost_history_select', cmd: 'SELECT' },
    { table: 'purchase_orders', policyName: 'po_select', cmd: 'SELECT' },
    { table: 'failed_notifications', policyName: 'Admins can view failed notifications', cmd: 'SELECT' },

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

// ─── Live DB: CHECK Constraint Validation ─────────────────────────────
// Verifies actual CHECK constraints in the database match expected values.

import { CHECK_CONSTRAINT_CONTRACTS } from './schemaIntegrity.test';

describe.skipIf(!isLiveDB)('Live DB: CHECK Constraint Values', () => {
  for (const contract of CHECK_CONSTRAINT_CONTRACTS) {
    it(`${contract.table}.${contract.column} CHECK constraint contains all expected values`, async () => {
      const result = await queryInformationSchema(`
        SELECT pg_get_constraintdef(oid) AS def
        FROM pg_constraint
        WHERE conrelid = '${contract.table}'::regclass
          AND contype = 'c'
          AND conname LIKE '%${contract.column}%check%'
      `);

      expect(
        result.length,
        `No CHECK constraint found for ${contract.table}.${contract.column} (looked for conname LIKE '%${contract.column}%check%')`
      ).toBeGreaterThan(0);

      const constraintDef = result[0].def;
      for (const value of contract.expectedValues) {
        expect(
          constraintDef,
          `CHECK constraint on ${contract.table}.${contract.column} is missing value '${value}'. Actual: ${constraintDef}`
        ).toContain(value);
      }
    });
  }
});

// ─── Known Function Overloads (intentional) ──────────────────────────
// Functions that legitimately have multiple overloads in pg_proc.
//
// EMPTIED 2026-09-03. Both former entries were stale and this list was failing
// against production, because the test below requires every named function to
// actually have MORE THAN ONE version. A live read on 2026-09-03 returns
// overload_count = 1 for both:
//   * next_invoice_number — the zero-arg version was dropped by
//     20260526151856_execute_full_codebase_ultra_review.sql; only
//     next_invoice_number(p_invoice_type text) remains. The comment that used to
//     sit here ("no-args version (column default) + type-aware version") was
//     doubly wrong: the column DEFAULT on invoices.invoice_number passes an
//     argument — next_invoice_number('field_application'::text) — so it calls the
//     type-aware version, not a zero-arg one. Keeping the name here also
//     contradicted schemaIntegrity.test.ts, which lists it in
//     FUNCTIONS_MUST_NOT_HAVE_OVERLOADS, and contradicted the postflight in
//     20260903160000_gate_number_generators_active_profile_role.sql, which
//     aborts unless exactly one version exists.
//   * check_rate_limit — also a single version live.
//
// Leave this empty unless a function genuinely needs multiple signatures. An
// entry here is an exemption from the overload check that caught 40+ bugs in
// March 2026, so it must name a real, verified overload.
const KNOWN_OVERLOADED_FUNCTIONS: string[] = [];

// ─── Live DB: Idempotency Body Check (PR-19, 2026-05-10) ───────────────
// schemaIntegrity.test.ts maintains a list of mutating RPCs that MUST use
// the canonical idempotency pattern. Static list-validation only catches
// "is the name in the list" — it cannot tell whether the live function
// body actually calls `check_idempotency` / `save_idempotency`. Without a
// live check, a bug like the PR-02 finding (broken `(v_existing->>'status')`
// check that never matched) is invisible to the test suite.
//
// This block queries `pg_proc.prosrc` for each function in
// MUTATING_RPCS_WITH_IDEMPOTENCY and asserts the body either references
// `check_idempotency` (the canonical helper-function pattern) OR carries
// the explicit `-- idempotency-body-check: exempt` marker for the small set
// of functions that use raw inline lookups (documented in CLAUDE.md).

import {
  FUNCTIONS_REQUIRING_SECURITY_INVOKER,
  MUTATING_RPCS_WITH_IDEMPOTENCY,
  SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH,
  SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP,
} from './schemaIntegrity.test';

interface FunctionBodyRow {
  proname: string;
  prosrc: string;
  proconfig: string[] | null;
}

interface FunctionSecurityRow {
  proname: string;
  identity_arguments: string;
  prosecdef: boolean;
  public_can_execute: boolean;
  anon_can_execute: boolean;
  authenticated_can_execute: boolean;
  service_role_can_execute: boolean;
}

const ACCOUNTING_MONTH_LOCK_CONTRACTS = [
  {
    name: 'create_vendor_bill',
    call: /public\._lock_accounting_months\s*\(\s*ARRAY\s*\[\s*p_bill_date\s*\]\s*,\s*false\s*\)/i,
  },
  {
    name: 'update_vendor_bill',
    call: /public\._lock_accounting_months\s*\(\s*ARRAY\s*\[\s*v_bill\.bill_date\s*,\s*p_bill_date\s*\]\s*,\s*false\s*\)/i,
  },
  {
    name: 'close_accounting_period',
    call: /public\._lock_accounting_months\s*\(\s*ARRAY\s*\[\s*v_period_start\s*\]\s*,\s*true\s*\)/i,
  },
] as const;

function relationReferencesFromFunctionBody(source: string) {
  // EXTRACT(field FROM value) and SUBSTRING(value FROM start) use FROM as
  // scalar syntax, not as a relation clause. Mask those calls before scanning
  // the deliberately tiny exact-empty-search-path allowlist for table access.
  const relationOnlySource = source.replace(
    /\b(?:extract|substring)\s*\((?:[^()]|\([^()]*\))*\)/gi,
    '',
  );
  return [
    ...relationOnlySource.matchAll(
      /\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+([a-z_][a-z0-9_.]*)/gi,
    ),
  ].map((match) => match[1].toLowerCase());
}

describe('Schema Integrity: relation reference scanner', () => {
  it('ignores scalar FROM syntax but retains real relation clauses', () => {
    expect(
      relationReferencesFromFunctionBody(`
        v_month := extract(month FROM p_date);
        v_tail := substring(v_value FROM 2);
        SELECT 1 FROM public.accounting_periods;
      `),
    ).toEqual(['public.accounting_periods']);
  });
});

describe.skipIf(!isLiveDB)('Live DB: Mutating RPC Idempotency Bodies', () => {
  it('every mutating RPC has a canonical idempotency block in the live function body', async () => {
    const namesList = MUTATING_RPCS_WITH_IDEMPOTENCY.map((n) => `'${n}'`).join(',');
    const result = (await queryInformationSchema(`
      SELECT proname, prosrc, proconfig
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (${namesList})
    `)) as FunctionBodyRow[];

    const byName = new Map(result.map((r) => [r.proname, r]));
    const findings: string[] = [];

    for (const rpcName of MUTATING_RPCS_WITH_IDEMPOTENCY) {
      const row = byName.get(rpcName);
      if (!row) {
        findings.push(`  ${rpcName}: function does not exist in pg_proc — list drift`);
        continue;
      }
      const body = row.prosrc || '';
      const referencesIdempotency = /check_idempotency\s*\(/.test(body) || /idempotency_keys/i.test(body);
      const hasExemptMarker = /idempotency-body-check:\s*exempt/i.test(body);
      if (!referencesIdempotency && !hasExemptMarker) {
        findings.push(`  ${rpcName}: body does not reference check_idempotency / idempotency_keys and has no exempt marker`);
      }
    }

    expect(
      findings,
      `Idempotency body audit failed for ${findings.length} function(s):\n${findings.join('\n')}\n\n` +
        `Each mutating RPC must use the canonical pattern:\n` +
        `  IF p_idempotency_key IS NOT NULL THEN\n` +
        `    v_existing := check_idempotency(p_idempotency_key, '<rpc_name>');\n` +
        `    IF v_existing IS NOT NULL THEN RETURN v_existing; END IF;\n` +
        `  END IF;\n\n` +
        `Or carry "-- idempotency-body-check: exempt" if using a raw inline lookup ` +
        `(documented exception, see CLAUDE.md "Canonical Patterns for New RPCs").`,
    ).toHaveLength(0);
  });
});

describe.skipIf(!isLiveDB)('Live DB: Accounting month lock callers', () => {
  it('the month-lock helper remains a private SECURITY INVOKER primitive', async () => {
    const result = (await queryInformationSchema(`
      SELECT
        p.proname,
        pg_get_function_identity_arguments(p.oid) AS identity_arguments,
        p.prosecdef,
        EXISTS (
          SELECT 1
          FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) AS acl
          WHERE acl.grantee = 0
            AND acl.privilege_type = 'EXECUTE'
        ) AS public_can_execute,
        has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_can_execute,
        has_function_privilege('authenticated', p.oid, 'EXECUTE') AS authenticated_can_execute,
        has_function_privilege('service_role', p.oid, 'EXECUTE') AS service_role_can_execute
      FROM pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.proname = '_lock_accounting_months'
    `)) as FunctionSecurityRow[];

    expect(result, 'expected exactly one public._lock_accounting_months overload').toHaveLength(1);
    expect(result[0]).toMatchObject({
      identity_arguments: 'p_dates date[], p_exclusive boolean',
      prosecdef: false,
      public_can_execute: false,
      anon_can_execute: false,
      authenticated_can_execute: false,
      service_role_can_execute: false,
    });
  });

  it('governed vendor-bill writers and period close retain their shared/exclusive lock calls', async () => {
    const namesList = ACCOUNTING_MONTH_LOCK_CONTRACTS.map(({ name }) => `'${name}'`).join(',');
    const result = (await queryInformationSchema(`
      SELECT proname, prosrc, proconfig
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (${namesList})
    `)) as FunctionBodyRow[];

    const findings: string[] = [];
    for (const contract of ACCOUNTING_MONTH_LOCK_CONTRACTS) {
      const rows = result.filter((row) => row.proname === contract.name);
      if (rows.length !== 1) {
        findings.push(`  ${contract.name}: expected exactly one function, found ${rows.length}`);
      } else if (!contract.call.test(rows[0].prosrc)) {
        findings.push(
          `  ${contract.name}: live body is missing its required ` +
            `_lock_accounting_months dates/mode contract`,
        );
      }
    }

    expect(
      findings,
      `Accounting-month lock audit failed for ${findings.length} function(s):\n` +
        `${findings.join('\n')}\n\n` +
        `create/update must retain shared month locks and close must retain its ` +
        `exclusive month lock, or the period-close race reopens.`,
    ).toHaveLength(0);
  });
});

describe.skipIf(!isLiveDB)('Live DB: SECURITY DEFINER pg_temp Bodies', () => {
  it('every listed SECURITY DEFINER function has pg_temp in search_path', async () => {
    const namesList = SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP.map((n) => `'${n}'`).join(',');
    const result = (await queryInformationSchema(`
      SELECT proname, prosrc, proconfig
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND prosecdef = true
        AND proname IN (${namesList})
    `)) as FunctionBodyRow[];

    const byName = new Map(result.map((r) => [r.proname, r]));
    const findings: string[] = [];

    for (const fnName of SECURITY_DEFINER_FUNCTIONS_REQUIRING_PG_TEMP) {
      const row = byName.get(fnName);
      if (!row) {
        findings.push(`  ${fnName}: function not found OR is not SECURITY DEFINER — list drift`);
        continue;
      }
      const config = row.proconfig || [];
      const searchPathSetting = config.find((c) => /^search_path=/i.test(c)) || '';
      if (!/pg_temp/i.test(searchPathSetting)) {
        findings.push(
          `  ${fnName}: search_path does not include pg_temp (proconfig=${JSON.stringify(config)})`,
        );
      }
    }

    expect(
      findings,
      `pg_temp audit failed for ${findings.length} function(s):\n${findings.join('\n')}\n\n` +
        `Every SECURITY DEFINER function MUST have SET search_path = public, pg_temp.`,
    ).toHaveLength(0);
  });
});

describe.skipIf(!isLiveDB)('Live DB: SECURITY DEFINER exact-empty search_path Bodies', () => {
  it('no unlisted SECURITY DEFINER function adopts the exact-empty exception', async () => {
    const result = (await queryInformationSchema(`
      SELECT
        p.proname,
        pg_get_function_identity_arguments(p.oid) AS identity_arguments
      FROM pg_proc AS p
      WHERE p.pronamespace = 'public'::regnamespace
        AND p.prosecdef = true
        AND EXISTS (
          SELECT 1
          FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) AS config(value)
          WHERE lower(config.value) = 'search_path=""'
        )
      ORDER BY p.proname, identity_arguments
    `)) as Array<{ proname: string; identity_arguments: string }>;

    const unapproved = result.filter(
      (row) => !SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH.includes(row.proname),
    );
    expect(
      unapproved,
      `Unapproved SECURITY DEFINER exact-empty search_path functions: ` +
        `${JSON.stringify(unapproved)}`,
    ).toHaveLength(0);
  });

  it('every listed exception has an exactly empty search_path', async () => {
    const namesList = SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH
      .map((n) => `'${n}'`)
      .join(',');
    const result = (await queryInformationSchema(`
      SELECT proname, prosrc, proconfig
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND prosecdef = true
        AND proname IN (${namesList})
    `)) as FunctionBodyRow[];

    const byName = new Map(result.map((r) => [r.proname, r]));
    const findings: string[] = [];

    for (const fnName of SECURITY_DEFINER_FUNCTIONS_REQUIRING_EMPTY_SEARCH_PATH) {
      const row = byName.get(fnName);
      if (!row) {
        findings.push(`  ${fnName}: function not found OR is not SECURITY DEFINER — list drift`);
        continue;
      }
      const config = row.proconfig || [];
      const searchPathSettings = config.filter((c) => /^search_path=/i.test(c));
      if (searchPathSettings.length !== 1 || searchPathSettings[0].toLowerCase() !== 'search_path=""') {
        findings.push(
          `  ${fnName}: search_path is not exactly empty (proconfig=${JSON.stringify(config)})`,
        );
      }
      const relationReferences = relationReferencesFromFunctionBody(row.prosrc);
      const unqualifiedRelations = relationReferences.filter(
        (relation) =>
          !relation.startsWith('public.') &&
          !relation.startsWith('pg_catalog.'),
      );
      if (
        !/\bFROM\s+public\.accounting_periods\b/i.test(row.prosrc) ||
        unqualifiedRelations.length > 0
      ) {
        findings.push(
          `  ${fnName}: body contains an unexpected or unqualified relation reference ` +
            `(relations=${JSON.stringify(relationReferences)})`,
        );
      }
    }

    expect(
      findings,
      `Exact-empty search_path audit failed for ${findings.length} function(s):\n` +
        `${findings.join('\n')}\n\n` +
        `These narrow exceptions must retain SET search_path = '' exactly and fully ` +
          `schema-qualified relation references; any mutable lookup path is a regression.`,
    ).toHaveLength(0);
  });
});

describe.skipIf(!isLiveDB)('Live DB: Required SECURITY INVOKER functions', () => {
  it('every listed function remains SECURITY INVOKER with its pinned public search_path', async () => {
    const namesList = FUNCTIONS_REQUIRING_SECURITY_INVOKER
      .map((n) => `'${n}'`)
      .join(',');
    const result = (await queryInformationSchema(`
      SELECT proname, prosecdef, proconfig
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
        AND proname IN (${namesList})
    `)) as Array<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>;

    const byName = new Map(result.map((r) => [r.proname, r]));
    const findings: string[] = [];
    for (const fnName of FUNCTIONS_REQUIRING_SECURITY_INVOKER) {
      const rows = result.filter((row) => row.proname === fnName);
      if (rows.length !== 1) {
        findings.push(`  ${fnName}: expected exactly one function, found ${rows.length}`);
      } else if (byName.get(fnName)?.prosecdef !== false) {
        findings.push(`  ${fnName}: unexpectedly SECURITY DEFINER`);
      } else {
        const config = byName.get(fnName)?.proconfig || [];
        const searchPathSettings = config.filter((value) => /^search_path=/i.test(value));
        if (
          searchPathSettings.length !== 1 ||
          searchPathSettings[0].toLowerCase() !== 'search_path=public'
        ) {
          findings.push(
            `  ${fnName}: expected exactly search_path=public ` +
              `(proconfig=${JSON.stringify(config)})`,
          );
        }
      }
    }

    expect(
      findings,
      `SECURITY INVOKER audit failed for ${findings.length} function(s):\n` +
        `${findings.join('\n')}\n\n` +
        `These advisor-safe invoker helpers must retain their deliberate public-only lookup path.`,
    ).toHaveLength(0);
  });
});

// ─── Live DB: Function Overload Detection ─────────────────────────────

describe.skipIf(!isLiveDB)('Live DB: No Unintended Function Overloads', () => {
  it('no public function has more than 1 overload (except known exceptions)', async () => {
    const result = await queryInformationSchema(`
      SELECT proname, count(*) as overload_count
      FROM pg_proc
      WHERE pronamespace = 'public'::regnamespace
      GROUP BY proname
      HAVING count(*) > 1
    `);

    const unexpected = (result as Array<{ proname: string; overload_count: number }>).filter(
      (r) => !KNOWN_OVERLOADED_FUNCTIONS.includes(r.proname)
    );

    if (unexpected.length > 0) {
      const details = unexpected
        .map((r) => `  ${r.proname} (${r.overload_count} overloads)`)
        .join('\n');
      expect(
        unexpected.length,
        `OVERLOAD BUG: ${unexpected.length} function(s) have unintended overloads.\n` +
          `This bug class caused 40+ issues in March 2026.\n` +
          `Overloaded functions:\n${details}\n` +
          `If intentional, add to KNOWN_OVERLOADED_FUNCTIONS.`
      ).toBe(0);
    }
  });

  it('known overloaded functions actually have overloads', async () => {
    for (const funcName of KNOWN_OVERLOADED_FUNCTIONS) {
      const result = await queryInformationSchema(`
        SELECT proname, count(*) as overload_count
        FROM pg_proc
        WHERE pronamespace = 'public'::regnamespace
          AND proname = '${funcName}'
        GROUP BY proname
      `);

      expect(
        result.length,
        `Known overloaded function ${funcName}() does not exist in database`
      ).toBeGreaterThan(0);

      if (result.length > 0) {
        expect(
          Number(result[0].overload_count),
          `${funcName}() is in KNOWN_OVERLOADED_FUNCTIONS but has only 1 version — remove from exceptions list`
        ).toBeGreaterThan(1);
      }
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

  it('known overloaded functions list is small (<=2 entries)', () => {
    expect(
      KNOWN_OVERLOADED_FUNCTIONS.length,
      `KNOWN_OVERLOADED_FUNCTIONS has ${KNOWN_OVERLOADED_FUNCTIONS.length} entries — overloads should be rare. ` +
        `If a function truly needs overloads, add it to the list. Otherwise fix the duplicate.`
    ).toBeLessThanOrEqual(2);
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
  KNOWN_OVERLOADED_FUNCTIONS,
  TABLES_REQUIRING_RLS,
  isLiveDB,
};
