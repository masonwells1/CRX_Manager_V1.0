---
name: new-page
description: Scaffold a new page in CRX Manager with lazy import, Route, nav link, and documentation updates. Use when the user wants to add a new page or screen to the app.
---

# Add New Page

Scaffold a complete new page with all the wiring CRX Manager requires — component file, lazy import, route, nav link, and doc updates.

## Step 1: Gather Requirements

Ask the user (skip if they already described it):
- **Page name** — What should the page be called? (e.g., "Tote Tracking")
- **Route path** — What URL path? (e.g., `/tote-tracking`)
- **Nav section** — Which nav group? (Operations, Sales, Inventory, Finance, Settings, Admin)
- **Role access** — Who can see it? (admin only, all roles, specific roles)
- **Purpose** — One sentence about what the page does

## Step 2: Create the Page Component

Create `src/pages/<PageName>.tsx` following the standard pattern:

```typescript
import { useState, useEffect } from 'react';
import { supabase, checkMutationResult } from '../lib/db';
import { useAuth } from '../contexts/AuthContext';

export default function PageName() {
  const { profile } = useAuth();

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Page Title</h1>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">Page content goes here.</p>
      </div>
    </div>
  );
}
```

Key rules:
- Use Tailwind CSS only (brand color: `crx-green` / `#28A26A`)
- Lucide React icons only
- Export as `default` function (required for lazy loading)

## Step 3: Wire Up the Route

### 3a. Add lazy import to `src/App.tsx`

Find the lazy import block (they're grouped alphabetically) and add:

```typescript
const PageName = lazy(() => import('./pages/PageName'));
```

### 3b. Add Route

Find the `<Routes>` section in App.tsx. Add the route in the appropriate section:

```tsx
<Route path="/route-path" element={
  <Suspense fallback={<LoadingSpinner />}>
    <PageName />
  </Suspense>
} />
```

If the page is role-restricted, wrap it in the existing role guard pattern used by other restricted pages.

### 3c. Add Nav Link

Edit `src/components/AppLayout.tsx`. Find the navigation section for the correct group and add the link:

```typescript
{ name: 'Page Title', href: '/route-path', icon: IconName }
```

Choose an appropriate Lucide icon that matches the page's purpose.

## Step 4: Update Documentation

### pages-routes.md
Read `docs/reference/pages-routes.md` and add a new row:

| Route | Page Component | Description | Access |
|-------|---------------|-------------|--------|
| /route-path | PageName | One-line description | Role info |

### CLAUDE.md
Read `CLAUDE.md` and update the page count in the "Current State" line (increment by 1).

## Step 5: Verify

```bash
cd /c/Users/mason/CRX_Manager_V1.0 && npm run typecheck && npm run build
```

Fix any errors before reporting done.

## Step 6: Print Summary

```
=== New Page Created ===

Component: src/pages/PageName.tsx
Route:     /route-path
Nav:       Added to [section] nav group
Icon:      [IconName] from lucide-react

Docs updated:
  - docs/reference/pages-routes.md (new entry)
  - CLAUDE.md (page count: XX → YY)

Build: PASS
Typecheck: PASS
```

## Safety Rules

- NEVER skip the lazy import — all pages must be lazy-loaded
- NEVER skip the nav link — pages must be discoverable
- NEVER use icons from outside lucide-react
- NEVER use CSS frameworks other than Tailwind
- NEVER commit automatically — the user decides when
