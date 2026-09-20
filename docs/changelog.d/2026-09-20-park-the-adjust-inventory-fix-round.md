## 2026-09-20 — park the `adjust_inventory` fix round in the repository

The refinement round for `20260911120000_bind_adjust_inventory_receipt_to_intent` existed only as a
279-line diff in a session scratchpad — a temporary directory Windows can clear at any time, and the
only copy. It is now `docs/plans/adjust-inventory-fix-round-parked-2026-09-20.md`, with the diff
embedded verbatim: the extracted fence hashes to `4551d18f…`, identical to the recovered file
(18736 bytes both sides).

Documentation only. No code, no schema, no behaviour change.

### Why it is parked rather than applied

The migration it was written against is applied to production (ledger version `20260920052149`) and
merged to `main` as `17826e9c3` via PR #739. An applied migration's bytes — comments included — are
never edited again, so these changes must arrive as a NEW forward migration pinning the current live
body (`9a503e54…`). The parked document says so at the top and labels the diff as source material
rather than something to `git apply`. The file's own preflight enforces the same thing mechanically:
it accepts only `ef485890…` or its own `v_new_pin`, and live is now neither, so an edited re-run
aborts with `PREFLIGHT_BODY`.

### What is actually outstanding

One behavioural item, rated LOW by the exact-head `gpt-5.6-sol` review of `b0d6236bb`: the live
function accepts an idempotency key containing ASCII control characters as long as the key also
holds one printable character. Both browser callers send plain ASCII keys, so it is hygiene, not a
live defect. The rest of the round is comment precision plus two extra smoke cases and a postflight
presence check for `AUTH_REQUIRED` (an ordering-only assertion passes a body that never
authenticates, because an absent `position()` returns 0).

The document also records a counting trap so the round is not "fixed" wrongly: PR #704 restamped
seven migrations, but the range `20260914100100`..`20260914100900` spans eight since PR #721 added
`20260914100800`. A blanket seven-to-eight replacement across the five affected documents would
introduce a new error.

### Verified

The security fix this round refines is live and unchanged: `public.adjust_inventory` reads 4334
chars, md5 `22f1f7d0bd190ce74efb5ad3a8379677`, with the admin-role check and the intent binding both
present and the control-character refusal absent — read read-only from `pg_proc` on 2026-09-20,
which is also what establishes the outstanding item above is genuinely outstanding.
