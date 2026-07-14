# Offline Work Stage 1B — Permanent Receipt Design

**Status:** IMPLEMENTED ON FEATURE BRANCH — migration is queued and has not been applied live
**Date:** 2026-07-13
**Risk:** HIGH — the supported actions change inventory, delivery/order/invoice state, jobs, and application records

## Plain-English goal

When a field user's phone reconnects, Supabase should first create a permanent receipt for the saved action. The phone may remove its local copy only after it reads a matching receipt that says the business action succeeded.

This closes the dangerous uncertainty window:

1. the server completes a delivery or job;
2. the response is lost before the phone hears it;
3. the phone cannot tell whether it is safe to retry or delete the local action.

Stage 1A keeps that uncertain action in the browser. Stage 1B gives the office and the returning device a server record that can answer what happened.

## Recommendation

Build only **Stage 1B-1: receipt and status recovery** first. Do not combine it with signatures/photos, email replay, manual abandonment, a large office dashboard, or a general-purpose offline-sync framework.

Stage 1B-1 supports exactly two operations:

- `complete_delivery`
- `complete_job`

Everything else stays unsupported until it receives its own threat model, authorization checks, failure rules, and real-path proof.

## Current CRX evidence

### Browser behavior already shipped in Stage 1A

- IndexedDB retains unresolved actions and no longer automatically deletes old or repeatedly failed work.
- Only the authenticated owner may replay an action on a shared device.
- Retries are delayed and capped; permanent/conflict cases move to `needs_attention`.
- The local copy is currently removed after the canonical RPC returns successfully.
- Single-flight protection is tab-local, not cross-tab.

### Server behavior that Stage 1B must respect

- Both canonical completion RPCs lock their target business row with `FOR UPDATE`.
- Both bind `p_performed_by` to `auth.uid()` and perform operation-specific authorization.
- Both accept `p_idempotency_key`.
- The current `idempotency_keys` record expires after 24 hours and therefore is not a permanent receipt.
- `idempotency_keys.idempotency_key` is globally unique even though lookups are operation-scoped. Reusing one key across different operations is a caller bug and can fail loudly.
- The current delivery and job functions have different payloads, authorization paths, lifecycle rules, and result shapes. A generic dynamic function dispatcher would be unsafe.

The implementation pass must refresh these facts from the live catalog before drafting SQL. Migration files describe intended history; the live database is the final source for current function bodies, grants, constraints, and overloads.

That refresh must use `pg_get_functiondef()` and current ACL/catalog queries for the exact `complete_delivery` and `complete_job` overloads. `complete_delivery` has been re-emitted many times, so selecting a body by migration filename is not an acceptable implementation baseline. The pass must also record whether each live function saves idempotency through the hardened helper or an inline insert; the receipt must not assume those two paths have identical cross-operation collision behavior.

## Pattern research

The useful lesson from mature local-first projects is a protocol rule, not a recommendation to install a large dependency:

- [WatermelonDB's sync contract](https://watermelondb.dev/docs/Sync/Frontend) says a push must resolve only after the backend confirms it received the change, and must reject on backend failure. Its [implementation notes](https://watermelondb.dev/docs/Implementation/SyncImpl) keep local changes unsynced until that confirmation and design retries to converge after an interruption.
- [Workbox's queue implementation](https://github.com/GoogleChrome/workbox/blob/v7/packages/workbox-background-sync/src/Queue.ts) stores requests in IndexedDB and retries them, but it also has time-based retention and is a transport queue rather than an office-visible business ledger. It is not enough by itself for inventory recovery.
- [PowerSync's JavaScript SDK](https://github.com/powersync-ja/powersync-js) and upload model demonstrate a full local-first stack with a durable upload queue. That is valuable reference material, but adopting a second database/sync engine would be disproportionate for two CRX commands.
- [RxDB](https://github.com/pubkey/rxdb) provides replication, conflicts, attachments, and schema migration. Its breadth likewise exceeds this slice and would introduce a second persistence architecture beside CRX's existing IndexedDB queue.

Decision: borrow the confirmed-acknowledgement, stable client ID, checkpoint, and retry principles. Do not add PowerSync, RxDB, WatermelonDB, or Workbox in Stage 1B-1.

## Required protocol

```text
Browser IndexedDB
  |
  | 1. stage exact action under stable clientActionId
  v
Supabase receipt: received
  |
  | 2. process the staged receipt
  v
Canonical complete_delivery / complete_job
  + receipt status = succeeded
  (one PostgreSQL transaction)
  |
  | 3. browser reads exact succeeded receipt
  v
Remove browser copy
```

If the stage response is lost, the browser retries staging the same ID or reads its status. If processing never reaches the database, the receipt remains `received`. If processing returns a deterministic business/security error, the receipt becomes `needs_review`. If processing commits but its HTTP response is lost, the `succeeded` receipt remains available.

## Stable action identity

Every newly queued Stage 1B action requires these immutable fields:

| Field | Rule |
|---|---|
| `clientActionId` | UUID generated once in the browser and persisted before any replay |
| `schemaVersion` | Integer identifying the local action contract |
| `ownerUserId` | Required, not optional, for newly created records |
| `operation` | Typed allowlist: only the two approved operations |
| `entityId` | Delivery ID or job ID |
| `params` | Operation-specific typed payload, with no client-controlled actor |
| `idempotencyKey` | Unique per action; never shared across operations |
| `createdAt` | Original device queue time; informational, never trusted for authorization |

The server must compare the actor, operation, entity, idempotency key, schema version, and canonical JSONB payload when the same `clientActionId` is staged again. Payload comparison uses PostgreSQL's native `jsonb = jsonb` deep equality, which ignores object-key order; do not compare `jsonb::text`, client serialization bytes, or a client-supplied hash. An exact match returns the existing receipt. Any mismatch fails with `OFFLINE_ACTION_ID_REUSE`; it must not overwrite the first action.

## Proposed database contract

### Table: `offline_action_receipts`

The eventual additive migration should create a narrowly scoped table similar to:

| Column | Purpose |
|---|---|
| `client_action_id uuid primary key` | Permanent device-generated support/recovery ID |
| `actor_id uuid not null` | `auth.uid()` captured by the server |
| `operation text not null` | Check-constrained to the two approved operations |
| `entity_id uuid not null` | Delivery or job target |
| `schema_version integer not null` | Payload contract version |
| `request_payload jsonb not null` | Minimal allowlisted canonical RPC arguments |
| `idempotency_key text not null unique` | Original canonical-operation key |
| `status text not null` | `received`, `succeeded`, or `needs_review` |
| `result jsonb` | Asserted canonical RPC result after success |
| `failure_code text` | Stable machine-readable failure code |
| `failure_summary text` | Sanitized support-facing explanation; no raw SQL or payload dump |
| `attempt_count integer not null default 0` | Server processing attempts |
| `received_at timestamptz not null default now()` | First server receipt time |
| `last_attempt_at timestamptz` | Most recent processing attempt |
| `succeeded_at timestamptz` | Durable success time |
| `needs_review_at timestamptz` | Durable manual-review time |
| `updated_at timestamptz not null default now()` | Status update time |

Required constraints:

- operation/status checks;
- `attempt_count` bounded from 0 through a deliberately chosen server maximum (initial proposal: 50);
- success requires `result` and `succeeded_at`;
- review requires `failure_code` and `needs_review_at`;
- no success and failure timestamps on the same row;
- one globally unique idempotency key per action.

Add an `(actor_id, status)` index for the actor's status polling and a status/partial index appropriate for the future office `needs_review` queue. Use the repo's existing `update_updated_at()` trigger so every status transition advances `updated_at` without relying on every code path to remember it.

Do not store browser diagnostics, raw stack traces, signatures/photos, or arbitrary UI state in `request_payload`. The first implementation must explicitly construct the JSONB shape for each operation and reject extra keys. It must also enforce resource limits before storing or processing: a total canonical payload ceiling (initial proposal: 64 KiB via `pg_column_size`), fixed nesting implied by the operation schema, maximum string lengths, and maximum item/map/field arrays (initial proposal: 500, verified against current CRX business limits before SQL is finalized).

### RLS and grants

- Enable Row Level Security in the same migration.
- Authenticated, active actors may select their own receipts.
- Active `admin` and `sales_rep` users may select receipts for office review.
- Clients receive no direct `INSERT`, `UPDATE`, or `DELETE` privilege.
- No client role may change `actor_id`, payload, status, result, or failure fields.
- Revoke function execution from `PUBLIC` and `anon`; grant only to `authenticated` and deliberately to `service_role` if required.
- Every SECURITY DEFINER function uses `SET search_path = public, pg_temp`.

The table is append-oriented. There is no delete/abandon API in Stage 1B-1. Unresolved rows are never automatically deleted. A later approved retention policy may redact succeeded payloads while retaining the permanent identity, operation, entity, actor, status, and result proof.

## Proposed RPC contract

Exact signatures remain draft until the implementation pass verifies current database types and generated client conventions.

### `stage_offline_action(...)`

Responsibilities:

1. require an authenticated, active user;
2. accept only the two approved operations and supported schema version;
3. derive `actor_id` from `auth.uid()`—do not accept a trusted actor from JSON;
4. validate UUIDs, required fields, types, ranges, lengths, and extra keys before insert;
5. construct the stored payload server-side from allowlisted arguments;
6. insert the receipt as `received` with an atomic conflict pattern—`INSERT ... ON CONFLICT DO NOTHING`, followed by a read and exact immutable-field comparison; never use a check-then-insert sequence;
7. fail closed on any identity/payload mismatch for a reused client ID;
8. perform the same target/assignment authorization needed to stage that operation without weakening the canonical RPC's authorization.

### `process_offline_action(p_client_action_id uuid)`

Responsibilities:

1. require `auth.uid()` and lock the receipt `FOR UPDATE`;
2. require the current `auth.uid()` to equal the stored `actor_id`; Stage 1B-1 does not let an office user impersonate or process another actor's receipt;
3. return immediately for an existing `succeeded` receipt;
4. reject processing an existing `needs_review` receipt in Stage 1B-1;
5. explicitly branch on the allowlisted operation—no dynamic SQL/function names;
6. after proving `auth.uid() = actor_id`, pass that same current `auth.uid()` as `p_performed_by` and call the canonical RPC with the receipt's idempotency key—never substitute a stored actor under a different current session;
7. call `complete_delivery` using its current eight-argument signature, including the saved completion timestamp when present;
8. call `complete_job` using its current typed applied-information payload;
9. validate the canonical return shape before recording success;
10. update the receipt to `succeeded` in the same database transaction as the canonical business changes.

The canonical call should run inside a PL/pgSQL exception sub-block. A known deterministic failure rolls back the business sub-transaction, then records a sanitized `needs_review` result. A connection loss, database termination, serialization abort, or other whole-transaction failure must leave the prior `received` receipt intact so the client can safely retry.

Stage 1B-1 processes a durable `received` receipt once per committed deterministic outcome: success becomes `succeeded`, a caught business/security failure becomes `needs_review`, and a whole-transaction failure rolls the counter/status change back. The processor rejects `needs_review` and `succeeded`, so the high attempt ceiling is defense in depth. Any later office retry RPC must define a lower operational cap and its own audited authorization instead of simply reopening this processor.

### `get_offline_action_status(p_client_action_id uuid)`

Prefer a narrow typed RPC result over exposing the raw table payload to the phone. It should return only the ID, operation, entity, status, timestamps, safe failure code/summary, and asserted result permitted to that actor. It must never return another user's receipt or raw request JSON.

## Browser state changes

For new actions after the Stage 1B release:

1. save `clientActionId`, required owner, schema version, typed operation, entity, payload, and unique idempotency key in one IndexedDB transaction;
2. on reconnect, stage the action;
3. process only after staging is confirmed or the exact existing receipt is read;
4. after a lost/unknown response, query the receipt before another process call;
5. remove the local record only when `status = succeeded` and the returned action ID, actor, operation, and entity all match;
6. keep `received` locally with retry backoff;
7. keep `needs_review` locally and show the safe failure summary;
8. never infer success from HTTP 2xx, an empty response, the target's `updated_at`, or the target already being completed.

The server row lock makes repeated process calls safe at the receipt level. A separate cross-tab browser lease can reduce noise, but it is not a substitute for the server lock and is not required in this slice.

The browser integration keeps CRX's deliberately slow Stage 1A retry curve—30 seconds, 2 minutes, then 10 minutes—with bounded jitter so many returning devices do not retry at the same instant. `navigator.onLine === false` pauses scheduled stage/process/status attempts without consuming a business retry; `true` is only a hint and never proof that Supabase is reachable. Hidden/background tabs may defer status polling, but must not cancel an in-flight transaction or change a receipt's state; retry/status work resumes immediately on `online` and `visibilitychange` back to visible. A faster generic library backoff is not adopted for inventory-changing commands.

## Legacy Stage 1A records

Stage 1B cannot retroactively prove whether an action completed before a permanent receipt existed.

- Upgrade old records without deleting or silently reassigning them.
- Generate and persist a new stable `clientActionId` only once for a legacy record whose owner can be safely inferred.
- Label it as a legacy recovery action in local metadata.
- Do not claim that the new receipt proves any pre-upgrade attempt.
- If the target is already completed and no matching permanent receipt exists, move the action to office review. Do not automatically mark it successful and do not rerun inventory work.
- Owner-unknown or unsupported legacy records remain local `needs_attention` and are never uploaded automatically.

This means Stage 1B guarantees recovery for actions created under the new contract. It improves handling of old retained work but cannot manufacture missing historical proof.

The existing 24-hour idempotency expiry does **not** create a new uncertainty window for a correctly staged Stage 1B action: canonical success and receipt `succeeded` commit in the same transaction. It does matter for a legacy Stage 1A action whose old direct RPC may have succeeded before the permanent receipt existed. If such an action is now staged after its old idempotency row expired and the target is already complete, use `LEGACY_OUTCOME_UNKNOWN`; do not claim success or label a new receipt as proof of the historical attempt.

## Structured failure rules

The browser should stop classifying permanent errors by searching English message text. The receipt/status RPC should return stable codes such as:

| Code | Meaning | Browser action |
|---|---|---|
| `AUTH_REQUIRED` | No valid session | Pause; do not consume a business retry |
| `ACTOR_MISMATCH` | Session does not own the action | Keep local; needs attention |
| `UNSUPPORTED_OPERATION` | Not one of the two allowed commands | Keep local; needs attention |
| `UNSUPPORTED_SCHEMA_VERSION` | Client payload contract is unknown | Keep local; prompt update/support |
| `OFFLINE_ACTION_ID_REUSE` | Same UUID presented with different immutable content | Security review; never overwrite |
| `TARGET_NOT_FOUND` | Delivery/job is missing | Needs review |
| `TARGET_STATE_CONFLICT` | Lifecycle no longer permits the action | Needs review |
| `NOT_AUTHORIZED` | Current actor may not perform it | Needs review |
| `PAYLOAD_INVALID` | Missing/invalid allowlisted field | Needs review |
| `PAYLOAD_TOO_LARGE` | Payload exceeds the operation's byte/item limits | Needs review |
| `LEGACY_OUTCOME_UNKNOWN` | Target is terminal but no permanent receipt proves the retained legacy action | Office comparison; never auto-success |
| `UNEXPECTED_SERVER_ERROR` | Sanitized unclassified server failure | Keep receipt/local copy; office review |

Network and whole-transaction failures do not need a receipt failure code because the durable receipt remains `received` and is safe to retry.

`failure_summary` must come from a fixed template selected by `failure_code`, optionally interpolating safe IDs or bounded business labels. It must never copy `SQLERRM`, PostgreSQL `DETAIL`/`CONTEXT`, stack traces, or raw payload text into a client-visible field.

## Adversarial review — what this design rejects

### Reject: use the existing 24-hour idempotency table as the receipt

It expires and cannot answer a week-old recovery question. It remains duplicate protection for the canonical RPC; the new receipt supplies permanent acknowledgement and office visibility.

### Reject: let the browser write/update receipt rows directly

That would let a compromised client forge actor, payload, success, or failure state. All creation and transitions go through allowlisted, identity-bound RPCs.

### Reject: stage and then delete the local copy

`received` proves only that Supabase has the request, not that inventory/job work succeeded. Local removal requires the exact `succeeded` receipt.

### Reject: call a function name supplied in JSON

Dynamic dispatch turns a recovery endpoint into a privilege-escalation surface. The processor contains two explicit branches and nothing else.

### Reject: mark “already completed” as success without proof

The entity may have been completed by a different online action with different quantities, signature, applied information, actor, or time. Without the matching receipt, this is a conflict requiring review.

### Reject: install a full local-first database now

PowerSync, RxDB, and WatermelonDB solve broader replication problems. CRX has two approved offline commands and an existing queue. Replatforming persistence would enlarge the security, migration, testing, and operational surface without being necessary for this failure window.

### Reject: combine attachments and notifications with the receipt migration

Signatures/photos need blob lifecycle and storage authorization. Email/notifications need their own duplicate-send contracts. Bundling them makes the first migration harder to prove and roll back.

## Approval-sized delivery sequence

### 1B-1A — database receipt foundation

- additive receipt table, constraints, RLS, grants;
- stage/process/status RPCs for `complete_delivery` and `complete_job` only;
- SQL tests for identity, RLS, payload reuse, concurrency, transaction rollback, lost-response recovery, and exact result persistence;
- generated types/schema registry and reference documentation.

This slice requires a separately reviewed migration and the normal live migration approval/proof gate.

### 1B-1B — browser integration

- IndexedDB schema version upgrade and required UUID/owner fields for new actions;
- typed operation payloads;
- stage/process/status flow;
- local deletion only after exact server success;
- structured failure codes;
- focused unit/component tests and real browser proof for both operations.

### Deferred Stage 1B-2 / 1C

- office-wide review panel and audited manual resolution/abandonment;
- signature/photo storage replay;
- idempotent email/notification replay;
- cross-tab Web Locks/BroadcastChannel coordination;
- additional offline operations;
- success-payload retention/redaction automation.

## Required proof before any production migration

### Database proof in a disposable environment

- RLS matrix: own actor, different actor, active admin/sales, anon, inactive user, service role.
- Direct client insert/update/delete denied.
- Re-staging identical UUID/content returns the same receipt.
- Re-staging the UUID with changed operation/entity/payload/key fails closed.
- Two concurrent process calls produce one business result and one success receipt.
- Forced canonical failure rolls back all business mutations and records only a safe review state.
- Forced transaction termination leaves `received`, not false success.
- Simulated lost HTTP response is resolved by status lookup without another inventory deduction.
- Canonical result shapes are asserted for both operations.
- Current function overloads, grants, search paths, constraints, and live schema drift are rechecked.

### Browser proof with approved disposable fixtures

- Queue an offline delivery, close/reopen the app, reconnect, and observe one receipt plus one inventory change.
- Drop the response after server commit; reload and observe local removal only after status recovery.
- Repeat for a job and verify one application record and one inventory deduction.
- Open two tabs and trigger replay concurrently; observe one business result.
- Change server state before reconnect; observe retained local work plus `needs_review`, not deletion.
- Sign in as a different shared-device user; observe no payload leak or replay.
- Upgrade a version-1 legacy record; observe retention and explicit legacy review behavior.

### Repository gate

```bash
npm run typecheck
npm run lint
npm run test
npm run build
npm run test:agent-workflows
npm run check:docs
```

## Go / no-go decision

Proceed to a migration implementation plan only if the independent review agrees that:

1. success acknowledgement is atomic with the canonical business transaction;
2. the client cannot forge receipt content or state;
3. legacy actions are not falsely treated as proven successes;
4. local deletion requires an exact matching permanent success receipt;
5. the first slice remains limited to two operations and excludes manual destructive resolution.

Mason approved the implementation pass on 2026-07-13. The migration and proof chain now exist on the feature branch, but live application remains subject to the migration-review proof gate. Browser integration remains a later slice.
