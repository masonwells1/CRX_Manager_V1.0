## 2026-09-22 - soft_delete_customer_document: independent Opus review round

The Codex CLI hit its account usage limit (it reports a retry date of 2026-09-26), so Mason asked
for an independent Claude Opus session to review the candidate instead. That review is NOT the
repository's push proof: `scripts/write-codex-push-proof.mjs` still requires `gpt-5.6-sol`, and the
push and migration-apply guards still demand it. It returned no BLOCKER and no HIGH, and
independently re-verified from live: the guard body md5 pin, the helper's owner-only ACL, the
tables' ownership and un-forced RLS, `idempotency_keys`' single deny-all policy, that
`IDEMPOTENCY_ACTOR_MISMATCH` is P0001 (so the round-5 `22023` handler cannot swallow it), and the
"95 applied post-baseline migrations, 2 skipped" replay claim.

**Fixed.**
- **(MED) The prover was registered nowhere,** so `run-smoke.mjs` would never re-run it and a later
  edit to `guard_customer_document_update`, `customer_documents_rep_select` or
  `check_idempotency_intent` would stop being proven silently. New chain
  `scripts/smoke/smoke-customer-document-rep-soft-delete.sql` covers the security core (grants,
  the rep removal, the bound replay, the uniform refusals, key required, no actor), is registered
  in `scripts/smoke/smoke-specs.json` as `soft_delete_customer_document`, and the prover runs it.
  The prover also re-applies the mutant and requires the chain to FAIL against it, so the chain
  cannot pass while the property it claims is false.
- **(MED) The skip-soundness check had identifier blind spots and had never executed,** because
  PR #761's file is not on disk. It is now `touchesCustomerDocumentSurface()`, which matches the
  table rather than one statement spelling — unqualified `ON customer_documents`, quoted policy
  names, `FORCE`/`ENABLE`/`DISABLE ROW LEVEL SECURITY` and `OWNER TO` all trip it — and
  `selfTestSkipSoundness()` proves each spelling trips it and that three benign statements do not.
- **(MED) The proof never covers the prerequisite schema.** The migration header now says so, and
  records the hand analysis: `20260914100800`'s new `idempotency_keys` trigger is scoped to
  `NEW.operation = 'transfer_job_to_invoice'`, so it cannot affect this function's receipt INSERT.
- **(LOW) Docs.** `CURRENT_STATE.md` no longer opens with a high-water it contradicts four lines
  later; `KNOWN_ISSUES.md`'s header parenthesis, sentence and prerequisite list are repaired; the
  apply dates for `20260914100500`/`100600` are now stated as 2026-09-22 UTC (2026-09-21 evening in
  Chicago), matching the ledger versions the repo cites everywhere else.
- **(LOW) Overstated claim** in the inventory-classification changelog: that test checks the
  declaration and an idempotency marker; the prover is what proves enforcement.
- **(LOW) Dead `v_role` declaration** removed from the preflight block (the postflight copy is used).
- **(LOW) `caller-analysis:`** no longer claims a caller that does not exist at this commit.
- **(LOW) The deadlock note** no longer says "only": it names the lock order, the second
  conflicting class (customers before profiles), and dates the sweep that found no partner.

**Deferred, with reasons.**
- *(LOW) `IDEMPOTENCY_CROSS_OP_KEY_REUSE` names the other operation.* That refusal comes from the
  shared helper at P0001 before the actor check, and catching it here would mean matching on
  message text and would mask genuine errors. Keys are random 122-bit values, it discloses no ids,
  and this belongs with the helper, not with one caller.
- *(LOW) The postflight does not pin this function's own body md5.* There is no reference value to
  pin at install time; the postflight pins the argument list, overload count, owner, SECDEF,
  search_path, ACL and refusal ordering, and the prover exercises the behaviour.
- *(LOW) Mutation coverage is one predicate.* The registered chain now adds a second mutation axis
  (the chain must fail against the assignment mutant); widening to the role gate, the key rule and
  the replay re-authorization stays open work.
- Previously accepted: the Docker image is pinned by tag, control characters in the key (the same
  residual accepted for `adjust_inventory`), and EXECUTE inherited through `authenticated`
  membership.
