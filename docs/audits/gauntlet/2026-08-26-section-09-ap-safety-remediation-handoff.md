# Section 9 AP Safety Remediation — Verified Build Handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\section9-ap-safety-remediation\CRX_Manager`
- Branch: `codex/section9-ap-safety-remediation`
- Current base: `origin/main` at `5e356ee6e757526920c3d7ffe92491e1e42b6bbf`; the branch is two commits ahead and not behind.
- Repository: `masonwells1/CRX_Manager_V1.0`
- Live database: Supabase project `rhyzpcqhnizqbxphqdkr`

## GOAL

Close and prove the three Section 9 HIGH findings: due-date AP aging, calendar-month AP dashboard semantics, and actor-plus-exact-intent idempotency for AP and receiving mutations.

Done means the changed database and UI paths execute successfully in rollback-only/disposable proof, each original bug has a regression guard that fails when the fix is removed, an independent exact-SHA review is clean, and the protected PR pipeline is green.

## PROVEN

- The worktree is clean and was created from freshly fetched `origin/main` rather than the dirty shared checkout.
- A fresh Graphify map was built at `14378963`; the focused impact query identified the AP page/types, all receiving callers, idempotency helpers, and existing intent-binding proof patterns. Source reads confirmed every material connection.
- Live catalog reads confirmed the current `get_ap_aging` still buckets from `bill_date`, `get_ap_dashboard_summary` still uses a rolling 30-day window, and the six affected AP/receiving mutators still call operation-only receipt helpers.
- Live aggregate evidence showed zero unexpired receipts for `create_vendor_bill`, `update_vendor_bill`, `record_vendor_payment`, `void_vendor_payment`, `void_vendor_bill`, and `receive_po_items` at the cutover preflight.
- The existing `check_idempotency_intent(text,text,uuid,text)` helper is live, PostgreSQL-only, fixed-search-path, and already implements exact replay plus actor/intent mismatch refusal.

## WRITTEN AND PROVEN LOCALLY

- Candidate migration `20260826125456_bind_section9_ap_receiving_intent_and_month_dashboard.sql`:
  - wraps all six AP/receiving mutators with actor-plus-SHA-256 intent binding;
  - keeps the mature implementations private and owner-only;
  - preserves the existing public signatures, defaults, return shapes, grants, and fixed search paths;
  - takes an `ACCESS EXCLUSIVE` cutover lock on the receipt table so pre-cutover executions drain before legacy-receipt validation;
  - installs an insert-time binding trigger that rejects a late old function body and rolls its entire money/inventory statement back;
  - stamps each new receipt atomically from transaction-local wrapper context before the private implementation returns;
  - refuses active unbound legacy receipts at cutover;
  - changes `Due This Month` from a rolling 30-day window to the Chicago business date through calendar month-end.
- Candidate migration `20260826140333_correct_ap_aging_due_date_buckets.sql`:
  - replaces bill-date aging with the approved due-date contract;
  - adds the fifth `1-30 Days` bucket and makes `Current` mean due today or later;
  - preserves the current-only refusal, admin guard, fixed search path, owner, and deliberate grants.
- `AccountsPayable.tsx`, shared types, and generated Supabase RPC types now expose and label all five buckets, including CSV export and totals.
- Lost-response UI protection freezes the first exact payment or PO-receiving payload and prevents closing or editing those forms until an exact retry reconciles the result or the server proves a definitive refusal. Intent-mismatch errors remain uncertain until the caller inspects their receipt; both screens now recover the committed payment/receiving result and refresh authoritative state instead of unlocking a fresh mutation.
- Other AP/receiving entry points no longer mint a fresh key merely because a form reopens or changes after an uncertain response; the server rejects changed intent under the retained key.
- The create-bill and both receiving entry points now freeze the exact first payload after an uncertain response, disable editing/closing, expose an exact-retry action, and reconcile a committed result before allowing a new mutation.
- Vendor-payment input formatting now converts integer cents to a decimal string with integer arithmetic, avoiding a binary floating-point round trip.
- `section9ApIntentBinding.test.ts` mutation-tests the actor binding, fingerprints, cutover lock, insert trigger, transaction-local binding context, private implementation ACLs, helper dependency, receipt reconciliation, due-date basis, and day-1 boundary. `useUncertainMutationIntent.test.ts` proves frozen payloads and keeps actor/intent mismatch errors locked until reconciliation.
- The Section 9 rollback chain now proves exact replay and changed-payload refusal for all six mutators, with no second money, inventory, receiving, audit, or terminal-state effect. It also proves the next-month dashboard boundary and exact due-today/future and 1/30/31/60/61/90/91 aging boundaries.
- The real-schema PostgreSQL 17 prover now restores the verified platform and migration-ledger artifacts, normalizes historical SQL to canonical LF, pins the one live CRLF function body expected by a later preflight, proves a concurrent legacy receipt writer blocks cutover until it commits and is then caught by preflight, and proves a late old payment body is rejected at receipt insertion with zero payment, bill-balance, or receipt residue.

## PROOF OBSERVED

- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npm run build` — pass.
- `npm run test -- --run` after the CodeRabbit follow-up — 341 files passed; 4,787 tests passed; 123 skipped.
- Latest focused remediation/concurrency/money tests after the follow-up — 68/68 passed.
- `npm run check:docs` — pass.
- Disposable PostgreSQL proof after the follow-up — full replay of 63 post-baseline migrations, concurrent cutover drain passed, late-old-body rollback passed, both new candidates applied, all three sibling rollback chains passed, every two-session close/write schedule passed, future-dated payments were excluded from the selected month, terminal marker `VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS`.
- `git diff --check` — pass.
- React best-practices review — no new waterfall, bundle, hook-dependency, transient-state, or rendering blocker found in the changed flow.

## EXACT-COMMIT REVIEW STATUS

- The first `gpt-5.6-sol` high-effort exact-commit review correctly found one HIGH cutover race: queued old RPC bodies could write an unbound receipt after preflight, while payment and receiving callers treated the resulting mismatch as permission to unlock a fresh key.
- The database cutover barrier/trigger and client receipt reconciliation described above close that finding, and the new disposable concurrency/rollback proof passes.
- The first CodeRabbit review on PR #491 raised eight actionable implementation/proof comments. All eight are corrected locally: three missing uncertain-intent UI locks, exact cents display, stable payment-method label wiring, single-clock AP aging, an upper month bound, smoke ownership, prover cleanup error handling, and guard/changelog accuracy.
- A fresh exact-commit review of the new follow-up SHA, proof stamping, refreshed CodeRabbit review, PR checks, live apply, merge, and production verification remain pending.

## APPROVAL STATE

- Mason explicitly authorized remediation and proof of all three HIGH findings and approved the fifth `1-30 Days` bucket in this task.
- The interactive live-migration apply remains a separate in-chat approval gate after the exact migration artifact is proven.
- The product decision is settled and recorded in `docs/manual/DECISION_LOG.md`.

## GATES AND BLOCKERS

- Money/RPC/migration changes require rollback-only execution, migration security/drift review, and an exact-SHA `gpt-5.6-sol` high-effort verdict.
- Live apply is not authorized yet.

## FIRST ACTION

Commit the CodeRabbit follow-up, run the exact-SHA review against that new head, and update PR #491 only if it returns no unresolved HIGH/BLOCKER finding.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
