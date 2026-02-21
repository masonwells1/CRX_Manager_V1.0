# CRX Manager Go-Live Remediation Plan

Generated: February 21, 2026  
Prepared for: Pre-implementation review (no remediation changes executed yet)  
Scope: Application functionality, business logic, security, authorization, and release readiness

## 1) Executive Summary

Current recommendation is **No-Go** for employee launch until critical remediation is completed and validated.

Primary blockers are:

- Security exposure (hardcoded credentials in repository).
- Authorization guard gaps (authenticated session with missing profile can bypass role/page checks).
- Broken customer save contract (critical finance/hierarchy fields not persisted; create navigation bug).
- Access-control drift (route roles, sidebar roles, and page-permission matrix not aligned).
- Private storage buckets used with public URL logic in delivery photo/signature flows.
- High codebase drift: TypeScript and lint failures at scale.

## 2) Current Baseline (as of February 21, 2026)

### Quality Metrics

- `npm.cmd run typecheck`: **127 errors**
- `npm.cmd run lint`: **573 problems** (`511 errors`, `62 warnings`)
- `npm.cmd test`: **PASS** (`35 files`, `446 tests`)
- `npm.cmd run build`: **PASS**

### Readiness Interpretation

- Build/test pass does not indicate production readiness because type/lint contract drift is high.
- Existing tests are strong at unit level, but there are clear cross-layer integration gaps.

## 3) Scope and Objectives

### In Scope

- Security and credential hygiene.
- AuthN/AuthZ enforcement and role gating consistency.
- Cross-layer contract integrity (frontend payloads vs RPC function behavior).
- Critical workflow correctness (customer management, delivery execution, OCR triggers, notifications).
- Release gating and validation strategy for go-live decision.

### Out of Scope (for this remediation cycle)

- New feature development.
- UI redesign not tied to functional correctness/risk reduction.
- Performance optimization beyond release blockers.

## 4) Severity Model

- **P0 (Critical)**: Security risk, unauthorized access risk, or core workflow data integrity failure.
- **P1 (High)**: Major workflow breakage or high-confidence production failure path.
- **P2 (Medium)**: Reliability/UX issues with contained blast radius.
- **P3 (Low)**: Non-blocking cleanup/hardening.

## 5) Remediation Backlog (Formal Work Packages)

## WP-001 (P0) Remove Hardcoded Credentials and Rotate Exposed Account Secrets

### Evidence

- `tests/e2e/utils/auth.ts:4`
- `tests/e2e/utils/auth.ts:5`

### Risk

- Credential leakage and unauthorized account access.

### Remediation

1. Remove plaintext credentials from source and test helpers.
2. Move E2E credentials to secure env-based configuration.
3. Rotate affected account password immediately.
4. Add secret scanning pre-commit/CI guard.

### Acceptance Criteria

- No hardcoded passwords/tokens in tracked files.
- E2E auth helper consumes env vars only.
- Credential rotation completed and documented.

### Validation

- Secret scan passes.
- E2E login still works via environment variables.

### Owner

- Security + QA Automation

---

## WP-002 (P0) Enforce Profile-Required Authorization in Route Guard

### Evidence

- `src/components/auth/ProtectedRoute.tsx:33`
- `src/components/auth/ProtectedRoute.tsx:39`
- `src/contexts/AuthContext.tsx:43`
- Multiple non-null assertions e.g. `src/pages/CustomerDetail.tsx:306`

### Risk

- Authenticated users may hit protected routes without profile-backed role checks.
- Elevated chance of runtime crashes due to `profile!` assumptions.

### Remediation

1. Update route guard to block when `session` exists but `profile` is null.
2. Add explicit fallback handling for profile-load failure (retry/sign-out/error state).
3. Remove unsafe `profile!` assumptions in critical workflows.
4. Add focused tests for session-without-profile scenario.

### Acceptance Criteria

- No protected page renders when profile cannot be loaded.
- Role/page checks always execute for authenticated access.
- New test coverage verifies failure-path behavior.

### Validation

- Auth route tests pass including missing-profile case.
- Manual check: simulate profile query failure and verify safe redirect/block.

### Owner

- Frontend + Auth/Platform

---

## WP-003 (P0) Repair Customer Save Contract (Finance + Hierarchy + Create Navigation)

### Evidence

- Frontend sends fields:
  - `src/pages/CustomerDetail.tsx:277`
  - `src/pages/CustomerDetail.tsx:284`
- RPC does not persist these fields:
  - `supabase/migrations/20260211230000_atomic_customer_blend_quote_dup.sql:42`
  - `supabase/migrations/20260211230000_atomic_customer_blend_quote_dup.sql:70`
- RPC returns JSON object:
  - `supabase/migrations/20260211230000_atomic_customer_blend_quote_dup.sql:141`
- Frontend navigates with whole object:
  - `src/pages/CustomerDetail.tsx:315`

### Risk

- Financial settings and parent hierarchy silently fail to persist.
- New customer flow may route to invalid URL (`[object Object]`) and break post-save workflow.

### Remediation

1. Align frontend payload and `save_customer` RPC columns.
2. Persist `parent_customer_id`, `credit_limit_cents`, `finance_charge_rate`, `finance_charge_enabled`, `finance_charge_grace_days`.
3. Fix create navigation to use `data.customer_id`.
4. Add integration tests for create/update with finance/hierarchy fields.
5. Update stale customer RPC contract tests.

### Acceptance Criteria

- Create and update persist all customer settings correctly.
- New customer redirects to `/customers/{uuid}` reliably.
- Contract tests match live RPC shape.

### Validation

- SQL verification on created/updated rows.
- UI roundtrip checks across create/edit/reload.
- Test coverage for payload/response contract.

### Owner

- Backend (Supabase SQL) + Frontend

---

## WP-004 (P1) Fix Private Storage Media Retrieval for Deliveries

### Evidence

- Private buckets declared:
  - `supabase/migrations/20260308200000_production_fixes_v2.sql:252`
  - `supabase/migrations/20260308200000_production_fixes_v2.sql:256`
- Delivery flow uses public URLs:
  - `src/pages/DeliveryDetail.tsx:357`
  - `src/pages/DeliveryDetail.tsx:497`

### Risk

- Broken image/signature retrieval in production.
- Potential leakage or inconsistent access semantics.

### Remediation

1. Replace `getPublicUrl` usage with signed URL generation for private buckets.
2. Ensure signed URLs refresh/expire safely in UI.
3. Confirm storage policy assumptions against access patterns.

### Acceptance Criteria

- Delivery photos and signatures render consistently for authorized users.
- No dependency on public bucket URLs for private media.

### Validation

- Manual role-based checks on media access.
- Regression test for upload + display + reload cycle.

### Owner

- Frontend + Backend/Storage

---

## WP-005 (P1) Unify Role Matrix Across Router, Sidebar, and Page Permissions

### Evidence

- App records mismatch:
  - `src/components/layout/Sidebar.tsx:137`
  - `src/lib/pagePermissions.ts:38`
  - `src/App.tsx:138`
- Additional route/permission mismatches:
  - `src/App.tsx:122` vs `src/lib/pagePermissions.ts:42`
  - `src/App.tsx:132` vs `src/lib/pagePermissions.ts:20`
  - `src/App.tsx:133` vs `src/lib/pagePermissions.ts:48`
  - `src/App.tsx:135` vs `src/lib/pagePermissions.ts:54`
  - `src/App.tsx:136` vs `src/lib/pagePermissions.ts:36`

### Risk

- Users see links they cannot access, or gain access outside intended matrix.
- High support burden and inconsistent behavior by role.

### Remediation

1. Define a single source of truth for role/page access.
2. Generate/derive router and sidebar permissions from that source.
3. Add automated parity test asserting router vs permissions vs nav consistency.

### Acceptance Criteria

- No role mismatch across routing, sidebar visibility, and permission checks.
- Applicator/driver/admin/sales_rep experiences are consistent and predictable.

### Validation

- Automated parity test passes.
- Manual role walkthrough for all primary navigation categories.

### Owner

- Frontend + Product/Operations (policy sign-off)

---

## WP-006 (P1) Production-Ready Edge Function CORS and Secrets

### Evidence

- Missing `ALLOWED_ORIGIN` returns empty origin:
  - `supabase/functions/create-user/index.ts:6`
  - `supabase/functions/process-blend-ticket/index.ts:6`
  - `supabase/functions/process-document/index.ts:6`
- Frontend function usage:
  - `src/hooks/useOCRProcessor.ts:59`
  - `src/lib/documentOCR.ts:176`

### Risk

- Browser function calls fail in production due to CORS.
- OCR and admin workflows break post-launch.

### Remediation

1. Define environment contract for all edge function secrets.
2. Set and verify `ALLOWED_ORIGIN` for each deployment environment.
3. Add pre-deploy validation script/checklist to block missing secrets.
4. Update deployment docs and runbook.

### Acceptance Criteria

- All edge functions return valid CORS headers in staging/prod.
- Required secrets are documented and validated pre-release.

### Validation

- Function invocation tests from browser context in staging.
- Deployment checklist includes explicit secret verification step.

### Owner

- DevOps + Backend

---

## WP-007 (P2) Restrict “Take Delivery” UI to Valid Roles/States

### Evidence

- UI eligibility too broad:
  - `src/pages/DeliveryDetail.tsx:569`
- Backend enforces target driver role:
  - `supabase/migrations/20260228200000_safety_audit_hardening.sql:827`

### Risk

- Users are offered actions that fail server-side, degrading trust and usability.

### Remediation

1. Tighten `canTakeDelivery` condition to match backend authorization.
2. Improve user messaging when action is unavailable.
3. Add role/state tests for action visibility.

### Acceptance Criteria

- Only authorized users see and can execute reassignment action.
- Avoidable RPC authorization errors are eliminated for this action path.

### Validation

- Manual role-based action visibility matrix.
- Component test for action gating logic.

### Owner

- Frontend

---

## WP-008 (P2) Fix Offline Sync Trigger Dependency Gap

### Evidence

- `src/components/ui/OfflineBanner.tsx:27`
- `src/components/ui/OfflineBanner.tsx:30`

### Risk

- Pending actions may not auto-sync if queued while already online.

### Remediation

1. Update effect dependencies and/or sync trigger strategy.
2. Add test scenario: pending actions appear while online and auto-sync occurs.

### Acceptance Criteria

- Pending actions reliably auto-sync without requiring connectivity toggle.

### Validation

- Offline queue integration test.
- Manual simulation in browser.

### Owner

- Frontend

---

## WP-009 (P2) Handle Notification RPC Errors Explicitly

### Evidence

- `src/lib/notificationTriggers.ts:215`

### Risk

- Admin alerts can silently fail while user assumes completion.

### Remediation

1. Inspect RPC response `{ error }` in notification helpers.
2. Log and surface meaningful telemetry on failures.
3. Add tests for RPC error-response path (not only thrown exceptions).

### Acceptance Criteria

- Notification helper reports and records RPC errors deterministically.

### Validation

- Unit tests for thrown + returned-error failure modes.

### Owner

- Frontend + Backend

---

## WP-010 (P2) Reduce Engineering Drift (TypeScript/Lint) to Release Threshold

### Evidence

- TypeScript: 127 errors.
- Lint: 573 problems (511 errors, 62 warnings).

### Risk

- High regression probability, weak refactor safety, hidden contract mismatches.

### Remediation

1. Partition TS/lint failures by domain and assign owners.
2. Triage by impact: runtime/safety first, then code hygiene.
3. Re-enable strict CI quality gates with agreed threshold policy.

### Acceptance Criteria

- Target release gate: `typecheck = 0`, `lint errors = 0`.
- If temporary waiver is needed, waiver list is explicit, approved, and time-bound.

### Validation

- CI gates enforced on merge.

### Owner

- Engineering Lead + All feature owners

## 6) Execution Phasing (Proposed)

## Phase 0: Security and Access Blocking Issues (Feb 23-24, 2026)

- WP-001, WP-002, WP-003.
- Exit criteria: no credential leakage; no profile-null bypass; customer save flow corrected.

## Phase 1: Core Workflow Integrity (Feb 24-27, 2026)

- WP-004, WP-005, WP-006.
- Exit criteria: media retrieval fixed; role matrix unified; edge function CORS/secrets validated.

## Phase 2: Reliability and Hardening (Feb 27-Mar 2, 2026)

- WP-007, WP-008, WP-009, WP-010.
- Exit criteria: reliability patches complete; quality baseline reaches approved release threshold.

## 7) Owners and RACI (Role-Level)

- Engineering Lead: Prioritization, sequencing, release gate authority.
- Frontend Lead: Route guards, UI gating, workflow integration, tests.
- Backend/DB Lead: RPC contracts, SQL migration safety, data integrity.
- DevOps Lead: Secrets/CORS/deployment checks and runbooks.
- QA Lead: End-to-end test matrix, sign-off evidence.
- Product/Operations: Role-policy approval and workflow acceptance.

## 8) Validation Matrix (Required Before Go-Live)

### Automated Gates

1. `npm.cmd run typecheck`
2. `npm.cmd run lint`
3. `npm.cmd test`
4. `npm.cmd run build`

### Targeted Integration Tests

1. Auth session with missing profile cannot access protected routes.
2. Customer create/update persists hierarchy and finance fields.
3. New customer navigation resolves to actual UUID route.
4. Delivery photo/signature upload and retrieval works with private buckets.
5. Role matrix parity checks pass for all user roles.
6. OCR/document edge function calls succeed with production CORS configuration.
7. Delivery reassignment UI visibility matches backend rules.
8. Offline queue auto-sync triggers reliably.
9. Notification RPC error-path handling verified.

### Manual UAT Scenarios (Minimum)

1. Admin full workflow pass.
2. Sales rep full workflow pass.
3. Driver delivery workflow pass.
4. Applicator workflow pass (including app records access policy).

## 9) Go-Live Gate (Approval Checklist)

All items must be marked complete unless an explicit waiver is approved.

- [ ] P0 work packages complete and validated.
- [ ] P1 work packages complete and validated.
- [ ] Quality gates meet approved threshold.
- [ ] No unresolved security findings.
- [ ] Deployment secrets/CORS checklist complete.
- [ ] UAT sign-off by QA + Product/Operations.
- [ ] Final launch approval by Engineering Lead.

## 10) Reporting Cadence (During Remediation)

- Daily status: open P0/P1 count, blockers, changed risk level.
- Mid-phase checkpoint: evidence links for completed acceptance criteria.
- Pre-launch review: final gate checklist with pass/fail evidence.

## 11) Notes for Review

- This document is intentionally implementation-agnostic and intended for sign-off before fixes begin.
- After approval, convert each work package into tracked tickets with assignees, estimates, and due dates.
