## 2026-09-12 - OPEN migration-crossing retry blocker

The final exact-head Sol/high review of `f6cb05b369d5271acc254e125cd1f46049bbf32d`
returned BLOCKERS at 18:15:11Z. HIGH: the generic field-invoice creation refusal
runs before cached replay; an invoice committed before deployment can therefore
report failure on an identical retry after deployment. This is OPEN, not fixed
or approved, and no clean proof was minted for that commit.

Add an executable regression to the normal disposable prover: create and COMMIT
through the actual authenticated base public RPC, observe successful identical
replay before migration, apply the candidate in the container, and require the
same committed invoice UUID afterward. The failure remains registered until a
safe transition implementation is reviewed and observed.

Observed: the base authenticated creation committed its receipt; the identical
authenticated pre-migration retry returned its invoice. After applying the
candidate in the isolated container, the same request failed with
`FIELD_APPLICATION_VIA_SAVE_INVOICE_NOT_ALLOWED`, producing the explicit
`MIGRATION_CROSSING_COMMITTED_RETRY_REJECTED` assertion. The full prover exited
1 and its container was removed. This is a reproduced HIGH, not a passing run.

Read-only current source confirms generic `save_invoice` uses `check_idempotency`
and `save_idempotency`, which do not bind the receipt to actor or original request
contents. The separate bound helper cannot reconstruct legacy missing bindings.
Do not claim the existing generic writer enforces intent, return arbitrary old
receipts as authorized exact matches, or broaden receipt/auth policy silently.
Production currently has zero unexpired generic receipts; this is a dated
read-only observation, not a deployment guarantee. Neither guard is live.

No new push, merge, live apply, data mutation, trigger bypass or review-policy
change is authorized by this unresolved-finding checkpoint. The previously
passing registered edit chains do not clear the newly added transition check.
