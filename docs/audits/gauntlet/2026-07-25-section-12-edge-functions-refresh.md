# Section 12 Refresh — Edge Functions, Auth, Email, and Document Contracts

**Date:** 2026-07-25
**Auditor:** Codex (read-only, report-only)
**Base reviewed:** `25363345adeabb5b2b08a3772a0de3f0edcb3952` (`origin/main` at worktree creation)
**Verdict:** **NEEDS FOLLOW-UP — 0 BLOCKER, 0 HIGH, 1 MEDIUM, 0 LOW**

## Scope and boundaries

This is a focused refresh of Section 12 from
`docs/audits/gauntlet/2026-06-17-sections-02-15-full-gauntlet.md`. It covered
the Edge Function authentication/CORS boundary, `send-email`, and
`process-document` contracts. It did not alter or deploy an Edge Function,
change secrets, query or mutate business data, or inspect the active
Product/Supplier implementation lane. `epa-lookup` was included only in the
local/live inventory because its deeper behavior belongs to that excluded
Product lane.

The prior Section 12 report called the then-six-function inventory clean
(`2026-06-17-sections-02-15-full-gauntlet.md:312-321`). That inventory is now
stale: the repository and live metadata both show seven deployed function
names, with `epa-lookup` added. This is an inventory refresh, not by itself a
deployed-versus-repository bundle-parity proof.

## Finding

### S12-1 — MEDIUM: timestamp-derived invoice email keys defeat user-retry deduplication

`send-email` correctly deduplicates only an *identical* `idempotency_key`
against `email_log` before contacting Resend
(`supabase/functions/send-email/index.ts:452-480`, `:676`). However, the
shared invoice payload builder generates a new key with `Date.now()` when its
caller does not provide one (`src/lib/emailService.ts:149`). The builder is
used by `FieldApplicationInvoice` (`src/pages/FieldApplicationInvoice.tsx:2118`)
and `FieldInvoicesListPanel`
(`src/components/field-invoices/FieldInvoicesListPanel.tsx:290`). Three other
reachable invoice paths construct timestamp-suffixed keys directly:
`FieldInvoicesUnpostedPanel`
(`src/components/field-invoices/FieldInvoicesUnpostedPanel.tsx:299`),
`FieldInvoicesPostedPanel`
(`src/components/field-invoices/FieldInvoicesPostedPanel.tsx:308`), and
`InvoiceDetail` (`src/pages/InvoiceDetail.tsx:1226`).

There is no automatic retry claim here: `sendEmail` performs one `fetch`
(`src/lib/emailService.ts:55`) and `runCriticalAction` invokes its supplied
action once (`src/lib/criticalAction.ts:46`). If a user re-clicks Send after an
ambiguous network result, the new timestamp makes the second attempt look like
a new send to the server, even though it represents the same intended action.

**Business risk:** a grower can receive duplicate invoice email when the first
send reached Resend but the browser did not receive the response. The durable
email log remains internally consistent, but its deduplication guard cannot
protect those retries.

**Fix direction:** retain/cache one per-invoice operation key across a failed
or ambiguous user retry, then clear or rotate it only after confirmed success.
A deliberate "Send again" action should generate a new key. Add a focused test
that simulates an ambiguous first result and proves a user re-click reuses the
exact key while an intentional resend does not.

## Repository correctness observed

- The six in-scope non-Product functions use the shared CORS helper. It fails
  loud in production when `ALLOWED_ORIGIN` is absent and has a constrained
  preflight response (`supabase/functions/_shared/cors.ts:4-40`).
- The shared profile gate fails closed on lookup error, inactive accounts, and
  unauthorized roles (`supabase/functions/_shared/auth.ts:66-90`). The reviewed
  handlers authenticate the bearer token with `auth.getUser()` before
  constructing their service-role client and applying that gate.
- `create-user`, `reset-user-password`, and the inactive
  `setup-blend-tickets-storage` helper require an active admin. The user-admin
  endpoints also reject password operations for `entity_recipient` service
  profiles. `setup-blend-tickets-storage` only returns configuration guidance;
  it does not create a bucket. No application caller was found for that helper
  in the scoped source search. This audit does not recommend deleting or
  undeploying it.
- `process-blend-ticket` has the same token/profile boundary and its
  queue-commit path supplies an idempotency key
  (`supabase/functions/process-blend-ticket/index.ts:803-825`, `:1176`).
- `process-document` permits only active `admin`, `sales_rep`, or `applicator`
  callers (`supabase/functions/process-document/index.ts:656-693`); validates
  the document type; caps the request, each page, and total decoded input
  (`:622-750`); and sends processing failures to Sentry (`:759-798`).
- `send-email` validates caller role, customer-bound recipient, role/type
  allowlists, rate limit, invoice lifecycle, and idempotency before its Resend
  request (`supabase/functions/send-email/index.ts:35-72`, `:110-187`,
  `:439-480`, `:676`). The focused invoice-authority contract test also covers
  the final lifecycle recheck immediately before provider dispatch.

## Live deployment metadata — read-only

Command executed from this worktree:

```text
supabase functions list --project-ref rhyzpcqhnizqbxphqdkr --output json
```

The command completed successfully on 2026-07-25. All seven live functions
are `ACTIVE` with `verify_jwt=true`:

| Function | Live version |
| --- | ---: |
| `create-user` | 23 |
| `setup-blend-tickets-storage` | 18 |
| `process-blend-ticket` | 25 |
| `process-document` | 19 |
| `send-email` | 18 |
| `reset-user-password` | 15 |
| `epa-lookup` | 4 |

The local function directories match this seven-name inventory plus `_shared`.
`seed-admin` is absent from the local and live inventories. The CLI response
supplied function status, version, JWT setting, and bundle hash only; it did
not expose deployed source. Consequently, this audit does **not** claim
byte-for-byte bundle parity, deployed-secret presence (`ALLOWED_ORIGIN`,
`RESEND_API_KEY`, `GOOGLE_VISION_API_KEY`, or `SENTRY_DSN`), provider delivery,
or a real OCR/email transaction. No deploy, invocation, or secret read was
attempted.

## Focused proof and coverage

After lockfile-faithful `npm ci`, these focused suites passed:

```text
npx vitest run src/lib/sendEmailEdgeGateContracts.test.ts \
  src/lib/emailService.test.ts src/lib/documentOCR.test.ts \
  src/lib/processDocumentTypes.test.ts src/hooks/useOCRProcessor.test.tsx \
  src/lib/gauntletRemediationGuards.test.ts

Test Files  6 passed (6)
Tests       85 passed (85)
```

They cover browser request shapes, document-type handling and client error
paths, document boundary guards, the blend-ticket remediation guard, and the
server-source invoice lifecycle gate. They do not execute a deployed Edge
Function or prove secrets/provider behavior. A direct `deno check` was also
attempted but is blocked because `deno` is not installed on this workstation.

Graphify was refreshed at the reviewed base (`graphify-out/GRAPH_REPORT.md`:
commit `25363345`, 7,923 nodes, 16,456 edges). Narrow queries
`graphify explain sendEmail --budget 800` and
`graphify explain processDocumentWithOCR --budget 800` identified the direct
frontend boundaries; the material auth and handler conclusions above were then
confirmed in current source rather than accepted from the graph alone.

## Recommended next step

Repair S12-1 in a separate, narrowly scoped email-retry change, with a
same-key retry test and an intentionally-new-key resend test. Before any Edge
Function deployment, obtain the required owner approval and run a real
non-production-safe send/deployment proof.
