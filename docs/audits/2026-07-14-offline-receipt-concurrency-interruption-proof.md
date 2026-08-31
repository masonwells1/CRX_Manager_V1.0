# Offline Receipt Concurrency and Interrupted-Connection Proof

**Date:** 2026-07-14  
**Branch:** `codex/offline-receipt-failure-proof`  
**Scope:** `complete_delivery` and `complete_job` permanent offline receipts  
**Environment:** disposable local PostgreSQL only; no live Supabase reads or writes  
**Verdict:** Transaction proof PASS; Claude Opus 4.8 `SHIP-WITH-FOLLOWUPS`

## What was tested

The proof runner creates a fresh database whose name is hard-limited to the
`crx_offline_receipts_` disposable prefix, applies the current queued migration,
creates isolated proof fixtures, and drives genuinely separate PostgreSQL
sessions through Docker.

Command:

```powershell
node scripts/smoke/prove-offline-action-receipt-failures.mjs
```

Latest evidence database:

```text
crx_offline_receipts_failure_proof_mrklc9bf
```

The database was intentionally retained for inspection. The runner never
connects to linked or production Supabase.

### Recreating the local template

The runner expects Mason's existing throwaway Supabase stack documented in the
field-app parity ledger: project directory
`C:\Users\mason\fieldapp-local-db`, container
`supabase_db_fieldapp-local-db`, and local database `postgres`. If the immutable
proof template is absent, recreate it only from that local throwaway database:

```powershell
Set-Location C:\Users\mason\fieldapp-local-db
supabase start
docker exec supabase_db_fieldapp-local-db pg_dump -U postgres -d postgres --format=custom --file=/tmp/crx_offline_receipts_20260714.dump
docker exec supabase_db_fieldapp-local-db createdb -U postgres crx_offline_receipts_20260714
docker exec supabase_db_fieldapp-local-db pg_restore -U postgres -d crx_offline_receipts_20260714 --no-owner /tmp/crx_offline_receipts_20260714.dump
```

Then run the proof command from the CRX repo. The runner refuses to continue
unless the template's canonical `complete_delivery` and `complete_job` bodies
match the live-verified MD5 fingerprints declared by the receipt migration. If
the template name already exists, reuse it; replacing/deleting a database is
not part of this proof runner.

## Results

### Permanent-write abuse guard

- A security review found that an authenticated account could otherwise stage
  unlimited permanent rows by repeatedly naming missing targets.
- Follow-up migration `20260714171800_offline_action_receipt_stage_limits.sql`
  serializes new staging per actor, allows existing action-ID replays, limits
  new receipts to 250 per rolling 24 hours, and refuses every new receipt once
  an actor already has 500 unresolved review rows.
- A disposable 500-row old backlog proved that even a newly valid `received`
  action is rejected; those synthetic rows were then removed.
- With the actor at 249 recent receipts, two authenticated sessions raced for
  the final slot. The first deliberately paused after acquiring the real actor
  advisory lock; `pg_stat_activity` showed the second waiting on that lock.
- Exactly one session stored the 250th receipt. The other received
  `OFFLINE_STAGE_RATE_LIMIT`, the recent count remained exactly 250, and an
  exact replay of the winner remained available at the cap.

### Concurrent delivery completion

- Session A locked the receipt, performed the canonical delivery work, and was
  deliberately paused before the success receipt update and commit.
- Session B called the same processor while A was paused.
- `pg_stat_activity` showed B waiting on a PostgreSQL lock.
- Both callers ultimately returned the same permanent success receipt.
- Stored `attempt_count` was `1`.
- Delivery status was `completed` and exactly one `delivered` inventory ledger
  row existed.

### Concurrent job completion

- The same two-session overlap and lock observation was repeated for a job.
- Both callers returned the same permanent success receipt.
- Stored `attempt_count` was `1`.
- Job status was `completed` and exactly one application record existed.

### Connection terminated before commit

- The delivery processor was paused after the canonical business mutation but
  before the receipt was marked succeeded or the transaction committed.
- A separate session terminated that exact PostgreSQL backend with
  `pg_terminate_backend`.
- The client command failed, as expected.
- The receipt remained `received`, `attempt_count` returned to `0`, the
  delivery remained `in_progress`, and no delivered ledger row leaked.
- A normal retry then succeeded with `attempt_count = 1`, completed the
  delivery, and wrote exactly one ledger row.

### Connection lost after commit / unknown client outcome

- A separate delivery was processed and committed without returning the
  processor result to the proof client.
- The same database session then paused and was terminated, modeling a client
  that cannot trust whether its request completed.
- Read-only inspection proved the success receipt and exactly one business
  mutation were already durable before termination.
- Replaying the same action/key recovered the identical permanent result,
  retained `attempt_count = 1`, and did not create another ledger row.

## Safety and limitations

- Test-only delay triggers and fixtures exist only inside each new disposable
  database. They are not part of the production migration.
- The proof exercises PostgreSQL connection loss, not a specific mobile radio,
  browser, reverse proxy, or Supabase HTTP transport. It covers the two database
  outcomes those transports can expose: rollback before commit and an unknown
  client outcome after commit.
- This proof does not authorize applying the queued migration live. The normal
  live-migration approval and proof gates still apply.

## Activation follow-ups from Claude review

Claude Opus independently returned `SHIP-WITH-FOLLOWUPS` and agreed that the
transaction, concurrency, pre-commit termination, and post-commit unknown-outcome
claims are proven. It found no CRX red-line violation.

The direct review ran with `claude-opus-4-8` in read-only plan mode (session
`1b27ca0c-caeb-4938-ad1d-daf2dcb801cc`). The wrapper's final text capture was
empty because the read-only stop hook repeatedly requested a write-only
acknowledgement; the attributable review and terminal verdict were recovered
from that exact Claude session log. Claude initially reported 1 HIGH, 3 MEDIUM,
3 LOW, and 1 NIT. This branch then closed the type-object, authenticated-role,
specific-error, advisory-lock-observation, and template-recreation findings and
re-ran the disposable proof and focused gates successfully.

The queued server contract must not be wired to driver phones until both of
these later workflow requirements exist:

1. an audited office resolution path can clear a driver's `needs_review`
   backlog; otherwise reaching 500 would block every new stage indefinitely;
2. the browser treats `OFFLINE_STAGE_RATE_LIMIT` as "keep this local action and
   try later / escalate," never as permission to delete the local copy.

The 250-per-day guard bounds acute abuse but does not replace long-term storage
monitoring or a deliberate archival/retention design for permanent successful
receipts. Those are activation requirements, not claims made by this DB-only
proof. There are currently zero frontend callers of the three receipt RPCs.
