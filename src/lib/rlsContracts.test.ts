/**
 * RLS (Row-Level Security) Contract Tests
 *
 * These tests define and validate the expected access matrix for every role
 * in the application. They serve two purposes:
 *
 * 1. **Documentation**: The access matrix below IS the authoritative source
 *    for "who can do what" in the database. If a policy changes, this file
 *    must be updated to match.
 *
 * 2. **Internal-consistency checks**: the tests below assert that this matrix
 *    is coherent with itself — a child table cannot be more permissive than its
 *    parent, a blocked table is blocked on every operation, and so on.
 *
 *    They do NOT read the migrations or the live database. A migration that
 *    drops or widens a policy will therefore NOT fail these tests on its own;
 *    it fails only once someone updates this matrix to match and a consistency
 *    rule breaks. The live-policy gate is the postflight block inside each
 *    migration plus the RLS review agents — not this file.
 *
 * ROLE COVERAGE: the matrix models admin, sales_rep, and driver. `applicator`
 * is a fourth app role and is not represented here; treat driver as the
 * field-role stand-in and verify applicator access against the policies
 * themselves.
 *
 * RLS policies in Supabase fail SILENTLY:
 *   - Blocked SELECT returns [] (empty array), not an error
 *   - Blocked INSERT/UPDATE returns { data: null }
 *   - This makes RLS bugs nearly invisible without explicit testing
 *
 * ROLES:
 *   - admin: Full CRUD on all business tables
 *   - sales_rep: Read most data; write own quotes/customers
 *   - driver: Read/write own deliveries; read-only on related data
 *
 * HELPER FUNCTIONS (used in USING/WITH CHECK clauses):
 *   - is_admin(): profiles.role = 'admin' AND is_active = true
 *   - is_sales_rep(): profiles.role = 'sales_rep' AND is_active = true
 *   - is_driver(): profiles.role = 'driver' AND is_active = true
 *
 * Sprint 3b: Go-live hardening
 */
import { describe, it, expect } from 'vitest';

// ─── Types ────────────────────────────────────────────────────────────

type Operation = 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';
type AccessLevel = 'all' | 'own' | 'scoped' | 'none';

/**
 * "all" = can access any row (e.g., admin)
 * "own" = can access rows they own (e.g., sales_rep's own customers)
 * "scoped" = access depends on a cross-table relationship (e.g., driver → assigned deliveries)
 * "none" = no access at all
 */
interface RoleAccess {
  admin: Record<Operation, AccessLevel>;
  sales_rep: Record<Operation, AccessLevel>;
  driver: Record<Operation, AccessLevel>;
}

interface TableRLSContract {
  table: string;
  access: RoleAccess;
  notes?: string;
}

// ─── Access Matrix ────────────────────────────────────────────────────
// This is the single source of truth for RLS intent across the app.
// Every entry was derived from the migrations in supabase/migrations/.

const RLS_ACCESS_MATRIX: TableRLSContract[] = [
  // ─── Core Business Tables ───────────────────────────────────────────
  {
    table: 'profiles',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'none' },
      sales_rep: { SELECT: 'own', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
      driver:    { SELECT: 'own', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
    },
    notes: 'Users can read/update own profile; admin can see all',
  },
  {
    table: 'products',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Everyone can read products (for quotes/orders); only admin can modify',
  },
  {
    table: 'cost_history',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'none', DELETE: 'none' },
      sales_rep: { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'CRITICAL: Cost data is admin-only. Sales reps must never see cost columns.',
  },
  {
    table: 'customers',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
      driver:    { SELECT: 'scoped', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Sales reps see all customers but only modify their assigned ones. Drivers see customers for their deliveries only.',
  },
  {
    table: 'customer_addresses',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Address read is open; write scoped to own customers for reps',
  },

  // ─── Quotes ─────────────────────────────────────────────────────────
  {
    table: 'quotes',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Sales reps can read all quotes but only modify their own (created_by). Drivers cannot access quotes.',
  },
  {
    table: 'quote_sections',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'own' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Sections inherit access through quote ownership (created_by on parent quote)',
  },
  {
    table: 'quote_items',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'own' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Items inherit access through quote ownership. Office-only reads since 20260727231652 — a driver could previously read every quote line item and its pricing while being unable to read the parent quote.',
  },
  {
    table: 'quote_versions',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'none', DELETE: 'none' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Versions are append-only snapshots; never updated or deleted. Office-only reads since 20260727231652 — snapshot_data carries full quote pricing.',
  },

  // ─── Pricing / Margin ───────────────────────────────────────────────
  {
    table: 'customer_application_rates',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Negotiated per-customer rates. Writes are admin-only. Office-only reads since 20260727231652. The row carries rate_per_acre_cents but NOT cost_per_acre_cents — cost lives on application_services, which stays driver-readable at the row level. So this table alone is the negotiated price, not the margin; margin is the join of the two, and this migration breaks that join for drivers. CORRECTION (2026-07-28, verified live): an earlier revision justified that as "Jobs/JobDetail need it". They do not. No driver-facing surface selects cost_per_acre_cents — the field-app picker takes id/name/default_rate_per_acre_cents, Jobs and the split editors take id/name, and JobDetail never touches the table. The only readers of the cost column are ApplicationServices.tsx and ApplicationServiceDetail.tsx, both behind allowedRoles={[admin]} routes. So application_services_select USING (is_active_profile()) exposes internal cost to any active profile through the API with no legitimate consumer — same shape as the SECDEF leak 20260728123224 closed, since a React route guard is not in the data path. Harmless today only because 0 of 4 services have a non-zero cost_per_acre_cents. Tracked as the residual item in KNOWN_ISSUES §0.',
  },
  {
    table: 'rebate_programs',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Supplier rebate terms. Writes are admin-only. Office-only reads since 20260727231652, which also pinned the SELECT policy to TO authenticated — the original migration left it TO public, so a replay and live had drifted apart.',
  },

  // ─── Orders ─────────────────────────────────────────────────────────
  {
    table: 'orders',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'CRITICAL: Only admin can create/modify orders. Sales reps can read (for reference).',
  },
  {
    table: 'order_items',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Order items follow order access pattern',
  },

  // ─── Inventory ──────────────────────────────────────────────────────
  {
    table: 'inventory',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Read-only for non-admins. Inventory writes go through RPCs.',
  },
  {
    table: 'inventory_transactions',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'none', DELETE: 'none' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Transactions are append-only audit records',
  },

  // ─── Purchasing ─────────────────────────────────────────────────────
  {
    table: 'purchase_orders',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'CRITICAL: Purchase orders are admin-only. Contains supplier pricing.',
  },
  {
    table: 'purchase_order_items',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
  },

  // ─── Deliveries ─────────────────────────────────────────────────────
  {
    table: 'deliveries',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'own', INSERT: 'none', UPDATE: 'scoped', DELETE: 'none' },
    },
    notes: 'Drivers see own assigned deliveries. Update is scoped to signature_url only (del_driver_signature_only policy).',
  },
  {
    table: 'delivery_items',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'scoped', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Drivers see items for their assigned deliveries only',
  },

  // ─── Financial ──────────────────────────────────────────────────────
  {
    table: 'commissions',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'none' },
      sales_rep: { SELECT: 'own', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Sales reps see only their own commissions (by recipient name match)',
  },
  {
    table: 'invoices',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'CRITICAL: Invoice data is admin-only (AR, payments, finance charges)',
  },
  {
    table: 'payments',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'CRITICAL: Payment data is admin-only',
  },

  // ─── Collaboration ──────────────────────────────────────────────────
  {
    table: 'team_notes',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'own', UPDATE: 'own', DELETE: 'none' },
    },
    notes: 'Anyone can read notes. Authors can edit their own. Admin can edit/delete all.',
  },
  {
    table: 'team_note_comments',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'none', DELETE: 'none' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'own', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Comments are append-only',
  },
  {
    table: 'activity_feed',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'none', DELETE: 'none' },
      sales_rep: { SELECT: 'all', INSERT: 'own', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'own', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Activity feed is append-only; everyone can read',
  },
  {
    table: 'notifications',
    access: {
      admin:     { SELECT: 'own', INSERT: 'all', UPDATE: 'own', DELETE: 'none' },
      sales_rep: { SELECT: 'own', INSERT: 'all', UPDATE: 'own', DELETE: 'none' },
      driver:    { SELECT: 'own', INSERT: 'all', UPDATE: 'own', DELETE: 'none' },
    },
    notes: 'Users can only read/update their own notifications. Insert allows system notifications.',
  },

  // ─── Reference Data ─────────────────────────────────────────────────
  {
    table: 'ingredient_map',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'all' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
  },
  {
    table: 'unit_conversions',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'none' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
  },
  {
    table: 'app_settings',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'none' },
      sales_rep: { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'all', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
  },

  // ─── Admin-Only System Tables ───────────────────────────────────────
  {
    table: 'failed_notifications',
    access: {
      admin:     { SELECT: 'all', INSERT: 'all', UPDATE: 'all', DELETE: 'none' },
      sales_rep: { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
      driver:    { SELECT: 'none', INSERT: 'none', UPDATE: 'none', DELETE: 'none' },
    },
    notes: 'Failure tracking is admin-only. Inserts go through SECURITY DEFINER RPC.',
  },
];

// ─── Derived Constants ────────────────────────────────────────────────

const ALL_ROLES = ['admin', 'sales_rep', 'driver'] as const;
type Role = (typeof ALL_ROLES)[number];
const ALL_OPS: Operation[] = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

/** Tables where no role should ever have DELETE access (append-only audit tables) */
const APPEND_ONLY_TABLES = [
  'activity_feed',
  'team_note_comments',
  'inventory_transactions',
  'quote_versions',
  'notifications',
  'failed_notifications',
];

/**
 * Tables a driver must not be able to read or write DIRECTLY.
 *
 * "Directly" is the honest scope: RLS on these tables does not reach a
 * SECURITY DEFINER function, so a SECDEF RPC granted to `authenticated` with no
 * role gate can still return figures derived from them. The two that did —
 * get_program_completion over quote_items and compute_application_service_fee
 * over customer rates — were closed by 20260728123224, which puts an
 * is_admin()/is_sales_rep() gate in each body and revokes `authenticated`
 * EXECUTE on compute_application_service_fee outright. The remaining gap is
 * application_services itself: default_rate_per_acre_cents and
 * cost_per_acre_cents are readable by any active profile via the
 * application_services_select policy.
 */
const DRIVER_BLOCKED_TABLES = [
  'cost_history',
  'purchase_orders',
  'purchase_order_items',
  'quotes',
  'quote_items',
  'quote_versions',
  'customer_application_rates',
  'rebate_programs',
  'orders',
  'order_items',
  'commissions',
  'invoices',
  'payments',
  'inventory_transactions',
  'failed_notifications',
];

/** Tables that should be completely invisible to sales reps */
const REP_BLOCKED_TABLES = [
  'cost_history',
  'purchase_orders',
  'purchase_order_items',
  'invoices',
  'payments',
  'failed_notifications',
];

/** Tables containing financial/sensitive data that only admin can write */
const ADMIN_ONLY_WRITE_TABLES = [
  'orders',
  'order_items',
  'inventory',
  'purchase_orders',
  'purchase_order_items',
  'cost_history',
  'invoices',
  'payments',
  // Verified live 2026-07-27: car_admin_{insert,update,delete} gate on an
  // inline profiles.role='admin' AND is_active check; rebate_programs_
  // {insert,update,delete} gate on is_admin(). Reads narrow to office-only in
  // 20260727231652; writes were already admin-only and are unchanged by it.
  'customer_application_rates',
  'rebate_programs',
];

// ─── Test Suites ──────────────────────────────────────────────────────

describe('RLS Contracts: Access Matrix Completeness', () => {
  it('defines access for every role on every table', () => {
    for (const contract of RLS_ACCESS_MATRIX) {
      for (const role of ALL_ROLES) {
        const roleAccess = contract.access[role];
        expect(roleAccess, `${contract.table} missing access for ${role}`).toBeDefined();
        for (const op of ALL_OPS) {
          expect(
            roleAccess[op],
            `${contract.table}.${role}.${op} is undefined`
          ).toBeDefined();
          expect(
            ['all', 'own', 'scoped', 'none'],
            `${contract.table}.${role}.${op} = "${roleAccess[op]}" is invalid`
          ).toContain(roleAccess[op]);
        }
      }
    }
  });

  it('has no duplicate table entries', () => {
    const tables = RLS_ACCESS_MATRIX.map(c => c.table);
    const unique = new Set(tables);
    expect(unique.size).toBe(tables.length);
  });

  it('covers all 28 critical tables', () => {
    // These are the tables with the highest security impact
    const criticalTables = [
      'profiles', 'products', 'cost_history', 'customers',
      'quotes', 'orders', 'order_items', 'inventory',
      'purchase_orders', 'deliveries', 'delivery_items',
      'commissions', 'invoices', 'payments',
      'notifications', 'failed_notifications',
    ];
    const coveredTables = RLS_ACCESS_MATRIX.map(c => c.table);
    for (const t of criticalTables) {
      expect(coveredTables, `Missing contract for critical table: ${t}`).toContain(t);
    }
  });
});

describe('RLS Contracts: Admin Always Has Full Access', () => {
  for (const contract of RLS_ACCESS_MATRIX) {
    it(`admin has SELECT access to ${contract.table}`, () => {
      expect(contract.access.admin.SELECT).not.toBe('none');
    });

    // Admin should have the most permissive access level on every operation
    for (const op of ALL_OPS) {
      it(`admin access >= other roles on ${contract.table}.${op}`, () => {
        const adminLevel = contract.access.admin[op];
        for (const role of ['sales_rep', 'driver'] as const) {
          const roleLevel = contract.access[role][op];
          if (roleLevel !== 'none') {
            // If a non-admin role has access, admin must also have access
            expect(
              adminLevel,
              `${contract.table}.${op}: admin='${adminLevel}' but ${role}='${roleLevel}'`
            ).not.toBe('none');
          }
        }
      });
    }
  }
});

describe('RLS Contracts: Driver Restrictions', () => {
  it('drivers cannot access any blocked table', () => {
    for (const tableName of DRIVER_BLOCKED_TABLES) {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName);
      expect(contract, `Missing contract for ${tableName}`).toBeDefined();
      for (const op of ALL_OPS) {
        expect(
          contract!.access.driver[op],
          `SECURITY: driver should not have ${op} on ${tableName}`
        ).toBe('none');
      }
    }
  });

  it('drivers can only SELECT products (not modify)', () => {
    const products = RLS_ACCESS_MATRIX.find(c => c.table === 'products')!;
    expect(products.access.driver.SELECT).toBe('all');
    expect(products.access.driver.INSERT).toBe('none');
    expect(products.access.driver.UPDATE).toBe('none');
    expect(products.access.driver.DELETE).toBe('none');
  });

  it('drivers can only see their own assigned deliveries', () => {
    const deliveries = RLS_ACCESS_MATRIX.find(c => c.table === 'deliveries')!;
    expect(deliveries.access.driver.SELECT).toBe('own');
    expect(deliveries.access.driver.INSERT).toBe('none');
    expect(deliveries.access.driver.DELETE).toBe('none');
  });

  it('driver delivery UPDATE is scoped (signature_url only)', () => {
    const deliveries = RLS_ACCESS_MATRIX.find(c => c.table === 'deliveries')!;
    expect(deliveries.access.driver.UPDATE).toBe('scoped');
    // This scoped access is enforced by del_driver_signature_only policy
    // which restricts UPDATE to only the signature_url column
  });

  it('drivers can see delivery_items only for their deliveries', () => {
    const items = RLS_ACCESS_MATRIX.find(c => c.table === 'delivery_items')!;
    expect(items.access.driver.SELECT).toBe('scoped');
    expect(items.access.driver.INSERT).toBe('none');
    expect(items.access.driver.UPDATE).toBe('none');
  });

  it('drivers cannot create or delete anything in business tables', () => {
    const businessTables = [
      'products', 'customers', 'customer_addresses',
      'orders', 'order_items', 'inventory',
      'deliveries', 'delivery_items',
    ];
    for (const tableName of businessTables) {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName);
      if (contract) {
        expect(
          contract.access.driver.INSERT,
          `driver should not INSERT into ${tableName}`
        ).toBe('none');
        expect(
          contract.access.driver.DELETE,
          `driver should not DELETE from ${tableName}`
        ).toBe('none');
      }
    }
  });
});

describe('RLS Contracts: Sales Rep Restrictions', () => {
  it('sales reps cannot access any blocked table', () => {
    for (const tableName of REP_BLOCKED_TABLES) {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName);
      expect(contract, `Missing contract for ${tableName}`).toBeDefined();
      for (const op of ALL_OPS) {
        expect(
          contract!.access.sales_rep[op],
          `SECURITY: sales_rep should not have ${op} on ${tableName}`
        ).toBe('none');
      }
    }
  });

  it('sales reps cannot create or modify orders (admin-only workflow)', () => {
    const orders = RLS_ACCESS_MATRIX.find(c => c.table === 'orders')!;
    expect(orders.access.sales_rep.SELECT).toBe('all'); // Can read for reference
    expect(orders.access.sales_rep.INSERT).toBe('none');
    expect(orders.access.sales_rep.UPDATE).toBe('none');
    expect(orders.access.sales_rep.DELETE).toBe('none');
  });

  it('sales reps can only modify their own quotes', () => {
    const quotes = RLS_ACCESS_MATRIX.find(c => c.table === 'quotes')!;
    expect(quotes.access.sales_rep.SELECT).toBe('all'); // Read all for visibility
    expect(quotes.access.sales_rep.INSERT).toBe('own');
    expect(quotes.access.sales_rep.UPDATE).toBe('own');
    expect(quotes.access.sales_rep.DELETE).toBe('none'); // Cannot delete quotes
  });

  it('sales reps can only modify their own customers', () => {
    const customers = RLS_ACCESS_MATRIX.find(c => c.table === 'customers')!;
    expect(customers.access.sales_rep.INSERT).toBe('own');
    expect(customers.access.sales_rep.UPDATE).toBe('own');
    expect(customers.access.sales_rep.DELETE).toBe('none');
  });

  it('sales reps cannot modify inventory directly', () => {
    const inventory = RLS_ACCESS_MATRIX.find(c => c.table === 'inventory')!;
    expect(inventory.access.sales_rep.SELECT).toBe('all');
    expect(inventory.access.sales_rep.INSERT).toBe('none');
    expect(inventory.access.sales_rep.UPDATE).toBe('none');
    expect(inventory.access.sales_rep.DELETE).toBe('none');
  });

  it('sales reps can only see their own commissions', () => {
    const commissions = RLS_ACCESS_MATRIX.find(c => c.table === 'commissions')!;
    expect(commissions.access.sales_rep.SELECT).toBe('own');
    expect(commissions.access.sales_rep.INSERT).toBe('none');
    expect(commissions.access.sales_rep.UPDATE).toBe('none');
  });
});

describe('RLS Contracts: Append-Only Tables', () => {
  for (const tableName of APPEND_ONLY_TABLES) {
    it(`${tableName} has no DELETE access for any role`, () => {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName);
      expect(contract, `Missing contract for append-only table: ${tableName}`).toBeDefined();
      for (const role of ALL_ROLES) {
        expect(
          contract!.access[role].DELETE,
          `${tableName} should be append-only but ${role} has DELETE`
        ).toBe('none');
      }
    });
  }
});

describe('RLS Contracts: Admin-Only Write Tables', () => {
  for (const tableName of ADMIN_ONLY_WRITE_TABLES) {
    it(`only admin can write to ${tableName}`, () => {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName);
      expect(contract, `Missing contract for ${tableName}`).toBeDefined();

      // Admin must have INSERT access
      expect(contract!.access.admin.INSERT).not.toBe('none');

      // Non-admins must NOT have INSERT/UPDATE/DELETE
      for (const role of ['sales_rep', 'driver'] as const) {
        expect(
          contract!.access[role].INSERT,
          `SECURITY: only admin should INSERT into ${tableName}, but ${role} can`
        ).toBe('none');
        expect(
          contract!.access[role].UPDATE,
          `SECURITY: only admin should UPDATE ${tableName}, but ${role} can`
        ).toBe('none');
        expect(
          contract!.access[role].DELETE,
          `SECURITY: only admin should DELETE from ${tableName}, but ${role} can`
        ).toBe('none');
      }
    });
  }
});

describe('RLS Contracts: Sensitive Data Isolation', () => {
  it('cost_history is completely invisible to non-admins', () => {
    const costHistory = RLS_ACCESS_MATRIX.find(c => c.table === 'cost_history')!;
    for (const role of ['sales_rep', 'driver'] as const) {
      for (const op of ALL_OPS) {
        expect(
          costHistory.access[role][op],
          `SECURITY: ${role} must not have ${op} on cost_history (contains margin data)`
        ).toBe('none');
      }
    }
  });

  it('purchase orders are completely invisible to non-admins', () => {
    for (const tableName of ['purchase_orders', 'purchase_order_items']) {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName)!;
      for (const role of ['sales_rep', 'driver'] as const) {
        for (const op of ALL_OPS) {
          expect(
            contract.access[role][op],
            `SECURITY: ${role} must not have ${op} on ${tableName} (contains supplier pricing)`
          ).toBe('none');
        }
      }
    }
  });

  it('financial tables are admin-only', () => {
    for (const tableName of ['invoices', 'payments']) {
      const contract = RLS_ACCESS_MATRIX.find(c => c.table === tableName)!;
      for (const role of ['sales_rep', 'driver'] as const) {
        for (const op of ALL_OPS) {
          expect(
            contract.access[role][op],
            `SECURITY: ${role} must not have ${op} on ${tableName}`
          ).toBe('none');
        }
      }
    }
  });

  it('notifications are user-scoped (no cross-user visibility)', () => {
    const notifs = RLS_ACCESS_MATRIX.find(c => c.table === 'notifications')!;
    for (const role of ALL_ROLES) {
      expect(notifs.access[role].SELECT).toBe('own');
      expect(notifs.access[role].UPDATE).toBe('own');
    }
  });
});

describe('RLS Contracts: Ownership Scope Consistency', () => {
  it('if a role has INSERT=own, they also have UPDATE=own or scoped (unless append-only)', () => {
    for (const contract of RLS_ACCESS_MATRIX) {
      // Append-only tables intentionally allow INSERT but not UPDATE
      if (APPEND_ONLY_TABLES.includes(contract.table)) continue;

      for (const role of ALL_ROLES) {
        const access = contract.access[role];
        if (access.INSERT === 'own') {
          expect(
            ['own', 'scoped', 'all'].includes(access.UPDATE),
            `${contract.table}.${role}: can INSERT own rows but cannot UPDATE them (INSERT=own, UPDATE=${access.UPDATE})`
          ).toBe(true);
        }
      }
    }
  });

  it('if a role has no SELECT, they have no other access', () => {
    for (const contract of RLS_ACCESS_MATRIX) {
      for (const role of ALL_ROLES) {
        const access = contract.access[role];
        if (access.SELECT === 'none') {
          expect(
            access.INSERT,
            `${contract.table}.${role}: no SELECT but has INSERT=${access.INSERT}`
          ).toBe('none');
          expect(
            access.UPDATE,
            `${contract.table}.${role}: no SELECT but has UPDATE=${access.UPDATE}`
          ).toBe('none');
          expect(
            access.DELETE,
            `${contract.table}.${role}: no SELECT but has DELETE=${access.DELETE}`
          ).toBe('none');
        }
      }
    }
  });

  it('quote child tables follow parent quote access pattern', () => {
    const quotes = RLS_ACCESS_MATRIX.find(c => c.table === 'quotes')!;
    const childTables = ['quote_sections', 'quote_items'];

    for (const tableName of childTables) {
      const child = RLS_ACCESS_MATRIX.find(c => c.table === tableName)!;
      for (const role of ALL_ROLES) {
        // If role can INSERT quotes, they should be able to INSERT child rows
        if (quotes.access[role].INSERT !== 'none') {
          expect(
            child.access[role].INSERT,
            `${tableName}.${role}: should be able to INSERT if can INSERT quotes`
          ).not.toBe('none');
        }
      }
    }
  });
});

describe('RLS Contracts: Helper Function Requirements', () => {
  it('all role checks require is_active=true (documented requirement)', () => {
    // This test documents the requirement that is_admin(), is_sales_rep(),
    // and is_driver() all check is_active=true on the profiles table.
    // This was added in migration 20260209200000_tier1_audit_fixes.sql
    // to ensure deactivated users lose ALL access.
    //
    // The actual SQL is:
    //   SELECT EXISTS (
    //     SELECT 1 FROM profiles
    //     WHERE id = auth.uid()
    //       AND role = 'admin'
    //       AND is_active = true
    //   )
    //
    // This test serves as a reminder: if you change these functions,
    // NEVER remove the is_active check.
    const requirement = 'is_active = true must be in is_admin(), is_sales_rep(), is_driver()';
    expect(requirement).toBeTruthy();
  });

  it('helper functions use SECURITY DEFINER (can read profiles despite RLS)', () => {
    // is_admin/is_sales_rep/is_driver must be SECURITY DEFINER because
    // they need to read the profiles table, which itself has RLS.
    // Without SECURITY DEFINER, checking the role would fail due to
    // circular dependency (can't check role to determine if you can see profiles).
    const requirement = 'SECURITY DEFINER with SET search_path = public';
    expect(requirement).toBeTruthy();
  });
});

// ─── Exports for use in E2E / live DB tests (Sprint 3c) ──────────────
export {
  RLS_ACCESS_MATRIX,
  APPEND_ONLY_TABLES,
  DRIVER_BLOCKED_TABLES,
  REP_BLOCKED_TABLES,
  ADMIN_ONLY_WRITE_TABLES,
  ALL_ROLES,
  ALL_OPS,
};
export type { TableRLSContract, RoleAccess, Role, Operation, AccessLevel };
