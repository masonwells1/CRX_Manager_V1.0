# Gap Remediation Handoff — CRX Manager V1.0

**Date:** 2026-03-01
**Purpose:** Verified implementation tasks for desktop Claude session.
**Source:** Cross-validated audit from two independent AI reviews against actual codebase.

---

## How This Was Verified

Every item below was confirmed by reading actual files — not guessed from docs.
Where the two audits disagreed, the codebase was the tiebreaker.

**Key corrections applied:**
- Dependabot is already enabled (`.github/dependabot.yml` — npm + github-actions, weekly)
- `console.error()` actual count is **103 across 50 files** (not 114)
- CI does run on PRs to main; only direct feature-branch pushes skip CI
- Sentry `@sentry/react` v10+ DOES capture `unhandledrejection` via `GlobalHandlers` integration — but `ignoreErrors` filters `'Non-Error promise rejection captured'`, so non-Error rejections are silenced
- Skeleton components used on only **4 pages** (Dashboard, FinancialDashboard, BlendTicketDetail, BlendTickets), not "10"
- `runCriticalAction()` adopted on only **3 pages** (PrepaymentManager, BlendRecipes, Compliance) — the remaining 47 pages still use bare try/catch with `console.error()`

---

## TIER 1 — Do This Week (Quick Wins, High Impact)

### 1. Add `unhandledrejection` safety net in `src/main.tsx`

**Why:** Sentry captures most rejections, but `ignoreErrors` silently drops non-Error rejections (strings, undefined). A safety net catches anything Sentry misses.

**What to do:**
```typescript
// Add BEFORE createRoot() in src/main.tsx
window.addEventListener('unhandledrejection', (event) => {
  // Sentry GlobalHandlers already captures Error rejections.
  // This catches non-Error rejections that Sentry ignores.
  if (!(event.reason instanceof Error)) {
    Sentry.captureException(
      new Error(`Unhandled rejection: ${String(event.reason)}`),
      { tags: { source: 'unhandled_rejection_safety_net' } }
    );
  }
});
```

**Files:** `src/main.tsx`
**Effort:** 10 minutes
**Risk:** None

---

### 2. Add Vitest coverage thresholds

**Why:** 1,380 tests exist but nothing measures what they cover. Tests could be deleted with no gate to stop it.

**What to do:**
1. Install `@vitest/coverage-v8` as a dev dependency
2. Add coverage config to `vite.config.ts` test block:
```typescript
test: {
  // ... existing config ...
  coverage: {
    provider: 'v8',
    reporter: ['text', 'lcov'],
    include: ['src/**/*.{ts,tsx}'],
    exclude: [
      'src/**/*.test.{ts,tsx}',
      'src/setupTests.ts',
      'src/types/**',
      'src/vite-env.d.ts',
    ],
    thresholds: {
      statements: 50,
      branches: 40,
      functions: 40,
      lines: 50,
    },
  },
}
```
3. Add `"test:coverage": "vitest run --coverage"` to `package.json` scripts
4. Start with conservative thresholds (50/40/40/50) — ratchet up over time

**Files:** `vite.config.ts`, `package.json`
**Effort:** 20 minutes
**Risk:** Low — only fails if coverage drops below threshold

---

### 3. Enable production sourcemaps (uploaded, not shipped)

**Why:** `vite.config.ts` has `sourcemap: false`. Sentry stack traces show minified code, making production debugging difficult.

**What to do:**
1. Change `sourcemap: false` to `sourcemap: 'hidden'` in `vite.config.ts` (generates maps but doesn't reference them in output)
2. Add `@sentry/vite-plugin` to upload maps during build:
```typescript
// vite.config.ts
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react(),
    // Only upload in CI builds
    process.env.SENTRY_AUTH_TOKEN && sentryVitePlugin({
      org: 'your-sentry-org',
      project: 'crx-manager',
      authToken: process.env.SENTRY_AUTH_TOKEN,
    }),
  ].filter(Boolean),
});
```
3. Add `SENTRY_AUTH_TOKEN` to Vercel env vars and CI secrets

**Files:** `vite.config.ts`, `package.json` (add dep), Vercel dashboard, GitHub secrets
**Effort:** 30 minutes
**Risk:** Low — hidden maps aren't served to browsers. Requires Sentry auth token setup.
**Note:** Skip if Sentry isn't actively monitored yet. Do coverage thresholds first.

---

## TIER 2 — Do This Sprint (Moderate Effort, Important)

### 4. Migrate remaining pages to `runCriticalAction()`

**Why:** Only 3 of 50 pages use `runCriticalAction()`. The other 47 pages with mutations use bare try/catch + `console.error()` — those errors are invisible in production (not reported to Sentry).

**What to do:**
Audit each page with `console.error()` calls and migrate mutation patterns to `runCriticalAction()`. Priority order (by error count per file):

| Priority | File | `console.error` count |
|----------|------|----------------------|
| 1 | `InventoryPage.tsx` | 7 |
| 2 | `Deliveries.tsx` | 6 |
| 3 | `QuoteBuilder.tsx` | 6 |
| 4 | `Invoices.tsx` | 5 |
| 5 | `BlendTicketDetail.tsx` | 4 |
| 6 | `ARaging.tsx` | 4 |
| 7 | `Dashboard.tsx` | 3 |
| 8 | `TeamBoard.tsx` | 3 |
| 9 | `activityLogger.ts` | 3 |
| 10 | `notificationTriggers.ts` | 2 (lib — special handling) |

**Pattern to replace in each file:**
```typescript
// BEFORE (bare try/catch)
try {
  const result = await supabase.from('x').update({...}).eq('id', id).select();
  checkMutationResult(result, 'Update x');
  toast('success', 'Saved');
} catch (err) {
  console.error('Failed:', err);
  toast('error', 'Failed to save');
} finally {
  setSaving(false);
}

// AFTER (runCriticalAction)
await runCriticalAction({
  action: async () => {
    const result = await supabase.from('x').update({...}).eq('id', id).select();
    checkMutationResult(result, 'Update x');
  },
  toast,
  successMessage: 'Saved',
  setLoading: setSaving,
  sentryTag: 'update_x',
});
```

**Files:** ~50 files listed in the count table above (full list: grep for `console.error(` in `src/`)
**Effort:** 2-4 hours (mechanical refactor, page by page)
**Risk:** Low per page — each is an isolated refactor. Run tests after each batch.

---

### 5. Add route-level error boundaries

**Why:** One global `ErrorBoundary` wraps the entire app. If one page crashes, the user sees a full-app error screen. Route-level boundaries keep the rest of the app working.

**What to do:**
1. Create a `RouteErrorBoundary` component (can reuse existing `ErrorBoundary` logic but scoped)
2. Wrap each lazy route in `App.tsx` with its own boundary:
```tsx
<Route path="/inventory" element={
  <RouteErrorBoundary>
    <Suspense fallback={<PageLoader />}>
      <InventoryPage />
    </Suspense>
  </RouteErrorBoundary>
} />
```
3. The route boundary should show an in-page error message with "Go back" / "Retry" buttons instead of the full-app error screen

**Files:** `src/components/ErrorBoundary.tsx` (or new `RouteErrorBoundary.tsx`), `src/App.tsx`
**Effort:** 1-2 hours
**Risk:** Low — additive change, doesn't modify page code

---

### 6. Expand Skeleton loading states

**Why:** Only 4 of 50 pages use `Skeleton` components. Most pages show a spinner or nothing while data loads.

**What to do:**
Prioritize data-heavy list pages that users hit frequently:

| Page | Current loading | Skeleton variant needed |
|------|----------------|----------------------|
| `Customers.tsx` | Spinner | `SkeletonTable` |
| `Products.tsx` | Spinner | `SkeletonTable` |
| `Orders.tsx` | Spinner | `SkeletonTable` |
| `Invoices.tsx` | Spinner | `SkeletonTable` |
| `Deliveries.tsx` | Spinner | `SkeletonTable` |
| `Quotes.tsx` | Spinner | `SkeletonTable` |
| `PurchaseOrders.tsx` | Spinner | `SkeletonTable` |
| `ARaging.tsx` | Spinner | `SkeletonTable` + `SkeletonCard` for summary |
| `Jobs.tsx` | Spinner | `SkeletonTable` |
| `InventoryPage.tsx` | Spinner | `SkeletonTable` + `SkeletonCard` for stats |

The `Skeleton`, `SkeletonCard`, and `SkeletonTable` components already exist in `src/components/ui/Skeleton.tsx`. Just import and use them.

**Files:** ~10 page files
**Effort:** 1-2 hours
**Risk:** None — purely visual improvement

---

### 7. Add ESLint `no-console` rule

**Why:** TESTING.md says "no console.log in production" but nothing enforces it. New `console.error()` calls keep getting added.

**What to do:**
Add to `eslint.config.js` rules:
```javascript
'no-console': ['warn', { allow: ['warn'] }],
```

This will:
- Warn on `console.log()`, `console.error()`, `console.info()`, `console.debug()`
- Allow `console.warn()` (sometimes useful for dev-only warnings)
- Force developers to use `runCriticalAction()` or `Sentry.captureException()` instead

**Important:** Run `npm run lint` after adding — expect ~103+ warnings. Fix them as part of Task 4 (runCriticalAction migration), not separately.

**Files:** `eslint.config.js`
**Effort:** 5 minutes to add rule, then fix as part of Task 4
**Risk:** None if set to `warn` — won't block commits until changed to `error`

---

### 8. Add Firefox to E2E test matrix

**Why:** Playwright only runs Chromium. Firefox handles CSS and events differently. Real users use Firefox.

**What to do:**
Add Firefox project to `playwright.config.ts`:
```typescript
projects: [
  {
    name: 'chromium',
    use: { ...devices['Desktop Chrome'] },
  },
  {
    name: 'firefox',
    use: { ...devices['Desktop Firefox'] },
  },
],
```

Update CI to install Firefox:
```yaml
- name: Install Playwright browsers
  run: npx playwright install --with-deps chromium firefox
```

**Files:** `playwright.config.ts`, `.github/workflows/ci.yml`
**Effort:** 15 minutes
**Risk:** Low — may surface new failures that are real bugs. E2E runs post-merge so won't block PRs.

---

## TIER 3 — Do Next Sprint (Larger Effort)

### 9. Add accessibility lint enforcement

**Why:** Only 88 aria attributes across 39 files for a 50-page app. No automated a11y checks.

**What to do:**
1. Install `eslint-plugin-jsx-a11y` as a dev dependency
2. Add to `eslint.config.js`:
```javascript
import jsxA11y from 'eslint-plugin-jsx-a11y';
// Add to extends or plugins
```
3. Start with `recommended` ruleset at `warn` level
4. Run lint, fix critical issues (missing alt text, missing button labels on icon-only buttons)
5. Gradually promote to `error`

**Files:** `eslint.config.js`, `package.json`, then scattered component fixes
**Effort:** 2-4 hours (install + initial fix pass)
**Risk:** Medium — may surface many warnings. Start as `warn` to avoid blocking.

---

### 10. Tighten CSP `unsafe-inline` for styles

**Why:** `vercel.json` allows `'unsafe-inline'` in style-src. Tailwind uses class-based styles so this likely isn't needed — but verify first.

**What to do:**
1. Remove `'unsafe-inline'` from style-src in `vercel.json`
2. Deploy to a preview branch
3. Test all pages — if any inline styles break, add a nonce-based strategy or hash-based exception
4. Tailwind classes should work fine. Watch for: Mapbox GL (injects inline styles), any `style={}` JSX props

**Files:** `vercel.json`
**Effort:** 30 minutes + testing
**Risk:** Medium — could break Mapbox or any component using inline styles. Test thoroughly on preview deploy first.

---

### 11. Add request correlation IDs

**Why:** When an error happens, there's no way to trace it from browser to Edge Function to database.

**What to do:**
1. Generate a `X-Request-ID` header (UUID) for each Supabase client request
2. Log the ID in Sentry breadcrumbs
3. Pass through to Edge Functions
4. This requires modifying `src/lib/db.ts` to add a request interceptor

**Files:** `src/lib/db.ts`, Edge Functions
**Effort:** 2-3 hours
**Risk:** Low — additive. Edge Functions need to read and log the header.

---

## NOT DOING (And Why)

| Item | Reason |
|------|--------|
| Enable Dependabot | Already active in `.github/dependabot.yml` |
| Query caching (React Query) | High value but massive refactor across all 50 pages — needs its own design doc |
| `React.memo()` everywhere | Premature optimization — measure performance first, memoize bottlenecks |
| Form library (React Hook Form) | Would be great but requires rewriting every form — better as incremental adoption on new/modified forms |
| Service worker | Only needed if offline-first scope expands beyond driver deliveries |
| Internationalization | Not needed — English-only customer base |
| Breadcrumb navigation | Nice-to-have, not a gap |
| Visual regression testing | Valuable but needs Percy/Chromatic budget and setup |
| Move typecheck to pre-commit | Tradeoff: slower commits. Current pre-push gate is fine. |

---

## Execution Notes for Desktop Claude

1. **Read `docs/workflows/SAFE_DEVELOPMENT_RULES.md` before starting** — mandatory per CLAUDE.md
2. **Run tests after every change** — pre-commit hook runs lint + build + vitest
3. **Never use `--no-verify`** — hard red line
4. **Tasks 1-3 are independent** — can be done in any order
5. **Task 4 and Task 7 should be done together** — add the lint rule, then migrate console.error calls
6. **Task 5 and Task 6 are independent** — can be done in parallel
7. **Create one commit per task** for clean history
8. **Start with Task 1** — it's 10 minutes and catches invisible errors immediately

---

## Verification Checklist

After all tasks, confirm:
- [ ] `npx vitest run` — all tests pass
- [ ] `npm run lint` — 0 errors (warnings OK for no-console during migration)
- [ ] `npm run build` — clean build
- [ ] `npm run typecheck` — 0 errors
- [ ] `grep -r "console\.error" src/ | wc -l` — count should be near 0
- [ ] `grep -r "runCriticalAction" src/ | wc -l` — count should be 50+
