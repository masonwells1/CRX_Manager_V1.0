# UI Patterns

Reference for how the CRX Manager frontend is built. Follow these patterns for consistency.

---

## Adding a New Page (4-Step Checklist)

### Step 1: Create the page component
Create a new file in `src/pages/`:
```typescript
// src/pages/MyNewPage.tsx
import { useState, useEffect } from 'react';
import { supabase, checkMutationResult } from '../lib/db';

export default function MyNewPage() {
  // ... component code
}
```

### Step 2: Add lazy import in App.tsx
```typescript
// src/App.tsx — add near the top with other lazy imports
const MyNewPage = lazy(() => import('./pages/MyNewPage'));
```

### Step 3: Add the Route
```typescript
// src/App.tsx — add inside the protected route block
<Route path="/my-new-page" element={<MyNewPage />} />
```

### Step 4: Add sidebar link
```typescript
// src/components/layout/AppLayout.tsx — add to the navigation array
{ path: '/my-new-page', label: 'My New Page', icon: SomeIcon }
```

**Important:** All pages are lazy-loaded using `React.lazy()` and wrapped in `<Suspense>`. This is mandatory.

---

## Existing Pages (56 total)

Before creating a new page, check that it doesn't already exist. Here are all current pages grouped by area:

### Core
Dashboard, Products, ProductDetail, Customers, CustomerDetail

### Quoting & Orders
Quotes, QuoteBuilder (new + edit), Orders, NewOrder, OrderDetail

### Delivery
Deliveries (includes driver dashboard), NewDelivery, DeliveryDetail, DeliveryRemainders

### Inventory & Receiving
InventoryPage, PurchaseOrders, NewPurchaseOrder, PurchaseOrderDetail, ReceivingLog, QuickReceive, CycleCounts

### Jobs & Application
Jobs, JobDetail, ApplicationRecords, BlendTickets, BlendTicketDetail, BlendRecipes

### Financial
Invoices, InvoiceDetail, Payments, PaymentAllocation, PaymentHistory, ARaging, MonthEndClose, CommissionPayments, CustomerTransactionReview, PrepaymentManager, PrepayWorkspace, FinancialDashboard, SalesReports

### Accounts Payable
AccountsPayable (AP Dashboard), VendorBills, NewVendorBill, VendorBillDetail

### Fields & Compliance
Fields, FieldDetail, Compliance, Rebates

### Other
BrandVsGeneric, CropPrograms, Vehicles, VehicleDetail, Returns, Reports, TeamBoard, Notifications, SettingsPage

---

## Data Fetching Pattern

CRX Manager uses `useState` + `useEffect` for data fetching (not React Query or SWR).

### Reading data
```typescript
const [customers, setCustomers] = useState<Customer[]>([]);
const [loading, setLoading] = useState(true);

useEffect(() => {
  async function loadCustomers() {
    const { data, error } = await supabase
      .from('customers')
      .select('*')
      .is('deleted_at', null)
      .order('farm_name');

    if (error) {
      console.error('Failed to load customers:', error);
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

  // Log the activity
  logActivity(
    'customer_updated',
    `Updated ${updates.farm_name}`,
    currentUser.id,
    'customer',
    id
  );
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
Products, Customers, Jobs, Quotes, PurchaseOrders, BlendTickets, Orders, Vehicles, Fields, Returns, ReceivingLog

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
| Invoice | `INV-YYYY-NNNN` | Count query |
| Return | `RMA-YYYY-NNNN` | Count query |
| Rebate claim | `RC-YYYY-NNNN` | Count query |
| Cycle count | `CC-YYYY-NNNN` | Count query |
| PO | `PO-YYYY-NNNN` | `next_po_number()` RPC |
| Job | `JOB-YYYY-NNNN` | `next_job_number()` RPC |
| Application record | `APP-YYYY-NNNN` | `next_application_record_number()` RPC |
| Commission payment | `CP-YYYY-NNNN` | `next_commission_payment_number()` RPC |
| Delivery | `DEL-YYYY-NNNN` | `next_delivery_number()` RPC |

---

## PDF Generation

All PDF generation is client-side using `jspdf` and `jspdf-autotable`:

| PDF | Source file | Notes |
|-----|-----------|-------|
| Invoice | `src/lib/invoicePdf.ts` | 3 layouts (756 lines) |
| Statement | `src/lib/statementPdf.ts` | Dual-mode (818 lines) |
| Year-end summary | `src/lib/yearEndSummaryPdf.ts` | (633 lines) |
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
