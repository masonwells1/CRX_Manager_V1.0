## 2026-08-27 — Production migration ordering and final race closure

Exact-commit adversarial review found that requiring the reviewed migration PR to remain current
`main` could strand an older migration after unrelated work merged, while a newer migration could
then advance the live ledger past it. The verifier now accepts the original reviewed PR only when
its merge is an ancestor of current `main` and its newly added regular Git blob is identical at the
reviewed head, original merge, and current head.

The atomic batch now enumerates repository migrations from the immutable current-main tree and,
while holding the live ledger lock, refuses execution when any earlier post-baseline migration lacks
a matching ledger row. The credential-bearing step also rechecks remote `main` and the exact
migration blob hash after database linking and immediately before SQL execution, closing the stale
checkout window without weakening Mason's environment approval.
