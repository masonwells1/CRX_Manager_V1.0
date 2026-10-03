## 2026-09-23 - soft_delete_customer_document: rls-security-reviewer + migration-drift-reviewer

Both reviewers were re-run on `9e12dc55a` because the PR #776 round edited the SQL. **0 BLOCKER,
0 HIGH from each.** They independently found the SAME root cause, and it was in that round's own
fix — the reason to re-review your own fixes first.

### The MED both reviewers raised, and why the fix goes further than either suggested

PR #776 narrowed the `22023` handler by message and called bare `RAISE;` for anything else. Bare
`RAISE;` re-raises the original exception **with its DETAIL**, and that DETAIL carries the
committed receipt naming a document and customer the caller may no longer be allowed to see. So a
later re-emit of the shared helper that reworded or prefixed its `22023` message would fall to the
`RAISE;` path and leak exactly what the file's uniform `CUSTOMER_DOCUMENT_NOT_FOUND` exists to
withhold. The round had traded a cosmetic risk for a disclosure risk, gated on an unpinned string
in another migration's function.

Both reviewers proposed pinning the helper's message in the preflight. **The fix is structural
instead:** no path re-raises the helper's exception at all. The mismatch branch raises the scrubbed
token; every other `22023` raises a distinct `IDEMPOTENCY_HELPER_FAULT`, never the original. A
preflight pin only protects at apply time — a helper re-emitted *after* this file is applied would
walk straight past it — whereas removing the re-raise means a drifted message can at worst
mislabel a fault and can never leak. The message is now read only to choose which token to answer
with.

- `starts_with()`, not `LIKE`: `_` is a `LIKE` single-character wildcard, so
  `'IDEMPOTENCY_INTENT_MISMATCH%'` also matched `'IDEMPOTENCYxINTENTyMISMATCH'`. Measured on live
  2026-09-23: `LIKE` → true, `starts_with` → false. This is the second `LIKE`-semantics defect on
  this branch in two days.
- The discarded DETAIL now goes to the server log (`RAISE LOG`) before the scrub, so a real key
  collision leaves a diagnostic on the side of the boundary where it is not an oracle.

### Also fixed

- **The fault branch was unreachable, so no proof layer could execute it** (RLS M2). A
  security-relevant branch whose first execution is its first test is the failure shape this
  branch has already hit three times. The prover now renames the real helper aside, installs a
  shadow that raises a *different* `22023` with a receipt-shaped DETAIL, and asserts the caller
  sees `IDEMPOTENCY_HELPER_FAULT`, not the mismatch token, with no DETAIL, no document id, no
  customer id, and the document still live. It then drops the shadow, renames the real helper back,
  and **proves the restore** — otherwise every later assertion in the run would be meaningless.
- **The replay validated the customer but not the document** (drift L1). The fingerprint binds
  both, so only a receipt from an older scheme could diverge — but in that case the function
  returned a success envelope naming a *different* document as removed. Both ids are now checked.
- **Two refusals were bare tokens** (drift L2), unlike every other refusal in the file. They now
  carry human text, so the Documents tab cannot show a raw token.
- **`docs/reference/migration-history.md` row 936 pinned a stale blob** and attributed the
  reviewers' verdicts to it (drift M2). The pin went stale silently when this file was edited. The
  row no longer pins a hash at all — it points at the per-round changelogs and states that each
  verdict binds only to the blob it read.
- **Two header claims corrected** (RLS L3, L5): PostgreSQL re-validates every CHECK against the
  new row on UPDATE, so `20260914100700`'s `storage_path` CHECK *does* participate in this
  function's UPDATE (safe only because that file adds it validated over a zero-violation
  preflight); and `has_function_privilege()` is membership-aware, so the postflight does catch
  `anon`/`service_role` inheriting EXECUTE.

### Recorded, not acted on

- Idempotency keys admit embedded control characters — the accepted repo-wide residual from the
  2026-09-20 `adjust_inventory` round. Deliberately NOT re-opened here. This file makes no
  "controls pass" claim, so it inherits none of that entry's wrong sub-claim.
- `customer_documents` has no shared TypeScript interface (drift L4). Belongs to the follow-up page
  branch, which switches `handleDelete` to this RPC.

Proof: the prover re-ran end to end to `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS`, now
including the shadow-helper fault case, the registered chain, and both mutation tests. The
`gpt-5.6-sol` gate returned CLEAN on the earlier heads `1789c72b3` and `8069cd45a`; those proofs
are void for the current head (the signature changed after them, and every commit unbinds a
proof), so a fresh run is still required before merge or apply. It has not run since (Codex
usage limit, retry 2026-09-26).
