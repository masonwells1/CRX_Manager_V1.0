# Inventory & Delivery Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build 5 features that improve daily warehouse and inventory operations — load sheet PDFs for drivers, an inventory transaction ledger, reorder alerts, batch inventory adjustments, and inventory valuation display.

**Architecture:** All features are client-side additions to existing pages. No new database tables or migrations needed. Load Sheet uses a new PDF generator (following `deliveryPdf.ts` pattern). Transaction Ledger and Batch Adjust are new modals on the Inventory page. Reorder Alerts and Inventory Valuation enhance the existing Inventory page.

**Tech Stack:** React + TypeScript, Supabase client, jsPDF + jspdf-autotable (dynamic imports), Vitest for tests

---

## Parallel Execution Guide

**Phase 1** (3 independent tasks — can run in parallel):
- Task 1: Load Sheet / Pick List PDF
- Task 2: Inventory Transaction Ledger Modal
- Task 3: Reorder Alerts (banner + filter chip)

**Phase 2** (2 independent tasks — can run in parallel, but depend on Phase 1 Task 3's `vendor`/`current_cost` query changes):
- Task 4: Batch Inventory Adjustments
- Task 5: Inventory Valuation Display

---

## Reference Files (read before starting any task)

| Purpose | File |
|---------|------|
| Code patterns | `docs/reference/code-patterns.md` |
| Safe dev rules | `docs/workflows/SAFE_DEVELOPMENT_RULES.md` |
| DB schema | `docs/reference/database-schema.md` |
| Existing PDF pattern | `src/lib/deliveryPdf.ts` |
| Modal component | `src/components/ui/Modal.tsx` |
| Inventory page | `src/pages/InventoryPage.tsx` |
| Deliveries page | `src/pages/Deliveries.tsx` |
| Activity logger | `src/lib/activityLogger.ts` |
| Idempotency keys | `src/lib/idempotency.ts` |

---

## Task 1: Load Sheet / Pick List PDF

**Goal:** A printable PDF that warehouse/drivers can print showing everything to load for a set of deliveries. Product summary at top (aggregate all quantities by product), then per-stop breakdown grouped by delivery.

**Files:**
- Create: `src/lib/loadSheetPdf.ts`
- Create: `src/lib/loadSheetPdf.test.ts`
- Modify: `src/pages/Deliveries.tsx` (add "Print Load Sheet" button)

### Step 1: Write the test file for loadSheetPdf

Create `src/lib/loadSheetPdf.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock jsPDF and autoTable
const mockSave = vi.fn();
const mockText = vi.fn();
const mockSetFontSize = vi.fn();
const mockSetFont = vi.fn();
const mockSetTextColor = vi.fn();
const mockSetFillColor = vi.fn();
const mockSetDrawColor = vi.fn();
const mockRect = vi.fn();
const mockLine = vi.fn();
const mockGetTextWidth = vi.fn().mockReturnValue(50);
const mockInternal = { pageSize: { getWidth: () => 595.28, getHeight: () => 841.89 } };
const mockAutoTable = vi.fn();

vi.mock('jspdf', () => ({
  default: vi.fn().mockImplementation(() => ({
    save: mockSave,
    text: mockText,
    setFontSize: mockSetFontSize,
    setFont: mockSetFont,
    setTextColor: mockSetTextColor,
    setFillColor: mockSetFillColor,
    setDrawColor: mockSetDrawColor,
    rect: mockRect,
    line: mockLine,
    getTextWidth: mockGetTextWidth,
    internal: mockInternal,
    lastAutoTable: { finalY: 100 },
    addPage: vi.fn(),
  })),
}));

vi.mock('jspdf-autotable', () => ({
  default: vi.fn().mockImplementation((...args: unknown[]) => mockAutoTable(...args)),
}));

import { generateLoadSheetPdf, type LoadSheetStop } from './loadSheetPdf';

beforeEach(() => {
  vi.clearAllMocks();
});

const makeStop = (overrides?: Partial<LoadSheetStop>): LoadSheetStop => ({
  delivery_number: 'DEL-2026-0001',
  customer_name: 'Smith Farm',
  customer_address: '123 Rural Rd',
  driver_name: 'John',
  scheduled_date: '2026-03-01',
  priority: 'normal',
  items: [
    { product_name: 'Roundup PowerMax', quantity: 10, unit_size: '2.5 Gal', tote_number: 'T-100' },
    { product_name: 'Atrazine 4L', quantity: 5, unit_size: '2.5 Gal' },
  ],
  ...overrides,
});

describe('generateLoadSheetPdf', () => {
  it('calls jsPDF save with correct filename', async () => {
    await generateLoadSheetPdf([makeStop()]);
    expect(mockSave).toHaveBeenCalledWith(expect.stringContaining('load_sheet_'));
  });

  it('creates product summary table (autoTable call #1)', async () => {
    await generateLoadSheetPdf([makeStop()]);
    // First autoTable call is the product summary
    expect(mockAutoTable).toHaveBeenCalled();
    const firstCallArgs = mockAutoTable.mock.calls[0];
    const doc = firstCallArgs[0];
    const opts = firstCallArgs[1];
    // Should aggregate products: Roundup 10, Atrazine 5
    expect(opts.body).toHaveLength(2);
  });

  it('aggregates quantities across multiple stops for same product', async () => {
    const stop1 = makeStop({ delivery_number: 'DEL-2026-0001' });
    const stop2 = makeStop({
      delivery_number: 'DEL-2026-0002',
      customer_name: 'Jones Farm',
      items: [
        { product_name: 'Roundup PowerMax', quantity: 15, unit_size: '2.5 Gal' },
      ],
    });
    await generateLoadSheetPdf([stop1, stop2]);
    const firstCallOpts = mockAutoTable.mock.calls[0][1];
    // Roundup should be 10 + 15 = 25, Atrazine should be 5
    const roundupRow = firstCallOpts.body.find((r: string[]) => r[0] === 'Roundup PowerMax');
    expect(roundupRow).toBeTruthy();
    expect(Number(roundupRow[1])).toBe(25);
  });

  it('creates one per-stop table per delivery', async () => {
    const stops = [
      makeStop({ delivery_number: 'DEL-2026-0001' }),
      makeStop({ delivery_number: 'DEL-2026-0002', customer_name: 'Jones Farm' }),
    ];
    await generateLoadSheetPdf(stops);
    // autoTable calls: 1 (summary) + 2 (per-stop) = 3
    expect(mockAutoTable).toHaveBeenCalledTimes(3);
  });

  it('accepts custom filename', async () => {
    await generateLoadSheetPdf([makeStop()], 'my_sheet.pdf');
    expect(mockSave).toHaveBeenCalledWith('my_sheet.pdf');
  });

  it('throws on empty stops array', async () => {
    await expect(generateLoadSheetPdf([])).rejects.toThrow('No stops');
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/lib/loadSheetPdf.test.ts
```
Expected: FAIL — `./loadSheetPdf` module not found

### Step 3: Implement loadSheetPdf.ts

Create `src/lib/loadSheetPdf.ts`:

```typescript
/**
 * Load Sheet / Pick List PDF generator.
 *
 * Produces a printable PDF with:
 *   1. Product Summary — all products aggregated across stops
 *   2. Per-Stop Breakdown — items for each delivery/customer
 *
 * Follows the same dynamic-import + color-scheme pattern as deliveryPdf.ts.
 */

export interface LoadSheetItem {
  product_name: string;
  quantity: number;
  unit_size: string;
  tote_number?: string | null;
}

export interface LoadSheetStop {
  delivery_number: string;
  customer_name: string;
  customer_address?: string;
  driver_name: string;
  scheduled_date: string;
  priority?: string;
  items: LoadSheetItem[];
}

// CRX brand colors (RGB)
const CRX_GREEN: [number, number, number] = [40, 162, 106];
const CHARCOAL: [number, number, number] = [46, 46, 46];
const GRAY: [number, number, number] = [78, 78, 78];

export async function generateLoadSheetPdf(
  stops: LoadSheetStop[],
  filename?: string,
): Promise<void> {
  if (stops.length === 0) throw new Error('No stops provided for load sheet');

  const { default: jsPDF } = await import('jspdf');
  const { default: autoTable } = await import('jspdf-autotable');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'letter' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 40;
  let y = margin;

  // ── Header ──
  doc.setFillColor(...CRX_GREEN);
  doc.rect(0, 0, pageWidth, 50, 'F');
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(255, 255, 255);
  doc.text('LOAD SHEET', margin, 33);

  // Date + driver info on right
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  const dateStr = stops[0].scheduled_date
    ? new Date(stops[0].scheduled_date + 'T00:00:00').toLocaleDateString()
    : 'N/A';
  const drivers = [...new Set(stops.map((s) => s.driver_name).filter(Boolean))];
  const driverStr = drivers.length > 0 ? drivers.join(', ') : 'Unassigned';
  doc.text(`Date: ${dateStr}  |  Driver: ${driverStr}`, pageWidth - margin, 25, { align: 'right' });
  doc.text(`${stops.length} stop(s)`, pageWidth - margin, 40, { align: 'right' });

  y = 70;

  // ── Section 1: Product Summary ──
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Product Summary — Total to Load', margin, y);
  y += 8;

  // Aggregate products across all stops
  const productMap = new Map<string, { quantity: number; unit_size: string }>();
  for (const stop of stops) {
    for (const item of stop.items) {
      const existing = productMap.get(item.product_name);
      if (existing) {
        existing.quantity += item.quantity;
      } else {
        productMap.set(item.product_name, { quantity: item.quantity, unit_size: item.unit_size });
      }
    }
  }

  const summaryBody = [...productMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, data]) => [name, String(data.quantity), data.unit_size]);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Product', 'Total Qty', 'Unit']],
    body: summaryBody,
    theme: 'grid',
    headStyles: {
      fillColor: CRX_GREEN,
      textColor: [255, 255, 255],
      fontStyle: 'bold',
      fontSize: 10,
    },
    bodyStyles: { fontSize: 10, textColor: CHARCOAL },
    alternateRowStyles: { fillColor: [245, 245, 245] },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { halign: 'right', cellWidth: 60 },
      2: { cellWidth: 80 },
    },
  });

  y = (doc as unknown as Record<string, unknown> & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 20;

  // ── Section 2: Per-Stop Breakdown ──
  doc.setTextColor(...CHARCOAL);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Per-Stop Breakdown', margin, y);
  y += 5;

  for (let i = 0; i < stops.length; i++) {
    const stop = stops[i];

    // Check if we need a new page (if < 120pt remaining)
    if (y > doc.internal.pageSize.getHeight() - 120) {
      doc.addPage();
      y = margin;
    }

    // Stop header
    y += 12;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...CHARCOAL);
    doc.text(`Stop ${i + 1}: ${stop.customer_name}`, margin, y);
    y += 14;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...GRAY);
    const meta = [
      stop.delivery_number,
      stop.customer_address,
      stop.priority && stop.priority !== 'normal' ? `Priority: ${stop.priority.toUpperCase()}` : null,
    ].filter(Boolean).join('  |  ');
    doc.text(meta, margin, y);
    y += 4;

    // Items table for this stop
    const hasTotes = stop.items.some((it) => it.tote_number);
    const headRow = hasTotes
      ? ['Product', 'Qty', 'Unit', 'Tote #']
      : ['Product', 'Qty', 'Unit'];
    const bodyRows = stop.items.map((it) =>
      hasTotes
        ? [it.product_name, String(it.quantity), it.unit_size, it.tote_number || '-']
        : [it.product_name, String(it.quantity), it.unit_size]
    );

    autoTable(doc, {
      startY: y,
      margin: { left: margin + 10, right: margin },
      head: [headRow],
      body: bodyRows,
      theme: 'striped',
      headStyles: {
        fillColor: [220, 220, 220],
        textColor: CHARCOAL,
        fontStyle: 'bold',
        fontSize: 9,
      },
      bodyStyles: { fontSize: 9, textColor: CHARCOAL },
      columnStyles: {
        1: { halign: 'right', cellWidth: 50 },
        2: { cellWidth: 70 },
        ...(hasTotes ? { 3: { cellWidth: 70 } } : {}),
      },
    });

    y = (doc as unknown as Record<string, unknown> & { lastAutoTable: { finalY: number } }).lastAutoTable.finalY + 8;
  }

  // ── Footer ──
  const footerY = doc.internal.pageSize.getHeight() - 30;
  doc.setDrawColor(200, 200, 200);
  doc.line(margin, footerY, pageWidth - margin, footerY);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(...GRAY);
  doc.text(
    `Generated ${new Date().toLocaleString()} — Crop Rx Solutions`,
    margin,
    footerY + 12,
  );

  const outFilename = filename || `load_sheet_${dateStr.replace(/\//g, '-')}.pdf`;
  doc.save(outFilename);
}
```

### Step 4: Run tests to verify they pass

```bash
npx vitest run src/lib/loadSheetPdf.test.ts
```
Expected: All 6 tests PASS

### Step 5: Commit

```bash
git add src/lib/loadSheetPdf.ts src/lib/loadSheetPdf.test.ts
git commit -m "feat: add load sheet / pick list PDF generator

Generates printable load sheets with product summary (aggregated across
all stops) and per-stop breakdown. Uses same jsPDF pattern as deliveryPdf.ts."
```

### Step 6: Add "Print Load Sheet" button to Deliveries page

Modify `src/pages/Deliveries.tsx`:

**6a.** Add import at top (after existing imports around line 29):
```typescript
import { generateLoadSheetPdf } from '../lib/loadSheetPdf';
```

**6b.** Add state variable (after line 99 `printing` state):
```typescript
const [printingLoadSheet, setPrintingLoadSheet] = useState(false);
```

**6c.** Add handler function (after `handleBatchPrint` function, around line 376):
```typescript
const handlePrintLoadSheet = async () => {
  setPrintingLoadSheet(true);
  try {
    // Use selected deliveries, or all filtered scheduled/in_progress for today
    const rows = selected.size > 0
      ? selectedDeliveries
      : filtered.filter((d) => d.status === 'scheduled' || d.status === 'in_progress');

    if (rows.length === 0) {
      toast('error', 'No deliveries to include in load sheet');
      setPrintingLoadSheet(false);
      return;
    }

    // Fetch items for each delivery
    const stops = [];
    for (const del of rows) {
      const { data: items } = await supabase
        .from('delivery_items')
        .select('*, product:products(product_name)')
        .eq('delivery_id', del.id)
        .order('sort_order');

      const delAny = del as unknown as Record<string, unknown>;
      stops.push({
        delivery_number: del.delivery_number,
        customer_name: del.customer_name,
        customer_address: (delAny.delivery_address as string) || undefined,
        driver_name: del.driver_name,
        scheduled_date: del.scheduled_date,
        priority: del.priority || 'normal',
        items: ((items || []) as Array<Record<string, unknown> & { product?: { product_name?: string } }>).map((it) => ({
          product_name: it.product?.product_name || (it.product_name as string) || 'Unknown',
          quantity: it.quantity as number,
          unit_size: (it.unit_size as string) || '-',
          tote_number: (it.tote_number as string) || undefined,
        })),
      });
    }

    await generateLoadSheetPdf(stops);
    toast('success', `Load sheet generated for ${stops.length} stop(s)`);
  } catch (err: unknown) {
    console.error('Load sheet failed:', err);
    toast('error', sanitizeError(err));
  }
  setPrintingLoadSheet(false);
};
```

**6d.** Add button in the header actions area (after the "Download PDF" button, around line 722). Add it BEFORE the `{selected.size > 0 && (` block:
```tsx
<Button
  variant="secondary"
  size="sm"
  icon={<FileText className="w-4 h-4" />}
  onClick={handlePrintLoadSheet}
  loading={printingLoadSheet}
>
  {selected.size > 0 ? `Load Sheet (${selected.size})` : 'Load Sheet'}
</Button>
```

### Step 7: Run the app and test manually

```bash
npm run dev
```
Navigate to Deliveries → click "Load Sheet" → verify PDF downloads with product summary + per-stop breakdown.

### Step 8: Commit

```bash
git add src/pages/Deliveries.tsx
git commit -m "feat: add Load Sheet button to Deliveries page

Prints a pick list PDF with product summary and per-stop breakdown.
Works with batch selection or defaults to all scheduled/in-progress deliveries."
```

---

## Task 2: Inventory Transaction Ledger Modal

**Goal:** Click a product on the Inventory page → modal shows full transaction history (received, adjusted, delivered, etc.) in chronological order with a running balance.

**Files:**
- Create: `src/components/inventory/TransactionLedgerModal.tsx`
- Create: `src/components/inventory/TransactionLedgerModal.test.ts`
- Modify: `src/pages/InventoryPage.tsx` (add trigger + import)

### Step 1: Write the test file

Create `src/components/inventory/TransactionLedgerModal.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSelect = vi.fn();
const mockEq = vi.fn();
const mockOrder = vi.fn();

const mockFrom = vi.fn().mockReturnValue({
  select: mockSelect.mockReturnValue({
    eq: mockEq.mockReturnValue({
      order: mockOrder.mockResolvedValue({
        data: [
          {
            id: '1',
            transaction_type: 'received',
            quantity: 100,
            notes: 'Initial stock',
            created_at: '2026-01-15T10:00:00Z',
            performed_by: 'user-1',
            order_id: null,
            purchase_order_id: 'po-1',
            delivery_id: null,
            from_location: null,
            to_location: 'Main Warehouse',
            performer: { full_name: 'Admin User' },
          },
          {
            id: '2',
            transaction_type: 'delivered',
            quantity: -25,
            notes: null,
            created_at: '2026-02-01T14:30:00Z',
            performed_by: 'user-2',
            order_id: 'order-1',
            purchase_order_id: null,
            delivery_id: 'del-1',
            from_location: null,
            to_location: null,
            performer: { full_name: 'Driver Bob' },
          },
        ],
        error: null,
      }),
    }),
  }),
});

vi.mock('../../lib/db', () => ({
  supabase: { from: (...args: unknown[]) => mockFrom(...args) },
  sanitizeError: (e: unknown) => String(e),
}));

import { computeRunningBalance } from './TransactionLedgerModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('computeRunningBalance', () => {
  it('computes cumulative balance from transactions', () => {
    const txns = [
      { quantity: 100 },
      { quantity: -25 },
      { quantity: 50 },
      { quantity: -10 },
    ];
    const balances = computeRunningBalance(txns as Array<{ quantity: number }>);
    expect(balances).toEqual([100, 75, 125, 115]);
  });

  it('returns empty array for no transactions', () => {
    expect(computeRunningBalance([])).toEqual([]);
  });

  it('handles negative starting balance', () => {
    const txns = [{ quantity: -5 }, { quantity: 10 }];
    expect(computeRunningBalance(txns as Array<{ quantity: number }>)).toEqual([-5, 5]);
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/components/inventory/TransactionLedgerModal.test.ts
```
Expected: FAIL — module not found

### Step 3: Implement TransactionLedgerModal.tsx

Create `src/components/inventory/TransactionLedgerModal.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, Truck, RefreshCw, ArrowRightLeft, Pencil } from 'lucide-react';
import Modal from '../ui/Modal';
import { supabase, sanitizeError } from '../../lib/db';

interface Transaction {
  id: string;
  transaction_type: string;
  quantity: number;
  notes: string | null;
  created_at: string;
  performed_by: string | null;
  order_id: string | null;
  purchase_order_id: string | null;
  delivery_id: string | null;
  from_location: string | null;
  to_location: string | null;
  performer: { full_name: string } | null;
}

interface Props {
  open: boolean;
  onClose: () => void;
  productId: string;
  productName: string;
}

const TYPE_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  received: { label: 'Received', color: 'text-crx-green', icon: ArrowDownToLine },
  delivered: { label: 'Delivered', color: 'text-blue-600', icon: Truck },
  adjusted: { label: 'Adjusted', color: 'text-amber-600', icon: Pencil },
  returned: { label: 'Returned', color: 'text-purple-600', icon: RefreshCw },
  transferred: { label: 'Transferred', color: 'text-teal-600', icon: ArrowRightLeft },
  booked: { label: 'Booked', color: 'text-gray-600', icon: ArrowUpFromLine },
};

/** Exported for testing */
export function computeRunningBalance(txns: Array<{ quantity: number }>): number[] {
  const balances: number[] = [];
  let running = 0;
  for (const t of txns) {
    running += t.quantity;
    balances.push(running);
  }
  return balances;
}

export default function TransactionLedgerModal({ open, onClose, productId, productName }: Props) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open || !productId) return;
    setLoading(true);
    setError('');

    supabase
      .from('inventory_transactions')
      .select('*, performer:profiles!inventory_transactions_performed_by_fkey(full_name)')
      .eq('product_id', productId)
      .order('created_at', { ascending: true })
      .then(({ data, error: err }) => {
        if (err) {
          setError(sanitizeError(err));
        } else {
          setTransactions((data || []) as Transaction[]);
        }
        setLoading(false);
      });
  }, [open, productId]);

  const balances = computeRunningBalance(transactions);

  return (
    <Modal open={open} onClose={onClose} title="Transaction" accent="Ledger" size="large">
      <p className="text-sm text-secondary mb-4">{productName}</p>

      {loading && <p className="text-sm text-secondary py-8 text-center">Loading transactions...</p>}
      {error && <p className="text-sm text-red-600 py-4">{error}</p>}

      {!loading && !error && transactions.length === 0 && (
        <p className="text-sm text-secondary py-8 text-center">No transactions found for this product.</p>
      )}

      {!loading && transactions.length > 0 && (
        <div className="max-h-[60vh] overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-white border-b">
              <tr className="text-left text-xs text-secondary">
                <th className="py-2 px-2">Date</th>
                <th className="py-2 px-2">Type</th>
                <th className="py-2 px-2 text-right">Qty</th>
                <th className="py-2 px-2 text-right">Balance</th>
                <th className="py-2 px-2">By</th>
                <th className="py-2 px-2">Notes</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t, i) => {
                const config = TYPE_CONFIG[t.transaction_type] || {
                  label: t.transaction_type,
                  color: 'text-gray-600',
                  icon: Pencil,
                };
                const Icon = config.icon;
                const isPositive = t.quantity > 0;

                return (
                  <tr key={t.id} className="border-b border-gray-100 hover:bg-gray-50">
                    <td className="py-2 px-2 text-xs text-secondary whitespace-nowrap">
                      {new Date(t.created_at).toLocaleDateString()}{' '}
                      <span className="text-gray-400">
                        {new Date(t.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </td>
                    <td className="py-2 px-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium ${config.color}`}>
                        <Icon className="w-3 h-3" />
                        {config.label}
                      </span>
                    </td>
                    <td className={`py-2 px-2 text-right font-mono font-medium ${isPositive ? 'text-crx-green' : 'text-red-600'}`}>
                      {isPositive ? '+' : ''}{t.quantity}
                    </td>
                    <td className="py-2 px-2 text-right font-mono text-nav-dark">
                      {balances[i]}
                    </td>
                    <td className="py-2 px-2 text-xs text-secondary truncate max-w-[120px]">
                      {t.performer?.full_name || '-'}
                    </td>
                    <td className="py-2 px-2 text-xs text-secondary truncate max-w-[180px]">
                      {t.notes || '-'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}
```

### Step 4: Run tests to verify they pass

```bash
npx vitest run src/components/inventory/TransactionLedgerModal.test.ts
```
Expected: All 3 tests PASS

### Step 5: Commit

```bash
git add src/components/inventory/TransactionLedgerModal.tsx src/components/inventory/TransactionLedgerModal.test.ts
git commit -m "feat: add inventory transaction ledger modal

Shows full chronological transaction history for a product with running
balance, type icons, performer names, and notes."
```

### Step 6: Wire up the modal on InventoryPage

Modify `src/pages/InventoryPage.tsx`:

**6a.** Add import (after existing imports, around line 16):
```typescript
import TransactionLedgerModal from '../components/inventory/TransactionLedgerModal';
```

**6b.** Add state variables (after `holdsExpanded` state, around line 76):
```typescript
const [ledgerOpen, setLedgerOpen] = useState(false);
const [ledgerProductId, setLedgerProductId] = useState('');
const [ledgerProductName, setLedgerProductName] = useState('');
```

**6c.** Add a "History" icon button to the table. Find the columns definition and add a new column at the end (or add a click handler to the product name). The simplest approach: add a new action column. Find where `columns` is defined (it will be an array of `EditableColumn<InventoryRow>`) and add:

```typescript
{
  key: '_actions',
  header: '',
  sortable: false,
  className: 'w-10',
  render: (row: InventoryRow) => (
    <button
      onClick={() => {
        setLedgerProductId(row.product_id);
        setLedgerProductName(row.product_name);
        setLedgerOpen(true);
      }}
      className="p-1 rounded hover:bg-gray-100 text-secondary hover:text-nav-dark transition-colors"
      title="View transaction history"
    >
      <FileText className="w-4 h-4" />
    </button>
  ),
},
```

Note: `FileText` is already imported at line 2.

**6d.** Add the modal component at the end of the JSX return (before the closing `</div>`):
```tsx
<TransactionLedgerModal
  open={ledgerOpen}
  onClose={() => setLedgerOpen(false)}
  productId={ledgerProductId}
  productName={ledgerProductName}
/>
```

### Step 7: Test manually

```bash
npm run dev
```
Navigate to Inventory → click the document icon on any product row → verify modal opens with transaction history.

### Step 8: Commit

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat: wire transaction ledger modal to inventory page

Adds a history icon on each inventory row that opens the transaction
ledger modal showing full product movement history."
```

---

## Task 3: Reorder Alerts — Enhanced Banner + Filter Chip

**Goal:** Make low-stock items impossible to miss. Group the existing low-stock section by vendor, add a prominent "ACTION REQUIRED" banner, and add a "Needs Reorder" filter chip that filters the main table to only low-stock items.

**Files:**
- Modify: `src/pages/InventoryPage.tsx` (enhance low-stock section, add filter chip, add vendor to query)
- No new files needed

### Step 1: Extend the inventory query to include vendor and current_cost

In `src/pages/InventoryPage.tsx`, modify the `fetchInventory` query (line 123) to also select `vendor` and `current_cost`:

Change:
```typescript
.select('*, product:products(product_name, inventory_unit, container_size, container_type)')
```
To:
```typescript
.select('*, product:products(product_name, inventory_unit, container_size, container_type, vendor, current_cost)')
```

### Step 2: Extend the InventoryRow interface

Add `vendor` and `current_cost` to the `InventoryRow` interface (around line 19):

```typescript
interface InventoryRow extends Inventory {
  product_name: string;
  inventory_unit: string | null;
  container_size: number | null;
  container_type: string | null;
  vendor: string | null;        // ← ADD
  current_cost: number | null;  // ← ADD
  total_on_floor: number;
  planned_qty: number;
  free_qty: number;
  delivered_ytd: number;
  reorder_point: number;
  min_stock_level: number;
  is_low_stock: boolean;
}
```

### Step 3: Thread vendor/cost through buildRow

In the `buildRow` function (around line 202), add `vendor` and `current_cost` to the parameter type and the returned object:

Add to parameter type:
```typescript
vendor?: string | null;
current_cost?: number | null;
```

Add to return object (inside the `return { ... } as InventoryRow`):
```typescript
vendor: item.vendor || null,
current_cost: item.current_cost || null,
```

In `existingRows` mapping (around line 239), add:
```typescript
vendor: item.product?.vendor || null,
current_cost: item.product?.current_cost || null,
```

In `virtualRows` mapping (around line 258), add:
```typescript
vendor: null,
current_cost: null,
```

### Step 4: Add "Needs Reorder" filter chip state

After the `locationFilter` state (around line 45), add:
```typescript
const [reorderFilter, setReorderFilter] = useState(false);
```

### Step 5: Apply the reorder filter to the filtered data

Find where `filtered` is computed (search for `useMemo` that filters by `locationFilter`). Add the reorder filter:

```typescript
// After location filtering:
if (reorderFilter) {
  result = result.filter((r) => r.is_low_stock);
}
```

### Step 6: Add the filter chip to the EditableDataTable filters prop

In the `filters` prop of `EditableDataTable` (around line 921), add the reorder chip next to the location dropdown:

```tsx
filters={
  <div className="flex gap-2 items-center flex-wrap">
    <select
      value={locationFilter}
      onChange={(e) => setLocationFilter(e.target.value)}
      aria-label="Filter by location"
      className="px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green"
    >
      <option value="">All Locations</option>
      {locations.map((l) => (
        <option key={l} value={l}>{l}</option>
      ))}
    </select>
    <button
      onClick={() => setReorderFilter(!reorderFilter)}
      className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
        reorderFilter
          ? 'bg-red-50 border-red-200 text-red-700 font-medium'
          : 'border-gray-200 text-secondary hover:border-red-200 hover:text-red-600'
      }`}
    >
      Needs Reorder
      {(() => {
        const count = inventory.filter((i) => i.is_low_stock).length;
        return count > 0 ? (
          <span className={`ml-1.5 px-1.5 py-0.5 text-xs rounded-full ${
            reorderFilter ? 'bg-red-200 text-red-800' : 'bg-red-100 text-red-600'
          }`}>
            {count}
          </span>
        ) : null;
      })()}
    </button>
  </div>
}
```

### Step 7: Enhance the low-stock alert section to group by vendor

Replace the existing low-stock alert section (lines 854-905) with a vendor-grouped version:

```tsx
{/* Enhanced Reorder Alerts — grouped by vendor */}
{(() => {
  const lowStockItems = inventory.filter((i) => i.is_low_stock);
  if (lowStockItems.length === 0) return null;

  // Group by vendor
  const byVendor = new Map<string, InventoryRow[]>();
  for (const item of lowStockItems) {
    const vendor = item.vendor || 'No Vendor';
    const group = byVendor.get(vendor) || [];
    group.push(item);
    byVendor.set(vendor, group);
  }
  const vendorGroups = [...byVendor.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-red-100 flex items-center justify-center">
          <AlertTriangle className="w-4 h-4 text-red-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-red-700">
            ACTION REQUIRED — {lowStockItems.length} Product{lowStockItems.length !== 1 ? 's' : ''} Need Reordering
          </h3>
          <p className="text-xs text-secondary">
            {vendorGroups.length} vendor{vendorGroups.length !== 1 ? 's' : ''} affected
          </p>
        </div>
      </div>

      {vendorGroups.map(([vendor, items]) => (
        <div key={vendor} className="mt-4">
          <p className="text-sm font-semibold text-nav-dark mb-2 border-b border-gray-200 pb-1">
            {vendor} ({items.length})
          </p>
          <div className="space-y-2">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center justify-between p-3 bg-red-50 border border-red-100 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-nav-dark truncate">{item.product_name}</p>
                  <p className="text-xs text-secondary">
                    {item.location || 'No location'} &middot; Unit: {item.inventory_unit || item.unit_size || '-'}
                  </p>
                </div>
                <div className="flex items-center gap-6 text-sm">
                  <div className="text-center">
                    <p className="text-xs text-secondary">Available</p>
                    <p className="font-semibold text-red-600">{item.quantity_available}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-secondary">Reorder Pt</p>
                    <p className="font-semibold text-nav-dark">{item.reorder_point}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-secondary">On Order</p>
                    <p className="font-semibold text-teal-600">{item.quantity_on_order}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-secondary">Shortfall</p>
                    <p className="font-semibold text-red-600">
                      {Math.max(0, item.reorder_point - item.quantity_available - item.quantity_on_order)}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
})()}
```

### Step 8: Run the app and verify

```bash
npm run dev
```
- Verify the low-stock section now says "ACTION REQUIRED" and groups by vendor
- Verify the "Needs Reorder" filter chip appears with a count badge
- Clicking the chip filters the main table to only low-stock items

### Step 9: Run existing tests to ensure nothing broke

```bash
npx vitest run
```
Expected: All existing tests pass

### Step 10: Commit

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat: enhanced reorder alerts with vendor grouping + filter chip

- ACTION REQUIRED banner with vendor-grouped low-stock items
- Needs Reorder filter chip with count badge on main table
- Added vendor and current_cost to inventory data query"
```

---

## Task 4: Batch Inventory Adjustments

**Goal:** Select multiple products on the Inventory page and adjust all their quantities at once (e.g., "+5 to all selected" or set a specific delta per row).

**Files:**
- Create: `src/components/inventory/BatchAdjustModal.tsx`
- Create: `src/components/inventory/BatchAdjustModal.test.ts`
- Modify: `src/pages/InventoryPage.tsx` (add selection + button)

### Step 1: Write the test file

Create `src/components/inventory/BatchAdjustModal.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockRpc = vi.fn().mockResolvedValue({ data: { status: 'adjusted', new_quantity: 10 }, error: null });

vi.mock('../../lib/db', () => ({
  supabase: { rpc: (...args: unknown[]) => mockRpc(...args) },
  sanitizeError: (e: unknown) => String(e),
}));

vi.mock('../../lib/idempotency', () => ({
  generateIdempotencyKey: vi.fn().mockReturnValue('test-key-123'),
}));

vi.mock('../../lib/activityLogger', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
}));

import { buildAdjustmentCalls, type AdjustmentItem } from './BatchAdjustModal';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildAdjustmentCalls', () => {
  it('creates one RPC call per item', () => {
    const items: AdjustmentItem[] = [
      { inventory_id: 'inv-1', product_name: 'Product A', current_qty: 10, delta: 5 },
      { inventory_id: 'inv-2', product_name: 'Product B', current_qty: 20, delta: -3 },
    ];
    const calls = buildAdjustmentCalls(items, 'Cycle count correction', 'user-1');
    expect(calls).toHaveLength(2);
    expect(calls[0].p_inventory_id).toBe('inv-1');
    expect(calls[0].p_delta).toBe(5);
    expect(calls[1].p_delta).toBe(-3);
  });

  it('filters out zero-delta items', () => {
    const items: AdjustmentItem[] = [
      { inventory_id: 'inv-1', product_name: 'A', current_qty: 10, delta: 5 },
      { inventory_id: 'inv-2', product_name: 'B', current_qty: 20, delta: 0 },
    ];
    const calls = buildAdjustmentCalls(items, 'fix', 'user-1');
    expect(calls).toHaveLength(1);
  });

  it('includes reason in every call', () => {
    const items: AdjustmentItem[] = [
      { inventory_id: 'inv-1', product_name: 'A', current_qty: 10, delta: 5 },
    ];
    const calls = buildAdjustmentCalls(items, 'Damaged goods', 'user-1');
    expect(calls[0].p_reason).toBe('Damaged goods');
  });
});
```

### Step 2: Run test to verify it fails

```bash
npx vitest run src/components/inventory/BatchAdjustModal.test.ts
```
Expected: FAIL — module not found

### Step 3: Implement BatchAdjustModal.tsx

Create `src/components/inventory/BatchAdjustModal.tsx`:

```tsx
import { useState } from 'react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import Input from '../ui/Input';
import { supabase, sanitizeError } from '../../lib/db';
import { generateIdempotencyKey } from '../../lib/idempotency';
import { logActivity } from '../../lib/activityLogger';
import { useToast } from '../ui/Toast';

export interface AdjustmentItem {
  inventory_id: string;
  product_name: string;
  current_qty: number;
  delta: number;
}

interface RpcCall {
  p_inventory_id: string;
  p_delta: number;
  p_reason: string;
  p_performed_by: string;
  p_idempotency_key: string;
}

/** Exported for testing */
export function buildAdjustmentCalls(
  items: AdjustmentItem[],
  reason: string,
  userId: string,
): RpcCall[] {
  return items
    .filter((it) => it.delta !== 0)
    .map((it) => ({
      p_inventory_id: it.inventory_id,
      p_delta: it.delta,
      p_reason: reason,
      p_performed_by: userId,
      p_idempotency_key: generateIdempotencyKey('batch_adjust', userId),
    }));
}

interface Props {
  open: boolean;
  onClose: () => void;
  items: Array<{ id: string; product_id: string; product_name: string; quantity_available: number }>;
  userId: string;
  onSuccess: () => void;
}

export default function BatchAdjustModal({ open, onClose, items, userId, onSuccess }: Props) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [uniformDelta, setUniformDelta] = useState('');
  const [saving, setSaving] = useState(false);

  const delta = Number(uniformDelta) || 0;

  const handleSubmit = async () => {
    if (!reason.trim()) {
      toast('error', 'Please enter a reason for the adjustment');
      return;
    }
    if (delta === 0) {
      toast('error', 'Adjustment quantity cannot be zero');
      return;
    }

    setSaving(true);
    const adjustItems: AdjustmentItem[] = items.map((it) => ({
      inventory_id: it.id,
      product_name: it.product_name,
      current_qty: it.quantity_available,
      delta,
    }));

    const calls = buildAdjustmentCalls(adjustItems, reason.trim(), userId);
    let successCount = 0;
    let errorCount = 0;

    for (const call of calls) {
      const { error } = await supabase.rpc('adjust_inventory', call);
      if (error) {
        console.error('Batch adjust error:', error);
        errorCount++;
      } else {
        successCount++;
      }
    }

    if (successCount > 0) {
      await logActivity(
        'inventory_batch_adjusted',
        `Batch adjusted ${successCount} product(s) by ${delta > 0 ? '+' : ''}${delta}: ${reason.trim()}`,
        userId,
        'inventory',
      );
    }

    if (errorCount > 0) {
      toast('error', `${errorCount} adjustment(s) failed. ${successCount} succeeded.`);
    } else {
      toast('success', `Adjusted ${successCount} product(s) by ${delta > 0 ? '+' : ''}${delta}`);
    }

    setSaving(false);
    setReason('');
    setUniformDelta('');
    onSuccess();
    onClose();
  };

  return (
    <Modal open={open} onClose={onClose} title="Batch" accent="Adjustment">
      <div className="space-y-4">
        <p className="text-sm text-secondary">
          Adjusting <strong>{items.length}</strong> product{items.length !== 1 ? 's' : ''}
        </p>

        {/* Preview list */}
        <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-lg divide-y">
          {items.map((it) => (
            <div key={it.id} className="flex items-center justify-between px-3 py-2 text-sm">
              <span className="truncate">{it.product_name}</span>
              <span className="text-secondary whitespace-nowrap ml-2">
                {it.quantity_available} → {it.quantity_available + delta}
              </span>
            </div>
          ))}
        </div>

        <Input
          label="Adjustment Quantity (+ or -)"
          type="number"
          value={uniformDelta}
          onChange={(e) => setUniformDelta(e.target.value)}
          placeholder="e.g. 5 or -3"
        />

        <Input
          label="Reason (required)"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. Cycle count correction, Damaged goods"
        />

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            onClick={handleSubmit}
            loading={saving}
            disabled={delta === 0 || !reason.trim()}
          >
            Adjust {items.length} Product{items.length !== 1 ? 's' : ''}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

### Step 4: Run tests

```bash
npx vitest run src/components/inventory/BatchAdjustModal.test.ts
```
Expected: All 3 tests PASS

### Step 5: Commit

```bash
git add src/components/inventory/BatchAdjustModal.tsx src/components/inventory/BatchAdjustModal.test.ts
git commit -m "feat: add batch inventory adjustment modal

Allows selecting multiple products and applying a uniform quantity
adjustment with a required reason. Uses adjust_inventory RPC with
idempotency keys for each item."
```

### Step 6: Wire batch adjust to InventoryPage

Modify `src/pages/InventoryPage.tsx`:

**6a.** Add import:
```typescript
import BatchAdjustModal from '../components/inventory/BatchAdjustModal';
```

**6b.** Add state (near the other modal states):
```typescript
const [batchAdjustOpen, setBatchAdjustOpen] = useState(false);
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
```

**6c.** Add selection toggle handler:
```typescript
const toggleSelect = (id: string) => {
  setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
};

const toggleSelectAll = () => {
  if (selectedIds.size === filtered.length) {
    setSelectedIds(new Set());
  } else {
    setSelectedIds(new Set(filtered.map((r) => r.id)));
  }
};
```

**6d.** Add a checkbox column at the beginning of the columns array (admin only):
```typescript
// Only add if isAdmin:
...(isAdmin ? [{
  key: '_select',
  header: '',
  sortable: false,
  className: 'w-10',
  render: (row: InventoryRow) => (
    <input
      type="checkbox"
      checked={selectedIds.has(row.id)}
      onChange={() => toggleSelect(row.id)}
      className="rounded border-gray-300"
    />
  ),
}] : []),
```

**6e.** Add "Batch Adjust" button in the header area (next to existing admin buttons, only show when items selected):
```tsx
{isAdmin && selectedIds.size > 0 && (
  <Button
    variant="secondary"
    icon={<Pencil className="w-4 h-4" />}
    onClick={() => setBatchAdjustOpen(true)}
  >
    Adjust {selectedIds.size} Selected
  </Button>
)}
```

**6f.** Add the modal component at the end of JSX:
```tsx
<BatchAdjustModal
  open={batchAdjustOpen}
  onClose={() => setBatchAdjustOpen(false)}
  items={inventory.filter((r) => selectedIds.has(r.id)).map((r) => ({
    id: r.id,
    product_id: r.product_id,
    product_name: r.product_name,
    quantity_available: r.quantity_available,
  }))}
  userId={profile?.id || ''}
  onSuccess={() => {
    setSelectedIds(new Set());
    fetchInventory();
  }}
/>
```

### Step 7: Test manually + run existing tests

```bash
npm run dev
npx vitest run
```

### Step 8: Commit

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat: wire batch adjustment modal to inventory page

Admin users can now select multiple products with checkboxes and
apply a batch quantity adjustment with a reason."
```

---

## Task 5: Inventory Valuation Display

**Goal:** Show total dollar value of inventory on the Inventory page — as a summary card and optionally as columns in the table.

**Dependencies:** Requires Task 3's `current_cost` field to already be in the query and `InventoryRow` interface.

**Files:**
- Modify: `src/pages/InventoryPage.tsx` (add summary card + optional column)

### Step 1: Add valuation summary card

Find the `summaryCards` array in `InventoryPage.tsx` (search for `summaryCards`). Add a new card for total valuation:

First, compute the total valuation value near where other summary values are computed:
```typescript
const totalValuation = inventory.reduce((sum, r) => {
  const cost = r.current_cost || 0;
  return sum + (r.quantity_available * cost);
}, 0);
```

Then add to the `summaryCards` array:
```typescript
{
  label: 'Inventory Value',
  value: totalValuation,
  color: 'bg-emerald-50 text-emerald-600',
  icon: Package, // or use a dollar icon if available
  format: 'currency',
},
```

For the currency formatting, modify the summary card rendering to handle a `format` property. In the card display (around line 847), change the value display:

```tsx
<p className="text-2xl font-semibold font-heading text-nav-dark">
  {c.format === 'currency'
    ? `$${c.value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : c.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}
</p>
```

You'll need to update the `summaryCards` type to include `format?: 'currency'`.

### Step 2: Add unit cost + total value columns to the table (optional, admin only)

Add two new columns to the `columns` array (admin only, after the Delivered YTD column):

```typescript
...(isAdmin ? [
  {
    key: 'current_cost',
    header: 'Unit Cost',
    sortable: true,
    className: 'text-right',
    render: (row: InventoryRow) => (
      <span className="text-sm text-secondary">
        {row.current_cost != null ? `$${Number(row.current_cost).toFixed(2)}` : '-'}
      </span>
    ),
  },
  {
    key: '_total_value',
    header: 'Value',
    sortable: true,
    className: 'text-right',
    render: (row: InventoryRow) => {
      const val = (row.current_cost || 0) * row.quantity_available;
      return (
        <span className="text-sm font-medium text-nav-dark">
          {row.current_cost != null ? `$${val.toFixed(2)}` : '-'}
        </span>
      );
    },
  },
] as EditableColumn<InventoryRow>[] : []),
```

### Step 3: Run the app and verify

```bash
npm run dev
```
- Verify the "Inventory Value" summary card shows total dollar value
- Verify Unit Cost and Value columns appear for admin users

### Step 4: Run all tests

```bash
npx vitest run
```
Expected: All tests pass

### Step 5: Commit

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat: add inventory valuation display

Shows total inventory dollar value as a summary card. Admin users also
see Unit Cost and Value columns in the inventory table."
```

---

## Final Verification

After all 5 tasks are complete:

```bash
# 1. Run full test suite
npx vitest run

# 2. Run lint
npx eslint src/ --max-warnings 0

# 3. Run build
npm run build

# 4. Run E2E tests
npx playwright test
```

All must pass before merging.
