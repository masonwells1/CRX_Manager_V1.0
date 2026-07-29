# Section 10 refresh — Blend tickets, OCR, review/payment/order link, and Edge handoff

**Cycle:** 2026-07-25 (performed 2026-07-26)
**Verdict:** **MEDIUM finding — repair the `process-document` Vision timeout before relying on it for bounded OCR completion.** The blend-ticket lifecycle, current link/unlink actor binding, idempotency, state guards, and current live data are otherwise clean in the evidence available below.
**Scope:** audit only; no application, schema, Edge Function, test, hook, process-document, generated-type, plan, manual, or live-service changes were made. The normal pre-commit hook regenerated only the mandatory date stamp in `docs/app-workflow-map.html` (Jul 23 → Jul 26); that mechanical map churn is included with this report.

## Baseline, isolation, and collision check

- Fresh `origin/main` base: `31d8e4d3ed25832d4d63206488fdf4a910222c91`.
- Isolated worktree: `C:\Users\mason\.codex\worktrees\section10-blend-ocr-refresh-20260725\CRX_Manager`, branch `codex/section10-blend-ocr-refresh-20260725`.
- Supplier Pricing Stage B1's committed diff contains delivery, order, quote, return, supplier-pricing, Product presentation, and its own planning/handoff files; it has no BlendTicket/OCR/process-document source overlap. Stage B2 is at the same `origin/main` SHA and clean. This report is the sole intended change in this lane.
- Graphify was refreshed at `31d8e4d3` (7,965 nodes / 16,566 edges). Query used: `graphify query "what connects BlendTicket OCR process-blend-ticket process-document and blend ticket order linking" --budget 1200`. Its result scoped the review to `BlendTickets`, `BlendTicketDetail`, upload/create components, `useOCRProcessor`, `documentOCR`, both Edge Functions, and their RPC contracts. Every material conclusion below was then checked in current source and/or live read-only data; Graphify alone is not treated as proof.

## Findings

### M1 — `process-document` has no timeout around paid Google Vision calls

`supabase/functions/process-document/index.ts:76-104` calls `fetch()` without an `AbortSignal` timeout. `ocrAllPages()` starts up to five of those calls concurrently and waits for every one (`:106-123`). A stalled provider connection can therefore hold the request until the platform terminates it rather than failing at a controlled application deadline. The otherwise comparable blend-ticket worker explicitly uses `AbortSignal.timeout(OCR_NETWORK_TIMEOUT_MS)` with a 45-second limit (`process-blend-ticket/index.ts:752-780`).

Impact is operational reliability and bounded provider work for invoice, purchase-order, customer-list, and quote-list OCR. It is not a confirmed blend-ticket data-integrity or authorization bypass: `process-document` performs no application-data write in this path, and the caller receives a failure only when the request eventually returns. The repair should add a bounded timeout to the document Vision fetch, preserve the existing caught error response/Sentry capture, and add a stalled-provider test. Do not silently retry paid OCR at this boundary.

### L1 — historical six-function inventory is stale, not a current runtime defect

The 2026-06-17 full-gauntlet report records six active functions. Current live metadata lists **seven** active JWT-enforced functions: the former six plus `epa-lookup` v4. The local function directories also contain those seven plus `_shared`. The dated historical report is valid as historical evidence, but must not be quoted as the current active-function inventory.

## Confirmed clean or protected paths

### Ticket state and UI contract

Live `blend_tickets` CHECK constraints and `src/types/index.ts:1537-1541` agree exactly:

| Field | Current permitted values |
| --- | --- |
| `status` | `pending`, `processing`, `completed`, `failed`, `needs_review` |
| `review_status` | `unreviewed`, `approved`, `rejected` |
| `order_link_status` | `unlinked`, `linked` |
| `payment_status` | `unbilled`, `billed`, `prepaid`, `no_charge` |

`BlendTicketDetail` requires completed OCR, approved review, unbilled payment, unlinked status, matched active products, and no local dirty state before link/create-order actions (`:135-153`). It prevents direct invoice creation after an order link and protects unlinking when payment, an active invoice, or an application record makes the relationship immutable (`:155-173`, `:812-847`, `:1716-1732`). The current detail tests contain focused UI guards for these downstream locks; see limitations for execution status.

### Link/unlink/create-order actor and idempotency boundary

The live metadata query confirmed these public RPCs are `SECURITY DEFINER` with `search_path=public, pg_temp`, have no `anon` execute privilege, and retain authenticated execution only where intended:

- `link_blend_ticket_to_order(uuid,uuid,jsonb,uuid,text)` and `unlink_blend_ticket_from_order(uuid,uuid,text)` both contain `auth.uid()`, `ACTOR_MISMATCH`, idempotency check/save, and `FOR UPDATE`.
- `create_order_from_blend_ticket(uuid,text,date,text,uuid,text)` has the same actor/idempotency/row-lock evidence plus review/link/payment lifecycle guards.
- `create_blend_ticket(...)` similarly has `auth.uid()`, `ACTOR_MISMATCH`, and idempotency evidence.
- `commit_blend_ticket_ocr_result(uuid,uuid,uuid,jsonb,jsonb,text)` is service-role worker-only (`anon_exec=false`, `authenticated_exec=false`), uses a row lock and queue-lease/idempotency fencing; it has no caller actor parameter, so `ACTOR_MISMATCH` is not expected there.

The UI passes `profile.id`, obtains operation-specific keys from `useIdempotencyKey`, and calls `assertRpcResult()` for link, unlink, and create-order (`BlendTicketDetail.tsx:37-39`, `:782-846`, `:926-955`, `:1661-1677`). The live function properties supersede the historical June actor-finding: it is not reopened by this refresh.

### Blend OCR handoff

`process-blend-ticket` v25 is ACTIVE with JWT verification. Deployed-source retrieval and local source both show an explicit Authorization/user lookup, active-profile gate for `admin`/`sales_rep`, pre-OCR unreviewed/unlinked/unbilled gating, active-invoice/application-record guards, queue ownership/lease heartbeat, CAS updates, and atomic `commit_blend_ticket_ocr_result` handoff. Image metadata is constrained to 1–20 ticket-scoped JPEG/PNG/WebP records, each no larger than 10 MiB; signed download MIME and streamed body are revalidated. Network reads and Vision calls use the 45-second timeout above.

The bulk uploader deliberately makes the initial Edge invocation non-blocking and captures trigger failure to Sentry; the page-level queue poller is the recovery path (`BulkTicketUpload.tsx:235-251`, `useOCRProcessor.ts`). This is an intentional asynchronous contract, not a false success claim: a ticket is created atomically before OCR is started, and the server owns the queue/lifecycle transition.

### General document OCR handoff

`process-document` v19 is ACTIVE with JWT verification. It requires a verified active `admin`, `sales_rep`, or `applicator`; unauthenticated requests return 401 and rejected profiles return the shared 403 response. It fails closed for retired `price_list` and `product_list` values both during request validation and at the provider boundary.

Before provider work, the function bounds request input to 52,000,000 bytes on the wire, 20 pages, 5,000,000 decoded bytes per page, and 37,000,000 decoded bytes total. It recognizes JPEG, PNG, PDF, WebP, BMP, and TIFF magic bytes. The client restricts individual input files to 10 MiB, renders at most 20 PDF pages, and surfaces Edge/function failures as a structured unsuccessful OCR result. These controls are meaningful; M1 is the remaining unbounded portion after validation.

## Live read-only evidence

The query was read-only and made no RPC or Edge Function invocation.

- `blend_tickets`: **0** non-deleted rows, so there are no current live status combinations to remediate and no lifecycle transition could be exercised safely.
- `ocr_processing_queue`: **0** rows.
- `blend-ticket-images` Storage: **1** object; this is not an orphan judgment and was not touched.
- RLS is enabled on both `blend_tickets` and `ocr_processing_queue`.
- Edge metadata: `process-blend-ticket` v25, artifact SHA-256 `69de9f941c6b64e5aacf869697541dd86b292af96cd3b991013d15615f2976ed`; `process-document` v19, artifact SHA-256 `166f6ffeb4e6b4d7bb82a52cc20f92385a48dd2a4d1f318391a45ad0b254d7fe`; both `ACTIVE` and `verify_jwt=true`.

## Coverage and proof limitations

Focused test assets exist for upload retry/idempotency, manual atomic creation, queue polling, document client conversion/error mapping, retired document types, blend detail lifecycle locks, RPC contract/idempotency coverage, and Deno guards for image/lease behavior. The document-type test specifically proves retired pricing types reach the provider boundary zero times.

The initial focused test command was blocked because the isolated checkout has no local dependency installation, and `deno` is not installed on this machine. For the required normal commit, the hook then ran through an ignored local junction to the already-installed workspace dependencies: **294 Vitest files passed; 3,939 tests passed and 118 skipped**, plus lint (0 errors; 3 pre-existing warnings), typecheck, build, agent-workflow checks, guard-hook tests, documentation drift, and dependency-integrity checks. The Deno-only blend Edge guard suite still was not executed, so a live/provider path remains untested.

Likewise, no Google Vision request, Storage write/read, Queue mutation, Edge invocation, deploy, migration, or production data write was performed. The Supabase management API returned deployed source for both active functions, which is enough to compare the reviewed auth/guard/timeout logic semantically. It does not expose a repository-commit provenance mapping from the deployed artifact SHA to `31d8e4d3`; byte-for-byte full-artifact provenance remains **blocked**, not inferred.

## Recommended next step

Implement and test a bounded timeout for `process-document` Vision calls, then run the Deno Edge guard suite in an environment with Deno available. Keep the current link/unlink and blend-worker controls unchanged.
