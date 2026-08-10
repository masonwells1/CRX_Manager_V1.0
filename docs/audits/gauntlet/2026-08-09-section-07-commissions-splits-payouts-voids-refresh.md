# CRX Live Foundation Gauntlet — Section 7 Refresh

Date: 2026-08-09  
Section: Commissions, commission splits, entity recipients, payout batches, cancellations, and voids  
Verdict: **REMEDIATION REQUIRED**  
Findings: **0 BLOCKER / 2 HIGH / 0 MED / 0 LOW**

## Executive Summary

Two current, evidence-backed production risks remain in the commission foundation:

1. The Commission Balance report presents an As-of Date but classifies paid and outstanding amounts from each commission's **current** status. A payment or void after the selected date therefore rewrites a prior-period report.
2. Commission payout create, post, and void receipts are keyed only to the operation. After an uncertain response, the browser deliberately retains the key; if the admin changes the selected commissions, payment, or void reason, the server can replay the first result as success for a different intended action.

The earlier unresolvable-recipient finding is closed live. The current catalog also preserves RLS, admin-only payout-table reads, RPC-only payout mutations, selection locking, header/item reconciliation, cancelled-order closeout on void, and whole-cent commission reconciliation.

No finding was included unless current source and the live database catalog/function definition proved it. No business rows were queried.

## Scope and Provenance

- Repo: `C:\CRX_Manager`
- Audited checkout: `3a5ed9e0f34c51c29ccaf5dc8c184cb5eb4ed998`
- Current remote `main` verified read-only with `git ls-remote`: `6bdcc0e3925d5662df4840dc707f9cc44dd7e61f`
- Ancestry at closeout: `origin/main...HEAD = 0 behind / 6 ahead`
- Branch-only files: `.claude/hooks/actor-binding-check.mjs`, `.claude/hooks/actor-binding-check.test.mjs`, and `docs/CHANGELOG.md`. No Section 7 source or migration differs from current remote `main`.
- Run-start working tree: clean; no pre-existing uncommitted files.
- Live Supabase project: `rhyzpcqhnizqbxphqdkr`
- Fresh live migration high-water observed during the structure-only packet: `20260807220323` (`log_customer_fact_rpc`).
- Graph navigation: the existing Graphify graph was built from current `origin/main` `6bdcc0e3`; `graphify query` traced `CommissionSplitEditor` through commission payout batching and cancellation/void restoration. `graph:refresh` was not run because it writes generated graph files outside the automation's permitted audit folder.
- The canonical Sections 1–9 workflow adapter was read. Its parallel Task worker is not callable in this Codex automation, so the section was adjudicated directly from its evidence contract.

Explicit exclusions honored: Sentry, Vercel, GitHub PRs, browser sessions, production runtime telemetry, application logs, and live business-row probes. No migration, live data, grant, policy, function, source file, ref, deployment, or customer-visible state was changed.

## Finding 1 — HIGH: Historical Commission Balance reports are rewritten by later payout activity

### Proven evidence

- `src/pages/Reports.tsx:281-285` sends the selected End Date to `get_commission_balance_report(date)` and presents the returned values as the report for that date.
- `supabase/migrations/20260330100000_prelaunch_state_machine_and_security.sql:770-807` defines the function. It limits earned commissions with `cm.order_date <= p_as_of_date`, but calculates paid and outstanding amounts from current `cm.status = 'paid'` and `cm.status = 'pending'` values.
- The live `pg_proc.prosrc` definition matches that disk logic. It contains no payout item date, payment `posted_at`/`payment_date` cutoff, void cutoff, or append-only event reconstruction.
- The live function remains admin-only, `SECURITY DEFINER`, and configured with `search_path=public, pg_temp`; this is a correctness defect, not an access-control defect.

### Plain-English business risk

A commission earned before June 30 but paid in July appears as **paid** when an admin later reruns the June 30 report. If that July payout is then voided, the same June 30 report changes back to **outstanding**. Month-end commission liability and payment history therefore cannot be reproduced reliably for accounting or dispute review.

### Suggested fix

Reconstruct earned, paid, voided, and outstanding amounts from durable dated payout events as of the requested cutoff. The safest design is an append-only commission payout event ledger linked to the commission payment item. If the historical state cannot be reconstructed from existing durable records, fail closed for past dates rather than label current state as historical.

### Prevention action

Add a rollback-only database smoke that:

1. earns a commission before a cutoff;
2. runs the cutoff report;
3. posts a payment after the cutoff;
4. voids it later; and
5. proves every earlier snapshot remains unchanged.

Add a static guard requiring any RPC that accepts an historical cutoff to reference dated immutable facts or explicitly reject unsupported historical dates.

## Finding 2 — HIGH: Commission payout idempotency is not bound to the selected payout intent

### Proven evidence

- `src/hooks/useIdempotencyKey.ts:21-40` intentionally retains a key after an error and scopes it only to `[operation, userId]`.
- `src/pages/CommissionPayments.tsx:56-58` creates one persistent hook per create/post/void operation.
- `src/pages/CommissionPayments.tsx:302-345`, `348-377`, and `380-420` reset the key only after a successful RPC response. The selected commission IDs, payment ID, and void reason can change while an uncertain key remains retained.
- Live and disk `create_commission_payment` check `check_idempotency(key, 'create_commission_payment')` before validating or locking `p_commission_ids`, then cache only the payment ID (`supabase/migrations/20260714180000_harden_commission_payment_creation.sql:70-258`).
- Live and disk `post_commission_payment` perform the operation-only replay check before loading the requested payment and then cache the result (`supabase/migrations/20260714230000_gauntlet_core_guards.sql:285-395`).
- Live and disk `void_commission_payment` perform the operation-only replay check before loading `p_payment_id` and then cache the result (`supabase/migrations/20260707060000_u8_application_channel_commissions.sql:1569-1717`).
- Shared live helpers reject cross-operation reuse but do not compare actor, entity, selected IDs, or a request fingerprint (`supabase/migrations/20260714230000_gauntlet_core_guards.sql:5-52`; `supabase/migrations/20260714220000_shared_idempotency_and_hold_hardening.sql:49-82`).
- `src/lib/commissionPayoutGuards.test.ts:58-95` protects stale-selection locks and payout RLS policy shape, but contains no same-key/different-intent assertion.

### Plain-English business risk

Example: the server successfully posts Payment A, but the response is lost. The UI keeps the key. The admin then opens Payment B and retries. The server sees the old key and returns Payment A's cached success without posting Payment B; the UI reports success for the wrong payment. Create and void have the same problem, including a changed commission selection or void reason.

This does not double-pay by itself; it is dangerous because the operator is told a different financial action succeeded when it did not.

### Suggested fix

Bind each receipt to the authenticated actor and a canonical server-derived fingerprint:

- create: sorted distinct commission IDs plus payment method, reference, date, and normalized notes;
- post: payment ID;
- void: payment ID plus normalized reason.

Exact intent replays should return the cached result. A reused key with a different actor or fingerprint must fail closed with `IDEMPOTENCY_ACTOR_MISMATCH` or `IDEMPOTENCY_INTENT_MISMATCH`. Reuse the established pattern in `supabase/migrations/20260803010917_bind_idempotency_to_mutation_intent.sql:16-168`.

### Prevention action

Add rollback-only database smokes for create, post, and void proving:

- the same key plus identical intent replays exactly once;
- the same key plus a different selection/payment/reason is rejected; and
- a different actor cannot consume the original receipt.

Add a source guard requiring commission payout RPC definitions and callers to include an intent-binding marker and tests.

## Verified Controls That Survived Review

- Live `commissions`, `commission_payments`, and `commission_payment_items` have RLS enabled.
- Live payout tables expose admin-only SELECT policies and no authenticated browser write policy; mutations are routed through RPCs.
- Live `commissions` write policies remain admin-only; sales reps can read only their `recipient_user_id = auth.uid()` rows.
- Live `trg_commissions_recipient_resolved` rejects unresolved recipients before insert/update. The previous custom "Other" recipient dead end remains closed by `20260722134252_reject_unresolvable_commission_recipients`.
- `create_commission_payment` locks the full selected commission set, rejects stale/non-pending/deleted/mixed-recipient selections, and verifies inserted item count.
- `post_commission_payment` verifies item total equals header total and requires every item commission to transition from pending.
- Cancellation/void paths freeze active payout membership. Voiding a payout restores only commissions whose orders remain live and closes out commissions for cancelled/voided orders.
- Payment number allocation uses an advisory lock.
- Commission split creation rounds to cents and assigns the rounding remainder to the final split so the components reconcile to the order commission.
- Numeric commission storage is an intentional documented exception to the general bigint-cent rule; no finding was scored for that accepted design.

## Live Catalog Evidence Packet

The following structure-only queries were executed read-only against live Supabase. They returned catalog/function metadata only:

- `pg_class`/`pg_namespace`: RLS enabled on the three commission/payout tables.
- `pg_policy`: admin-only payout SELECT policies, admin-only commission writes, and admin-or-recipient commission reads.
- `information_schema.triggers`: `trg_commissions_recipient_resolved` invokes `enforce_commission_recipient_resolved` before unresolved commission writes.
- `pg_constraint`: commission amount/split/status checks, payment status/number constraints, and recipient/payment/item foreign keys.
- `pg_proc` plus `aclexplode`: current routine signatures, `SECURITY DEFINER` flags, `proconfig`, and grants for report, recipient, payout, cancel, and void functions.
- `pg_proc.prosrc`: current live bodies for the Commission Balance report, shared idempotency helpers, commission recipient helpers, commission creation, payout create/post/void, cancellation, and payment-number generation.
- `supabase_migrations.schema_migrations`: migration names/versions only; no migration was applied.

One initial catalog statement containing `pg_get_triggerdef()` was blocked by the live-data guard before execution and was replaced with `information_schema.triggers`. One combined query was also blocked before execution by the guard parser and was split into narrower catalog queries. Neither blocked statement ran.

## Cut Findings

- Role-agnostic resolution among active admin/sales-rep/entity-recipient profiles is intentional in the current migration design; access to payout operations remains admin-only. No contrary live evidence proved a defect.
- Decimal commission storage is an accepted documented exception with explicit cent rounding/reconciliation; it was not rescored.
- No live row counts, dollar totals, legacy batch contents, or business data were inspected, so no historical cleanup claim is made in this report.

## Ranked Fix Queue From This Section

1. **HIGH — make Commission Balance snapshots historically stable.** This affects accounting-period reproducibility.
2. **HIGH — bind payout create/post/void idempotency to actor and exact intent.** This prevents false-success financial actions after uncertain responses.

## Next Section

**Section 8 — Returns and credit memos, including issue, unapply, reversal, and statement impact.** It is now the oldest section (last reviewed 2026-07-22).

## Closeout

- Audit report written under the permitted gauntlet folder.
- Index and ranked summary updated.
- No remediation attempted.
- No app/source code, migration, live database state, commit, push, deploy, deletion, or forbidden external system was touched.
