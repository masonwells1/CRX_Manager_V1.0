# Agent Pair Review — Offline Work Durability

**Date:** 2026-07-13
**Scope:** `docs/roadmap/offline-work-durability-plan-2026-07-13.md` and the current offline queue/replay implementation
**Review order:** Codex adversarial review first, then independent Claude Opus review
**Mode:** inspection only; no product code, migration, live data, commit, push, or deploy

## Pair verdict

**NEEDS-WORK — do not build the current Stage 1 as written.**

Both reviewers recommend a narrower **Stage 1A browser hotfix** before the review panel, signature replay, client follow-up replay, or server-receipt migration.

Pair-review counts:

- 9 substantive agreements;
- 1 corrected mechanism/severity (cross-user replay and the commit/ack gap);
- 1 low-severity design disagreement (how to store a future signature attachment);
- 0 unresolved BLOCKER/HIGH disagreements.

Final severity: **0 BLOCKER · 5 HIGH · 5 MED · 1 LOW**.

## Top verified risk

A queued action can be destroyed through four back-to-back sync passes, potentially within seconds of reconnect:

1. `OfflineBanner` runs sync whenever `pendingCount > 0 && !syncing` (`src/components/ui/OfflineBanner.tsx:57-61`).
2. `handleSync()` sets `syncing` false when it finishes (`OfflineBanner.tsx:53`), which re-triggers that effect immediately while the count remains nonzero.
3. Three failures raise `retryCount` to 3; the next pass runs `clearFailedActions(MAX_RETRIES)` before replay (`src/lib/offlineSync.ts:34-40`).
4. `clearFailedActions()` permanently deletes the action (`src/lib/offlineQueue.ts:121-128`).

The cross-user path makes this worse. Offline actions carry the original `p_performed_by`, but the queue has no owner field and sign-out does not clear or partition it (`src/contexts/AuthContext.tsx:112-124`). When another user signs in on the same device, the current live `complete_delivery` and `complete_job` functions correctly reject the actor mismatch. The client treats that expected rejection as a retryable failure, burns through the loop, and deletes the original user's work.

Live read-only verification on 2026-07-13 confirmed that both current functions have:

- an authenticated-actor mismatch guard;
- an `in_progress` lifecycle guard;
- row locking;
- an idempotency guard.

The live `idempotency_keys.expires_at` default remains 24 hours.

## Reconciliation

| Finding | Claude | Codex | Status | Evidence |
|---|---|---|---|---|
| Rapid retry/delete loop | HIGH | agree | open; Stage 1A | `OfflineBanner.tsx:53,57-61`; `offlineSync.ts:34-40`; `offlineQueue.ts:121-128` |
| Current Stage 1 bundles multiple approval-sized changes | HIGH | agree | revise plan | plan lines 44-121 |
| Queue lacks user/session ownership | HIGH | agree; Claude corrected the mechanism | open; Stage 1A | `offlineQueue.ts:11-22`; `AuthContext.tsx:112-124`; live function definitions |
| IndexedDB writes resolve before transaction commit | HIGH | agree | open; Stage 1A | `offlineQueue.ts:56,84,98` |
| Requiring every `snapshotAt` would regress the deliberate U12 fallback | HIGH | agree | remove requirement; defer conflict redesign | plan line 64; `FieldView.tsx:469-486` |
| RPC commit can precede local `core_succeeded` checkpoint | MED | agree with Claude's downgrade | document ambiguity; Stage 2 closes it | lifecycle locks/guards in current SQL; 24-hour idempotency default |
| App-wide single-flight is underspecified across tabs | MED | agree | defer cross-tab lease; retain work first | one banner/timer per `AppLayout`; no shared lock in queue/sync |
| Duplicate action/dependency policy missing | MED | agree | defer with explicit follow-up | `DeliveryDetail.tsx:805`; `FieldStop.tsx:319` reset keys after queueing |
| Version-1 action migration is underspecified | MED | agree | Stage 1A must quarantine safely | `DeliveryDetail.tsx:799-804` lacks entity/snapshot metadata |
| Local conflict abandonment has no office audit trail | MED | agree | no abandon action in Stage 1A | plan line 93 |
| Separate signature Blob store is unnecessary | LOW | disagree; deferred | Stage 1B design choice | upload is idempotent at `DeliveryDetail.tsx:833-836`, but local persistence format remains undecided |

## Important corrections to the original design

### 1. Do not require `snapshotAt` for every action

`FieldView` deliberately allows a missing snapshot when connectivity drops during the post-start refresh. The code documents that a blind replay was chosen over a guaranteed self-conflict (`src/pages/FieldView.tsx:469-486`). A future conflict redesign needs operation-specific preconditions; a generic `updated_at` requirement is not safe.

### 2. Stage 1A must define legacy-owner handling

New actions should carry `ownerUserId`. Existing actions should:

- infer the owner only from a valid string `params.p_performed_by` for the two active operations;
- otherwise become `owner_unknown` / needs-attention;
- never be assigned automatically to whoever is currently logged in;
- never consume retries while a different user is signed in.

Owner binding is a loss-prevention and privacy control, not a replacement for the RPC's server-side authorization.

### 3. The commit/ack gap is not a duplicate-inventory path

The current business functions lock the target and reject a second completion after the status leaves `in_progress`. If the first RPC commits but its response is lost, a later replay becomes an ambiguous needs-review item; it does not deduct inventory again. A permanent server receipt is still valuable because it resolves that ambiguity after the 24-hour idempotency window.

### 4. Keep client follow-ups out of Stage 1A

The canonical RPCs own the mandatory inventory, invoice/application-record, lifecycle, and key audit effects. Client notification/activity helpers are not uniformly idempotent and may duplicate if replayed. Signature persistence is important evidence work, but it is separable from the emergency retention fix.

Claude recommends storing a future signature data URL in the action because the upload path is delivery-keyed with `upsert: true`. Codex does not adopt that storage choice yet: upload idempotency does not decide whether base64 JSON or a structured-clone Blob is the safer local format. Resolve that in Stage 1B with quota/PII tests.

## Revised Stage 1A — approval-sized first build

**No migration, no new page/panel, no signature/photo queue, and no notification/email replay.**

1. Remove automatic failed/stale deletion from `syncPendingActions()`; unresolved actions remain indefinitely.
2. Stop immediate retry chaining. Persist `nextAttemptAt` and use bounded retry delays (for example 30 seconds, 2 minutes, 10 minutes), resumed on reconnect/foreground/manual retry.
3. Add `ownerUserId` to new actions. Skip different-owner actions without executing them or incrementing their attempts. Quarantine ownerless legacy actions as described above.
4. Resolve IndexedDB writes/removes/updates only on `transaction.oncomplete`; reject on transaction abort/error.
5. Keep conflicts and max-attempt failures as needs-attention records rather than deleting them.
6. Make the banner truthful: show unresolved/needs-attention counts and never display a green zero-action success while retained work exists.
7. Replace tests that assert failed/stale deletion with retention, backoff, transaction, legacy-owner, cross-user, and truthful-banner tests.

Expected production files:

- `src/lib/offlineQueue.ts`
- `src/lib/offlineSync.ts`
- `src/components/ui/OfflineBanner.tsx`
- `src/pages/DeliveryDetail.tsx`
- `src/pages/FieldStop.tsx`
- `src/pages/FieldView.tsx`

Expected focused test files:

- `src/lib/offlineQueue.test.ts`
- `src/lib/offlineSync.test.ts`
- `src/components/ui/OfflineBanner.test.tsx`

## Deferred by design

- review panel and audited conflict resolution;
- signature/photo persistence and replay;
- idempotent customer email/notification follow-ups;
- operation-specific conflict preconditions;
- duplicate-action policy;
- cross-tab/browser-context lease;
- Supabase `offline_action_receipts` migration and office recovery UI.

These are not rejected. They are separated so the silent-loss fix can be proven and shipped without authorizing a larger workflow redesign.

## Proof required before merge

1. Unit/component tests prove no age/attempt cleanup, persisted backoff, transaction-completion semantics, legacy quarantine, different-user skip with unchanged attempt count, and truthful banner state.
2. In an installed PWA: queue offline, reload, and inspect that the record survived.
3. Force three failures and confirm the record remains while requests follow the delay schedule.
4. Queue as user A, sign out, sign in as user B, wait through the retry window, and confirm A's record is unchanged and undisclosed.
5. With a separately approved disposable fixture, reconnect successfully and verify via read-only queries exactly one status transition and inventory/application-record effect.
6. Run `npm run typecheck`, `npm run lint`, `npm run test`, `npm run build`, `npm run test:agent-workflows`, and `npm run check:docs`.

## Next step for Mason

Approve **revising the design to this Stage 1A scope** before implementation. The original Stage 1 should not be used as the build authorization.

Claude's full independent report is stored at:

`C:\Users\mason\.claude\plans\you-are-running-an-glistening-octopus.md`

## Implementation review and proof

**Implementation date:** 2026-07-13
**Branch:** `codex/offline-stage1a-durability`
**Scope:** revised Stage 1A only; no migration, live-data write, signature/photo replay, or notification/email replay

Codex's implementation review initially found and fixed the duplicate My Route status path. The independent compliance/workflow fan-out then found one HIGH and four MEDIUM gaps. Before the Claude implementation review, all blocker/high items and the proof gaps were resolved:

- legacy owner inference is restricted to `complete_delivery` and `complete_job`;
- other legacy operations are quarantined without an RPC;
- the My Route offline-work badge uses the same owner-aware status model and refreshes after background sync (the stop list's pre-existing manual refresh behavior is unchanged);
- transaction-success/abort behavior, conflict retention, same-tab single-flight, and account-switch behavior have direct regressions;
- ordinary automatic work observes persisted backoff while user-initiated retry is explicit.

Claude Opus independently reviewed the completed diff and returned **SHIP-WITH-FOLLOWUPS — 0 BLOCKER, 0 HIGH, 4 MEDIUM, 3 LOW**. Full report:

`C:\Users\mason\.claude\plans\you-are-running-an-sleepy-tulip.md`

The four medium findings were addressed before merge:

| Claude finding | Disposition |
|---|---|
| Manual `Sync Now` did not bypass a scheduled wait | fixed — user-initiated sync passes `force: true`; automatic sync still observes backoff |
| Needs-attention work did not match the unconditional reconnect promise | fixed — queue/save messages now say it retries when connected and remains saved if it needs attention; permanent/conflict work still requires deliberate review |
| 10-minute delay was unreachable with a three-attempt limit | fixed — the shared limit is four attempts, producing 30 seconds, 2 minutes, 10 minutes, then needs-attention |
| Auth-session mismatch could defer forever | fixed — session mismatches have their own three-deferral cap without consuming the business retry counter |

Claude LOW-1 was also fixed by scoping the in-flight promise to its user and queuing a different user's replay behind it. The pre-existing blind DeliveryDetail conflict fallback remains explicitly deferred. Producer owner binding is present at all three current call sites; making that optional legacy field compile-time mandatory is a future hardening item.

### Real Chromium proof (production network intercepted)

Playwright CLI drove Chromium against the Vite app using the real `offlineQueue.ts` and `offlineSync.ts` modules. Supabase RPC traffic was intercepted locally; no production request or live-data mutation occurred.

- Queued `complete_delivery` record: stored with owner/status, then survived a full page reload with the same IndexedDB ID and `retryCount = 0`.
- Four forced 503 responses: retained after every attempt with exact persisted delay ladder `30`, `120`, and `600` seconds, then `needs_attention` at retry count 4; never deleted.
- Different-user replay: `skippedOtherUser = 1`, zero RPC requests, owner/retry/status/error unchanged.
- Mock successful RPC: exactly one request, `synced = 1`, and queue count became zero.

This proves browser persistence, bounded failure behavior, cross-user isolation, and success removal without authorizing a live inventory mutation. A real production delivery/job completion was intentionally not used as test data.

### Final Claude re-review and follow-up round

Claude Opus re-reviewed the remediated implementation and confirmed all five prior findings fixed. Verdict remained **SHIP-WITH-FOLLOWUPS — 0 BLOCKER, 0 HIGH, 2 MEDIUM, 3 LOW**. Full report:

`C:\Users\mason\.claude\plans\you-are-running-an-modular-crane.md`

Both new medium findings were then fixed:

- A wholesale sync rejection now creates a 30-second scheduler cooldown, refreshes the queue in `finally`, and automatically re-arms. A fake-timer component regression proves no retry before 30 seconds and a second automatic attempt at 30 seconds.
- Every terminal needs-attention transition now emits a Sentry error with a reason tag (`owner_unknown`, `actor_owner_mismatch`, `conflict`, or `session_mismatch_limit`) so retained work is visible to oncall while the office review panel remains deferred.

The related low/nit hardening was also applied: `Not authenticated` uses the session-mismatch budget instead of the business retry budget; a forced same-user call queues behind an active non-forced pass instead of losing `force`; `.playwright-cli/` is ignored; the empty yellow-banner edge case is suppressed; and the audit now distinguishes the My Route queue badge refresh from its pre-existing manual stop-list refresh.

### Third and final Claude verdict

The third permitted Opus review round verified every requested follow-up in code and tests, ran the full release gate, and returned **SHIP-WITH-FOLLOWUPS — 0 BLOCKER, 0 HIGH, 3 MEDIUM, 3 LOW** with the explicit recommendation **Ship it**. Full report:

`C:\Users\mason\.claude\plans\you-are-running-an-spicy-biscuit.md`

The remaining follow-ups are recorded rather than expanding Stage 1A again:

- A `complete_job` whose server commit succeeds but whose response is lost can later be retained as a false conflict because `jobs.updated_at` advances before the replay's pre-check. It is not a duplicate-inventory path and does not lose work, but Stage 1B needs a receipt/idempotency-aware resolution path that can clear the local record safely.
- `ownerUserId` remains optional on the stored legacy record type. All current producers set it, but a future hard guard should make it mandatory on the `queueAction()` input while preserving optionality for old IndexedDB records.
- Repeated network-class failures eventually become needs-attention and require a human retry. Work remains saved and visible; a later failure-kind redesign should distinguish network recovery from permanent business errors.
- Lower-severity cleanup: correct the stale-write comment for deliveries, reset the session-mismatch counter after a non-mismatch attempt, show waiting plus needs-attention counts together in My Route, and retire unused queue count helpers if they remain unreferenced.

Per the pair-review workflow, review stopped after three rounds with no blocker/high disagreement. These items are follow-ups, not merge blockers.
