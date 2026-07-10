/**
 * pagePermissions.test.ts — Tests for page access control system
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  PAGE_PERMISSIONS,
  EXEMPT_ROUTE_SEGMENTS,
  getPageKeyFromPath,
  hasPageAccess,
  getPagesForRole,
  getCategories,
  isExemptRoute,
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

  it('maps the KPI dashboard route to the dashboard permission', () => {
    expect(getPageKeyFromPath('/dashboard')).toBe('dashboard');
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

  // Codex Phase-1a R2: the field-application editor is mounted under
  // /invoices/field-app/* but must resolve to the SEPARATE 'field-invoices'
  // permission, not Chemical Sales 'invoices'. Regression guard for the
  // segregation requirement.
  it('maps the field-app invoice editor to the field-invoices permission', () => {
    expect(getPageKeyFromPath('/invoices/field-app/new')).toBe('field-invoices');
    expect(getPageKeyFromPath('/invoices/field-app/abc-123-def')).toBe('field-invoices');
  });

  it('keeps the Chemical Sales invoice list on the invoices permission', () => {
    expect(getPageKeyFromPath('/invoices')).toBe('invoices');
    expect(getPageKeyFromPath('/invoices/some-invoice-id')).toBe('invoices');
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
    expect(pages.length).toBeLessThanOrEqual(4);
    const keys = pages.map((p) => p.key);
    expect(keys).toContain('deliveries');
    expect(keys).toContain('my-route');
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
    expect(categories).toEqual([
      'Sell & Deliver',
      'Spray Fields',
      'Customers & Fields',
      'Inventory & Buying',
      'Money',
      'Compliance & Records',
      'Insights',
      'Setup & Admin',
    ]);
  });
});

// ── PR-11: Fail-closed coverage of every protected route ──────────────────

function extractRouteFirstSegmentsFromAppTsx(): Set<string> {
  const appTsxPath = resolve(__dirname, '../App.tsx');
  const source = readFileSync(appTsxPath, 'utf-8');

  const segments = new Set<string>();
  // Match `path: 'foo'` or `path: 'foo/bar'` — captures the first segment.
  // Restricted to lowercase alphanumeric + dash so wildcard ('*') and
  // route params (':id') don't get captured as page keys.
  const matches = source.matchAll(/path:\s*['"]([a-z][a-z0-9-]*)/g);
  for (const m of matches) {
    const seg = m[1].trim();
    if (seg) segments.add(seg);
  }
  return segments;
}

describe('PAGE_PERMISSIONS coverage (PR-11 fail-closed)', () => {
  it('every protected route in App.tsx has a PAGE_PERMISSIONS entry or is exempt', () => {
    const routeSegments = extractRouteFirstSegmentsFromAppTsx();
    const knownKeys = new Set(PAGE_PERMISSIONS.map((p) => p.key));

    const missing: string[] = [];
    for (const seg of routeSegments) {
      if (EXEMPT_ROUTE_SEGMENTS.has(seg)) continue;
      if (!knownKeys.has(seg)) missing.push(seg);
    }

    // Surface the diff explicitly so a failing test names the missing route(s).
    expect(missing, `Routes in App.tsx missing from PAGE_PERMISSIONS: ${missing.join(', ')}`).toEqual([]);
  });

  it('finds the routes Mason added in PR-11', () => {
    // Sanity check on the route extractor itself — confirm it picks up the
    // five routes that PR-11 specifically patched.
    const segments = extractRouteFirstSegmentsFromAppTsx();
    for (const expected of ['dispatch', 'program-tracker', 'application-services', 'prepay-workspace', 'getting-started']) {
      expect(segments, `extractor should find /${expected}`).toContain(expected);
    }
  });

  it('isExemptRoute returns true for known exempt segments and false otherwise', () => {
    for (const seg of EXEMPT_ROUTE_SEGMENTS) {
      expect(isExemptRoute(`/${seg}`)).toBe(true);
      expect(isExemptRoute(`/${seg}/something`)).toBe(true);
    }
    expect(isExemptRoute('/quotes')).toBe(false);
    expect(isExemptRoute('/dispatch')).toBe(false);
    expect(isExemptRoute('/made-up-page')).toBe(false);
  });
});

// ── PAGE_PERMISSIONS structure ──────────────────────────────────────────

describe('PAGE_PERMISSIONS data integrity', () => {
  it('has no duplicate page keys', () => {
    const keys = PAGE_PERMISSIONS.map((p) => p.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('all entries have non-empty key, path, label, category, and roles', () => {
    for (const perm of PAGE_PERMISSIONS) {
      expect(perm.key.length).toBeGreaterThan(0);
      expect(perm.path.length).toBeGreaterThan(0);
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
