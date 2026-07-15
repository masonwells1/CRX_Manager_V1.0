# CRX Full Foundation Gauntlet — Codex-Only Remediation Ledger

Date: 2026-07-14
Current base: `origin/main` at `a9271769`
Remediation branch: `codex/gauntlet-full-remediation-20260714`
Mode: Codex-only audit, implementation, and adversarial verification until the explicit final Claude review gate

## Verdict

The all-15-section gauntlet originally produced **0 BLOCKER, 8 HIGH, 9 MEDIUM, and 2 LOW** leads. Revalidation against current `origin/main`, exact live function bodies, the live migration ledger, and focused row-level probes separated them into code/source findings fixed by this branch, issues already fixed upstream, historical data needing owner-approved reconciliation, and prevention debt closed with deterministic tests.

No prompt, task, review, or artifact was sent to Claude during the gauntlet or Codex remediation. Native Codex subagents independently covered frontend/Edge behavior, money/inventory flows, database/security contracts, and release proof. All three adversarial lanes reached **CLEAN** after their verified findings were fixed. A later direct Claude review returned `SHIP-WITH-FOLLOWUPS` with 0 BLOCKER, 0 HIGH, 1 MEDIUM, and 2 LOW findings; all three findings were then fixed instead of deferred.

## Code Findings and Remediation

| Original finding | Disposition | Remediation / proof |
|---|---|---|
| Blend tables and Storage were broader than the office routes | Fixed locally | `20260714230100_blend_ticket_access_and_atomicity.sql` installs active admin/sales policies and a 10 MiB JPEG/PNG/WebP bucket contract. Rolled-back linked-schema compile and RLS smoke pass. |
| Blend tickets could create/link invalid orders | Fixed locally | `20260714230200_blend_ticket_order_lifecycle.sql` requires completed + approved + unbilled + customer + nonempty fully matched positive products, validates mappings, and refuses zero-link success. UI and full order smoke match. |
| Sales could call the admin-only batch-prepay wrapper | Already fixed on current main | PR #128/current source contains the top-level active-admin boundary. No duplicate migration was added. |
| Same-key concurrent mutators could duplicate effects | Fixed locally | `check_idempotency` takes a key-only transaction advisory lock. A trigger protects 43 legacy inline key writers by forcing a concurrent loser to roll back rather than silently losing `ON CONFLICT`. |
| Sales could enable PO over-receive without a reason | Fixed locally | `receive_po_items` requires admin plus a dedicated `over_receive_reason`; the server appends an `OVER-RECEIVE:` audit note. |
| Live offline migration missing from protected source | Fixed upstream during run | PR #124 merged the exact four-file source chain. Local Git blob hashes matched the reviewed/applied commit before refresh. |
| Reports claimed commissions were paid when it created a batch | Fixed locally | Reports now says “Create Payment Batch” and describes the required review/post step. |
| Empty/nonreconciling commission batches could post | Fixed locally | `post_commission_payment` rejects zero items and header/item total mismatch. The UI suppresses Post for empty rows. |
| Blend upload creation was non-atomic | Fixed locally | Manual and bulk creation share `create_blend_ticket`, which commits header/products/images/queue/activity in one transaction and replays a stable result. |
| OCR recovery treated resolved `{ error }` as success | Fixed locally | Bulk invocation and polling inspect resolved error payloads; the counter does not increment on failure. |
| Edge image limits were client-only and fully buffered | Fixed locally | The Edge Function is office-only, validates metadata/headers, and reads through a bounded stream. |
| Sensitive inventory report had an inconsistent role boundary | Fixed locally | `get_inventory_position()` calls `require_admin_or_sales_rep()`; applicator denial and office success are smoke-proven. |
| Billing status mutator lacked idempotency | Fixed locally | One trailing idempotency argument, strict actor/role checks, ticket lock, canonical save/replay, grants, types, and smoke coverage. |
| Chemical Application Report PDF lacked renderer regression | Fixed locally | Direct test asserts identity/customer/job/field/product/EPA/rate/total/REI/PHI/fallback/filename/footer output. |
| Idempotency coverage relied on a 55-name debt baseline | Fixed locally | Tests discover every generated or newly migrated direct/transitive mutator and require real key use or an evidence-backed exemption. The missing list is intentionally empty. |

## Codex Adversarial Findings Closed

The first remediation was treated as untrusted input by three independent Codex review lanes. Their additional findings were fixed and re-reviewed:

- **Database/security:** removed a trigger/RLS bypass around invoice provenance; narrowed Storage mutation policies to active admin or active sales owner/uploader; revoked direct execution of downstream trigger helpers; locked ticket/product state consistently; made product-parent version tokens strictly monotonic; and proved the hidden-invoice path with role-switched RLS smoke coverage.
- **Atomic editing:** `save_blend_ticket` now requires the expected ticket version and commits the complete product snapshot in one transaction. It validates product identity and ownership, detects duplicate or cross-ticket IDs, preserves omitted foreign keys while allowing explicit `product_id: null`, and rejects edits after processing or stale-version races.
- **Frontend lifecycle:** product add/remove stays local until atomic Save; unsaved header, product, or field edits block approval, rejection, invoicing, OCR, linking, order creation, and application-record creation. Removing the final field persists an explicit empty array. Both save paths disable the editable surface while in flight, and failed field hydration preserves the previous local snapshot.
- **OCR concurrency:** image reads are signed, bounded, MIME/path checked, and timed out. Processing uses leases, heartbeats, compare-and-swap ownership, and a service-only atomic commit RPC that refuses approval/link/lease races while preserving current manual values.
- **Order provenance:** exact source-line mappings, multi-line item support, missing inventory-row upsert, hardened unlink rules, and active-invoice/application/billing provenance checks are rollback- and concurrency-proven.

Final Codex verdicts: database/security **CLEAN**; frontend/Edge **CLEAN**; tests/release **CLEAN apart from the intentional unapplied-RPC live-signature gate described below**.

A final Codex-only current-base refresh after PR #132 found three regressions that earlier reviews missed, all fixed before the Claude gate:

- `check_idempotency` now preserves the already-live blank-key and blank-operation errors while adding the shared key-only serialization lock, so the return-lifecycle RPCs newly landed on `main` do not inherit weaker validation.
- `receive_po_items` treats a nullable over-receive flag as false; even an active admin with a reason cannot over-receive without an explicit affirmative override.
- `create_invoice_from_blend_ticket` now uses the shared serialized check/save helpers before taking the ticket lock, so concurrent same-key callers replay the winner instead of producing a stale-state loser error.

The linked rollback smoke covers both validation failures and the nullable override with zero receiving effects. The disposable two-session harness proves exact winner replay and one business effect/ledger row. Codex re-reviewed the corrected interactions with the new return-lifecycle migration and returned **CLEAN**.

The final independent Codex adversarial pass found four more cross-layer gaps that the prior Claude pass did not catch. All were fixed and re-reviewed **CLEAN**: direct invoicing now excludes soft-deleted blend tickets under the row lock; receiving rejects every nonpositive quantity and rolls back a mixed payload instead of returning a false success; bulk-upload recovery clears its in-memory UUID/key/form/images on an authenticated-user transition; and the Unlink action is disabled with a plain-English application-record explanation when the database will refuse it.

## Direct Claude Verification and Reconciliation

The repository-owned read-only wrapper supplied the complete `origin/main`-bound diff to Claude. Two initial Opus runs completed with an empty CLI result and were correctly recorded as `BLOCKED`, not clean. A safe-mode Sonnet high-effort retry completed `VERIFIED` with `FINAL_VERDICT: SHIP-WITH-FOLLOWUPS` and no permission denials.

Codex agreed with all three findings and fixed them:

- **MED — commission list availability:** a failed item-count query now marks only that payment row unverified, disables its Post action, reports the failure, and leaves every other row usable. A focused component test proves an unverified row and verified row can coexist safely.
- **LOW — application-record delete UX:** bulk deletion performs a bounded indexed application-record lookup before mutation, gives a friendly reversal instruction when provenance exists, and fails closed on lookup errors. Two focused tests prove refusal and the clean delete path.
- **LOW — linked header database parity:** the linked-ticket trigger now locks every editor-controlled content field, including the previously missed text fields, while preserving sanctioned lifecycle transitions. The linked rollback smoke proves both numeric and text mutations are rejected without changing stored values.

A corrected-diff Claude re-review then found a separate direct-invoice path and returned `NEEDS-WORK` with 1 HIGH and 1 MEDIUM:

- **HIGH — direct-invoice product provenance:** an approved ticket can be invoiced without an order link. The product trigger now treats any nondeleted, non-voided/non-cancelled invoice as downstream provenance, runs with RLS-safe definer rights, locks both old/new parents, and blocks insert/update/delete/reparent product changes. The hidden-invoice sales-role smoke proves rejected quantity edits leave the product unchanged.
- **MEDIUM — direct-invoice header parity:** the downstream invoice/application-record header lock now includes `job_number`, `invoice_number`, `driver_name`, `mixer_name`, and `tank_number`, completing parity with the ticket editor payload. The UI uses one content-lock predicate for linked or billed tickets across header/product fieldsets, Save, add, remove, and product-update handlers. A billed/unlinked component test proves the editor is locked while sanctioned non-editor lifecycle actions remain available.

Later corrected-diff reviews found and closed the remaining lifecycle and retry gaps instead of deferring them:

- **Upload uncertainty and hydration:** a thrown bulk-create RPC is now treated as an unknown outcome, recovered by the stable idempotency key after reload, and never blindly retried into duplicate work. Post-save state is rehydrated before downstream actions can resume.
- **Persisted downstream locks:** application-record provenance, active invoices, and linked orders now lock the matching header, application-field, and product editing surfaces. Reload-safe upload recovery and failed or stale lifecycle hydration fail closed.
- **OCR lease liveness:** the Edge processor serializes periodic heartbeats while work is active, so a long AI call cannot silently lose its lease and later commit under expired ownership.
- **Order/invoice mutual exclusion:** an active invoice blocks link, unlink, and create-order paths in both SQL and UI; a linked order blocks direct invoice creation; and stale active-invoice state is rechecked under the ticket lock. Rollback smoke proves every rejected route leaves orders, links, invoices, commissions, idempotency rows, activity, inventory, and audit state unchanged.
- **Manual-create reload uncertainty:** the exact user-scoped ticket UUID, idempotency key, header, and product snapshot are persisted before the RPC and restored locked after reload. Known success or definite failure clears the record; retries refresh its bounded TTL; malformed UUID records are rejected; and an in-place user switch clears the prior user's in-memory intent without deleting that user's scoped recovery record. Eight focused tests cover success, definite/uncertain outcomes, remount replay, user isolation, malformed storage, and product identity.
- **Image availability isolation:** a transient signed-URL failure is contained to that image tile, recorded to Sentry, and explained with a warning; it no longer rejects the whole `Promise.all` loader and hides the otherwise usable ticket page.

The next current-base Claude pass returned `SHIP-WITH-FOLLOWUPS` with two MEDIUM and seven LOW/informational hardening findings. None were deferred:

- **Storage signing timeout:** signed-URL creation now has its own bounded timeout before the already-bounded image fetch. A never-resolving signer test proves failure closes in finite time.
- **Manual OCR header intent:** `manually_corrected_fields` records every OCR-managed header included in an office save, including an intentional blank. OCR fills only untouched blanks, so a deliberately cleared tank number is no longer repopulated by a late worker.
- **OCR/catalog and product bounds:** OCR commit rejects inactive catalog product IDs atomically. Both ticket creation and versioned saves reject snapshots over 200 product rows.
- **Scoped idempotency cleanup:** `check_idempotency` removes an expired row only for the requested key; an unrelated expired key survives the smoke probe.
- **Complete receiving audit:** the required over-receive reason is now written to both the receiving record and the matching inventory transaction.
- **Truthful billing activity:** a null/no-op payment-status request still saves/replays idempotently but creates no false “changed to unchanged” activity row.
- **Exact order-link identity:** existing null line identities fail the migration with an explicit reconciliation error; the column becomes `NOT NULL`; the uniqueness index is full rather than partial; and the link/create/unlink RPC names must each have exactly one overload.

All reported code findings are fixed and independently Codex-reviewed. The terminal corrected-diff Claude review is `VERIFIED` with `FINAL_VERDICT: SHIP-WITH-FOLLOWUPS`, no permission denials, and no BLOCKER/HIGH finding. Its remaining operational follow-ups were closed on 2026-07-15: the live order-link table is empty, no unposted commission header/item mismatch exists, and the legacy commission money-unit wording is corrected. The normal final exact-commit Claude review after live-derived schema artifacts are regenerated is still required to mint the HEAD/base-bound push proof.

## Additional Defect Found by the Smoke

The first successful-order replay returned only `{success, order_id}` while the first call returned the full order payload. `create_order_from_blend_ticket` now builds one `v_result`, saves that exact object, and returns it on both execution and replay. The full smoke failed on the mismatch, then passed after the fix.

## Historical / Live Data Requiring Separate Approval

No live rows were changed.

| Live state | Evidence and next decision |
|---|---|
| Eight empty unposted `SEED` commission batches, $1,500 header total | New code prevents posting. Voiding/quarantining existing rows requires Mason’s approval. |
| PO-2026-0008 marked fully received with seven open lines | Old aggregate rollup was hidden by large overreceipts; code is linewise now. Correcting status/reviewing receipts requires approval. |
| PO-2026-0015 received quantity with no `receiving_records` row | Historical March receipt predates the current receipt ledger path. Reconciliation needs operational evidence. |
| One posted `[E2E] DEMO-INV-49874d` invoice with zero items | The row says it is throwaway test data. Deletion/voiding still requires approval. |
| Five March completed deliveries with no items | Their orders also have zero items and no invoices. Historical cleanup needs an owner decision. |
| Eighteen negative inventory rows | Negative stock is an intentional warn-and-reconcile state. Correct quantities require physical counts; zero-clamping would destroy discrepancy evidence. |

## Executed Evidence

- Branch refreshed to current `origin/main`; divergence `0 0` before verification.
- During review, `origin/main` first advanced to `849642bc` with five earlier money/inventory migrations, then to `a9271769` with the live return-lifecycle hardening from PR #132. The remediation was safely stashed, fast-forwarded, reapplied, and additive documentation conflicts reconciled each time. A fresh remote-ledger query confirmed versions `20260714220000` through `20260714224000`; PR #132 records the return hardening live, and the refreshed linked-schema rollback smoke compiled and passed against that current remote state. Only this branch's three migrations remain pending.
- Blend Ticket detail component proof: **24/24 passed**, including add/edit/save, remove/save, remove-all-fields, dirty-state gates, failed hydration, downstream application-record/invoice field locking, linked-only field editing, active-invoice link/create/unlink refusal, linked-order direct-invoice refusal, stale-active-invoice refusal, and in-flight edit exclusion. Bulk upload retry/reload proof adds **7/7 passed**.
- Deno Edge guard tests: **11/11 passed**; `deno check --no-config --no-lock --node-modules-dir=auto` passed for the Edge entrypoint and guard module.
- TypeScript typecheck: **PASS**.
- ESLint: **PASS**.
- Production build: **PASS**.
- Manual ticket atomic/reload recovery proof: **8/8 passed**.
- Pre-apply full Vitest run: **3,498 passed, 117 skipped** across 250 files, with only the intentional live-signature queued-RPC gate failing. After apply, the live RPC snapshot regenerated to 393 names, both new RPCs are present, the queued exceptions are removed, and the focused 10-test fixture suite passes.
- Agent workflow suite, correction guards, dependency verification, agent health, frontend validation, and `npm audit --omit=dev`: **PASS** (zero production dependency vulnerabilities).
- Changed-only SQL audit: **3 files, 0 violations, 1 reviewed warning**. The `customer_name` token is a canonical alias/local value and a real `invoice_shares` column, not an invalid direct-column assumption.
- Rolled-back linked-schema migration compile: `GAUNTLET_MIGRATIONS_COMPILED`.
- `plpgsql_check` on eight changed callable functions: `PLPGSQL_CHECK_CLEAN`, zero errors.
- Full linked rollback smoke: `SMOKE_PASS_ROLLBACK` after auth, replay, commission, receiving, product-cap, inactive OCR product, manual-header preservation, blend lifecycle, billing, inventory-role, RLS, and grant assertions.
- Disposable concurrent-session proof: **PASS** for idempotency serialization, blend locking, OCR approval/link/lease races, and cleanup of the isolated container.
- The old billing signature has no blocking live database dependents.

## Remaining Gates

1. Require the complete release suite green against the refreshed live artifacts.
2. Commit and run the final exact-commit Claude review to mint the protected push proof.
3. Push the branch, open a PR, wait for required checks including Vercel, merge, and verify production. Old frontend tabs must refresh before another blend upload. Live-data cleanup remains a separate checklist.
