# Go-Live Hardening Design

> **Created:** 2026-02-28 | **Status:** Approved | **Branch:** `feature/go-live-hardening`

## Background

External audit (Codex) identified 10 verified findings in the codebase. All findings confirmed
accurate against current code. Codex code changes were rejected (deleted 65k+ lines, 205 files,
all tests) — only audit findings are used as input.

## Sprint 1: Financial Safety (P0 — before go-live)

### 1a. Idempotency key fix
- Replace `Math.random()` with `crypto.randomUUID()` in `generateIdempotencyKey`
- Create `useIdempotencyKey(operation)` hook — generates key once in `useRef`, resets on success
- Retrofit all critical action handlers
- Tests: simulate retry, assert same key reuse

### 1b. Quote math server authority
- Create `compute_quote_totals(p_items jsonb)` SQL function using `NUMERIC`
- Client `recalcItem` becomes preview-only; authoritative totals from server
- Golden tests for rounding edge cases

### 1c. db.ts placeholder removal
- Remove `|| 'placeholder'` fallbacks, hard-throw if env vars missing

## Sprint 2: Operational Reliability (P0 — before go-live)

### 2a. Notification failure tracking
- `failed_notifications` table with structured failure payloads
- Replace `console.error` catch blocks with DB writes
- `await` the `notifyDeliveryRemainder` call
- Admin-visible failed notifications UI + periodic retry RPC

### 2b. Dashboard maintenance observability
- Await maintenance RPCs, wrap in try/catch
- Admin status indicator for maintenance health
- Sentry breadcrumbs for results

### 2c. Read-path error handling
- Check `.error` on Supabase responses in `NewOrder.fetchData` and similar
- Show error message + retry button instead of empty state

## Sprint 3: Security Hardening (P1)

### 3a. Delivery signature privacy
- Private bucket + `createSignedUrl` with 1-hour TTL

### 3b. RLS integration tests
- Test each mutation RPC as each role
- IDOR tests for cross-customer access

### 3c. Schema integrity upgrade
- CI job introspecting `information_schema` on staging DB

## Sprint 4: Developer Experience (P2)

### 4a. Shared `runCriticalAction` helper
### 4b. React hooks lint cleanup (critical flows first)
### 4c. E2E test infrastructure in CI

## Sprint 5: Observability (P2)

### 5a. Operational metrics via Sentry
### 5b. Reconciliation checks (invoice vs payments, inventory vs transactions)
