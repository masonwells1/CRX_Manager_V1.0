# Launch Readiness UX — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make CRX Manager self-explanatory for 3 users (admin, sales admin, driver) going live 2026-03-20. Add contextual help tips, enhanced empty states, a Getting Started page, and an RLS security fix.

**Architecture:** New `HelpTip` component (click-to-show popover), enhanced `EmptyState` usage on 4 pages, new `GettingStarted` page with role-aware content, one SQL migration for RLS. No external libraries — pure Tailwind + Lucide icons.

**Tech Stack:** React 18, TypeScript, Tailwind CSS, Lucide React icons, Supabase (migration only)

---

## Task 1: HelpTip Component

**Files:**
- Create: `src/components/ui/HelpTip.tsx`
- Test: `src/components/ui/HelpTip.test.tsx`

**Step 1: Write the test**

```tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import HelpTip from './HelpTip';

describe('HelpTip', () => {
  it('renders the help icon', () => {
    render(<HelpTip text="Test tip" />);
    expect(screen.getByRole('button', { name: /help/i })).toBeInTheDocument();
  });

  it('shows tip text when clicked', () => {
    render(<HelpTip text="Test tip content" />);
    fireEvent.click(screen.getByRole('button', { name: /help/i }));
    expect(screen.getByText('Test tip content')).toBeInTheDocument();
  });

  it('hides tip when clicked again', () => {
    render(<HelpTip text="Test tip content" />);
    const btn = screen.getByRole('button', { name: /help/i });
    fireEvent.click(btn);
    expect(screen.getByText('Test tip content')).toBeInTheDocument();
    fireEvent.click(btn);
    expect(screen.queryByText('Test tip content')).not.toBeInTheDocument();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/ui/HelpTip.test.tsx`
Expected: FAIL — module not found

**Step 3: Write the component**

```tsx
import { useState, useRef, useEffect } from 'react';
import { HelpCircle } from 'lucide-react';

interface HelpTipProps {
  text: string;
  className?: string;
}

export default function HelpTip({ text, className = '' }: HelpTipProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  return (
    <div ref={ref} className={`relative inline-flex items-center ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-label="help"
        className="text-gray-400 hover:text-crx-green transition-colors p-0.5"
      >
        <HelpCircle className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute z-50 bottom-full left-1/2 -translate-x-1/2 mb-2 w-72 p-3 bg-white border border-gray-200 rounded-lg shadow-lg text-sm text-gray-700 leading-relaxed">
          <div className="absolute top-full left-1/2 -translate-x-1/2 -mt-px border-4 border-transparent border-t-white" />
          <div className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-gray-200" />
          {text}
        </div>
      )}
    </div>
  );
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/ui/HelpTip.test.tsx`
Expected: PASS (3 tests)

**Step 5: Commit**

```bash
git add src/components/ui/HelpTip.tsx src/components/ui/HelpTip.test.tsx
git commit -m "feat: add HelpTip component for contextual help"
```

---

## Task 2: Getting Started Page + Route + Sidebar Link

**Files:**
- Create: `src/pages/GettingStarted.tsx`
- Modify: `src/App.tsx:16` (add lazy import), `src/App.tsx:152` (add route)
- Modify: `src/components/layout/Sidebar.tsx:3` (add BookOpen import), `src/components/layout/Sidebar.tsx:76` (add nav entry)

**Step 1: Create the page**

Create `src/pages/GettingStarted.tsx` with:
- `useAuth()` to get `profile.role`
- Admin/Sales view: visual stepper (Quote → Send → Convert → Deliver → Invoice) using Tailwind flex + icons
- Driver view: simpler stepper (Dashboard → Start Delivery → Signature & Photos → Complete)
- Each step links to the relevant page via `useNavigate()`
- "Don't show on login" checkbox using `localStorage.getItem('crx_hide_getting_started')`
- Each section card uses existing card pattern (bg-white rounded-lg border p-4 shadow-sm)

Key elements:
- Stepper: horizontal flex with `FileText → Send → ShoppingCart → Truck → Receipt` icons connected by arrows
- Driver stepper: `LayoutDashboard → PlayCircle → Camera → CheckCircle2` icons
- Section cards with 2-3 sentence descriptions and "Go to [Page]" buttons
- Use `crx-green` for active step indicators

**Step 2: Add lazy import to App.tsx**

After line 72 (`const SalesReports = lazy(...)`), add:
```tsx
const GettingStarted = lazy(() => import('./pages/GettingStarted'));
```

**Step 3: Add route to App.tsx**

After line 153 (`{ path: 'notifications', element: <Notifications /> },`), add:
```tsx
{ path: 'getting-started', element: <GettingStarted /> },
```

**Step 4: Add sidebar link**

In `src/components/layout/Sidebar.tsx`:

Add `BookOpen` to the Lucide import (line 3-38).

Add nav entry after the Dashboard standalone link (after line 84), before the Sales category:
```tsx
{
  type: 'standalone',
  link: {
    id: 'getting-started',
    path: '/getting-started',
    label: 'Getting Started',
    icon: <BookOpen className="w-5 h-5" />,
  },
},
```

**Step 5: Run build + tests**

Run: `npm run build && npx vitest run`
Expected: clean build, all tests pass

**Step 6: Commit**

```bash
git add src/pages/GettingStarted.tsx src/App.tsx src/components/layout/Sidebar.tsx
git commit -m "feat: add Getting Started page with role-aware workflow guide"
```

---

## Task 3: Enhanced Empty States

**Files:**
- Modify: `src/pages/Quotes.tsx` — update EmptyState props
- Modify: `src/pages/Orders.tsx` — update EmptyState props
- Modify: `src/pages/Deliveries.tsx` — update EmptyState props
- Modify: `src/pages/TeamBoard.tsx` — add EmptyState when no notes

For each page, find the existing EmptyState or DataTable `emptyTitle`/`emptyDescription` props and update them with the workflow-guiding text from the design doc. Add action buttons that navigate to the next logical step.

**Quotes.tsx:**
- Find: `emptyTitle` prop on DataTable → change to `"No quotes yet"`
- Find: `emptyDescription` → change to `"Quotes are the first step — build a quote, send it to your customer, then convert it to an order."`
- Add `emptyAction` button: "Create Your First Quote" → `navigate('/quotes/new')`
- Import `FileText` icon from Lucide for the empty state icon

**Orders.tsx:**
- Find: `emptyTitle` → `"No orders yet"`
- Find: `emptyDescription` → `"Start by creating a quote in Sales → Quotes, then convert it to an order. Or create a direct order below."`
- Add `emptyAction`: two buttons side by side — "New Quote" → `/quotes/new`, "New Order" → `/orders/new`

**Deliveries.tsx:**
- Find: `emptyTitle` → `"No deliveries scheduled"`
- Find: `emptyDescription` → `"Deliveries are created from orders. Open an order and click 'Schedule Delivery' to get started."`
- Add `emptyAction`: "View Orders" → `/orders`

**TeamBoard.tsx:**
- Find the empty state or add one when `notes.length === 0`
- Title: `"Your team board is empty"`
- Description: `"Create notes, tasks, and announcements to keep your team coordinated."`
- Action: "Create First Note" button that triggers the create note flow (existing `setShowCreateNote(true)` or equivalent)

**Step 1: Update each page** (read each file first to find exact insertion points)

**Step 2: Run build + tests**

Run: `npm run build && npx vitest run`
Expected: clean build, all tests pass

**Step 3: Commit**

```bash
git add src/pages/Quotes.tsx src/pages/Orders.tsx src/pages/Deliveries.tsx src/pages/TeamBoard.tsx
git commit -m "feat: enhance empty states with workflow guidance on core pages"
```

---

## Task 4: QuoteBuilder Help Tips (8 tips)

**Files:**
- Modify: `src/pages/QuoteBuilder.tsx`

**Step 1:** Read `QuoteBuilder.tsx` fully to find exact insertion points for each tip.

**Step 2:** Add `import HelpTip from '../components/ui/HelpTip';` at top.

**Step 3:** Add 8 HelpTip components next to the relevant UI elements:

| Find this element | Add HelpTip with text |
|---|---|
| "Planned" / `is_planned` toggle | "Mark as Planned if the customer intends to buy but hasn't committed yet. This reserves inventory with a hold so it's not sold to someone else. Set the Needed By date so you can forecast when product will move." |
| `needed_by_date` input/label | "This is when the customer needs the product — different from the quote expiration. Used for inventory forecasting and delivery scheduling." |
| Section header notes label/input | "These notes print above the items in the PDF. Use for delivery instructions like 'Apply before 10am' or 'Requires cool storage'." |
| "Send Quote" button area | "Sends the quote PDF to the customer's email and locks it as 'Sent'. A version snapshot is saved automatically so you can always see what the customer received." |
| "View History" / version history button | "Every time you send or revise, a snapshot is saved. You can compare versions side-by-side or restore an older version if needed." |
| "Convert to Order" button | "Creates a confirmed order from this quote. Inventory holds transfer to the order and the customer gets a confirmation email." |
| "Save as Template" button | "Saves this quote's structure as a reusable template. Great for customers who reorder the same products each season." |
| "Roll Over" button | "Copies this planned program into the next season (Oct–Sep) with the same products and quantities. Dates update automatically." |

Place each `<HelpTip text="..." />` inline next to (after) the label or button, using `className="ml-1"` for spacing.

**Step 4: Run build**

Run: `npm run build`
Expected: clean build

**Step 5: Commit**

```bash
git add src/pages/QuoteBuilder.tsx
git commit -m "feat: add contextual help tips to QuoteBuilder"
```

---

## Task 5: OrderDetail Help Tips (5 tips)

**Files:**
- Modify: `src/pages/OrderDetail.tsx`

**Step 1:** Read `OrderDetail.tsx` to find insertion points.

**Step 2:** Add `import HelpTip from '../components/ui/HelpTip';`

**Step 3:** Add 5 HelpTips:

| Find this element | Tip text |
|---|---|
| "Schedule Delivery" button | "Creates a new delivery from this order's items. The driver will see it on their dashboard and can start it when ready." |
| "Create Invoice" button | "Generates a draft invoice from the order. It stays in draft until you review and post it — nothing is sent to the customer yet." |
| Fulfillment % progress bar/label | "Shows how much of the order has been delivered, weighted by dollar value. 100% means all items are fully delivered." |
| Program notes label/section | "Notes about this order that carry through to the load sheet and delivery. Use for special instructions like 'Call before delivering'." |
| Inventory warning banner | "This means available inventory is lower than the order quantity. The order still goes through — this is a heads-up so you can reorder if needed." |

**Step 4: Run build**

Run: `npm run build`

**Step 5: Commit**

```bash
git add src/pages/OrderDetail.tsx
git commit -m "feat: add contextual help tips to OrderDetail"
```

---

## Task 6: DeliveryDetail Help Tips (6 tips)

**Files:**
- Modify: `src/pages/DeliveryDetail.tsx`

**Step 1:** Read `DeliveryDetail.tsx` to find insertion points.

**Step 2:** Add `import HelpTip from '../components/ui/HelpTip';`

**Step 3:** Add 6 HelpTips:

| Find this element | Tip text |
|---|---|
| "Start Delivery" button | "Marks this delivery as in-progress. You can now adjust quantities, capture photos, and get the customer's signature." |
| Photo upload section label | "Take up to 10 photos as proof of delivery — product condition, drop location, etc. These attach to the delivery record and can be included in the customer email." |
| Signature canvas label | "Have the customer sign with their finger or mouse. This saves as part of the delivery record for your files." |
| "Complete Delivery" button | "Finalizes the delivery. Inventory is deducted, the customer gets an email receipt, and a draft invoice is created automatically." |
| Email receipt checkbox | "If checked, the customer receives an email with the items delivered, photos, and signature. Uncheck if this is an internal transfer." |
| Quantity adjustment section (partial delivery) | "Adjust quantities down if you couldn't deliver everything. The remaining items automatically create a follow-up delivery." |

**Step 4: Run build**

Run: `npm run build`

**Step 5: Commit**

```bash
git add src/pages/DeliveryDetail.tsx
git commit -m "feat: add contextual help tips to DeliveryDetail"
```

---

## Task 7: TeamBoard Help Tips (4 tips)

**Files:**
- Modify: `src/pages/TeamBoard.tsx`

**Step 1:** Read `TeamBoard.tsx` to find insertion points.

**Step 2:** Add `import HelpTip from '../components/ui/HelpTip';`

**Step 3:** Add 4 HelpTips:

| Find this element | Tip text |
|---|---|
| Create note button | "Notes can be tasks, reminders, or announcements. Assign to a team member, set a due date, and link to an order or delivery for context." |
| Entity link dropdown (in create/edit modal) | "Link this note to an order, quote, delivery, or customer. The note will show up on that record's detail page too." |
| Tags section/filter | "Color-coded tags help organize notes. Filter by tag to see only what's relevant — like 'Urgent' or 'Follow-up'." |
| Delivery bulletin section (TodaysDeliveries) | "Shows today's scheduled deliveries and yesterday's completed ones. Quick way to see what's moving without leaving the board." |

**Step 4: Run build**

Run: `npm run build`

**Step 5: Commit**

```bash
git add src/pages/TeamBoard.tsx
git commit -m "feat: add contextual help tips to TeamBoard"
```

---

## Task 8: List Page Help Tips (3 tips)

**Files:**
- Modify: `src/pages/Quotes.tsx`
- Modify: `src/pages/Orders.tsx`
- Modify: `src/pages/Deliveries.tsx`

**Step 1:** Read each file to find badge/column rendering locations.

**Step 2:** Add HelpTip import to each file.

**Step 3:** Add tips:

- **Quotes.tsx** — next to the "Planned" badge/filter toggle: "Planned quotes reserve inventory but aren't committed orders yet. Use the Planned Programs filter to see all of them."
- **Orders.tsx** — next to the Fulfillment/Invoiced column headers: "Fulfillment shows delivery progress. Invoiced shows billing progress. Both are weighted by dollar value."
- **Deliveries.tsx** — next to the shortage warning icon column: "This delivery has items where warehouse stock is running low. Check inventory before dispatching."

**Step 4: Run build**

Run: `npm run build`

**Step 5: Commit**

```bash
git add src/pages/Quotes.tsx src/pages/Orders.tsx src/pages/Deliveries.tsx
git commit -m "feat: add help tips to Quotes, Orders, and Deliveries list pages"
```

---

## Task 9: RLS Migration

**Files:**
- Create: `supabase/migrations/20260319200000_rate_limit_log_rls.sql`

**Step 1: Write the migration**

```sql
-- Enable RLS and add deny-all policy on rate_limit_log
-- This table is only accessed by SECURITY DEFINER functions, not directly by users
ALTER TABLE rate_limit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Deny all direct access to rate_limit_log"
  ON rate_limit_log
  FOR ALL
  USING (false);
```

**Step 2: Commit**

```bash
git add supabase/migrations/20260319200000_rate_limit_log_rls.sql
git commit -m "fix: add deny-all RLS policy to rate_limit_log table"
```

---

## Task 10: Final Build + Test + Doc Updates

**Files:**
- Modify: `CLAUDE.md` — update page count (56 → 57)
- Modify: `docs/reference/pages-routes.md` — add Getting Started entry
- Modify: `docs/reference/migration-history.md` — add RLS migration entry
- Modify: `docs/CHANGELOG.md` — add session entry

**Step 1: Run full build + test suite**

```bash
npm run lint && npm run build && npx vitest run
```

Expected: 0 errors, clean build, all tests pass

**Step 2: Update docs**

- `CLAUDE.md` line with page count: `57 pages` (was 56)
- `CLAUDE.md` line with migration count: `212 migrations` (was 211)
- Add to `docs/reference/pages-routes.md`: `| /getting-started | GettingStarted | All roles | Getting Started guide |`
- Add to `docs/reference/migration-history.md`: `| 20260319200000 | rate_limit_log_rls | RLS deny-all on rate_limit_log |`
- Add to `docs/CHANGELOG.md`: session entry summarizing all changes

**Step 3: Commit**

```bash
git add CLAUDE.md docs/reference/pages-routes.md docs/reference/migration-history.md docs/CHANGELOG.md
git commit -m "docs: update docs for launch readiness UX session"
```

---

## Task 11: Deploy to Vercel + Apply Migration

**Step 1: Apply RLS migration to Supabase production**

Use Supabase MCP tool `execute_sql` to run the migration SQL against project `rhyzpcqhnizqbxphqdkr`.

**Step 2: Push to main**

```bash
git push origin main
```

Vercel auto-deploys from main.

**Step 3: Verify deployment**

Check Vercel deployment status and verify the Getting Started page loads at `https://croprxsolutions.app/getting-started`.
