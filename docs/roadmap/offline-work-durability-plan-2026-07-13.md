# Offline Work Durability Plan

> **Status update — 2026-07-14:** Stage 1A is merged. The approved Stage 1B feature branch now integrates permanent receipts into the two real producers, retains local work until server-proven success, adds distinct cap/backlog handling, exposes a safe device panel, and adds audited non-destructive office resolution. All three migrations are live and verified; the browser rollout remains pending this branch merge. Signature/photo replay, notification/email replay, cross-tab lease, and general duplicate/conflict policy remain deferred.

**Status:** STAGE 1B DATABASE LIVE + VERIFIED — browser and office UI pending feature-branch merge
**Date:** 2026-07-13
**Risk:** HIGH — delivery completion changes inventory and order/invoice state; job completion changes inventory and application records

## Recommendation in plain English

Build this in two controlled stages:

1. **Stop silent loss immediately in the browser.** Never automatically delete an offline action because it is old, failed three times, or conflicted. Slow retries down, keep failures visible, and give the user a review screen.
2. **Add a server receipt after the browser fix is proven.** As soon as connectivity returns, copy the action to Supabase under a permanent client-generated action ID before processing it. The local copy is removed only after Supabase records a successful result.

Stage 1 closes the active defect without a database change. Stage 2 adds office-visible recovery and protects against the app closing during replay. No web design can recover work from a phone that is destroyed or its browser data is cleared before the phone reconnects; that residual limitation must be stated honestly.

## What is verified today

### Active producers

| Screen | Offline operation | Business effect | Conflict snapshot |
|---|---|---|---|
| `DeliveryDetail.tsx` | `complete_delivery` | inventory, order fulfillment, remainders, draft billing | **missing** |
| `FieldStop.tsx` | `complete_delivery` | inventory, order fulfillment, remainders, draft billing | present |
| `FieldView.tsx` | `complete_job` | inventory, job status, application record, draft billing | present |

`offlineSync.ts` knows nine operation names, but only the two operations above currently have real queue producers. The redesign should use a typed allowlist so a name in the replay switch cannot be mistaken for a supported offline workflow.

### Current loss sequence

1. The action is stored only in browser IndexedDB.
2. `OfflineBanner` checks the total count every five seconds and automatically starts sync whenever the browser reports online.
3. Before replay, `syncPendingActions()` permanently removes every action with three failures and every action older than seven days.
4. Retries have no delay. A persistent error can be attempted repeatedly as the banner toggles out of its syncing state.
5. A conflict is assigned `retryCount = 3`. The next automatic sync deletes it before replay.
6. The banner does not render the returned `conflicts` list or individual errors. A later cleanup-only pass can replace the failure with a misleading zero-action success message.
7. A successful business RPC removes the local action. Offline-only follow-up work is not checkpointed: signature images, delivery email, and client-triggered completion notifications do not replay through the current queue.

The current unit tests lock in the dangerous cleanup behavior: they assert that three-strike and seven-day actions are deleted. Those tests must be replaced, not merely supplemented.

### Duplicate protection and its limit

Both active RPCs accept an idempotency key, and their current SQL implementations lock the target row and enforce lifecycle state. That prevents the normal double-inventory path during a quick retry. However, server idempotency records expire after 24 hours. A durable offline design therefore cannot treat the current idempotency table as a permanent receipt for a week-old action.

## Stage 1 — browser safety fix (recommended first build)

No migration and no live-service mutation.

### 1. Replace delete-on-failure with explicit states

Upgrade the IndexedDB record shape without deleting version-1 records:

```text
pending -> retry_wait -> syncing -> core_succeeded -> done
                         |                |
                         v                v
                    needs_review     followup_pending
```

Add:

- a UUID `clientActionId` independent of IndexedDB's numeric key;
- a typed operation (`complete_delivery` or `complete_job` initially);
- `status`, `attemptCount`, `lastAttemptAt`, `nextAttemptAt`, `lastError`, and `failureKind`;
- required `entityTable`, `entityId`, and `snapshotAt` for every critical action;
- a schema version so old records can be upgraded safely on read.

Remove `clearFailedActions()` and `clearStaleActions()` from automatic sync. Unresolved work has no time-based deletion. Only a proven successful action may leave the active queue.

### 2. Make retries controlled and single-flight

- Run one sync process at a time across the app.
- Attempt once when connectivity returns, then use a bounded delay such as 30 seconds, 2 minutes, and 10 minutes.
- After the retry limit, move the action to `needs_review`; do not keep hammering the server and do not delete it.
- Treat browser `navigator.onLine` as a hint, not proof that Supabase is reachable.
- Classify conflicts, authorization/validation failures, unknown operations, and missing entities as `needs_review`. Only network/time-out failures should auto-retry.

### 3. Add an Offline Work review surface

The global banner should show separate counts for:

- waiting to sync;
- retrying later;
- needs review;
- follow-up incomplete.

An `OfflineWorkPanel` opened from the banner should show a safe business label, queued time, last attempt, and a plain-English error. It should link to the delivery/job when possible.

Actions in Stage 1:

- `Retry now` for retryable failures;
- `Copy support ID` using `clientActionId`;
- no generic one-click delete;
- conflict resolution remains a deliberate office-review action, behind `ConfirmModal`, and must say exactly which offline work will be abandoned.

The initial build should not expose raw JSON payloads because they can contain names, notes, and application details.

### 4. Preserve the full completion, not only its core RPC

Use checkpointed steps so reconnecting cannot repeat inventory while losing proof or communication:

1. run the canonical business RPC;
2. retain its asserted result;
3. upload the queued signature image, when one was captured;
4. run each required notification/email step with its own completion flag;
5. mark `done` only when all mandatory steps finish.

Signature blobs should live in a separate IndexedDB attachment store keyed by `clientActionId`, not inside the JSON action. A failed signature upload moves to `followup_pending`; it must never call `complete_delivery` again just to retry the image.

Customer email remains governed by the user's original opt-in/opt-out selection, which must be saved with the queued action. Notification/email sends need their own idempotent contract before automatic replay; otherwise a response loss can send duplicates.

### Expected Stage 1 files

- `src/lib/offlineQueue.ts`
- `src/lib/offlineSync.ts`
- `src/components/ui/OfflineBanner.tsx`
- new `src/components/ui/OfflineWorkPanel.tsx`
- the three producers: `src/pages/DeliveryDetail.tsx`, `src/pages/FieldStop.tsx`, `src/pages/FieldView.tsx`
- focused tests beside each changed module/component
- `docs/manual/KNOWN_ISSUES.md` after the implementation is proven

This is multi-file, inventory-affecting behavior. Implementation starts only after Mason approves this plan.

## Stage 2 — Supabase receipt and recovery layer

This is a separate database design and approval cycle after Stage 1 is stable.

### Proposed server contract

Add an append-oriented `offline_action_receipts` table with:

- unique `client_action_id`;
- authenticated actor, operation, entity type/id, sanitized payload, and original idempotency key;
- `received`, `processing`, `succeeded`, or `needs_review` status;
- attempt/error timestamps and the asserted business result;
- no automatic deletion of unresolved rows.

Security requirements:

- RLS enabled in the same migration;
- the creator sees their own receipt; admin/sales roles can see review items;
- no client-side direct update/delete;
- SECURITY DEFINER RPCs use `public, pg_temp`, verify `auth.uid()`, verify actor identity, and accept only the two explicitly supported operations;
- no dynamic function name or arbitrary JSON-to-SQL dispatch.

### Replay shape

1. `stage_offline_action(...)` stores or returns the receipt using `client_action_id` as the permanent key.
2. `process_offline_action(client_action_id, idempotency_key)` reads the staged payload and explicitly calls the matching canonical RPC.
3. The business call and success receipt are committed together. A lost HTTP response can then be recovered by reading the receipt instead of repeating inventory work.
4. Failures are captured as `needs_review` without deleting the payload.
5. The browser removes its local copy only after it reads `succeeded` for the same `client_action_id`.

The processing RPC should initially support only `complete_delivery` and `complete_job`. The other seven names in today's client switch do not become approved offline operations merely because a mapping exists.

### Expected Stage 2 files/systems

- one new additive migration under `supabase/migrations/`;
- generated Supabase types and schema registry refresh;
- `src/lib/offlineSync.ts` and its tests;
- a small admin review surface or an extension of `OfflineWorkPanel`;
- reference documentation for the new table/RPCs.

Applying this migration is a live change and requires the normal migration proof gate and approval policy.

## Verification plan

### Unit and component proof

- Version-1 IndexedDB records upgrade without loss.
- Three failures remain stored as `needs_review`.
- Records older than seven days remain stored.
- A conflict remains visible across repeated sync calls and page reloads.
- Backoff prevents a reconnect retry storm.
- Concurrent banner/effect calls execute only one sync.
- Unknown operations are quarantined, not executed or deleted.
- Null RPC data remains a failure.
- A successful core RPC plus failed signature upload retries only the signature.
- The banner/panel render each state and expose no raw payload.

### Browser proof

Using a disposable approved fixture:

1. Complete one in-progress delivery offline, reload the installed app, and verify the action remains.
2. Reconnect and force three RPC failures; verify it remains visible and no rapid loop occurs.
3. Create a real server-side edit conflict; verify the offline payload remains in `needs_review`.
4. Complete and reconnect successfully; verify exactly one inventory decrement, one delivery status transition, correct remainder/invoice state, and signature/follow-up status.
5. Repeat for `complete_job`; verify exactly one application record and one inventory deduction.
6. Close the app between core success and follow-up processing; reopen and verify checkpointed continuation without repeating the core RPC.

Stage 2 additionally proves receipt RLS by role, cross-user denial, duplicate `client_action_id` handling, lost-response recovery, concurrent processing, and a migration rollback rehearsal in a disposable database.

### Full repository gate

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:agent-workflows
npm run check:docs
```

The targeted offline tests could not be run while writing this design because this isolated worktree has no installed dependencies. Its lockfile exactly matches `C:\CRX_Manager`, but Node module resolution still requires a local install or a clean test worktree before implementation begins.

## Residual risks that remain even after both stages

- A phone destroyed, factory-reset, signed out with browser storage cleared, or out of storage before its first reconnect can still lose purely local work.
- Browser storage is not a legal-grade backup. The server receipt begins only after a network path exists.
- Offline reads are separate from offline write durability; a user can only complete work whose required details were already loaded.
- Email, notification, photo, and signature replay each need explicit duplicate protection; they must not be assumed safe because the inventory RPC is idempotent.

## Approval-sized next step

Approve **Stage 1 only** first. It is the smallest change that stops silent deletion and makes unresolved work visible. After its browser proof is green, review and approve the separate Stage 2 migration design.
