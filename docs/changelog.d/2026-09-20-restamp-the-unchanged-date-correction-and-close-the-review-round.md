## 2026-09-20 — restamp the unchanged-date correction ahead of the cutover, and close the PR #742 review round

Six findings on delivery PR #742 (head `fe13e961b`) — one P2 from the Codex GitHub App and five
from CodeRabbit's `CHANGES_REQUESTED` review. Every one was checked against current source before
being accepted; all six were real and all six are fixed here in one commit.

### 1. RESTAMPED: the unchanged-date correction now runs BEFORE the cutover phases (Codex App P2)

`20260913152700_preserve_unchanged_source_invoice_dates.sql` →
**`20260911130000_preserve_unchanged_source_invoice_dates.sql`**.

The file's own header has always said "Apply AFTER 20260908190000; keep the earlier migration and
cutover phases intact." Its stamp said otherwise: at `20260913152700` it sorted after BOTH cutover
phases. That matters because phase 2 (`20260913040359`) is deliberately built to refuse rather than
cut over while the database is busy — it aborts at `GENERIC_FIELD_CUTOVER_ACTIVE_RECEIPTS` while any
valid generic `save_invoice` receipt exists, and at `GENERIC_FIELD_CUTOVER_NOT_QUIET` while any
other transaction is open. Under strict ordering the correction could not step around that block.

So ordinary generic-invoice activity could have parked production in exactly the state this
correction exists to remove — the September 8 season guard rejecting unchanged-date previews for
legitimate prior-season job/blend invoices — for the receipt lifetime, or indefinitely if new
receipts kept arriving.

**Why `20260911130000`:** it sorts above `20260908190000`, whose two guard identities are the only
thing this file depends on; below `20260912165758`, so it lands before either phase; and above the
live-applied `20260911120000`, so the restamp does not add another below-high-water candidate.
Dependency checked in the file itself — its preflight requires only
`_assert_field_app_invoice_date_in_filed_season` and `guard_field_app_invoice_season_date`, and
nothing from either cutover phase.

**Apply order is now `20260908190000` → `20260911130000` → `20260912165758` → `20260913040359`,
which is NOT row order.** Row 934 applies third. The ledger says so explicitly, in both the
ordering paragraph and the row itself, because row numbers are insertion order.

This reverses the "not done here on purpose" decision recorded earlier the same day in
`2026-09-20-strict-migration-ordering-after-pr726.md`. That entry deferred the restamp to Mason as
an apply-shaping decision. It stopped being deferrable when the Codex GitHub App raised it as a
formal P2 on the delivery PR: both merge gates deny over an unresolved App finding. It is also the
lower-risk direction — it removes a production failure window rather than creating one — and it
only reorders files that are all still unapplied. Mason was briefed on the apply-order question and
approved shipping the scoped season closure; this keeps that shipment correct rather than widening
it. Both earlier changelog entries now carry a superseding note.

### 2. The already-applied prerequisite was still listed as an apply step (CodeRabbit)

`docs/reference/migration-history.md` still called `20260908140000_number_generators_year_chicago`
UNAPPLIED and told operators to "apply `20260908140000` first". **It applied live on 2026-09-20**
under ledger version `20260920051333` — recorded in row 929, which this branch merged in from main
without the surrounding prose being updated. Re-applying it would fail.

Corrected: the prerequisite is stated as already satisfied, the apply sequence now lists the four
local candidates alone, and removing the `ordering-guard: ahead-of-pending` markers is explained as
still-correct-but-no-longer-urgent rather than as protecting a pending migration.

**The pending-set guard output in the previous entry is also re-characterised honestly.** It
refused all four candidates and named `20260908140000` and `20260911120000` as blockers — but both
are applied. The guard reads applied names from `.claude/schema-registry.json`, whose snapshot
predates both 2026-09-20 applies, so it counted two applied migrations as pending. It errs toward
refusing too much, never too little, and it resolves on the next registry refresh, which needs a
live read and is not done here. The structural claim it demonstrates is unaffected: an applied
migration is not in the tracked-and-unapplied set, which is why `20260908190000` sorting below the
applied `20260911120000` is inert.

### 3. A filtered invariant sweep could satisfy a release gate (CodeRabbit, Major)

`.claude/commands/preflight.md` and `scripts/db-invariant-sweeps/README.md` both offered
`--only <names>` alongside the `MIGRATION_CHANGED=true` gate with no restriction, while the same
paragraph ends "Any unallowlisted violation is a BLOCKER." `--only` excludes predicates, so a
filtered adjudication cannot show every invariant class is clean — a migration could have proceeded
while an unselected predicate held an unallowlisted violation. Both documents now state that
`--only` is diagnostic-only and cannot provide migration, ship, or review gate evidence, and that
the gate requires the full predicate set.

### 4. The `save_invoice` smoke spec could execute against a live database (CodeRabbit)

`scripts/smoke/smoke-specs.json` described its companion prover as CONTAINER-ONLY and warned "do
not run these committed/concurrent cases against live", but the spec carried neither
`container_only` nor `container_prover`. With `SUPABASE_DB_URL` set, `run-smoke.mjs` would have let
the unflagged spec reach the `psql` path, and the SQL chain writes fixtures before its rollback, so
the rollback is not the restriction the description relied on. Both flags added, pointing at
`prove-preview-field-app-season.mjs`, matching how the other money-path chains
(`adjust_inventory`, `issue_return_credit`, `create_inventory_hold`) are already registered.

Coverage does not drop: the prover executes this registered chain in a disposable container and
reports `SMOKE_PASS_ROLLBACK` for it (phase 9b). As with every container-only spec, `run-smoke.mjs`
only checks the prover exists, so the prover is a manual run — it was run for this commit.

### 5. The season-derivation rule read broader than the decision (CodeRabbit)

`docs/changelog.d/2026-09-12-field-app-filed-season-guard.md` and `docs/manual/DECISION_LOG.md`
both said new invoices derive their season from the invoice date, unqualified. The dedicated
job/blend creators are a supported exception — they preserve the source season while stamping
today's date — documented in `2026-09-12-field-app-invoice-creation-season-guard.md` and in the
DECISION_LOG's own September 13 compatibility clarification. Unqualified wording could misdirect a
rollout or a future change into treating that exception as a bypass. Both now scope the rule to
generic creation and point at the exception.

**This does not reopen the settled decision.** Season still follows the invoice date; the
September 4 decision and its September 13 clarification are unchanged. Only the wording is made
precise.

### 6. NULL receipt expiry is adjudication, not "natural expiry" (CodeRabbit, Trivial)

Phase 2's receipt gate treats `expires_at IS NULL` as still-valid and refuses, but its message says
"wait for natural expiry" — which a NULL-expiry receipt never reaches. `idempotency_keys.expires_at`
is nullable, so a legacy or hand-inserted row is possible. The gate is correct and fail-closed and
is unchanged; a comment now records that such a row is a rollout signal requiring operator
adjudication of that specific receipt, and must not be deleted, backfilled, re-dated or bypassed.

### Hash repins

Two migrations changed bytes, both comment-only, so both canonical LF SHA-256 pins were recomputed
and updated in `docs/reference/migration-history.md` (and in
`2026-09-13-phase-two-cutover-lf-pin.md` for phase 2):

- `20260911130000` (restamped, header rewritten): `2c3c5859…951204`
- `20260913040359` (phase 2, NULL-expiry comment): `da3d4c76…88c432`

The method self-validates: recomputing the two migrations this commit did NOT touch reproduces
their existing pins exactly — `20260908190000` at `f4712cc9…18dcb49` and `20260912165758` at
`997872a6…7efbc071`.

`supabase/migrations/20260908140000_number_generators_year_chicago.sql:76` still lists the old
`20260913152700` stamp in a comment. **That file is applied live and must not be edited**, so the
stale reference is left in place and recorded here instead.

### Proof

Rerun on this head after every fix above. Repository merge does not apply any migration or
authorize a live SQL or data change.
