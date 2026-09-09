## 2026-09-07 - the create_inventory_hold cutover race is closed (candidate, still NOT applied)

A fourth `gpt-5.6-sol` review of PR #624 found a real hole in the
`20260908130000` candidate: the `ACCESS EXCLUSIVE` lock it takes on
`idempotency_keys` only drains transactions that have already touched that
table. A call that had already resolved the OLD `create_inventory_hold` body was
untouched by it — that body authenticates, reads the profile, runs the stock
check and inserts the hold all before it first touches `idempotency_keys`. Such
a call could block at its final receipt insert, resume after the migration
committed, and write a receipt bound to nobody, having used the old body's
missing-profile and NULL-`p_force` bypasses.

The fix is a `BEFORE INSERT` trigger on `public.idempotency_keys`, created
**before** the rename so there is no window at all. It early-returns for every
operation but `create_inventory_hold`, requires a transaction-local
`crx.create_inventory_hold_intent` context naming that exact key, actor and
fingerprint, and stamps the binding columns. The wrapper publishes that context
before it can reach any receipt write.

This is a **separate** trigger rather than an edit to the live Section 9 guard
(`20260826221000`), which currently protects vendor-bill, vendor-payment and
PO-receiving money receipts. Same protection, far smaller blast radius.

**Proof, by execution:** the smoke chain now calls the renamed body directly
with no context — byte for byte what an in-flight pre-cutover call does — and
the receipt is refused, rolling the whole call back with no hold and no receipt
left. A stale context from a different key is refused too, and an unrelated
operation's receipt still inserts freely. **Falsified:** with the trigger
installed but its predicate neutered (so every text-level postflight still
passed), the chain failed `SMOKE_FAIL: the old body wrote an UNBOUND receipt
after cutover`. Container run with the fix:
`pre_chain=FAIL pre_race=1_hold_loser_errors legacy_receipt=REFUSED
post_chain=PASS post_race=1_hold_loser_replays rerun=PASS`.

The wrapper body changed, so the replay pin was recomputed to
`71fa8faf…0750d02`; the `rerun=PASS` leg proves it matches what the file emits.

The migration is still **NOT applied** and still gated on Mason.
