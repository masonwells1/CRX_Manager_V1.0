# Section 9 AP Safety Remediation — Verified Build Handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\section9-ap-safety-remediation\CRX_Manager`
- Branch: `codex/section9-ap-safety-remediation`
- Starting base: `origin/main` at `14378963c4c2188844757c07da4ca0f38e4944f3`; refresh/rebase is required before final review.
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
  - refuses active unbound legacy receipts at cutover;
  - changes `Due This Month` from a rolling 30-day window to the Chicago business date through calendar month-end.
- Candidate migration `20260826140333_correct_ap_aging_due_date_buckets.sql`:
  - replaces bill-date aging with the approved due-date contract;
  - adds the fifth `1-30 Days` bucket and makes `Current` mean due today or later;
  - preserves the current-only refusal, admin guard, fixed search path, owner, and deliberate grants.
- `AccountsPayable.tsx`, shared types, and generated Supabase RPC types now expose and label all five buckets, including CSV export and totals.
- Lost-response UI protection freezes the first exact payment or PO-receiving payload and prevents closing or editing those forms until an exact retry reconciles the result or the server proves a definitive refusal.
- Other AP/receiving entry points no longer mint a fresh key merely because a form reopens or changes after an uncertain response; the server rejects changed intent under the retained key.
- `section9ApIntentBinding.test.ts` mutation-tests the actor binding, fingerprints, private implementation ACLs, helper dependency, due-date basis, and day-1 boundary. `useUncertainMutationIntent.test.ts` proves frozen payloads and definitive-versus-uncertain error handling.
- The Section 9 rollback chain now proves exact replay and changed-payload refusal for all six mutators, with no second money, inventory, receiving, audit, or terminal-state effect. It also proves the next-month dashboard boundary and exact due-today/future and 1/30/31/60/61/90/91 aging boundaries.
- The real-schema PostgreSQL 17 prover now restores the verified platform and migration-ledger artifacts, normalizes historical SQL to canonical LF, pins the one live CRLF function body expected by a later preflight, and proves the candidate legacy-receipt barrier before removing only the disposable fixture.

## PROOF OBSERVED

- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npm run build` — pass.
- `npm run test` — 341 files passed; 4,779 tests passed; 123 skipped.
- Focused remediation tests — 15/15 passed.
- Disposable PostgreSQL proof — full replay of 63 post-baseline migrations, both new candidates applied, all three sibling rollback chains passed, every two-session close/write schedule passed, terminal marker `VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS`.
- `git diff --check` — pass.
- React best-practices review — no new waterfall, bundle, hook-dependency, transient-state, or rendering blocker found in the changed flow.

## NOT STARTED

- Independent exact-SHA migration/adversarial review, proof stamping, commit, PR checks, live apply, merge, and production verification.

## APPROVAL STATE

- Mason explicitly authorized remediation and proof of all three HIGH findings and approved the fifth `1-30 Days` bucket in this task.
- The interactive live-migration apply remains a separate in-chat approval gate after the exact migration artifact is proven.
- The product decision is settled and recorded in `docs/manual/DECISION_LOG.md`.

## GATES AND BLOCKERS

- `origin/main` advanced during the build. Refresh/rebase before the final exact-SHA review.
- Money/RPC/migration changes require rollback-only execution, migration security/drift review, and an exact-SHA `gpt-5.6-sol` high-effort verdict.
- Live apply is not authorized yet.

## FIRST ACTION

Refresh/rebase from `origin/main`, rerun the affected proof if the rebase changes relevant files, then enter the exact-SHA review and protected PR pipeline.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
