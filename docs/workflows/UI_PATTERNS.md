# UI Patterns

Reference for how the CRX Manager frontend is built. Follow these patterns for consistency.

---

## Adding a New Page

Follow `.claude/skills/new-page/SKILL.md` — it is the maintained step-by-step source. In short:

1. **Create the page component** in `src/pages/` as a `default` export (required for lazy loading).
2. **Add the lazy import** in `src/App.tsx`:
   ```typescript
   const MyNewPage = lazy(() => import('./pages/MyNewPage'));
   ```
3. **Add a route object** to the `RouteShell` children array in `src/App.tsx`. The app uses
   `createBrowserRouter` route objects, not `<Route>` JSX, and suspense is centralized in
   `RouteShell` (do not add a per-route `<Suspense>`). Paths there are relative:
   ```tsx
   { path: 'my-new-page', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><MyNewPage /></ProtectedRoute> },
   ```
4. **Add the `PAGE_PERMISSIONS` entry (REQUIRED)** in `src/lib/pagePermissions.ts`. Without it
   `ProtectedRoute` redirects users away and `pagePermissions.test.ts` fails.
5. **Add the sidebar link** in `src/components/layout/Sidebar.tsx`, in the right role tree
   (`officeNavigation`, `applicatorNavigation`, or `driverNavigation`).
6. **Document it** in `docs/reference/pages-routes.md`, then open the page and verify it.

---

## Existing Pages

Before creating a new page, check that it doesn't already exist: `docs/reference/pages-routes.md`
lists every route and page, and `src/pages/` is the ground truth.

---

## Data Fetching Pattern

CRX Manager uses `useState` + `useEffect` for data fetching (not React Query or SWR).

### Reading data
```typescript
const [customers, setCustomers] = useState<Customer[]>([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  async function loadCustomers() {
    // Name the columns you need; avoid select('*') + `as` casts (untyped DB access).
    const { data, error } = await supabase
      .from('customers')
      .select('id, farm_name, assigned_tier')
      .order('farm_name');

    if (error) {
      // Lint forbids console.error; report through Sentry (src/lib/sentry) and a toast.
      Sentry.captureException(error, { tags: { source: 'fetch', action: 'load_customers' } });
      toast('error', 'Failed to load customers');
    } else {
      setCustomers(data || []);
    }
    setLoading(false);
  }
  loadCustomers();
}, []);
```

### Writing data (always use checkMutationResult)
```typescript
async function updateCustomer(id: string, updates: Partial<Customer>) {
  const result = await supabase
    .from('customers')
    .update(updates)
    .eq('id', id)
    .select();

  checkMutationResult(result, 'Update customer');

  // Log the activity (object param — NOT positional args)
  await logActivity({
    event: 'customer_updated',
    description: `Updated ${updates.farm_name}`,
    performedBy: currentUser.id,
    entityType: 'customer',
    entityId: id
  });
}
```

---

## Bulk Import Pattern (3-State Modal)

Used for importing data from CSV files. The pattern has 3 states:

### State 1: File Selection
- User selects a CSV file
- File is read client-side using `FileReader`

### State 2: Validation & Review
- Parse CSV rows
- Validate each row against business rules
- Show a preview table with valid/invalid indicators
- User can fix issues or proceed

### State 3: Results
- Process valid rows (insert into database)
- Show success/failure counts
- Display any errors

### Source files (examples)
- `src/components/products/BulkProductImport.tsx`
- `src/components/customers/BulkCustomerImport.tsx`

### Modal sizing
Use `size="large"` prop on the Modal component for bulk imports.

---

## Bulk Operations Pattern (Row Selection)

For pages with bulk actions (select rows -> perform action):

### Components used
1. `useRowSelection` hook — manages selected row IDs
2. `createCheckboxColumn` — adds a checkbox column to the table
3. `BulkActionBar` — shows action buttons, auto-hides when 0 selected
4. `BulkDeleteConfirmModal` — confirmation dialog for destructive bulk actions

### Smart export fallback
```typescript
// Exports selected rows if any are selected, otherwise exports all filtered rows
const rows = selected.size > 0 ? selectedRows : filtered;
```

### Pages using this pattern
Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets, Orders, Vehicles, Fields, Returns, ApplicationServices, plus the Receiving hub's `ReceivingLogPanel` and `JobMassEditModal` (check `grep -rl useRowSelection src` for the current list)

### Exceptions
- **Invoices and Deliveries** use hand-rolled `Set<string>` selection (pre-existing pattern, kept for stability)
- **InventoryPage** uses `EditableDataTable` (inline editing) — no checkbox column

---

## Styling Rules

### Tailwind CSS only
- No other CSS frameworks (no Bootstrap, no styled-components, no CSS modules)
- All styling uses Tailwind utility classes

### Brand color
- Primary green: `crx-green` (#28A26A)
- Use `bg-crx-green`, `text-crx-green`, `border-crx-green`, etc.

### Icons: Lucide React only
```typescript
import { Plus, Edit, Trash2, Search } from 'lucide-react';
```
- Do NOT install other icon packages (no Heroicons, no FontAwesome, no Material Icons)

### Common UI patterns
- Tables: use the shared DataTable/table components
- Modals: use the shared Modal component
- Forms: standard controlled inputs with `useState`
- Loading states: show a spinner or skeleton while `loading === true`
- Error states: show error message in red text

---

## Component Organization

```
src/
  components/
    ui/           # Shared UI components (Modal, DataTable, BulkActionBar, etc.)
    auth/         # Login, registration, auth guards
    layout/       # AppLayout, sidebar, header
    reports/      # ReportShell, LogbookReport
    deliveries/   # Delivery-specific components
    blendtickets/ # Blend ticket components
    customers/    # Customer-specific components (BulkCustomerImport, etc.)
    products/     # Product-specific components (BulkProductImport, etc.)
    ...           # Other domain folders as needed
  pages/          # Full page components (one per route)
  lib/            # Utility functions (db.ts, activityLogger.ts, idempotency.ts, PDF generators)
  hooks/          # Custom React hooks (useRowSelection, useRealtimeSubscription)
  contexts/       # React contexts (AuthContext)
  types/          # TypeScript interfaces (index.ts)
```

---

## Number Formats

| Entity | Format | Generated by |
|--------|--------|-------------|
| Invoice | `<PREFIX>-YYYY-NNNN` — `CS` chemical sale, `MC` misc charge, `CM` credit memo, `INV` field application and other types | `next_invoice_number(p_invoice_type)`, called inside the invoice-creating RPCs |
| Return | `RMA-YYYY-NNNN` | `next_return_number()`, called inside the `create_return` RPC |
| Rebate claim | `RC-YYYY-NNNN` | Per-year counter row inside the `create_rebate_claim()` RPC |
| Cycle count | `CC-YYYY-NNNNN` (5 digits) | `next_cycle_count_number()` RPC |
| PO | `PO-YYYY-NNNN` | `next_po_number()` RPC |
| Job | `JOB-YYYY-NNNN` | `next_job_number()` RPC |
| Application record | `APP-YYYY-NNNN` | `next_application_record_number()` RPC |
| Commission payment | `CP-YYYY-NNNN` | `next_commission_payment_number()` RPC |
| Delivery | `DEL-NNNNN` (no year, 5 digits) | `next_delivery_number()` RPC |

---

## PDF Generation

All PDF generation is client-side using `jspdf` and `jspdf-autotable`:

| PDF | Source file | Notes |
|-----|-----------|-------|
| Invoice | `src/lib/invoicePdf.ts` | 3 layouts |
| Statement | `src/lib/statementPdf.ts` | Dual-mode |
| Year-end summary | `src/lib/yearEndSummaryPdf.ts` | |
| Delivery | `src/lib/deliveryPdf.ts` | Batch support, partial delivery highlighting |
| Receiving | `src/lib/receivingPdf.ts` | CRX green header, condition color-coding |

---

## Realtime Subscriptions

For tables that need live updates:

```typescript
useRealtimeSubscription({
  table: 'team_notes',
  event: '*',
  filter: undefined,
  onInsert: (payload) => { /* handle new row */ },
  onUpdate: (payload) => { /* handle changed row */ },
  onDelete: (payload) => { /* handle removed row */ },
});
```

Currently used for: `team_notes`, `team_note_comments`, `notifications`, `note_activity_log`

---

## Tab-Based Page Layout

Some pages use tabs to organize content:

| Page | Tabs |
|------|------|
| ARaging | 3 tabs |
| Compliance | 2 tabs |
| Rebates | 2 tabs |
| InventoryPage | Multiple tabs |
| BlendRecipes | Multiple tabs |

Use the same tab component pattern when adding tabs to new pages.
