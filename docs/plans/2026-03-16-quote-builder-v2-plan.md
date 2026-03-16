# Quote Builder V2 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade the Quote Builder with versioning, send/present workflow, product notes auto-pull, PDF column presets, planned programs with inventory forecasting, quote templates, pipeline notes flow, customer quote history, inventory forecasting dashboard, seasonal rollover, and quick quote from customer page.

**Architecture:** 12 sprints, each with its own migration (where needed) and self-contained frontend changes. Follows existing patterns: SalesReports `customerView` toggle for hide/show, Dashboard data-driven alerts array, CustomerDetail tab lazy-loading, and `save_quote` RPC atomic save pattern.

**Tech Stack:** React + TypeScript, Supabase (PostgreSQL RPCs, RLS), jsPDF + autotable, Tailwind CSS, Vitest + Playwright

**Design Doc:** `docs/plans/2026-03-16-quote-builder-v2-design.md`

---

## Sprint 1: Product Internal Notes Field

### Task 1.1: Migration — Add `internal_notes` Column

**Files:**
- Create: `supabase/migrations/20260316100000_product_internal_notes.sql`

**Step 1: Write the migration**

```sql
-- Add internal_notes column to products table
-- Existing `notes` column stays as-is (grower-facing description)
-- New `internal_notes` column for internal-only notes (never shown to growers)

ALTER TABLE products ADD COLUMN IF NOT EXISTS internal_notes text;

-- Copy existing notes to internal_notes so both start with same content
UPDATE products SET internal_notes = notes WHERE notes IS NOT NULL;
```

**Step 2: Apply migration locally**

Run: `npx supabase db push` or apply via Supabase dashboard

**Step 3: Commit**

```bash
git add supabase/migrations/20260316100000_product_internal_notes.sql
git commit -m "feat(db): add internal_notes column to products table"
```

---

### Task 1.2: Update TypeScript Types

**Files:**
- Modify: `src/types/index.ts:20-57` (Product interface)

**Step 1: Add `internal_notes` to Product interface**

Find the Product interface (line 20-57). After the `notes` field (line 53), add:

```typescript
internal_notes: string | null;
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No new errors (internal_notes is nullable, won't break existing code)

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add internal_notes to Product interface"
```

---

### Task 1.3: Update ProductDetail Form

**Files:**
- Modify: `src/pages/ProductDetail.tsx:441-451` (notes section)

**Step 1: Relabel existing Notes field and add Internal Notes**

Find the notes section at lines 441-451. Replace the entire block with:

```tsx
{/* Grower Description (existing notes field) */}
<div className="border-t border-gray-100 pt-4 mt-4">
  <label className="block text-sm font-medium text-secondary mb-1">Grower Description</label>
  <p className="text-xs text-gray-400 mb-1">Shown to growers on quotes and PDFs. Describe what the product does, application tips, etc.</p>
  <textarea
    value={product.notes || ''}
    onChange={(e) => update('notes', e.target.value)}
    disabled={!isAdmin}
    rows={3}
    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
  />
</div>

{/* Internal Notes */}
<div className="border-t border-gray-100 pt-4 mt-4">
  <label className="block text-sm font-medium text-secondary mb-1">Internal Notes</label>
  <p className="text-xs text-gray-400 mb-1">Internal only — never shown to growers.</p>
  <textarea
    value={product.internal_notes || ''}
    onChange={(e) => update('internal_notes', e.target.value)}
    disabled={!isAdmin}
    rows={3}
    className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green disabled:opacity-50 disabled:bg-gray-50"
  />
</div>
```

**Step 2: Run build**

Run: `npm run build`
Expected: Clean build

**Step 3: Run tests**

Run: `npx vitest run`
Expected: All existing tests pass

**Step 4: Commit**

```bash
git add src/pages/ProductDetail.tsx
git commit -m "feat(products): relabel notes as Grower Description, add Internal Notes field"
```

---

### Task 1.4: Unit Tests for Product Internal Notes

**Files:**
- Create: `src/pages/__tests__/ProductDetail.internal-notes.test.tsx`

**Step 1: Write tests**

Write tests verifying:
- Both "Grower Description" and "Internal Notes" labels render
- Helper text renders for both fields
- Both textareas display correct values from product data
- Both textareas are disabled for non-admin users
- Updating internal_notes calls the update function

**Step 2: Run tests**

Run: `npx vitest run src/pages/__tests__/ProductDetail.internal-notes.test.tsx`
Expected: All pass

**Step 3: Commit**

```bash
git add src/pages/__tests__/ProductDetail.internal-notes.test.tsx
git commit -m "test(products): add unit tests for internal notes field"
```

---

## Sprint 2: Quote Versioning

### Task 2.1: Migration — Version RPCs

**Files:**
- Create: `supabase/migrations/20260316200000_quote_versioning_v2.sql`

**Step 1: Write the migration**

```sql
-- RPC: create_quote_version
-- Creates a snapshot of the current quote state when presented or emailed to grower
CREATE OR REPLACE FUNCTION public.create_quote_version(
  p_quote_id uuid,
  p_performed_by uuid,
  p_method text DEFAULT 'presented'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_version_number integer;
  v_snapshot jsonb;
  v_version_id uuid;
BEGIN
  -- Validate quote exists
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  -- Get next version number
  SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
  FROM quote_versions WHERE quote_id = p_quote_id;

  -- Build snapshot: full quote state with sections and items
  SELECT jsonb_build_object(
    'quote', jsonb_build_object(
      'quote_number', v_quote.quote_number,
      'customer_id', v_quote.customer_id,
      'tier', v_quote.tier,
      'status', v_quote.status,
      'total_price', v_quote.total_price,
      'total_cost', v_quote.total_cost,
      'total_profit', v_quote.total_profit,
      'total_margin_pct', v_quote.total_margin_pct,
      'valid_days', v_quote.valid_days,
      'expires_at', v_quote.expires_at,
      'header_notes', v_quote.header_notes,
      'footer_notes', v_quote.footer_notes,
      'is_planned', v_quote.is_planned,
      'commission_split', v_quote.commission_split
    ),
    'sections', (
      SELECT COALESCE(jsonb_agg(
        jsonb_build_object(
          'section_name', qs.section_name,
          'sort_order', qs.sort_order,
          'section_notes', qs.section_notes,
          'section_header_notes', qs.section_header_notes,
          'needed_by_date', qs.needed_by_date,
          'items', (
            SELECT COALESCE(jsonb_agg(
              jsonb_build_object(
                'product_id', qi.product_id,
                'product_name', p.product_name,
                'sku', p.sku,
                'sort_order', qi.sort_order,
                'notes', qi.notes,
                'price_per_unit', qi.price_per_unit,
                'current_cost', qi.current_cost,
                'suggested_rate', qi.suggested_rate,
                'actual_rate', qi.actual_rate,
                'rate_unit', qi.rate_unit,
                'oz_per_acre', qi.oz_per_acre,
                'price_per_acre', qi.price_per_acre,
                'acres', qi.acres,
                'total_units_needed', qi.total_units_needed,
                'unit_size', qi.unit_size,
                'profit', qi.profit,
                'total_price', qi.total_price,
                'net_margin', qi.net_margin,
                'calc_mode', qi.calc_mode,
                'price_unit', qi.price_unit
              ) ORDER BY qi.sort_order
            ), '[]'::jsonb)
            FROM quote_items qi
            JOIN products p ON p.id = qi.product_id
            WHERE qi.section_id = qs.id
          )
        ) ORDER BY qs.sort_order
      ), '[]'::jsonb)
      FROM quote_sections qs
      WHERE qs.quote_id = p_quote_id
    )
  ) INTO v_snapshot;

  -- Insert version record
  INSERT INTO quote_versions (quote_id, version_number, sent_by, sent_at, sent_method, snapshot_data)
  VALUES (p_quote_id, v_version_number, p_performed_by, now(), p_method, v_snapshot)
  RETURNING id INTO v_version_id;

  -- Update quote status to sent
  UPDATE quotes SET status = 'sent', sent_at = now(), updated_at = now()
  WHERE id = p_quote_id;

  RETURN jsonb_build_object(
    'status', 'created',
    'version_id', v_version_id,
    'version_number', v_version_number
  );
END;
$$;

-- RPC: restore_quote_version
-- Restores a quote to a previous version's state as a new revised draft
CREATE OR REPLACE FUNCTION public.restore_quote_version(
  p_quote_id uuid,
  p_version_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_snapshot jsonb;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_version_number integer;
BEGIN
  -- Get snapshot data
  SELECT snapshot_data, version_number INTO v_snapshot, v_version_number
  FROM quote_versions
  WHERE id = p_version_id AND quote_id = p_quote_id;

  IF v_snapshot IS NULL THEN
    RAISE EXCEPTION 'Version not found: %', p_version_id;
  END IF;

  -- Delete existing sections (cascades to items)
  DELETE FROM quote_sections WHERE quote_id = p_quote_id;

  -- Restore quote-level fields
  UPDATE quotes SET
    header_notes = v_snapshot->'quote'->>'header_notes',
    footer_notes = v_snapshot->'quote'->>'footer_notes',
    total_price = (v_snapshot->'quote'->>'total_price')::numeric,
    total_cost = (v_snapshot->'quote'->>'total_cost')::numeric,
    total_profit = (v_snapshot->'quote'->>'total_profit')::numeric,
    total_margin_pct = (v_snapshot->'quote'->>'total_margin_pct')::numeric,
    status = 'revised',
    updated_at = now()
  WHERE id = p_quote_id;

  -- Restore sections and items from snapshot
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_snapshot->'sections')
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes, needed_by_date)
    VALUES (
      p_quote_id,
      v_section->>'section_name',
      (v_section->>'sort_order')::integer,
      v_section->>'section_notes',
      v_section->>'section_header_notes',
      (v_section->>'needed_by_date')::date
    )
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        oz_per_acre, price_per_acre, acres, total_units_needed, unit_size,
        profit, total_price, net_margin, calc_mode, price_unit
      )
      VALUES (
        p_quote_id, v_section_id,
        (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer,
        v_item->>'notes',
        (v_item->>'price_per_unit')::numeric,
        (v_item->>'current_cost')::numeric,
        v_item->>'suggested_rate',
        (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit',
        (v_item->>'oz_per_acre')::numeric,
        (v_item->>'price_per_acre')::numeric,
        (v_item->>'acres')::numeric,
        (v_item->>'total_units_needed')::numeric,
        v_item->>'unit_size',
        (v_item->>'profit')::numeric,
        (v_item->>'total_price')::numeric,
        (v_item->>'net_margin')::numeric,
        v_item->>'calc_mode',
        v_item->>'price_unit'
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'restored',
    'restored_from_version', v_version_number,
    'quote_id', p_quote_id
  );
END;
$$;
```

**Step 2: Apply migration**

Run: `npx supabase db push`

**Step 3: Commit**

```bash
git add supabase/migrations/20260316200000_quote_versioning_v2.sql
git commit -m "feat(db): add create_quote_version and restore_quote_version RPCs"
```

---

### Task 2.2: Add QuoteVersion TypeScript Interface

**Files:**
- Modify: `src/types/index.ts` (after QuoteItem interface, ~line 186)

**Step 1: Add QuoteVersion interface**

```typescript
export interface QuoteVersion {
  id: string;
  quote_id: string;
  version_number: number;
  sent_by: string;
  sent_at: string;
  sent_method: string;
  snapshot_data: {
    quote: {
      quote_number: string;
      customer_id: string;
      tier: number;
      status: string;
      total_price: number;
      total_cost: number;
      total_profit: number;
      total_margin_pct: number;
      valid_days: number;
      expires_at: string | null;
      header_notes: string | null;
      footer_notes: string | null;
      is_planned: boolean;
      commission_split: CommissionSplit | null;
    };
    sections: Array<{
      section_name: string;
      sort_order: number;
      section_notes: string | null;
      section_header_notes: string | null;
      needed_by_date: string | null;
      items: Array<{
        product_id: string;
        product_name: string;
        sku: string | null;
        sort_order: number;
        notes: string | null;
        price_per_unit: number;
        current_cost: number;
        suggested_rate: string | null;
        actual_rate: number | null;
        rate_unit: string | null;
        oz_per_acre: number | null;
        price_per_acre: number | null;
        acres: number | null;
        total_units_needed: number | null;
        unit_size: string | null;
        profit: number;
        total_price: number;
        net_margin: number;
        calc_mode: string | null;
        price_unit: string | null;
      }>;
    }>;
  };
  pdf_url: string | null;
  notes: string | null;
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add QuoteVersion interface with snapshot_data shape"
```

---

### Task 2.3: Version History Panel in QuoteBuilder

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Add version state and fetch**

In the state declarations section (~lines 48-80), add:

```typescript
const [quoteVersions, setQuoteVersions] = useState<QuoteVersion[]>([]);
const [showVersionPanel, setShowVersionPanel] = useState(false);
const [selectedVersion, setSelectedVersion] = useState<QuoteVersion | null>(null);
const [compareMode, setCompareMode] = useState(false);
```

Add a `fetchVersions` function that queries `quote_versions` for the current quote, ordered by `version_number DESC`.

**Step 2: Add version badge + panel toggle button**

In the header area (near quote number display), add:
- Version badge: `V{latestVersionNumber}` if versions exist
- "Versions ({count})" button with History icon that toggles `showVersionPanel`

**Step 3: Build version history panel**

Create a slide-out panel or modal that shows:
- List of versions with version number, sent_at date, sent_method badge
- Click a version → `setSelectedVersion(v)` → shows read-only snapshot
- "Compare to Current" button → `setCompareMode(true)` → shows inline diff
- "Restore as Draft" button → calls `restore_quote_version` RPC → reloads quote

**Step 4: Build snapshot viewer**

Read-only view rendering the snapshot_data:
- For each section: section name, section_header_notes, items table, section_notes
- Items table with all columns (product, rate, acres, qty, price, total)
- Quote totals at bottom

**Step 5: Build comparison view**

Simple inline diff:
- Loop through current sections/items and snapshot sections/items
- Highlight added items (green), removed items (red), changed values (amber)
- Show old value → new value for changed fields

**Step 6: Wire restore button**

```typescript
const handleRestore = async (versionId: string) => {
  const { data, error } = await supabase.rpc('restore_quote_version', {
    p_quote_id: quoteId,
    p_version_id: versionId,
    p_performed_by: profile.id,
  });
  if (error) { toast.error('Failed to restore version'); return; }
  toast.success(`Restored from V${selectedVersion?.version_number}`);
  // Reload quote data
  fetchQuote(quoteId);
  setShowVersionPanel(false);
  setSelectedVersion(null);
};
```

**Step 7: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 8: Commit**

```bash
git add src/pages/QuoteBuilder.tsx src/types/index.ts
git commit -m "feat(quotes): add version history panel with snapshot viewer, comparison, and restore"
```

---

## Sprint 3: Send/Present Workflow Rework

### Task 3.1: Customer View Toggle

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Add customerView state**

In state declarations, add:

```typescript
const [customerView, setCustomerView] = useState(false);
```

**Step 2: Add toggle button**

Follow the SalesReports pattern (lines 379-387 in SalesReports.tsx). Add in the QuoteBuilder toolbar area:

```tsx
<button
  onClick={() => setCustomerView(!customerView)}
  className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border transition-colors ${
    customerView
      ? 'bg-crx-green text-white border-crx-green'
      : 'border-gray-200 text-secondary hover:border-crx-green hover:text-crx-green'
  }`}
>
  {customerView ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
  Customer View
</button>
```

**Step 3: Add green banner when active**

```tsx
{customerView && (
  <div className="flex items-center gap-2 px-4 py-2 bg-crx-green-tint border border-crx-green/20 rounded-lg text-sm text-crx-green font-medium">
    <EyeOff className="w-4 h-4" />
    Customer View — cost, profit, and margin columns hidden
  </div>
)}
```

**Step 4: Conditionally hide columns**

In the items table header and body, use the spread pattern:

```tsx
// In table headers, wrap Cost, Profit, Margin in:
{!customerView && <th className="px-3 py-3 font-medium">Cost</th>}
{!customerView && <th className="px-3 py-3 font-medium">Profit</th>}
{!customerView && <th className="px-3 py-3 font-medium">Margin</th>}

// Same pattern in table body cells
```

**Step 5: Import Eye/EyeOff icons**

Add `Eye, EyeOff` to the lucide-react import line.

**Step 6: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 7: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat(quotes): add customer view toggle to hide cost/profit/margin"
```

---

### Task 3.2: Preview Modal + Download/Present/Email Buttons

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`
- Modify: `src/lib/quotePdf.ts`

**Step 1: Add preview state**

```typescript
const [showPreviewModal, setShowPreviewModal] = useState(false);
const [previewPdfUrl, setPreviewPdfUrl] = useState<string | null>(null);
```

**Step 2: Replace "Send Quote" button with "Preview Quote"**

Find the current "Send Quote" button and replace with:

```tsx
<button
  onClick={handlePreviewQuote}
  className="flex items-center gap-2 px-4 py-2 bg-crx-green text-white rounded-lg hover:bg-crx-green-dark"
>
  <Eye className="w-4 h-4" />
  Preview Quote
</button>
```

**Step 3: Build handlePreviewQuote**

```typescript
const handlePreviewQuote = async () => {
  // Validate quote first (same validations as current send)
  if (!validateQuote()) return;
  // Generate PDF and create blob URL for preview
  const pdfData = buildPdfData(); // extract existing PDF data builder
  const doc = await generateQuotePdf(pdfData);
  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  setPreviewPdfUrl(url);
  setShowPreviewModal(true);
};
```

**Step 4: Build preview modal**

```tsx
{showPreviewModal && (
  <Modal onClose={() => { setShowPreviewModal(false); if (previewPdfUrl) URL.revokeObjectURL(previewPdfUrl); }} title="Quote Preview" size="xl">
    {/* PDF Preview */}
    <div className="h-[60vh]">
      <iframe src={previewPdfUrl || ''} className="w-full h-full border rounded-lg" />
    </div>

    {/* Action Buttons */}
    <div className="flex justify-end gap-3 mt-4 pt-4 border-t">
      <button onClick={handleDownloadPdf} className="flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg hover:bg-gray-50">
        <Download className="w-4 h-4" />
        Download PDF
      </button>
      <button onClick={handleMarkPresented} disabled={status !== 'draft' && status !== 'revised'}
        className="flex items-center gap-2 px-4 py-2 bg-crx-green text-white rounded-lg hover:bg-crx-green-dark disabled:opacity-50">
        <CheckCircle className="w-4 h-4" />
        Mark as Presented
      </button>
      <button disabled title="Coming Soon" className="flex items-center gap-2 px-4 py-2 bg-gray-100 text-gray-400 rounded-lg cursor-not-allowed">
        <Send className="w-4 h-4" />
        Email to Grower
      </button>
    </div>
  </Modal>
)}
```

**Step 5: Implement action handlers**

```typescript
const handleDownloadPdf = async () => {
  const pdfData = buildPdfData();
  const doc = await generateQuotePdf(pdfData);
  doc.save(`${quoteNumber || 'quote'}.pdf`);
  // NO version created, NO status change
};

const handleMarkPresented = async () => {
  // Save current state first
  await handleSaveDraft();
  // Create version snapshot
  const { data, error } = await supabase.rpc('create_quote_version', {
    p_quote_id: quoteId,
    p_performed_by: profile.id,
    p_method: 'presented',
  });
  if (error) { toast.error('Failed to create version'); return; }
  toast.success(`Quote marked as presented (V${data.version_number})`);
  setShowPreviewModal(false);
  fetchVersions();
  setStatus('sent');
};
```

**Step 6: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 7: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat(quotes): replace Send button with Preview modal, Download PDF, and Mark as Presented"
```

---

## Sprint 4: Product Notes Auto-Pull + Section Header Notes

### Task 4.1: Migration — Section Header Notes

**Files:**
- Create: `supabase/migrations/20260316300000_quote_section_header_notes.sql`

**Step 1: Write the migration**

```sql
-- Add section_header_notes column to quote_sections
-- Displays above items table, below section name
-- Existing section_notes stays as-is (displays below items table)
ALTER TABLE quote_sections ADD COLUMN IF NOT EXISTS section_header_notes text;
```

**Step 2: Apply migration**

Run: `npx supabase db push`

**Step 3: Commit**

```bash
git add supabase/migrations/20260316300000_quote_section_header_notes.sql
git commit -m "feat(db): add section_header_notes column to quote_sections"
```

---

### Task 4.2: Update Types

**Files:**
- Modify: `src/types/index.ts:155-161` (QuoteSection interface)

**Step 1: Add section_header_notes**

```typescript
export interface QuoteSection {
  id: string;
  quote_id: string;
  section_name: string;
  sort_order: number;
  section_notes: string | null;
  section_header_notes: string | null;  // ADD THIS
}
```

**Step 2: Commit**

```bash
git add src/types/index.ts
git commit -m "feat(types): add section_header_notes to QuoteSection interface"
```

---

### Task 4.3: Notes Auto-Pull in QuoteBuilder

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Update product selection handler**

Find where a product is selected for a line item (the product selector callback). When a product is selected, auto-populate the item's `notes` from `product.notes`:

```typescript
// In the product selection handler for a line item:
const handleProductSelect = (sectionKey: string, itemKey: string, product: Product) => {
  setSections(prev => prev.map(s => {
    if (s._key !== sectionKey) return s;
    return {
      ...s,
      items: s.items.map(item => {
        if (item._key !== itemKey) return item;
        return {
          ...item,
          product_id: product.id,
          product: product,
          notes: product.notes || '',  // Auto-pull grower description
          // ... existing field assignments
        };
      }),
    };
  }));
};
```

**Step 2: Add notes textarea to each line item**

In the items table, add a notes cell. This can be a small textarea or an expandable field below the row:

```tsx
<td className="px-3 py-2">
  <div className="flex items-center gap-1">
    <textarea
      value={item.notes || ''}
      onChange={(e) => updateItem(section._key, item._key, 'notes', e.target.value)}
      rows={1}
      placeholder="Product notes..."
      className="w-full text-xs border border-gray-200 rounded px-2 py-1 focus:ring-1 focus:ring-crx-green/20 resize-none"
    />
    {item.product?.notes && item.notes !== item.product.notes && (
      <button
        onClick={() => updateItem(section._key, item._key, 'notes', item.product?.notes || '')}
        title="Reset to default"
        className="text-xs text-crx-green hover:underline whitespace-nowrap"
      >
        Reset
      </button>
    )}
  </div>
</td>
```

**Step 3: Add section header notes textarea**

In each section, between the section name input and the items table, add:

```tsx
{/* Section Header Notes - above items table */}
<div className="px-4 pb-2">
  <textarea
    value={section.section_header_notes || ''}
    onChange={(e) => updateSection(section._key, 'section_header_notes', e.target.value)}
    rows={2}
    placeholder="Section notes for grower (shown above products on PDF)..."
    className="w-full text-sm border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-crx-green/20 focus:border-crx-green resize-none"
  />
</div>
```

**Step 4: Update LocalSection type**

Add `section_header_notes: string | null` to the LocalSection interface in QuoteBuilder.

**Step 5: Update save payload**

In the sections payload builder, include `section_header_notes`:

```typescript
sectionsPayload = sections.map(s => ({
  section_name: s.section_name,
  sort_order: s.sort_order,
  section_notes: s.section_notes,
  section_header_notes: s.section_header_notes,  // ADD THIS
  items: s.items.map(/* ... existing ... */),
}));
```

**Step 6: Update save_quote RPC**

Modify the `save_quote` RPC to handle `section_header_notes` in the sections insert. This requires updating the migration or creating a new one that adds the column handling to the RPC's section insert loop.

**Step 7: Update fetch to load section_header_notes**

In `fetchQuote`, ensure the query for quote_sections includes `section_header_notes`.

**Step 8: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 9: Commit**

```bash
git add src/pages/QuoteBuilder.tsx supabase/migrations/
git commit -m "feat(quotes): auto-pull product notes to line items, add section header notes"
```

---

### Task 4.4: Update PDF to Render Notes

**Files:**
- Modify: `src/lib/quotePdf.ts`

**Step 1: Add section_header_notes rendering**

In the sections loop (around line 151), after rendering the section header and before the items table, add:

```typescript
// Section header notes (above items)
if (section.section_header_notes) {
  doc.setFontSize(9);
  doc.setFont('helvetica', 'italic');
  doc.setTextColor(...CHARCOAL);
  const headerNoteLines = doc.splitTextToSize(section.section_header_notes, pageWidth - 2 * margin);
  doc.text(headerNoteLines, margin, y);
  y += headerNoteLines.length * 4 + 4;
}
```

**Step 2: Add Notes column to items table (conditional)**

The Notes column will be controlled by the column picker (Sprint 5). For now, add it as an optional column that can be toggled. Update the `PdfQuoteItem` interface to include `notes`:

```typescript
interface PdfQuoteItem {
  // ... existing fields
  notes: string | null;  // ADD THIS
}
```

**Step 3: Update section_notes rendering**

Ensure existing `section_notes` (footer) still renders below items and only when non-empty. This should already work — verify it skips when null.

**Step 4: Commit**

```bash
git add src/lib/quotePdf.ts
git commit -m "feat(pdf): render section header notes above items, support notes column"
```

---

## Sprint 5: PDF Column Picker + Presets

### Task 5.1: Migration — PDF Templates Table

**Files:**
- Create: `supabase/migrations/20260316400000_quote_pdf_templates.sql`

**Step 1: Write the migration**

```sql
-- PDF column presets for quote PDFs
CREATE TABLE IF NOT EXISTS quote_pdf_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  columns jsonb NOT NULL DEFAULT '[]'::jsonb,
  is_default boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES profiles(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quote_pdf_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read pdf templates"
  ON quote_pdf_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admins can manage pdf templates"
  ON quote_pdf_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role = 'admin'));

-- Seed 3 default presets
INSERT INTO quote_pdf_templates (template_name, columns, is_default, is_system) VALUES
  ('Program Detail', '["product", "notes", "sug_rate", "actual_rate", "acres", "qty", "price_unit", "price_per_acre"]', true, true),
  ('Simple Pricing', '["product", "notes", "price_unit", "price_per_acre"]', false, true),
  ('Summary', '["product", "qty", "total_price"]', false, true);

-- Add PDF template reference to quotes
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_template_id uuid REFERENCES quote_pdf_templates(id);
ALTER TABLE quotes ADD COLUMN IF NOT EXISTS pdf_columns_override jsonb;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260316400000_quote_pdf_templates.sql
git commit -m "feat(db): add quote_pdf_templates table with 3 seed presets"
```

---

### Task 5.2: Column Picker UI in Preview Modal

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Add column picker state**

```typescript
const [pdfTemplates, setPdfTemplates] = useState<QuotePdfTemplate[]>([]);
const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
const [customColumns, setCustomColumns] = useState<string[] | null>(null);
const [showColumnPicker, setShowColumnPicker] = useState(false);
```

**Step 2: Define available columns**

```typescript
const AVAILABLE_PDF_COLUMNS = [
  { key: 'product', label: 'Product' },
  { key: 'category', label: 'Category' },
  { key: 'notes', label: 'Notes' },
  { key: 'sug_rate', label: 'Sug. Rate' },
  { key: 'actual_rate', label: 'Actual Rate' },
  { key: 'rate_unit', label: 'Unit' },
  { key: 'acres', label: 'Acres' },
  { key: 'qty', label: 'Qty' },
  { key: 'unit_size', label: 'Container' },
  { key: 'price_unit', label: 'Price/Unit' },
  { key: 'price_per_acre', label: '$/Acre' },
  { key: 'total_price', label: 'Total' },
] as const;
// NOTE: cost, profit, margin are NEVER available here
```

**Step 3: Fetch templates on mount**

```typescript
const fetchPdfTemplates = async () => {
  const { data } = await supabase.from('quote_pdf_templates').select('*').order('is_default', { ascending: false });
  if (data) {
    setPdfTemplates(data);
    const defaultTemplate = data.find(t => t.is_default);
    if (defaultTemplate && !selectedTemplateId) setSelectedTemplateId(defaultTemplate.id);
  }
};
```

**Step 4: Add template dropdown + customize button to preview modal**

In the preview modal, above the PDF iframe:

```tsx
<div className="flex items-center gap-3 mb-3">
  <select
    value={selectedTemplateId || ''}
    onChange={(e) => { setSelectedTemplateId(e.target.value); setCustomColumns(null); }}
    className="text-sm border border-gray-200 rounded-lg px-3 py-1.5"
  >
    {pdfTemplates.map(t => (
      <option key={t.id} value={t.id}>{t.template_name}</option>
    ))}
  </select>
  <button onClick={() => setShowColumnPicker(!showColumnPicker)}
    className="text-sm text-crx-green hover:underline">
    Customize Columns
  </button>
</div>
```

**Step 5: Build column picker checkboxes**

```tsx
{showColumnPicker && (
  <div className="flex flex-wrap gap-2 mb-3 p-3 bg-gray-50 rounded-lg">
    {AVAILABLE_PDF_COLUMNS.map(col => {
      const activeColumns = customColumns || getTemplateColumns(selectedTemplateId);
      const isActive = activeColumns.includes(col.key);
      return (
        <label key={col.key} className="flex items-center gap-1.5 text-sm cursor-pointer">
          <input type="checkbox" checked={isActive}
            onChange={() => {
              const cols = [...activeColumns];
              if (isActive) cols.splice(cols.indexOf(col.key), 1);
              else cols.push(col.key);
              setCustomColumns(cols);
            }}
          />
          {col.label}
        </label>
      );
    })}
  </div>
)}
```

**Step 6: Pass active columns to PDF generator**

Update `generateQuotePdf` to accept a `columns` parameter and only render selected columns. Update `buildPdfData` to pass the active columns.

**Step 7: Save column selection with quote**

When saving draft or presenting, include `pdf_template_id` and `pdf_columns_override` in the quote payload:

```typescript
quotePayload.pdf_template_id = customColumns ? null : selectedTemplateId;
quotePayload.pdf_columns_override = customColumns;
```

**Step 8: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 9: Commit**

```bash
git add src/pages/QuoteBuilder.tsx src/lib/quotePdf.ts supabase/migrations/
git commit -m "feat(quotes): add PDF column picker with 3 presets and per-quote customization"
```

---

## Sprint 6: Planned Programs + Inventory Forecasting

### Task 6.1: Migration — Planned Programs

**Files:**
- Create: `supabase/migrations/20260316500000_planned_programs.sql`

**Step 1: Write the migration**

```sql
-- Add needed_by_date to quote_sections for planned programs
ALTER TABLE quote_sections ADD COLUMN IF NOT EXISTS needed_by_date date;

-- RPC: create_planned_holds
-- Auto-creates inventory holds for all items in a planned quote
CREATE OR REPLACE FUNCTION public.create_planned_holds(
  p_quote_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_quote quotes%ROWTYPE;
  v_item RECORD;
  v_holds_created integer := 0;
BEGIN
  SELECT * INTO v_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Quote not found: %', p_quote_id;
  END IF;

  IF NOT v_quote.is_planned THEN
    RAISE EXCEPTION 'Quote is not marked as planned: %', p_quote_id;
  END IF;

  -- Delete existing holds for this quote (idempotent)
  DELETE FROM inventory_holds WHERE source_id = p_quote_id AND is_active = true;

  -- Create holds for each quote item
  FOR v_item IN
    SELECT qi.product_id, qi.total_units_needed, qs.needed_by_date
    FROM quote_items qi
    JOIN quote_sections qs ON qs.id = qi.section_id
    WHERE qi.quote_id = p_quote_id
      AND qi.total_units_needed IS NOT NULL
      AND qi.total_units_needed > 0
  LOOP
    INSERT INTO inventory_holds (
      product_id, customer_id, quantity, hold_type, source_id,
      notes, created_by, expires_at, is_active
    ) VALUES (
      v_item.product_id,
      v_quote.customer_id,
      v_item.total_units_needed,
      'crop_program',
      p_quote_id,
      'Planned program hold for quote ' || v_quote.quote_number,
      p_performed_by,
      v_item.needed_by_date + INTERVAL '14 days',  -- 14-day buffer past need date
      true
    );
    v_holds_created := v_holds_created + 1;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'holds_created', v_holds_created);
END;
$$;

-- RPC: get_expiring_planned_holds
-- Returns planned holds with needed_by_date within N days (for dashboard alerts)
CREATE OR REPLACE FUNCTION public.get_expiring_planned_holds(
  p_days_ahead integer DEFAULT 7
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        ih.id AS hold_id,
        ih.product_id,
        p.product_name,
        ih.quantity,
        ih.expires_at,
        (ih.expires_at - INTERVAL '14 days')::date AS needed_by_date,
        ih.source_id AS quote_id,
        q.quote_number,
        c.farm_name AS customer_name,
        ih.customer_id
      FROM inventory_holds ih
      JOIN products p ON p.id = ih.product_id
      JOIN quotes q ON q.id = ih.source_id
      JOIN customers c ON c.id = ih.customer_id
      WHERE ih.is_active = true
        AND ih.hold_type = 'crop_program'
        AND (ih.expires_at - INTERVAL '14 days')::date <= CURRENT_DATE + p_days_ahead
        AND ih.expires_at > CURRENT_DATE  -- not yet expired
      ORDER BY (ih.expires_at - INTERVAL '14 days')::date ASC
    ) r
  );
END;
$$;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260316500000_planned_programs.sql
git commit -m "feat(db): add planned program RPCs — create_planned_holds and get_expiring_planned_holds"
```

---

### Task 6.2: Planned Program UI in QuoteBuilder

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Add planned program toggle**

In the quote header area (near customer selector and tier display), add:

```tsx
<label className="flex items-center gap-2 text-sm">
  <input
    type="checkbox"
    checked={isPlanned}
    onChange={(e) => setIsPlanned(e.target.checked)}
    className="rounded border-gray-300 text-crx-green focus:ring-crx-green"
  />
  <span className="font-medium">Planned Program</span>
</label>
{isPlanned && (
  <span className="px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-800 rounded-full">
    Planned
  </span>
)}
```

**Step 2: Add needed_by_date per section**

In each section header (when `isPlanned` is true), add a date picker:

```tsx
{isPlanned && (
  <div className="flex items-center gap-2">
    <label className="text-xs text-secondary">Needed By:</label>
    <input
      type="date"
      value={section.needed_by_date || ''}
      onChange={(e) => updateSection(section._key, 'needed_by_date', e.target.value)}
      className="text-sm border border-gray-200 rounded px-2 py-1"
    />
  </div>
)}
```

**Step 3: Wire hold creation on save**

After `save_quote` succeeds, if `isPlanned`:

```typescript
if (isPlanned) {
  const { error: holdError } = await supabase.rpc('create_planned_holds', {
    p_quote_id: savedQuoteId,
    p_performed_by: profile.id,
  });
  if (holdError) toast.error('Failed to create inventory holds');
  else toast.success('Inventory holds created for planned program');
}
```

If `isPlanned` was toggled OFF (was planned, now isn't), release holds:

```typescript
if (!isPlanned && wasPlanned) {
  await supabase.from('inventory_holds')
    .update({ is_active: false })
    .eq('source_id', quoteId);
}
```

**Step 4: Update LocalSection type and save payload**

Add `needed_by_date: string | null` to LocalSection and include it in the sections payload.

**Step 5: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 6: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat(quotes): add planned program toggle with needed_by_date and auto inventory holds"
```

---

### Task 6.3: Dashboard Alert for Expiring Holds

**Files:**
- Modify: `src/pages/Dashboard.tsx`

**Step 1: Fetch expiring holds count**

In the Dashboard data fetching (near the other alert queries), add:

```typescript
const [expiringHoldsCount, setExpiringHoldsCount] = useState(0);

// In the fetch function:
const { data: holdsData } = await supabase.rpc('get_expiring_planned_holds', { p_days_ahead: 7 });
if (holdsData) setExpiringHoldsCount(Array.isArray(holdsData) ? holdsData.length : 0);
```

**Step 2: Add alert to the alerts array**

Follow the existing pattern at Dashboard.tsx lines 378-411. Add to the `alerts` array:

```typescript
{
  key: 'expiring-holds',
  path: '/quotes?filter=planned',
  count: expiringHoldsCount,
  label: 'planned program holds expiring within 7 days',
  icon: AlertTriangle,
  bg: 'bg-amber-50',
  border: 'border-amber-200',
  iconColor: 'text-amber-600',
  driverVisible: false,
},
```

**Step 3: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 4: Commit**

```bash
git add src/pages/Dashboard.tsx
git commit -m "feat(dashboard): add expiring planned program holds alert"
```

---

### Task 6.4: Quotes List — Planned Programs Filter

**Files:**
- Modify: `src/pages/Quotes.tsx`

**Step 1: Add planned filter tab**

Add a tab/button group above the quotes table for "All Quotes" | "Planned Programs":

```tsx
<div className="flex gap-2 mb-4">
  <button
    onClick={() => setPlannedFilter(false)}
    className={`px-3 py-1.5 text-sm rounded-lg ${!plannedFilter ? 'bg-crx-green text-white' : 'border border-gray-200'}`}
  >
    All Quotes
  </button>
  <button
    onClick={() => setPlannedFilter(true)}
    className={`px-3 py-1.5 text-sm rounded-lg ${plannedFilter ? 'bg-amber-100 text-amber-800 border border-amber-200' : 'border border-gray-200'}`}
  >
    Planned Programs
  </button>
</div>
```

**Step 2: Add filtering logic**

```typescript
const [plannedFilter, setPlannedFilter] = useState(false);

// In the filter chain:
const filtered = quotes.filter(q => {
  if (plannedFilter && !q.is_planned) return false;
  if (statusFilter && q.status !== statusFilter) return false;
  return true;
});
```

**Step 3: Add is_planned badge to quote rows**

In the status column or as a separate badge:

```tsx
{row.is_planned && (
  <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-800 rounded">
    Planned
  </span>
)}
```

**Step 4: Support URL filter parameter**

Check for `?filter=planned` on mount (linked from dashboard alert):

```typescript
useEffect(() => {
  const params = new URLSearchParams(location.search);
  if (params.get('filter') === 'planned') setPlannedFilter(true);
}, []);
```

**Step 5: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 6: Commit**

```bash
git add src/pages/Quotes.tsx
git commit -m "feat(quotes): add Planned Programs filter tab with URL parameter support"
```

---

## Sprint 7: Quote Templates

### Task 7.1: Migration — Quote Templates Table

**Files:**
- Create: `supabase/migrations/20260316600000_quote_templates.sql`

**Step 1: Write the migration**

```sql
CREATE TABLE IF NOT EXISTS quote_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  description text,
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by uuid REFERENCES profiles(id),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE quote_templates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can read templates"
  ON quote_templates FOR SELECT TO authenticated USING (true);

CREATE POLICY "Admin and sales can manage templates"
  ON quote_templates FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles WHERE id = auth.uid() AND role IN ('admin', 'sales_rep')));

-- RPC: save_quote_template
CREATE OR REPLACE FUNCTION public.save_quote_template(
  p_quote_id uuid,
  p_template_name text,
  p_description text DEFAULT NULL,
  p_performed_by uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_sections jsonb;
  v_template_id uuid;
BEGIN
  -- Build sections snapshot (strips customer-specific data)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'section_name', qs.section_name,
      'sort_order', qs.sort_order,
      'section_notes', qs.section_notes,
      'section_header_notes', qs.section_header_notes,
      'items', (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'product_id', qi.product_id,
            'product_name', p.product_name,
            'sku', p.sku,
            'sort_order', qi.sort_order,
            'notes', qi.notes,
            'suggested_rate', qi.suggested_rate,
            'actual_rate', qi.actual_rate,
            'rate_unit', qi.rate_unit,
            'calc_mode', qi.calc_mode
          ) ORDER BY qi.sort_order
        ), '[]'::jsonb)
        FROM quote_items qi
        JOIN products p ON p.id = qi.product_id
        WHERE qi.section_id = qs.id
      )
    ) ORDER BY qs.sort_order
  ), '[]'::jsonb) INTO v_sections
  FROM quote_sections qs WHERE qs.quote_id = p_quote_id;

  INSERT INTO quote_templates (template_name, description, sections, created_by)
  VALUES (p_template_name, p_description, v_sections, p_performed_by)
  RETURNING id INTO v_template_id;

  RETURN jsonb_build_object('status', 'created', 'template_id', v_template_id);
END;
$$;

-- RPC: create_quote_from_template
CREATE OR REPLACE FUNCTION public.create_quote_from_template(
  p_template_id uuid,
  p_customer_id uuid,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_template quote_templates%ROWTYPE;
  v_customer customers%ROWTYPE;
  v_quote_id uuid;
  v_quote_number text;
  v_section jsonb;
  v_item jsonb;
  v_section_id uuid;
  v_tier_price numeric;
BEGIN
  SELECT * INTO v_template FROM quote_templates WHERE id = p_template_id AND is_active = true;
  IF NOT FOUND THEN RAISE EXCEPTION 'Template not found: %', p_template_id; END IF;

  SELECT * INTO v_customer FROM customers WHERE id = p_customer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found: %', p_customer_id; END IF;

  -- Generate quote number
  SELECT generate_quote_number() INTO v_quote_number;

  -- Create quote
  INSERT INTO quotes (quote_number, customer_id, created_by, tier, status, valid_days,
    commission_split)
  VALUES (v_quote_number, p_customer_id, p_performed_by, v_customer.assigned_tier, 'draft', 15,
    v_customer.default_commission_split)
  RETURNING id INTO v_quote_id;

  -- Create sections and items from template
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_template.sections)
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_quote_id, v_section->>'section_name', (v_section->>'sort_order')::integer,
      v_section->>'section_notes', v_section->>'section_header_notes')
    RETURNING id INTO v_section_id;

    FOR v_item IN SELECT * FROM jsonb_array_elements(v_section->'items')
    LOOP
      -- Get tier price for this product
      SELECT CASE v_customer.assigned_tier
        WHEN 1 THEN COALESCE(tier1_price, 0)
        WHEN 2 THEN COALESCE(tier2_price, tier1_price, 0)
        WHEN 3 THEN COALESCE(tier3_price, tier1_price, 0)
        ELSE COALESCE(tier1_price, 0)
      END INTO v_tier_price
      FROM products WHERE id = (v_item->>'product_id')::uuid;

      INSERT INTO quote_items (quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit, calc_mode)
      VALUES (v_quote_id, v_section_id, (v_item->>'product_id')::uuid,
        (v_item->>'sort_order')::integer, v_item->>'notes',
        v_tier_price,
        (SELECT current_cost FROM products WHERE id = (v_item->>'product_id')::uuid),
        v_item->>'suggested_rate', (v_item->>'actual_rate')::numeric,
        v_item->>'rate_unit', v_item->>'calc_mode');
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object('status', 'created', 'quote_id', v_quote_id, 'quote_number', v_quote_number);
END;
$$;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260316600000_quote_templates.sql
git commit -m "feat(db): add quote_templates table with save and create-from-template RPCs"
```

---

### Task 7.2: "Save as Template" Button in QuoteBuilder

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Add template save state and modal**

```typescript
const [showSaveTemplateModal, setShowSaveTemplateModal] = useState(false);
const [templateName, setTemplateName] = useState('');
const [templateDescription, setTemplateDescription] = useState('');
```

**Step 2: Add "Save as Template" button**

In the QuoteBuilder toolbar (next to other action buttons):

```tsx
{quoteId && (
  <button onClick={() => setShowSaveTemplateModal(true)}
    className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
    <Copy className="w-4 h-4" />
    Save as Template
  </button>
)}
```

**Step 3: Build save template modal**

```tsx
{showSaveTemplateModal && (
  <Modal onClose={() => setShowSaveTemplateModal(false)} title="Save as Template">
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium mb-1">Template Name</label>
        <input value={templateName} onChange={e => setTemplateName(e.target.value)}
          placeholder="e.g., 2026 Soybean Program"
          className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
      </div>
      <div>
        <label className="block text-sm font-medium mb-1">Description (optional)</label>
        <textarea value={templateDescription} onChange={e => setTemplateDescription(e.target.value)}
          placeholder="When to use this template..."
          rows={2} className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg" />
      </div>
      <div className="flex justify-end gap-3">
        <button onClick={() => setShowSaveTemplateModal(false)} className="px-4 py-2 text-sm border rounded-lg">Cancel</button>
        <button onClick={handleSaveTemplate} disabled={!templateName.trim()}
          className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg disabled:opacity-50">
          Save Template
        </button>
      </div>
    </div>
  </Modal>
)}
```

**Step 4: Implement handler**

```typescript
const handleSaveTemplate = async () => {
  const { data, error } = await supabase.rpc('save_quote_template', {
    p_quote_id: quoteId,
    p_template_name: templateName.trim(),
    p_description: templateDescription.trim() || null,
    p_performed_by: profile.id,
  });
  if (error) { toast.error('Failed to save template'); return; }
  toast.success(`Template "${templateName}" saved`);
  setShowSaveTemplateModal(false);
  setTemplateName('');
  setTemplateDescription('');
};
```

**Step 5: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat(quotes): add Save as Template button and modal"
```

---

### Task 7.3: "New from Template" on New Quote Page

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Fetch templates on mount (for new quotes only)**

```typescript
const [templates, setTemplates] = useState<QuoteTemplate[]>([]);

useEffect(() => {
  if (!id) { // New quote
    supabase.from('quote_templates').select('*').eq('is_active', true).order('template_name')
      .then(({ data }) => { if (data) setTemplates(data); });
  }
}, [id]);
```

**Step 2: Add template selector dropdown (new quote only)**

Show at top of new quote form, before customer selector:

```tsx
{!id && templates.length > 0 && (
  <div className="flex items-center gap-3 p-4 bg-gray-50 rounded-lg mb-4">
    <label className="text-sm font-medium">Start from Template:</label>
    <select onChange={handleSelectTemplate} defaultValue=""
      className="text-sm border border-gray-200 rounded-lg px-3 py-1.5">
      <option value="">Blank Quote</option>
      {templates.map(t => (
        <option key={t.id} value={t.id}>{t.template_name}</option>
      ))}
    </select>
  </div>
)}
```

**Step 3: Implement template selection handler**

When a template is selected AND a customer is already chosen:

```typescript
const handleSelectTemplate = async (e: React.ChangeEvent<HTMLSelectElement>) => {
  const templateId = e.target.value;
  if (!templateId || !customerId) {
    // If no customer yet, store template selection and apply after customer is picked
    setSelectedTemplateId(templateId);
    return;
  }
  const { data, error } = await supabase.rpc('create_quote_from_template', {
    p_template_id: templateId,
    p_customer_id: customerId,
    p_performed_by: profile.id,
  });
  if (error) { toast.error('Failed to create from template'); return; }
  navigate(`/quotes/${data.quote_id}`);
};
```

**Step 4: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 5: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat(quotes): add Start from Template dropdown on new quote page"
```

---

## Sprint 8: Notes Flow Through Pipeline

### Task 8.1: Migration — Pipeline Notes

**Files:**
- Create: `supabase/migrations/20260316700000_notes_pipeline_flow.sql`

**Step 1: Write the migration**

Check if `order_items.notes` and `delivery_items.notes` exist (they do based on exploration). Update `convert_quote_to_order` to copy notes:

```sql
-- Update convert_quote_to_order to copy item notes from quote to order
-- Find the INSERT INTO order_items section and add qi.notes

-- Also ensure delivery creation copies notes from order_items
-- delivery_items.notes already exists in schema

-- Add notes to order_sections if applicable, or add order-level field
-- for section header notes context
ALTER TABLE orders ADD COLUMN IF NOT EXISTS program_notes text;
```

**Step 2: Update convert_quote_to_order RPC**

The current RPC creates order_items from quote_items. Find the INSERT INTO order_items statement and ensure `notes` is included in the column list, sourcing from `qi.notes`.

Read the latest `convert_quote_to_order` (in `20260331500000`) and create an updated version that adds `notes` to the order_items insert.

**Step 3: Commit**

```bash
git add supabase/migrations/20260316700000_notes_pipeline_flow.sql
git commit -m "feat(db): copy product notes through quote → order → delivery pipeline"
```

---

### Task 8.2: Update Delivery Creation to Copy Notes

**Files:**
- Search for the delivery creation logic (likely in `NewDelivery.tsx` or a `create_delivery` RPC)

**Step 1: Find delivery item creation**

When delivery items are created from order items, ensure `notes` is copied:

```typescript
// In the delivery item creation:
delivery_items.notes = order_item.notes;
```

**Step 2: Update Load Sheet PDF**

Find the load sheet PDF generator (likely `src/lib/deliveryPdf.ts` or similar). Add a "Notes" column to the load sheet table so drivers see product application info.

**Step 3: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 4: Commit**

```bash
git add src/
git commit -m "feat(delivery): copy notes from order items and display on load sheet PDF"
```

---

## Sprint 9: Customer Detail — Quotes & Programs Tabs

### Task 9.1: Add Quotes Tab to CustomerDetail

**Files:**
- Modify: `src/pages/CustomerDetail.tsx`

**Step 1: The tab system already includes 'quotes' in the type union (line 72)**

Verify that the `quotes` tab exists. If lazy-loading isn't wired for it yet, add:

```typescript
// In fetchTabData callback:
case 'quotes': {
  const { data } = await supabase
    .from('quotes')
    .select('*, customer:customers(farm_name)')
    .eq('customer_id', id)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  setCustomerQuotes(data || []);
  break;
}
```

**Step 2: Render quotes tab content**

```tsx
{tab === 'quotes' && (
  <div className="space-y-4">
    {/* Filter: All | Planned Programs */}
    <div className="flex gap-2">
      <button onClick={() => setQuotePlannedFilter(false)}
        className={`px-3 py-1.5 text-sm rounded-lg ${!quotePlannedFilter ? 'bg-crx-green text-white' : 'border'}`}>
        All Quotes
      </button>
      <button onClick={() => setQuotePlannedFilter(true)}
        className={`px-3 py-1.5 text-sm rounded-lg ${quotePlannedFilter ? 'bg-amber-100 text-amber-800' : 'border'}`}>
        Planned Programs
      </button>
    </div>
    <DataTable
      columns={quoteColumns}
      data={filteredQuotes}
      onRowClick={(q) => navigate(`/quotes/${q.id}`)}
    />
  </div>
)}
```

**Step 3: Define quote columns**

```typescript
const quoteColumns: Column<Quote>[] = [
  { key: 'quote_number', header: 'Quote #', sortable: true },
  { key: 'status', header: 'Status', sortable: true, render: (q) => <StatusBadge status={q.status} /> },
  { key: 'total_price', header: 'Total', sortable: true, className: 'text-right', render: (q) => formatCurrency(q.total_price) },
  { key: 'created_at', header: 'Created', sortable: true, render: (q) => formatDate(q.created_at) },
  { key: 'expires_at', header: 'Expires', sortable: true, render: (q) => q.expires_at ? formatDate(q.expires_at) : '-' },
];
```

**Step 4: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 5: Commit**

```bash
git add src/pages/CustomerDetail.tsx
git commit -m "feat(customers): add Quotes tab with planned programs filter"
```

---

## Sprint 10: Inventory Forecasting Dashboard

### Task 10.1: Migration — Forecasting RPC

**Files:**
- Create: `supabase/migrations/20260316800000_inventory_forecasting.sql`

**Step 1: Write the migration**

```sql
-- RPC: get_inventory_forecast
-- Aggregates planned demand vs supply by product and month
CREATE OR REPLACE FUNCTION public.get_inventory_forecast(
  p_months_ahead integer DEFAULT 6
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(row_to_json(r)), '[]'::jsonb)
    FROM (
      SELECT
        p.id AS product_id,
        p.product_name,
        p.sku,
        DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))::date AS needed_month,
        SUM(ih.quantity) AS planned_demand,
        (SELECT COALESCE(i.quantity_available, 0) FROM inventory i WHERE i.product_id = p.id LIMIT 1) AS current_available,
        (SELECT COALESCE(i.quantity_prebooked, 0) FROM inventory i WHERE i.product_id = p.id LIMIT 1) AS prebooked,
        (SELECT COALESCE(SUM(poi.quantity_ordered - poi.quantity_received), 0)
         FROM purchase_order_items poi
         JOIN purchase_orders po ON po.id = poi.purchase_order_id
         WHERE poi.product_id = p.id AND po.status IN ('submitted', 'partially_received')
        ) AS on_order,
        COUNT(DISTINCT ih.source_id) AS quote_count,
        COUNT(DISTINCT ih.customer_id) AS customer_count
      FROM inventory_holds ih
      JOIN products p ON p.id = ih.product_id
      WHERE ih.is_active = true
        AND ih.hold_type = 'crop_program'
        AND (ih.expires_at - INTERVAL '14 days') <= CURRENT_DATE + (p_months_ahead || ' months')::interval
      GROUP BY p.id, p.product_name, p.sku,
        DATE_TRUNC('month', (ih.expires_at - INTERVAL '14 days'))
      ORDER BY needed_month, p.product_name
    ) r
  );
END;
$$;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260316800000_inventory_forecasting.sql
git commit -m "feat(db): add get_inventory_forecast RPC for planned demand aggregation"
```

---

### Task 10.2: Forecast Tab on Inventory Page

**Files:**
- Modify: `src/pages/InventoryPage.tsx`

**Step 1: Add "Forecast" tab**

Find the tab system in InventoryPage and add a "Forecast" tab.

**Step 2: Fetch forecast data**

```typescript
const [forecastData, setForecastData] = useState<InventoryForecast[]>([]);

const fetchForecast = async () => {
  const { data } = await supabase.rpc('get_inventory_forecast', { p_months_ahead: 6 });
  if (data) setForecastData(data);
};
```

**Step 3: Render forecast table**

Show a table with columns:
- Product Name
- Needed Month
- Planned Demand (quantity from holds)
- Available (current_available)
- On Order
- Prebooked
- **Net Gap** = planned_demand - (available + on_order - prebooked)
  - Red highlight when gap > 0 (shortfall)
  - Green when supply exceeds demand

```tsx
{tab === 'forecast' && (
  <div>
    <h3 className="text-lg font-semibold mb-4">Planned Demand Forecast</h3>
    <DataTable
      columns={forecastColumns}
      data={forecastData}
    />
    {forecastData.some(f => f.planned_demand > (f.current_available + f.on_order - f.prebooked)) && (
      <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
        <AlertTriangle className="w-4 h-4 inline mr-2" />
        Some products have demand exceeding available supply. Consider placing purchase orders.
      </div>
    )}
  </div>
)}
```

**Step 4: Define forecast columns**

```typescript
const forecastColumns = [
  { key: 'product_name', header: 'Product', sortable: true },
  { key: 'needed_month', header: 'Needed', sortable: true, render: (r) => formatMonth(r.needed_month) },
  { key: 'planned_demand', header: 'Planned Demand', className: 'text-right', render: (r) => formatNumber(r.planned_demand) },
  { key: 'current_available', header: 'Available', className: 'text-right', render: (r) => formatNumber(r.current_available) },
  { key: 'on_order', header: 'On Order', className: 'text-right', render: (r) => formatNumber(r.on_order) },
  { key: 'net_gap', header: 'Gap', className: 'text-right', render: (r) => {
    const gap = r.planned_demand - (r.current_available + r.on_order - r.prebooked);
    return <span className={gap > 0 ? 'text-red-600 font-bold' : 'text-crx-green'}>{gap > 0 ? `-${formatNumber(gap)}` : 'OK'}</span>;
  }},
  { key: 'quote_count', header: 'Quotes', className: 'text-right' },
  { key: 'customer_count', header: 'Customers', className: 'text-right' },
];
```

**Step 5: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 6: Commit**

```bash
git add src/pages/InventoryPage.tsx
git commit -m "feat(inventory): add Forecast tab showing planned demand vs supply with gap alerts"
```

---

## Sprint 11: Seasonal Program Rollover

### Task 11.1: Migration — Rollover RPC

**Files:**
- Create: `supabase/migrations/20260316900000_seasonal_rollover.sql`

**Step 1: Write the migration**

```sql
-- RPC: rollover_quote_to_season
-- Duplicates a quote into a new season with updated pricing
CREATE OR REPLACE FUNCTION public.rollover_quote_to_season(
  p_quote_id uuid,
  p_new_season integer,
  p_performed_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_old_quote quotes%ROWTYPE;
  v_new_quote_id uuid;
  v_new_quote_number text;
  v_section RECORD;
  v_new_section_id uuid;
  v_item RECORD;
  v_tier_price numeric;
  v_current_cost numeric;
BEGIN
  SELECT * INTO v_old_quote FROM quotes WHERE id = p_quote_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Quote not found: %', p_quote_id; END IF;

  SELECT generate_quote_number() INTO v_new_quote_number;

  -- Create new quote (reset dates, status, season)
  INSERT INTO quotes (
    quote_number, customer_id, created_by, tier, status, is_planned,
    commission_split, valid_days, header_notes, footer_notes, season, salesman_id
  ) VALUES (
    v_new_quote_number, v_old_quote.customer_id, p_performed_by, v_old_quote.tier,
    'draft', v_old_quote.is_planned, v_old_quote.commission_split,
    v_old_quote.valid_days, v_old_quote.header_notes, v_old_quote.footer_notes,
    p_new_season, v_old_quote.salesman_id
  ) RETURNING id INTO v_new_quote_id;

  -- Copy sections (reset needed_by_date)
  FOR v_section IN
    SELECT * FROM quote_sections WHERE quote_id = p_quote_id ORDER BY sort_order
  LOOP
    INSERT INTO quote_sections (quote_id, section_name, sort_order, section_notes, section_header_notes)
    VALUES (v_new_quote_id, v_section.section_name, v_section.sort_order,
      v_section.section_notes, v_section.section_header_notes)
    RETURNING id INTO v_new_section_id;

    -- Copy items with UPDATED pricing
    FOR v_item IN
      SELECT * FROM quote_items WHERE section_id = v_section.id ORDER BY sort_order
    LOOP
      -- Get current tier price
      SELECT CASE v_old_quote.tier
        WHEN 1 THEN COALESCE(p.tier1_price, 0)
        WHEN 2 THEN COALESCE(p.tier2_price, p.tier1_price, 0)
        WHEN 3 THEN COALESCE(p.tier3_price, p.tier1_price, 0)
        ELSE COALESCE(p.tier1_price, 0)
      END, p.current_cost
      INTO v_tier_price, v_current_cost
      FROM products p WHERE p.id = v_item.product_id;

      INSERT INTO quote_items (
        quote_id, section_id, product_id, sort_order, notes,
        price_per_unit, current_cost, suggested_rate, actual_rate, rate_unit,
        acres, calc_mode, price_unit
      ) VALUES (
        v_new_quote_id, v_new_section_id, v_item.product_id, v_item.sort_order,
        v_item.notes, v_tier_price, v_current_cost, v_item.suggested_rate,
        v_item.actual_rate, v_item.rate_unit, v_item.acres,
        v_item.calc_mode, v_item.price_unit
      );
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'created',
    'quote_id', v_new_quote_id,
    'quote_number', v_new_quote_number,
    'season', p_new_season
  );
END;
$$;
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260316900000_seasonal_rollover.sql
git commit -m "feat(db): add rollover_quote_to_season RPC with updated pricing"
```

---

### Task 11.2: Rollover Button in QuoteBuilder

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1: Add rollover state and modal**

```typescript
const [showRolloverModal, setShowRolloverModal] = useState(false);
const [rolloverSeason, setRolloverSeason] = useState(new Date().getFullYear() + 1);
```

**Step 2: Add "Roll Over to New Season" button**

In the toolbar (visible only for existing quotes):

```tsx
{quoteId && (
  <button onClick={() => setShowRolloverModal(true)}
    className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-gray-50">
    <RotateCcw className="w-4 h-4" />
    Roll Over to New Season
  </button>
)}
```

**Step 3: Build rollover modal**

```tsx
{showRolloverModal && (
  <Modal onClose={() => setShowRolloverModal(false)} title="Roll Over to New Season">
    <div className="space-y-4">
      <p className="text-sm text-secondary">
        Creates a new draft quote with the same products and program structure,
        but with updated pricing from current product prices.
        Need dates will be reset.
      </p>
      <div>
        <label className="block text-sm font-medium mb-1">Target Season</label>
        <input type="number" value={rolloverSeason}
          onChange={e => setRolloverSeason(parseInt(e.target.value))}
          className="w-32 px-3 py-2 text-sm border border-gray-200 rounded-lg" />
      </div>
      <div className="flex justify-end gap-3">
        <button onClick={() => setShowRolloverModal(false)} className="px-4 py-2 text-sm border rounded-lg">Cancel</button>
        <button onClick={handleRollover}
          className="px-4 py-2 text-sm bg-crx-green text-white rounded-lg">
          Roll Over
        </button>
      </div>
    </div>
  </Modal>
)}
```

**Step 4: Implement handler**

```typescript
const handleRollover = async () => {
  const { data, error } = await supabase.rpc('rollover_quote_to_season', {
    p_quote_id: quoteId,
    p_new_season: rolloverSeason,
    p_performed_by: profile.id,
  });
  if (error) { toast.error('Failed to roll over quote'); return; }
  toast.success(`Rolled over to ${rolloverSeason} — ${data.quote_number}`);
  navigate(`/quotes/${data.quote_id}`);
};
```

**Step 5: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 6: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat(quotes): add Roll Over to New Season button with updated pricing"
```

---

## Sprint 12: Quick Quote from Customer Page

### Task 12.1: Add Quick Quote Buttons to CustomerDetail

**Files:**
- Modify: `src/pages/CustomerDetail.tsx`

**Step 1: Add "New Quote" button in customer header**

Find the header area (where customer name and action buttons are). Add:

```tsx
<button
  onClick={() => navigate(`/quotes/new?customer_id=${id}`)}
  className="flex items-center gap-2 px-3 py-1.5 text-sm bg-crx-green text-white rounded-lg hover:bg-crx-green-dark"
>
  <Plus className="w-4 h-4" />
  New Quote
</button>
```

**Step 2: Add "New from Last Quote" button**

```tsx
{customerQuotes.length > 0 && (
  <button
    onClick={handleNewFromLastQuote}
    className="flex items-center gap-2 px-3 py-1.5 text-sm border border-crx-green text-crx-green rounded-lg hover:bg-crx-green-tint"
  >
    <Copy className="w-4 h-4" />
    New from Last Quote
  </button>
)}
```

**Step 3: Implement handler**

```typescript
const handleNewFromLastQuote = async () => {
  const lastQuote = customerQuotes[0]; // already sorted by created_at DESC
  const { data, error } = await supabase.rpc('duplicate_quote', {
    p_quote_id: lastQuote.id,
    p_performed_by: profile.id,
  });
  if (error) { toast.error('Failed to duplicate quote'); return; }
  navigate(`/quotes/${data.quote_id}`);
};
```

**Step 4: Handle customer_id query parameter in QuoteBuilder**

In QuoteBuilder, on mount for new quotes, check for `customer_id` param:

```typescript
useEffect(() => {
  if (!id) {
    const params = new URLSearchParams(location.search);
    const presetCustomerId = params.get('customer_id');
    if (presetCustomerId) {
      setCustomerId(presetCustomerId);
      // Auto-set tier and commission from customer
    }
  }
}, [id]);
```

**Step 5: Run build and tests**

Run: `npm run build && npx vitest run`

**Step 6: Commit**

```bash
git add src/pages/CustomerDetail.tsx src/pages/QuoteBuilder.tsx
git commit -m "feat(customers): add New Quote and New from Last Quote buttons on customer page"
```

---

## Testing Strategy

Each sprint should include:

1. **Unit tests** for any new utility functions (quoteCalc, dateUtils, etc.)
2. **Component tests** for new UI elements (version panel, column picker, preview modal)
3. **E2E test updates** for modified workflows (quote send → preview flow)
4. **Migration tests** via local Supabase (verify RPCs return expected shapes)

### Key E2E Scenarios to Add

- `tests/e2e/quote-versioning.spec.ts` — create quote, present, edit, present again, view versions, restore
- `tests/e2e/quote-preview-workflow.spec.ts` — preview, download, mark presented
- `tests/e2e/planned-programs.spec.ts` — create planned quote, verify holds, check dashboard alert
- `tests/e2e/quote-templates.spec.ts` — save template from quote, create new quote from template
- `tests/e2e/quote-pdf-presets.spec.ts` — select preset, customize columns, verify PDF content

---

## Dependency Order

Sprints must be executed in order 1→12. Key dependencies:

- Sprint 2 (versioning) depends on Sprint 1 (product notes for snapshot data)
- Sprint 3 (send workflow) depends on Sprint 2 (version creation on present)
- Sprint 4 (notes auto-pull) depends on Sprint 1 (grower description label)
- Sprint 5 (PDF presets) depends on Sprint 4 (notes column in PDF)
- Sprint 6 (planned programs) depends on Sprint 4 (section header notes for needed_by_date UI)
- Sprint 7 (templates) can run after Sprint 4
- Sprint 8 (pipeline flow) can run after Sprint 4
- Sprint 9 (customer tabs) can run after Sprint 6
- Sprint 10 (forecasting) depends on Sprint 6 (planned holds data)
- Sprint 11 (rollover) can run after Sprint 7
- Sprint 12 (quick quote) can run after Sprint 9
