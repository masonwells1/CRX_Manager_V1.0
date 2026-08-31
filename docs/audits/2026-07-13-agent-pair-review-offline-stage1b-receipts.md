# Agent Pair Review — Offline Stage 1B Permanent Receipts

**Date:** 2026-07-13
**Scope:** `docs/roadmap/offline-work-stage1b-receipt-design-2026-07-13.md`
**Codex verdict:** SHIP-WITH-FOLLOWUPS for implementation planning; no implementation or live migration approved
**Claude verdict:** SHIP-WITH-FOLLOWUPS; no BLOCKER findings
**Combined verdict:** DESIGN READY after the reconciled clarifications below

## Provenance

- Codex inspected the current Stage 1A browser queue/sync implementation, the current migration history for `complete_delivery`, `complete_job`, and `idempotency_keys`, the project safety rules, and primary-source offline queue/sync projects.
- Claude review ran independently with `claude-opus-4-6` in read-only plan mode. The usable adversarial review came from Claude session `45815ef5-c46a-438c-a084-406fb9258b50`.
- Claude's separate GitHub research ran in session `90e4af03-fdd0-4ae8-97f2-f809ffc5921e`; its memo was recovered by resuming that exact session after the CRX stop hook replaced the first final message with session-hygiene text.
- The first plain-text wrapper capture was empty and is **not** counted as a review. Structured JSON output provided the attributable model, session, and review text used here.
- Neither reviewer edited product code, drafted/applied SQL, changed live data, committed, pushed, merged, or deployed.

## Shared position

Both reviewers agree the first build should be a narrow permanent receipt protocol for only `complete_delivery` and `complete_job`:

1. stage an immutable action under a stable browser-generated UUID;
2. process it through an explicit allowlisted server branch;
3. commit the canonical business action and receipt `succeeded` state in the same PostgreSQL transaction;
4. remove the browser copy only after reading the exact matching success receipt;
5. preserve conflicts and legacy uncertainty for office review instead of inferring success.

Both reject direct client writes to receipt state, dynamic RPC dispatch, full local-first replatforming, automatic “already completed” success, and bundling attachments/email/manual abandonment into the first migration.

## Claude adversarial findings and reconciliation

| Finding | Claude rating | Codex evidence decision | Reconciled action |
|---|---:|---|---|
| Existing 24-hour idempotency expiry can cause false review after prior success | HIGH | **Partly disagree.** For a new staged action, canonical success and receipt success are one transaction, so `received` cannot remain after committed business success. The risk is real only for legacy Stage 1A work whose direct RPC may predate the receipt. | Added `LEGACY_OUTCOME_UNKNOWN`; explicitly states no new 24-hour window under the atomic protocol and never treats terminal state as proof. |
| Concurrent stage calls need an atomic insert pattern | HIGH | **Agree.** Check-then-insert has a time-of-check/time-of-use race. | Requires `INSERT ... ON CONFLICT DO NOTHING`, then read and exact immutable-field comparison. |
| Payload validation needs size/depth/count limits | HIGH | **Agree.** Allowlisted keys alone do not bound resource use. | Added proposed 64 KiB total limit, fixed operation shape, bounded strings, and proposed 500-entry collection limit subject to current business-limit verification. |
| `p_performed_by` sourcing is ambiguous | HIGH | **Agree.** Future office retry must not accidentally impersonate the original actor. | Stage 1B-1 requires current `auth.uid() = actor_id`, then passes that same current identity to the canonical RPC. Office resolution remains a separate later contract. |
| Own-receipt SELECT should require an active profile | MED | **Agree.** Deactivated users should not retain receipt access. | RLS requirement now says authenticated, active actor. |
| Add a server attempt ceiling | MED | **Agree with qualification.** Normal Stage 1B-1 deterministic processing can commit only one terminal attempt; whole-transaction failures roll back the counter. | Added a bounded counter proposal and requires any future office retry RPC to define a stricter audited operational cap. |
| Verify the live delivery/job function definitions | MED | **Agree; already present but strengthened.** Migration history contains many re-emissions. | Explicitly requires `pg_get_functiondef()`, current ACL/overload checks, and live idempotency-save-path verification. |
| Add the standard `updated_at` trigger | MED | **Agree.** The helper exists and is the current project convention. | Requires the existing `update_updated_at()` trigger. |
| Canonical RPCs may not share the same idempotency-save path | MED | **Agree as an implementation check, not a redesign.** Current history shows helper and inline-save patterns differ. | Live verification must record each canonical path; unique per-action keys remain mandatory. |
| Define failure-summary sanitization | LOW | **Agree.** Raw `SQLERRM` can expose internal detail/context. | Requires fixed templates by failure code and forbids raw SQL errors, context, stack traces, and payloads. |
| Add polling/review indexes | LOW | **Agree.** Receipt lookup and office review should not rely on scans. | Requires `(actor_id, status)` plus a suitable status/partial office-review index. |

## Claude's independent GitHub research

Claude inspected pinned primary-source files from four projects:

- [Workbox `Queue.ts`](https://github.com/GoogleChrome/workbox/blob/62b9d8ba8eb3c1a2ab8aac9d84c90cda7865d6a3/packages/workbox-background-sync/src/Queue.ts) and [QueueStore](https://github.com/GoogleChrome/workbox/blob/62b9d8ba8eb3c1a2ab8aac9d84c90cda7865d6a3/packages/workbox-background-sync/src/lib/QueueStore.ts): FIFO IndexedDB request retention and replay, but transport success is the only acknowledgement and old entries expire.
- [TanStack Query mutation cache](https://github.com/TanStack/query/blob/79d2384db5c8776680d5bfbe9b595618c066248b/packages/query-core/src/mutationCache.ts) and [retryer](https://github.com/TanStack/query/blob/79d2384db5c8776680d5bfbe9b595618c066248b/packages/query-core/src/retryer.ts): paused mutations, capped exponential backoff, and online/focus gating.
- [RxDB conflict handler](https://github.com/pubkey/rxdb/blob/dd94f39d80b4ca8f84967e643b600e15dacd027d/src/replication-protocol/default-conflict-handler.ts) and [checkpoint logic](https://github.com/pubkey/rxdb/blob/dd94f39d80b4ca8f84967e643b600e15dacd027d/src/replication-protocol/checkpoint.ts): deep equality, pluggable conflict resolution, and compare-and-swap checkpoint advancement.
- [PouchDB revision winner](https://github.com/apache/pouchdb/blob/70b9de3c2072fa97e4b5b97cb74faa712ac184e0/packages/node_modules/pouchdb-merge/src/winningRev.js): deterministic multi-master revision-tree conflict selection.

### Adopt

- Explicit retry schedule with jitter and negative online gating.
- Pause no-hope attempts while definitely offline; resume promptly on reconnect/visibility.
- PostgreSQL native `jsonb = jsonb` deep equality for restage comparison, not byte/text/hash comparison.

Codex kept CRX's slower existing 30-second, 2-minute, and 10-minute schedule rather than TanStack's generic faster curve because these calls change inventory and business records.

### Reject

- Workbox-style time-based deletion or HTTP success as permanent acknowledgement.
- RxDB pluggable auto-conflict resolution for inventory/money commands.
- RxDB compare-and-swap replication checkpoints; the receipt and business-row locks already serialize this narrow protocol.
- PouchDB revision trees; CRX has one authoritative PostgreSQL server, not multi-master replicas.
- A new persistence abstraction or full sync engine for two commands.

### Defer

- Service-worker Background Sync so replay can start while the tab is closed.
- Cross-tab Web Locks/BroadcastChannel coordination.

Both are reliability/noise improvements after the server receipt is proven; neither replaces the server transaction and row locks.

## Remaining approval gates

This review approves only the **design as ready for implementation planning**. The next pass may draft the Stage 1B-1A migration and tests on this isolated branch, but must still:

1. refresh live function definitions, overloads, grants, constraints, and idempotency behavior;
2. produce a migration threat model and disposable-database proof;
3. receive a fresh independent Codex/Claude review of the actual SQL;
4. obtain the required live migration approval/proof gate before applying anything;
5. build browser integration only after the database contract is proven.

No commit, push, merge, deployment, or live migration was performed in this design review.

## Implementation follow-up — 2026-07-14

Mason subsequently approved the implementation pass. This section records proof that happened after the design review; it does not change the original review's provenance.

- Current live `complete_delivery` and `complete_job` signatures, bodies, grants, and actor/idempotency behavior were refreshed read-only before the SQL was drafted.
- The migration compiled on disposable local database `crx_offline_receipts_20260714`, cloned from the existing local CRX Supabase stack and brought to the current live dependency shape.
- `scripts/smoke/smoke-offline-action-receipts.sql` executed there through its required terminal `SMOKE_PASS_ROLLBACK` signal. It proved both canonical success paths, exact replay without duplicate inventory/application work, owner binding, safe review retention, RPC-only writes, and grants without persisting fixtures.
- The disposable proof did not claim a true two-session concurrency race or forced connection termination; those remain pre-live proof items.
- Claude Opus 4.6 first returned `NEEDS-WORK` in session `377e1e95-7479-40a5-ae23-8f88ef724104`. Codex resolved the substantive classification, replay, type, and smoke findings while retaining the project-required `p_idempotency_key text DEFAULT NULL` signature and enforcing a required key at runtime and in app-layer types.
- Claude Opus 4.6 re-reviewed the implementation in session `99d98cde-a1d2-4bfb-96a7-c3f0f3880742` and returned `SHIP-WITH-FOLLOWUPS` with no blockers.
- The exact-commit wrapper review of `58f9f35c` also returned `SHIP-WITH-FOLLOWUPS`. Its claim that PostgreSQL had never parsed or smoked the migration was incorrect because the disposable proof above had already run, but it correctly identified future device-clock handling and broad English error matching. The follow-up commit rejects completion timestamps more than five minutes ahead before writing a receipt, narrows classification to exact canonical message contracts, adds apply-time drift checks, and extends the rollback smoke.

The migration remains queued and unapplied live. A fresh exact-HEAD Claude review is required after this follow-up commit and before push.
