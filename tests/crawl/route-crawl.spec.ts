/**
 * CRX Nightly Debug — Runtime Route Crawl
 *
 * Drives every page of the app in a headless browser as each role for which
 * credentials are present, and records per-route runtime health:
 *   - JavaScript console errors
 *   - uncaught page errors (pageerror)
 *   - failed network responses (HTTP >= 400 — e.g. a broken PostgREST query returns 400)
 *   - whether the ErrorBoundary fallback rendered ("This page crashed" / "Something went wrong")
 *   - whether a role-guarded route correctly redirected (RBAC guard check)
 *
 * READ-ONLY: it only navigates (GET-style). It submits no forms and runs no
 * mutations. It is equivalent to a user browsing. It does NOT run the E2E
 * fixture global setup/teardown (this config has none), so it creates/deletes
 * no test data.
 *
 * CREDENTIAL-GATED: it reads creds straight from process.env and crawls only
 * the roles that have them. With zero creds it registers a single skipped test
 * and writes a "skipped" results file — it never throws. This is why it does
 * NOT import tests/e2e/utils/auth.ts (that module fail-closes at import time).
 *
 * Results are written to docs/audits/nightly-debug/crawl-latest.json for the
 * nightly loop to triage into findings.
 */
import { test, type Page } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

type Role = 'admin' | 'sales_rep' | 'driver' | 'applicator';

interface RoleCred {
  name: Role;
  email: string;
  password: string;
}

// Build the list of roles we have credentials for. Admin uses the standard
// E2E_TEST_* vars; the others use role-specific vars (same names the existing
// role specs use).
function rolesFromEnv(): RoleCred[] {
  const out: RoleCred[] = [];
  const push = (name: Role, e?: string, p?: string) => {
    if (e && p) out.push({ name, email: e, password: p });
  };
  push('admin', process.env.E2E_TEST_EMAIL, process.env.E2E_TEST_PASSWORD);
  push('sales_rep', process.env.E2E_SALESREP_EMAIL, process.env.E2E_SALESREP_PASSWORD);
  push('driver', process.env.E2E_DRIVER_EMAIL, process.env.E2E_DRIVER_PASSWORD);
  push('applicator', process.env.E2E_APPLICATOR_EMAIL, process.env.E2E_APPLICATOR_PASSWORD);
  return out;
}

// Authoritative non-parameterized route list, derived from src/App.tsx, with the
// roles each route allows (so we can verify guards AND page loads in one pass).
const ALL: Role[] = ['admin', 'sales_rep', 'driver', 'applicator'];
const AS: Role[] = ['admin', 'sales_rep'];
const ADMIN: Role[] = ['admin'];
type CrawlRoute = { path: string; roles: Role[]; intentionalRedirectTo?: string };

const ROUTES: CrawlRoute[] = [
  { path: '/', roles: ALL },
  { path: '/team-board', roles: ALL },
  { path: '/notifications', roles: ALL },
  { path: '/getting-started', roles: ALL },
  { path: '/products', roles: AS },
  { path: '/customers', roles: AS },
  { path: '/fields', roles: AS },
  // Creation / "new" form routes are EXCLUDED from this crawl: some reserve a real sequence
  // value on mount — e.g. /quotes/new mounts QuoteBuilder which calls generate_quote_number()
  // -> nextval('quote_number_seq'), which would MUTATE prod and break the read-only safety
  // model (Codex P1). The crawl visits list/detail/index pages only.
  { path: '/quotes', roles: AS },
  { path: '/orders', roles: AS },
  { path: '/inventory', roles: AS },
  { path: '/invoices', roles: AS },
  { path: '/blend-tickets', roles: AS },
  { path: '/recipes', roles: AS },
  { path: '/cycle-counts', roles: ADMIN },
  { path: '/returns', roles: AS },
  { path: '/receiving', roles: AS },
  { path: '/purchase-orders', roles: AS },
  { path: '/brand-vs-generic', roles: AS },
  { path: '/reports', roles: AS },
  { path: '/sales-reports', roles: AS },
  { path: '/crop-programs', roles: AS },
  { path: '/payments', roles: AS },
  { path: '/payment-history', roles: ADMIN },
  { path: '/ar-aging', roles: ADMIN },
  { path: '/compliance', roles: AS },
  { path: '/rebates', roles: ADMIN },
  { path: '/vehicles', roles: ADMIN },
  { path: '/application-services', roles: ADMIN },
  { path: '/application-records', roles: ['admin', 'sales_rep', 'applicator'] },
  { path: '/program-tracker', roles: AS },
  { path: '/delivery-remainders', roles: AS },
  { path: '/deliveries', roles: ['admin', 'sales_rep', 'driver'] },
  { path: '/my-route', roles: ['admin', 'sales_rep', 'driver'] },
  { path: '/jobs', roles: ['admin', 'sales_rep', 'applicator'] },
  { path: '/dispatch', roles: ['admin', 'sales_rep', 'applicator'] },
  { path: '/financial-dashboard', roles: ADMIN },
  { path: '/month-end', roles: ADMIN },
  // These bookmark-preserving routes deliberately redirect to a tab on their
  // replacement page. A successful redirect is a passing behavior, not a page
  // that failed to render.
  { path: '/integrity-report', roles: ADMIN, intentionalRedirectTo: '/integrity' },
  { path: '/integrity-cleanup', roles: ADMIN, intentionalRedirectTo: '/integrity' },
  { path: '/commission-payments', roles: ADMIN },
  { path: '/customer-transactions', roles: ADMIN },
  { path: '/prepayments', roles: ADMIN, intentionalRedirectTo: '/prepay' },
  { path: '/prepay-workspace', roles: ADMIN, intentionalRedirectTo: '/prepay' },
  { path: '/accounts-payable', roles: ADMIN },
  { path: '/accounts-payable/bills', roles: ADMIN },
  { path: '/vendors', roles: ADMIN },
  { path: '/settings', roles: ADMIN },
];

// Console noise that is not a real defect — keep this list conservative.
const IGNORE = [
  /favicon/i,
  /ResizeObserver loop/i,
  /Download the React DevTools/i,
  /\[vite\]/i,
  /sourcemap/i,
  /mapbox.*(token|access)/i,
];
const isIgnored = (t: string) => IGNORE.some((re) => re.test(t));

interface RouteResult {
  role: Role;
  path: string;
  allowed: boolean;
  finalPath: string;
  redirected: boolean;
  crashed: boolean;
  consoleErrors: string[];
  pageErrors: string[];
  failedResponses: string[];
  status: 'ok' | 'crashed' | 'console-errors' | 'network-errors' | 'unexpected-redirect' | 'intentional-redirect' | 'guard-ok' | 'guard-leak';
}

const results: RouteResult[] = [];

async function login(page: Page, email: string, password: string): Promise<void> {
  // Mirror of tests/e2e/utils/auth.ts login() — retries past Supabase auth rate-limit.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.goto('/login');
    const emailInput = page.locator('input[type="email"]');
    const isLoginPage = await emailInput.isVisible({ timeout: 3000 }).catch(() => false);
    if (!isLoginPage) return; // already authenticated
    await emailInput.fill(email);
    await page.fill('input[type="password"]', password);
    await page.click('button[type="submit"]');
    try {
      await page.waitForURL('/', { timeout: 8000 });
      return;
    } catch {
      if (attempt === 3) throw new Error(`login failed after 3 attempts for ${email}`);
      await page.waitForTimeout(1000);
    }
  }
}

async function crawlRoute(page: Page, role: Role, route: CrawlRoute): Promise<void> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];

  const onConsole = (msg: { type(): string; text(): string }) => {
    if (msg.type() === 'error' && !isIgnored(msg.text())) consoleErrors.push(msg.text().slice(0, 300));
  };
  const onPageError = (err: Error) => pageErrors.push((err.message || String(err)).slice(0, 300));
  const onResponse = (resp: { status(): number; url(): string }) => {
    const s = resp.status();
    if (s >= 400 && !resp.url().includes('/favicon')) failedResponses.push(`${s} ${resp.url().slice(0, 200)}`);
  };

  page.on('console', onConsole);
  page.on('pageerror', onPageError);
  page.on('response', onResponse);

  await page.goto(route.path, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(800);

  const finalPath = new URL(page.url()).pathname;
  const crashed =
    (await page.locator('text=This page crashed').count().catch(() => 0)) +
      (await page.locator('text=Something went wrong').count().catch(() => 0)) >
    0;

  page.off('console', onConsole);
  page.off('pageerror', onPageError);
  page.off('response', onResponse);

  const allowed = route.roles.includes(role);
  // A route counts as "stayed" if the final path still matches the target.
  const stayed = finalPath === route.path || finalPath === route.path.replace(/\/$/, '');
  const redirected = !stayed;

  let status: RouteResult['status'];
  if (!allowed) {
    status = redirected ? 'guard-ok' : 'guard-leak';
  } else if (route.intentionalRedirectTo === finalPath) {
    status = 'intentional-redirect';
  } else if (redirected) {
    // Codex P2: an ALLOWED route that redirects away never rendered — a broken/missing route
    // or an auth/profile-guard regression. Don't let it fall through to 'ok'.
    status = 'unexpected-redirect';
  } else if (crashed) {
    status = 'crashed';
  } else if (pageErrors.length > 0 || consoleErrors.length > 0) {
    status = 'console-errors';
  } else if (failedResponses.length > 0) {
    status = 'network-errors';
  } else {
    status = 'ok';
  }

  results.push({
    role,
    path: route.path,
    allowed,
    finalPath,
    redirected,
    crashed,
    consoleErrors,
    pageErrors,
    failedResponses,
    status,
  });
}

// SAFETY GATE (Codex cross-review P1): this crawl is NOT read-only against production.
// Loading pages triggers on-mount side effects — e.g. Dashboard ('/') runs
// release_expired_quote_holds + notification RPCs, and every forbidden route redirects to
// Dashboard; some "new" pages reserve sequence numbers. So the crawl REFUSES to run when
// VITE_SUPABASE_URL points at the prod project; it may only run against a staging/disposable DB.
const PROD_PROJECT_REF = 'rhyzpcqhnizqbxphqdkr';
const TARGET_DB_URL = process.env.VITE_SUPABASE_URL || '';
const IS_PROD_DB = TARGET_DB_URL.includes(PROD_PROJECT_REF);

const ROLES = IS_PROD_DB ? [] : rolesFromEnv();

if (IS_PROD_DB) {
  test('route-crawl (skipped — refuses to run against the PRODUCTION database)', () => {
    test.skip(
      true,
      'VITE_SUPABASE_URL points at the prod project. The crawl is NOT read-only against prod ' +
        '(Dashboard mounts release_expired_quote_holds + notification RPCs; redirects funnel ' +
        'through it). Point VITE_SUPABASE_URL at a staging/disposable DB to enable it.',
    );
  });
} else if (ROLES.length === 0) {
  test('route-crawl (skipped — no E2E credentials)', () => {
    test.skip(true, 'Add E2E_TEST_EMAIL/E2E_TEST_PASSWORD (+ optional salesrep/driver) to a STAGING .env to enable the crawl.');
  });
} else {
  for (const cred of ROLES) {
    test(`route-crawl as ${cred.name}`, async ({ page }) => {
      test.setTimeout(180_000);
      await login(page, cred.email, cred.password);
      for (const route of ROUTES) {
        await crawlRoute(page, cred.name, route);
      }
    });
  }
}

test.afterAll(() => {
  const outDir = resolve(process.cwd(), 'docs/audits/nightly-debug');
  try {
    mkdirSync(outDir, { recursive: true });
  } catch {
    /* dir exists */
  }
  const summary = {
    ok: results.filter((r) => r.status === 'ok').length,
    crashed: results.filter((r) => r.status === 'crashed').length,
    consoleErrors: results.filter((r) => r.status === 'console-errors').length,
    networkErrors: results.filter((r) => r.status === 'network-errors').length,
    unexpectedRedirect: results.filter((r) => r.status === 'unexpected-redirect').length,
    guardOk: results.filter((r) => r.status === 'guard-ok').length,
    guardLeak: results.filter((r) => r.status === 'guard-leak').length,
  };
  const payload = {
    skipped: ROLES.length === 0,
    rolesCrawled: ROLES.map((r) => r.name),
    routeCount: ROUTES.length,
    summary,
    // Only the actionable results — drop the clean "ok" and "guard-ok" rows to keep it tight.
    problems: results.filter((r) => r.status !== 'ok' && r.status !== 'guard-ok' && r.status !== 'intentional-redirect'),
    results,
  };
  writeFileSync(resolve(outDir, 'crawl-latest.json'), JSON.stringify(payload, null, 2), 'utf-8');
});
