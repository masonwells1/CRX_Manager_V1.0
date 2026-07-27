---
name: new-page
description: Scaffold a new page in CRX Manager with lazy import, route object, permission-registry entry, sidebar nav link, and documentation updates. Use when the user wants to add a new page or screen to the app.
---

# Add New Page

Scaffold a complete new page with all the wiring CRX Manager requires — component file,
lazy import, route object, **permission-registry entry**, sidebar nav link, and doc updates.

The permission entry is not optional: `ProtectedRoute` is **fail-closed**. A protected route
with no `PAGE_PERMISSIONS` entry is redirected away, and `src/lib/pagePermissions.test.ts`
fails CI. Skipping it produces a page nobody can open.

## Step 1: Gather Requirements

Ask the user (skip if they already described it):
- **Page name** — What should the page be called? (e.g., "Tote Tracking")
- **Route path** — What URL path? (e.g., `/tote-tracking`)
- **Nav category** — Which sidebar group? Read the category list in
  `src/components/layout/Sidebar.tsx` and offer the real ones rather than guessing.
- **Role access** — Who can see it? (`admin`, `sales_rep`, `applicator`, `driver`)
- **Purpose** — One sentence about what the page does

## Step 2: Create the Page Component

Create `src/pages/<PageName>.tsx`. Start minimal and import only what the page actually
uses — unused imports fail `npm run lint`:

```tsx
export default function PageName() {
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

Add `useState`/`useEffect`, `supabase`/`checkMutationResult` from `../lib/db`, or `useAuth`
from `../contexts/AuthContext` **only when the page uses them**.

Key rules:
- Use Tailwind CSS only (brand color: `crx-green` / `#28A26A`)
- Lucide React icons only
- Export as `default` function (required for lazy loading)
- `src/lib/db.ts` is the only Supabase client; call `assertRpcResult()` after RPCs and
  `checkMutationResult()` after `.update()` / `.delete()`

## Step 3: Wire Up the Route

### 3a. Add the lazy import to `src/App.tsx`

Find the lazy import block and add:

```typescript
const PageName = lazy(() => import('./pages/PageName'));
```

### 3b. Add the route object

`App.tsx` uses **`createBrowserRouter` route objects, not `<Routes>`/`<Route>` JSX**, and
suspense is centralized in `RouteShell`. **Do not add a per-route `<Suspense>` wrapper.**

Add an entry to the `RouteShell` children array, in the matching role section. Note the
paths there are relative (no leading slash):

```tsx
{ path: 'route-path', element: <PageName /> },
```

Role-restricted pages wrap the element in `ProtectedRoute`, matching the neighbours:

```tsx
{ path: 'route-path', element: <ProtectedRoute allowedRoles={['admin', 'sales_rep']}><PageName /></ProtectedRoute> },
```

### 3c. Add the permission-registry entry (REQUIRED)

Edit `src/lib/pagePermissions.ts` and add an entry to `PAGE_PERMISSIONS` under the right
category. `path` here **does** carry the leading slash, matching the browser URL:

```typescript
{ key: 'route-path', path: '/route-path', label: 'Page Title', category: 'Sell & Deliver', roles: ['admin', 'sales_rep'] },
```

Without this the deny-list (`profile.denied_pages`) silently does nothing for the route,
`ProtectedRoute` redirects users away, and `pagePermissions.test.ts` fails.

### 3d. Add the sidebar nav link

Navigation lives in `src/components/layout/Sidebar.tsx` (there is **no**
`src/components/AppLayout.tsx` nav list). Each role has its own tree —
`officeNavigation`, `applicatorNavigation`, `driverNavigation`, selected by
`getNavigationForRole`. Add the item to the correct category's `items` array:

```tsx
{ path: '/route-path', label: 'Page Title', icon: <IconName className="w-4 h-4" />, roles: ['admin', 'sales_rep'] },
```

Use `w-4 h-4` for category sub-items and `w-5 h-5` for standalone top-level links, matching
the surrounding entries. Omit `roles` only when every role in that tree may see the page.
Choose a Lucide icon that matches the page's purpose.

## Step 4: Update Documentation

### pages-routes.md
Read `docs/reference/pages-routes.md` and add a new row:

| Route | Page Component | Description | Access |
|-------|---------------|-------------|--------|
| /route-path | PageName | One-line description | Role info |

**Do not put page counts in `CLAUDE.md` or `AGENTS.md`.** Volatile counts belong in
`docs/reference/`, and `npm run check:agent-guidance` fails when they appear in the
always-loaded agent files. If a total is stated in `docs/reference/pages-routes.md`,
update it there.

## Step 5: Verify

```bash
npm run lint && npm run typecheck && npm run test -- src/lib/pagePermissions.test.ts && npm run build
```

Then actually open the page — done means the changed behavior ran and was observed:
start the dev preview, navigate to the new route, confirm it renders, the sidebar link
appears for an allowed role, and the console is clean. Check the phone width too if the
page is field-facing. Fix any errors before reporting done.

## Step 6: Print Summary

```
=== New Page Created ===

Component: src/pages/PageName.tsx
Route:     /route-path (route object in App.tsx, RouteShell handles suspense)
Permission: PAGE_PERMISSIONS entry 'route-path' (roles: ...)
Nav:       Sidebar.tsx → [category] in [officeNavigation|applicatorNavigation|driverNavigation]
Icon:      [IconName] from lucide-react

Docs updated:
  - docs/reference/pages-routes.md (new entry)

Lint: PASS
Typecheck: PASS
pagePermissions test: PASS
Build: PASS
Rendered: /route-path opened, renders, console clean
```

## Safety Rules

- NEVER skip the lazy import — all pages must be lazy-loaded
- NEVER skip the `PAGE_PERMISSIONS` entry — the route is fail-closed without it
- NEVER skip the nav link — pages must be discoverable
- NEVER add a per-route `<Suspense>`; `RouteShell` already provides it
- NEVER add a page/route count to `CLAUDE.md` or `AGENTS.md`
- NEVER use icons from outside lucide-react
- NEVER use CSS frameworks other than Tailwind
- NEVER commit automatically — the user decides when
