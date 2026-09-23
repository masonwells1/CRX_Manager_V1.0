## 2026-09-22 - soft_delete_customer_document: rls-security and migration-drift review rounds

Both repository reviewers ran read-only against the parked `20260921180000`. Neither returned a
BLOCKER. Both independently confirmed the candidate's own SQL is clean: correct `search_path`,
grants, actor binding, key enforcement, no overload collision, no CHECK or generated-column
issue, every referenced column and function present live with the assumed type, and the pinned
guard body md5 (`49056708bdd24900db157ef617d763b3`, 1086 characters) recomputed from the live dump.

**Signature changed while still parked (MED).** The function now takes
`soft_delete_customer_document(p_document_id uuid, p_customer_id uuid, p_idempotency_key text
DEFAULT NULL)`. The page's old direct UPDATE scoped on `.eq('customer_id', customerId)`, and
dropping that scope reopened this repository's stale-closure bug class: a tab holding a document
from a customer it no longer shows, with an admin confirming Remove, would permanently remove
another customer's document and report success. The customer is now in the WHERE clause AND in the
idempotency fingerprint, and a receipt whose customer differs is refused. A signature locks on
first apply — adding the parameter later would need a DROP plus another migration — so it is here
from the start. The prover asserts a wrong customer, a null customer and an admin naming the wrong
customer are all `CUSTOMER_DOCUMENT_NOT_FOUND` and change nothing, and a second mutation axis
proves those assertions test the new scope.

**Owner decision (Mason, 2026-09-22).** A sales rep may remove ANY active document on a customer
assigned to them, including one uploaded by the office or created by the system. Removal is
permanent, so the reviewer raised it as his call; recorded in the migration header.

**Preflight widened (MED).** It pinned ownership and un-forced row security for
`customer_documents` and `customers`, but the body also reads `public.profiles` as the owner and
writes `public.idempotency_keys` as the owner. Forced RLS on either fails closed — every caller
would get `INSUFFICIENT_ROLE`, or the receipt INSERT would roll the removal back — so both are now
pinned rather than discovered as "Remove stopped working for everyone".

**Error tokens registered (MED).** `IDEMPOTENCY_KEY_REQUIRED`, `IDEMPOTENCY_ACTOR_MISMATCH` and
`IDEMPOTENCY_INTENT_MISMATCH` are now in `RpcErrorCodes`. Pages classify these through
`src/lib/idempotency.ts` rather than by token, which is why they were missing; two reviewers asked
for the names, and they are raised by this function.

**Header corrections.**
- `20260914100800`'s new `idempotency_keys` trigger has NO `WHEN` clause, so it does fire on this
  function's receipt INSERT; its body returns `NEW` unless the operation is
  `transfer_job_to_invoice`. The conclusion (no effect here) was right, the mechanism described
  was not.
- The 24-hour receipt expiry is now documented: a retry a day after a successful removal is treated
  as new, finds the document gone, and reports `CUSTOMER_DOCUMENT_NOT_FOUND` for a removal that did
  commit. The page reads that as "already removed" and reloads, which is the truth.
- The locks section records the new blocking path (`allocate_payment` and `save_customer` take the
  customer row `FOR UPDATE`, so a removal queues behind them) and that the two row locks inside one
  statement are acquired in a plan-dependent order.

**Ordering findings, NOT fixable in this branch — they belong to Mason and to another lane.**
- **(HIGH) `20260914100450` (PR #761) is already stranded.** It sorts below the live high-water
  `20260914100600`, so `.claude/hooks/migration-ordering-lib.mjs` refuses it. This file no longer
  names it as a prerequisite, and it cannot strand it: `100500` applying did that. Its own lane
  must restamp it above `20260914100600`.
- **(HIGH) `.claude/session-state/applied-migrations.json` was captured 2026-09-05** and contains
  none of the `20260914100100`..`100600` cohort, so the ordering guard computes a stale high-water
  and would report a false clean for `100450`. Refreshing it is a cross-lane decision, because a
  refresh makes the guard refuse every stranded file (`100450` plus the four field-season files) —
  the same hold recorded for PR #646. Surfaced to Mason rather than done unilaterally.

**Deferred.** The `IDEMPOTENCY_CROSS_OP_KEY_REUSE` refusal still names the operation that owns a
colliding key; that message belongs to the shared helper, keys are random 122-bit values, and no
ids are disclosed. The admin path still takes the customer row `FOR SHARE` it does not strictly
need. Both recorded, neither changed here.
