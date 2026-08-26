#!/usr/bin/env node
/**
 * generate-workflow-map.mjs
 *
 * Regenerates docs/app-workflow-map.html by reading the live codebase:
 *   - src/App.tsx               → page routes + roles
 *   - src/components/layout/Sidebar.tsx → nav links
 *   - src/**                    → navigate() calls, supabase.rpc() calls, direct .from().write() calls
 *   - docs/reference/rpc-functions.md   → full RPC catalogue
 *
 * Replaces marked sections inside the HTML file in-place so hand-written
 * content (lifecycle SVGs, problem descriptions, CSS) is preserved.
 *
 * Run manually : node scripts/generate-workflow-map.mjs
 * CI check     : regenerated in CI and compared after normalizing the date stamp
 * Pre-commit   : never auto-runs or stages this file; callers stage it explicitly
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname, relative } from 'path';

const ROOT = process.cwd();
const HTML_OUT = join(ROOT, 'docs', 'app-workflow-map.html');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────
function read(rel) {
  try { return readFileSync(join(ROOT, rel), 'utf8'); }
  catch { return ''; }
}

function srcFiles() {
  const files = [];
  function walk(dir) {
    let entries;
    // Filesystem directory order is not portable. Sort before recursion so the
    // generated node/edge order is byte-stable on Windows and GitHub's Linux CI.
    try { entries = readdirSync(dir).sort(); } catch { return; }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) {
        if (!['node_modules', '.git', 'dist', '.next', '__snapshots__'].includes(e)) walk(full);
      } else if (['.tsx', '.ts', '.jsx', '.js'].includes(extname(e)) && !e.endsWith('.d.ts')) {
        files.push(full);
      }
    }
  }
  walk(join(ROOT, 'src'));
  return files;
}

// ─────────────────────────────────────────────
// 1.  Parse App.tsx → routes
//
//  Handles BOTH formats:
//    JSX:    <Route path="/foo" element={<Foo />} />
//    Object: { path: 'foo', element: <Foo ... /> }   (createBrowserRouter)
// ─────────────────────────────────────────────
function parseRoutes() {
  const src = read('src/App.tsx');
  const routes = [];
  const seen = new Set();

  function addRoute(path, component, roles) {
    // Normalise: ensure leading slash, skip wildcard
    const p = path === '' ? '/' : (path.startsWith('/') ? path : '/' + path);
    if (p === '/*' || p === '*') return;
    if (seen.has(p)) return;
    seen.add(p);
    routes.push({ path: p, component, roles });
  }

  const lines = src.split('\n');
  let m;

  for (const line of lines) {
    // Helper: extract roles from a line
    function extractRoles(l) {
      const rm = /allowedRoles=\{\s*(\[[^\]]+\])\s*\}/.exec(l);
      if (!rm) return ['all'];
      try { return JSON.parse(rm[1].replace(/'/g, '"')); } catch { return ['all']; }
    }

    // Helper: extract the actual page component (skip wrapper components like ProtectedRoute/RouteShell)
    const WRAPPERS = new Set(['ProtectedRoute','RouteShell','Suspense','ErrorBoundary','Outlet','AppLayout']);
    function extractComponent(l) {
      // Find all <ComponentName occurrences on the line
      const allComponents = [];
      const re = /<([A-Z]\w+)/g;
      let cm;
      while ((cm = re.exec(l)) !== null) allComponents.push(cm[1]);
      // Return first non-wrapper component
      return allComponents.find(c => !WRAPPERS.has(c)) || '';
    }

    // ── Object-router format: { path: 'foo', element: <Comp ...> }  ──
    const objPathM = /\{\s*path:\s*['"]([^'"*]+)['"]/.exec(line);
    if (objPathM) {
      addRoute(objPathM[1], extractComponent(line), extractRoles(line));
      continue;
    }

    // ── Index route: { index: true, element: <Dashboard /> } ──
    if (/\bindex:\s*true/.test(line)) {
      addRoute('', extractComponent(line) || 'Dashboard', ['all']);
      continue;
    }

    // ── JSX format: <Route path="/foo" element={<Foo />} /> ──
    const jsxPathM = /path="([^"*]+)"/.exec(line);
    if (jsxPathM) {
      addRoute(jsxPathM[1], extractComponent(line), extractRoles(line));
    }
  }

  return routes;
}

// ─────────────────────────────────────────────
// 2.  Parse Sidebar → nav link paths
// ─────────────────────────────────────────────
function parseNavLinks() {
  // Try several common Sidebar component locations
  const candidates = [
    'src/components/layout/Sidebar.tsx',
    'src/components/Sidebar.tsx',
    'src/components/layout/sidebar.tsx',
    'src/components/AppLayout.tsx',
  ];
  let src = '';
  for (const c of candidates) {
    const s = read(c);
    if (s) { src = s; break; }
  }

  const paths = new Set();
  // to="..." (NavLink / Link)
  const re1 = /to="(\/[^"?#]*)"/g;
  let m;
  while ((m = re1.exec(src)) !== null) paths.add(m[1]);
  // path: '/...'  (object-based nav arrays) — use separate patterns to avoid nested group issues
  const re2a = /path:\s*'(\/[^'?#]*)'/g;
  while ((m = re2a.exec(src)) !== null) paths.add(m[1]);
  const re2b = /path:\s*"(\/[^"?#]*)"/g;
  while ((m = re2b.exec(src)) !== null) paths.add(m[1]);
  // href="/..."
  const re3 = /href="(\/[^"?#]*)"/g;
  while ((m = re3.exec(src)) !== null) paths.add(m[1]);

  return [...paths];
}

// ─────────────────────────────────────────────
// 3.  Grep src/ → navigate() destination paths (per source file)
// ─────────────────────────────────────────────
function parseNavigateCalls() {
  const results = [];
  const re = /\bnavigate\s*\(\s*['"`](\/[^'"`?#]+)['"`]/g;
  for (const file of srcFiles()) {
    const src = read(relative(ROOT, file));
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      results.push({ file: relative(ROOT, file).replace(/\\/g, '/'), dest: m[1] });
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// 3b.  Grep ALL src/ for every literal route reference that makes a page reachable.
//
//  A page is reachable if it appears as a navigate() target, a <Link to="...">,
//  OR a nav-config object literal like  { label: 'X', path: '/x' }.
//  (e.g. FinancialDashboard's quick-links array reaches /payment-history this way.)
//  Catching all three sources prevents false "orphan" flags for pages that ARE
//  reachable through array-driven menus rather than the main Sidebar.
// ─────────────────────────────────────────────
function parseReachablePaths() {
  const paths = new Set();
  const patterns = [
    /\bnavigate\s*\(\s*['"`](\/[^'"`?#]+)['"`]/g,  // navigate('/x')
    /\bto=\{?['"`](\/[^'"`?#]+)['"`]/g,            // to="/x" / to={'/x'}
    /\bto:\s*['"`](\/[^'"`?#]+)['"`]/g,            // to: '/x'
    /\bpath:\s*['"`](\/[^'"`?#]+)['"`]/g,          // path: '/x'  (nav-config arrays)
    /\bhref=['"`](\/[^'"`?#]+)['"`]/g,             // href="/x"
  ];
  for (const file of srcFiles()) {
    const src = read(relative(ROOT, file));
    for (const re of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src)) !== null) paths.add(m[1]);
    }
  }
  return paths;
}

// ─────────────────────────────────────────────
// 4.  Grep src/ → supabase.rpc('name') calls (per source file)
// ─────────────────────────────────────────────
function parseRpcCalls() {
  const byFile = {};   // file → Set<rpcName>
  const allCalled = new Set();
  const re = /\.rpc\s*\(\s*['"`]([a-z_]+)['"`]/g;
  for (const file of srcFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const src = read(rel);
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      const name = m[1];
      allCalled.add(name);
      if (!byFile[rel]) byFile[rel] = new Set();
      byFile[rel].add(name);
    }
  }
  return { byFile, allCalled };
}

// ─────────────────────────────────────────────
// 5.  Grep src/ → direct table writes
//
//  NOTE: a direct .from().insert/update/delete is NOT inherently a problem —
//  Architecture Rule #3 explicitly endorses direct writes wrapped in
//  checkMutationResult(). So we ALSO record whether the file uses
//  checkMutationResult at all, and only the genuinely-unguarded files are
//  flagged later. This avoids the prior 65-false-positive flood.
// ─────────────────────────────────────────────
function parseDirectWrites() {
  const results = [];
  const re = /\.from\s*\(\s*['"`]([a-z_]+)['"`]\s*\)\s*\.(insert|update|delete)/g;
  for (const file of srcFiles()) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const src = read(rel);
    const guarded = src.includes('checkMutationResult');
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) {
      results.push({ table: m[1], op: m[2], file: rel, guarded });
    }
  }
  return results;
}

// ─────────────────────────────────────────────
// 6.  Parse docs/reference/rpc-functions.md → full RPC catalogue
// ─────────────────────────────────────────────
function parseDocRpcs() {
  const src = read('docs/reference/rpc-functions.md');
  const names = new Set();
  // Markdown table row: | `func_name` |  or  | func_name |
  const re1 = /\|\s*`?([a-z][a-z_]{4,})`?\s*\|/g;
  let m;
  while ((m = re1.exec(src)) !== null) {
    if (m[1].includes('_')) names.add(m[1]);
  }
  // Section headers: ## func_name
  const re2 = /^#{2,4}\s+`?([a-z][a-z_]{4,})`?/gm;
  while ((m = re2.exec(src)) !== null) {
    if (m[1].includes('_')) names.add(m[1]);
  }
  return [...names];
}

// ─────────────────────────────────────────────
// 7.  Classify helpers
// ─────────────────────────────────────────────

/**
 * Convert a PascalCase component name to a kebab-case node ID.
 * 'OrderDetail' → 'order-detail',  'NewPurchaseOrder' → 'new-purchase-order'
 */
function componentToId(name) {
  if (!name) return null;
  return name
    .replace(/([A-Z])/g, (c, i) => (i ? '-' : '') + c.toLowerCase())
    .replace(/^-/, '');
}

/**
 * Convert a route path to a best-guess node ID when component name is unavailable.
 * '/orders/new' → 'orders-new',   '/orders/:id' → 'orders'
 */
function pathFallbackId(path) {
  return path
    .replace(/^\//, '')
    .replace(/\/:[\w]+$/, '')   // strip trailing :param
    .replace(/\//g, '-')
    || 'dashboard';
}

// Internal / trigger / cron functions that are correctly never called from frontend
const INTERNAL_RPCS = new Set([
  // Cron / scheduled
  'auto_expire_quotes','mark_overdue_invoices','generate_rup_sales_records',
  // Infrastructure helpers (called from other RPCs, not directly from frontend)
  'check_idempotency','save_idempotency','check_rate_limit','check_period_open',
  'check_duplicate_delivery','check_customer_credit_limit',
  // Trigger functions
  'release_holds_on_quote_status_change','enforce_invoice_draft_on_insert',
  'calculate_billing_splits','calculate_prices_from_margin',
  // Date/season helpers
  'compute_season','current_season','season_start_date','season_end_date',
  // Internal field billing helpers
  'get_field_billing_splits_for_blend_ticket','get_field_billing_splits_for_order',
  // Unit conversion helpers
  'convert_to_gl_lb',
  // Reconcile helpers
  'reconcile_prepay_balances',
  // Legacy/replaced
  'dashboard_summary','get_field_geojson','get_field_polygons','save_field_polygons',
  'generate_order_number',
]);

function fileToApproxNodeId(filePath) {
  // src/pages/QuoteBuilder.tsx  →  'quote-builder' (via componentToId)
  const m = /pages[/\\]([^/\\]+)\.(tsx?|jsx?)$/.exec(filePath);
  if (!m) return null;
  return componentToId(m[1]);
}

function rpcToGroupId(name) {
  const map = [
    [/^(save_quote|generate_quote|duplicate_quote|rollover_quote|create_quote|restore_quote|convert_quote)/, 'r-quote'],
    [/^(save_order|create_order|create_direct|cancel_order|void_order|update_order|convert_quote_to_order)/, 'r-order'],
    [/^(create_delivery|confirm_delivery|complete_delivery|cancel_delivery|void_delivery|edit_delivery|reassign|batch_cancel|batch_reschedule|create_quick_delivery|create_followup|get_team_board|get_yesterday)/, 'r-delivery'],
    [/^(save_invoice|save_field_app_split_invoice|post_invoice|void_invoice|batch_post|batch_void|create_invoice|record_invoice|apply_write_off|reverse_write_off|generate_finance|apply_remaining)/, 'r-invoice'],
    [/^(record_payment|allocate_payment|apply_prepay|void_payment)/, 'r-payment'],
    [/^(adjust_inventory|create_inventory|release_inventory|receive_po|manual_inventory|retire_inventory|mark_inventory|reconcile|get_inventory|transfer_inventory)/, 'r-inventory'],
    [/^(save_purchase|cancel_purchase|save_vendor|pay_vendor|receive_po)/, 'r-po'],
    [/^(save_job|complete_job|cancel_job|transfer_job|assign_job)/, 'r-job'],
    [/^(save_blend|batch_approve_blend|batch_reject_blend|create_invoice_from_blend|create_order_from_blend|create_application_record_from_blend|link_blend|unlink_blend)/, 'r-blend'],
    [/^(get_ar_aging|get_customer_statement|get_detailed|get_sales|get_logbook|operational_dashboard|financial_dashboard|get_profile_detail|dashboard_summary)/, 'r-report'],
    [/^(approve_return|cancel_return|receive_return|issue_return_credit|request_return|save_return)/, 'r-return'],
    // Appended 2026-06-08 (map-drift audit MAP-1): subsystems the app grew into.
    // Placed LAST so first-match-wins leaves every existing grouping unchanged —
    // these only catch RPC names that previously matched no group at all.
    [/commission_payment/, 'r-commission'],
    [/vendor_bill|vendor_payment/, 'r-vendor'],
    [/cycle_count/, 'r-cycle'],
    [/rebate/, 'r-rebate'],
  ];
  for (const [re, gid] of map) if (re.test(name)) return gid;
  return null;
}

// ─────────────────────────────────────────────
// 8.  Static entity + RPC group nodes / data-flow edges
//     (change these here when entities or data flows change)
// ─────────────────────────────────────────────
const ENTITY_NODES = [
  {id:'e-customer',label:'Customer',type:'entity',group:'Entity'},
  {id:'e-quote',label:'Quote',type:'entity',group:'Entity'},
  {id:'e-order',label:'Order',type:'entity',group:'Entity'},
  {id:'e-delivery',label:'Delivery',type:'entity',group:'Entity'},
  {id:'e-invoice',label:'Invoice',type:'entity',group:'Entity'},
  {id:'e-payment',label:'Payment',type:'entity',group:'Entity'},
  {id:'e-product',label:'Product',type:'entity',group:'Entity'},
  {id:'e-inventory',label:'Inventory',type:'entity',group:'Entity'},
  {id:'e-po',label:'PurchaseOrder',type:'entity',group:'Entity'},
  {id:'e-return',label:'Return',type:'entity',group:'Entity'},
  {id:'e-job',label:'Job',type:'entity',group:'Entity'},
  {id:'e-blend',label:'BlendTicket',type:'entity',group:'Entity'},
  {id:'e-commission',label:'Commission',type:'entity',group:'Entity'},
  {id:'e-field',label:'Field',type:'entity',group:'Entity'},
  // Added 2026-06-08 (map-drift audit MAP-1) — entities for the newly-modeled subsystems
  {id:'e-vendorbill',label:'Vendor Bill (AP)',type:'entity',group:'Entity'},
  {id:'e-cyclecount',label:'Cycle Count',type:'entity',group:'Entity'},
  {id:'e-rebate',label:'Rebate',type:'entity',group:'Entity'},
];

const RPC_GROUP_NODES = [
  {id:'r-quote',label:'RPCs: Quote',type:'rpc',group:'RPC'},
  {id:'r-order',label:'RPCs: Order',type:'rpc',group:'RPC'},
  {id:'r-delivery',label:'RPCs: Delivery',type:'rpc',group:'RPC'},
  {id:'r-invoice',label:'RPCs: Invoice',type:'rpc',group:'RPC'},
  {id:'r-payment',label:'RPCs: Payment',type:'rpc',group:'RPC'},
  {id:'r-inventory',label:'RPCs: Inventory',type:'rpc',group:'RPC'},
  {id:'r-po',label:'RPCs: PO/Receiving',type:'rpc',group:'RPC'},
  {id:'r-job',label:'RPCs: Job',type:'rpc',group:'RPC'},
  {id:'r-blend',label:'RPCs: BlendTicket',type:'rpc',group:'RPC'},
  {id:'r-report',label:'RPCs: Reports',type:'rpc',group:'RPC'},
  {id:'r-return',label:'RPCs: Return',type:'rpc',group:'RPC'},
  // Added 2026-06-08 (map-drift audit MAP-1) — previously unmodeled write subsystems
  {id:'r-commission',label:'RPCs: Commission Pay',type:'rpc',group:'RPC'},
  {id:'r-vendor',label:'RPCs: Vendor/AP',type:'rpc',group:'RPC'},
  {id:'r-cycle',label:'RPCs: Cycle Count',type:'rpc',group:'RPC'},
  {id:'r-rebate',label:'RPCs: Rebate',type:'rpc',group:'RPC'},
];

const DATA_FLOW_EDGES = [
  {s:'r-quote',t:'e-quote',type:'data'},{s:'e-quote',t:'e-inventory',type:'data'},
  {s:'r-order',t:'e-order',type:'data'},{s:'e-quote',t:'e-order',type:'data'},
  {s:'r-delivery',t:'e-delivery',type:'data'},{s:'e-order',t:'e-delivery',type:'data'},
  {s:'r-invoice',t:'e-invoice',type:'data'},{s:'e-delivery',t:'e-invoice',type:'data'},
  {s:'e-order',t:'e-invoice',type:'data'},{s:'e-blend',t:'e-invoice',type:'data'},
  {s:'r-payment',t:'e-payment',type:'data'},{s:'e-payment',t:'e-invoice',type:'data'},
  {s:'r-po',t:'e-po',type:'data'},{s:'e-po',t:'e-inventory',type:'data'},
  {s:'r-inventory',t:'e-inventory',type:'data'},
  {s:'r-job',t:'e-job',type:'data'},{s:'e-job',t:'e-invoice',type:'data'},
  {s:'r-blend',t:'e-blend',type:'data'},{s:'e-blend',t:'e-order',type:'data'},
  {s:'r-return',t:'e-return',type:'data'},{s:'e-return',t:'e-inventory',type:'data'},
  {s:'e-customer',t:'e-quote',type:'data'},{s:'e-customer',t:'e-order',type:'data'},
  {s:'e-customer',t:'e-invoice',type:'data'},{s:'e-order',t:'e-commission',type:'data'},
  {s:'e-product',t:'e-inventory',type:'data'},{s:'e-field',t:'e-quote',type:'data'},
  // Added 2026-06-08 (map-drift audit MAP-1): connect the newly-modeled RPC groups
  // to their entities so the subsystems aren't left floating. cyclecount→inventory
  // is the one well-established cross-entity link (cycle counts reconcile inventory).
  {s:'r-commission',t:'e-commission',type:'data'},
  {s:'r-vendor',t:'e-vendorbill',type:'data'},
  {s:'r-cycle',t:'e-cyclecount',type:'data'},{s:'e-cyclecount',t:'e-inventory',type:'data'},
  {s:'r-rebate',t:'e-rebate',type:'data'},
];

// ─────────────────────────────────────────────
// 9.  Build graph data
// ─────────────────────────────────────────────
function buildGraphData(routes, navLinks, navigateCalls, rpcCallsByFile, docRpcs, reachablePaths) {

  const AUTH_PATHS = new Set(['/login', '/forgot-password', '/reset-password']);
  const navSet = new Set(navLinks);
  const reachable = reachablePaths || new Set();
  // Nodes hardcoded as "problems" — kept empty. A node is only marked problem:true
  // if it's a genuine orphan computed from the live codebase (see isOrphan below).
  // The prior list (notifications/payment-history/returns/rebates/vehicle-detail)
  // was verified FALSE on 2026-05-20 and removed.
  const KNOWN_PROBLEM_IDS = new Set([]);

  // ── Build nodeId from component name (primary) or path (fallback) ──
  function nodeIdFor(r) {
    return r.component ? componentToId(r.component) : pathFallbackId(r.path);
  }

  // ── Build path → nodeId lookup for navigate() resolution ──
  const pathToNodeId = {};
  for (const r of routes) {
    pathToNodeId[r.path] = nodeIdFor(r);
  }
  // Normalise paths: also index without leading slash
  for (const r of routes) {
    const noSlash = r.path.replace(/^\//, '');
    if (!pathToNodeId[noSlash]) pathToNodeId[noSlash] = nodeIdFor(r);
  }

  function resolveDestToNodeId(dest) {
    // Exact match
    if (pathToNodeId[dest]) return pathToNodeId[dest];
    // Parametric match: /orders/abc → find /orders/:id
    for (const [pattern, id] of Object.entries(pathToNodeId)) {
      if (!pattern.includes(':')) continue;
      try {
        const re = new RegExp('^' + pattern.replace(/:[\w]+/g, '[^/]+') + '$');
        if (re.test(dest)) return id;
      } catch { /* skip bad patterns */ }
    }
    return null;
  }

  function routeGroup(path) {
    if (AUTH_PATHS.has(path)) return 'Auth';
    if (/quote/.test(path)) return 'Sales';
    if (/\/(order|invoice|payment)/.test(path)) return 'Sales';
    if (/\/(customer|field|crop)/.test(path)) return 'Customers';
    if (/\/(product|inventor|recipe|brand|cycle)/.test(path)) return 'Products';
    if (/\/(purchase|receiv|return)/.test(path)) return 'Supply';
    if (/\/(deliver|job|dispatch|blend|vehicle|application|program)/.test(path)) return 'Ops';
    if (/\/(financial|ar-|month|integrity|commission|prepay|payable|rebate|report|compliance|customer-trans|payment-hist|sales-report)/.test(path)) return 'Finance';
    return 'Core';
  }

  function routeType(r) {
    if (AUTH_PATHS.has(r.path)) return 'page-auth';
    if (r.roles[0] === 'all' || r.roles.length === 0) return 'page-all';
    if (r.roles.length === 1 && r.roles[0] === 'admin') return 'page-admin';
    if (r.roles.includes('admin') && !r.roles.includes('sales_rep')) return 'page-admin';
    return 'page-sales';
  }

  // ── Page nodes ──────────────────────────────
  const seenIds = new Set();
  const pageNodes = [];
  for (const r of routes) {
    const id = nodeIdFor(r);
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);

    // A page is reachable if it's a parameter/new sub-route (always reached
    // dynamically), in the sidebar, or referenced anywhere (navigate/Link/path:).
    const isSubRoute = r.path.includes('/:') || r.path.endsWith('/new');
    let reachableHit = navSet.has(r.path) || reachable.has(r.path);
    if (!reachableHit) {
      for (const p of reachable) { if (p === r.path || p.startsWith(r.path + '/')) { reachableHit = true; break; } }
    }
    const isOrphan = !isSubRoute && !reachableHit && !AUTH_PATHS.has(r.path) && r.path !== '/';

    pageNodes.push({
      id,
      label: r.component || id,
      type: routeType(r),
      group: routeGroup(r.path),
      path: r.path,
      problem: KNOWN_PROBLEM_IDS.has(id) || isOrphan,
    });
  }

  const allNodes = [...pageNodes, ...ENTITY_NODES, ...RPC_GROUP_NODES];
  const nodeIds = new Set(allNodes.map(n => n.id));

  // ── Edges ────────────────────────────────────
  const edgeSeen = new Set();
  const edges = [];

  function addEdge(s, t, type) {
    if (!nodeIds.has(s) || !nodeIds.has(t) || s === t) return;
    const key = `${s}|${t}|${type}`;
    if (edgeSeen.has(key)) return;
    edgeSeen.add(key);
    edges.push({ s, t, type });
  }

  // Nav edges from navigate() calls
  for (const { file, dest } of navigateCalls) {
    const fromId = fileToApproxNodeId(file);
    if (!fromId) continue;
    const toId = resolveDestToNodeId(dest);
    if (toId) addEdge(fromId, toId, 'nav');
  }

  // RPC call edges: page → rpc_group
  for (const [file, rpcNames] of Object.entries(rpcCallsByFile)) {
    const fromId = fileToApproxNodeId(file);
    if (!fromId) continue;
    for (const rpc of rpcNames) {
      const gid = rpcToGroupId(rpc);
      if (gid) addEdge(fromId, gid, 'rpc');
    }
  }

  // Data flow edges (static)
  for (const e of DATA_FLOW_EDGES) edges.push(e);

  return { nodes: allNodes, edges };
}

// ─────────────────────────────────────────────
// 10.  Compute problems
// ─────────────────────────────────────────────
function computeProblems(routes, navLinks, navigateCalls, rpcCalls, docRpcs, directWrites, reachablePaths) {
  const problems = [];
  const navSet = new Set(navLinks);
  const AUTH_PATHS = new Set(['/login', '/forgot-password', '/reset-password']);

  // A page is reachable if it's in the sidebar, OR any literal route reference
  // (navigate / Link to= / nav-config path:) anywhere in src points at it.
  function isReachable(path) {
    if (navSet.has(path)) return true;
    if (reachablePaths.has(path)) return true;
    // prefix match: a navigate to /foo/bar makes /foo reachable
    for (const p of reachablePaths) {
      if (p === path || p.startsWith(path + '/')) return true;
    }
    return false;
  }

  // Orphan pages — only flag NON-parameter, non-/new routes that nothing references.
  // Parameter routes (/orders/:id) are excluded because navigate('/orders/'+id)
  // uses dynamic values our regex can't match.
  for (const r of routes) {
    if (AUTH_PATHS.has(r.path) || r.path === '/') continue;
    if (r.path.includes('/:') || r.path.endsWith('/new')) continue;
    if (!isReachable(r.path)) {
      problems.push({
        category: 'orphan',
        title: `Orphan page: ${r.path}`,
        detail: `Route exists (component: ${r.component}) but nothing references it — no sidebar link, no navigate() call, no nav-config entry. Only reachable by typing the URL directly.`,
        file: 'src/App.tsx',
      });
    }
  }

  // Broken navigate() destinations (nav to path not in routes)
  // Only flag LITERAL string paths (not paths containing variable segments like /orders/some-uuid)
  // We detect dynamic paths by checking for UUID-like patterns or numeric IDs.
  const looksLiteral = (p) => !/[0-9a-f]{8}-|\/\d+$/.test(p);  // skip UUID/numeric paths
  const brokenSeen = new Set();
  for (const { file, dest } of navigateCalls) {
    if (!looksLiteral(dest)) continue;  // skip dynamic navigations
    const matched = routes.some(r => {
      if (r.path === dest) return true;
      // /orders/:id matches /orders/abc
      const pattern = r.path.replace(/:[\w]+/g, '[^/]+');
      try { return new RegExp('^' + pattern + '$').test(dest); } catch { return false; }
    });
    if (!matched) {
      const key = dest;
      if (brokenSeen.has(key)) continue;
      brokenSeen.add(key);
      problems.push({
        category: 'broken-link',
        title: `Broken navigate(): "${dest}"`,
        detail: `No matching Route in App.tsx. Will redirect to / (catch-all).`,
        file,
      });
    }
  }

  // Dead RPCs (in docs but never called, excluding internal ones)
  const calledSet = new Set(rpcCalls);
  for (const rpc of docRpcs) {
    if (!calledSet.has(rpc) && !INTERNAL_RPCS.has(rpc)) {
      problems.push({
        category: 'dead-rpc',
        title: `Dead RPC: ${rpc}()`,
        detail: 'Listed in docs/reference/rpc-functions.md but never called from any src/ file.',
        file: 'docs/reference/rpc-functions.md',
      });
    }
  }

  // Unguarded writes — a direct .insert/.update/.delete is FINE per Architecture
  // Rule #3 when wrapped in checkMutationResult(). We only flag writes in files
  // that NEVER use checkMutationResult AND target a financially-sensitive table.
  // (Plain direct writes that ARE guarded are the endorsed pattern — not a bug.)
  const SENSITIVE_TABLES = new Set([
    'invoices', 'invoice_items', 'payments', 'commissions', 'commission_payments',
    'financial_audit_log', 'orders', 'order_items', 'prepay_credits', 'prepay_applications',
    'write_offs', 'finance_charges', 'returns', 'return_items',
  ]);
  const writeSeen = new Set();
  for (const { table, op, file, guarded } of directWrites) {
    if (guarded) continue;                       // file uses checkMutationResult — endorsed pattern
    if (!SENSITIVE_TABLES.has(table)) continue;  // only care about money/financial tables
    const key = `${file}|${table}|${op}`;
    if (writeSeen.has(key)) continue;
    writeSeen.add(key);
    problems.push({
      category: 'unguarded-write',
      title: `Unguarded .${op}() on "${table}"`,
      detail: 'Direct write to a financial table in a file that never calls checkMutationResult(). Review whether it needs result validation or an RPC.',
      file,
    });
  }

  return problems;
}

// ─────────────────────────────────────────────
// 11.  Render auto-detected problems as HTML
// ─────────────────────────────────────────────
function renderAutoProblems(problems) {
  const byCategory = {
    orphan: [],
    'broken-link': [],
    'dead-rpc': [],
    'unguarded-write': [],
  };
  for (const p of problems) {
    (byCategory[p.category] || []).push(p);
  }

  let html = '';
  const sections = [
    { key: 'orphan', title: 'Auto-detected Orphan Pages (no inbound navigation)', cls: '' },
    { key: 'broken-link', title: 'Auto-detected Broken navigate() Destinations', cls: '' },
    { key: 'dead-rpc', title: 'Auto-detected Dead RPCs (in docs, never called from src)', cls: 'warn' },
    { key: 'unguarded-write', title: 'Auto-detected Unguarded Writes to Financial Tables', cls: 'warn' },
  ];

  if (problems.length === 0) {
    return '\n      <div class="prob-section">\n        <h3>Auto-detected Problems</h3>\n        <div class="prob-item info"><strong>None found</strong><p>No orphan pages, broken links, dead RPCs, or unguarded financial-table writes detected in the current codebase.</p></div>\n      </div>';
  }

  for (const { key, title, cls } of sections) {
    const items = byCategory[key];
    if (!items || items.length === 0) continue;
    html += `\n      <div class="prob-section">\n        <h3>${escHtml(title)} (${items.length} found)</h3>\n`;
    for (const p of items) {
      html += `        <div class="prob-item ${cls}">\n`;
      html += `          <strong>${escHtml(p.title)}</strong>\n`;
      html += `          <p>${escHtml(p.detail)}</p>\n`;
      html += `          <span class="loc">${escHtml(p.file)}</span>\n`;
      html += `        </div>\n`;
    }
    html += `      </div>`;
  }

  return html;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─────────────────────────────────────────────
// 12.  Patch the HTML file in-place
// ─────────────────────────────────────────────
function patch(html, startMarker, endMarker, newContent) {
  const s = html.indexOf(startMarker);
  const e = html.indexOf(endMarker);
  if (s === -1 || e === -1) {
    console.warn(`  ⚠  Marker not found: "${startMarker}" — skipping that section`);
    return html;
  }
  return html.slice(0, s + startMarker.length) + newContent + html.slice(e);
}

function validateQuoteLifecycleCoverage(html) {
  const typeSource = read('src/types/index.ts');
  const typeMatch = /export\s+type\s+QuoteStatus\s*=\s*([^;]+);/.exec(typeSource);
  if (!typeMatch) throw new Error('Could not parse QuoteStatus from src/types/index.ts');

  const expected = [...typeMatch[1].matchAll(/'([a-z][a-z0-9_]*)'/g)].map((m) => m[1]);
  if (expected.length === 0) throw new Error('QuoteStatus contained no string literals');

  const quoteMatch = /<!-- QUOTE -->([\s\S]*?)<!-- ORDER -->/.exec(html);
  if (!quoteMatch) throw new Error('Could not isolate the Quote Lifecycle SVG');

  const rendered = new Set(
    [...quoteMatch[1].matchAll(/<g\b[^>]*>((?:(?!<\/g>)[\s\S])*?)<\/g>/g)]
      .map((groupMatch) => /<text\b[^>]*>\s*([a-z][a-z0-9_]*)\s*<\/text>/.exec(groupMatch[1])?.[1])
      .filter((status) => status !== undefined)
  );
  const missing = expected.filter((status) => !rendered.has(status));
  const unexpected = [...rendered].filter((status) => !expected.includes(status));
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Quote Lifecycle SVG status nodes differ from QuoteStatus; missing: ${missing.join(', ') || 'none'}; unexpected: ${unexpected.join(', ') || 'none'}`
    );
  }
}

// ─────────────────────────────────────────────
// 13.  Main
// ─────────────────────────────────────────────
function main() {
  console.log('🗺  Generating workflow map…');

  const routes         = parseRoutes();
  const navLinks       = parseNavLinks();
  const navigateCalls  = parseNavigateCalls();
  const reachablePaths = parseReachablePaths();
  const { byFile: rpcByFile, allCalled: rpcCalled } = parseRpcCalls();
  const directWrites   = parseDirectWrites();
  const docRpcs        = parseDocRpcs();

  console.log(`   Found ${routes.length} routes, ${navLinks.length} nav links, ${[...rpcCalled].length} distinct RPC calls`);

  const { nodes, edges } = buildGraphData(routes, navLinks, navigateCalls, rpcByFile, docRpcs, reachablePaths);
  const problems = computeProblems(routes, navLinks, navigateCalls, [...rpcCalled], docRpcs, directWrites, reachablePaths);

  console.log(`   Graph: ${nodes.length} nodes, ${edges.length} edges`);
  console.log(`   Auto-detected problems: ${problems.length}`);

  // Read current HTML
  let html;
  try { html = readFileSync(HTML_OUT, 'utf8'); }
  catch { console.error(`❌ Cannot read ${HTML_OUT} — run initial generation first`); process.exit(1); }

  const now = new Date().toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });

  // Patch stats line
  html = patch(html,
    '<!-- __STATS_START__ -->',
    '<!-- __STATS_END__ -->',
    `\n  <span id="stat-line" style="color:var(--muted);font-size:.8rem">${routes.length} routes · ${[...rpcCalled].length} RPC calls · ${problems.length} issues · Updated ${now}</span>\n  `
  );

  // Patch nodes array
  const nodesJson = JSON.stringify(nodes, null, 2)
    .replace(/^/gm, '  ')   // indent by 2
    .trimStart();
  html = patch(html,
    '// __NODES_START__',
    '// __NODES_END__',
    `\nconst NODES = ${nodesJson};\n`
  );

  // Patch edges array (only nav + rpc; data-flow are embedded in DATA_FLOW_EDGES inside NODES section)
  const navRpcEdges = edges.filter(e => e.type === 'nav' || e.type === 'rpc');
  const allEdgesJson = JSON.stringify(edges, null, 2)
    .replace(/^/gm, '  ')
    .trimStart();
  html = patch(html,
    '// __EDGES_START__',
    '// __EDGES_END__',
    `\nconst EDGES = ${allEdgesJson};\n`
  );

  // Patch problem count badge
  const totalProblems = problems.length;
  html = html.replace(/<span id="prob-count"[^>]*>[^<]*<\/span>/,
    `<span id="prob-count" style="background:#ef4444;color:#fff;border-radius:10px;padding:0 6px;font-size:.7rem;margin-left:4px">${totalProblems}</span>`
  );

  // Patch auto-detected problems section
  html = patch(html,
    '<!-- __AUTO_PROBLEMS_START__ -->',
    '<!-- __AUTO_PROBLEMS_END__ -->',
    renderAutoProblems(problems)
  );

  validateQuoteLifecycleCoverage(html);

  writeFileSync(HTML_OUT, html, 'utf8');
  console.log(`✅ docs/app-workflow-map.html updated (${(html.length / 1024).toFixed(0)} KB)`);
}

main();
