# Section 12 Refresh — Edge Functions

Date: 2026-07-28  
Audit baseline: `origin/main` / `bf0cbced`  
Remediation baseline: `origin/main` / `68b47bf4`  
Mode: read-only code, Graphify, Supabase catalog, and Edge-log inspection

## Verdict

**FIXED LOCALLY — 0 BLOCKER / 0 HIGH / 0 OPEN MED / 0 LOW**

## Resolved During Refresh — Google Vision timeout

The refresh initially confirmed that `process-document` sent the Google Vision `fetch(...)` without an abort signal or explicit timeout. The local fix extracts the provider call to `visionApi.ts`, applies one shared `AbortSignal.timeout(120_000)` across the complete multi-page OCR job, and converts standardized `TimeoutError`/`AbortError` failures into a controlled timeout message. A standalone provider call retains a 45-second default. Non-timeout Google API errors retain their prior status/body detail.

Focused proof:

- production timeout signals, 45-second single-call default, and 120-second total multi-page bound
- controlled timeout conversion
- non-timeout provider-error preservation
- sequential batches share one deadline rather than resetting the clock
- 46 focused OCR/document tests pass
- typecheck and lint pass (four pre-existing warnings)
- production build passes
- full suite passes: 303 files, 4,001 passed, 118 skipped

## Verified Safe

- All seven live functions are active and configured with `verify_jwt=true`: `create-user`, `setup-blend-tickets-storage`, `process-blend-ticket`, `process-document`, `send-email`, `reset-user-password`, and `epa-lookup`.
- Every reviewed function performs a server-side `auth.getUser(...)` check.
- `process-blend-ticket` already bounds its external OCR request.
- The last 24 hours of Edge logs contained no errors.
- Current Supabase Edge Function changes reviewed for this refresh did not introduce a breaking change relevant to these functions.

## Limitations

The 24-hour log result was empty, so it proves no observed errors but not a successful invocation. No function was deployed or invoked with customer data.

## Recommended Next Action

Complete governed review and publish the branch through the normal PR flow. Deployment remains a separate approval gate.
