# Functional Audit Report — 2026-04-10

## Scope
- Frontend TypeScript/React app-level health checks.
- Static review of delivery creation flow and guardrail behavior.
- Verification with unit/integration test suite, typecheck, and lint.

## Checks Performed
- `npm test`
- `npm run typecheck`
- `npm run lint`

## Findings

### 1) Driver load guardrail could run with stale driver context (fixed)
- **Severity:** Medium
- **Area:** Delivery scheduling / operational guardrails
- **Issue:** The effect that triggers `checkDriverLoad` depended on `selectedDriverId` and `scheduledDate`, but not on the `drivers` list. If driver records resolve asynchronously after selection, the guardrail can run with a missing `driverName`, reducing warning quality and traceability.
- **Fix implemented:** Added `drivers` to the dependency array so the guardrail recomputes when driver data arrives.

### 2) Inventory warning computes on-hand only, not net-available
- **Severity:** Medium
- **Area:** Delivery planning
- **Issue:** The query selects both `quantity_available` and `quantity_prebooked`, but warning math uses only `quantity_available`. This can understate shortage risk where available stock is already committed.
- **Recommendation:** Calculate and compare against net available (`quantity_available - quantity_prebooked`) or use the same server-side net-position RPC used elsewhere for consistency.

### 3) Inventory check is hardcoded to one location
- **Severity:** Medium
- **Area:** Multi-location operations
- **Issue:** Delivery stock warnings filter inventory by `location = 'Main Warehouse'`. This can produce false warnings/false safety for organizations using multiple warehouses or dispatch points.
- **Recommendation:** Derive location from the selected route/driver/dispatch location, or aggregate across eligible locations according to business rules.

### 4) Accessibility quality warnings in UI components
- **Severity:** Low to Medium
- **Area:** UX/accessibility
- **Issue:** Lint reports multiple `jsx-a11y` warnings (autofocus usage, click handlers without keyboard listeners).
- **Recommendation:** Remove nonessential autofocus usage and add keyboard handlers/semantic controls for clickable non-button elements.

## Risk Summary
- Primary correctness risk remains in delivery preflight checks (capacity and inventory signal quality), not in compile-time stability.
- Test and type health are strong, but some operational correctness and accessibility gaps remain.

## Suggested Next Actions
1. Normalize inventory warning logic to net-available and location-aware criteria.
2. Add regression tests for delivery guardrails that simulate delayed driver list hydration.
3. Treat current accessibility lint warnings as backlog items with a targeted remediation pass.
