## 2026-09-30 - soft_delete_customer_document: fourth `main` sync; the hold's predecessors are now on `main`

PR #800 merged `main` again (#825, #844 and the field-season delivery PR #850; no conflicts). #850
brought the four field-season migrations the ordering hold waits on
(`20260914101000`..`20260914101300`) onto `main`, so the real-schema prover now replays them:
`node scripts/smoke/prove-customer-document-rep-soft-delete-real-schema.mjs` printed
"ordering-hold predecessors replayed: 4/4", replayed 101 applied post-baseline migrations, and ended
`CUSTOMER_DOCUMENT_REP_SOFT_DELETE_PROOF_PASS before=rls_refused fix=rep_removes replay=bound
no_new_access=true admin=ok reapply=ok mutation=detected`.

Read-only live ledger check 2026-09-30 (after #850 merged): the newest `20260914` file live is still
`20260914100900` (`20260928025520`); `20260914101000`..`101300` are on `main` but not live, so the
hold still stands. Their owner rollout lands them after 2026-10-01, with `20260914101000` behind
Mason's owner approval. `CURRENT_STATE.md`, `KNOWN_ISSUES.md` and migration-history row 936 plus its
addendum now say "on `main`, not yet live" instead of naming an open PR.
