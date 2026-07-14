# Offline Receipt Browser + Office Resolution Proof

**Date:** 2026-07-14
**Branch:** `codex/offline-receipt-activation-guards`
**Live state:** unchanged; all three offline-receipt migrations remain queued

## Scope

- Permanent receipt identity and stage/process/status integration for offline `complete_delivery` and `complete_job`.
- Browser retention until permanent `succeeded` proof.
- Distinct daily-cap, unresolved-backlog, needs-review, and office-resolved handling.
- Safe Saved Offline Work panel with explicit local acknowledgement.
- Admin/sales-only sanitized review queue and audited `already_completed` / `abandoned` resolution.
- Rate-limit, backlog, interrupted-response, same-receipt concurrency, same-key/different-receipt concurrency, and legacy multi-tab identity recovery.

## Safety properties proven

- Raw receipt payloads and permanent idempotency keys are absent from office/device review UI results.
- Only the original active actor can process a receipt; office users cannot impersonate or rerun it.
- Office resolution preserves receipt status `needs_review`, records resolver/time/note plus one `activity_feed` event, and never calls a canonical completion RPC or deletes the receipt.
- Each resolution idempotency key is transaction-serialized before its cache check, preventing one key from mutating two receipts.
- A durable action sends its queued entity `updated_at` snapshot into the permanent server receipt. A changed delivery/job becomes `TARGET_STATE_CONFLICT` office review before the completion RPC runs, while an exact replay of an already-committed `succeeded` receipt still recovers a lost response without repeating inventory work.
- `process_offline_action` rechecks the same snapshot immediately before the canonical mutation, closing the stage-to-process interruption window; a legacy row with no snapshot is retained as `LEGACY_OUTCOME_UNKNOWN` review work and cannot run.
- A stage replay returning the older base `needs_review` shape fetches full sanitized status, allowing the original device to discover an office decision.
- Two tabs upgrading the same legacy IndexedDB row derive the same SHA-256-based receipt UUID before any network request.
- A genuine pre-receipt production row is marked as legacy, reads the current target snapshot once, and atomically retains the first snapshot across racing tabs before staging. This preserves already-saved work while the server still catches every target change after recovery and before mutation.
- A blocked IndexedDB version upgrade rejects with an actionable close-other-tabs message instead of leaving an offline save pending forever; opened connections also close after use and on future version changes.
- A daily-cap or unresolved-backlog response waits one hour without consuming a retry, so saved work resumes automatically after pressure clears.
- Actionable offline drift (a moved job field, moved delivery item, or slightly fast completion clock) creates a sanitized `PAYLOAD_INVALID` office-review receipt; malformed and oversized payloads still fail closed.
- A completion time more than 14 days behind the server clock becomes sanitized `PAYLOAD_INVALID` office review instead of posting automatically into a potentially closed prior period.
- The browser removes an office-resolved local copy only after the original user confirms acknowledgement.

## Disposable database proof

Command:

```text
node scripts/smoke/prove-offline-action-review-resolution.mjs
```

Latest retained office-resolution database: `crx_offline_resolution_proof_mrkrpczi`

Latest retained concurrency/interruption database: `crx_offline_receipts_failure_proof_mrkrptnd`

Observed results:

- active admin and sales_rep can list safe queue metadata;
- applicator and anon are denied office access;
- exact resolution replay returns the cached result with one audit event;
- same key with changed arguments is rejected;
- the original actor can read safe resolution metadata;
- a second office session was observed waiting on the first receipt row lock before losing with `OFFLINE_ACTION_ALREADY_RESOLVED`;
- a second session using the same key on a different receipt was observed waiting on the first key lock, then rejected with `IDEMPOTENCY_ARGUMENT_MISMATCH`;
- the second same-key receipt stayed unresolved and received zero audit events;
- resolving one of 500 review items reduced unresolved backlog to 499 and allowed one new receipt;
- a job-field membership drift staged an idempotently replayable `PAYLOAD_INVALID` review receipt without exposing `field_acres` through the office queue;
- a delivery completion timestamp 30 days behind the server clock staged `PAYLOAD_INVALID` review work instead of running;
- a stale job `updated_at` snapshot staged an idempotently replayable `TARGET_STATE_CONFLICT` receipt before any canonical completion ran;
- a missing legacy snapshot staged `LEGACY_OUTCOME_UNKNOWN`, and a target changed after `received` but before processing became `TARGET_STATE_CONFLICT` with zero new application records;
- the 251st recent receipt returned `OFFLINE_STAGE_DAILY_CAP`;
- same-delivery and same-job processor races produced one business mutation; a connection terminated before commit left `received` with zero business mutation and retried once; a connection lost after commit replayed the same `succeeded` receipt with one mutation;
- final proof summary: `same_key_second_unresolved=true`, `backlog_unresolved=499`, `daily_recent=250`.

## Browser and automated verification

- `npm run test`: 244 files passed; 3,442 tests passed; 117 skipped.
- `npm run typecheck`: passed.
- `npm run lint`: passed.
- `npm run build`: passed; Vite emitted the existing large-chunk warning only.
- `npm run check:docs`: passed with 688 migrations, 76 pages, and 83 routes indexed.
- `npm run test:agent-workflows`: passed.
- Focused queue/receipt/sync/panel/office-page/route/idempotency suites passed: 7 files, 84 tests, including a real blocked IndexedDB v1-to-v2 upgrade simulation, racing legacy snapshot recovery, retry-safe lookup failure, and offline-only completion timestamps.
- Real headed Chromium loaded the branch preview and login shell without an application error after inheriting the main checkout's existing Vite environment in-process.
- Authenticated route rendering could not be performed in the real browser because no `E2E_TEST_EMAIL` / `E2E_TEST_PASSWORD` is configured. No production user credential was used. The office page, confirmation flow, activation-pending message, safe payload boundary, local acknowledgement, and concurrent-office refresh are covered by component tests.

## Independent adversarial review

The migration security, drift, and TypeScript reviewers initially found:

1. same-key concurrent resolution could mutate two different receipts;
2. the first race proof did not prove the losing session actually waited;
3. a normal `needs_review` stage replay could not discover office metadata;
4. the legacy local stale check could prevent lost-response receipt recovery;
5. stage/process results were typed as the fuller status response;
6. two tabs could assign different random IDs while upgrading one legacy row.

All six were fixed and re-reviewed. Those independent reviewers returned zero remaining BLOCKER, HIGH, or MEDIUM findings. The low UI concurrency-test gap was also closed.

Claude Opus then performed a separate review of the current uncommitted branch and returned `SHIP-WITH-FOLLOWUPS` with 0 BLOCKER, 1 HIGH, 2 MEDIUM, 3 LOW, and 1 NIT. The review identified four valid gaps that were fixed before commit:

1. blocked IndexedDB upgrades could leave every offline queue call pending forever;
2. actionable payload drift could fail only on the device instead of reaching the office queue;
3. a backlog-blocked action required a manual retry after the backlog cleared;
4. editing an office resolution after a failed submit could reuse an incompatible idempotency key.

The second Opus pass confirmed all four fixes, then found one additional HIGH and two MEDIUM issues. Those were fixed: target snapshots now become server-side `TARGET_STATE_CONFLICT` receipts without defeating lost-response recovery; the panel cannot spend retries while offline; and device-clock `p_completed_at` is sent only for genuinely offline deliveries. The third Opus pass returned 0 BLOCKER / 0 HIGH and confirmed those fixes, then identified the stage-to-process drift window, missing legacy snapshots, and the procedural database-before-frontend gate as MEDIUM. The process-time snapshot recheck and fail-closed unknown-snapshot receipt closed the first two; the third is enforced operationally by keeping the PR draft/unmerged until live database verification.

The first exact-commit Opus pass after the final `main` rebase returned `SHIP-WITH-FOLLOWUPS` but correctly elevated one rollout-compatibility issue: offline work saved by the pre-receipt production build had no snapshot and would have required manual office re-entry. That path is now hardened by the explicit legacy origin plus atomic current-snapshot recovery described above, matching the old app's behavior for already-saved rows while preserving all post-recovery drift guards. The same pass identified the missing old-clock lower bound, which is now closed by the 14-day review boundary. Remaining follow-ups are automatic device discovery of office resolutions, office visibility for old `received` receipts, pagination/count polish, and stale-tab release-note wording. The redundant partial-index note is non-blocking. The push guard separately records the required fresh final exact-commit Claude review in generated session state.

## Required release order

1. Obtain the final Claude Opus re-review and green PR checks.
2. Separately obtain Mason's explicit approval to apply the three live migrations in timestamp order.
3. Verify the live table/RPC/grant/function state and run a safe post-apply receipt smoke.
4. Only then merge the frontend PR.

Merging the frontend before the database rollout would make offline durable calls target RPCs that do not exist live, so this branch must remain unmerged until step 3 succeeds.
