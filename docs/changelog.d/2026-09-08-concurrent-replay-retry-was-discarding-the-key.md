## 2026-09-08 - a concurrent-replay error was discarding the retry key and duplicating the hold

Codex round 6 on PR #624 found a second HIGH, and this one bites on live TODAY —
it does not wait for the migration.

When two hold requests race on the same idempotency key, the live database guard
lets one win and tells the loser
`IDEMPOTENCY_CONCURRENT_REPLAY_RETRY: ... completed concurrently; retry to read
its saved result`. The winner COMMITTED — the hold exists.

Every PL/pgSQL error arrives as SQLSTATE `P0001`, which `isDefinitiveRpcRejection`
treats as a definitive refusal. So the loser's durable retry key was deleted. The
operator saw an error, clicked again, a fresh key was minted, and a **second hold**
was created for a request that had already succeeded — the exact double-hold this
branch exists to prevent.

Fixed in `src/lib/idempotency.ts`: that message is now excluded from the
definitive set, so the key is retained and the retry reads the winner's receipt.
Matched as a substring because the server appends the operation and key.
`IDEMPOTENCY_CROSS_OP_KEY_REUSE` deliberately stays definitive — a key owned by
another operation can never succeed, and leaving it in place would trap the
operator in an unfixable retry loop.

**Falsified:** with the exclusion disabled the new test fails with
`expected true to be false`, so it detects the bug it claims to catch.

Also recorded, and deliberately NOT fixed: the cutover guard added yesterday
cannot see an in-flight old-body call that passed a NULL idempotency key, because
that path skips the receipt table entirely. Closing it would require a guard on
`inventory_holds`, a table written by 16 migrations including live job and quote
flows — a bigger risk than the seconds-long window it removes, and not a
regression (keyless calls behave that way on live today, permanently). The
migration header carries a read-only post-apply detection query that must return
zero rows.
