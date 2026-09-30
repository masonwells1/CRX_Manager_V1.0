## 2026-09-12 - Pending #652 retry-safe generic field-invoice cutover

The earlier proposed one-stage refusal breaks a retry of an invoice committed
before installation. It is not live, and the reproduced HIGH remains open until
the corrected candidate's executed proof and independent review pass.

Repurpose the still-unapplied `20260912165758` proposal as phase 1: a fail-fast
shared advisory lock, READ COMMITTED requirement and fresh catalog V1 fence,
with original creation/below-cost/key-only receipt/delegation behavior intact.
Legacy generic receipts do not have actor or payload bindings; no bridge,
manufactured binding, deletion or backfill is introduced.

New `20260913040359_finish_generic_field_invoice_cutover.sql` is phase 2.
It requires phase 1 to be separately committed, obtains the same advisory key
exclusively or refuses, checks all other open database transactions and prepared
transactions with full stats visibility, and locks receipts for a stable scan.
ANY still-valid generic save receipt blocks installation, including NULL expiry
and expiry equal to the transaction timestamp. This leaves legitimate retries
working under phase 1 until natural expiry. Apply phases separately, never in a
single batch transaction or savepoint. Total transaction quiescence is mandatory
at phase-two installation, including background workers and scheduled jobs;
quiet customer traffic alone is insufficient. A refusal leaves phase one intact.
Wait for natural receipt expiry and a genuinely quiet window, then recheck and
retry only through the full governed apply gate; never bypass the refusal.

After safe cutover, final public save is the original pinned wrapper plus the
NEW field-application refusal. The transitional advisory/isolation/version checks
are removed from normal final operation. Dedicated field-app/job/blend creators,
source-season behavior, existing generic edits, money logic, defaults, owner and
ACL are unchanged. The all-open-transaction scan includes background workers;
SQL PREPARE statements and two-phase prepared transactions are tested separately.

Extend the existing network-isolated disposable PostgreSQL prover, not a new
production test path: committed retry before/after phase 1 and failed phase 2;
active/null/exact-boundary receipt refusal; deliberate receipt-gate removal;
shared/exclusive contention; old open/prepared transactions; the SAME persistent
SQL PREPARE session across both commits; old V1 null-key catalog fence; simulated
fixture expiry; final original/changed/alternate-actor field refusal; normal
nonfield/edit/source-creator controls. No production database URL is read.

Observed local proof: the final full disposable run exited 0 with
`PREVIEW_SEASON_PROOF_PASS`; both registered public invoice business chains reached
`SMOKE_PASS_ROLLBACK`. It exercised the committed retry/expiry/cached-session/
concurrent/prepared/bundled-savepoint/OID-drop-create/refusal/mutation controls above.
Full Vitest: 373 files passed, 5,246 tests passed, 123 deliberately skipped; no
unhandled-error summary. Lint, typecheck, build, agent-workflow tests, dependency
verification, documentation indexing and focused drift slice (256 passed,
78 skipped) passed. Four fresh read-only production sweep packets (invoice
balance, whole-cent money, overloads, SECDEF search path) returned zero rows and
the normal captured-result adjudicator passed; this is an explicit subset,
not a claim that every unrelated live invariant was re-certified.

Focused security/drift/compliance/type reviews are clean for the corrected SQL
surface. The earlier broad shell SQL-audit invocation remains blocked by the
maintenance-command guard; it was not bypassed or called a pass. Normal staged
SQL validation and exact-commit hard-rule/whole-branch review still bind delivery.
The corrected frozen whole-branch Sol/high review, publication, CI and actual
CodeRabbit review remain pending. The reproduced HIGH is behavior-repaired in
the disposable path, not final-candidate cleared or deployed.

Rollback/verification: before live apply, no business state has changed—close
or park the PR. If only phase 1 were applied in a later approved rollout, restore
the pinned original wrapper via a fresh reviewed forward migration at a quiet
moment; never edit/reapply installed history. After phase 2, restoring generic
field creation would reopen the reproduced creation bypass and requires an
explicit risk decision; prefer preserving the refusal and fixing forward.
Check exact live body/OID/ACL/defaults, pending receipt/request state and normal
nonfield/edit/source-creator behavior after any separately approved apply.
No merge, live apply, production mutation or review-policy change authorized.
