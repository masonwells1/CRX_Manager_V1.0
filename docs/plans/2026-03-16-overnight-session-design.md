# Overnight Session Design — 2026-03-16

> **Approved by:** Mason Wells | **Executor:** Claude

---

## Scope

### Phase A: Database Housekeeping
- **A1:** `pg_temp` search_path fix — single migration fixing all public functions missing `pg_temp`
- **A2:** Data validation — run corruption-check queries, write cleanup migration if needed

### Phase B: Code Quality Sprint
- **B1:** Migrate ~47 pages from bare try/catch to `runCriticalAction()`
- **B2:** Skeleton loading states on 10 high-traffic list pages
- **B3:** Firefox E2E test matrix (playwright.config.ts + CI)
- **B4:** CSP `unsafe-inline` style-src tightening in vercel.json

### Phase C: Delivery Features
- **C1:** Delivery Calendar View — new tab on Deliveries page using @fullcalendar/react
- **C2:** Delivery completion email — auto-send with opt-out checkbox in completion modal
- **C3:** In-app notifications — notify driver, admins, and sales rep on delivery completion

### Phase D: Stretch Goals
- **D1:** Accessibility lint (eslint-plugin-jsx-a11y) at warn level
- **D2:** Request correlation IDs (X-Request-ID header on Supabase calls)

---

## Design Decisions

### C1: Calendar View — Tab on Deliveries Page
- Library: `@fullcalendar/react` + `@fullcalendar/daygrid` + `@fullcalendar/interaction`
- Month/Week toggle, color-coded by status (blue=scheduled, amber=in_progress, green=completed, gray=cancelled)
- Click event → DeliveryDetail, click day → NewDelivery with date pre-filled
- Reuses existing deliveries query — no new RPC

### C2: Email Opt-Out
- Checkbox "Email delivery receipt to customer" in completion modal (default: checked)
- Only sends if customer has email on file
- Uses existing `sendEmail()` + `buildEmailHtml()` from emailService.ts
- Existing email code in DeliveryDetail.tsx lines 685-755 already builds the HTML

### C3: Notification Recipients
- Driver (assigned to delivery) — confirmation
- All admins — visibility
- Sales rep (from the linked order's commission splits) — their customer got product
- Uses existing `createNotification()` from activityLogger.ts

### B1: runCriticalAction Migration
- Replace `try { ... } catch (err) { console.error(...); toast(...) }` pattern
- Each mutation gets a descriptive `sentryTag` (e.g., `update_customer`, `void_invoice`)
- Preserves all existing behavior, just centralizes error reporting

### A1: pg_temp Strategy
- Query pg_proc for all public functions where search_path doesn't include pg_temp
- Generate ALTER FUNCTION ... SET search_path = public, pg_temp for each
- Single migration file, no function body changes needed
