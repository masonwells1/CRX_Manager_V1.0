/**
 * pagePermissions.test.ts — Tests for page access control system
 */
import { describe, it, expect } from 'vitest';
import {
  PAGE_PERMISSIONS,
  getPageKeyFromPath,
  hasPageAccess,
  getPagesForRole,
  getCategories,
} from './pagePermissions';

// ── getPageKeyFromPath ──────────────────────────────────────────────────

describe('getPageKeyFromPath', () => {
  it('extracts page key from simple path', () => {
    expect(getPageKeyFromPath('/quotes')).toBe('quotes');
  });

  it('extracts page key from path with sub-route', () => {
    expect(getPageKeyFromPath('/quotes/new')).toBe('quotes');
  });

  it('extracts page key from path with UUID param', () => {
    expect(getPageKeyFromPath('/customers/abc-123-def')).toBe('customers');
  });

  it('returns null for non-permissionable paths', () => {
    expect(getPageKeyFromPath('/')).toBeNull();
    expect(getPageKeyFromPath('/team-board')).toBeNull();
    expect(getPageKeyFromPath('/notifications')).toBeNull();
    expect(getPageKeyFromPath('/settings')).toBeNull();
    expect(getPageKeyFromPath('/login')).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(getPageKeyFromPath('')).toBeNull();
  });

  it('handles path with trailing slash', () => {
    expect(getPageKeyFromPath('/products/')).toBe('products');
  });

  it('handles all known page keys', () => {
    for (const perm of PAGE_PERMISSIONS) {
      expect(getPageKeyFromPath(`/${perm.key}`)).toBe(perm.key);
    }
  });
});

// ── hasPageAccess ───────────────────────────────────────────────────────

describe('hasPageAccess', () => {
  it('denies access when role is null', () => {
    expect(hasPageAccess(null, [], 'quotes')).toBe(false);
  });

  it('always allows admin access to any page', () => {
    expect(hasPageAccess('admin', [], 'quotes')).toBe(true);
    expect(hasPageAccess('admin', [], 'ar-aging')).toBe(true);
    expect(hasPageAccess('admin', [], 'vehicles')).toBe(true);
  });

  it('allows sales_rep access to sales pages', () => {
    expect(hasPageAccess('sales_rep', [], 'quotes')).toBe(true);
    expect(hasPageAccess('sales_rep', [], 'orders')).toBe(true);
    expect(hasPageAccess('sales_rep', [], 'customers')).toBe(true);
  });

  it('denies sales_rep access to admin-only pages', () => {
    expect(hasPageAccess('sales_rep', [], 'ar-aging')).toBe(false);
    expect(hasPageAccess('sales_rep', [], 'vehicles')).toBe(false);
    expect(hasPageAccess('sales_rep', [], 'rebates')).toBe(false);
  });

  it('denies driver access to most pages', () => {
    expect(hasPageAccess('driver', [], 'quotes')).toBe(false);
    expect(hasPageAccess('driver', [], 'products')).toBe(false);
    expect(hasPageAccess('driver', [], 'invoices')).toBe(false);
  });

  it('allows driver access to deliveries', () => {
    expect(hasPageAccess('driver', [], 'deliveries')).toBe(true);
  });

  it('allows applicator access to jobs and application records', () => {
    expect(hasPageAccess('applicator', [], 'jobs')).toBe(true);
    expect(hasPageAccess('applicator', [], 'application-records')).toBe(true);
  });

  it('respects deny list', () => {
    expect(hasPageAccess('sales_rep', ['quotes'], 'quotes')).toBe(false);
    expect(hasPageAccess('sales_rep', ['quotes', 'orders'], 'orders')).toBe(false);
  });

  it('admin ignores deny list', () => {
    expect(hasPageAccess('admin', ['quotes', 'orders'], 'quotes')).toBe(true);
  });

  it('denies unknown page keys (fail-closed)', () => {
    expect(hasPageAccess('sales_rep', [], 'unknown-page')).toBe(false);
    expect(hasPageAccess('driver', [], 'nonexistent')).toBe(false);
  });
});

// ── getPagesForRole ─────────────────────────────────────────────────────

describe('getPagesForRole', () => {
  it('admin gets all pages', () => {
    const pages = getPagesForRole('admin');
    expect(pages.length).toBe(PAGE_PERMISSIONS.length);
  });

  it('sales_rep gets subset of pages', () => {
    const pages = getPagesForRole('sales_rep');
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.length).toBeLessThan(PAGE_PERMISSIONS.length);
    // sales_rep should NOT have admin-only pages
    const keys = pages.map((p) => p.key);
    expect(keys).not.toContain('vehicles');
    expect(keys).not.toContain('ar-aging');
    expect(keys).not.toContain('rebates');
  });

  it('driver gets very few pages', () => {
    const pages = getPagesForRole('driver');
    expect(pages.length).toBeLessThanOrEqual(2);
    const keys = pages.map((p) => p.key);
    expect(keys).toContain('deliveries');
  });

  it('applicator gets jobs and application records', () => {
    const pages = getPagesForRole('applicator');
    const keys = pages.map((p) => p.key);
    expect(keys).toContain('jobs');
    expect(keys).toContain('application-records');
  });
});

// ── getCategories ───────────────────────────────────────────────────────

describe('getCategories', () => {
  it('returns unique categories preserving order', () => {
    const categories = getCategories(PAGE_PERMISSIONS);
    expect(categories.length).toBeGreaterThan(0);
    // Check uniqueness
    expect(new Set(categories).size).toBe(categories.length);
  });

  it('returns empty array for empty input', () => {
    expect(getCategories([])).toEqual([]);
  });

  it('preserves insertion order', () => {
    const categories = getCategories(PAGE_PERMISSIONS);
    // First entry in PAGE_PERMISSIONS is Sales
    expect(categories[0]).toBe('Sales');
  });
});

// ── PAGE_PERMISSIONS structure ──────────────────────────────────────────

describe('PAGE_PERMISSIONS data integrity', () => {
  it('has no duplicate page keys', () => {
    const keys = PAGE_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('all entries have non-empty key, label, category, and roles', () => {
    for (const perm of PAGE_PERMISSIONS) {
      expect(perm.key.length).toBeGreaterThan(0);
      expect(perm.label.length).toBeGreaterThan(0);
      expect(perm.category.length).toBeGreaterThan(0);
      expect(perm.roles.length).toBeGreaterThan(0);
    }
  });

  it('every page includes admin in roles', () => {
    for (const perm of PAGE_PERMISSIONS) {
      expect(perm.roles).toContain('admin');
    }
  });
});
