## 2026-09-07 — SUPERSEDED (was OPEN): the hold migration's cutover can still let an in-flight old call write an unbound receipt

> **Superseded the same day. Do not use this entry as apply guidance.** The race below was
> closed by a separate `BEFORE INSERT` trigger on `public.idempotency_keys`, created before the
> rename (see `2026-09-07-create-inventory-hold-cutover-race-fixed.md`). The apply blocker this
> entry describes is cleared on migration-history row 924, which now carries the candidate (it was
> numbered 923 before the main merge renumbered it). Candidate `20260908130000` is still **NOT
> applied live**, still needs Mason's explicit approval and a fresh read-only preflight, and keeps
> one accepted residual recorded on row 924: an in-flight old-body call that passed no idempotency
> key never touches the receipt table, so the trigger cannot see it.

Fourth `gpt-5.6-sol` review of PR #624. Unlike the previous round's two staleness artifacts, this
one is **substantive and remains OPEN**. It is recorded here and on migration-history row 924 as an
**apply blocker**, not fixed in this branch.

### The race

`20260908130000` drains `public.idempotency_keys` with `SET LOCAL lock_timeout = '10s'` +
`LOCK TABLE ... ACCESS EXCLUSIVE` before renaming the function and installing the wrapper. That
drains transactions which have already *touched* the receipt table. It does not stop a call that
already resolved the **old** `create_inventory_hold` body and has not reached its receipt write yet.

The old body's order of operations is what makes this reachable: it authenticates, reads the
profile, runs the stock check and `INSERT INTO inventory_holds` — all **before** its first
`idempotency_keys` access, which sits at the end behind `IF p_idempotency_key IS NOT NULL`. So an
in-flight call can insert a hold, block on the receipt insert, and resume after this migration
commits, writing an **unbound** receipt. It will have used the old body's weaker guards: the
missing-profile gate and the NULL-`p_force` bypass. Renaming and revoking cannot stop an invocation
already executing, and `PREFLIGHT_LEGACY_RECEIPTS` cannot detect a *future* late insert.

### The remedy already exists in this repo, and it is live

`20260826221000` (row 901, applied live 2026-09-01) registered
`section9_bind_idempotency_receipt_20260826` as a `BEFORE INSERT` trigger on
`public.idempotency_keys`. It requires a transaction-local actor/key/fingerprint context and
**early-returns for any operation outside its list**, so its blast radius is scoped to the six
operations it names:

    create_vendor_bill, update_vendor_bill, record_vendor_payment,
    void_vendor_payment, void_vendor_bill, receive_po_items

`create_inventory_hold` is not among them, so it is unprotected. Closing this means adding this
operation to that guard, having the new wrapper publish the context before it delegates (note the
wrapper reaches `check_idempotency_intent` before the impl, so the context must be set ahead of
that call), and proving it with a test that pauses an old invocation before its first receipt-table
access while the migration applies.

### Why it was not done in this change

Editing `_section9_bind_idempotency_receipt_20260826` modifies a trigger function that is currently
guarding **live vendor-bill, vendor-payment and PO-receiving money receipts**. A mistake there
breaks accounts payable, which is a far larger blast radius than the inventory wrapper this branch
is about. It deserves its own change with its own concurrency proof rather than being appended to
an already-large migration late in a session.

**Deferring exposes nothing.** The window exists only during an apply of this migration, this
migration is not applied, and applying it requires Mason's explicit approval. The risk is realised
only if someone applies it before this is closed — hence the apply blocker on row 924.

### What is NOT claimed

This entry does not claim the race is unlikely enough to ignore. Production volume is small and the
file already instructs a quiet-window apply, but neither is a guarantee, and no attempt was made to
measure the window. It is open work, deliberately left visible.
