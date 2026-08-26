# Section 9 AP Safety Remediation — Verified Build Handoff

## WHERE

- Checkout: `C:\Users\mason\.codex\worktrees\section9-ap-safety-remediation\CRX_Manager`
- Branch: `codex/section9-ap-safety-remediation-v2`
- Current base: `origin/main` at `090bce62`; the published branch merged that current base without rewriting history, and the affected proof reran afterwards.
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
- Other AP/receiving entry points no longer mint a fresh key merely because a form reopens, unmounts, reloads, or changes after an uncertain response. The frozen payload and matching key are persisted atomically in one versioned, actor/operation/surface/scope-isolated session record; storage failure refuses the mutation before the RPC call.
- The create-bill and every `receive_po_items` frontend now freeze the exact first payload after an uncertain response, disable editing/closing, expose an exact-retry action, and reconcile a committed result before allowing a new mutation.
- Inventory receiving preserves and restores the frozen request if its modal is reopened or the page reloads. PO-detail receiving scopes its durable record to the route PO and restores only that PO's payload when React Router reuses the component, preventing a prior PO payload from being paired with the new PO's PDF or notifications.
- PO-detail receiving sends a restored frozen request directly instead of comparing it to the post-commit remaining quantity. Quick Receive now persists its exact matched allocations and display context, restores and locks them after reload, and refuses to call the RPC if durable storage is unavailable.
- Vendor Bill Detail closes and clears every visible bill-specific modal when React Router changes the bill ID, without deleting the prior bill's durable unresolved payment. Payment, edit, void-payment, and void-bill actions are bound to the bill that opened them and refuse a route mismatch; stale bill reads are generation-checked so an old request cannot repaint a new route.
- Vendor-payment and vendor-bill void requests obtain keys by exact target plus normalized reason, so a failed request cannot lend its receipt to a different payment, bill, or reason.
- Every locked form now explains that the previous response was uncertain and instructs the operator to retry the unchanged request; the New Vendor Bill icon-only back control also has an accessible name.
- Vendor-payment input formatting now converts integer cents to a decimal string with integer arithmetic, avoiding a binary floating-point round trip.
- `section9ApIntentBinding.test.ts` mutation-tests the actor binding, fingerprints, cutover lock, insert trigger, transaction-local binding context, private implementation ACLs, helper dependency, receipt reconciliation, due-date basis, day-1 boundary, durable actor/surface/scope isolation, and restoration wiring in every high-risk form. `useUncertainMutationIntent.test.ts` proves same-payload/same-key restoration after unmount/reload, definitive cleanup, and fail-closed storage refusal. The Quick Receive component test additionally proves a restored request bypasses refreshed form validation and replays the frozen payload/key.
- The public receiving wrapper raises the canonical `ACTOR_MISMATCH` refusal when `p_performed_by` disagrees with `auth.uid()`; the mutation guard goes red if that token is removed or renamed.
- Both migrations fail closed on stale public overloads. Their preflights pin the sole expected signature, owner, language, security mode, fixed search path, and reviewed live-body SHA-256; their postflights require exactly one expected public overload after creation.
- The Section 9 rollback chain now proves exact replay and changed-payload refusal for all six mutators, with no second money, inventory, receiving, audit, or terminal-state effect. It also proves the next-month dashboard boundary and exact due-today/future and 1/30/31/60/61/90/91 aging boundaries.
- The real-schema PostgreSQL 17 prover now restores the verified platform and migration-ledger artifacts, normalizes historical SQL to canonical LF, pins the one live CRLF function body expected by a later preflight, proves a concurrent legacy receipt writer blocks cutover until it commits and is then caught by preflight, and proves a late old payment body is rejected at receipt insertion with zero payment, bill-balance, or receipt residue.
- The standing Section 9 invariant accepts the pre-apply direct bodies and the post-apply wrapper-to-private chain, then checks the private implementation's locks and period guards. Decoy overload cleanup now runs in `finally`, and one shared legacy-receipt predicate drives setup, assertion, and cleanup.

## PROOF OBSERVED

- `npm run typecheck` — pass.
- `npm run lint` — pass.
- `npm run build` — pass.
- `npm run test` after the durable retry and vendor-bill route follow-ups on current main — 342 files passed; 4,807 tests passed; 123 skipped.
- `npm run test` after the final receiving follow-up — 342 files passed; 4,808 tests passed; 123 skipped.
- Durable retry focused contracts after the vendor-bill route correction — 3 files, 50/50 passed; hook-only reload/unmount/storage-failure/scope-switch proof 9/9 passed.
- Final receiving review follow-up — typecheck, full lint, production build, documentation drift, and diff checks pass; 4 focused files, 19/19 tests pass, including an actual Quick Receive reload/retry.
- Latest focused remediation/concurrency/money tests after the follow-up — 68/68 passed.
- Latest PR-review follow-up guard — 4 files, 27/27 passed; the focused Section 9 contract alone passes 7/7.
- Focused Section 9 guard after the canonical actor-refusal correction — 6/6 passed.
- `npm run check:docs` — pass.
- Disposable PostgreSQL proof after the follow-up — full replay of 64 post-baseline migrations, decoy overloads for `create_vendor_bill(text)` and `get_ap_aging(text)` were rejected before candidate apply, concurrent cutover drain passed, late-old-body rollback passed, both new candidates applied, all three sibling rollback chains passed, every two-session close/write schedule passed, future-dated payments were excluded from the selected month, terminal marker `VENDOR_BILL_PERIOD_CLOSE_CONCURRENCY_PASS`.
- The broader supplier-pricing return-policy proof now creates and restores its disposable migration ledger, then stops before the Section 9 object-identity assertion at the older `20260810010308_active_team_note_assignment_actor.sql` preflight because the baseline's `notify_team_note_assignment` body md5 is `ad8be4ed1d2bdd2a87acce255b38ab641` instead of the migration's pinned `ce356683fb140f2e0d3d8faee077cc1a`. This is an unrelated harness/baseline blocker, not a clean result; the corrected `days_1_30` expected signature is pinned by the focused test.
- `git diff --check` — pass.
- React best-practices review — no new waterfall, bundle, hook-dependency, transient-state, or rendering blocker found in the changed flow.

## EXACT-COMMIT REVIEW STATUS

- The first `gpt-5.6-sol` high-effort exact-commit review correctly found one HIGH cutover race: queued old RPC bodies could write an unbound receipt after preflight, while payment and receiving callers treated the resulting mismatch as permission to unlock a fresh key.
- The database cutover barrier/trigger and client receipt reconciliation described above close that finding, and the new disposable concurrency/rollback proof passes.
- The first CodeRabbit review on PR #491 raised eight actionable implementation/proof comments. All eight are corrected locally: three missing uncertain-intent UI locks, exact cents display, stable payment-method label wiring, single-clock AP aging, an upper month bound, smoke ownership, prover cleanup error handling, and guard/changelog accuracy.
- Exact branch review at `893eeb19` returned CLEAN with zero HIGH/BLOCKER findings and minted its SHA-bound proof.
- The final migration-specific security pass then found one additional HIGH: `receive_po_items` enforced actor equality but returned a noncanonical exception string. The wrapper and executable guard are corrected, the full database replay passes again, and the AP-aging migration's security/drift proof remains clean.
- Exact branch review at `b4b6b70c` then found one additional HIGH: unexpected public function overloads could survive the migrations and expose a stale implementation. Both migrations now fail closed before and after on overload drift, pin the reviewed pre-cutover function shape/body, and include real decoy-overload rollback proofs.
- Rebased exact branch review at `518f777b` returned CLEAN, but current main advanced during the next test-only review and correctly invalidated that proof. The published branch now contains current main through a normal merge; a new exact-head proof remains pending.
- Exact branch review at `a2ba3bf9` returned CLEAN, and all required PR checks passed on that SHA. The CodeRabbit status was green, but its actual latest-review body contained two real Major reload/unmount findings. Those are now fixed by the atomic durable payload/key record and covered by executable tests; the changed final head still requires a fresh exact-SHA review and latest-commit PR gates.
- The first Sol-high review after the durable-retry fix returned CLEAN on `e06b708b`, but `origin/main` advanced to `090bce62` during the run. The wrapper correctly refused to mint a proof for the moved base; the new main commit is now merged and a stable-head rerun remains required.
- The stable-head Sol-high rerun then found one HIGH: route reuse could pair vendor bill A's visible payment fields with bill B's fresh key. The route reset, modal-to-bill binding, stale-fetch guard, and A-to-B-to-A scope regression described above close it locally; a fresh exact-head review remains required after commit.
- Exact review at `e0985c82` found two receiving HIGHs: PO-detail revalidated a restored request against post-commit remaining quantity, and Quick Receive still discarded its key on reload. The direct frozen retry and durable Quick Receive contract described above close both locally; focused executable proof is green and full/exact-head proof remains pending.
- Both migrations' final security and drift reviewers are CLEAN with SHA-bound proof files. The first intent/dashboard drift run timed out while scanning GitHub under a Windows read-only-shell limitation; the warm-cache retry completed CLEAN without changing the proof harness.
- Replacement PR #500 is open and obsolete PR #491 is closed without rewriting published history. All earlier required checks passed on `a2ba3bf9`, but the actual CodeRabbit review text exposed the two durable-retry findings described above. They are corrected locally and the full/focused proofs pass; a fresh exact-head review and latest-commit CI/CodeRabbit pass remain pending after the documentation commit.

## APPROVAL STATE

- Mason explicitly authorized remediation and proof of all three HIGH findings and approved the fifth `1-30 Days` bucket in this task.
- The interactive live-migration apply remains a separate in-chat approval gate after the exact migration artifact is proven.
- The product decision is settled and recorded in `docs/manual/DECISION_LOG.md`.

## GATES AND BLOCKERS

- Money/RPC/migration changes require rollback-only execution, migration security/drift review, and an exact-SHA `gpt-5.6-sol` high-effort verdict.
- Live apply is not authorized yet.

## FIRST ACTION

Commit the durable-retry proof update, mint a fresh exact-head review, push to PR #500, and clear latest-commit CI/CodeRabbit before requesting live-migration approval.

Verify current state from Git, disk, and connected services before trusting this handoff; it may be stale when read.
