## 2026-09-26 - soft_delete_customer_document: three deferred MEDs fixed, branch synced with main

The three MED findings from the 2026-09-24 adversarial Claude review of `f351c4a20` were held back
so they could ship together with the Sol gate's findings (Mason's decision: one commit, one PR,
one CodeRabbit round). No SQL change: the candidate migration is byte-identical.

**The Sol run (2026-09-26, `f351c4a20`).** `gpt-5.6-sol` returned BLOCKERS with two findings,
a stop-latch regression and a review-model downgrade. Both were stale-base artifacts. That head was
two commits behind `main` (#794, #796), and this branch changes none of the six files named, so
`main`'s newer versions read as reversions. The same run found no blocker in the RPC itself. Fix:
merge `main`. Since #796 the gate is `gpt-6-sol`.

**MED-1: a comment pointed callers at the wrong classifier.** `src/lib/db.ts` told pages to classify
the idempotency refusals through `src/lib/idempotency.ts`. Those helpers match the token by exact
equality, and this RPC raises `IDEMPOTENCY_INTENT_MISMATCH` and `IDEMPOTENCY_RESULT_INVALID` with a
human suffix (added on purpose, reviewer round of 2026-09-23), so neither would be recognised. The
comment now names this RPC as the exception and points its callers to `hasRpcCode` /
`rpcCodeDetail`, which accept the suffixed form. The shared classifier is unchanged, since changing it
would change every RPC.

**MED-2: the prover's skip check only looked at `customer_documents`.** The function also writes a
receipt into `public.idempotency_keys`, and the skipped parked `20260914100800` installs a
`BEFORE INSERT` trigger there. The prover now scans every skipped parked file for changes to that
table's triggers, policies, row security, ownership or grants, or to `check_idempotency_intent`.
It fails closed on anything it cannot account for. A REVOKE from browser roles is accounted for
(the receipt INSERT runs as the owner), and so is a trigger, but only by installing it verbatim
from the parked file before the candidate applies and running the whole proof through it.

**MED-3: the path-shape check used a copy of the chain's file name.** It now rebuilds the chain's
storage paths from the literals the chain really inserts. It also requires every inserted row to
compose its path that way, and self-tests by restoring a `[SMOKE]` marker into the path.

**Proof.** `node scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs` passed on
the merged tree (`CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS`, 95 migrations replayed,
`trg_idempotency_keys_require_transfer_intent_20260908` installed). Three deliberate breaks each
made it fail: `[SMOKE]` back in the chain's path (path-shape assertion), a parked file forcing row
security on `idempotency_keys` (receipt-surface assertion), and the installed trigger refusing every
insert (the FIX step fails with the trigger's error). The prover was restored byte-identical after
each. Migration files were not edited for these (the migration guard forbids it); B and C were
simulated inside the prover.

**Luna round (`gpt-6-luna`/xhigh, advisory, whole branch).** Four findings. Fixed: migration-history row 936 still said the gate had not run since the usage limit (LOW). Refuted: the BLOCKER calling the round-5 changelog's account of the `idempotency-body-check: exempt` marker a prompt injection. That is a record of a settled dispute addressed to Mason, and the body's key enforcement is exercised by the prover (key required, replay, intent and actor mismatch). Deferred by name, as before: control characters accepted in the key (LOW), and the prover's image pinned by tag rather than digest (LOW).

**Still unverified.** The Sol gate on the final head; the live apply (Mason's approval, after
`20260914100700`, `100800`, `100900`); and a rep's Remove click on live after the page branch deploys.
