## 2026-09-24 - soft_delete_customer_document: PR #780 review fix

CodeRabbit (CHANGES_REQUESTED, 2026-09-24T02:18Z), one Minor finding, verified valid against the
file before fixing. No code, SQL or prover change.

**The finding.** `docs/manual/CURRENT_STATE.md` line 48 enumerated the conditions for applying
`20260921180000_soft_delete_customer_document_rpc` as the three predecessor migrations
(`20260914100700`, `20260914100800`, `20260914100900`) plus the pending `gpt-5.6-sol` gate, and
omitted Mason's explicit approval. `docs/manual/KNOWN_ISSUES.md` (line 102) already states it
correctly — "and with Mason's approval". A status document whose job is to list what must be true
before applying should not read as though the order and the gate are the whole list.

**The fix.** That sentence now reads "and only with Mason's explicit approval in the applying
session", says in the same breath that the order and the gate are not the only apply conditions,
and points at `KNOWN_ISSUES.md` as the other record of the requirement. Nothing else in the
document enumerated apply conditions for this migration, so this was a one-place correction rather
than the multi-copy sweep the previous round needed.

Residual risk was low before the fix and is low after it: the migration header, `AGENTS.md` and
`KNOWN_ISSUES.md` all carry the approval requirement independently, and the approval gate is
enforced in `.claude/hooks/migration-apply-lib.mjs`, not by prose.

**Proof observed this round.** `node scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs`
passed on the current revision of the prover — it had been edited in `ce036bdb6` after its last
observed pass, so that pass is now re-established rather than assumed. It replayed 95 applied
post-baseline migrations, and reported `CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS
before=rls_refused fix=rep_removes replay=bound no_new_access=true admin=ok reapply=ok
mutation=detected`, including that the registered chain
`scripts/smoke/smoke-customer-document-rep-soft-delete.sql` passed, rolled back, and still fails
against the mutant.

**Not verified.** The migration has still never been applied to live and the function has never
been exercised by a real rep in a browser. The `gpt-5.6-sol` gate still has not run on the current
head — the Codex CLI is at its usage limit, retry 2026-09-26 — so this change is not apply-ready
and not merge-ready on that gate's account.
